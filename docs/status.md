# status — Dococa FM の現在地

> 新しいセッションはまずここを読む。更新はタスクの区切りごと（最新を上に）。

## 2026-11-05 本番デプロイ・Gemini-TTS・デモ投入 完了。次は Books の鍵・eval 20 回・声と台本の調整・public 化

- 本番 URL: **https://dococafm.app**（カスタムドメイン、Cloudflare Registrar で 2026-11-05 取得。旧 `https://dococa-fm.promitsu.workers.dev` は新ドメインへ 301）（Cloudflare account `promitsu.jp`、Worker `dococa-fm`、D1 `dococa`（APAC、`database_id` は wrangler.jsonc に記入済み）、R2 `dococa-audio`。migrations 0001〜0004 適用済み、secret 7 件投入済み（`GOOGLE_TTS_API_KEY` は `GOOGLE_TTS_SA_JSON` に置き換え、旧 secret は 2026-11-05 に削除））。認証は ops-mac の `.env` の `CLOUDFLARE_API_TOKEN`（gitignore 済み）。再デプロイは `pnpm run deploy`。
- ローカル確認: ops-mac で `pnpm dev` を起動中（ログ `.wrangler/dev-ops-mac.log`）。main-mac からは `ssh -L 5173:127.0.0.1:5173 ops-mac` を張って `http://127.0.0.1:5173` を開く（`PUBLIC_ORIGIN` が 127.0.0.1 なので Origin 検査も通る）。
- 本番で確かめたこと（2026-11-05、ops-mac から curl）: 全ページ 200、セキュリティヘッダ想定どおり。`POST /start` → 303 → 番組生成が実 API で通る（TMDB の映画、Spotify の曲、YouTube の動画、Claude の台本。12〜15 秒）。別リスナーのお便りは原文のまま `letter` 行で読まれる。D1 のクエリは問題なし（CPU 81 ms）。
- Gemini-TTS は **API キーでは使えない**（IAM 権限 `aiplatform.endpoints.predict` が要る）。サービスアカウント `dococa-tts`（ロール Vertex AI User）の JSON を `GOOGLE_TTS_SA_JSON` に置き、Worker が RS256 の JWT を署名して OAuth2 トークンに交換する方式に変更（計画 Task 11 を修正、コミット 805b63f と 4be9d18、opus レビュー済み）。本番 `GET /tts` で 200、初回 8 秒、R2 キャッシュ後 0.7 秒。
- デモ投入（2026-11-05）: AI 生成の 30 ペルソナ（`docs/demo/personas.json`、日本 4 + 26 か国、英語原文）で 93 通を本番に投入（規則で落ちた 12 通は投入せず）。作品は映画 8・音楽 8（本は下の Books の鍵待ち）。作品ページに翻訳＋原文＋「デモ用」の印が出ることを確認。再投入は `pnpm seed --items <file> --personas 30 --reuse --origin https://dococafm.app`。
- MCP（2026-11-05）: 本番 `/mcp/<token>` に initialize / tools/list / get_episode を curl で確認。Claude のカスタムコネクタへの登録は本人。
- GitHub（2026-11-05）: ルールセット `protect-main`（`main` の削除と force-push を禁止、bypass なし）を作成。fork PR の承認設定は private では API が拒むので public 化直後に設定。
- 見つけた不具合と対処:
  - お便りが 1 通も無いセグメント（自分のお便りしか無い最初の回）で DJ が「お便りを読み上げ役にお願いします」と予告してしまう → プロンプトに「このセグメントにお便りは無い」を明示し、検証に `announce:` を追加（修正コミットは `git log` 参照）。
  - Spotify は `/track/` の URL だけ対応（設計どおり）。アルバム URL は作品に解決されず、その枠は黙って落ちる。
  - 本が解決できない: Google Books API を鍵なしで呼ぶと共有枠が 429（1 日のクォータ超過）。任意の `GOOGLE_BOOKS_API_KEY`（ヘッダ `X-Goog-Api-Key`）を足した（b761407、776fd4e、本番デプロイ済み）。鍵が入るまで本の URL と本の検索は空振りする。
