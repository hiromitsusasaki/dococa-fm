# Dococa FM Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The radio answers the dial in real time (one segment per request, picked by how far a work is from the listener's taste), the screens around it (home, send, my page, settings) are laid out as designed and worded like radio, letters that bash or offend are kept out, and the DJ's introductions improve through a semi-automatic review loop.

**Architecture:** `POST /stations/:key/next` makes a one-segment episode from the dial value the client sends; selection ranks candidate works by cosine distance between a Workers AI embedding (`@cf/baai/bge-m3`) of the work and the mean embedding of the listener's favourites, and picks from the band the dial points at. Everything downstream (units, fixed lines, audio cache, `listens`, resume) is unchanged. MCP is removed. Moderation gains two reasons and an admin re-judge. Units gain a 👍 flag that feeds examples into the DJ prompt, an admin page to mark them, and a grading script.

**Tech Stack:** Cloudflare Workers (Hono 4, D1, R2, Workers AI, Cron), hono/jsx/dom client, vitest with `@cloudflare/vitest-plugin`, Anthropic SDK (tool use), Gemini-TTS.

**Spec:** `docs/superpowers/specs/2026-11-03-dococa-fm-design.md`, addendum L (binding for this plan; K for what it builds on). Visual/wording rules: `docs/DESIGN.md`. Code map used to write this plan: `.superpowers/sdd/phase4-map.md` (read it for file:line pointers; it is a survey, not a requirement).

## Global Constraints

- Commit prefix `feat:` `fix:` `docs:` `test:` `refactor:` `chore:` + short English summary; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never `git push`. Never amend or rewrite a commit on main; `git add <paths>` only.
- Secrets only in `.dev.vars` / Cloudflare secrets. New env keys in this plan: none. New binding: `AI` (Workers AI). Every `Env` key stays listed in `vitest.config.ts`.
- "AI がしないこと": letters verbatim; no sourceless found voices; no 時事; no counts/rankings (the embedding distance is used to choose and never appears in a response, a screen, a log or a DJ line); the DJ never invites playback. Every episode still goes through `verifyEpisode` before it is stored.
- No Japanese literals in JSX; every string in `src/worker/i18n/ja.ts` and `en.ts` with the same keys (`test/worker/i18n.test.ts`). Words banned by DESIGN.md §6 stay banned; 「土地」 joins the banned list for screens.
- Every write `POST` route is in `isRateLimited()` or has its own limiter with an exception in the route-table test (`test/worker/security.test.ts`). `GET /search` gets its own limiter.
- D1: at most 100 bound parameters per statement; `query-budget.test.ts` limits stay (raise only with a note in the report).
- Logs never carry letter text, dj lines, search queries or vectors.
- `pnpm test`, `pnpm typecheck`, `pnpm build` green at every commit. Each task's last commit updates the Phase 4 table in `docs/status.md`.
- Do not edit `docs/superpowers/**` from an implementer; report the need instead.
- Client bundle: `station.js` stays under 6 kB gzip; put the figure in the report.

## Review Focus

1. The dial the client sends is clamped to 0–1 and the `letterId` it may send is honoured only when that letter is public, readable (`letter`/`found` with a source) and not the listener's own; anything else falls back to the normal pick. (Task 3)
2. One-segment episodes must not say the opening twice or lose the hand-over: `bridge.open` only when the client says `first`; a resumed stored episode plays as stored; the `/me` replay link and `/listens` keep working on one-segment episodes. (Task 3)
3. With no `AI` binding, no vector for a candidate, or a listener with no favourites and no listens, selection degrades to today's random pick without an error, and no vector or distance reaches `playerView`, any JSON, or a log. (Task 4)
4. `GET /search` is signed-in only, rate-limited, never logs the query, and a provider failure yields an empty list, never a 500; anonymous visitors see the sign-in prompt instead of the search box. (Task 6)
5. Re-judging never touches 私も, never republishes a rejected letter, and a Claude failure leaves the letter as it is (reported as skipped, not rejected). (Task 8)

---

### Task 1: お住まい (place wording on screens and in the hand-over)

