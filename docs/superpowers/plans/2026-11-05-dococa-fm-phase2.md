# Dococa FM Phase 2（局・識別・公開局・ラジオの見た目）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サイトを開いてスイッチを入れると世界の誰かの好きなものが流れ続ける「局」を入口にし、Google サインインで登録・取り込み・公開局・マイページを解放し、レトロフューチャー / シティ・ポップの見た目とラジオの文言に揃える。

**Architecture:** 既存の「回（episode）」はそのまま材料の単位として残し、その上に「局（station）」を置く。局は `world`（遠くだけ）、`mine`（自分の履歴で組む。既存の挙動）、`public:<owner>`（持ち主の好きなものだけ）の三種で、`POST /stations/:key/next` が JSON で次の回を返し、クライアントの局プレイヤーが画面遷移なしに回を継ぎ足して流す。識別は Google OIDC を `listeners.google_sub` に紐づけるだけで、匿名のリスナーと同じ行を使う。

**Tech Stack:** 既存のまま（Cloudflare Workers、Hono 4、hono/jsx/dom、D1、vitest workers pool、zod）。新規依存なし。Google OIDC は `fetch` と WebCrypto だけで行う（ID トークンは Google のトークンエンドポイントから直接受け取るので署名検証は不要。`aud`・`iss`・`exp` を見る）。

**Spec:** `docs/superpowers/specs/2026-11-03-dococa-fm-design.md` の「追記 2026-11-05: Web の体験の組み替え」（A〜E）。Phase 1 の計画 `docs/superpowers/plans/2026-11-03-dococa-fm.md` の決めは、この計画で上書きしない限り生きている。

## Global Constraints

- 提出は 2026-11-08 20:00 JST。Task の順は価値順（①文言 ②局 ③見た目 ④識別 ⑤公開局・マイページ）。間に合わない Task は飛ばし、status.md に「未着手」と書く。
- AI がしないこと（お便りは原文のまま。出典の無い声を作らない。DJ は時事を言わない。数で人や作品を測らない）は変えない。`verifyEpisode` は触らない。
- 匿名で「聴く・私も・一言」はできる。サインインが要るのは「好きなものの登録（/start、/put の投稿、取り込み）」「公開局」「マイページ」だけ。
- 新しい秘密は `GOOGLE_OAUTH_CLIENT_ID` と `GOOGLE_OAUTH_CLIENT_SECRET` の 2 つ。`.dev.vars.example`、`vitest.config.ts` の bindings、`test/scripts/config.test.ts`（Env の全キーが bindings と example にあること）に必ず足す。
- 新しい依存を足さない。Google Fonts の `<link>` は可（CSP は無い）。
- 文言は `src/worker/i18n/ja.ts` にだけ置く。画面の日本語をコードに直書きしない。
- commit は `feat:` `fix:` `docs:` `test:` `chore:` + 英語の要約。各 Task の最後に `docs/status.md` の Phase 2 の表を更新して同じ commit に含める。
- `git push` は本人の指示があるときだけ。
- テストは `pnpm test`（49 ファイル / 711 件が緑の状態から始める）。`vi.mock` は workers pool で効かないので fetch 層のスタブで書く。env の上書きは `app.request(path, init, { ...env, KEY: value })`。

## Review Focus

1. 匿名リスナーが `world` 局をつけたまま 1 時間聴くと、1 人 1 日の回数上限（既定 10）に当たる。当たったら止まるのではなく「今日の分はここまで」を告げて最後の回を流し切る。→ Task 5 のテスト。
2. サインイン済みの Google アカウントで別端末からサインインしたとき、別端末の匿名リスナーが置いた私も・一言は移らない（仕様どおり）が、cookie は元のリスナーに切り替わる。→ Task 7 のテスト。
3. 公開局の持ち主が履歴を空にする、または公開をやめた直後に、他人が `POST /stations/:slug/next` を呼ぶ。→ 404 を返し、作成済みの回には触らない。Task 9 のテスト。
4. `POST /stations/:key/next` は書き込み（回の作成）なので同一オリジン検査とレート制限の対象。fetch は `Origin` を付けるので通る。→ Task 4 のテスト（Origin 不一致で 403）。
5. 取り込みの `rank` は Spotify のよく聴く曲の順位であって再生回数ではない。画面にも「よく聴く順」と書き、数字を出さない。→ Task 11 のテスト（表示に順位の数字が無い）。

---

### Task 1: 一文と文言（ラジオの言葉に揃える）

