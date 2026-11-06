import { getItem } from "../db/items";
import { getLetter } from "../db/letters";
import { countLettersWithoutUnit, countUnitsWithoutAudio, getUnits, listLettersWithoutUnit, listUnitsWithoutAudio, setUnitAudioReady } from "../db/units";
import { hasClaude } from "../claude/client";
import type { Env } from "../env";
import { ensureAudio, voiceOf } from "../tts/audio";
import type { Unit } from "../types";
import { makeUnit, unitSegment } from "./unit";

export type Prepared = { units: number; audio: number; failed: number };

type Run = Prepared & {
  /** The cloud voice is over its cap or has no key: further clips would be refused too. */
  audioHalted: boolean;
  /** Claude could not make a unit: further units would fail the same way. */
  unitsHalted: boolean;
};

const none = (): Run => ({ units: 0, audio: 0, failed: 0, audioHalted: false, unitsHalted: false });

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
    unit = await makeUnit(env, db, letter, item, lang);
    if (!unit) {
      out.failed++;
      out.unitsHalted = true;
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
  if (complete && unit.verified) await setUnitAudioReady(db, letter.id, lang, true);
  return out;
}

const strip = ({ units, audio, failed }: Run): Prepared => ({ units, audio, failed });

/**
 * The letter's unit in `lang` (made if missing) and the audio of every dj/letter line of `unitSegment`;
 * marks `audio_ready` when all clips exist. Non-public letters and reactions are ignored. Never throws.
 */
export async function prepareLetter(env: Env, db: D1Database, letterId: string, lang: Unit["lang"] = "ja"): Promise<Prepared> {
  try {
    return strip(await run(env, db, letterId, lang, true));
  } catch (e) {
    logFailure(e);
    return { units: 0, audio: 0, failed: 1 };
  }
}

/**
 * Up to `limit` letters without a unit, then up to `limit` verified units without audio. Stops making audio
 * at the first `limit`/`unavailable` answer and units at the first Claude failure.
 */
export async function prepareBatch(env: Env, db: D1Database, limit = 20): Promise<Prepared & { remaining: { units: number; audio: number } }> {
  const total: Prepared = { units: 0, audio: 0, failed: 0 };
  const add = (r: Prepared) => {
    total.units += r.units;
    total.audio += r.audio;
    total.failed += r.failed;
  };
  const lang = "ja" as const;
  let audioHalted = false;
  let unitsHalted = false;
  const done = new Set<string>();
  const one = async (id: string) => {
    done.add(id);
    try {
      const r = await run(env, db, id, lang, !audioHalted);
      audioHalted ||= r.audioHalted;
      unitsHalted ||= r.unitsHalted;
      add(r);
    } catch (e) {
      logFailure(e);
      total.failed++;
    }
  };

  for (const id of await listLettersWithoutUnit(db, lang, limit)) {
    if (unitsHalted) break;
    await one(id);
  }
  if (!audioHalted) {
    for (const u of await listUnitsWithoutAudio(db, lang, limit)) {
      if (audioHalted) break;
      if (!done.has(u.letterId)) await one(u.letterId);
    }
  }
  return { ...total, remaining: { units: await countLettersWithoutUnit(db, lang), audio: await countUnitsWithoutAudio(db, lang) } };
}
