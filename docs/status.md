# status — Dococa FM の現在地

> 新しいセッションはまずここを読む。更新はタスクの区切りごと（最新を上に）。

## 2026-11-08 提出前の仕上げ（Phase 8。本番は Phase 7 = 71ccfc6d。次は本人のデプロイ → 録画 → 提出）

11-07 深夜から 11-08 の提出（20:00 JST）に向けて、審査員の目のレビュー・仕様と実装の矛盾の監査・本番の画面の総当たり（いずれも `~/agent_workspace/workspace/2026-11-07-dococa-fm-submission/` の `judge-review.md`、`audit-spec.md`、`smoke/report.md`）を元に直した。設計の変更はしない（ダイヤルのロック・選曲・migration・音声の作り直しは触らない）。本人の決定（11-07 深夜）: 画面の変更 1〜6 と、明示的に頼んだお便りは自分のものでも流す、サインイン文言の修正を承認。仕様・UI/UX を大きく変えるときは事前に本人に確認する。

### 入ったもの（ローカル main。push・デプロイは本人）

- 文書（1752ab4, dbd64c8）: README の冒頭に「なぜ作ったか」「30 秒で試す」「AI に引いた線」「どう作ったか」。文書とコードの食い違いを修正（自分のお便りは自分のラジオの選曲に入らない、外に出るのは遠さの値ではなく枠の札、ダイヤルは一言と私もも数える、共有ページは反応の欄、eval 表は Phase 5 の 6 席の build、Phase 1 は 17 タスク、追記は A〜O、fork 向けの wrangler.jsonc の値、X の player カードは未確認）。public 化チェックリストに Private vulnerability reporting と人名・パスの見直しを追加。history.md の古い数字は process.md への参照に。
- 画面（8c1c100, c52b5dd, 4d17d4d, 767b470）: `/about` に「なぜ作ったか」の段と 4 つの線をまとめた文（［デモ用］の混在も明記）、「返さなくてもかまいません」。ホームの説明文を「スイッチを入れると…ダイヤルを右に回すほど、遠くの棚から届きます」に。「いま流れている」のお便りの下に「原文のまま読んでいます」。全ページに既定の OGP（/kv.jpg）と題（「〇〇 · Dococa FM」）、HTML の 404 ページ。ホームのカードは人のお便りを［デモ用］より先に。390px の面はスイッチが 1 行目、音量とダイヤルが 2 行目。オンエア欄の「いま」の線がサムネイルに重ならない。スクリーンショット `docs/screenshots/2026-11-08-p8-*.png`。
- 画面（a049643, 9e09ce2）: 明示的に頼んだお便り（カード・`/?letter=`・`letterId`）は、公開のお便りか出典のある見つけた声なら、自分のものでも流す（自動の選曲・反響・除外は変えない。自分のお便りのカードも「このお便りから聴く」になる）。`/put` のサインイン文言を「お便りを送るには、サインインが要ります。」に。訳を見せているときは「訳して読んでいます（原文は書いたまま）」、`/about` は「書き足しも言い換えもせずに読みます（言葉の違う人には、訳を添えて）」。

### 本人作業（この順）

- [ ] opus のレビューの指摘を見て（司令塔が要約する）、`pnpm run deploy`（migration なし）。
- [ ] 本番の自分のアカウントでお便りを 2 通送る（ダイヤルが目覚める条件。いま 1 通）。
- [ ] 動画の撮り直し（司令塔が本番で録画 → mix → render。`~/agent_workspace/workspace/2026-11-07-dococa-fm-submission/video/`）。通しで見て、ナレーションの読みを聴く。
- [ ] 提出フォーム（`submission-form.md`。概要は改稿済み 485 字。§7 の【要確認】を本人の言葉で）。
- [ ] public 化チェックリスト → private → public。
- [ ] 提出。

### 既知（提出後）

- `test/worker/program/prepare.test.ts` が 0〜2 件、不定に落ちる（c0ceade でも再現。実装の変更と無関係）。
- verify の MEASURE に 人気・いいね・フォロワー・「多くの人が」が無い（足すと保存済みの単位が 2 度目の検査で落ちうるので、提出後に）。
- `/start`・`/stations/world`・Spotify の設定欄はリンク無しで残る。`listeners.mcp_token` の残骸。

## 2026-11-07 Phase 6 完了（最終レビュー前・ローカル）。次は本人作業 → デプロイ

Phase 6（ラジオの面・ホームとヘッダ・お便りの直リンクと反応の点・取り下げと公開ラジオの一覧・冷えた入口・デモの反応・冒頭の一行・読み・お便りの共有ページ・動画の種類・5 曲の BGM・about の挿絵・費用のメモ）の Task 1〜5、7〜12 は main にコミット済み（push していない）。Task 6（cookie の無い GET でリスナー行を作らない）だけ、ハッカソン後に回す（本人了承待ち）。全体レビュー（Claude と Codex）の指摘は、返ってきたら本人に見せてから直す。本番は Phase 5 のままなので、下の本人作業を上から順に済ませる。

### 本人作業（Phase 6 のデプロイ。この順）

- [ ] `pnpm db:migrate`（0022 `reactions_seen`、0023 `units_lead`: **単位を全部消す**、0024 `readings`、0025 `video_kind`: YouTube の作品を `video` に）。
- [ ] 続けてすぐ `pnpm run deploy`。終わった時刻（UTC）を控える（例 `DEPLOYED_AT=2026-11-08T03:12:00Z`）。
- [ ] デプロイ前の単位を消す: `pnpm wrangler d1 execute dococa --remote --command "DELETE FROM units WHERE created_at < '$DEPLOYED_AT'"`。migrate と deploy のあいだに古い Worker（cron か誰かの `next`）が冒頭の一行を知らない台本で単位を作り直していると、新しいコードの検証（`lead:`）で落ち続け、作り直されないため（最終レビュー opus I1）。デプロイ前に作られた単位はどれも古い形なので、時刻で切れば安全。
- [ ] 0025 で `video` に移った作品のベクトルを作り直させる: `pnpm wrangler d1 execute dococa --remote --command "UPDATE items SET vec = NULL WHERE kind = 'video'"`（埋め込みの文が `[music]` のままのため。次の `/admin/prepare` が最初に埋め直す。最終レビュー opus M6）。
- [ ] `/admin/prepare` のループ（読み → 単位 → 音声の順に進む）。`remaining.readings`（作品の題名と作者の読み。作品ごとに Claude 1 回）、`remaining.units`（Claude 約 200 回）、`remaining.audio`（約 1,000 行。`gaveUp` は、ブラウザの声が読む行を含む単位の数）が ja/en とも 0 になるまで回す。上限は `CLOUD_TTS_GLOBAL_DAILY_LIMIT`（本番は 8000）の内。コストは [docs/cost.md](cost.md)。
- [ ] デモの反応を付ける。先に `read -rs PROD_ADMIN_TOKEN` で本番のトークンをシェルに読み込み、`ADMIN_TOKEN="$PROD_ADMIN_TOKEN" pnpm seed:reactions --origin https://dococafm.app --dry-run`（書かせるだけ）で確かめてから、本番の `--per 2`。あとで自分のお便りに付けるなら `--letters <id,...>`。
- [ ] 聴いて確かめる: 冒頭の一行「…という曲の紹介です」、読み（PSY → サイ、大船渡 → オオフナト）、「別の人」、5 曲の BGM が回ごとにランダムに変わること（音量は `src/client/audio.ts` の `BED_VOLUME`）、ブラウザの声への切り替えが回ぜんぶではなく行ごとになったこと。
- [ ] 画面を確かめる: ホーム（「お便りを送る」がオンエアの欄の上、「これまでの番組」の行、お便りが届いた公開ラジオ、2 回目の訪問でヒーローが畳まれる、サインイン済みのヘッダを 390px と 1120px で）、`/letters/<id>` の共有ページと X の Card Validator（player カードは許可が要ることがある）、`/?letter=<id>` のリンク、反応の点、`/me` の取り下げ、`/about` の挿絵。iPhone の Safari で、埋め込みプレイヤーの最初のタップで声が出るか。
- [ ] 任意: あとで `pnpm wrangler secret delete CLOUD_TTS_GLOBAL_DAILY_LIMIT` で既定の 3000 に戻す。

### ハッカソン後

- Task 6: cookie の無い GET でリスナー行を作らない（クローラーで行が増える。`SECURITY.md` の既知の制限）。
- Cloudflare 側の防御: WAF のマネージドルールと Bot Fight Mode（検証済みボットは許可して、OGP のクローラーを通す）、書き込みの経路（`POST /letters`、`/stations/*/next`、`/start`、`/admin/*`）だけ Managed Challenge、IP ごとの Rate Limiting ルール。
- 1 日 1 回の放送（日本時間の深夜の Cron で、お便りは翌日に読まれる）: [docs/broadcast.md](broadcast.md)。
- 費用の削減: 英語の単位の遅延生成、判定と翻訳を Haiku に（`CLAUDE_MODEL_JUDGE`）、音声の鍵の分割、再試行の上限: [docs/cost.md](cost.md)。
- Chirp 3 HD を別の TTS として足す（読みを `yomigana` のカスタム発音で渡す）。`TTS_PROVIDER` の切り替えの後ろに置く。
- 本人が選ぶ UI の細かい直し（楽しさの項目）。
- 冷えた入口（Task 5）はほとんど効かない: 最初の番組には前のセグメントが無く、最初のお便りを聴いた時点で「冷えた」でなくなるため（最終レビュー opus M3）。「聴いた記録が N 件未満でお気に入りが無い」を冷えたとみなす、国を聴いた記録から読む、などは本人が決める。
- 共有ページの `og:image` が無い作品では `/kv.jpg` を出すので、リンクの展開（X・Slack など）が cookie なしで取りに来る。画像はセッションの外にした（最終修正）が、ページ自体の取得はまだ行を 1 つ作る（Task 6）。

## 2026-11-07 Phase 5 完了（本番に反映済み）

Phase 5（TTS の見張りと指示文・ヘッダの言語切替・オンエアの欄・設定の整理と `radio-xxxxxx`・自作の BGM・ホームの作り替え・説明ページ・締めのドキュメント）の Task 1〜8 は main にコミット済み。本番には 2026-11-07 に反映済み（Phase 5 と音声の鍵 v4。0021 まで当て、`/admin/prepare` で音声を作り直した）。下の本人作業は済んだものを残してある。

### 本人作業（Phase 5 のデプロイ。反映は済み。聴く・見る確認は本人がまだ）

