import { afterEach, describe, expect, it, vi } from "vitest";
import { searchBooks } from "../../../src/worker/resolve/books";
import { json, stubFetch } from "../../helpers/fetch";

const volume = {
  id: "vol123",
  volumeInfo: {
    title: "こころ",
    authors: ["夏目漱石", "別の人"],
    publishedDate: "2004-05",
    imageLinks: { thumbnail: "http://books.google.com/t.jpg" },
    industryIdentifiers: [
      { type: "ISBN_10", identifier: "4101010013" },
      { type: "ISBN_13", identifier: "9784101010014" },
    ],
    infoLink: "https://books.google.com/books?id=vol123",
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("searchBooks", () => {
  it("maps volumes to book drafts, https thumbnails, first author, isbn13", async () => {
    const { calls } = stubFetch([["https://www.googleapis.com/books/v1/volumes", () => json({ items: [volume] })]]);
    expect(await searchBooks("こころ")).toEqual([
      {
        kind: "book",
        title: "こころ",
        creator: "夏目漱石",
        year: 2004,
        imageUrl: "https://books.google.com/t.jpg",
        previewUrl: null,
        outLinks: { "google-books": "https://books.google.com/books?id=vol123" },
        externalIds: { "google-books": "vol123", isbn: "9784101010014" },
      },
    ]);
    expect(calls()).toEqual([`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent("こころ")}&maxResults=5`]);
  });

  it("uses an isbn: query when the text is an ISBN (hyphens ignored)", async () => {
    const { calls } = stubFetch([["https://www.googleapis.com/books/v1/volumes", () => json({ items: [] })]]);
    await searchBooks("978-4-10-101001-4");
    await searchBooks("4101010013");
    expect(calls()).toEqual([
      "https://www.googleapis.com/books/v1/volumes?q=isbn%3A9784101010014&maxResults=5",
      "https://www.googleapis.com/books/v1/volumes?q=isbn%3A4101010013&maxResults=5",
    ]);
  });

  it("sends the key as an X-Goog-Api-Key header only when given, never in the URL", async () => {
    const { fn } = stubFetch([["https://www.googleapis.com/books/v1/volumes", () => json({ items: [] })]]);
    await searchBooks("t", "K123");
    await searchBooks("t");
    await searchBooks("t", "");
    const sent = fn.mock.calls.map(([u, init]) => ({
      url: String(u),
      key: new Headers((init as RequestInit | undefined)?.headers).get("X-Goog-Api-Key"),
    }));
    expect(sent.map((c) => c.key)).toEqual(["K123", null, null]);
    for (const c of sent) expect(c.url).not.toContain("key=");
  });

  it("handles sparse volumes and missing items", async () => {
    stubFetch([["https://www.googleapis.com/books/v1/volumes", () => json({ items: [{ id: "x", volumeInfo: { title: "T" } }] })]]);
    expect(await searchBooks("t")).toEqual([
      { kind: "book", title: "T", creator: "", year: null, imageUrl: null, previewUrl: null, outLinks: {}, externalIds: { "google-books": "x" } },
    ]);
    stubFetch([["https://www.googleapis.com/books/v1/volumes", () => json({ totalItems: 0 })]]);
    expect(await searchBooks("t")).toEqual([]);
  });

  it("returns [] on non-2xx", async () => {
    stubFetch([["https://www.googleapis.com/", () => new Response("", { status: 429 })]]);
    expect(await searchBooks("t")).toEqual([]);
  });
});
