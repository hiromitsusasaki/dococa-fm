# Dococa FM デザイン資料（DESIGN.md）

本人確定 2026-11-05。画面を作る・直すときは、まずこの資料と模型 `docs/design/station-mock.html` に合わせる。実装の正本は `public/app.css`。ここに無い判断が要るときは、模型に当ててから本人に見せる。

## 1. 一文と空気

- 「世界のどこかにいる誰かの好きなものが聴こえてくるラジオ」
- テイスト: レトロフューチャー / シティ・ポップ。夜の部屋でラジオをつけている感じ。モダンなレイアウトに、ラジオの意匠（トグルスイッチ、ノブ、目盛り、ON AIR）を乗せる。
- 爽やかさを保つ: 地は冷色（空色 / 紺）、差し色だけ暖色（サンゴ・レモン・マゼンタ）。暖色を面に広げない。
- 文言はラジオの言葉で、短く。数字で人や作品を測る表現（件数・順位・一致率）は出さない。

## 2. 色（トークン）

CSS 変数は `:root` にライト、`@media (prefers-color-scheme: dark)` と `html[data-theme="dark"]` にダークを定義する。部品は必ずトークン経由で色を取る（直書き禁止）。

| トークン | ライト | ダーク | 用途 |
|---|---|---|---|
| `--paper` | `#e9f1f8` | `#121a2e` | ページの地 |
| `--panel` | `#ffffff` | `#1a2440` | パネル（ラジオ、このあと、カード） |
| `--ink` | `#141b31` | `#eef4f8` | 文字 |
| `--ink-2` | `#44506b` | `#a9b7cc` | 補助の文字 |
| `--line` | `rgba(20,27,49,.16)` | `rgba(238,244,248,.14)` | 罫線・枠線 |
| `--line-strong` | `#c9d2df` | `#4b5878` | ヒーローの枠線（不透明。グラデーションの上で色が変わらないように） |
| `--haze` | `rgba(20,27,49,.06)` | `rgba(238,244,248,.07)` | 面の薄い塗り（お便りの箱、OFF のスイッチ） |
| `--aqua` | `#1fb3a7` | `#4fd1c5` | 冷色の差し色（控えめに） |
| `--sky` | `#3f9fff` | `#7cc4ff` | フォーカスリング、リンク |
| `--coral` | `#ff6f7a` | `#ff8a95` | 暖色の差し色（ラベル、目盛り、ボタンの枠、wordmark） |
| `--magenta` | `#e0409a` | `#f06cb6` | 主ボタン（私も）、作品種別ラベル |
| `--lemon` | `#ffd24d` | `#ffe08a` | 点灯（ON のスイッチ、針、お便りの左線） |
| `--hero` | `#ffffff` | `linear-gradient(160deg,#1c2a52 0%,#2a4a7a 40%,#a04a8a 74%,#ff7a8a 100%)` | ヒーローの地 |
| `--knob` | `radial-gradient(circle at 35% 30%,#fff,#e9eef5 60%,#c9d3e0)` | `radial-gradient(circle at 35% 30%,rgba(255,255,255,.38),rgba(255,255,255,.08) 55%,rgba(0,0,0,.3))` | ノブ |

暖色の使いどころ（これ以外には広げない）:

- wordmark `Dococa FM` のグラデーション（coral → magenta 70% → lemon）
- パネル上端の 4px の帯（coral → lemon 55% → magenta）
- `ON AIR`、見出しラベル（いま流れている / このあと流れるもの）、コントロールのラベル: coral
- 目盛り: coral（不透明度 .55）。針: lemon（`box-shadow: 0 0 8px`）
- お便りの左線: lemon。ボタンの枠: coral。主ボタン（私も）: magenta の塗りに白文字
- 作品種別ラベル（音楽 / 映画 / 本）: magenta
- 作品のジャケットが無いときの代替: coral → magenta のグラデーション

テーマ切替: 既定は端末に合わせる。ヘッダに ライト / ダーク / 端末 の 3 択。`html[data-theme]` を切り替え、`localStorage` に保存（読めなくても動く）。

## 3. 書体と文字

- wordmark（`Dococa FM` だけ）: `"Righteous"`（Google Fonts）。他に使わない。
- 見出し・本文（日本語・英語とも）: `"Zen Kaku Gothic New"`（Google Fonts、400 / 500 / 700）。フォールバック `"Hiragino Kaku Gothic ProN", system-ui, sans-serif`。
- 太い角ゴシック（Dela Gothic One など）は使わない（本人の判断）。
- 大きさ: wordmark `clamp(28px, 4vw, 40px)`、タグライン `clamp(14px, 1.5vw, 16px)`（PC 幅は 1 行、スマホ幅は折り返す）、作品名 18px / 700、本文 14px、ラベル 11〜12px / 字間 .08〜.1em。
- 行間 1.6。ラベルは字間を広げる。数字は `tabular-nums`。

## 4. 部品

