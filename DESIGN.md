---
name: Copilot Session Atlas
description: セッションログの集計を、罫で仕切った様式(記入済みの帳票)として読ませるレポート
colors:
  form: "#1b6549"
  form-wash: "#e8f2ec"
  page: "#f3f5f3"
  surface: "#ffffff"
  ink: "#141816"
  ink-2: "#464e4a"
  ink-3: "#636b67"
  rule: "#c5d4cc"
  rule-strong: "#86a898"
  control: "#6f7f77"
  warn: "#8a4b00"
  warn-wash: "#fbf1e3"
  series-1: "#2a78d6"
  series-2: "#eb6834"
  series-3: "#1baf7a"
  series-4: "#eda100"
  missing: "#b9bcb8"
  grid: "#e1e0d9"
  axis: "#c3c2b7"
  form-dark: "#7cc3a3"
  form-wash-dark: "#1b2822"
  page-dark: "#0e1110"
  surface-dark: "#161a18"
  ink-dark: "#e8ece9"
  ink-2-dark: "#bcc4c0"
  ink-3-dark: "#939c97"
  rule-dark: "#34423b"
  rule-strong-dark: "#5c7568"
  control-dark: "#7a8c84"
  warn-dark: "#f0b25c"
  warn-wash-dark: "#2a2116"
  series-1-dark: "#3987e5"
  series-2-dark: "#d95926"
  series-3-dark: "#199e70"
  series-4-dark: "#c98500"
  missing-dark: "#4b504d"
  grid-dark: "#2c2c2a"
  axis-dark: "#383835"
typography:
  headline:
    fontFamily: "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', Meiryo, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', Meiryo, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
  subtitle:
    fontFamily: "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', Meiryo, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.3
  value:
    fontFamily: "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', Meiryo, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', Meiryo, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
  table:
    fontFamily: "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', Meiryo, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'Segoe UI', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', Meiryo, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.02em"
  mono:
    fontFamily: "'Cascadia Mono', Consolas, 'BIZ UDGothic', ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  none: "0"
spacing:
  cell-y: "5px"
  cell-x: "8px"
  field-x: "12px"
  gap: "12px"
  gutter: "24px"
  section: "28px"
  rail-gap: "32px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.form}"
    typography: "{typography.table}"
    rounded: "{rounded.none}"
    padding: "4px 12px"
  button-hover:
    backgroundColor: "{colors.form-wash}"
    textColor: "{colors.form}"
  button-disabled:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-3}"
  segment:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "3px 10px"
    height: "24px"
  segment-pressed:
    backgroundColor: "{colors.form}"
    textColor: "{colors.surface}"
  select:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.table}"
    rounded: "{rounded.none}"
    padding: "3px 6px"
    height: "30px"
  tag:
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 6px"
  tag-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.warn}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.value}"
    rounded: "{rounded.none}"
    padding: "8px 12px 10px"
  ledger-head:
    backgroundColor: "{colors.form-wash}"
    textColor: "{colors.form}"
    typography: "{typography.label}"
    padding: "5px 8px"
  ledger-cell:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.table}"
    padding: "5px 8px"
  toc-link:
    textColor: "{colors.ink-2}"
    typography: "{typography.table}"
    height: "36px"
  toc-link-current:
    textColor: "{colors.form}"
---

# Design System: Copilot Session Atlas

この文書は、レポート(`out/atlas.html`・詳細ページ・用語ページ)の今の見た目を、コード(`packages/report/src/styles/base.css` と各部品の `<style>`)から書き起こしたものです。値の正は上のフロントマター(とその元の CSS 変数)で、本文は使いどころの説明です。色の名前に `-dark` が付くものは、ダーク配色のときの同じ役の値です。

## Overview

**Creative North Star: "記入済みの様式"**

役所や経理の帳票のように、罫で仕切った欄に値が記入されている紙面です。欄の左上に小さな項目名があり、その下に値が入ります。飾りで注意を引くのではなく、罫と項目名の位置で「どこに何が書いてあるか」を先に分からせます。CSS の中でもこの考え方を「様式」と呼んでいて、基調の緑の変数名も `--form` です。

密度は高めです。本文は 14px(0.875rem)、表は 13px、項目名は 12px で、1 画面に全体 → 絞り込み → 根拠のセッションまでを並べます。その代わり、面は平らで、角は丸めず、影も付けません。色は緑 1 色(見出しの罫・項目名・リンク・押せるもの)と、注意の茶色、グラフの系列色だけです。

読む人は、元のセッションを知らない相手のこともあります。だから、記録が無い値は「記録なし」と書き、推定は推定と書き、色だけで区別させません。

**Key Characteristics:**

- 罫で仕切った欄と表が紙面の骨格。面を浮かせず、罫の濃さ(薄い罫・濃い罫・緑の 2px)で区切りの強さを表す
- 角丸なし、影なし、動きは画面内の移動(スムーズスクロール)だけ
- 緑は「様式の色」: 項目名・見出しの下の罫・リンク・ボタンの枠
- 数値は右寄せの等幅数字(`tabular-nums`)、桁区切りあり
- 記録の無い値は灰色の「記録なし」「—」で、0 と区別する
- ライト・ダークの両方で同じ役割の色を持つ(自動・ライト・ダークを切り替えられる)

