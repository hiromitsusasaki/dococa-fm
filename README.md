# Dococa FM

世界のどこかの、好きなものが流れてくるラジオ。

Built with Claude: Japan 2026 への応募作です。

## この作品について

- **期間内の新規制作。** このリポジトリのコードは、イベント期間中に新しく書いたものです。
- **musico（2020）から引き継いだのは、問題設定と学びだけ。** コード・文面・データ・UI は流用していません。

### musico との違い

1. DJ が語る。作品の曲間を、ラジオの DJ が声でつなぎます。
2. 一致率を出さない。数字で人や作品を測りません。
3. お便りは原文のまま、時間差で届く。要約も加工もしません。

## 動かす

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 鍵を入れる（.dev.vars は gitignore 済み）
pnpm dev          # http://127.0.0.1:5173
pnpm test         # vitest + @cloudflare/vitest-plugin
pnpm typecheck
```

必要な鍵は `.dev.vars.example` に一覧があります。鍵は `.dev.vars` と Cloudflare secrets にだけ置き、リポジトリには入れません。
