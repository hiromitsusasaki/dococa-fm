/** The pure parts of the demo seeder: prompts, validation of what the model wrote, and argument handling. */
import { containsTopical } from "../../src/worker/program/topical-words.ts";
import { looksLikeContact, normalizeText } from "../../src/worker/program/pii-patterns.ts";
import { stripHtml } from "./found.ts";

export const MAX_LETTER = 200;
export const MIN_ITEMS = 2;
export const MAX_ITEMS = 5;
export const PERSONA_BATCH = 10;
export const MODEL = "claude-sonnet-5-5";

export type PersonaLang = "ja" | "en";
export type Persona = { radioName: string; country: string; place: string; ageGroup: string; taste: string; lang: PersonaLang };
export type Check = { ok: true } | { ok: false; reason: string };

const codePoints = (s: string): number => Array.from(s).length;

/** A short list of famous people. It catches the obvious slip of a model naming a real person; it is not a screen for every name. */
const REAL_PEOPLE = [
  "Taylor Swift", "Beyoncé", "Beyonce", "Bob Dylan", "Madonna", "Michael Jackson", "Elvis Presley", "David Bowie", "Prince", "Adele",
  "Ed Sheeran", "Billie Eilish", "Bruno Mars", "Rihanna", "Lady Gaga", "Kanye West", "Drake", "Eminem", "Paul McCartney", "John Lennon",
  "Haruki Murakami", "Stephen King", "J.K. Rowling", "Elon Musk", "Barack Obama", "Donald Trump", "Joe Biden", "Steve Jobs", "Bill Gates",
  "Messi", "Ronaldo", "Shakira", "Bad Bunny", "Björk", "Bjork", "Rosalía", "Rosalia",
  "宇多田ヒカル", "米津玄師", "星野源", "あいみょん", "山下達郎", "松任谷由実", "坂本龍一", "村上春樹", "吉本ばなな", "大谷翔平", "木村拓哉", "安倍晋三",
];
const norm = (s: string): string => normalizeText(s).toLowerCase();
const REAL_NORMALIZED = REAL_PEOPLE.map(norm);
const LATIN = /^[a-z0-9 .'-]+$/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A latin name must stand as whole words (Prince is not princess); a name in another script is matched as a substring. */
const mentions = (text: string, name: string): boolean =>
  LATIN.test(name) ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, "u").test(text) : text.includes(name);

/** Names that belong to the work itself (its creator) are allowed in a letter about it. */
const hitsRealPerson = (text: string, allow: string[] = []): boolean => {
  let t = norm(text);
  for (const a of allow) if (a.trim() !== "") t = t.split(norm(a)).join(" ");
  return REAL_NORMALIZED.some((n) => mentions(t, n));
};

