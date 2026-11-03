# agent-session-atlas
[![CI](https://github.com/noxitro/agent-session-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/noxitro/agent-session-atlas/actions/workflows/ci.yml)

Local-first analytics for GitHub Copilot session logs — visualize skills, agents, instruction files, and llm-wiki effectiveness from session.db.

GitHub Copilot のセッションログ(`%USERPROFILE%\.copilot`)から、トークン・skills / agents / hooks・指示ファイルの注入・llm-wiki の参照・摩擦指標を LLM なしで集計するツールです。計画は [docs/PLAN.md](docs/PLAN.md) にあります。

> 現在は Phase 8(集計ライブラリ `@atlas/core`、コマンド `atlas`、HTML レポート、LLM による工数判定 `@atlas/judge`、空のセッション・表記揺れ・新しいログ形式への対応、利用ランキング・変更行数・プロジェクトの統合、モード・推論強度・文脈の内訳・待ち時間・todo・要点欄、セッション記録の Markdown 出力、解析用の完全出力、改善点の分析)まで。判定の回し方は「[判定の回し方(推定人手工数)](#判定の回し方推定人手工数)」を見てください。

## 起動方法

前提: Node.js 24 以上。

### ダブルクリックで(atlas.bat)

リポジトリ直下の `atlas.bat` をダブルクリックすると、依存が足りないときだけ `npm install` を実行したあと、`~/.copilot` を集計して `out\atlas.html` と各セッションの記録(`out\sessions\<id>.md`。詳細ページからリンク)を作り、ローカルサーバ(`127.0.0.1` だけに公開。ポートは空いているものを自動で取ります)で既定のブラウザに開きます。黒い窓はブラウザを閉じるまで残り、閉じるとサーバも止まります(画面からの操作が 3 秒ごとに届かなくなってから約 8 秒。窓を閉じても止まります)。もう一度 `atlas.bat` を実行すると集計し直し、サーバが動いていればブラウザを開くだけにします。元のファイルは書き換えません(`out\snapshot` に複製してから読みます)。2 回目以降は変わっていないファイルの複製を省くので数秒で終わります。

サーバ経由で開いたときだけ、画面からグループの作成・名前の変更・削除と、セッションのメモの編集ができます(下記「絞り込み」「セッションのメモ」)。共有するときは `out\atlas.html`(と `out\glossary.html`、`out\sessions\` の `.html`)をそのまま渡せます。`out\sessions\` の `.md`(セッション記録)には依頼文や応答がそのまま入るので渡さないでください。サーバ無しで開いた画面は閲覧だけで、グループとメモの操作は出ません。

`atlas-export.bat` も同じもの(集計と各セッションの記録)を作ります。違いは追加の引数を `export` に渡せることで、記録の中身の調整(`--tool-output all` など)や伏せ字版の記録(`--anonymize`)に使います(「[セッション記録(Markdown)](#セッション記録markdown)」)。`atlas-export-full.bat` はさらに解析用の全文記録(上限なし)と網羅の検査、指示文と skill の閲覧ページも作ります(「[解析用の完全出力](#解析用の完全出力)」)。

> **`out/` は共有しないでください。** スナップショット(原本の複製)と、全文記録・セッション記録には依頼文・応答・ツールの結果・ファイルのパスがそのまま入り、秘密情報が混じることがあります。共有するときは伏せ字版(`--anonymize` で作った `out/atlas.html` と `out/sessions/`)だけを、中身を確認してから渡してください。

### コマンドで(npm run atlas)

```
npm install
npm run atlas                              # all と同じ: snapshot → extract → metrics → export(記録つき)
npm run atlas -- build --anonymize         # 伏せ字版の HTML を作り直す(共有用)
npm run atlas -- all --since 2026-07-01    # 7 月以降に更新されたセッションだけ
npm run atlas -- --help                    # 使い方
```

| コマンド | すること |
|---|---|
| `snapshot` | `~/.copilot` の必要部分(`session-store.db`、各セッションの `workspace.yaml` / `events.jsonl` / `session.db` / `plan.md` / `checkpoints/` / `files/` / `rewind-file-snapshots/` / `policies/`、直下の `plans/` / `attachments/` / `chats/` の `*.md`)を `out/snapshot/` へ複製する。`data.db`(デスクトップアプリ)は複製せず、許可リストの列だけを `desktop.json` に書く(下記)。大きいもの(`rewind-snapshots/`、一覧に無い名前のフォルダ、`logs/`)は既定で写さず名前と容量を `snapshot-manifest.json` に残す(`--snapshot-all` で写す)。インストール済みの skill・プラグインは**名前だけ**を記録する(下記) |
| `extract` | スナップショットから `out/sessions.json` を作る。repository の記録が無いセッションは、作業フォルダの git の設定を読んでプロジェクトを束ねる(下記) |
| `metrics` | `out/metrics.json`(全体・プロジェクト・クライアント・月・モデル別の集計。空のセッションは除き、件数を `emptySessions` に、トークンの出所別・欠測の件数を各集計の `tokenSources` / `sessionsMissingTokens` に、ツールの成否を `tools.results`、MCP サーバー別を `tools.mcp`、skill の呼んだ側を `skills.byTrigger`、agent の失敗とトークンを `agents.byNameDetail`、変更行数を `lines`、インストール済みで未使用の skill を `installedSkills`、モード・推論強度・リクエストの起点・ツール定義のトークンを `exec`、権限の結果・エラーの種別・サブエージェント失敗の理由・compaction 自体のトークンを `frictionDetail`、todo を `todos`、モデル別の待ち時間を `latency`、ツール別の所要時間を `toolDurations` に持つ)を作る |
| `build` | `out/atlas.html` と `out/sessions/<id>.html`(セッション詳細)を作る |
| `export` | `build` に加えて、各セッションの記録(経過・消費)を `out/sessions/<id>.md` に書く。共有や LLM での振り返り用(下記「[セッション記録(Markdown)](#セッション記録markdown)」)。指示文と skill の閲覧ページ `out/instructions.html` も作る。`--full` で解析用の全文記録(下記)。LLM は呼ばない |
| `all` | `snapshot` → `extract` → `metrics` → `export` を順に実行する(コマンド省略時の既定)。`--anonymize` のときは記録を作らず `build` にする(記録の伏せ字は HTML より弱いため) |
| `bundle` | LLM に工数を判定させる評価バンドル `out/bundle/` を作る(LLM は呼ばない) |
| `judge run` | バンドルの各セッションを LLM で判定し `out/judgments.json` に追記する(**クレジットを消費します**) |
| `judge import <ファイル>` | 外部の LLM で作った判定(JSON か、JSON を含む Markdown)を検証して `out/judgments.json` に取り込む |
| `serve` | `out/` をローカルサーバ(`127.0.0.1`)で配信してブラウザで開く。画面からグループとメモを書ける。ブラウザを閉じると止まる。`atlas.bat` 系はこれで終わる |
| `memo list` / `memo show <id>` / `memo set <id> <本文...>` / `memo set <id> --file <path>` / `memo remove <id>` | セッションごとのメモ(`atlas-notes/memos/<id>.md`)を一覧・表示・保存・削除する。id は先頭の数文字でよい。`remove` は画像を残す(下記「セッションのメモ」) |
| `group list` / `group add <名前> <id...> [--note <一文>]` / `group remove <名前>` | 名前付きグループ(`atlas-notes/groups.json`)を一覧・追加・削除する。`add` は既存の名前なら id を追記(重複は除く)。id は先頭の数文字でよい(1 つに決まらなければエラー)。壊れたファイルは上書きしない(下記「絞り込み」) |

| オプション | 意味 |
|---|---|
| `--home <dir>` | Copilot のデータの場所(既定: 環境変数 `ATLAS_COPILOT_HOME`、無ければ `~/.copilot`) |
| `--out <dir>` | 出力先(既定: リポジトリ直下の `out/`) |
| `--since <date>` | この日時以降に更新されたセッションだけ |
| `--project <key>` | プロジェクトで絞る(完全一致、無ければ部分一致) |
| `--client <name>` / `--model <name>` / `--branch <name>` | クライアント・モデル・ブランチで絞る |
| `--group <名前>` | 名前付きグループ(`atlas-notes/groups.json`)に入っているセッションだけ。他の絞り込みと AND。無い名前はエラー |
| `--session <id,...>` | 特定のセッションだけ(カンマ区切り、複数回指定可)。id は先頭の数文字でよく、複数に当たればエラー |
| `--notes-dir <dir>` | メモとグループの置き場(既定: リポジトリ直下の `atlas-notes/`)。無ければ無いものとして動く |
| `--port <n>` / `--no-open` | `serve` で、ポートを固定する / 起動後にブラウザを開かない |
| `--anonymize` | プロジェクト名・パス・リポジトリ名(git の origin から決めたものを含む)・ブランチを `project-01` などの仮名にし、依頼本文・セッション名・ファイルパス・自由記述(タスク完了の要約、中断の理由、エラーやサブエージェント失敗のメッセージ本文。`rate_limit` のような種別名だけは出る)を出さない。「(ホーム)」「(一時フォルダ)」「(atlas の判定)」は固有名を含まないのでそのまま、MCP サーバー名・skill 名・ツール名・agent 名(カスタム agent を含む)・hook の種別も出ます |
| `--judgments <file>` | LLM の判定結果 `judgments.json` の場所(既定: `out/judgments.json` があれば使う) |
| `--bundle <dir>` | 評価バンドルの場所(既定: `out/bundle/`) |
| `--include-empty` | `bundle` で、依頼の記録が無いセッションもパケットにする |
| `--tool-output <v>` | `export` で、ツールの結果を記録に入れる条件。`fail`(既定。失敗したときだけ)/ `all` / `none` |
| `--max-chars <n>` | `export` で、依頼・応答・要約 1 件の上限(文字、既定 20000)。超えた分は中略して字数を書く |
| `--full` | `export` で、解析用の全文記録 `out/full/<id>.md`(上限なし)と `out/coverage.json`(網羅の検査)も書く。`--anonymize` とは併用できない |
| `--snapshot-all` | `snapshot` / `all` / `export` で、既定で写さない大きなもの(`rewind-snapshots/`、一覧に無い名前のフォルダ、`logs/`)も写す |
| `--snapshot-prune` | `snapshot` / `all` / `export` で、前回 `--snapshot-all` で写したが今回は写さないものを消す(既定は残して `snapshot-manifest.json` の `extras.leftover` とログに日時を出す) |
| `--temp-dir <dir>` | `extract` で、このフォルダ配下を「(一時フォルダ)」にまとめる(複数指定可)。指定すると既定の判定(`%TEMP%` と `AppData\Local\Temp`・`/tmp` のパターン)を使わず、挙げたフォルダだけを一時フォルダとみなす。このリポジトリ自体を一時フォルダ配下に置いて試すときや、別のマシンのデータを読むとき用 |
| `--config <file>` | `extract` と `all` で読む設定ファイル(既定: 環境変数 `ATLAS_CONFIG`、無ければリポジトリ直下の `atlas.config.json`。下記「[wiki の指定](#wiki-の指定)」) |

`judge run` 専用のオプション(`--backend` `--limit` `--only` `--concurrency` `--force` `--no-allow-tools` `--timeout`)は「判定の回し方」を見てください。`judge run` では `--model` は判定に使うモデルの指定になります。

`snapshot` は各セッションの `session-state/<id>/session.db`(エージェントが残す todo の記録)も `session-store.db` と同じ方法(元を開かずにバイト列をコピーし、コピー側から `VACUUM INTO`)で複製します。2 回目以降は元のサイズと更新時刻が同じなら複製し直しません。`extract` が読むのは todo の状態別の件数と依存関係の数だけで、タイトルや説明は読みません。壊れていて複製できない `session.db` はそのセッションだけ飛ばし、理由を警告に出します。

`snapshot` が `~/.copilot` から名前だけ記録するもの(中身は読みません): `skills/` のディレクトリ名、`installed-plugins/<マーケットプレイス>/<プラグイン>/` とその `skills/` のディレクトリ名、`settings.json` の `disabledSkills`(他のキーは記録しません)。読めなかったものは理由を `extract` の警告に出します。

`extract` は、repository の記録が無いセッションについて、作業フォルダ(`gitRoot`。無ければ `cwd` から上へ探した `.git`)の `.git/config` の `[remote "origin"]` を**読むだけ**で(git コマンドは使いません)、URL から「所有者/リポジトリ」を取り出してプロジェクトにします。worktree(`.git` がファイル)は `gitdir` → `commondir` を辿って共有の設定を読みます。origin が無い・読めないときはパスのままです。上へ探すときは、ホームディレクトリと一時フォルダより上には上りません。

`out/atlas.html` は 1 ファイルで完結しており(外部への通信なし)、サーバ無しにブラウザで開けます。共有するときは `out/atlas.html` と、用語の説明 `out/glossary.html`、詳細ページの入った `out/sessions/` フォルダを一緒に渡してください(セッション記録の `.md` は外すか、伏せ字版で作り直してから)。5 MB 以上になると `build` が注意を出します(出力はします)。そのときは `--since` で期間を、`--project` などで対象を絞って作り直してください。

## wiki の指定

llm-wiki の参照は、ツール呼び出しの引数に vault の場所が現れたものを数えます。**vault を指定しないと wiki は集計せず、レポートの件数は 0 のままです。** 集計するときは、リポジトリ直下に `atlas.config.json` を置いて vault を指定してください(雛形は `atlas.config.example.json`。`atlas.bat` と `atlas-export.bat` もこの設定を読みます)。

```json
{
  "wikis": [
    "my-wiki",
    {
      "path": "my-notes",
      "index": ["README.md", "00-home.md"],
      "pages": ["notes", "areas/work"],
      "extensions": [".md", ".mdx"],
      "skills": ["notes-search"]
    }
  ]
}
```

| 項目 | 意味 | 省略時 |
|---|---|---|
| `path` | vault のフォルダ名か、その末尾を含むパス(必須)。大文字小文字は区別せず、区切りは `\` と `/` のどちらでも構いません | — |
| `index` | 索引のファイル。vault からの相対パス | `["index.md"]` |
| `pages` | 個別ページを置くフォルダ。vault からの相対パス。`"."` は vault 全体 | `["."]` |
| `extensions` | 個別ページの拡張子 | `[".md"]` |
| `skills` | wiki の skill として数える名前(完全一致) | なし(名前では数えない) |

- `wikis` の要素は文字列でも書けます。`path` だけの指定で、ほかは省略時の値です。
- `index` と `pages` は別々に判定し、索引に当たるものは索引として数えます。`pages` の配下にも索引にも当たらないファイルは「その他」です。
- vault の中に置いた skill は、`skills` に書かなくても skill のファイルの場所から判定します。
- vault を複数挙げると、レポートの「個別ページ」の一覧には `my-notes/notes/a.md` のように vault 名が先頭に付きます。件数は全 vault の合計で、vault 別には分けていません。
- **`path` はフォルダ名だけの指定が確実です。** フルパスにすると、エージェントが別の書き方(bash の `/e/notes`、`~/notes` など)で触った分は数えられません。逆にフォルダ名が短くて他と紛らわしいときは、`work/notes` のように親フォルダまで含めてください。`my-notes-app` や `notes.md` は `notes` とは別物として扱います。
- `~/` で始まる `path` はホームフォルダに展開します(展開後はフルパスの扱いです)。
- 相対パスだけで触った呼び出し(vault の中で作業していて `wiki/a.md` とだけ書いた場合など)は vault の場所が現れないので数えません。
- 項目の書き間違いは、件数が 0 になって気付きにくいのでエラーで止めます。

判定は `extract` で行うので、設定を変えたら `extract` からやり直してください(`atlas.bat` や `npm run atlas` なら毎回行います)。`extract` のログに対象の vault と参照のあったセッション数が出ます(未設定のときはその旨が出ます)。0 件のときは、まず `path` が合っているか確かめてください。

## 画面の見方

- **上部**: 生成日時、記録期間、「記録 N 件のうち M 件を集計対象にしています(空のセッション K 件を除外)」の 1 文、配色の切り替え(自動 / ライト / ダーク)。
- **目次と件数**: 幅 1280px 以上では左にサイドバーが固定され、各欄へのリンクを 概況(全体・要点・集計明細)/ 内訳(利用ランキング・実行の性質・プロジェクト別・月別推移・モデル別)/ 一覧(セッション一覧)/ 付録(用語の説明、別ページ)の 4 群に分けて並べ、その下に「グループ」の群(下記「絞り込み」)が続きます。スクロールに合わせて読んでいる欄に印が付き、下に「表示中 N / 集計対象 M セッション」、絞り込みが効いているときは「K 条件で絞り込み中」の印と「解除」が出ます。1280px 未満ではサイドバーの代わりに上部に細い目次の行が固定され(横に流れます。現在地に印)、右端に件数と「解除」が出ます。母数の M は上部の 1 文の M と揃えています。
- **絞り込み**: 1 行目に期間(開始日・終了日・直近 30 / 90 日)・プロジェクト・クライアント・モデル、「その他の条件」を開くとブランチ・入力トークン記録の有無・タスク分類・空のセッションの切り替えが出ます(どれかが効いている間は閉じられず、効いている数を印で出します)。絞ると下の欄がすべてその条件で集計し直され、サイドバー(狭い画面では上部の固定行)の「表示中 N / 集計対象 M セッション」が今の件数です。絞り込み行そのものは固定せず、スクロールすると流れます(条件を変えるときは上に戻ります)。キーボードでは Tab で順に移り、押した部品に緑の枠が出ます(日付入力は年・月・日の 3 区画で Tab を使うブラウザの仕様です)。**空のセッション**(依頼・ツール呼び出し・応答がどれも無い、開いただけのもの)は既定で集計・一覧・プロジェクト表・中央値のすべてから外しています。「その他の条件」の「空のセッションを含める」にチェックすると含めます(このときの「集計対象 M」は空を含めた件数)。条件は URL の `#` 以降に残るので、ブックマークすれば同じ絞り込みで開けます。タスク分類は LLM による判定(judgments.json)があるときだけ選べます(無いときは理由を欄の下に出します)。
  - **選んだセッションだけ集計**: セッション一覧の左端の欄にチェックを付け(見出し行のチェックでそのページの 50 件をまとめて)、一覧の上の「選んだ N 件だけ集計」を押すと、その N 件だけで全体サマリ・要点・内訳・一覧が集計し直されます(他の条件とは AND。サイドバーの条件の数にも 1 つとして数えます)。絞り込み行の「グループ」には「選んだ N 件」と出て、「すべて」に戻すか「解除」で外れます。チェックは画面の中だけのもので保存されません(選んだ id は URL の `#ids=…` に残るので、再読み込み・ブックマーク・共有では保てます)。「選択を解除」はチェックを全部外し、選択で集計中ならその条件も外します。
  - **グループ**: 名前付きグループの居場所はサイドバーの「グループ」の群(幅 1280px 未満では上部の固定した目次行の「グループ N」を押して開く一覧。外を押すか Esc で閉じます)です。「すべて」と各グループ(名前・件数・一文)が並び、押すとそのグループで絞り込まれ、現在のグループに印が付きます(もう一度押すか「すべて」で外れます)。グループが無いときは「グループはまだありません。一覧でセッションを選ぶと作れます」と出ます。作るには、セッション一覧でチェックして一覧の上の「グループに追加 ▾」を開き、既存のグループを選べばその場で追加(重複は足さず「N 件を「名前」に追加しました」と出ます。絞り込みは変わりません)、末尾の「新しいグループ…」で名前と一文を入れて作成(作成するとそのグループで絞り込んだ状態になります)。グループで絞り込み中は「このグループから外す」でチェックした分を外せます(0 件になってもグループは残ります)。サイドバーの現在のグループの行には「改名」「一文」「削除」(その場で入力・確認 1 回。セッションは消えません)が付きます。これらの操作は `atlas.bat`(= `atlas serve`)で開いたときだけ使えます。`out\atlas.html` を直接開いたときはグループを選んで絞り込むことだけができ、「このファイルは閲覧用です」と出ます。サーバが止まると画面の上に「サーバが止まっています」の帯が出て、編集の操作だけが消えます(閲覧はそのまま)。ファイルは `atlas-notes/groups.json`(リポジトリ直下。`--notes-dir` で変更可)で、形式は `{ "version": 1, "groups": [ { "name": "<名前>", "note": "<任意の一文>", "ids": ["<session id>", …] } ] }`、名前は一意です。手で書いてもよく、壊れていても `build` / `export` / `judge` は止まらず、無視した箇所を全体サマリの集計明細と脚注に出します(壊れている間は画面からも書き換えません)。グループの条件は URL の `#` に名前と id の両方で残るので、ブックマークや共有で保てます(相手にその名前のグループが無ければ id だけで「選んだ N 件」として絞り込まれます)。記録に無い id が混じっていれば件数は「m / n」です。CLI では `--group <名前>` で同じ絞り込みができ、`--session <id,...>` で特定のセッションだけを対象にできます(`build` / `export` / `metrics` / `bundle` に効きます)。`npm run atlas -- group add <名前> <id...>` でも追記できます。伏せ字版ではグループ名と一文は出さず「グループ 1, 2, …」になり、画面からの編集もできず、URL にも名前は出ません。`atlas-notes/` は `.gitignore` に入れていないので、リポジトリに含めるかどうかは自分で決めてください。
- **要点**: 絞り込み後の集計から決まった規則で選んだ短い一覧です(LLM は使いません)。AI 使用量(AIU)の大きいセッション上位 3 件(AIU の記録が無い条件では出力トークンの多い順)、失敗率の高いツール(結果の記録が 5 回以上で失敗・拒否のあったもの)、compaction の多いセッション、インストール済みで未使用の skill。各項目にはリンクがあり、セッションならその詳細ページ、ツールなら今の絞り込みに「そのツールを使ったセッション」を足した状態(URL の `#…&tool=<ツール名>`)、未使用の skill なら利用ランキングの未使用一覧に移ります。ツールで絞っているときは絞り込み行に「<ツール名> を使った ×」が出て、押すと外れます。
- **全体サマリ(表紙)**: 規模の 4 欄(セッション数、期間、実働時間、推定人手工数)。帳票の「表紙 → 摘要(要点)→ 明細」の順に並べているので、この下に要点、その下に集計明細が来ます。空のセッションを外しているときは、その件数を「空のセッション N 件を除外」と出します。
- **集計明細**(要点の下): 4 列 × 3 行の 12 欄。トークン(入力・出力・うち推論・キャッシュ読取)、AI 使用量(AIU)、premium request、API リクエスト、ツール呼び出し(失敗率つき)、変更行数、skill・agent・hook の件数、指示ファイルと llm-wiki の利用(対象の vault は「[wiki の指定](#wiki-の指定)」)、摩擦の合計。各欄の下の注記は 1 行程度に抑え、摩擦の内訳の続きは「実行の性質」へのリンクにしています。**入力トークン・AI 使用量・premium request・変更行数は記録が残っているセッションだけの合計**で、欄の下に「記録あり N / M セッション」を出します。
  - AI 使用量は nano AIU を 10 億で割った AIU で、桁区切りで表示します。金額には換算しません。premium request は旧来の課金単位で、記録のある(主に 2026 年 7 月以前の)セッションだけの合計です。
  - 変更行数(追加 / 削除)は、セッション終了時の累計(`session.shutdown` の `codeChanges`)を優先し、無ければツールごとの行数(`toolTelemetry`)を合計したものです。
  - 依頼の回数には、autopilot が自分で作業を続けるときの自動継続(ログ上はユーザーのメッセージとして残る)を含めず、別に「自動継続 N 回」と出します。
  - ツール呼び出しの回数には、作業の途中経過を画面に出すための内部ツール(`report_intent`)を含めず、件数だけ別に出します。
  - 摩擦の内訳では「ツール失敗」(個々のツール呼び出しの失敗)と「エラー」(`session.error`。利用上限・通信エラーなどセッション全体のエラー)を分けています。
  - その下の「入力トークン記録の内訳」で、明細あり / 終了時の累計のみ / 出力のみ / **記録なし(欠測)** の件数を確認できます。記録なし(欠測)は、依頼や応答があるのにトークン量の記録がどこにも無いセッションです(2026 年 9 月以降のログは `assistant.message` に出力トークン数を書かなくなったため、session-store.db・usage_record・終了時の累計のどれも無いと出力トークンも分かりません)。0 として足さず、件数で示します。帯の欠測の区画は色に加えて斜線で区別しています。
  - 帯の下に、画面で使う欠測の語の凡例を置いています: **記録なし**(ログにその項目の記録が無い)/ **推計不可**(出力トークンだけ記録があり入力は求められない)/ **未判定**(LLM の工数判定をまだ実行していない)/ **不明**(記録はあるが分類できない。クライアント・モデルなど)/ **—**(該当なし)。用語の説明ページの先頭にも同じ凡例があります。
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
- **プロジェクト別**: プロジェクトごとの集計表。列見出しで並べ替え、プロジェクト名を押すとそのプロジェクトに絞り込みます(行に「絞り込み中」の印が付き、もう一度押すと解除。名前はリンクなので Ctrl+クリックで別タブにも開けます)。入力トークンの下の小さな「5/30」は、記録のあるセッション数 / 全セッション数です。「変更行」は追加行数(下に削除行数)、「指示」「wiki」は該当セッション数 / セッション数、「摩擦」の下には内訳の多い順 3 つを小さく出します。表が幅に収まらないときは横にスクロールでき、続きがある側の端に影が出ます(他の表も同じ)。
  - プロジェクトは、ログの repository、無ければ git の origin(「所有者/リポジトリ」)で束ねます。同じリポジトリの別フォルダや worktree で開いたセッションも 1 つになります。ホームディレクトリそのもので開いたものは「(ホーム)」、一時フォルダ(`%TEMP%` 配下。scratchpad での試行など)は「(一時フォルダ)」、このツール自身の工数判定(`judge run` が作る `%TEMP%\atlas-judge-cwd-*`)は「(atlas の判定)」にまとめます。どれにも当たらないものは作業フォルダのパスのままです。
- **月別推移**: セッション数・出力トークン・入力トークン・AI 使用量(AIU)・premium request の月別の棒グラフ(月は UTC)。棒にマウスを乗せるかキーボードで選ぶと値が出ます。棒を押す(Enter / Space)と値の表示を固定でき、もう一度押すと外れます。「表で見る」で同じ値と変更行数を表で確認できます。AIU と premium request は記録のあるセッションだけの合計です。
- **モデル別**: モデルごとのトークンとリクエスト数。1 セッションで複数のモデルを使うことがあるため、セッション数の合計は全体と一致しません。同じモデルがログの出所によって `claude-haiku-5-5` / `claude-haiku-5.5` / `<ID>/claude-haiku-5-5` のように書き分けられているため、`claude-haiku-5.5` の形にそろえています(`claude-<種類>-<数字>-<1 桁の数字>` で後ろに日付などが続かないものだけ。先頭の `<UUID>/` はプロバイダ設定の ID で、同じリクエストの記録にどちらの名前も残っていることを実データで確認しています)。
- **セッション一覧**: 1 ページ 50 件。左端はチェック欄で、チェックした行は薄い緑になり、一覧の上の「N 件を選択中」と「選んだ N 件だけ集計」「選択を解除」「グループに追加 ▾」「このグループから外す」(後の 2 つは `atlas.bat` から開いたときだけ)が使えます(上記「絞り込み」)。詳細ページの目次はレポートと同じ作法で、幅 1280px 以上では左のサイドバーに「レポート(セッション一覧)に戻る」(レポートから開いたときはブラウザの「戻る」と同じ動きで、絞り込みを保ったまま戻ります。詳細ページを直接開いたときや新しいタブではレポートの先頭を開きます)、節の目次(概要・トークン内訳・…・ログの状態。読んでいる節に印)、「用語の説明」、配色の切り替えが上から並びます。`atlas export` で記録を作ってあれば「セッション記録(Markdown)を開く」「記録を .md で保存」も入ります(素の `build` では出ません)。1280px 未満では上部の帯に戻る・リンク・配色、その下に固定した目次の行(横に流れ、現在地に印)が出ます。セッション ID は表題の下の印の列の末尾にあります。「変更行」列は追加行数(下に削除行数)。名前を押すとセッション詳細(時系列、ツール内訳と成功・失敗・拒否、実行の性質(モード・推論強度・起点・ツール定義・モデル別の待ち時間・ツールの所要時間・摩擦の詳細・失敗したサブエージェントの理由・todo)、skills(呼んだ側)/ agents / hooks、指示ファイル、llm-wiki の参照、摩擦、変更行数、変更したファイル)を開きます。推定人手工数は LLM による判定を実行するまで「未判定」です。空のセッションを含めているときは、空のものに「空」の印が付きます。
  - 詳細の「変更したファイル」は、変更・作成・削除に分けて載せます。相対パスは作業フォルダ基準の絶対パスにそろえ、同じファイルは 1 回だけ載せます(Windows では大文字小文字を区別しない)。途中で削除したファイルは、終了時の記録(`codeChanges.filesModified`)に残っていても「削除」のままにします。Copilot 自身のセッション用ファイル(`~/.copilot/session-state/` 配下の plan.md など)は一覧から外し、件数だけ書きます。
  - 応答の件数には、サブエージェントの応答を含めません。
- **クライアントが「不明」のセッション**: 次のどちらかで、記録からはクライアントを決められません(推測では埋めていません)。
  - Copilot 1.0.54 以前(2026 年 5 月以前)のセッション。`workspace.yaml` に `client_name` がまだ記録されていませんでした(実データで `client_name` が初めて現れるのは 1.0.56)。
  - `session-store.db` にだけあるセッション。DB の `sessions` 表にはクライアントの列が無く、`host_type` は CLI と autopilot のどちらでも `github` か空なので区別できません。実データではこの種類はすべて空のセッションでした。
- **用語の説明**(別ページ `out/glossary.html`。上部のリンクと各詳細ページの上部から開く): 33 語を 5 つの分類に分けて載せています。**消費の単位**(nano AIU / AIU、premium request、入力 / 出力 / キャッシュ読取トークン、リクエストの起点、文脈の内訳)/ **時間と待ち**(所要時間 / 実働時間、ツールの所要時間、待ち時間)/ **記録の由来と欠測**(トークン記録なし、空のセッション、内部ツール、モデル名の表記、変更行数、プロジェクトのまとめ方。欠測の語の凡例もここ)/ **動かし方と拡張の仕組み**(モード、推論強度、compaction、skill とその呼んだ側、未使用の skill、MCP サーバー、agent、hook、指示ファイル、llm-wiki)/ **工数と判定**(推定人手工数とその ÷ AI の実働、摩擦、ツールの失敗率、権限の確認の結果、todo、要点)。目次は分類だけで、レポート・詳細ページと同じく 1280px 以上では左のサイドバー(分類の 1 行の説明つき。読んでいる分類に印)、未満では上部に固定した分類の行です。「レポートに戻る」と配色の切り替えも同じ場所にあります。各用語への直接リンク `glossary.html#<id>` は従来のままです。レポートを初めて読む人向けです。

## セッションのメモ

セッションごとに、自分用のメモ(Markdown と画像)を残せます。数字だけでは残らない「なぜこのセッションが良かった / 悪かったか」を書くためのものです。

**書き方**: `atlas.bat`(または `atlas serve`)から開いた画面で、セッションの詳細ページの「メモを書く」を押します。

- 保存は「保存」か Ctrl+S。本文を空にして保存すると、確認のうえメモを削除します(画像は残ります)。
- 画像は貼り付け、ドロップ、または「画像を追加」で入れられます(png / jpeg / gif / webp、1 枚 10MB まで。svg は不可。手で置いた画像も 10MB を超えると表示しません)。
- 開いている間に Obsidian や `atlas memo` で同じメモが書き換えられていたら、上書きせずに知らせます。入力は残るので「上書きして保存」を選べます。

**見え方**: メモは詳細ページの先頭に出ます。一覧ではセッション名の下に先頭の 1 行が出て、「その他の条件」の「メモのあるセッションだけ」で絞り込めます。`atlas.html` に埋め込むのは先頭の 1 行だけで、全文は詳細ページにあります。

**置き場**: `atlas-notes/memos/<id>.md`(素の Markdown)と、画像の `atlas-notes/memos/<id>/`。`--notes-dir` で変えられます。本文からは `![説明](<id>/<ファイル名>)` で参照するので、Obsidian や VS Code でもそのまま読め、手で置いたファイルも同じように扱います。`atlas-notes/` は Git の対象外なので、消すと元に戻せません。バックアップが必要なら自分で管理してください。

**制限**:

- `file://` で開いた画面は閲覧だけで、メモは前回の build の時点の内容です。atlas.bat から開いた画面は常に最新です。
- 生の HTML は文字として表示します。リンクは http / https / mailto だけが有効で、外部の画像は読み込みません(リンクとして出します)。
- `--anonymize` の伏せ字版にはメモを一切出しません(本文・先頭の 1 行・件数のどれも)。
- メモは評価バンドル(`bundle` / `judge`)、セッション記録、全文記録には入りません。自由記述を LLM や共有用の出力に流さないためです。

## セッション記録(Markdown)

セッションの経過を 1 ファイルの Markdown にして、人に共有したり LLM に渡して振り返ったりするための出力です。集計と同じスナップショットから作り、LLM は呼びません。

```
npm run atlas -- export                          # build と同じ絞り込みで、全セッションの .md を out/sessions/ に書く
npm run atlas -- export --since 2026-10-01       # 期間で絞る(--project / --client / --model / --branch も同じ)
npm run atlas -- export --tool-output all        # 成功したツールの結果も入れる(容量が数倍になる)
npm run atlas -- export --anonymize              # 伏せ字版(下の注意を読んでください)
```

`atlas-export.bat` をダブルクリックすると snapshot → extract → export を通しで実行し、レポートを開きます(引数は export に渡ります)。

記録 1 件(`out/sessions/<セッション ID>.md`)の中身:

| 節 | 内容 |
|---|---|
| 概要 | ID・プロジェクト・クライアント・リポジトリ・作業フォルダ・Copilot の版・開始と所要時間・依頼と応答の数・トークンと AIU・ツール呼び出し(失敗・拒否)・摩擦・変更行数 |
| 役 × モデルの消費 | 本体とサブエージェント(名前)× モデルごとのリクエスト数・入力・出力・キャッシュ読取・AIU と、待ち時間(最初のトークンまで / 全体)の中央値と p90。`session-store.db` と `usage_record` のリクエスト単位の明細から |
| ツールの内訳 | ツール別の回数・失敗・拒否 |
| 経過 | 開始からの相対時刻つきの時系列。依頼(本文、モード)、応答(本文、モデル)、ツール呼び出し 1 回 1 行(名前・引数の要約・成否・所要時間・失敗の理由)、サブエージェントの開始と完了(`[agent:名前]` を付けた中の発言とツール)、compaction(要約は折りたたみ)、権限確認、エラー、中断、モード・モデルの変更、終了時の変更行数。5 分以上の空白は「待ち」。依頼ごとに本体の消費(リクエスト数・トークン・AIU・所要)を 1 行 |
| 変更したファイル | 変更・作成・削除の一覧 |
| 秘密情報の検査 | 伏せた件数(下記) |
| 分析の観点 | LLM に渡して振り返るときの定型の観点(時間とトークンの内訳、手戻り、失敗と回復、compaction、委譲、依頼の質) |

- **既定ではツールの結果は失敗したときだけ入れます**(`--tool-output fail`)。成功した結果はログの容量の大半を占めるためで、必要なら `--tool-output all`。内部ツール(`report_intent`)は書きません。
- 長い本文は上限(`--max-chars`、既定 20,000 字。ツールの結果は 4,000 字)で中略し、中略した箇所に字数を書きます。LLM に渡す前に全体の長さを確認してください(長いセッションは 1 件で数十万字になります)。
- **秘密情報**: API キーやトークンらしい文字列(GitHub / OpenAI・Anthropic / AWS / Slack / Google のキー、秘密鍵、JWT、Bearer)は形式で見つけて `[伏せました: 種類]` に置き換え、件数を記録の末尾と `export` のログに出します。形式で探しているだけなので偽陽性・見逃しがあります。本物が見つかったら元の記録(`~/.copilot`)にも残っているので鍵を作り直してください。共有する前に中身は必ず確認してください。
- **伏せ字モード(`--anonymize`)の記録**は、プロジェクト名・パス・リポジトリ名・ブランチを仮名に、絶対パスを `<path>` に置き換え、ファイル一覧を出しません。ただし依頼文や応答などの自由記述は機械的に置き換えるだけなので、本文中の相対パス・ファイル名・人名などは残りえます。HTML の伏せ字版(本文を出さない)より弱い保証です。記録の先頭にもその注意を書きます。
- スナップショットに `events.jsonl` が無いセッション(`session-store.db` にだけあるもの、`--since` で複製対象外だったもの)は、`sessions.json` に残る最初の依頼と最後の応答だけの記録になり、その旨を書きます。
- `export` は `build` を含むので、レポートと詳細ページも作り直されます。逆に素の `build` を実行すると `.md` は消え、詳細ページのリンクも消えます(フィルタで減ったセッションの古い記録を残さないため)。`all`(`atlas.bat`・`npm run atlas`)と `atlas-judge.bat` は記録も作るので消えません。伏せ字版(`--anonymize`)の `all` は記録を作りません。
- 同じ目的の既存ツールとの関係: agent-toolkit の `copilot-session-export`(アプリの中から `/export` `/export-usage` でその場で書き出す)と `copilot-usage-export`(PowerShell だけで動く日次バッチ)は、1 セッションをその場で・自動で書き出すためのものです。atlas の `export` は、集計と同じ絞り込みと伏せ字でまとめて出すためのもので、節の構成は揃えていますが同じファイルにはなりません。

## 解析用の完全出力

出力データだけでローカルと同等の解析ができるようにするための出力です(Phase 11)。**外部に出さない前提**で、原本の文字列をそのまま含みます。

```
npm run atlas -- export --full                   # snapshot / extract 済みの状態から、全文記録と coverage.json を書く
atlas-export-full.bat                            # snapshot → extract → export --full を通しで(引数は snapshot と export に渡る)
npm run atlas -- snapshot --snapshot-all         # rewind-snapshots / 一覧に無いフォルダ / logs/ も写す
```

| 出力 | 中身 |
|---|---|
| `out/snapshot/` | 原本の複製(スナップショット)。セッションフォルダの `plan.md` / `checkpoints/` / `files/` / `rewind-file-snapshots/` / `policies/`、直下の `plans/` / `attachments/` / `chats/` の `*.md` も写す。写さなかったもの(`rewind-snapshots/` は 1 セッションで数十 MB、一覧に無い名前のフォルダ、`logs/`、`repos/`、`chats/` の `*.md` 以外)は `snapshot-manifest.json` の `extras.skipped` に名前と容量を残し、`--snapshot-all` で写す(`repos/` と `chats/` の `*.md` 以外は写さない) |
| `out/snapshot/desktop.json` | デスクトップアプリの `data.db` から、名前で固定した許可リストの列だけを読んだもの(下記) |
| `out/full/<id>.md` | 全文記録。依頼、応答、reasoningText、ツールの引数と結果(成功含む)、hook の入出力、system.message、compaction の要約、skill の本文、plan.md、チェックポイント、`files/` などの一覧、data.db の列を時系列で、上限なしで書く。除くのは暗号化・不透明データ(`encryptedContent`、`reasoningOpaque`、`reasoningBlocks` の中の base64 らしい値)と base64 の本体(画像などは `out/full/assets/<id>/` に書き出してリンク)だけで、除いた箇所に種別とバイト数を書く。hook の入力に入っているツールの結果がツールの結果と同一なら参照にする。API キーらしい文字列は形式検査で伏せて件数を末尾に書く |
| `out/coverage.json` | 網羅の検査。元データの event type × data のキーごとに件数・バイト数・扱い(`full` = 全文に出した / `ref` = 参照にした / `excluded` = 理由付きで除外)。扱いの表(`packages/report/src/coverage.ts`)に無いキーは `unclassified` として数え、`export` のログと全文記録の末尾にも出す(0 件なら欠損なし)。`data.db` の列も同じ表で(許可 = `full`、許可外 = `unclassified`、開かない表 = `excluded`) |
| `out/instructions.html` と `out/library/` | 指示文(AGENTS.md / CLAUDE.md / copilot-instructions.md 等の注入)と skill の本文を、重複なしで版(内容のハッシュ)ごとに置いたもの。見出しごとの版一覧、本文、使われたセッション、初回と最終の利用日、前の版との差分。詳細ページの指示ファイルの行と skill からリンクし、サイドバーの付録にも入る。`--full` でなくても `export` で作る。伏せ字版では作らない |

`--full` を付けない `export` や素の `build` は、前回の `out/full/` と `out/coverage.json`(と `instructions.html` / `out/library/`)を消しません(ユーザーの生成物を黙って消さないため。残っているときはログに生成日時を出します)。古い全文記録が残っている点に注意し、消したいときはフォルダを手で消すか、`--anonymize` で作ります(伏せ字版の `out/` には残しません)。

**data.db(デスクトップアプリ)**: 以前は資格情報の列を含むため読んでいませんでしたが、Phase 11 から次の形で読みます。ファイルは複製せず、`file:///…/data.db?immutable=1` の読み取り専用で開きます(`-shm` / `-wal` に触れません)。読むのは名前で固定した許可リストの列だけで(`sessions` の非資格情報の列、`session_context_usage`、`session_checkpoints`、`activity_items`、`projects` と `workspaces` の非資格情報の列)、`select *` はせず、`accounts` / `settings` / `app_state` / `model_providers` / `remote_environments` は開きません。許可リストに無い列は名前だけ数えます(値は読みません)。immutable で開くため `-wal` の未反映分は読めず、最近の更新が欠けることがあります(`desktop.json` と全文記録に WAL の大きさと更新日時を書きます)。結果は `sessions.json` の `desktop` 欄、全文記録、詳細ページの「デスクトップアプリの記録(data.db)」に出ます。

## 改善点(規則による分析)

レポートの「改善点」の節(目次「概況」の「要点」の次)と、全件のページ `out/insights.html`、機械可読の `out/insights.json` です(Phase 12)。LLM は使わず、決まった規則で集計します。**分かるのは相関まで**なので画面でも「傾向」と書いています。指示文の効果は直接は測れません(同じ版でも依頼が違う)。率は 5 セッション以上のものだけ出し、未満は「—」です(セッション数の列で分かります)。閾値は `packages/report/src/lib/insights.ts` の `THRESHOLDS` にまとめ、根拠は `docs/PLAN.md` の Phase 12 にあります。

| 箱 | 中身 | 計算の場所 |
|---|---|---|
| 指示文の傾向 | 指示文(AGENTS.md / CLAUDE.md 等)の版(内容のハッシュ)ごとの字数・注入セッション数・ツールの失敗率・手戻り率(同じファイルを 2 回以上編集したセッションの割合)・compaction と出力トークン / セッション。「長いのに注入が少ない」(字数が上位 25% で注入 3 セッション未満。見出しごとに最新の版だけ)と「版を変えた前後で悪化」(前後とも 5 セッション以上で失敗率か手戻り率が 10 ポイント以上悪化)を挙げる。版の名前から `instructions.html` の版へ移動できる(`export` 後) | レポート内で絞り込みに従って再計算 |
| skill の傾向 | skill ごとの呼び出し(利用者 / エージェント)、本文の字数、呼んだセッションと呼ばなかったセッションの失敗率、インストール済みで未使用 | 同上 |
| 止まっている箇所 | 待ち時間(TTFT の中央値 20 秒以上)、失敗の連続(3 回以上)、同じファイルの再編集(余分な編集 3 回以上)、権限確認の多さ(10 件以上)、compaction(3 回以上)のどれかに当たるセッションと、プロジェクト別の該当数 | 同上 |
| スキル化の候補 | (a) 似た依頼文の繰り返し: 依頼文を正規化(小文字、パス・URL・数字・id を印に)して文字 3-gram の Jaccard 類似度 0.6 以上を束ねる。(b) 同じツールの並びの繰り返し: 本体のターンごとのツール列から長さ 3〜6 の部分列(連続の重複は潰し、閲覧系以外のツールが 2 種類以上、周期的な繰り返しは除く)。どちらも 3 回以上・2 セッション以上。スコア = 回数 × 1 回の所要の中央値(分、2 時間で頭打ち)。相づち(OK / 続けて)と動作確認の定型文(行頭の reply with 等)、20 字未満は除く | `build` / `export` 時に全セッションで計算し、上位 30 件を埋め込む(全件は `insights.html`) |

伏せ字版(`--anonymize`)では依頼文の本文・指示文の見出し・代表文を出さず、件数とスコアだけになります(`insights.json` も同じ)。

### スキルの下書き(`atlas skill-draft`、任意)

```
npm run atlas -- skill-draft <番号>            # out/insights.json の候補の番号。--backend copilot-cli(既定)/ opencode / anthropic、--model、--timeout
```

候補の繰り返し回数・代表の依頼文・ツールの並びを LLM に渡し、SKILL.md の形の下書きを `out/skill-drafts/<番号>-<名前>.md` に書きます。**明示したときだけ動き、`build` / `export` / `all` では呼びません**。費用は 1 回の実行で判定 1 件と同じです。`copilot-cli` はモデル 1 リクエスト相当の AI クレジット、`opencode` は選んだモデルの料金、`anthropic` は Anthropic API の従量課金(`ANTHROPIC_API_KEY` が必要)を消費します。`copilot-cli` は判定と同じ安全策(`--no-custom-instructions`、`shell` / `write` / `url` の拒否、`--add-dir` なし)で動きます。`opencode` にはツールを拒否する引数を渡していないので、作業フォルダが空であることだけが歯止めです(判定と同じ)。下書きの作業フォルダは判定と同じ接頭辞にしており、次回の集計では「(atlas の判定)」に分類されて候補に戻りません。テストは偽の CLI(`ATLAS_COPILOT_BIN`、`ATLAS_OPENCODE_BIN`)と fetch の差し替えで行い、本物は呼びません。伏せ字版の `out/` では拒否します(本文が無いため)。下書きは案なので、使う前に読んで直してください。

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
npm run atlas:judge                               # bundle → judge run → export(atlas-judge.bat と同じ。伏せ字版は build)
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

- `copilot-cli` は `--add-dir` を使いません(そのフォルダの `.github/skills` / `agents` を信頼設定として読むため、他セッションの本文を含むバンドルが指示の注入口になりうるからです)。ユーザーの AGENTS.md 等も読ませません(`--no-custom-instructions`)。`--allow-all-tools` は既定で付けます(付けたくないときは `--no-allow-tools`)が、判定にツールは要らないので、シェル・ファイルの作成と変更・URL アクセス(`shell` / `write` / `url`)は常に `--deny-tool` で拒否します(`copilot help permissions` によれば拒否は `--allow-all-tools` より優先されます。パケット本文に「コマンドを実行せよ」のような文が含まれていても動かないようにするためです。実走での確認はクレジット超過のためまだです)。プロンプト中のパケットの境界には依頼ごとの乱数を付け、本文側で境界を偽装できないようにしています。
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

- **CI**(`.github/workflows/ci.yml`): `main` への push と PR ごとに、Windows と Linux × Node.js 24 と 26 の 4 通りで `npm ci` → `typecheck` → `test` → `build:report` → `e2e` → 配布物の動作確認を実行します。E2E はテスト時に生成する架空の fixture だけを使い(追加の手順は不要)、実データ(`ATLAS_LIVE`)や実際の LLM 判定は動かしません。Actions タブから手動でも実行できます。
  - 配布物の動作確認: リリースと同じ中身(`scripts/pack-release.ts`)を作り、`atlas.bat` と同じ順で動かします(`scripts/release-smoke.ts`。`*.bat` が CRLF か → 依存の判定 → `npm install` → 架空の fixture で `atlas all`(セッション記録ができるか)→ 同梱テンプレートを作り直していないか)。手元では `npm run build:report` のあと次のように試せます(コミット済みの内容だけが入ります)。

    ```
    node scripts/pack-release.ts agent-session-atlas-smoke <作業用フォルダ>
    node scripts/release-smoke.ts <作業用フォルダ>/agent-session-atlas-smoke
    ```

  - 依存の脆弱性: `package.json` の `dependencies`(集計で毎回読み込むもの)に high 以上の警告があると止まります(`npm audit --omit=dev`)。`devDependencies` は止めず、Dependabot の PR で追います(`atlas.bat` の `npm install` は `devDependencies` も入れ、テンプレートが古いときは手元で Vite が動きます)。
- **依存の更新**(`.github/dependabot.yml`): npm と GitHub Actions の更新を週 1 回 PR で出します。npm の minor / patch は 1 本にまとめ、major は個別の PR になります。どの PR も CI が通ってから取り込みます。
- **リリース**(`.github/workflows/release.yml`): `v` で始まるタグを push すると、同じ CI を通したあと、ソース一式にビルド済みのレポートテンプレートを足した `agent-session-atlas-<タグ>.zip` を GitHub Release に添付します(リリースノートは自動生成)。zip を展開して `atlas.bat` をダブルクリックすれば、初回の `npm install` のあとそのまま集計できます。zip を作るジョブと Release を作るジョブを分け、書き込み権限は後者だけに渡しています。

```
git tag v0.1.0
git push origin v0.1.0
```

公開リポジトリなので標準ランナーの Actions は無料枠で動きます。

### 元データを書き換えないための仕組み

- `session-store.db` と各セッションの `session.db` は SQLite です(前者は WAL 付き)。デスクトップアプリの `data.db` は資格情報の列(`accounts.access_token` など)を含み、集計にも使わないので複製しません(以前のバージョンが `out/snapshot/` に残した複製は次の `snapshot` で消します)。元を直接開くと読み取り専用でも `-shm` が書き換わる(mtime が変わる)ため、本体と `-wal` をバイト列のままコピーし、コピー側から `VACUUM INTO` で単一ファイルにします。コピー中に元が更新されたら取り直します。
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