- **本人作業（残り）**
  - [x] Gemini-TTS: Agent Platform API（旧 Vertex AI API）を有効化し、サービスアカウントで通した（2026-11-05）。API キー `dococa-tts` は不要になったので Google 側で削除してよい。
  - [ ] 声の聴き比べ（Task 11 Step 5）: 本番でブラウザから自分の最初の回を聴く（最初の回だけクラウド TTS）。Kore を試すなら `pnpm wrangler secret put GEMINI_TTS_VOICE` に `female` を入れて再生成。`DJ_STYLE_PROMPT`（`src/worker/tts/style.ts`）は耳で 1〜2 回調整。
  - [ ] Spotify Developer Dashboard の Redirect URI を `https://dococafm.app/auth/spotify/callback` に、Website を `https://dococafm.app` に変更（workers.dev 版は消してよい）。TMDB の Application URL も同じく。`/settings` からの Spotify 連携の実機確認は本人のフィードバック待ち。
  - [ ] Google Cloud で Books API を有効化し、キー（YouTube のキーに Books API を足して同じ値でもよい）を `.dev.vars` の `GOOGLE_BOOKS_API_KEY` と Cloudflare secret に入れる。入ったら本の作品を足してデモを追加投入（`--reuse`）。
  - [ ] `printf '30' | pnpm wrangler secret put EPISODE_DAILY_LIMIT`（eval 20 回のため。エージェントの権限では secret の書き込みが拒まれる）。
  - [x] デモ投入（上記）。
  - [ ] eval 20 回: `pnpm eval --origin https://dococafm.app --token "$ADMIN_TOKEN" --listener <id> --runs 20 --out docs/eval/<日付>.md`（`EPISODE_DAILY_LIMIT` を 25 以上に）。
  - [ ] `/settings` の `/mcp/<token>` を Claude のカスタムコネクタに登録（サーバー側は確認済み）。
  - [ ] 下の「public 化前チェックリスト」の残り（GitHub 設定、gitleaks、public 化）。

## Phase 2 の進み

| タスク | 内容 | 状態 |
|---|---|---|
| Task 1 | 一文と文言 | 完了 |
| Task 2 | スキーマ | 完了 |
| Task 2b | 言語設定 | 完了 |
| Task 3 | 局ごとの枠決め | 完了 |
| Task 4 | 局の API | 完了（`/stations/:key.json` は局ごとの直近の検証済み回を返す。`episodes.station` を 0006 で追加） |
| Task 5 | 局プレイヤー | 完了（`/stations/:key` のページと `station.js`。行の再生は `playback.ts` に共通化。ON で直近の回に復帰か新規作成、残り 2 セグメントで次の回を先読み） |
| Task 6 | ホームを局に | 完了 |
| Task 7 | Google サインイン | 未着手 |
| Task 8 | 保護とマイページ | 未着手 |
| Task 9 | 公開局 | 未着手 |
| Task 10 | 取り込みの順位 | 未着手 |
| Task 11 | 見た目の方針 | 未着手 |
| Task 12 | レトロラジオのコントロール | 未着手 |
| Task 13 | キービジュアル | 未着手 |
| Task 14 | 文書と本番の設定 | 未着手 |

## 2026-11-04 最終修正 完了。次は本人作業（push・鍵・デプロイ・public 化）

