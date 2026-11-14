# Rust への移行

サーバー(`atlas serve`)と集計(snapshot → extract → vcs → metrics → build)、判定(judge / turns)、そのほかの CLI を TypeScript(Node)から Rust に移した。
画面(Svelte。`packages/report/src/app/`)と、画面が使う `packages/report/src/lib/`・`shared/`・`styles/` は TypeScript のまま残し、Vite で作った `packages/report/dist/template.html` を Rust の実行ファイルに埋め込む。

**状況: 移行は終わった(段 0〜8)。** TS のサーバー側(`packages/core`・`packages/cli`・`packages/judge`、`packages/report` の Node 側)は消した。
残したのは、TS 版の schedule-upload.bat で登録した自動送信のタスクのための互換の入口 `packages/cli/src/upload-auto.ts` だけ(下記「決めたこと」)。

## 目的と、移す前に測った値

- 配布: Node 24 と `npm install` なしで、実行ファイル 1 つで動くようにする(画面のテンプレートは実行ファイルに埋め込む)。
- 速さ・メモリ: 移す前の実測(実データ 2405 セッション、out/ を新しく作った場合)は、`all` 全体が 43.8 秒、ピーク時のメモリが 515MB。工程別では snapshot 13.7 秒、extract 5.4 秒、vcs 13.2 秒、metrics と build で約 10 秒。待機中の serve は 69MB。
  snapshot と vcs はディスクと git の待ちが大半なので、言語を変えるだけでは縮まない。縮むのは extract と build の CPU の分。

## 置き場所

```
Cargo.toml                 ワークスペース。[workspace.package] の version が配る版(リリースのタグは v<version>)
crates/atlas-core/         TS 版の packages/core の移植(types・events・snapshot・desktop・extract・normalize・classify・project・
                           instructions・wiki・metrics・turns・tables・ai-changes・vcs・vcs-retention・vcs-step・tool-failure・
                           atlas-build・atlas-version・fs-retry)と、共通の json.rs・jsdate.rs・collate.rs
crates/atlas-report/       TS 版の packages/report の Node 側(build・detail・transcript・full・coverage・library・insights-page・
                           glossary-page・memo-*・viewer・groups-io・session-tools・memo-editor)と、build が使う lib/*。
                           ページに埋め込む JS と CSS は assets/ が元(TS の定数から書き出したもの。今はここを直す)
crates/atlas-judge/        TS 版の packages/judge
crates/atlas-cli/          TS 版の packages/cli(実行ファイル atlas)。commands/ はコマンドごとに 1 ファイル。
                           build.rs が版の目印とコミットを決める(version.rs)。assets/m365-uia.ps1 は M365 Copilot を操作するスクリプト
packages/report/src/app/   画面(Svelte)。lib/・shared/・styles/ と一緒に Vite で dist/template.html にまとめる
packages/report/src/shared/ 画面が読む型と定数(もとは packages/core にあったもの。types・turns・tool-failure・project-keys・
                           desktop-types・atlas-version)
scripts/ensure-atlas.ps1   起動用の .bat が最初に動かす: bin\atlas.exe を Cargo.toml の版にそろえる(リリースから取る / ビルドする)
```

TS のファイル 1 つを Rust のモジュール 1 つに移した(`normalize.ts` → `normalize.rs`)。関数名は snake_case に直したが、対応がわかるよう名前は変えていない。

## 守ったこと(出力を TS 版と同じにするため)

- **JSON** は `atlas_core::json` の `to_js_string` / `to_js_string_pretty` / `write_js` で書く(数値を JS と同じ形で書く。`1.0` ではなく `1`)。
  キーの順は TS がオブジェクトを組み立てた順にする(serde の構造体はフィールドの宣言順で書く。TS の `undefined` は `#[serde(skip_serializing_if = "Option::is_none")]`、`null` は `Option` を常に書く)。
  入力の JSON を読んで形を変えずに渡すところは `serde_json::Value`(`preserve_order` が有効なのでキーの順は保たれる)。
- **時刻**は `atlas_core::jsdate`(`Date.parse` と `toISOString` と同じ規則)。
- **並べ替え**で `localeCompare` を使っていたところは `atlas_core::collate::locale_compare`(ICU の ja 照合。Node の既定と同じ並び)。
  `a < b` や `sort()` だけ(UTF-16 の単位順)のところは、文字列を `encode_utf16` で比べる。JS の `Array#sort` は安定ソートなので、Rust も `sort_by`(安定)を使う。
