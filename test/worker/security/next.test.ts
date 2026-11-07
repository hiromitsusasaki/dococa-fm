import { describe, expect, it } from "vitest";
import { safeNext } from "../../../src/worker/security/next";

const ORIGIN = "https://dococa.example";

describe("safeNext", () => {
  it("keeps a same-site path with its query", () => {
    expect(safeNext("/put?x=1", ORIGIN)).toBe("/put?x=1");
    expect(safeNext("/", ORIGIN)).toBe("/");
  });

  it("gives the fallback (default /) for anything that is not a plain absolute path", () => {
    for (const raw of [undefined, "", "put", "//evil.example", "https://evil.example/x", "/\\evil.example", "/%09/evil.example", "/a\tb", `/${"a".repeat(200)}`]) {
      expect(safeNext(raw, ORIGIN), String(raw)).toBe("/");
    }
  });

  it("uses the fallback it is given", () => {
    expect(safeNext("//evil.example", ORIGIN, "/me")).toBe("/me");
    expect(safeNext(undefined, ORIGIN, "/me")).toBe("/me");
  });
});
