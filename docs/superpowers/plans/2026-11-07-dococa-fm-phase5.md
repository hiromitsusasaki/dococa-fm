# Dococa FM Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner's fixes from the first listen to the Phase 4 production: a header language switch, a prompt-reading guard that catches long lines, a simpler and cleaner DJ voice in both languages, an on-air panel that always shows the current letter and takes reactions, a settings page without the DJ-voice field and with a ready-made public URL, a bed track that can be heard, a home page where a card plays on the spot, letters are sent from a modal and the three latest programmes are listed, and an about page.

**Architecture:** No new tables. `POST /lang` writes `listeners.lang`. The TTS guard constants are re-calibrated from production clips and the audio cache key moves to `tts/v4/` (migration 0021 clears the cache and `units.audio_ready`). The on-air panel is a client-only change in `station.tsx` / `station-view.tsx`. The slug is assigned on Google sign-in and lazily on the settings page. The bed is a synthesized loop committed as `public/bed.mp3` with the script that made it.

**Tech Stack:** Cloudflare Workers (Hono 4, D1, R2), hono/jsx/dom client, vitest with `@cloudflare/vitest-plugin`, Gemini-TTS, ffmpeg (build-time only, for the bed).

**Spec:** `docs/superpowers/specs/2026-11-03-dococa-fm-design.md`, addendum M (binding for this plan). Visual/wording rules: `docs/DESIGN.md`. Code map: `.superpowers/sdd/phase5-map.md` (file:line pointers and the production measurements; a survey, not a requirement).

## Global Constraints

- Commit prefix `feat:` `fix:` `docs:` `test:` `refactor:` `chore:` + short English summary; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never `git push`. Never amend or rewrite a commit on main; `git add <paths>` only. Never stash, checkout or switch branches.
- Secrets only in `.dev.vars` / Cloudflare secrets. New env keys: none. New bindings: none.
- "AI がしないこと" unchanged: letters verbatim; no sourceless found voices; no 時事; no counts/rankings on screens or in DJ lines.
- No Japanese literals in JSX; every string in `src/worker/i18n/ja.ts` and `en.ts` with the same keys (`test/worker/i18n.test.ts`). DESIGN.md §6 banned words stay banned (「局」 never on a screen).
- Every write `POST` route is in `isRateLimited()` (`src/worker/security/rate-limit.ts`) and passes the Origin guard; the route-table test in `test/worker/security.test.ts` lists it.
- Logs never carry letter text, dj lines or tokens.
- `pnpm test`, `pnpm typecheck`, `pnpm build` green at every commit. Each task's last commit updates the Phase 5 table in `docs/status.md`.
- Do not edit `docs/superpowers/**` from an implementer; report the need instead.
- Client bundle: `station.js` stays under 6 kB gzip; put the figure in the report.
- UI changes are checked in a real browser (playwright-cli against `pnpm dev`), screenshots under `docs/screenshots/2026-11-07-*.png`, light and dark, 1120 and 390 wide where the task says so.

## Review Focus

1. A `POST /lang` with a `next` pointing off-site, at a `//host` path or at a non-path must land on `/`; a bad `lang` must change nothing; the toggle must work for an anonymous listener and never touch any other column. (Task 2)
2. The re-calibrated guard must not reject honest slow clips: the measured clean maxima (ja 68 chars at 17.9 s, en 94 chars at 13.8 s, en 148 chars at 16.6 s) pass, and the measured spoken-prompt clips (ja 41 chars at 16.6 s, ja 64 chars at 33.6 s, en 117 chars at 21.1 s) fail. Short fixed lines (6 chars at 3 s) pass. (Task 1)
3. The on-air panel must show the current letter as soon as the first episode starts, with nothing duplicated when the prefetched episode arrives, and must empty (showing the hint) when the switch goes off. (Task 3)
4. Slug assignment must never overwrite a slug the listener already has, must survive a unique-index collision, and must not run for anonymous listeners. (Task 4)
5. The new bed must loop without a click at the seam (fade-matched ends), stay far under the voice (mean about −24 dBFS in the file, 0.4 × volume in the player), and the client must not change how or when it starts and stops. (Task 5)
6. A card click on the home must never play the viewer's own letter (the server refuses it; the card then has no `data-play-letter`), and the send modal's frame must accept `message` events only from its own origin. (Task 6)

