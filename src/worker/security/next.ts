/**
 * A same-site absolute path only; anything else would make a redirect to it an open redirect. Printable ASCII only,
 * because browsers strip tabs and newlines from a Location value (`/%09/evil.com` would become `//evil.com`).
 * Anything else gives `fallback`.
 */
export function safeNext(raw: string | undefined, publicOrigin: string, fallback = "/"): string {
  if (!raw || raw.length > 200 || !/^\/(?!\/)[\x21-\x7e]*$/.test(raw) || raw.includes("\\") || /%(?:[01][0-9a-f]|7f)/i.test(raw)) return fallback;
  try {
    const u = new URL(raw, publicOrigin);
    if (u.origin !== new URL(publicOrigin).origin) return fallback;
    const next = u.pathname + u.search;
    return next.startsWith("//") ? fallback : next;
  } catch {
    return fallback;
  }
}
