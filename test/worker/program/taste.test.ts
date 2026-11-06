import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem, setItemVec } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import { recordListen } from "../../../src/worker/db/listens";
import { seededRng } from "../../../src/worker/program/select";
import { farness, pickByDial, tasteOf } from "../../../src/worker/program/taste";
import { angled } from "../../helpers/ai";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";

beforeEach(() => resetDb(env.DB));

describe("farness", () => {
  it("ranks by cosine distance from the taste as a percentile, 0 nearest and 1 farthest", () => {
    const far = farness(angled(0), new Map([["c", angled(1.5)], ["a", angled(0.1)], ["b", angled(0.7)]]));
    expect(far).toEqual(new Map([["a", 0], ["b", 0.5], ["c", 1]]));
  });

  it("puts a single candidate at 0 and breaks ties by id", () => {
    expect(farness(angled(0), new Map([["x", angled(1)]]))).toEqual(new Map([["x", 0]]));
    expect(farness(angled(0), new Map([["b", angled(1)], ["a", angled(1)]]))).toEqual(new Map([["a", 0], ["b", 1]]));
  });
});

describe("pickByDial", () => {
  const ids = ["p0", "p25", "p50", "p75", "p100"];
  const far = new Map([["p0", 0], ["p25", 0.25], ["p50", 0.5], ["p75", 0.75], ["p100", 1]]);

  it("picks inside the band of ±0.2 around the dial, with the slot of its percentile", () => {
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      expect(pickByDial(ids, far, 0, seededRng(seed))).toEqual({ id: "p0", slot: "near" });
      expect(pickByDial(ids, far, 1, seededRng(seed))).toEqual({ id: "p100", slot: "far" });
      expect(pickByDial(ids, far, 0.5, seededRng(seed))).toEqual({ id: "p50", slot: "neighbor" });
      expect(["p0", "p25"]).toContain(pickByDial(ids, far, 0.1, seededRng(seed))?.id);
    }
  });

  it("widens by 0.1 until the band holds a candidate", () => {
    const sparse = new Map([["n", 0], ["f", 1]]);
    // 0.55 from far, 0.45 from near: the band reaches near at 0.5 first.
    expect(pickByDial(["n", "f"], sparse, 0.45, seededRng("x"))).toEqual({ id: "n", slot: "near" });
    expect(pickByDial(["n", "f"], sparse, 0.7, seededRng("x"))).toEqual({ id: "f", slot: "far" });
    expect(pickByDial([], sparse, 0.5, seededRng("x"))).toBeNull();
  });

  it("is uniform inside the band: every candidate in it comes up", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 40; n++) seen.add(pickByDial(ids, far, 0.5, seededRng(`s${n}`))!.id);
    expect(seen).toEqual(new Set(["p50"]));
    const wide = new Set<string>();
    for (let n = 0; n < 40; n++) wide.add(pickByDial(ids, far, 0.375, seededRng(`s${n}`))!.id);
    expect(wide).toEqual(new Set(["p25", "p50"]));
  });
});

describe("tasteOf", () => {
  it("is the mean of the favourites' vectors, else of the works heard, else null", async () => {
    const me = await createListener(env.DB);
    expect(await tasteOf(env.DB, me)).toBeNull();

    const heardItem = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    await setItemVec(env.DB, heardItem.id, angled(1.2));
    const letter = await insertLetter(env.DB, letterDraft(heardItem.id, { body: "x" }));
    const ep = await insertEpisode(env.DB, { listenerId: me.id, segments: [], verified: true, report: { verbatim: true, sources: true, topical: true, pii: true, details: [] } });
    await recordListen(env.DB, { listenerId: me.id, episodeId: ep.id, letterId: letter.id, segmentIndex: 0 });
    const heard = (await tasteOf(env.DB, me))!;
    expect(heard[0]).toBeCloseTo(Math.cos(1.2), 2);

    const a = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    const b = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    const none = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    await setItemVec(env.DB, a.id, angled(0));
    await setItemVec(env.DB, b.id, angled(Math.PI / 2));
    await upsertHistory(env.DB, [a, b, none].map((i) => ({ listenerId: me.id, itemId: i.id, source: "manual" as const, occurredAt: null, rank: null })));
    const fav = (await tasteOf(env.DB, me))!;
    expect(fav[0]).toBeCloseTo(Math.SQRT1_2, 2);
    expect(fav[1]).toBeCloseTo(Math.SQRT1_2, 2);
    expect(Math.hypot(...fav)).toBeCloseTo(1, 5);
  });

  it("does not count an imported (Spotify) work as a favourite", async () => {
    const me = await createListener(env.DB);
    const i = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    await setItemVec(env.DB, i.id, angled(0));
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: i.id, source: "spotify", occurredAt: null, rank: 1 }]);
    expect(await tasteOf(env.DB, me)).toBeNull();
  });
});
