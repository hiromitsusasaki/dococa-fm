import { Hono } from "hono";
import { type Variables, sessionMiddleware } from "./auth/session";
import type { Env } from "./env";
import { api } from "./routes/api";
import { settings } from "./routes/settings";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", sessionMiddleware);

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", api);
app.route("/", settings);

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
