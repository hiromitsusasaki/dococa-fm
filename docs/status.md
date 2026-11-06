# status — Dococa FM の現在地

> 新しいセッションはまずここを読む。更新はタスクの区切りごと（最新を上に）。

## Phase 4 の進み（計画: `docs/superpowers/plans/2026-11-06-dococa-fm-phase4.md`、設計: 追記 L）

| Task | 内容 | 状態 |
|---|---|---|
| Task 1 | お住まい（画面と手渡しの言い方） | 完了 |
| Task 2 | MCP の撤去 | 完了（`/mcp`・`/settings/mcp-token`・MCP の依存 2 つ・レート制限と session の例外を外した。`/settings` の末尾にリスナー ID の行を残す） |
| Task 3 | ラジオ面のダイヤル（要求ごとに 1 目盛り） | 未着手 |
| Task 4 | 遠さ（埋め込みと距離の帯） | 未着手 |
| Task 5 | ホームに今届いているお便り | 未着手 |
| Task 6 | 送る画面（並び・お気に入りから選ぶ・検索・ブックマークレット） | 未着手 |
| Task 7 | マイページの並び | 未着手 |
| Task 8 | モデレーションの理由と再判定 | 未着手 |
| Task 9 | 単位のフィードバックの輪（管理画面・良い例・採点スクリプト） | 未着手 |
| Task 10 | 締めのドキュメント | 未着手 |

決定: MCP は Phase 4 で外した（事前生成で役目を終えた）。列 `mcp_token` は残して使わない。

## 2026-11-06 Phase 3 完了（最終レビュー済み・ローカル）。次は本人作業 → デプロイ → public 化

Phase 2（ラジオ中心の体験への作り替え）と Phase 3（単位・音声の鍵・つなぎ・事前生成・聴いた記録・土地コード・英語の DJ）の実装は、最終レビューの修正まで含めてすべて main にコミット済み。本番は Phase 1 の状態のままなので、下の本人作業を上から順に済ませてデプロイする（migrate → deploy → `/admin/prepare`）。本番 URL は `https://dococafm.app`、再デプロイは `pnpm run deploy`。

### 本人作業

