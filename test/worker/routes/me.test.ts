import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { updateListener } from "../../../src/worker/db/listeners";
import { insertEpisode } from "../../../src/worker/db/episodes";
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

  it("lists reactions newest first and shows no counts in English either", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    await updateListener(env.DB, me, { lang: "en" });
    const item = await insertItem(env.DB, itemDraft());
    const mine = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me }));
    const react = async (name: string, at: string) => {
      const r = await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", body: "", bodyJa: "", parentLetterId: mine.id, radioName: name, place: "" }));
      await env.DB.prepare("UPDATE letters SET created_at = ? WHERE id = ?").bind(at, r.id).run();
    };
    await react("Older", "2026-01-01T00:00:00.000Z");
    await react("Newer", "2026-02-01T00:00:00.000Z");
    const html = await (await get("/me", cookie)).text();
    expect(html.indexOf("Newer")).toBeGreaterThan(-1);
    expect(html.indexOf("Newer")).toBeLessThan(html.indexOf("Older"));
    expect(html).not.toMatch(/\d+ (reactions|people|letters)/);
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

  it("lists letters heard, with replay link, reactions and no counts", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    const a = await insertItem(env.DB, itemDraft({ title: "曲A" }));
    const b = await insertItem(env.DB, itemDraft({ title: "曲B", externalIds: { itunes: "2" } }));
    const la = await insertLetter(env.DB, letterDraft(a.id, { body: "Aへのお便り", bodyJa: "Aへのお便り", radioName: "ミナミ", place: "那覇" }));
    const lb = await insertLetter(env.DB, letterDraft(b.id, { body: "Bへのお便り", bodyJa: "Bへのお便り" }));
    const line = (l: typeof la) => ({ type: "letter" as const, letterId: l.id, text: l.body, radioName: l.radioName, place: l.place, kind: "letter" as const, sourceUrl: null, sourceAuthor: null });
    const ep = await insertEpisode(env.DB, {
      listenerId: me,
      segments: [
        { itemId: a.id, slot: "near", lines: [line(la)] },
        { itemId: b.id, slot: "far", lines: [line(lb)] },
      ],
      verified: true,
      report: { verbatim: true, sources: true, topical: true, pii: true, details: [] },
    });
    const html = await (await get("/me", cookie)).text();
    expect(html).toContain(t("me.heard"));
    expect(html).toContain("Bへのお便り");
    expect(html).toContain("那覇");
    expect(html).toContain(`href="/episodes/${ep.id}?seg=1"`);
    expect(html).toContain(`name="parentLetterId" value="${lb.id}"`);
    expect(html).not.toMatch(/\d+ ?件/);
    expect(html).not.toMatch(/\d+ letters/);
  });

  it("says so when nothing has been heard", async () => {
    const html = await (await get("/me", await signedInSession())).text();
    expect(html).toContain(t("me.heardNone"));
  });
});
