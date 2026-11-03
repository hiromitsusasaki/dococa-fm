import { describe, expect, it } from "vitest";
import { containsTopical } from "../../../src/worker/program/topical-words";

describe("containsTopical", () => {
  it.each(["今年", "2024年", "クリスマス"])("flags %s", (w) => {
    expect(containsTopical(`それは${w}のことでした`)).toBe(true);
  });
  it.each(["この曲を初めて聴いたのはどこでしたか？", "誰かと一緒でしたか？"])("lets %s through", (q) => {
    expect(containsTopical(q)).toBe(false);
  });
});
