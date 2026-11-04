import type { Context } from "hono";
import { Layout } from "../../views/layout";
import { t } from "../i18n/t";

/** Form routes get a small page; API-style callers (the player's fetch, /api/*) get JSON. */
export function tooManyRequests(c: Context): Response | Promise<Response> {
  const path = c.req.path;
  const wantsJson = path.startsWith("/api/") || /^\/episodes\/[^/]+\/next$/.test(path);
  if (wantsJson) return c.json({ error: "rate_limited" }, 429);
  return c.html(
    <Layout title={t("rate.limited")}>
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
