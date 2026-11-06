# Dococa FM Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The DJ's talk is made once per letter (a "unit"), voiced once per distinct line, and every listener's programme is assembled from those units with fixed bridges, so the cloud voice reaches everyone and cost follows the number of letters, not plays.

**Architecture:** `units (letter_id, lang)` holds two verified DJ lines per letter; `composeEpisode` lays out bridge → intro → fixed hand-over → letter → after → reactions; `/tts` caches by `sha256(text)` under `tts/v2/<lang>/<voice>/`; a `waitUntil` hook after every letter insert and a 15-minute cron pre-generate units and audio; `listens` records what was actually played; English units and English verification come last.

**Tech Stack:** Cloudflare Workers (Hono 4, D1, R2, Cron Triggers), hono/jsx/dom client, vitest with `@cloudflare/vitest-plugin`, Anthropic SDK (tool use), Gemini-TTS via `src/worker/tts/google.ts`.

**Spec:** `docs/superpowers/specs/2026-11-03-dococa-fm-design.md`, addenda H, I, J, K (K is the binding summary for this plan). Visual/wording rules: `docs/DESIGN.md`.

## Global Constraints

- Commit prefix `feat:` `fix:` `docs:` `test:` `refactor:` `chore:` + short English summary; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never `git push`.
- Secrets only in `.dev.vars` / Cloudflare secrets. No key names beyond those in `src/worker/env.ts` plus none new in this plan.
- "AI がしないこと": letters verbatim (`line.text` equals `bodyJa`, `body`, or from Task 8 `bodyEn`); no sourceless found voices; no 時事; no counts/rankings; the DJ never invites playback (`playback:` rule). Every episode still goes through `verifyEpisode` before it is stored.
- No Japanese literals in JSX; every string in `src/worker/i18n/ja.ts` and `en.ts` with the same keys (`test/worker/i18n.test.ts` checks parity). Screen words banned by DESIGN.md §6 stay banned.
- Every write `POST` route is listed in `isRateLimited()` (`src/worker/security/rate-limit.ts`) and covered by the route-table test in `test/worker/security.test.ts`.
- D1: at most 100 bound parameters per statement (`IN_CHUNK = 90`); one batch where several writes belong together.
- `pnpm test`, `pnpm typecheck`, `pnpm build` green at every commit. Update the Phase 3 table in `docs/status.md` in the task's last commit.
- Do not edit `docs/superpowers/**` (plan/spec) from an implementer; report the need instead.

## Review Focus

1. A letter rejected or taken down after its unit and audio exist must never be read or voiced again: `publicView` still drops it, `/tts` still refuses a line whose stored index is gone, and `prepareBatch` never re-makes a non-public letter. (Tasks 4, 5)
2. The synth cap must be counted before the paid call and never skipped by concurrency: two requests for the same key make one synthesis (claim), and a request over the cap answers 503 without calling Google. (Task 2)
3. A unit whose lines verify alone but fail inside a programme (quoting another letter in the same segment, naming a year that is topical there) must be dropped from that programme, not stored as failed. (Task 4)
4. A new listener with no letters from others on their works must still get a programme (far letters fill the near and neighbor seats) and the `empty` answer must appear only when nobody has written anything readable. (Task 1)
5. `POST /listens` must accept only the listener's own verified episode and a public letter that the episode reads; anything else is 404, and it never creates a row for a `reply` line. (Task 6)

---

### Task 1: Letterless works leave the programme (I3)

