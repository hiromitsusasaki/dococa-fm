import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createListener, getListener, updateListener } from "../../../src/worker/db/listeners";
import { ensureStationSlug, parseStationKey, slugSuffix, stationLabel } from "../../../src/worker/program/station";

import { resetDb } from "../../helpers/db";

beforeEach(() => resetDb(env.DB));

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

describe("slugSuffix", () => {
  it("draws the asked number of base36 characters", () => {
    expect(slugSuffix()).toMatch(/^[0-9a-z]{4}$/);
    expect(slugSuffix(6)).toMatch(/^[0-9a-z]{6}$/);
  });
});

describe("ensureStationSlug", () => {
  it("returns an existing slug untouched", async () => {
    const l = await createListener(env.DB);
    await updateListener(env.DB, l.id, { stationSlug: "my-radio" });
    expect(await ensureStationSlug(env.DB, (await getListener(env.DB, l.id))!, () => "zzzzzz")).toBe("my-radio");
    expect((await getListener(env.DB, l.id))?.stationSlug).toBe("my-radio");
  });

  it("assigns radio-<6 chars> and persists it", async () => {
    const l = await createListener(env.DB);
    const slug = await ensureStationSlug(env.DB, l);
    expect(slug).toMatch(/^radio-[0-9a-z]{6}$/);
    expect((await getListener(env.DB, l.id))?.stationSlug).toBe(slug);
  });

  it("draws again when the first suffix is taken", async () => {
    const other = await createListener(env.DB);
    await updateListener(env.DB, other.id, { stationSlug: "radio-aaaaaa" });
    const l = await createListener(env.DB);
    const draws = ["aaaaaa", "bbbbbb"];
    expect(await ensureStationSlug(env.DB, l, () => draws.shift()!)).toBe("radio-bbbbbb");
  });

  it("gives up after three collisions", async () => {
    const other = await createListener(env.DB);
    await updateListener(env.DB, other.id, { stationSlug: "radio-aaaaaa" });
    const l = await createListener(env.DB);
    let calls = 0;
    await expect(ensureStationSlug(env.DB, l, () => (calls++, "aaaaaa"))).rejects.toThrow();
    expect(calls).toBe(3);
  });
});
