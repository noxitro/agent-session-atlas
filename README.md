# agent-session-atlas
[![CI](https://github.com/noxitro/agent-session-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/noxitro/agent-session-atlas/actions/workflows/ci.yml)

Local-first analytics for GitHub Copilot session logs — visualize skills, agents, instruction files, and llm-wiki effectiveness from session.db.

GitHub Copilot のセッションログ(`%USERPROFILE%\.copilot`)から、トークン・skills / agents / hooks・指示ファイルの注入・llm-wiki の参照・摩擦指標を LLM なしで集計するツールです。計画は [docs/PLAN.md](docs/PLAN.md) にあります。

> 現在は Phase 7(集計ライブラリ `@atlas/core`、コマンド `atlas`、HTML レポート、LLM による工数判定 `@atlas/judge`、空のセッション・表記揺れ・新しいログ形式への対応、利用ランキング・変更行数・プロジェクトの統合、モード・推論強度・文脈の内訳・待ち時間・todo・要点欄)まで。判定の回し方は「[判定の回し方(推定人手工数)](#判定の回し方推定人手工数)」を見てください。

## 起動方法

前提: Node.js 24 以上。

### ダブルクリックで(atlas.bat)

リポジトリ直下の `atlas.bat` をダブルクリックすると、初回だけ `npm install` を実行したあと、`~/.copilot` を集計して `out\atlas.html` を作り、既定のブラウザで開きます。元のファイルは書き換えません(`out\snapshot` に複製してから読みます)。2 回目以降は変わっていないファイルの複製を省くので数秒で終わります。

### コマンドで(npm run atlas)

```
npm install
npm run atlas                              # all と同じ: snapshot → extract → metrics → build
npm run atlas -- build --anonymize         # 伏せ字版の HTML を作り直す(共有用)
npm run atlas -- all --since 2026-07-01    # 7 月以降に更新されたセッションだけ
npm run atlas -- --help                    # 使い方
```

| コマンド | すること |
|---|---|
| `snapshot` | `~/.copilot` の必要部分(`session-store.db`、各セッションの `workspace.yaml` / `events.jsonl` / `session.db`)を `out/snapshot/` へ複製する。インストール済みの skill・プラグインは**名前だけ**を `snapshot-manifest.json` に記録する(下記) |
| `extract` | スナップショットから `out/sessions.json` を作る。repository の記録が無いセッションは、作業フォルダの git の設定を読んでプロジェクトを束ねる(下記) |
| `metrics` | `out/metrics.json`(全体・プロジェクト・クライアント・月・モデル別の集計。空のセッションは除き、件数を `emptySessions` に、トークンの出所別・欠測の件数を各集計の `tokenSources` / `sessionsMissingTokens` に、ツールの成否を `tools.results`、MCP サーバー別を `tools.mcp`、skill の呼んだ側を `skills.byTrigger`、agent の失敗とトークンを `agents.byNameDetail`、変更行数を `lines`、インストール済みで未使用の skill を `installedSkills`、モード・推論強度・リクエストの起点・ツール定義のトークンを `exec`、権限の結果・エラーの種別・サブエージェント失敗の理由・compaction 自体のトークンを `frictionDetail`、todo を `todos`、モデル別の待ち時間を `latency`、ツール別の所要時間を `toolDurations` に持つ)を作る |
| `build` | `out/atlas.html` と `out/sessions/<id>.html`(セッション詳細)を作る |
| `all` | 上の 4 つを順に実行する(コマンド省略時の既定) |
| `bundle` | LLM に工数を判定させる評価バンドル `out/bundle/` を作る(LLM は呼ばない) |
| `judge run` | バンドルの各セッションを LLM で判定し `out/judgments.json` に追記する(**クレジットを消費します**) |
| `judge import <ファイル>` | 外部の LLM で作った判定(JSON か、JSON を含む Markdown)を検証して `out/judgments.json` に取り込む |

| オプション | 意味 |
|---|---|
| `--home <dir>` | Copilot のデータの場所(既定: 環境変数 `ATLAS_COPILOT_HOME`、無ければ `~/.copilot`) |
| `--out <dir>` | 出力先(既定: リポジトリ直下の `out/`) |
| `--since <date>` | この日時以降に更新されたセッションだけ |
| `--project <key>` | プロジェクトで絞る(完全一致、無ければ部分一致) |
| `--client <name>` / `--model <name>` / `--branch <name>` | クライアント・モデル・ブランチで絞る |
| `--anonymize` | プロジェクト名・パス・リポジトリ名(git の origin から決めたものを含む)・ブランチを `project-01` などの仮名にし、依頼本文・セッション名・ファイルパスを出さない。「(ホーム)」「(一時フォルダ)」「(atlas の判定)」は固有名を含まないのでそのまま、MCP サーバー名・skill 名・ツール名・agent 名(カスタム agent を含む)・hook の種別も出ます |
| `--judgments <file>` | LLM の判定結果 `judgments.json` の場所(既定: `out/judgments.json` があれば使う) |
| `--bundle <dir>` | 評価バンドルの場所(既定: `out/bundle/`) |
| `--include-empty` | `bundle` で、依頼の記録が無いセッションもパケットにする |
| `--temp-dir <dir>` | `extract` で、このフォルダ配下を「(一時フォルダ)」にまとめる(複数指定可)。指定すると既定の判定(`%TEMP%` と `AppData\Local\Temp`・`/tmp` のパターン)を使わず、挙げたフォルダだけを一時フォルダとみなす。このリポジトリ自体を一時フォルダ配下に置いて試すときや、別のマシンのデータを読むとき用 |

`judge run` 専用のオプション(`--backend` `--limit` `--only` `--concurrency` `--force` `--no-allow-tools` `--timeout`)は「判定の回し方」を見てください。`judge run` では `--model` は判定に使うモデルの指定になります。

`snapshot` は各セッションの `session-state/<id>/session.db`(エージェントが残す todo の記録)も `session-store.db` と同じ方法(元を開かずにバイト列をコピーし、コピー側から `VACUUM INTO`)で複製します。2 回目以降は元のサイズと更新時刻が同じなら複製し直しません。`extract` が読むのは todo の状態別の件数と依存関係の数だけで、タイトルや説明は読みません。壊れていて複製できない `session.db` はそのセッションだけ飛ばし、理由を警告に出します。

`snapshot` が `~/.copilot` から名前だけ記録するもの(中身は読みません): `skills/` のディレクトリ名、`installed-plugins/<マーケットプレイス>/<プラグイン>/` とその `skills/` のディレクトリ名、`settings.json` の `disabledSkills`(他のキーは記録しません)。読めなかったものは理由を `extract` の警告に出します。

`extract` は、repository の記録が無いセッションについて、作業フォルダ(`gitRoot`。無ければ `cwd` から上へ探した `.git`)の `.git/config` の `[remote "origin"]` を**読むだけ**で(git コマンドは使いません)、URL から「所有者/リポジトリ」を取り出してプロジェクトにします。worktree(`.git` がファイル)は `gitdir` → `commondir` を辿って共有の設定を読みます。origin が無い・読めないときはパスのままです。上へ探すときは、ホームディレクトリと一時フォルダより上には上りません。

`out/atlas.html` は 1 ファイルで完結しており(外部への通信なし)、サーバ無しにブラウザで開けます。詳細ページを含めて共有するときは `out/atlas.html` と `out/sessions/` フォルダを一緒に渡してください。

## 画面の見方

- **上部**: 生成日時、記録期間、配色の切り替え(自動 / ライト / ダーク)、各欄へのリンク。
- **絞り込み**: 期間・プロジェクト・クライアント・モデル・ブランチ・入力トークン記録の有無・タスク分類で絞ると、下の欄がすべてその条件で集計し直されます。右端の「表示中 N / 全 M セッション」が今の件数です。**空のセッション**(依頼・ツール呼び出し・応答がどれも無い、開いただけのもの。実データでは全体の約 75%)は既定で集計・一覧・プロジェクト表・中央値のすべてから外しています。「空のセッションを含める」にチェックすると含めます(このときの「全 M」は空を含めた件数)。条件は URL の `#` 以降に残るので、ブックマークすれば同じ絞り込みで開けます。タスク分類は LLM による判定(judgments.json)があるときだけ選べます。
- **要点**: 絞り込み後の集計から決まった規則で選んだ短い一覧です(LLM は使いません)。AI 使用量(AIU)の大きいセッション上位 3 件(AIU の記録が無い条件では出力トークンの多い順)、失敗率の高いツール(結果の記録が 5 回以上で失敗・拒否のあったもの)、compaction の多いセッション、インストール済みで未使用の skill。各項目にはリンクがあり、セッションならその詳細ページ、ツールなら今の絞り込みに「そのツールを使ったセッション」を足した状態(URL の `#…&tool=<ツール名>`)、未使用の skill なら利用ランキングの未使用一覧に移ります。ツールで絞っているときは絞り込み行に「<ツール名> を使った ×」が出て、押すと外れます。
- **全体サマリ**: セッション数、期間、実働時間、トークン(入力・出力・キャッシュ読取)、AI 使用量(AIU)、premium request、ツール呼び出し(失敗率つき)、変更行数、skill・agent・hook の件数、指示ファイルと llm-wiki の利用、摩擦の合計。**入力トークン・AI 使用量・premium request・変更行数は記録が残っているセッションだけの合計**で、欄の下に「記録あり N / M セッション」を出します。空のセッションを外しているときは、その件数を「空のセッション N 件を除外」と出します。
  - AI 使用量は nano AIU を 10 億で割った AIU で、桁区切りで表示します。金額には換算しません。premium request は旧来の課金単位で、記録のある(主に 2026 年 7 月以前の)セッションだけの合計です。
  - 変更行数(追加 / 削除)は、セッション終了時の累計(`session.shutdown` の `codeChanges`)を優先し、無ければツールごとの行数(`toolTelemetry`)を合計したものです。
  - 依頼の回数には、autopilot が自分で作業を続けるときの自動継続(ログ上はユーザーのメッセージとして残る)を含めず、別に「自動継続 N 回」と出します。
  - ツール呼び出しの回数には、作業の途中経過を画面に出すための内部ツール(`report_intent`)を含めず、件数だけ別に出します。
  - 摩擦の内訳では「ツール失敗」(個々のツール呼び出しの失敗)と「エラー」(`session.error`。利用上限・通信エラーなどセッション全体のエラー)を分けています。
  - その下の「入力トークン記録の内訳」で、明細あり / 終了時の累計のみ / 出力のみ / **記録なし(欠測)** の件数を確認できます。記録なし(欠測)は、依頼や応答があるのにトークン量の記録がどこにも無いセッションです(2026 年 9 月以降のログは `assistant.message` に出力トークン数を書かなくなったため、session-store.db・usage_record・終了時の累計のどれも無いと出力トークンも分かりません)。0 として足さず、件数で示します。
- **AI 投入量 vs 推定人手工数**(判定結果があるときだけ): 判定済みのセッションについて、LLM が推定した人手工数(幅と平均確信度つき)と、同じセッションで AI が使った実働時間・トークンを全体とプロジェクト別に並べます。「推定人手工数 ÷ AI の実働」は目安で、削減量の実測ではありません。
- **利用ランキング**: 絞り込んだセッションで「何を使ったか」を、ツール / MCP サーバー / skill / agent / hook / 指示ファイルの切り替えで上位 10 件の棒グラフにし、「全件を表で見る」で全件を表にします。絞り込みを変えると集計し直されます。
  - ツール: 呼び出し回数と失敗率(失敗 + 拒否 ÷ 結果の記録がある回数)。MCP のツールは「MCP」の印を付けてサーバーごとに 1 行にまとめます。「並べ方」で失敗率の高い順(結果 5 回以上のツールだけ)にもできます。表では成功・失敗・拒否・結果なしの内訳が見られます。
  - MCP サーバー: サーバーごとの呼び出し回数と、よく使ったツール。
  - skill: 回数と、利用者が呼んだ(`trigger: user-invoked`)/ エージェントが呼んだ(`agent-invoked` と skill ツールの呼び出し)/ 不明(trigger を記録しない古いログ)の内訳。その下に「**インストール済みで未使用の skill**」(`~/.copilot/skills/` とプラグインの skill のうち、絞り込んだ期間に一度も呼ばれなかったもの。`settings.json` で無効にしたものには「無効」)を出します。
  - agent: 起動回数・失敗・使ったトークン。hook: 種類ごとの実行回数。指示ファイル: 注入されたセッション数(「(user)」はユーザー単位の指示ファイル)。
- **実行の性質**: 絞り込んだセッションを「どう動かしたか」「どこで時間と文脈を使ったか」で見る欄です。値は記録のあるものだけの集計です。
  - モード別の依頼: 依頼(ユーザーのターン)ごとのモード(対話 interactive / 計画 plan / autopilot)。`user.message` の `agentMode`、無ければ直前の `session.mode_changed` で決めます。どちらも無い依頼は既定の interactive とみなし、その回数を欄の下に出します(実データでは最初のモード変更の変更前は全件 interactive でした)。
  - 推論強度別: リクエストの `reasoningEffort`(session-store.db / usage_record)、無ければその時点のセッションの設定(`session.start` / `session.model_change`)ごとのリクエスト数・入力・出力・AIU。終了時の累計しか無いセッションは、設定が 1 種類ならその強度に、それ以外は「不明」に入れます。
  - リクエストの起点: API リクエストを誰が起こしたか(`initiator`: 利用者の依頼 / エージェント / サブエージェント / compaction / 記録なし)。リクエスト単位の明細があるセッションだけです。
  - 文脈の内訳(ツール定義): 毎リクエストの文脈に入るツール定義のトークン(セッションの最後の値。`session.shutdown` か `session.compaction_complete` の `toolDefinitionsTokens`、無ければ usage_record の `toolTokenCount`)の平均・中央値と、文脈(system・会話・ツール定義)に占める割合、使えるツールの数、プロジェクト別の平均。
  - モデル別の待ち時間: 最初のトークンまで(`time_to_first_token_ms` / `timeToFirstTokenMs`)とリクエスト全体(`duration_ms` / `duration`)の中央値と p90(遅い方から 1 割の境目)。
  - ツールの所要時間: 開始から完了まで(`toolCallId` で対応)。5 回以上記録のあるツールを p90 の長い順に出し、「全件を表で見る」で全ツールを見られます。**1 時間を超えたもの(放置や利用者の返答待ち。1 日近いものもある)は外れ値として中央値・p90 から除き、件数だけ出します。**
  - 摩擦の詳細: 権限の確認の結果(承認 = `approved` / `approved-for-location`、拒否 = `denied…`)、エラーの種別(`session.error` の `errorType`: quota / rate_limit など)、サブエージェント失敗の理由(`subagent.failed` の `error` を 利用上限(402)/ 回数制限(429)/ 中断 / 応答なし / その他 に分類。詳細ページには本文を短く出します)、compaction 自体が使ったトークンと compaction で減ったトークン。
  - todo: `session.db` の todo の状態別件数(完了 / 進行中 / 未着手 / 保留)、完了率(完了 ÷ 全件。セッション終了時点)、依存関係の数。
- **プロジェクト別**: プロジェクトごとの集計表。列見出しで並べ替え、プロジェクト名を押すとそのプロジェクトに絞り込みます。入力トークンの下の小さな「5/30」は、記録のあるセッション数 / 全セッション数です。「変更行」は追加行数(下に削除行数)です。
  - プロジェクトは、ログの repository、無ければ git の origin(「所有者/リポジトリ」)で束ねます。同じリポジトリの別フォルダや worktree で開いたセッションも 1 つになります。ホームディレクトリそのもので開いたものは「(ホーム)」、一時フォルダ(`%TEMP%` 配下。scratchpad での試行など)は「(一時フォルダ)」、このツール自身の工数判定(`judge run` が作る `%TEMP%\atlas-judge-cwd-*`)は「(atlas の判定)」にまとめます。どれにも当たらないものは作業フォルダのパスのままです。
- **月別推移**: セッション数・出力トークン・入力トークン・AI 使用量(AIU)・premium request の月別の棒グラフ(月は UTC)。棒にマウスを乗せるかキーボードで選ぶと値が出ます。「表で見る」で同じ値と変更行数を表で確認できます。AIU と premium request は記録のあるセッションだけの合計です。
- **モデル別**: モデルごとのトークンとリクエスト数。1 セッションで複数のモデルを使うことがあるため、セッション数の合計は全体と一致しません。同じモデルがログの出所によって `claude-haiku-5-5` / `claude-haiku-5.5` / `<ID>/claude-haiku-5-5` のように書き分けられているため、`claude-haiku-5.5` の形にそろえています(`claude-<種類>-<数字>-<1 桁の数字>` で後ろに日付などが続かないものだけ。先頭の `<UUID>/` はプロバイダ設定の ID で、同じリクエストの記録にどちらの名前も残っていることを実データで確認しています)。
- **セッション一覧**: 1 ページ 50 件。「変更行」列は追加行数(下に削除行数)。名前を押すとセッション詳細(時系列、ツール内訳と成功・失敗・拒否、実行の性質(モード・推論強度・起点・ツール定義・モデル別の待ち時間・ツールの所要時間・摩擦の詳細・失敗したサブエージェントの理由・todo)、skills(呼んだ側)/ agents / hooks、指示ファイル、llm-wiki の参照、摩擦、変更行数、変更したファイル)を開きます。推定人手工数は LLM による判定を実行するまで「未判定」です。空のセッションを含めているときは、空のものに「空」の印が付きます。
  - 詳細の「変更したファイル」は、変更・作成・削除に分けて載せます。相対パスは作業フォルダ基準の絶対パスにそろえ、同じファイルは 1 回だけ載せます(Windows では大文字小文字を区別しない)。途中で削除したファイルは、終了時の記録(`codeChanges.filesModified`)に残っていても「削除」のままにします。Copilot 自身のセッション用ファイル(`~/.copilot/session-state/` 配下の plan.md など)は一覧から外し、件数だけ書きます。
  - 応答の件数には、サブエージェントの応答を含めません。
- **クライアントが「不明」のセッション**: 次のどちらかで、記録からはクライアントを決められません(推測では埋めていません)。
  - Copilot 1.0.54 以前(2026 年 5 月以前)のセッション。`workspace.yaml` に `client_name` がまだ記録されていませんでした(実データで `client_name` が初めて現れるのは 1.0.56)。
  - `session-store.db` にだけあるセッション。DB の `sessions` 表にはクライアントの列が無く、`host_type` は CLI と autopilot のどちらでも `github` か空なので区別できません。実データではこの種類はすべて空のセッションでした。
- **用語の説明**: nano AIU / AIU、premium request、compaction、skill / agent / hook、skill を呼んだ側、インストール済みで未使用の skill、MCP サーバー、ツールの失敗率、変更行数、プロジェクトのまとめ方、要点、モード、推論強度、リクエストの起点、文脈の内訳(ツール定義)、待ち時間、ツールの所要時間、権限の確認の結果、todo、指示ファイル、llm-wiki などの説明。レポートを初めて読む人向けです。

## 判定の回し方(推定人手工数)

「同じ作業を人が AI なしでやったら何時間かかるか」は LLM に推定させます。集計(LLM なし)とは別の手順で、結果は `out/judgments.json` に貯まり、次の `atlas build` でレポートに合成されます。判定は外部の LLM でも、このツールの中からでも回せます(どちらも同じ形式です)。

**推定は推定です。** レポートには幅(low〜high)と確信度を一緒に出しますが、人手での実測ではありません。

### 1. 評価バンドルを作る(LLM は呼ばない)

```
npm run atlas            # まだなら先に集計(out/sessions.json と out/snapshot を作る)
npm run atlas -- bundle  # out/bundle/ を作る。--project / --since / --client などで対象を絞れる
```

`out/bundle/` の中身:

| ファイル | 内容 |
|---|---|
| `INSTRUCTIONS.md` | 判定する LLM への指示(役割・評価軸・出力形式・手順)。最初に読ませる |
| `manifest.json` | パケットの一覧(セッション ID とファイルの場所、件数、サイズ) |
| `schema.json` | 返してもらう `judgments.json` の JSON Schema |
| `sessions/<セッション ID>.md` | 評価パケット。依頼文、最終応答、変更ファイル、ツール / skill / agent / hook、ターン数・時間・トークン、摩擦、指示ファイル・wiki の参照、compaction 要約 |

- 依頼の記録が無いセッション(開いただけで使っていないもの)はパケットにしません(`manifest.json` の `skipped` に理由付きで載ります)。含めたいときは `--include-empty`。
- 本文はスナップショットのログから全文を読み直しますが、1 パケット 24,000 字に収まるよう長い本文は中略します(中略した箇所には字数を書きます)。
- **パケットには依頼文や応答の本文、パス、リポジトリ名がそのまま入ります。** 外部のサービスに渡す前に中身を確認してください。

### 2a. 外部の LLM で判定する(M365 Copilot など)

1. `out/bundle` フォルダを**フォルダごと ZIP にします**(エクスプローラーで右クリック →「圧縮先」→「ZIP ファイル」)。このツールは ZIP を作りません(依存を増やさないため)。
2. ZIP(または中のファイル)を M365 Copilot のエージェント等に添付し、「`INSTRUCTIONS.md` に従って判定して」と頼みます。件数が多いときは何回かに分けて返してもらってかまいません。
3. 返ってきた JSON(または JSON のコードブロックを含む返答をそのまま貼った `.md` / `.txt`)を保存し、取り込みます。

```
npm run atlas -- judge import 返答.md     # 検証して out/judgments.json に取り込む(同じセッションは上書き)
npm run atlas -- build                    # レポートに合成
```

形が合わない項目(範囲外の値、必須欄の欠け)が 1 件でもあると、何も取り込まずにどこが違うかを表示します。

### 2b. このツールの中で判定する(atlas-judge.bat)

`atlas-judge.bat` をダブルクリックすると、バンドルを作り直し、既定のバックエンド(`copilot -p`)で未判定のセッションを判定して、レポートを作り直して開きます。コマンドでは次のとおりです。

```
npm run atlas:judge                               # bundle → judge run → build(atlas-judge.bat と同じ)
npm run atlas -- judge run --limit 5              # まず 5 件だけ試す
npm run atlas -- judge run --only <id>,<id>       # 指定したセッションだけ
npm run atlas -- judge run --force                # 判定済みも判定し直す
npm run atlas -- judge run --model <モデル名>      # 判定に使うモデルを指定
```

- 判定済みのセッションは飛ばすので、途中で止めても続きから再開できます。失敗したセッションは `judgments.json` の `failures` に記録し、次へ進みます(最後に終了コード 1)。
- バックエンドは `--backend` で選びます。

| バックエンド | 中身 | 費用 |
|---|---|---|
| `copilot-cli`(既定) | `copilot -p` を空の作業フォルダで起動し、パケットをプロンプトに埋め込んで渡す | GitHub Copilot のサブスクリプション内で AI クレジット(旧課金では premium request)を消費します(1 セッション 1 回以上) |
| `opencode` | `opencode run --format json` | 選んだモデル次第(無料モデルなら無料)。`--model openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` で実走を確認済み(1 件 20〜30 秒)。opencode の既定モデルがカタログから消えていると `UnknownError` になるので、その場合は `opencode models` で残っている無料モデルを `--model` に指定してください |
| `anthropic` | Anthropic Messages API を直接呼ぶ(既定モデル `claude-sonnet-5-5`、環境変数 `ANTHROPIC_API_KEY` が必要) | **従量課金**です。明示的に `--backend anthropic` を指定したときだけ使います |

- `copilot-cli` は `--add-dir` を使いません(そのフォルダの `.github/skills` / `agents` を信頼設定として読むため、他セッションの本文を含むバンドルが指示の注入口になりうるからです)。ユーザーの AGENTS.md 等も読ませません(`--no-custom-instructions`)。`--allow-all-tools` は既定で付けます(付けたくないときは `--no-allow-tools`)。
- 判定自体の使用量は `copilot` の `--usage-output-file` から集計し、`judgments.json` の `judge.usage` に残します。
- `copilot` の場所は環境変数 `ATLAS_COPILOT_BIN` で指定できます(テストでは偽の copilot `fixtures/fake-copilot.mjs` に差し替えています)。
- 月間の AI クレジット(旧課金では premium request)を使い切っていると、どのモデルを指定しても `quota_exceeded HTTP 402` で失敗します(消費はありません)。`judgments.json` の `failures` に残るので、翌月や別のバックエンドで `judge run` を再実行すれば再試行されます。
- 出力の形を調べたいときは環境変数 `ATLAS_JUDGE_RAW_DIR` にフォルダを指定すると、`copilot` の生の stdout / stderr / usage をセッションごとに保存します(パケット本文を含むので共有しないでください)。

## 開発

前提: Node.js 24 以上(`node:sqlite` と TypeScript の型除去を使うため。ネイティブ依存はありません)。

```
npm install
npm run typecheck   # tsc + svelte-check(出力なし)
npm test            # 単体テスト(packages/*/test)
npm run e2e         # E2E(テスト時に生成する架空の fixture のみ。生成は自動)
npm run fixtures    # fixture(.fixtures/)を手で作り直す(中身を見たいとき。E2E は毎回自動で作り直す)
npm run build:report  # レポートのテンプレート(packages/report/dist/template.html)を作り直す(atlas build もソースが新しければ自動で作り直す)
```

実データ(`~/.copilot`)を使う E2E は環境変数で有効にします。元のファイルは書き換えず、`out/live/` にスナップショットと `sessions.json` / `metrics.json` を出力します。

```
# PowerShell
$env:ATLAS_LIVE = '1'; npm run e2e
# bash
ATLAS_LIVE=1 npm run e2e
```

`ATLAS_COPILOT_HOME` で `~/.copilot` 以外の場所を指定できます。E2E は LLM を呼びません(`judge run` の検査は偽の copilot で行います)。

### CI / リリース(GitHub Actions)

- **CI**(`.github/workflows/ci.yml`): `main` への push と PR ごとに、Windows と Linux で `npm ci` → `typecheck` → `test` → `build:report` → `e2e` を実行します。E2E はテスト時に生成する架空の fixture だけを使い(追加の手順は不要)、実データ(`ATLAS_LIVE`)や実際の LLM 判定は動かしません。Actions タブから手動でも実行できます。
- **リリース**(`.github/workflows/release.yml`): `v` で始まるタグを push すると、同じ CI を通したあと、ソース一式にビルド済みのレポートテンプレートを足した `agent-session-atlas-<タグ>.zip` を GitHub Release に添付します(リリースノートは自動生成)。zip を展開して `atlas.bat` をダブルクリックすれば、初回の `npm install` のあとそのまま集計できます。

```
git tag v0.1.0
git push origin v0.1.0
```

公開リポジトリなので標準ランナーの Actions は無料枠で動きます。

### 元データを書き換えないための仕組み

- `session-store.db` / `data.db` と各セッションの `session.db` は SQLite です(前の 2 つは WAL 付き)。元を直接開くと読み取り専用でも `-shm` が書き換わる(mtime が変わる)ため、本体と `-wal` をバイト列のままコピーし、コピー側から `VACUUM INTO` で単一ファイルにします。コピー中に元が更新されたら取り直します。
- `events.jsonl` / `workspace.yaml` はコピーしてから読みます。2 回目以降はサイズと更新時刻が同じファイルを再利用します。

### fixtures

**サンプルデータはリポジトリに置かず、テスト時に架空の値だけで生成します。実データは読みません。**

- 規則: fixtures に実データ(匿名化したものも含む)を使わない。セッション ID・ツール呼び出し ID・パス・時刻・本文はすべて作った値です(`00000000-0000-4000-8000-0000000000NN`、`call_synth_…`、`X:\synthetic-…` など)。
- 生成器は `scripts/synthetic-fixtures.ts`(001〜006・099 は `scripts/synthetic-base.ts`)で、何度実行しても同じ結果になります。E2E は `e2e/global-setup.ts`(vitest の globalSetup)から毎回これを呼び、`.fixtures/` を作り直してから走ります。新しく clone した状態でも `npm ci && npm test && npm run e2e` だけで動きます(CI も同じ)。
- `.fixtures/` は `.gitignore` 済みです。中身を見たいときは `npm run fixtures` で作れます。
  - `copilot-home/session-state/<id>/{workspace.yaml,events.jsonl}` と `copilot-home/session-store.json`(`session-store.db` の中身。テスト時に `e2e/fixture-home.ts` が WAL の DB に組み立てます)
  - `manifest.json`(各セッションの役割)、`fixture-counts.json`(core を使わずに数えた件数 = 期待値の根拠)、`judgments-sample.json`(手書きの架空の判定)
- `fixtures/` にはコード(偽の copilot `fixtures/fake-copilot.mjs`)だけを置きます。

セッションの役割:

| ID | 確かめること |
|---|---|
| `00…001` | usage_record も DB usage も無い旧形式(トークンは `session.shutdown.modelMetrics`)、compaction の要約、postToolUse hook、アイドル時間、source 付きの user.message、指示ファイル(imported の AGENTS.md・applyTo・複数プロジェクト共通のブロック) |
| `00…002` | usage_record だけ(DB に無い)、`<UUID>/claude-sonnet-5-5` の表記揺れ、7 種類の hook、待ち時間とツール定義のトークン |
| `00…003` | usage_record と DB の `assistant_usage_events` の重複除去、サブエージェント(agentId で DB の行と結び付く)、DB の `session_files` |
| `00…004` | `skill` ツールと `skill.invoked` の組、llm-wiki の index / ページ / その他の読み、権限で拒否されたツール失敗、DB の usage だけ |
| `00…005` | 旧形式(`outputTokens` だけ)、サブエージェント 3 回(1 回は完了前に記録が切れる)、abort、ask_user、apply_patch の行数、shutdown の無いログ |
| `00…006`・`00…010` | `session-store.db` にだけあるセッション(空) |
| `00…007`〜`00…009` | 空のセッション、`fileEdits[]`、autopilot の自動継続、表記揺れのあるモデル名、`report_intent`、トークン記録の無いセッション |
| `00…011`〜`00…013` | MCP ツール、ツールの失敗・拒否、変更行数、skill の trigger、agent の失敗、一時フォルダと atlas の判定のセッション |
| `00…099` | 未知のイベント種別と壊れた行 |

生成器を変えたら `.fixtures/fixture-counts.json` を見て、`e2e/phase1.test.ts` などの期待値を更新してください(期待値には根拠のコメントを付けています)。git の origin によるプロジェクトの統合・ホーム・インストール済みの skill は、`e2e/phase6.test.ts` が実行時に作る合成のリポジトリとフォルダで確かめます(一時フォルダは `--temp-dir` で合成の場所だけにするので、リポジトリを `%TEMP%` 配下に置いても通ります)。モード・推論強度・起点・文脈の内訳・待ち時間・ツールの所要時間・摩擦の詳細・todo(`session.db`)は、`e2e/phase7.test.ts` が実行時に足す合成セッション(`00…014`・`00…015`)と `session-store.db` の明細行で確かめます。既知のイベント種別は `packages/core/src/event-types.ts` にあり、ここに無い種別は未知種別として数えます(生成器が使う種別がすべてここにあることを単体テストで確かめます)。