**Files:**
- Modify: `src/worker/program/select-sql.ts` (delete `FALLBACK_SQL`), `src/worker/program/select.ts`, `src/worker/program/build.ts`, `src/worker/program/compose.ts`, `src/worker/program/script.ts`, `src/worker/program/verify.ts`, `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `docs/DESIGN.md` (nothing to change unless a word appears), `docs/status.md`
- Test: `test/worker/program/select.test.ts`, `test/worker/program/build.test.ts`, `test/worker/program/compose.test.ts`, `test/worker/program/verify.test.ts`, `test/worker/routes/stations.test.ts`

**Interfaces:**
- Consumes: `selectProgram(db, listener, opts)` → `Selection[]`; `composeEpisode(plan, djLines, letters, items)`.
- Produces: `Selection.letterIds.length >= 1` for every selection returned by `selectProgram`; `buildEpisode` skips a selection whose readable letters all turn out sourceless; `composeEpisode` no longer emits `script.workOnly`; `verifyEpisode` has no `announce` rule.

- [ ] **Step 1: Write the failing tests**

`select.test.ts`:
```ts
it("a public station reads only works that someone has written about", ...) // owner favourite with no letters is absent from the result
it("seats that near and neighbor cannot fill go to far, never to the listener's own unwritten works", ...) // listener owns i0 with no letters from others; far has 2 letters → program has 2 far segments, none for i0
it("every selection has at least one letter", ...) // for mine/world/public fixtures
```
`build.test.ts`: `it("a segment whose only letters are sourceless found voices is dropped", ...)` (a found voice with `sourceUrl: null` on an otherwise letterless item → episode has no segment for it, and `segments.length` can be 0 → `makeEpisode` answers `empty`).
`compose.test.ts`: remove the `script.workOnly` case; `it("throws when a plan entry has no letters", ...)` → `composeEpisode` throws `Error("segment without letters")`.
`verify.test.ts`: delete the `announce` cases.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run test/worker/program` — Expected: the new cases FAIL (fallback pool still fills; workOnly still composed).

- [ ] **Step 3: Implement**

- `select-sql.ts`: delete `FALLBACK_SQL` and its doc comment.
- `select.ts`: delete the `fallback` pool and both `pools.fallback.splice` lines; `publicProgram` filters `withLetters(...)` to `letterIds.length > 0`; at the end of `selectProgram` filter the interleaved result the same way (defensive; the three pools already require a public letter from others).
- `build.ts`: `if (read.length === 0) continue;` after the sourceless loop, before `plan.push` (log once with the count of skipped segments); drop `announce` from `RETRYABLE`.
- `compose.ts`: delete the `script.workOnly` branch; throw `new Error("segment without letters")` when `p.letterIds.length === 0`; remove `"script.workOnly"` from `FIXED_TEMPLATES`.
- `script.ts`: delete `NO_LETTER_NOTE` and its use; `say_before` description becomes 「作品を紹介し、送り主の名前と土地を添えて『〇〇さんからのお便りです』で手渡す。再生や視聴を促す言い方はしない。{SAY_BEFORE_MAX} 字以内」.
- `verify.ts`: delete `hasLetter` and the `announce` block.
- `ja.ts`/`en.ts`: delete `script.workOnly`. Check `station.empty` (ja/en) still reads right for "nobody has written anything readable yet"; adjust wording only if it mentions the listener's own works.

- [ ] **Step 4: Run the suite** — `pnpm test` PASS; `pnpm typecheck` exit 0.

- [ ] **Step 5: Commit** — `feat: letterless works leave the programme` + status.md row.

---

### Task 2: One audio clip per line of text; cloud voice for everyone

**Files:**
- Create: `migrations/0008_tts_audio.sql`, `src/worker/tts/audio.ts`
- Modify: `src/worker/tts/google.ts` (`synthesize(env, text, voice, lang)`), `src/worker/routes/tts.ts`, `src/worker/program/create.ts`, `src/worker/db/episodes.ts` (delete `countCloudTtsToday`), `src/worker/db/listeners.ts` (delete `claimCloudTts` / `releaseCloudTts`), `src/worker/routes/admin.ts` (`/admin/episodes` no longer passes `cloudTts`), `src/client/playback.ts` (no change in shape; 503 already marks `cloudFailed`), `SECURITY.md`, `README.md`, `docs/status.md`
- Test: `test/worker/tts/audio.test.ts` (new), `test/worker/routes/tts.test.ts`, `test/worker/program/create.test.ts`, `test/worker/db/listeners.test.ts`, `test/worker/tts/google.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/worker/tts/audio.ts
  export type AudioLang = "ja" | "en";
  export type AudioVoice = "male" | "female";
  export async function audioKey(lang: AudioLang, voice: AudioVoice, text: string): Promise<string>; // `tts/v2/${lang}/${voice}/${sha256hex(text)}.mp3`
  export async function countSynthesizedToday(db: D1Database, now?: Date): Promise<number>;         // rows of tts_audio since jstDayStartIso(now)
  export type Ensured = { ok: true; key: string; made: boolean } | { ok: false; reason: "limit" | "busy" | "failed" | "unavailable" };
  /** R2 hit → ok (made false). Miss → cap check → claimTts(key) → synthesize → BUCKET.put → INSERT tts_audio → release. A lost claim waits up to 5 s for the winner's clip (busy after that). */
  export async function ensureAudio(env: Env, db: D1Database, line: { text: string; lang: AudioLang; voice: AudioVoice }): Promise<Ensured>;
  export const voiceOf = (env: Pick<Env, "GEMINI_TTS_VOICE">): AudioVoice => env.GEMINI_TTS_VOICE === "female" ? "female" : "male";
  ```
  `synthesize(env, text, voice, lang: AudioLang)` sends `languageCode: lang === "en" ? "en-US" : "ja-JP"` and `prompt: lang === "en" ? DJ_STYLE_PROMPT_EN : DJ_STYLE_PROMPT`.
  Migration 0008:
  ```sql
  CREATE TABLE tts_audio (
    key TEXT PRIMARY KEY,
    lang TEXT NOT NULL,
    voice TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tts_audio_created ON tts_audio (created_at);
  ```
