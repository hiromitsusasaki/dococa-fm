# Phase 9 — AI で上げる 4 点（2026-11-08、本人の指示）

本人が 2026-11-08 朝に選んだ 4 点。提出（20:00 JST）前に本番へ入れる。守ること（CLAUDE.md「AI がしないこと」）はそのまま: お便りは原文のまま、出典の無い声を作らない、時事を言わない、数字で人や作品を測らない（件数・人数も言わない）。既存の検証（`verify.ts`）を通らない行は流さない。Claude が使えないときは、どの機能も今までどおりの動きに戻る（落ちない）。

共通: 文言キーは ja と en を同時に足す（`test/worker/i18n.test.ts` が差を落とす）。テストは `pnpm test`、型は `pnpm typecheck`。コミットは `feat:` + 英語の要約、本文に日本語で要点。commit は明示の pathspec で。push しない。

## Task 1 — 好みに「お便りの中身」を入れる（埋め込み）

いま: 作品ベクトル = `itemText`（題名 — 作者 (年) [種類]）の bge-m3。好み = 自分が送った／私も・一言を返したお便りの作品ベクトルの平均（`taste.ts` `standingOf`、`select-sql.ts`）。候補との距離で近い／隣／遠い。

変える:
- migration `0026_letter_vec.sql`: `ALTER TABLE letters ADD COLUMN vec BLOB;` と `ALTER TABLE items ADD COLUMN vec_mix BLOB;`（量子化は `items.vec` と同じ `quantise`/`dequantise`）。
- お便りのベクトル: 公開の `letter` と `reply`（私もは除く）について、`${itemText(item)}\n${body}`（原文の言語のまま。bge-m3 は多言語）を埋め込み、`letters.vec` に入れる。作るタイミングは (a) お便り作成の `defer`（`letters/create.ts` の `prepareLetter` と並べる）、(b) `/admin/prepare` のループ（`remaining.letterVecs` を返す。既存の `ensureItemVectors` と同じ予算の考え方）。
- 作品の混ぜたベクトル `items.vec_mix` = normalise(`items.vec` + その作品の公開お便り（letter/reply）の `vec` の平均)。お便りのベクトルを作るたびに、その作品の `vec_mix` を作り直す（`db/items.ts` に `refreshItemMix(db, itemId)`）。お便りが非公開になったときも作り直す（`setLetterStatus` の呼び元で呼ぶ。漏れても次の prepare で直るよう、prepare のループでも `vec_mix` が無い作品を作る）。
- 選曲: `getItemVecs` は `COALESCE(vec_mix, vec)` を返す（`vec_mix` があればそれ）。
- 好み（`TASTE_OWN_SQL`）: 自分のお便りはその `letters.vec`、私も・一言はその親お便りの `letters.vec`、無ければ今までどおり作品の `COALESCE(vec_mix, vec)`。`TASTE_HEARD_SQL` も聴いたお便りの `vec`、無ければ作品のベクトル。
- ログには本文もベクトルも出さない（`embed.ts` の方針）。
- docs: `docs/how-it-works.md` の「作品のベクトルと、聴く人の好み」を書き換える。`docs/status.md` に 1 行。
- テスト: `test/worker/ai/embed.test.ts`（あれば）に letter vec と vec_mix、`test/worker/program/taste.test.ts` に「自分のお便りの本文のベクトルが好みに入る」「vec が無いお便りは作品のベクトルで埋める」。migration のテストは既存の流儀に合わせる。
- デプロイ手順を `docs/status.md` に書く: `pnpm db:migrate`（0026）→ deploy → `/admin/prepare` を `remaining.letterVecs` が 0 になるまで。

## Task 2 — 遠い棚からのとき、DJ が橋渡しを言う

いま: 枠の頭に固定の `bridge.far`「次は、少し遠くからのお便りです。」（`compose.ts`）。単位（intro/after）は全員共通で作り置き。

変える（自分のラジオ `mine` だけ。人の公開ラジオと `world` は今までどおり固定文）:
- 遠い枠（slot が `far`）で、聴く人に自分の声（送ったお便り・一言を返したお便り）が 1 つ以上あるとき、固定の `bridge.far` の代わりに Claude が書いた 1 文（`bridge` 行、`type: "dj"`、`fixed: false`）を置く。
- Claude に渡すもの: 聴く人の作品（送ったお便り・返したお便りの作品を新しい順に最大 3: 題名・作者・種類だけ。本文は渡さない）、次の作品（題名・作者・種類）。指示: 「あなたの好きな『○○』とは少し違う毛色の一曲です」のように、聴く人の作品を 1 つだけ名指しして、次の作品へやわらかく橋をかける。45 字以内。題名の繰り返しは次の作品についてはしない（直後に冒頭の一行が題名を言う）。時事・数・順位・再生を促す言い方は禁止。送り主の名前と土地は言わない。
- 返った文は `verifyEpisode` の dj 行の規則（topical / measure / announce / playback）を通す。通らない・Claude が使えない・上限に達した・5 秒で返らない、のどれでも固定の `bridge.far` に戻す。
- 作り置き: `bridges` テーブルを足す（migration `0027_bridges.sql`: `listener_id, item_id, lang, text, spoken, created_at`、主キー (listener_id, item_id, lang)）。同じ人・同じ作品の橋は使い回す。1 日の上限 `BRIDGE_DAILY_LIMIT`（既定 400、環境変数で変更）は `unitCapReached` と同じ数え方。
- 読み: 聴く人の作品の `readingJa` と次の作品の `readingJa` を `applyReadings` で `spoken` に入れる（`speechReadings` と同じ）。
- 英語の回も同じ（英語の指示文）。
- `how-it-works.md` の「次の 1 枠の選び方」に 1 段落、`broadcast.md` があれば橋の行を追記。`status.md` に 1 行。
- テスト: `test/worker/program/compose.test.ts`（または新規 `bridge.test.ts`）に、far のとき Claude の文が入る／検証に落ちたら固定文／Claude 無しなら固定文／`world` では固定文／同じ人・作品では 2 回目は保存した文、を足す。Claude はモックする（既存の unit のテストの流儀）。

