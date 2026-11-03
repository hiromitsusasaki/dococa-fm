import type { Env } from "../env";
import { claude, model } from "./client";

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
};

/** Current models reject a forced tool_choice, so the system prompt asks for the call instead. */
export const callInstruction = (name: string): string => `必ず ${name} ツールを 1 回だけ呼んで答える。ほかの文章は書かない。`;

/**
 * One request with a single strict tool and `tool_choice: auto`. Returns the tool's input, or null unless
 * the reply holds exactly one call to that tool; callers validate the input and decide what null means.
 */
export async function callTool(
  env: Env,
  req: { system: string; user: string; tool: ToolSpec; maxTokens: number },
): Promise<unknown | null> {
  const res = await claude(env).messages.create({
    model: model(env),
    max_tokens: req.maxTokens,
    system: `${req.system}\n${callInstruction(req.tool.name)}`,
    tools: [{ ...req.tool, strict: true }],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: req.user }],
  });
  const calls = res.content.filter((b) => b.type === "tool_use" && b.name === req.tool.name);
  const [only] = calls;
  return calls.length === 1 && only?.type === "tool_use" ? only.input : null;
}
