import { Hono } from "hono";
import type { Env } from "./env";
import { api } from "./routes/api";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/", api);

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