## Colors

白い紙に緑の罫、という 1 色の帳票です。ダークでは、暗い紙に明るい緑の罫になります。

### Primary

- **様式の緑**(`form`): 項目名、表の見出しの文字、見出しの下の 2px の罫、リンク、ボタンの枠と文字、選ばれている切り替えボタンの地、キーボードの焦点の枠。「押せる」「ここが項目名」を表す色です。
- **様式の緑の淡い地**(`form-wash`): 表の見出しの地、ボタンや切り替えにカーソルを載せたときの地。

### Secondary

- **注意の茶**(`warn`)と**その淡い地**(`warn-wash`): 警告の札、サーバが止まったときの帯、詰まったターンの左の印。失敗や要注意だけに使います。

### Tertiary

- **グラフの系列色**(`series-1` 青・`series-2` 橙・`series-3` 緑・`series-4` 黄): グラフの系列だけに使います。画面の部品には使いません。
- **記録なしの灰**(`missing`): グラフで、記録が無い分を表す色。凡例でも必ず言葉で示します。
- **目盛りの線**(`grid`)と**軸の線**(`axis`): グラフの中だけ。

### Neutral

- **紙の外**(`page`): ページの地。わずかに緑がかった灰色。
- **紙**(`surface`): 欄・表・帯の地。
- **墨**(`ink`): 本文と値。
- **薄墨**(`ink-2`): 説明文、札の文字、選ばれていない切り替えの文字。
- **淡墨**(`ink-3`): 補足、記録なしの表示、無効な部品の文字。
- **罫**(`rule`): 欄と表のふつうの罫。
- **濃い罫**(`rule-strong`): 欄の上端、表の見出しの下、帯の下端。
- **入力部品の枠**(`control`): select・日付・札・切り替えの枠。罫より濃く、紙の上で 3:1 以上のコントラストを保ちます。

### Named Rules

**緑は様式の色の規則。** 緑(`form`)は項目名・罫・押せるものにだけ使います。値そのものや、良い・悪いの評価には塗りません。

**色だけにしない規則。** 状態や系列の違いは、色に加えて言葉・印・位置のどれかでも分かるようにします(例: 絞り込み中の行は地の色と「絞り込み中」の文字、別のウィンドウで開くリンクは「↗」)。

## Typography

**Display Font:** Segoe UI(続いて Yu Gothic UI、Hiragino Sans、Noto Sans JP、Meiryo、system-ui)
**Body Font:** 同じ
**Label/Mono Font:** Cascadia Mono(続いて Consolas、BIZ UDGothic、ui-monospace)

**Character:** 読む端末に入っている UI 用の書体をそのまま使います。Web フォントは読み込みません(レポートは 1 つの HTML で、ネットワーク無しで開くため)。書体で個性を出さず、大きさと太さの差を小さく保って、表と欄を主役にします。

### Hierarchy

- **Headline**(`headline`): ページの題(レポート名、詳細ページのセッション名)。1 ページに 1 つ。
- **Title**(`title`): 節の見出し(「全体サマリ」「人別」「プロジェクト別」など)。下に緑の 2px の罫が付きます。
- **Subtitle**(`subtitle`): 節の中の小見出し。
- **Value**(`value`): 欄の値(セッション数、実働時間など)。紙面でいちばん大きい字は題ではなく値です。
- **Body**(`body`): 本文。節の説明文は 1 段小さい `table` の大きさで、70 字ほどで折り返します。
- **Table**(`table`): 表の中身、ボタン、select、目次。
- **Label**(`label`): 欄の項目名、表の見出し、札、補足。絞り込みの行の項目名だけはさらに小さい 0.6875rem です。
- **Mono**(`mono`): ID、パス、ファイル名、コマンド。

### Named Rules

**値が主役の規則。** いちばん大きく太い字は欄の値です。見出しは値より小さく、罫で区切りを示します。

**文節で折る規則。** 見出しと説明文は日本語の文節で折り返します(`word-break: auto-phrase`、見出しは `text-wrap: balance`)。数値と表の見出しは折り返しません。

## Layout

- 768px 以上は 2 列です。左に幅 13em の目次(スクロールしても残る)、右に本文。本文の最大幅は 1360px、左右の余白は 24px、列の間は 32px。
- 768px 未満は 1 列です。目次は上に固定した 1 行の帯になり、横に流れます(続きがあることは端の影で示します)。その右に、表示中の件数と絞り込みの解除が出ます。
- 節の間は 28px。節の見出しの行には、左に見出し、右に説明文を並べ、幅が足りなければ説明文が下に回ります。
- 欄は格子に並べます(既定は 4 列)。720px 以下では 2 列にし、値の字を 1 段小さくします。
- 列の多い表は、表だけを横にスクロールさせます。ページの幅は広げません。続きがある側の端に影が出ます。
- 押す的は 24px 以上(目次は 36px、select と日付は 30px)。