**Files:**
- Modify: `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `src/worker/program/compose.ts` (`who` for spoken lines), `src/worker/program/verify.ts` (the `{who}` capture of a fixed line is re-split through `script.whoPlace` so our own wording is never a quote), `docs/DESIGN.md` (§6 word table and the blockquote row), `migrations/0016_revoice_handover.sql`, `docs/status.md`
- Test: `test/worker/program/compose.test.ts`, `test/worker/program/verify.test.ts`, `test/worker/routes/settings.test.ts`, `test/worker/i18n.test.ts`

**Interfaces:**
- Produces: i18n key `script.whoPlace` (ja 「{place}にお住まいの、{who}」, en "{who}, who lives in {place}"); `settings.place` ja 「お住まい」 en "Where you live"; `settings.placeHelp` ja 「お便りに添える、お住まいの地域。都道府県や国まで。」 en "The area that goes with your letters: a prefecture, a state or a country."; `put.fromHelp` ja 「設定のラジオネームとお住まいで届きます。」 en "It goes out under the radio name and the place in your settings."
- Spoken lines use `script.whoPlace`; screens keep `letter.whoPlace` 「{who}（{place}）」.

- [ ] **Step 1: Failing tests.** In `compose.test.ts`: `handOver` of a letter with radioName みなと and place 東京 (ja) has text 「東京にお住まいの、みなとさんからのお便りです。」; en reads "A letter from みなと, who lives in Tokyo, Japan." (place label from codes; radio names are not translated); a letter with no place keeps 「みなとさんからのお便りです。」; `reaction` lines use the same phrase. In `settings.test.ts`: the settings page contains お住まい and not 土地. In `verify.test.ts`: a fixed hand-over with the new phrasing passes (filled values only are quote-checked).
- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.** `who(l, lang)` in `compose.ts`: when the place is non-empty return `t("script.whoPlace", { who: name, place }, lang)`. Change the i18n strings above (both languages; en `script.letterFrom` stays "A letter from {who}."). DESIGN.md: 「土地」→「お住まい」 in the blockquote row and the word table; add 「土地」 to the banned words line. Migration `0016_revoice_handover.sql`: `UPDATE units SET audio_ready = 0;` with a comment (the hand-over clip of every letter changes text; existing clips stay cache hits).
- [ ] **Step 4: Run tests; expected PASS.**
- [ ] **Step 5: Commit** `feat: place is said as osumai` (i18n + compose + tests), then `docs: osumai wording and revoice migration` (DESIGN.md, migration, status table).

---

### Task 2: MCP removed

**Files:**
- Delete: `src/worker/mcp/server.ts`, `src/worker/mcp/markdown.ts`, `src/worker/routes/mcp.ts`, `test/worker/routes/mcp.test.ts`, `test/worker/mcp/markdown.test.ts`
- Modify: `src/worker/index.ts`, `src/worker/routes/settings.tsx` (MCP section, `mcpUrlOf`, `POST /settings/mcp-token`), `src/worker/security/rate-limit.ts` (mcp stores/functions), `src/worker/security/origin.ts` (`/mcp` exemption), `src/worker/security/body-limit.ts` (comment), `src/worker/auth/session.ts` (`/mcp` exemption), `src/worker/db/listeners.ts` (drop `getListenerByMcpToken`, `isWellFormedMcpToken`; keep `newMcpToken` because the column is NOT NULL UNIQUE), `src/worker/i18n/{ja,en}.ts` (`mcp.*`, `settings.mcp*`; keep `settings.listenerId` and show it in a small "about this listener" line at the end of settings), `public/app.css` (`.settings-mcp`), `package.json` (drop `@hono/mcp`, `@modelcontextprotocol/sdk`; run `pnpm install` so the lockfile follows), `wrangler.jsonc` (comment), `README.md`, `SECURITY.md`, `docs/eval/README.md`, `docs/status.md`
- Test: `test/worker/security.test.ts` (route list, mcp cases, route count), `test/worker/auth/session.test.ts`, `test/worker/routes/settings.test.ts`, `test/worker/db/listeners.test.ts`

**Interfaces:**
- Consumes nothing new. Produces: no `/mcp` route (404 through the normal not-found), no `/settings/mcp-token`.

- [ ] **Step 1: Adjust tests first.** Remove the MCP tests; in `security.test.ts` drop `/settings/mcp-token` from the write-route list and the MCP limiter cases; in `session.test.ts` the `/mcp/abc` case now expects the session middleware to run (a cookie is set); `settings.test.ts` asserts no `/mcp/` string on the page and that the listener id line is still there.
- [ ] **Step 2: Run; expected FAIL** (routes still exist).
- [ ] **Step 3: Delete and unwire** as listed. Keep `listeners.mcp_token` and `newMcpToken` (comment: column kept, unused).
- [ ] **Step 4: `pnpm install`, run tests, typecheck, build; expected PASS.** `pnpm build` output must not contain `modelcontextprotocol`.
- [ ] **Step 5: Docs.** README: delete the "MCP で聴く" section and the two mentions; SECURITY.md: the `/mcp` paragraph and the route list entry; `docs/eval/README.md` step 3 points at the settings page's listener id line; status.md: Phase 4 table + 決定 line 「MCP は Phase 4 で外した（事前生成で役目を終えた）。列 `mcp_token` は残して使わない」.
- [ ] **Step 6: Commit** `refactor: remove mcp` then `docs: mcp removed`.

---

### Task 3: The dial on the radio face, one segment per request

**Files:**
- Modify: `src/worker/routes/stations.tsx` (`POST /stations/:key/next` body; `data-dial` default; `?letter=` on the page), `src/worker/routes/episodes.tsx` (`POST /episodes`, `/episodes/:id/next` pass `first`), `src/worker/program/create.ts` (`makeEpisode` opts `dial`, `first`, `letterId`, `size: 1`; limits ×6), `src/worker/program/build.ts`, `src/worker/program/select.ts` (`dial` override, `letterId` first pick), `src/worker/program/compose.ts` (`first` → `bridge.open`; no `bridge.close`), `src/worker/program/bridge.ts` (`bridgeBefore(first, slot, station)`), `src/worker/routes/settings.tsx` (drop the dial slider and `POST /settings/dial`), `src/worker/db/listeners.ts` (`updateListener` dial), `src/client/playback.ts` (`fetchNext(url, body)`), `src/client/station.tsx` (dial state in `localStorage`, `first`, prefetch invalidation, `letter` start), `src/worker/i18n/{ja,en}.ts` (`settings.dial*` removed; `station.dialHelp` added), `README.md`, `SECURITY.md`, `docs/status.md`
- Test: `test/worker/routes/stations.test.ts`, `test/worker/routes/episodes.test.ts`, `test/worker/program/{create,select,compose,bridge}.test.ts`, `test/worker/routes/settings.test.ts`, `test/worker/security.test.ts`, `test/client/station.test.ts`

**Interfaces:**
- Produces: request body of `POST /stations/:key/next` and `POST /episodes`: `{ dial?: number, first?: boolean, letterId?: string }` (zod: `dial` number 0–1 optional, `first` boolean optional, `letterId` string 1–100 optional; a missing or invalid body = `{}`).
- `makeEpisode(env, listener, opts: { station?: StationKey; dial?: number; first?: boolean; letterId?: string })` → `{ ok: true, episode } | { ok: false, reason }` as today; always `size: 1`.
- `selectProgram(db, listener, { size, seed, station, dial, letterId })`: `dial` overrides `listener.dial`; `letterId` (public, readable, not the listener's own) puts that letter's item in the first (only) seat with the slot the pools say (`near` if nothing matches).
- `bridgeBefore(first: boolean, slot, station)`: `first` → `bridge.open`; else as today. `composeEpisode(..., { first })`: no `bridge.close` any more (the i18n key stays for stored episodes).
- Limits: `EPISODE_DAILY_LIMIT` default 10 → 60, `EPISODE_GLOBAL_DAILY_LIMIT` 300 → 1800 (segments per day now); README/SECURITY wording "枠".
- Client: `localStorage["dfm.dial"]` (string 0–1; default `data-dial` if present else "0.3"); the knob writes it; a change empties the prefetch queue and refetches; `first` is true for the first `next` of a mount and false after any episode has played or resumed; when signed in, the server writes `listeners.dial` from each request (one `UPDATE` only when the value differs).
- `GET /stations/mine?letter=<id>` → `data-letter` → the first `next` request carries `letterId`.

- [ ] **Step 1: Failing tests.** stations: `POST /stations/mine/next` with `{dial: 1, first: true}` returns one segment whose first line is `bridge.open`; with `{first: false}` the first line is the slot bridge and there is no `bridge.close` anywhere; `{dial: 2}` → 400 `bad request`; a `letterId` of another listener's public letter → that letter is read in the segment; the listener's own letter id → normal pick; `listeners.dial` updated when signed in; anonymous → not updated. episodes: `POST /episodes` with `{first:true}` opens. create: `EPISODE_DAILY_LIMIT` unset → the 61st `next` of a day is `limit`. settings: no `dial` input and `POST /settings/dial` is 404; security route list updated. client (`station.test.ts`): turning the knob stores `dfm.dial`, drops the queued episode and refetches with the new `dial`; the first fetch sends `first: true`, the second `false`; `data-letter` goes out once.
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Implement** per Interfaces. In `compose.ts` delete the `bridge.close` push. `bridge.ts`: `bridgeBefore(first, slot, station)`. `select.ts`: with `size === 1` the quotas collapse to one seat: `dial ≥ 2/3` → far pool first, `≥ 1/3` → neighbor, else near, falling back in the order far → near → neighbor (Task 4 replaces this with the distance band). The `letterId` seat: look the letter up (`getLetter`), check `status = 'public'`, `kind in ('letter','found')`, sourced if found, `listenerId !== listener.id`, and that the item has letters; else ignore.
- [ ] **Step 4: Run tests; expected PASS.** Check `station.js` gzip in `pnpm build`.
- [ ] **Step 5: Commit** `feat: one segment per request with the dial from the client` (server), `feat: dial knob kept in the browser` (client + settings), `docs: segments per day and the dial` (README, SECURITY.md, status; 決定 lines: 「回は 1 枠」「終わりのつなぎは言わない」「上限は枠の数」).

---

### Task 4: 遠さ (embeddings and the distance band)

**Files:**
- Create: `src/worker/ai/embed.ts`, `src/worker/program/taste.ts`, `migrations/0017_items_vec.sql`
- Modify: `wrangler.jsonc` (`"ai": { "binding": "AI" }`), `src/worker/env.ts` (`AI?: Ai`), `vitest.config.ts` (no change needed if `AI` is optional; document), `src/worker/db/items.ts` (`vec` column read/write, `listItemsWithoutVec`), `src/worker/resolve/index.ts` (`resolveOrCreate*` return value unchanged; callers queue embedding), `src/worker/program/prepare.ts` (first stage: `ensureItemVectors(env, db, budget)`), `src/worker/program/select.ts` (band pick), `src/worker/program/select-sql.ts` (`HEARD_RECENTLY_SQL`, `RECENT_EPISODE_ITEMS_SQL`), `src/worker/letters/create.ts` / `src/worker/routes/start.tsx` / `src/worker/auth/spotify.ts` / `src/worker/routes/admin.ts` (after creating items: `defer(embedItems(env, db, ids))`), `README.md`, `SECURITY.md`, `docs/status.md`
- Test: `test/worker/ai/embed.test.ts`, `test/worker/program/taste.test.ts`, `test/worker/program/select.test.ts`, `test/worker/program/prepare.test.ts`, `test/worker/db/items.test.ts`, `test/worker/routes/stations.test.ts`

**Interfaces:**
- `embed(env: Pick<Env, "AI">, texts: string[]): Promise<Float32Array[] | null>` — `env.AI.run("@cf/baai/bge-m3", { text: texts })` → `{ data: number[][] }`; each vector L2-normalised; `null` when `env.AI` is undefined or the call throws (log `[dococa] embed failed` + `e.name` only).
- `items.vec BLOB` = Int8 quantised unit vector (`Math.round(x * 127)`, 1024 bytes). `db/items.ts`: `setItemVec(db, id, vec: Float32Array)`, `getItemVecs(db, ids): Map<string, Float32Array>` (dequantised), `listItemsWithoutVec(db, limit): string[]`, `countItemsWithoutVec(db)`.
- `embedItems(env, db, ids: string[]): Promise<number>` — text per item `${title} — ${creator}${year ? ` (${year})` : ""} [${kind}]`; batches of 20; returns the number stored.
- `ensureItemVectors(env, db, budget): Promise<{ made: number; remaining: number }>` — called first in `prepareBatch` and consumes budget like the other stages (1 per 20 items); `remaining.vectors` added to `Remaining`.
- `tasteOf(db, listener): Promise<Float32Array | null>` — mean of the vectors of up to 50 favourites (`listFavorites`), else of up to 20 items heard (`listens`), normalised; `null` when nothing has a vector.
- `farness(taste, cands: Map<id, vec>): Map<id, number>` — cosine distance ranked, percentile `rank / (n − 1)` (n = 1 → 0).
- `pickByDial(ids, far: Map, dial, rng): { id; slot }` — candidates with `|p − dial| ≤ 0.2`, widening by 0.1 until non-empty; uniform random; slot `near` (p < 1/3) / `neighbor` (< 2/3) / `far`.
- `selectProgram` (mine, size 1): candidates = near ∪ neighbor ∪ far pool ids minus items heard in the last 7 days (`HEARD_RECENTLY_SQL`) minus items of the listener's last 30 episodes on this station (`RECENT_EPISODE_ITEMS_SQL`; lift the two exclusions in that order when nothing is left); `taste === null` or no vectors → today's pool-first pick; else `pickByDial`. `letterId` (Task 3) still wins the seat. World and public stations unchanged.

- [ ] **Step 1: Failing tests.** `embed.test.ts`: a fake `AI` (`{ run: async (model, input) => ({ data: [[...]] }) }`) yields normalised vectors; no `AI` → `null`; a throw → `null` and a log without the text. `taste.test.ts`: `farness` ranks and `pickByDial` picks inside the band and widens; `tasteOf` uses favourites, then listens, then `null`. `select.test.ts`: with vectors seeded so one item is close and one far, dial 0 picks the close one and dial 1 the far one (seeded rng); an item heard yesterday is skipped unless it is the only one; no vectors → old behaviour. `prepare.test.ts`: the batch embeds items without a vector first and reports `remaining.vectors`. `stations.test.ts`: the JSON of `next` has no `vec`, `farness` or `distance` key anywhere (deep check).
- [ ] **Step 2: Run; expected FAIL.**
- [ ] **Step 3: Implement.** Migration `0017_items_vec.sql`: `ALTER TABLE items ADD COLUMN vec BLOB;`. The AI binding in `wrangler.jsonc`; `Env.AI?: Ai` (type from `@cloudflare/workers-types`). Queue `embedItems` with `defer` wherever items are created (the four call sites). Cache dequantised vectors per isolate in a `Map` capped at 2,000 entries.
- [ ] **Step 4: Run tests; expected PASS.** `query-budget.test.ts`: `next` may add 3 statements (taste favourites, candidate vecs, exclusions); raise its bound with a note if needed.
- [ ] **Step 5: Docs.** README (Workers AI binding; 遠さ in one paragraph; `/admin/prepare` now reports `vectors`), SECURITY.md (vectors are derived from public work metadata only; never from letters), status.md (本人作業: Workers AI is enabled per account on Workers Paid; migrations 0016–0017; run `/admin/prepare` once to backfill vectors; 決定: distance never shown).
- [ ] **Step 6: Commit** `feat: work embeddings with workers ai`, `feat: pick the next work by the dial's distance band`, `docs: farness`.