| 部品 | 形 | 状態 |
|---|---|---|
| `.hero` | 丸角 24px、枠線 1px `--line-strong`、影 `0 18px 40px rgba(20,40,70,.12)`、`background-clip: padding-box`。PC 幅は 2 列（左: wordmark とタグライン、右: キービジュアル `public/kv.jpg` を 3:2・丸角 16px・影つき）。スマホ幅は 1 列で絵は文の下に全幅 | ライトは白、ダークはグラデーション |
| `.panel`（ラジオ、このあと、カード） | 丸角 22px、`--panel`、枠線 1px `--line`、影、上端に 4px の帯（`::before`） | |
| `.face`（ラジオの面） | 左に `DOCOCA FM`、右に赤い点つきの `ON AIR`。破線の下罫 | 局名は出さない |
| `.scale`（目盛り） | 12px の高さの縦線の繰り返し + 針 | 針の位置は飾り（再生位置ではない） |
| `.switch` | 72×36 のトグル。`aria-pressed` | OFF: `--haze` と枠線。ON: `--lemon` に点灯 + `box-shadow` のゆるい明滅（`prefers-reduced-motion` で止める） |
| `.knob` | 52px の円、`--knob`、針は coral | 音量とセレンディピティの 2 つ。`input[type=range]` を置き換え、キーボードでも動く |
| お便り `blockquote` | 左線 3px `--lemon`、`--haze` の地、丸角 `0 12px 12px 0` | 主文 → 原文トグル（`<details>`）→ 送り主（`〇〇さん（土地、国）［デモ用］`） |
| `.pill` | 枠線 1px coral、丸、13px | 主ボタン `.pill.hot` は magenta 塗り・白文字・700 |
| このあと流れるもの | 種別ラベル（magenta、11px）と作品名・作者の行。上罫 1px `--line` | 数字（順番）を付けない |
| ヘッダ `.site-header` | 右上に お便りを送る / マイページ / サインイン（サインイン済みは名前とサインアウト） | |

タップ領域は 44px 以上。フォーカスは `outline: 2px solid var(--sky); outline-offset: 2px`。

## 5. レイアウト

- 最大幅 1120px、左右の余白は `max(16px, env(safe-area-inset-*))`。
- PC 幅（> 760px）: ヒーロー（2 列）→ 本体 2 列（左 1.3fr: ラジオ、いま流れている、お便り、反応ボタン。右 1fr: このあと流れるもの、あなたのラジオ）。
- スマホ幅（<= 760px）: すべて 1 列。ラジオ → いま流れている → お便り → 反応 → このあと。
- 間隔は 4px の倍数。パネル内の余白 18〜20px。要素間 12〜22px。
- 画像と `aspect-ratio` の箱は `max-width: 100%`。横スクロールを出さない。

## 6. 文言（UX ライティング）

日本語と英語を `src/worker/i18n/ja.ts` / `en.ts` に同じキーで持つ。画面に日本語を直書きしない。

| 場面 | 日本語 | 英語 |
|---|---|---|
| タグライン | 世界のどこかにいる誰かの好きなものが聴こえてくるラジオ | A radio where you hear what someone, somewhere, loves |
| スイッチ | ラジオをつける / 止める | Turn the radio on / Stop |
| 放送中 | ON AIR | ON AIR |
| 音量 | 音量 | Volume |
| ダイヤル | セレンディピティ | Serendipity |
| いま | いま流れている | Now playing |
| 次 | このあと流れるもの | Up next |
| 自分の局 | あなたのラジオ | Your radio |
| 人の局 | 〇〇さんのラジオ | 〇〇's radio |
| お便り | お便りを送る / 送る | Send a letter / Send |
| 反応 | 私も / 一言を送る | Me too / Reply |
| 出口 | この作品を聴く・観る | Listen or watch |
| 原文 | 原文を見る / 訳を見る | Show original / Show translation |
| デモ | ［デモ用］ | [Demo] |

使わない言葉: 「局」「みんなのラジオ」「置く」（お便りは送る）、「世界の局」「遠くのダイヤル」「知らないものの割合」、順位や件数を示す数字。

お便りの表示: 設定言語と原文の言語が違うときは訳を主文にし、「原文を見る」で原文に切り替える。原文は決して書き換えない。

## 7. 素材

- キービジュアル: `public/kv.jpg`（1280 幅）、`public/kv-mobile.jpg`（800 幅）。alt は「机でレトロなラジオを聴く人と、世界の誰かの好きなもの」。元 PNG は private workspace `outputs/2026-11-05-kv-source.png`。差し替えるときは同じ構図（机に頬杖をついてラジオを聴く人。ヘッドホンは無し。ラジオの電波の弧、夜景の上の無人の地球。人影や線は入れない。本人確定 2026-11-05 第 3 版）。
- 模型: `docs/design/station-mock.html`。ブラウザで開くと ライト / ダーク、PC 幅 / スマホ幅 を切り替えて確かめられる。
- アイコン / manifest の `theme-color` はダークの `--paper` `#121a2e`。

## 8. 確かめ方

- UI を変えたら、ライトとダーク、PC 幅（1120px）とスマホ幅（390px）の 4 通りをスクリーンショットで見る（`docs/screenshots/`）。
- 新しい色・書体・部品を足すときは、先にこの資料と模型を更新してから実装する。
