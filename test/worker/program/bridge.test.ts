import { describe, expect, it } from "vitest";
import { t } from "../../../src/worker/i18n/t";
import { BRIDGE_KEYS, bridgeBefore, bridgeLine } from "../../../src/worker/program/bridge";
import { TOPICAL } from "../../../src/worker/program/topical-words";

describe("bridgeBefore", () => {
  it("is open for the first segment whatever its slot", () => {
    expect(bridgeBefore(0, "far")).toBe("bridge.open");
    expect(bridgeBefore(0, "near")).toBe("bridge.open");
  });

  it.each(["near", "neighbor", "far"] as const)("follows the slot %s after the first", (slot) => {
    expect(bridgeBefore(2, slot)).toBe(`bridge.${slot}`);
  });
});

describe("bridgeLine", () => {
  it("is a fixed dj line made from the template", () => {
    expect(bridgeLine("bridge.sameWork", "ja")).toEqual({ type: "dj", text: "同じ作品に、別の方からもお便りが届いています。", fixed: true, bridge: "bridge.sameWork" });
    expect(bridgeLine("bridge.close", "en")).toEqual({ type: "dj", text: t("bridge.close", undefined, "en"), fixed: true, bridge: "bridge.close" });
  });

  it.each(BRIDGE_KEYS.flatMap((k) => (["ja", "en"] as const).map((l) => [k, l] as const)))("%s (%s) names no time", (key, lang) => {
    expect(t(key, undefined, lang).match(TOPICAL)).toBeNull();
    expect(t(key, undefined, lang)).not.toMatch(/tonight|today|this (morning|evening)|right now/i);
  });
});