---

### Task 5: Home shows the letters arriving now

**Files:**
- Modify: `src/worker/routes/home.tsx`, `src/worker/db/letters.ts` (`listRecentPublicLetters(db, limit)`), `src/views/components.tsx` (`LetterCard`), `public/app.css` (`.letter-cards`, `.letter-card`), `src/worker/i18n/{ja,en}.ts` (`home.recent` → ja 「いま届いているお便り」 en "Letters arriving now"; `home.playFrom` ja 「このお便りから聴く」 en "Listen from this letter"), `docs/DESIGN.md` (home section), `docs/status.md`
- Test: `test/worker/routes/home.test.ts`, `test/worker/db/letters.test.ts`

**Interfaces:**
- `listRecentPublicLetters(db, limit = 6): Promise<Array<Letter & { item: Item }>>` — `status='public'`, `kind IN ('letter','found')` (found only with source), ORDER `letters.created_at DESC`, one query with a JOIN on items.
- `LetterCard({ letter, item, lang })`: `<a class="letter-card" href="/stations/mine?letter=<id>">` with the item image (`img` 96×96, `loading="lazy"`, or an empty `.letter-card-art` box), the display text cut at 120 code points with 「…」 (`displayText(letter, lang).main`), and a muted line `title · who · place` (`whoOf`).

