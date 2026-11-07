import { Hono } from "hono";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import type { Env } from "../env";
import { tFor } from "../i18n/t";

const SECTIONS = ["listen", "send", "mine", "rules"] as const;

export const about = new Hono<{ Bindings: Env; Variables: Variables }>();

about.get("/about", (c) => {
  const listener = c.get("listener");
  const t = tFor(listener.lang);
  return c.html(
    <Layout title={t("about.title")} lang={listener.lang} listener={listener} path="/about">
      <main class="about">
        <h1>{t("about.title")}</h1>
        <p class="about-lead">{t("about.lead")}</p>
        {/* The home opens its tour again on `?tour=1`. */}
        <p>
          <a class="pill tour-again" href="/?tour=1">
            {t("about.tour")}
          </a>
        </p>
        {SECTIONS.map((key) => (
          <section class="panel panel-rule-under">
            <h2>{t(`about.${key}.title`)}</h2>
            <div class="rule" aria-hidden="true" />
            <figure class="about-art">
              <img
                src={`/about/${key}.jpg`}
                alt={t(`about.${key}.alt`)}
                width="1280"
                height="720"
                loading={key === "listen" ? "eager" : "lazy"}
                decoding="async"
              />
            </figure>
            <p>{t(`about.${key}.body`)}</p>
          </section>
        ))}
      </main>
    </Layout>,
  );
});
