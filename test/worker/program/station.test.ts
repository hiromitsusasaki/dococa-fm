import { describe, expect, it } from "vitest";
import { parseStationKey, stationLabel } from "../../../src/worker/program/station";

describe("parseStationKey", () => {
  it("accepts world, mine and s:<slug>", () => {
    expect(parseStationKey("world")).toEqual({ kind: "world" });
    expect(parseStationKey("mine")).toEqual({ kind: "mine" });
    expect(parseStationKey("s:hiro-fm")).toEqual({ kind: "public", slug: "hiro-fm" });
  });
  it("rejects anything else", () => {
    for (const bad of ["s:HIRO", "s:ab", "s:" + "a".repeat(25), "x", "", "s:", "world "]) expect(parseStationKey(bad)).toBeNull();
  });
});

describe("stationLabel", () => {
  it("names each station in the given language", () => {
    expect(stationLabel({ kind: "world" }, "", "en")).toBe("Dococa FM");
    expect(stationLabel({ kind: "mine" }, "", "en")).toBe("Your radio");
    expect(stationLabel({ kind: "public", ownerId: "o" }, "Hiro", "en")).toBe("Hiro's radio");
  });
});
