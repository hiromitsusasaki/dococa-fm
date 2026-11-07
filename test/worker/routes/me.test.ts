import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { getLetter, insertLetter, setLetterStatus } from "../../../src/worker/db/letters";
import { createListener, updateListener } from "../../../src/worker/db/listeners";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { recordListen } from "../../../src/worker/db/listens";
import { t } from "../../../src/worker/i18n/t";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";
import { BASE, get, newSession, postForm, signedInSession } from "./helpers";

const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;

beforeEach(() => resetDb(env.DB));

describe("GET /me", () => {
  it("sends an anonymous listener to sign-in", async () => {
    const res = await SELF.fetch(`${BASE}/me`, { redirect: "manual", headers: { cookie: await newSession() } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/google?next=%2Fme");
  });

  it("shows the new public radio address once, in one line, when sent here by the sign-in", async () => {
    const cookie = await signedInSession();
    const id = idOf(cookie);
    await updateListener(env.DB, id, { stationSlug: "kiku-radio" });
    const plain = await (await get("/me", cookie)).text();
    expect(plain).not.toContain('role="status"');
    const html = await (await get("/me?welcome=1", cookie)).text();
    const url = `${env.PUBLIC_ORIGIN}/stations/s:kiku-radio`;
    expect(html).toContain(`公開ラジオの URL ができました: ${url}（下の「あなたの公開ラジオ」で公開にすると誰でも聴けます）`);
    // Shown once: the page drops the query, so a reload has no banner.
    expect(html).toContain("history.replaceState");
    await updateListener(env.DB, id, { stationPublic: true });
    expect(await (await get("/me?welcome=1", cookie)).text()).not.toContain("公開ラジオの URL ができました");
  });

  it("shows who reacted and how, no favourites panel, and no counts", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    const item = await insertItem(env.DB, itemDraft({ title: "Blue in Green" }));
    await upsertHistory(env.DB, [{ listenerId: me, itemId: item.id, source: "manual", occurredAt: null, rank: 1 }]);
    const mine = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", body: "", bodyJa: "", parentLetterId: mine.id, radioName: "ミナミ", place: "那覇" }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", body: "いい曲ですね", bodyJa: "いい曲ですね", parentLetterId: mine.id, radioName: "キタ", place: "札幌" }));

    const html = await (await get("/me", cookie)).text();
    expect(html).not.toContain("あなたの好きなもの");
    expect(html).not.toContain(`href="/put?itemId=${item.id}"`);
    expect(html).toContain("ミナミ");
    expect(html).toContain("那覇");
    expect(html).toContain("いい曲ですね");
    expect(html).not.toMatch(/\d+ ?件/);
  });

  it("lays the page out as four panels: your letters, reactions, your public radio, heard; no sign-out form", async () => {
    const cookie = await signedInSession();
    const html = await (await get("/me", cookie)).text();
    const main = html.slice(html.indexOf('<main class="me"'));
    const panels = [...main.matchAll(/<section class="panel (me-[a-z]+)"/g)].map((m) => m[1]);
    expect(panels).toEqual(["me-letters", "me-reactions", "me-station", "me-heard"]);
    expect(main).not.toContain('action="/auth/signout"');
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

  it("marks the reactions seen when opened, and an anonymous visit marks nothing", async () => {
    const seenAt = async (id: string) => (await env.DB.prepare("SELECT reactions_seen_at AS s FROM listeners WHERE id = ?").bind(id).first<{ s: string | null }>())?.s ?? null;
    const anon = await newSession();
    await SELF.fetch(`${BASE}/me`, { redirect: "manual", headers: { cookie: anon } });
    expect(await seenAt(idOf(anon))).toBeNull();
    const cookie = await signedInSession();
    expect(await seenAt(idOf(cookie))).toBeNull();
    const before = new Date().toISOString();
    expect((await get("/me", cookie)).status).toBe(200);
    const seen = await seenAt(idOf(cookie));
    expect(seen).not.toBeNull();
    expect(seen! >= before).toBe(true);
  });

  it("says nobody has reacted yet when nobody has", async () => {
    const html = await (await get("/me", await signedInSession())).text();
    expect(html).toContain(t("me.nobody"));
  });

  it("shows the radio's url with a copy button, a public/private toggle, a slug form and what the radio plays", async () => {
    const cookie = await signedInSession();
    await updateListener(env.DB, idOf(cookie), { stationSlug: "hiro-fm" });
    const url = `${env.PUBLIC_ORIGIN}/stations/s:hiro-fm`;
    const panelOf = (html: string) => html.slice(html.indexOf('class="panel me-station"'), html.indexOf('class="panel me-heard"'));
    const off = panelOf(await (await get("/me", cookie)).text());
    expect(off).toContain(t("me.station"));
    expect(off).toContain(url);
    expect(off).toContain(`data-copy="${url}"`);
    // Private: the url is shown but not a link, and the toggle offers to make it public.
    expect(off).not.toContain(`href="${url}"`);
    expect(off).toMatch(/<form method="post" action="\/me\/radio"[^>]*>[\s\S]*?name="public" value="1"[\s\S]*?<button type="submit"[^>]*>公開する<\/button>/);
    expect(off).toMatch(/<input type="text" name="slug"[^>]*value="hiro-fm"/);
    expect(off).toContain("公開ラジオには、あなたが送ったお便りと、一言を返したお便りが流れます。");
    expect(off).toContain(t("me.radioNameOnly"));
    expect(off).not.toContain('href="/settings"');
    await updateListener(env.DB, idOf(cookie), { stationPublic: true });
    const on = panelOf(await (await get("/me", cookie)).text());
    expect(on).toContain(`href="${url}"`);
    expect(on).toMatch(/name="public" value="0"[\s\S]*?<button type="submit"[^>]*>非公開にする<\/button>/);
    expect(on).not.toMatch(/\d+ ?件/);
  });

  it("gives a signed-in listener without an address one, and shows it once the station is public", async () => {
    const cookie = await signedInSession();
    await updateListener(env.DB, idOf(cookie), { stationPublic: true });
    const html = await (await get("/me", cookie)).text();
    const slug = (await env.DB.prepare("SELECT station_slug FROM listeners WHERE id = ?").bind(idOf(cookie)).first<{ station_slug: string | null }>())?.station_slug;
    expect(slug).toMatch(/^radio-[0-9a-z]{6}$/);
    expect(html).toContain(`/stations/s:${slug}`);
    await get("/me", cookie);
    expect((await env.DB.prepare("SELECT station_slug FROM listeners WHERE id = ?").bind(idOf(cookie)).first<{ station_slug: string }>())?.station_slug).toBe(slug);
  });

  it("lists letters heard one row each: picture, work · sender, date and replay; no text, no forms, no counts", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    const a = await insertItem(env.DB, itemDraft({ title: "曲A" }));
    const b = await insertItem(env.DB, itemDraft({ title: "曲B", imageUrl: "https://example.com/b.jpg", externalIds: { itunes: "2" } }));
    const la = await insertLetter(env.DB, letterDraft(a.id, { body: "Aへのお便り", bodyJa: "Aへのお便り", radioName: "ミナミ", place: "那覇" }));
    const lb = await insertLetter(env.DB, letterDraft(b.id, { body: "Bへのお便り", bodyJa: "Bへのお便り", radioName: "キタ", place: "札幌" }));
    const line = (l: typeof la) => ({ type: "letter" as const, letterId: l.id, text: l.body, radioName: l.radioName, place: l.place, kind: "letter" as const, sourceUrl: null, sourceAuthor: null });
    const episode = () =>
      insertEpisode(env.DB, {
        listenerId: me,
        segments: [
          { itemId: a.id, slot: "near", lines: [line(la)] },
          { itemId: b.id, slot: "far", lines: [line(lb)] },
        ],
        verified: true,
        report: { verbatim: true, sources: true, topical: true, pii: true, details: [] },
      });
    const ep = await episode();
    const later = await episode();
    // Only what was actually played counts: the programme also holds la, which was never started.
    await recordListen(env.DB, { listenerId: me, episodeId: ep.id, letterId: lb.id, segmentIndex: 1 });
    await recordListen(env.DB, { listenerId: me, episodeId: later.id, letterId: lb.id, segmentIndex: 1 });
    const html = await (await get("/me", cookie)).text();
    const panel = html.slice(html.indexOf('class="panel me-heard"'));
    expect(panel).toContain(t("me.heard"));
    expect(panel).not.toContain("曲A");
    // Heard twice, listed once, with the newest replay.
    expect(panel.match(/<li/g)).toHaveLength(1);
    expect(panel).toContain(`href="/episodes/${later.id}?letter=${lb.id}"`);
    expect(panel).toContain(t("me.replay"));
    expect(panel).toMatch(/<img[^>]*src="https:\/\/example\.com\/b\.jpg"[^>]*width="40"/);
    expect(panel.replace(/<[^>]+>/g, "")).toContain("曲B · キタさん（札幌）");
    expect(panel).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(panel).not.toContain("Bへのお便り");
    expect(panel).not.toContain("<form");
    expect(panel).not.toMatch(/\d+ ?件/);
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

  it("names a heard found voice by its source's author, not as an anonymous listener", async () => {
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
    const panel = html.slice(html.indexOf('class="panel me-heard"'));
    expect(panel).toContain("@jazzcat");
    expect(panel).not.toContain(t("listener.anonymous"));
  });
});

describe("own letters and POST /letters/:id/withdraw", () => {
  const withdraw = (id: string, cookie: string) => postForm(`/letters/${id}/withdraw`, cookie, {});

  it("lists own public letters with the work and its picture, the first 80 characters, the date, share links and a withdraw button", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    await updateListener(env.DB, me, { radioName: "ちくわ" });
    const a = await insertItem(env.DB, itemDraft({ title: "Blue in Green", imageUrl: "https://example.com/a.jpg", externalIds: { itunes: "a1" } }));
    const b = await insertItem(env.DB, itemDraft({ title: "Kind of Blue", externalIds: { itunes: "b1" } }));
    const long = "あ".repeat(100);
    const l1 = await insertLetter(env.DB, letterDraft(a.id, { listenerId: me, body: long, bodyJa: long, radioName: "ちくわ", place: "那覇" }));
    const l2 = await insertLetter(env.DB, letterDraft(b.id, { listenerId: me, body: "二通目", bodyJa: "二通目", radioName: "ちくわ" }));
    const gone = await insertLetter(env.DB, letterDraft(b.id, { listenerId: me, body: "取り下げ済み", bodyJa: "取り下げ済み" }));
    await setLetterStatus(env.DB, gone.id, "withdrawn");
    await insertLetter(env.DB, letterDraft(b.id, { listenerId: (await createListener(env.DB)).id, body: "他人のお便り", bodyJa: "他人のお便り" }));
    const html = await (await get("/me", cookie)).text();
    const panel = html.slice(html.indexOf('class="panel me-letters"'), html.indexOf('class="panel me-reactions"'));
    expect(panel).toContain(t("me.myLetters"));
    expect(panel).toContain("Blue in Green");
    expect(panel).toContain("Kind of Blue");
    expect(panel).toMatch(/<img[^>]*src="https:\/\/example\.com\/a\.jpg"/);
    expect(panel).toContain("あ".repeat(80));
    expect(panel).not.toContain("あ".repeat(81));
    expect(panel).toContain("二通目");
    expect(panel).not.toContain("取り下げ済み");
    expect(panel).not.toContain("他人のお便り");
    expect(panel.match(new RegExp(`action="/letters/(${l1.id}|${l2.id})/withdraw"`, "g"))).toHaveLength(2);
    expect(panel).toContain(t("me.withdraw"));
    expect(panel).toContain(t("me.withdrawConfirm"));
    expect(panel).not.toMatch(/\d+ ?件/);
    // Share: the letter's public page and a short text with the work and the radio name; nothing private.
    const url = `${env.PUBLIC_ORIGIN}/letters/${l1.id}`;
    expect(panel.match(/<div class="share">/g)).toHaveLength(2);
    const x = panel.match(/<a class="pill" href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/)?.[1]?.replaceAll("&amp;", "&") ?? "";
    const intent = new URL(x);
    expect([...intent.searchParams.keys()].sort()).toEqual(["text", "url"]);
    expect(intent.searchParams.get("url")).toMatch(new RegExp(`^${env.PUBLIC_ORIGIN}/letters/(${l1.id}|${l2.id})$`));
    expect(intent.searchParams.get("text")).toMatch(/^(Blue in Green|Kind of Blue) · ちくわさんのお便り — Dococa FM$/);
    expect(panel).toContain(`data-copy="${url}"`);
    expect(panel).toContain(t("share.x"));
    expect(panel).not.toContain(me);
    expect(panel).not.toContain("那覇");
  });

  it("wires the share buttons with the small share script, not the radio's script and not inline code", async () => {
    const html = await (await get("/me", await signedInSession())).text();
    expect(html).toMatch(/<script type="module" src="(\/assets\/share-page\.js|\/src\/client\/share-page\.tsx)"><\/script>/);
    expect(html).not.toMatch(/src="[^"]*station\.(js|tsx)"/);
    expect(html).not.toContain("navigator.share");
  });

  it("shows a line instead of a list when there is no letter", async () => {
    const html = await (await get("/me", await signedInSession())).text();
    expect(html).toContain(t("me.myLettersNone"));
  });

  it("takes an own letter back: 303 to /me, and it is gone from the work page, the home cards and the shared page", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    const item = await insertItem(env.DB, itemDraft());
    const mine = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me, body: "ひみつの本文", bodyJa: "ひみつの本文" }));
    const watch = await get("/", cookie);
    expect(await watch.text()).toContain("ひみつの本文");
    expect(await (await get(`/items/${item.id}`, cookie)).text()).toContain("ひみつの本文");
    expect((await SELF.fetch(`${BASE}/letters/${mine.id}`)).status).toBe(200);

    const res = await withdraw(mine.id, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/me");
    expect((await getLetter(env.DB, mine.id))?.status).toBe("withdrawn");
    // Pressing it again is not an error.
    expect((await withdraw(mine.id, cookie)).status).toBe(303);
    expect(await (await get(`/items/${item.id}`, cookie)).text()).not.toContain("ひみつの本文");
    expect(await (await get("/", cookie)).text()).not.toContain("ひみつの本文");
    expect((await SELF.fetch(`${BASE}/letters/${mine.id}`)).status).toBe(404);
    expect(await (await get("/me", cookie)).text()).not.toContain("ひみつの本文");
  });

  it("answers 404 for another listener's letter, an own reply, a reaction and an unknown id, and changes nothing", async () => {
    const cookie = await signedInSession();
    const me = idOf(cookie);
    const item = await insertItem(env.DB, itemDraft());
    const theirs = await insertLetter(env.DB, letterDraft(item.id, { listenerId: (await createListener(env.DB)).id }));
    const parent = await insertLetter(env.DB, letterDraft(item.id, { listenerId: (await createListener(env.DB)).id }));
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", listenerId: me, parentLetterId: parent.id }));
    const anon = await insertLetter(env.DB, letterDraft(item.id, { listenerId: null }));
    for (const id of [theirs.id, reply.id, anon.id, "nope"]) expect((await withdraw(id, cookie)).status, id).toBe(404);
    for (const l of [theirs, reply, anon]) expect((await getLetter(env.DB, l.id))?.status).toBe("public");
  });

  it("sends an anonymous listener to sign-in and changes nothing", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const cookie = await newSession();
    const mine = await insertLetter(env.DB, letterDraft(item.id, { listenerId: idOf(cookie) }));
    const res = await withdraw(mine.id, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/google");
    expect((await getLetter(env.DB, mine.id))?.status).toBe("public");
  });
});

