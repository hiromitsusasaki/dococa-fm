import { Hono } from "hono";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import type { Env } from "../env";
import { tFor } from "../i18n/t";

/** The two legal pages: each a lead and a list of sections, one heading and one paragraph each (`<page>.<key>.title` / `.body`). */
const PAGES = {
  privacy: ["collect", "use", "public", "cookies", "ai", "services", "keep", "contact"],
  terms: ["service", "account", "letters", "rights", "dj", "works", "conduct", "changes"],
} as const;
type Key = Parameters<ReturnType<typeof tFor>>[0];

export const privacy = new Hono<{ Bindings: Env; Variables: Variables }>();

for (const page of ["privacy", "terms"] as const) {
  // Every `<page>.<key>.<part>` is in both language tables (test/worker/i18n.test.ts keeps them equal); the cast only narrows the template string.
  const section = (key: string, part: "title" | "body") => `${page}.${key}.${part}` as Key;
  privacy.get(`/${page}`, (c) => {
    const listener = c.get("listener");
    const t = tFor(listener.lang);
    return c.html(
      <Layout title={t(`${page}.title`)} lang={listener.lang} listener={listener} path={`/${page}`}>
        <main class="about privacy">
          <h1>{t(`${page}.title`)}</h1>
          <p class="about-lead">{t(`${page}.lead`)}</p>
          {PAGES[page].map((key) => (
            <section class="panel panel-rule-under">
              <h2>{t(section(key, "title"))}</h2>
              <div class="rule" aria-hidden="true" />
              <p>{t(section(key, "body"))}</p>
            </section>
          ))}
          <p class="muted">{t(`${page}.updated`)}</p>
        </main>
      </Layout>,
    );
  });
}