- [x] `pnpm db:migrate`（0021: 音声の鍵 v4。`tts_audio` を空にし `units.audio_ready` を戻す。当日の TTS 上限カウンタも空になる（本番は `CLOUD_TTS_GLOBAL_DAILY_LIMIT=8000` のまま）ので、日本時間の日の早いうちに当てるか、prepare の回数を見ながら進める）。
- [x] `pnpm run deploy`。
- [x] `/admin/prepare` のループ（`{"limit":8}` 程度で、`remaining.audio` が ja/en とも 0 になったら止める。約 700 行、上限の内）。`remaining.gaveUp` は、合成を諦めた行を含む単位の数で、その行からその回の終わりまではブラウザの声が読む（`audio` には数えない）。諦めた行をもう一度試すときは、`pnpm wrangler d1 execute dococa --remote --command "DELETE FROM tts_audio WHERE synth_count >= 6 AND bytes = 0"` のあと `pnpm wrangler d1 execute dococa --remote --command "UPDATE units SET audio_ready = 0 WHERE audio_ready = 2"` を流して、またループする（1 通だけなら `/admin/units` の 👎 で作り直しても 0 に戻る。ただしお便りの本文の行は作り直しでも変わらないので、その行の `tts_audio` は消す）。最初の 1〜2 回で `failed` が増えるなら、英語の見張りが新しい遅めの指示文に対して厳しすぎる可能性がある。`src/worker/tts/google.ts` の `SECONDS_PER_OTHER_CHAR`（かな・漢字以外の 1 文字）を 0.125 → 0.14 に緩めて再デプロイ。
- [ ] 聴いて確かめる: 冒頭の挨拶（指示文が読まれていないか）、日本語と英語の回の話し方、BGM の音量感（声の 16 dB ほど下。大きい/小さいなら `src/client/audio.ts` の `BED_VOLUME`）。
- [ ] 画面を確かめる: ヘッダの言語切替、ホーム（ダイヤル、カードを押して即再生、送るモーダル、直近 3 番組）、`/settings`（公開 URL）、`/about`。
- [ ] 任意: あとで `pnpm wrangler secret delete CLOUD_TTS_GLOBAL_DAILY_LIMIT` で既定の 3000 に戻す。

## Phase 7 の進み（計画: `docs/superpowers/plans/2026-11-07-dococa-fm-phase7.md`、設計: 追記 O）

2026-11-07 夕方の画面ごとの本人フィードバック。migration なし。

デプロイ: migration なし。`pnpm run deploy` だけ。番組の作り置き（`/admin/prepare`）は不要（単位の形は変わらない）。デプロイ後に本人が `pnpm seed:reactions`（dry-run → `--per 2`。上の Phase 6 の本人作業と同じ手順）と、二重読みの 2 クリップの削除（本番の `tts_audio` と R2 の clip）を行う。

### 本人作業（Phase 7 のデプロイ。Phase 6 の残りと合わせて）

- [ ] `pnpm run deploy`（Phase 7 は migration なし。Phase 6 の 0022〜0025 がまだなら、先に上の Phase 6 の本人作業を順に済ませる）。
- [ ] `pnpm seed:reactions`（dry-run → `--per 2`。手順は Phase 6 の本人作業）と、二重読みの 2 クリップの削除。
- [ ] 確かめる: X の Card Validator での `/letters/<id>` の player カード、iPhone の Safari と X のアプリ内ブラウザでの最初のタップの声、初回チュートリアル、ダイヤルのロックと目覚め、マイページの順。
- [ ] もう一方の端末（main-mac か ops-mac）の `.dev.vars` と `pnpm db:migrate:local`（下の public 化前チェックリスト）。
- [ ] 提出物の動画と概要の文章。
- [ ] 提出後: WAF と Bot の Managed Challenge（上の「ハッカソン後」の Cloudflare 側の防御）。
- [ ] public 化（下の public 化前チェックリストが済んでから、本人が private → public に切り替える）。

| Task | 内容 | 状態 |
|---|---|---|
| Task 1 | ホーム（送るパネル・私も／一言／共有を「いま流れている」へ・番組を角丸パネルに・X 共有） | 完了（2026-11-07。共有は `ShareLinks` / `wireShare` を /me と共用。station.js 7.44 kB gzip。追記の「名無しの一言の前にラジオネームとお住まい」も完了: 名前の無い人の一言の欄に畳んだ 1 行、`POST /letters` の reply で設定と同じ検証のうえ先に保存。station.js 7.64 kB gzip） |
| Task 2 | 1 枠 1 通・公開ラジオは持ち主のお便りと一言を返したお便り | 完了（2026-11-07。1 枠 = 1 通: つなぎ → 冒頭の一行 → intro → 手渡し → お便り → after → 反応（反響の枠は従来どおり）。`bridge.sameWork` は作らない（キーを外した。保存済みの回の文はそのまま描く）。候補はお便り単位: 他の人の公開のお便りと出典のある見つけた声（一言・私もは反響の反応としてだけ流れる）。直近 3 枠の作品と 7 日以内に聴いたお便りを外す（作品が待つのは、そのお便りを全部聴いたときだけ）。1 つの作品の中では、聴いていないお便りの古い順。公開ラジオ `public:<ownerId>` は、持ち主の公開のお便り（letter）と、持ち主が公開の一言を返した公開のお便り。好きなものからは作らない。空ならページに「まだお便りがありません」（`station.publicEmpty`）。D1 の文は `POST /stations/mine/next` 19（冷えた入口 20）、公開ラジオ 14） |
| Task 3 | マイページ（送ったお便りを最上部・公開ラジオの操作・聴いたお便りを簡素に・ヘッダに設定） | 完了（2026-11-07。`/me` は 送ったお便り（絵・先頭 80 字・共有・非公開にする）→ 届いた反応 → あなたの公開ラジオ（URL のコピー・公開／非公開・URL の変更、`POST /me/radio`）→ 聴いたお便り（1 通 1 行）。好きなものの欄は外した。`/settings` から公開ラジオの欄を外し、`POST /settings` は公開の状態に触れない。ヘッダに ⚙ 設定。スクリーンショット `2026-11-07-p7-me-{pc,phone}.png`） |
| Task 4 | `/about`（見出しの下に線・挿絵を KV の画風で） | 完了（2026-11-07。`/about` のパネルは `panel-rule-under`: 上端の帯を出さず、各 `h2` の直下に 3px の `div.rule`。挿絵の差し替えは別作業。DESIGN.md に例外を記載） |
| Task 5 | 初回チュートリアル | 完了（2026-11-07。`src/client/tour.ts`（約 1.0 kB gzip）: `--scrim` の覆いに 1 つの部品の穴と吹き出し、5 段（スイッチ → ダイヤル → いま流れている → オンエア → サインイン。サインイン済みは最後が送るパネル）。Enter / Escape / Tab、終えても とばしても `dfm.tour = "done"`、ラジオはつけない。面の「使い方」と `/about` の `/?tour=1` で再表示。「いま流れている」カードは OFF の間は無いので、その段は穴なしで吹き出しだけ。station.js 8.50 kB gzip。スクリーンショット `2026-11-07-p7-tour-{1-pc,4-pc,1-phone}.png`） |
| Task 7 | ダイヤルはお便り 3 通で有効化（好みは送ったお便りと反応したお便りから） | 完了（2026-11-07。好み（`standingOf`）は自分の公開のお便り（letter）と、自分の公開の私も・一言が付いた公開のお便りの作品の平均（最大 50 作品、新しい順）。無ければ聴いた記録、それも無ければ従来どおり。好きなもの・Spotify は好みに使わない。`countOwnLetters`（1 文）が 3 以上でダイヤルが目覚める: ページの `data-dial-ready`、`POST /stations/mine/next` の `dialReady`。ロック中は面に出したまま回らない。ホームの説明と `/about` は「お便りを 3 通送ると…」で、`/start` へのリンクは外した。D1 の文は `POST /stations/mine/next` 20（冷えた入口 21。`dialReady` の 1 文）。スクリーンショット `2026-11-07-p7-dial-{locked,ready}.png`） |
| Task 6 | 締めのドキュメント | 完了（2026-11-07。README の機能と好みの説明、`docs/how-it-works.md` の「実装中」の印、SECURITY.md の一言に添えるラジオネームとお住まい、このデプロイ手順を現状に合わせた。`/settings` の入力規則は `listener-profile.ts` の `profileFields` を使い回すようにして、規則の置き場を 1 つにした） |

- 決定（Task 7）: ダイヤルの「3 通」は、自分の公開のお便り（letter）と自分の公開の私も・一言（返した先が公開のものだけ）を数える。自分のお便りへの自分の反応は数えない（好みにも入れない。最終レビューの修正）。好みと同じ行（`OWN_VOICES_SQL`）なので、数えたものは必ず好みに入る。数は画面に出さない（文言の「3 通」だけ）。ロック中は `next` にダイヤルの中央（0.5）を送り、ブラウザに保存した値は変えない（画面の針と番組を一致させる。fix round 1）。ロック中の値は保存しない: サーバーもロック中は送られた値によらず中央で選び、アカウントのダイヤルを書き換えない（最終レビューの修正）。目覚めは `next` の答えで知る（送るモーダルや `/put` から送ったあとは次の回で目覚める）。「好きなもの」の登録（`/start`）と Spotify の取り込みは導線から外した（ルートと設定の Spotify の欄は残す。ハッカソン後に撤去）。`/stations/mine` の「始める」パネル（好きなものが無いと出て、スイッチを止めていた）は外した（聴くのに登録は要らない。ページの D1 は 1 文減る）。`/episodes` の空のページは `/put`「お便りを送る」へ。プールの near（`OWN`）は今も好きなものを含む（ハッカソン後に外す）。`dfm.dialLocked` はブラウザごとで、リスナーごとではない: 同じブラウザで別のアカウントに入り直すと、すでに目覚めているダイヤルでも一度だけ目覚めの toast が出る（害は無いので受け入れる）。
- 決定（Task 2）: 「直近 3 枠」は、そのリスナーのその局の検証済みの回を新しい順に並べた最後の 3 セグメントの作品（1 回 1 枠なので 3 回）。外す制限は従来の順で戻す: 聴いたお便り → 直近 3 枠 → 直前の枠の作品（最後のものは候補がほかに無いときだけ）。7 日以内に聴いたお便りは、どの局で聴いたものも数え、世界と公開ラジオにも当てる（以前は自分のラジオだけ。世界と公開局は直近 10 回）。距離とダイヤルは作品のベクトルで選び、選んだ作品のお便りから 1 通を読む。出典の無い見つけた声は候補に入れない（1 通しか読まない枠が空になるため）。公開ラジオは持ち主自身が聴いても持ち主のお便りが流れる（自分のラジオでは自分のお便りは流れない）。