**Files:**
- Modify: `src/worker/i18n/ja.ts`、`README.md:3`、`CLAUDE.md:3`、`public/manifest.webmanifest:4`
- Test: `test/worker/i18n.test.ts:11`、`test/worker/routes/home.test.ts:27`

**Interfaces:**
- Produces: 新しいキー `station.*`（下記）。後の Task はこのキーを使う。

- [ ] **Step 1: テストを直す。** `i18n.test.ts` の `app.tagline` の期待値を `世界のどこかにいる誰かの好きなものが聴こえてくるラジオ` に。`home.test.ts:27` も同じ文字列に。追加: `expect(t("station.on")).toBe("スイッチを入れる")`、`expect(t("station.off")).toBe("止める")`。
- [ ] **Step 2: 実行して失敗を確認。** `pnpm vitest run test/worker/i18n.test.ts test/worker/routes/home.test.ts`
- [ ] **Step 3: `ja.ts` を更新。** `app.tagline` を置き換え。次のキーを追加（値は厳守）:
  - `station.world`: `世界の局`、`station.mine`: `わたしの局`、`station.public`: `{name}の局`
  - `station.on`: `スイッチを入れる`、`station.off`: `止める`、`station.volume`: `音量`、`station.nowPlaying`: `いま流れているもの`、`station.upNext`: `このあと`、`station.tuning`: `チューニング中`、`station.limit`: `今日の分はここまで。また明日、この局で`、`station.failed`: `電波が届きませんでした。少し待ってもう一度`、`station.empty`: `この局にはまだお便りがありません`
  - `station.grow`: `自分の局を育てる`、`station.growHelp`: `好きなものを置くと、「近く」と「隣」の枠が効き始めます`
  - `home.tuneIn`: `世界の局をつける`
  - 既存の `home.listen` を `わたしの局をつける`、`home.start` を `好きなものを 3 つ置いて、わたしの局を始める` に変更。
  - `signin.google`: `Google でサインイン`、`signin.needed`: `好きなものを置くには、サインインが要ります。聴くのと「私も」「一言」はそのままどうぞ`、`signin.out`: `サインアウト`、`signin.as`: `{name} としてサインイン中`
  - `me.title`: `マイページ`、`me.favorites`: `わたしの好きなもの`、`me.reactions`: `届いた反応`、`me.station`: `わたしの公開局`、`me.nobody`: `まだ反応はありません`
  - `settings.station`: `公開局`、`settings.stationPublic`: `わたしの好きなものだけの局を公開する`、`settings.stationSlug`: `局の URL`、`settings.stationSlugHelp`: `英小文字・数字・ハイフン、3〜24 字`、`settings.stationUrl`: `公開 URL`
  - `put.register`: `好きなものに置く`、`put.imported.top`: `よく聴く順`、`put.imported.recent`: `最近聴いた順`
- [ ] **Step 4: README、CLAUDE.md、manifest の一文を置き換え。**
- [ ] **Step 5: `pnpm test` が緑。コミット** `feat: new tagline and station vocabulary`

### Task 2: スキーマ（識別・公開局・取り込みの順位）

**Files:**
- Create: `migrations/0005_station.sql`
- Modify: `src/worker/types.ts:38-59`（Listener、HistoryRow）、`src/worker/db/listeners.ts`、`src/worker/db/history.ts`
- Test: `test/worker/db/listeners.test.ts`（既存があれば追記、無ければ作成）、`test/worker/db/history.test.ts`

**Interfaces:**
- Produces:
  - `listeners` に `google_sub TEXT NULL UNIQUE`、`display_name TEXT NOT NULL DEFAULT ''`、`station_public INTEGER NOT NULL DEFAULT 0`、`station_slug TEXT NULL UNIQUE`。`history` に `rank INTEGER NULL`。
  - `Listener` に `googleSub: string | null; displayName: string; stationPublic: boolean; stationSlug: string | null`。`HistoryRow` に `rank: number | null`。
  - `updateListener` の書き込み可能列に `googleSub, displayName, stationPublic, stationSlug` を追加。
  - `getListenerByGoogleSub(db, sub): Promise<Listener | null>`、`getListenerBySlug(db, slug): Promise<Listener | null>`（`station_public = 1` のものだけ返す）。
  - `upsertHistory(db, rows: (HistoryRow)[])`: `rank` を書く。ON CONFLICT では `rank = COALESCE(excluded.rank, history.rank)`。
  - `listHistory(db, listenerId, limit, order: "recent" | "rank" = "recent")`: `rank` は `rank IS NULL, rank ASC, occurred_at DESC`。
  - `listFavorites(db, listenerId, limit): Promise<(HistoryRow & { item: Item })[]>`: `source IN ('manual','url')` だけ、`rank` 順。

