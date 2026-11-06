import { describe, expect, it, vi } from "vitest";
import { parseRejudgeArgs, runRejudge } from "../../scripts/lib/rejudge";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("parseRejudgeArgs", () => {
  it("takes --origin and --token, falling back to the environment", () => {
    expect(parseRejudgeArgs(["--origin", "https://x.test/", "--token", "t"], {})).toEqual({ origin: "https://x.test", token: "t" });
    expect(parseRejudgeArgs([], { ADMIN_TOKEN: "env", DOCOCA_ORIGIN: "https://y.test" })).toEqual({ origin: "https://y.test", token: "env" });
    expect(parseRejudgeArgs([], { ADMIN_TOKEN: "env" }).origin).toBe("http://127.0.0.1:5173");
  });

  it("refuses a missing token and unknown flags", () => {
    expect(() => parseRejudgeArgs([], {})).toThrow("ADMIN_TOKEN");
    expect(() => parseRejudgeArgs(["--nope", "1"], { ADMIN_TOKEN: "t" })).toThrow("usage:");
  });
});

describe("runRejudge", () => {
  it("follows next until it is null, sending the cursor and the token, and totals the counts", async () => {
    const pages = [
      { judged: 20, rejected: [{ id: "a", reason: "negative" }], skipped: 0, next: "c1" },
      { judged: 20, rejected: [], skipped: 1, next: "c2" },
      { judged: 3, rejected: [{ id: "z", reason: "obscene" }], skipped: 0, next: null },
    ];
    const fetchMock = vi.fn(async () => reply(pages.shift()));
    const log = vi.fn();
    const total = await runRejudge({ origin: "https://x.test", token: "tok" }, fetchMock as unknown as typeof fetch, log);
    expect(total).toEqual({ judged: 43, rejected: [{ id: "a", reason: "negative" }, { id: "z", reason: "obscene" }], skipped: 1 });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u]) => u)).toEqual(Array(3).fill("https://x.test/admin/rejudge"));
    expect(calls.map(([, i]) => JSON.parse(String(i.body)))).toEqual([{}, { after: "c1" }, { after: "c2" }]);
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe("Bearer tok");
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("a negative");
    expect(printed).not.toContain("tok");
  });

  it("stops with a message on a non-200 answer, without the token", async () => {
    const fetchMock = vi.fn(async () => reply({ error: "unauthorized" }, 401));
    await expect(runRejudge({ origin: "https://x.test", token: "secret" }, fetchMock as unknown as typeof fetch, () => {})).rejects.toThrow(/401/);
    await expect(runRejudge({ origin: "https://x.test", token: "secret" }, fetchMock as unknown as typeof fetch, () => {})).rejects.not.toThrow(/secret/);
  });
});
