import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { getListenerByMcpToken, isWellFormedMcpToken } from "../db/listeners";
import type { Env } from "../env";
import { defer } from "../defer";
import { createMcpServer } from "../mcp/server";
import { mcpIpBlocked, mcpTokenOver, mcpUnauthorizedOver } from "../security/rate-limit";

export const mcp = new Hono<{ Bindings: Env }>();

/** The token in the path is the only credential: connectors register this URL without any other auth. */
mcp.all("/mcp/:token", async (c) => {
  const token = c.req.param("token");
  const ip = c.req.header("cf-connecting-ip");
  const limited = () => c.json({ error: "rate_limited" }, 429);
  // A token that cannot exist is refused without a D1 read once its IP is over the limit. A well-formed token is always
  // looked up first: hosted connectors share egress IPs, and a guesser there must not lock out valid tokens.
  const wellFormed = isWellFormedMcpToken(token);
  if (!wellFormed && mcpIpBlocked(c.env, ip)) return limited();
  const listener = wellFormed ? await getListenerByMcpToken(c.env.DB, token) : null;
  if (!listener) return mcpUnauthorizedOver(c.env, ip) ? limited() : c.json({ error: "unauthorized" }, 401);
  if (mcpTokenOver(c.env, token)) return limited();
  // Stateless: a server and a transport per request, no session id.
  const server = createMcpServer(c.env, c.env.DB, listener, (work) => defer(c, work));
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.body(null, 204);
});
