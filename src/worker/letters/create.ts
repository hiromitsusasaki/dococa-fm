import { moderateLetter } from "../claude/moderate";
import { type Lang, detectLang, translateLetter } from "../claude/translate";
import { getItem } from "../db/items";
import { countLettersToday, countRecentDuplicate, getLetter, hasWatashimo, insertLetter } from "../db/letters";
import type { Env } from "../env";
import { limitFrom } from "../limits";
import { saneTranslation } from "./display";
import type { ja } from "../i18n/ja";
import { t } from "../i18n/t";
import { type ItemDraft, resolveOrCreate, resolveUrl } from "../resolve";
import type { Item, Letter, LetterKind, Listener } from "../types";

export const MAX_BODY = 200;
const DUPLICATE_WINDOW_MINUTES = 10;
/** Letters and replies stored per JST day, everyone together, when `LETTER_GLOBAL_DAILY_LIMIT` is unset. */
export const DEFAULT_LETTER_GLOBAL_DAILY_LIMIT = 500;

export type LetterInput = {
  url?: string;
  itemId?: string;
  body: string;
  kind?: Exclude<LetterKind, "found">;
  parentLetterId?: string;
};

export type LetterFailure = {
  ok: false;
  status: 422 | 429 | 409 | 503;
  /** The i18n key of the message for this failure. */
  key: keyof typeof ja;
  /** Set with `letters.rejected`: the moderation reason, as the suffix of `letters.reason.*`. */
  reason?: string;
  /** The item the person was writing about, when it could be found (not yet stored for a URL). */
  draft?: ItemDraft | null;
};

export type LetterResult = { ok: true; letter: Letter; itemId: string } | LetterFailure;

/** The shared letter pipeline: checks, moderation, translation, insert. The caller maps failures to its own surface. */
export async function createLetter(
  env: Env,
  db: D1Database,
  listener: Listener,
  input: LetterInput,
  /** The stored item `input.itemId` names, when the caller already has it (saves a query). */
  known: { item?: Item } = {},
): Promise<LetterResult> {
  const kind = input.kind ?? "letter";
  const isWatashimo = kind === "watashimo";
  const body = isWatashimo ? t("reaction.watashimo") : input.body.trim();
  const fail = (status: LetterFailure["status"], key: LetterFailure["key"], extra: Partial<LetterFailure> = {}): LetterFailure => ({ ok: false, status, key, ...extra });

  if (body === "") return fail(422, "letters.empty");
  if (Array.from(body).length > MAX_BODY) return fail(422, "letters.tooLong");

  const stored = input.itemId ? (known.item?.id === input.itemId ? known.item : await getItem(db, input.itemId)) : null;
  const draft = stored ?? (input.url ? await resolveUrl(input.url, env) : null);
  if (!draft) return fail(422, "put.notFound");

  // A reaction hangs off a public top-level letter of the same stored item; a plain letter has no parent.
  const parent = input.parentLetterId ? await getLetter(db, input.parentLetterId) : null;
  const isReaction = kind !== "letter";
  const parentOk = parent !== null && stored !== null && parent.itemId === stored.id && parent.parentLetterId === null && parent.status === "public";
  if (isReaction ? !parentOk : input.parentLetterId !== undefined) return fail(422, "letters.badParent", { draft });
  if (isWatashimo && (await hasWatashimo(db, listener.id, parent!.id))) return fail(409, "letters.watashimoDuplicate", { draft });
  // Every 私も has the same text, so only the same-parent rule above limits it.
  if (!isWatashimo && (await countRecentDuplicate(db, listener.id, body, DUPLICATE_WINDOW_MINUTES)) >= 1) return fail(429, "letters.duplicate", { draft });

  let lang: Lang = "ja";
  let bodyJa = body;
  let bodyEn: string | null = isWatashimo ? t("reaction.watashimo", undefined, "en") : body;
  if (!isWatashimo) {
    // Moderation and translation are paid calls; the cheap 私も is not capped.
    if ((await countLettersToday(db)) >= limitFrom(env.LETTER_GLOBAL_DAILY_LIMIT, DEFAULT_LETTER_GLOBAL_DAILY_LIMIT)) return fail(429, "letters.dailyLimit", { draft });
    try {
      const verdict = await moderateLetter(env, body, { title: draft.title, creator: draft.creator });
      if (!verdict.ok) return fail(422, "letters.rejected", { reason: verdict.reason, draft });
      lang = detectLang(body);
      // One call per language the letter was not written in; the other column keeps the original.
      // The Japanese text is what the DJ reads, so its failure is fatal. A translation that fails the sanity
      // check is not stored (the column is NOT NULL for Japanese, so the original stands in for it).
      const ja = await translateLetter(env, body, lang, "ja");
      bodyJa = saneTranslation(body, ja) ? ja : body;
    } catch (e) {
      console.error("[dococa] letter judgement failed", e);
      return fail(503, "letters.unavailable", { draft });
    }
    // The English rendering is a convenience: if it fails, the letter is still stored and shows its original.
    try {
      const en = await translateLetter(env, body, lang, "en");
      bodyEn = saneTranslation(body, en) ? en : null;
    } catch (e) {
      console.error("[dococa] english translation failed", e instanceof Error ? e.name : "error");
      bodyEn = null;
    }
  }

  const item = stored ?? (await resolveOrCreate(db, draft));
  const letter = await insertLetter(db, {
    itemId: item.id,
    kind,
    body,
    bodyJa,
    bodyEn,
    lang,
    radioName: listener.radioName,
    place: listener.place,
    placeCountry: listener.placeCountry,
    placeRegion: listener.placeRegion,
    year: null,
    listenerId: listener.id,
    parentLetterId: parent?.id ?? null,
    sourceUrl: null,
    sourceAuthor: null,
    status: "public",
  });
  return { ok: true, letter, itemId: item.id };
}
