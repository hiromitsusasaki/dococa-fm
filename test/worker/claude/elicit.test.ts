import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elicitQuestions } from "../../../src/worker/claude/elicit";
import type { Env } from "../../../src/worker/env";
import type { Item, Listener } from "../../../src/worker/types";
import { expectInstructedTool, stubAnthropic, toolUse } from "../../helpers/anthropic";

const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test" } as Env;
const keyless = { ...env, ANTHROPIC_API_KEY: "" } as Env;
const item: Item = {
  id: "i1", kind: "music", title: "Blue in Green", creator: "Miles Davis", year: 1959,
  imageUrl: null, previewUrl: null, outLinks: {}, externalIds: {}, createdAt: "2026-01-01T00:00:00Z",
};
const listener = { id: "l1", radioName: "ヒロ", place: "大船渡" } as Listener;
const asked = (questions: unknown) => toolUse("ask", { questions });

let create: ReturnType<typeof stubAnthropic>;
beforeEach(() => {
  create = stubAnthropic();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("elicitQuestions", () => {
  it("returns the questions from the ask tool", async () => {
    create.mockResolvedValue(asked(["この曲を初めて聴いたのはどこでしたか？", "誰かと一緒でしたか？"]));
    expect(await elicitQuestions(keyed, item, listener)).toEqual(["この曲を初めて聴いたのはどこでしたか？", "誰かと一緒でしたか？"]);
    const req = create.mock.calls[0]![0];
    expectInstructedTool(req, "ask");
    expect(req.max_tokens).toBe(300);
    const sent = JSON.stringify(req.messages);
    expect(sent).toContain("Blue in Green");
    expect(sent).toContain("Miles Davis");
    expect(sent).not.toContain("ヒロ"); // nothing about the listener goes to the model
  });

  it("drops a question with a topical word", async () => {
    create.mockResolvedValue(asked(["今年いちばん聴きましたか？", "誰かと一緒でしたか？"]));
    expect(await elicitQuestions(keyed, item, listener)).toEqual(["誰かと一緒でしたか？"]);
  });

  it("returns [] when every question is topical", async () => {
    create.mockResolvedValue(asked(["今年いちばん聴きましたか？"]));
    expect(await elicitQuestions(keyed, item, listener)).toEqual([]);
  });

  it("keeps at most two questions of at most 60 characters", async () => {
    create.mockResolvedValue(asked(["あ".repeat(61), "一つ目？", "二つ目？", "三つ目？"]));
    expect(await elicitQuestions(keyed, item, listener)).toEqual(["一つ目？", "二つ目？"]);
  });

  it("returns [] with no key and does not call Claude", async () => {
    expect(await elicitQuestions(keyless, item, listener)).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns [] when the reply has no tool_use or the wrong shape", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "hm" }] });
    expect(await elicitQuestions(keyed, item, listener)).toEqual([]);
    create.mockResolvedValueOnce(asked("not an array"));
    expect(await elicitQuestions(keyed, item, listener)).toEqual([]);
  });

  it("returns [] when the call fails", async () => {
    create.mockRejectedValue(new Error("boom"));
    expect(await elicitQuestions(keyed, item, listener)).toEqual([]);
  });
});
