import { describe, expect, it } from "vitest";
import {
  MAX_LETTER,
  type Persona,
  checkLetter,
  checkPersona,
  parseArgs,
  parsePersonas,
  PERSONA_SYSTEM,
  personaPrompt,
  pickItems,
  parseItemUrls,
  letterPrompt,
  pageShows,
  parseLetters,
  type SeedItem,
} from "../../scripts/lib/seed";

const persona = (over: Partial<Persona> = {}): Persona => ({
  radioName: "Marisol",
  country: "México",
  place: "Oaxaca",
  ageGroup: "40代",
  taste: "ボレロと古い映画音楽",
  lang: "en",
  ...over,
});

describe("checkLetter", () => {
  it("accepts a plain line", () => {
    expect(checkLetter("My grandmother hummed this while she cooked.")).toEqual({ ok: true });
  });

  it("counts code points against the 200 limit", () => {
    expect(checkLetter("😀".repeat(MAX_LETTER)).ok).toBe(true);
    expect(checkLetter("😀".repeat(MAX_LETTER + 1))).toMatchObject({ ok: false, reason: "too long" });
    expect(checkLetter("  ")).toMatchObject({ ok: false, reason: "empty" });
  });

  it("rejects topical words with the same dictionary the DJ uses", () => {
    expect(checkLetter("今日もこの曲を聴いた")).toMatchObject({ ok: false, reason: "topical" });
    expect(checkLetter("令和の夜に")).toMatchObject({ ok: false, reason: "topical" });
  });

  it("rejects contact details", () => {
    expect(checkLetter("write me at a@b.co")).toMatchObject({ ok: false, reason: "pii" });
    expect(checkLetter("see https://example.com")).toMatchObject({ ok: false, reason: "pii" });
    expect(checkLetter("call 090-1234-5678")).toMatchObject({ ok: false, reason: "pii" });
  });

  it("rejects ranking and counting talk in english and japanese", () => {
    expect(checkLetter("This is the number 1 song ever")).toMatchObject({ ok: false, reason: "measure" });
    expect(checkLetter("It has 10 million views")).toMatchObject({ ok: false, reason: "measure" });
    expect(checkLetter("歴代 1 位の曲")).toMatchObject({ ok: false, reason: "measure" });
    expect(checkLetter("再生回数がすごい")).toMatchObject({ ok: false, reason: "measure" });
  });

  it("rejects a real person's name from the short list", () => {
    expect(checkLetter("It sounds like Taylor Swift")).toMatchObject({ ok: false, reason: "real person" });
    expect(checkLetter("宇多田ヒカルみたい")).toMatchObject({ ok: false, reason: "real person" });
  });
});

describe("checkPersona", () => {
  it("accepts a consistent fictional persona", () => {
    expect(checkPersona(persona())).toEqual({ ok: true });
  });

  it("rejects a real person's name as a radio name, contact-like text and a bad language", () => {
    expect(checkPersona(persona({ radioName: "Taylor Swift" }))).toMatchObject({ ok: false });
    expect(checkPersona(persona({ radioName: "@marisol_oax" }))).toMatchObject({ ok: false });
    expect(checkPersona(persona({ place: "a@b.co" }))).toMatchObject({ ok: false });
    expect(checkPersona(persona({ lang: "fr" as "en" }))).toMatchObject({ ok: false });
    expect(checkPersona(persona({ radioName: "" }))).toMatchObject({ ok: false });
  });
});

describe("parsePersonas", () => {
  it("keeps valid personas and drops the rest, with the reason", () => {
    const { personas, dropped } = parsePersonas({ personas: [persona(), { radioName: "x" }, persona({ radioName: "Taylor Swift" })] });
    expect(personas).toHaveLength(1);
    expect(dropped).toHaveLength(2);
  });

  it("drops a repeated radio name", () => {
    expect(parsePersonas({ personas: [persona(), persona()] }).personas).toHaveLength(1);
  });

  it("returns nothing for a non-object", () => {
    expect(parsePersonas(null).personas).toEqual([]);
  });
});

describe("pageShows", () => {
  it("is true only for a character-for-character match, after the page's html escaping is undone", () => {
    expect(pageShows("<p>I loved this at 15</p>", "I loved this at 15")).toBe(true);
    expect(pageShows("<p>I loved this at 15</p>", "I loved this at 15 ")).toBe(false);
    expect(pageShows(`<p>Don&#39;t &quot;stop&quot; &lt;b&gt; &amp; go</p>`, `Don't "stop" <b> & go`)).toBe(true);
    expect(pageShows("<p>hullo</p>", "hello")).toBe(false);
  });
});

