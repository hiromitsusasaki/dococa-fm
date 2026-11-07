import { expect, vi } from "vitest";
import { json, stubFetch } from "./fetch";

/**
 * Stands in for the Anthropic Messages API at the fetch layer. `create` receives each request body
 * and returns the response fields (`content`), so tests assert on the real request shape.
 * vi.mock on the client module does not reach the worker's module graph, hence fetch.
 */
export function stubAnthropic(opts: { names?: (req: any) => unknown } = {}) {
  const create = vi.fn<(req: any) => unknown>();
  stubFetch([
    [
      "https://api.anthropic.com/v1/messages",
      async (_url, init) => {
        const req = JSON.parse(String(init?.body));
        // With `names`, the work-reading call (`name_readings`) goes there, so `create` sees only the other calls.
        const out = opts.names && req.tools?.[0]?.name === "name_readings" ? await opts.names(req) : await create(req);
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

/**
 * Current models reject a forced tool_choice and sampling parameters, so a request offers one strict
 * tool with `tool_choice: auto` and asks for the call in the system prompt.
 */
export function expectInstructedTool(req: any, name: string) {
  expect(req.tool_choice).toEqual({ type: "auto" });
  expect(req.tools).toHaveLength(1);
  expect(req.tools[0]).toMatchObject({ name, strict: true });
  expect(req.tools[0].input_schema.additionalProperties).toBe(false);
  expect(req.system).toContain(`必ず ${name} ツールを 1 回だけ呼んで答える`);
  expect(req).not.toHaveProperty("temperature");
}

/**
 * A default answer for the letter pipeline: moderation passes, and a translation into either language comes
 * back as a marked stand-in (`[en] translated`), so tests that do not care about it still get a stored translation.
 */
export function okReply(req: any) {
  const tool = req.tools?.[0];
  if (tool?.name === "translate") {
    const target = Object.keys(tool.input_schema.properties)[0]!;
    return toolUse("translate", { [target]: `[${target}] translated` });
  }
  return toolUse("judge_letter", { ok: true });
}

/** The work-reading call's answer: no reading unless one is given. */
export const noNames = () => toolUse("name_readings", { title: "", creator: "" });
