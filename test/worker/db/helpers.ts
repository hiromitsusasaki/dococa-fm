import type { Item, Letter } from "../../../src/worker/types";

export const itemDraft = (over: Partial<Omit<Item, "id" | "createdAt">> = {}): Omit<Item, "id" | "createdAt"> => ({
  kind: "music",
  title: "Blue in Green",
  creator: "Miles Davis",
  year: 1959,
  imageUrl: "https://example.com/a.jpg",
  previewUrl: "https://example.com/a.m4a",
  outLinks: { itunes: "https://music.apple.com/x" },
  externalIds: { itunes: "1669547856" },
  ...over,
});

export const letterDraft = (
  itemId: string,
  over: Partial<Omit<Letter, "id" | "createdAt">> = {},
): Omit<Letter, "id" | "createdAt"> => ({
  itemId,
  kind: "letter",
  body: "ありがとう",
  bodyJa: "ありがとう",
  lang: "ja",
  radioName: "ラジオネーム",
  place: "札幌",
  year: null,
  listenerId: null,
  parentLetterId: null,
  sourceUrl: null,
  sourceAuthor: null,
  status: "public",
  ...over,
});

/** Storage is shared by all tests in a file, so each test starts from empty tables (children first for FKs). */
export async function resetDb(db: D1Database): Promise<void> {
  await db.batch(
    ["reports", "takedowns", "history", "episodes", "letters", "listeners", "items"].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
}
