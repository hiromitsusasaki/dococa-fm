# status — Dococa FM の現在地

> 新しいセッションはまずここを読む。更新はタスクの区切りごと（最新を上に）。

## 2026-11-03 Task 3 完了。次は Task 4

- 設計書・計画は本人承認済み。実行方式は **Subagent-driven**（`superpowers:subagent-driven-development`）。
- 次の一手: **Task 4（リスナーのセッションと設定）**。`docs/superpowers/plans/2026-11-03-dococa-fm.md` の Task 4 を開き、Step 1 から順に。
- リポは private。main-mac と ops-mac の両方に clone 済み（`~/src/github.com/hiromitsusasaki/dococa-fm`）。

## タスクの進み

| Task | 内容 | 状態 |
|---|---|---|
| 1 | Scaffold（Worker、Vite、D1、vitest、i18n） | 完了 |
| 2 | データ層（型、マイグレーション、リポジトリ） | 完了 |
| 3 | 作品の解決（URL 貼り付け、検索、プレビュー） | 完了（TMDB の実 API 確認は鍵待ち） |
| 4 | リスナーのセッションと設定 | 未着手 |
| 5 | お便り（投稿、判定、翻訳、作品ページ、リアクション） | 未着手 |
| 6 | Spotify 連携と履歴、問い係 | 未着手 |
| 7 | 番組の枠決め（三枠とダイヤル） | 未着手 |
| 8 | 台本（Claude）、合成、検証 | 未着手 |
| 9 | 番組の API と画面、アーカイブ、先読み、上限 | 未着手 |
| 10 | プレイヤー（hono/jsx/dom、Media Session、PWA） | 未着手 |
| 11 | クラウド TTS（Gemini-TTS） | 未着手 |
| 12 | MCP の口 | 未着手 |
| 13 | 見つけた声（収集バッチと管理 API） | 未着手 |
| 14 | はじめの一歩（好きなもの 3 つ、ブックマークレット、ホーム） | 未着手 |
| 15 | eval、デプロイ、README | 未着手 |
| 16 | 公開前の整備（CI、secret scanning、レート制限）→ public 化 | 未着手 |

## 決定の記録（設計書に反映済み）

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