- [ ] **Step 1: Failing tests.** home: the page lists the newest 6 public letters (not 私も/一言, not rejected), each linking to `/stations/mine?letter=<id>`, body cut at 120 code points, the image when the item has one; the heading is 「いま届いているお便り」; `letters.test.ts` for the query (order, kinds, status).
- [ ] **Step 2: Run; expected FAIL.** **Step 3: Implement.** Replace the recent-items block; delete `listRecentItems` if nothing else uses it. CSS per DESIGN.md tokens (panel, `--haze` art box, 12px radius, two columns above 760px). **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat: home shows the letters arriving now` and `docs: home letters` (DESIGN.md home row, status).

---

### Task 6: The send page (layout, choose from favourites, search, bookmarklet)

**Files:**
- Modify: `src/worker/routes/put.tsx` (layout, sections, `?q=` search results), `src/worker/routes/api.ts` (delete `/api/search`; keep `/api/resolve` only if a test or page uses it, else delete), `src/worker/resolve/index.ts` (`searchByText` gains YouTube when `YOUTUBE_API_KEY` is set), `src/worker/resolve/youtube.ts` (new `searchYouTube(q, key)`: `search.list` `part=snippet&type=video&maxResults=5&q=`; draft kind `music`, image `thumbnails.high.url`, external id `youtube:<videoId>`, out link `https://www.youtube.com/watch?v=<id>`), `src/worker/routes/letters.tsx` (`/bookmarklet` page copy; the button is a draggable `a.button` already — add the 3-line help and a "add to bookmarks" heading), `src/worker/security/rate-limit.ts` (`searchRateLimit` 20/min per listener), `src/worker/index.ts`, `src/worker/i18n/{ja,en}.ts`, `public/app.css`, `docs/DESIGN.md`, `README.md`, `SECURITY.md`, `docs/status.md`
- Test: `test/worker/routes/letters.test.ts` (GET /put), `test/worker/routes/put-history.test.ts`, `test/worker/routes/search.test.ts` (new), `test/worker/resolve/youtube.test.ts` (new), `test/worker/security.test.ts`

