import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { type Variables, requireSessionSecret, sessionMiddleware } from "./auth/session";
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
import { start } from "./routes/start";
import { tts } from "./routes/tts";
import { requirePublicOrigin, sameOriginOnly } from "./security/origin";
import { ipRateLimit, listenerRateLimit } from "./security/rate-limit";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// No CSP: the player reads inline JSON script blocks and the client bundle. The other default headers stay on.
app.use("*", secureHeaders({ referrerPolicy: "strict-origin-when-cross-origin" }));
// Cheap refusals come before the session middleware so they never mint a listener row.
app.use("*", requirePublicOrigin);
app.use("*", sameOriginOnly);
app.use("*", ipRateLimit);
app.use("*", requireSessionSecret);
app.use("*", sessionMiddleware);
app.use("*", listenerRateLimit);

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", admin);
app.route("/", api);
app.route("/", auth);
app.route("/", settings);
app.route("/", put);
app.route("/", start);
app.route("/", letters);
app.route("/", items);
app.route("/", episodes);
app.route("/", tts);
app.route("/", home);
app.route("/", mcp);

// A copy, because the headers of an assets response are immutable and secureHeaders() sets its own.
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(res.body, res);
});

export default app;
