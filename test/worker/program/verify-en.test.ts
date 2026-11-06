import { describe, expect, it } from "vitest";
import { t } from "../../../src/worker/i18n/t";
import { FIXED_TEMPLATES } from "../../../src/worker/program/compose";
import { verifyEpisode } from "../../../src/worker/program/verify";
import { MEASURE_EN, PLAYBACK_EN, TOPICAL_EN } from "../../../src/worker/program/verify-en";
import type { Letter, ScriptLine, Segment } from "../../../src/worker/types";
import { byId, item, letter, listener } from "./fixtures";

const ja = letter({ id: "a", bodyEn: "I listened alone at midnight and cried a little." });
const english = letter({ id: "e", body: "My grandmother hummed this while she cooked.", bodyJa: "祖母が料理しながら口ずさんでいました。", bodyEn: null, lang: "en" });
const letters = byId([ja, english]);
const me = listener({ lang: "en" });

const read = (l: Letter, text: string): ScriptLine => ({
  type: "letter",
  letterId: l.id,
  text,
  radioName: l.radioName,
  place: l.place,
  kind: l.kind,
  sourceUrl: l.sourceUrl,
  sourceAuthor: l.sourceAuthor,
});
const dj = (text: string): ScriptLine => ({ type: "dj", text });
const episode = (...lines: ScriptLine[]): Segment[] => [{ itemId: "i1", slot: "near", lines }];
const check = (text: string) => verifyEpisode(episode(dj(text), read(ja, ja.bodyEn!)), letters, me, new Map(), "en");
const named = (text: string, rule: string) => check(text).details.filter((d) => d.startsWith(`${rule}: `));

describe("english patterns", () => {
  it.each(["Let's play it.", "Here it is.", "Here's the song.", "Have a listen.", "Give it a spin.", "Check it out.", "Enjoy!", "Coming up next, a song.", "Without further ado"])("PLAYBACK_EN refuses %s", (s) => {
    expect(PLAYBACK_EN.test(s)).toBe(true);
  });
  it.each(["Enjoy it.", "Enjoy the song.", "enjoy the film"])("PLAYBACK_EN refuses %s", (s) => {
    expect(PLAYBACK_EN.test(s)).toBe(true);
  });
  it.each(["I played it on repeat.", "A song that plays with silence.", "She enjoyed the quiet.", "Listening back, it feels close.", "For people who enjoy quiet music.", "You might enjoy its patience."])("PLAYBACK_EN passes %s", (s) => {
    expect(PLAYBACK_EN.test(s)).toBe(false);
  });

  it.each(["3 people wrote about it.", "12 listeners sent letters.", "It was number one.", "A #1 record.", "In the top 10.", "A ranking of songs.", "He made 5 albums.", "2 songs in a row.", "A million plays."])("MEASURE_EN refuses %s", (s) => {
    expect(MEASURE_EN.test(s)).toBe(true);
  });
  it.each(["One song, quietly.", "1 song for the night.", "Two people falling in love.", "A film about one family.", "Track 1 of the album."])("MEASURE_EN passes %s", (s) => {
    expect(MEASURE_EN.test(s)).toBe(false);
  });

  it.each(["Perfect for tonight.", "Today, a quiet one.", "This week we have jazz.", "Recently I heard it.", "A Christmas song.", "It's trending.", "Out now.", "In the news."])("TOPICAL_EN refuses %s", (s) => {
    expect(TOPICAL_EN.test(s)).toBe(true);
  });
  it.each(["Last week it rained.", "Next month, perhaps.", "Next year again.", "This spring.", "This fall it returns.", "This winter.", "A Valentine's song.", "Before the election.", "The Olympics.", "The World Cup final.", "Breaking: a new song.", "I heard it the other day."])("TOPICAL_EN refuses %s", (s) => {
    expect(TOPICAL_EN.test(s)).toBe(true);
  });
  it.each(["A song for the night.", "Someday it will be yours.", "A slow morning song.", "Newly found, long loved.", "The last song of the album.", "A spring of clear water.", "Next to the window.", "A heartbreaking chorus."])("TOPICAL_EN passes %s", (s) => {
    expect(TOPICAL_EN.test(s)).toBe(false);
  });
});

