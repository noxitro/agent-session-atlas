# Rust への移行

サーバー(`atlas serve`)と集計(snapshot → extract → vcs → metrics → build)、判定(judge / turns)、そのほかの CLI を TypeScript(Node)から Rust に移す。画面(Svelte。`packages/report/src/app/`)はそのまま残し、Vite で作った `packages/report/dist/template.html` を Rust 版が使う。

## 目的と、移す前に測った値

- 配布: Node 24 と `npm install` なしで、実行ファイル 1 つで動くようにする(画面のテンプレートは実行ファイルに埋め込む)。
- 速さ・メモリ: 移す前の実測(実データ 2405 セッション、out/ を新しく作った場合)は、`all` 全体が 43.8 秒、ピーク時のメモリが 515MB。工程別では snapshot 13.7 秒、extract 5.4 秒、vcs 13.2 秒、metrics と build で約 10 秒。待機中の serve は 69MB。
  snapshot と vcs はディスクと git の待ちが大半なので、言語を変えるだけでは縮まない。縮むのは extract と build の CPU の分。

## 置き場所

```
Cargo.toml                 ワークスペース
crates/atlas-core/         packages/core の移植(types・events・snapshot・desktop・extract・normalize・classify・project・
                           instructions・wiki・metrics・turns・tables・ai-changes・vcs・vcs-retention・vcs-step・tool-failure・
                           code-stamp・atlas-build・atlas-version・fs-retry)と、共通の json.rs・jsdate.rs・collate.rs
crates/atlas-report/       packages/report の Node 側(build・detail・transcript・full・coverage・library・insights-page・
                           glossary-page・memo-*・viewer・groups-io・session-tools・memo-editor)と、build が使う lib/*
crates/atlas-judge/        packages/judge
crates/atlas-cli/          packages/cli(実行ファイル atlas)。commands/ はコマンドごとに 1 ファイル
```

TS のファイル 1 つを Rust のモジュール 1 つに移す(`normalize.ts` → `normalize.rs`)。関数名は snake_case に直すが、対応がわかるよう名前は変えない。

## 守ること(出力を TS 版と同じにするため)

- **JSON** は `atlas_core::json` の `to_js_string` / `to_js_string_pretty` / `write_js` で書く(数値を JS と同じ形で書く。`1.0` ではなく `1`)。
  キーの順は TS がオブジェクトを組み立てた順にする(serde の構造体はフィールドの宣言順で書く。TS の `undefined` は `#[serde(skip_serializing_if = "Option::is_none")]`、`null` は `Option` を常に書く。どちらなのかは TS を読んで決める)。
  入力の JSON を読んで形を変えずに渡すところは `serde_json::Value`(`preserve_order` が有効なのでキーの順は保たれる)。
- **時刻**は `atlas_core::jsdate`(`Date.parse` と `toISOString` と同じ規則)。
- **並べ替え**で `localeCompare` を使っているところは `atlas_core::collate::locale_compare`(ICU の ja 照合。Node の既定と同じ並び)。
  `a < b` や `sort()` だけ(コードポイント順ではなく UTF-16 の単位順)のところは、文字列を `encode_utf16` で比べる(サロゲートペアの文字があると順が変わる)。
  JS の `Array#sort` は安定ソートなので、Rust も `sort_by`(安定)を使う。
- **文字数**: JS の `.length` と `slice` は UTF-16 の単位で数える。字数の上限・切り詰め・抜粋は UTF-16 の単位で同じ結果になるよう書く(`str.len()` はバイト数なので使わない)。
- **正規表現**: JS の `/u` なしの正規表現は UTF-16 の単位で動く。`regex` クレートで同じ一致になるか確かめる(先読み・後読みは regex クレートに無いので書き換える)。
- **ハッシュ**: sha256 / sha1 は sha2 / sha1 クレート。入力のバイト列(UTF-8)を TS と同じにする。
- **NFKC**: `unicode-normalization`。
- **ログ**の文言は TS 版と同じにする(e2e のテストがログを見ている)。所要時間は `ms()` と同じ書式。
- **元データを書き換えない**: snapshot 以外は ~/.copilot を開かない。SQLite は複製を読み取り専用で開く。VCS は読むだけのコマンドしか呼ばない(vcs.ts の assertReadOnly)。
- **並列**: CPU を使う処理は rayon、I/O 待ちが多い処理(git の呼び出しなど)はスレッドで同時に走らせる数を TS 版の並列数以上にしてよい(出力の順は TS と同じに保つ)。

## 確かめ方

1. 単体テスト: 移したモジュールごとに `cargo test`。TS のテスト(`packages/*/test/*.test.ts`)のうち、そのモジュールの振る舞いを決めているものは Rust のテストに移す。
2. 出力の突き合わせ: `node scripts/parity.ts --stages <工程>`。TS 版と Rust 版を同じ入力で 1 工程ずつ動かし、出力ファイルを比べる。
   - 既定は架空の fixture(e2e と同じもの)。実データでは `--home ~/.copilot --config <atlas.config.json>`(実データの出力は out/parity/ に置き、コミットしない)。
   - 実行のたびに変わる値(時刻・所要時間)は比べない(`IGNORE_KEYS`)。
3. サーバの突き合わせ: `node scripts/parity-serve.ts`。架空の fixture の出力先を 2 つに写し、TS 版と Rust 版の atlas serve に同じ要求(静的ファイル・/view・GET の API・書き込み・ジョブ・チャットの判定・失敗する要求)を送って、状態コード・見出し・本文を比べる。
4. e2e(`npm run e2e`)と画面のテスト(`npm run ui`)を Rust 版の実行ファイルに向けて通す。環境変数 `ATLAS_CLI` に Rust 版の atlas の実行ファイルを指定すると、
   テストは `e2e/fixture-home.ts` の `cliCommand`(CLI)と `startServer`(サーバ。atlas serve を別のプロセスで動かす)を通して Rust 版を動かす。
   テストが TS 版の startServe に直接渡していた設定は、環境変数で渡す(`ATLAS_SERVE_IDLE_MS`・`ATLAS_SERVE_BYE_GRACE_MS`・`ATLAS_SERVE_FIRST_HEARTBEAT_MS`・
   `ATLAS_SERVE_MEMO_IMAGE_LIMIT`・`ATLAS_SERVE_VIEW_LIMIT`・`ATLAS_SERVE_CODE_STAMP`・`ATLAS_SERVE_CAN_PICK`、フォルダを選ぶ画面の代わりは `ATLAS_TEST_HOOK_URL`。テスト専用で、ふだんは設定しない)。

## 進め方と状況

| 段 | 中身 | 状況 |
|---|---|---|
| 0 | ワークスペース、json・jsdate・collate、CLI の引数解釈と出力先、突き合わせのスクリプト | 済 |
| 1a | snapshot・desktop・fs-retry(`atlas snapshot`) | |
| 1b | types・events・event-types・normalize・classify・project・instructions・wiki・tool-failure・extract(`atlas extract`) | |
| 2 | ai-changes・vcs・vcs-retention・vcs-step(`atlas vcs`) | |
| 3 | turns・metrics・tables(`atlas metrics`、表の CSV と atlas.sqlite) | |
| 4 | report の Node 側と build が使う lib(`atlas build` / `export`) | |
| 5 | serve・jobs・viewer・memo・groups・folders・open | 済 |
| 6 | judge・turns(bundle・run・import・m365)・skill-draft | |
| 7 | config・setup・self-update・upload 系・group export / upload・schedule | |
| 8 | 起動用の .bat を Rust 版に切り替え、e2e と画面のテストを Rust 版で通し、TS のサーバー側のコードを消す | |
