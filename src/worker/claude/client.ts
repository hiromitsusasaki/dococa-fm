import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";

export function claude(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
}

export const model = (env: Env): string => env.CLAUDE_MODEL || "claude-sonnet-5-5";

export const hasClaude = (env: Env): boolean => Boolean(env.ANTHROPIC_API_KEY);

/**
 * One line of text: every run of control characters (U+0000–U+001F, U+007F, so \r \n \t too) and the Unicode
 * line/paragraph separators becomes one space. Used where a value must not open a new line in a prompt block or a heading.
 */
export const oneLine = (s: string): string => s.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/gu, " ");

/** Letters sit inside <letter> tags in prompts, so a body must not be able to close or open one. */
export const escapeTags = (s: string): string => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * With no key, the call may be skipped (returns true) only when `DEV_SKIP_CLAUDE` is exactly "1", which only
 * `.dev.vars` sets; anywhere else it is an error. The origin never decides this.
 */
export function skipWithoutKey(env: Env, what: string): boolean {
  if (hasClaude(env)) return false;
  if (env.DEV_SKIP_CLAUDE !== "1") throw new Error("claude unavailable");
  console.warn(`[dococa] ANTHROPIC_API_KEY is empty; skipping ${what}`);
  return true;
}