## Phase 6 の進み（計画: `docs/superpowers/plans/2026-11-07-dococa-fm-phase6.md`、設計: 追記 N）

2026-11-07 のサービス仕様レビューのプロダクトと UI/UX の項目（本人がすべて採用）に、本人の追加（冒頭の一行・読み・共有ページ・動画・BGM・挿絵）を足した。デプロイは上の本人作業（migration 0022〜0025 → deploy → `/admin/prepare` のループ）。

| Task | 内容 | 状態 |
|---|---|---|
| Task 1 | ラジオの面（ダイヤルの両端・電波待ち・音量の保存・私もの合図・サムネ・カードの再生印・コントラスト） | 完了（2026-11-07。音量の保存は既存。カードの再生文字のライト色を 3.91→5.18:1 に） |
| Task 2 | ホームとヘッダ（「お便りを送る」をオンエア欄の上に・「これまでの番組」を同じ行の部品で全幅に・ヒーローを畳む・短い表記・言語切替の確認・サインイン後の案内・文言） | 完了（2026-11-07。送るボタンはラジオのスクリプトがオンエア欄の最初に描く。番組の行は同じクラスをサーバーで描く。聴いた番組が無ければ節ごと出さない） |
| Task 3 | お便りの直リンク `/?letter=`・リンクのコピー・新しい反応の点（0022） | 完了（2026-11-07。`/?letter=` は形だけ見て `data-letter`、公開のお便りなら OGP（1 文足す）。点はヘッダが `/me` のリンクを描くときだけ 1 文読む（サインイン済みの GET だけ。JSON は読まない）。`/me` を開くと読む前の時刻で既読にし、`/me` 自身には点を出さない。共有ボタンは `/letters/<id>` をコピー、クリップボードが無ければ `prompt`。station.js gzip 5.46 kB） |
| Task 4 | 送ったお便りの非公開（`withdrawn`）・公開ラジオの一覧 | 完了（2026-11-07。`POST /letters/:id/withdraw` は自分の種類 `letter` の公開のお便りだけを 1 回の UPDATE で `withdrawn` にし、他人のもの・一言・私も・無い id は 404、匿名はサインインへ。読む側はどれも `status = 'public'` で絞っていたので、`withdrawn` は `rejected` と同じく画面・選別・音声・番組・共有ページから消える（コードの変更は型と書き込みだけ）。`/me` に「送ったお便り」の欄（作品名・先頭 60 字・日付・確認つきの「非公開にする」）。ホームに「お便りが届いた公開ラジオ」（最新の公開のお便りが新しい順に最大 5 つ、名前と お住まい だけ、数字なし、無ければ節ごと出さない）） |
| Task 5 | 冷えた入口（お住まいの国を散らす） | 完了（2026-11-07。お気に入りも聴いた記録も無く、自分の作品に誰も書いていないリスナーの `mine` の 1 席だけ。直近 2 セグメントの最初のお便りの国と違う国のお便りがある作品を、同じ新しさの中で先にし、そのお便りを最初に読む。国コードの無いお便りは外さない。残りが無ければ今まで通り。D1 は冷えた入口だけ 1 文増える） |
| Task 6 | cookie の無い GET でリスナー行を作らない | ハッカソン後に回す（本人了承待ち） |
| Task 8 | デモの反応（デモのペルソナから「私も」と一言。あとから送られたお便りにも付けられる） | 完了（コードは 2026-11-07。本番への投入はデプロイ後に本人が `pnpm seed:reactions`。上の本人作業） |
| BGM | Suno の 5 曲を回ごとにランダムに（`scripts/make-beds.sh`） | 完了 |
| Task 9 | 種類ごとの冒頭の一行（「…という曲の紹介です」。0023 で単位を作り直す） | 完了（2026-11-07。冒頭の一行は単位が無い・検証に落ちたお便りにも言う。intro の最初の一文が題名を言うと `lead:` で言い直させる） |
| Task 10 | 読み方（台本係が読みを返し、読み上げだけ変える。PSY → サイ。0024） | 完了（2026-11-07。日本語の単位だけ。読みは冒頭の一行・intro・after の音声にだけ効き、画面・プレイヤーの JSON・お便りは書いたまま。「別の方」→「別の人」。Task 9 のレビューの題名の語境界・`lead:` の言い直しのテスト・prepare のコメントも直した） |
| Task 11 | お便りの共有ページ `/letters/:id`（OGP・X の player カード・埋め込みプレイヤー・公開の音声経路） | 完了（2026-11-07。`/letters/:id/player` だけ枠に入れられる（`frame-ancestors *`、`X-Frame-Options` なし）。プレイヤー・`lines.json`・`audio/:n` はセッション外。行は `unitSegment` と同じで、位置は 冒頭 0・紹介 1・手渡し 2・お便り 3・ひとこと 4、検証済みの単位が無ければ 2 と 3 だけ。言語はお便りの言語。`embed.js` は gzip 0.55 kB） |
| Task 12 | YouTube の作品は「動画」（種類 `video`、0025） | 完了 |
| Task 7 | 締め（`docs/cost.md`・status・README・SECURITY・DESIGN） | 完了（2026-11-07。`docs/cost.md` はお便り 1 通あたりの費用・日次の上限・削れるところ） |
| Task 13 | ラジオの手ざわり（12 項目: スイッチの点灯と針・ダイヤルと電源の音・声で息づくランプ・音量のつまみ・読んでいる行の線・カードが飛ぶ・私もの封筒・送ったあとの封筒・BGM のクロスフェード・深夜のあたたかさ・キービジュアルの電波） | 完了（2026-11-07。決まりは DESIGN.md §10「動きと音」。Web Audio の文脈は 1 つで、最初のタップで作る。ランプは iOS と Web Audio をつなげないときは動かないだけ。スイッチの明滅は「続く動きは 2 つだけ」に合わせて止めた。レビューを受けて、ランプは Safari（macOS と iOS）では声につながず、声が鳴っている間だけ動かす。iOS の BGM はフェードせずに切り替える。音の部品はラジオのページだけが読む（`sounds.ts`）。station.js gzip 7.22 kB） |

- 決定（Task 5）: 「冷えた入口」は好みの読み（`standingOf`）でお気に入りの行も聴いた記録も無いこと（ベクトルの有無は問わない）、かつ近く・隣の棚が空のとき。国は各セグメントで最初に読んだお便りの `letters.place_country` で比べ、繰り返さない規則（新しさの順位）を先に守る。国も距離も件数も選ぶのに使うだけで、外には出さない。
- 決定（Task 9）: 作品の紹介の前に、定型の一行「{作者}の「{題名}」という{曲/本/映画/動画}の紹介です。」（英語は "Here is “{title}”, a song by {creator}."）を言う。作者が空なら作者を言わない形。作品のデータを埋めるだけで、Claude の文ではない。セグメントの最初のお便りの前に 1 回だけ、単位の有無にかかわらず言う（単位が無いときも作品の名前が聞こえるように）。DJ の intro はその続きとして題名と作者を繰り返さずに始め、最初の一文に題名があれば検証が `lead:` で落とし、1 回言い直させる。今の intro は題名から始まるものが多いので、0023 で単位を全部消して作り直す（👍 はまだ無い）。
- 決定（Task 10）: `write_unit`（日本語）に `readings`（`{text, reading}` を 8 個まで。text は 40 字以内で、かなだけの語は不可、intro・after・題名・作者のどれかにそのまま出てくるもの）・`titleReading`・`creatorReading` を足した。読みはカタカナだけで、外れたものは捨てて単位は通す。作品の読みは `items.reading_ja` に、作品にまだ無いときだけ保存し、冒頭の一行はそれで読む。intro・after は単位の読みと作品の読み（作品が優先）で読む。dj の行の `spoken` は作るときに組み立てて番組の行に保存し、`GET /tts` と事前生成は `spoken ?? text` を合成する（鍵も読みの本文で決まる）。`publicView` が `spoken` を落とすので、画面と JSON には出ない。検証は `spoken` にも同じ検査をかけ、さらに「本文の名前をカタカナに置き換えただけ」でなければ `reading:` で落とす。英語の行には付けない。読みの再生成マイグレーションは無し（今ある単位は作り直すまで読みが無い）。追加（本人 2026-11-07、「大船渡」が おおふなわた と読まれた）: 手渡しの土地とラジオネームにも読みを付ける。指示文に「読み方を返すためだけ — intro で名指ししない」と印を付けて渡し、単位の読みを手渡しの `spoken` にも当てる。追加（セキュリティレビュー）: 読みは全角カタカナだけ・元の表記の 3 倍（英字・数字）/ 2 倍（漢字など）まで・数字だけの表記は不可。作品の読みは題名か作者と完全一致のときだけ。定型の行でも読みが足したカタカナは語りの検査にかけ、落ちたら言い直させる。レビュー修正 1: 読みの長さは元の表記の英字・数字 1 字につき 3 字、漢字 1 字につき 2 字まで（最低 2）。英字・数字・漢字を含まない表記、数字と記号だけの表記は不可（題名・作者の読みも同じ）。作品の読みは最新の検証済みの単位に従い（上書き）、変わったらその作品の日本語の単位の `audio_ready` を 0 に戻す。作り直しは単位の読みを置き換える。
- 本人作業（Task 10、必要なときだけ）: 作品の読み（題名・作者）は作品のデータだけを見せる専用の呼び出しで 1 回だけ作る（最終修正。単位や作り直しでは変わらない）。間違っていたら SQL で消すと、次の `/admin/prepare` で聞き直す: `pnpm wrangler d1 execute dococa --remote --command "UPDATE items SET reading_ja = NULL WHERE id = '<作品の id>'"`。新しい読みが保存されると、その作品の日本語の単位は音声を作り直す印に戻る。単位の読み（語りと手渡し）が間違っていたら、管理画面（`/admin/units`）でその単位を 👎 で作り直す。
- 本人作業（Task 11）: デプロイ後、X の Card Validator（または実際の投稿）で `https://dococafm.app/letters/<id>` が player カードとして出るか確かめる。iPhone（Safari と X のアプリ内ブラウザ）でカードとプレイヤーの最初のタップで声が出るかも確かめる（最初のタップの中で再生を始める作りにしたが、iOS の実機では確かめていない）。X の player カードは審査・許可リストが要ることがあり、通らないときは X ではカードの絵（`og:image`）だけになる。`twitter:card` は 1 つしか選べないので `player` にし、ほかの SNS 向けに `og:` の画像カードの札（`og:image`・`og:title`・`og:description`）を併せて出している。
- デプロイの注意（Task 9）: 0023 は `units` を全部消す。当てたあと `/admin/prepare` のループをもう一度回し、`remaining.units` と `remaining.audio` が ja/en とも 0 になるまで続ける（単位は約 200 回 Claude を呼ぶ。音声はお便り 1 通でおよそ 10 行。冒頭の一行は作品と言語ごとに共有）。

