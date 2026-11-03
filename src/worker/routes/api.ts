import { Hono } from "hono";
import type { Env } from "../env";
import { resolveUrl, searchByText } from "../resolve";
import type { ItemKind } from "../types";

const KINDS: ReadonlySet<string> = new Set<ItemKind | "any">(["music", "book", "film", "any"]);

/** Temporary routes for trying out resolution by hand; Task 5's /put page may reuse them. */
export const api = new Hono<{ Bindings: Env }>();

api.get("/api/resolve", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url is required" }, 400);
  const item = await resolveUrl(url, c.env);
  return item ? c.json({ item }) : c.json({ item: null }, 404);
});

api.get("/api/search", async (c) => {
  const q = c.req.query("q");
  const kind = c.req.query("kind") ?? "any";
  if (!q || !KINDS.has(kind)) return c.json({ error: "q is required and kind must be music, book, film or any" }, 400);
  return c.json({ items: await searchByText(q, kind as ItemKind | "any", c.env) });
});
