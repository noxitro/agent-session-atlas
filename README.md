# agent-session-atlas
[![CI](https://github.com/noxitro/agent-session-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/noxitro/agent-session-atlas/actions/workflows/ci.yml)

Local-first analytics for GitHub Copilot session logs — visualize tokens, skills, agents, hooks, instruction files, and llm-wiki usage from `~/.copilot`, without an LLM.

GitHub Copilot のセッションログ(`%USERPROFILE%\.copilot`)を手元で集計し、ブラウザで読めるレポートにするツールです。集計に LLM は使わず、元のファイルも書き換えません(複製してから読みます)。

## 何が分かるか

- トークン・AI 使用量(AIU)・premium request・変更行数を、プロジェクト・月・モデル・クライアント別に
- 使ったツール・MCP サーバー・skill・agent・hook・指示ファイルの利用ランキングと、インストール済みで使っていない skill
- 摩擦(ツールの失敗、権限の確認、compaction、エラー)と待ち時間
- 指示ファイルの注入と llm-wiki の参照
- 改善点の傾向(指示文や skill の版の前後比較、止まっている箇所、スキル化の候補)
- セッションごとの詳細ページ・経過の記録(Markdown)・自分用のメモ
- 推定人手工数(任意。LLM に判定させたときだけ)

## 使い方

前提: Node.js 24 以上。

1. リポジトリ直下の `atlas.bat` をダブルクリックします(初回だけ `npm install` が走ります)。
2. 集計が終わると、既定のブラウザにレポートが開きます。約 800 セッションで十数秒かかります。2 回目以降は、変わっていないファイルの複製を省きます。
3. 読み終わったらブラウザを閉じます。黒い窓とローカルサーバ(`127.0.0.1` だけに公開)も止まります。

もう一度 `atlas.bat` を実行すると集計し直します。[GitHub Release](https://github.com/noxitro/agent-session-atlas/releases) の zip を展開した場合も、同じく `atlas.bat` をダブルクリックするだけです。

### 画面でできること

`atlas.bat` から開いた画面では、次の操作ができます。`out\atlas.html` を直接開いたときは閲覧と絞り込みだけです。

| 操作 | 場所 |
|---|---|
| 期間・プロジェクト・モデルなどで絞り込む | レポートの上部 |
| 集計し直す | レポートの右上 |
| 工数を判定する…(AI クレジットを消費します。実行前に確認が出ます) | レポートの右上 |
| セッションを選んで集計する / グループにする | セッション一覧 |
| 記録を読む / 全文を作って読む | 詳細ページの表題の下 |
| メモを書く(Markdown と画像) | 詳細ページ |

各欄の読み方と操作の細かい決まりは [docs/screen.md](docs/screen.md) にあります。用語はレポートの「用語の説明」ページで引けます。

## 共有するときの注意

**`out/` はそのまま渡さないでください。** スナップショット・セッション記録・全文記録には依頼文・応答・ツールの結果・ファイルのパスがそのまま入り、秘密情報が混じることがあります。伏せ字でない `atlas.html` と詳細ページにも、最初の依頼と最後の応答が入ります。

共有するときは伏せ字版を作り、中身を確かめてから `out/atlas.html`・`out/glossary.html`・`out/sessions/` だけを渡してください。

```
npm run atlas -- all --anonymize
```

伏せ字版では、プロジェクト名・パス・リポジトリ名・ブランチを仮名にし、依頼の本文・メモ・グループ名を出しません。何を伏せ、何が残るかは [docs/cli.md の `--anonymize`](docs/cli.md#オプション) にあります。評価バンドル(`bundle`)は伏せ字になりません。

## コマンドで使う

期間の絞り込み・記録の中身の調整・全件の全文記録・伏せ字版など、細かい指定はコマンドで行います。

```
npm install
npm run atlas                              # atlas.bat と同じ集計(snapshot → extract → metrics → export)
npm run atlas -- all --since 2026-07-01    # 7 月以降に更新されたセッションだけ
npm run atlas -- export --full             # 解析用の全文記録(外に出さない前提)
npm run atlas -- serve                     # 集計せずに画面だけ開く
npm run atlas -- --help                    # 使い方
```

コマンドとオプションの一覧は [docs/cli.md](docs/cli.md)、出力ファイルの中身は [docs/outputs.md](docs/outputs.md) にあります。

## llm-wiki の参照を数えるとき

**vault を指定しないと、llm-wiki の参照は 0 件のままです。** リポジトリ直下に `atlas.config.json` を置いて、vault のフォルダ名を書いてください(雛形は `atlas.config.example.json`)。

```json
{ "wikis": ["my-wiki"] }
```

`path` にはフルパスよりもフォルダ名だけを書くほうが確実です。索引やページの場所の指定、数え方は [docs/cli.md の「wiki の指定」](docs/cli.md#wiki-の指定) にあります。

## 推定人手工数(任意)

「同じ作業を人が AI なしでやったら何時間かかるか」を LLM に推定させ、レポートに足せます。集計とは別の手順です。推定には幅と確信度を付けますが、人手での実測ではありません。

- **画面から**: 「工数を判定する…」で、未判定のセッションを上限(既定 10 件)まで `copilot -p` か `opencode` で判定します。
- **外部の LLM で(M365 Copilot など)**: `npm run atlas -- bundle` で作った `out/bundle/parts/part-01.md` を添付して判定させ、返答を `npm run atlas -- judge import 返答.md` で取り込みます。

`copilot -p` は AI クレジットを消費します。従量課金の `anthropic` は、コマンドで明示したときだけ使います。手順・費用・安全策は [docs/judge.md](docs/judge.md) にあります。

## 詳しい説明

| 文書 | 中身 |
|---|---|
| [docs/screen.md](docs/screen.md) | 画面の見方(各欄の意味)、画面からの操作、グループ、セッションのメモ |
| [docs/cli.md](docs/cli.md) | コマンドとオプションの全一覧、snapshot / extract が読むもの、wiki の指定 |
| [docs/outputs.md](docs/outputs.md) | セッション記録(Markdown)、解析用の完全出力、改善点の分析、スキルの下書き |
| [docs/judge.md](docs/judge.md) | 推定人手工数の判定の回し方(評価バンドル、外部の LLM、バックエンドと費用) |
| [docs/development.md](docs/development.md) | 開発・テスト・全ページの網羅チェック・CI / リリース・fixtures・元データを書き換えない仕組み |
| [docs/PLAN.md](docs/PLAN.md) | 計画と、各フェーズの設計判断 |