/** Talk that measures a work or a person by numbers or rank. The program never does, so a letter that does is not seeded. */
const MEASURE =
  /(?:number\s*(?:one|1)|no\.\s*(?:one|1)|#\s*1)\b|\btop\s*\d+|\b\d[\d,.]*\s*(?:million|billion|thousand|k)\b|\b\d[\d,.]*\s*(?:views|plays|streams|likes|stars|followers|copies|downloads|ratings?)\b|\b\d+\s*(?:\/|out of)\s*(?:10|5|100)\b|\branked?\b|\bchart[- ]?topp|\bbillboard\b|歴代|ランキング|ランク|再生回数|[0-9０-９]+\s*(?:位|万回|回再生|票|点満点|冊目)|満点|売上|累計/iu;

export function checkLetter(text: string, lang?: PersonaLang, allow: string[] = []): Check {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (text !== text.trim()) return { ok: false, reason: "surrounding whitespace" };
  if (codePoints(text) > MAX_LETTER) return { ok: false, reason: "too long" };
  if (text.includes("\n")) return { ok: false, reason: "not one line" };
  if (containsTopical(text)) return { ok: false, reason: "topical" };
  if (looksLikeContact(text)) return { ok: false, reason: "pii" };
  if (MEASURE.test(normalizeText(text))) return { ok: false, reason: "measure" };
  if (hitsRealPerson(text, allow)) return { ok: false, reason: "real person" };
  // The worker reads the language from the script of the text, so the text has to match the persona's language.
  if (lang === "en" && !/^[\x20-\x7e]*$/.test(text)) return { ok: false, reason: "english letters must be plain ascii" };
  if (lang === "ja" && !/[぀-ヿ一-鿿]/.test(text)) return { ok: false, reason: "japanese letters must contain japanese" };
  return { ok: true };
}

const FIELD_MAX = 60;
/** The limits of the settings screen, which `POST /admin/listeners` shares. */
export const MAX_RADIO_NAME = 20;
export const MAX_PLACE = 30;
/** The place as posted: town and country together, so it has to fit the 30 characters as a whole. */
export const placeOf = (p: Pick<Persona, "place" | "country">): string => `${p.place}、${p.country}`;
const isText = (v: unknown, max = FIELD_MAX): v is string => typeof v === "string" && v.trim() !== "" && codePoints(v) <= max;

export function checkPersona(p: Persona): Check {
  for (const [k, v] of Object.entries({ radioName: p.radioName, country: p.country, place: p.place, ageGroup: p.ageGroup, taste: p.taste })) {
    if (!isText(v, k === "taste" ? 120 : FIELD_MAX)) return { ok: false, reason: `${k} is missing or too long` };
    if (looksLikeContact(v) || /^@|^#/.test(v.trim())) return { ok: false, reason: `${k} looks like a handle or contact` };
  }
  if (codePoints(p.radioName.trim()) > MAX_RADIO_NAME) return { ok: false, reason: `radioName is over ${MAX_RADIO_NAME} characters` };
  if (codePoints(placeOf({ place: p.place.trim(), country: p.country.trim() })) > MAX_PLACE) return { ok: false, reason: `place and country are over ${MAX_PLACE} characters together` };
  if (p.lang !== "ja" && p.lang !== "en") return { ok: false, reason: "lang must be ja or en" };
  if (hitsRealPerson(`${p.radioName}`)) return { ok: false, reason: "real person" };
  return { ok: true };
}

/** Keeps the valid personas of a model answer, drops a repeated radio name, and says why anything was dropped. */
export function parsePersonas(raw: unknown, known: Persona[] = []): { personas: Persona[]; dropped: string[] } {
  const list = (raw as { personas?: unknown } | null)?.personas;
  const personas: Persona[] = [];
  const dropped: string[] = [];
  const seen = new Set(known.map((p) => norm(p.radioName)));
  for (const [i, v] of (Array.isArray(list) ? list : []).entries()) {
    const o = (v ?? {}) as Record<string, unknown>;
    const p = { radioName: o.radioName, country: o.country, place: o.place, ageGroup: o.ageGroup, taste: o.taste, lang: o.lang } as Persona;
    const verdict = typeof p.radioName === "string" ? checkPersona(p) : ({ ok: false, reason: "not a persona" } as const);
    if (!verdict.ok) dropped.push(`personas[${i}]: ${verdict.reason}`);
    else if (seen.has(norm(p.radioName))) dropped.push(`personas[${i}]: repeated radio name`);
    else {
      seen.add(norm(p.radioName));
      personas.push({ radioName: p.radioName.trim(), country: p.country.trim(), place: p.place.trim(), ageGroup: p.ageGroup.trim(), taste: p.taste.trim(), lang: p.lang });
    }
  }
  return { personas, dropped };
}

export type SeedItem = { id: string; title: string; creator: string; kind: string; url: string };
export type SeedLetter = { itemId: string; body: string };

/** Keeps one valid line per assigned item. The text is stored as the model wrote it; only whole lines are kept or dropped. */
export function parseLetters(raw: unknown, persona: Persona, items: SeedItem[]): { letters: SeedLetter[]; dropped: string[] } {
  const list = (raw as { letters?: unknown } | null)?.letters;
  const byId = new Map(items.map((i) => [i.id, i]));
  const used = new Set<string>();
  const letters: SeedLetter[] = [];
  const dropped: string[] = [];
  for (const [i, v] of (Array.isArray(list) ? list : []).entries()) {
    const o = (v ?? {}) as { itemId?: unknown; text?: unknown };
    const item = typeof o.itemId === "string" ? byId.get(o.itemId) : undefined;
    if (!item || typeof o.text !== "string") dropped.push(`letters[${i}]: unknown item or no text`);
    else if (used.has(item.id)) dropped.push(`letters[${i}]: second line for the same item`);
    else {
      const verdict = checkLetter(o.text, persona.lang, [item.creator]);
      if (!verdict.ok) dropped.push(`letters[${i}] (${item.title}): ${verdict.reason}`);
      else {
        used.add(item.id);
        letters.push({ itemId: item.id, body: o.text });
      }
    }
  }
  return { letters, dropped };
}

/** True when the page shows `text` character for character, after the page's own HTML escaping is undone. */
export const pageShows = (html: string, text: string): boolean => stripHtml(html).includes(text);

export const PERSONA_SYSTEM = `あなたは、世界中のリスナーが集まるラジオ番組のデモ用に、架空のリスナーを作る係です。
作るのはすべて架空の人物です。実在の人物（有名人、作家、音楽家、政治家、身近な人）の名前・ハンドル・SNS アカウント名は使わないこと。
名前・土地・年代・好みが一貫した、その土地にいそうな普通の人にします。ラジオネームは本名ではなく、ニックネームです（20 字以内）。町の名前と国の名前は合わせて 28 字以内に収めます。
連絡先、URL、メールアドレス、@ から始まる名前は書かないこと。`;

export function personaPrompt(count: number, existing: Persona[]): string {
  const used = existing.map((p) => `${p.radioName}（${p.country}）`).join("、");
  return `架空のリスナーを ${count} 人作ってください。
- できるだけ多くの国と地域から。日本からは全体の 4 分の 1 までにする。
- 年代（10代〜70代）と好み（音楽・本・映画のどれに偏るか、ジャンル、時代）もばらけさせる。
- lang は、その人が普段お便りを書く言語。日本の人は ja、それ以外の国の人は en。
- 実在の人物の名前は使わない。すべて架空であること。
${used === "" ? "" : `- すでにいるリスナー（重ならないように）: ${used}\n`}`;
}

export const PERSONA_TOOL = {
  name: "submit_personas",
  description: "作った架空のリスナーを提出する",
  input_schema: {
    type: "object" as const,
    properties: {
      personas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            radioName: { type: "string", description: "ラジオネーム（ニックネーム）" },
            country: { type: "string", description: "国または地域名（日本語）" },
            place: { type: "string", description: "町や地方の名前（日本語または現地の表記）" },
            ageGroup: { type: "string", description: "例: 30代" },
            taste: { type: "string", description: "好みの傾向を一文で" },
            lang: { type: "string", enum: ["ja", "en"] },
          },
          required: ["radioName", "country", "place", "ageGroup", "taste", "lang"],
          additionalProperties: false,
        },
      },
    },
    required: ["personas"],
    additionalProperties: false,
  },
};

