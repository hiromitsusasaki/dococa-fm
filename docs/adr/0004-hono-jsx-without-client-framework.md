# 0004 Hono JSX と、フレームワーク無しのクライアント

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

画面はホーム・作品ページ・送るページ・マイページなど、ほとんどが読むだけのページです。動きが要るのはラジオのプレイヤーだけです。Worker と同じ言葉で書け、依存が少なく、Workers の上でローカル開発できるものが欲しかった。

## Decision

ページは Hono 4 の JSX でサーバー描画し、クライアントはプレイヤーまわりの部品だけを hono/jsx/dom で書きます。React などの SPA フレームワークは入れません。ビルドは Vite と Cloudflare の Vite プラグインです。

比べたもの:

| 候補 | 見送った理由 |
|---|---|
| HonoX | README が alpha と明記し、同じメジャー版の中で壊れる変更がある |
| Astro + Cloudflare | 安定していて次点。ただ Hono が主役でなくなり、二つの作法を持つことになる |
| React の SPA + Hono の API | サーバー描画が無く、初回表示と OGP に弱い |
| React Router、TanStack Start、SvelteKit など | Hono と同居させるのが標準の手順でなく、学ぶ量が増える |

## Consequences

- 依存は Hono・zod・Anthropic SDK など少数で済んだ。i18n は自前の辞書（日本語と英語を同じキーで持ち、差が出るとテストが落ちる）。
- プレイヤーの JS は小さく保てた。ラジオのページのスクリプトは gzip で数 kB に収まっている。
- 部品が増えると、状態の受け渡しを手で書く量が増えた（オンエアの欄とプレイヤーの「私も」の共有など）。
- CSP は付けていない。プレイヤーが JSON の script ブロックとバンドルを使うため（SECURITY.md）。

## Related

- 設計書 §4.9
- [docs/DESIGN.md](../DESIGN.md)
