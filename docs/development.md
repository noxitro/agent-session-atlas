# 開発

[README](../README.md) に戻る。

前提: Node.js 24 以上(画面の Svelte のビルドと、テスト・スクリプトで `node:sqlite` と TypeScript の型除去を使うため)と Rust(rustup の stable。`cargo`)。

atlas の本体(集計・レポートのページ・サーバ・判定・アップロード)は Rust の実行ファイル 1 つ(`crates/atlas-cli`、実行ファイルの名前は `atlas`)です。
画面(`packages/report/src/app/`。Svelte)と、画面が使う `packages/report/src/lib/`・`shared/`・`styles/` は TypeScript のまま残し、Vite で `packages/report/dist/template.html` にまとめます。
`cargo build` は、そのときの `template.html` を実行ファイルに埋め込みます(`crates/atlas-report/build.rs`。実行するときはリポジトリの `dist/` を読みません)。
そのため **画面を変えたら `npm run build:report` の後に `cargo build` し直します**。

```
npm install
npm run build:report  # 画面のテンプレート(packages/report/dist/template.html)を作る。atlas のビルドより先に
npm run build:atlas   # cargo build --release -p atlas-cli(target/release/atlas.exe。テンプレートを埋め込む)
npm run atlas -- --help   # atlas を動かす(scripts/atlas.ts。bin/ → target/release → target/debug の順に探す)
npm run typecheck   # tsc(e2e・ui・scripts・画面の lib)+ svelte-check(出力なし)
npm test            # 単体テスト: cargo test --workspace と、残った TS の単体テスト(packages/report/test・scripts/*.test.ts)
npm run parity:fixture  # 画面の TS の lib と、build が使う Rust の lib の突き合わせ(架空の fixture。下記)
npm run e2e         # E2E(テスト時に生成する架空の fixture のみ。生成は自動)
npx playwright install chromium   # 画面の操作の検査に使うブラウザ(初回だけ)
npm run ui          # 画面の操作の検査(ui/。架空の fixture で atlas serve を立て、Chromium で押して確かめる)
npm run audit:ui -- out   # 生成したレポートの全ページの網羅チェック(下記)
# 画面の操作の検査を、CI の遅い機械に近い速さで(Chromium の CPU を N 倍遅くする。待ちの切れ方を手元で再現したいとき)
ATLAS_UI_CPU_SLOWDOWN=20 npm run ui
npm run fixtures    # fixture(.fixtures/)を手で作り直す(中身を見たいとき。E2E は毎回自動で作り直す)
```

e2e・画面の検査・`npm run atlas` が動かす atlas は、環境変数 `ATLAS_CLI` → `bin/atlas(.exe)` → `target/release/atlas(.exe)` → `target/debug/atlas(.exe)` の順に探します(`e2e/fixture-home.ts`)。
`bin/` は起動用の `.bat` が置くもの(古い版のことがある)なので、手元で直したものを試すときは `bin/` を消すか `ATLAS_CLI` で指定します。

画面の TS の lib(`packages/report/src/lib/`)と、ページを書くときに Rust が使う lib(`crates/atlas-report/src/`)は同じ計算を 2 か所に持っています。
`npm run parity:fixture`(`scripts/parity-fixture.ts` → `scripts/parity-lib.ts --compare`。Rust の側は `crates/atlas-report/examples/libdump.rs`)が、架空の fixture で両方の結果を比べ、違いがあれば落ちます。lib を変えたら両方を直します。
実データで比べるときは `node scripts/parity-lib.ts <out> --compare`(結果には依頼文がそのまま入るので、比べ終わったら `out/parity-lib-dump` を消す)。

実データ(`~/.copilot`)を使う E2E は環境変数で有効にします。元のファイルは書き換えず、`out/live/` にスナップショットと `sessions.json` / `metrics.json` を出力します。

```
# PowerShell
$env:ATLAS_LIVE = '1'; npm run e2e
# bash
ATLAS_LIVE=1 npm run e2e
```