- `makeEpisode`: `cloudTts = Boolean(env.GOOGLE_TTS_SA_JSON)` for every episode; `opts.cloudTts` removed; the `CLOUD_TTS_GLOBAL_DAILY_LIMIT` env now caps synthesized lines per JST day, default `3000` (`DEFAULT_SYNTH_DAILY_LIMIT` in audio.ts; `limitFrom` reused from create.ts — move `limitFrom` to `src/worker/limits.ts` and import it in both).
- `/tts`: unchanged query (`episode`, `line`), same ownership and `storedIndex` checks; then `ensureAudio(env, DB, { text: target.text, lang: "ja", voice: voiceOf(env) })` → `ok` streams `BUCKET.get(key)`; `limit` → 503 `{ error: "tts limit" }`; `busy` → 503 with `retry-after: 2`; `unavailable` (no key) → 503; `failed` → 502. Headers unchanged (`private, max-age=86400`).

- [ ] **Step 1: Write the failing tests**

`audio.test.ts`: key is deterministic and differs by lang/voice/text; `ensureAudio` on a miss calls the stub once, puts the object, inserts a row (`made: true`); a second call returns `made: false` with no fetch; at the cap (`CLOUD_TTS_GLOBAL_DAILY_LIMIT: "1"` with one row today) returns `{ ok: false, reason: "limit" }` and no fetch; a held claim → `busy` after the wait (use a short wait via an exported `WAIT_MS` override or fake timers).
`tts.test.ts`: two episodes of two listeners reading the same letter text: the second `GET /tts` for that line does not call Google (R2 hit by hash); over the cap → 503 `tts limit`; keyless → 503.
`create.test.ts`: with `GOOGLE_TTS_SA_JSON: "{...}"` every episode has `cloudTts: true`, with it empty `false`; the per-listener claim is gone (two episodes, both `cloudTts: true`).
`google.test.ts`: `lang: "en"` sends `en-US` and `DJ_STYLE_PROMPT_EN`.

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run test/worker/tts test/worker/program/create.test.ts`.

- [ ] **Step 3: Implement** as in Interfaces. Delete `claimCloudTts`, `releaseCloudTts`, `countCloudTtsToday` and their tests; leave the `cloud_tts_used` column in place (unused). `SECURITY.md` / `README.md`: reword the cloud-voice limit paragraph (lines per day, 503 then browser voice). `docs/status.md` 本人作業: note that the env meaning changed (default 3000) under 決定.

- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`.

- [ ] **Step 5: Commit** — `feat: cache tts by line text and voice every episode`.

---

### Task 3: Bridges (fixed transition lines)

