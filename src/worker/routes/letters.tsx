import { zValidator } from "@hono/zod-validator";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { BookmarkletHelp, bookmarkletCode } from "../../views/bookmarklet";
import { LetterText, ReportForm, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import { currentPath, requireSignin } from "../auth/require-signin";
import type { Variables } from "../auth/session";
import { embedItems } from "../ai/embed";
import { getItem } from "../db/items";
import { updateListener } from "../db/listeners";
import { isValidPlace, profileFields, profilePatch } from "../listener-profile";
import { displayText } from "../letters/display";
import { getLetter, insertReport, insertTakedown, listReactionsForLetter } from "../db/letters";
import type { Env } from "../env";
import type { ja } from "../i18n/ja";
import { type Lang, tFor } from "../i18n/t";
import { defer } from "../defer";
import { createLetter } from "../letters/create";
import { prepareLetter } from "../program/prepare";
import type { ItemDraft } from "../resolve";
import type { Listener } from "../types";
import { PutPage } from "./put";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const letterSchema = z.object({
  url: z.string().trim().max(2000).optional(),
  itemId: z.string().max(100).optional(),
  body: z.string().default(""),
  parentLetterId: z.string().max(100).optional(),
  kind: z.enum(["letter", "reply", "watashimo"]).default("letter"),
  /** Sent from the home's send modal: the answer stays in the frame. */
  embed: z.literal("1").optional(),
  /** A nameless listener's optional name and place, sent with a reply; checked as `/settings` checks them. */
  radioName: z.string().max(200).optional(),
  placeCountry: z.string().max(10).optional(),
  placeRegion: z.string().max(10).optional(),
});
const profileSchema = z.object(profileFields).refine(isValidPlace);
type LetterForm = z.infer<typeof letterSchema>;

export const letters = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Re-renders the put page with an error, keeping what the person typed. */
async function putError(c: AppContext, form: Partial<LetterForm>, error: string, status: 404 | 422 | 429 | 409 | 503, draft?: ItemDraft | null) {
  const card = form.itemId ? await getItem(c.env.DB, form.itemId) : (draft ?? null);
  const itemId = card && form.itemId ? form.itemId : undefined;
  return c.html(<PutPage listener={c.get("listener")} bookmarklet={bookmarkletCode(c.env.PUBLIC_ORIGIN)} card={card} itemId={itemId} url={form.url} body={form.body} error={error} embed={form.embed === "1"} />, status);
}

/** Only a new letter needs an account; 私も and a reply stay open to anonymous listeners. */
const signinForLetters: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const kind = (await c.req.parseBody()).kind;
  return kind === "watashimo" || kind === "reply" ? next() : requireSignin(c, next);
};

letters.post(
  "/letters",
  signinForLetters,
  zValidator("form", letterSchema, (result, ctx) => {
    if (!result.success) return putError(ctx as AppContext, {}, tFor((ctx as AppContext).get("listener").lang)("letters.invalid"), 422);
  }),
  async (c) => {
    const form = c.req.valid("form");
    let listener = c.get("listener");
    const t = tFor(listener.lang);
    // Kept on the listener before the reply is made, so the reply (and later ones) carry it. Once named, the fields are ignored.
    if (form.kind === "reply" && !listener.radioName && (form.radioName?.trim() || form.placeCountry?.trim())) {
      const profile = profileSchema.safeParse({ radioName: form.radioName ?? "", placeCountry: form.placeCountry ?? "", placeRegion: form.placeRegion ?? "" });
      if (!profile.success) return putError(c, form, t("settings.invalid"), 422);
      listener = (await updateListener(c.env.DB, listener.id, profilePatch(listener, profile.data))) ?? listener;
    }
    const result = await createLetter(c.env, c.env.DB, listener, form);
    if (result.ok) {
      // The work may be new: its vector is made after the answer (a no-op when it has one).
      defer(c, embedItems(c.env, c.env.DB, [result.itemId]));
      // Reactions are fixed phrases and have no unit to make.
      if (result.letter.kind === "letter") defer(c, prepareLetter(c.env, c.env.DB, result.letter.id));
      return c.redirect(form.embed === "1" ? `/put?embed=1&sent=${encodeURIComponent(result.itemId)}` : `/items/${result.itemId}`, 303);
    }
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
    <Layout title={t("reaction.title")} lang={lang} listener={c.get("listener")} path={currentPath(c)}>
      <main class="reactions-page">
        <h1>{t("reaction.title")}</h1>
        <LetterText letter={letter} lang={lang} />
        {reactions.length === 0 ? (
          <p class="muted">{t("reaction.none")}</p>
        ) : (
          <ul>
            {reactions.map((r) => (
              <li class="reaction">
                {r.kind === "watashimo" ? <p class="letter-body">{displayText(r, lang).main}</p> : <LetterText letter={r} lang={lang} />}
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

function TakedownPage(props: { url?: string; received?: boolean; invalid?: boolean; listener: Listener; path: string }) {
  const t = tFor(props.listener.lang);
  return (
    <Layout title={t("takedown.title")} lang={props.listener.lang} listener={props.listener} path={props.path}>
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
  return c.html(<TakedownPage url={letter?.sourceUrl ?? undefined} listener={c.get("listener")} path={currentPath(c)} />);
});

const takedownSchema = z.object({ url: z.string().trim().min(1).max(2000), reason: z.string().trim().max(500).default("") });

letters.post("/takedown", zValidator("form", takedownSchema, (r, c) => (r.success ? undefined : c.html(<TakedownPage invalid listener={(c as AppContext).get("listener")} path="/takedown" />, 422))), async (c) => {
  await insertTakedown(c.env.DB, c.req.valid("form"));
  return c.html(<TakedownPage received listener={c.get("listener")} path="/takedown" />);
});

letters.get("/bookmarklet", (c) => {
  const code = bookmarkletCode(c.env.PUBLIC_ORIGIN);
  const lang = c.get("listener").lang;
  const t = tFor(lang);
  return c.html(
    <Layout title={t("bookmarklet.title")} lang={lang} listener={c.get("listener")} path={currentPath(c)}>
      <main class="bookmarklet">
        <h1>{t("bookmarklet.title")}</h1>
        <BookmarkletHelp code={code} lang={lang} heading="h2" />
        {code && (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </main>
    </Layout>,
  );
});
