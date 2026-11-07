import { describe, expect, it } from "vitest";
import { letterShareText, ShareLinks } from "../../../src/views/components";

describe("share links", () => {
  const url = "https://dococafm.app/letters/L1";

  it("goes to X with only the short text and the letter's public page, opened in a new tab", async () => {
    const html = String(await ShareLinks({ url, text: "曲A · しずくさんのお便り — Dococa FM", lang: "ja" }));
    const href = html.match(/<a class="pill" href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    const intent = new URL(href);
    expect(intent.origin + intent.pathname).toBe("https://x.com/intent/post");
    expect(Object.fromEntries(intent.searchParams)).toEqual({ text: "曲A · しずくさんのお便り — Dococa FM", url });
    expect(html).toContain('target="_blank" rel="noopener"');
    expect(html).toContain(">X で共有</a>");
  });

  it("draws the share-sheet button hidden for the script to show, and the copy button with its toast", async () => {
    const html = String(await ShareLinks({ url, text: "t", lang: "en" }));
    expect(html).toMatch(/<button type="button" class="pill" data-share="https:\/\/dococafm.app\/letters\/L1" data-text="t" hidden="">Share<\/button>/);
    expect(html).toContain(`data-copy="${url}" data-copied="Link copied">Copy link</button>`);
    expect(html).toContain(">Share on X</a>");
  });

  it("names the work and the radio name, never the place; a found voice by its author, never as a letter", () => {
    expect(letterShareText("曲A", { kind: "letter", radioName: "しずく", sourceAuthor: null }, "ja")).toBe("曲A · しずくさんのお便り — Dococa FM");
    expect(letterShareText("Song A", { kind: "letter", radioName: "Shizuku", sourceAuthor: null }, "en")).toBe("Song A · a letter from Shizuku — Dococa FM");
    expect(letterShareText("曲A", { kind: "letter", radioName: "", sourceAuthor: null }, "ja")).toBe("曲A · 名無しのリスナーのお便り — Dococa FM");
    // A found voice is not a letter: by its author, or as a found voice when there is none.
    expect(letterShareText("曲A", { kind: "found", radioName: "", sourceAuthor: "誰か" }, "ja")).toBe("曲A · 出典: 誰かさんの声 — Dococa FM");
    expect(letterShareText("曲A", { kind: "found", radioName: "", sourceAuthor: null }, "ja")).toBe("曲A · 見つけた声 — Dococa FM");
    expect(letterShareText("Song A", { kind: "found", radioName: "", sourceAuthor: "Someone" }, "en")).toBe("Song A · a voice from Someone — Dococa FM");
    expect(letterShareText("Song A", { kind: "found", radioName: "", sourceAuthor: null }, "en")).toBe("Song A · a voice found online — Dococa FM");
  });
});
