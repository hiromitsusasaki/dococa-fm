import { describe, expect, it } from "vitest";
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
  it("keeps everything while every letter is public, with stored indices in order", () => {
    const letters = byId(["a", "f", "r", "b"].map((id) => letter({ id })));
    const view = publicView(segments, letters);
    expect(view.segments).toEqual(segments);
    expect(view.storedIndex).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("drops a rejected found voice or reply with the fixed line that introduced it, and nothing else", () => {
    const letters = byId([letter({ id: "a" }), letter({ id: "f", status: "rejected" }), letter({ id: "r", status: "rejected" }), letter({ id: "b" })]);
    const view = publicView(segments, letters);
    expect(view.segments[0]!.lines).toEqual([fixed("お便りを読みます。"), read("a"), dj("after")]);
    expect(view.storedIndex).toEqual([0, 1, 6, 7, 8, 9]);
  });

  it("keeps the readings-only line when a plain letter goes, and drops a segment left with none of its letters", () => {
    const letters = byId([letter({ id: "a", status: "rejected" }), letter({ id: "f" }), letter({ id: "r" })]);
    const view = publicView(segments, letters);
    expect(view.segments).toHaveLength(1);
    expect(view.segments[0]!.lines[0]).toEqual(fixed("お便りを読みます。"));
    expect(view.segments[0]!.lines.some((l) => l.type === "letter" && l.letterId === "a")).toBe(false);
    expect(view.storedIndex).toEqual([0, 2, 3, 4, 5, 6]);
  });
});

describe("originalsOf", () => {
  it("lists public letters not written in Japanese only", () => {
    const letters = byId([letter({ id: "e", lang: "en", body: "Hi" }), letter({ id: "j" }), letter({ id: "x", lang: "en", body: "No", status: "rejected" })]);
    expect(originalsOf(letters)).toEqual({ e: { body: "Hi", lang: "en" } });
  });
});
