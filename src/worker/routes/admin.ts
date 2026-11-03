import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Variables } from "../auth/session";
import { type Lang, detectLang, translateToJa } from "../claude/translate";
import { getEpisode } from "../db/episodes";
import { getItem } from "../db/items";
import { getLetter, insertLetter, listLettersForItem, setLetterStatus } from "../db/letters";
import { getListener } from "../db/listeners";
import type { Env } from "../env";
import { makeEpisode } from "../program/create";
import { resolveOrCreate, resolveUrl } from "../resolve";
import { isFetchableUrl } from "../resolve/url";

type AppEnv = { Bindings: Env; Variables: Variables };

export const admin = new Hono<AppEnv>();

const encoder = new TextEncoder();

/** Compares SHA-256 digests, so neither the length nor the content of the real token leaks through timing. */
async function sameToken(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([given, expected].map(async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s)))));
  let diff = 0;
  for (let i = 0; i < a!.length; i++) diff |= a![i]! ^ b![i]!;
  return diff === 0;
}

/** `/admin/*` is exempt from the listener session, so each route proves itself with `Authorization: Bearer ADMIN_TOKEN`. */
const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  // An unset token must never match, not even an empty bearer.
  if (!expected || !given || !(await sameToken(given, expected))) return c.json({ error: "unauthorized" }, 401);
  return next();
};

admin.use("/admin/*", adminAuth);

const MAX_FOUND_CODE_POINTS = 100;
const MAX_AUTHOR = 80;

const voiceSchema = z.object({
  body: z.string().refine((s) => s.trim() !== "" && Array.from(s).length <= MAX_FOUND_CODE_POINTS, `body must be 1-${MAX_FOUND_CODE_POINTS} characters`),
  author: z.string().trim().min(1).max(MAX_AUTHOR),
  url: z.string().max(2000).refine(isFetchableUrl, "url must be a public http(s) url"),
  lang: z.enum(["ja", "en", "other"]).optional(),
});
const foundSchema = z.object({ itemId: z.string().min(1), voices: z.array(voiceSchema).min(1).max(50) });

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** The first problem as `{ error, index?, reason }`, so the operator can find the voice to fix. */
function invalid(c: Context<AppEnv>, error: z.ZodError) {
  const issue = error.issues[0];
  const [head, index] = issue?.path ?? [];
  return c.json({ error: "invalid", ...(head === "voices" && typeof index === "number" ? { index } : {}), reason: issue?.message ?? "invalid" }, 422);
}

/**
 * Found voices are curated by the operator, who reads each one before running this, so they skip the
 * letter moderation. The text is stored exactly as given (no trimming), with a translation beside it.
 */
admin.post("/admin/found", async (c) => {
  const parsed = foundSchema.safeParse(await readJson(c));
  if (!parsed.success) return invalid(c, parsed.error);
  const { itemId, voices } = parsed.data;
  if (!(await getItem(c.env.DB, itemId))) return c.json({ error: "item not found" }, 404);

  const existing = new Map((await listLettersForItem(c.env.DB, itemId)).filter((l) => l.kind === "found" && l.sourceUrl !== null).map((l) => [l.sourceUrl!, l.id]));
  const fresh = new Map<string, (typeof voices)[number]>();
  const skipped: string[] = [];
  for (const v of voices) {
    const already = existing.get(v.url);
    if (already) skipped.push(already);
    else if (!fresh.has(v.url)) fresh.set(v.url, v);
  }

  // Translate everything before storing anything, so a failure leaves nothing half-inserted.
  let prepared: Array<{ v: (typeof voices)[number]; lang: Lang; bodyJa: string }>;
  try {
    prepared = await Promise.all(
      [...fresh.values()].map(async (v) => {
        const lang = v.lang ?? detectLang(v.body);
        return { v, lang, bodyJa: await translateToJa(c.env, v.body, lang) };
      }),
    );
  } catch (e) {
    console.error(`[dococa] found voice translation failed: ${e instanceof Error ? e.name : "unknown"}`);
    return c.json({ error: "translation unavailable" }, 503);
  }

  const letterIds: string[] = [];
  for (const { v, lang, bodyJa } of prepared) {
    const letter = await insertLetter(c.env.DB, {
      itemId,
      kind: "found",
      body: v.body,
      bodyJa,
      lang,
      radioName: v.author,
      place: "",
      year: null,
      listenerId: null,
      parentLetterId: null,
      sourceUrl: v.url,
      sourceAuthor: v.author,
      status: "public",
    });
    letterIds.push(letter.id);
  }
  return c.json({ letterIds, skipped });
});

const urlSchema = z.object({ url: z.string().max(2000) });

admin.post("/admin/items", async (c) => {
  const parsed = urlSchema.safeParse(await readJson(c));
  if (!parsed.success) return invalid(c, parsed.error);
  const draft = await resolveUrl(parsed.data.url, c.env);
  if (!draft) return c.json({ error: "unresolvable" }, 422);
  return c.json({ item: await resolveOrCreate(c.env.DB, draft) });
});

admin.get("/admin/items/:id", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  return item ? c.json({ item }) : c.json({ error: "item not found" }, 404);
});

const episodeSchema = z.object({ listenerId: z.string().min(1) });

/** The operator's own demo episode: made for the given listener with the cloud voice, which does not use up their first-episode voice. */
admin.post("/admin/episodes", async (c) => {
  const parsed = episodeSchema.safeParse(await readJson(c));
  if (!parsed.success) return invalid(c, parsed.error);
  const listener = await getListener(c.env.DB, parsed.data.listenerId);
  if (!listener) return c.json({ error: "listener not found" }, 404);
  const made = await makeEpisode(c.env, listener, { cloudTts: true });
  if (!made.ok) return c.json({ error: made.reason }, made.reason === "limit" ? 429 : 503);
  const episode = await getEpisode(c.env.DB, made.id);
  return c.json({ id: made.id, cloudTts: episode?.cloudTts === true });
});

admin.post("/admin/letters/:id/reject", async (c) => {
  const id = c.req.param("id");
  if (!(await getLetter(c.env.DB, id))) return c.json({ error: "letter not found" }, 404);
  await setLetterStatus(c.env.DB, id, "rejected");
  return c.json({ ok: true });
});