- 設計書・計画は本人承認済み。実行方式は **Subagent-driven**（`superpowers:subagent-driven-development`）。
- 全体レビュー（Claude と Codex）の指摘を 9 コミットで閉じた。主なもの: 定型文が引用検査に当たって 503 になる件、プレイヤーに原文を出す、時事語・作品数・住所・郵便番号の検査、未検証の回と非公開にしたお便りを全出口で出さない、作品の題名と作者の判定、審査員の 3 作品を「近く」に入れる、D1 のクエリ数（`POST /start` 57 → 25、`POST /episodes` 45 → 13）、空の回を作らない、`PUBLIC_ORIGIN` の既定値を空に、開発時の判定の素通しは `DEV_SKIP_CLAUDE=1` だけ、TTS の single-flight と上限、本文の上限、MCP の照会前の IP 制限。詳細は `.superpowers/sdd/2026-11-03-dococa-fm/final-fix-report.md`（gitignore 済み）。
- Cloudflare のプランは **Workers Paid**（本人確認 2026-11-04）。D1 のクエリ上限は 1 回の実行あたり 1000。主な経路はテストで 50 未満（`test/worker/query-budget.test.ts`）なので余裕がある。
- 次の一手（当時）: 本人が push → 鍵を入れる → デプロイ → チェックリストを済ませて public 化・提出。push とデプロイは 2026-11-05 に完了（上の節）。
- Task 16 でできたこと: CI（SHA 固定、secret なし）、Dependabot、SECURITY.md、同一オリジン検査、`secureHeaders()`、レート制限（IP とリスナー、1 分 20 回。カウンタは isolate ごと）、番組作成の全体上限（`EPISODE_GLOBAL_DAILY_LIMIT` 既定 300、`CLOUD_TTS_GLOBAL_DAILY_LIMIT` 既定 50、上限値 `0` は停止）、`SESSION_SECRET` 空のときの 500、未検証の番組は 404。
- **public 化前チェックリスト（本人）**
  - [x] ローカルの commit を push する（2026-11-04 ops-mac から push。初回 CI 緑）。
  - [x] Cloudflare のプラン: Paid。
  - [ ] もう一方の端末の `.dev.vars` に `PUBLIC_ORIGIN=http://127.0.0.1:5173` と `DEV_SKIP_CLAUDE=1` を足し、`pnpm db:migrate:local` を流す（無いと `pnpm dev` が 500 になる。main-mac は 2026-11-04 に済み）。
  - [ ] `CLAUDE.md`、`docs/status.md`（端末名と private の作業場所のパス）、設計書 §3（知人の呼び名）を公開してよいか見る。
  - [ ] Settings → Code security で Secret scanning と Push protection を有効にする。
  - [ ] Settings → Actions → General で、fork からの PR の workflow は承認が要る設定にする。
  - [ ] Settings → Branches（または Rulesets）で、`main` への直接 push を自分だけに限定する。
  - [ ] 手元で `gitleaks detect --source .` を実行して検出 0 を確かめる（実装側で 2026-11-04 に実行済み: 50 commits、検出 0。public 化の直前にもう一度）。
  - [ ] CI が main で緑になっていることを確かめる（GitHub Actions は push するまで走らない）。
  - [ ] 上が済んでから private → public に切り替えて提出する。
- Task 15 の保留（デプロイは 2026-11-05 に完了。残りは eval 20 回と MCP connector 確認）:eval スクリプトは `pnpm eval`（管理 API の模擬サーバーで動作確認済み）、README の eval 欄は「鍵投入後に 20 回回して記入」のまま。走らせ方は `docs/eval/README.md`。
- デプロイの手順（2026-11-05 に実施済み。再デプロイは `pnpm run deploy` だけ）:
  ```bash
  pnpm wrangler d1 create dococa                 # 出た database_id を wrangler.jsonc の d1_databases に書く
  pnpm wrangler r2 bucket create dococa-audio
  for k in ANTHROPIC_API_KEY SPOTIFY_CLIENT_ID GOOGLE_TTS_API_KEY TMDB_API_KEY YOUTUBE_API_KEY ADMIN_TOKEN SESSION_SECRET; do pnpm wrangler secret put $k; done
  # 任意: EPISODE_DAILY_LIMIT、EPISODE_GLOBAL_DAILY_LIMIT、CLOUD_TTS_GLOBAL_DAILY_LIMIT、RATE_LIMIT_PER_MINUTE、CLAUDE_MODEL、GEMINI_TTS_MODEL、GEMINI_TTS_VOICE
  # DEV_SKIP_CLAUDE は本番に入れない（開発専用）
  # wrangler.jsonc の vars.PUBLIC_ORIGIN を本番 URL にする（必須。空のままだと /healthz 以外が 500。--var は次の deploy で空に戻るので使わない）
  pnpm db:migrate                                # 0004_tts_claims.sql まで当たる
  pnpm run deploy
  ```
  そのあと本番 URL で `/start` → 番組を聴く → `/settings` の `/mcp/<token>` を Claude のカスタムコネクタに登録して `get_episode` を呼ぶ。eval は `EPISODE_DAILY_LIMIT` を 25 などに上げて `pnpm eval --origin https://<URL> --token "$ADMIN_TOKEN" --listener <id> --runs 20 --out docs/eval/<日付>.md`。
