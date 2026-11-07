import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Variables } from "../auth/session";
import { updateListener } from "../db/listeners";
import type { Env } from "../env";
import { safeNext } from "../security/next";

const form = z.object({ lang: z.enum(["ja", "en"]), next: z.string().optional() });

/** The header's language switch. Anonymous listeners may use it; it writes `lang` and nothing else. */
export const langRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

langRoutes.post("/lang", zValidator("form", form), async (c) => {
  const { lang, next } = c.req.valid("form");
  await updateListener(c.env.DB, c.get("listener").id, { lang });
  return c.redirect(safeNext(next, c.env.PUBLIC_ORIGIN), 303);
});
