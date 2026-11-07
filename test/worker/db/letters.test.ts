import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import {
  countRecentDuplicate,
  getLetter,
  getPublicLetterWithTitle,
  hasUnseenReactions,
  insertLetter,
  listLettersByListener,
  listLettersForItem,
  listRecentPublicLetters,
  listReactionsForLetter,
  listOwnPublicLetters,
  setLetterStatus,
  withdrawLetter,
} from "../../../src/worker/db/letters";
import { createListener, markReactionsSeen } from "../../../src/worker/db/listeners";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "./helpers";

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

  it("keeps the place codes, null when there are none", async () => {
    const item = await insertItem(env.DB, itemDraft());
    expect((await insertLetter(env.DB, letterDraft(item.id))).placeCountry).toBeNull();
    const l = await insertLetter(env.DB, letterDraft(item.id, { placeCountry: "JP", placeRegion: "32" }));
    const got = await getLetter(env.DB, l.id);
    expect([got?.placeCountry, got?.placeRegion]).toEqual(["JP", "32"]);
  });

  it("bodyEn is null by default and round-trips when given", async () => {
    const item = await insertItem(env.DB, itemDraft());
    expect((await insertLetter(env.DB, letterDraft(item.id))).bodyEn).toBeNull();
    const en = await insertLetter(env.DB, letterDraft(item.id, { bodyEn: "Thank you" }));
    expect((await getLetter(env.DB, en.id))?.bodyEn).toBe("Thank you");
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

  it("withdrawLetter takes back only the listener's own public letter, and listOwnPublicLetters stops listing it", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const me = await createListener(env.DB);
    const other = await createListener(env.DB);
    const mine = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me.id, body: "mine" }));
    await tick();
    const mine2 = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me.id, body: "mine2" }));
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", listenerId: me.id, parentLetterId: mine.id }));
    const theirs = await insertLetter(env.DB, letterDraft(item.id, { listenerId: other.id }));
    expect((await listOwnPublicLetters(env.DB, me.id)).map((l) => l.id)).toEqual([mine2.id, mine.id]);
    expect(await withdrawLetter(env.DB, theirs.id, me.id)).toBe(false);
    expect(await withdrawLetter(env.DB, reply.id, me.id)).toBe(false);
    expect(await withdrawLetter(env.DB, "nope", me.id)).toBe(false);
    expect(await withdrawLetter(env.DB, mine.id, me.id)).toBe(true);
    expect(await withdrawLetter(env.DB, mine.id, me.id)).toBe(false);
    expect((await getLetter(env.DB, mine.id))?.status).toBe("withdrawn");
    expect((await getLetter(env.DB, theirs.id))?.status).toBe("public");
    expect((await listOwnPublicLetters(env.DB, me.id)).map((l) => l.id)).toEqual([mine2.id]);
    expect((await listLettersForItem(env.DB, item.id)).map((l) => l.id)).not.toContain(mine.id);
    expect((await listRecentPublicLetters(env.DB, 10)).map((l) => l.id)).not.toContain(mine.id);
    expect(await getPublicLetterWithTitle(env.DB, mine.id)).toBeNull();
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

  it("listRecentPublicLetters: newest first, letters and sourced found voices only, public only, with the work", async () => {
    const a = await insertItem(env.DB, itemDraft({ title: "A", externalIds: { itunes: "a" } }));
    const b = await insertItem(env.DB, itemDraft({ title: "B", externalIds: { itunes: "b" } }));
    const old = await insertLetter(env.DB, letterDraft(a.id, { body: "古い", bodyJa: "古い" }));
    await tick();
    await insertLetter(env.DB, letterDraft(a.id, { kind: "watashimo" }));
    await insertLetter(env.DB, letterDraft(a.id, { kind: "reply" }));
    await insertLetter(env.DB, letterDraft(a.id, { status: "rejected" }));
    await insertLetter(env.DB, letterDraft(a.id, { kind: "found", sourceAuthor: null }));
    await insertLetter(env.DB, letterDraft(a.id, { kind: "found", sourceAuthor: "誰か", sourceUrl: "" }));
    await insertLetter(env.DB, letterDraft(a.id, { kind: "found", sourceAuthor: "  ", sourceUrl: "https://x.example/p" }));
    await tick();
    const found = await insertLetter(env.DB, letterDraft(b.id, { kind: "found", sourceAuthor: "誰か", sourceUrl: "https://x.example/p" }));
    await tick();
    const fresh = await insertLetter(env.DB, letterDraft(b.id, { body: "新しい", bodyJa: "新しい" }));
    const got = await listRecentPublicLetters(env.DB, 6);
    expect(got.map((l) => l.id)).toEqual([fresh.id, found.id, old.id]);
    expect(got[0]!.item.title).toBe("B");
    expect(got[2]!.item.title).toBe("A");
    expect(await listRecentPublicLetters(env.DB, 2)).toHaveLength(2);
  });

  it("hasUnseenReactions: another's public 私も or 一言 on the listener's public letter, after the last look", async () => {
    const me = await createListener(env.DB);
    const other = await createListener(env.DB);
    const item = await insertItem(env.DB, itemDraft());
    const mine = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me.id }));
    expect(await hasUnseenReactions(env.DB, me.id)).toBe(false);
    await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: mine.id, listenerId: me.id }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: mine.id, status: "rejected" }));
    expect(await hasUnseenReactions(env.DB, me.id)).toBe(false);
    await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: mine.id, listenerId: other.id }));
    expect(await hasUnseenReactions(env.DB, me.id)).toBe(true);
    expect(await hasUnseenReactions(env.DB, other.id)).toBe(false);
    await tick();
    await markReactionsSeen(env.DB, me.id);
    expect(await hasUnseenReactions(env.DB, me.id)).toBe(false);
    await tick();
    await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: mine.id }));
    expect(await hasUnseenReactions(env.DB, me.id)).toBe(true);
    await setLetterStatus(env.DB, mine.id, "rejected");
    expect(await hasUnseenReactions(env.DB, me.id)).toBe(false);
  });

  it("getPublicLetterWithTitle: a public letter or sourced found voice with its work's title, nothing else", async () => {
    const item = await insertItem(env.DB, itemDraft({ title: "題" }));
    const l = await insertLetter(env.DB, letterDraft(item.id));
    const found = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: "https://x.example/p", sourceAuthor: "@a" }));
    const bare = await insertLetter(env.DB, letterDraft(item.id, { kind: "found" }));
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: l.id }));
    const hidden = await insertLetter(env.DB, letterDraft(item.id, { status: "rejected" }));
    const got = await getPublicLetterWithTitle(env.DB, l.id);
    expect(got?.letter.id).toBe(l.id);
    expect(got?.title).toBe("題");
    expect((await getPublicLetterWithTitle(env.DB, found.id))?.letter.id).toBe(found.id);
    for (const id of [bare.id, reply.id, hidden.id, "nope"]) expect(await getPublicLetterWithTitle(env.DB, id)).toBeNull();
  });
});
