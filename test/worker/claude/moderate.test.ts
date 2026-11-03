import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import type { Env } from "../../../src/worker/env";

import { moderateLetter } from "../../../src/worker/claude/moderate";

const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test" } as Env;
const judged = (input: unknown) => toolUse("judge_letter", input);

let create: ReturnType<typeof stubAnthropic>;
beforeEach(() => {
  create = stubAnthropic();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("moderateLetter", () => {
  it("returns the rejection reason from the forced judge_letter tool", async () => {
    create.mockResolvedValue(judged({ ok: false, reason: "ad" }));
    expect(await moderateLetter(keyed, "買って買って")).toEqual({ ok: false, reason: "ad" });
    const req = create.mock.calls[0]![0];
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.tool_choice).toEqual({ type: "tool", name: "judge_letter" });
    expect(req.tools[0].name).toBe("judge_letter");
    expect(req.max_tokens).toBe(200);
    expect(JSON.stringify(req.messages)).toContain("買って買って");
  });

  it("returns ok for an ok verdict", async () => {
    create.mockResolvedValue(judged({ ok: true }));
    expect(await moderateLetter(keyed, "この曲で泣いた")).toEqual({ ok: true });
  });

  it("does not block a human when the judge returns no tool_use", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    create.mockResolvedValue({ content: [{ type: "text", text: "hmm" }] });
    expect(await moderateLetter(keyed, "x")).toEqual({ ok: true });
  });

  it("skips Claude in dev when the key is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dev = { ...env, ANTHROPIC_API_KEY: "", PUBLIC_ORIGIN: "http://127.0.0.1:5173" } as Env;
    expect(await moderateLetter(dev, "x")).toEqual({ ok: true });
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("throws in production when the key is empty", async () => {
    const prod = { ...env, ANTHROPIC_API_KEY: "", PUBLIC_ORIGIN: "https://dococa.fm" } as Env;
    await expect(moderateLetter(prod, "x")).rejects.toThrow("claude unavailable");
  });
});
