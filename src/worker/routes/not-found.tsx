import type { Context } from "hono";
import { Layout } from "../../views/layout";
import { currentPath } from "../auth/require-signin";
import { tFor } from "../i18n/t";
import type { Listener } from "../types";

/** No route or no such thing: a browser gets a page with the header and a way home; a fetch (the player, an API) gets the plain 404. */
export function notFoundPage(c: Context): Response | Promise<Response> {
  if (!(c.req.header("accept") ?? "").includes("text/html")) return c.text("404 Not Found", 404);
  // A refusal before the session middleware leaves no listener; then the page is Japanese and the header is the short one.
  const listener = c.get("listener") as Listener | undefined;
  const lang = listener?.lang ?? "ja";
  const t = tFor(lang);
  const body = (
    <main class="episode-page not-found">
      <h1>{t("notFound.title")}</h1>
      <p>{t("notFound.body")}</p>
      <p>
        <a href="/">{t("episode.home")}</a>
      </p>
    </main>
  );
  return c.html(
    listener ? (
      <Layout title={t("notFound.title")} lang={lang} listener={listener} path={currentPath(c)}>{body}</Layout>
    ) : (
      <Layout title={t("notFound.title")} lang={lang}>{body}</Layout>
    ),
    404,
  );
}
