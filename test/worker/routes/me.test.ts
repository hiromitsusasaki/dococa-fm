import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { updateListener } from "../../../src/worker/db/listeners";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { recordListen } from "../../../src/worker/db/listens";
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

  it("lays the page out as four panels, with an image on a favourite and no sign-out form", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    const withArt = await insertItem(env.DB, itemDraft({ title: "With art", imageUrl: "https://example.com/a.jpg", externalIds: { itunes: "11" } }));
    const noArt = await insertItem(env.DB, itemDraft({ title: "No art", imageUrl: null, externalIds: { itunes: "12" } }));
    await upsertHistory(env.DB, [
      { listenerId: me, itemId: withArt.id, source: "manual", occurredAt: null, rank: 1 },
      { listenerId: me, itemId: noArt.id, source: "manual", occurredAt: null, rank: 2 },
    ]);
    const html = await (await get("/me", cookie)).text();
    const main = html.slice(html.indexOf('<main class="me"'));
    const panels = [...main.matchAll(/<section class="panel (me-[a-z]+)"/g)].map((m) => m[1]);
    expect(panels).toEqual(["me-favorites", "me-heard", "me-reactions", "me-station"]);
    expect(main).not.toContain('action="/auth/signout"');
    expect(main).toMatch(/<img src="https:\/\/example\.com\/a\.jpg"[^>]*width="96"[^>]*height="96"/);
    expect(main.match(/<img /g)).toHaveLength(1);
    // The art box stays, empty, for the favourite without an image.
    expect(main.match(/class="item-card-box"/g)).toHaveLength(2);
    expect(main).toContain(`href="/put?itemId=${noArt.id}"`);
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
    // Only what was actually played counts: the programme also holds la, which was never started.
    await recordListen(env.DB, { listenerId: me, episodeId: ep.id, letterId: lb.id, segmentIndex: 1 });
    const html = await (await get("/me", cookie)).text();
    expect(html).not.toContain("Aへのお便り");
    expect(html).toContain(t("me.heard"));
    expect(html).toContain("Bへのお便り");
    expect(html).not.toContain("那覇");
    expect(html).toContain(`href="/episodes/${ep.id}?letter=${lb.id}"`);
    expect(html).toContain(`name="parentLetterId" value="${lb.id}"`);
    expect(html).toContain(`<a class="me-card-link" href="/items/${b.id}">`);
    expect(html).not.toMatch(/\d+ ?件/);
    expect(html).not.toMatch(/\d+ letters/);
  });

  it("says so when nothing has been heard, even if an episode holds letters", async () => {
    const cookie = await signedInSession();
    const a = await insertItem(env.DB, itemDraft());
    const l = await insertLetter(env.DB, letterDraft(a.id));
    await insertEpisode(env.DB, { listenerId: idOf(cookie), segments: [{ itemId: a.id, slot: "near", lines: [{ type: "letter", letterId: l.id, text: l.body, radioName: l.radioName, place: l.place, kind: "letter", sourceUrl: null, sourceAuthor: null }] }], verified: true, report: { verbatim: true, sources: true, topical: true, pii: true, details: [] } });
    expect(await (await get("/me", cookie)).text()).toContain(t("me.heardNone"));
  });

  it("says so when nothing has been heard", async () => {
    const html = await (await get("/me", await signedInSession())).text();
    expect(html).toContain(t("me.heardNone"));
  });

  it("shows a heard found voice with its source, not as an anonymous listener", async () => {
    const cookie = await signedInSession();
    const a = await insertItem(env.DB, itemDraft());
    const found = await insertLetter(env.DB, letterDraft(a.id, { kind: "found", radioName: "", place: "", sourceAuthor: "@jazzcat", sourceUrl: "https://youtu.be/x", body: "so good", bodyJa: "とてもいい" }));
    const ep = await insertEpisode(env.DB, {
      listenerId: idOf(cookie),
      segments: [{ itemId: a.id, slot: "far", lines: [{ type: "letter", letterId: found.id, text: "とてもいい", radioName: "", place: "", kind: "found", sourceUrl: "https://youtu.be/x", sourceAuthor: "@jazzcat" }] }],
      verified: true,
      report: { verbatim: true, sources: true, topical: true, pii: true, details: [] },
    });
    await recordListen(env.DB, { listenerId: idOf(cookie), episodeId: ep.id, letterId: found.id, segmentIndex: 0 });
    const html = await (await get("/me", cookie)).text();
    expect(html).toContain("@jazzcat");
    expect(html).toContain('href="https://youtu.be/x"');
    expect(html).toContain(`/takedown?letterId=${found.id}`);
    expect(html).not.toContain(t("listener.anonymous"));
  });
});
