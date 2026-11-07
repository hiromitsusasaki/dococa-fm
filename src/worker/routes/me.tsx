import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { raw } from "hono/html";
import { z } from "zod";
import { ShareLinks, letterShareText, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import { currentPath, requireSignin } from "../auth/require-signin";
import type { Variables } from "../auth/session";
import { getItemsByIds } from "../db/items";
import { listHeardLetters } from "../db/listens";
import { getLetter, listOwnPublicLetters, listRecentReactionsToListener, withdrawLetter } from "../db/letters";
import { markReactionsSeen, updateListener } from "../db/listeners";
import type { Env } from "../env";
import { displayText } from "../letters/display";
import { tFor } from "../i18n/t";
import { SLUG, ensureStationSlug, isSlugTaken, stationUrl } from "../program/station";
import type { Listener } from "../types";

const REACTIONS_LIMIT = 50;
/** A letter in the list of one's own quotes this many characters. */
const OWN_PREVIEW_CHARS = 80;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const jstDate = (iso: string): string => new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);
const isHttp = (s: string | null): s is string => s !== null && /^https?:\/\//i.test(s);

type MeContext = Context<{ Bindings: Env; Variables: Variables }>;

/** What the public radio panel shows after a refused change: the slug as typed, and why. `failed`: no address could be assigned. */
type RadioError = { slug: string; reason: "taken" | "invalid" | "failed" };

const RADIO_ERROR_TEXT = { taken: "me.slugTaken", invalid: "me.slugInvalid", failed: "me.radioFailed" } as const;

export const me = new Hono<{ Bindings: Env; Variables: Variables }>();

