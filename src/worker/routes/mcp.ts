import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { getListenerByMcpToken } from "../db/listeners";
import type { Env } from "../env";
import { createMcpServer } from "../mcp/server";

export const mcp = new Hono<{ Bindings: Env }>();

/** The token in the path is the only credential: connectors register this URL without any other auth. */
mcp.all("/mcp/:token", async (c) => {
  const listener = await getListenerByMcpToken(c.env.DB, c.req.param("token"));
  if (!listener) return c.json({ error: "unauthorized" }, 401);
  // Stateless: a server and a transport per request, no session id.
  const server = createMcpServer(c.env, c.env.DB, listener);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.body(null, 204);
});
