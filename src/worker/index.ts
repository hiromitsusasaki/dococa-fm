import { Hono } from "hono";
import { type Variables, sessionMiddleware } from "./auth/session";
import type { Env } from "./env";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";
import { api } from "./routes/api";
import { episodes } from "./routes/episodes";
import { home } from "./routes/home";
import { items } from "./routes/items";
import { letters } from "./routes/letters";
import { mcp } from "./routes/mcp";
import { put } from "./routes/put";
import { settings } from "./routes/settings";
import { tts } from "./routes/tts";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", sessionMiddleware);

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", admin);
app.route("/", api);
app.route("/", auth);
app.route("/", settings);
app.route("/", put);
app.route("/", letters);
app.route("/", items);
app.route("/", episodes);
app.route("/", tts);
app.route("/", home);
app.route("/", mcp);

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