- **文字数**: JS の `.length` と `slice` は UTF-16 の単位で数える。字数の上限・切り詰め・抜粋は UTF-16 の単位で同じ結果になるよう書く。
- **正規表現**: JS の `/u` なしの正規表現は UTF-16 の単位で動く。`regex` クレートで同じ一致になるか確かめた(先読み・後読みは書き換えた)。
- **ハッシュ**: sha256 / sha1 は sha2 / sha1 クレート。入力のバイト列(UTF-8)を TS と同じにする。**NFKC**: `unicode-normalization`。
- **ログ**の文言は TS 版と同じ(e2e のテストがログを見ている)。所要時間は `ms()` と同じ書式。
- **元データを書き換えない**: snapshot 以外は ~/.copilot を開かない。SQLite は複製を読み取り専用で開く。VCS は読むだけのコマンドしか呼ばない。
- **並列**: CPU を使う処理は rayon、I/O 待ちが多い処理(git の呼び出しなど)はスレッドで同時に走らせる数を TS 版の並列数以上にした(出力の順は TS と同じ)。

## 確かめ方(移行の間に使ったものと、今も残すもの)

1. 単体テスト: `cargo test --workspace`。TS のテストのうち、そのモジュールの振る舞いを決めていたものは Rust のテストに移した。
2. 出力の突き合わせ(移行の間だけ。TS の CLI を消したので、スクリプトも消した): `scripts/parity.ts`(工程ごとの出力ファイル)・`parity-serve.ts`(サーバの応答)・
   `parity-cli.ts`(対話の入口)・`parity-judge.ts`・`parity-build.ts`・`parity-markdown.ts`。どれも架空の fixture と実データで差が無いことを確かめてから消した。
   CLI の中に残した試すとき用の口(`ATLAS_PARITY_FAKE_PS`・`ATLAS_PARITY_SKIP_AGGREGATE`)は、本物のタスク スケジューラや集計に触れずに試すのに使える。
3. **画面の TS の lib と Rust の lib の突き合わせ(残す)**: 画面(`packages/report/src/lib/`)と、ページを書くときの Rust(`crates/atlas-report/src/`)は同じ計算を 2 か所に持つ。
   `npm run parity:fixture`(`scripts/parity-fixture.ts` → `scripts/parity-lib.ts --compare`。Rust の側は `crates/atlas-report/examples/libdump.rs`)が架空の fixture で比べる(CI でも回す)。
4. e2e(`npm run e2e`)と画面のテスト(`npm run ui`)は Rust の実行ファイルを動かす。実行ファイルは環境変数 `ATLAS_CLI` → `bin/` → `target/release/` → `target/debug/` の順に探す(`e2e/fixture-home.ts`)。
   テストが TS 版の startServe に直接渡していた設定は、環境変数で渡す(`ATLAS_SERVE_IDLE_MS`・`ATLAS_SERVE_BYE_GRACE_MS`・`ATLAS_SERVE_FIRST_HEARTBEAT_MS`・
   `ATLAS_SERVE_MEMO_IMAGE_LIMIT`・`ATLAS_SERVE_VIEW_LIMIT`・`ATLAS_SERVE_CODE_STAMP`・`ATLAS_SERVE_CAN_PICK`、フォルダを選ぶ画面の代わりは `ATLAS_TEST_HOOK_URL`。テスト専用で、ふだんは設定しない)。

## 進め方と状況

| 段 | 中身 | 状況 |
|---|---|---|
| 0 | ワークスペース、json・jsdate・collate、CLI の引数解釈と出力先、突き合わせのスクリプト | 済 |
| 1a | snapshot・desktop・fs-retry(`atlas snapshot`) | 済 |
| 1b | types・events・event-types・normalize・classify・project・instructions・wiki・tool-failure・extract(`atlas extract`) | 済 |
| 2 | ai-changes・vcs・vcs-retention・vcs-step(`atlas vcs`) | 済 |
| 3 | turns・metrics・tables(`atlas metrics`、表の CSV と atlas.sqlite) | 済 |
| 4 | report の Node 側と build が使う lib(`atlas build` / `export`) | 済 |
| 5 | serve・jobs・viewer・memo・groups・folders・open | 済 |
| 6 | judge・turns(bundle・run・import・m365)・skill-draft | 済 |
| 7 | config・setup・self-update・upload 系・group export / upload・schedule | 済 |
| 8 | 起動用の .bat を Rust 版に切り替え、配り方(リリースとこの PC でのビルド)、e2e と画面のテストを Rust 版で通し、TS のサーバー側のコードを消す | 済 |