export const LETTER_SYSTEM = `あなたは、次のリスナーになりきって、好きな作品への一言を書く係です。
書くのは、その人の言葉の一行（200 字以内）だけです。作品の紹介文ではなく、その人と作品の間にある小さな記憶や感じ方を書きます。
- 時事（今日・最近・今年・流行・ニュースなど、書いた日がわかる言葉）、年号、季節の行事は書かない。
- 個人を特定できる情報、連絡先、URL は書かない。実在の人物の名前（作品の作者を除く）も出さない。
- 再生回数・順位・点数・売上など、数字や順位で作品や人を測る言い方をしない。
- 1 行に収め、改行しない。
- lang が en の人は、アクセント記号や特殊な引用符を使わない半角英数字と基本の記号だけの英語で書く。ja の人は日本語で書く。`;

export function letterPrompt(p: Persona, items: SeedItem[]): string {
  const list = items.map((i) => `- itemId: ${i.id} / ${i.title} / ${i.creator}（${i.kind}）`).join("\n");
  return `リスナー: ${p.radioName}（${p.country}・${p.place}、${p.ageGroup}、lang=${p.lang}）
好み: ${p.taste}

次の作品それぞれに、この人らしい一言を 1 つずつ書いてください。

${list}`;
}

export const LETTER_TOOL = {
  name: "submit_letters",
  description: "書いた一言を提出する",
  input_schema: {
    type: "object" as const,
    properties: {
      letters: {
        type: "array",
        items: {
          type: "object",
          properties: { itemId: { type: "string" }, text: { type: "string" } },
          required: ["itemId", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["letters"],
    additionalProperties: false,
  },
};

export const USAGE =
  "usage: pnpm seed --items <file of item urls> [--personas 30] [--origin <url>] [--token <ADMIN_TOKEN>] [--reuse] [--dry-run]\n       origin defaults to $DOCOCA_ORIGIN, token to $ADMIN_TOKEN";

export type Args = { personas: number; items: string; origin: string; token: string; reuse: boolean; dryRun: boolean };

const VALUE_FLAGS = ["--personas", "--items", "--origin", "--token"];
const SWITCHES = ["--reuse", "--dry-run"];

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Args {
  const value = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (SWITCHES.includes(a)) continue;
    const v = argv[i + 1];
    if (!VALUE_FLAGS.includes(a) || v === undefined || v.startsWith("--")) throw new Error(USAGE);
    value.set(a, v);
    i++;
  }
  const personas = value.has("--personas") ? Number(value.get("--personas")) : 30;
  const items = value.get("--items");
  const origin = (value.get("--origin") ?? env.DOCOCA_ORIGIN ?? "http://127.0.0.1:5173").replace(/\/$/, "");
  const token = value.get("--token") ?? env.ADMIN_TOKEN;
  if (!items || !Number.isInteger(personas) || personas < 1 || personas > 100) throw new Error(USAGE);
  if (!token) throw new Error("ADMIN_TOKEN is not set (use --token or the environment)");
  return { personas, items, origin, token, reuse: argv.includes("--reuse"), dryRun: argv.includes("--dry-run") };
}

/** One public http(s) url per line; blank lines, `#` comments and anything else are skipped. */
export function parseItemUrls(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l) && !/^https?:\/\/(?:localhost|127\.|10\.|192\.168\.|\[)/i.test(l));
}

/** The first of each item id, so one work is never assigned twice to the same persona. */
export const uniqueById = (items: SeedItem[]): SeedItem[] => items.filter((it, i) => items.findIndex((o) => o.id === it.id) === i);

/** 2 to 5 distinct items for the persona at `index`: a rotating window, so the same list gives the same assignment and every item is reached. */
export function pickItems(urls: string[], index: number): string[] {
  const count = Math.min(urls.length, MIN_ITEMS + (index % (MAX_ITEMS - MIN_ITEMS + 1)));
  const start = (index * 3) % Math.max(urls.length, 1);
  return Array.from({ length: count }, (_, k) => urls[(start + k) % urls.length]!);
}
