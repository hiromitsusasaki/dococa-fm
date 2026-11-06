import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, setLetterStatus } from "../../../src/worker/db/letters";
import { listHeardLetters } from "../../../src/worker/db/listens";
import { createListener } from "../../../src/worker/db/listeners";
import type { Letter, ScriptLine, Segment } from "../../../src/worker/types";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";
import { BASE, newSession } from "./helpers";

const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;
const report = { verbatim: true, sources: true, topical: true, pii: true, details: [] };
const line = (l: Letter, kind: "letter" | "found" | "reply" = "letter"): ScriptLine => ({ type: "letter", letterId: l.id, text: l.body, radioName: l.radioName, place: l.place, kind, sourceUrl: null, sourceAuthor: null });
const post = (cookie: string, body: unknown, raw = false) =>
  SELF.fetch(`${BASE}/listens`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: raw ? String(body) : JSON.stringify(body) });

beforeEach(() => resetDb(env.DB));

async function setup() {
  const cookie = await newSession();
  const me = idOf(cookie);
  const a = await insertItem(env.DB, itemDraft({ title: "A" }));
  const b = await insertItem(env.DB, itemDraft({ title: "B", externalIds: { itunes: "2" } }));
  const la = await insertLetter(env.DB, letterDraft(a.id, { body: "a" }));
  const lb = await insertLetter(env.DB, letterDraft(b.id, { body: "b" }));
  const lr = await insertLetter(env.DB, letterDraft(b.id, { kind: "reply", body: "r", bodyJa: "r" }));
  const segments: Segment[] = [
    { itemId: a.id, slot: "near", lines: [{ type: "dj", text: "d" }, line(la)] },
    { itemId: b.id, slot: "far", lines: [{ type: "dj", text: "d" }, line(lb, "found"), line(lr, "reply")] },
  ];
  const ep = await insertEpisode(env.DB, { listenerId: me, segments, verified: true, report });
  return { cookie, me, ep, la, lb, lr };
}

describe("POST /listens", () => {
  it("records a letter the episode reads and answers 204; a repeat updates, not duplicates", async () => {
    const { cookie, me, ep, la, lb } = await setup();
    expect((await post(cookie, { episodeId: ep.id, letterId: la.id, segmentIndex: 0 })).status).toBe(204);
    expect((await post(cookie, { episodeId: ep.id, letterId: lb.id, segmentIndex: 1 })).status).toBe(204);
    expect((await post(cookie, { episodeId: ep.id, letterId: lb.id, segmentIndex: 1 })).status).toBe(204);
    const rows = await listHeardLetters(env.DB, me);
    expect(rows.map((r) => [r.letter.id, r.episodeId, r.segmentIndex]).sort()).toEqual([[la.id, ep.id, 0], [lb.id, ep.id, 1]].sort());
  });

  it("answers 404 and writes nothing for a reply line, a letter the episode does not read or a non-public letter", async () => {
    const { cookie, me, ep, la, lr } = await setup();
    const other = await insertLetter(env.DB, letterDraft((await insertItem(env.DB, itemDraft({ externalIds: { itunes: "3" } }))).id));
    const bad = [
      { episodeId: ep.id, letterId: lr.id, segmentIndex: 1 },
      { episodeId: ep.id, letterId: other.id, segmentIndex: 0 },
      { episodeId: ep.id, letterId: other.id },
    ];
    for (const b of bad) expect((await post(cookie, b)).status, JSON.stringify(b)).toBe(404);
    await setLetterStatus(env.DB, la.id, "rejected");
    expect((await post(cookie, { episodeId: ep.id, letterId: la.id, segmentIndex: 0 })).status).toBe(404);
    expect(await listHeardLetters(env.DB, me)).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listens").first<{ n: number }>())!.n).toBe(0);
  });

  it("records the public-view segment that reads the letter, whatever index the player sends", async () => {
    const { cookie, me, ep, la, lb } = await setup();
    expect((await post(cookie, { episodeId: ep.id, letterId: la.id, segmentIndex: 5 })).status).toBe(204);
    expect((await post(cookie, { episodeId: ep.id, letterId: lb.id })).status).toBe(204);
    const rows = await listHeardLetters(env.DB, me);
    expect(rows.map((r) => [r.letter.id, r.segmentIndex]).sort()).toEqual([[la.id, 0], [lb.id, 1]].sort());
  });

  it("records index 0 when an earlier letter was hidden after the episode was made and the player still reports 1", async () => {
    const { cookie, me, ep, la, lb } = await setup();
    await setLetterStatus(env.DB, la.id, "rejected");
    expect((await post(cookie, { episodeId: ep.id, letterId: lb.id, segmentIndex: 1 })).status).toBe(204);
    expect((await listHeardLetters(env.DB, me)).map((r) => [r.letter.id, r.segmentIndex])).toEqual([[lb.id, 0]]);
  });

  it("answers 404 for another listener's episode and for an unverified one", async () => {
    const { cookie, la } = await setup();
    const stranger = await createListener(env.DB);
    const theirs = await insertEpisode(env.DB, { listenerId: stranger.id, segments: [{ itemId: la.itemId, slot: "near", lines: [line(la)] }], verified: true, report });
    expect((await post(cookie, { episodeId: theirs.id, letterId: la.id, segmentIndex: 0 })).status).toBe(404);
    const mine = await insertEpisode(env.DB, { listenerId: idOf(cookie), segments: [{ itemId: la.itemId, slot: "near", lines: [line(la)] }], verified: false, report });
    expect((await post(cookie, { episodeId: mine.id, letterId: la.id, segmentIndex: 0 })).status).toBe(404);
  });

  it("answers 400 for bad JSON or a body of the wrong shape", async () => {
    const { cookie, ep, la } = await setup();
    expect((await post(cookie, "{nope", true)).status).toBe(400);
    expect((await post(cookie, { episodeId: ep.id })).status).toBe(400);
    expect((await post(cookie, { episodeId: ep.id, letterId: la.id, segmentIndex: -1 })).status).toBe(400);
    expect((await post(cookie, { episodeId: ep.id, letterId: la.id, segmentIndex: 0.5 })).status).toBe(400);
    expect((await post(cookie, { episodeId: 1, letterId: la.id, segmentIndex: 0 })).status).toBe(400);
  });

  it("refuses another origin", async () => {
    const { cookie, ep, la } = await setup();
    const res = await SELF.fetch(`${BASE}/listens`, { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ episodeId: ep.id, letterId: la.id, segmentIndex: 0 }) });
    expect(res.status).toBe(403);
  });
});