- [ ] **Step 1: 失敗するテスト。** `listeners.test.ts`: `updateListener(db, id, { googleSub: "g1", displayName: "Hiro" })` → `getListenerByGoogleSub(db,"g1")` が同じ id。`stationSlug: "hiro"` と `stationPublic: true` で `getListenerBySlug(db,"hiro")` が取れ、`stationPublic: false` にすると null。同じ `googleSub` を別リスナーに書くと `D1_ERROR`（UNIQUE）。`history.test.ts`: `upsertHistory` に `rank: 2` → `listHistory(db,id,10,"rank")` が rank 順（null は最後）。`listFavorites` が spotify 行を除く。
- [ ] **Step 2: 失敗を確認。** `pnpm vitest run test/worker/db`
- [ ] **Step 3: マイグレーションと DB 層を実装。** `0005_station.sql` は `ALTER TABLE ... ADD COLUMN` を 5 本と `CREATE UNIQUE INDEX idx_listeners_google_sub ON listeners(google_sub)`、`CREATE UNIQUE INDEX idx_listeners_station_slug ON listeners(station_slug)`。`test/apply-migrations.ts` が全マイグレーションを当てることを確認（`TEST_MIGRATIONS`）。
- [ ] **Step 4: 緑を確認。** `pnpm test`
- [ ] **Step 5: コミット** `feat: schema for google identity, public station and import rank`

### Task 3: 局ごとの枠決め（world / mine / public）

**Files:**
- Modify: `src/worker/program/select.ts:66`、`src/worker/program/select-sql.ts`、`src/worker/program/build.ts:46`、`src/worker/program/create.ts:26`
- Create: `src/worker/program/station.ts`
- Test: `test/worker/program/select.test.ts`（既存に追記）、`test/worker/program/station.test.ts`

**Interfaces:**
- Produces:
  - `src/worker/program/station.ts`: `type StationKey = { kind: "world" } | { kind: "mine" } | { kind: "public"; ownerId: string }`；`parseStationKey(raw: string): { kind: "world" } | { kind: "mine" } | { kind: "public"; slug: string } | null`（`"world"`、`"mine"`、`"s:" + slug` の 3 形。slug は `/^[a-z0-9-]{3,24}$/`）；`stationLabel(key, ownerName): string`（`t("station.*")`）。
  - `selectProgram(db, listener, opts: { size?; seed?; station?: StationKey })`: `station.kind === "world"` のとき far だけ（`farQuota = size`、echo・fallback なし）。`"public"` のとき near の母集団を `ownerId` の `listFavorites` の作品に限り、neighbor は無し、far は 0（size すべて near。お便りが付いていない作品は DJ の紹介だけで流す= `letterIds: []` を許す）。`"mine"` と未指定は既存どおり。
  - `buildEpisode(env, db, listener, opts: { size?; seed?; station?: StationKey })` と `makeEpisode(env, listener, opts: { cloudTts?; station?: StationKey })` は `station` を素通しする。`world` 局の回も `episodes.listener_id` は聴いているリスナー（上限はその人に数える）。

- [ ] **Step 1: 失敗するテスト。** `station.test.ts`: `parseStationKey("world")`、`("mine")`、`("s:hiro-fm")`、不正 `("s:HIRO")`→null、`("x")`→null。`select.test.ts` に追記: 履歴ゼロの新規リスナーで `selectProgram(db, l, { station: { kind: "world" }, size: 3 })` が far 3 件（他人の公開お便りがある作品）。`{ kind: "public", ownerId }` で、owner の favorites にある作品だけが返り、お便りが無い作品も `letterIds: []` で返る。
- [ ] **Step 2: 失敗を確認。** `pnpm vitest run test/worker/program/select.test.ts test/worker/program/station.test.ts`
- [ ] **Step 3: 実装。** `select-sql.ts` に `OWNER_FAVORITES_SQL`（owner の `history` で `source IN ('manual','url')` の `item_id` とその作品に付いた他人の公開お便り、最大 3 通）を追加。`compose.ts` がお便り 0 のセグメントを既に扱えることを確認（Phase 1 の「お便りが無いセグメント」対応）。
- [ ] **Step 4: 緑を確認。** `pnpm test`
- [ ] **Step 5: コミット** `feat: station-aware program selection (world, mine, public)`

### Task 4: 局の API（次の回を JSON で返す）