---

### Task 1: TTS guard re-calibration, crisp English prompt, cache v4

**Files:**
- Modify: `src/worker/tts/google.ts` (constants + docblock), `src/worker/tts/style.ts` (`DJ_STYLE_PROMPT_EN`), `src/worker/tts/audio.ts` (`tts/v4/`), `README.md` (migrations 0001〜0021), `docs/status.md`
- Create: `migrations/0021_tts_v4.sql`
- Test: `test/worker/tts/google.test.ts`, `test/worker/tts/audio.test.ts`

**Interfaces:**
- Consumes: `spokeThePrompt(bytes, text, lang)` and `audioKey(lang, voice, text)` as they are.
- Produces: the same signatures; only the constants, the prompt text and the key prefix change.

- [ ] **Step 1: Write the failing guard tests** in `test/worker/tts/google.test.ts` (`describe("spokeThePrompt")`), replacing the three existing cases with these (seconds × 4000 = bytes):

```ts
// Spoken prompt (measured in production 2026-11-07)
expect(spokeThePrompt(16.6 * 4000, "Dococa FM。世界のどこかにいる誰かの好きなものへのお便りを、お届けします。", "ja")).toBe(true); // 41 ch
expect(spokeThePrompt(33.6 * 4000, "あ".repeat(64), "ja")).toBe(true);
expect(spokeThePrompt(25 * 4000, "ここで一息。", "ja")).toBe(true);
expect(spokeThePrompt(21.1 * 4000, "a".repeat(117), "en")).toBe(true);
expect(spokeThePrompt(22 * 4000, "The next letter.", "en")).toBe(true);
// Honest clips, including the slowest clean ones measured
expect(spokeThePrompt(17.9 * 4000, "あ".repeat(68), "ja")).toBe(false);
expect(spokeThePrompt(24.4 * 4000, "あ".repeat(120), "ja")).toBe(false);
expect(spokeThePrompt(3 * 4000, "ここで一息。", "ja")).toBe(false);
expect(spokeThePrompt(13.8 * 4000, "a".repeat(94), "en")).toBe(false);
expect(spokeThePrompt(16.6 * 4000, "a".repeat(148), "en")).toBe(false);
expect(spokeThePrompt(2.5 * 4000, "The next letter.", "en")).toBe(false);
```

- [ ] **Step 2: Run** `pnpm vitest run test/worker/tts/google.test.ts` — expect the three "true" cases for long lines to FAIL with the current constants.

- [ ] **Step 3: Re-calibrate** in `src/worker/tts/google.ts`: `SECONDS_PER_CHAR = { ja: 0.27, en: 0.125 }`, `SLACK_SECONDS = 3`. Rewrite the docblock above `spokeThePrompt` with the measurement: production clips 2026-11-07, ja median 0.20 s/char (clean p90 0.23), en median 0.093 (clean max 0.115); a spoken prompt adds 8–21 s; the old 0.5 / 0.35 let every line over ~40 chars through.

- [ ] **Step 4: Crisper prompts** in `src/worker/tts/style.ts`. Japanese keeps the imperative form, English the descriptive form (the docblock says why). New texts:

```ts
export const DJ_STYLE_PROMPT =
  "次の文を、深夜の都会の FM の男性 DJ のように読んでください。落ち着いて澄んだ、自然で簡潔な話し方で。テンポは急がず、抑揚は軽く、声を張らず、粘らず、母音を伸ばさず、誇張しないでください。";
export const DJ_STYLE_PROMPT_EN =
  "A late-night city FM host with a clear, crisp, natural delivery. Easy, unhurried pace; light, clean intonation; warm but understated, like talking to a friend. Not breathy, not sultry, no drawn-out vowels, no exaggeration.";
```

  Update the docblock: the suave / dandy wording (sample "P" / "Q") was heard as too sticky (ねっとり) in both languages in production on 2026-11-07; the owner asked for simple and clean.

- [ ] **Step 5: Key v4** in `src/worker/tts/audio.ts`: prefix `tts/v4/`; comment: "v4: the guard was too loose for lines over ~40 chars and the English prompt changed (2026-11-07)". In `test/worker/tts/audio.test.ts` add `expect(a.startsWith("tts/v4/ja/male/")).toBe(true)` to the `audioKey` describe (check lines 25–26 first; replace any `v3` literal).

