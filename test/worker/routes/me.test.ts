import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { updateListener } from "../../../src/worker/db/listeners";
import { t } from "../../../src/worker/i18n/t";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";
import { BASE, get, newSession, signedInSession } from "./helpers";

const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;

beforeEach(() => resetDb(env.DB));

describe("GET /me", () => {
  it("sends an anonymous listener to sign-in", async () => {
    const res = await SELF.fetch(`${BASE}/me`, { redirect: "manual", headers: { cookie: await newSession() } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/google?next=%2Fme");
  });

  it("shows favorites, who reacted and how, and no counts", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    const item = await insertItem(env.DB, itemDraft({ title: "Blue in Green" }));
    await upsertHistory(env.DB, [{ listenerId: me, itemId: item.id, source: "manual", occurredAt: null, rank: 1 }]);
    const mine = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", body: "", bodyJa: "", parentLetterId: mine.id, radioName: "ミナミ", place: "那覇" }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", body: "いい曲ですね", bodyJa: "いい曲ですね", parentLetterId: mine.id, radioName: "キタ", place: "札幌" }));

    const html = await (await get("/me", cookie)).text();
    expect(html).toContain(t("me.favorites"));
    expect(html).toContain(`href="/items/${item.id}"`);
    expect(html).toContain(`href="/put?itemId=${item.id}"`);
    expect(html).toContain("ミナミ");
    expect(html).toContain("那覇");
    expect(html).toContain("いい曲ですね");
    expect(html).not.toMatch(/\d+ ?件/);
  });

  it("says nobody has reacted yet when nobody has", async () => {
    const html = await (await get("/me", await signedInSession())).text();
    expect(html).toContain(t("me.nobody"));
  });

  it("shows the public url when the station is public, else a way to settings", async () => {
    const cookie = await signedInSession();
    expect(await (await get("/me", cookie)).text()).toContain('href="/settings"');
    await updateListener(env.DB, idOf(cookie), { stationPublic: true, stationSlug: "hiro-fm" });
    expect(await (await get("/me", cookie)).text()).toContain("/stations/s:hiro-fm");
  });
});
