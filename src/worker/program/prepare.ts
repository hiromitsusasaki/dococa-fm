import { getItem } from "../db/items";
import { getLetter } from "../db/letters";
import { countLettersWithoutUnit, countUnitsWithoutAudio, getUnits, listLettersWithoutUnit, listUnitsWithoutAudio, setUnitAudioReady } from "../db/units";
import { hasClaude } from "../claude/client";
import type { Env } from "../env";
import { ensureAudio, voiceOf } from "../tts/audio";
import type { Unit } from "../types";
import { makeUnit, unitCapReached, unitSegment } from "./unit";

export type Prepared = { units: number; audio: number; failed: number };

type Run = Prepared & {
  /** The cloud voice is over its cap or has no key: further clips would be refused too. */
  audioHalted: boolean;
  /** No unit could be made for this letter (malformed replies, an outage or a store failure). */
  unitFailed: boolean;
  /** Today's units are at `UNIT_DAILY_LIMIT`: further units would be refused too. Not a failure. */
  unitHalted: boolean;
};

const none = (): Run => ({ units: 0, audio: 0, failed: 0, audioHalted: false, unitFailed: false, unitHalted: false });

/** Names and counts only: a letter's text never reaches the log. */
function logFailure(e: unknown): void {
  console.error(`[dococa] prepare failed: ${e instanceof Error ? e.name : "unknown"}`);
}

async function run(env: Env, db: D1Database, letterId: string, lang: Unit["lang"], withAudio: boolean): Promise<Run> {
  const out = none();
  const letter = await getLetter(db, letterId);
  if (!letter || letter.status !== "public" || (letter.kind !== "letter" && letter.kind !== "found")) return out;
  const item = await getItem(db, letter.itemId);
  if (!item) return out;

  let unit = (await getUnits(db, [letter.id], lang)).get(letter.id) ?? null;
  if (!unit) {
    if (!hasClaude(env)) return out;
    if (await unitCapReached(env, db)) {
      out.unitHalted = true;
      return out;
    }
    unit = await makeUnit(env, db, letter, item, lang);
    if (!unit) {
      out.failed++;
      out.unitFailed = true;
      return out;
    }
    out.units++;
  }
  if (!withAudio) return out;

  // An unverified unit is never spoken, so only the fixed hand-over and the letter are voiced for it.
  const texts = unitSegment(unit.verified ? unit : null, letter, item, lang).lines.flatMap((l) => (l.type === "dj" || l.type === "letter") && l.text !== "" ? [l.text] : []);
  const voice = voiceOf(env);
  let complete = true;
  for (const text of texts) {
    const r = await ensureAudio(env, db, { text, lang, voice });
    if (r.ok) {
      if (r.made) out.audio++;
      continue;
    }
    complete = false;
    if (r.reason === "limit" || r.reason === "unavailable") {
      out.audioHalted = true;
      break;
    }
    out.failed++;
  }
  if (complete && unit.verified) await setUnitAudioReady(db, letter.id, lang, true, unit);
  return out;
}

/** Every language a unit is made in: a letter airs in the Japanese and the English programme alike. */
const LANGS: readonly Unit["lang"][] = ["ja", "en"];

/**
 * The letter's unit in `lang` (made if missing), or in every language when none is named, and the audio of
 * every dj/letter line of `unitSegment`; marks `audio_ready` when all clips exist. Once the cloud voice
 * refuses a clip, the next language makes its unit only. Non-public letters and reactions are ignored. Never throws.
 */
export async function prepareLetter(env: Env, db: D1Database, letterId: string, lang?: Unit["lang"]): Promise<Prepared> {
  const total: Prepared = { units: 0, audio: 0, failed: 0 };
  let audioHalted = false;
  for (const l of lang ? [lang] : LANGS) {
    try {
      const r = await run(env, db, letterId, l, !audioHalted);
      audioHalted ||= r.audioHalted;
      total.units += r.units;
      total.audio += r.audio;
      total.failed += r.failed;
    } catch (e) {
      logFailure(e);
      total.failed++;
    }
  }
  return total;
}

/** Letters in a row whose unit could not be made before the unit phase is taken for an outage and stops. */
const OUTAGE_AFTER = 3;

export type Remaining = { units: Record<Unit["lang"], number>; audio: Record<Unit["lang"], number> };

/**
 * Per language, `ja` first then `en`: up to `limit` letters without a unit, then up to `limit` verified units
 * without audio. Stops making audio at the first `limit`/`unavailable` answer, units at `UNIT_DAILY_LIMIT`
 * (a halt, not a failure), and units after 3 letters in a row that cannot get one, in either language (a single bad letter is counted as failed and skipped, so newer
 * letters are still reached).
 */
export async function prepareBatch(env: Env, db: D1Database, limit = 20): Promise<Prepared & { remaining: Remaining }> {
  const total: Prepared = { units: 0, audio: 0, failed: 0 };
  const add = (r: Prepared) => {
    total.units += r.units;
    total.audio += r.audio;
    total.failed += r.failed;
  };
  let audioHalted = false;
  let unitHalted = false;
  let unitMisses = 0;
  const done = new Set<string>();
  const one = async (id: string, lang: Unit["lang"]) => {
    done.add(`${lang}:${id}`);
    try {
      const r = await run(env, db, id, lang, !audioHalted);
      audioHalted ||= r.audioHalted;
      unitHalted ||= r.unitHalted;
      unitMisses = r.unitFailed ? unitMisses + 1 : r.units > 0 ? 0 : unitMisses;
      add(r);
    } catch (e) {
      logFailure(e);
      total.failed++;
    }
  };

  for (const lang of LANGS) {
    for (const id of await listLettersWithoutUnit(db, lang, limit)) {
      if (unitHalted || unitMisses >= OUTAGE_AFTER) break;
      await one(id, lang);
    }
  }
  for (const lang of LANGS) {
    if (audioHalted) break;
    for (const u of await listUnitsWithoutAudio(db, lang, limit)) {
      if (audioHalted) break;
      if (!done.has(`${lang}:${u.letterId}`)) await one(u.letterId, lang);
    }
  }
  const remaining: Remaining = { units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 } };
  for (const lang of LANGS) {
    remaining.units[lang] = await countLettersWithoutUnit(db, lang);
    remaining.audio[lang] = await countUnitsWithoutAudio(db, lang);
  }
  return { ...total, remaining };
}
