import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { LetterText, ReportForm, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { getItem } from "../db/items";
import { getLetter, insertReport, insertTakedown, listReactionsForLetter } from "../db/letters";
import type { Env } from "../env";
import type { ja } from "../i18n/ja";
import { type Lang, tFor } from "../i18n/t";
import { createLetter } from "../letters/create";
import type { ItemDraft } from "../resolve";
import { PutPage } from "./put";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

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
    if (!result.success) return putError(ctx as AppContext, {}, tFor((ctx as AppContext).get("listener").lang)("letters.invalid"), 422);
  }),
  async (c) => {
    const form = c.req.valid("form");
    const t = tFor(c.get("listener").lang);
    const result = await createLetter(c.env, c.env.DB, c.get("listener"), form);
    if (result.ok) return c.redirect(`/items/${result.itemId}`, 303);
    const message = result.reason ? `${t(result.key)} ${t(`letters.reason.${result.reason}` as keyof typeof ja)}` : t(result.key);
    return putError(c, form, message, result.status, result.draft);
  },
);

letters.get("/letters/:id/reactions", async (c) => {
  const letter = await getLetter(c.env.DB, c.req.param("id"));
  if (!letter || letter.listenerId !== c.get("listener").id) return c.notFound();
  const reactions = await listReactionsForLetter(c.env.DB, letter.id);
  const lang = c.get("listener").lang;
  const t = tFor(lang);
  return c.html(
    <Layout title={t("reaction.title")} lang={lang}>
      <main class="reactions-page">
        <h1>{t("reaction.title")}</h1>
        <LetterText letter={letter} lang={lang} />
        {reactions.length === 0 ? (
          <p class="muted">{t("reaction.none")}</p>
        ) : (
          <ul>
            {reactions.map((r) => (
              <li class="reaction">
                <LetterText letter={r} lang={lang} />
                <p class="letter-who">{whoOf(r, lang)}</p>
                <ReportForm letterId={r.id} lang={lang} />
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

letters.post("/letters/:id/report", zValidator("form", reportSchema, (r, c) => (r.success ? undefined : c.text(tFor((c as AppContext).get("listener").lang)("letters.invalid"), 422))), async (c) => {
  const letter = await getLetter(c.env.DB, c.req.param("id"));
  if (!letter) return c.notFound();
  await insertReport(c.env.DB, { letterId: letter.id, listenerId: c.get("listener").id, reason: c.req.valid("form").reason });
  return c.redirect(`/items/${letter.itemId}`, 303);
});

function TakedownPage(props: { url?: string; received?: boolean; invalid?: boolean; lang: Lang }) {
  const t = tFor(props.lang);
  return (
    <Layout title={t("takedown.title")} lang={props.lang}>
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
  return c.html(<TakedownPage url={letter?.sourceUrl ?? undefined} lang={c.get("listener").lang} />);
});

const takedownSchema = z.object({ url: z.string().trim().min(1).max(2000), reason: z.string().trim().max(500).default("") });

letters.post("/takedown", zValidator("form", takedownSchema, (r, c) => (r.success ? undefined : c.html(<TakedownPage invalid lang={(c as AppContext).get("listener").lang} />, 422))), async (c) => {
  await insertTakedown(c.env.DB, c.req.valid("form"));
  return c.html(<TakedownPage received lang={c.get("listener").lang} />);
});

/** The origin the bookmarklet sends people to; null when the configured one is not a plain http(s) origin. */
function bookmarkletOrigin(publicOrigin: string): string | null {
  try {
    const url = new URL(publicOrigin);
    const plain = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(url.origin);
    return (url.protocol === "http:" || url.protocol === "https:") && plain ? url.origin : null;
  } catch {
    return null;
  }
}

letters.get("/bookmarklet", (c) => {
  const origin = bookmarkletOrigin(c.env.PUBLIC_ORIGIN);
  const code = origin && `javascript:location.href='${origin}/put?url='+encodeURIComponent(location.href)`;
  const lang = c.get("listener").lang;
  const t = tFor(lang);
  return c.html(
    <Layout title={t("bookmarklet.title")} lang={lang}>
      <main class="bookmarklet">
        <h1>{t("bookmarklet.title")}</h1>
        {code ? (
          <>
            <p>{t("bookmarklet.help")}</p>
            <p>
              <a class="button" href={code}>{t("bookmarklet.drag")}</a>
            </p>
            <pre><code>{code}</code></pre>
          </>
        ) : (
          <p>{t("bookmarklet.unavailable")}</p>
        )}
      </main>
    </Layout>,
  );
});
