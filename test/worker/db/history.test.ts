import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { listHistory, upsertHistory } from "../../../src/worker/db/history";
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
      { listenerId: me.id, itemId: a.id, source: "spotify", occurredAt: "2026-01-01T00:00:00.000Z" },
      { listenerId: me.id, itemId: b.id, source: "spotify", occurredAt: "2026-02-01T00:00:00.000Z" },
      { listenerId: me.id, itemId: c.id, source: "manual", occurredAt: null },
    ]);
    const rows = await listHistory(env.DB, me.id, 10);
    expect(rows.map((r) => r.item.title)).toEqual(["B", "A", "C"]);
    expect(rows[0]).toMatchObject({ listenerId: me.id, itemId: b.id, source: "spotify" });
    expect(await listHistory(env.DB, me.id, 2)).toHaveLength(2);
  });

  it("upsertHistory on conflict updates source and keeps occurredAt when the new one is null", async () => {
    const me = await createListener(env.DB);
    const a = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source: "spotify", occurredAt: "2026-01-01T00:00:00.000Z" }]);
    await upsertHistory(env.DB, [{ listenerId: me.id, itemId: a.id, source: "manual", occurredAt: null }]);
    const rows = await listHistory(env.DB, me.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "manual", occurredAt: "2026-01-01T00:00:00.000Z" });
  });

  it("upsertHistory with no rows is a no-op", async () => {
    await expect(upsertHistory(env.DB, [])).resolves.toBeUndefined();
  });
});
