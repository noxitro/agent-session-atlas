# 開発

[README](../README.md) に戻る。

前提: Node.js 24 以上(`node:sqlite` と TypeScript の型除去を使うため。ネイティブ依存はありません)。

atlas はすべて TypeScript で、Node.js でそのまま動きます(ビルドの手順は画面のテンプレートだけです)。

- `packages/core`: 集計(snapshot → extract → vcs → metrics)と、画面とサーバーの両方が使う型と規則
- `packages/judge`: LLM の判定(評価バンドル・判定・取り込み・依頼ごとの判定・skill の下書き)
- `packages/cli`: コマンド(`main.ts`)と、起動用の `.bat` から動かす入口、ローカルサーバ(`serve.ts`)
- `packages/report`: ページを書く Node 側(`src/*.ts`)と、画面(`src/app/` の Svelte と、画面が使う `src/lib/`・`src/styles/`)。画面は Vite で `packages/report/dist/template.html` にまとめます

```
npm install
npm run atlas -- --help   # atlas を動かす(node packages/cli/src/main.ts)
npm run typecheck   # tsc + svelte-check(出力なし)
npm test            # 単体テスト(packages/*/test と scripts/*.test.ts)
npm run e2e         # E2E(テスト時に生成する架空の fixture のみ。生成は自動)
npx playwright install chromium   # 画面の操作の検査に使うブラウザ(初回だけ)
npm run ui          # 画面の操作の検査(ui/。架空の fixture で atlas serve を立て、Chromium で押して確かめる)
npm run audit:ui -- out   # 生成したレポートの全ページの網羅チェック(下記)
# 画面の操作の検査を、CI の遅い機械に近い速さで(Chromium の CPU を N 倍遅くする。待ちの切れ方を手元で再現したいとき)
ATLAS_UI_CPU_SLOWDOWN=20 npm run ui
npm run fixtures    # fixture(.fixtures/)を手で作り直す(中身を見たいとき。E2E は毎回自動で作り直す)
npm run build:report  # レポートのテンプレート(packages/report/dist/template.html)を作り直す(atlas build もソースが新しければ自動で作り直す)
```

e2e と画面のテストは、CLI を Node の入口(`packages/cli/src/<入口>.ts`)で別のプロセスとして動かし、サーバ(`serve.ts` の `startServe`)はテストのプロセスの中で動かします(`e2e/fixture-home.ts`)。

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

## 依存の検査

- **npm**: `node scripts/npm-audit.mjs` で見ます。`npm audit` を `devDependencies` も含めて回し、high 以上の advisory があれば止めます(終了コード 1。`npm audit` 自体が失敗したときや、下の除外の書き方が誤っているときは 2)。画面のビルドに使う `devDependencies`(Vite・Svelte など)の出力はレポートの HTML に入るので、`devDependencies` も止めます。push と PR の CI(ジョブ `check`)と毎週の検査で同じものを回すので、毎週の検査で止まるものは PR でも止まります。`node:` の標準モジュールだけで動き(`npm ci` は要りません。`npm audit` と同じく `package-lock.json` だけを読みます)、手元でも同じコマンドで回せます。`--omit=dev`(`dependencies` だけ)と `--audit-level=<low|moderate|high|critical>` も付けられます。
  - 除外(リポジトリ直下の `npm-audit-ignore.json`): 止めない advisory を、`id`(`GHSA-…`)・`package`(脆弱性のあるパッケージ名)・`reason`(止めない理由)・`removeWhen`(外す時)の 4 つで 1 件ずつ書きます。JSON にはコメントを書けないので、理由はこの欄に書きます。どれかが空なら書き方の誤りとして止めます。足してよいのは、修正版がまだ無く(`npm update` や Dependabot で上げられない)、脆弱なコードに届く経路が無いと確かめたものだけです(たとえば、ビルドとテストの道具の中だけで使われ、レポートの HTML にも atlas の実行にも入らないもの)。修正版が出たら上げて、除外を外します。
  - 除外に当たったものは、実行のたびに 1 行ずつ出します(Actions では `::warning::` の注記にもなり、実行結果の画面に残ります)。除外の行がどの advisory にも当たらなくなったら、外してよいと出します(止めはしません。Dependabot のセキュリティ更新の PR を落とさないため)。
  - 入れたものの署名(`npm audit signatures`): `npm ci` のあとに、入ったパッケージがレジストリの署名(と、あれば来歴の attestation)と合うかを見ます。PR と push の CI(ジョブ `check`)で回し、合わなければ止めます。
  - lockfile の中身(`scripts/lockfile.test.ts`。`npm test` で回ります): `npm audit` は既知の advisory しか見ないので、`package-lock.json` のすべてのパッケージが npm の公式レジストリ(`https://registry.npmjs.org/`)から名前と版に合う URL で取られること、`sha512` の整合性ハッシュを持つこと、インストール時のスクリプトを持つのは許したもの(今は macOS だけの任意の依存の `fsevents`)だけであることを確かめます。git や tarball の URL・ほかのレジストリの依存を足すと落ちます。
  - 手元では `npm run audit:deps` で、`node scripts/npm-audit.mjs` と `npm audit signatures` をまとめて回せます(`npm run ci` の最初にも入っています。`npm ci` のあとに回します)。
