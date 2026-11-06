/** Pure parts of `pnpm rejudge`: argument parsing and the loop over `POST /admin/rejudge`. Ids and counts only, never letter text. */

export const REJUDGE_USAGE = "usage: pnpm rejudge [--origin <url>] [--token <ADMIN_TOKEN>]\n       origin defaults to $DOCOCA_ORIGIN, token to $ADMIN_TOKEN";

export type RejudgeArgs = { origin: string; token: string };
export type Rejection = { id: string; reason: string };
export type RejudgeTotal = { judged: number; rejected: Rejection[]; skipped: number };

export function parseRejudgeArgs(argv: string[], env: Record<string, string | undefined> = {}): RejudgeArgs {
  const value = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (!["--origin", "--token"].includes(a) || v === undefined || v.startsWith("--")) throw new Error(REJUDGE_USAGE);
    value.set(a, v);
    i++;
  }
  const token = value.get("--token") ?? env.ADMIN_TOKEN;
  if (!token) throw new Error("ADMIN_TOKEN is not set (use --token or the environment)");
  const origin = (value.get("--origin") ?? env.DOCOCA_ORIGIN ?? "http://127.0.0.1:5173").replace(/\/$/, "");
  return { origin, token };
}

/** Calls the endpoint page by page until `next` is null. A failed page stops the run with its status, never the token. */
export async function runRejudge(args: RejudgeArgs, fetchImpl: typeof fetch, log: (line: string) => void): Promise<RejudgeTotal> {
  const total: RejudgeTotal = { judged: 0, rejected: [], skipped: 0 };
  let after: string | undefined;
  for (let page = 1; ; page++) {
    let res: Response;
    try {
      res = await fetchImpl(`${args.origin}/admin/rejudge`, {
        method: "POST",
        headers: { authorization: `Bearer ${args.token}`, "content-type": "application/json" },
        body: JSON.stringify(after === undefined ? {} : { after }),
      });
    } catch {
      throw new Error(`cannot reach ${args.origin} (is pnpm dev or the deployment up?)`);
    }
    const out = (await res.json().catch(() => null)) as { judged: number; rejected: Rejection[]; skipped: number; next: string | null } | null;
    if (res.status !== 200 || !out) throw new Error(`rejudge failed on page ${page}: ${res.status}`);
    total.judged += out.judged;
    total.skipped += out.skipped;
    for (const r of out.rejected) {
      total.rejected.push(r);
      log(`rejected ${r.id} ${r.reason}`);
    }
    log(`page ${page}: judged ${out.judged}, rejected ${out.rejected.length}, skipped ${out.skipped}`);
    if (out.next === null) return total;
    after = out.next;
  }
}
