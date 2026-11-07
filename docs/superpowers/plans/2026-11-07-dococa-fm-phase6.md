# Dococa FM Phase 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The product and UI/UX items of the 2026-11-07 review, all accepted by the owner: a radio face that explains itself (dial labels, loading text, play affordance, feedback), a home that shows the radio first on a phone, a letter's direct link and a share button, a notice of new reactions without counts, letters one can withdraw, a list of public radios without ranking, a cold-start pick that spreads places, fewer listener rows from crawlers, and the cost notes kept for later tuning.

**Architecture:** Client changes stay in `station.tsx` / `station-view.tsx` / `app.css` (bundle under 6 kB gzip). Server: `GET /?letter=` primes the home radio; `listeners.reactions_seen_at` (migration 0022, which also drops nothing — `mcp_token` stays until a later cleanup) backs the header notice; `letters.status = 'withdrawn'` is a new non-public status handled like `rejected` by every reader; the public-radio list reads `listeners.station_public = 1` ordered by the latest letter; the cold-start spread lives in `select.ts`'s no-taste path; cookie-less `GET`s get a cookie but no row until the first write.

**Tech Stack:** Cloudflare Workers (Hono 4, D1, R2, Workers AI), hono/jsx/dom client, vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-dococa-fm-design.md`, addendum N (binding for this plan). Visual/wording rules: `docs/DESIGN.md`. Review that produced the items: private workspace `2026-11-07-dococa-fm-product-review/review.md` (not in the repo). Code map: `.superpowers/sdd/phase5-map.md` plus the Phase 5 task reports.

## Global Constraints

- Commit prefix + short English summary; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never `git push`, amend, stash, checkout or switch branches; `git add <paths>` only.
- Secrets only in `.dev.vars` / Cloudflare secrets. New env keys: none. New migration: `0022_reactions_seen.sql` only.
- "AI がしないこと" unchanged. **No counts anywhere**: the reaction notice is a dot and a sentence, the public-radio list is chronological with no numbers, the cold-start spread never shows a distance.
- No Japanese literals in JSX; ja/en key parity. DESIGN.md §6 banned words stay banned (「局」 never on a screen).
- Every write `POST` is in `isRateLimited()` and under the Origin guard; the route-table test lists it.
- Logs never carry letter text, dj lines or tokens.
- `pnpm test`, `pnpm typecheck`, `pnpm build` green at every commit; `station.js` under 6 kB gzip (figure in the report). Each task's last commit updates the Phase 6 table in `docs/status.md`.
- UI changes are checked in a real browser (playwright-cli against `pnpm dev`); screenshots `docs/screenshots/2026-11-07-p6-*.png`, 1120 and 390 where the task says so. Do not edit `docs/superpowers/**` from an implementer.

## Review Focus

1. The reaction notice must never leak a number and must clear only when the listener opens `/me`; an anonymous listener (no letters) never sees it. (Task 3)
2. A withdrawn letter must vanish from every reader: the work page, home cards, selection, stored episodes' playback (`/tts`, `/episodes/:id`), the archive sender line, eval and admin lists; the owner can withdraw only their own, and 私も/一言 attached to it stay hidden with it. (Task 4)
3. `GET /?letter=` must not start audio without a gesture; it primes the switch and the first `next` carries `letterId`, with the same server checks (public, readable, not own). (Task 3)
4. The cold-start spread must keep today's behaviour as soon as a taste exists, must never return `empty` when a pick is possible, and must stay inside the D1 budget (`query-budget.test.ts`). (Task 5)
5. A cookie-less `GET` must render the same page as today (language, radio mount) without inserting a listener row; the first write (any POST, `/listens` included) creates the row with the same id the cookie carries; nothing else in the session middleware changes. (Task 6)

---

### Task 1: The radio face explains itself

**Files:**
- Modify: `src/client/station-view.tsx`, `src/client/station.tsx`, `src/client/playback.ts` (volume persistence hook if needed), `public/app.css`, `src/worker/i18n/ja.ts`, `src/worker/i18n/en.ts`, `src/views/components.tsx` (`LetterCard` play mark), `docs/DESIGN.md`, `docs/status.md`
- Test: `test/client/station.test.ts`, the `LetterCard` test

**Interfaces:**
- Produces: localStorage `dfm.volume` (0..1, read at mount like `dfm.dial`); a `toast(text)` helper in `station.tsx` (one `div.toast[role=status]`, replaced on each call, hidden after 2.5 s); i18n `station.dialNear`「近く」/ "Near", `station.dialFar`「遠く」/ "Far", `station.dialHint`「次のお便りから効きます」/ "Takes effect from the next letter", `station.searching`「電波を探しています…」/ "Tuning in…", `station.playFromToast`「このお便りから流します」/ "Playing from this letter", `player.sentToast`「送りました」/ "Sent".

- [ ] **Step 1: Failing tests** — the dial shows the two end labels; the first dial release shows `station.dialHint` once per session; while the first `next` is pending the face shows `station.searching`; the volume knob's value is stored under `dfm.volume` and read back at mount; pressing 私も shows `player.sentToast`; a card press shows `station.playFromToast`; the on-air now row shows the work's picture when `imageUrl` is present (the segment view must carry it — add `imageUrl` to the segment payload if missing, server test too); `LetterCard` renders a `span.letter-card-playmark` with an `aria-hidden` play glyph when `data-play-letter` is set.
- [ ] **Step 2: Implement** with the smallest markup: labels as two `span.dial-end` left/right of the dial; the toast element; the thumbnail 40×40 in the now row; the play mark as a CSS circle with a triangle (no image). Contrast: check `--accent` text on the dark background with a contrast tool (`playwright-cli` evaluate of computed colours and a WCAG formula in a one-off script) and raise the token one step if below 4.5:1 for small text — report the ratio before/after.
- [ ] **Step 3: Browser check** at 390 light and 1120 dark, radio on: `docs/screenshots/2026-11-07-p6-face-phone.png`, `2026-11-07-p6-face-pc.png`.
- [ ] **Step 4: Run all, commit** (`feat: radio face labels, toasts and thumbnails`).

---

### Task 2: Home and header on a phone

**Files:**
- Modify: `src/worker/routes/home.tsx`, `src/views/layout.tsx`, `src/client/station.tsx` (hero collapse, language-switch confirm), `public/app.css`, `src/worker/routes/auth-google.tsx` (welcome), `src/worker/routes/me.tsx` (welcome banner), `src/worker/i18n/*`, `docs/DESIGN.md`, `docs/status.md`
- Test: `test/worker/routes/home.test.ts`, `test/worker/views/layout.test.ts`, `test/client/station.test.ts`, `test/worker/routes/me.test.ts`, `test/worker/routes/auth-google.test.ts`

**Interfaces:**
- Produces (owner corrections 2026-11-07 first): **the 「お便りを送る」 button sits directly above the on-air panel** — inside `aside.side` (or wrapping it) as its first child, before the panel's heading, on every width (Phase 5 put it under the player in `section.home`; move it, keep the dialog). **「これまでの番組」 becomes full-width rows under the player**, built with the same row component as the on-air rows (work picture, kind, title, sender; a link to `/episodes/<id>`), up to 3, then the `/episodes` link; it sits between the player/on-air block and 「いま届いているお便り」, so the cards are not pushed far down. Then: localStorage `dfm.seen` (set after the first switch-on; when present at load, `section.hero` gets class `compact`: picture hidden, wordmark + tagline only, on every width); the language form gets `data-confirm` and the client asks `confirm(t("lang.confirmPlaying"))`「切り替えると再生が止まります。続けますか？」/ "Switching stops the radio. Continue?" only while the radio is on; on a phone (≤ 480 px) the language buttons show `JA` / `EN` and the theme buttons their short labels (`.short` spans exist for auto; add for light/dark: ☀ / ☾ as text), so the header is two rows at most; the sign-in callback redirects a newly bound or slug-assigned listener to `/me?welcome=1`, and `/me` shows a one-line banner `me.welcome`「公開ラジオの URL ができました: {url}（設定で公開にすると誰でも聴けます）」/ en equivalent, once; the home's "recent programmes" section renders nothing (not even the heading) when the listener has none and shows only the `/episodes` link otherwise as now; the explanation line says 「好きなものを 3 つ登録すると」 / "Register three things you love"; `/about`'s rules section starts with 「AI は、お便りに書き足しません。」 / "The AI never adds to a letter."; every screen link to `/stations/world` is removed (route stays).

- [ ] **Step 1: Failing tests** for each bullet above.
- [ ] **Step 2: Implement.** Modal on a phone: `dialog.send-modal` at ≤ 480 px is `100dvw × 100dvh`, no border radius, the iframe fills it, the close button stays visible (fixed top-right).
- [ ] **Step 3: Browser check** at 390 (first visit, then revisit with `dfm.seen`) and 1120: `docs/screenshots/2026-11-07-p6-home-phone-first.png`, `-home-phone-again.png`, `-home-modal-phone.png`.
- [ ] **Step 4: Run all, commit** (`feat: compact home and header on a phone`, `feat: welcome line after sign-in`).

---

### Task 3: A letter's link, a share button, and a notice of new reactions

**Files:**
- Create: `migrations/0022_reactions_seen.sql` (`ALTER TABLE listeners ADD COLUMN reactions_seen_at TEXT;`)
- Modify: `src/worker/routes/home.tsx` (`?letter=`), `src/worker/routes/stations.tsx` (`data-letter` on the mount — exists for `/stations/mine?letter=`; reuse), `src/client/station.tsx` / `station-view.tsx` (primed switch label, share button), `src/views/layout.tsx` (header dot), `src/worker/db/letters.ts` (`hasUnseenReactions(db, listenerId)`), `src/worker/db/listeners.ts`, `src/worker/routes/me.tsx` (mark seen), `src/worker/i18n/*`, `public/app.css`, `README.md` (migrations 0001〜0022), `docs/DESIGN.md`, `docs/status.md`
- Test: `test/worker/routes/home.test.ts`, `test/client/station.test.ts`, `test/worker/views/layout.test.ts`, `test/worker/routes/me.test.ts`, `test/worker/db/letters.test.ts`

**Interfaces:**
- Produces: `GET /?letter=<id>` renders the home with `data-letter=<id>` on the station mount (same validation as `/stations/mine?letter=`: id shape only; the server checks on `next`); the switch label reads `station.playFromLetter`「このお便りから聴く」/ "Listen from this letter" while primed; the first `next` carries `letterId` and `first: true` (no opening, as Phase 5). The now row gets a `button.share` (`station.share`「リンクをコピー」/ "Copy link") that writes `${location.origin}/?letter=<id>` to the clipboard and toasts `station.shared`「リンクをコピーしました」/ "Link copied" (fallback: a prompt with the URL when the clipboard API is missing). Header: when `hasUnseenReactions` (a 私も or 一言 on one of the listener's letters with `created_at > COALESCE(reactions_seen_at, '1970')`), the `/me` link gets `span.dot` with `aria-label` `me.newReactions`「新しい反応があります」/ "New reactions"; `GET /me` sets `reactions_seen_at = now` after rendering the reactions panel. One D1 statement per page for the check, signed-in only.

- [ ] **Step 1: Failing tests** per bullet; budget test: `GET /` adds at most one statement for signed-in listeners.
- [ ] **Step 2: Implement.** `OGP` for `/?letter=`: the home's `og:title` becomes the work title and `og:description` the first 80 chars of the letter when the id resolves to a public letter (server-side, one more statement only when `?letter=` is present).
- [ ] **Step 3: Browser check**: primed home at 390 (`docs/screenshots/2026-11-07-p6-letter-link-phone.png`), header dot at 1120 signed-in (seed as before, restore).
- [ ] **Step 4: Run all, commit** (`feat: letter links and sharing`, `feat: a notice of new reactions`).

---

### Task 4: Withdraw a letter; public radios without ranking

**Files:**
- Modify: `src/worker/routes/me.tsx` (own letters list + `POST /letters/:id/withdraw`), `src/worker/routes/letters.tsx`, `src/worker/db/letters.ts`, every reader that filters `status = 'public'` (grep; add nothing — `withdrawn` is simply not public — but check readers that filter `status != 'rejected'` and make them `status = 'public'`), `src/worker/security/rate-limit.ts`, `src/worker/routes/home.tsx` (public radios list), `src/worker/db/listeners.ts` (`listRecentPublicRadios(db, 5)`), `src/worker/i18n/*`, `SECURITY.md`, `docs/DESIGN.md`, `docs/status.md`
- Test: `test/worker/routes/me.test.ts`, `test/worker/routes/letters.test.ts`, `test/worker/routes/home.test.ts`, `test/worker/security.test.ts`, `test/worker/db/letters.test.ts`

**Interfaces:**
- Produces: `POST /letters/:id/withdraw` (signed-in, own letter of kind `letter` only, 404 otherwise) sets `status = 'withdrawn'`, 303 back to `/me`; `/me` gains a panel `me.myLetters`「送ったお便り」/ "Your letters" listing own public letters (work title, first 60 chars, date) each with a `button.quiet` `me.withdraw`「非公開にする」/ "Make private" (confirm dialog text `me.withdrawConfirm`). Home gains `section.public-radios` `home.publicRadios`「お便りが届いた公開ラジオ」/ "Public radios with new letters": up to 5 public listeners whose letters are newest, chronological, each a link `/stations/s:<slug>` showing the radio name and お住まい only; no numbers; rendered only when at least one exists.

- [ ] **Step 1: Failing tests**: withdraw own → 303 and the letter is gone from `/items/:id`, home cards, `listRecentPublicLetters`, selection pools (`select.test.ts` one case), `GET /tts` for a stored episode line of that letter (503 or skip, consistent with `rejected`), and `/episodes/:id` playback (as `rejected` today); withdraw another's → 404; anonymous → 303 to sign-in; route is rate-limited and in the route table. Public radios list: order and the no-number rule; a private listener never appears.
- [ ] **Step 2: Implement**; grep `'rejected'` and `status` across `src/worker` to find every reader and make the withdrawn letter behave exactly like a rejected one.
- [ ] **Step 3: Browser check** `/me` with two own letters at 390 (`docs/screenshots/2026-11-07-p6-me-letters-phone.png`), home with public radios at 1120.
- [ ] **Step 4: Run all, commit** (`feat: withdraw a letter`, `feat: public radios on the home`).

---

### Task 5: Cold start spreads the places

**Files:**
- Modify: `src/worker/program/select.ts`, `src/worker/program/select-sql.ts`, `docs/status.md`
- Test: `test/worker/program/select.test.ts`, `test/worker/query-budget.test.ts`

**Interfaces:**
- Consumes: the no-taste path of the `mine` pick (no favourites, no listens → today's random pick).
- Produces: in that path only, the candidate list is ordered so that the first pick's sender country (letters' place code country, `place_code` prefix) differs from the countries of the last two aired segments of this listener (from `listens`/episodes, as the no-repeat rule already reads), falling back to any when fewer than two distinct countries remain; still random within the allowed set. No distance, no count, nothing in the view. One extra D1 statement at most (`DISTANCE_EXTRA` budget unchanged: fold it into the exclusions read if possible).

- [ ] **Step 1: Failing tests**: three consecutive picks for a fresh listener come from three countries when the pool has them; a pool with one country still answers; a listener with taste is unaffected (existing tests).
- [ ] **Step 2: Implement; Step 3: run all, commit** (`feat: cold start spreads the places`).

---

### Task 6: No listener row for a cookie-less GET

**Files:**
- Modify: `src/worker/auth/session.ts`, `src/worker/db/listeners.ts` (`ensureListener`), every write route that needs the row to exist (`/stations/:key/next`, `/listens`, `/letters`, `/settings`, `/lang`, `/start`, `/put/register`, `/auth/*`), `SECURITY.md`, `docs/status.md`
- Test: `test/worker/auth/session.test.ts`, `test/worker/security.test.ts`, route tests that assumed a row after a GET

**Interfaces:**
- Produces: the session middleware, for a request without a valid cookie: makes a fresh id, sets the cookie as today, and puts a `Listener` object (defaults: lang from Accept-Language, dial 0.3, voice "", no slug) into `c.set("listener")` **without inserting**; a `c.set("listenerStored", false)` flag; `ensureListener(db, listener)` inserts the row with that id when a write route runs (call it in `listenerRateLimit`'s write branch or in a tiny middleware applied to unsafe methods — one place). For a request with a valid cookie whose row is missing (deleted), behave as today (create). Reads never write.

- [ ] **Step 1: Failing tests**: `GET /` without a cookie → 200, cookie set, `listeners` count unchanged; then `POST /stations/mine/next` with that cookie → the row exists with that id; `GET /items/:id` ×10 without cookies → no rows; `POST /listens` without a prior row creates it; the demo listeners and sign-in flows untouched.
- [ ] **Step 2: Implement; Step 3: run all, commit** (`fix: no listener row for a cookie-less GET`).

---

### Task 8: Demo reactions (run before Task 7's close-out)

**Files:**
- Create: `scripts/seed-reactions.ts`, `scripts/lib/seed-reactions.ts`, its test under `test/scripts/` (or where `scripts/lib/*` are tested)
- Modify: `src/worker/routes/admin.ts` (`GET /admin/letters.json`, and `POST /admin/letters` accepting `kind: "watashimo" | "reply"` with `parentLetterId`), `package.json` (`"seed:reactions"`), `README.md` (one paragraph under seeding), `docs/status.md`
- Test: `test/worker/routes/admin.test.ts`

**Interfaces:**
- Produces: `GET /admin/letters.json?after=<id>&limit=50` (admin) → `{ letters: [{ id, kind, itemId, listenerId, body, radioName, demo }], next }` for public `letter` / `found` rows, plus for each the ids of existing reactions' listeners. `POST /admin/letters` with `kind: "watashimo"` (no body) or `kind: "reply"` (body ≤ 200) and `parentLetterId` goes through `createLetter` exactly like a listener's reaction (moderation for replies, no translation for 私も, the demo flag follows the listener), and answers 409 for a repeated 私も. The script `pnpm seed:reactions --origin <url> [--letters <id,...>] [--per 2] [--dry-run]`: for every public letter that has **no reaction from a demo persona yet** (or the given ids), picks 1–3 demo listeners (never the letter's own author, never the same persona twice on one letter) and posts 1–2 私も and 0–1 一言; the 一言 is written by Claude (`claude-sonnet-5-5`, one call per reply) in the persona's language and voice from `docs/demo/personas.json`, ≤ 120 chars, about the letter's feeling, no topical words, no contact-like text, no numbers about people or works, no real-person names beyond the work's creator; checked by the same `check` rules as `seed.ts`. Idempotent: rerunning adds nothing to letters that already have demo reactions, so the owner can run it later for their own new letters (`--letters`).

- [ ] **Step 1: Failing tests** for the admin JSON, the admin reaction post (demo flag, 409 on repeat, moderation on a reply), and the script's selection (no self-reaction, no duplicates, idempotence) with a fake fetch.
- [ ] **Step 2: Implement; run `--dry-run` against the dev server; then run it for real against production** (`DOCOCA_ORIGIN=https://dococafm.app`, token from `.dev.vars`, never printed) and put the counts in the report. If the run is refused by the environment, say so; the owner runs it.
- [ ] **Step 3: Commit** (`feat: demo reactions script`).

---

### Task 7: Close-out: cost notes and docs

**Files:**
- Create: `docs/cost.md` (the per-letter cost table and the tuning levers: lazy English units, Haiku for judge/translate via a `CLAUDE_MODEL_JUDGE` key not yet implemented, split cache namespaces for DJ lines vs letter text, retry caps; with the measured prices as of 2026-11-07 and the assumptions)
- Modify: `docs/status.md` (Phase 6 close-out, 本人作業: migration 0022 → deploy → check screens; Cloudflare Rate Limiting rule as an owner task), `README.md` (features; migrations 0001〜0022), `SECURITY.md`, `docs/DESIGN.md`

- [ ] **Step 1:** Write; `pnpm test` green. **Step 2: Commit** (`docs: phase 6 close-out and cost notes`).
