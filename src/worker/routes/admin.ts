import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Variables } from "../auth/session";
import { embedItems } from "../ai/embed";
import { moderateLetter } from "../claude/moderate";
import { type Lang, detectLang, translateToJa } from "../claude/translate";
import { getEpisode } from "../db/episodes";
import { getItem } from "../db/items";
import { getLetter, insertLetter, listFoundSources, setLetterStatus } from "../db/letters";
import { createListener, getListener } from "../db/listeners";
import type { Env } from "../env";
import { defer } from "../defer";
import { isValidRegion, placeLabel } from "../geo/place-label";
import { COUNTRIES } from "../geo/places";
import { createLetter } from "../letters/create";
import { makeEpisode } from "../program/create";
import { prepareBatch, prepareLetter } from "../program/prepare";
import { looksLikeContact } from "../program/pii-patterns";
import { resolveOrCreate, resolveUrl } from "../resolve";
import { isFetchableUrl } from "../resolve/url";
import { fromPublicOrigin } from "../security/origin";

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

const decoder = new TextDecoder();

/** The password of `Basic base64("admin:" + token)`; undefined for any other user or a malformed value. */
function basicToken(header: string): string | undefined {
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header)?.[1];
  if (!encoded) return undefined;
  let decoded: string;
  try {
    decoded = decoder.decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)));
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  return colon >= 0 && decoded.slice(0, colon) === "admin" ? decoded.slice(colon + 1) : undefined;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The page a browser opens; only there a 401 asks the browser for the Basic password. */
const ADMIN_PAGE = "/admin/units";

/**
 * `/admin/*` is exempt from the listener session, so each route proves itself with `Authorization: Bearer ADMIN_TOKEN`
 * or, for the owner's page in a browser, `Basic base64("admin:" + ADMIN_TOKEN)`. A browser re-sends Basic on its own,
 * so a Basic write must also come from PUBLIC_ORIGIN (a cross-site form could otherwise ride on it).
 */
const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  const header = c.req.header("authorization") ?? "";
  const bearer = /^Bearer (.+)$/.exec(header)?.[1];
  const basic = bearer === undefined ? basicToken(header) : undefined;
  const given = bearer ?? basic;
  // An unset token must never match, not even an empty bearer.
  if (!expected || !given || !(await sameToken(given, expected))) {
    if (c.req.method === "GET" && c.req.path === ADMIN_PAGE) c.header("WWW-Authenticate", 'Basic realm="dococa admin"');
    return c.json({ error: "unauthorized" }, 401);
  }
  if (basic !== undefined && UNSAFE.has(c.req.method) && !fromPublicOrigin(c.req.header("origin"), c.req.header("sec-fetch-site"), c.env.PUBLIC_ORIGIN)) {
    return c.text("Forbidden", 403);
  }
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
export function invalid(c: Context<AppEnv>, error: z.ZodError) {
  const issue = error.issues[0];
  const [head, index] = issue?.path ?? [];
  return c.json({ error: "invalid", ...(head === "voices" && typeof index === "number" ? { index } : {}), reason: issue?.message ?? "invalid" }, 422);
}

/**
 * Found voices go through the same fail-closed moderation as letters, before translation: a judgement
 * that cannot be made answers 503 and stores nothing. A voice that is turned down is left out and
 * reported in `rejected`, so one bad comment does not sink the batch. The text is never altered:
 * it is stored exactly as given, with a translation beside it.
 */
