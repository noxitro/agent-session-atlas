# 開発

[README](../README.md) に戻る。

前提: Node.js 24 以上(画面の Svelte のビルドと、テスト・スクリプトで `node:sqlite` と TypeScript の型除去を使うため)と Rust(rustup の stable。`cargo`)。
Windows では、Rust の既定(MSVC 向け)のリンカーと、`rusqlite` が同梱する SQLite の C のコンパイルに、Visual Studio Build Tools の「C++ によるデスクトップ開発」(MSVC と Windows SDK。<https://visualstudio.microsoft.com/visual-cpp-build-tools/>)も要ります。
Visual Studio 本体に C++ のワークロードを入れてあれば、それで足ります。`scripts/ensure-atlas.ps1` は、ビルドの前に `vswhere.exe` で `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` を探し(無ければ PATH の `cl.exe` と `link.exe`)、無ければ入れるよう案内します。

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
cargo deny check    # Rust の依存の検査(下記「依存の検査」。cargo install cargo-deny --locked で入れておく)
# 従量課金の Anthropic API を直接呼ぶ判定(--backend anthropic)を入れたビルドとテスト(既定では入らない。下記)
cargo build --release -p atlas-cli --features anthropic-backend
cargo test --workspace --features atlas-cli/anthropic-backend
```

### 機能 anthropic-backend(従量課金の API を直接呼ぶ判定)

判定のバックエンド `anthropic`(`crates/atlas-judge/src/backends/anthropic.rs`。Anthropic Messages API を直接呼ぶ。従量課金)は、cargo の機能 `anthropic-backend`(`atlas-judge` の機能を `atlas-cli` が同じ名前で渡す)を付けたときだけ入ります。
HTTP と TLS のクライアント(`ureq`・`rustls`・`ring`・`webpki-roots` など)がこれだけのために要るので、既定のビルドとリリースの `atlas.exe`、`scripts/ensure-atlas.ps1` のこの PC でのビルドには入れません。
入れていないビルドでも `--backend anthropic` は引数として受け付け、`judge run` と `skill-draft` が、入っていないことと上のビルドの仕方を出して止まります(`atlas_judge::backends::ensure_backend_built`)。
テストは両方で回します(`cargo test --workspace` と、上の `--features` を付けたもの)。片方だけで動くテストは `#[cfg(feature = "anthropic-backend")]` で分けます。

### 依存の検査

- **Rust**: `cargo deny check`(設定はリポジトリ直下の `deny.toml`)。入れるのは `cargo install cargo-deny --locked`。見るのは次の 4 つです。
  - `advisories`: RustSec の既知の脆弱性(常に止める)・保守終了(unmaintained)・健全でない(unsound)・crates.io で取り下げられた版(yanked)。どれも止めます。直せるものは `cargo update -p <クレート>` で上げ、直せないものだけ `deny.toml` の `ignore` に理由と一緒に書きます。
  - `licenses`: MIT と両立する寛容なライセンスだけを許します(`deny.toml` の `allow`。Unicode のデータのライセンスなど、許した理由はそこに書いてあります)。新しい依存が別のライセンスなら、両立するか確かめてから足します。
  - `bans`: 同じクレートの版が複数あるのは警告だけ。版を `*` で指定した依存は止めます。
  - `sources`: crates.io 以外(ほかのレジストリ・git)からの依存は止めます。
  - 機能 `anthropic-backend` の依存も含めて見ます(`[graph] all-features = true`)。
- **npm**: push と PR の CI は `dependencies` だけを `npm audit --omit=dev --audit-level=high` で見ます(今は 0 件。atlas の実行に npm の依存は要りません)。画面のビルドに使う `devDependencies`(Vite・Svelte など。出力は `atlas.exe` に埋め込まれます)は、毎週の検査で high 以上なら落とします。
- **毎週**(`.github/workflows/deny-schedule.yml`): 新しい advisory はコードを変えなくても出るので、毎週月曜に `cargo deny check advisories` と `npm audit --audit-level=high`(`devDependencies` も含む)を回します。Actions の画面から手動でも回せます。CI・毎週の検査・リリースが入れる cargo-deny の版は、3 つのワークフロー(`ci.yml`・`deny-schedule.yml`・`release.yml`)の `CARGO_DENY_VERSION` で固定しています(Dependabot は上げないので、3 か所をそろえて手で上げます)。
- **リリースの前**(`.github/workflows/release.yml` のジョブ `audit`): `atlas.exe` を作る前に、ビルドするコミットで `cargo deny --locked check` と `npm audit --audit-level=high`(`devDependencies` も含む)を回し、落ちたらリリースを作りません。マージの後に出た advisory もここで止まります。止まったら、上の直し方で直す PR を入れます(配る中身が変わるので、そのマージでもう一度作ります)。直すまでの間、利用者は前のリリースの `atlas.exe` のまま使い続けます(自動の更新は、リリースの無いコミットには進みません)。

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
  - clone した状態での動作確認: clone した直後と同じ中身(`scripts/fresh-checkout.ts`。git archive HEAD だけで、`bin/` もレポートのテンプレートも入れない)を作り、起動用の `.bat` と同じ順で動かします(`scripts/checkout-smoke.ts`。`*.bat` と `ensure-atlas.ps1` が CRLF か → `scripts/ensure-atlas.ps1` が、リリースを探せない(origin が無い)のでこの PC でビルドするか(`npm ci` → `build:report` → `cargo build --release`)→ もう一度動かすと使い回すか → 初期設定(`atlas setup`)が書かずに終わるか → 架空の fixture で `atlas all` → プロジェクトを送る操作 → Windows では `upload-project.bat`・`schedule-upload.bat`・`setup.bat`・`open-folder.bat`・`stop.bat` を cmd で実際に起動する。Linux では `ensure-atlas.ps1` を pwsh で動かす)。ビルドはリポジトリの `target/` を使います(`CARGO_TARGET_DIR`。依存のクレートのビルドを使い回す)。手元では `npm run smoke` で同じことを試せます(`scripts/smoke-local.ts`。置き場はリポジトリの外の一時フォルダ(OS の一時フォルダの `atlas-ci-pkg-XXXXXX/`。回すたびに別の名前で、通ったら消し、落ちたら残す。中に作ると、入れ忘れた依存もリポジトリの `node_modules` から読めて見逃すため)。コミット済みの内容だけが入るので、コミットしていない変更があれば注意を出します)。
  - **push の前に手元で CI と同じ順に回す**: `npm run ci`(`typecheck` → `build:report` → `test` → `build:atlas` → `parity:fixture` → `e2e` → `ui` → `smoke`。最初に落ちたところで止まります)。画面の操作の検査には `npx playwright install chromium` が 1 回要ります。
  - 依存の脆弱性: Rust はジョブ `cargo-deny`(`cargo deny --locked check`。上の「依存の検査」)で見ます。npm は `package.json` の `dependencies` に high 以上の警告があると止まります(`npm audit --omit=dev`。今は画面のビルドに使う `devDependencies` だけで、atlas の実行に npm の依存は要りません)。PR では、その PR で新しく入る・上がる `dependencies` も同じ基準で見ます(ジョブ `dependency-review`。`actions/dependency-review-action`)。`devDependencies` は止めず、Dependabot の PR で追います。
  - まとめのジョブ `ci-ok`: 上のジョブがどれか落ちたか取り消されたら落ちます。`main` のルール(リポジトリの Settings → Rules)で必須にするのはこれだけです(行列の組み合わせを変えても、必須チェックの名前を変えずに済むため)。`main` へは PR を通してだけ入れ、`ci-ok` が通るまでマージできません。
  - 外部の Action はコミット SHA で固定し、行末の `# v7.0.1` のような注記で版を示します(タグが付け替えられても中身が変わらないため)。更新は Dependabot が SHA と注記をまとめて行います。Rust は Action を使わず、ランナーに入っている rustup で入れます。
- **依存の更新**(`.github/dependabot.yml`): npm・Cargo・GitHub Actions の更新を週 1 回 PR で出します。npm と Cargo の minor / patch はそれぞれ 1 本にまとめ、major は個別の PR になります。どの PR も CI が通ってから取り込みます。公開されてすぐの版は取り込みません(`cooldown`。npm と Cargo は patch 3 日・minor 7 日・major 14 日、Actions は 7 日。乗っ取られた版が公開直後に見つかって取り下げられる間を待つため)。脆弱性の修正(セキュリティ更新)には `cooldown` が効かないので、すぐ PR になります。
- **リリース**(`.github/workflows/release.yml`): `main` への push ごとに、いちばん新しいリリースのタグ(`v<x.y.z>` を版の順に並べたもの)から、配る `atlas.exe` に入るもの(`scripts/release-shipped.txt` の git の pathspec。`crates/`・`Cargo.toml`・`Cargo.lock`・`packages/report/`・`package.json`・`package-lock.json`・`tsconfig.json` から、`crates/*/tests/`・`crates/*/examples/`・`packages/report/test/` などを除いたもの。自動の更新も同じファイルを読む)が変わったかを見ます。変わっていれば、依存の脆弱性の検査(上の「依存の検査」の「リリースの前」。落ちたら作らない)を通してから、次の版(下記)の `atlas.exe` を Windows のランナーで `npm ci` → `build:report` → `cargo build --release`(テンプレートが無ければ止める `ATLAS_REQUIRE_TEMPLATE=1`、版は `ATLAS_VERSION=<次の版>`)で作り(既定の機能だけ。`anthropic-backend` は入れない)、`atlas --version` がその版を出すかを確かめてから、`atlas.exe.sha256` と一緒にリリース `v<次の版>` を作って付けます(`gh release create`。タグもこのとき、そのコミットに付きます。ファイルを上げてから公開するので、ファイルの無いリリースは見えません)。説明書・テスト・スクリプト・ワークフローだけのコミットでは、確かめてすぐ終わります。
  - 次の版: `Cargo.toml` の `[workspace.package]` の `version` のタグがまだ無く、いちばん新しいタグより大きければ、その版(minor や major を上げるとき)。そうでなければ、いちばん新しいタグのパッチ版を 1 つ上げたもの。タグがまだ 1 つも無ければ `Cargo.toml` の `version`。
  - 止めるとき: いちばん新しいタグにリリースが無い(Actions の画面からタグを指定して作り直すか、タグを消す)。次の版の名前のリリースがもう公開されているのに、別のコミットから作ろうとしたとき。前の実行が残した下書きのリリース(ファイルを上げている途中で止まった)は、消してから作り直します。いちばん新しいリリースのコミットを含まないコミット(古い実行のやり直し)からは作りません。
  - `atlas.exe` にはビルドの来歴(GitHub の artifact attestation。`actions/attest-build-provenance`)も付けます。書き込みの権限(`contents: write`、来歴の署名と保存の `id-token: write`・`attestations: write`)はビルドのジョブだけです。Actions の画面からタグを指定して作り直すこともできます(そのタグのコミットから、タグの版で作ります。同じ名前のファイルは置き換えます)。同時に動かすのは 1 本だけで(`concurrency`)、後から来たものは前のものがタグを付けた後に、そのタグと比べます。
  - 利用者の起動用の `.bat` は、開くたびに新しいコミットとタグを取り込み(`atlas self-update`)、`scripts/ensure-atlas.ps1` で今のコミットから辿れるいちばん新しいタグのリリースを取ってきます(README の「atlas.exe の用意と更新」)。

### リリースの手順

**`version` を上げる PR は要らない。配る中身が変わったマージごとにパッチ版が出る**:

1. ふつうに PR を通して `main` に入れる。タグは手で付けない。`atlas.exe` の中身が変わるマージなら、Actions の「Release」がそのコミットから次のパッチ版のリリースを作る(十数分)。`atlas.exe` と `atlas.exe.sha256` が付いたかは、後で見ればよい。来歴は `gh attestation verify atlas.exe --repo <owner>/<repo>` で確かめられる(README の「リリースの atlas.exe を自分で確かめる」)。
2. minor や major を上げたいときだけ、ワークスペースの `Cargo.toml` の `[workspace.package]` の `version` をその版(例 `0.2.0`)にし、`cargo build` で `Cargo.lock` も更新して、PR を通して入れる。次のリリースがその版になり、その後のパッチ版はそこから数える。`Cargo.toml` の `version` は、リリースの版と同じでなくてよい(この PC でのビルドと `cargo test` の `atlas --version` が出す版になる)。
3. 「Release」が落ちたら(依存の脆弱性の検査で止まったときも)、直す PR を入れる(配る中身を変える PR なら、そのマージでもう一度作る。次のマージでも、前のタグとの差で作る)か、Actions の画面からタグを指定して作り直す(タグまで付いていたとき)。

**マージは「Release」を待たない**: PR をマージしてよいかは、CI の `ci-ok` だけで決めます。「Release」はマージの後に動き、マージの条件にも、マージした後の作業の前提にもしません。
起動用の `.bat` と自動で送るタスクの更新は、配る中身が変わったのにリリースがまだ無いコミット(マージしてからリリースができるまでの間や、「Release」が落ちたままの間)には進まず、リリースのある手前のコミットまで取り込みます(`self_update.rs` の `pending_release`。前の版の `atlas.exe` で新しい版の `.bat` やスクリプトを動かさないように)。手で `git pull` して先に進んだ利用者は、前のタグのリリースの `atlas.exe` のまま開きます(`ensure-atlas.ps1` が取ってくるのは、今のコミットから辿れるいちばん新しいタグのリリース)。リリースができてタグが届くと(起動用の `.bat` と自動で送るタスクは、`git fetch --tags` でタグも取ってくる)、次に開いたときにその版にします。前のタグのリリースも取れない(初めて使う)ときは、Node.js と Rust があればこの PC でビルドし、無ければリリースを待つよう出して止まります(`.bat` は、今ある `bin\atlas.exe` があればそのまま開く `-KeepOlder`)。

公開リポジトリなので標準ランナーの Actions は無料枠で動きます。

## 元データを書き換えないための仕組み

- `session-store.db` と各セッションの `session.db` は SQLite です(前者は WAL 付き)。デスクトップアプリの `data.db` は資格情報の列(`accounts.access_token` など)を含み、集計にも使わないので複製しません(以前のバージョンが `out/snapshot/` に残した複製は次の `snapshot` で消します)。元を直接開くと読み取り専用でも `-shm` が書き換わる(mtime が変わる)ため、本体と `-wal` をバイト列のままコピーし、コピー側から `VACUUM INTO` で単一ファイルにします。コピー中に元が更新されたら取り直します。
- `events.jsonl` / `workspace.yaml` はコピーしてから読みます。2 回目以降はサイズと更新時刻が同じファイルを再利用します。

## fixtures

**サンプルデータはリポジトリに置かず、テスト時に架空の値だけで生成します。実データは読みません。**

- 規則: fixtures に実データ(匿名化したものも含む)を使わない。セッション ID・ツール呼び出し ID・パス・時刻・本文はすべて作った値です(`00000000-0000-4000-8000-0000000000NN`、`call_synth_…`、`X:\synthetic-…` など)。
- 推論強度どうしの比較の画面の検査(`ui/effort-compare.test.ts`)は、別の生成器 `scripts/synthetic-effort.ts` で、送り先をまとめて集計する形(利用者 3 人 × 4 週、週ごとに medium と xhigh を入れ替える)の架空のログを作って集計します。中身を見たいときは `node scripts/synthetic-effort.ts <フォルダ>` で書き出せます。
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
