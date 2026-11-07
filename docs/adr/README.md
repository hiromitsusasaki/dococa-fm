# Architecture Decision Records

Dococa FM の設計上の判断を、1 件 1 ファイルで残しています。各 ADR は Status・Date・Context・Decision・Consequences・Related の順に書いています。全体の流れは [docs/history.md](../history.md) にあります。

日付は、設計書（`docs/superpowers/specs/2026-11-03-dococa-fm-design.md`）の追記、[docs/status.md](../status.md)、git の履歴によります。

| # | 判断 | Status | Date |
|---|---|---|---|
| [0001](0001-radio-and-letters.md) | ラジオとお便りという形 | Accepted | 2026-11-03 |
| [0002](0002-verify-what-ai-must-not-do.md) | AI がしないことを機械で検証する | Accepted | 2026-11-03 |
| [0003](0003-cloudflare-workers-d1-r2-workers-ai.md) | Cloudflare Workers + D1 + R2 + Workers AI | Accepted | 2026-11-03 |
| [0004](0004-hono-jsx-without-client-framework.md) | Hono JSX と、フレームワーク無しのクライアント | Accepted | 2026-11-03 |
| [0005](0005-claude-single-tool-no-network.md) | Claude は 1 ツールだけの tool use。ネット・ファイル・DB に触れない | Accepted | 2026-11-03 |
| [0006](0006-gemini-tts-and-sha256-audio-cache.md) | Gemini-TTS と、文の SHA-256 を鍵にした音声キャッシュ | Accepted | 2026-11-03 / 11-06 |
| [0007](0007-serendipity-by-embedding-distance.md) | セレンディピティは埋め込みの距離で選ぶ | Accepted | 2026-11-06 |
| [0008](0008-units-and-thumbs-up-loop.md) | 単位と、👍 で育てる改善ループ | Accepted | 2026-11-06 |
| [0009](0009-mcp-built-then-removed.md) | MCP を作って、外した | Superseded | 2026-11-04 / 11-06 |
| [0010](0010-one-letter-per-segment.md) | 1 枠 1 通 | Accepted | 2026-11-07 |
| [0011](0011-readings-from-work-data-and-per-unit.md) | 読みは作品データから、台本係の読みは単位ごと | Accepted | 2026-11-07 |
| [0012](0012-public-radio-contents.md) | 公開ラジオは、持ち主のお便りと一言を返したお便り | Accepted | 2026-11-05 / 11-07 |
| [0013](0013-daily-broadcast-after-hackathon.md) | 放送のタイミングは日次でよい（ハッカソン後） | Accepted | 2026-11-07 |
| [0014](0014-demo-data-as-labeled-ai-personas.md) | デモデータは［デモ用］と明示した AI ペルソナ | Accepted | 2026-11-03 |
| [0015](0015-subagent-driven-development-with-codex.md) | サブエージェント駆動の開発と、Codex の第二の目 | Accepted | 2026-11-03 |
| [0016](0016-count-then-act-limits.md) | 上限とレート制限は「数えてから動く」でよい | Accepted | 2026-11-04 / 11-06 |

新しい ADR は次の番号で足します。判断を覆すときは古い ADR を消さず、Status を Superseded にして新しい ADR へのリンクを書きます。
