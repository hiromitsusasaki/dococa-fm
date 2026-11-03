import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
