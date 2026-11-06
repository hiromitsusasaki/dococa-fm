import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { type Variables, requireSessionSecret, sessionMiddleware } from "./auth/session";
import type { Env } from "./env";
import { prepareBatch } from "./program/prepare";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";
import { authGoogle } from "./routes/auth-google";
import { api } from "./routes/api";
import { episodes } from "./routes/episodes";
import { home } from "./routes/home";
import { items } from "./routes/items";
import { letters } from "./routes/letters";
import { listens } from "./routes/listens";
import { me } from "./routes/me";
import { put } from "./routes/put";
import { settings } from "./routes/settings";
import { start } from "./routes/start";
import { stations } from "./routes/stations";
import { tts } from "./routes/tts";
import { limitBodies } from "./security/body-limit";
import { canonicalHost, requirePublicOrigin, sameOriginOnly } from "./security/origin";
import { ipRateLimit, listenerRateLimit, listensIpRateLimit } from "./security/rate-limit";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// No CSP: the player reads inline JSON script blocks and the client bundle. The other default headers stay on.
app.use("*", secureHeaders({ referrerPolicy: "strict-origin-when-cross-origin" }));
// Cheap refusals come before the session middleware so they never mint a listener row.
app.use("*", requirePublicOrigin);
app.use("*", canonicalHost);
app.use("*", limitBodies);
app.use("*", sameOriginOnly);
app.use("*", ipRateLimit);
// `/listens` has its own buckets; its IP one also runs before the session, so a cookie-less flood mints no rows.
app.use("/listens", listensIpRateLimit);
app.use("*", requireSessionSecret);
app.use("*", sessionMiddleware);
app.use("*", listenerRateLimit);

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", admin);
app.route("/", api);
app.route("/", auth);
app.route("/", authGoogle);
app.route("/", settings);
app.route("/", put);
app.route("/", start);
app.route("/", letters);
app.route("/", me);
app.route("/", items);
app.route("/", episodes);
app.route("/", stations);
app.route("/", listens);
app.route("/", tts);
app.route("/", home);

// A copy, because the headers of an assets response are immutable and secureHeaders() sets its own.
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(res.body, res);
});

/** Every 15 minutes: units for letters that have none and audio that is still missing. */
/** Awaited, not handed to `waitUntil`: the batch never throws, and the cron invocation lasts as long as it runs. */
async function scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await prepareBatch(env, env.DB);
}

// The app itself stays the default export (tests call `app.request` and read `app.routes`); the runtime finds
// `fetch` and `scheduled` on it.
export default Object.assign(app, { scheduled } satisfies Pick<Required<ExportedHandler<Env>>, "scheduled">);
