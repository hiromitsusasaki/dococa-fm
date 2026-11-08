import { claude, escapeTags, hasClaude, model, oneLine } from "../claude/client";
import { listReactionsForLetter } from "../db/letters";
import { countUnitsToday, getReactionsSeen, getUnits, listLikedUnits, replaceUnit, upsertUnit } from "../db/units";
import type { Env } from "../env";
import { limitFrom } from "../limits";
import { claimTts, releaseTts } from "../tts/claim";
import type { Item, Letter, Reading, Segment, Unit } from "../types";
import { leadLine, letterLines, speechReadings, type UnitLines } from "./compose";
import { DJ_SYSTEM, DJ_SYSTEM_EN, letterTag, retryNote, workTag } from "./script";
import { verifyEpisode } from "./verify";

export type { UnitLines } from "./compose";

export const INTRO_MAX = 160;
export const AFTER_MAX = 120;
/** Readings kept from one reply; more are dropped. */
export const READINGS_MAX = 8;
/** Code points of a reading's written text, and of a reading. */
export const READING_TEXT_MAX = 40;
/** Replies out of shape are asked for again, up to this many calls. */
const ATTEMPTS = 3;
/** Checks rephrased lines can fix; verbatim and sources failures come from the data. */
const RETRYABLE = /^(?:topical|measure|pii|announce|playback|intro|lead): /;
/** Units made at once while a programme waits for them. */
const CONCURRENCY = 3;
/** A unit is for everyone, so it is checked against no listener's account. */
const NOBODY = { id: "", mcpToken: "" };
/** A unit's claim outlives a clip's: two writes of up to 3 attempts each can pass a minute. */
export const UNIT_CLAIM_TTL_MS = 180_000;
/** Units made per JST day when `UNIT_DAILY_LIMIT` is unset. */
export const DEFAULT_UNIT_DAILY_LIMIT = 1000;

/** Whether today's units have reached `UNIT_DAILY_LIMIT` (`0` pauses); counted before any Claude call. */
export async function unitCapReached(env: Env, db: D1Database): Promise<boolean> {
  const reached = (await countUnitsToday(db)) >= limitFrom(env.UNIT_DAILY_LIMIT, DEFAULT_UNIT_DAILY_LIMIT);
  if (reached) console.warn("[dococa] unit cap reached");
  return reached;
}

/**
 * Sonnet 5.5 rejects forced tool_choice and strict schemas drop maxLength, so the call is `auto` +
 * `strict`, the limits are stated in words, and `parse` enforces them.
 *
 * Readings (Japanese only) are free model output that only the voice says, so they are held tight: `parse` keeps a
 * reading only in full-width katakana, at most 3 katakana per Latin letter or digit and 2 per kanji of its text (at
 * least 2), never for a text without a Latin letter, digit or kanji or for a number alone, and only for a text the
 * unit's lines or the sender's name and place say; anything else is dropped. A unit's readings voice that unit's
 * lines and its hand-over only. The work's own reading (title, creator) never comes from here: it is asked for from
 * the work's data alone (`ensureItemReading`), never with a letter in the prompt. The spoken lines then get the same
 * checks as the written ones in `verifyEpisode`.
 */
const TOOL = {
  name: "write_unit",
  description: "このお便りの前に言う作品の紹介（intro）と、お便りの後に言う短い感想（after）を返す",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      intro: {
        type: "string",
        description: `作品を紹介する。送り主の名前と土地は言わない（手渡しは別の定型が言う）。お便りの引用も要約もしない。再生や視聴を促す言い方はしない。${INTRO_MAX} 字以内`,
      },
      after: { type: "string", description: `お便りへの短い感想。次のお便りの中身には触れない（つなぎは定型が言う）。${AFTER_MAX} 字以内` },
      readings: {
        type: "array",
        description: `音声が読み間違えそうな固有名（英字の略称・アーティスト名・難読の漢字など）の読み。text は intro・after・送り主の名前と土地のどれかにそのまま出てくる書き方、reading はカタカナだけ。画面には書いたままが出て、音声だけが reading を言う。読み間違えそうな名前だけ、${READINGS_MAX} 個まで。無ければ空の配列`,
        items: {
          type: "object",
          properties: { text: { type: "string", description: `書いたままの名前。${READING_TEXT_MAX} 字以内` }, reading: { type: "string", description: "カタカナの読み（例: PSY → サイ）" } },
          required: ["text", "reading"],
          additionalProperties: false,
        },
      },
    },
    required: ["intro", "after", "readings"],
    additionalProperties: false,
  },
};

