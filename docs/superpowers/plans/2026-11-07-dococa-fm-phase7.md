# Dococa FM Phase 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner's screen-by-screen feedback of 2026-11-07 (evening): the home's right column is a send panel plus the on-air list, reactions move to the 「いま流れている」 card; one letter per segment and a public radio made of the owner's own letters and the letters they replied to; a my page that starts with 「送ったお便り」, controls the public radio inline, and shares letters to SNS; a settings link in the header; the about page's gradient rule under each heading and illustrations in the key visual's style; a first-visit tutorial.

**Architecture:** Client changes in `station.tsx` / `station-view.tsx` / a new `tour.ts`; server changes in `select.ts` / `compose.ts` (one letter per segment, no `bridge.sameWork`), the `public:<ownerId>` programme pool, `/me` controls (`POST /me/radio`), share links (X intent + Web Share API), and the header. No new tables; migration none.

**Tech Stack:** Cloudflare Workers (Hono 4, D1, R2, Workers AI), hono/jsx/dom client, vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-dococa-fm-design.md`, addendum O (binding). Visual/wording rules: `docs/DESIGN.md`.

## Global Constraints

- Commit prefix + short English summary; trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push/amend/stash/checkout/switch; `git add` explicit paths and only your own hunks in shared files.
- "AI がしないこと" unchanged; no counts/rankings anywhere; letters verbatim; 「局」 never on a screen.
- i18n ja/en parity; every write POST in `isRateLimited()` and under the Origin guard; route-table test updated.
- `pnpm test`, `pnpm typecheck`, `pnpm build` green at every commit; `station.js` ≤ 9 kB gzip (tour included). Each task's last commit updates the Phase 7 table in `docs/status.md`. UI checked in a real browser with screenshots `docs/screenshots/2026-11-07-p7-*.png` (390 and 1120).

## Review Focus

1. One letter per segment must not make the same work play twice in a row, must still honour the 7-day heard exclusion by letter, and must keep the echo (own letter + reactions) segment working. (Task 2)
2. The public radio pool must contain only the owner's public letters and the public parents of the owner's public replies; nothing from favourites; withdrawn/rejected never. (Task 2)
3. `POST /me/radio` changes only the caller's own `station_public` / `station_slug`, validates the slug as `/settings` does, and 422s on a taken slug without changing anything. (Task 3)
4. Share links carry only the public URL and a short text; nothing private; Web Share API falls back to the X intent + copy. (Tasks 1, 3)
5. The tutorial never blocks a returning visitor (localStorage `dfm.tour` done), never starts audio, and is fully keyboard/Escape dismissible. (Task 5)

---

### Task 1: Home: send panel, reactions on the now-playing card, rounded programme panel, share

**Files:** `src/client/station-view.tsx`, `src/client/station.tsx`, `src/worker/routes/home.tsx`, `src/views/components.tsx`, `public/app.css`, i18n, `docs/DESIGN.md`, `docs/status.md`; tests `test/client/station.test.ts`, `test/worker/routes/home.test.ts`.

- The right column's first panel is a `section.panel.send-panel`: heading 「お便りを送る」(`home.put`), one line 「好きな曲・本・映画について、200 字まで。DJ が読み上げます。」(`home.sendLead` / en "About a song, a book or a film you love, up to 200 characters. The DJ reads it out."), the button (opens the modal as today). The on-air panel below keeps only the list (いま / このあと) — no reaction controls, no share button.
- The 「いま流れている」 card (left, under the player) gains, under the DJ text and the out-links: the 私も pill, the 一言 form, and a `div.share` with 「X で共有」(`share.x`: `https://x.com/intent/post?text=<encoded short text>&url=<encoded https://dococafm.app/letters/<id>>`, `target=_blank rel=noopener`), 「共有」(`share.native`, shown only when `navigator.share` exists; calls it with title/text/url) and 「リンクをコピー」. Short text = 「{work} · {sender}さんのお便り — Dococa FM」/ en "{work} · a letter from {sender} — Dococa FM". Hidden when the current letter is a reply.
- 「これまでの番組」 becomes a `section.panel` with the same rounded frame and heading style as the other panels (gradient rule, heading, rows).
- [ ] Tests first; browser check 1120 dark / 390 light; commits `feat: send panel and reactions on the now-playing card`, `feat: share a letter to x`.