## Task 3 — 「私も」が届いたお便りへの DJ の反応

いま: 単位の `after` は作成時に一度だけ書かれる。私もは固定文 `script.reaction`。

変える:
- お便りに「私も」が届いたとき（`letters/create.ts` の watashimo 作成の `defer`）、その親お便りの単位をもう一度書く（`remakeUnit` を使う）。書き直すのは、親お便りの私もが 1 件目のときと、別々の土地（`placeCountry` が異なる）からの私もが 3 つ目になったときの、合計 2 回まで（`units` に `reactions_seen INTEGER DEFAULT 0` を足す migration `0028_units_reactions.sql`。書き直した時点の私もの件数を入れ、それより増えた条件のときだけ書き直す）。
- Claude に渡すもの: 私もを返した人の土地（`place` の文字列。無ければ渡さない。最大 3）。本文・名前・件数は渡さない。指示（after の説明に足す）: 「このお便りには、次の土地の人から『私も』が届いている: …。after で、同じ気持ちの人がいることに一言触れてよい。人数や件数は言わない。土地は言ってもよい」。英語も同じ。
- 検証はこれまでどおり（`measure` が数を落とす）。
- 書き直し中は古い単位をそのまま流す（`remakeUnit` の既存の動き）。
- `how-it-works.md` の「3. 一言と「私も」」に追記。`status.md` に 1 行。
- テスト: `test/worker/program/unit.test.ts` に、私もの土地が prompt に入る／1 件目と 3 土地目で書き直す／2 件目では書き直さない。`letters/create` のテストに defer が呼ばれること。

## Task 4 — 書きかけへの問い返し

いま: `/put` で作品を選ぶと、履歴にある作品のときだけ `elicitQuestions` の問い（最大 2）を出す。

変える:
- 問いは履歴に無い作品でも出す（`isInHistory` の条件を外す。1 回の表示で Claude 1 回。`ELICIT_DAILY_LIMIT` 既定 600 を `tts_claims` と同じ日次カウンタの流儀で数え、超えたら出さない）。
- 書きかけへの問い返し: 書く欄の下に `button.put-ask`「DJ に問い返してもらう」（`put.ask` ja/en）。押すと `POST /put/ask` に `{ itemId, draft }`（JSON、同一オリジン、サインイン必須、`searchRateLimit` と同じ流儀で 1 分 6 回）。サーバーは Claude に作品と書きかけを渡し、「書きかけの続きを引き出す、答えなくてよい前提のやわらかい問いを 1 つ。60 字以内。時事・個人情報を聞かない。書きかけを引用しない」で 1 文を返す（`elicit.ts` に `askBack(env, item, draft)` を足す。`containsTopical` で落とす）。書きかけはどこにも保存しない（ログにも出さない）。
- 画面: 返った問いを欄の上の `p.put-askback` に出す。失敗や空のときは `put.askNone`「いまは問いを思いつきませんでした」を 3 秒出して消す。ボタンの下に小さく `put.askNote`「書きかけは保存しません」。クライアントは `src/client/put.ts`（無ければ新規。`/put` のページで読む。`embed=1` でも動く）。
- テスト: `test/worker/routes/put.test.ts` に `POST /put/ask`（サインイン無し 401 / 空の draft 422 / Claude をモックして 1 文 / 時事語を含む返事は空）。`test/client/put.test.ts` にボタン → fetch → 表示。

## Task 5 — AI の仕組みの説明文書（4 本のあと、司令塔）

`docs/ai.md`（仮題「Dococa FM の AI」）を新しく作る: どこで Claude・Gemini-TTS・bge-m3 を使い、何を渡して何を返させ、何を機械的に検証し、何をしないか（1〜4 を含む）。図 1 枚（mermaid）。README の「どう作ったか」からリンクし、提出文（概要・Claude の活用）と動画の「仕組み」の場面にも反映する。

## 統合

4 本は別ブランチ（`phase9/task1` … `task4`）。司令塔が順に main へ merge し、`pnpm test` と `pnpm typecheck`、opus のレビューを通してから本人がデプロイ（Task 1 は migration あり）。
