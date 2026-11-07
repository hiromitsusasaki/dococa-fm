import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimProfile,
  createListener,
  getListener,
  getListenerByGoogleSub,
  getListenerBySlug,
  listRecentPublicRadios,
  updateListener,
} from "../../../src/worker/db/listeners";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, setLetterStatus } from "../../../src/worker/db/letters";
import { itemDraft, letterDraft } from "./helpers";
import { resetDb } from "../../helpers/db";

describe("listeners", () => {
  beforeEach(() => resetDb(env.DB));

  it("createListener applies defaults", async () => {
    const l = await createListener(env.DB);
    expect(l).toMatchObject({
      radioName: "",
      place: "",
      voice: "",
      dial: 0.3,
      lang: "ja",
      spotifyRefreshToken: null,
      cloudTtsUsed: false,
    });
    expect(l.mcpToken).toMatch(/^[0-9a-f]{48}$/);
    expect(await getListener(env.DB, l.id)).toEqual(l);
  });

  it("updateListener patches only given fields", async () => {
    const l = await createListener(env.DB);
    const u = await updateListener(env.DB, l.id, { radioName: "夜更かし", dial: 0.7, spotifyRefreshToken: "tok" });
    expect(u).toMatchObject({ radioName: "夜更かし", dial: 0.7, spotifyRefreshToken: "tok", place: "", mcpToken: l.mcpToken });
    expect(await getListener(env.DB, l.id)).toEqual(u);
  });

  it("updateListener with an empty patch returns the listener unchanged", async () => {
    const l = await createListener(env.DB);
    expect(await updateListener(env.DB, l.id, {})).toEqual(l);
  });

  it("updateListener writes cloudTtsUsed as a boolean", async () => {
    const l = await createListener(env.DB);
    expect((await updateListener(env.DB, l.id, { cloudTtsUsed: true }))?.cloudTtsUsed).toBe(true);
    expect((await updateListener(env.DB, l.id, { cloudTtsUsed: false }))?.cloudTtsUsed).toBe(false);
  });

  it("createListener starts without a google identity or a public station", async () => {
    const l = await createListener(env.DB);
    expect(l).toMatchObject({ googleSub: null, displayName: "", stationPublic: false, stationSlug: null });
  });

  it("getListenerByGoogleSub finds the listener who signed in with that account", async () => {
    const l = await createListener(env.DB);
    await createListener(env.DB);
    await updateListener(env.DB, l.id, { googleSub: "g1", displayName: "Hiro" });
    expect(await getListenerByGoogleSub(env.DB, "g1")).toMatchObject({ id: l.id, googleSub: "g1", displayName: "Hiro" });
    expect(await getListenerByGoogleSub(env.DB, "g2")).toBeNull();
  });

  it("getListenerBySlug returns only public stations", async () => {
    const l = await createListener(env.DB);
    await updateListener(env.DB, l.id, { stationSlug: "hiro", stationPublic: true });
    expect((await getListenerBySlug(env.DB, "hiro"))?.id).toBe(l.id);
    expect((await getListener(env.DB, l.id))?.stationPublic).toBe(true);
    await updateListener(env.DB, l.id, { stationPublic: false });
    expect(await getListenerBySlug(env.DB, "hiro")).toBeNull();
  });

  it("a google account or a slug belongs to one listener", async () => {
    const a = await createListener(env.DB);
    const b = await createListener(env.DB);
    await updateListener(env.DB, a.id, { googleSub: "g1", stationSlug: "hiro" });
    await expect(updateListener(env.DB, b.id, { googleSub: "g1" })).rejects.toThrow(/UNIQUE/);
    await expect(updateListener(env.DB, b.id, { stationSlug: "hiro" })).rejects.toThrow(/UNIQUE/);
  });

  it("many listeners may have no google account or slug", async () => {
    await createListener(env.DB);
    await expect(createListener(env.DB)).resolves.toBeDefined();
  });

  it("lang can be en", async () => {
    const l = await createListener(env.DB);
    expect((await updateListener(env.DB, l.id, { lang: "en" }))?.lang).toBe("en");
  });
  it("listRecentPublicRadios: public stations by their newest public letter, newest first, cut at the limit", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const tick = () => new Promise((r) => setTimeout(r, 3));
    const mk = async (slug: string, over: Parameters<typeof updateListener>[2] = {}) =>
      (await updateListener(env.DB, (await createListener(env.DB)).id, { stationSlug: slug, stationPublic: true, radioName: slug, place: "札幌", ...over }))!;
    const a = await mk("aaa");
    const b = await mk("bbb", { placeCountry: "JP", placeRegion: "13" });
    const priv = await mk("ccc", { stationPublic: false });
    const none = await mk("ddd");
    const gone = await mk("eee");
    const send = (l: { id: string }) => insertLetter(env.DB, letterDraft(item.id, { listenerId: l.id }));
    await send(a);
    await tick();
    await send(b);
    await tick();
    await send(priv);
    const withdrawn = await send(gone);
    await setLetterStatus(env.DB, withdrawn.id, "withdrawn");
    await tick();
    await send(a);
    expect(none.id).toBeTruthy();
    const radios = await listRecentPublicRadios(env.DB, 5);
    expect(radios.map((r) => r.slug)).toEqual(["aaa", "bbb"]);
    expect(radios[1]).toMatchObject({ radioName: "bbb", placeCountry: "JP", placeRegion: "13" });
    expect((await listRecentPublicRadios(env.DB, 1)).map((r) => r.slug)).toEqual(["aaa"]);
  });
});

describe("claimProfile", () => {
  it("names a nameless listener once: a second claim, like a racing reply that lost, changes nothing", async () => {
    const l = await createListener(env.DB);
    expect(await claimProfile(env.DB, l.id, { radioName: "しずく", placeCountry: "JP", placeRegion: "32", place: "島根" })).toBe(true);
    expect(await claimProfile(env.DB, l.id, { radioName: "別の名前", placeCountry: "FR", placeRegion: null, place: "フランス" })).toBe(false);
    const me = (await getListener(env.DB, l.id))!;
    expect([me.radioName, me.placeCountry, me.placeRegion, me.place]).toEqual(["しずく", "JP", "32", "島根"]);
  });
});