## Elevation & Depth

面は平らです。浮かせる影は使いません。重なりは、罫の濃さと地の色(紙の外・紙・緑の淡い地)で表します。

例外は 2 つだけで、どちらも「浮き」ではなく手掛かりです。

- 横にスクロールできる表と目次の、端のぼかし(続きがあることを示す)
- 上に貼り付いた帯の下の 1px の線、詰まったターンの行の左の 3px の印

### Named Rules

**平らな紙の規則。** 欄・表・ボタン・ダイアログに、浮かせるための影を付けません。区切りは罫で引きます。

## Shapes

角はすべて直角です(`border-radius: 0`。ブラウザ既定で丸くなる select や入力欄も 0 に戻しています)。丸いのは、チャットで判定する手順の番号の印 1 つだけです。

罫は 1px の実線が基本で、強さは 3 段です。薄い罫(欄・表の仕切り)、濃い罫(欄の上端、表の見出しの下、帯の下端)、緑の 2px(節の見出しの下、目次の今いる項目)。畳んである条件の行の上だけ、破線を使います。

隣り合う欄の罫は 1px 重ねて、線が二重にならないようにします。

## Components

### Buttons

- **形:** 直角、緑の 1px の枠、紙の地に緑の文字(`button`)。
- **カーソルを載せたとき:** 地が緑の淡い色になります(`button-hover`)。キーボードの焦点は、緑の 2px の枠を 2px 離して出します(全部品共通)。
- **無効:** 枠が薄い罫の色、文字が淡墨になります(`button-disabled`)。
- **切り替え(配色・グラフの値):** 枠でひとまとめにしたボタンの並び(`segment`)。選ばれているものは緑の地に紙の色の文字(`segment-pressed`)で、`aria-pressed` も付けます。

### Chips

- **札**(`tag`): 入力部品の枠と同じ色の 1px の枠、薄墨の文字。詳細ページの「人」「プロジェクト」「クライアント」など、値の種類と値を「種類: 値」の形で書きます。長いパスは折り返します。
- **注意の札**(`tag-warn`): 茶の枠と文字、茶の淡い地。

### Cards / Containers

- **欄**(`field`): 罫で仕切った記入欄。左上に緑の小さな項目名、その下に大きな値、その下に淡墨の補足。上端だけ濃い罫です。カードのように離して並べず、罫を共有して 1 枚の表のように組みます。
- **節:** 見出しの行の下に緑の 2px の罫。節を箱で囲みません。

### Inputs / Fields

- **select・日付**(`select`): 直角、入力部品の枠、高さ 30px。カーソルを載せると枠が緑になります。無効のときは文字が淡墨になり、理由を横に書きます。
- **項目名:** 入力部品の上に、緑の小さな字で置きます(`label` 要素でつなぐ)。

### Navigation

- **目次:** 広い画面では左の列に、群の題つきの縦の一覧。狭い画面では上の帯に横 1 行。今いる項目は緑の太字と緑の 2px の線(`toc-link-current`)で、`aria-current` も付けます。
- **絞り込み中の行:** 表の中で、絞り込みに使っている行は地の色を変え、名前の下に「絞り込み中(もう一度押すと解除)」と書きます。

### 罫線の表

このレポートの中心の部品です(`ledger-head`・`ledger-cell`)。すべてのセルに 1px の罫を引き、見出しは緑の淡い地に緑の文字、下端だけ濃い罫。数値の列は右寄せの等幅数字で折り返しません。列見出しを押すと並べ替えられ、今の並びは印と `aria-sort` で示します。記録の無いセルは淡墨の「記録なし」です。

## Do's and Don'ts

### Do:

- **Do** 新しい集計は、欄(`.fields` / `.field`)か罫線の表(`table.ledger`)で出す。
- **Do** 色は CSS 変数(`--form`、`--ink-2` など)で指定し、ライトとダークの両方で確かめる。
- **Do** 記録が無い値は「記録なし」か「—」にして、0 と区別する。推定の値には推定と書く。
- **Do** 数値は右寄せ・等幅数字・桁区切りにする。
- **Do** 列の多い表は `.table-scroll` に入れて、表だけを横にスクロールさせる。
- **Do** 押せるものは 24px 以上の的にし、キーボードで操作できるようにする。

### Don't:

- **Don't** 角を丸めない。浮かせる影を付けない。
- **Don't** 緑を、値の強調や良し悪しの表示に使わない。
- **Don't** グラフの系列色を、画面の部品(ボタン・札・罫)に使わない。
- **Don't** 色だけで状態や系列を区別させない。
- **Don't** Web フォントや外部の画像を読み込まない(レポートは 1 つの HTML で、`file://` でも開く)。
- **Don't** 記録が無いことを空欄や 0 で隠さない。
