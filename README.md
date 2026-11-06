# Dococa FM

世界のどこかにいる誰かの好きなものが聴こえてくるラジオ。

Built with Claude: Japan 2026 への応募作です。

## 何をするか

ホームの「ラジオをつける」を押すと、世界のどこかの誰かの好きなものが流れ続けます。AI の DJ が作品を紹介し、その作品に誰かが書いた一行の「お便り」が、原文のまま読まれます。聴くだけでよく、返事は義務ではありません。スマホのブラウザでも聴けます。

- **サインインなしでできること。** ラジオを聴く、お便りに「私も」を押す、「一言を送る」。
- **Google でサインインするとできること。** 好きなものの登録、Spotify の取り込み、「お便りを送る」、「あなたのラジオ」の公開、マイページ（届いた反応、聴いたお便りのふり返り）。公開すると「〇〇さんのラジオ」として他の人が聴けます。公開に出るのはラジオネームだけで、Google の名前とメールアドレスは出ません。
- **言語。** 画面は日本語と英語を選べます。言語を英語にすると、DJ も英語で話し、お便りは英訳で読みます。日本語圏以外のお便りは、選んだ言語の訳を読み、原文を切り替えて確かめられます。
- **土地。** 設定の「土地」は、国と都道府県・州から選びます。

### 三枠とダイヤル

番組は 3 つの枠でできています。

| 枠 | 中身 | パーソナライズ |
|---|---|---|
| 近く | あなたの履歴やお便りにつながる作品 | する |
| 隣 | あなたの好きなものを好きな人が、ほかに好きな作品 | する |
| 遠く | 世界のどこかの一通。あなたとの接点は問わない | しない。常に 1 枠は入る |

ダイヤルは「遠く」の強さを聴く側が動かすものです。「遠く」に回すほど、知らない作品が増えます。

## 材料の三層と見つけた声

DJ が語る材料は 3 層に分かれ、混ぜません。

1. **作品のデータ。** 題名・作者・年・画像など、公開 API や貼られた URL から得たもの。
2. **お便り。** この番組のリスナーが書いた一行。原文のまま載せ、翻訳は併記します。
3. **ネットで見つけた声。** 公開されたコメントのうち短いもの（100 字まで）を、投稿者名と元の URL を付けて引用します。「この番組へのお便り」とは別の枠に出し、各作品ページに削除依頼の口を置いています。出典の無い声は作りません。

見つけた声は、ローカルの収集バッチで YouTube のコメントから候補を拾い、Claude に ID だけを選ばせ、本人が目で確かめてから投入します。

## AI がすること、しないこと

**すること。** 番組の台本（曲間の DJ の語り）を書く。お便りの判定（公開してよいか）と、日本語圏以外のお便りの翻訳。デモ用ペルソナのお便りの下書き。

**しないこと。**

- お便りを要約・言い換え・加工しない。画面でも番組でも原文のままです（前後の空白だけ除いて保存します）。非日本語のお便りは、番組では訳を読み、画面には訳の下に原文を出します。
- 時事を言わない（日付・ニュース・流行・季節の挨拶）。
- 数字で人や作品を測らない（件数・ランキング・一致率・再生回数）。
- 出典の無い「見つけた声」を作らない。

これらは台本を保存する前に、モデルを使わない決定的な検査で確かめます。

| 検証項目 | 見ること |
|---|---|
| verbatim | お便りの行が、データベースの原文と一字違わない |
| sources | 見つけた声に、出典の URL と投稿者名が付いている |
| topical | 時事の語（昨夜・先日・公開中・新作など）や、人数・順位・作品数などの数え方が DJ の行に無い |
| pii | 住所・郵便番号・メール・電話・URL・アカウント情報が無く、DJ がお便りを引用していない |

機械検査の対象は住所・郵便番号・メール・電話・URL です。名前と勤務先の組み合わせは、投稿時の判定とプロンプトで防ぎます。読み上げ（Web Speech / Gemini-TTS）は検査の外で、検査するのは保存する台本までです。作品の題名と作者名は、その作品へのお便りと同じ判定で確かめます。

検査に落ちた台本は、理由を添えて 1 回だけ書き直させます。それでも通らなければ、定型文だけの番組に切り替えます。検証に落ちた番組は、保存も再生もされません。

**道具の制限。** 台本を書くモデルに渡す道具は、台本を返す 1 つだけです（ネットも、ファイルも、DB も触れません）。見つけた声の収集バッチでは Claude Agent SDK を使い、道具を 1 つも渡さないうえで、呼ばれたら必ず拒否する hook も付けています。hook を使うのはこの収集バッチだけで、Worker 本体には入っていません。

## この作品について

- **期間内の新規制作。** このリポジトリのコードは、イベント期間中に新しく書いたものです。
- **過去の自作との関係。** 2020 年に作った音楽の出会いの Web サービス「musico」から引き継いだのは、問題設定と学びだけです。コード・文面・データ・UI は流用していません。
- **ベッド音。** ベッド音は ffmpeg で生成したピンクノイズです（第三者の素材は使っていません）。