describe("POST /me/radio", () => {
  const radio = (cookie: string, body: Record<string, string>) => postForm("/me/radio", cookie, body);
  const rowOf = async (id: string) => env.DB.prepare("SELECT station_public AS pub, station_slug AS slug FROM listeners WHERE id = ?").bind(id).first<{ pub: number; slug: string | null }>();

  it("makes the caller's radio public and private again, keeping the slug, and leaves everyone else alone", async () => {
    const cookie = await signedInSession("Hiro");
    const other = idOf(await signedInSession("Other"));
    await updateListener(env.DB, other, { stationSlug: "other-fm" });
    await updateListener(env.DB, idOf(cookie), { stationSlug: "hiro-fm" });
    const on = await radio(cookie, { public: "1" });
    expect(on.status).toBe(303);
    expect(on.headers.get("location")).toBe("/me#radio");
    expect(await rowOf(idOf(cookie))).toEqual({ pub: 1, slug: "hiro-fm" });
    expect(await rowOf(other)).toEqual({ pub: 0, slug: "other-fm" });
    expect((await radio(cookie, { public: "0" })).status).toBe(303);
    expect(await rowOf(idOf(cookie))).toEqual({ pub: 0, slug: "hiro-fm" });
  });

  it("gives an address to a listener who has none when the radio is made public", async () => {
    const cookie = await signedInSession();
    expect((await radio(cookie, { public: "1" })).status).toBe(303);
    const row = await rowOf(idOf(cookie));
    expect(row?.pub).toBe(1);
    expect(row?.slug).toMatch(/^radio-[0-9a-z]{6}$/);
  });

  it("changes the slug (trimmed, lower-cased) without touching public", async () => {
    const cookie = await signedInSession();
    await updateListener(env.DB, idOf(cookie), { stationSlug: "hiro-fm", stationPublic: true });
    expect((await radio(cookie, { slug: "  My-Radio " })).status).toBe(303);
    expect(await rowOf(idOf(cookie))).toEqual({ pub: 1, slug: "my-radio" });
    expect(await (await get("/me", cookie)).text()).toContain(`href="${env.PUBLIC_ORIGIN}/stations/s:my-radio"`);
  });

  it("422s with 「この URL は使われています」 on a slug another listener holds, and changes nothing", async () => {
    const other = idOf(await signedInSession("Other"));
    await updateListener(env.DB, other, { stationSlug: "my-radio", stationPublic: true });
    const cookie = await signedInSession("Hiro");
    await updateListener(env.DB, idOf(cookie), { stationSlug: "hiro-fm" });
    const res = await radio(cookie, { slug: "my-radio" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("この URL は使われています");
    expect(html).toMatch(/<input type="text" name="slug"[^>]*value="my-radio"/);
    expect(await rowOf(idOf(cookie))).toEqual({ pub: 0, slug: "hiro-fm" });
    expect(await rowOf(other)).toEqual({ pub: 1, slug: "my-radio" });
  });

  it("422s for a slug that breaks the rule, an unknown public value or an empty post, and changes nothing", async () => {
    const cookie = await signedInSession();
    await updateListener(env.DB, idOf(cookie), { stationSlug: "hiro-fm" });
    const bodies: Record<string, string>[] = [{ slug: "ab" }, { slug: "has space" }, { slug: "UPPER_x" }, { slug: "a".repeat(25) }, { slug: "" }, { public: "yes" }, { public: "1", slug: "x-fm" }, {}];
    for (const body of bodies) {
      expect((await radio(cookie, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(await rowOf(idOf(cookie))).toEqual({ pub: 0, slug: "hiro-fm" });
  });

  it("sends an anonymous listener to sign-in and changes nothing", async () => {
    const cookie = await newSession();
    const res = await radio(cookie, { public: "1", slug: "sneaky" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/google");
    expect(await rowOf(idOf(cookie))).toEqual({ pub: 0, slug: null });
  });
});
