import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { insertLetter, listLettersForItem, listReactionsForLetter, setLetterStatus } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import { upsertHistory } from "../../../src/worker/db/history";
import { t } from "../../../src/worker/i18n/t";
import { resetDb } from "../../helpers/db";
import { stubAnthropic } from "../../helpers/anthropic";
import { itemDraft, letterDraft } from "../db/helpers";

let create: ReturnType<typeof stubAnthropic>;
const verdict = (input: unknown) => ({ content: [{ type: "tool_use", id: "j", name: "judge_letter", input }] });

beforeEach(async () => {
  await resetDb(env.DB);
  (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The transport answers with JSON or a single SSE event; both carry one JSON-RPC message. */
async function rpc(token: string, method: string, params: unknown = {}, id = 1) {
  const res = await SELF.fetch(`http://example.com/mcp/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const data = res.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).at(-1)!
    : text;
  return { status: res.status, body: JSON.parse(data) };
}
const call = (token: string, name: string, args: unknown) => rpc(token, "tools/call", { name, arguments: args });
const textOf = (r: { body: any }): string => r.body.result.content[0].text;

const INIT = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } };

async function seed() {
  const me = await createListener(env.DB);
  const other = await createListener(env.DB);
  const near = await insertItem(env.DB, itemDraft({ title: "手元の曲" }));
  const far = await insertItem(env.DB, itemDraft({ title: "遠い国の歌", externalIds: { itunes: "2" } }));
  await upsertHistory(env.DB, [{ listenerId: me.id, itemId: near.id, source: "manual", occurredAt: null }]);
  for (const it of [near, far]) {
    await insertLetter(env.DB, letterDraft(it.id, { listenerId: other.id, radioName: "しずく", place: "松本", body: `${it.title}への手紙`, bodyJa: `${it.title}への手紙` }));
  }
  return { me, other, near, far };
}

describe("/mcp/:token", () => {
  it("answers 401 for an unknown token", async () => {
    const res = await SELF.fetch("http://example.com/mcp/nope", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("initializes and lists exactly the four tools", async () => {
    const { me } = await seed();
    const init = await rpc(me.mcpToken, "initialize", INIT);
    expect(init.body.result.serverInfo.name).toBe("dococa-fm");
    const list = await rpc(me.mcpToken, "tools/list");
    expect(list.body.result.tools.map((x: { name: string }) => x.name).sort()).toEqual(["get_episode", "get_item", "post_letter", "react"]);
  });

  it("get_episode returns the instruction first and a letter's original text verbatim, without counts", async () => {
    const { me } = await seed();
    const r = await call(me.mcpToken, "get_episode", { new: true });
    const text = textOf(r);
    expect(r.body.result.isError).toBeFalsy();
    expect(text.startsWith(t("mcp.instruction"))).toBe(true);
    expect(text).toMatch(/> (手元の曲|遠い国の歌)への手紙/);
    expect(text).not.toMatch(/\d+\s*(件|人|位)/);
    // without new, the latest one comes back (no second episode is made)
    const again = await call(me.mcpToken, "get_episode", {});
    expect(textOf(again)).toBe(text);
  });

  it("get_episode with new falls back to the latest episode when the daily limit is hit", async () => {
    const { me } = await seed();
    const limited = env as { EPISODE_DAILY_LIMIT?: string };
    limited.EPISODE_DAILY_LIMIT = "1";
    try {
      const first = textOf(await call(me.mcpToken, "get_episode", { new: true }));
      const second = await call(me.mcpToken, "get_episode", { new: true });
      expect(second.body.result.isError).toBeFalsy();
      expect(textOf(second)).toBe(first);
    } finally {
      limited.EPISODE_DAILY_LIMIT = undefined;
    }
  });

  it("get_episode never hands over an unverified episode, even the latest", async () => {
    const { me, far } = await seed();
    const first = textOf(await call(me.mcpToken, "get_episode", { new: true }));
    await insertEpisode(env.DB, {
      listenerId: me.id,
      verified: false,
      report: { verbatim: true, sources: true, topical: false, pii: true, details: [] },
      segments: [{ itemId: far.id, slot: "far", lines: [{ type: "dj", text: "未検証の回です" }] }],
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const again = textOf(await call(me.mcpToken, "get_episode", {}));
    expect(again).not.toContain("未検証の回です");
    expect(again).toBe(first);
  });

  it("get_episode leaves out a letter rejected after the episode was made", async () => {
    const { me, far } = await seed();
    const before = textOf(await call(me.mcpToken, "get_episode", { new: true }));
    expect(before).toContain("遠い国の歌への手紙");
    const [l] = await listLettersForItem(env.DB, far.id);
    await setLetterStatus(env.DB, l!.id, "rejected");
    const after = textOf(await call(me.mcpToken, "get_episode", {}));
    expect(after).not.toContain("遠い国の歌への手紙");
    expect(after.startsWith(t("mcp.instruction"))).toBe(true);
  });

  it("get_item shows the card and the letters with ids", async () => {
    const { me, far } = await seed();
    const [l] = await listLettersForItem(env.DB, far.id);
    const text = textOf(await call(me.mcpToken, "get_item", { itemId: far.id }));
    expect(text).toContain("遠い国の歌");
    expect(text).toContain("> 遠い国の歌への手紙");
    expect(text).toContain(`letterId: ${l!.id}`);
    const missing = await call(me.mcpToken, "get_item", { itemId: "nope" });
    expect(missing.body.result.isError).toBe(true);
    expect(textOf(missing)).toBe(t("mcp.itemNotFound"));
  });

  it("post_letter creates a letter for an item, and a duplicate is an error", async () => {
    create = stubAnthropic();
    create.mockResolvedValue(verdict({ ok: true }));
    (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "sk-test";
    const { me, far } = await seed();
    const r = await call(me.mcpToken, "post_letter", { itemId: far.id, body: "中学の頃、毎日聴いていた" });
    expect(r.body.result.isError).toBeFalsy();
    expect(textOf(r)).toContain("> 中学の頃、毎日聴いていた");
    const stored = (await listLettersForItem(env.DB, far.id)).filter((l) => l.listenerId === me.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "letter", body: "中学の頃、毎日聴いていた", bodyJa: "中学の頃、毎日聴いていた" });
    const dup = await call(me.mcpToken, "post_letter", { itemId: far.id, body: "中学の頃、毎日聴いていた" });
    expect(dup.body.result.isError).toBe(true);
    expect(textOf(dup)).toBe(t("letters.duplicate"));
  });

  it("react places a watashimo once and a reply", async () => {
    create = stubAnthropic();
    create.mockResolvedValue(verdict({ ok: true }));
    (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "sk-test";
    const { me, far } = await seed();
    const [parent] = await listLettersForItem(env.DB, far.id);
    const ok = await call(me.mcpToken, "react", { letterId: parent!.id, kind: "watashimo" });
    expect(ok.body.result.isError).toBeFalsy();
    expect((await listReactionsForLetter(env.DB, parent!.id)).map((r) => r.kind)).toEqual(["watashimo"]);
    const dup = await call(me.mcpToken, "react", { letterId: parent!.id, kind: "watashimo" });
    expect(dup.body.result.isError).toBe(true);
    expect(textOf(dup)).toBe(t("letters.watashimoDuplicate"));
    const reply = await call(me.mcpToken, "react", { letterId: parent!.id, kind: "reply", body: "わかります" });
    expect(reply.body.result.isError).toBeFalsy();
    const bad = await call(me.mcpToken, "react", { letterId: "nope", kind: "watashimo" });
    expect(bad.body.result.isError).toBe(true);
    expect(textOf(bad)).toBe(t("letters.badParent"));
  });
});