- [ ] **Step 6: Migration** `migrations/0021_tts_v4.sql`:

```sql
-- v4 audio keys: the prompt-reading guard was re-calibrated and the English prompt changed (2026-11-07).
DELETE FROM tts_audio;
UPDATE units SET audio_ready = 0;
```

  `README.md`: the migrations range becomes 0001〜0021 wherever 0020 is named.

- [ ] **Step 7: Run** `pnpm test`, `pnpm typecheck`, `pnpm build` — all green.

- [ ] **Step 8: Commit** (`fix: tts guard catches long spoken prompts`, then `feat: crisp english dj prompt and v4 audio keys` — two commits, the second with the migration, README and the status.md table row).

---

### Task 2: Header language switch

**Files:**
- Create: `src/worker/routes/lang.ts`, `test/worker/routes/lang.test.ts`
- Modify: `src/views/layout.tsx` (`SiteHeader`), `public/app.css`, `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `src/worker/routes/settings.tsx` (remove the `lang` select and the `lang` schema field), `src/worker/security/rate-limit.ts` (`/lang` in `isRateLimited`), the app's route registration (where `authGoogle` is mounted), `docs/DESIGN.md` (header row), `docs/status.md`
- Test: `test/worker/views/layout.test.ts`, `test/worker/routes/settings.test.ts`, `test/worker/security.test.ts`

**Interfaces:**
- Consumes: `updateListener(db, id, { lang })` (`src/worker/db/listeners.ts`), the same-origin `next` sanitiser used by `auth-google.tsx` (find it; if it is local to that file, move it to `src/worker/security/next.ts` as `safeNextPath(next: string | undefined): string` returning `/` for anything that is not a same-origin absolute path, and use it in both places).
- Produces: `POST /lang` with form fields `lang` (`ja` | `en`) and `next` (optional). 303 to `safeNextPath(next)`. 400 on a bad `lang` (zod). Anonymous allowed.

- [ ] **Step 1: Write the failing route tests** `test/worker/routes/lang.test.ts`:
  - `POST /lang` `lang=en&next=/put` with a session cookie → 303 `Location: /put`, and the listener row's `lang` is `en`, every other column unchanged.
  - `lang=fr` → 400 and `lang` unchanged.
  - `next=https://evil.example/x`, `next=//evil.example`, `next=put` (no leading slash) → 303 `Location: /`.
  - without Origin / with a foreign Origin → whatever the Origin guard returns for other forms (assert the same status `POST /auth/signout` gives).
  - `/lang` is rate-limited: `isRateLimited("/lang")` is true.

- [ ] **Step 2: Run** — FAIL (404).

- [ ] **Step 3: Implement** `src/worker/routes/lang.ts` (`export const langRoutes = new Hono<AppEnv>()`), register it next to `authGoogle`, add `path === "/lang"` to `isRateLimited`, and list `/lang` in the route-table expectations of `test/worker/security.test.ts`.

- [ ] **Step 4: Header** in `src/views/layout.tsx`: inside the `listener &&` block (the toggle needs a listener), after the `<nav>`, render

```tsx
<form method="post" action="/lang" class="lang-toggle" role="group" aria-label={t("lang.label")}>
  <input type="hidden" name="next" value={path ?? "/"} />
  {(["ja", "en"] as const).map((l) => (
    <button type="submit" name="lang" value={l} aria-pressed={String(lang === l)} lang={l}>{t(`lang.${l}`)}</button>
  ))}
</form>
```

  i18n: `lang.label` ja「表示の言語」/ en "Language"; `lang.ja` = "日本語" and `lang.en` = "English" in both files (native names; the parity test only needs the keys). CSS: add `.lang-toggle` beside every `.theme-toggle` selector in `public/app.css` (same pill group), with `.lang-toggle { margin-right: var(--sp-2) }` so the two groups read as separate. On a 390 px viewport both groups sit on the second header row.

- [ ] **Step 5: Settings** — remove the `lang` `<select>`, the `lang` schema field and the now-unused `settings.lang*` keys; adjust `test/worker/routes/settings.test.ts` (a posted `lang` is now ignored: assert the column is unchanged).

- [ ] **Step 6: Layout test** — the header has `form.lang-toggle` with two buttons, the current language's button has `aria-pressed="true"`, and the hidden `next` carries the page path.