describe("parseLetters", () => {
  const items: SeedItem[] = [
    { id: "i1", title: "Blue in Green", creator: "Miles Davis", kind: "music", url: "https://a.example/1" },
    { id: "i2", title: "Kitchen", creator: "Banana", kind: "book", url: "https://a.example/2" },
  ];

  it("keeps a valid line verbatim and drops lines that fail, naming the reason", () => {
    const raw = {
      letters: [
        { itemId: "i1", text: "Miles Davis made my kitchen quiet." },
        { itemId: "i2", text: "It was number 1 in my heart" },
        { itemId: "zz", text: "unknown item" },
      ],
    };
    const { letters, dropped } = parseLetters(raw, persona(), items);
    expect(letters).toEqual([{ itemId: "i1", body: "Miles Davis made my kitchen quiet." }]);
    expect(dropped).toHaveLength(2);
  });

  it("allows the creator's name in a letter about their work but not a different famous name", () => {
    expect(parseLetters({ letters: [{ itemId: "i1", text: "Like Bob Dylan, but quieter." }] }, persona(), items).letters).toEqual([]);
  });

  it("takes one line per item and requires the persona's language", () => {
    const dup = { letters: [{ itemId: "i1", text: "first" }, { itemId: "i1", text: "second" }] };
    expect(parseLetters(dup, persona(), items).letters).toHaveLength(1);
    expect(parseLetters({ letters: [{ itemId: "i1", text: "café au lait" }] }, persona(), items).letters).toEqual([]);
    expect(parseLetters({ letters: [{ itemId: "i1", text: "english only" }] }, persona({ lang: "ja" }), items).letters).toEqual([]);
  });

  it("returns nothing for a malformed answer", () => {
    expect(parseLetters(null, persona(), items).letters).toEqual([]);
    expect(parseLetters({ letters: "x" }, persona(), items).letters).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("reads the flags and the defaults", () => {
    expect(parseArgs(["--items", "urls.txt", "--origin", "http://127.0.0.1:5173/", "--token", "t"])).toEqual({
      personas: 30,
      items: "urls.txt",
      origin: "http://127.0.0.1:5173",
      token: "t",
      reuse: false,
      dryRun: false,
    });
    expect(parseArgs(["--items", "u.txt", "--reuse", "--dry-run"], { ADMIN_TOKEN: "t" })).toMatchObject({ reuse: true, dryRun: true });
    expect(parseArgs(["--personas", "3", "--items", "u.txt", "--origin", "http://x", "--token", "t"]).personas).toBe(3);
  });

  it("falls back to env for origin and token, never requiring the token on the command line", () => {
    expect(parseArgs(["--items", "u.txt"], { DOCOCA_ORIGIN: "http://o", ADMIN_TOKEN: "env-token" })).toMatchObject({ origin: "http://o", token: "env-token" });
  });

  it("refuses missing items, unknown flags and a bad count", () => {
    expect(() => parseArgs([], {})).toThrow(/usage/);
    expect(() => parseArgs(["--items", "u", "--nope", "x"], { ADMIN_TOKEN: "t" })).toThrow(/usage/);
    expect(() => parseArgs(["--items", "u", "--personas", "0"], { ADMIN_TOKEN: "t" })).toThrow(/usage/);
    expect(() => parseArgs(["--items", "u"], {})).toThrow(/ADMIN_TOKEN/);
  });
});

describe("parseItemUrls / pickItems", () => {
  it("reads one public url per line, skipping blanks, comments and non-urls", () => {
    expect(parseItemUrls("# list\nhttps://a.example/1\n\n  https://a.example/2  \nnot a url\nhttp://127.0.0.1/x\n")).toEqual(["https://a.example/1", "https://a.example/2"]);
  });

  it("picks 2 to 5 distinct items, deterministic for the same persona index", () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://a.example/${i}`);
    for (let i = 0; i < 20; i++) {
      const picked = pickItems(urls, i);
      expect(picked.length).toBeGreaterThanOrEqual(2);
      expect(picked.length).toBeLessThanOrEqual(5);
      expect(new Set(picked).size).toBe(picked.length);
      expect(pickItems(urls, i)).toEqual(picked);
    }
    expect(pickItems(["https://a.example/1"], 0)).toEqual(["https://a.example/1"]);
  });
});

describe("prompts", () => {
  it("tell the model to invent fictional people only and to avoid real names", () => {
    const p = personaPrompt(5, [persona()]);
    expect(p).toContain("架空");
    expect(p).toContain("Marisol");
    expect(PERSONA_SYSTEM).toContain("実在");
  });

  it("list the assigned items by id", () => {
    expect(letterPrompt(persona(), [{ id: "i1", title: "T", creator: "C", kind: "music", url: "u" }])).toContain("itemId: i1");
  });
});
