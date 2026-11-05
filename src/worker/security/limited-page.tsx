import type { Context } from "hono";
import { Layout } from "../../views/layout";
import { tFor } from "../i18n/t";

/** Form routes get a small page; API-style callers (the player's fetch, /api/*) get JSON. */
export function tooManyRequests(c: Context): Response | Promise<Response> {
  const path = c.req.path;
  // The limiter can answer before a session exists; then the page is Japanese.
  const lang = (c.get("listener") as { lang: "ja" | "en" } | undefined)?.lang ?? "ja";
  const t = tFor(lang);
  const wantsJson = path.startsWith("/api/") || /^\/episodes\/[^/]+\/next$/.test(path);
  if (wantsJson) return c.json({ error: "rate_limited" }, 429);
  return c.html(
    <Layout title={t("rate.limited")} lang={lang}>
      <main class="episode-page">
        <p role="alert">{t("rate.limited")}</p>
        <p>
          <a href="/">{t("episode.home")}</a>
        </p>
      </main>
    </Layout>,
    429,
  );
}