## Phase 5 の進み（計画: `docs/superpowers/plans/2026-11-07-dococa-fm-phase5.md`、設計: 追記 M）

2026-11-07 の本人フィードバック（本番を聴いて。2 回分）から。8 タスク。すべて完了。デプロイは上の本人作業（migration 0021 → deploy → `/admin/prepare` のループで音声を全部作り直す）。

| Task | 内容 | 状態 |
|---|---|---|
| Task 1 | TTS の見張りの再調整・日英の指示文（簡潔に）・音声の鍵 v4（0021） | 完了（見張り ja 0.27 / en 0.125 s/字 + 3 s。0021 は deploy で当てる） |
| Task 2 | ヘッダの言語切替（`POST /lang`。設定の言語欄は無くす） | 完了（`safeNext` を `security/next.ts` へ移し、`POST /lang` は不正な `lang` を 400、`next` が同一サイトのパスでなければ `/`。ヘッダに 日本語 / English のボタン、設定の言語欄と `settings.lang` を撤去） |
| Task 3 | 「オンエア」の欄（いま流れているお便りを先頭に。私も・一言もそこから） | 完了（`upNextRows()` が今の枠を `now` として先頭に置き、残りと作り置きを続ける。OFF の間は空で案内の一文。`いま` の行に 私も・一言（プレイヤーと `sent` を共有）。同じ反応の二重送信を送信中は止める。見出しは新キー `station.panel`、`station.upNext` は撤去。`station.js` 4.34 kB gzip） |
| Task 4 | 設定の「DJ の声」を無くす・公開ラジオの URL をサインイン時に付ける | 完了（サインインで束ねた時点で `radio-<英数 6 字>` を `ensureStationSlug` が付ける。付いていない既存のサインイン済みは設定ページを開くか保存したときに付く。重複は 3 回まで引き直し、自分で決めた URL が使われていれば 422。`voice` の入力と文言を外した（列と `data-voice` は残す）。匿名には付けない） |
| Task 5 | 聞こえる BGM（自作のベッド音に差し替え） | 完了（`scripts/make-bed.sh` が 32 秒のつなぎ目のない mono 64 kbps の静かなパッドを合成し `public/bed.mp3` を上書き。実測 平均 −23.1 dBFS・ピーク −12.4 dBFS。`BED_VOLUME` は 0.4。音の良し悪しは本人がデプロイ後に聴いて判断） |
| Task 6 | ホーム（ラジオを `mine` にしてダイヤルを常に表示・カードで即再生（挨拶を飛ばす）・送るモーダル・説明文・直近 3 番組） | 完了（ホームは匿名も含め `mine` を載せる。頼んだお便りが最初の枠に座った初回は、挨拶もつなぎも無くそのお便りの紹介から始まる。カードは `data-play-letter` をページの委譲クリックで拾い、作り置きを捨ててそのお便りから鳴らし直す。送るは `<dialog>` の iframe に `/put?embed=1`（ヘッダ無し。フォームとリンクは `embed=1` を引き継ぎ、サインインと設定は `_top`）。送ると `/put?embed=1&sent=<作品>` が `dfm:sent` を送り、「届きました」が見えるよう約 1.5 秒おいてモーダルが閉じる（最終修正 9）。説明文は全員に。直近 3 番組は `listArchive` が保存済みの行から送り主も 1 クエリで返す。`station.js` 4.8 kB gzip。スクリーンショットは `docs/screenshots/2026-11-07-home-*.png`） |
| Task 7 | 説明ページ `/about` とヘッダのリンク | 完了（`GET /about` は 4 枚のパネル（聴く・送る・自分のラジオ・できること・しないこと）。言語はリスナーのもの。ヘッダのナビは常に出し、「Dococa FM とは」を先頭に全員へ（`listener` が無いページでも）。スクリーンショットは `docs/screenshots/2026-11-07-about-*.png`） |
| Task 8 | 締めのドキュメント | 完了（status・README・SECURITY.md・DESIGN.md をコードに合わせた。サインイン済みのヘッダの 390px のスクリーンショットは `docs/screenshots/2026-11-07-header-signedin-phone.png`） |

### 決定（Phase 5）

- BGM が鳴らない原因は `public/bed.mp3` が Phase 1 のプレースホルダ（20 秒、平均 −46 dB）だったこと。自作のアンビエントに差し替える。本物の楽曲にするなら本人が CC0 のものを選ぶ。
- プロンプトの読み上げの見張りは本番の clip の実測から決める（追記 M に数字）。英語の指示文は説明形のまま。
- 頼んだお便りが最初の枠に座った初回は、挨拶もつなぎも無く、そのお便りの紹介から始める（Task 6。カードを押してすぐ聴けるように）。
- ホームのラジオは、匿名も含め全員が `mine`（自分のラジオ）にする。ダイヤルも全員に出る（Task 6）。
- 英語の見張りの余裕は 1 秒に満たない（Task 1 のレビュー M1）。測ったのは古い指示文で、新しい「ゆっくり」の指示文では英語の読みが遅くなりうる。`failed` が増えたら `SECONDS_PER_OTHER_CHAR` を 0.125 → 0.14 に緩める（上の本人作業）。
- 見張りの余裕は番組の言語ではなく文字の種類で数える（最終修正 1。かな・漢字・ハングル・全角は 1 文字 0.27 秒、ほかは 0.125 秒）。英語の番組が日本語の見つけた声を読んでも、正直な clip を落とさない。
- 1 つの行（鍵）に払う合成はおよそ 6 回まで（最終修正 2。`MAX_SYNTH_PER_KEY`）。確かめるのは要求の前なので、正確には 5 回に、線を越える要求の分（1 チャンクにつき最大 3 回）を足した数。`synth_count` が 6 に達して R2 に clip が無い鍵は、Google を呼ばずに `gaveUp` を返す。prepare はその単位を `audio_ready = 2` にして以後は選ばず、`remaining.gaveUp` に数える（最終修正の 2 巡目）。もう一度試すなら本人が `tts_audio` のその行を消し、単位を 0 に戻す（上の本人作業）。
- 0021 は `tts_audio` を空にするので、その日の TTS 上限カウンタ（`tts_audio` の行数）も空になる（Task 1 のレビュー M5）。当てる日と prepare の回し方に注意する（上の本人作業）。

## Phase 4 の進み（計画: `docs/superpowers/plans/2026-11-06-dococa-fm-phase4.md`、設計: 追記 L）

| Task | 内容 | 状態 |
|---|---|---|
| Task 1 | お住まい（画面と手渡しの言い方） | 完了 |
| Task 2 | MCP の撤去 | 完了（`/mcp`・`/settings/mcp-token`・MCP の依存 2 つ・レート制限と session の例外を外した。`/settings` の末尾にリスナー ID の行を残す） |
| Task 3 | ラジオ面のダイヤル（要求ごとに 1 目盛り） | 完了（`next` は毎回 1 枠。本文 `{dial, first, letterId}` を zod で検査し、形が違えば 400。ダイヤルは `localStorage["dfm.dial"]` に置き、回すと 300 ms 待って作り置きを捨てて頼み直す。`/settings` のダイヤルと `POST /settings/dial` を外した。サインイン済みなら `listeners.dial` を値が変わったときだけ 1 回の UPDATE で書く。`/stations/mine?letter=` は最初の `next` に `letterId` を載せる。上限の既定は 60 枠と 1800 枠） |
| Task 4 | 遠さ（埋め込みと距離の帯） | 完了（作品の公開情報だけを Workers AI `@cf/baai/bge-m3` でベクトルにし、Int8 で `items.vec`（0017）に置く。作品を作る経路（`/start`・`POST /letters`・Spotify 取り込み・`/admin/items`・`/admin/letters`）は応答のあとで作り、Cron と `/admin/prepare` が残りを埋める（20 作品で 1 件分の枠、`remaining.vectors`）。自分のラジオの 1 枠は、好みのベクトル（お気に入り 50、無ければ最近聴いた 20 作品の平均）からの遠さの百分位で、ダイヤル ±0.2 の帯から無作為に選ぶ。7 日以内に聴いた作品と直近 30 回の作品を外し、尽きたら前者から戻す。好みかベクトルが無ければ従来の枠の順。反響は「最後に聴いたお便り」より新しい反応に変え、直前の回の作品は外す） |
| Task 5 | ホームに今届いているお便り | 完了（`listRecentPublicLetters` が最新の公開のお便り 6 通（通常のお便りと出典つきの見つけた声）を作品つきで 1 クエリで返し、`LetterCard` が `/stations/mine?letter=<id>` へのカードにする。`listRecentItems` は撤去） |
| Task 6 | 送る画面（並び・お気に入りから選ぶ・検索・ブックマークレット） | 完了（`/put` を 3 枚のパネル（作品を決める・お便りを書く・ブックマークレット）にした。好きなものは `?pick=` でサーバー側でしぼる。`?q=` の題名検索はサインイン済みだけで、`searchByText` が iTunes・Google Books・TMDB と鍵があるときの YouTube を交互に 10 件まで並べ、`searchRateLimit`（リスナーごと 1 分 20 回）で守る。検索結果のリンク先で別の種類に化けないよう、TMDB と Google Books の URL は ID で引き直す。`/api/resolve`・`/api/search` は撤去。スクリーンショットは `docs/screenshots/2026-11-06-put-*.png`） |
| Task 7 | マイページの並び | 完了（`/me` を 4 枚のパネル（好きなもの・聴いたお便り・届いた反応・公開ラジオ）にした。好きなものは 96px の絵の箱つきの小さなカードのグリッドで、`ItemCard` の `art` で出す。ページ内のサインアウトのフォームは外した（ヘッダに残る）。データと文言は変えていない。スクリーンショットは `docs/screenshots/2026-11-06-me-*.png`） |
| Task 8 | モデレーションの理由と再判定 | 完了（理由に `obscene`（公序良俗）と `negative`（作品や作り手をけなすのが主体）を足した。悲しい一通・そっけない一通・辛口の一言は通す。`POST /admin/rejudge`（`limit` 1〜50 既定 20、`after` は `letters.id` のカーソル）が公開中の `letter`・`found`・`reply` を id 順に今の基準で判定し直し、断られたものを `rejected` にする。私も・既に `rejected` のものは対象外、判定が投げたものは `skipped` で公開のまま。`pnpm rejudge` が `next` が null になるまで回し、id・理由・件数だけを出す） |
| Task 9 | 単位のフィードバックの輪（管理画面・良い例・採点スクリプト） | 完了（`units.liked`（0018）。`/admin/units` で単位を一覧し、👍（`liked` を立てる）と 👎（その場で作り直し、新しい単位が検証を通って保存できたときだけ前の単位と置き換えて音声を作る（最終修正）。別の処理が作っている最中は 409、鍵が無い・その日の上限なら 503/429、作れなかったら前の単位を残して 503。今日作った単位の作り直しは `unit_remakes`（0019）に残して上限に数える）。一覧と JSON は公開中のお便りの単位だけで、未検証の行には 👍 を出さない。`adminAuth` は Basic（`admin:ADMIN_TOKEN`）も受け、ページだけ 401 で Basic を求める。Basic の書き込みは `PUBLIC_ORIGIN` からに限る。単位の指示文の末尾に、👍 付き・検証済みの intro を新しい順に 5 件（intro だけ）。単位 1 件の D1 の文は 6 → 7。`pnpm eval:units` が `/admin/units.json` を採点し `docs/eval/units-<日付>.md` を書く。`--remake` で 2 点以下を作り直す） |
| Task 10 | 締めのドキュメント | 完了（README・SECURITY.md・DESIGN.md・`.dev.vars.example`・`wrangler.jsonc` のコメントをコードに合わせた。「土地」を「お住まい」に直し、マイグレーションは 0001〜0018（Task 9 の修正で 0019 を足した）、レート制限は題名検索の別枠まで書いた） |