**Files:**
- Create: `src/worker/routes/stations.tsx`
- Modify: `src/worker/index.ts:37-48`（マウント）、`src/worker/routes/episodes.tsx:92-146`（`episode-json` の組み立てを `src/worker/program/player-view.ts` に切り出して共用）
- Create: `src/worker/program/player-view.ts`
- Test: `test/worker/routes/stations.test.ts`

**Interfaces:**
- Produces:
  - `playerView(db, episode): Promise<{ id; segments; items; originals; ttsLines; cloudTts: boolean }>`（episodes.tsx の `episode-json` と同じ形に `cloudTts` を足したもの）。
  - `POST /stations/:key/next` → `200 { episode: PlayerView, station: { key, label } }`。`key` は `parseStationKey` で解釈。`public` は `getListenerBySlug` で持ち主を引き、無ければ 404 `{ error: "station" }`。`makeEpisode` の失敗は既存の `/episodes/:id/next` と同じ（limit 429、empty 409、unavailable 503）。
  - `GET /stations/:key.json` → 直近の自分の検証済みの回（あれば）を同じ形で返す（再読込時の復帰用。無ければ 204）。
  - 同一オリジン検査・レート制限は既存ミドルウェアがそのまま効く（`/stations` は免除パスに入れない）。

- [ ] **Step 1: 失敗するテスト。** `stations.test.ts`: 新規 cookie で `POST /stations/world/next`（`Origin: http://127.0.0.1:5173`）→ 200、`episode.segments.length >= 1`、全 segment が `slot === "far"`。`Origin` 無しの cross-site（`Sec-Fetch-Site: cross-site`）→ 403。`POST /stations/s:nobody/next` → 404。公開局: owner を作り `stationSlug:"hiro"`、`stationPublic:true`、favorites 1 件 → 別 cookie で `POST /stations/s:hiro/next` → 200 で segments の itemId が owner の作品。`EPISODE_DAILY_LIMIT: "1"` で 2 回目 → 429。
- [ ] **Step 2: 失敗を確認。**
- [ ] **Step 3: 実装。** `episodes.tsx` の `GET /episodes/:id` は `playerView` を使うように置き換え、`episode-json` の中身が変わらないことを既存テストで確認。
- [ ] **Step 4: 緑を確認。** `pnpm test`
- [ ] **Step 5: コミット** `feat: station endpoints returning the next episode as json`

### Task 5: 局プレイヤー（スイッチで流れ続ける）

**Files:**
- Create: `src/client/station.tsx`（局の状態機械）、`src/client/station-view.tsx`（描画）
- Modify: `src/client/player.tsx`（行の再生・TTS・Media Session・反応の送信を `src/client/playback.ts` と `src/client/reactions.ts` に切り出し、回プレイヤーと局プレイヤーで共用）、`vite.config.ts`（`station.js` のエントリ追加）
- Create: `src/worker/routes/home.tsx` の局画面（Task 6 で差し替えるので、ここでは `GET /stations/:key` のページだけ）
- Test: `test/client/station.test.tsx`（happy-dom）、`test/worker/routes/stations.test.ts` に GET の追記

**Interfaces:**
- Consumes: Task 4 の `POST /stations/:key/next`、`GET /stations/:key.json`。
- Produces:
  - `mountStation(root: HTMLElement, opts: { stationKey: string; label: string; nextUrl: string; resumeUrl: string; ttsUrl: string | null; voiceURI: string; dial?: number; strings: Record<string,string> }): { state(): StationState; unmount(): void }`
  - `StationState = { power: "off" | "tuning" | "on" | "limit" | "failed"; volume: number (0..1); current: PlayerView | null; seg: number; line: number; queue: PlayerView[] }`
  - 動き: スイッチ ON → `resumeUrl` で復帰できなければ `nextUrl` を POST → 回を再生。残り 2 セグメントで次の回を prefetch（1 本だけ）。回が終わったら queue の先頭を続ける。429 は `power: "limit"`（流し切ってから `station.limit` を表示）、他の失敗は `power: "failed"`。音量は `clips` と `bed` の `volume` に掛ける（既定 0.8、`localStorage` に保存）。
  - 画面（`station-view.tsx`）: 上からスイッチ（`data-action="power"`）、音量（`input[type=range]`）、ダイヤル（`world` では非表示）、いま流れているもののカード（ジャケット・題名・作者・読まれている行・私も／一言・出口リンク）、「このあと」の列（現在の回の残りセグメント + prefetch 済みの回のセグメント。作品の題名と作者だけ。数字は出さない）。
  - `GET /stations/:key` → ページ。`<div id="station" data-...>` と `script#station-i18n`（`/^(station\.|player\.|out\.|letter\.who|listener\.(?:anonymous|demo)$)/`）。`public` で持ち主が無ければ 404、`mine` で履歴が無ければ `station.grow` の案内と `/start` へのリンク。

