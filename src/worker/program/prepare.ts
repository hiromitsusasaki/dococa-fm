import { EMBED_BATCH, ensureItemVectors } from "../ai/embed";
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
  /**
   * `makeUnit` gave nothing for this letter: Claude failed (an API error or replies out of shape) or the unit
   * could not be stored. A run that throws counts the same toward the outage stop in `prepareBatch`.
   */
  unitFailed: boolean;
  /** Today's units are at `UNIT_DAILY_LIMIT`: further units would be refused too. Not a failure. */
  unitHalted: boolean;
};

const none = (): Run => ({ units: 0, audio: 0, failed: 0, audioHalted: false, unitFailed: false, unitHalted: false });

/** Names and counts only: a letter's text never reaches the log. */
function logFailure(e: unknown): void {
  console.error(`[dococa] prepare failed: ${e instanceof Error ? e.name : "unknown"}`);
}

/** One letter in one language: its unit when `steps.unit` and it is missing, then its clips when `steps.audio`. */
async function run(env: Env, db: D1Database, letterId: string, lang: Unit["lang"], steps: { unit: boolean; audio: boolean }): Promise<Run> {
  const out = none();
  const letter = await getLetter(db, letterId);
  if (!letter || letter.status !== "public" || (letter.kind !== "letter" && letter.kind !== "found")) return out;
  const item = await getItem(db, letter.itemId);
  if (!item) return out;

  let unit = (await getUnits(db, [letter.id], lang)).get(letter.id) ?? null;
  if (!unit) {
    if (!steps.unit || !hasClaude(env)) return out;
    if (await unitCapReached(env, db)) {
      out.unitHalted = true;
      return out;
    }
    const made = await makeUnit(env, db, letter, item, lang);
    // Another run is making this unit: skipped, neither a failure nor a miss.
    if (made === "busy") return out;
    unit = made;
    if (!unit) {
      out.failed++;
      out.unitFailed = true;
      return out;
    }
    out.units++;
  }
  if (!steps.audio) return out;

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
 * every dj/letter line of `unitSegment`; marks `audio_ready` when all clips exist. Every unit is made first
 * (ja, then en), then the clips (ja, then en): a letter gets its talk in both languages before any paid
 * voice. Once the cloud voice refuses a clip, the next language is not voiced. Non-public letters and
 * reactions are ignored. Never throws.
 */
export async function prepareLetter(env: Env, db: D1Database, letterId: string, lang?: Unit["lang"]): Promise<Prepared> {
  const total: Prepared = { units: 0, audio: 0, failed: 0 };
  let audioHalted = false;
  const langs = lang ? [lang] : LANGS;
  // A language whose unit step threw is not tried again for its clips: one failure per letter and language.
  const threw = new Set<Unit["lang"]>();
  for (const steps of [{ unit: true, audio: false }, { unit: false, audio: true }]) {
    for (const l of langs) {
      if (steps.audio && audioHalted) break;
      if (threw.has(l)) continue;
      try {
        const r = await run(env, db, letterId, l, steps);
        audioHalted ||= r.audioHalted;
        total.units += r.units;
        total.audio += r.audio;
        total.failed += r.failed;
      } catch (e) {
        logFailure(e);
        total.failed++;
        threw.add(l);
      }
    }
  }
  return total;
}

/** Letters in a row whose unit could not be made before the unit phase is taken for an outage and stops. */
const OUTAGE_AFTER = 3;

/** `vectors`: works still without an embedding (all of them while Workers AI is not bound). */
export type Remaining = { vectors: number; units: Record<Unit["lang"], number>; audio: Record<Unit["lang"], number> };

/**
 * `limit` is the whole run's budget, spent in order on work vectors (one per 20 works embedded), then letter-language
 * jobs: ja units, en units, ja audio, en audio, each letter run consuming one, and every listing asks for the remaining budget only. Stops making
 * audio at the first `limit`/`unavailable` answer, units at `UNIT_DAILY_LIMIT` (a halt, not a failure), and
 * units after 3 letters in a row that cannot get one, in either language (a single bad letter is counted as
 * failed and skipped, so newer letters are still reached).
 */
export async function prepareBatch(env: Env, db: D1Database, limit = 20): Promise<Prepared & { remaining: Remaining }> {
  const total: Prepared = { units: 0, audio: 0, failed: 0 };
  const add = (r: Prepared) => {
    total.units += r.units;
    total.audio += r.audio;
    total.failed += r.failed;
  };
  // Vectors first: they are cheap, and the next pick by distance needs them.
  const vectors = await ensureItemVectors(env, db, limit);
  let budget = limit - Math.ceil(vectors.made / EMBED_BATCH);
  let audioHalted = false;
  let unitHalted = false;
  let unitMisses = 0;
  const done = new Set<string>();
  const one = async (id: string, lang: Unit["lang"]) => {
    budget--;
    done.add(`${lang}:${id}`);
    try {
      const r = await run(env, db, id, lang, { unit: true, audio: !audioHalted });
      audioHalted ||= r.audioHalted;
      unitHalted ||= r.unitHalted;
      unitMisses = r.unitFailed ? unitMisses + 1 : r.units > 0 ? 0 : unitMisses;
      add(r);
    } catch (e) {
      logFailure(e);
      total.failed++;
      unitMisses++;
    }
  };
  const unitsStopped = () => unitHalted || unitMisses >= OUTAGE_AFTER;

  for (const lang of LANGS) {
    if (budget <= 0 || unitsStopped()) break;
    for (const id of await listLettersWithoutUnit(db, lang, budget)) {
      if (budget <= 0 || unitsStopped()) break;
      await one(id, lang);
    }
  }
  for (const lang of LANGS) {
    if (budget <= 0 || audioHalted) break;
    // Letters already run in the unit phase are skipped without spending budget, so the listing asks for them too.
    for (const u of await listUnitsWithoutAudio(db, lang, budget + done.size)) {
      if (budget <= 0 || audioHalted) break;
      if (!done.has(`${lang}:${u.letterId}`)) await one(u.letterId, lang);
    }
  }
  const remaining: Remaining = { vectors: vectors.remaining, units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 } };
  for (const lang of LANGS) {
    remaining.units[lang] = await countLettersWithoutUnit(db, lang);
    remaining.audio[lang] = await countUnitsWithoutAudio(db, lang);
  }
  return { ...total, remaining };
}
