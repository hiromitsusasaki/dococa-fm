import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { listFavorites, listHistory, upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { createListener } from "../../../src/worker/db/listeners";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "./helpers";

describe("history", () => {
  beforeEach(() => resetDb(env.DB));

  it("upsertHistory inserts, lists newest first with NULLs last, joined with items", async () => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft({ title: "A", externalIds: {} }));
    const b = await insertItem(env.DB, itemDraft({ title: "B", externalIds: {} }));
    const c = await insertItem(env.DB, itemDraft({ title: "C", externalIds: {} }));
    await upsertHistory(env.DB, [
      { listenerId: me.id, itemId: a.id, source: "spotify", occurredAt: "2026-01-01T00:00:00.000Z", rank: null },
      { listenerId: me.id, itemId: b.id, source: "spotify", occurredAt: "2026-02-01T00:00:00.000Z", rank: null },
      { listenerId: me.id, itemId: c.id, source: "manual", occurredAt: null, rank: null },
    ]);
    const rows = await listHistory(env.DB, me.id, 10);
    expect(rows.map((r) => r.item.title)).toEqual(["B", "A", "C"]);
    expect(rows[0]).toMatchObject({ listenerId: me.id, itemId: b.id, source: "spotify" });
    expect(await listHistory(env.DB, me.id, 2)).toHaveLength(2);
  });

  it("upsertHistory on conflict updates source and keeps occurredAt when the new one is null", async () => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source: "spotify", occurredAt: "2026-01-01T00:00:00.000Z", rank: null }]);
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source: "manual", occurredAt: null, rank: null }]);
    const rows = await listHistory(env.DB, me.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "manual", occurredAt: "2026-01-01T00:00:00.000Z" });
  });

  it("upsertHistory with no rows is a no-op", async () => {
    await expect(upsertHistory(env.DB, [])).resolves.toBeUndefined();
  });

  it("rank order puts the most loved first and rows without a rank last", async () => {
    const me = await createListener(env.DB);
    const [a, b, c] = await Promise.all(["A", "B", "C"].map((title) => insertItem(env.DB, itemDraft({ title, externalIds: {} }))));
    await upsertHistory(env.DB, [
      { listenerId: me.id, itemId: a!.id, source: "manual", occurredAt: null, rank: null },
      { listenerId: me.id, itemId: b!.id, source: "manual", occurredAt: null, rank: 2 },
      { listenerId: me.id, itemId: c!.id, source: "manual", occurredAt: null, rank: 1 },
    ]);
    const rows = await listHistory(env.DB, me.id, 10, "rank");
    expect(rows.map((r) => r.item.title)).toEqual(["C", "B", "A"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, null]);
  });

  it("upsertHistory keeps the rank when the new row has none", async () => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source: "manual", occurredAt: null, rank: 3 }]);
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source: "manual", occurredAt: null, rank: null }]);
    expect((await listHistory(env.DB, me.id, 10))[0]?.rank).toBe(3);
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source: "manual", occurredAt: null, rank: 1 }]);
    expect((await listHistory(env.DB, me.id, 10))[0]?.rank).toBe(1);
  });

  it.each(["manual", "url"] as const)("a spotify import does not demote a %s favourite", async (source) => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source, occurredAt: null, rank: null }]);
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source: "spotify", occurredAt: "2026-01-01T00:00:00.000Z", rank: 4 }], { clearRanksOf: me.id });
    const [row] = await listFavorites(env.DB, me.id, 10);
    expect(row).toMatchObject({ source, rank: 4, occurredAt: "2026-01-01T00:00:00.000Z" });
  });

  it("a re-import clears every rank of the listener, a manual favourite's included", async () => {
    const me = await createListener(env.DB);
    const [a, b] = await Promise.all(["A", "B"].map((title) => insertItem(env.DB, itemDraft({ title, externalIds: {} }))));
    await upsertHistory(env.DB, [
      { listenerId: me.id, itemId: a!.id, source: "manual", occurredAt: null, rank: 1 },
      { listenerId: me.id, itemId: b!.id, source: "spotify", occurredAt: null, rank: 2 },
    ]);
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: b!.id, source: "spotify", occurredAt: null, rank: 1 }], { clearRanksOf: me.id });
    const ranks = Object.fromEntries((await listHistory(env.DB, me.id, 10)).map((r) => [r.item.title, r.rank]));
    expect(ranks).toEqual({ A: null, B: 1 });
  });

  it("listFavorites leaves out what a service played and orders by rank", async () => {
    const me = await createListener(env.DB);
    const [a, b, c] = await Promise.all(["A", "B", "C"].map((title) => insertItem(env.DB, itemDraft({ title, externalIds: {} }))));
    await upsertHistory(env.DB, [
      { listenerId: me.id, itemId: a!.id, source: "spotify", occurredAt: "2026-01-01T00:00:00.000Z", rank: 1 },
      { listenerId: me.id, itemId: b!.id, source: "url", occurredAt: null, rank: 2 },
      { listenerId: me.id, itemId: c!.id, source: "manual", occurredAt: null, rank: 1 },
    ]);
    expect((await listFavorites(env.DB, me.id, 10)).map((r) => r.item.title)).toEqual(["C", "B"]);
    expect(await listFavorites(env.DB, me.id, 1)).toHaveLength(1);
  });
});