admin.post("/admin/found", async (c) => {
  const parsed = foundSchema.safeParse(await readJson(c));
  if (!parsed.success) return invalid(c, parsed.error);
  const { itemId, voices } = parsed.data;
  if (!(await getItem(c.env.DB, itemId))) return c.json({ error: "item not found" }, 404);

  // Any status counts: a voice that was rejected must not come back with the next collection.
  const existing = new Map((await listFoundSources(c.env.DB, itemId)).map((l) => [l.sourceUrl, l.id]));
  const fresh = new Map<string, { index: number; v: (typeof voices)[number] }>();
  const skipped: string[] = [];
  voices.forEach((v, index) => {
    const already = existing.get(v.url);
    if (already) skipped.push(already);
    else if (!fresh.has(v.url)) fresh.set(v.url, { index, v });
  });

  // Judge and translate everything before storing anything, so a failure leaves nothing half-inserted.
  const rejected: Array<{ index: number; url: string; reason: string }> = [];
  let prepared: Array<{ v: (typeof voices)[number]; lang: Lang; bodyJa: string }>;
  try {
    const judged = await Promise.all(
      [...fresh.values()].map(async ({ index, v }) => ({ index, v, verdict: await moderateLetter(c.env, v.body) })),
    );
    const passed = judged.filter((j) => j.verdict.ok);
    for (const j of judged) if (!j.verdict.ok) rejected.push({ index: j.index, url: j.v.url, reason: j.verdict.reason });
    prepared = await Promise.all(
      passed.map(async ({ v }) => {
        const lang = v.lang ?? detectLang(v.body);
        return { v, lang, bodyJa: await translateToJa(c.env, v.body, lang) };
      }),
    );
  } catch (e) {
    console.error(`[dococa] found voice judgement failed: ${e instanceof Error ? e.name : "unknown"}`);
    return c.json({ error: "judgement unavailable" }, 503);
  }

  const letterIds: string[] = [];
  for (const { v, lang, bodyJa } of prepared) {
    const letter = await insertLetter(c.env.DB, {
      itemId,
      kind: "found",
      body: v.body,
      bodyJa,
      bodyEn: null,
      lang,
      radioName: v.author,
      place: "",
      placeCountry: null,
      placeRegion: null,
      year: null,
      listenerId: null,
      parentLetterId: null,
      sourceUrl: v.url,
      sourceAuthor: v.author,
      status: "public",
    });
    letterIds.push(letter.id);
  }
  // One after another: fifty voices at once would ask Claude and Google fifty times in parallel.
  defer(c, (async () => {
    for (const id of letterIds) await prepareLetter(c.env, c.env.DB, id);
  })());
  return c.json({ letterIds, skipped, rejected });
});

const urlSchema = z.object({ url: z.string().max(2000).refine(isFetchableUrl, "url must be a public http(s) url") });

admin.post("/admin/items", async (c) => {
  const parsed = urlSchema.safeParse(await readJson(c));
  if (!parsed.success) return invalid(c, parsed.error);
  const draft = await resolveUrl(parsed.data.url, c.env);
  if (!draft) return c.json({ error: "unresolvable" }, 422);
  const item = await resolveOrCreate(c.env.DB, draft);
  defer(c, embedItems(c.env, c.env.DB, [item.id]));
  return c.json({ item });
});

admin.get("/admin/items/:id", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  return item ? c.json({ item }) : c.json({ error: "item not found" }, 404);
});

/** `size`: segments in the episode (the eval asks for a whole programme; a listener always gets one). */
const episodeSchema = z.object({ listenerId: z.string().min(1), size: z.number().int().min(1).max(6).optional() });

/** The operator's own demo episode, made for the given listener. */
admin.post("/admin/episodes", async (c) => {
  const parsed = episodeSchema.safeParse(await readJson(c));
  if (!parsed.success) return invalid(c, parsed.error);
  const listener = await getListener(c.env.DB, parsed.data.listenerId);
  if (!listener) return c.json({ error: "listener not found" }, 404);
  const made = await makeEpisode(c.env, listener, { first: true, ...(parsed.data.size ? { size: parsed.data.size } : {}) });
  if (!made.ok) return c.json({ error: made.reason }, made.reason === "limit" ? 429 : made.reason === "empty" ? 409 : 503);
  const episode = await getEpisode(c.env.DB, made.id);
  return c.json({ id: made.id, cloudTts: episode?.cloudTts === true });
});

/** The stored episode, report included, so the eval script can read what a listener's session would. */
admin.get("/admin/episodes/:id", async (c) => {
  const episode = await getEpisode(c.env.DB, c.req.param("id"));
  return episode ? c.json(episode) : c.json({ error: "episode not found" }, 404);
});

admin.post("/admin/letters/:id/reject", async (c) => {
  const id = c.req.param("id");
  if (!(await getLetter(c.env.DB, id))) return c.json({ error: "letter not found" }, 404);
  await setLetterStatus(c.env.DB, id, "rejected");
  return c.json({ ok: true });
});

// The same limits as the settings screen.
const MAX_NAME = 20;
const MAX_PLACE = 30;

const noContact = (s: string) => !looksLikeContact(s);
const listenerSchema = z
  .object({
    radioName: z.string().trim().min(1).max(MAX_NAME).refine(noContact, "radioName must not look like contact details"),
    place: z.string().trim().max(MAX_PLACE).refine(noContact, "place must not look like contact details"),
    // ISO 3166-1 alpha-2 from the settings list, and a region of that country (JP prefectures, US states).
    placeCountry: z.string().refine((v) => COUNTRIES.some((p) => p.code === v), "placeCountry must be a listed country code").optional(),
    placeRegion: z.string().min(1).optional(),
    // Only demo accounts can be made here, so this route cannot mint a listener that passes for a real one.
    demo: z.literal(true),
  })
  .refine((v) => v.placeRegion === undefined || (v.placeCountry !== undefined && isValidRegion(v.placeCountry, v.placeRegion)), "placeRegion must be a region of placeCountry");

