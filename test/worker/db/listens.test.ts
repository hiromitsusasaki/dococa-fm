import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, setLetterStatus } from "../../../src/worker/db/letters";
import { listHeardLetters } from "../../../src/worker/db/listens";
import { createListener } from "../../../src/worker/db/listeners";
import type { Letter, ScriptLine, Segment } from "../../../src/worker/types";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "./helpers";

const report = { verbatim: true, sources: true, topical: true, pii: true, details: [] };
const read = (l: Letter): ScriptLine => ({ type: "letter", letterId: l.id, text: l.body, radioName: l.radioName, place: l.place, kind: "letter", sourceUrl: null, sourceAuthor: null });
const seg = (itemId: string, ...letters: Letter[]): Segment => ({ itemId, slot: "near", lines: [{ type: "dj", text: "d" }, ...letters.map(read)] });

beforeEach(() => resetDb(env.DB));

describe("listHeardLetters", () => {
  it("lists newest episode first, one row per letter, with its segment index", async () => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft({ title: "A" }));
    const b = await insertItem(env.DB, itemDraft({ title: "B", externalIds: { itunes: "2" } }));
    const la = await insertLetter(env.DB, letterDraft(a.id, { body: "a" }));
    const lb = await insertLetter(env.DB, letterDraft(b.id, { body: "b" }));
    await insertEpisode(env.DB, { listenerId: me.id, segments: [seg(a.id, la)], verified: true, report, createdAt: "2026-11-01T00:00:00.000Z" });
    const newer = await insertEpisode(env.DB, { listenerId: me.id, segments: [seg(a.id, la), seg(b.id, lb)], verified: true, report, createdAt: "2026-11-02T00:00:00.000Z" });
    const rows = await listHeardLetters(env.DB, me.id);
    expect(rows.map((r) => [r.letter.id, r.episodeId, r.segmentIndex, r.item.title])).toEqual([
      [la.id, newer.id, 0, "A"],
      [lb.id, newer.id, 1, "B"],
    ]);
    expect(rows[0]!.heardAt).toBe("2026-11-02T00:00:00.000Z");
  });

  it("honours the limit, skips unverified episodes, other listeners and letters no longer public", async () => {
    const me = await createListener(env.DB);
    const other = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    const ls = [];
    for (let i = 0; i < 3; i++) ls.push(await insertLetter(env.DB, letterDraft(a.id, { body: `l${i}` })));
    const gone = await insertLetter(env.DB, letterDraft(a.id, { body: "gone" }));
    await setLetterStatus(env.DB, gone.id, "rejected");
    await insertEpisode(env.DB, { listenerId: me.id, segments: [seg(a.id, ...ls, gone)], verified: true, report });
    await insertEpisode(env.DB, { listenerId: me.id, segments: [seg(a.id, ls[0]!)], verified: false, report });
    await insertEpisode(env.DB, { listenerId: other.id, segments: [seg(a.id, ls[0]!)], verified: true, report });
    const rows = await listHeardLetters(env.DB, me.id, 2);
    expect(rows.map((r) => r.letter.id)).toEqual([ls[0]!.id, ls[1]!.id]);
    expect((await listHeardLetters(env.DB, me.id)).map((r) => r.letter.id)).not.toContain(gone.id);
  });
});