### Task 2: One letter per segment; the public radio is the owner's letters

**Files:** `src/worker/program/select.ts`, `select-sql.ts`, `compose.ts`, `bridge.ts`, `build.ts`, `verify.ts` (FIXED_TEMPLATES), i18n (`bridge.sameWork` removed), `docs/status.md`; tests `select.test.ts`, `compose.test.ts`, `query-budget.test.ts`, `stations.test.ts`.

- A segment reads exactly one letter: lead → intro → hand-over → letter → after (echo segments: the owner's letter + its reactions stay as today). `bridge.sameWork` is never composed; remove the key and its FIXED_TEMPLATES entry.
- Selection picks a **letter**, not a work: candidates are public letters (kind letter/found) whose work is not among the last 3 segments' works and that the listener has not heard in 7 days (`listens` by letter); the distance band and the dial still rank by the work's vector; the cold-start spread unchanged. The old "30 episodes" work exclusion becomes the 3-segment rule. Reaction-only echo segments unchanged.
- `public:<ownerId>` pool = the owner's public letters (kind letter) ∪ public parents of the owner's public replies; read with the same one-letter rule, oldest-unheard first for the visitor; empty pool → the station page says 「まだお便りがありません」(`station.publicEmpty`).
- [ ] Tests first (Review Focus 1–2; budgets ≤ 30 statements); commit `feat: one letter per segment`, `feat: public radio plays the owner's letters`.

### Task 3: My page, settings link, public radio controls, share on my page

**Files:** `src/worker/routes/me.tsx` (+ `POST /me/radio`), `src/worker/routes/settings.tsx` (station fieldset removed; link to /me), `src/views/layout.tsx` (header 「設定」 link for signed-in, gear glyph + text), `src/views/components.tsx`, `public/app.css`, i18n, `src/worker/security/rate-limit.ts`, `SECURITY.md`, `docs/DESIGN.md`, `docs/status.md`; tests `me.test.ts`, `settings.test.ts`, `layout.test.ts`, `security.test.ts`.

- Order of `/me`: 1 「送ったお便り」(each: work title + picture, first 80 chars, date, 「X で共有」/「共有」/「リンクをコピー」, 「非公開にする」); 2 「届いた反応」; 3 「あなたの公開ラジオ」: the URL (copy button), a `button` 「公開する／非公開にする」 toggle (`POST /me/radio` `{public: 0|1}`), an inline slug form (`POST /me/radio` `{slug}`; same `SLUG` rule; 422 → 「この URL は使われています」), and one line 「公開ラジオには、あなたが送ったお便りと、一言を返したお便りが流れます。」; 4 「聴いたお便り」 at the bottom, simplified: one row per letter (small picture, work · sender, date, 「もう一度聴く」); no text, no forms. The 「あなたの好きなもの」 panel is removed from `/me` (favourites remain as data).
- `/settings` loses the station fieldset (a link 「公開ラジオの設定はマイページで」). Header: signed-in nav gains 「設定」 → `/settings` (after マイページ).
- [ ] Tests first (Review Focus 3–4); browser check `/me` at 390/1120; commits `feat: my page starts with your letters`, `feat: public radio controls on my page`, `feat: settings link in the header`.

### Task 4: About page: gradient rule under each heading; illustrations in the key visual's style

**Files:** `src/worker/routes/about.tsx`, `public/app.css`, `public/about/*.jpg` (regenerated by the controller), `docs/DESIGN.md`, `docs/status.md`.

- The panel's gradient rule moves from the panel top to directly under each `<h2>` (a `.rule` element after the heading; keep the panel frame). Apply the same to `/put` panels for consistency? No — only `/about` (owner asked for it there; DESIGN.md notes the exception).
- The controller regenerates the four images with the key visual as the style reference; the task swaps files only if the controller says so.
- [ ] Tests (about markup), screenshots; commit `feat: about headings carry the rule`.

### Task 5: First-visit tutorial

**Files:** `src/client/tour.ts` (new, ≤ 2 kB gzip), `src/client/station.tsx` (mount), `public/app.css`, i18n, `src/views/layout.tsx` (a 「？」 button in the header? no — a small 「使い方」 link in the about page and a `?` button on the radio face), `docs/DESIGN.md`, `docs/status.md`; tests `test/client/tour.test.ts`.

- On the home, when `localStorage["dfm.tour"]` is absent and the viewer is not in the send modal: a dim overlay with a cut-out around the target (box-shadow trick on a positioned box), a bubble with title + one sentence + 「次へ」/「とばす」 (keyboard: Enter next, Escape skip), 5 steps: (1) the switch 「スイッチを入れると、誰かのお便りが流れます」; (2) the dial 「近く・遠く。好みに近いお便りか、少し遠くのお便りか。お便りを 3 通送ると効きはじめます」; (3) the on-air panel 「いま流れているお便りと、このあと」; (4) the send panel 「あなたの好きなものも、お便りで」; (5) the sign-in link 「サインインすると、自分のラジオと公開 URL が持てます」(skip when signed in). Ends with `dfm.tour = "done"`. Re-open: a `button.tour-again` 「使い方」 on the radio face (quiet) and in `/about`. Never starts audio; respects reduced motion (no animation); works at 390 (bubble below the target, full width).
- [ ] Tests (steps, skip, done flag, Escape, no audio); screenshots at 1120 and 390 of step 1 and 4; commit `feat: first-visit tour`.

### Task 7: The dial wakes up after three letters (owner decision 2026-11-07; after Tasks 1 and 2)

**Files:** `src/worker/program/taste.ts` (taste = mean vector of the works of the listener's own public letters (kind letter) ∪ the public parents of their public 私も/一言; listens stay a weak fallback only when the above is empty), `select.ts` (no favourites in taste), `src/worker/routes/home.tsx` / `stations.tsx` (mount attribute `data-dial-ready="0|1"` from `countOwnLetters(listenerId) ≥ 3` — letters sent + reactions, one statement), `src/client/station-view.tsx` (the dial stays visible; when not ready it is rendered at 50% opacity, `disabled`, with the line 「お便りを 3 通送ると、ダイヤルが効きはじめます」(`station.dialLocked`); when it flips to ready during a session, a toast 「ダイヤルが効くようになりました」(`station.dialReady`)), `src/client/station.tsx`, home explanation line (「お便りを 3 通送ると、あなたの好みに近いお便りが流れてきます。」 — no `/start` link), `/about` 自分のラジオ text (same wording; Google sign-in sentence stays), i18n, `docs/DESIGN.md`, `docs/status.md` (決定 + 「好きなもの」の登録と Spotify 取り込みは導線から外す; post-hackathon: remove them), tests `taste.test.ts`, `select.test.ts`, `station.test.ts`, `home.test.ts`, `about.test.ts`.
- `/start` and the Spotify connect stay as routes but are not linked from the home or the about page; the settings page's Spotify panel is hidden behind nothing (leave it; note in status).
- [ ] Tests first; browser check (locked and unlocked dial at 1120 dark, `docs/screenshots/2026-11-07-p7-dial-locked.png`); commit `feat: the dial wakes up after three letters`.

### Task 6: Close-out docs

- `docs/status.md` Phase 7 table + deploy note (no migration; prepare not needed), `README.md` (features), `SECURITY.md` (`POST /me/radio`), `docs/DESIGN.md`. Commit `docs: phase 7 close-out`.