**Interfaces:**
- Page sections, in order, each a `.panel`: (1) 「作品を決める」 with three ways: `URL を貼る` (form `GET /put` `url`), 「好きなものから選ぶ」 (favourites + imported, with a client-free `<input type=search>` that is a `GET /put?pick=<text>` filter over titles, server-side), 「題名で探す」 (signed in: form `GET /put?q=`; anonymous: `signin.needed` + Google link). (2) 「お便りを書く」 — the letter form as today, shown once an item/draft is chosen. (3) 「ブックマークレット」 — the draggable button (`a.button` with the javascript: href, `draggable`), heading `bookmarklet.addTitle` ja 「ブックマークに追加」 en "Add to your bookmarks", and `bookmarklet.help` as three short lines (ja: 「上のボタンをブックマークバーへドラッグします。」「好きな作品のページで、そのブックマークを押します。」「この画面が、その作品を選んだ状態で開きます。」; en the same three).
- `GET /put?q=`: `requireSignin` only for the search part (anonymous gets the prompt, 200); `searchRateLimit` (20/min per listener, 429 → `search.tooMany`); results `searchByText(q, "any", env)` up to 10 drafts rendered as `ItemCard` + link `/put?url=<outLink>` (or `?itemId=` for stored); an empty result shows `search.none`. The query is never logged. Spotify connect link leaves `/put` (settings keeps it).
- i18n new keys: `put.choose`, `put.pasteUrl`, `put.fromFavorites`, `put.filterFavorites`, `put.searchTitle`, `put.searchPlaceholder`, `put.searchNeedsSignin`, `search.none`, `search.tooMany`, `bookmarklet.addTitle`, `bookmarklet.help1..3` (ja/en as above; wording per DESIGN.md).

