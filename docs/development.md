# 開発

[README](../README.md) に戻る。

前提: Node.js 24 以上(`node:sqlite` と TypeScript の型除去を使うため。ネイティブ依存はありません)。

```
npm install
npm run typecheck   # tsc + svelte-check(出力なし)
npm test            # 単体テスト(packages/*/test)
npm run e2e         # E2E(テスト時に生成する架空の fixture のみ。生成は自動)
npx playwright install chromium   # 画面の操作の検査に使うブラウザ(初回だけ)
npm run ui          # 画面の操作の検査(ui/。架空の fixture で atlas serve を立て、Chromium で押して確かめる)
npm run audit:ui -- out   # 生成したレポートの全ページの網羅チェック(下記)
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

## 全ページの網羅チェック(`npm run audit:ui`)

生成したレポート(`out/` など)の全ページ(`atlas.html`・`insights.html`・`instructions.html`・`glossary.html`・`sessions/*.html`)を Chromium で開き、機械で分かる不備を洗い出します。目視のレビューで漏れやすい、ページをまたぐ食い違いや一部の幅・配色だけで起きる崩れを、毎回同じ基準で確かめるためのものです。

```
npm run audit:ui -- out --json audit.json --shots shots
```

- **構造(全ページ)**: id の重複、ページ内リンクと別ページへのリンクの行き先(ファイルと `#id`)、リンクの「版 N」と行き先の版番号の一致
- **文言(全ページ。atlas.html はタブを 1 つずつ押した状態も)**: `undefined`・`NaN`・`[object Object]`・テンプレートの `${…}`・二重に逃がした実体参照・HTML コメントの印の漏れ(`pre` / `code` の中の本文は除く)
- **アクセシビリティの基本(全ページ)**: `lang`、名前の無いリンクとボタン、`alt` の無い画像、ラベルの無い入力欄、見出しの段の飛び
- **実行時(全ページ)**: ページ内の例外とコンソールのエラー
- **レイアウト(主要ページと詳細ページの見本 × 375 / 1024 / 1440px × ライト / ダーク)**: 横へのはみ出し、文字のコントラスト(WCAG 2.x)、切れた文字、キーボードで届かないスクロール領域、375px での小さい押す的。375px では字間を広げた状態でも横のはみ出しを確かめる(字の幅は OS のフォントで違い、Linux の CI でだけはみ出すことがあるため)

結果は「要修正」(終了コード 1)と「要確認」(目で確かめるもの)に分けて出ます。`--shots` を付けると主要ページの全体のスクリーンショットを幅・配色ごとに保存します。`npm run ui` の `ui/audit.test.ts` は、わざと不備を入れたページで各検査が必ず見つけること(陽性コントロール)と、架空の fixture の全ページに要修正が無いことを確かめます。数値の意味や言葉の分かりやすさは機械では測れないので、画面を変えたときは読み手の目での確認も続けて行います。

## CI / リリース(GitHub Actions)

- **CI**(`.github/workflows/ci.yml`): `main` への push と PR ごとに、Windows と Linux × Node.js 24 と 26 の 4 通りで `npm ci` → `typecheck` → `test` → `build:report` → `e2e` → 画面の操作の検査 → 配布物の動作確認を実行します。E2E はテスト時に生成する架空の fixture だけを使い(追加の手順は不要)、実データ(`ATLAS_LIVE`)や実際の LLM 判定は動かしません。Actions タブから手動でも実行できます。
  - 画面の操作の検査(`ui/report.test.ts`、Node.js 24 の 2 通りだけ): Playwright の Chromium で、一覧のチェックで集計し直す・グループの作成 / 選択 / 名前と説明の編集 / 削除・詳細ページでメモを書いて保存・用語ページとの行き来を実際に押して確かめ、どの画面でもページ内の例外とコンソールのエラーが無いことを見ます。
  - 配布物の動作確認: リリースと同じ中身(`scripts/pack-release.ts`)を作り、`atlas.bat` と同じ順で動かします(`scripts/release-smoke.ts`。`*.bat` が CRLF か → 依存の判定 → `npm install` → 初期設定(`setup.ts`)が書かずに終わるか → 架空の fixture で `atlas all`(セッション記録ができるか)→ 同梱テンプレートを作り直していないか)。手元では `npm run build:report` のあと次のように試せます(コミット済みの内容だけが入ります)。

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
