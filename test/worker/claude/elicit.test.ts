import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askBack, elicitQuestions } from "../../../src/worker/claude/elicit";
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

  it("keeps a question that names the work's own year, drops one with another year", async () => {
    create.mockResolvedValue(asked(["1959年に聴いたのはどこでしたか？", "1999年にも聴きましたか？"]));
    expect(await elicitQuestions(keyed, item, listener)).toEqual(["1959年に聴いたのはどこでしたか？"]);
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

describe("askBack", () => {
  const said = (question: unknown) => toolUse("ask_back", { question });
  const draft = "雨の日に聴くと落ち着きます";

  it("returns the one question, and sends the work and the draft inside tags", async () => {
    create.mockResolvedValue(said("どんな場面でしたか？"));
    expect(await askBack(keyed, item, draft)).toBe("どんな場面でしたか？");
    const req = create.mock.calls[0]![0];
    expectInstructedTool(req, "ask_back");
    expect(JSON.stringify(req.messages)).toContain(`<draft>${draft}</draft>`);
    expect(req.system).toContain("書きかけの文を引用しない");
  });

  it("drops a question that is empty, over 60 characters, topical or quotes the draft; English may be longer", async () => {
    for (const q of ["", "あ".repeat(61), "今日のニュースは？", `${draft}、とは？`, 5]) {
      create.mockResolvedValueOnce(said(q));
      expect(await askBack(keyed, item, draft)).toBeNull();
    }
    create.mockResolvedValueOnce(said("What were you doing when it first played, and who was nearby?"));
    expect(await askBack(keyed, item, draft, "en")).not.toBeNull();
  });

  it("returns null without a key or when the call fails, and never logs the draft", async () => {
    expect(await askBack(keyless, item, draft)).toBeNull();
    create.mockRejectedValue(new Error(draft));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await askBack(keyed, item, draft)).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("雨の日");
  });

  it("shares the page questions' daily cap: past it, null without calling Claude", async () => {
    await env.DB.prepare("DELETE FROM tts_claims WHERE key LIKE 'elicit:%'").run();
    const capped = { ...keyed, ELICIT_DAILY_LIMIT: "1" } as Env;
    create.mockResolvedValue(asked(["どこで聴きましたか？"]));
    expect(await elicitQuestions(capped, item, listener)).toHaveLength(1);
    create.mockClear();
    expect(await askBack(capped, item, draft)).toBeNull();
    expect(await askBack({ ...keyed, ELICIT_DAILY_LIMIT: "0" } as Env, item, draft)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