describe("english gaps", () => {
  it.each([
    "At the moment, a quiet one.", "As of now, it is a classic.", "Nowadays it plays everywhere.", "A song for this weekend.", "Perfect for this season.",
    "A song for the holidays.", "An Easter song.", "For Thanksgiving dinner.", "Now in theaters.", "In theaters soon.", "Now showing downtown.", "On sale now.",
    "Their latest album.", "The latest film by her.", "The latest movie.", "Her latest book.", "The latest single.", "The latest release.",
  ])("TOPICAL_EN refuses %s", (s) => {
    expect(s.match(TOPICAL_EN)).not.toBeNull();
  });

  it.each(["Two letters arrived.", "Three messages came in.", "Twelve letters about it.", "Dozens of letters.", "Dozens of messages.", "Dozens of people wrote.", "Dozens of listeners.", "The second letter.", "The fifth letter is short.", "The 3rd letter.", "The 21st letter."])("MEASURE_EN refuses %s", (s) => {
    expect(s.match(MEASURE_EN)).not.toBeNull();
  });

  it.each(["Two people falling in love.", "A letter from far away.", "The second verse.", "One letter, quietly."])("MEASURE_EN passes %s", (s) => {
    expect(s.match(MEASURE_EN)).toBeNull();
  });

  it.each(["Hit play.", "Press play and wait.", "Put it on loud.", "Tune in.", "Listen to it once.", "Listen to this.", "Watch it alone.", "Watch this one."])("PLAYBACK_EN refuses %s", (s) => {
    expect(s.match(PLAYBACK_EN)).not.toBeNull();
  });

  it.each(["I listened to it twice.", "She watched it alone.", "Listening to it feels close.", "A song to listen for.", "A press of the hand."])("PLAYBACK_EN passes %s", (s) => {
    expect(s.match(PLAYBACK_EN)).toBeNull();
  });

  it.each(["The east wind.", "A holiday of one.", "A theater kid's song."])("TOPICAL_EN passes %s", (s) => {
    expect(s.match(TOPICAL_EN)).toBeNull();
  });
});

describe("verifyEpisode in english", () => {
  it("passes an english episode that reads bodyEn and the original of an english letter", () => {
    const r = verifyEpisode(episode(dj("A quiet piece from 1959."), read(ja, ja.bodyEn!), read(english, english.body)), letters, me, byId([item()]), "en");
    expect(r).toEqual({ verbatim: true, sources: true, topical: true, pii: true, details: [] });
  });

  it("fails verbatim when an english episode reads the japanese translation of an english letter", () => {
    const r = verifyEpisode(episode(read(english, english.bodyJa)), letters, me, new Map(), "en");
    expect(r.verbatim).toBe(false);
  });

  it("does not accept bodyEn on a japanese episode", () => {
    expect(verifyEpisode(episode(read(ja, ja.bodyEn!)), letters, me).verbatim).toBe(false);
  });

  it("names playback, measure and topical words in an english dj line", () => {
    expect(named("Let's play it.", "playback")).toHaveLength(1);
    expect(named("3 people wrote about it.", "measure")).toHaveLength(1);
    expect(named("Perfect for tonight.", "topical")).toHaveLength(1);
    expect(check("I played it on repeat, one song at night.").details).toEqual([]);
  });

  it("allows the work's year and refuses any other year", () => {
    const items = byId([item()]);
    expect(verifyEpisode(episode(dj("Recorded in 1959."), read(ja, ja.bodyEn!)), letters, me, items, "en").topical).toBe(true);
    expect(verifyEpisode(episode(dj("A song for 2026."), read(ja, ja.bodyEn!)), letters, me, items, "en").topical).toBe(false);
  });

  it("refuses an english hand-over in a segment with no letter", () => {
    const r = verifyEpisode([{ itemId: "i1", slot: "near", lines: [dj("Here's a letter from the coast.")] }], letters, me, new Map(), "en");
    expect(r.details.some((d) => d.startsWith("announce: "))).toBe(true);
  });

  it("refuses a dj line that copies six words of the letter in english, and passes common short phrases", () => {
    expect(check("Someone listened alone at midnight and cried, it says.").details.some((d) => d.endsWith("quotes a letter"))).toBe(true);
    expect(check("Alone at midnight and still awake, a song of the night.").details).toEqual([]);
  });

  it("checks an english fixed line on its filled values only", () => {
    const quoted = letter({ id: "q", body: "A letter from Minato, Hakodate, Japan. Thank you.", bodyJa: "誰かからの手紙。", lang: "en" });
    const text = t("script.letterFrom", { who: "Minato (Hakodate, Japan)" }, "en");
    const r = verifyEpisode(episode({ type: "dj", text, fixed: true }, read(quoted, quoted.body)), byId([quoted]), me, new Map(), "en");
    expect(r.details).toEqual([]);
  });

  it.each(FIXED_TEMPLATES)("the english %s says nothing the dj checks would refuse", (key) => {
    const text = t(key, { who: "Minato (Hakodate, Japan)", author: "@jazzcat", site: "YouTube" }, "en");
    const r = verifyEpisode(episode(dj(text), read(ja, ja.bodyEn!)), letters, me, new Map(), "en");
    expect(r).toMatchObject({ topical: true, pii: true });
  });
});