決定: 単位は本人の 👍 と 👎 で育てる（Task 9。👍 した intro が指示文の良い例になり、👎 は作り直す。採点スクリプトの提案は本人が読んで手で反映する）。
決定: モデレーションの理由は 6 つ（Task 8。`obscene` と `negative` を足した）。悲しい一通・そっけない一通・辛口の一言は引き続き通す（`negative` は、けなす・嫌いと言うのが主体のものだけ）。
決定: MCP は Phase 4 で外した（事前生成で役目を終えた）。列 `mcp_token` は残して使わない。
決定: 回は 1 枠（Task 3。リスナーの回は `makeEpisode` の既定 `size: 1`。eval だけは `POST /admin/episodes` に `size: 6` を送り、1 回 6 枠で測る。`selectProgram` の `size` はそのためとテストのために残す）。
決定: 終わりのつなぎは言わない（Task 3。`bridge.close` は出さないが、保存済みの回を描くためにキーと `BRIDGE_KEYS` は残す。`bridge.open` は訪問の最初の回だけ）。
決定: 遠さは選ぶためだけに使い、応答・画面・ログ・DJ の言葉には出さない（Task 4。`next` の JSON にベクトルや遠さのキーが無いことをテストで確かめる）。
決定: 反響の基準は「このラジオで最後にお便りを聴いた時刻」（Task 4。作り置きの回が捨てられても反響は消えない。作り置きが同じ反響を繰り返さないよう、直前の回の作品は反響にしない）。
決定: ホームは『いま届いているお便り』（最新 6 通のカード。本文は 120 字で切り、全文は作品ページ）。
決定: 送るページは URL・好きなもの・題名検索の 3 本（検索はサインイン済みだけ、YouTube は鍵があるとき）。
決定: Spotify をつなぐのは設定だけ。
決定: 上限は枠の数（Task 3。`EPISODE_DAILY_LIMIT` 既定 60、`EPISODE_GLOBAL_DAILY_LIMIT` 既定 1800。数えるのは従来どおり回の行で、1 回が 1 枠）。
決定: 同じ作品を続けて流さない（最終レビュー。どの局でも、そのリスナーのその局の直近の回の作品を避ける。世界と公開局は 10 回、自分のラジオは 30 回と 7 日以内に聴いた作品。候補が尽きたら外すが、直前の回の作品はほかに候補が無いときだけ）。
決定: 別の端末で再開すると、まだ聴いていない作り置きの回を挨拶なしで頭から流すことがある（最終レビュー M7）。受け入れて直さない。
決定: 捨てた古い作り置きの要求が遅れて届くと、保存したダイヤルを古い値に戻すことがある（Codex M1）。影響は別の端末のつまみの初期値だけなので、見送る。
決定: 同じ作品のベクトルを同時に 2 回作りうる（Codex I2）。1 回の費用はごく小さく、上書きも同じ値なので、受け入れた制限として SECURITY.md に書いた。
決定: ベクトルに作品の説明は入れない（Codex I3 の後半）。作品は説明の欄を持たず、確かな説明を返す検索先も無いので、題名・作者・年・種類で作る（設計書の追記 L を改めた）。
決定: 題名検索の音楽は iTunes（Codex I4）。Spotify の検索はアプリの client secret が要り、この app は PKCE だけで secret を持たないため。iTunes は鍵なしで曲を引ける（設計書の追記 L を改めた）。
決定: ラジオ面の最初の回（begin）が答えたら、ダイヤルが回った後でも、聴きに来たお便りの指定を外す（最終修正の item 1 の後半を見送り）。begin の回はダイヤルに関係なく流すので、指定を残すと次の回が同じお便りをもう一度読むため。

## 2026-11-06 Phase 4 完了（最終レビューの修正まで・ローカル）。次は本人作業 → デプロイ → public 化

Phase 4（お住まい・MCP の撤去・ラジオ面のダイヤル・遠さ・ホームのお便り・送る画面・マイページ・モデレーション・単位の見直し・締めのドキュメント）の Task 1〜10 と、全体レビュー（Claude と Codex）の修正は main にコミット済み（push していない）。修正は、ホームのお便りのカードが新しい訪問者でも鳴る、同じ作品を続けて流さない、作り直しで前の単位を消さない、等距離の作品を同じ遠さにする、再聴ページで新しい回を作らない、`/episodes` は聴いた回だけ、題名検索の YouTube に 1 日の上限（0020）、ベクトルの埋め戻しで失敗する作品を飛ばす、管理画面の位置を保つ、ほか細かい直し。本番は Phase 1 の状態のままなので、下を上から順に済ませる。

### 本人作業（Phase 4 のデプロイ。この順）

- [x] （2026-11-07 済み。0016〜0020 を本番に適用）`pnpm db:migrate` で 0015 以降の当てていない分を順に当てる。本番には 0005〜0014 まで当て済み（2026-11-06）。残りは 0015（tts_v3: 音声の鍵を v3 に変え、`tts_audio` を空にして `units.audio_ready` を戻す）、0016（revoice_handover: 手渡しの言い方が変わるので単位の音声を作り直す）、0017（items_vec: 作品のベクトル）、0018（units_liked）、0019（unit_remakes: 作り直した単位を 1 日の上限に数える）、0020（youtube_searches: 題名検索の YouTube を 1 日に数える）。R2 の `tts/v2/` は手で消してよい（残っても害はない）。
- [ ] 本番の `EPISODE_DAILY_LIMIT` を 30 などにしてあれば、消す（既定 60 枠）か上げる。1 回が 1 枠なので、以前の「30 回」と数え方は同じだが、既定は 60 になった。
- [ ] 題名検索の YouTube の 1 日の上限 `YOUTUBE_SEARCH_DAILY_LIMIT`（任意。既定 80 回/日。全員合計で、1 回 100 ユニット）。見つけた声の収集バッチに枠を多く残したいなら下げ、YouTube を検索に使わないなら `0`。`wrangler.jsonc` の `vars` か `pnpm wrangler secret put` で入れる（入れなければ 80）。
- [ ] Workers AI を使えるようにする（Workers Paid のアカウント。`wrangler.jsonc` に `ai` バインディング `AI` を入れてある。新しい鍵は無い。無くても動き、そのときダイヤルは枠の順を決めるだけ）。開発機は `pnpm wrangler login` を済ませておく（`pnpm dev` がリモートの Workers AI に繋ぐ。使った分はそのアカウントに課金される。テストは繋がない）。
- [x] （2026-11-07 済み。version 7430aaad、`env.AI` 付き）`pnpm run deploy`。
- [x] （2026-11-07 済み。判定 97 件、断られたもの 0）デプロイしたらすぐ `ADMIN_TOKEN="$PROD_ADMIN_TOKEN" pnpm rejudge --origin https://dococafm.app`（先に `read -rs PROD_ADMIN_TOKEN`）を一度実行する。公開済みのお便りを新しい基準（`obscene`・`negative`）で判定し直し、断られたものは `rejected` になる。`skipped` が出たらもう一度。先に済ませるのは、次の `/admin/prepare`（と 15 分ごとの Cron）が、断られるお便りの単位と音声を作らないため。
- [x] （2026-11-07 済み。20 回で vectors・units・audio がすべて 0、failed 0）rejudge のあと、`POST /admin/prepare`（`Authorization: Bearer $ADMIN_TOKEN`、`{"limit":20}`）を、`remaining`（`vectors`・`units`・`audio`）が全部 0 になるか `failed` が変わらなくなるまで繰り返す。作品のベクトル、日本語と英語の単位、手渡しと音声が揃う。`AI` バインディング（Workers AI）が無いあいだは `remaining.vectors` は作品の数のまま減らないので、そのときは `failed` が変わらなくなったところで止める。音声の上限（既定 3000 行/日）に当たったら翌日（JST）に続く（Cron は 15 分ごとに 20 件ずつ埋める）。
- [ ] 最初の `ADMIN_TOKEN="$PROD_ADMIN_TOKEN" pnpm eval:units --origin https://dococafm.app --lang ja --limit 40`。`docs/eval/units-<日付>.md` の低い 10 件と「指示文への提案」を読み、採るものを指示文に入れる。英語は `--lang en`。良い intro は `https://dococafm.app/admin/units?lang=ja`（ユーザー名 `admin`、パスワード `ADMIN_TOKEN`）で 👍、だめなものは 👎。
- [ ] 画面を確かめる: ホームの「いま届いているお便り」のカード、ラジオの面のセレンディピティ（回すと次の回から効く）、送る画面（`/put`）の題名検索、マイページ（`/me`）。ライトとダーク、PC 幅とスマホ幅。

以降は Phase 3 までの本人作業のうち、まだ済んでいないもの。

## 2026-11-06 Phase 3 完了（最終レビュー済み・ローカル）。次は本人作業 → デプロイ → public 化

Phase 2（ラジオ中心の体験への作り替え）と Phase 3（単位・音声の鍵・つなぎ・事前生成・聴いた記録・土地コード・英語の DJ）の実装は、最終レビューの修正まで含めてすべて main にコミット済み。本番は Phase 1 の状態のままなので、下の本人作業を上から順に済ませてデプロイする（migrate → deploy → `/admin/prepare`）。本番 URL は `https://dococafm.app`、再デプロイは `pnpm run deploy`。

### 本人作業