**Files:**
- Create: `src/worker/program/bridge.ts`
- Modify: `src/worker/program/compose.ts`, `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `docs/DESIGN.md` §6 (one row: つなぎ), `docs/status.md`
- Test: `test/worker/program/bridge.test.ts` (new), `test/worker/program/compose.test.ts`, `test/worker/program/verify.test.ts`, `test/worker/i18n.test.ts` (parity passes)

**Interfaces:**
- i18n keys and exact Japanese (English by the implementer, same meaning, no time words):
  | key | ja |
  |---|---|
  | `bridge.open` | Dococa FM。世界のどこかにいる誰かの好きなものを、お届けします。 |
  | `bridge.near` | 次は、あなたの好きなものに届いたお便りです。 |
  | `bridge.neighbor` | 次は、近くの棚からのお便りです。 |
  | `bridge.far` | 次は、少し遠くからのお便りです。 |
  | `bridge.sameWork` | 同じ作品に、もう一通届いています。 |
  | `bridge.close` | ここで一息。このあとも、お便りは続きます。 |
- ```ts
  // src/worker/program/bridge.ts
  export type BridgeKey = "bridge.open" | "bridge.near" | "bridge.neighbor" | "bridge.far" | "bridge.sameWork" | "bridge.close";
  export const BRIDGE_KEYS: readonly BridgeKey[];
  /** The bridge before segment `index` of a programme: `open` for the first, else by slot. */
  export function bridgeBefore(index: number, slot: Slot): BridgeKey;
  export function bridgeLine(key: BridgeKey, lang: Lang): ScriptLine; // { type: "dj", text: t(key, undefined, lang), fixed: true }
  ```
- `composeEpisode(plan, djLines, letters, items, lang: Lang = "ja")`: segment `i` begins with `bridgeLine(bridgeBefore(i, p.slot), lang)`; before the 2nd..nth letter of a segment `bridgeLine("bridge.sameWork", lang)`; after the last segment's last line `bridgeLine("bridge.close", lang)`. `FIXED_TEMPLATES` gains the six keys. (Task 4 keeps these placements and swaps `djLines` for units.)

- [ ] **Step 1: Failing tests**: `bridge.test.ts` (`bridgeBefore(0, "far") === "bridge.open"`, `bridgeBefore(2, "neighbor") === "bridge.neighbor"`); `compose.test.ts` (first line of segment 0 is the open bridge, fixed; a 2-letter segment has `sameWork` between the letters; the last line of the episode is `close`; `verifyEpisode` on the composed episode passes with `fixed` lines exempt from the quote check even when a letter contains 「お便り」); `verify.test.ts` (a letter containing the exact open-bridge sentence does not fail the bridge line).
- [ ] **Step 2: Run** `pnpm vitest run test/worker/program` — FAIL.
- [ ] **Step 3: Implement** as above. DESIGN.md §6 row: 「つなぎ | （DJ の定型。画面には出ない）」 is enough; §9 one line: つなぎは定型文、差し込み語は手渡しの定型だけ.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat: fixed bridge lines between segments`.

---

### Task 4: Units: the DJ's talk made once per letter (implementer: opus)

**Files:**
- Create: `migrations/0009_units.sql`, `src/worker/db/units.ts`, `src/worker/program/unit.ts`
- Modify: `src/worker/program/script.ts` (keep `DJ_SYSTEM`, `escape`/tag helpers; delete `writeDjLines`, `TOOL`, `ScriptInput`, `DjLines`), `src/worker/program/compose.ts`, `src/worker/program/build.ts`, `src/worker/types.ts` (add `Unit`), `docs/status.md`
- Test: `test/worker/db/units.test.ts`, `test/worker/program/unit.test.ts` (new), `test/worker/program/compose.test.ts`, `test/worker/program/build.test.ts` (rewrite the Claude cases), `test/worker/program/script.test.ts` (move what still applies), `test/worker/query-budget.test.ts` (adjust the per-build query budget: +1 read for units, +N writes only when units are missing)

**Interfaces:**
- Migration 0009:
  ```sql
  CREATE TABLE units (
    letter_id TEXT NOT NULL REFERENCES letters (id),
    lang TEXT NOT NULL,
    intro TEXT NOT NULL,
    after TEXT NOT NULL,
    verified INTEGER NOT NULL,
    audio_ready INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (letter_id, lang)
  );
  ```