- Demo seeding real run held: no key（`ANTHROPIC_API_KEY` が空。入れたら `pnpm seed --items <作品 URL の一覧> --personas 3 --dry-run` で確かめ、`--dry-run` を外して投入。`docs/demo/personas.json` はこのときできる）。デモ用リスナーは `listeners.demo = 1` で、画面・MCP・番組に「デモ用」の印が出る。
- YouTube collection real run held: no key（`YOUTUBE_API_KEY` と `ANTHROPIC_API_KEY` を入れたら `pnpm collect --item <url>` を 1 作品で流す。既定は dry-run で `.found/<itemId>.json` に書くだけ。中身を読んで不要な行を消し、`pnpm collect --post .found/<itemId>.json` で投入して、`/items/:id` の「ネットで見つけた声」を確かめる）。`/admin/found` はお便りと同じモデレーションを通り、reject 済みの出典 URL は再投入されない。管理 API は `ADMIN_TOKEN`（Bearer）。デモ回は `POST /admin/episodes`（`listenerId` は `/settings` の MCP の欄に出る）。
- Gemini-TTS real check: 鍵は API キーで通る形だが、本番で 403（Vertex AI API が未有効化）。上の本人作業を参照。`GET /tts` は鍵が空なら 503。鍵が入ったら Task 11 Step 5（Charon / Kore の聴き比べと `DJ_STYLE_PROMPT` の調整）をする。クラウド TTS は各リスナーの最初の回（`claimCloudTts`）と、`makeEpisode(env, listener, { cloudTts: true })`（Task 13 のデモ回）だけ。
- Real-API episode: 2026-11-05 に本番で 2 回生成して確認。`docs/examples/episode-1.json` は未作成（デモ投入後の回で作るとよい）。
- Spotify real check: 曲 URL の解決は本番で確認。OAuth 連携（Step 5）は本番 redirect URI の登録待ち（上の本人作業）。
- リポは private。main-mac と ops-mac の両方に clone 済み（`~/src/github.com/hiromitsusasaki/dococa-fm`）。

## タスクの進み

| Task | 内容 | 状態 |
|---|---|---|
| 1 | Scaffold（Worker、Vite、D1、vitest、i18n） | 完了 |
| 2 | データ層（型、マイグレーション、リポジトリ） | 完了 |
| 3 | 作品の解決（URL 貼り付け、検索、プレビュー） | 完了（TMDB の実 API 確認は鍵待ち） |
| 4 | リスナーのセッションと設定 | 完了 |
| 5 | お便り（投稿、判定、翻訳、作品ページ、リアクション） | 完了 |
| 6 | Spotify 連携と履歴、問い係 | 完了（実機確認は Spotify アプリ待ち） |
| 7 | 番組の枠決め（三枠とダイヤル） | 完了 |
| 8 | 台本（Claude）、合成、検証 | 完了（実 API での 1 回は鍵待ち） |
| 9 | 番組の API と画面、アーカイブ、先読み、上限 | 完了 |
| 10 | プレイヤー（hono/jsx/dom、Media Session、PWA） | 完了（実機での音出しは本人確認待ち） |
| 11 | クラウド TTS（Gemini-TTS） | 完了（実 API の合成は鍵待ち） |
| 12 | MCP の口 | 完了 |
| 13 | 見つけた声（収集バッチと管理 API） | 完了（実データ収集は YouTube 鍵待ち） |
| 13b | デモ用シード（AI ペルソナのお便りと「デモ用」の印） | 完了（実 API での 3 ペルソナ投入は ANTHROPIC_API_KEY 待ち） |
| 14 | はじめの一歩（好きなもの 3 つ、ブックマークレット、ホーム） | 完了 |
| 15 | eval、デプロイ、README | 完了（20 回の eval 実走・デプロイ・MCP connector 確認は鍵と wrangler login 待ち） |
| 16 | 公開前の整備（CI、secret scanning、レート制限）→ public 化 | 完了（gitleaks と GitHub 側の設定は本人） |

