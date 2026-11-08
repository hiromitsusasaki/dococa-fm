import { Hono } from "hono";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import type { Env } from "../env";
import { tFor } from "../i18n/t";

/** The sections of the privacy page, each a heading and one paragraph (`privacy.<key>.title` / `.body`). */
const SECTIONS = ["collect", "use", "public", "cookies", "ai", "services", "keep", "contact"] as const;

export const privacy = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The privacy policy: plain words about what is stored, what is shown to others and who else touches the data. */
privacy.get("/privacy", (c) => {
  const listener = c.get("listener");
  const t = tFor(listener.lang);
  return c.html(
    <Layout title={t("privacy.title")} lang={listener.lang} listener={listener} path="/privacy">
      <main class="about privacy">
        <h1>{t("privacy.title")}</h1>
        <p class="about-lead">{t("privacy.lead")}</p>
        {SECTIONS.map((key) => (
          <section class="panel panel-rule-under">
            <h2>{t(`privacy.${key}.title`)}</h2>
            <div class="rule" aria-hidden="true" />
            <p>{t(`privacy.${key}.body`)}</p>
          </section>
        ))}
        <p class="muted">{t("privacy.updated")}</p>
      </main>
    </Layout>,
  );
});
