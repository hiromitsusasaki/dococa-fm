import { Hono } from "hono";
import { ItemCard, LetterSource, LetterText, ReactionForms, ReportForm, isHttpUrl, senderLine, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import { currentPath } from "../auth/require-signin";
import type { Variables } from "../auth/session";
import { getItem } from "../db/items";
import { getLetter } from "../db/letters";
import { getUnits } from "../db/units";
import type { Env } from "../env";
import { type Lang, tFor } from "../i18n/t";
import { displayText } from "../letters/display";
import { unitSegment } from "../program/unit";
import { letterAudioIpRateLimit } from "../security/rate-limit";
import { audioKey, ensureAudio, voiceOf } from "../tts/audio";
import type { Item, Letter, ScriptLine } from "../types";

export const letterPage = new Hono<{ Bindings: Env; Variables: Variables }>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAYER_WIDTH = 480;
const PLAYER_HEIGHT = 200;
const DESCRIPTION_CHARS = 100;
const AUDIO_HEADERS = { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" };

/** The player page is the only one another site may frame. */
export const isFramedPath = (path: string): boolean => /^\/letters\/[^/]+\/player$/.test(path);

type Shared = { letter: Letter; item: Item };

/** A public letter or found voice (a found voice only with its source) and its work; null for anything else. */
async function loadShared(db: D1Database, id: string): Promise<Shared | null> {
  if (!UUID.test(id)) return null;
  const letter = await getLetter(db, id);
  if (!letter || letter.status !== "public") return null;
  if (letter.kind !== "letter" && letter.kind !== "found") return null;
  if (letter.kind === "found" && !(letter.sourceUrl?.trim() && letter.sourceAuthor?.trim())) return null;
  const item = await getItem(db, letter.itemId);
  return item ? { letter, item } : null;
}

/** The letter's own language: the language its part of the radio is played in. */
const langOf = (letter: Letter): Lang => (letter.lang === "en" ? "en" : "ja");

type Voiced = Extract<ScriptLine, { type: "dj" | "letter" }>;
/** `n` is stable whatever the unit has: 0 lead, 1 intro, 2 hand-over, 3 letter, 4 after. */
type Slot = { n: number; line: Voiced };

/**
 * The letter's part of the radio, as the pre-generation voices it (`unitSegment`), so the clips are the same keys.
 * Without a verified unit, only the hand-over and the letter.
 */
async function slotsOf(db: D1Database, { letter, item }: Shared): Promise<{ lang: Lang; slots: Slot[] }> {
  const lang = langOf(letter);
  const unit = (await getUnits(db, [letter.id], lang)).get(letter.id);
  const verified = unit?.verified ? unit : null;
  let fixedSeen = 0;
  const slots: Slot[] = [];
  for (const line of unitSegment(verified, letter, item, lang).lines) {
    if (line.type === "letter") slots.push({ n: 3, line });
    else if (line.type === "dj") slots.push({ n: line.unit ? (line.unit.part === "intro" ? 1 : 4) : fixedSeen++ === 0 ? 0 : 2, line });
  }
  return { lang, slots: verified ? slots : slots.filter((s) => s.n === 2 || s.n === 3) };
}

/** What the voice says: a dj line's `spoken` when it has one, a letter as written. */
const said = (line: Voiced): string => (line.type === "dj" ? (line.spoken ?? line.text) : line.text);

const imageOf = (item: Item, origin: string): string => (isHttpUrl(item.imageUrl) ? item.imageUrl : `${origin}/kv.jpg`);

/** The play button and the line being read; `embed.js` wires it to `lines.json` and `audio/:n`. */
function EmbedPlayer({ shared, lang, openSite }: { shared: Shared; lang: Lang; openSite: boolean }) {
  const t = tFor(lang);
  const { letter, item } = shared;
  return (
    <section class="embed-player" data-embed={`/letters/${letter.id}`} data-play={t("player.play")} data-pause={t("player.pause")} aria-label={t("share.player")}>
      <span class="embed-art">{isHttpUrl(item.imageUrl) && <img src={item.imageUrl} alt="" width="96" height="96" />}</span>
      <div class="embed-body">
        <p class="embed-title">{item.title}</p>
        <p class="embed-who">{senderLine(letter, lang)}</p>
        <p class="embed-line" aria-live="polite"></p>
        <p class="embed-actions">
          <button type="button" class="embed-toggle" aria-pressed="false">{t("player.play")}</button>
          {openSite && (
            <a href={`/letters/${letter.id}`} target="_top">
              {t("share.openSite")}
            </a>
          )}
        </p>
      </div>
    </section>
  );
}

const embedScript = () => <script type="module" src={import.meta.env.DEV ? "/src/client/embed.tsx" : "/assets/embed.js"} />;

letterPage.get("/letters/:id", async (c) => {
  const shared = await loadShared(c.env.DB, c.req.param("id"));
  if (!shared) return c.notFound();
  const { letter, item } = shared;
  const listener = c.get("listener");
  const lang = listener.lang;
  const t = tFor(lang);
  const origin = c.env.PUBLIC_ORIGIN;
  const url = `${origin}/letters/${letter.id}`;

  // The first clip of the DJ's own lines, when it is already made: a crawler never sets off a synthesis.
  const { lang: voiceLang, slots } = await slotsOf(c.env.DB, shared);
  let audio: string | undefined;
  for (const s of slots.filter((s) => s.n <= 1)) {
    if (await c.env.BUCKET.head(await audioKey(voiceLang, voiceOf(c.env), said(s.line)))) {
      audio = `${url}/audio/${s.n}`;
      break;
    }
  }
  const og = {
    title: `${item.title} · ${senderLine(letter, lang)}`,
    description: Array.from(displayText(letter, lang).main).slice(0, DESCRIPTION_CHARS).join(""),
    url,
    type: "article" as const,
    image: imageOf(item, origin),
    ...(audio ? { audio } : {}),
    twitter: { card: "player" as const, player: `${url}/player`, width: PLAYER_WIDTH, height: PLAYER_HEIGHT },
  };

  return c.html(
    <Layout title={item.title} lang={lang} listener={listener} path={currentPath(c)} og={og}>
      <main class="letter-page">
        <ItemCard item={item} lang={lang} />
        <article class="letter">
          <LetterText letter={letter} lang={lang} />
          {letter.kind === "found" ? <LetterSource letter={letter} lang={lang} /> : <p class="letter-who">{whoOf(letter, lang)}</p>}
          <div class="letter-actions">
            <ReactionForms letterId={letter.id} itemId={item.id} lang={lang} />
            <ReportForm letterId={letter.id} lang={lang} />
          </div>
        </article>
        <EmbedPlayer shared={shared} lang={voiceLang} openSite={false} />
        <p>
          <a class="button" href={`/?letter=${letter.id}`}>{t("share.continue")}</a>
        </p>
      </main>
      {embedScript()}
    </Layout>,
  );
});

letterPage.get("/letters/:id/player", async (c) => {
  const shared = await loadShared(c.env.DB, c.req.param("id"));
  if (!shared) return c.notFound();
  const lang = langOf(shared.letter);
  const t = tFor(lang);
  return c.html(
    "<!doctype html>" +
      (
        <html lang={lang} data-theme="dark">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>{`${shared.item.title} | ${t("app.name")}`}</title>
            <link rel="stylesheet" href="/app.css" />
          </head>
          <body class="letter-player">
            <EmbedPlayer shared={shared} lang={lang} openSite />
            {embedScript()}
          </body>
        </html>
      ),
  );
});

letterPage.get("/letters/:id/lines.json", async (c) => {
  const shared = await loadShared(c.env.DB, c.req.param("id"));
  if (!shared) return c.json({ error: "not found" }, 404);
  const { slots } = await slotsOf(c.env.DB, shared);
  // The text as written: `spoken` never leaves the server.
  return c.json({ lines: slots.map(({ n, line }) => ({ n, type: line.type, text: line.text })) });
});

letterPage.get("/letters/:id/audio/:n", letterAudioIpRateLimit, async (c) => {
  const raw = c.req.param("n");
  if (!/^[0-4]$/.test(raw)) return c.json({ error: "not found" }, 404);
  const shared = await loadShared(c.env.DB, c.req.param("id"));
  if (!shared) return c.json({ error: "not found" }, 404);
  const { lang, slots } = await slotsOf(c.env.DB, shared);
  const slot = slots.find((s) => s.n === Number(raw));
  if (!slot) return c.json({ error: "not found" }, 404);

  // The same key and cap as `/tts`: a clip made here is the one every programme plays.
  const ensured = await ensureAudio(c.env, c.env.DB, { text: said(slot.line), lang, voice: voiceOf(c.env) });
  if (!ensured.ok) {
    if (ensured.reason === "limit") return c.json({ error: "tts limit" }, 503);
    if (ensured.reason === "busy") return c.json({ error: "tts busy" }, 503, { "retry-after": "2" });
    if (ensured.reason === "unavailable") return c.json({ error: "tts unavailable" }, 503);
    return c.json({ error: "tts failed" }, 502);
  }
  const clip = await c.env.BUCKET.get(ensured.key);
  if (!clip) return c.json({ error: "tts failed" }, 502);
  return new Response(clip.body, { headers: AUDIO_HEADERS });
});