- [ ] **Step 7: Browser check** on `pnpm dev`: home at 1120 (light) and 390 (dark), ja then click English → the page re-renders in English and the English button is pressed. Screenshots `docs/screenshots/2026-11-07-header-ja-pc.png`, `2026-11-07-header-en-phone.png`. `docs/DESIGN.md`: the header row lists wordmark, nav, language switch, theme switch.

- [ ] **Step 8: Run all, commit** (`feat: language switch in the header`).

---

### Task 3: On-air panel

**Files:**
- Modify: `src/client/station.tsx` (`upNextRows`), `src/client/station-view.tsx` (panel), `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `public/app.css` (a `.now` row style), `docs/DESIGN.md` (station screen row), `docs/status.md`
- Test: `test/client/station.test.ts`

**Interfaces:**
- Consumes: `state.current`, `state.seg`, `state.queue`, `whoOf` as they are.
- Produces: `upNextRows()` returns `{ now: boolean; kind; title; creator; sender? }[]`; the first row is the segment now playing (`now: true`), then the rest of the current episode, then the queued episodes.

- [ ] **Step 1: Reproduce first.** Start `pnpm dev`, open `/` as a fresh anonymous visitor with playwright-cli, switch the radio on, wait for the first line to play, and record what the panel shows (snapshot). Then seed a signed-in listener in the local D1 (`google_sub` on the session listener, as the Phase 4 final-fix implementer did; remove it afterwards) and repeat on `/` and `/stations/mine`. Write both observations in the report. If the anonymous case shows nothing even after the prefetch should have resolved, find why (network tab: the second `next` call's status and body) and fix the cause in this task; report it.

- [ ] **Step 2: Failing tests** in `test/client/station.test.ts`:
  - before the switch is on: `.up-next` has no `li` and the panel shows `station.offHint`.
  - after power with `nextReplies = [ok(epA()), ok(epB())]`: rows are `[A (li.now), B]`, and the heading text is `station.onAir`.
  - when B starts playing: rows are `[B (li.now)]` plus whatever is prefetched; A is gone.
  - after turning off: hint again, no `li`.

- [ ] **Step 3: Implement.** `upNextRows()`: `if (state.current) { add(state.current, state.seg, true); addRest(state.current, state.seg + 1); }` then the queue. View: heading `t("station.onAir")` (ja「オンエア」/ en "On air"); each `li` gets `class={row.now ? "now" : ""}` and a leading `<span class="tag">` with `station.now`（ja「いま」/ en "Now"）or `station.next`（ja「このあと」/ en "Next"）; empty + off → `<p class="muted">{t("station.offHint")}</p>`（ja「スイッチを入れると、ここにお便りが並びます。」/ en "Turn the switch on and the letters line up here."）. Remove `station.upNext` if nothing else uses it. CSS: `.up-next li.now` gets the coral left rule the design tokens already define for emphasis (`--accent`), nothing else.

- [ ] **Step 3b: Reactions on the now row.** The player already has 私も / 一言 (`react()` in `station.tsx:316`, buttons in `station-view.tsx:117`), but only inside the player card. Put the same two controls under the `now` row of the panel for the segment's first letter (`letterId` / `itemId` from the segment, as `react()` uses them): a `pill hot` 私も button (disabled once sent, label `player.sent`) and a 一言 form (textarea 200 chars, `player.reply` send button) that call the existing `react("watashimo")` / `react("reply", body)`. One `sent` map serves both places, so a 私も said in the player shows as sent in the panel. Test: pressing 私も in the panel posts `kind=watashimo&itemId=…&parentLetterId=…` once and disables both buttons; a reply posts `kind=reply` with the body. No counts anywhere.

- [ ] **Step 4: Browser check** at 1120 dark and 390 light, radio on, first segment playing: `docs/screenshots/2026-11-07-onair-pc.png`, `2026-11-07-onair-phone.png`. `station.js` gzip in the report.

- [ ] **Step 5: Run all, commit** (`feat: on-air panel shows the current letter`).

---

### Task 4: Settings without the DJ-voice field; a public URL from sign-in

**Files:**
- Modify: `src/worker/routes/settings.tsx`, `src/worker/program/station.ts` (`slugSuffix(length)`, `ensureStationSlug`), `src/worker/routes/auth-google.tsx` (assign on bind), `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `docs/DESIGN.md` (settings row), `docs/status.md`
- Test: `test/worker/routes/settings.test.ts`, `test/worker/program/station.test.ts`, `test/worker/routes/auth-google.test.ts`