- [ ] **Step 1: 失敗するテスト（client）。** `station.test.tsx`: fetch をスタブし、`power` を押すと `nextUrl` が POST され、`current` が入り、`seg` が進み、最後の行で queue の回に切り替わる。429 で `power === "limit"`。音量の range 変更が `clips.volume` に反映。
- [ ] **Step 2: 失敗するテスト（worker）。** `GET /stations/world` が 200 で `id="station"` と `data-next-url="/stations/world/next"` を含む。`GET /stations/s:nobody` → 404。
- [ ] **Step 3: 失敗を確認。** `pnpm vitest run --project client test/client/station.test.tsx` と worker 側。
- [ ] **Step 4: 実装。** `player.tsx` から切り出すときは既存の `test/client/player.test.tsx` を壊さない。bed の音量は `volume * 0.15`。
- [ ] **Step 5: 緑を確認し、ブラウザで `/stations/world` を開いて ON → 2 回続けて流れることをスクリーンショットで確認（`docs/screenshots/2026-11-0X-station.png`）。**
- [ ] **Step 6: コミット** `feat: station player that keeps playing episodes after the switch is on`

### Task 6: ホームを局にする（入口の組み替え）

**Files:**
- Modify: `src/worker/routes/home.tsx`、`src/worker/routes/start.tsx:58-110`（送信後は `/stations/mine` へ 303）、`src/worker/routes/episodes.tsx:49-56`（`startEpisode` の 303 先はそのまま。アーカイブは残す）
- Test: `test/worker/routes/home.test.ts`、`test/worker/routes/start.test.ts`

**Interfaces:**
- Consumes: Task 5 の局ページ部品（`StationPage(props)` を `stations.tsx` から export して home が使う）。
- Produces: `GET /` = `world` 局の画面 + 「わたしの局をつける」（履歴があるとき）+ 「好きなものを 3 つ置いて、わたしの局を始める」（無いとき）+ 「一通置く」。`station.tuning` の文言は i18n。

- [ ] **Step 1: テストを直す。** `home.test.ts`: 新規 cookie の `GET /` が `data-station-key="world"` と `home.tuneIn` の文言を含み、`/start` へのリンクがある。履歴ありのリスナーは `home.listen`（わたしの局）へのリンクがある。`start.test.ts`: POST 成功で `Location: /stations/mine`。
- [ ] **Step 2: 失敗を確認。**
- [ ] **Step 3: 実装。** 旧ホームの `POST /episodes` フォームは残さない（`/episodes/:id` のページとアーカイブは残す）。
- [ ] **Step 4: 緑を確認。ブラウザで `/` を開き、何も登録せず ON で流れることを確認。**
- [ ] **Step 5: コミット** `feat: home is the world station`

### Task 7: Google サインイン

**Files:**
- Create: `src/worker/auth/google.ts`、`src/worker/routes/auth-google.tsx`
- Modify: `src/worker/env.ts`（`GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`）、`vitest.config.ts`、`.dev.vars.example`、`src/worker/index.ts`（マウント）、`src/worker/auth/session.ts`（`setSessionCookie(c, listenerId)` を export）
- Test: `test/worker/auth/google.test.ts`、`test/worker/routes/auth-google.test.ts`

**Interfaces:**
- Produces:
  - `google.ts`: `googleAuthorizeUrl(env, state: string, nonce: string): string`（`https://accounts.google.com/o/oauth2/v2/auth`、`scope=openid email profile`、`redirect_uri = PUBLIC_ORIGIN + "/auth/google/callback"`、`prompt=select_account`）；`exchangeGoogleCode(env, code, fetchFn = fetch): Promise<{ idToken: string } | null>`（`https://oauth2.googleapis.com/token`、`grant_type=authorization_code`、client_secret 付き。失敗は null、本文はログに出さない）；`parseIdToken(idToken, env, nonce, now = Date.now): { sub: string; name: string; email: string } | null`（`iss` が `https://accounts.google.com` か `accounts.google.com`、`aud === GOOGLE_OAUTH_CLIENT_ID`、`exp*1000 > now`、`nonce` 一致。署名検証は不要: トークンエンドポイントから直接受け取るため）。
  - `GET /auth/google?next=/path`: `GOOGLE_OAUTH_CLIENT_ID` が空なら 503 `signin.unavailable`（i18n に追加: `サインインはいま用意できていません`）。state と nonce を `dfm_oauth` cookie（`${state}.${nonce}.${next}`、10 分、path `/auth/google`、HttpOnly）に置き、302。`next` は `/` で始まる相対パスだけ許す。
  - `GET /auth/google/callback`: state 不一致・交換失敗・トークン不正 → 303 `/settings?signin=failed`。成功: `getListenerByGoogleSub` で既存があれば `setSessionCookie(c, existing.id)` で cookie を切り替え（いまの匿名リスナーはそのまま残す）；無ければいまのリスナーに `googleSub`、`displayName`（Google の `name`、無ければ email の `@` 前。`radioName` が空なら同じ値で埋める）を書く。303 `next`（既定 `/me`）。
  - `POST /auth/signout`: cookie を削除して 303 `/`（次のリクエストで新しい匿名リスナー）。
  - `src/worker/auth/session.ts`: `export function setSessionCookie(c, listenerId)`。