- [ ] **Step 1: Failing tests.** `search.test.ts`: anonymous `GET /put?q=x` → 200 with `put.searchNeedsSignin` and no provider call; signed in → provider stubs called, results rendered, YouTube included only when `YOUTUBE_API_KEY` is non-empty; a provider that throws → the others still render; 21st search in a minute → 429. `youtube.test.ts`: request URL carries `part=snippet`, `type=video`, the key; drafts shaped as above; empty key → `[]`. `letters.test.ts`: `/put` has the three panels in order, no Spotify link; `/bookmarklet` has the three help lines. `security.test.ts`: `/api/search` gone.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS.**
- [ ] **Step 5: Commit** `feat: search works by title on the send page`, `feat: send page laid out in panels`, `docs: send page`.

---

### Task 7: My page laid out

**Files:**
- Modify: `src/worker/routes/me.tsx`, `src/views/components.tsx` (`ItemCard` art size variant), `public/app.css`, `docs/DESIGN.md`, `docs/status.md`
- Test: `test/worker/routes/me.test.ts`

**Interfaces:** Sections become `.panel`s with the same data: favourites as a card grid (image 96×96, title, creator, link to `/put?itemId=`), heard letters as a list (as today), reactions, public radio (link or the settings hint). The in-page sign-out form is removed (header keeps it). Empty states keep their copy.

