import { describe, expect, it } from "vitest";
import { t } from "../../../src/worker/i18n/t";
import { BRIDGE_KEYS, bridgeBefore, bridgeLine } from "../../../src/worker/program/bridge";
import { TOPICAL } from "../../../src/worker/program/topical-words";

describe("bridgeBefore", () => {
  it("is open for the first programme of a visit whatever its slot and station", () => {
    expect(bridgeBefore(true, "far", "mine")).toBe("bridge.open");
    expect(bridgeBefore(true, "near", "world")).toBe("bridge.open");
    expect(bridgeBefore(true, "near", "public")).toBe("bridge.open");
  });

  it.each(["near", "neighbor", "far"] as const)("follows the slot %s after the first, on mine and world", (slot) => {
    expect(bridgeBefore(false, slot, "mine")).toBe(`bridge.${slot}`);
    expect(bridgeBefore(false, slot, "world")).toBe(`bridge.${slot}`);
  });

  it.each(["near", "neighbor", "far"] as const)("is the neutral next on a public station whatever the slot (%s)", (slot) => {
    expect(bridgeBefore(false, slot, "public")).toBe("bridge.next");
  });

  it("opens and closes without promising what follows", () => {
    expect(t("bridge.open")).toBe("Dococa FM。世界のどこかにいる誰かの好きなものへのお便りを、お届けします。");
    expect(t("bridge.open", undefined, "en")).toBe("Dococa FM. Letters about the things someone, somewhere, loves.");
    expect(t("bridge.close")).toBe("ここで一息。");
    expect(t("bridge.close", undefined, "en")).toBe("A moment's pause.");
  });

  it("words the neutral next without saying whose favourite it is", () => {
    expect(t("bridge.next")).toBe("続いてのお便りです。");
    expect(t("bridge.next", undefined, "en")).toBe("The next letter.");
  });
});

describe("bridgeLine", () => {
  it("is a fixed dj line made from the template", () => {
    expect(bridgeLine("bridge.sameWork", "ja")).toEqual({ type: "dj", text: "同じ作品に、別の人からもお便りが届いています。", fixed: true, bridge: "bridge.sameWork" });
    expect(bridgeLine("bridge.close", "en")).toEqual({ type: "dj", text: t("bridge.close", undefined, "en"), fixed: true, bridge: "bridge.close" });
  });

  it.each(BRIDGE_KEYS.flatMap((k) => (["ja", "en"] as const).map((l) => [k, l] as const)))("%s (%s) names no time", (key, lang) => {
    expect(t(key, undefined, lang).match(TOPICAL)).toBeNull();
    expect(t(key, undefined, lang)).not.toMatch(/tonight|today|this (morning|evening)|right now/i);
  });
});