- ```ts
  // src/worker/types.ts
  export type Unit = { letterId: string; lang: "ja" | "en"; intro: string; after: string; verified: boolean; audioReady: boolean; createdAt: string };
  // src/worker/db/units.ts
  export async function getUnits(db: D1Database, letterIds: Iterable<string>, lang: Unit["lang"]): Promise<Map<string, Unit>>; // 90 per statement
  export async function upsertUnit(db: D1Database, u: Omit<Unit, "createdAt"> & { createdAt?: string }): Promise<Unit>; // INSERT OR REPLACE
  export async function setUnitAudioReady(db: D1Database, letterId: string, lang: Unit["lang"], ready: boolean): Promise<void>;
  /** Public letters of kind letter/found with no unit in `lang`, oldest first. */
  export async function listLettersWithoutUnit(db: D1Database, lang: Unit["lang"], limit: number): Promise<string[]>;
  /** Verified units whose audio is not ready yet, oldest first. */
  export async function listUnitsWithoutAudio(db: D1Database, lang: Unit["lang"], limit: number): Promise<Unit[]>;
  // src/worker/program/unit.ts
  export const INTRO_MAX = 160; export const AFTER_MAX = 120;
  export type UnitLines = { intro: string; after: string };
  /** One Claude call with the single tool `write_unit` { intro, after }; retried up to 3 times when the reply is out of shape. */
  export async function writeUnitLines(env: Env, input: { item: Item; letter: Letter; lang: Unit["lang"]; retryNotes?: string[] }): Promise<UnitLines>;
  /** The one-segment layout a unit is verified and voiced with: [intro?, hand-over(fixed), letter, after?]. No bridges. */
  export function unitSegment(unit: UnitLines | null, letter: Letter, item: Item, lang: Unit["lang"]): Segment;
  /** write → unitSegment → verifyEpisode; one retry with the retryable details; stores verified 0/1. Null when Claude is unavailable (nothing stored). */
  export async function makeUnit(env: Env, db: D1Database, letter: Letter, item: Item, lang: Unit["lang"]): Promise<Unit | null>;
  /** Stored units for the letters, making the missing ones (concurrency 3) when `hasClaude(env)`. */
  export async function ensureUnits(env: Env, db: D1Database, letters: Letter[], items: ReadonlyMap<string, Item>, lang: Unit["lang"]): Promise<Map<string, Unit>>;
  ```
- `write_unit` tool description (ja): `intro` 「作品を紹介する。送り主の名前と土地は言わない（手渡しは別の定型が言う）。お便りの引用も要約もしない。再生や視聴を促す言い方はしない。160 字以内」; `after` 「お便りへの短い感想。次のお便りの中身には触れない（つなぎは定型が言う）。120 字以内」. System prompt = `DJ_SYSTEM` with the sentence about 次のお便りへのつなぎ replaced by 「感想のあとのつなぎは定型文が言う」. The user message carries one `<segment>` with `<work>` and the one `<letter>` (same tags as today), the listener line removed (a unit is for everyone).
- `composeEpisode(plan: SegmentPlan[], units: ReadonlyMap<string, Unit> | null, letters, items, lang: Lang = "ja"): Segment[]`: per letter `l` (in `p.letterIds` order): the bridge (Task 3), then for the first letter of the segment `dj(unit.intro)` when `units?.get(l.id)?.verified`, then the fixed hand-over (`script.letterFrom` / `script.readingOnly` / `script.foundVoice`, exactly as today when `djLines === null`), then `read(l)`, then `dj(unit.after)` when verified. Reactions after the last letter; `close` after the last segment.
- `buildEpisode`: select → three reads as today → `ensureUnits(env, db, [...letters.values() that are read], items, "ja")` → `composeEpisode(plan, units, letters, items, "ja")` → `verifyEpisode`. If verification fails, find the segments named in `report.details`, drop the unit lines of their letters (compose again with those letter ids removed from `units`), verify again; if it still fails, compose with `units = null`; if that fails throw `EpisodeUnverifiedError`. Delete `DJ_ATTEMPTS`, `askDj`, `RETRYABLE` (the retry moves into `makeUnit`).

- [ ] **Step 1: Failing tests**
  - `units.test.ts`: upsert/get by lang; `listLettersWithoutUnit` skips reactions, rejected letters and letters with a unit; `listUnitsWithoutAudio` returns only verified units.
  - `unit.test.ts`: `writeUnitLines` calls the stub with one `<segment>` and no `聴いている人` line, parses `write_unit`, retries on a missing tool call; `makeUnit` stores `verified: true` for clean lines, retries once with `retryNotes` when the first lines say 「お聴きください」 and stores `verified: false` when the second attempt also fails; keyless `makeUnit` returns null and stores nothing; `unitSegment(null, ...)` is `[hand-over, letter]`.
  - `build.test.ts`: with all units stored, `buildEpisode` makes zero Claude calls and the episode carries each unit's `intro` before and `after` after its letter; with one unit missing it makes exactly one call and stores the unit; a stored unit that quotes a letter of the same segment is dropped from that programme (the episode verifies, the unit row stays `verified: 1`); keyless → fixed lines only.
  - `compose.test.ts`: the layout above, with `units = null` and with units.
