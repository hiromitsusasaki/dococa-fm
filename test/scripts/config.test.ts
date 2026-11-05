import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("committed config", () => {
  it("ships the production PUBLIC_ORIGIN over https, never a dev or loopback origin", () => {
    const m = /"PUBLIC_ORIGIN":\s*"([^"]*)"/.exec(read("wrangler.jsonc"));
    expect(m?.[1]).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(m?.[1]).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("fixes every Env key in the test bindings, so .dev.vars cannot change test paths", () => {
    const env = read("src/worker/env.ts");
    const keys = [...env.matchAll(/^\s+([A-Z][A-Z0-9_]+)\??:\s*string;/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(10);
    const config = read("vitest.config.ts");
    for (const key of keys) expect(config, key).toMatch(new RegExp(`\\b${key}:`));
  });

  it("lists every Env key in .dev.vars.example", () => {
    const env = read("src/worker/env.ts");
    const keys = [...env.matchAll(/^\s+([A-Z][A-Z0-9_]+)\??:\s*string;/gm)].map((m) => m[1]!);
    const example = read(".dev.vars.example");
    for (const key of keys) expect(example, key).toMatch(new RegExp(`^${key}=`, "m"));
  });
});
