import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { newMcpToken, updateListener } from "../db/listeners";
import type { Env } from "../env";
import { t } from "../i18n/t";
import type { Listener } from "../types";

const schema = z.object({
  radioName: z.string().trim().max(20),
  place: z.string().trim().max(30),
  voice: z.string().max(200),
  dial: z.coerce.number().min(0).max(1),
});

type FormValues = Pick<Listener, "radioName" | "place" | "voice" | "dial">;

function SettingsPage(props: { values: FormValues; mcpUrl: string; saved?: boolean; invalid?: boolean }) {
  const { values, mcpUrl, saved, invalid } = props;
  return (
    <Layout title={t("settings.title")}>
      <main class="settings">
        <h1>{t("settings.title")}</h1>
        <p class="settings-name">{values.radioName || t("listener.anonymous")}</p>
        {saved && <p class="settings-note" role="status">{t("settings.saved")}</p>}
        {invalid && <p class="settings-error" role="alert">{t("settings.invalid")}</p>}

        <form method="post" action="/settings" class="settings-form">
          <label>
            <span>{t("settings.radioName")}</span>
            <input type="text" name="radioName" maxlength={20} value={values.radioName} />
          </label>
          <label>
            <span>{t("settings.place")}</span>
            <input type="text" name="place" maxlength={30} value={values.place} />
          </label>
          <label>
            <span>{t("settings.voice")}</span>
            <input type="text" name="voice" maxlength={200} value={values.voice} />
          </label>
          <label>
            <span>{t("settings.dial")}</span>
            <input type="range" name="dial" min="0" max="1" step="0.1" value={String(values.dial)} />
            <output>{String(values.dial)}</output>
            <small>{t("settings.dialHelp")}</small>
          </label>
          <button type="submit">{t("settings.save")}</button>
        </form>

        <section class="settings-mcp">
          <h2>{t("settings.mcp")}</h2>
          <p>{t("settings.mcpHelp")}</p>
          <input type="text" readonly value={mcpUrl} aria-label={t("settings.mcp")} />
          <form method="post" action="/settings/mcp-token">
            <button type="submit">{t("settings.mcpRegenerate")}</button>
          </form>
        </section>
      </main>
    </Layout>
  );
}

type SettingsContext = Context<{ Bindings: Env; Variables: Variables }>;

const mcpUrlOf = (env: Env, listener: Listener) => `${env.PUBLIC_ORIGIN}/mcp/${listener.mcpToken}`;

export const settings = new Hono<{ Bindings: Env; Variables: Variables }>();

settings.get("/settings", (c) => {
  const listener = c.get("listener");
  return c.html(<SettingsPage values={listener} mcpUrl={mcpUrlOf(c.env, listener)} saved={c.req.query("saved") === "1"} />);
});

settings.post(
  "/settings",
  zValidator("form", schema, (result, ctx) => {
    if (result.success) return;
    const c = ctx as SettingsContext;
    const listener = c.get("listener");
    return c.html(<SettingsPage values={listener} mcpUrl={mcpUrlOf(c.env, listener)} invalid />, 422);
  }),
  async (c) => {
    await updateListener(c.env.DB, c.get("listener").id, c.req.valid("form"));
    return c.redirect("/settings?saved=1", 303);
  },
);

settings.post("/settings/mcp-token", async (c) => {
  await updateListener(c.env.DB, c.get("listener").id, { mcpToken: newMcpToken() });
  return c.redirect("/settings", 303);
});