## 決定の記録（設計書に反映済み）

- 2026-11-03 **デモ用データは AI 生成の多国籍ダミーペルソナのお便りで作る**（本人）。ペルソナは国籍・土地・年代・好みが一貫した人物像を持たせ、日本語圏以外は英語で原文を投稿した体（`lang="en"`）にし、番組では聴く側の言語（v1 は日本語）に翻訳したものを DJ が読む（画面は原文併記）。本人の実お便りと「見つけた声」を置き換えるものではなく、デモの密度を出す追加。計画に Task 13 付近で「デモ用シード生成」（`scripts/seed-demo-letters.ts` → 管理 API）を追加する。設計書のアンチゴール「架空のお便り」との整理は、設計書の「追記 2026-11-03: デモ用ペルソナ」に書いた（「デモ用」の印付きのお便りだけ例外。README も「印で見分けられます」に合わせた）。
- 2026-11-03 Task 1 のレビューで、`run_worker_first: true` のまま `ASSETS` binding が無いと静的アセットが配信されないことが判明。計画の Task 1 の決めを `binding: "ASSETS"` + Worker 末尾のフォールスルーに修正（Claude の判断）。dev の `PUBLIC_ORIGIN` は Spotify の制約で `http://127.0.0.1:5173`。
- 2026-11-03 クラウド TTS は Google Cloud Text-to-Speech の **Gemini-TTS**（スタイルをプロンプトで指定。既定モデル `gemini-2.5-flash-tts`、声は Charon / Kore）。API キーで通らなければサービスアカウント JWT に切り替える（Task 11 Step 5 で確認）。
- 2026-11-03 v1 は Web + PWA（Media Session API）。**ネイティブ化は v2**（Capacitor、OS 音声、端末内モデル Kokoro Core ML、Personal Voice）。設計書 §2.1。
- 2026-11-03 リポは private で作り、Task 16 の整備後に public へ。

## 本人側の宿題（実装側はブロックされない。要るタスクで止まる）

| 必要なもの | 要るタスク | 置き場所 |
|---|---|---|
| Spotify Developer Dashboard のアプリ（redirect `http://127.0.0.1:5173/auth/spotify/callback`、開発モード） | Task 6 | `.dev.vars` の `SPOTIFY_CLIENT_ID` |
| TMDB API キー | Task 3 | `.dev.vars` の `TMDB_API_KEY` |
| YouTube Data API v3 キー | Task 13 | `.dev.vars` の `YOUTUBE_API_KEY` |
| Google Cloud Text-to-Speech の API キー（Gemini-TTS が使えるプロジェクト） | Task 11 | `.dev.vars` の `GOOGLE_TTS_API_KEY` |
| Anthropic API キー | Task 5 以降 | `.dev.vars` の `ANTHROPIC_API_KEY` |
| Cloudflare アカウントで `wrangler login`、D1 / R2 の作成 | Task 15 | 手元の wrangler |
| 本人のお便り 20〜30 通、知人への依頼 | Task 13〜15 | `POST /letters` か管理 API |
| ドメイン `dococa.fm` の正式な空き確認 | 任意 | — |

## 環境

- Node 20 以上（main-mac は nodenv 24、ops-mac は 25.8）、pnpm 10。wrangler は devDependency で入る。
- Claude Code の plugin `superpowers` が両端末で有効。
- secret は `.dev.vars`（gitignore）。端末をまたぐときは本人が手で写す（リポにも Slack にも置かない）。