`ATLAS_COPILOT_HOME` で `~/.copilot` 以外の場所を指定できます。E2E は LLM を呼びません(`judge run` の検査は偽の copilot で行います)。

## 全ページの網羅チェック(`npm run audit:ui`)

生成したレポート(`out/` など)の全ページ(`atlas.html`・`insights.html`・`instructions.html`・`glossary.html`・`sessions/*.html`)を Chromium で開き、機械で分かる不備を洗い出します。目視のレビューで漏れやすい、ページをまたぐ食い違いや一部の幅・配色だけで起きる崩れを、毎回同じ基準で確かめるためのものです。

```
npm run audit:ui -- out --json audit.json --shots shots
```

- **構造(全ページ)**: id の重複、ページ内リンクと別ページへのリンクの行き先(ファイルと `#id`)、リンクの「版 N」と行き先の版番号の一致
- **文言(全ページ。atlas.html はタブを 1 つずつ押した状態も)**: `undefined`・`NaN`・`[object Object]`・テンプレートの `${…}`・二重に逃がした実体参照・HTML コメントの印の漏れ(`pre` / `code` の中の本文は除く)
- **アクセシビリティの基本(全ページ)**: `lang`、名前の無いリンクとボタン、`alt` の無い画像、ラベルの無い入力欄、見出しの段の飛び
- **押せそうで押せない要素(全ページ。atlas.html はタブを 1 つずつ押した状態、閉じた `details` と `aria-expanded="false"` のボタンを開いた状態、レイアウトの見本は 375 / 1024 / 1440px でも)**: 自分自身へのリンク(押しても同じ場所に留まるもの。`glossary.html#x` のようにファイル名付きで同じページを指すもの、見出し・語の欄の中のものも含む。節の先頭へ戻るリンクのように行き先が節や枠でほかの中身も持つものは除く)、指のカーソルが出るのにボタン・リンク・操作を受ける ARIA の役割のどれでもないもの(引き継いだ子は数えず、カーソルを付けた要素だけ)。目で確かめる側: ホバーで見た目が変わるのに操作できない要素(表の行の読み取り補助など意図したものもあるため)、下線があるのにリンクでない文字(包んだ要素に付けた下線も)、逆向きの、ボタンなど操作できるのに指のカーソルが出ない要素。「押すものが無い」ことを示すカーソル(矢印・既定・I 字・疑問符・無し)のものを挙げ、指摘の末尾に出ているカーソルの値を添えます。別の操作を示すカーソル(待ち・不可・つかむ・拡大・幅を変える・写すなど)は意図したものとして挙げません。字を打つ欄・選ぶ欄とそのラベル、使えない状態のもの(中の印が使えないラベルも)、部品の付いていないラベル、一覧・表・木・メニューの中の項目(option・gridcell・treeitem・menuitem。矢印が普通)も除きます。サーバが要る設定・別のフォルダのダイアログと 375px のタスクタグの一覧の中は、`npm run ui` の `ui/report.test.ts` が同じ検査(`clickableFindings`)で見ます
- **実行時(全ページ)**: ページ内の例外とコンソールのエラー
- **レイアウト(主要ページと詳細ページの見本 × 375 / 1024 / 1440px × ライト / ダーク)**: 横へのはみ出し、文字のコントラスト(WCAG 2.x)、切れた文字、キーボードで届かないスクロール領域、375px での小さい押す的。375px では字間を広げた状態でも横のはみ出しを確かめる(字の幅は OS のフォントで違い、Linux の CI でだけはみ出すことがあるため)

結果は「要修正」(終了コード 1)と「要確認」(目で確かめるもの)に分けて出ます。`--shots` を付けると主要ページの全体のスクリーンショットを幅・配色ごとに保存します。`npm run ui` の `ui/audit.test.ts` は、わざと不備を入れたページで各検査が必ず見つけること(陽性コントロール)と、架空の fixture の全ページに要修正が無いことを確かめます。数値の意味や言葉の分かりやすさは機械では測れないので、画面を変えたときは読み手の目での確認も続けて行います。