/** `TOOL` for an English unit: the same name, shape and limits, described in English. */
const TOOL_EN = {
  ...TOOL,
  description: "Return the introduction of the work said before this letter (intro) and a short reaction said after it (after)",
  input_schema: {
    ...TOOL.input_schema,
    // English is voiced as written: no readings.
    required: ["intro", "after"],
    properties: {
      intro: {
        type: "string",
        description: `Introduces the work, in English. Do not say the sender's name or place (a fixed line hands over). Do not quote or summarise the letter. Never invite anyone to play, listen or watch. Keep it to at most ${INTRO_MAX} characters`,
      },
      after: { type: "string", description: `A short reaction to the letter, in English. Do not touch on the next letter (a fixed line makes the transition). Keep it to at most ${AFTER_MAX} characters` },
    },
  },
};

/** Liked intros shown to the DJ, newest first. */
const EXAMPLES = 5;

/** Places of the people who said 私も that reach the prompt, at most. */
export const REACTION_PLACES_MAX = 3;

/**
 * 私も has reached the letter. `places`: where the people who said it live (`place` strings, at most
 * `REACTION_PLACES_MAX`, none empty). Never their bodies, names or how many they are.
 */
export type ReactionNote = { places: string[] };

type UnitInput = { item: Item; letter: Letter; lang: Unit["lang"]; retryNotes?: string[]; examples?: string[]; reaction?: ReactionNote };

const placesJa = (r: ReactionNote) => r.places.map((p) => `『${escapeTags(oneLine(p))}』`).join("、");
const placesEn = (r: ReactionNote) => r.places.map((p) => `"${escapeTags(oneLine(p))}"`).join(", ");

/** The sentence added to the `after` description when 私も has reached the letter; nothing for a letter without one. */
function reactionDescription(lang: Unit["lang"], reaction: ReactionNote | undefined): string {
  if (!reaction) return "";
  const some = reaction.places.length > 0;
  if (lang === "en") {
    return `. People who feel the same have said "me too" to this letter${some ? `, from: ${placesEn(reaction)}` : ""}. In after you may say, in a few words, that others feel the same. Never say how many people or how many times. You may name the places`;
  }
  return `。このお便りには${some ? "、次の土地の人から" : ""}『私も』が届いている${some ? `: ${placesJa(reaction)}` : ""}。after で、同じ気持ちの人がいることに一言触れてよい。人数や件数は言わない。土地は言ってもよい`;
}

/** `TOOL` or `TOOL_EN`, with the `after` description told about the 私も of the unit being written. */
function toolFor(lang: Unit["lang"], reaction: ReactionNote | undefined) {
  const tool = lang === "en" ? TOOL_EN : TOOL;
  if (!reaction) return tool;
  const props = tool.input_schema.properties;
  return { ...tool, input_schema: { ...tool.input_schema, properties: { ...props, after: { ...props.after, description: props.after.description + reactionDescription(lang, reaction) } } } };
}

/** The owner's liked intros, one per line under a heading; intros only, so no letter ever reaches another unit's prompt. */
function examplesBlock(examples: string[] | undefined, lang: Unit["lang"]): string[] {
  if (!examples?.length) return [];
  const head = lang === "en" ? "Good examples (intro only; for style and length, not content)" : "良い例（intro のみ。文体と長さの参考。内容は写さない）";
  return ["", head, ...examples.map((e) => `- ${oneLine(escapeTags(e))}`)];
}

/**
 * The sender's place and radio name, which the fixed hand-over says, given only so a reading can be returned for
 * them; the intro still never names them (the `intro:` check). Nothing for a found voice or a sender without either.
 */
function senderForReadings(l: Letter): string[] {
  const parts = [...(l.place !== "" ? [`お住まい『${escapeTags(l.place)}』`] : []), ...(l.radioName !== "" ? [`ラジオネーム『${escapeTags(l.radioName)}』`] : [])];
  if (l.kind === "found" || parts.length === 0) return [];
  return [`手渡しの定型文は ${parts.join("、")} を言う。これは読み方を返すためだけ — intro で名指ししない。読み間違えそうなら readings に入れる。`];
}

