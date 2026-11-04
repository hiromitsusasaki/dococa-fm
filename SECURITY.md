# Security

## 脆弱性の報告

このリポジトリの **Security** タブから「Report a vulnerability」（GitHub Security Advisories の非公開報告）で送ってください。公開の issue には、再現手順や鍵を書かないでください。個人のメールアドレスでは受け付けていません。

## 見つけた声・お便りの削除依頼

作品ページ（`/items/:id`）の「ネットで見つけた声」には、出典の URL と投稿者名を付けています。自分の書いた声を外してほしいときは、次のどちらかで依頼できます。

1. アプリの `/takedown` で、声の出典 URL と理由を送る。
2. このリポジトリの issue に、出典 URL を書いて依頼する（声の中身は書かなくて構いません）。

運営は依頼を確認し、該当の声を管理 API（`POST /admin/letters/:id/reject`）で非公開にします。一度非公開にした出典 URL は、収集バッチでも再投入されません。

お便りの不適切な内容は、各お便りの「通報」（`POST /letters/:id/report`）から知らせてください。運営が確認し、同じ管理 API で非公開にします。

## 守りの範囲

- `/admin/*` は `ADMIN_TOKEN`（Bearer）が必須です。`/mcp/<token>` は推測できない token だけが鍵です。
- 書き込みの `POST` は同一オリジンのみです。`Origin` があれば `PUBLIC_ORIGIN` と一致が必要で、無いときは `Sec-Fetch-Site` が `same-origin` か `none` のときだけ通します（curl などブラウザ以外は通ります。Cookie を持たないため）。
- レート制限: `POST /letters`、`/episodes`、`/episodes/:id/next`、`/start`、`/takedown`、お便りの通報、`GET /put?itemId=|url=`、`/api/*`、`/mcp/*` は、IP（`CF-Connecting-IP`）とリスナーのそれぞれで 1 分 20 回までです。超えると 429 を返します。
- 番組の作成は、リスナーごとの 1 日の上限（`EPISODE_DAILY_LIMIT`、既定 10）と、全体の 1 日の上限（`EPISODE_GLOBAL_DAILY_LIMIT`、既定 300）があります。クラウドの声（Gemini-TTS）には全体の 1 日の上限（`CLOUD_TTS_GLOBAL_DAILY_LIMIT`、既定 50）があり、超えるとブラウザの音声に切り替わります。どの上限も `0` は停止、日は日本時間で数えます。
- `secureHeaders()` で標準のセキュリティヘッダを付けています。CSP は付けていません（プレイヤーが JSON の script ブロックとバンドルを使うため）。

### 既知の制限

レート制限のカウンタは Worker の isolate ごとのメモリにあり、isolate をまたいで共有されません。実効の上限は表の値より緩くなりえます。コストに直結する番組作成は、D1 を数える全体の 1 日の上限が最後の歯止めです。Cloudflare 側の Rate Limiting ルールを足すと、isolate をまたいだ上限になります。