- [ ] 任意: 単位（お便りごとの DJ の語り）の 1 日の上限 `UNIT_DAILY_LIMIT`（既定 1000、`0` で停止）を変えるときは `pnpm wrangler secret put UNIT_DAILY_LIMIT`（Cloudflare の secret か var。既定でよければ設定しない）。
- [ ] 任意: お便りと一言の全体の 1 日の上限 `LETTER_GLOBAL_DAILY_LIMIT`（既定 500、`0` で停止。数えるのはお便りと一言だけで、「私も」と見つけた声は数えず止めない）を変えるときは `pnpm wrangler secret put LETTER_GLOBAL_DAILY_LIMIT`。`/admin/letters` のシードもこの上限に従うので、大量に投入する日は先に上げる。
- [ ] GCP で OAuth クライアント（種類: ウェブ アプリケーション）を作る。承認済みのリダイレクト URI は `https://dococafm.app/auth/google/callback` と `http://127.0.0.1:5173/auth/google/callback`。
- [ ] `pnpm wrangler secret put GOOGLE_OAUTH_CLIENT_ID` と `pnpm wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET` を実行し、`.dev.vars` にも同じ値を写す。
- [ ] OAuth の同意画面を「本番」に公開する（テスト中のままだと、登録したテストユーザーしか入れない）。
- [ ] Google Cloud で Books API を有効化し、キーを `.dev.vars` の `GOOGLE_BOOKS_API_KEY` と `pnpm wrangler secret put GOOGLE_BOOKS_API_KEY` に入れる（YouTube のキーに Books API を足して同じ値でもよい）。入ったら本のデモを追加投入する（`pnpm seed --items <file> --personas 30 --reuse --origin https://dococafm.app`）。
- [ ] 本番のデモデータは土地コードなしでシードしてある（`/admin/listeners` がコードを受け取るのは最終修正から）。英語の画面と英語の DJ では、コードの無いペルソナのお便りに日本語の土地（`place`）が出る。直すにはペルソナを作り直して再シードする（`pnpm seed --reuse` はペルソナの国名からコードを付けて送る）。するかどうかは本人が決める。
- [ ] シードの量に注意: お便り 1 通で音声はおよそ 8 行（日本語と英語の intro・手渡し・お便り・after）、ほかにつなぎの定型が 14 行（7 本 × 2 言語）を一度だけ使う。単位はお便り 1 通・1 言語で Claude を 2〜4 回呼ぶ。大量に入れるなら、デモの前日にシードするか、その日だけ `CLOUD_TTS_GLOBAL_DAILY_LIMIT` を上げる（`UNIT_DAILY_LIMIT` と `LETTER_GLOBAL_DAILY_LIMIT` も同じ）。
- [ ] 題名検索の YouTube は `search.list` で 1 回 100 ユニットを使う（既定の枠は 1 日 10,000 ユニット、つまり 1 日およそ 100 回。見つけた声の収集バッチと同じ鍵なら枠も共有）。足りなければ Google Cloud で枠の引き上げを申請するか、`YOUTUBE_API_KEY` を外して YouTube なしで探す。
- [ ] 本番で確かめる: ホームの「ラジオをつける」、Google サインイン、`/me`、公開局 `/stations/s:<slug>`、日本語と英語の切り替え。
- [ ] Spotify Developer Dashboard の Redirect URI を `https://dococafm.app/auth/spotify/callback`、Website を `https://dococafm.app` に。TMDB の Application URL も同じく（済んでいなければ。新ドメインに揃える）。
- [ ] eval 20 回（1 回が 1 枠で、既定の 60 枠で足りる）: `ADMIN_TOKEN="$PROD_ADMIN_TOKEN" pnpm eval --origin https://dococafm.app --listener <id> --runs 20 --out docs/eval/<日付>.md`。結果を README の eval 表に書く。
- [ ] 声の聴き比べ（Phase 1 の Task 11 Step 5）が済んでいなければ、本番で自分の最初の回を聴く。
- [ ] public 化後の GitHub 設定（fork PR の承認など）と、public 化前チェックリストの残り（下の 2026-11-04 の節）。gitleaks は public 化の直前にもう一度。

### 決定（Phase 2 の判断。台帳に記録したもの）

- タスクの番号は、2b を 2 と 3 の間に置く（実行順は 1、2、2b、3〜14）。言語設定が `t()` の署名を変え、以降の画面すべてに効くため。
- `CLOUD_TTS_GLOBAL_DAILY_LIMIT` の意味を「クラウドの声を付ける回数」から「1 日に合成する行数」に変えた（Phase 3 Task 2、既定 3000）。本番で値を設定済みなら見直す（既定に戻すなら secret / var を消す）。
- `GET /tts` はエピソードの `cloudTts` フラグを見なくなった（Phase 3 Task 2）。本人のエピソードに限り、ページが `data-tts-url` を出したときだけ呼ばれ、行数の上限が費用を抑える。`cloud_tts = 0` の古いエピソードは、手で作った要求でだけ声が付く。
- 画面の文言から「局」を外す（`me.station`、`settings.station*` の文言）。DESIGN.md が画面での「局」を禁じている。
- Spotify の取り込みは、履歴の `source` が `manual` / `url` のものを `spotify` で上書きしない。上書きすると好きなものの一覧から消える。
- お便りの翻訳には健全性の検査を置く。URL・メール・電話・住所・郵便番号を含むか、長さが `max(400, 原文の 2 倍)` 字を超えたら、翻訳だけを捨てて原文を出す。お便り自体は拒まない。
- 翻訳が失敗しても投稿は通す（英訳は fail open）。日本語の本文は原文にフォールバックし（NOT NULL で DJ が読む）、`body_en` は null。
- 翻訳の検査は、連絡先らしさの判定（`looksLikeContact`）の全体を使い、投稿時の判定と揃える。
- 局ごとに回を分けるため、`episodes.station`（`world` / `mine` / `public:<ownerId>`）を 0006 で足し、`GET /stations/:key.json` は局ごとに絞る。別の局の回には復帰しない。
- Google アカウントへの紐づけは、現在のリスナーの `google_sub` が空のときだけ行う。別の Google アカウントに紐づいたリスナーへは上書きせず失敗にする。サインイン後の戻り先 `next` は同一オリジンのパスだけを通す。
- Google アカウントを紐づけても、ラジオネームは Google の名前やメールから埋めない（2026-11-06、本人の規則が計画 Task 7 の文より優先）。空のラジオネームは「名無しのリスナー」で出し、`/settings` と `/me` に「公開されるのはラジオネームだけです」と案内する。Google の名前は `displayName` に持ち、ヘッダと `/me` だけに使う。
- （MCP は Phase 4 で廃止）MCP の `post_letter`（新しいお便り）はサインイン済みのリスナーだけ（2026-11-06 の裁定）。匿名は `signin.needed` で失敗し、`react`（私も・一言）は匿名でも使える。`/settings` の MCP の欄に「聴くことと反応だけできます」と添える。
- Spotify の再取り込みは、そのリスナーの履歴すべての `rank` を消してから入れる（手で選んだ `manual` の行も含む）。順位は最新の取り込みだけが決め、ほかの経路からは付かない。取り込みが成功して空だったときも消す。上位の 2 リストの読み取りが失敗したときは、何も分からないので消さない。
- 「語りだけ」を徹底する（追記 I）: 作品の試聴 30 秒（`preview` 行）は新しい回に入れず、保存済みの回に残っていても出口（プレイヤー、`/tts`、聴いたお便り。当時は MCP も。Phase 4 で廃止）では落とす。作品を聴く・観るリンクは残す。
- 局プレイヤーは、このブラウザが聴いていた回の位置を `localStorage["dfm.pos:<局>"]`（回 id、セグメント、行）に持つ。ON で `GET /stations/:key.json?id=<回 id>`（自分のその局の回だけ。違えば 204）を呼び、その位置から続ける。無ければ直近の回、聴き終えた回なら先読み済みの次の回か新規。
- Spotify の認可は、開始したリスナーの id を `dfm_pkce` cookie に入れ、コールバックで一致を確かめる。コールバックもサインインが要る。Google の紐づけは `google_sub IS NULL` を条件にした 1 回の UPDATE で行い、競合に負けたら再読込して切り替えるか失敗にする。
- セッション cookie は、紐づけで回さない（リスナー id の決定的な HMAC という既存の設計）。
- 公開局のラベルと自動の slug は、ラジオネームだけから作る（Google の表示名は公開しない）。自動の slug は乱数の `radio-xxxx`。ユーザーが自分で決めてもよい。
- 見た目のトークンに `--on-magenta`（マゼンタ上の文字色）と `--label`（ライトで濃くした coral）を足す。コントラスト不足への対処で、DESIGN.md に反映済み。
- お便りの無いセグメントのフォールバックは、作品を紹介する（`script.workOnly`）。「お便りを読みます」とは言わない。
- DJ は「かけます」「どうぞ」などの再生の誘いを言わない。verify の `playback:` が落とし、再生成する。

### 保留 / Phase 3

- 音声の事前生成（作品 × お便りの単位）。
- 合間のトークの定型化。
- 先読みの応答が途中で失われると、同じ枠をもう一度作って 1 日の枠を余分に使うことがある（冪等キーは入れていない）。
- セッション cookie はサインイン・サインアウトで回さない（リスナー id の決定的な HMAC のまま。サインアウトはブラウザ側の削除だけ）。v1 の既知の設計。
- お便りの無い作品を枠に入れない（本人決定 2026-11-06。番組はお便りのある作品だけで組み、Phase 1 の FALLBACK プールと公開局の例外を外す。Phase 3 で実装）。影響箇所（最終レビュー I3 より。ずれないように全部まとめて直す）:
  - `src/worker/program/select-sql.ts` の `FALLBACK_SQL` と `select.ts` でのその利用。無くすと、他人のお便りが無い新規リスナーの `mine` は短いか空になる（`/start` → `/stations/mine` が 409 `empty` になる）ので、`station.empty` の文言と grow の経路を確かめる。
  - `select.ts` の `publicProgram` は誰も書いていない作品をわざと残している → `letterIds.length > 0` で絞る（`worldProgram` は `FAR_SQL` で既にお便りのみ）。
  - `compose.ts` の `script.workOnly` と `FIXED_TEMPLATES`、i18n の `script.workOnly`、`script.ts` の `NO_LETTER_NOTE`、`verify.ts` の `announce` 規則と `build.ts` の `RETRYABLE`。
  - `stored.ts` の `publicView`（お便りが全部非公開になった枠を落とす現在の扱いを維持するか決める）。`/me` の聴いた履歴と `?seg=` の再生は `publicView` の添字を共有しているので、両方そこを通す。
  - テスト: `select` / `compose` / `verify` / `build` / `station` の fallback・workOnly の fixture。