/** One work and one letter; no listener line, since a unit airs in everyone's programme. */
function userMessage(input: UnitInput): string {
  const examples = examplesBlock(input.examples, input.lang);
  if (input.lang === "en") {
    const head = [
      "Write the intro and after for the next segment.",
      "A separate reader reads the letters and found voices word for word. Before that, a fixed line says the sender's name and place.",
      "You neither quote nor summarise: in intro you introduce the work, and in after you react briefly to what the letter says.",
      `Just before your intro, a fixed line says: "${escapeTags(leadLine(input.item, "en").text)}" Your intro follows it: start without repeating the title or the creator.`,
    ];
    const retry = input.retryNotes?.length ? ["", retryNote(input.retryNotes, "en")] : [];
    const segment = ["<segment>", workTag(input.item, "en"), letterTag(input.letter, "en"), "</segment>"].join("\n");
    return [...head, ...retry, "", segment, ...examples].join("\n");
  }
  const head = [
    "次のセグメントに、intro と after を書いてください。",
    "お便りと見つけた声は、別の読み上げ役が原文のまま読みます。送り主の名前と土地は、その前に定型文が言います。",
    "あなたは引用も要約もせず、intro で作品を紹介し、after でお便りの内容に短く反応します。",
    `直前に『${escapeTags(leadLine(input.item, "ja").text)}』と告げてある。intro はその続きで、題名と作者を繰り返さずに始める。`,
    "音声合成が読み間違えそうな固有名（英字の略称やアーティスト名、難読の漢字・地名）があれば、その読みをカタカナで readings に入れる。読み間違えそうな名前だけでよく、intro と after は書いたままの表記で書く。",
    ...senderForReadings(input.letter),
  ];
  const retry = input.retryNotes?.length ? ["", retryNote(input.retryNotes)] : [];
  const segment = ["<segment>", workTag(input.item), letterTag(input.letter), "</segment>"].join("\n");
  return [...head, ...retry, "", segment, ...examples].join("\n");
}

/** A line in shape: a string, not blank, at most `max` code points. A blank line is asked for again like a missing one. */
const within = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && Array.from(v).length <= max;

/** Full-width katakana, ー and ・ only, with a space between words. */
const KATAKANA = /^[ァ-ヶー・](?:[ァ-ヶー・ 　]*[ァ-ヶー・])?$/u;
/** A name worth a reading has a Latin letter, a digit or a kanji in it; kana alone is read as written. */
export const NEEDS_READING = /[\p{Script=Latin}\p{N}\p{Script=Han}]/u;
/** Digits with punctuation, symbols or spaces only: a number, not a name, so it never gets a reading. */
const NUMBER_ONLY = /^[\p{N}\p{P}\p{S}\s]+$/u;

/**
 * The most katakana a reading of `text` may have: 3 per Latin letter or digit and 2 per kanji (or other letter) of
 * the text, at least 2. Kana, punctuation and spaces in the text add nothing.
 */