- [ ] 任意: 単位（お便りごとの DJ の語り）の 1 日の上限 `UNIT_DAILY_LIMIT`（既定 1000、`0` で停止）を変えるときは `pnpm wrangler secret put UNIT_DAILY_LIMIT`（Cloudflare の secret か var。既定でよければ設定しない）。
- [ ] 任意: お便りと一言の全体の 1 日の上限 `LETTER_GLOBAL_DAILY_LIMIT`（既定 500、`0` で停止。数えるのはお便りと一言だけで、「私も」と見つけた声は数えず止めない）を変えるときは `pnpm wrangler secret put LETTER_GLOBAL_DAILY_LIMIT`。`/admin/letters` のシードもこの上限に従うので、大量に投入する日は先に上げる。
- [ ] GCP で OAuth クライアント（種類: ウェブ アプリケーション）を作る。承認済みのリダイレクト URI は `https://dococafm.app/auth/google/callback` と `http://127.0.0.1:5173/auth/google/callback`。
- [ ] `pnpm wrangler secret put GOOGLE_OAUTH_CLIENT_ID` と `pnpm wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET` を実行し、`.dev.vars` にも同じ値を写す。
- [ ] OAuth の同意画面を「本番」に公開する（テスト中のままだと、登録したテストユーザーしか入れない）。
- [ ] Google Cloud で Books API を有効化し、キーを `.dev.vars` の `GOOGLE_BOOKS_API_KEY` と `pnpm wrangler secret put GOOGLE_BOOKS_API_KEY` に入れる（YouTube のキーに Books API を足して同じ値でもよい）。入ったら本のデモを追加投入する（`pnpm seed --items <file> --personas 30 --reuse --origin https://dococafm.app`）。
- [x] `pnpm db:migrate` で本番に 0005〜0014 を当てた（2026-11-06）。**0015（tts_v3）と 0016（revoice_handover: 手渡しの言い方が変わるので単位の音声を作り直す）はまだ**: 音声の鍵を v3 に変え、`tts_audio` を空にして `units.audio_ready` を戻す。当てたら `pnpm run deploy` → `/admin/prepare` をやり直す。R2 の `tts/v2/` は手で消してよい（残っても害はない）。
- [ ] `pnpm run deploy`。
- [ ] デプロイ後、`POST /admin/prepare`（`Authorization: Bearer $ADMIN_TOKEN`）で、デモデータの日本語と英語の単位と音声を先に作っておく。1 回の実行は単位と音声を合わせて最大 `limit` 件なので、`remaining` が 0 になるか `failed` が変わらなくなるまで繰り返す。音声の上限（既定 3000 行/日）に当たったら翌日（JST）に続く（Cron は 15 分ごとに 20 件ずつ埋める）。
- [ ] 本番のデモデータは土地コードなしでシードしてある（`/admin/listeners` がコードを受け取るのは最終修正から）。英語の画面と英語の DJ では、コードの無いペルソナのお便りに日本語の土地（`place`）が出る。直すにはペルソナを作り直して再シードする（`pnpm seed --reuse` はペルソナの国名からコードを付けて送る）。するかどうかは本人が決める。
- [ ] シードの量に注意: お便り 1 通で音声はおよそ 8 行（日本語と英語の intro・手渡し・お便り・after）、ほかにつなぎの定型が 14 行（7 本 × 2 言語）を一度だけ使う。単位はお便り 1 通・1 言語で Claude を 2〜4 回呼ぶ。大量に入れるなら、デモの前日にシードするか、その日だけ `CLOUD_TTS_GLOBAL_DAILY_LIMIT` を上げる（`UNIT_DAILY_LIMIT` と `LETTER_GLOBAL_DAILY_LIMIT` も同じ）。
- [ ] 本番で確かめる: ホームの「ラジオをつける」、Google サインイン、`/me`、公開局 `/stations/s:<slug>`、日本語と英語の切り替え。
- [ ] Spotify Developer Dashboard の Redirect URI を `https://dococafm.app/auth/spotify/callback`、Website を `https://dococafm.app` に。TMDB の Application URL も同じく（済んでいなければ。新ドメインに揃える）。
- [ ] eval 20 回: `printf '30' | pnpm wrangler secret put EPISODE_DAILY_LIMIT` のあと、`pnpm eval --origin https://dococafm.app --token "$ADMIN_TOKEN" --listener <id> --runs 20 --out docs/eval/<日付>.md`。結果を README の eval 表に書く。
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
  - [ ] eval 20 回: `pnpm eval --origin https://dococafm.app --token "$ADMIN_TOKEN" --listener <id> --runs 20 --out docs/eval/<日付>.md`（`EPISODE_DAILY_LIMIT` を 25 以上に）。
  - [ ] 下の「public 化前チェックリスト」の残り（GitHub 設定、gitleaks、public 化）。

## 2026-11-04 最終修正 完了。次は本人作業（push・鍵・デプロイ・public 化）

- 設計書・計画は本人承認済み。実行方式は **Subagent-driven**（`superpowers:subagent-driven-development`）。
- 全体レビュー（Claude と Codex）の指摘を 9 コミットで閉じた。主なもの: 定型文が引用検査に当たって 503 になる件、プレイヤーに原文を出す、時事語・作品数・住所・郵便番号の検査、未検証の回と非公開にしたお便りを全出口で出さない、作品の題名と作者の判定、審査員の 3 作品を「近く」に入れる、D1 のクエリ数（`POST /start` 57 → 25、`POST /episodes` 45 → 13）、空の回を作らない、`PUBLIC_ORIGIN` の既定値を空に、開発時の判定の素通しは `DEV_SKIP_CLAUDE=1` だけ、TTS の single-flight と上限、本文の上限、MCP の照会前の IP 制限。詳細は `.superpowers/sdd/2026-11-03-dococa-fm/final-fix-report.md`（gitignore 済み）。
- Cloudflare のプランは **Workers Paid**（本人確認 2026-11-04）。D1 のクエリ上限は 1 回の実行あたり 1000。主な経路は `test/worker/query-budget.test.ts` で数えている。単位がそろっていれば番組の作成は 30 未満だが、単位をその場で作る経路は 1 単位につき 6 文かかり、最悪（18 単位）でおよそ 140 文になる（テストの上限は 150）。Workers Free の 50 は超えるが、Paid の 1000 には十分な余裕がある（2026-11-06 最終修正で更新）。
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
  そのあと本番 URL で `/start` → 番組を聴く。eval は `EPISODE_DAILY_LIMIT` を 25 などに上げて `pnpm eval --origin https://<URL> --token "$ADMIN_TOKEN" --listener <id> --runs 20 --out docs/eval/<日付>.md`。
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
