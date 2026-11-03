import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import {
  countRecentDuplicate,
  getLetter,
  insertLetter,
  listLettersByListener,
  listLettersForItem,
  listReactionsForLetter,
  setLetterStatus,
} from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import { itemDraft, letterDraft, resetDb } from "./helpers";

const tick = () => new Promise((r) => setTimeout(r, 3));

describe("letters", () => {
  beforeEach(() => resetDb(env.DB));

  it("insertLetter then getLetter round-trips", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const l = await insertLetter(env.DB, letterDraft(item.id, { year: 2001, sourceUrl: "https://x.example/p" }));
    expect(await getLetter(env.DB, l.id)).toEqual(l);
    expect(l.year).toBe(2001);
    expect(await getLetter(env.DB, "nope")).toBeNull();
  });

  it("listLettersForItem returns only public, oldest first", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const other = await insertItem(env.DB, itemDraft({ title: "x", externalIds: {} }));
    const first = await insertLetter(env.DB, letterDraft(item.id, { body: "1" }));
    await tick();
    await insertLetter(env.DB, letterDraft(item.id, { body: "rej", status: "rejected" }));
    await tick();
    const second = await insertLetter(env.DB, letterDraft(item.id, { body: "2" }));
    await insertLetter(env.DB, letterDraft(other.id, { body: "other" }));
    expect((await listLettersForItem(env.DB, item.id)).map((l) => l.id)).toEqual([first.id, second.id]);
  });

  it("listLettersByListener returns all statuses, newest first", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const me = await createListener(env.DB);
    const you = await createListener(env.DB);
    const a = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me.id }));
    await tick();
    const b = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me.id, status: "rejected" }));
    await insertLetter(env.DB, letterDraft(item.id, { listenerId: you.id }));
    expect((await listLettersByListener(env.DB, me.id)).map((l) => l.id)).toEqual([b.id, a.id]);
  });

  it("listReactionsForLetter returns public children, oldest first", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const r1 = await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: parent.id }));
    await tick();
    await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: parent.id, status: "rejected" }));
    await tick();
    const r2 = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: parent.id }));
    expect((await listReactionsForLetter(env.DB, parent.id)).map((l) => l.id)).toEqual([r1.id, r2.id]);
  });

  it("countRecentDuplicate counts identical bodies within the window", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const me = await createListener(env.DB);
    await insertLetter(env.DB, letterDraft(item.id, { listenerId: me.id, body: "same" }));
    await insertLetter(env.DB, letterDraft(item.id, { listenerId: me.id, body: "different" }));
    expect(await countRecentDuplicate(env.DB, me.id, "same", 10)).toBe(1);
    const later = new Date(Date.now() + 11 * 60_000);
    expect(await countRecentDuplicate(env.DB, me.id, "same", 10, later)).toBe(0);
    const other = await createListener(env.DB);
    expect(await countRecentDuplicate(env.DB, other.id, "same", 10)).toBe(0);
  });

  it("setLetterStatus changes status", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const l = await insertLetter(env.DB, letterDraft(item.id));
    await setLetterStatus(env.DB, l.id, "rejected");
    expect((await getLetter(env.DB, l.id))?.status).toBe("rejected");
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });
});