- `letters.place` は日本語のラベルで持つ（DJ が日本語で読むため。設計書 Addendum H）。画面はコードがあれば読み手の言語で引き直す（Phase 3 Task 7）。コードの無い古いお便りと見つけた声は `place` のまま出る。DJ の英語の読みは Task 8。
- 英語の回でも、場所コードの無いお便りでは手渡しが日本語の土地（`place`）を言い、訳が作れなかったお便り（`body_en` が null）は日本語の原文を読む。どちらも en-US の声ではうまく読めない。データの欠け（コードと訳）なので、データを埋めれば直る。

## Phase 3 の進み（計画: `docs/superpowers/plans/2026-11-06-dococa-fm-phase3.md`、設計: 追記 K）

| Task | 内容 | 状態 |
|---|---|---|
| Task 1 | お便りの無い作品を枠から外す | 完了（FALLBACK プール・公開局の例外・`script.workOnly`・`NO_LETTER_NOTE`・`announce` 規則を撤去。出典なしの見つけた声だけの枠は build で落とす） |
| Task 2 | 行の本文を鍵にした音声キャッシュ。クラウドの声を全員に | 完了（`tts/v2/<lang>/<voice>/<sha256>.mp3` で全員が共有、合成ごとに `tts_audio` へ記録して 1 日の行数を上限に、`ensureAudio` が上限確認→claim→合成。全エピソードが鍵があれば `cloudTts`、初回限定の claim は撤去） |
| Task 3 | つなぎの定型 | 完了（`program/bridge.ts` の 6 本の定型。回の頭に open、2 作品目以降は slot ごと、同じ作品の 2 通目の前に sameWork、最後に close。いずれも `fixed`。`composeEpisode` に `lang` を追加） |
| Task 4 | 単位（お便りごとの DJ の語り） | 完了（`units (letter_id, lang)` を 0009 で追加。`makeUnit` が `write_unit` で intro/after を書き 1 枠で検証、通らなければ規則を伝えて 1 回だけ書き直し、`verified` 0/1 で保存。`buildEpisode` は単位を並べるだけで、無い単位だけ作る（同時 3）。番組の検証で落ちた枠は単位を外して再検証、それでも駄目なら定型だけ。`writeDjLines` と回ごとの台本は撤去） |
| Task 5 | 事前生成（投稿後・15 分ごと・手動） | 完了（`program/prepare.ts` の `prepareLetter` / `prepareBatch`。`POST /letters`・MCP `post_letter`・`/admin/letters`・`/admin/found` が `waitUntil` で呼び、Cron `*/15 * * * *` と `POST /admin/prepare`（`limit` 1〜50）で 20 件ずつ埋める。出典のない見つけた声は対象外。音声は上限か鍵なしで止める） |
| Task 6 | 聴いた記録 | 完了（`listens`（リスナー × お便り）を 0010 で追加。プレイヤーが読み上げ始めたお便りの行で `POST /listens`（`reply` は送らない）、サーバーは自分の検証済みの回・公開のお便り・公開ビューの枠の添字が合うときだけ 204、他は 404。マイページの聴いたお便りはこの表から出す） |
| Task 7 | お便りの土地コード | 完了（`letters.place_country` / `place_region` を 0011 で追加。送るときにリスナーの値を写し、見つけた声は null。画面と `whoLine` は言語に合わせてコードから引き、無ければ `place`。番組の台本の手紙行にもコードを載せ、検証で突き合わせる。クライアントは `places.ts` を取り込む（一覧は player と station が共有するチャンク `reactions-*.js` に入り、その gzip は Task 7 で 9.1 KB から 15.2 KB に増えた。最終修正の後は 15.3 KB。entry の station.js 自体は gzip 約 3.9 KB）。DJ の読みは日本語の `place` のまま） |
| Task 8 | 英語の DJ | 完了（`episodes.lang` を 0012 で追加し、番組は聴く人の言語で組む。`lang = en` の単位は `DJ_SYSTEM_EN` と英語の `write_unit` で書き、お便りは `body_en`（無ければ原文）を読み、手渡し・反応・つなぎの定型も英語、土地はコードから英語で言う。検証は英語用の時事・年・数え上げ・再生の誘い・手渡しの語彙と 6 語の引用窓。`/tts` は回の言語で合成（`en-US` と `DJ_STYLE_PROMPT_EN`）。`prepareLetter` と `prepareBatch`（Cron・`/admin/prepare`）は ja → en の順に両方の単位と音声を作る。`remaining` は言語ごと） |
| 最終修正 | 全体レビュー（opus と Codex）の裁定 | 完了（単位・お便りの 1 日の上限 `UNIT_DAILY_LIMIT` / `LETTER_GLOBAL_DAILY_LIMIT`、合成のたびに数える `synth_count`（0013）、単位はお便り × 言語ごとに 1 人だけが作り、検証済みの単位は上書きしない、batch は `limit` を 1 回の総数として使う、`prepareLetter` は単位を両方作ってから音声、Cron は待つ、公開局のつなぎは「続いてのお便りです。」、つなぎの文言、`/listens` の専用の枠、聴き直しと再開はお便りの id で枠を探す、intro に送り主の名前と土地を言わせない、空の intro/after は形の不備、intro は先頭のお便りのものだけ、検証の語彙の追加、デモのペルソナに国コード） |

### 決定（Phase 3）

- Gemini-TTS が style prompt を本文の前に読み上げることがある（2026-11-06 に本番で発覚。描写文の日本語 prompt では短い定型行のほぼ全部、命令形でも 6 回に 1 回。英語は描写文で正常、命令形で逆に悪化）。対処は 2 つ: 日本語 prompt を命令形（「次の文を、〜のように読んでください」）にし、合成した MP3 の長さ（32 kbps 固定なので bytes/4000 秒）が「4 秒 + 文字数 × 0.5（英語 0.35）」を超えたら prompt を読んだとみなして捨てて作り直す（3 回まで。全部だめなら `tts prompt` で失敗し、プレイヤーはブラウザの声に落ちる）。再試行の回数も日次上限に数える。v2 の音声は全部作り直し（鍵を `tts/v3/` に、0015 で `tts_audio` を空に）。
- 聴いたお便りの履歴は、デプロイの時点で空から始まる（最終レビュー M8）。`/me` の「聴いたお便り」は Phase 3 から `listens`（プレイヤーが実際に読み上げ始めたお便り）だけを読み、それより前の回は移さない。作った回に入っていたことと、聴いたことは別のため。
- 原文どおりの判定（Task 8）: お便りの行は、日本語の回では `body_ja` か原文、英語の回では `body_en` か原文と一字一句同じであること。英語の回で日本語訳を読むのは不可。引用の検査は日本語の回では原文と `body_ja`、英語の回ではそれに `body_en` を加えた全部と突き合わせる。英語の行は偶然の一致が多いので、引用の窓は 10 字ではなく 6 語。
- 単位の並び（Task 4）: 枠は「つなぎ → intro（1 回だけ）→ 手渡し（定型）→ お便り → after」を通数ぶん、2 通目の前は sameWork、反応のあと最後の枠に close。intro は枠の先頭のお便り自身の検証済みの単位のものだけ（最終修正 C9 で変更。単位の intro はそのお便りを見せて書かせるので、別のお便りの前では言わない。先頭が一言の読み上げや単位の無いお便りなら intro は無し）。dj 行の `unit: { letterId, part }` で、非公開になったお便りの intro/after を `publicView` が落とす。手渡しの定型はお便りの種類を問わず一緒に落とす（以前の回の読み上げのみの手渡しも落ちる）。

## Phase 2 の進み

| タスク | 内容 | 状態 |
|---|---|---|
| Task 1 | 一文と文言 | 完了 |
| Task 2 | スキーマ | 完了 |
| Task 2b | 言語設定 | 完了 |
| Task 3 | 局ごとの枠決め | 完了 |
| Task 4 | 局の API | 完了（`/stations/:key.json` は局ごとの直近の検証済み回を返す。`episodes.station` を 0006 で追加） |
| Task 5 | 局プレイヤー | 完了（`/stations/:key` のページと `station.js`。行の再生は `playback.ts` に共通化。ON で、このブラウザが聴いていた回を `?id=` で呼んでその位置（`localStorage` の `dfm.pos:<局>`）から続ける。無ければ直近の回、それも無ければ新規作成。残り 2 セグメントで次の回を先読み） |
| Task 6 | ホームを局に | 完了。局パネルの見た目（左寄せ、DOCOCA FM と ON AIR の間隔）は Task 11 で整える |
| Task 7 | Google サインイン | 完了（OIDC を Worker 内で。`/auth/google`、`/auth/google/callback`、`POST /auth/signout`。実キーでの実機確認は本人作業の後） |
| Task 8 | 保護とマイページ | 完了（`requireSignin` で `/start`・`/auth/spotify`・`POST /letters`（`kind=letter`）・`/me` を保護。`GET /put` は閲覧可で、匿名にはフォームの代わりにサインイン案内。ヘッダ `.site-header` と `/me`。`POST /put` は存在しないので対象外） |
| Task 9 | 公開局 | 完了（設定で `stationPublic`・`stationSlug`（空なら表示名から生成、衝突は 422 `settings.slugTaken`、生成のときは乱数を足して 1 回再試行）。`/stations/s:<slug>` に OGP。`POST /settings` をレート制限の対象に。匿名は公開の項目が出ず、送っても無視。見た目は Task 11 で整える） |
| Task 10 | 取り込みの順位 | 完了（取り込みは long_term 20＋short_term 10 に 1..n の `rank`、直近 10 と保存済みは `rank` なし、計 40。取り込みは `manual`/`url` の `source` を上書きしない。サインイン済みの `GET /put` は好きなもの→`put.imported.top`→`put.imported.recent` の順で順位の数字なし、各候補に `POST /put/register`（要サインイン、履歴に無ければ 404、`manual` にして 303 `/put?itemId=`）。お気に入りの並び（公開局・マイページ）は Spotify の順位を引き継ぐ。手で順位を付ける経路は無い（v1 の決定）。再取り込みは古い順位を消す） |
| Task 11 | 見た目の方針 | 完了。トークン（ライト / ダーク）、Google Fonts、`.panel` `.hero` `.pill` `.site-header`、テーマ切替（`dfm.theme`）、1120px の 2 列レイアウト。スクリーンショットは `docs/screenshots/2026-11-05-theme-*.png`。`.hero` のマークアップとキービジュアルは Task 13、ノブとスイッチの作り込みは Task 12 |
| Task 12 | レトロラジオのコントロール | 完了。`.knob` は 52px の円と coral の針（`--angle` を入力で更新、range は透明で上に重ねてキーボードも可）、ダイヤル面に ON AIR、目盛りの針は ON の間だけゆっくり動く（`prefers-reduced-motion` で止める） |
| Task 13 | キービジュアル | 完了。`/` の先頭に `.hero`（`h1.wordmark` + タグライン + `<picture>`、760px 以下は `kv-mobile.jpg`）。他の局のページにはヒーローなし。スクリーンショットは `docs/screenshots/2026-11-05-hero-*.png` と `2026-11-05-radio-on.png` |
| Task 14 | 文書と本番の設定 | 完了。README・SECURITY・この status を Phase 2 に合わせた |
| Task 16（Phase 2） | DJ の語り口 | 完了。DJ は作品を紹介してお便りを読むだけで、「かけます」「どうぞ」などの再生・視聴の誘いは言わない。verify の `playback:` が dj 行（固定文を除く）で落とし、再生成の対象。固定の手渡しは名前か土地がある送り主なら `script.letterFrom`（「{who}からのお便りです。」）、匿名は `script.readingOnly`。ローカルで eval 3 回、`playback:` は 0 件 |
| Task 15 | 土地を選択式に | 完了。設定の「土地」は国の select と、日本の都道府県・アメリカの州の select（`placeCountry` / `placeRegion`、0007 で列を追加）。地域は選んだ国のものだけ受け付け、合わないと 422。保存で `place` に `placeLabel(…, "ja")` の文字列（島根、カリフォルニア州、アメリカ、ポルトガル）を入れ、お便りと DJ はこれまでどおり `place` を読む。自由入力の欄は無くなり、国を選ぶまでは旧データの `place` をそのまま残す（「選ばない」に戻すと消える）。一覧は `src/worker/geo/places.ts`（日本語名は 204 か国（日本を含む）、残りは英語名）。デモ用シード（`scripts/lib/seed.ts`）のペルソナの `place` は自由文字列のまま（`POST /admin/listeners` 経由で `place` だけに入る）。スクリーンショットは `docs/screenshots/2026-11-05-settings-place.png` |
| Task 17（Phase 2） | 聴いたお便り | 完了。`/me` に `me.heard`: 検証済みの直近 30 回から読まれたお便りを新しい順に最大 50 件（同じお便りは最新 1 件、非公開は除く、返信は除く）。作品カード、主文と原文、送り主、JST の日付、`もう一度聴く`（`/episodes/<id>?seg=<n>`、n は公開分のセグメント位置）、私も・一言のフォーム。件数は出さない。`GET /episodes/:id?seg=n` は範囲外なら 0 で `data-start-seg`、プレイヤーは idle からの再生をそのセグメントから始める。スクリーンショットは `docs/screenshots/2026-11-05-me-heard.png` |

