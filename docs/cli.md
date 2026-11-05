# コマンドとオプション

[README](../README.md) に戻る。起動と画面での使い方は README、画面の各欄の意味は [screen.md](screen.md) にあります。

```
npm install
npm run atlas                              # all と同じ: snapshot → extract → metrics → export(記録つき)
npm run atlas -- build --anonymize         # 伏せ字版の HTML を作り直す(共有用)
npm run atlas -- all --since 2026-07-01    # 7 月以降に更新されたセッションだけ
npm run atlas -- --help                    # 使い方
```

## コマンド

| コマンド | すること |
|---|---|
| `snapshot` | `~/.copilot` の必要部分(`session-store.db`、各セッションの `workspace.yaml` / `events.jsonl` / `session.db` / `plan.md` / `checkpoints/` / `files/` / `rewind-file-snapshots/` / `policies/`、直下の `plans/` / `attachments/` / `chats/` の `*.md`)を `out/snapshot/` へ複製する。`data.db`(デスクトップアプリ)は複製せず、許可リストの列だけを `desktop.json` に書く([outputs.md](outputs.md#解析用の完全出力) の「data.db」)。大きいもの(`rewind-snapshots/`、一覧に無い名前のフォルダ、`logs/`)は既定で写さず名前と容量を `snapshot-manifest.json` に残す(`--snapshot-all` で写す)。インストール済みの skill・プラグインは**名前だけ**を記録する(下記) |
| `extract` | スナップショットから `out/sessions.json` を作る。repository の記録が無いセッションは、作業フォルダの git の設定を読んでプロジェクトを束ねる(下記) |
| `metrics` | `out/metrics.json`(全体・プロジェクト・クライアント・月・モデル別の集計。空のセッションは除き、件数を `emptySessions` に、トークンの出所別・欠測の件数を各集計の `tokenSources` / `sessionsMissingTokens` に、ツールの成否を `tools.results`、MCP サーバー別を `tools.mcp`、skill の呼んだ側を `skills.byTrigger`、agent の失敗とトークンを `agents.byNameDetail`、変更行数を `lines`、インストール済みで未使用の skill を `installedSkills`、モード・推論強度・リクエストの起点・ツール定義のトークンを `exec`、権限の結果・エラーの種別・サブエージェント失敗の理由・compaction 自体のトークンを `frictionDetail`、todo を `todos`、モデル別の待ち時間を `latency`、ツール別の所要時間を `toolDurations` に持つ)を作る |
| `build` | `out/atlas.html` と `out/sessions/<id>.html`(セッション詳細)を作る |
| `export` | `build` に加えて、各セッションの記録(経過・消費)を `out/sessions/<id>.md` に書く。LLM での振り返り用(共有するなら `--anonymize` の記録を中身を確かめてから。[outputs.md の「セッション記録」](outputs.md#セッション記録markdown))。指示文と skill の閲覧ページ `out/instructions.html` も作る。`--full` で解析用の全文記録([outputs.md](outputs.md#解析用の完全出力))。LLM は呼ばない |
| `all` | `snapshot` → `extract` → `metrics` → `export` を順に実行する(コマンド省略時の既定)。`--anonymize` のときは記録を作らず `build` にする(記録の伏せ字は HTML より弱いため) |
| `bundle` | LLM に工数を判定させる評価バンドル `out/bundle/` を作る(LLM は呼ばない)。ZIP を渡せない相手用に、指示とパケット数件を 1 ファイルにまとめた `out/bundle/parts/part-<番号>.md` も書く |
| `judge run` | バンドルの各セッションを LLM で判定し `out/judgments.json` に追記する(**クレジットを消費します**) |
| `judge import <ファイル>` | 外部の LLM で作った判定(JSON か、JSON を含む Markdown)を検証して `out/judgments.json` に取り込む |
| `serve` | `out/` をローカルサーバ(`127.0.0.1`)で配信してブラウザで開く。画面からグループとメモを書け、集計し直す・工数の判定・記録と全文記録の表示ができる([screen.md の「画面からの操作」](screen.md#画面からの操作))。ブラウザを閉じると止まる(画面から動かした処理の実行中は、終わるまで待ってから止まる)。`atlas.bat` はこれで終わる |
| `memo list` / `memo show <id>` / `memo set <id> <本文...>` / `memo set <id> --file <path>` / `memo remove <id>` | セッションごとのメモ(`atlas-notes/memos/<id>.md`)を一覧・表示・保存・削除する。id は先頭の数文字でよい。`remove` は画像を残す([screen.md の「セッションのメモ」](screen.md#セッションのメモ)) |
| `group list` / `group add <名前> <id...> [--note <一文>]` / `group remove <名前>` | 名前付きグループ(`atlas-notes/groups.json`)を一覧・追加・削除する。`add` は既存の名前なら id を追記(重複は除く)。id は先頭の数文字でよい(1 つに決まらなければエラー)。壊れたファイルは上書きしない([screen.md の「グループとセッションの選択」](screen.md#グループとセッションの選択)) |

## オプション

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
| `--anonymize` | プロジェクト名・パス・リポジトリ名(git の origin から決めたものを含む)・ブランチを `project-01` などの仮名にし、依頼本文・セッション名・ファイルパス・自由記述(タスク完了の要約、中断の理由、エラーやサブエージェント失敗のメッセージ本文。`rate_limit` のような種別名だけは出る)を出さない。「(ホーム)」「(一時フォルダ)」「(atlas の判定)」は固有名を含まないのでそのまま、MCP サーバー名・skill 名・ツール名・agent 名(カスタム agent を含む)・hook の種別も出ます。パスは途中のフォルダ名に空白があっても(`C:\Users\<名前 姓>\OneDrive - <会社名>\…`)まとめて `<path>` にし、既知の固有名は大文字小文字を区別せずに置き換えます。使えるのは `build` / `export` / `all`(と `npm run atlas:judge` の最後のレポート)だけで、伏せ字に対応しない `bundle` や `judge` などに付けるとエラーになります(評価バンドルは伏せ字になりません) |
| `--judgments <file>` | LLM の判定結果 `judgments.json` の場所(既定: `out/judgments.json` があれば使う) |
| `--bundle <dir>` | 評価バンドルの場所(既定: `out/bundle/`) |
| `--include-empty` | `bundle` で、依頼の記録が無いセッションもパケットにする |
| `--per-part <n>` | `bundle` で、`parts/` の 1 ファイルに入れるパケットの数(既定 5) |
| `--unjudged` | `bundle` で、判定済み(`judgments.json` にある)セッションを入れない(画面の「チャットに貼る」の「添付ファイルを作る」はこれを付ける) |
| `--tool-output <v>` | `export` で、ツールの結果を記録に入れる条件。`fail`(既定。失敗したときだけ)/ `all` / `none` |
| `--max-chars <n>` | `export` で、依頼・応答・要約 1 件の上限(文字、既定 20000)。超えた分は中略して字数を書く |
| `--full` | `export` で、解析用の全文記録 `out/full/<id>.md`(上限なし)と `out/coverage.json`(網羅の検査)も書く。`--anonymize` とは併用できない |
| `--snapshot-all` | `snapshot` / `all` / `export` で、既定で写さない大きなもの(`rewind-snapshots/`、一覧に無い名前のフォルダ、`logs/`)も写す |
| `--snapshot-prune` | `snapshot` / `all` / `export` で、前回 `--snapshot-all` で写したが今回は写さないものを消す(既定は残して `snapshot-manifest.json` の `extras.leftover` とログに日時を出す) |
| `--temp-dir <dir>` | `extract` で、このフォルダ配下を「(一時フォルダ)」にまとめる(複数指定可)。指定すると既定の判定(`%TEMP%` と `AppData\Local\Temp`・`/tmp` のパターン)を使わず、挙げたフォルダだけを一時フォルダとみなす。このリポジトリ自体を一時フォルダ配下に置いて試すときや、別のマシンのデータを読むとき用 |
| `--config <file>` | `extract` と `all` で読む設定ファイル(既定: 環境変数 `ATLAS_CONFIG`、無ければリポジトリ直下の `atlas.config.json`。下記「[wiki の指定](#wiki-の指定)」) |

`judge run` 専用のオプション(`--backend` `--limit` `--only` `--concurrency` `--force` `--no-allow-tools` `--timeout`)は [judge.md](judge.md) を見てください。`judge run` では `--model` は判定に使うモデルの指定になります。

## snapshot と extract が読むもの

`snapshot` は各セッションの `session-state/<id>/session.db`(エージェントが残す todo の記録)も `session-store.db` と同じ方法(元を開かずにバイト列をコピーし、コピー側から `VACUUM INTO`)で複製します。2 回目以降は元のサイズと更新時刻が同じなら複製し直しません。`extract` が読むのは todo の状態別の件数と依存関係の数だけで、タイトルや説明は読みません。壊れていて複製できない `session.db` はそのセッションだけ飛ばし、理由を警告に出します。`session-store.db` を、Copilot が書き続けているなどで何度か取り直しても一貫した状態で複製できなかったときは、集計を止めずに前回の複製を使い(前回の複製が無ければその内容を使わず)、理由を警告に出します。走査の途中で消されたセッションは飛ばします。

`snapshot` が `~/.copilot` から名前だけ記録するもの(中身は読みません): `skills/` のディレクトリ名、`installed-plugins/<マーケットプレイス>/<プラグイン>/` とその `skills/` のディレクトリ名、`settings.json` の `disabledSkills`(他のキーは記録しません)。読めなかったものは理由を `extract` の警告に出します。

`extract` は、repository の記録が無いセッションについて、作業フォルダ(`gitRoot`。無ければ `cwd` から上へ探した `.git`)の `.git/config` の `[remote "origin"]` を**読むだけ**で(git コマンドは使いません)、URL から「所有者/リポジトリ」を取り出してプロジェクトにします。worktree(`.git` がファイル)は `gitdir` → `commondir` を辿って共有の設定を読みます。origin が無い・読めないときはパスのままです。上へ探すときは、ホームディレクトリと一時フォルダより上には上りません。

## レポートのファイル

`out/atlas.html` は 1 ファイルで完結しており(外部への通信なし)、サーバ無しにブラウザで開けます。共有するときは、伏せ字版(`--anonymize`)で作った `out/atlas.html` と、用語の説明 `out/glossary.html`、詳細ページの入った `out/sessions/` フォルダを一緒に渡してください(伏せ字版の `all` は記録の `.md` を作りません)。5 MB 以上になると `build` が注意を出します(出力はします)。そのときは `--since` で期間を、`--project` などで対象を絞って作り直してください。

## wiki の指定

llm-wiki の参照は、ツール呼び出しの引数に vault の場所が現れたものを数えます。**vault を指定しないと wiki は集計せず、レポートの件数は 0 のままです。** 集計するときは、リポジトリ直下に `atlas.config.json` を置いて vault を指定してください(雛形は `atlas.config.example.json`。`atlas.bat` と画面の「集計し直す」もこの設定を読みます)。

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