- [ ] **Step 2: Run** `pnpm vitest run test/worker/program test/worker/db/units.test.ts` — FAIL.
- [ ] **Step 3: Implement** as in Interfaces. Keep `MAX_REACTIONS`, `FIXED_TEMPLATES`, `siteName`.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm build`.
- [ ] **Step 5: Commit** — `feat: dj talk is made once per letter as a unit` (two commits are fine: db + program).

---

### Task 5: Pre-generation: after each letter, every 15 minutes, and by hand

**Files:**
- Create: `src/worker/program/prepare.ts`
- Modify: `src/worker/index.ts` (export `{ fetch: app.fetch, scheduled }`), `wrangler.jsonc` (`"triggers": { "crons": ["*/15 * * * *"] }`), `src/worker/routes/letters.tsx`, `src/worker/routes/mcp.ts` + `src/worker/mcp/server.ts` (pass a `waitUntil` callback into `buildServer`), `src/worker/routes/admin.ts` (`/admin/letters`, `/admin/found`, new `POST /admin/prepare`), `src/worker/security/rate-limit.ts` (no change: `/admin/*` is exempt), `docs/status.md`, `README.md` (運用: `/admin/prepare` after seeding)
- Test: `test/worker/program/prepare.test.ts` (new), `test/worker/routes/admin.test.ts`, `test/worker/routes/letters.test.ts` (hook fires), `test/worker/index.test.ts` (`scheduled` exists and runs `prepareBatch`)

**Interfaces:**
- ```ts
  // src/worker/program/prepare.ts
  export type Prepared = { units: number; audio: number; failed: number };
  /** The letter's unit in `lang` (made if missing) and the audio of every dj/letter line of `unitSegment`; marks `audio_ready` when all clips exist. Non-public letters and reactions are ignored. Never throws. */
  export async function prepareLetter(env: Env, db: D1Database, letterId: string, lang?: Unit["lang"]): Promise<Prepared>;
  /** Up to `limit` letters without a unit, then up to `limit` verified units without audio. Stops making audio at the first `limit`/`unavailable` answer. */
  export async function prepareBatch(env: Env, db: D1Database, limit = 20): Promise<Prepared & { remaining: { units: number; audio: number } }>;
  ```
- `scheduled(event, env, ctx)` in `index.ts`: `ctx.waitUntil(prepareBatch(env, env.DB))`.
- Hooks: `c.executionCtx.waitUntil(prepareLetter(c.env, c.env.DB, letter.id))` after a successful `createLetter` with `kind === "letter"` in `POST /letters`, `/admin/letters`; after each inserted found voice in `/admin/found`; in MCP `post_letter` through the callback. Reactions never schedule anything.
- `POST /admin/prepare` body `{ limit?: number }` (1..50, default 20) → `200 { units, audio, failed, remaining }`.
- Audio lines of a unit: the `dj` and `letter` lines of `unitSegment(unit, letter, item, lang)`; `ensureAudio` with `voiceOf(env)`; with `GOOGLE_TTS_SA_JSON` empty the unit is made and audio is skipped (`audio: 0`, not failed).

- [ ] **Step 1: Failing tests**: `prepare.test.ts` (a public letter without a unit → one Claude call, unit stored, three `ensureAudio` calls (intro, hand-over, letter, after = four lines when both dj lines exist), `audio_ready = 1`; a rejected letter → nothing; keyless TTS → unit only; `prepareBatch` respects `limit` and reports `remaining`); `admin.test.ts` (`/admin/prepare` 401 without the token; counts with it); `letters.test.ts` (`POST /letters` for a new letter schedules `prepareLetter`, spy on the module; a `watashimo` does not); `index.test.ts` (`scheduled` calls `prepareBatch`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**. In tests, `c.executionCtx.waitUntil` throws outside a real context: wrap in a helper `defer(c, promise)` that falls back to `void promise`.
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm build`; `wrangler deploy --dry-run` parses the cron (run `pnpm exec wrangler deploy --dry-run --outdir /tmp/dococa-dry` and expect no error).
- [ ] **Step 5: Commit** — `feat: pre-generate units and audio after letters and on a cron`.