**Interfaces:**
- Consumes: `updateListener`, `getListenerById`, the unique index on `listeners.station_slug`.
- Produces: `ensureStationSlug(db: D1Database, listener: Listener): Promise<string>` — returns the existing slug, or assigns `radio-<6 base36 chars>` (retry up to 3 times on a unique violation), persists it and returns it. `slugSuffix(length = 4)`.

- [ ] **Step 1: Failing tests.**
  - `station.test.ts`: `ensureStationSlug` returns the existing slug untouched; assigns `/^radio-[0-9a-z]{6}$/` to a listener without one and persists it; retries when the first suffix collides (pre-insert a listener with that slug by stubbing `slugSuffix` through an injectable `suffix` option, or by seeding and checking the second call differs).
  - `settings.test.ts`: GET `/settings` signed-in with no slug → the form shows a `radio-…` slug and the URL in `<code>`; the row now has it. GET as anonymous → no slug assigned. POST with `stationSlug=my-radio` → 303 and the slug is `my-radio`; posting a slug another listener holds → 422 `settings.slugTaken`. The `voice` field is gone from the form and a posted `voice` is ignored (column unchanged).
  - `auth-google.test.ts`: after a successful callback that binds a new Google account, the listener has a slug.

- [ ] **Step 2: Implement.** Remove the `voice` input, label and `settings.voice*` keys (the column stays; `data-voice` keeps reading it). POST `/settings`: slug = `chosen ?? listener.stationSlug` (always set for signed-in listeners now; keep the generated-collision retry for safety). Hint text under the slug: ja「公開ラジオの URL。あとから変えられます（英小文字・数字・ハイフン、3〜24 文字）」/ en "Your radio's public address. You can change it later (a–z, 0–9, hyphen, 3–24 characters)". The URL line shows as a link when public, `<code>` otherwise (as now).

- [ ] **Step 3: Browser check** `/settings` signed-in (seed `google_sub` locally, remove afterwards) at 1120 light and 390 dark: `docs/screenshots/2026-11-07-settings-pc.png`, `2026-11-07-settings-phone.png`.

- [ ] **Step 4: Run all, commit** (`feat: public radio address from sign-in` and `chore: drop the dj voice field`).

---

### Task 5: A bed you can hear

**Files:**
- Create: `scripts/make-bed.sh`
- Replace: `public/bed.mp3`
- Modify: `src/client/audio.ts` (`BED_VOLUME`), `README.md` (credit line), `docs/status.md`
- Test: `test/client/player.test.ts`, `test/client/station.test.ts` (bed level expectations)

**Interfaces:**
- Consumes: `createBed()` as it is.
- Produces: `BED_VOLUME = 0.4`; the file: 32 s seamless loop, mono, 64 kbps MP3, mean level about −24 dBFS, peak at most −12 dBFS.

