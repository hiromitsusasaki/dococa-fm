export type ItemKind = "music" | "book" | "film";

export type Item = {
  id: string;
  kind: ItemKind;
  title: string;
  creator: string;
  year: number | null;
  imageUrl: string | null;
  previewUrl: string | null;
  outLinks: Record<string, string>;
  externalIds: Record<string, string>;
  createdAt: string;
};

export type LetterKind = "letter" | "found" | "reply" | "watashimo";

export type Letter = {
  id: string;
  itemId: string;
  kind: LetterKind;
  body: string;
  bodyJa: string;
  lang: string;
  radioName: string;
  place: string;
  year: number | null;
  listenerId: string | null;
  parentLetterId: string | null;
  sourceUrl: string | null;
  sourceAuthor: string | null;
  status: "public" | "rejected";
  createdAt: string;
};

export type Listener = {
  id: string;
  radioName: string;
  place: string;
  voice: string;
  dial: number;
  lang: "ja";
  mcpToken: string;
  spotifyRefreshToken: string | null;
  createdAt: string;
};

export type HistoryRow = {
  listenerId: string;
  itemId: string;
  source: "spotify" | "url" | "manual";
  occurredAt: string | null;
};

export type ScriptLine =
  | { type: "dj"; text: string }
  | {
      type: "letter";
      letterId: string;
      text: string;
      radioName: string;
      place: string;
      kind: LetterKind;
      sourceUrl: string | null;
      sourceAuthor: string | null;
    }
  | { type: "preview"; url: string; seconds: 30 };

export type Segment = {
  itemId: string;
  slot: "near" | "neighbor" | "far";
  lines: ScriptLine[];
};

export type VerifyReport = {
  verbatim: boolean;
  sources: boolean;
  topical: boolean;
  pii: boolean;
  details: string[];
};

export type Episode = {
  id: string;
  listenerId: string;
  segments: Segment[];
  verified: boolean;
  report: VerifyReport;
  createdAt: string;
};
