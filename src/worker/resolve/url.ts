export type Provider = "spotify" | "youtube" | "apple-music" | "amazon" | "filmarks" | "letterboxd" | "netflix";
export type ParsedUrl = { provider: Provider | "unknown"; id?: string };

const host = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`);

export function parseKnownUrl(raw: string): ParsedUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { provider: "unknown" };
  }
  const h = u.hostname.toLowerCase();
  const path = u.pathname;

  if (host(h, "spotify.com")) {
    const m = /\/track\/([A-Za-z0-9]+)/.exec(path);
    if (m) return { provider: "spotify", id: m[1] };
  } else if (h === "youtu.be") {
    const m = /^\/([\w-]{6,})/.exec(path);
    if (m) return { provider: "youtube", id: m[1] };
  } else if (host(h, "youtube.com")) {
    const v = u.searchParams.get("v");
    if (path === "/watch" && v) return { provider: "youtube", id: v };
  } else if (h === "music.apple.com") {
    const i = u.searchParams.get("i");
    return i ? { provider: "apple-music", id: i } : { provider: "apple-music" };
  } else if (/(^|\.)amazon\.(co\.jp|com)$/.test(h)) {
    const m = /\/(?:dp|gp\/product)\/([A-Za-z0-9]{10})/.exec(path);
    if (m) return { provider: "amazon", id: m[1] };
  } else if (host(h, "filmarks.com")) {
    const m = /\/movies\/(\d+)/.exec(path);
    if (m) return { provider: "filmarks", id: m[1] };
  } else if (host(h, "letterboxd.com")) {
    const m = /\/film\/([^/]+)/.exec(path);
    if (m) return { provider: "letterboxd", id: m[1] };
  } else if (host(h, "netflix.com")) {
    const m = /\/title\/(\d+)/.exec(path);
    if (m) return { provider: "netflix", id: m[1] };
  }
  return { provider: "unknown" };
}
