# Dococa FM — プロジェクトの取り決め

「世界のどこかの、好きなものが流れてくるラジオ」。Built with Claude: Japan 2026 への応募作。提出は **2026-11-08 20:00 JST**。

## まず読む

1. `docs/status.md` — 現在地と次の一手（タスクの進み、決定の記録、本人側の宿題）
2. `docs/superpowers/specs/2026-11-03-dococa-fm-design.md` — 設計書（承認済み。設計の正本）
3. `docs/superpowers/plans/2026-11-03-dococa-fm.md` — 実装計画（Task 1〜16。各タスクにテストとコミットがある）

ブレストと調査の経緯は、このリポには置かない（公開リポになるため）。main-mac / ops-mac の `~/agent_workspace/workspace/2026-11-02-built-with-claude-hackathon/`（private）にある。`outputs/2026-11-03-handoff.md` が引き継ぎ資料、`notes/30-session-log.md` がセッション全文の記録。

## 進め方

- 計画は `superpowers:subagent-driven-development` で Task 1 から順に実行する（本人の決定 2026-11-03。推奨された方式）。タスクごとに実装者とレビュアーを新しく起こし、最後に全体レビュー。
- Agent の `model` は明示する。実装 `sonnet`、レビュー `opus`。設計判断を含む Task 8（台本・合成・検証）は実装も `opus`。
- タスクが終わるたびに `docs/status.md` の表を更新し、commit に含める。
- 設計書の書き換えは本人に相談する。追記・補強は事後報告でよい。
- 計画と実装がずれたら、計画の該当タスクを直してから実装する（計画が正本）。

## 守ること

- **イベント期間中の新規制作のみ。** musico-web / musico-react / virtual-dj-space / digline のコード・スキーマ・文言・UI は持ち込まない（思想だけ）。
- **secret はリポに入れない。** `.dev.vars`（gitignore 済み）と Cloudflare secrets のみ。鍵名は計画の Global Constraints に列挙してある。
- **AI がしないこと**を守る: お便りは原文のまま。出典の無い「見つけた声」を作らない。DJ は時事を言わない。数字（件数・ランキング・一致率）で人や作品を測らない。これらは Task 8 の検証コードと eval で機械的に確かめる。
- commit は `feat:` `fix:` `docs:` `test:` `chore:` の prefix + 英語の短い要約。細かく刻む。
- `git push` は本人の指示があるときだけ。main-mac と ops-mac の両方で作業するので、タスクの区切りで「push してよいか」を聞く。
- 公開（private → public）は Task 16 を終えてから、本人が行う。

## 動かす

```bash
pnpm install
pnpm dev          # http://127.0.0.1:5173
pnpm test         # vitest + @cloudflare/vitest-plugin
pnpm typecheck
```

Task 1 が終わるまでは上のコマンドは無い。`.dev.vars` の雛形は `.dev.vars.example`（Task 1 で作る）。
