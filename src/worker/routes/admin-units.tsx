import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Variables } from "../auth/session";
import { hasClaude } from "../claude/client";
import { getItem } from "../db/items";
import { getLetter } from "../db/letters";
import { getUnits, listUnits, setUnitLiked, type UnitRow } from "../db/units";
import type { Env } from "../env";
import { prepareLetter } from "../program/prepare";
import { remakeUnit, unitCapReached } from "../program/unit";
import { invalid } from "./admin";

type AppEnv = { Bindings: Env; Variables: Variables };

/**
 * The owner's review of the DJ's units: 👍 marks an intro the DJ prompt shows as an example, 👎 makes the unit
 * again. Guarded by `adminAuth` through its `/admin/*` middleware in `admin.ts` (mounted before this app).
 * Owner-only and Japanese-only, so its labels live here rather than in the listener-facing i18n tables.
 */
export const adminUnits = new Hono<AppEnv>();

const L = {
  title: "単位の見直し",
  lead: "👍 した intro は、DJ の指示文に良い例として入ります（検証済みのものだけ。新しい順に 5 件）。👎 はその場で作り直し、新しい単位が検証を通って保存できたときだけ置き換えます（今日の単位の上限に数えます）。",
  work: "作品",
  letter: "お便り（冒頭）",
  verified: "検証",
  like: "👍",
  unlike: "👍 を外す",
  remake: "👎 作り直す",
  confirmRemake: "この単位を作り直しますか？",
  next: "次へ",
  empty: "単位はまだありません。",
  notFound: "見つかりません",
  busy: "いま別の処理がこの単位を作っています。少し待ってからもう一度押してください。",
  noClaude: "ANTHROPIC_API_KEY が無いので作り直せません。単位は消していません。",
  capped: "今日の単位の上限（UNIT_DAILY_LIMIT）に達しています。単位は消していません。",
  failed: "新しい単位を作れませんでした（Claude の失敗、検証に通らない、保存の失敗のどれか）。前の単位はそのままです。",
} as const;

const EXCERPT = 80;
const excerpt = (body: string) => {
  const cps = Array.from(body);
  return cps.length > EXCERPT ? `${cps.slice(0, EXCERPT).join("")}…` : body;
};

const lang = z.enum(["ja", "en"]);
const listSchema = z.object({
  lang: lang.default("ja"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().min(1).max(100).optional(),
});

async function readList(c: Context<AppEnv>) {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return { error: invalid(c, parsed.error) } as const;
  const rows = await listUnits(c.env.DB, parsed.data);
  return { query: parsed.data, rows, next: rows.length === parsed.data.limit ? rows[rows.length - 1]!.letterId : null } as const;
}

adminUnits.get("/admin/units.json", async (c) => {
  const list = await readList(c);
  if ("error" in list) return list.error;
  c.header("Cache-Control", "no-store");
  return c.json({ units: list.rows, next: list.next });
});

const STYLE = `body{font-family:system-ui,sans-serif;margin:16px;line-height:1.5}table{border-collapse:collapse;width:100%}
th{white-space:nowrap}td,th{border-bottom:1px solid #ccc;padding:8px;vertical-align:top;text-align:left}form{display:inline}button{margin:2px}
.liked{background:#fff7d6}.muted{color:#666}`;

function Row({ u }: { u: UnitRow }) {
  return (
    <tr class={u.liked ? "liked" : undefined}>
      <td>{u.title}</td>
      <td class="muted">{excerpt(u.letterBody)}</td>
      <td>{u.intro}</td>
      <td>{u.after}</td>
      <td>{u.verified ? "✓" : "✗"}</td>
      <td>
        {/* An unverified unit is never an example, so it gets no 👍. */}
        {u.verified ? (
          <form method="post" action={`/admin/units/${u.letterId}/${u.lang}/like`}>
            <input type="hidden" name="liked" value={u.liked ? "0" : "1"} />
            <button type="submit">{u.liked ? L.unlike : L.like}</button>
          </form>
        ) : null}
        <form method="post" action={`/admin/units/${u.letterId}/${u.lang}/remake`} onsubmit={`return confirm(${JSON.stringify(L.confirmRemake)})`}>
          <button type="submit">{L.remake}</button>
        </form>
      </td>
    </tr>
  );
}

adminUnits.get("/admin/units", async (c) => {
  const list = await readList(c);
  if ("error" in list) return list.error;
  const { query, rows, next } = list;
  c.header("Cache-Control", "no-store");
  return c.html(
    "<!doctype html>" +
      (
        <html lang="ja">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="robots" content="noindex" />
            <title>{L.title}</title>
            <style>{STYLE}</style>
          </head>
          <body>
            <main>
              <h1>{L.title}</h1>
              <p>{L.lead}</p>
              <p>
                <a href="/admin/units?lang=ja">ja</a> / <a href="/admin/units?lang=en">en</a>（{query.lang}）
              </p>
              {rows.length === 0 ? (
                <p>{L.empty}</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>{L.work}</th>
                      <th>{L.letter}</th>
                      <th>intro</th>
                      <th>after</th>
                      <th>{L.verified}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <Row u={u} />
                    ))}
                  </tbody>
                </table>
              )}
              {next ? (
                <p>
                  <a href={`/admin/units?lang=${query.lang}&limit=${query.limit}&after=${encodeURIComponent(next)}`}>{L.next}</a>
                </p>
              ) : null}
            </main>
          </body>
        </html>
      ).toString(),
  );
});

const back = (l: string) => `/admin/units?lang=${l}`;

adminUnits.post("/admin/units/:letterId/:lang/like", async (c) => {
  const l = lang.safeParse(c.req.param("lang"));
  const form = await c.req.parseBody();
  const liked = z.enum(["0", "1"]).safeParse(form.liked);
  if (!l.success) return invalid(c, l.error);
  if (!liked.success) return invalid(c, liked.error);
  const letterId = c.req.param("letterId");
  if (!(await getUnits(c.env.DB, [letterId], l.data)).has(letterId)) return c.text(L.notFound, 404);
  await setUnitLiked(c.env.DB, letterId, l.data, liked.data === "1");
  return c.redirect(back(l.data), 303);
});

/**
 * Makes the unit again before answering, audio included, so the owner sees the new one on reload. The old unit
 * stays until a new verified one is stored (`remakeUnit`): no key, today's cap, another run holding the unit's
 * claim, or a new unit that could not be made, verified or stored leave it as it was and answer with why.
 */
adminUnits.post("/admin/units/:letterId/:lang/remake", async (c) => {
  const l = lang.safeParse(c.req.param("lang"));
  if (!l.success) return invalid(c, l.error);
  const letterId = c.req.param("letterId");
  const db = c.env.DB;
  const letter = await getLetter(db, letterId);
  const item = letter ? await getItem(db, letter.itemId) : null;
  if (!letter || !item) return c.text(L.notFound, 404);
  if (!hasClaude(c.env)) return c.text(L.noClaude, 503);
  if (await unitCapReached(c.env, db)) return c.text(L.capped, 429);
  const remade = await remakeUnit(c.env, db, letter, item, l.data);
  if (remade === "busy") return c.text(L.busy, 409);
  if (remade === "capped") return c.text(L.capped, 429);
  if (remade === "failed") return c.text(L.failed, 503);
  await prepareLetter(c.env, db, letterId, l.data);
  return c.redirect(back(l.data), 303);
});