---

### Task 6: Record what was actually played

**Files:**
- Create: `migrations/0010_listens.sql`, `src/worker/routes/listens.ts`
- Modify: `src/worker/db/listens.ts` (rewrite on the table), `src/worker/index.ts` (route), `src/worker/security/rate-limit.ts` (`path === "/listens"`), `src/client/station.tsx`, `src/client/player.tsx`, `src/client/playback.ts` (shared `reportListen`), `src/worker/routes/stations.tsx` + `episodes.tsx` (`data-listens-url="/listens"`), `docs/status.md` (保留 line removed)
- Test: `test/worker/db/listens.test.ts` (rewrite), `test/worker/routes/listens.test.ts` (new), `test/worker/security.test.ts` (route table + same-origin), `test/client/station.test.ts`, `test/client/player.test.ts`, `test/worker/routes/me.test.ts`

**Interfaces:**
- Migration 0010:
  ```sql
  CREATE TABLE listens (
    listener_id TEXT NOT NULL REFERENCES listeners (id),
    episode_id TEXT NOT NULL REFERENCES episodes (id),
    letter_id TEXT NOT NULL REFERENCES letters (id),
    segment_index INTEGER NOT NULL,
    heard_at TEXT NOT NULL,
    PRIMARY KEY (listener_id, letter_id)
  );
  CREATE INDEX idx_listens_listener_heard ON listens (listener_id, heard_at);
  ```
- ```ts
  // src/worker/db/listens.ts
  export async function recordListen(db: D1Database, r: { listenerId: string; episodeId: string; letterId: string; segmentIndex: number; heardAt?: string }): Promise<void>; // INSERT OR REPLACE
  export async function listHeardLetters(db: D1Database, listenerId: string, limit = 50): Promise<HeardLetter[]>; // from listens JOIN letters (public) newest first; item loaded as today
  ```
- `POST /listens` JSON `{ episodeId: string, letterId: string, segmentIndex: number }` → 204; 404 when the episode is not the listener's verified one, or the letter is not a `letter`/`found` line of its `publicView`, or `segmentIndex` is not that segment's index; 400 on bad JSON.
- Client: `reportListen(url, { episodeId, letterId, segmentIndex })` in `playback.ts` (fire-and-forget `fetch` POST with `content-type: application/json`, once per `(episodeId, letterId)` per page). Called from both players when a `letter` line with `kind !== "reply"` starts; `segmentIndex` is the index in the episode the player holds (already the public view).

- [ ] **Step 1: Failing tests** (db, route incl. the 404 cases of Review Focus 5, route table, same-origin, client once-per-letter, `/me` reads from the table).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test`, `pnpm typecheck`, `pnpm build`. **Step 5: Commit** — `feat: record the letters a listener actually heard`.

---

### Task 7: Letters carry place codes; the screen shows the place in the reader's language

**Files:**
- Create: `migrations/0011_letters_place.sql` (`ALTER TABLE letters ADD COLUMN place_country TEXT; ALTER TABLE letters ADD COLUMN place_region TEXT;`)
- Modify: `src/worker/types.ts` (`Letter.placeCountry: string | null; placeRegion: string | null`), `src/worker/db/letters.ts` (insert/map), `src/worker/letters/create.ts` (copy from the listener), `src/worker/letters/label.ts` (`whoLine` uses `placeLabel(country, region, lang)` when `placeCountry` is set, else `place`), `src/views/components.tsx` if it formats place itself, `src/client/playback.ts` (`whoOf` gets the codes from the script line: add `placeCountry`/`placeRegion` to the `letter` `ScriptLine` and to `compose.read`; `verifyEpisode` attribution check compares them too), `docs/status.md`
- Test: `test/worker/db/letters.test.ts`, `test/worker/letters/label.test.ts`, `test/worker/program/verify.test.ts` (attribution), `test/client/station.test.ts` (an `en` page shows "Shimane, Japan" from codes `JP`/`JP-32`)

- [ ] Steps 1–5 as usual. Commit — `feat: letters keep place codes and show them in the reader's language`.

---

### Task 8: English DJ

