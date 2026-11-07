import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { updateListener } from "../../../src/worker/db/listeners";
import { t } from "../../../src/worker/i18n/t";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";
import { get, newSession } from "./helpers";

beforeEach(() => resetDb(env.DB));

const idOf = (cookie: string): string => cookie.slice(cookie.indexOf("=") + 1).split(".")[0]!;

describe("GET /items/:id", () => {
  it("offers a nameless listener a collapsed name and place under each reply form, with the place lists once per page; never to a named one", async () => {
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id, { body: "一通目" }));
    await insertLetter(env.DB, letterDraft(item.id, { body: "二通目" }));
    const cookie = await newSession();
    const html = await (await get(`/items/${item.id}`, cookie)).text();
    expect(html.match(/<details class="reply-name"><summary>ラジオネームとお住まいを添える（任意）<\/summary><label><span>ラジオネーム<\/span><input type="text" name="radioName" maxlength="20"\/><\/label><div class="place-slot"><\/div><\/details><button type="submit">返す<\/button><\/form>/g)).toHaveLength(2);
    expect(html.match(/<template id="place-fields">/g)).toHaveLength(1);
    expect(html).toMatch(/<template id="place-fields">[\s\S]*<select name="placeCountry">[\s\S]*<option value="JP">日本<\/option>[\s\S]*<select name="placeRegion">[\s\S]*<optgroup label="日本"><option value="01">北海道<\/option>[\s\S]*<\/template>/);
    await updateListener(env.DB, idOf(cookie), { radioName: "しずく" });
    const named = await (await get(`/items/${item.id}`, cookie)).text();
    expect(named).not.toContain("reply-name");
    expect(named).not.toContain("place-fields");
  });

  it("404 for a missing item", async () => {
    expect((await get("/items/nope", await newSession())).status).toBe(404);
  });

  it("shows the card, out links with fallbacks and the put link", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    expect(html).toContain("Blue in Green");
    expect(html).toContain("Miles Davis");
    expect(html).toContain("1959");
    expect(html).toContain(t("kind.music"));
    expect(html).toContain("https://music.apple.com/x");
    expect(html).toContain("https://open.spotify.com/search/");
    expect(html).toContain("https://www.youtube.com/results?search_query=");
    expect(html).toContain("https://www.google.com/search?q=");
    expect(html).toContain(`/put?itemId=${item.id}`);
  });

  it("shows a book's and a film's own link", async () => {
    const book = await insertItem(env.DB, itemDraft({ kind: "book", title: "こころ", outLinks: { "google-books": "https://books.google.com/books?id=b1" }, externalIds: { "google-books": "b1" } }));
    const film = await insertItem(env.DB, itemDraft({ kind: "film", title: "Parasite", outLinks: { tmdb: "https://www.themoviedb.org/movie/7" }, externalIds: { tmdb: "7" } }));
    const cookie = await newSession();
    const bookHtml = await (await get(`/items/${book.id}`, cookie)).text();
    expect(bookHtml).toContain("https://books.google.com/books?id=b1");
    expect(bookHtml).toContain(t("out.google-books"));
    const filmHtml = await (await get(`/items/${film.id}`, cookie)).text();
    expect(filmHtml).toContain("https://www.themoviedb.org/movie/7");
    expect(filmHtml).toContain(t("out.tmdb"));
  });

  it("letter_body_is_escaped_in_item_page", async () => {
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id, { body: "<script>alert(1)</script>", bodyJa: "<script>alert(1)</script>", radioName: "<b>x</b>" }));
    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("shows bodyJa with the untouched original for non-japanese letters", async () => {
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id, { body: "I loved this at 15", bodyJa: "15 歳のときに大好きだった", lang: "en" }));
    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    expect(html).toContain("15 歳のときに大好きだった");
    expect(html).toContain("I loved this at 15");
    expect(html).toContain(`<summary>${t("letter.showOriginal")}</summary>`);
    expect(html).toMatch(/<details class="letter-original">/);
  });

  it("shows an english listener the original as the main text, with no toggle", async () => {
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id, { body: "I loved this at 15", bodyJa: "15 歳のときに大好きだった", bodyEn: "I loved this at 15", lang: "en" }));
    const cookie = await newSession();
    await updateListener(env.DB, idOf(cookie), { lang: "en" });
    const html = await (await get(`/items/${item.id}`, cookie)).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("I loved this at 15");
    expect(html).not.toContain("15 歳のときに大好きだった");
    expect(html).not.toContain("letter-original");
    expect(html).toContain(t("item.putLetter", undefined, "en"));
  });

  it("gives an english listener the translation first and the japanese original behind the toggle", async () => {
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id, { body: "中学の頃、毎日聴いていた", bodyJa: "中学の頃、毎日聴いていた", bodyEn: "I listened every day in junior high" }));
    const cookie = await newSession();
    await updateListener(env.DB, idOf(cookie), { lang: "en" });
    const html = await (await get(`/items/${item.id}`, cookie)).text();
    expect(html).toContain('<p class="letter-body">I listened every day in junior high</p>');
    expect(html).toContain(`<summary>${t("letter.showOriginal", undefined, "en")}</summary>`);
    expect(html).toContain("中学の頃、毎日聴いていた");
  });

  it("shows found letters under their own heading with the source link and takedown link", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const found = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", body: "見つけた声", bodyJa: "見つけた声", sourceUrl: "https://example.org/post/1", sourceAuthor: "山田" }));
    await insertLetter(env.DB, letterDraft(item.id, { body: "ふつうの一通", bodyJa: "ふつうの一通" }));
    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    const at = html.indexOf(t("item.foundVoices"));
    expect(at).toBeGreaterThan(-1);
    expect(html.indexOf("見つけた声", at)).toBeGreaterThan(at);
    expect(html).toContain('href="https://example.org/post/1"');
    expect(html).toContain("山田");
    expect(html).toContain(`/takedown?letterId=${found.id}`);
    expect(html.indexOf("ふつうの一通")).toBeLessThan(at);
  });

  it("labels a found voice by its source author, never as an anonymous listener", async () => {
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id, { kind: "found", radioName: "", place: "", body: "見つけた声", bodyJa: "見つけた声", sourceUrl: "https://example.org/post/1", sourceAuthor: "山田" }));
    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    expect(html).toContain("山田");
    expect(html).not.toContain(t("listener.anonymous"));
  });

  it("shows reactions under the parent as 'who から 私も' without counts", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    for (const name of ["あ", "い", "う"]) {
      await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", body: "私も", bodyJa: "私も", radioName: name, place: "高知", parentLetterId: parent.id }));
    }
    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    expect(html).toContain("あさん（高知）から");
    expect(html).toContain("『私も』");
    expect(html).not.toMatch(/\d+\s*(件|人|位)/);
  });

  it("has no count-like numbers", async () => {
    const item = await insertItem(env.DB, itemDraft());
    for (let i = 0; i < 3; i++) await insertLetter(env.DB, letterDraft(item.id, { body: `一通${i}`, bodyJa: `一通${i}` }));
    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    expect(html).not.toMatch(/\d+\s*(件|人|位)/);
  });

  it("does not list rejected letters", async () => {
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id, { body: "消えた", bodyJa: "消えた", status: "rejected" }));
    expect(await (await get(`/items/${item.id}`, await newSession())).text()).not.toContain("消えた");
  });

  it("renders a report form and the original for an english reply", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", body: "Same here", bodyJa: "私もです", lang: "en", parentLetterId: parent.id }));
    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    expect(html).toContain(`/letters/${reply.id}/report`);
    expect(html).toContain("Same here");
    expect(html).toContain("私もです");
  });
});