- **PR**: その PR で新しく入る・上がる `dependencies` も見ます(ジョブ `dependency-review`。`actions/dependency-review-action`。high 以上で止める)。
- **毎週**(`.github/workflows/deny-schedule.yml` のジョブ `npm-audit`): 新しい advisory はコードを変えなくても出るので、毎週月曜に `node scripts/npm-audit.mjs`(`devDependencies` も含む)を回します。Actions の画面から手動でも回せます。
- 落ちたら: 直せるものは依存を上げる PR を入れます(Dependabot の PR があればそれを取り込みます)。

## CI(GitHub Actions)

- **CI**(`.github/workflows/ci.yml`): `main` への push と PR ごとに、Windows と Linux × Node.js 24 と 26 の 4 通りで `npm ci` → `typecheck` → `test` → `build:report` を実行します(ジョブ `check`)。E2E(ジョブ `e2e`。Windows と Linux で、Node.js 24 と 26 を 1 つのジョブで続けて回す。24 で落ちても 26 も回す)・画面の操作の検査(ジョブ `ui`)・clone した状態での動作確認(ジョブ `smoke`。`ui` と `smoke` は Windows と Linux の Node.js 24)は、`check` と並べて別のジョブで回します(1 つのジョブで順に回すと待ち時間が和になるため)。文書だけ(`docs/` の下と `*.md`)を変えた PR では、この 4 つを飛ばします(ジョブ `changes`。`main` への push と手動の実行では全部回します)。マージの条件は、これらをまとめたジョブ `ci-ok` だけです。E2E はテスト時に生成する架空の fixture だけを使い(追加の手順は不要)、実データ(`ATLAS_LIVE`)や実際の LLM 判定は動かしません。Actions タブから手動でも実行できます。
  - 画面の操作の検査(`ui/`。ジョブ `ui`): Playwright の Chromium で、一覧のチェックで集計し直す・タスクタグの作成 / 選択 / 名前と説明の編集 / 削除・詳細ページでのタスクタグの付け外しとメモ・アップロード・別のフォルダを開く(`ui/folders.test.ts`。開いた先の別のサーバまで)・戻る / 進む・サーバの止まり方・用語ページとの行き来を実際に押して確かめ、どの画面でもページ内の例外とコンソールのエラーが無いことを見ます。ブラウザの本体は Playwright の版ごとにキャッシュします(保存は `main` だけ。PR ごとに保存すると、リポジトリのキャッシュの上限で `main` のものが追い出されるため)。落ちたテストはその時点の画面を `out/ui-failures/<テスト名>.png` に残し(`ui/failure-shot.ts`)、CI では成果物 `ui-failures-<OS>` として 7 日間残します(Actions の実行結果の画面から落とせます)。
  - clone した状態での動作確認(ジョブ `smoke`): clone した直後と同じ中身(`scripts/fresh-checkout.ts`。git archive HEAD だけで、`node_modules` もレポートのテンプレートも入れない)を作り、起動用の `.bat` と同じ順で動かします(`scripts/checkout-smoke.ts`。`*.bat` と `scripts/*.ps1` が CRLF か → 開くたびの更新(`launcher-update.ts`)が、git で取得したフォルダではないので何もせずに終わるか → 依存の判定 → `npm install` → 初期設定(`setup.ts`)が書かずに終わるか → 架空の fixture で `atlas all`(最初の実行でテンプレートを作るか)→ `atlas serve` が画面を配るか → プロジェクトを送る操作 → Windows では `*.bat` を cmd で実際に起動する。前の版の atlas.exe から移るときの入口 `scripts/ensure-atlas.ps1 -Check` も、依存の有無で答えが変わるかを見ます)。手元では `npm run smoke` で同じことを試せます(`scripts/smoke-local.ts`。置き場はリポジトリの外の一時フォルダ(OS の一時フォルダの `atlas-ci-pkg-XXXXXX/`。回すたびに別の名前で、通ったら消し、落ちたら残す。中に作ると、入れ忘れた依存もリポジトリの `node_modules` から読めて見逃すため)。コミット済みの内容だけが入るので、コミットしていない変更があれば注意を出します)。
  - **push の前に手元で CI と同じ順に回す**: `npm run ci`(`audit:deps` → `typecheck` → `test` → `build:report` → `e2e` → `ui` → `smoke`。最初に落ちたところで止まります)。画面の操作の検査には `npx playwright install chromium` が 1 回要ります。
  - 依存の脆弱性: 上の「[依存の検査](#依存の検査)」。
  - まとめのジョブ `ci-ok`: 上のジョブがどれか落ちたか取り消されたら落ちます。`main` のルール(リポジトリの Settings → Rules)で必須にするのはこれだけです(行列の組み合わせやジョブの分け方を変えても、必須チェックの名前を変えずに済むため)。`main` へは PR を通してだけ入れ、`ci-ok` が通るまでマージできません。
  - 外部の Action はコミット SHA で固定し、行末の `# v7.0.1` のような注記で版を示します(タグが付け替えられても中身が変わらないため)。更新は Dependabot が SHA と注記をまとめて行います。
- **依存の更新**(`.github/dependabot.yml`): npm と GitHub Actions の更新を週 1 回 PR で出します。npm の minor / patch は 1 本にまとめ、major は個別の PR になります。どの PR も CI が通ってから取り込みます。公開されてすぐの版は取り込みません(`cooldown`。npm は patch 3 日・minor 7 日・major 14 日、Actions は 7 日。乗っ取られた版が公開直後に見つかって取り下げられる間を待つため)。脆弱性の修正(セキュリティ更新)には `cooldown` が効かないので、すぐ PR になります。
- **配布**: zip や実行ファイルでの配布(GitHub Release)はしません。利用者はリポジトリを `git clone` して使い、起動用の `.bat` が開くたびに新しい版を取り込みます(README の「[新しい版への更新](../README.md#新しい版への更新)」)。

公開リポジトリなので標準ランナーの Actions は無料枠で動きます。

## Rust 版をやめた経緯

- 2026-11-14〜15 に、サーバー側(集計・`serve`・判定・CLI)を TypeScript から Rust に移し、1 つの実行ファイル `bin\atlas.exe` を GitHub Release で配っていました(画面は TypeScript のままで、実行ファイルに埋め込んでいました)。
- 2026-11-16 に取りやめ、Node.js 24 だけで動く今の形に戻しました。Rust のコード、リリースのワークフロー、Rust の依存の検査はリポジトリから消しました。
- 2026-11-17 に、Node に戻すかがまだ決まっていなかったので、いったん Rust 版に戻しました(#109)。2026-11-18 に Rust をやめることに決まり、もう一度 Node だけの形にしました。
- Rust に移していた間に足した機能(判定の変更、複製の削除、開くたびの更新、推論強度どうしの比較、VCS の残存の照合の追加分、失敗の台帳、テストの結果と課題 × 条件など)は、TS に移しました。
- Rust 版に戻していた 2026-11-17 の間に足した機能(送った atlas の版を人ごとに出す表示、llm-wiki の参照の数え方とページごとの参照率・役立った率、工数の判定の日時とモデル、`files/` と `rewind-file-snapshots/` を既定で写さない、`judge run --session`、スキル化の候補の振り分けの速さなど)も、TS に移しました。
- 前の版の `atlas.exe` を使っていた PC は、`scripts/ensure-atlas.ps1` を入口にこの版へ移ります(README の「[前の版(atlas.exe)から移るとき](../README.md#前の版atlasexeから移るとき)」)。

## 元データを書き換えないための仕組み

- `session-store.db` と各セッションの `session.db` は SQLite です(前者は WAL 付き)。デスクトップアプリの `data.db` は資格情報の列(`accounts.access_token` など)を含み、集計にも使わないので複製しません(以前のバージョンが `out/snapshot/` に残した複製は次の `snapshot` で消します)。元を直接開くと読み取り専用でも `-shm` が書き換わる(mtime が変わる)ため、本体と `-wal` をバイト列のままコピーし、コピー側から `VACUUM INTO` で単一ファイルにします。コピー中に元が更新されたら取り直します。
- `events.jsonl` / `workspace.yaml` はコピーしてから読みます。2 回目以降はサイズと更新時刻が同じファイルを再利用します。

## fixtures

**サンプルデータはリポジトリに置かず、テスト時に架空の値だけで生成します。実データは読みません。**

- 規則: fixtures に実データ(匿名化したものも含む)を使わない。セッション ID・ツール呼び出し ID・パス・時刻・本文はすべて作った値です(`00000000-0000-4000-8000-0000000000NN`、`call_synth_…`、`X:\synthetic-…` など)。
- 「課題 × 条件」の節の画面の検査(`ui/conditions.test.ts`)は、別の生成器 `scripts/synthetic-conditions.ts` で、課題 2 つ × 条件 3 つ × 3 回の架空のログ(テストの実行ファイルの印つきの行を含む)を作って集計します。~/.copilot の形(タスクタグは `groups.json`)と、送り先をまとめて集計する形(タスクタグは各セッションの `atlas-session.json`)の両方を書けます。中身を見たいときは `node scripts/synthetic-conditions.ts <フォルダ>`。
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

生成器を変えたら `.fixtures/fixture-counts.json` を見て、`e2e/phase1.test.ts` などの期待値を更新してください(期待値には根拠のコメントを付けています)。git の origin によるプロジェクトの統合・ホーム・インストール済みの skill は、`e2e/phase6.test.ts` が実行時に作る合成のリポジトリとフォルダで確かめます(一時フォルダは `--temp-dir` で合成の場所だけにするので、リポジトリを `%TEMP%` 配下に置いても通ります)。モード・推論強度・起点・文脈の内訳・待ち時間・ツールの所要時間・摩擦の詳細・todo(`session.db`)は、`e2e/phase7.test.ts` が実行時に足す合成セッション(`00…014`・`00…015`)と `session-store.db` の明細行で確かめます。既知のイベント種別は `packages/core/src/event-types.ts` にあり、ここに無い種別は未知種別として数えます(既知の種別だけで作った合成セッションに未知種別が出ないことを、`e2e/phase1.test.ts` で確かめます)。