**Files:**
- Create: `migrations/0012_episode_lang.sql` (`ALTER TABLE episodes ADD COLUMN lang TEXT NOT NULL DEFAULT 'ja';`), `src/worker/program/verify-en.ts` (`TOPICAL_EN`, `MEASURE_EN`, `PLAYBACK_EN`)
- Modify: `src/worker/types.ts` (`Episode.lang`), `src/worker/db/episodes.ts`, `src/worker/program/unit.ts` (`DJ_SYSTEM_EN`, tool descriptions in English for `lang === "en"`, letter text `bodyEn ?? body`), `src/worker/program/compose.ts` (`read(l, lang)` picks `bodyEn ?? body` for `en`), `src/worker/program/verify.ts` (`lang` param: verbatim accepts `bodyEn`; fixed patterns from `t(key, undefined, lang)`; English regexes for non-fixed lines), `src/worker/program/build.ts` (`lang = listener.lang`), `src/worker/program/create.ts` (store `lang`), `src/worker/routes/tts.ts` (`lang: episode.lang`), `src/worker/program/prepare.ts` (both languages), `docs/DESIGN.md` §9, `docs/status.md`, `README.md`
- Test: `test/worker/program/verify-en.test.ts` (new), `unit.test.ts`, `compose.test.ts`, `build.test.ts`, `tts.test.ts`, `prepare.test.ts`

**Interfaces:**
- `TOPICAL_EN = /\b(today|tonight|this (morning|evening|week|month|year)|yesterday|tomorrow|recently|lately|these days|right now|currently|christmas|new year'?s?|halloween|summer vacation|news|trending|viral|out now|now streaming|just released|new release)\b/i`
- `MEASURE_EN = /\b\d+\s*(people|persons|listeners|letters|messages|fans)\b|\bnumber one\b|#\s?1\b|\btop\s+\d+\b|\branking\b|\b\d+\s*(songs|tracks|films|movies|books|albums)\b(?<!\b1\s*(song|track|film|movie|book|album)s?\b)/i` (one work does not count; the implementer may simplify as long as the listed positives and negatives in the tests hold)
- `PLAYBACK_EN = /\b(let'?s (play|listen|hear|watch)|here it is|here'?s the (song|track|film|movie|book)|have a listen|take a listen|give it a (listen|watch|spin)|check it out|enjoy(!|\b)|play(ing)? it now|coming up next|without further ado)\b/i`
- `verifyEpisode(segments, letters, listener, items, lang: Lang = "ja")`; the Japanese patterns stay as they are for `ja`.
- `DJ_SYSTEM_EN`: the same rules in English (no playback invitations, no dates/seasons/news, no quoting or summarising the letter, no counts, no heavy words, only radio name and place). Tool descriptions in English with the same limits.

- [ ] **Step 1: Failing tests**: `verify-en.test.ts` positives/negatives for the three patterns ("let's play it" fails, "I played it on repeat" passes; "3 people wrote" fails, "one song" passes; "tonight" fails, "night" passes); an `en` episode whose letter line is `bodyEn` verifies; a `ja` body on an `en` episode fails `verbatim`. `unit.test.ts`: `lang: "en"` sends `DJ_SYSTEM_EN`. `build.test.ts`: an `en` listener's episode reads `bodyEn` and stores `lang: "en"`. `tts.test.ts`: an `en` episode synthesizes with `en-US`. `prepare.test.ts`: `prepareLetter` makes `ja` and `en` units.
- [ ] Steps 2–5. Commit — `feat: english dj` (+ `docs:` for DESIGN.md §9 and README).

---

## Self-review notes

- Spec coverage: K bullets → Tasks 1 (letterless), 2 (audio key + cap + everyone), 3 (bridges), 4 (units + episode layout), 5 (pre-generation + cron + admin), 6 (listens), 7 (place codes), 8 (English). H's BGM-per-slot and J's "もう一度聴く plays the unit audio" are not in this plan (replay keeps `?seg=`; BGM stays one bed) — noted in status.md 保留.
- Type consistency: `Unit`, `UnitLines`, `unitSegment`, `ensureUnits`, `ensureAudio`, `AudioLang`, `voiceOf`, `recordListen`, `prepareLetter`, `prepareBatch` are named once here and used by name in later tasks.
- Order and deadline: Tasks 1–5 are the structure; 6–8 can be dropped from the back if 2026-11-08 20:00 JST comes first.