- [ ] **Step 1: 失敗するテスト。** `google.test.ts`: `parseIdToken` が `aud` 違い・`exp` 切れ・`nonce` 違いで null、正しいもので `{sub,name,email}`（トークンは base64url で自作、署名はダミー）。`exchangeGoogleCode` のスタブが form body に `grant_type=authorization_code` と `code` を含むこと、500 で null。`auth-google.test.ts`: `GET /auth/google` が 302 で `accounts.google.com` と `redirect_uri=http%3A%2F%2F127.0.0.1%3A5173%2Fauth%2Fgoogle%2Fcallback` を含み `dfm_oauth` を set。callback で state 不一致 → 303 `/settings?signin=failed`。正常系（fetch スタブで token 応答）: 新規 sub なら現在のリスナーに `googleSub` が付く；既存 sub なら `set-cookie` の `dfm_sid` が既存リスナーの id に変わる。`POST /auth/signout` で `dfm_sid` が `Max-Age=0`。
- [ ] **Step 2: 失敗を確認。**
- [ ] **Step 3: 実装。** `test/scripts/config.test.ts` が通るように bindings と example を更新。
- [ ] **Step 4: 緑を確認。** `pnpm test`
- [ ] **Step 5: コミット** `feat: google sign-in bound to the listener`

### Task 8: サインインが要る入口の保護とマイページ

**Files:**
- Create: `src/worker/auth/require-signin.ts`、`src/worker/routes/me.tsx`
- Modify: `src/worker/routes/start.tsx`（GET/POST）、`src/worker/routes/put.tsx`（POST のみ。GET の閲覧は可だが投稿フォームは案内に差し替え）、`src/worker/routes/auth.tsx`（`/auth/spotify` を保護）、`src/worker/routes/letters.tsx`（`kind` が `letter` の POST を保護。`watashimo` と `reply` は匿名可）、`src/views/layout.tsx`（右上に `signin.as` / `signin.google` / `signin.out`）
- Test: `test/worker/auth/require-signin.test.ts`、`test/worker/routes/me.test.ts`、既存の start/put/letters/auth テストの更新

**Interfaces:**
- Produces:
  - `requireSignin: MiddlewareHandler`：`listener.googleSub === null` のとき、HTML 要求なら 303 `/auth/google?next=<元のパス>`、それ以外（`Accept: application/json` か `fetch` 由来）は 401 `{ error: "signin" }`。
  - `GET /me`（保護）: `me.favorites`（`listFavorites` 20 件、作品カードと「お便りを置く」リンク）、`me.reactions`（自分のお便りに付いた私も・一言。`listReactionsToListener` を使い、誰（ラジオネーム・土地）がどう反応したかを新しい順に。数は出さない）、`me.station`（公開なら URL、非公開なら設定への誘導）、`signin.out` ボタン。
  - `Layout` の `props.listener?: Listener` でヘッダ右上の表示を切り替える。

- [ ] **Step 1: 失敗するテスト。** 匿名で `GET /start` → 303 `/auth/google?next=%2Fstart`；`POST /letters` の `kind=letter` → 401；`kind=watashimo` は従来どおり通る；`GET /auth/spotify` → 303。サインイン済み（テストでは `updateListener(db, id, { googleSub: "g1" })`）で `GET /me` が 200 で `me.favorites` と反応者のラジオネームを含み、数字を含まない（`/\d+ 件/` が無い）。
- [ ] **Step 2: 失敗を確認。**
- [ ] **Step 3: 実装。**
- [ ] **Step 4: 緑を確認。ブラウザで匿名 → `/start` が Google に飛ぶことと、`/stations/world` で私もが押せることを確認。**
- [ ] **Step 5: コミット** `feat: sign-in gate for registration and the my page`