function readingRoom(text: string): number {
  let room = 0;
  for (const c of text) {
    if (/[\p{Script=Latin}\p{N}]/u.test(c)) room += 3;
    else if (/\p{L}/u.test(c) && !/[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(c)) room += 2;
  }
  return Math.max(2, room);
}

/**
 * Whether `reading` is a reading the voice may say for `text`: full-width katakana only, no longer than
 * `readingRoom(text)`, for a text with a Latin letter, a digit or a kanji in it that is not a number alone.
 */
export function isReadingOf(text: string, reading: unknown): reading is string {
  if (typeof reading !== "string" || text === "" || !NEEDS_READING.test(text) || NUMBER_ONLY.test(text)) return false;
  const r = reading.trim();
  return KATAKANA.test(r) && Array.from(r).length <= readingRoom(text);
}

/** Unit lines and their readings, as one reply gives them. */
export type WrittenUnit = UnitLines;

/**
 * The readings worth keeping, in the reply's order: a written text of up to `READING_TEXT_MAX` code points that is not
 * kana alone and appears verbatim in the intro, the after, the sender's place or radio name,
 * with a reading `isReadingOf` accepts; at most
 * `READINGS_MAX`, one per text. Anything else is dropped, never failed: a unit is fine without readings.
 */
function keptReadings(raw: unknown, said: string[]): Reading[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, string>();
  for (const r of raw as { text?: unknown; reading?: unknown }[]) {
    if (out.size >= READINGS_MAX) break;
    const text = typeof r?.text === "string" ? r.text.trim() : "";
    if (text === "" || Array.from(text).length > READING_TEXT_MAX || out.has(text)) continue;
    if (!isReadingOf(text, r.reading) || !said.some((s) => s.includes(text))) continue;
    out.set(text, r.reading.trim());
  }
  return [...out].map(([text, reading]) => ({ text, reading }));
}

/** The tool's input as unit lines, or null when it is missing or out of shape. Readings are Japanese only. */
function parse(content: { type: string; name?: string; input?: unknown }[], letter: Letter, lang: Unit["lang"]): WrittenUnit | null {
  const block = content.find((b) => b.type === "tool_use" && b.name === TOOL.name);
  const input = block?.input as { intro?: unknown; after?: unknown; readings?: unknown } | undefined;
  if (!within(input?.intro, INTRO_MAX) || !within(input?.after, AFTER_MAX)) return null;
  const lines = { intro: input.intro, after: input.after };
  if (lang !== "ja") return lines;
  // Only what the unit's lines say (talk and hand-over): the hand-over says the sender's radio name and place.
  const sender = [letter.radioName, letter.place].filter((v) => v !== "");
  const readings = keptReadings(input.readings, [lines.intro, lines.after, ...sender]);
  return { ...lines, ...(readings.length ? { readings } : {}) };
}

/**
 * One Claude call with the single tool `write_unit` { intro, after, readings }; retried
 * up to 3 times when the reply is out of shape.
 */
export async function writeUnitLines(env: Env, input: UnitInput): Promise<WrittenUnit> {
  const client = claude(env);
  const content = userMessage(input);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const res = await client.messages.create({
      model: model(env),
      max_tokens: 1024,
      system: input.lang === "en" ? DJ_SYSTEM_EN : DJ_SYSTEM,
      tools: [toolFor(input.lang, input.reaction)],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content }],
    });
    const lines = parse(res.content, input.letter, input.lang);
    if (lines) return lines;
  }
  throw new Error("dj unit invalid");
}

/**
 * The one-segment layout a unit is verified and voiced with: [lead(fixed), intro?, hand-over(fixed), letter, after?].
 * No bridges. Japanese dj lines carry `spoken` where the unit's or the work's readings change what the voice says.
 */
export function unitSegment(unit: UnitLines | null, letter: Letter, item: Item, lang: Unit["lang"]): Segment {
  return { itemId: item.id, slot: "near", lines: [leadLine(item, lang), ...letterLines(letter, unit, true, lang, speechReadings(unit, item, lang))] };
}

function verifyUnit(lines: UnitLines, letter: Letter, item: Item, lang: Unit["lang"]): { ok: boolean; details: string[] } {
  const report = verifyEpisode([unitSegment(lines, letter, item, lang)], new Map([[letter.id, letter]]), NOBODY, new Map([[item.id, item]]), lang);
  return { ok: report.verbatim && report.sources && report.topical && report.pii, details: report.details };
}

/**
 * write → unitSegment → verifyEpisode; one retry with the retryable details; stores verified 0/1 and returns
 * the stored row (a verified unit already stored is kept over the new lines). Null when Claude is unavailable
 * (no key, an API error, or replies out of shape) or today's units are at `UNIT_DAILY_LIMIT`: nothing is
 * stored, so a later run makes it. `"busy"` when another run holds the claim on `unit:<letterId>:<lang>`
 * (`tts_claims`, held for `UNIT_CLAIM_TTL_MS`): one maker per unit.
 */
export async function makeUnit(env: Env, db: D1Database, letter: Letter, item: Item, lang: Unit["lang"]): Promise<Unit | null | "busy"> {
  if (!hasClaude(env)) return null;
  if (await unitCapReached(env, db)) return null;
  const claim = `unit:${letter.id}:${lang}`;
  if (!(await claimTts(db, claim, Date.now(), UNIT_CLAIM_TTL_MS))) return "busy";
  try {
    return await writeAndStore(env, db, letter, item, lang);
  } finally {
    await releaseTts(db, claim);
  }
}