### musico との違い

1. DJ が語る。作品の曲間を、ラジオの DJ が声でつなぎます。
2. 一致率を出さない。数字で人や作品を測りません。
3. お便りは原文のまま、時間差で届く。要約も加工もしません。

## eval

番組を 20 回作り、保存された検証レポートと台本を集計します。方法と走らせ方は [docs/eval/README.md](docs/eval/README.md) にあります。

| 項目 | 結果 |
|---|---|
| verbatim の通過率 | 鍵投入後に 20 回回して記入 |
| sources の通過率 | 鍵投入後に 20 回回して記入 |
| topical の通過率 | 鍵投入後に 20 回回して記入 |
| pii の通過率 | 鍵投入後に 20 回回して記入 |
| 「遠く」枠が 1 つ以上ある回の率 | 鍵投入後に 20 回回して記入 |
| 出所のある DJ 行の率 | 鍵投入後に 20 回回して記入 |

（まだ実走していないため、上の欄は空です。）

## 動かす

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 鍵を入れる（.dev.vars は gitignore 済み）
pnpm db:migrate:local   # 初回だけ。pnpm dev の前に
pnpm dev          # http://127.0.0.1:5173
pnpm test         # vitest + @cloudflare/vitest-plugin
pnpm typecheck
```

必要な鍵は `.dev.vars.example` に一覧があります。鍵は `.dev.vars` と Cloudflare secrets にだけ置き、リポジトリには入れません。

### デプロイ

Cloudflare Workers に載せます（D1 と R2 を使います）。本番の URL は https://dococafm.app です。

```bash
pnpm wrangler login
pnpm wrangler d1 create dococa            # 出力の database_id を wrangler.jsonc の d1_databases に書く
pnpm wrangler r2 bucket create dococa-audio
pnpm wrangler secret put ANTHROPIC_API_KEY   # .dev.vars.example の鍵を 1 つずつ（ADMIN_TOKEN、SESSION_SECRET、SPOTIFY_CLIENT_ID、GOOGLE_TTS_SA_JSON、GOOGLE_OAUTH_CLIENT_ID、GOOGLE_OAUTH_CLIENT_SECRET、TMDB_API_KEY、YOUTUBE_API_KEY、任意で GOOGLE_BOOKS_API_KEY）
pnpm db:migrate   # migrations/0001〜0007 を順に当てる
# wrangler.jsonc の routes にカスタムドメイン、vars.PUBLIC_ORIGIN にその origin（例 https://dococafm.app）を書いてから
pnpm run deploy   # pnpm deploy は pnpm 組み込みの別コマンドなので、run を付ける
```

`wrangler.jsonc` の `PUBLIC_ORIGIN` は、リポジトリでは空です。空のままデプロイすると、`/healthz` 以外のすべてのリクエストが 500（`Server is not configured`）になります。デプロイ前に `vars` へ本番の origin を書いてください。`--var` で渡す方法は、次の `pnpm run deploy` で空に戻るので使いません。開発では `.dev.vars` の `PUBLIC_ORIGIN=http://127.0.0.1:5173` を使います。Spotify の redirect URI も同じ origin に合わせます。

`DEV_SKIP_CLAUDE=1` は開発専用です。`ANTHROPIC_API_KEY` が空のときに、お便りの判定と翻訳を素通しにします。本番の `vars` や secrets には入れません（入れなければ、鍵が空のときお便りの投稿は 503 で止まります）。

### Google サインインについて

Google Cloud の OAuth クライアント（ウェブ アプリケーション）を作り、承認済みのリダイレクト URI に `https://dococafm.app/auth/google/callback`（開発は `http://127.0.0.1:5173/auth/google/callback`）を登録します。同意画面は「本番」に公開します（テスト中のままだと、登録したテストユーザーしか入れません）。`GOOGLE_OAUTH_CLIENT_ID` が空のあいだ、`/auth/google` は 503 を返します。

### Spotify 連携について

Spotify 連携は開発モードのため、許可リストに入っているアカウントだけ使えます（本人と知人）。Spotify を使わない方は、サインインのうえ、作品の URL の貼り付けや検索で好きなものを登録できます。

### 守りと制限

書き込みの `POST` は同一オリジンのみ、好きなものの登録・お便り・マイページはサインイン必須、`/admin/*` は `ADMIN_TOKEN` 必須、レート制限は IP とリスナーごとに 1 分 20 回です。詳しくは [SECURITY.md](SECURITY.md) にあります。レート制限のカウンタは Worker の isolate ごとのメモリにあるため、isolate をまたぐ厳密な上限ではありません。番組の作成は D1 を数える 1 日の上限（`EPISODE_DAILY_LIMIT`、`EPISODE_GLOBAL_DAILY_LIMIT`）が、クラウドの声は 1 日に合成する行数の上限（`CLOUD_TTS_GLOBAL_DAILY_LIMIT`、既定 3000）が、DJ の語り（単位）は 1 日に作る数の上限（`UNIT_DAILY_LIMIT`、既定 1000）が、お便りと一言は全員で 1 日に受け付ける数の上限（`LETTER_GLOBAL_DAILY_LIMIT`、既定 500。判定と翻訳で Claude を呼ぶため。「私も」は止めない）が最後の歯止めです（`0` は停止）。単位が上限に当たった日は、新しいお便りを定型の手渡しだけで読みます。同じ行の音声は全員で共有し、上限を超えると `GET /tts` は 503 を返してブラウザの音声に切り替わります。ただし判定は原子的ではなく同時実行で数回超えることがあり、cookie を捨てる 1 人に全体の上限を使い切られうることも、[SECURITY.md](SECURITY.md) の既知の制限に書いています。