/** `radioError`: a refused `POST /me/radio` re-renders the page; that answer assigns no address (it writes nothing to the radio). */
async function renderMe(c: MeContext, signedIn: Listener, radioError?: RadioError) {
  // On `GET /me`, a listener signed in before addresses were assigned gets one here; a failure renders without it.
  const listener = !signedIn.stationSlug && !radioError ? { ...signedIn, stationSlug: await ensureStationSlug(c.env.DB, signedIn).catch(() => null) } : signedIn;
  const lang = listener.lang;
  const t = tFor(lang);
  // Taken before the read: a reaction that lands while the page is made lights the dot again rather than going unseen.
  const seenAt = new Date();
  const own = await listOwnPublicLetters(c.env.DB, listener.id);
  const reactions = await listRecentReactionsToListener(c.env.DB, listener.id, REACTIONS_LIMIT);
  // One row per letter, at its newest listen (the list comes newest first).
  const heard = (await listHeardLetters(c.env.DB, listener.id)).filter((h, i, all) => all.findIndex((o) => o.letter.id === h.letter.id) === i);
  const items = await getItemsByIds(c.env.DB, [...own.map((l) => l.itemId), ...reactions.map((r) => r.itemId)]);
  // The dot is a decoration: a failed write leaves it lit, it does not fail the page.
  await markReactionsSeen(c.env.DB, listener.id, seenAt).catch(() => {});
  const radioUrl = listener.stationSlug ? stationUrl(c.env, listener.stationSlug) : null;
  // Shown once: the script drops the query, so a reload does not repeat it. A listener who is already public has no news in it.
  const welcome = c.req.query("welcome") === "1" && radioUrl && !listener.stationPublic ? radioUrl : null;
  return c.html(
    <Layout title={t("me.title")} script="share-page" lang={lang} listener={listener} path={currentPath(c)}>
      <main class="me">
        <h1>{t("me.title")}</h1>
        {welcome && (
          <>
            <p class="notice" role="status">{t("me.welcome", { url: welcome })}</p>
            <script>{raw(`try{history.replaceState(null,"",location.pathname)}catch(e){}`)}</script>
          </>
        )}
        {!listener.radioName && (
          <p class="muted">
            {t("me.radioNameHint")} <a href="/settings">{t("settings.title")}</a>
          </p>
        )}
        <section class="panel me-letters">
          <h2>{t("me.myLetters")}</h2>
          {own.length === 0 ? (
            <p class="muted">{t("me.myLettersNone")}</p>
          ) : (
            <ul class="me-list">
              {own.map((l) => {
                const item = items.get(l.itemId);
                const title = item?.title ?? "";
                return (
                  <li class="me-letter">
                    <a class="me-letter-work" href={`/items/${l.itemId}`}>
                      <span class="me-thumb">{item && isHttp(item.imageUrl) && <img src={item.imageUrl} alt="" width="56" height="56" loading="lazy" />}</span>
                      <span class="title">{title}</span>
                    </a>
                    <p class="letter-body">{Array.from(displayText(l, lang).main).slice(0, OWN_PREVIEW_CHARS).join("")}</p>
                    <p class="muted">{jstDate(l.createdAt)}</p>
                    <div class="me-letter-actions">
                      <ShareLinks url={`${c.env.PUBLIC_ORIGIN}/letters/${l.id}`} text={letterShareText(title, l, lang)} lang={lang} />
                      <form method="post" action={`/letters/${l.id}/withdraw`} onsubmit={`return confirm(${JSON.stringify(t("me.withdrawConfirm"))})`}>
                        <button type="submit" class="quiet">{t("me.withdraw")}</button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section class="panel me-reactions">
          <h2>{t("me.reactions")}</h2>
          {reactions.length === 0 ? (
            <p class="muted">{t("me.nobody")}</p>
          ) : (
            <ul class="me-list">
              {reactions.map((r) => (
                <li>
                  <p class="letter-who">{whoOf(r, lang)}</p>
                  <p>{t(r.kind === "watashimo" ? "reaction.watashimo" : "me.reply")}</p>
                  {r.kind === "reply" && <p class="letter-body">{displayText(r, lang).main}</p>}
                  <p class="muted">
                    <a href={`/items/${r.itemId}`}>{items.get(r.itemId)?.title ?? ""}</a>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section class="panel me-station" id="radio">
          <h2>{t("me.station")}</h2>
          <p class="muted">{t("me.radioWhat")}</p>
          {radioUrl && (
            <div class="me-radio-url">
              <p>
                <span class={listener.stationPublic ? "me-radio-state on" : "me-radio-state"}>{t(listener.stationPublic ? "me.radioIsPublic" : "me.radioIsPrivate")}</span>{" "}
                {listener.stationPublic ? <a href={radioUrl}>{radioUrl}</a> : <code>{radioUrl}</code>}
              </p>
              <button type="button" class="pill" data-copy={radioUrl} data-copied={t("station.shared")}>{t("me.radioCopy")}</button>
            </div>
          )}
          <form method="post" action="/me/radio" class="me-radio-toggle">
            <input type="hidden" name="public" value={listener.stationPublic ? "0" : "1"} />
            <button type="submit" class={listener.stationPublic ? "quiet" : undefined}>{t(listener.stationPublic ? "me.radioUnpublish" : "me.radioPublish")}</button>
          </form>
          <form method="post" action="/me/radio" class="me-radio-slug">
            <label>
              <span>{t("me.radioSlug")}</span>
              <input type="text" name="slug" maxlength={24} pattern="[a-z0-9-]{3,24}" required value={radioError?.slug ?? listener.stationSlug ?? ""} autocapitalize="none" spellcheck={false} />
            </label>
            <button type="submit" class="quiet">{t("me.radioSlugSave")}</button>
            <small>{t("me.radioSlugHelp")}</small>
            {radioError && <p class="settings-error" role="alert">{t(RADIO_ERROR_TEXT[radioError.reason])}</p>}
          </form>
          <p class="muted">{t("me.radioNameOnly")}</p>
        </section>
        <section class="panel me-heard">
          <h2>{t("me.heard")}</h2>
          {heard.length === 0 ? (
            <p class="muted">{t("me.heardNone")}</p>
          ) : (
            <ul class="me-rows">
              {heard.map((h) => (
                <li>
                  {isHttp(h.item.imageUrl) ? <img class="thumb" src={h.item.imageUrl} alt="" width="40" height="40" loading="lazy" /> : <span class="thumb"></span>}
                  <span class="me-row-what">
                    <a href={`/items/${h.item.id}`}>{h.item.title}</a> · {h.letter.kind === "found" ? (h.letter.sourceAuthor ?? "") : whoOf(h.letter, lang)}
                  </span>
                  <span class="muted">{jstDate(h.heardAt)}</span>
                  <a class="me-row-replay" href={`/episodes/${h.episodeId}?letter=${encodeURIComponent(h.letter.id)}`}>{t("me.replay")}</a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </Layout>,
    !radioError ? 200 : radioError.reason === "failed" ? 503 : 422,
  );
}

me.get("/me", requireSignin, (c) => renderMe(c, c.get("listener")));

/** Exactly one of the two: the public toggle, or a new slug (the `/settings` rule: trimmed, lower-cased, `SLUG`). */
const radioForm = z.union([z.object({ public: z.enum(["0", "1"]) }).strict(), z.object({ slug: z.string().trim().toLowerCase().refine((v) => SLUG.test(v)) }).strict()]);

/** The caller's own public radio and nothing else: `station_public` or `station_slug` on their row. */
me.post(
  "/me/radio",
  requireSignin,
  zValidator("form", radioForm, async (result, ctx) => {
    if (result.success) return;
    const c = ctx as MeContext;
    const typed = (await c.req.parseBody()).slug;
    return renderMe(c, c.get("listener"), { slug: typeof typed === "string" ? typed : (c.get("listener").stationSlug ?? ""), reason: "invalid" });
  }),
  async (c) => {
    const listener = c.get("listener");
    const form = c.req.valid("form");
    if ("public" in form) {
      // Turning it on needs an address; one signed in before addresses were assigned gets it now.
      // If that fails nothing is written: the page says so and the listener can try again.
      if (form.public === "1") {
        try {
          await ensureStationSlug(c.env.DB, listener);
        } catch {
          return renderMe(c, listener, { slug: listener.stationSlug ?? "", reason: "failed" });
        }
      }
      await updateListener(c.env.DB, listener.id, { stationPublic: form.public === "1" });
      return c.redirect("/me#radio", 303);
    }
    try {
      await updateListener(c.env.DB, listener.id, { stationSlug: form.slug });
    } catch (e) {
      if (!isSlugTaken(e)) throw e;
      // Held by someone else: one UPDATE that failed, so nothing changed; the slug is theirs to change.
      return renderMe(c, listener, { slug: form.slug, reason: "taken" });
    }
    return c.redirect("/me#radio", 303);
  },
);

/** The sender takes a letter back: it turns `withdrawn`, which every reader treats as rejected. Only one's own letters, never a reply or a reaction. */
me.post("/letters/:id/withdraw", requireSignin, async (c) => {
  const id = c.req.param("id");
  const listener = c.get("listener");
  if (!(await withdrawLetter(c.env.DB, id, listener.id))) {
    // A second press (double submit, back and resubmit) is not an error for the sender; anyone else's id still looks unknown.
    const again = await getLetter(c.env.DB, id);
    if (!(again && again.listenerId === listener.id && again.kind === "letter" && again.status === "withdrawn")) return c.notFound();
  }
  return c.redirect("/me", 303);
});
