/** X's compose page with the short text and the letter's public page; nothing else rides along. */
export const xIntentUrl = (text: string, url: string): string => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

type ShareKey = "share.text" | "share.textFound" | "share.textFoundNoAuthor" | "letter.who" | "listener.anonymous";

/**
 * The short text a shared letter goes out with: the work and the radio name (no place). A found voice is not a letter: it goes by its
 * source's author, or as a found voice when the author is unknown.
 */
export function shareText(work: string, l: { kind: string; radioName: string; sourceAuthor: string | null }, say: (key: ShareKey, params?: Record<string, string>) => string): string {
  if (l.kind === "found") return l.sourceAuthor ? say("share.textFound", { work, author: l.sourceAuthor }) : say("share.textFoundNoAuthor", { work });
  return say("share.text", { work, sender: l.radioName ? say("letter.who", { name: l.radioName }) : say("listener.anonymous") });
}