### public 化前チェックリスト（本人）

- [ ] リポの Settings → Code security で **Secret scanning** と **Push protection** を有効にする。
- [ ] Settings → Actions → General で、fork からの pull request の workflow は承認が要る設定にする（"Require approval for all outside collaborators"）。
- [ ] Settings → Branches（または Rulesets）で、`main` への直接 push を自分だけに限定する。
- [ ] 手元で `gitleaks detect --source .` を実行し、検出が 0 であることを確かめる（履歴全体が対象）。
- [ ] `.gitignore` に `.dev.vars`、`*.pem`、`.wrangler/`、`.found/` があることを確かめる（済み）。
- [ ] CI（`.github/workflows/ci.yml`）が main で緑になっていることを確かめる。
- [ ] 上が済んでから、Settings → General → Danger Zone で private を public に切り替え、提出する。

## MCP で聴く

設定画面に表示される `/mcp/<token>` の URL が、番組を取り出す口です。トークンは URL の一部で、他の認証は要りません。URL を知っている人は、あなたの名前でお便りを送れます。漏れたら設定画面で作り直してください。

- Claude: 設定のコネクタ（カスタムコネクタ）に URL を追加し、認証は「なし」にします。
- ChatGPT: コネクタ（開発者モード）に MCP サーバーとして URL を追加し、認証は「なし」にします。
- Gemini: 接続するアプリ（MCP）に URL を追加し、認証は「なし」にします。

使えるのは `get_episode`、`get_item`、`post_letter`、`react` の 4 つだけです。

他社のアシスタントの中では、お便りの原文がそのまま読まれることを保証できません。原文はいつも Dococa FM の画面で確かめられます。

## デモ用のお便りについて

デモの密度を出すため、AI が作った架空のリスナー（多国籍のダミーアカウント）が、好きな作品に一言ずつ書いています。

- 画面・MCP・番組では、ラジオネームの横に「［デモ用］」の印が付きます。本人や知人のお便りと同じ場所に並びますが「デモ用」の印で見分けられます。
- 日本語圏以外の人は英語で書き、日本語の番組では日本語訳を、英語の番組では原文を読みます。画面には原文を併記します。
- 書かれた文は、判定を通ったあと一字も直さずに載せます。人物像は `docs/demo/personas.json` にあり、実在の人物ではありません。

```bash
# items.txt: 作品の URL を 1 行ずつ。ADMIN_TOKEN と ANTHROPIC_API_KEY は .dev.vars に
pnpm seed --items items.txt --personas 30 --dry-run   # 書かせるだけ。投入しない
pnpm seed --items items.txt --personas 30             # 投入して、作品ページに原文が出ることを確かめる
```

### 事前生成（運用）

お便りが保存されると（`POST /letters`、MCP の `post_letter`、`/admin/letters`、`/admin/found`）、Worker が応答のあとで、そのお便りの DJ の語り（単位）と音声を作っておきます。単位は日本語と英語の両方を作ります。15 分ごとの Cron（`wrangler.jsonc` の `triggers`）が、単位の無いお便りと音声の揃っていない単位を、日本語・英語の順に言語ごと 1 回 20 件まで埋めます。`waitUntil` の仕事は応答から 30 秒ほどで打ち切られるため、`/admin/found` で多数の声を入れたときに応答の直後に用意されるのは先頭の数件で、残りは Cron か `/admin/prepare` が拾います。シードで大量に投入した直後は、手で回します。

```bash
# 言語ごとに 1 回 20 件（limit は 1〜50）。remaining の 4 つの数が 0 になるまで繰り返す
curl -s -X POST "$DOCOCA_ORIGIN/admin/prepare" -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"limit":20}'
# => {"units":..,"audio":..,"failed":..,"remaining":{"units":{"ja":..,"en":..},"audio":{"ja":..,"en":..}}}
```

`GOOGLE_TTS_SA_JSON` が空のあいだは単位だけ作り、音声は `remaining.audio` に残ります。クラウドの声の 1 日の上限（`CLOUD_TTS_GLOBAL_DAILY_LIMIT`）に当たると音声はそこで止まり、翌日の Cron が続きを作ります。

## 後で

Gemini-TTS はサービスアカウントの JWT で認証するように切り替え済みです（鍵は secret `GOOGLE_TTS_SA_JSON`）。`GOOGLE_TTS_API_KEY` はもう読みません。
