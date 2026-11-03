import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";

export function claude(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
}

export const model = (env: Env): string => env.CLAUDE_MODEL ?? "claude-sonnet-5-5";

export const hasClaude = (env: Env): boolean => Boolean(env.ANTHROPIC_API_KEY);

const isDevOrigin = (env: Env) => env.PUBLIC_ORIGIN.startsWith("http://127.0.0.1") || env.PUBLIC_ORIGIN.startsWith("http://localhost");

/** With no key, local dev may skip the call (returns true); anywhere else it is an error. */
export function skipWithoutKey(env: Env, what: string): boolean {
  if (hasClaude(env)) return false;
  if (!isDevOrigin(env)) throw new Error("claude unavailable");
  console.warn(`[dococa] ANTHROPIC_API_KEY is empty; skipping ${what}`);
  return true;
}