### Task 9: 公開局の設定とページ

**Files:**
- Modify: `src/worker/routes/settings.tsx:15-20,123`（`stationPublic`、`stationSlug`）、`src/worker/routes/stations.tsx`（`public` のページに持ち主の表示名と `station.public` ラベル、OGP）
- Test: `test/worker/routes/settings.test.ts`、`test/worker/routes/stations.test.ts` に追記

**Interfaces:**
- Produces:
  - `POST /settings` に `stationPublic: "1" | undefined`、`stationSlug: /^[a-z0-9-]{3,24}$/`。slug 重複は 422 `settings.slugTaken`（i18n: `その URL は使われています`）。slug 未入力で公開にしたら `displayName` から生成（小文字・英数字以外をハイフン・24 字・衝突時は末尾に 4 桁の乱数）。保護対象（Task 8 の `requireSignin`）。
  - `GET /stations/s:<slug>`: 持ち主の `displayName` を `station.public` に入れて表示。`<meta property="og:title">` と `og:description`（一文）を出す。公開をやめたら 404（Review Focus 3）。

- [ ] **Step 1: 失敗するテスト。** 設定保存で slug が保存され `GET /stations/s:<slug>` が 200；`stationPublic` を外すと 404；他人が同じ slug を保存すると 422。favorites が空の公開局への `POST .../next` は 409 `{error:"empty"}`。
- [ ] **Step 2: 失敗を確認。**
- [ ] **Step 3: 実装。**
- [ ] **Step 4: 緑を確認。**
- [ ] **Step 5: コミット** `feat: publish a personal station at /stations/s:<slug>`

### Task 10: 取り込みの順位と「好きなものに置く」

**Files:**
- Modify: `src/worker/auth/spotify.ts:143`（`importSpotifyHistory` が `rank` を書く）、`src/worker/routes/put.tsx:102`（候補の並びと「好きなものに置く」ボタン）、`src/worker/db/history.ts`
- Test: `test/worker/auth/spotify.test.ts`、`test/worker/routes/put.test.ts`

**Interfaces:**
- Produces:
  - `importSpotifyHistory`: top（long_term）の順に `rank = 1..n`、`short_term` も取り（`MAX_TRACKS` 40 の内訳: long 20、short 10、recent 10）、recently-played と saved は `rank: null`。
  - `GET /put`: 候補を 2 群で見せる。`put.imported.top`（`rank` 順）と `put.imported.recent`（`occurred_at` 降順）。各候補に `POST /put/register`（`itemId`）→ `upsertHistory` で `source: "manual"`（公開局とマイページに出る）→ 303 `/put?itemId=` で一言を書く画面へ。
  - 表示に順位の数字を出さない（Review Focus 5）。

- [ ] **Step 1: 失敗するテスト。** Spotify のスタブ応答で `rank` が 1 から振られる；`GET /put` の HTML が `put.imported.top` を含み、順位を表す `\d+位` を含まない；`POST /put/register` 後に `listFavorites` に含まれる。
- [ ] **Step 2: 失敗を確認。**
- [ ] **Step 3: 実装。**
- [ ] **Step 4: 緑を確認。**
- [ ] **Step 5: コミット** `feat: rank spotify imports and register favorites from them`

### Task 11: 見た目の方針（レトロフューチャー / シティ・ポップ）

**Files:**
- Modify: `public/app.css`（トークンの置き換えと部品）、`src/views/layout.tsx`（Google Fonts の `<link>`、`<meta name="theme-color">`、共通ヘッダ）
- Test: `test/worker/views/layout.test.ts`（新規。ヘッダとフォントの link があること）

**Interfaces:**
- Produces（この値で始める。本人が別案を選んだらこの表だけ差し替える）:
  - 配色: `--night #1b1b3a`（背景）、`--cream #f6efe4`（文字）、`--sunset #ff6f61`、`--magenta #e84393`、`--teal #2ec4b6`、`--gold #f4c95d`、`--haze rgba(246,239,228,0.08)`（面）。グラデーション `--sky: linear-gradient(180deg, #2b1f5a 0%, #e84393 55%, #ff6f61 100%)` をホームの上部だけに。
  - 書体: 見出し `"Dela Gothic One"`（Google Fonts）、本文 `"Zen Kaku Gothic New"`（同）。`--font-display`、`--font-sans` を置き換え。
  - 部品: `.panel`（丸角 20px、`--haze`、1px の hairline）、`.knob`（円、針つき。`input[type=range]` の見た目を CSS で置き換え）、`.switch`（トグル。ON で `--gold` に点灯）、`.vu`（水平の目盛り。装飾）。スマホ幅（<= 480px）で 1 カラム、タップ 44px。