/** The liked intros for the prompt; none when they cannot be read, since a unit is better made without examples than not at all. */
async function likedIntros(db: D1Database, lang: Unit["lang"]): Promise<string[]> {
  try {
    return (await listLikedUnits(db, lang, EXAMPLES)).map((u) => u.intro);
  } catch (e) {
    console.warn("[dococa] liked intros unavailable", e instanceof Error ? e.name : "unknown error");
    return [];
  }
}

/** The owner's remake, as `remakeUnit` answers it. */
export type Remade = "remade" | "busy" | "capped" | "failed";

/**
 * The owner's remake of a unit. The old unit stays until a new verified one is stored: the claim on
 * `unit:<letterId>:<lang>` is held throughout, the new lines are written and verified (one retry, as `makeUnit`), and
 * only then one batch notes the remake and replaces the row (`replaceUnit`). Claude unavailable, lines that fail
 * verification, or a failed write: `"failed"`, the old row untouched. Today's cap reached: `"capped"`. Another run
 * holds the claim: `"busy"`. The clips are not made here. The work's reading (`items.reading_ja`) is not touched.
 */
export async function remakeUnit(env: Env, db: D1Database, letter: Letter, item: Item, lang: Unit["lang"], reaction?: ReactionNote & { seen: number }): Promise<Remade> {
  if (!hasClaude(env)) return "failed";
  const claim = `unit:${letter.id}:${lang}`;
  if (!(await claimTts(db, claim, Date.now(), UNIT_CLAIM_TTL_MS))) return "busy";
  try {
    if (await unitCapReached(env, db)) return "capped";
    const written = await writeChecked(env, db, letter, item, lang, reaction ? { places: reaction.places } : undefined);
    if (!written?.ok) return "failed";
    try {
      await replaceUnit(db, { letterId: letter.id, lang, intro: written.lines.intro, after: written.lines.after, readings: written.lines.readings, ...(reaction ? { reactionsSeen: reaction.seen } : {}) });
    } catch (e) {
      // The name only: a D1 error message can quote the statement and its bound values, which carry the lines.
      console.warn("[dococa] dj unit could not be stored", e instanceof Error ? e.name : "unknown error");
      return "failed";
    }
    return "remade";
  } finally {
    await releaseTts(db, claim);
  }
}

/**
 * write → verify, with one retry on the retryable details. Null when Claude is unavailable (an API error, or replies
 * out of shape). The lines are verified as they will air: with their readings, and the work's stored ones.
 */
async function writeChecked(env: Env, db: D1Database, letter: Letter, item: Item, lang: Unit["lang"], reaction?: ReactionNote): Promise<{ lines: WrittenUnit; ok: boolean } | null> {
  let lines: WrittenUnit;
  let ok: boolean;
  const examples = await likedIntros(db, lang);
  try {
    lines = await writeUnitLines(env, { item, letter, lang, examples, reaction });
    let check = verifyUnit(lines, letter, item, lang);
    if (!check.ok) {
      console.warn("[dococa] dj unit failed verification", check.details.join("; "));
      const retryNotes = check.details.filter((d) => RETRYABLE.test(d));
      if (retryNotes.length > 0) {
        lines = await writeUnitLines(env, { item, letter, lang, retryNotes, examples, reaction });
        check = verifyUnit(lines, letter, item, lang);
        if (!check.ok) console.warn("[dococa] dj unit failed verification again", check.details.join("; "));
      }
    }
    ok = check.ok;
  } catch (e) {
    // The name and status only: an API error's message can echo the request, which carries the letter.
    const status = (e as { status?: unknown } | null)?.status;
    console.warn(
      "[dococa] dj unit unavailable; reading the letter with fixed lines",
      typeof status === "number" ? `status ${status}` : "no status",
      e instanceof Error ? e.name : "unknown error",
    );
    return null;
  }
  return { lines, ok };
}