## 決めたこと(段 8)

- **配り方は「両方」**: 利用者は、チェックアウトの版(`Cargo.toml` の `version`)と同じ `v<version>` の GitHub Release があれば、そこから `atlas.exe` を取ってくる(Node も Rust も要らない)。
  無ければ、Node.js と Rust があればその PC でビルドする。どちらもできなければ、何を入れればよいかを出して止まる。
- **`scripts/ensure-atlas.ps1`**(起動用の .bat がすべて最初に呼ぶ。Windows PowerShell 5.1 で動くよう BOM 付き UTF-8・CRLF):
  1. `bin\atlas.exe --version` の版が `Cargo.toml` と同じなら、そのまま使う。ただし、この PC でビルドしたもの(`bin\atlas-source.txt` が `local <コミット>`)は、
     作ったときのコミットが今のコミットと違い、Node と Rust があれば、ビルドし直す(開発者が `git pull` しても古い実行ファイルのままにならないように)。
     リリースから取ったもの(`release v<version>`)は、同じ版のうちはそのまま使う(版を上げないコミットは利用者に届かない。届けたい変更は版を上げてリリースする)。
  2. リリースのリポジトリは `git remote get-url origin` から決める(決め打ちしない)。`https://github.com/<owner>/<repo>/releases/download/v<version>/atlas.exe` と `.sha256` を取り、
     sha256 と `--version` の版を確かめてから置く。取れなければ `gh release download` も試す(公開していないリポジトリ用)。
  3. ビルドは `npm ci`(`scripts/deps-fresh.mjs` で揃っていれば飛ばす)→ `npm run build:report` → `cargo build --release --locked -p atlas-cli`(`ATLAS_REQUIRE_TEMPLATE=1`)。
     経過は `bin\build.log` に書き、窓には 1 工程 1 行だけ出す。
  4. 動いている `bin\atlas.exe`(開いたままの画面のサーバ、自動で送るタスク)は消せないので、別の名前(`atlas.old-*.exe`)に移してから置き換え、次に動かしたときに消す。
  管理者の権限は要らない(書くのは `bin\`・`target\`・`node_modules\` だけ)。`-Check` は何も変えずに、そのまま使えるかを終了コードで返す。
- **自動で送る前の更新**(`crates/atlas-cli/src/self_update.rs`): `git pull`(早送り)の後、`ensure-atlas.ps1 -Check` で今の版の実行ファイルか確かめ、違えば `ensure-atlas.ps1` で用意する。
  用意できなければ前のコミットに戻し、前の版の実行ファイルを用意し直して、前の版で送る(TS 版の「依存を入れられなければ戻す」と同じ形)。
  用意したら `bin\atlas.exe upload-auto …` を動かし直す(`paths::installed_exe`。動いている実行ファイルは移されているので、`current_exe` ではなく `bin\` を動かす)。
  ダウンロードと検証とビルドは .bat と同じ手順を使いたいので、Rust で書き直さずにスクリプトを呼ぶ(HTTP と TLS のクレートも実行ファイルに入れずに済む)。
- **TS 版で登録したタスク**(`conhost --headless "<node>" "<repo>\packages\cli\src\upload-auto.ts" [--no-update]`): その場所に、依存を読み込まない互換の入口を残した。
  `ensure-atlas.ps1` で実行ファイルを用意し、`bin\atlas.exe upload-auto` を同じ引数で動かす(環境変数 `ATLAS_TS_TASK=1` を付け、atlas が記録に「登録し直してください」と書く)。
  `schedule-upload.bat`(`atlas upload-schedule`)を開くと、TS 版のタスクだと分かれば、時刻と自動更新の設定はそのままで、`bin\atlas.exe` を直接動かす形に登録し直す。
  TS 版の自動更新でこの版に上がった直後は、TS 版のプロセスが互換の入口を動かし直す。実行ファイルを用意できなければ、TS 版の仕組みが前の版に戻して送る。
- **版の目印**(画面とサーバの版のずれ。ページの `<meta name="atlas-code">` と応答の `x-atlas-code`): 実行ファイルを作るときに `crates/atlas-cli/build.rs` が決める。
  材料は各クレートの `Cargo.toml`・`build.rs`・`src/`・`assets/`、ワークスペースの `Cargo.toml`・`Cargo.lock`、埋め込むテンプレートと `base.css`(改行は LF にそろえ、作業ファイルは数えない)。
  実行するときに `packages/` のソースを読まないので、ページを書いた実行ファイルとサーバの実行ファイルが同じなら必ず同じ目印になる。
  送るときに添える版(`atlas_build`: コミット・日時・手で変えたか・目印)は、コミットなどは今までどおりチェックアウトの git から、目印はこの値を使う。
- **テンプレート**: 実行するときは実行ファイルに埋め込んだものだけを使う(リポジトリの `dist/` は読まず、古ければ Vite で作り直すこともしない)。
  置いてある `dist/` が別の版のものでも、実行ファイルと同じ版の画面を書くため。画面を変えたら `npm run build:report` の後に `cargo build` し直す。
- **`atlas --version`**: `atlas <version> (commit <作ったときのコミット>, code <目印>)`。コミットは build.rs が `git rev-parse HEAD` で読む(環境変数 `ATLAS_BUILD_COMMIT` で渡せる)。
- **CI**: Windows と Linux × Node 24・26 で `typecheck` → `build:report` → `test`(`cargo test` と TS の単体テスト)→ `build:atlas` → `parity:fixture` → `e2e` → `ui` → `smoke`。
  Rust はランナーの rustup で入れる(SHA で固定する Action を増やさない)。`smoke` は clone した直後の中身で `ensure-atlas.ps1` のビルドの道を通す。
- **リリース**(`.github/workflows/release.yml`): `v*` のタグの push で、Windows のランナーが `atlas.exe` と `atlas.exe.sha256` を作り、そのタグのリリースに付ける。タグと `Cargo.toml` の版が違えば止める。
- **消したもの**: `packages/core`・`packages/judge`・`packages/cli`(互換の入口を除く)、`packages/report` の Node 側の .ts、それらの TS の単体テスト、
  `scripts/gen-report-assets.ts` と `crates/atlas-report/tests/assets_drift.rs`(ページに埋め込む JS と CSS は全部 TS の Node 側にあったので、`assets/` が元になった)、
  突き合わせのスクリプト(上記)、依存の `marked`(Node 側の Markdown)。`yaml` はテスト用の fixture を作るのに使うので、ルートの devDependencies に移した。

## 移した後の実測

同じ PC・同じ実データ(2549 セッション。読むだけ)・同じ atlas.config.json で、TS 版(移行前の最後のコミット 1297185、Node 24、`UV_THREADPOOL_SIZE=16`)と Rust 版(release ビルド)の `atlas all` を、
出力先を消してから 1 回(新しく作る)と、続けてもう 1 回(前の snapshot を使い回す)動かした。ピーク時のメモリは atlas のプロセスの最大の working set(子の git は数えない)。
どちらも ~/.copilot はディスクのキャッシュに載った状態で測った(移す前の 43.8 秒・snapshot 13.7 秒は、キャッシュに無い状態を含む別の日の値)。

| | TS 版 | Rust 版 |
|---|---|---|
| `all`(出力先を新しく作る) | 35.2 秒 / 569MB | 13.9 秒 / 451MB |
| うち snapshot・extract・vcs・export(build) | 6.1・5.6・10.8・11.4 秒 | 3.2・1.7・4.8・3.2 秒 |
| `all`(2 回目。snapshot を使い回す) | 31.0 秒 / 535MB | 12.0 秒 / 486MB |
| 待機中の `serve`(起動して 10 秒後の working set / private) | 79MB / 178MB | 6MB / 1MB |

- 出力の中身は同じ(セッション 2549・空 852・プロジェクト 73・モデル 22、atlas.html 4.61MB、詳細ページ 2549 件 92.43MB)。
- vcs は git の呼び出しの待ちが大半なので、言語を変えた分よりは縮まない。export(build)は詳細ページと記録を rayon で並べて書くので大きく縮んだ。
- `scripts/ensure-atlas.ps1` のこの PC でのビルド(clone した直後。`npm ci` → `npm run build:report` → `cargo build --release` を一から)は 68 秒、2 回目からの確かめは 0.9 秒(この PC。遅い PC では数分かかる)。