## 2026-11-05 本番デプロイ・Gemini-TTS・デモ投入 完了（Phase 1 の締め）。次は Books の鍵・eval 20 回・声と台本の調整・public 化

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
  - 決定（Task 7）: セッション cookie はリスナー id の決定的な HMAC なので、サインインで紐づけても回さない（既存の設計）。有効な `dfm_sid` 無しでコールバックに来ると孤児の匿名リスナー行ができる。別の Google アカウントに紐づいたリスナーへは上書きせず失敗にする。
  - [ ] Google サインイン（Task 7）: Google Cloud で OAuth クライアント（ウェブ アプリケーション）を作り、承認済みのリダイレクト URI に `https://dococafm.app/auth/google/callback`（開発は `http://127.0.0.1:5173/auth/google/callback`）を登録。`pnpm wrangler secret put GOOGLE_OAUTH_CLIENT_ID` と `GOOGLE_OAUTH_CLIENT_SECRET` で入れ、`.dev.vars` にも写す。同意画面を「本番」に公開（テスト中のままだと登録したテストユーザーしか入れない）。
  - [ ] `printf '30' | pnpm wrangler secret put EPISODE_DAILY_LIMIT`（eval 20 回のため。エージェントの権限では secret の書き込みが拒まれる）。
  - [x] デモ投入（上記）。
  - [ ] eval 20 回: `ADMIN_TOKEN="$PROD_ADMIN_TOKEN" pnpm eval --origin https://dococafm.app --listener <id> --runs 20 --out docs/eval/<日付>.md`（`EPISODE_DAILY_LIMIT` を 25 以上に）。
  - [ ] 下の「public 化前チェックリスト」の残り（GitHub 設定、gitleaks、public 化）。

## 2026-11-04 最終修正 完了。次は本人作業（push・鍵・デプロイ・public 化）

- 設計書・計画は本人承認済み。実行方式は **Subagent-driven**（`superpowers:subagent-driven-development`）。
- 全体レビュー（Claude と Codex）の指摘を 9 コミットで閉じた。主なもの: 定型文が引用検査に当たって 503 になる件、プレイヤーに原文を出す、時事語・作品数・住所・郵便番号の検査、未検証の回と非公開にしたお便りを全出口で出さない、作品の題名と作者の判定、審査員の 3 作品を「近く」に入れる、D1 のクエリ数（`POST /start` 57 → 25、`POST /episodes` 45 → 13）、空の回を作らない、`PUBLIC_ORIGIN` の既定値を空に、開発時の判定の素通しは `DEV_SKIP_CLAUDE=1` だけ、TTS の single-flight と上限、本文の上限、MCP の照会前の IP 制限。詳細は `.superpowers/sdd/2026-11-03-dococa-fm/final-fix-report.md`（gitignore 済み）。
- Cloudflare のプランは **Workers Paid**（本人確認 2026-11-04）。D1 のクエリ上限は 1 回の実行あたり 1000。主な経路は `test/worker/query-budget.test.ts` で数えている。単位がそろっていれば番組の作成は 30 未満だが、単位をその場で作る経路は 1 単位につき 6 文かかり、最悪（18 単位）でおよそ 140 文になる（テストの上限は 150）。Workers Free の 50 は超えるが、Paid の 1000 には十分な余裕がある（2026-11-06 最終修正で更新）。
- 次の一手（当時）: 本人が push → 鍵を入れる → デプロイ → チェックリストを済ませて public 化・提出。push とデプロイは 2026-11-05 に完了（上の節）。
- Task 16 でできたこと: CI（SHA 固定、secret なし）、Dependabot、SECURITY.md、同一オリジン検査、`secureHeaders()`、レート制限（IP とリスナー、1 分 20 回。カウンタは isolate ごと）、番組作成の全体上限（`EPISODE_GLOBAL_DAILY_LIMIT` 既定 300、`CLOUD_TTS_GLOBAL_DAILY_LIMIT` 既定 50（現在の既定は 1800 / 3000）、上限値 `0` は停止）、`SESSION_SECRET` 空のときの 500、未検証の番組は 404。
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
- Task 15 の保留（デプロイは 2026-11-05 に完了。残りは eval 20 回）:eval スクリプトは `pnpm eval`（管理 API の模擬サーバーで動作確認済み）、README の eval 欄は「鍵投入後に 20 回回して記入」のまま。走らせ方は `docs/eval/README.md`。
- デプロイの手順（2026-11-05 に実施済み。再デプロイは `pnpm run deploy` だけ）:
  ```bash
  pnpm wrangler d1 create dococa                 # 出た database_id を wrangler.jsonc の d1_databases に書く
  pnpm wrangler r2 bucket create dococa-audio
  for k in ANTHROPIC_API_KEY SPOTIFY_CLIENT_ID GOOGLE_TTS_SA_JSON TMDB_API_KEY YOUTUBE_API_KEY ADMIN_TOKEN SESSION_SECRET; do pnpm wrangler secret put $k; done
  # 任意: EPISODE_DAILY_LIMIT、EPISODE_GLOBAL_DAILY_LIMIT、CLOUD_TTS_GLOBAL_DAILY_LIMIT、RATE_LIMIT_PER_MINUTE、CLAUDE_MODEL、GEMINI_TTS_MODEL、GEMINI_TTS_VOICE
  # DEV_SKIP_CLAUDE は本番に入れない（開発専用）
  # wrangler.jsonc の vars.PUBLIC_ORIGIN を本番 URL にする（必須。空のままだと /healthz 以外が 500。--var は次の deploy で空に戻るので使わない）
  pnpm db:migrate                                # 0004_tts_claims.sql まで当たる
  pnpm run deploy
  ```
  そのあと本番 URL で `/start` → 番組を聴く。eval は `EPISODE_DAILY_LIMIT` を 25 などに上げて `ADMIN_TOKEN="$PROD_ADMIN_TOKEN" pnpm eval --origin https://<URL> --listener <id> --runs 20 --out docs/eval/<日付>.md`。
- Demo seeding real run held: no key（`ANTHROPIC_API_KEY` が空。入れたら `pnpm seed --items <作品 URL の一覧> --personas 3 --dry-run` で確かめ、`--dry-run` を外して投入。`docs/demo/personas.json` はこのときできる）。デモ用リスナーは `listeners.demo = 1` で、画面・番組に「デモ用」の印が出る。
- YouTube collection real run held: no key（`YOUTUBE_API_KEY` と `ANTHROPIC_API_KEY` を入れたら `pnpm collect --item <url>` を 1 作品で流す。既定は dry-run で `.found/<itemId>.json` に書くだけ。中身を読んで不要な行を消し、`pnpm collect --post .found/<itemId>.json` で投入して、`/items/:id` の「ネットで見つけた声」を確かめる）。`/admin/found` はお便りと同じモデレーションを通り、reject 済みの出典 URL は再投入されない。管理 API は `ADMIN_TOKEN`（Bearer）。デモ回は `POST /admin/episodes`（`listenerId` は `/settings` の末尾に出る）。
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
| 15 | eval、デプロイ、README | 完了（20 回の eval 実走・デプロイは鍵と wrangler login 待ち） |
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
| Google Cloud のサービスアカウント（Vertex AI User。Gemini-TTS 用） | Task 11 | `.dev.vars` の `GOOGLE_TTS_SA_JSON` |
| Anthropic API キー | Task 5 以降 | `.dev.vars` の `ANTHROPIC_API_KEY` |
| Cloudflare アカウントで `wrangler login`、D1 / R2 の作成 | Task 15 | 手元の wrangler |
| 本人のお便り 20〜30 通、知人への依頼 | Task 13〜15 | `POST /letters` か管理 API |
| ドメイン `dococa.fm` の正式な空き確認 | 任意 | — |

## 環境

- Node 20 以上（main-mac は nodenv 24、ops-mac は 25.8）、pnpm 10。wrangler は devDependency で入る。
- Claude Code の plugin `superpowers` が両端末で有効。
- secret は `.dev.vars`（gitignore）。端末をまたぐときは本人が手で写す（リポにも Slack にも置かない）。
