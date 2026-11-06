import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { getUnits, listLettersWithoutUnit, listUnitsWithoutAudio, setUnitAudioReady, upsertUnit } from "../../../src/worker/db/units";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "./helpers";

const unit = (letterId: string, over: Partial<Parameters<typeof upsertUnit>[1]> = {}) => ({
  letterId,
  lang: "ja" as const,
  intro: "静かな一曲です。",
  after: "いいお便りでした。",
  verified: true,
  audioReady: false,
  ...over,
});

beforeEach(async () => {
  await resetDb(env.DB);
});

describe("units", () => {
  it("stores a unit per letter and language, and reads them back by lang", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const a = await insertLetter(env.DB, letterDraft(item.id));
    const b = await insertLetter(env.DB, letterDraft(item.id));
    const stored = await upsertUnit(env.DB, unit(a.id));
    expect(stored).toMatchObject({ letterId: a.id, lang: "ja", verified: true, audioReady: false });
    expect(typeof stored.createdAt).toBe("string");
    await upsertUnit(env.DB, unit(a.id, { lang: "en", intro: "A quiet song.", verified: false }));
    await upsertUnit(env.DB, unit(b.id, { createdAt: "2026-01-01T00:00:00.000Z" }));

    const ja = await getUnits(env.DB, [a.id, b.id, "missing"], "ja");
    expect([...ja.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(ja.get(a.id)).toEqual(stored);
    expect(ja.get(b.id)!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    const en = await getUnits(env.DB, [a.id, b.id], "en");
    expect([...en.values()]).toEqual([expect.objectContaining({ letterId: a.id, intro: "A quiet song.", verified: false })]);
  });

  it("replaces a unit on a second upsert", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const a = await insertLetter(env.DB, letterDraft(item.id));
    await upsertUnit(env.DB, unit(a.id, { verified: false }));
    await upsertUnit(env.DB, unit(a.id, { intro: "二度目", verified: true }));
    expect((await getUnits(env.DB, [a.id], "ja")).get(a.id)).toMatchObject({ intro: "二度目", verified: true });
  });

  it("keeps a verified unit over a later unverified or verified upsert", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const a = await insertLetter(env.DB, letterDraft(item.id));
    await upsertUnit(env.DB, unit(a.id, { audioReady: true }));
    await upsertUnit(env.DB, unit(a.id, { intro: "あとから", verified: false }));
    await upsertUnit(env.DB, unit(a.id, { intro: "もう一度", verified: true }));
    expect((await getUnits(env.DB, [a.id], "ja")).get(a.id)).toMatchObject({ intro: "静かな一曲です。", verified: true, audioReady: true });
  });

  it("reads more letter ids than one statement binds", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const a = await insertLetter(env.DB, letterDraft(item.id));
    await upsertUnit(env.DB, unit(a.id));
    const ids = [...Array.from({ length: 150 }, (_, i) => `x${i}`), a.id];
    expect((await getUnits(env.DB, ids, "ja")).size).toBe(1);
  });

  it("marks a unit's audio ready", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const a = await insertLetter(env.DB, letterDraft(item.id));
    const u = unit(a.id);
    await upsertUnit(env.DB, u);
    await setUnitAudioReady(env.DB, a.id, "ja", true, u);
    expect((await getUnits(env.DB, [a.id], "ja")).get(a.id)!.audioReady).toBe(true);
  });

  it("does not mark a unit whose texts are no longer the ones that were voiced", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const a = await insertLetter(env.DB, letterDraft(item.id));
    const u = unit(a.id);
    await upsertUnit(env.DB, { ...u, intro: "別の紹介" });
    await setUnitAudioReady(env.DB, a.id, "ja", true, u);
    expect((await getUnits(env.DB, [a.id], "ja")).get(a.id)!.audioReady).toBe(false);
  });

  it("lists public letters and found voices with no unit in the language, oldest first", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const older = await insertLetter(env.DB, letterDraft(item.id));
    const found = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: "https://youtu.be/x", sourceAuthor: "@a" }));
    const withUnit = await insertLetter(env.DB, letterDraft(item.id));
    const rejected = await insertLetter(env.DB, letterDraft(item.id, { status: "rejected" }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: older.id, body: "私も", bodyJa: "私も" }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: older.id, body: "わかる", bodyJa: "わかる" }));
    await env.DB.prepare("UPDATE letters SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(older.id).run();
    await upsertUnit(env.DB, unit(withUnit.id));
    await upsertUnit(env.DB, unit(found.id, { lang: "en" }));

    expect(await listLettersWithoutUnit(env.DB, "ja", 10)).toEqual([older.id, found.id]);
    expect(await listLettersWithoutUnit(env.DB, "ja", 1)).toEqual([older.id]);
    expect(await listLettersWithoutUnit(env.DB, "en", 10)).toEqual([older.id, withUnit.id]);
    expect(await listLettersWithoutUnit(env.DB, "ja", 10)).not.toContain(rejected.id);
  });

  it("lists verified units of public letters whose audio is not ready, oldest first", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const [a, b, c, d, e] = await Promise.all(Array.from({ length: 5 }, () => insertLetter(env.DB, letterDraft(item.id))));
    await upsertUnit(env.DB, unit(a!.id, { createdAt: "2026-01-02T00:00:00.000Z" }));
    await upsertUnit(env.DB, unit(b!.id, { createdAt: "2026-01-01T00:00:00.000Z" }));
    await upsertUnit(env.DB, unit(c!.id, { verified: false }));
    await upsertUnit(env.DB, unit(d!.id, { audioReady: true }));
    await upsertUnit(env.DB, unit(e!.id));
    await env.DB.prepare("UPDATE letters SET status = 'rejected' WHERE id = ?").bind(e!.id).run();

    expect((await listUnitsWithoutAudio(env.DB, "ja", 10)).map((u) => u.letterId)).toEqual([b!.id, a!.id]);
    expect((await listUnitsWithoutAudio(env.DB, "ja", 1)).map((u) => u.letterId)).toEqual([b!.id]);
    expect(await listUnitsWithoutAudio(env.DB, "en", 10)).toEqual([]);
  });
});
