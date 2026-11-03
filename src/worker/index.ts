import { Hono } from "hono";
import { type Variables, sessionMiddleware } from "./auth/session";
import type { Env } from "./env";
import { auth } from "./routes/auth";
import { api } from "./routes/api";
import { episodes } from "./routes/episodes";
import { home } from "./routes/home";
import { items } from "./routes/items";
import { letters } from "./routes/letters";
import { put } from "./routes/put";
import { settings } from "./routes/settings";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", sessionMiddleware);

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", api);
app.route("/", auth);
app.route("/", settings);
app.route("/", put);
app.route("/", letters);
app.route("/", items);
app.route("/", episodes);
app.route("/", home);

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