/**
 * A demo account: an AI-made persona for seeding, marked `demo` so every surface says so. With place codes,
 * `place` is the Japanese label made from them, as the settings screen stores it.
 */
admin.post("/admin/listeners", async (c) => {
  const parsed = listenerSchema.safeParse(await readJson(c));
  if (!parsed.success) return invalid(c, parsed.error);
  const { placeCountry, placeRegion, ...rest } = parsed.data;
  const coded = placeCountry ? { placeCountry, placeRegion: placeRegion ?? null, place: placeLabel(placeCountry, placeRegion ?? null, "ja") } : {};
  const listener = await createListener(c.env.DB, { ...rest, ...coded });
  return c.json({ id: listener.id });
});

const letterSchema = z
  .object({
    listenerId: z.string().min(1),
    itemId: z.string().min(1).optional(),
    url: z.string().max(2000).refine(isFetchableUrl, "url must be a public http(s) url").optional(),
    body: z.string(),
  })
  .refine((v) => (v.itemId === undefined) !== (v.url === undefined), "give exactly one of itemId and url");

/**
 * A letter in the name of a demo account, through the same pipeline as `POST /letters`: the same checks,
 * the same fail-closed moderation, the same translation and duplicate rules. Real listeners cannot be used.
 */
admin.post("/admin/letters", async (c) => {
  const parsed = letterSchema.safeParse(await readJson(c));
  if (!parsed.success) return invalid(c, parsed.error);
  const { listenerId, itemId, url, body } = parsed.data;
  const listener = await getListener(c.env.DB, listenerId);
  if (!listener) return c.json({ error: "listener not found" }, 404);
  if (!listener.demo) return c.json({ error: "not a demo listener" }, 403);
  const made = await createLetter(c.env, c.env.DB, listener, { itemId, url, body });
  if (!made.ok) return c.json({ error: made.key, ...(made.reason ? { reason: made.reason } : {}) }, made.status);
  defer(c, prepareLetter(c.env, c.env.DB, made.letter.id));
  defer(c, embedItems(c.env, c.env.DB, [made.itemId]));
  return c.json({ letterId: made.letter.id, itemId: made.itemId });
});

const rejudgeSchema = z.object({ limit: z.number().int().min(1).max(50).default(20), after: z.string().min(1).max(100).optional() });

/**
 * Judges stored public letters again with the current moderation, in id order after the `after` cursor.
 * A letter the judge turns down becomes `rejected`; a judgement that cannot be made leaves it public and
 * counts as skipped. 私も is never judged, and a rejected letter never comes back. The answer carries ids
 * and reasons only, never text.
 */
admin.post("/admin/rejudge", async (c) => {
  const parsed = rejudgeSchema.safeParse((await readJson(c)) ?? {});
  if (!parsed.success) return invalid(c, parsed.error);
  const { limit, after } = parsed.data;
  const { results } = await c.env.DB.prepare(
    `SELECT letters.id, letters.body, items.title, items.creator FROM letters JOIN items ON items.id = letters.item_id
     WHERE letters.status = 'public' AND letters.kind IN ('letter', 'found', 'reply') AND letters.id > ?
     ORDER BY letters.id ASC LIMIT ?`,
  )
    .bind(after ?? "", limit)
    .all<{ id: string; body: string; title: string; creator: string }>();
  const rejected: { id: string; reason: string }[] = [];
  let judged = 0;
  let skipped = 0;
  for (const row of results) {
    try {
      const verdict = await moderateLetter(c.env, row.body, { title: row.title, creator: row.creator });
      judged++;
      if (!verdict.ok) {
        await setLetterStatus(c.env.DB, row.id, "rejected");
        rejected.push({ id: row.id, reason: verdict.reason });
      }
    } catch (e) {
      // The id and the error's name only: a message can echo the request, which carries the letter.
      console.warn(`[dococa] rejudge skipped ${row.id} ${e instanceof Error ? e.name : "unknown"}`);
      skipped++;
    }
  }
  return c.json({ judged, rejected, skipped, next: results.length === limit ? results[results.length - 1]!.id : null });
});

const prepareSchema = z.object({ limit: z.number().int().min(1).max(50).default(20) });

/** The cron's work by hand: up to `limit` units and the audio that is still missing (use after seeding). */
admin.post("/admin/prepare", async (c) => {
  const parsed = prepareSchema.safeParse((await readJson(c)) ?? {});
  if (!parsed.success) return invalid(c, parsed.error);
  return c.json(await prepareBatch(c.env, c.env.DB, parsed.data.limit));
});
