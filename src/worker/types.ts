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
  /** The letter was sent by a demo account (read from the listener, never stored on the letter). */
  demo: boolean;
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
  /** The listener has already had their one cloud-voice episode. */
  cloudTtsUsed: boolean;
  /** An AI-made persona for the demo, shown with a mark wherever its letters appear. */
  demo: boolean;
  createdAt: string;
};

export type HistoryRow = {
  listenerId: string;
  itemId: string;
  source: "spotify" | "url" | "manual";
  occurredAt: string | null;
};

export type ScriptLine =
  /** `fixed` marks a line built from a template and data (names, places), never written by the model. */
  | { type: "dj"; text: string; fixed?: true }
  | {
      type: "letter";
      letterId: string;
      text: string;
      radioName: string;
      place: string;
      kind: LetterKind;
      sourceUrl: string | null;
      sourceAuthor: string | null;
      demo?: true;
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
  /** dj and letter lines of this episode may be read by the cloud voice (`GET /tts`). */
  cloudTts: boolean;
  createdAt: string;
};