## CI(GitHub Actions)

- **CI**(`.github/workflows/ci.yml`): `main` への push と PR ごとに、Windows と Linux × Node.js 24 と 26 の 4 通りで `npm ci` → `typecheck` → `build:report` → `test`(`cargo test` と TS の単体テスト)→ `build:atlas` → `parity:fixture` → `e2e` → 画面の操作の検査 → clone した状態での動作確認を実行します。Rust はランナーの rustup で stable を入れ、crates.io の依存と `target/` を `Cargo.lock` ごとにキャッシュします。E2E はテスト時に生成する架空の fixture だけを使い(追加の手順は不要)、実データ(`ATLAS_LIVE`)や実際の LLM 判定は動かしません。Actions タブから手動でも実行できます。
  - 画面の操作の検査(`ui/`、Node.js 24 の 2 通りだけ): Playwright の Chromium で、一覧のチェックで集計し直す・タスクタグの作成 / 選択 / 名前と説明の編集 / 削除・詳細ページでのタスクタグの付け外しとメモ・アップロード・別のフォルダを開く(`ui/folders.test.ts`。開いた先の別のサーバまで)・戻る / 進む・サーバの止まり方・用語ページとの行き来を実際に押して確かめ、どの画面でもページ内の例外とコンソールのエラーが無いことを見ます。ブラウザの本体は Playwright の版ごとにキャッシュします。落ちたテストはその時点の画面を `out/ui-failures/<テスト名>.png` に残し(`ui/failure-shot.ts`)、CI では成果物 `ui-failures-<OS>` として 7 日間残します(Actions の実行結果の画面から落とせます)。
  - clone した状態での動作確認: clone した直後と同じ中身(`scripts/fresh-checkout.ts`。git archive HEAD だけで、`bin/` もレポートのテンプレートも入れない)を作り、起動用の `.bat` と同じ順で動かします(`scripts/checkout-smoke.ts`。`*.bat` と `ensure-atlas.ps1` が CRLF か → `scripts/ensure-atlas.ps1` が、リリースを探せない(origin が無い)のでこの PC でビルドするか(`npm ci` → `build:report` → `cargo build --release`)→ もう一度動かすと使い回すか → 初期設定(`atlas setup`)が書かずに終わるか → 架空の fixture で `atlas all` → プロジェクトを送る操作 → Windows では `upload-project.bat`・`schedule-upload.bat`・`setup.bat`・`open-folder.bat` を cmd で実際に起動する。Linux では `ensure-atlas.ps1` を pwsh で動かす)。ビルドはリポジトリの `target/` を使います(`CARGO_TARGET_DIR`。依存のクレートのビルドを使い回す)。手元では `npm run smoke` で同じことを試せます(`scripts/smoke-local.ts`。置き場はリポジトリの外の一時フォルダ(OS の一時フォルダの `atlas-ci-pkg-XXXXXX/`。回すたびに別の名前で、通ったら消し、落ちたら残す。中に作ると、入れ忘れた依存もリポジトリの `node_modules` から読めて見逃すため)。コミット済みの内容だけが入るので、コミットしていない変更があれば注意を出します)。
  - **push の前に手元で CI と同じ順に回す**: `npm run ci`(`typecheck` → `build:report` → `test` → `build:atlas` → `parity:fixture` → `e2e` → `ui` → `smoke`。最初に落ちたところで止まります)。画面の操作の検査には `npx playwright install chromium` が 1 回要ります。
  - 依存の脆弱性: `package.json` の `dependencies` に high 以上の警告があると止まります(`npm audit --omit=dev`。今は画面のビルドに使う `devDependencies` だけで、atlas の実行に npm の依存は要りません)。PR では、その PR で新しく入る・上がる `dependencies` も同じ基準で見ます(ジョブ `dependency-review`。`actions/dependency-review-action`)。`devDependencies` は止めず、Dependabot の PR で追います。
  - まとめのジョブ `ci-ok`: 上のジョブがどれか落ちたか取り消されたら落ちます。`main` のルール(リポジトリの Settings → Rules)で必須にするのはこれだけです(行列の組み合わせを変えても、必須チェックの名前を変えずに済むため)。`main` へは PR を通してだけ入れ、`ci-ok` が通るまでマージできません。
  - 外部の Action はコミット SHA で固定し、行末の `# v7.0.1` のような注記で版を示します(タグが付け替えられても中身が変わらないため)。更新は Dependabot が SHA と注記をまとめて行います。Rust は Action を使わず、ランナーに入っている rustup で入れます。
