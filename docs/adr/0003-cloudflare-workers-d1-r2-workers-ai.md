# 0003 Cloudflare Workers + D1 + R2 + Workers AI

- **Status:** Accepted
- **Date:** 2026-11-03（Workers AI は 2026-11-06 に追加）

## Context

1 人で 5 日のうちに、端から端まで動くものを本番に出す必要がありました。聴く人が増えても固定費が膨らまず、音声をキャッシュして全員で共有できる置き場も要りました。

## Decision

1 つの Cloudflare Worker にすべてを載せます（本人の決定）。

- **Workers（Paid）。** ページ・API・プレイヤーの配信・事前生成の Cron を 1 つの Worker で持つ。
- **D1。** お便り・作品・リスナー・番組・単位・聴いた記録。日次の上限もここで数える。
- **R2。** 行ごとの音声（[0006](0006-gemini-tts-and-sha256-audio-cache.md)）。
- **Workers AI。** 作品の埋め込み（bge-m3）。2026-11-06 の Phase 4 で足した（[0007](0007-serendipity-by-embedding-distance.md)）。
- **Cron Triggers。** 15 分ごとに、単位と音声の無いお便りを埋める。

## Consequences

- Claude Agent SDK は Node のプロセスなので Worker の中では動かない。Worker からは Messages API を直接呼ぶ（[0005](0005-claude-single-tool-no-network.md)）。Agent SDK はローカルの収集バッチだけで使う。
- D1 は 1 回の実行あたりのクエリ数に上限がある。主な経路のクエリ数をテストで数えている。
- `waitUntil` の仕事は応答のあと約 30 秒で打ち切られる。大量に投入したあとは Cron か管理用の経路が残りを拾う。
- Workers AI はローカルでは動かない。開発時はリモートに繋ぎ、テストでは偽の AI を渡す。
- レート制限のカウンタは isolate ごとのメモリにある。厳密な上限ではない（[0016](0016-count-then-act-limits.md)）。

## Related

- 設計書 §4.9、追記 K・L
- README「デプロイ」、SECURITY.md