async function writeAndStore(env: Env, db: D1Database, letter: Letter, item: Item, lang: Unit["lang"]): Promise<Unit | null> {
  const written = await writeChecked(env, db, letter, item, lang);
  if (!written) return null;
  const { lines, ok } = written;
  try {
    await upsertUnit(db, { letterId: letter.id, lang, intro: lines.intro, after: lines.after, ...(lines.readings ? { readings: lines.readings } : {}), verified: ok, audioReady: false });
    return (await getUnits(db, [letter.id], lang)).get(letter.id) ?? null;
  } catch (e) {
    // The name only: a D1 error message can quote the statement and its bound values, which carry the lines.
    console.warn("[dococa] dj unit could not be stored", e instanceof Error ? e.name : "unknown error");
    return null;
  }
}

/**
 * Stored units for the letters, making the missing ones (concurrency 3) when `hasClaude(env)`. Once Claude
 * turns out unavailable, the rest are not tried in this run. A letter another run is making a unit for is
 * read again after the batch, and goes without one if it is still missing. Reactions have no unit and are skipped.
 */
export async function ensureUnits(env: Env, db: D1Database, letters: Letter[], items: ReadonlyMap<string, Item>, lang: Unit["lang"]): Promise<Map<string, Unit>> {
  const units = await getUnits(db, letters.map((l) => l.id), lang);
  const missing = letters.filter((l) => (l.kind === "letter" || l.kind === "found") && !units.has(l.id) && items.has(l.itemId));
  if (missing.length === 0) return units;
  if (!hasClaude(env)) {
    console.warn(`[dococa] ANTHROPIC_API_KEY is empty; ${missing.length} letter(s) read with fixed lines only`);
    return units;
  }
  let unavailable = false;
  let next = 0;
  const busy: string[] = [];
  const worker = async () => {
    while (!unavailable && next < missing.length) {
      const l = missing[next++]!;
      const unit = await makeUnit(env, db, l, items.get(l.itemId)!, lang);
      if (unit === "busy") busy.push(l.id);
      else if (unit) units.set(l.id, unit);
      else unavailable = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  if (busy.length > 0) for (const [id, u] of await getUnits(db, busy, lang)) units.set(id, u);
  return units;
}

/** A unit is written again when 私も reaches this many distinct countries (for the first time). */
export const REACTION_COUNTRIES = 3;

/**
 * A 私も reached the letter: the unit is written again (`remakeUnit`) in each language it exists in, in two cases only:
 * the first 私も, and the senders now spanning `REACTION_COUNTRIES` distinct `placeCountry` values for the first time.
 * `units.reactions_seen` is the number of 私も (oldest first) the unit was last written with, so each case fires
 * once: the first when it is 0, the second when the first `reactions_seen` senders spanned fewer countries than all
 * do now. Claude gets the places only (`ReactionNote`). A remake that fails leaves the count, and the old unit airs on.
 * Returns the languages remade. Never throws.
 */
export async function remakeForReaction(env: Env, db: D1Database, letter: Letter, item: Item): Promise<Unit["lang"][]> {
  const remade: Unit["lang"][] = [];
  if (!hasClaude(env) || letter.status !== "public" || (letter.kind !== "letter" && letter.kind !== "found")) return remade;
  try {
    const reactions = (await listReactionsForLetter(db, letter.id)).filter((r) => r.kind === "watashimo");
    if (reactions.length === 0) return remade;
    const countries = (rs: Letter[]) => new Set(rs.flatMap((r) => (r.placeCountry ? [r.placeCountry] : [])));
    const places = [...new Set(reactions.map((r) => r.place.trim()).filter((p) => p !== ""))].slice(0, REACTION_PLACES_MAX);
    for (const lang of ["ja", "en"] as const) {
      const seen = await getReactionsSeen(db, letter.id, lang);
      if (seen === null || seen >= reactions.length) continue;
      const spread = countries(reactions).size >= REACTION_COUNTRIES && countries(reactions.slice(0, seen)).size < REACTION_COUNTRIES;
      if (seen > 0 && !spread) continue;
      if ((await remakeUnit(env, db, letter, item, lang, { places, seen: reactions.length })) === "remade") remade.push(lang);
    }
  } catch (e) {
    console.warn("[dococa] reaction remake failed", e instanceof Error ? e.name : "unknown error");
  }
  return remade;
}