- **依存の更新**(`.github/dependabot.yml`): npm・Cargo・GitHub Actions の更新を週 1 回 PR で出します。npm と Cargo の minor / patch はそれぞれ 1 本にまとめ、major は個別の PR になります。どの PR も CI が通ってから取り込みます。公開されてすぐの版は取り込みません(`cooldown`。npm と Cargo は patch 3 日・minor 7 日・major 14 日、Actions は 7 日。乗っ取られた版が公開直後に見つかって取り下げられる間を待つため)。脆弱性の修正(セキュリティ更新)には `cooldown` が効かないので、すぐ PR になります。
- **リリース**(`.github/workflows/release.yml`): `v<version>` のタグを push すると、Windows のランナーで `npm ci` → `build:report` → `cargo build --release`(テンプレートが無ければ止める `ATLAS_REQUIRE_TEMPLATE=1`)で `atlas.exe` を作り、`atlas.exe.sha256` と一緒にそのタグの GitHub Release に付けます(`gh release`。書き込みの権限 `contents: write` はこのジョブだけ)。タグと `Cargo.toml` の `version` が違えば止めます。Actions の画面からタグを指定して作り直すこともできます(同じ名前のファイルは置き換えます)。利用者の起動用の `.bat` は、`scripts/ensure-atlas.ps1` でこれを取ってきます(README の「atlas.exe の用意と更新」)。

### リリースの手順

1. ワークスペースの `Cargo.toml` の `[workspace.package]` の `version` を上げ、`cargo build` で `Cargo.lock` も更新して、PR を通して `main` に入れる。
2. `main` のそのコミットに `v<version>` のタグを付けて push する(`git tag v0.2.0 && git push origin v0.2.0`)。
3. Actions の「Release」が通り、リリースに `atlas.exe` と `atlas.exe.sha256` が付いたことを確かめる。

`version` を上げたコミットが `main` に入ってからリリースが出るまでの間に `git pull` した利用者は、Node.js と Rust が無いと atlas.exe を用意できません(自動で送るタスクは前の版に戻して送り、次の回にもう一度試します)。`version` を上げたら、間を空けずにタグを push してください。
`version` を上げずに `main` を進めても、リリースから取ってきた利用者の `atlas.exe` は変わりません(この PC でビルドした人は、次に `.bat` を開いたときにビルドし直します)。利用者に届けたい変更は、`version` を上げてリリースします。

公開リポジトリなので標準ランナーの Actions は無料枠で動きます。

## 元データを書き換えないための仕組み

- `session-store.db` と各セッションの `session.db` は SQLite です(前者は WAL 付き)。デスクトップアプリの `data.db` は資格情報の列(`accounts.access_token` など)を含み、集計にも使わないので複製しません(以前のバージョンが `out/snapshot/` に残した複製は次の `snapshot` で消します)。元を直接開くと読み取り専用でも `-shm` が書き換わる(mtime が変わる)ため、本体と `-wal` をバイト列のままコピーし、コピー側から `VACUUM INTO` で単一ファイルにします。コピー中に元が更新されたら取り直します。
- `events.jsonl` / `workspace.yaml` はコピーしてから読みます。2 回目以降はサイズと更新時刻が同じファイルを再利用します。

## fixtures

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
