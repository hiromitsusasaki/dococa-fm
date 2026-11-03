import { fetchText } from "./http";
import type { Provider } from "./url";

export type Ogp = { title: string; image: string | null; description: string | null };

const decodeEntities = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export async function fetchOgp(url: string): Promise<Ogp | null> {
  const body = await fetchText(url);
  if (body === null) return null;
  const found: Record<string, string> = {};
  for (const tag of body.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? "";
    }
    const key = attrs.property ?? attrs.name;
    if ((key === "og:title" || key === "og:image" || key === "og:description") && attrs.content !== undefined && !(key in found)) {
      found[key] = decodeEntities(attrs.content);
    }
  }
  const title = found["og:title"]?.trim();
  if (!title) return null;
  let image: string | null = null;
  if (found["og:image"]) {
    try {
      image = new URL(found["og:image"], url).href;
    } catch {
      image = null;
    }
  }
  return { title, image, description: found["og:description"]?.trim() || null };
}

/** Strips each site's boilerplate from og:title (and pulls out a year when the site puts one there). */
export function cleanOgpTitle(provider: Provider, raw: string): { title: string; year: number | null } {
  if (provider === "filmarks") {
    const m = /^(?:映画|ドラマ|アニメ)『(.+?)』/.exec(raw);
    return { title: m?.[1] ?? raw, year: null };
  }
  if (provider === "letterboxd") {
    const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(raw);
    return m ? { title: m[1]!, year: Number(m[2]) } : { title: raw, year: null };
  }
  if (provider === "netflix") {
    return { title: raw.replace(/^Watch\s+/, "").replace(/\s*[|｜]\s*Netflix.*$/, ""), year: null };
  }
  return { title: raw, year: null };
}
