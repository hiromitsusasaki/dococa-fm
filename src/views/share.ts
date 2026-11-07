/** X's compose page with the short text and the letter's public page; nothing else rides along. */
export const xIntentUrl = (text: string, url: string): string => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

/** The name a shared letter goes by: a found voice by its source's author, else the radio name (no place). */
export const shareSender = (l: { kind: string; radioName: string; sourceAuthor: string | null }, say: (key: "letter.who" | "listener.anonymous", params?: Record<string, string>) => string): string =>
  l.kind === "found" ? (l.sourceAuthor ?? "") : l.radioName ? say("letter.who", { name: l.radioName }) : say("listener.anonymous");
