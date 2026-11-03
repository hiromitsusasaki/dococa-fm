import { vi } from "vitest";
import { json, stubFetch } from "./fetch";

/**
 * Stands in for the Anthropic Messages API at the fetch layer. `create` receives each request body
 * and returns the response fields (`content`), so tests assert on the real request shape.
 * vi.mock on the client module does not reach the worker's module graph, hence fetch.
 */
export function stubAnthropic() {
  const create = vi.fn<(req: any) => unknown>();
  stubFetch([
    [
      "https://api.anthropic.com/v1/messages",
      async (_url, init) => {
        const req = JSON.parse(String(init?.body));
        const out = await create(req);
        return json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: req.model,
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
          ...(out as object),
        });
      },
    ],
  ]);
  return create;
}

export const toolUse = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: "tu_1", name, input }] });
