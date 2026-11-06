import type { Item, Letter, Listener } from "../../../src/worker/types";

export const item = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  kind: "music",
  title: "Blue in Green",
  creator: "Miles Davis",
  year: 1959,
  imageUrl: null,
  previewUrl: "https://example.com/a.m4a",
  outLinks: {},
  externalIds: {},
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

export const letter = (over: Partial<Letter> = {}): Letter => ({
  id: "l1",
  itemId: "i1",
  kind: "letter",
  body: "夜中に一人で聴いて、少しだけ泣きました。",
  bodyJa: "夜中に一人で聴いて、少しだけ泣きました。",
  bodyEn: null,
  lang: "ja",
  radioName: "みなと",
  place: "函館",
  placeCountry: null,
  placeRegion: null,
  year: null,
  listenerId: "someone",
  parentLetterId: null,
  sourceUrl: null,
  sourceAuthor: null,
  status: "public",
  demo: false,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

export const listener = (over: Partial<Listener> = {}): Listener => ({
  id: "listener-0001",
  radioName: "ヒロ",
  place: "大船渡",
  placeCountry: null,
  placeRegion: null,
  voice: "",
  dial: 0.3,
  lang: "ja",
  cloudTtsUsed: false,
  mcpToken: "mcp-token-secret-0001",
  spotifyRefreshToken: null,
  demo: false,
  googleSub: null,
  displayName: "",
  stationPublic: false,
  stationSlug: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

export const byId = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]));
