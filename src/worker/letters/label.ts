/** Pure text rules the server pages, the DJ script and the browser players all share, so the three cannot drift. */

export type SayKey = "letter.who" | "letter.whoPlace" | "letter.whoDemo" | "listener.anonymous" | "listener.demo";

/** The radio-name line: 「{name}さん」, with the place when there is one, and the 「デモ用」 mark for a demo account. `say` is `t()` on the server and the shipped strings in the browser. */
export function whoLine(l: { radioName: string; place: string; demo?: boolean }, say: (key: SayKey, params?: Record<string, string>) => string): string {
  const who = l.radioName ? say("letter.who", { name: l.radioName }) : say("listener.anonymous");
  const named = l.place ? say("letter.whoPlace", { who, place: l.place }) : who;
  return l.demo ? say("letter.whoDemo", { who: named, demo: say("listener.demo") }) : named;
}

/** Where a found voice was found: YouTube by name, otherwise the host without www. Empty when the url does not parse. */
export function siteLabel(sourceUrl: string | null): string {
  let host = "";
  try {
    host = new URL(sourceUrl ?? "").hostname.toLowerCase();
  } catch {
    return "";
  }
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return "YouTube";
  return host.replace(/^www\./, "");
}
