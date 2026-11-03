import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { LetterText, ReportForm, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { moderateLetter } from "../claude/moderate";
import { type Lang, detectLang, translateToJa } from "../claude/translate";
import { getItem } from "../db/items";
import {
  countRecentDuplicate,
  getLetter,
  hasWatashimo,
  insertLetter,
  insertReport,
  insertTakedown,
  listReactionsForLetter,
} from "../db/letters";
import type { Env } from "../env";
import { t } from "../i18n/t";
import { type ItemDraft, resolveOrCreate, resolveUrl } from "../resolve";
import { PutPage } from "./put";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const MAX_BODY = 200;
const DUPLICATE_WINDOW_MINUTES = 10;

const letterSchema = z.object({
  url: z.string().trim().max(2000).optional(),
  itemId: z.string().max(100).optional(),
  body: z.string().default(""),
  parentLetterId: z.string().max(100).optional(),
  kind: z.enum(["letter", "reply", "watashimo"]).default("letter"),
});
type LetterForm = z.infer<typeof letterSchema>;

export const letters = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Re-renders the put page with an error, keeping what the person typed. */
async function putError(c: AppContext, form: Partial<LetterForm>, error: string, status: 404 | 422 | 429 | 409 | 503, draft?: ItemDraft | null) {
  const card = form.itemId ? await getItem(c.env.DB, form.itemId) : (draft ?? null);
  const itemId = card && form.itemId ? form.itemId : undefined;
  return c.html(<PutPage listener={c.get("listener")} card={card} itemId={itemId} url={form.url} body={form.body} error={error} />, status);
}

letters.post(
  "/letters",
  zValidator("form", letterSchema, (result, ctx) => {
    if (!result.success) return putError(ctx as AppContext, {}, t("letters.invalid"), 422);
  }),
  async (c) => {
    const form = c.req.valid("form");
    const listener = c.get("listener");
    const isWatashimo = form.kind === "watashimo";
    const body = isWatashimo ? t("reaction.watashimo") : form.body.trim();

    if (body === "") return putError(c, form, t("letters.empty"), 422);
    if (Array.from(body).length > MAX_BODY) return putError(c, form, t("letters.tooLong"), 422);

    const stored = form.itemId ? await getItem(c.env.DB, form.itemId) : null;
    const draft = stored ?? (form.url ? await resolveUrl(form.url, c.env) : null);
    if (!draft) return putError(c, form, t("put.notFound"), 422);

    // A reaction hangs off a top-level letter of the same stored item; a plain letter has no parent.
    const parent = form.parentLetterId ? await getLetter(c.env.DB, form.parentLetterId) : null;
    const isReaction = form.kind !== "letter";
    const parentOk = parent !== null && stored !== null && parent.itemId === stored.id && parent.parentLetterId === null;
    if (isReaction ? !parentOk : form.parentLetterId !== undefined) {
      return putError(c, form, t("letters.badParent"), 422, draft);
    }
    if (isWatashimo && (await hasWatashimo(c.env.DB, listener.id, parent!.id))) {
      return putError(c, form, t("letters.watashimoDuplicate"), 409, draft);
    }
    // Every 私も has the same text, so only the same-parent rule above limits it.
    if (!isWatashimo && (await countRecentDuplicate(c.env.DB, listener.id, body, DUPLICATE_WINDOW_MINUTES)) >= 1) {
      return putError(c, form, t("letters.duplicate"), 429, draft);
    }

    let lang: Lang = "ja";
    let bodyJa = body;
    if (!isWatashimo) {
      try {
        const verdict = await moderateLetter(c.env, body);
        if (!verdict.ok) {
          return putError(c, form, `${t("letters.rejected")} ${t(`letters.reason.${verdict.reason}`)}`, 422, draft);
        }
        lang = detectLang(body);
        bodyJa = await translateToJa(c.env, body, lang);
      } catch (e) {
        console.error("[dococa] letter judgement failed", e);
        return putError(c, form, t("letters.unavailable"), 503, draft);
      }
    }

    const item = stored ?? (await resolveOrCreate(c.env.DB, draft));
    await insertLetter(c.env.DB, {
      itemId: item.id,
      kind: form.kind,
      body,
      bodyJa,
      lang,
      radioName: listener.radioName,
      place: listener.place,
      year: null,
      listenerId: listener.id,
      parentLetterId: parent?.id ?? null,
      sourceUrl: null,
      sourceAuthor: null,
      status: "public",
    });
    return c.redirect(`/items/${item.id}`, 303);
  },
);

letters.get("/letters/:id/reactions", async (c) => {
  const letter = await getLetter(c.env.DB, c.req.param("id"));
  if (!letter || letter.listenerId !== c.get("listener").id) return c.notFound();
  const reactions = await listReactionsForLetter(c.env.DB, letter.id);
  return c.html(
    <Layout title={t("reaction.title")}>
      <main class="reactions-page">
        <h1>{t("reaction.title")}</h1>
        <LetterText letter={letter} />
        {reactions.length === 0 ? (
          <p class="muted">{t("reaction.none")}</p>
        ) : (
          <ul>
            {reactions.map((r) => (
              <li class="reaction">
                <LetterText letter={r} />
                <p class="letter-who">{whoOf(r)}</p>
                <ReportForm letterId={r.id} />
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href={`/items/${letter.itemId}`}>{t("reaction.back")}</a>
        </p>
      </main>
    </Layout>,
  );
});

const reportSchema = z.object({ reason: z.string().trim().max(200).default("") });

letters.post("/letters/:id/report", zValidator("form", reportSchema, (r, c) => (r.success ? undefined : c.text(t("letters.invalid"), 422))), async (c) => {
  const letter = await getLetter(c.env.DB, c.req.param("id"));
  if (!letter) return c.notFound();
  await insertReport(c.env.DB, { letterId: letter.id, listenerId: c.get("listener").id, reason: c.req.valid("form").reason });
  return c.redirect(`/items/${letter.itemId}`, 303);
});

function TakedownPage(props: { url?: string; received?: boolean; invalid?: boolean }) {
  return (
    <Layout title={t("takedown.title")}>
      <main class="takedown">
        <h1>{t("takedown.title")}</h1>
        {props.received ? (
          <p role="status">{t("takedown.received")}</p>
        ) : (
          <form method="post" action="/takedown" class="put-form">
            {props.invalid && <p class="form-error" role="alert">{t("letters.invalid")}</p>}
            <p>{t("takedown.help")}</p>
            <label>
              <span>{t("takedown.url")}</span>
              <input type="url" name="url" value={props.url ?? ""} required maxlength={2000} />
            </label>
            <label>
              <span>{t("takedown.reason")}</span>
              <textarea name="reason" rows={4} maxlength={500} />
            </label>
            <button type="submit">{t("takedown.submit")}</button>
          </form>
        )}
      </main>
    </Layout>
  );
}

letters.get("/takedown", async (c) => {
  const id = c.req.query("letterId");
  const letter = id ? await getLetter(c.env.DB, id) : null;
  return c.html(<TakedownPage url={letter?.sourceUrl ?? undefined} />);
});

const takedownSchema = z.object({ url: z.string().trim().min(1).max(2000), reason: z.string().trim().max(500).default("") });

letters.post("/takedown", zValidator("form", takedownSchema, (r, c) => (r.success ? undefined : c.html(<TakedownPage invalid />, 422))), async (c) => {
  await insertTakedown(c.env.DB, c.req.valid("form"));
  return c.html(<TakedownPage received />);
});

letters.get("/bookmarklet", (c) => {
  const code = `javascript:location.href='${c.env.PUBLIC_ORIGIN}/put?url='+encodeURIComponent(location.href)`;
  return c.html(
    <Layout title={t("bookmarklet.title")}>
      <main class="bookmarklet">
        <h1>{t("bookmarklet.title")}</h1>
        <p>{t("bookmarklet.help")}</p>
        <p>
          <a class="button" href={code}>{t("bookmarklet.drag")}</a>
        </p>
        <pre><code>{code}</code></pre>
      </main>
    </Layout>,
  );
});
