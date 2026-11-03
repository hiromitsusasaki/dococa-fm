import { vi } from "vitest";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export const meta = (props: Record<string, string>) =>
  html(`<html><head>${Object.entries(props).map(([k, v]) => `<meta property="${k}" content="${v}">`).join("")}</head></html>`);

/**
 * Stubs global fetch. Routes match by URL prefix, first match wins; anything unmatched is a 404
 * so tests can assert on `calls` to see exactly which URLs were requested.
 */
export function stubFetch(routes: Array<[string, Handler]>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hit = routes.find(([prefix]) => url.startsWith(prefix));
    return hit ? hit[1](url, init) : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls: () => fn.mock.calls.map(([u]) => String(u)) };
}