- [ ] **Step 1: Failing tests.** `me.test.ts`: four `.panel` sections in order; no `POST /auth/signout` form on the page; favourites render `img` when the item has one. **Step 2: FAIL. Step 3: Implement. Step 4: PASS.**
- [ ] **Step 5: Commit** `feat: my page in panels` and `docs: my page`.

---

### Task 8: Moderation reasons and re-judge

**Files:**
- Modify: `src/worker/claude/moderate.ts` (reasons `obscene`, `negative`; prompt), `src/worker/i18n/{ja,en}.ts` (`letters.reason.obscene` ja 「公序良俗に反する内容は載せられません。」 en "We cannot carry content that offends public decency."; `letters.reason.negative` ja 「このラジオは好きなものについてのお便りを読みます。作品や作り手をけなすお便りは載せられません。」 en "This radio reads letters about things people love. A letter that runs down a work or its maker cannot go out."), `src/worker/routes/admin.ts` (`POST /admin/rejudge`), `scripts/rejudge.ts` + `package.json` script `rejudge`, `README.md`, `SECURITY.md`, `docs/status.md`
- Test: `test/worker/claude/moderate.test.ts`, `test/worker/routes/letters.test.ts`, `test/worker/routes/admin.test.ts`, `test/scripts/rejudge.test.ts`

**Interfaces:**
- `Reason = "abuse" | "ad" | "pii" | "offtopic" | "obscene" | "negative"`; prompt lines: `- obscene: 露骨な性的表現、違法行為の勧め、公序良俗に反する内容` and `- negative: 作品や作り手をけなす、嫌いだと言うのが主体のもの（悲しい感想や辛口の一言は ok=true）`.
- `POST /admin/rejudge` body `{ limit?: 1–100 = 20, after?: string }` (letter id cursor); judges public letters with `kind IN ('letter','found','reply')` ordered by id after the cursor; for each: `moderateLetter(env, body, { title, creator })`; `ok:false` → `setLetterStatus(id, "rejected")`; a throw → skipped. Returns `{ judged, rejected: Array<{ id, reason }>, skipped, next: string | null }`.
- `pnpm rejudge --origin <url> --token <admin token>` loops until `next` is null and prints counts (ids only, no text).