- [ ] **Step 1: 失敗するテスト。** `GET /` の HTML に `fonts.googleapis.com` の link と `class="site-header"` がある。
- [ ] **Step 2: 実装。** 既存クラス名（`.player`、`.item-card` など）は変えない。
- [ ] **Step 3: ブラウザで `/`、`/stations/world`、`/put`、`/settings`、`/items/:id` をスマホ幅（390px）と PC 幅で撮る。** `docs/screenshots/2026-11-0X-theme-*.png`
- [ ] **Step 4: コミット** `feat: retro-future visual theme and shared header`

### Task 12: レトロラジオのコントロール

**Files:**
- Modify: `src/client/station-view.tsx`、`public/app.css`
- Test: `test/client/station.test.tsx`（クラス名とスイッチの aria）

**Interfaces:**
- Produces: スイッチは `button.switch[aria-pressed]`、音量は `.knob.knob-volume`、ダイヤルは `.knob.knob-dial`、局名は `.dial-face`（局名と「チューニング中」を表示）。「このあと」は `.up-next li`。

- [ ] **Step 1: 失敗するテスト。** ON 後に `button.switch` の `aria-pressed="true"`；`.dial-face` に局名。
- [ ] **Step 2: 実装。** 動きは Task 5 のまま。見た目だけ。
- [ ] **Step 3: ブラウザで ON/OFF、音量、ダイヤルを操作して撮る。**
- [ ] **Step 4: コミット** `feat: retro radio controls for the station player`

### Task 13: キービジュアル

**Files:**
- Create: `public/kv.webp`（1600×900 以下、300 KB 以下）、`public/kv-mobile.webp`
- Modify: `src/worker/routes/home.tsx`（ホーム上部に `<picture>`）、`public/app.css`
- Test: `test/worker/routes/home.test.ts`（`kv.webp` への参照）

- [ ] **Step 1: 画像を 3 案生成して本人に選んでもらう。** 指示: 「机に座ってレトロなラジオを聴いている人。ラジオから伸びる光や電波の線が、世界地図の上の小さな人影（レコード・本・映画のポスターを持つ）につながっている。シティ・ポップ / レトロフューチャーのイラスト。夕方の色（紺、マゼンタ、サーモン、金）。文字を入れない」。Figma の `generate_image` か `codex-image-gen` スキル。
- [ ] **Step 2: 選ばれた案を webp に変換して置き、ホームに表示。alt は一文。**
- [ ] **Step 3: コミット** `feat: key visual on the home station`

### Task 14: 文書と本番の設定

**Files:**
- Modify: `docs/status.md`（Phase 2 の表と本人作業）、`README.md`（局・サインイン・公開局）、`SECURITY.md`（Google OAuth の秘密）、`docs/superpowers/specs/...`（追記の見直し）、`.dev.vars.example`
- Test: なし（`pnpm test` 全体が緑であること）

- [ ] **Step 1: README に「局」「サインイン」「公開局」「マイページ」を追加し、鍵の一覧に Google OAuth の 2 つを足す。**
- [ ] **Step 2: status.md の本人作業: GCP で OAuth クライアント作成（リダイレクト URI 2 つ）、`wrangler secret put` 2 本、同意画面を本番へ、`pnpm db:migrate`、`pnpm run deploy`。**
- [ ] **Step 3: コミット** `docs: phase 2 in readme, security and status`

---

## 自己レビュー（計画を書いた時点）

- Spec 追記 A（局・連続再生・途中の反応・はじめの一歩の降格）→ Task 3〜6、12。B（識別・匿名の範囲）→ Task 2、7、8。C（公開局）→ Task 2、3、4、9。D（取り込みの並び）→ Task 2、10。E（文言・見た目・キービジュアル）→ Task 1、11、12、13。
- 名前の一貫性: `StationKey` / `parseStationKey`（Task 3）を Task 4・5・6 が使う。`playerView`（Task 4）を Task 5 が使う。`requireSignin`（Task 8）を Task 9・10 が使う。`listFavorites`（Task 2）を Task 3・8・10 が使う。
- 間に合わないときの削る順: Task 13 → 12 → 10 → 9 → 8（マイページだけ落として保護は残す）。Task 1〜7 と 11 は提出の核。
