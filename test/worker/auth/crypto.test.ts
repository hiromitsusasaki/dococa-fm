import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../../src/worker/auth/crypto";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and never stores the plaintext", async () => {
    const cipher = await encryptSecret("refresh-token-abc", "s1");
    expect(cipher).not.toContain("refresh-token-abc");
    expect(cipher).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(await decryptSecret(cipher, "s1")).toBe("refresh-token-abc");
  });

  it("uses a fresh iv each time", async () => {
    expect(await encryptSecret("x", "s1")).not.toBe(await encryptSecret("x", "s1"));
  });

  it("throws with the wrong secret", async () => {
    await expect(decryptSecret(await encryptSecret("x", "s1"), "s2")).rejects.toThrow();
  });

  it("throws on malformed input", async () => {
    await expect(decryptSecret("nodot", "s1")).rejects.toThrow();
  });
});