- [ ] **Step 1: Failing tests.** moderate: a verdict `{ok:false, reason:"negative"}` returns that reason; an unknown reason falls back to `offtopic`. letters: a rejected `negative` letter shows the new copy. admin: rejudge judges only the listed kinds, never 私も, sets `rejected`, skips on a thrown judgement, paginates by `after`, and never republishes an already rejected letter. scripts: the loop follows `next`.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS.**
- [ ] **Step 5: Commit** `feat: moderation refuses obscene and negative letters`, `feat: admin rejudge`, `docs: rejudge runbook` (status 本人作業: run `pnpm rejudge` once after deploy).

---

### Task 9: Units feedback loop (admin page, liked examples, grading script)

**Files:**
- Create: `migrations/0018_units_liked.sql` (`ALTER TABLE units ADD COLUMN liked INTEGER NOT NULL DEFAULT 0;`), `src/worker/routes/admin-units.tsx`, `scripts/eval-units.ts`, `docs/eval/units.md` (how to read the report)
- Modify: `src/worker/routes/admin.ts` (`adminAuth` accepts `Authorization: Basic base64("admin:" + ADMIN_TOKEN)` as well as Bearer, so a browser can open the page), `src/worker/db/units.ts` (`listUnits(db, { lang, limit, after })`, `setUnitLiked`, `listLikedUnits(db, lang, 5)`, `clearUnit(db, letterId, lang)`), `src/worker/program/unit.ts` (examples block in `userMessage` from `listLikedUnits`), `src/worker/index.ts`, `package.json` (`eval:units`), `README.md`, `SECURITY.md`, `docs/status.md`
- Test: `test/worker/routes/admin-units.test.ts`, `test/worker/db/units.test.ts`, `test/worker/program/unit.test.ts`, `test/scripts/eval-units.test.ts`

**Interfaces:**
- `GET /admin/units?lang=ja|en&limit=50&after=<letterId>` HTML (admin auth): rows with work title, the letter's first 80 code points, `intro`, `after`, verified, liked, and two forms: `POST /admin/units/:letterId/:lang/like` (toggle; 303 back) and `POST /admin/units/:letterId/:lang/remake` (deletes the unit row and its `audio_ready`, then `prepareLetter(env, db, letterId, lang)` in the request; 303 back). `GET /admin/units.json` same data as JSON for the script.
- `userMessage` (unit.ts) appends, when `listLikedUnits` returns any: 「良い例（intro のみ。文体と長さの参考。内容は写さない）」 followed by up to 5 intros, one per line (English heading for en). Examples are intros only (never letters).
- `scripts/eval-units.ts`: `pnpm eval:units --origin <url> --token <admin token> --lang ja --limit 40 [--remake]` → fetches `/admin/units.json`, grades each unit with Claude (model from `CLAUDE_MODEL` or the default, tool `grade_unit` with `score` 1–5 and `notes`) against the rubric (作品の具体的な一点に触れる／煽らない／ネタバレしない／お便りの言い換えにしない／手渡しに自然につながる), writes `docs/eval/units-<YYYY-MM-DD>.md` (table of scores, the 10 lowest with notes, a "指示文への提案" section the owner approves by hand), and with `--remake` posts `remake` for units scoring ≤ 2 (prints counts only).

- [ ] **Step 1: Failing tests.** admin-units: Basic auth with the token opens the page, Bearer too, wrong token 401; like toggles `liked`; remake clears the row and calls `prepareLetter` (mock); units.test: `listLikedUnits` returns at most 5 liked verified units of the language; unit.test: `userMessage` includes the examples block only when liked units exist and never includes letter text. scripts: the script writes the report file from a fixture JSON and a mocked grader.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS.**
- [ ] **Step 5: Commit** `feat: admin units page with like and remake`, `feat: liked intros as examples in the dj prompt`, `feat: eval units script`, `docs: units loop` (README, SECURITY.md (Basic auth), status 本人作業: migration 0018, how to run the loop).

---

### Task 10: Close-out docs

**Files:** `README.md`, `SECURITY.md`, `docs/status.md`, `docs/DESIGN.md`
- [ ] Reconcile every doc with the code after Tasks 1–9 (env/binding table, routes list, limits, 本人作業 checklist: migrations 0016–0018 → deploy → `/admin/prepare` (vectors, hand-over clips) → `pnpm rejudge` → first `pnpm eval:units`). Commit `docs: phase 4 close-out`.
