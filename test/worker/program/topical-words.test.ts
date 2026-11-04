import { describe, expect, it } from "vitest";
import { containsTopical } from "../../../src/worker/program/topical-words";

describe("containsTopical", () => {
  it.each(["今年", "2024年", "クリスマス", "去年", "来週", "先月", "年末", "ゴールデンウィーク", "お盆", "バレンタイン", "話題の", "この夏", "今シーズン"])("flags %s", (w) => {
    expect(containsTopical(`それは${w}のことでした`)).toBe(true);
  });
  it.each([
    "昨夜", "昨晩", "昨日", "先日", "今朝", "今夜", "先週", "先月", "去年", "今年",
    "公開中", "上映中", "発売中", "配信中", "放送中", "配信開始", "発売開始", "新作", "最新作", "話題の", "流行", "ニュース",
  ])("flags the time-relative word %s, also in NFKC form", (w) => {
    expect(containsTopical(`それは${w}のことでした`)).toBe(true);
    expect(containsTopical(`それは${w}のことでした`.normalize("NFKC"))).toBe(true);
  });
  it.each(["この曲を初めて聴いたのはどこでしたか？", "誰かと一緒でしたか？"])("lets %s through", (q) => {
    expect(containsTopical(q)).toBe(false);
  });
});
