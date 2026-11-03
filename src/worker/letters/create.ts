import { moderateLetter } from "../claude/moderate";
import { type Lang, detectLang, translateToJa } from "../claude/translate";
import { getItem } from "../db/items";
import { countRecentDuplicate, getLetter, hasWatashimo, insertLetter } from "../db/letters";
import type { Env } from "../env";
import type { ja } from "../i18n/ja";
import { t } from "../i18n/t";
import { type ItemDraft, resolveOrCreate, resolveUrl } from "../resolve";
import type { Letter, LetterKind, Listener } from "../types";

export const MAX_BODY = 200;
const DUPLICATE_WINDOW_MINUTES = 10;

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
export async function createLetter(env: Env, db: D1Database, listener: Listener, input: LetterInput): Promise<LetterResult> {
  const kind = input.kind ?? "letter";
  const isWatashimo = kind === "watashimo";
  const body = isWatashimo ? t("reaction.watashimo") : input.body.trim();
  const fail = (status: LetterFailure["status"], key: LetterFailure["key"], extra: Partial<LetterFailure> = {}): LetterFailure => ({ ok: false, status, key, ...extra });

  if (body === "") return fail(422, "letters.empty");
  if (Array.from(body).length > MAX_BODY) return fail(422, "letters.tooLong");

  const stored = input.itemId ? await getItem(db, input.itemId) : null;
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
  if (!isWatashimo) {
    try {
      const verdict = await moderateLetter(env, body);
      if (!verdict.ok) return fail(422, "letters.rejected", { reason: verdict.reason, draft });
      lang = detectLang(body);
      bodyJa = await translateToJa(env, body, lang);
    } catch (e) {
      console.error("[dococa] letter judgement failed", e);
      return fail(503, "letters.unavailable", { draft });
    }
  }

  const item = stored ?? (await resolveOrCreate(db, draft));
  const letter = await insertLetter(db, {
    itemId: item.id,
    kind,
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
  return { ok: true, letter, itemId: item.id };
}
