import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, setLetterStatus } from "../../../src/worker/db/letters";
import { listHeardLetters, recordListen } from "../../../src/worker/db/listens";
import { createListener } from "../../../src/worker/db/listeners";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "./helpers";

const report = { verbatim: true, sources: true, topical: true, pii: true, details: [] };
const episodeOf = (listenerId: string) => insertEpisode(env.DB, { listenerId, segments: [], verified: true, report });

beforeEach(() => resetDb(env.DB));

describe("recordListen", () => {
  it("keeps one row per listener and letter, updating the episode, segment and time", async () => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    const la = await insertLetter(env.DB, letterDraft(a.id));
    const e1 = await episodeOf(me.id);
    const e2 = await episodeOf(me.id);
    await recordListen(env.DB, { listenerId: me.id, episodeId: e1.id, letterId: la.id, segmentIndex: 0, heardAt: "2026-11-01T00:00:00.000Z" });
    await recordListen(env.DB, { listenerId: me.id, episodeId: e2.id, letterId: la.id, segmentIndex: 2, heardAt: "2026-11-02T00:00:00.000Z" });
    const rows = await listHeardLetters(env.DB, me.id);
    expect(rows.map((r) => [r.letter.id, r.episodeId, r.segmentIndex, r.heardAt])).toEqual([[la.id, e2.id, 2, "2026-11-02T00:00:00.000Z"]]);
  });

  it("stamps the time itself when none is given", async () => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    const la = await insertLetter(env.DB, letterDraft(a.id));
    const e = await episodeOf(me.id);
    await recordListen(env.DB, { listenerId: me.id, episodeId: e.id, letterId: la.id, segmentIndex: 0 });
    expect((await listHeardLetters(env.DB, me.id))[0]!.heardAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("listHeardLetters", () => {
  it("lists newest first with the item, only this listener's rows", async () => {
    const me = await createListener(env.DB);
    const other = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft({ title: "A" }));
    const b = await insertItem(env.DB, itemDraft({ title: "B", externalIds: { itunes: "2" } }));
    const la = await insertLetter(env.DB, letterDraft(a.id, { body: "a" }));
    const lb = await insertLetter(env.DB, letterDraft(b.id, { body: "b" }));
    const e = await episodeOf(me.id);
    const eo = await episodeOf(other.id);
    await recordListen(env.DB, { listenerId: me.id, episodeId: e.id, letterId: la.id, segmentIndex: 0, heardAt: "2026-11-01T00:00:00.000Z" });
    await recordListen(env.DB, { listenerId: me.id, episodeId: e.id, letterId: lb.id, segmentIndex: 1, heardAt: "2026-11-02T00:00:00.000Z" });
    await recordListen(env.DB, { listenerId: other.id, episodeId: eo.id, letterId: la.id, segmentIndex: 0, heardAt: "2026-11-03T00:00:00.000Z" });
    const rows = await listHeardLetters(env.DB, me.id);
    expect(rows.map((r) => [r.letter.id, r.segmentIndex, r.item.title])).toEqual([
      [lb.id, 1, "B"],
      [la.id, 0, "A"],
    ]);
  });

  it("honours the limit after leaving out letters that are no longer public", async () => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    const e = await episodeOf(me.id);
    const ls = [];
    for (let i = 0; i < 3; i++) ls.push(await insertLetter(env.DB, letterDraft(a.id, { body: `l${i}` })));
    const gone = await insertLetter(env.DB, letterDraft(a.id, { body: "gone" }));
    for (const [i, l] of ls.entries()) await recordListen(env.DB, { listenerId: me.id, episodeId: e.id, letterId: l.id, segmentIndex: 0, heardAt: `2026-11-0${i + 1}T00:00:00.000Z` });
    await recordListen(env.DB, { listenerId: me.id, episodeId: e.id, letterId: gone.id, segmentIndex: 0, heardAt: "2026-11-09T00:00:00.000Z" });
    await setLetterStatus(env.DB, gone.id, "rejected");
    const rows = await listHeardLetters(env.DB, me.id, 2);
    expect(rows.map((r) => r.letter.id)).toEqual([ls[2]!.id, ls[1]!.id]);
  });

  it.each(["rejected", "withdrawn"] as const)("leaves out a 一言 whose letter is %s", async (status) => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    const parent = await insertLetter(env.DB, letterDraft(a.id, { body: "parent" }));
    const reply = await insertLetter(env.DB, letterDraft(a.id, { kind: "reply", parentLetterId: parent.id, body: "reply" }));
    const e = await episodeOf(me.id);
    await recordListen(env.DB, { listenerId: me.id, episodeId: e.id, letterId: reply.id, segmentIndex: 0 });
    expect((await listHeardLetters(env.DB, me.id)).map((r) => r.letter.id)).toEqual([reply.id]);
    await setLetterStatus(env.DB, parent.id, status);
    expect(await listHeardLetters(env.DB, me.id)).toEqual([]);
  });
});