- [ ] **Step 1: Script.** `scripts/make-bed.sh` (bash, `set -euo pipefail`, requires `ffmpeg`): synthesize two slow detuned sine pads (for example 110 Hz and 164.81 Hz, each amplitude-modulated by a 0.05–0.08 Hz LFO) plus pink noise through `lowpass=f=500`, mix with `amix`, `highpass=f=50`, make the loop seamless by generating 36 s and `acrossfade`-ing the last 4 s into the first 4 s (or a fade-in/fade-out of 2 s each if the seam is inaudible at the bed's level), normalise with `loudnorm=I=-24:TP=-12`, encode `-ac 1 -b:a 64k` to `public/bed.mp3`. Print `ffmpeg -af volumedetect` output at the end. Choose exact frequencies and rates yourself; the sound should be a calm, static late-night pad, nothing rhythmic, no melody.

- [ ] **Step 2: Run it**, keep the volumedetect lines for the report, and listen check is not possible here — note that the owner judges the sound after deploy.

- [ ] **Step 3: Client level.** `BED_VOLUME = 0.4` in `src/client/audio.ts`; update the two tests that assert `0.075` at volume 0.5 to `0.2`. Comment: the file's mean is about −24 dBFS, so 0.4 puts it roughly 16 dB under the voice.

- [ ] **Step 4: README** credit: the bed is synthesized by `scripts/make-bed.sh` (no third-party audio); replace any earlier "CC0" credit for `bed.mp3`.

- [ ] **Step 5: Run all, commit** (`feat: audible synthesized bed track`).

---

### Task 6: Home page: play from a card, send in a modal, three recent programmes

**Files:**
- Modify: `src/worker/routes/home.tsx`, `src/views/components.tsx` (`LetterCard`), `src/client/station.tsx` (card → player), `src/client/station-view.tsx` (the send button above the on-air panel), `src/worker/routes/put.tsx` (`?embed=1`), `src/views/layout.tsx` (embed layout: no header, no footer), `public/app.css` (`dialog.send-modal`, `.recent-episodes`), `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `docs/DESIGN.md` (home screen), `docs/status.md`
- Test: `test/worker/routes/home.test.ts`, `test/worker/routes/put.test.ts`, `test/client/station.test.ts`, `test/worker/views/components.test.ts` (or wherever `LetterCard` is tested)

**Interfaces:**
- Consumes: `POST /stations/world/next` with `{dial, first: true, letterId}` (confirm in `src/worker/program/create.ts` / `routes/stations.tsx` that `letterId` is honoured on the `world` station exactly as on `mine`: public, readable, not the viewer's own; if it is `mine`-only, extend it to every station in this task and say so in the report). `listArchive(db, listenerId, limit)` (`src/worker/db/episodes.ts`) for the recent programmes.
- Produces: `GET /put?embed=1` renders the same page without header and footer, with `<base target="_top">` NOT set (forms stay inside the frame) and a `postMessage({ type: "dfm:sent" }, location.origin)` to `window.parent` on the "届きました" state. Home markup order inside `section.home`: (1) `<button type="button" class="button" data-open-send>` 「お便りを送る」 + `<dialog class="send-modal">` with an `<iframe src="/put?embed=1" title=…>` and a close button; (2) `<p class="muted">` 「好きなものを 3 つ送ると、あなたの好みに近いお便りが流れてきます。<a href="/start">始める</a>」 (en: "Send three things you love and the letters drift closer to your taste. <a>Start</a>"), shown for every listener; (3) `<section class="recent-episodes">` with `<h2>` 「これまでの番組」 and up to 3 of the viewer's heard episodes (title line = the first work's title · the sender, link to `/episodes/<id>`), then `<a href="/episodes">` 「すべて見る」; nothing but the link when there are none; (4) the letter cards as now.

- [ ] **Step 1: Failing tests.**
  - `home.test.ts`: the send button and the dialog with the iframe; the explanation paragraph with the `/start` link; three recent episodes for a listener with four heard, and only the link for a new listener; the order of the sections.
  - `put.test.ts`: `GET /put?embed=1` has no `header.site-header`, and the sent state carries the `postMessage` script; `GET /put` is unchanged.
  - `LetterCard` test: the card's main link keeps `href="/stations/mine?letter=<id>"` (no-JS fallback) and gains `data-play-letter="<id>"`; an own letter keeps its `/items/` link and has no `data-play-letter`.
  - `station.test.ts`: a click on an element with `data-play-letter` inside the page (dispatch on `document`) prevents the navigation, turns the radio on (or restarts it) and the first `next` body carries `letterId` and `first: true`; the page scrolls to the player (`scrollIntoView` stubbed).
  - `station.test.ts`: the send button opens the dialog (`showModal` stubbed), a `message` event `{type:"dfm:sent"}` from the frame's origin closes it; a foreign origin does nothing.

- [ ] **Step 1b: No opening when a letter is asked for.** Reproduced on production 2026-11-07: a card click seats the asked letter correctly, but the segment starts with `bridge.open`, whose cached clip carried the spoken prompt (16.6 s of voice direction, heard as "an introduction of Dococa FM") before the letter. Besides the v4 regeneration (Task 1), a request with `letterId` and `first: true` must start at the hand-over: in `bridgeBefore` (or where `first` is applied in `create.ts`), `first && letterId` → no `bridge.open`, the segment begins with the asked letter's intro. Test in `test/worker/routes/stations.test.ts` (or `create.test.ts`): `{first: true, letterId}` → the first line is not `bridge.open`; `{first: true}` without a letter → `bridge.open` as before.

- [ ] **Step 2: Implement.** Card → player: in `station.tsx`, one delegated `click` listener on `document` for `[data-play-letter]` (the station mounted on the home is `world`, so the letter plays there; `/stations/mine?letter=` stays as the no-JS route). Modal: `<dialog>` + `showModal()`; the frame loads only when opened (set `src` on open) so the home stays light; `Escape` and the close button close it; after `dfm:sent` close and do nothing else (the radio keeps playing). The embed layout drops header/footer and the key visual; the sent page posts the message. Remove the old `home.start` / `home.listen` button row (the explanation replaces it). The `home.put` button text stays 「お便りを送る」.

- [ ] **Step 3: Browser check** at 1120 dark and 390 light: the modal open (ja), a card click starting the radio (snapshot of the on-air panel), the recent list: `docs/screenshots/2026-11-07-home-modal-pc.png`, `2026-11-07-home-phone.png`. `station.js` gzip in the report (the delegated listener and the dialog wiring are small; the budget is 6 kB).

- [ ] **Step 4: Run all, commit** (three commits: `feat: letter cards play on the home radio`, `feat: send letters from a modal on the home`, `feat: three recent programmes on the home`).

---

### Task 7: About page

**Files:**
- Create: `src/worker/routes/about.tsx`, `test/worker/routes/about.test.ts`
- Modify: `src/views/layout.tsx` (header nav link), `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `src/worker/routes` registration, `docs/DESIGN.md`, `docs/status.md`

**Interfaces:**
- Produces: `GET /about` (session-less is fine; use the listener's language when there is one, else the Accept-Language rule), linked from the header nav as 「Dococa FM とは」/ "About" before 「お便りを送る」, visible to everyone (also when no `listener` prop is passed).

- [ ] **Step 1: Failing tests.** `/about` is 200 in ja and en, carries `<h1>`, the four sections below, and the header shows the link on `/` and on `/about` (`aria-current="page"` on `/about`).

- [ ] **Step 2: Content** (ja below; write the en counterparts yourself, same keys `about.*`; no counts, no 時事, no 「局」):
  - `<h1>` 「Dococa FM とは」. Lead: 「世界のどこかにいる誰かの好きなものが聴こえてくるラジオです。誰かが好きな曲・本・映画について書いたお便りを、DJ が読み上げます。」
  - 「聴く」: 「スイッチを入れると、お便りが流れはじめます。ダイヤルを回すと、自分の好みに近いお便りと、少し遠くのお便りの割合が変わります（次のお便りから効きます）。流れているお便りには「私も」と一言を返せます。」
  - 「送る」: 「好きな作品の URL を貼るか、題名で探して、お便りを書きます。お便りは原文のまま読まれます。AI は時事を話さず、数で人や作品を測りません。」
  - 「自分のラジオ」: 「好きなものを 3 つ送ると、あなたの好みに近いお便りが流れるラジオになります。Google でサインインすると、公開の URL で誰かに聴いてもらえます。」
  - 「できること・しないこと」: 「お便りは書いた人のものです。AI が勝手に書き足したり、出典の無い声を作ったりしません。通報されたお便りは非公開になります。」
  Layout: `.panel` sections with `<h2>`, the same tokens as `/put`. Screenshots at 1120 light and 390 dark: `docs/screenshots/2026-11-07-about-pc.png`, `2026-11-07-about-phone.png`.

- [ ] **Step 3: Run all, commit** (`feat: about page`).

---

### Task 8: Close-out docs

**Files:**
- Modify: `docs/status.md` (Phase 5 heading, table, 本人作業: `pnpm db:migrate` 0021 → `pnpm run deploy` → `/admin/prepare` loop until audio remaining is 0 (about 700 lines, within the 8000/day cap) → listen: opening line, a Japanese and an English episode, the bed; check the header switches, `/settings`, the home modal, a card click, `/about`), `README.md` (features list: language switch, about page, home modal, bed), `docs/DESIGN.md` (anything the tasks reported as needed), `SECURITY.md` (`POST /lang` in the rate-limit list; the embed frame is same-origin only).

- [ ] **Step 1:** Write the sections; `pnpm test` still green.
- [ ] **Step 2: Commit** (`docs: phase 5 close-out`).
