import { describe, expect, it } from "vitest";
import { t } from "../../../src/worker/i18n/t";
import { bridgeLine } from "../../../src/worker/program/bridge";
import { originalsOf, publicView } from "../../../src/worker/program/stored";
import type { ScriptLine, Segment } from "../../../src/worker/types";
import { byId, letter } from "./fixtures";

const read = (id: string, kind: "letter" | "found" | "reply" = "letter"): ScriptLine => ({
  type: "letter",
  letterId: id,
  text: id,
  radioName: "",
  place: "",
  kind,
  sourceUrl: null,
  sourceAuthor: null,
});
const dj = (text: string): ScriptLine => ({ type: "dj", text });
const fixed = (text: string): ScriptLine => ({ type: "dj", text, fixed: true });

const segments: Segment[] = [
  { itemId: "i1", slot: "near", lines: [fixed("お便りを読みます。"), read("a"), fixed("found intro"), read("f", "found"), fixed("reply intro"), read("r", "reply"), dj("after")] },
  { itemId: "i2", slot: "far", lines: [dj("before"), read("b"), dj("after")] },
];

describe("publicView", () => {
  it("leaves out a dj line's spoken text, which only the voice reads", () => {
    const spoken: Segment[] = [{ itemId: "i1", slot: "near", lines: [{ type: "dj", text: "PSYの曲", spoken: "サイの曲", fixed: true }, read("a")] }];
    const view = publicView(spoken, byId([letter({ id: "a" })]));
    expect(view.segments[0]!.lines[0]).toEqual({ type: "dj", text: "PSYの曲", fixed: true });
    expect(spoken[0]!.lines[0]).toHaveProperty("spoken", "サイの曲");
  });

  it("keeps everything while every letter is public, with stored indices in order", () => {
    const letters = byId(["a", "f", "r", "b"].map((id) => letter({ id })));
    const view = publicView(segments, letters);
    expect(view.segments).toEqual(segments);
    expect(view.storedIndex).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("drops a preview clip an older episode carries, and keeps the stored indices of the lines after it", () => {
    const old: Segment[] = [{ itemId: "i1", slot: "near", lines: [dj("before"), read("a"), { type: "preview", url: "https://example.com/a.m4a", seconds: 30 }, dj("after")] }];
    const view = publicView(old, byId([letter({ id: "a" })]));
    expect(view.segments[0]!.lines.map((l) => l.type)).toEqual(["dj", "letter", "dj"]);
    expect(view.storedIndex).toEqual([0, 1, 3]);
  });

  it("drops a rejected found voice or reply with the fixed line that introduced it, and nothing else", () => {
    const letters = byId([letter({ id: "a" }), letter({ id: "f", status: "rejected" }), letter({ id: "r", status: "rejected" }), letter({ id: "b" })]);
    const view = publicView(segments, letters);
    expect(view.segments[0]!.lines).toEqual([fixed("お便りを読みます。"), read("a"), dj("after")]);
    expect(view.storedIndex).toEqual([0, 1, 6, 7, 8, 9]);
  });

  it("drops a plain letter's fixed hand-over with it, and drops a segment left with none of its letters", () => {
    const letters = byId([letter({ id: "a", status: "rejected" }), letter({ id: "f" }), letter({ id: "r" })]);
    const view = publicView(segments, letters);
    expect(view.segments).toHaveLength(1);
    expect(view.segments[0]!.lines[0]).toEqual(fixed("found intro"));
    expect(view.segments[0]!.lines.some((l) => l.type === "letter" && l.letterId === "a")).toBe(false);
    expect(view.storedIndex).toEqual([2, 3, 4, 5, 6]);
  });

  it("keeps an older episode's DJ talk, which carries no unit mark, around a hidden letter", () => {
    const old: Segment[] = [{ itemId: "i1", slot: "near", lines: [dj("before"), read("a"), read("b"), dj("after")] }];
    const view = publicView(old, byId([letter({ id: "a", status: "rejected" }), letter({ id: "b" })]));
    expect(view.segments[0]!.lines).toEqual([dj("before"), read("b"), dj("after")]);
  });

  describe("with units", () => {
    const unitLine = (text: string, letterId: string, part: "intro" | "after"): ScriptLine => ({ type: "dj", text, unit: { letterId, part } });
    const unitSegments: Segment[] = [
      {
        itemId: "i1",
        slot: "near",
        lines: [
          bridgeLine("bridge.open", "ja"),
          unitLine("intro a", "a", "intro"),
          fixed("a hand-over"),
          read("a"),
          unitLine("after a", "a", "after"),
          bridgeLine("bridge.sameWork", "ja"),
          fixed("b hand-over"),
          read("b"),
          unitLine("after b", "b", "after"),
          bridgeLine("bridge.close", "ja"),
        ],
      },
    ];
    const open = t("bridge.open");
    const close = t("bridge.close");
    const texts = (v: ReturnType<typeof publicView>) => v.segments.flatMap((s) => s.lines.map((l) => (l.type === "letter" ? `letter:${l.letterId}` : (l as { text: string }).text)));

    it("drops a hidden letter's intro, hand-over and after, and the bridge left pointing at nothing", () => {
      const view = publicView(unitSegments, byId([letter({ id: "a", status: "rejected" }), letter({ id: "b" })]));
      expect(texts(view)).toEqual([open, "b hand-over", "letter:b", "after b", close]);
      expect(view.storedIndex).toEqual([0, 6, 7, 8, 9]);
    });

    it("drops the second letter's hand-over and after, and keeps the first letter's unit", () => {
      const view = publicView(unitSegments, byId([letter({ id: "a" }), letter({ id: "b", status: "rejected" })]));
      expect(texts(view)).toEqual([open, "intro a", "a hand-over", "letter:a", "after a", close]);
    });
  });
});

describe("originalsOf", () => {
  it("gives each public letter in the listener's language, with the original only for a translation", () => {
    const letters = byId([letter({ id: "e", lang: "en", body: "Hi", bodyJa: "やあ" }), letter({ id: "j" }), letter({ id: "x", lang: "en", body: "No", status: "rejected" })]);
    expect(originalsOf(letters, "ja")).toEqual({ e: { main: "やあ", original: "Hi" }, j: { main: expect.any(String), original: null } });
    expect(originalsOf(letters, "en").e).toEqual({ main: "Hi", original: null });
  });
});

describe("publicView sameWork bridge", () => {
  const same = bridgeLine("bridge.sameWork", "ja");
  const open = bridgeLine("bridge.open", "ja");
  const seg: Segment[] = [{ itemId: "i1", slot: "near", lines: [open, read("a"), same, read("b"), fixed("tail")] }];
  const all = [letter({ id: "a" }), letter({ id: "b" })];

  it("is unchanged when nothing is hidden", () => {
    const view = publicView(seg, byId(all));
    expect(view.segments).toEqual(seg);
    expect(view.storedIndex).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops the bridge when the 2nd letter is hidden, skipping its stored index", () => {
    const view = publicView(seg, byId([all[0]!, letter({ id: "b", status: "rejected" })]));
    expect(view.segments[0]!.lines).toEqual([open, read("a"), fixed("tail")]);
    expect(view.storedIndex).toEqual([0, 1, 4]);
  });

  it("drops the bridge when the 1st letter is hidden and still reads the other", () => {
    const view = publicView(seg, byId([letter({ id: "a", status: "rejected" }), all[1]!]));
    expect(view.segments[0]!.lines).toEqual([open, read("b"), fixed("tail")]);
    expect(view.storedIndex).toEqual([0, 3, 4]);
  });

  it("keeps the second of two bridges when the middle letter is hidden", () => {
    const three: Segment[] = [{ itemId: "i1", slot: "near", lines: [open, read("a"), same, read("b"), same, read("c")] }];
    const view = publicView(three, byId([letter({ id: "a" }), letter({ id: "b", status: "rejected" }), letter({ id: "c" })]));
    expect(view.segments[0]!.lines).toEqual([open, read("a"), same, read("c")]);
    expect(view.storedIndex).toEqual([0, 1, 4, 5]);
  });

  it("a reply after the letters does not count as a letter the bridge points at", () => {
    const withReply: Segment[] = [{ itemId: "i1", slot: "near", lines: [open, read("a"), same, read("b"), read("r", "reply")] }];
    const view = publicView(withReply, byId([letter({ id: "a" }), letter({ id: "b", status: "rejected" }), letter({ id: "r" })]));
    expect(view.segments[0]!.lines.some((l) => l.type === "dj" && l.bridge === "bridge.sameWork")).toBe(false);
  });
});
