# agent-session-atlas 実装計画

最終更新: 2026-10-31(Phase 8: セッション記録の Markdown 出力)

## 目的

GitHub Copilot(デスクトップ autopilot / CLI / SDK / VS Code)のセッションログから、

1. トークン使用量・コスト(premium request、nano AIU)
2. skills / agents / hooks の利用状況
3. 指示ファイル(AGENTS.md / CLAUDE.md / copilot-instructions.md)の注入状況
4. llm-wiki(設定で指定した vault)の参照状況
5. 摩擦指標(compaction、abort、ask_user、permission、error)

を**LLMなしで**抽出・集計し、単一HTMLで可視化する。さらに「各タスクを人手でやった場合の工数」を **LLM に推定させる**ための評価バンドルを出力し、外部 LLM(M365 Copilot 等)でもツール内バックエンド(`copilot -p` 等)でも同じ形式の判定結果 `judgments.json` を戻してレポートに合成する。

## データソース(2026-10-27 時点の形式)

ルートは `%USERPROFILE%\.copilot`。**読む前に必ずスクラッチへコピーする**。SQLite は `-wal` / `-shm` を同梱コピーするか、`node:sqlite` の読み取り専用接続から `VACUUM INTO` で複製する(実ファイルで動作確認済み。出力は journal_mode=delete の単一ファイルになる)。

| ソース | 内容 | 備考 |
|---|---|---|
| `session-state/<id>/workspace.yaml` | id, cwd, git_root, repository, branch, name, client_name, created/updated | セッションごとに 1 つ |
| `session-state/<id>/events.jsonl` | 全イベント(JSONL、1行1イベント、`type`/`data`/`id`/`timestamp`/`parentId`) | 1 本で数十 MB になることがある |
| `session-state/<id>/session.db` | todos / todo_deps / inbox_entries | WAL なし。優先度低 |
| `session-state/<id>/checkpoints/*.md` | 要約チェックポイント | 多数。`session-state` 全体は GB 単位になりうる |
| `session-store.db`(ルート、schema_version 8) | `sessions` `turns` `checkpoints` `session_files` `assistant_usage_events` `search_index`(FTS5) `forge_skill_proposals` | 本体 + WAL |
| `data.db`(ルート、デスクトップアプリ) | `projects` `workspaces` `sessions` `session_context_usage` 等 | 本体 + WAL。補助ソース、後回し |

### 索引の正典

`session-store.db.sessions` と `session-state/` ディレクトリは一部だけが重なり、どちらも他方を包含しない。**両者の和集合**をセッション一覧とし、出所(`sources: ["db","dir"]`)を記録する。

### トークンの正典

- `assistant_usage_events`(2026-07-08 以降): input/output/cache_read/cache_write/reasoning、`total_nano_aiu`、`request_multiplier`、`agent_id`、`parent_tool_call_id`、model、latency、`reasoning_effort`、`finish_reason`。
- `events.jsonl` の `session.usage_record`(Copilot 1.0.95 以降): ほぼ同内容 + `cost`(premium request)、`apiCallId`、`initiator`。
- 両者は一部だけが重なるので、**和集合**を「入力トークンあり」とする。両方ある場合は `assistant_usage_events` を優先し、`usage_record` は欠けた分を補う(同一リクエストの重複は timestamp と model と output_tokens の一致で除去)。
- それ以前のセッションでも、`session.shutdown.data.modelMetrics` にモデル別の累計(input/output/cache/reasoning)が残っているものがある。DB と両方あるセッションでほぼすべて完全一致したため(Phase 1 レビューで実測)、DB も usage_record も無いときは **`shutdown` を第 3 の出所**として採用する。
- それも無いセッションは `assistant.message.data.outputTokens` と `session.compaction_complete.preCompactionTokens`、`subagent.completed.totalTokens` しか無い。入力トークンは `null`(`source: partial`)とし、UI で「推計不可」を明示する。

### イベント種別(実データ由来)

`session.start` は全件 `version: 1`。npm グローバルの `@github/copilot@1.0.18` に同梱の `schemas/session-events.schema.json`(74 種別)は**古く**、実データにある `session.usage_record` `session.usage_checkpoint` `session.permissions_changed` `subagent.configured` `session.binary_asset` `model.*` `skill.*_ref` `session.canvas.*` 等を含まない。実際に動く 1.0.103 はスキーマファイルを同梱しない。

よって **実データで観測した種別名の一覧** をコード(`packages/core/src/event-types.ts`。件数などのデータは持たない)に持って正典とし、公式スキーマは `vendor/` に型の参考として置くだけにする。未知種別は捨てずに `unknown` として件数を数え、警告を出す。

分析に使う主な種別:

- トークン: `session.usage_record` `session.usage_checkpoint` `assistant.message`(`outputTokens`) `session.compaction_start/complete`
- ツール: `tool.execution_start/complete`(`toolName` `arguments` `turnId` `model`)
- skills: `tool.execution_start` の `toolName:"skill"`(`arguments.skill`)および `skill.invoked` `skill.invoked_ref` `skill.context_delivered_ref`。**両方の形を受ける**
- agents: `subagent.started/completed/failed/selected/configured`(`agentName` `totalTokens`)
- hooks: `hook.start/end`(`hookType` `input.toolName`)
- 指示ファイル: `system.message` 本文に AGENTS.md / CLAUDE.md / copilot-instructions.md が埋め込まれる。本文中の見出しやパスから「どのファイルが何文字注入されたか」を切り出す
- wiki: ツール引数に vault のパスを含むセッションと、system.message での言及がある。`view` で索引 → 個別ページの順に読んだか、`skill` の呼び出しかを区別する
- 摩擦: `abort` `session.error` `permission.requested/completed` `ask_user` ツール `session.mode_changed` `session.model_change`
- 構造: `user.message` `assistant.turn_start/end` `session.task_complete` `session.plan_changed` `session.resume` `session.shutdown`

## 方針決定(ユーザー確認済み)

1. 削減量は **LLM 推定**。外部 LLM(M365 Copilot など)向けにバンドルを出力し、ツール内でも `copilot -p`(Luna 等)で回せるようにする。
2. **全クライアント**(github/autopilot、github/cli、sdk、vscode-agent-host など)を対象にし、CLI と HTML の両方でフィルタできるようにする。
3. UI は **impeccable** を適用(`/impeccable init` 後に実装、`/impeccable audit` + web-design-guidelines をレビューゲートに含める)。データ可視化は dataviz skill の規約に従う。
4. **TypeScript / Node 24 / ESM**。SQLite は `node:sqlite`(ExperimentalWarning だけ `process.on('warning')` で抑制。FTS5 は動作確認済み)。問題が出たら better-sqlite3 に切替。
5. 実装は Opus のエージェント、レビューは Fable(オーケストレータ)。**各フェーズは E2E テスト合格をゲートに次へ進む**。

## アーキテクチャ

```
agent-session-atlas/
  package.json              npm workspaces, scripts: atlas / atlas:judge / test / e2e
  packages/core/            抽出(snapshot → parse → normalize)と集計(metrics)
  packages/cli/             atlas コマンド: snapshot | extract | metrics | bundle | judge | build | export | all
  packages/report/          Vite + Svelte 5 → dist/atlas.html(単一ファイル、集計+要約のみ埋め込み)、詳細ページ、セッション記録(transcript.ts)
  packages/judge/           評価バンドル生成、judgments.json スキーマ、バックエンド(copilot-cli / anthropic)
  fixtures/                 テスト用のコード(偽の copilot)だけ。サンプルデータは置かない
  scripts/                  fixture の生成器(架空の値だけ。テスト時に .fixtures/ へ書く。git 管理外)
  e2e/                      フェーズごとの E2E テスト(vitest)
  docs/                     PLAN.md
  out/                      生成物(git 管理外): snapshot/ sessions.json metrics.json bundle/ judgments.json atlas.html sessions/<id>.html sessions/<id>.md
  atlas.bat(Phase 14 から起動用の bat はこれ 1 つ。他の操作は serve の画面とコマンド)
  setup.bat(2026-11-08 から。初期設定: atlas.config.json の wikis と phases を対話で書く。集計はしない)
  README.md(日本語)
```

### データの流れ

1. `snapshot`: `~/.copilot` の必要部分を `out/snapshot/` へ複製(SQLite は VACUUM INTO、events.jsonl はコピー。`--since` で範囲を絞れる)。元を一切書かない。
2. `extract`: snapshot → `out/sessions.json`(セッション単位の正規化レコード。生イベントは含めず、集計に必要な派生値と、ドリルダウン用の時系列要約だけ)。
3. `metrics`: sessions.json → `out/metrics.json`(全体 / プロジェクト / クライアント / モデル / 期間別の集計)。
4. `bundle`: sessions.json → `out/bundle/sessions/<session>.md` + `manifest.json` + `INSTRUCTIONS.md` + `schema.json`(外部 LLM へ渡す評価パケット。ZIP は作らず、フォルダごと圧縮して渡す。依頼の記録が無いセッションは既定で除外。1 パケット 24,000 字以内に中略。Phase 3 で確定)。
5. `judge`: bundle → バックエンドで判定 → `out/judgments.json`。外部で判定した結果も同じファイルに取り込む(`judge import <file>`)。
6. `build`: metrics.json + sessions.json(要約)+ judgments.json → `out/atlas.html`。
7. `all`: 1→2→3→6(judge は別コマンド)。

### 正規化セッションレコード(sessions.json の 1 要素、要点)

- `id` `sources` `client` `cwd` `gitRoot` `repository` `branch` `name` `copilotVersion` `schemaVersion` `createdAt` `updatedAt` `durationMs`
- `turns`(ユーザーターン数) `assistantMessages` `firstUserMessage`(先頭 2000 字) `lastAssistantMessage`(末尾 2000 字)
- `tokens`: `{input, output, cacheRead, cacheWrite, reasoning, premiumRequests, nanoAiu, source: "db"|"events"|"db+events"|"shutdown"|"partial"|"none", byModel: {...}, byAgent: {...}}`
- `tools`: `{byName: {...}, total}`
- `skills`: `[{name, at, via: "tool"|"event"}]`
- `agents`: `[{name, startedAt, completedAt, status, totalTokens}]`
- `hooks`: `{byType: {...}, total}`
- `instructions`: `[{file, chars, firstSeenAt}]`
- `wiki`: `{indexReads, pageReads: [path...], skillCalls: [name...]}`
- `friction`: `{compactions, aborts, errors, permissionRequests, askUser, modelChanges, modeChanges}`
- `files`: `{changed: [...], created: [...]}`
- `timeline`: 粗い時系列(ターン境界・ツール群・agent・compaction)。ドリルダウン用。
- `unknownEventTypes`: `{type: count}`

### judgments.json スキーマ(要点)

```json
{
  "schemaVersion": 1,
  "judge": {"backend": "copilot-cli|opencode|anthropic|external", "model": "...", "ranAt": "..."},
  "items": [{
    "sessionId": "...",
    "taskCategory": "feature|bugfix|investigation|refactor|docs|ops|other",
    "taskSummary": "...",
    "humanEffort": {"hours": 3.5, "low": 2, "high": 6, "confidence": 0.6, "rationale": "..."},
    "aiOutcome": {"completed": true, "quality": 1-5, "rework": 0-5, "rationale": "..."},
    "instructionsEffect": {"score": -2..2, "evidence": "..."},
    "wikiEffect": {"score": -2..2, "evidence": "..."},
    "skillsAgentsEffect": {"score": -2..2, "evidence": "..."},
    "notes": "..."
  }]
}
```

Phase 3 での追加(互換): `items[].judge = {backend, model, ranAt}`(項目ごとの出所)、トップレベル `failures[]`(判定失敗。成功すると消える)、`judge.usage`(直近 run のトークン消費)。

### judge バックエンドの注意

- `copilot -p` は `--output-format json`(JSONL)+ `--stream off` + `--no-ask-user` + `-s`。`--allow-all-tools` は「非対話モードで必須」とヘルプにあるので、Phase 3 で空ディレクトリから 1 回実行して要否を確かめる。`--allow-all` と `COPILOT_ALLOW_ALL=true` は使わない。
- 2026-10-28 実走(CLI 1.0.103)で確認した出力の形: stdout は session.* / commands.changed / user.message / assistant.turn_start / model.call_start / model.call_failure / session.error / assistant.idle などのセッションイベントと同じ JSONL で、最終行が `{"type":"result","sessionId","exitCode","usage":{premiumRequests,totalApiDurationMs,sessionDurationMs,codeChanges}}`。stderr は空。`--usage-output-file` は `{totalPremiumRequestCost,totalUserRequests,totalNanoAiu,totalApiDurationMs,sessionStartTime,codeChanges,modelMetrics,agentMetrics,providerModelMetrics,lastCallInputTokens,lastCallOutputTokens}`。上記フラグの組み合わせは受理される(引数エラーなし)。
- 実走時は月間 AI クレジット超過で全モデル(sonnet-5.5 / haiku-5.5 / gpt-5.6-terra / mai-code-1.1-flash / auto)が `session.error {errorType:"quota", errorCode:"quota_exceeded", statusCode:402}` を返し、終了コード 1、消費 0。`gpt-5-mini` / `gpt-5.4-nano` は「not available」で stderr のみ。公式文書(copilot-requests)は超過後も「included models」が使えるとするが、新課金(AI クレジット)の環境では実測で使えなかった。判定の成功出力(assistant.message の形)は未確認のまま。
- **`--add-dir` は使わない**(そのディレクトリの `.github/skills` と `.github/agents` を信頼設定として読むため、他セッション本文を含むバンドルは注入の入口になる)。バンドルは本文埋め込みか stdin で渡す。
- `--usage-output-file <file>` で判定自体のトークン消費を記録する。
- 従量課金のバックエンド(Anthropic API)は明示指定時のみ。

### HTML の方針

- 埋め込むのは metrics.json と sessions.json の要約のみ。**生イベントは埋め込まない**。
- `file://` で動く(fetch 不可)。セッション詳細は `out/sessions/<id>.html` を別生成して相対リンク。
- フィルタ: プロジェクト、期間、クライアント、モデル、ブランチ、タスク分類(judgments があれば)、入力トークン記録の有無。
- ライト/ダーク両対応、グラフはインライン SVG。

## フェーズと E2E ゲート

各フェーズは「Opus 実装 → Fable レビュー(コード読み + E2E 実行)→ 合格で次へ」。不合格は差し戻し。

### Phase 1: 骨組み + core

- workspaces、TypeScript、vitest。`packages/core` の snapshot / parse / normalize / metrics。(lint 設定は Phase 4 に送る。`vendor/` の公式スキーマは古く参考価値が薄いので置かない)
- fixture: サンプルデータはリポジトリに置かず、テスト時に架空の値だけで生成する(`scripts/synthetic-fixtures.ts` → `.fixtures/`、E2E の globalSetup が毎回作り直す)。実データは読まない。
  - 規則: fixtures に実データ(匿名化したものも含む)を使わない。
- E2E(`e2e/phase1.test.ts`):
  - fixtures から sessions.json を生成し、件数(ツール別、skill、agent、hook、compaction)がフィクスチャ内の手計算値と一致する。
  - 実 `~/.copilot` に対して snapshot → extract → metrics が完走し(`ATLAS_LIVE=1` のときだけ)、セッション数が「DB ∪ ディレクトリ」の件数と一致する。
  - 未知イベント種別が `unknownEventTypes` に計上され、落ちない。
  - 元ディレクトリのファイルの mtime が実行前後で変わらない(読み取り専用の保証)。

### Phase 2: cli + report

- `/impeccable init` を先に実行(init 前にコミットして差分を確認)。
- `packages/cli` と `packages/report`。`atlas all` で `out/atlas.html` が出る。
- E2E(`e2e/phase2.test.ts`):
  - fixtures から HTML を生成し、サイズが 5MB 未満、外部参照(CDN、fetch)が無い。
  - 組み込みブラウザで開いてフィルタ操作が効く(セッション数表示が絞り込みで変わる)。
  - 実データで生成した HTML を開き、プロジェクト別タブが出る(`ATLAS_LIVE=1`)。
  - `/impeccable audit` と web-design-guidelines の指摘で重大なものが無い。

### Phase 3: judge

- bundle 生成、judgments スキーマ検証、`judge import`、バックエンド(copilot-cli を既定)。
- E2E(`e2e/phase3.test.ts`):
  - fixtures から bundle を生成し、manifest と各 md の必須セクションが揃う。
  - 手書きの judgments サンプルを import してレポートに「推定人手工数 vs AI 投入量」が出る。
  - `copilot -p` の 1 回実行(ユーザー許可後、`ATLAS_LIVE_JUDGE=1`)で JSONL の最終行から judgments を取り出せる。→ 2026-10-28 に 3 件実走したがクレジット超過(402)で成功例は得られず。同日、opencode バックエンド(`openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`)で同じ 3 件が成功(3/3、スキーマ検証通過、`text` / `step_finish` の既存パーサで取り出せた。opencode の既定モデル muse-spark は提供終了で UnknownError、OpenCode Zen 系は API キー期限切れ)。レポートの判定パネルと詳細ページへの合成を実データで確認。

### Phase 4: 仕上げ

- 日本語 README(目的・起動・使い方・判定の回し方)、`atlas.bat` / `atlas-judge.bat`、最終 `/impeccable audit`。

## 改善フェーズ(2026-10-28 のレビュー反映)

実データのレポートをレビューした結果(2026-10-28)、(1) 空セッションのノイズ、(2) 「何を使ったか」の内訳が無い、(3) 新しいログ形式への追従漏れ、の 3 点で振り返りツールとしての価値が落ちていた。以下の 3 フェーズで直す。進め方は Phase 1〜4 と同じ(Opus 実装 → Fable レビュー + E2E 合格で次へ)。各フェーズで README の該当箇所も同じ変更で更新する。

共通の制約: 元の `~/.copilot` は書かない(mtime 不変の E2E を維持)。HTML は 5MB 未満・外部参照なし。`--anonymize` で新しく出す固有名(MCP サーバー名を除くパス・リポジトリ名・ファイル名)も伏せる。fixture に新しい記録形式を足すときは生成器に架空の値で足す(実データ・匿名化した実データは使わない)。

### Phase 5: 正しさとノイズ(P0)

実測した問題と直し方:

1. **空セッション**(依頼 0・ツール 0・応答 0)が全体の大半を占める。レコードに `empty: boolean` を持たせ、レポートの絞り込みに「空のセッションを含める」(既定オフ、URL の `#` に残す)を足す。既定の集計・一覧・プロジェクト表・中央値はすべて空を除いた値にし、全体サマリに「空のセッション N 件を除外」と出す。`metrics.json` は空を除いた集計と、空の件数を持つ。
2. **モデル名の表記揺れ**: `claude-haiku-5-5` と `claude-haiku-5.5` などが別モデルになる。`claude-<family>-<major>-<minor>`(minor が 1 桁、末尾に日付等が続かない)を `<major>.<minor>` に正規化し、`models` を重複除去する。usage_record の `modelDisplayName` 由来の `<UUID>/` 接頭辞も外す(同一リクエストに `model` と両方残るのを実測、Phase 5 で追加)。正規化前の名前は捨てる(どの出所も同じモデルを指すため)。
3. **内部ツールの混入**: `report_intent` がツール数に入る。内部ツールの一覧を定数で持ち(少なくとも `report_intent`)、`tools.byName` / `total` から外して `tools.internal` に別計上する。
4. **摩擦の「エラー」表記**: 全体サマリの「エラー」はツール失敗と session.error の合計になっている。「ツール失敗」と「エラー」を分けて表示する。
5. **変更ファイルの二重計上**: 相対パスと絶対パスで同じファイルが 2 回載る。cwd 基準で絶対パスに解決し、Windows では大文字小文字を無視して重複除去する。`~/.copilot/session-state/` 配下(plan.md 等)は変更ファイルから外し、件数だけ別に持つ。
6. **新形式への追従**(実データで確認):
   - `session.workspace_file_changed` は 2026-07-09 以降出ない。`tool.execution_complete.data.fileEdits[]`(`path`, `kind`: edit/create/delete)を読み、`files.deleted` を新設する。両方ある場合は重複除去。
   - `user.message` の `isAutopilotContinuation: true` はユーザーのターンに数えず、`autopilotContinuations` に別計上する。
   - subagent の `assistant.message` で `data.parentToolCallId` が無くトップレベルの `agentId` だけを持つものを本体の応答として数えない(`assistantMessages` と `lastAssistantMessage`)。
   - `assistant.message.outputTokens` は 2026-08-31 以降出ない。出力トークンの出所ごとの件数を月別に数え、DB・usage_record・shutdown・outputTokens のいずれも無い非空セッションの件数を `metrics.json` と全体サマリの「入力トークン記録の内訳」に出す(黙って 0 にしない)。
7. **クライアント不明のセッション**: 原因(workspace.yaml の無い DB だけのセッション等)を調べ、`session-store.db.sessions.host_type` 等から決められるなら埋める。決められないものは「不明」のまま理由を README に書く。

E2E(`e2e/phase5.test.ts`): fixture に上の各形式(空セッション、`-5-5` 形式のモデル名、`report_intent`、相対・絶対の重複パス、`fileEdits[]` の削除、`isAutopilotContinuation`、agentId だけの subagent 応答)を合成して足し、件数が手計算値と一致する。既存の phase1〜3 の E2E が通る(期待値の変更は理由を添えて)。`ATLAS_LIVE=1` で実データの空セッション数・正規化後のモデル数・除去した内部ツール件数をログに出す。

### Phase 6: 利用の内訳と成果量(P1)

1. **利用ランキング欄**(トップページ、絞り込みに追従): ツール(MCP ツールは `tool.execution_start.data.mcpServerName` でサーバー別にまとめる)、skill(`skill.invoked.data.trigger` で自動/手動を区別)、agent(回数・失敗・トークン)、hook(種別)、指示ファイル(ファイル別のセッション数)。上位 N 件 + 「全件を表で見る」。
2. **インストール済みとの突き合わせ**: `~/.copilot/skills/` のディレクトリ名と `installed-plugins/` のプラグイン名、`settings.json` の `disabledSkills` を snapshot で名前だけ記録し(中身は読まない)、「インストール済みだが期間内に未使用の skill」を出す。
3. **変更行数**: `session.shutdown.data.codeChanges.linesAdded/linesRemoved` と、`tool.execution_complete` の `toolTelemetry.metrics.linesAdded/linesRemoved`。shutdown を優先し、無ければツール側の合計。全体・プロジェクト・セッションに出す。
4. **ツール別の成功率**: `tool.execution_complete.data.success` と `error.code`(failure / denied 等)で、ツール別に成功・失敗・拒否を数える。ランキング欄に失敗率を並べる。
5. **プロジェクトの統合**: `repository` が無いとき、`gitRoot` の `.git/config` から origin の URL を読んで `owner/repo` を得る(worktree は `.git` ファイル → gitdir → commondir を辿る)。読み取りのみ。読めない・リモート無しはパスのまま。ホーム直下と一時フォルダ(`%TEMP%`、scratchpad)は「(ホーム)」「(一時フォルダ)」にまとめる。
6. **AI 使用量の表示**: nano AIU は 10^9 で割った AIU で表示し(桁区切り、単位の説明を用語集に)、金額には換算しない。premium request を全体サマリと月別推移に戻す(記録のあるセッションだけの合計と明記)。

E2E(`e2e/phase6.test.ts`): fixture でランキング・成功率・行数・未使用 skill・プロジェクト統合(合成の `.git/config` と worktree)の値が手計算と一致し、HTML に欄が出る。`--anonymize` でリポジトリ名・パス・ファイル名が出ない。HTML 5MB 未満。組み込みブラウザで絞り込みに追従することをオーケストレータが確認。

### Phase 7: 実行の性質と要点(P2)

1. **モードと推論強度**: `session.start` / `session.mode_changed` / `user.message.agentMode` からモード(interactive / plan / autopilot)別のターン数、`reasoningEffort`(session.start・model_change・usage_record・DB の `reasoning_effort`)別のリクエスト数・トークン・AIU。
2. **リクエストの起点**: DB / usage_record の `initiator`(user / agent / sub-agent / compaction)の比率。
3. **文脈の内訳**: shutdown / compaction の `systemTokens` / `conversationTokens` / `toolDefinitionsTokens` と usage の `availableToolCount` から、ツール定義が常時占める量をセッション・プロジェクト別に。
4. **待ち時間**: DB の `time_to_first_token_ms` / `duration_ms` と usage_record の同等値から、モデル別の中央値と p90。
5. **ツールの所要時間**: start → complete を `toolCallId` で対応付け、ツール別の中央値と p90(1 時間超は外れ値として除外し件数を出す)。
6. **摩擦の詳細**: permission の結果(承認 / 拒否)、session.error の種別(quota / rate_limit 等)、subagent 失敗の理由、compaction 自体のトークン。
7. **todo**: `session-state/<id>/session.db` を snapshot に含め(VACUUM INTO)、todo の状態別件数と完了率。
8. **要点欄**: 上の集計から機械的に出す短い一覧(コストの大きいセッション上位、失敗率の高いツール、compaction の多いセッション、未使用の skill)。各項目は根拠のセッション / 絞り込みへのリンクを持つ。LLM は使わない。

E2E(`e2e/phase7.test.ts`): fixture で各集計が手計算と一致し、todo が snapshot から読める。元ファイルの mtime 不変。HTML 5MB 未満。`/impeccable audit` と web-design-guidelines で重大な指摘が無い(Phase 5〜7 の UI 変更をまとめて)。

### Phase 8: セッション記録の Markdown 出力(2026-10-31)

動機: (1) レポートからセッションの経過そのものを読みたい、(2) セッション画面から `.md` を出して共有したい(agent-toolkit の `/export-usage` と同じ用途)、(3) ボトルネック分析に必要な情報を 1 ファイルにして LLM に渡したい。

調べた結果、分析に必要な情報は events.jsonl(依頼・応答・ツールの引数と結果・時刻・compaction・権限・エラー・サブエージェント)と session-store.db(リクエスト単位のトークン・AIU・待ち時間・役)で揃っており、atlas は既に両方を読んでいる。足りないのは出力の形だけ。記録に無いのは、モデルの推論過程の多く(opaque)と Copilot の外で人がしていたこと。

実装:

1. `packages/report/src/transcript.ts`: 1 セッション → Markdown。概要、役 × モデルの消費(mergeUsage の明細から、TTFT と全体の中央値 / p90)、ツールの内訳、経過(相対時刻、依頼・応答・ツール 1 行・サブエージェント `[agent:名前]`・compaction・権限・エラー・中断・モード / モデル変更・終了、5 分以上の空白は「待ち」、依頼ごとの本体の消費 1 行)、変更ファイル、秘密情報の検査、分析の観点(定型)。
2. `atlas export`(= `build` + 記録)。`--tool-output fail|all|none`(既定 fail)、`--max-chars`。`build` の `sessions/` 削除に乗るので、素の `build` では `.md` も詳細ページのリンクも消える(古い記録を残さない)。
3. 詳細ページの上部に「セッション記録(Markdown)を開く / 保存」(`.md` があるときだけ)。
4. 秘密情報は形式(GitHub / OpenAI・Anthropic / AWS / Slack / Google のキー、秘密鍵、JWT、Bearer)で見つけて `[伏せました: 種類]` に置き換え、件数を出す(元の記録は書き換えない)。
5. 伏せ字モードでは本文に scrub(仮名・`<path>`)を掛け、ファイル一覧を出さず、先頭に「自由記述の固有名は機械的に保証できない」注意を書く。
6. `atlas-export.bat`。

決めたこと: HTML に本文を埋め込まない(5MB と file:// の制約。実データの events.jsonl は 202 本で 538MB)。`.md` の生成は `build` の既定にしない(容量と時間が増えるため別コマンド。2026-11-03 に `all` は記録を作るよう改めた。下の「`all` でもセッション記録を作る」)。ブラウザ側でのファイル生成はしない(埋め込みが要るため)。

E2E(`e2e/phase2.test.ts` g): fixture で全セッションに `.md` ができ、詳細ページからリンクされ、本体とサブエージェントの役 × モデルの表と依頼ごとの消費が出る。`--tool-output none` で結果の囲みが無い。`--anonymize` で fixture の固有名が出ない。素の `build` で `.md` とリンクが消える。単体(`packages/report/test/transcript.test.ts`): 架空のイベント列で経過・消費・待ち・秘密情報の伏せ字・内部ツールの除外・上限の中略・抜粋のみの形。

### Phase 9: UI/UX の磨き込み(2026-11-01)

動機: 技術カンファレンスで見せられる水準にする。`/impeccable critique`(デザインレビューと検出器を別のサブエージェントで)、`/impeccable audit`(a11y・性能・テーマ・レスポンシブ・実装整合)、web-design-guidelines の照合を実データのレポートに掛け、指摘を「設計契約(官公庁の帳票)を守ったまま直せるもの」と「契約の変更が要るもの」に分けた。前者だけを直した。critique のヒューリスティック合計は 27/40、audit は 16/20 で、P0 2 件・P1 4 件が出た(スナップショットは `.impeccable/critique/`。実データの件数を含むためコミットしない)。

直したこと(契約内):

1. **第一画面に「全体」が入らない(P0)**: 固定表示の絞り込み行が 3 段に折り返していた。1 行目を期間・プロジェクト・クライアント・モデルだけにし、ブランチ・入力トークン記録・タスク分類・空のセッションは「その他の条件」に畳んだ(効いている条件があるときは閉じられず、件数の印を出す)。日付入力と select の幅も詰めた。
2. **母数の二重表示(P0)**: マストヘッド「全 N セッション(うち空 K)」と絞り込み行「表示中 / 全 M」で N ≠ M だった。マストヘッドを「記録 N 件のうち M 件を集計対象にしています(空のセッション K 件を除外)」の 1 文にし、絞り込み行を「表示中 / 集計対象 M」に揃えた。
3. **要点が画面下(P1)**: 全体サマリを 16 欄(4 × 4)に揃えて注記を 1 行程度に短くし、摩擦の内訳の続きは「実行の性質」へのリンクにした。さらにユーザーの判断(2026-11-01)で設計契約の FIRST VIEWPORT を変更し、帳票の「表紙 → 摘要 → 明細」の順にした: 全体サマリ(表紙 4 欄: セッション・期間・実働・推定人手工数)→ 要点 → 集計明細(残り 12 欄と入力トークン記録の内訳・欠測語の凡例)。`Overview.svelte` は `part="cover" | "detail"` で 2 回描く。surface brief(`packages/report/.impeccable/surfaces/`)の STORY / FIRST VIEWPORT も更新。
4. **欠測の語 5 種に凡例が無い(P1)**: 内訳帯の下と用語ページの先頭に「記録なし / 推計不可 / 未判定 / 不明 / —」の凡例を置き、プロジェクト表の「なし」は「0/N」に統一した。欠測の帯片は色に加えて斜線にした。
5. **入力部品の枝線が 3:1 未満(P1、WCAG 1.4.11)**: `--control` トークンを足し(ライト #6f7f77、ダーク #7a8c84)、select・date・chip・seg・tag の枝に使う。罫線用の `--rule-strong` は表に限定。ダークの `--rule` / `--rule-strong` も少し明るくし、欄の境界が見えるようにした。
6. **角丸なし契約の違反 6 箇所(P2)**: 帯片・凡例の色見本・棒グラフ 3 箇所・月別推移の棒(パス → rect)・詳細ページの棒を全て角丸なしに。月別推移のツールチップの影も罫に替えた。
7. **月別推移の棒の `role="button"` に動作が無い(P2)**: 押すと値の表示を固定する(Enter / Space 対応、`aria-pressed`)ようにして、ロールを本物にした。
8. **title 属性だけが持つ情報(P2)**: プロジェクト表の摩擦の内訳を可視の小字(多い順 3 つ)に、タスク分類が選べない理由を欄の下の文に、select の option の title は廃止。
9. **詳細ページ上部のリンク群(P2)**: `nav` に組み直し、左「レポート(セッション一覧)に戻る」、右「セッション記録(Markdown)を開く / 記録を .md で保存 / 用語の説明」。セッション ID は表題下の印の列の末尾に降格。skills 表も横スクロールで包んだ。
10. **横スクロールの手掛かり(P2)**: `.table-scroll` に、続きがある側だけ影が出る背景(local attachment)を付けた。
11. **検出器の tiny-text 27 件**: 11px の本文(`.sub` `.part` `.foot` `.basis` `.src`)を 12px に。行長超過は `.section-head p` と マストヘッドの副題に max-width。
12. 細部: `.sr-only` と `.btn` を base.css に 1 つに、詳細・用語ページの共通 CSS(`.top` `.crumb` `.title` `.page-foot`)も base.css へ、`body` の文字サイズを rem に、フッターを `main` の外へ、0 件の `role="status"` を常設に、FilterBar の each をキー付きに、プロジェクト名を `<a href="#project=…">` に(別タブで開ける)、欄グリッドの最終行が埋まらなくても枠が閉じるように(`.field` の罫を枠線に 1px 重ねる)。

採らなかった案・判断を仰ぐもの(契約の変更が要る、または費用対効果が低い):

- 絞り込み行の固定表示を外し、表示中の件数だけを固定する案。
- `.seg` の押下状態(緑ベタ)を帳票らしい印(✓ や下線)に替える案(識別性が落ちる)。
- 伏せ字ビルドの要点を「セッション名」ではなく「規模の分布」の文に変える案。伏せ字の仮名を辞書順ではなくセッション数順(project-01 が最大)に振る案(単体テスト 5 箇所の期待値と README の記述が変わる)。
- 詳細ページから戻ると絞り込みが消える点(`file://` では referrer が無く、`history.back()` 相当のスクリプトを静的ページに足す必要がある)。
- 日付入力が Tab を 3 打ずつ消費する点(ブラウザの `<input type="date">` の仕様。置き換えは契約外)。
- 用語ページを別ファイルにしたままにする(HTML 1 枚だけ渡されるとリンク切れ。共有時は `glossary.html` も渡す運用で対応)。

残した P2 以下: `.seg` が `role="group"` + `aria-pressed` で「何番目か」を伝えない(tablist 化は未実施)、モバイルのセッション一覧は 13 列の横スクロールのまま(モデル列を 1 行に省略)、theme-color が手動のダーク切り替えに追従しない、`blockquote.msg` のスクロール領域が Safari でフォーカスできない。

#### 追記(2026-11-01 午後): 用語ページの目次と「並べているだけで探せない」箇所の再点検

ユーザーの指摘: 用語ページの目次が 33 項目のリンクの塊(3 行)で、分類も走査の起点も無く、本文が 1 画面に 4 件しか見えないのに目次が上部を占めていた。

直したこと(契約内):

13. **用語の分類**: `glossary.ts` の各項目に `group` を足し、5 分類(消費の単位 6 / 時間と待ち 3 / 記録の由来と欠測 6 / 動かし方と拡張の仕組み 11 / 工数と判定 7)にした。`GLOSSARY_GROUPS` に分類の題と 1 行の説明を持つ。用語ページは分類ごとの `section.group`(h2、id は `g-<分類>`)で区切り、目次は分類 5 項目だけ。960px 以上では左に固定(sticky)した側面目次 + 右に本文の 2 段で、読んでいる分類に `aria-current` の印(短いインラインスクリプト。スクロールごとに rAF で 1 回、見出しが画面上部 1/3 を越えた最後の節)。狭い画面では分類の行(44px の枠)だけ。欠測の語の凡例は「記録の由来と欠測」の冒頭に寄せた(先頭に置くと目次より前に 5 行を占めるため)。用語ごとの id(`glossary.html#<id>`)は変えていない。
14. **詳細ページの節の目次**: 11〜12 の節が並ぶだけだったので、表題の下に「ページ内の移動」(atlas.html と同じ形)を付けた。`section()` が描いた節の見出しを集めて描く。
15. **「実行の性質」の内訳の目次**: 8 つの小見出し(モード別・推論強度別・起点・文脈の内訳・待ち時間・所要時間・摩擦の詳細・todo)が並ぶだけだったので、節の頭に内訳のリンク行を置き、h3 に id を付けた。
16. 細部: ページ内リンクを滑らかにした(`scroll-behavior: smooth`、動きを減らす設定では即時)。詳細ページの長いパスの印(`.tag`)が狭い画面で枠からはみ出していたのを折り返すようにした。

見直したが直さなかった箇所: 集計明細の 12 欄は 4 × 3 の行がそれぞれトークン / 課金と呼び出し / 作業の量で揃っており、行の見出しを足すほどの密度差は無い。利用ランキングは切り替えで分かれている。マストヘッドの目次 11 項目は 1 行に収まる。

ui-ux-pro-max(`~/.agents/skills/ui-ux-pro-max`、`scripts/search.py --domain ux`、出典 `data/ux-guidelines.csv`。`--stack svelte` は `data/stacks/svelte.csv`)で照合した規則。設計契約(impeccable の surface brief)を優先し、この skill は汎用規則のチェックリストとしてだけ使った(`--design-system` と `--persist` は使っていない):

| 観点(検索語) | 該当した規則(Category / Issue) | 採否 |
|---|---|---|
| 用語ページの目次(table of contents navigation grouping / sticky sidebar navigation anchor links) | Navigation / Smooth Scroll | 採用: `html { scroll-behavior: smooth }`(reduced-motion では無効) |
| 同上 | Navigation / Sticky Navigation(固定要素が本文を隠さない) | 採用済み: 用語ページは固定ヘッダーが無く `scroll-margin-top: 12px`。atlas.html はフィルタ行の高さを `--filterbar-h` で補正済み |
| 同上 | Accessibility / Keyboard Navigation、Skip Links | 採用済み: 目次は普通のリンク、atlas.html に「本文へ移動」。用語・詳細ページは上部のリンクが 1〜4 個なので skip link は足していない |
| 同上 | Navigation / Breadcrumbs(3 階層以上で使う) | 採らない: 2 階層(レポート → 詳細 / 用語)なので「← 戻る」の 1 リンクのまま |
| 同上 | Navigation / Active State(現在位置を示す) | 採用: 側面目次に `aria-current` の印(左の 3px 罫 + 太字) |
| 詳細ページの nav(breadcrumb back link page header navigation) | Navigation / Back Button(履歴を壊さない) | 採用済み: 「← レポートに戻る」は普通の `<a>`。絞り込みの保持は契約変更の項(下)に残す |
| 同上 | Navigation / Active State | 採用: 詳細ページには該当しない(節の目次は印なし。1 ページ内のスクロールだけなので) |
| フィルタ行(filter bar controls sticky) | Navigation / Sticky Navigation | 採用済み(`--filterbar-h`) |
| 同上 | Layout / Chip Collection Reflow(chip は折り返す、隠すなら +n の開閉) | 採用済み: 「その他の条件」は件数の印付きの開閉ボタンで、効いている条件は隠さない |
| 同上 | Interaction / Focus States | 採用済み: `:focus-visible` の 2px 枠 |
| 表の横スクロール(table horizontal scroll overflow mobile) | Responsive / Table Handling(横スクロールかカード) | 採用済み: `.table-scroll` + 影の手掛かり |
| 同上 | Responsive / Horizontal Scroll(ページ全体の横スクロールを避ける) | 採用済み: スクロールは表の箱の中だけ |
| 同上 | Layout / Long Token Wrapping(識別子で横にはみ出さない) | 採用: `.tag` の `nowrap` を外し `overflow-wrap: anywhere` に(詳細ページのプロジェクトのパス) |
| ダーク配色(dark mode contrast color) | Accessibility / Color Contrast(4.5:1) | 採用済み: ダークの `--ink-3` #939c97 は #161a18 上で 5.9:1 |
| 同上 | Accessibility / Color Only | 採用済み: 欠測の帯片は斜線、失敗は文字と印 |
| 同上 | Accessibility / Focus Appearance(AAA の 2px・3:1) | 採用済み: 2px の `--form` 枠 |
| タップ領域(touch target size 44px) | Touch / Touch Target Size、Accessibility / Target Size (Minimum)(Web は 24px、ネイティブは 44pt / 48dp) | 採用: 用語ページの分類の目次は 44px 高(狭い画面はタップ前提)。他のリンクは 24px 以上のまま(Web の最小値) |
| 同上 | Touch / Touch Spacing(8px の間隔) | 採用: 分類の目次の枠の間隔 6〜8px |
| 長い一覧の走査(long list scanning categories) | Typography / Line Length(65〜75 字) | 採用済み: `.note` `.section-head p` に max-width |
| 同上 | Content / Truncation | 採らない: 用語の本文は全文を見せる(省略すると定義が読めない) |
| `--stack svelte`(navigation sidebar sticky) | Accessibility / Use semantic elements | 採用済み: `nav` `button` `section` |
| `--stack svelte`(table scroll、dark mode) | 0 件(データベースに該当なし) | — |

契約変更が要る判断待ち(推奨付き):

| 案 | 推奨 | 理由 |
|---|---|---|
| 絞り込み行の固定表示を外し、表示中の件数(と解除)だけを固定する | 実施(2026-11-01 夕、下の追記) | 第一画面の 2 行分が本文に戻る。条件の変更はページ上部に戻れば済み、件数の印は残る |
| 詳細ページから戻るときに絞り込みを保つ | 実施(2026-11-01 夕、下の追記) | `file://` では referrer が無いので、atlas.html が別ページへ移るときに sessionStorage に印を残し、詳細・用語ページの「戻る」が印を見て `history.back()` にする。直接開いたときは今のリンクのまま |
| atlas.html の節の目次を広い画面ではサイドバーにする | 実施(2026-11-01 夕、下の追記) | 10 項目を 1 行に並べると主従が無く、表題帯が消えると欄の移動に先頭へ戻る必要があり、現在地の印も無かった |
| 伏せ字の仮名をセッション数順に振る(project-01 が最大) | 推奨しない(保留) | 単体テスト 5 箇所と README の記述が変わる割に、伏せ字版を見せる相手には順序が無くても困らない |
| 伏せ字ビルドの要点を「規模の分布」の文に変える | 推奨しない | 要点は根拠のセッションへのリンクが価値で、伏せ字でも project-NN で辿れる |
| `.seg` の押下状態を帳票らしい印(✓ や下線)に替える | 推奨しない | 緑ベタの方が識別しやすく、契約の「色だけに頼らない」は `aria-pressed` + 文字で満たしている |
| 用語ページの分類目次を atlas.html のマストヘッドにも出す(用語へ直接飛ぶ) | 推奨しない | マストヘッドの目次が 11 → 16 項目になり第一画面を圧迫する |
| 日付入力の Tab 3 打(`<input type="date">` の仕様) | 推奨しない | 置き換えは契約外で、ブラウザ標準の方がキーボード・読み上げに強い |

#### 追記(2026-11-01 夕): 節の目次をサイドバーにし、保留だった 2 件を実施(契約変更)

ユーザーの指摘: 表題帯の下の 10 節のリンクは 1 行に並べるには多く主従の差が無い、表題帯はスクロールで消えるので欄の移動に先頭へ戻る必要がある(固定は絞り込み行だけ)、現在地の印が無い、大画面のデモでは左に目次があると構成が伝わる。「広い画面はサイドバー、狭い画面は固定した上部の行、どちらも現在地の印付き」で承認。

直したこと(surface brief の FIRST VIEWPORT と SUBPAGES を同じコミットで変更):

17. **サイドバー(1280px 以上)**: 表題帯の下を「目次 + 本文」の 2 段にした(`App.svelte` の `.shell` グリッド、左 13em、sticky)。10 節を 概況 / 内訳 / 一覧 / 付録 の 4 群に縦に並べ、群名は欄の項目名と同じ小さな緑の字。スクロールに合わせて読んでいる節に `aria-current` の印(左の 3px 罫 + 緑の地。用語ページの GLOSSARY_JS と同じ判定を Svelte の `$effect` で: 見出しが画面上部 1/3 を越えた最後の節、末尾では最後の節)。下に「表示中 N / 集計対象 M セッション」、絞り込みが効いていれば「K 条件で絞り込み中」の印(期間は開始・終了で 1 条件)と「解除」。サイドバーの幅はコンテンツから取らず、ページの最大幅を 1360px + 13em + 32px に広げた(1920px で本文 1312px、サイドバー導入前と同じ)。
18. **上部の固定行(1280px 未満)**: 目次を上部に固定した 36px の 1 行にし、横に流れる(端の影が続きの手掛かり。現在地の項目が見える位置まで行をずらす)。右端に件数と解除(720px 未満は「N / M 件」に縮める)。固定するのはこの行だけ。飛び先の余白は `html { scroll-padding-top: var(--topbar-h) }` + `.section { scroll-margin-top: 12px }` に整理した(以前は両方に固定行の高さを入れていて二重に下がっていた)。
19. **絞り込み行の固定解除**(保留の推奨案): `FilterBar` を通常の流れに戻し、件数と解除を目次の帯(サイドバー / 固定行)へ移した。
20. **詳細から戻るときの絞り込み保持**(保留の推奨案): atlas.html が別ページへのリンクを押したときに `sessionStorage` に印を残し、詳細・用語ページの「← 戻る」は印があり `history.length > 1` なら `history.back()`(URL の # の絞り込みがそのまま残る)。印は読んだら消す(次に直接開いたときに誤って戻らない)。修飾キー付きクリック・直接開いたとき・新しいタブでは普通のリンク。`detail.ts` の `BACK_JS`(外部参照なし、`file://` で動く)。

表の幅の扱い: 1280px 未満でサイドバーを出さないのは、13 列のセッション一覧(1360px)と 9 列のプロジェクト別が本文 1008px ではさらに窮屈になるため(brief に明記)。1280〜1440px では本文 1008〜1168px で、セッション一覧は横スクロール(`.table-scroll` の両端の影が手掛かり)、プロジェクト別も 1280px では僅かに横スクロールする。列幅は変えていない(1280px 未満の見え方と同じに保つ)。

確認: 1920 / 1440 / 1280 / 1024 / 375px、ライト / ダーク、伏せ字版。typecheck 0、unit・E2E 通過。

ui-ux-pro-max の照合(前回と同じ要領。`--domain ux` を 7 観点、`--stack svelte` を 2 観点):

| 観点(検索語) | 該当した規則(Category / Issue) | 採否 |
|---|---|---|
| 固定ナビ(sticky navigation header) | Navigation / Sticky Navigation(固定要素が本文を隠さない) | 採用: 固定行の高さを `--topbar-h` に出し `scroll-padding-top` で補正。サイドバーの幅では 0 |
| 同上 | Accessibility / Keyboard Navigation(Tab 順と見た目の順を揃える) | 採用済み: DOM 順は 目次 → 件数・解除 → 絞り込み行 → 本文で、見た目の順と同じ |
| 同上 | Navigation / Breadcrumbs | 採らない(前回と同じ。2 階層) |
| 現在地(scrollspy active section) | Navigation / Active State(現在の節を示す) | 採用: `aria-current` + 左罫・緑の地(サイドバー)/ 下線(固定行)。色だけに頼らず太字も |
| 同上 | Interaction / Active States(押した反応) | 採用済み: `:hover` と `:focus-visible` |
| 同上 | Navigation / Smooth Scroll | 採用済み(前回) |
| サイドバーの幅(sidebar navigation width) | Layout / Container Width(本文の行長) | 採用: サイドバーは本文の幅を削らず、ページの最大幅を広げて確保。本文の `.note` は 75ch のまま |
| 戻る(back button history) | Navigation / Back Button(履歴を壊さない。`pushState` を使い `location.replace` を避ける) | 採用: `history.back()` で戻る(履歴を増やさない)。絞り込みは `replaceState` で同じ履歴項目に残しているので、戻った先にそのまま残る |
| タップ領域(touch target size) | Touch / Touch Target Size、Accessibility / Target Size (Minimum) | 採用: 固定行のリンクは 36px 高(Web の最小 24px 以上)、サイドバーは 30px。横の間隔 14px(Touch Spacing の 8px 以上) |
| 表の横スクロール(horizontal scroll table) | Responsive / Table Handling、Responsive / Horizontal Scroll | 採用済み: スクロールは表の箱の中だけ。ページ全体は横に広がらない(375px で scrollWidth = 375 を確認) |
| 横に流れる目次(mobile navigation tabs scroll) | (Smooth Scroll / Back Button / Sticky Navigation の再掲のみ) | 新規なし |
| `--stack svelte`(sticky sidebar navigation) | Accessibility / Use semantic elements | 採用済み: `nav` `ol` `button` |
| `--stack svelte`(scroll position history) | 0 件 | — |

#### 追記(2026-11-01 夜): 詳細ページもサイドバーにし、3 画面のナビの作法を揃える

ユーザーの指摘: 詳細ページを開いたら節の目次が上部のままで「この画面はタブが上部のまま?」。前の追記で「詳細ページの節目次は 1 ページ内のスクロールだけなので上部で足りる」としたが、トップをサイドバーにした今は詳細だけ上部で固定も現在地の印も無いのは一貫せず、時系列の節は長いセッションで数百行になるので上部の目次は読んでいる途中で使えない。判断を改めて揃えた。

直したこと(surface brief の SUBPAGES を同じコミットで変更):

21. **共通の目次の帯**: 目次の帯の見た目(`.rail` / `.toc` / `.shell` / `.top`)を `App.svelte` から `base.css` に移し、3 画面で 1 つにした。静的ページの上部と帯の描画と動き(配色の切り替え・固定行の高さ `--topbar-h`・現在地の印・狭い画面での目次行の送り・「← 戻る」の `history.back()`)は新しい `page-nav.ts`(`renderTop` / `renderRail` / `NAV_JS`)に寄せ、詳細ページと用語ページが同じものを使う。
22. **詳細ページ**: 1280px 以上は左に 13em のサイドバー(上から 戻る → 12 節の目次(現在地の印)→ セッション記録 (Markdown) を開く / .md で保存(記録があるときだけ)→ 用語の説明 → 配色)。1280px 未満は上部の帯(戻る・リンク・配色。固定しない)と、その下に固定した 36px の目次行(横に流れ、現在地に印)。表題・メタ欄・ID は本文側のまま。
23. **用語ページ**: 切り替え幅を 960px から 1280px にして 3 画面で統一し、サイドバーに「← レポートに戻る」と配色を入れて詳細と同じ構成にした。狭い画面の分類の目次は 44px の枠の折り返しから、他と同じ横に流れる 36px の行に変えた(固定行が 2〜3 行分になるのを避ける)。理由は brief に書いた: 用語ページは表が無いので 960px でも成立するが、「どの画面でも同じ幅で同じ場所に目次がある」ことを優先した。
24. **配色の切り替え**: 詳細・用語ページには無かったので足した(atlas.html と同じ `localStorage` の鍵。1280px 以上はサイドバーの末尾、未満は上部の帯の右端)。
25. **統一点検**: 戻るリンクの位置(サイドバーの先頭 / 上部の帯の左端)と文言(詳細「← レポート(セッション一覧)に戻る」、用語「← レポートに戻る」)、固定行の高さ(3 画面とも 37px、飛び先の余白は `scroll-padding-top: var(--topbar-h)` + `scroll-margin-top: 12px`)、ページ下部のフッタ(`.page-foot` / `.foot`、同じ余白と字の大きさ)、ダークのサイドバーの罫線(`--rule` / `--rule-strong`、atlas と同じ変数)、Tab 順(戻る → 目次 → リンク → 配色 → 本文。`:focus-visible` の 2px 枠は base.css)、375px の固定行(37px)を確認した。

容量: 詳細ページ 1 件あたり +2.4KB(目次の帯の markup +1.6KB、共通スクリプト +1.7KB、CSS −0.4KB)。合計は 797 件で 18.3MB → 20.1MB(+1.9MB、+10%。`atlas export` 後は 20.4MB)。静的ページに埋め込む base.css からコメントと空白を落とすようにした(`build.ts` の `compactCss`)ので、サイドバーの CSS 分(+6KB/件)はこれで吸収している。これをしなければ +4.5MB だった。

ui-ux-pro-max の照合(`--domain ux` 4 観点、`--stack svelte` 1 観点):

| 観点(検索語) | 該当した規則(Category / Issue) | 採否 |
|---|---|---|
| 一貫性(consistency navigation patterns) | Navigation / Sticky Navigation、Accessibility / Keyboard Navigation、Navigation / Breadcrumbs | 採用済み(前回と同じ)。「一貫性」そのものの規則はデータベースに無い。設計契約(同じ幅で同じ場所)で判断 |
| 固定サイドバー(sticky sidebar) | Navigation / Sticky Navigation(固定要素が本文を隠さない) | 採用済み: サイドバーは本文と別の列。固定行は `--topbar-h` で補正 |
| 焦点(focus visible keyboard) | Interaction / Focus States | 採用済み: `:focus-visible` の 2px 枠(base.css、3 画面共通) |
| 同上 | Accessibility / Focus Not Obscured (Minimum)(固定 UI は scroll-padding で避ける) | 採用: `html { scroll-padding-top: var(--topbar-h) }` で、Tab で移った部品が固定行の下に隠れない |
| 同上 | Accessibility / Focus Not Obscured (Enhanced)(AAA) | 採用済み: 固定行は 37px で、焦点の枠(2px + offset 2px)まで含めて隠れない |
| 配色の切り替え(theme toggle dark mode) | 0 件 | — |
| `--stack svelte`(consistent component navigation) | Use semantic elements、Use scoped styles by default | 採用 / 一部採らない: 目次の帯の CSS は 3 画面で共用するため scoped ではなく base.css(global)に置いた。App 固有の件数の帯(`.status`)は scoped のまま |

### Phase 10: セッションの選択とグループ(2026-11-01)

動機(ユーザーの言葉): 「ユーザーはすべてのセッション、または特定のセッション、または特定の複数セッション単位で分析がしたい」。Phase 9 まではリポジトリなどの属性でしか絞れなかった。将来はセッションごとのメモ(Markdown + 画像)を足す予定で、その置き場 `atlas-notes/` の最初の住人として「名前付きグループ」のファイルを作る。第 1 段は「グループ絞り込み」まで。

契約(第 1 段):

1. **選択の軸**: 画面の絞り込みに「セッションの選択」の軸を足す。`FilterState` に `ids: string`(セッション id をカンマ区切り。`''` は制限なし)を追加し、`matches` は `ids` に含まれるものだけにする。既存の軸と AND。URL ハッシュへの encode / decode にも載せ、再読み込み・戻る・共有で保てるようにする(200 件 × 36 文字で 7KB 程度。`file://` でも問題ない。カンマはそのまま書く)。
2. **一覧のチェック欄**: セッション一覧(`SessionTable`)にチェック欄を足し、選んだ件数と「選んだ N 件だけ集計」「選択を解除」「グループとして保存」のボタンを一覧の見出し近くに置く(選択が 0 件のときは無効)。見出し行のチェックでそのページの行をまとめて選べる。「集計」を押すと `filter.ids` に入り、レポート全体(概況・内訳・実行の性質・一覧)が再計算される。絞り込み行とサイドバーの「絞り込み中」の印・件数・解除は既存の作法に従い、`ids` の絞り込みも 1 条件として数える。チェック状態そのものは画面内だけ(保存しない)。`ids` の絞り込み中は一覧にその id のセッションだけが出るので、チェックは全てオンで表示する(`ids` が変わるたびに選択を `ids` に揃える。ハッシュから開いたときも同じ)。「解除」で `ids` を外しても選択は残す(もう一度「集計」で戻せる)。
3. **名前付きグループのファイル** `atlas-notes/groups.json`(リポジトリ直下。`--notes-dir <dir>` で変更可。無ければ無いものとして動く。`.gitignore` には入れない = ユーザーが管理するかを決める)。形式:
   `{ "version": 1, "groups": [ { "name": "<名前>", "note": "<任意の一文>", "ids": ["<session id>", ...] } ] }`
   名前は一意。壊れていれば build / export / judge はエラーにせず警告して無視する(ファイル全体が読めなければ全部、1 件だけ形が違えばその 1 件。重複名は後の方を無視)。警告は `data.warnings.notes[]` として埋め込み、全体サマリの注記と脚注に出す(既存の `warnings` の経路)。
4. **CLI**: `--group <名前>` を既存の絞り込み(`--since` / `--project` / …)と同列に追加(build / export / metrics / bundle に効く。AND。無い名前はエラー)。`--session <id>`(カンマ区切り、複数回指定可)で特定のセッションだけ。id は先頭一致で解決してよいが、曖昧なら(複数に当たれば)エラー、どれにも当たらなければエラー。さらに `atlas group list`、`atlas group add <名前> <id...> [--note <一文>]`(既存名なら ids を追記、重複は除く)、`atlas group remove <名前>` を足す。add / remove は壊れた `groups.json` を上書きしない(エラーにして直してもらう)。
5. **埋め込みデータ**: `ReportData.groups[]`(name, note, ids)を入れ(`REPORT_DATA_VERSION` 5)、絞り込み行に「グループ」の選択肢を足す。選ぶと `filter.ids` にそのグループの ids が入る(表示上はグループ名と「n 件」、記録に無い id があれば「n 件(うち記録にあるのは m 件)」。壊れない)。手でチェックを変えて集計すると、`ids` の集合がどのグループとも一致しなくなるのでグループ名の表示は外れて「選んだ N 件」になる。グループが 1 つも無く `ids` も空のときはこの選択肢は出さない。
6. **画面から保存**: 選択中に「グループとして保存」を押すと、`{ "name": "", "note": "", "ids": [...] }` の JSON 片をクリップボードにコピーし(`file://` でクリップボードが使えないときに備えて同じ内容を読み取り専用の textarea にも出す)、`atlas-notes/groups.json` の `groups` に貼る旨と `atlas group add` の例を添える。HTML からファイルは書けないのでこれが上限。
7. **伏せ字**: `--anonymize` ではグループ名と note を出さず「グループ 1, 2, …」にする(自由記述のため。番号はファイルの順)。ids は不透明な id なのでそのまま。
8. **容量**: atlas.html の増分は小さい(チェック欄と埋め込みグループ)。5MB 制約・外部参照なしは従来どおり。

検査: 単体(filter の `ids` の encode / decode 往復と `matches`、`groups.json` の読み取りの正常・壊れた形・重複名、CLI の `--group` / `--session` / `group add` の解釈と先頭一致の解決)。E2E(phase2 系: fixture に `groups.json` を置いて `--group` で件数が変わる、`--session` で 1〜2 件になる、埋め込みデータにグループがある、`--anonymize` で名前が仮名になる、壊れたファイルで警告が出て build は成功する)。impeccable critique / audit と web-design-guidelines は従来どおりゲート。surface brief に「選択」の軸と「グループ」の選択肢を追記。ui-ux-pro-max の照合は「選択 / 一括操作 / フィルタ」の語で 1 回。ブラウザで 1024 と 1440 の幅で チェック → 集計 → サイドバーの件数と印 → 解除 → グループの選択 → 保存の textarea を一通り確認してスクリーンショットを残す(`.impeccable/critique/` 配下。コミットしない)。README の絞り込みの節に「選んだセッションだけ集計」「グループ(groups.json、--group、atlas group)」「--session」を追記。atlas.bat 系は変更不要。

#### 実施(2026-11-01 夜、第 1 段)

直したこと・作ったもの:

1. **純関数と読み書き**: `packages/report/src/lib/groups.ts`(`parseGroups` / `serializeGroups` / `groupSnippet` / `resolveIdPrefixes`。ブラウザと Node の両方から使う)と `packages/report/src/groups-io.ts`(`loadGroups` / `loadGroupsForWrite` / `saveGroups`。Node だけ)。`filter.ts` に `ids` と `splitIds` / `joinIds` / `sameIds`。`matches` / `applyFilter` は ids の集合を 1 回だけ作る。
2. **CLI**: `args.ts` に `--group` / `--session`(複数回・カンマ区切り)/ `--notes-dir` / `--note` と `group list | add | remove`。`commands.ts` は sessions.json と groups.json を読んで絞り込む共通の `selectSessions`(metrics / build / export / bundle が使う)と `resolveIdFilter`、`runGroup`。`Paths` に `notes` / `groups`。bundle の manifest の scope にも `group` / `session` を入れる。
3. **埋め込みと画面**: `ReportData.groups` と `warnings.notes`(`REPORT_DATA_VERSION` 5)。`FilterBar` の「グループ」(グループがあるか ids が効いているときだけ出る。選ぶと記録にある id だけを ids に入れ、記録に無い id は「うち記録にあるのは m 件」で知らせる。1 件も記録に無いグループは元の ids を入れて 0 件にする = 「すべて」と区別)。`SessionTable` のチェック欄(見出し行で 50 件まとめて、`indeterminate` も出す)と操作列、`groupSnippet` の textarea(焦点を当てると全選択)。`App` が選択の集合を持ち、`filter.ids` が変わるたびに記録にある id に揃える。「選択を解除」は選択で集計中ならその条件も外す(チェックが無いのに「選んだ N 件」で絞られたままにしない)。
4. **伏せ字**: `build.ts` で name を「グループ N」(ファイルの順)、note を '' にする。E2E で名前と note が HTML に出ないことを見る。
5. **警告の経路**: `warnings.notes[]` を全体サマリ(集計明細の注記)と脚注に出す。CLI の標準出力にも「注意」で出す。

自分で決めたこと(戻し方は git): 見出し行のチェックで「このページの 50 件」をまとめて選べるようにした(ui-ux-pro-max の Bulk Actions の「Checkbox column + Action bar」に沿う。全件選択は、絞り込み自体が全件を表すので付けていない)。`group add` に `--note` を足した(形式に note があるのに CLI から書けないのは半端なため)。「グループとして保存」の JSON は記録にある id だけを出す(記録に無い id を引き継がない)。クリップボードに書けたかどうかを文で知らせ、書けなくても同じ内容を textarea に出す(Feedback / Confirmation Messages)。

容量: atlas.html は伏せ字版の同じデータで 1,673,895 → 1,683,786 バイト(+9.9KB、+0.6%。うち埋め込みのグループは 2 件で 424 バイト、残りはチェック欄・操作列・保存欄・グループの選択肢の markup と script)。実データ 200 件(空を除く)の 1.68MB で 5MB 制約に遠く、外部参照の検査も通る。

ui-ux-pro-max の照合(`--domain ux`、検索語「selection bulk actions filter」、1 回):

| 該当した規則(Category / Issue) | 採否 |
|---|---|
| Data Entry / Bulk Actions(Checkbox column + Action bar) | 採用: 左端のチェック欄と一覧の見出し直下の操作列。見出し行のチェックでページ単位にまとめて選ぶ |
| Layout / Chip Collection Reflow(折り返しを許す) | 採用済み: 操作列と絞り込み行は flex-wrap で折り返し、1024px では 2 行になる(切り詰めない) |
| Feedback / Confirmation Messages(成功を短く知らせる) | 採用: 「グループとして保存」のあとに「N 件の id をクリップボードにコピーしました」/「この環境では書けないため下の欄から」を role=status で出す |

検査: typecheck 0 / 0、単体 101 通過(16 ファイル)、E2E 49 通過 / 8 skipped(6 ファイル。phase2 に i. を追加)。impeccable の検出器(`detect.mjs`、静的)は変更 3 ファイルで 0 件(URL スキャンは puppeteer が無く未実施)。設計契約と web-design-guidelines の照合はサブエージェント(読み取り専用)で実施: 契約違反なし(PASS)。P1 3 件(コマンドの例が `atlas …` で省略付きだった → `npm run atlas -- group add <名前> <全 id>` に、チェックの的が 16px → label で 28 × 32px に、「閉じる」で焦点が消える → 「グループとして保存」に戻す)と P2 6 件(textarea の行数、開いている間に JSON が古いまま → 選択に追従、グループ名が select で切れる → 件数と note を欄の下に、記録に無い id だけのグループで「選択を解除」が押せない → 集計中は 0 件でも押せる、aria-live の範囲を件数だけに、aria-expanded の誤用を外す、textarea に見える項目名)を直した。残した P2: 「選んだ N 件だけ集計」の N は他の条件で隠れた行も含むので、AND の結果の件数と一致しないことがある(件数は「表示中」で分かるため、そのまま)。ブラウザ(Playwright、実データ 200 件)で 1440px ライトと 1024px ダークの両方で チェック 3 件 → 集計(表示中 3、サイドバー / 固定行に「1 条件で絞り込み中」、グループの選択肢は「選んだ 3 件」、URL に `#ids=…`)→ 解除(表示中 200、選択は 3 件のまま)→ グループ「直近の調査」(表示中 5、note が欄の下に出る、一覧の 5 行が全てチェック済み)→ 1 件外して集計(「選んだ 4 件」)→ 再読み込み(表示中 4、選択 4)→ 保存(textarea に id 4 件の JSON、焦点が移る)→ 選択を解除(表示中 200、URL の # が消える)を通した。スクリーンショットは `.impeccable/critique/phase10-groups/`(コミットしない)。

残したこと(第 2 段以降): セッションごとのメモ(Markdown + 画像)とその表示。グループの編集(名前の変更・並べ替え)は CLI の add / remove と手書きで足りるとみて付けていない。クリップボードは `file://` の Chrome では書けるが、Playwright の既定では権限が無く fallback の文になる(実ブラウザでの確認は組み込みブラウザの http で行った)。

### Phase 10 第 2 段: ローカルサーバ経由で画面からグループを作る(2026-11-01)

動機(ユーザーの判断): 第 1 段の「グループとして保存」が JSON をコピーして貼る形なのは一般的でなく分かりづらい。技術的な事情(HTML からファイルを書けない)をユーザーに負わせない。ダイアログを毎回出すのも嫌。Gmail / VS Code / Obsidian のように「作成を押したら保存される」形にする。そのために atlas.bat がローカルサーバを立ててブラウザを開き、画面を閉じたらサーバも止まる運用に変える。アプリ化(Electron)は後回しにし、画面と保存の境界を小さな HTTP API にして後で差し替えられるようにする。第 1 段の契約 6(JSON 片をコピー)はこれで置き換える。

契約:

1. **`atlas serve [--port <n>] [--no-open]`**: 127.0.0.1 だけに bind(既定は空きポートを自動取得)。out/ を静的に配信(atlas.html、glossary.html、sessions/)。ディレクトリ一覧は出さず(`/` は atlas.html へ)、out/ の外は読めない(パスの正規化で検査)。起動したら既定のブラウザで `http://127.0.0.1:<port>/atlas.html` を開き、標準出力に URL と「ブラウザを閉じるか、この窓を閉じると終了します」を出す。
2. **API**(JSON、同一オリジンのみ):
   - `GET /api/state` → `{ groups, notesDir, warnings, version }`。groups はその時点の groups.json(`groups-io.loadGroups`)。
   - `POST /api/groups` `{ name, note, ids }` → 作成(同名があれば 409)。`PUT /api/groups/<name>` `{ name?, note?, ids? }` → 改名・更新(改名先が既にあれば 409)。`DELETE /api/groups/<name>` → 削除(無ければ 404)。書き込みは groups-io(`loadGroupsForWrite` / `saveGroups`)を通し、壊れたファイルは上書きしない(409 と理由)。書ける先は notes-dir 配下の groups.json だけ。
   - `POST /api/heartbeat` → 204。
   - `/api/*` の全てで `Sec-Fetch-Site` が same-origin / none 以外なら 403、`Origin` があれば自分のオリジンと一致しなければ 403。書き込み系(POST / PUT / DELETE。heartbeat も含む)は起動ごとのランダムな token を `X-Atlas-Token` に要求する(無ければ 403)。token は serve が HTML を配信するときに `<meta name="atlas-token" content="__ATLAS_TOKEN__">` のプレースホルダを置き換えて渡す(build 時の HTML はプレースホルダのまま = file:// では空扱い。詳細・用語ページにも同じ meta を入れ、heartbeat に使う)。
3. **終了の規則**: 3 画面(atlas.html・詳細・用語)は http(s) で開かれているときだけ 3 秒ごとに heartbeat を送る(page-nav.ts の NAV_JS にも入れる)。サーバは「最初の heartbeat を受けてから、最後の heartbeat から 8 秒」経ったら終了する。最初の heartbeat が 60 秒来なければ終了する(ブラウザが開かなかったとき)。詳細ページへ移っている間も heartbeat は続く。サーバが止まった後の画面は heartbeat の失敗を検知して「サーバが止まっています。atlas.bat を実行し直してください」の帯を出し、編集の操作を無効にする(閲覧はそのまま。失敗したら以後は送らない)。
4. **二重起動**: serve は起動時に `out/.serve.json`(port、pid。token は書かない)を見て、既に動いているサーバがあれば(`GET /api/state` が `X-Atlas-Serve` 付きで応える)ブラウザを開くだけで終了する。自分が終了するときに消す。
5. **画面の編集モード**: 読み込み時に http(s) かつ token があり `GET /api/state` が成功したら編集モード。グループの一覧は埋め込みではなく API の結果を使う(CLI で足したグループも再読み込みで出る。埋め込みの groups は file:// 用に残す)。
   - セッション一覧の操作列: 「選んだ N 件だけ集計」「選択を解除」はそのまま。「グループを作成」を押すと名前と一文の入力欄がインラインで開き(ダイアログにしない)、「作成」で POST → 成功したら絞り込み行の「グループ」に即座に出て、そのグループで絞り込んだ状態にする。失敗は入力欄の下に理由を出す。
   - 絞り込み行の「グループ」で選択中のグループに「名前の変更」(インライン編集)と「削除」(確認は 1 回、インライン)を付ける。
   - 編集モードでないとき: 「グループを作成」の代わりに「グループの作成は atlas.bat から開いたときにできます」の 1 行(伏せ字版では何も出さない)。第 1 段の JSON 片の textarea・クリップボード・コマンド例は全部外す(CSS・テスト・README・surface brief も)。
6. **bat**: atlas.bat / atlas-export.bat / atlas-judge.bat は最後の `start out\atlas.html` をやめ、`atlas serve` で終える(窓はサーバが終わるまで残る。失敗時の pause は従来どおり)。
7. **設計契約の文言**: 「サーバ無しで開ける 1 ファイル」は共有用の out/atlas.html として維持(閲覧のみ)。「外部参照なし」の検査(e2e の externalRefs)は、同一オリジンの相対パス `api/…`(詳細ページからは `../api/…`)への fetch だけ許し、http(s) の参照は従来どおり禁止、に改める。file:// で開いたときに fetch の失敗で console にエラーを出さない(try/catch、1 回だけ試す)。
8. **伏せ字版**(--anonymize)では編集モードにしない(serve されていても編集の操作を出さず、`/api/state` と groups の API は 403。heartbeat だけ受ける)。共有用なので。

検査: 単体(サーバを port 0 で起動して API: token の有無、409、パスの正規化、Sec-Fetch-Site、heartbeat による終了と .serve.json の削除)。E2E(build → serve → /api/state → POST → groups.json が書かれる → GET に出る → PUT → DELETE。静的な atlas.html は改定後の外部参照の検査を通る)。ブラウザ(Playwright、http://127.0.0.1、1440 / 1024): 「グループを作成」→ 名前入力 → 作成 → 絞り込み行に出る・絞り込まれる → 名前の変更 → 削除 → ブラウザを閉じて約 10 秒でプロセスが終わる、をスクリーンショット付きで。impeccable critique / audit、web-design-guidelines、ui-ux-pro-max(「inline create form feedback」で 1 回)は従来どおり。surface brief の SELECTION を更新。README の「起動方法」(bat がサーバを立ててブラウザを開く、閉じれば止まる、共有は out/atlas.html)、`serve` と `--port`、グループの節を書き換える。

#### 実施(2026-11-01 夜、第 2 段)

作ったもの・直したこと:

1. **サーバ** `packages/cli/src/serve.ts`(`startServe` / `findRunningServer` / `openInBrowser`)。node:http だけで、127.0.0.1 に bind。静的配信は `resolve(out, '.' + path)` が out/ 配下か(と `.serve.json` でないか)を見て、ディレクトリと外は 404、`/` は atlas.html へ 302。HTML は配信時に `__ATLAS_TOKEN__` を起動ごとの token(24 バイトの base64url)に置き換える。API は `/api/state`(GET)、`/api/groups`(POST)、`/api/groups/<name>`(PUT / DELETE)、`/api/heartbeat`(POST)。`/api/*` は `Sec-Fetch-Site`(same-origin / none 以外は 403)と `Origin`(自分のオリジン以外は 403)を見て、書き込み系(heartbeat も)は `X-Atlas-Token` を要求する。伏せ字版(atlas.html の埋め込みデータの `anonymized`。mtime が変わるまで覚える)では heartbeat 以外の API を 403。終了は「最初の heartbeat から、最後の heartbeat の 8 秒後」か「最初の heartbeat が 60 秒来ない」で、`.serve.json` を消してから閉じる。
2. **CLI**: `serve [--port <n>] [--no-open]`(`--port` / `--no-open` は serve 以外で UsageError)。`runServe` は atlas.html が無ければエラー、`.serve.json` のサーバが `X-Atlas-Serve` 付きで応えればブラウザを開くだけ、そうでなければ起動して `done` を待つ(SIGINT / SIGTERM で閉じる)。atlas.bat / atlas-export.bat / atlas-judge.bat は末尾の `start out\atlas.html` を `node packages\cli\src\main.ts serve` にした(atlas.bat の追加引数は `all` にだけ渡す)。
3. **画面**: `packages/report/src/app/api.ts`(`serveToken` / `api.state|create|update|remove` / `startHeartbeat`。fetch の宛先は相対パス `api/…` の文字列だけ。接続できないときは「サーバに接続できません」の日本語に変える)。`App.svelte` は token があれば heartbeat を始め、伏せ字版でなければ `api/state` を 1 回だけ試して成功したら編集モード(`liveGroups` を使う)。`createGroup` / `renameGroup` / `deleteGroup` は API の返す groups で差し替え、作成後はそのグループで絞り込み、削除後は `ids` を外す。heartbeat が失敗したら `serverDown`(帯 `.down-band` を sticky で上に貼り、編集を消す)。`SessionTable` の「グループを作成」は入力欄をインラインで開く(名前 / 一文 / 作成 / 取消。空の名前でも送れて理由を下に出す。送信中は `readonly` + `aria-busy`。成功で「グループを作成」に、失敗で名前の欄にフォーカスを戻す。`editable` が外れたら閉じる)。`FilterBar` の「グループ」の欄と操作(名前の変更・削除)は 1 つの固まり `.group-field`(折り返しても離れない)。削除の確認は初期フォーカスを「取消」に置く(Enter の連打で消さない)。成功したら「グループ」の select に、失敗したら入力欄に戻す。編集できないときの 1 行は「このファイルは閲覧用です。グループの作成は atlas.bat から開いたときにできます」(伏せ字版では出さない)。
4. **静的ページ**: template.html・詳細・用語の head に `<meta name="atlas-token" content="__ATLAS_TOKEN__">`。`page-nav.ts` の NAV_JS に heartbeat(http(s) で token がプレースホルダでないときだけ。詳細は `../api/heartbeat`、用語は `api/heartbeat`。失敗したら帯を出して止める)。
5. **撤去**: 第 1 段の JSON 片(`groupSnippet`・textarea・クリップボード・コマンド例・その CSS と単体テスト・README・brief の記述)。
6. **検査の改定**: e2e の `externalRefs` は `fetch(` の直後が `"api/` か `"../api/` の文字列のときだけ許す(それ以外の `fetch(` と http(s) は従来どおり不可)。

自分で決めたこと(戻し方は git): heartbeat にも token を要求した(書き込み系の規則をそのまま適用。静的ページにも meta を入れたので困らない)。`.serve.json` のサーバ確認は `X-Atlas-Serve` ヘッダで見分ける(伏せ字版は `/api/state` が 403 でも生きている)。`--no-open` を足した(テストと、既にブラウザを開いているとき用)。`PUT` の改名先が既にあれば 409。サーバが止まった帯は 3 画面とも同じ文言と見た目にし、詳細・用語ページでも出す。削除の確認の初期フォーカスは「取消」。

容量: atlas.html は伏せ字版の同じデータで 1,683,786 → 1,691,558 バイト(+7.8KB。作成の入力欄・操作・API の script)。詳細ページは meta と heartbeat の script で 1 件 +0.9KB、797 件で 20.12MB → 20.88MB。

ui-ux-pro-max の照合(`--domain ux`、検索語「inline create form feedback」、1 回):

| 該当した規則(Category / Issue) | 採否 |
|---|---|
| Forms / Submit Feedback(送信中 → 成功 / 失敗を見せる) | 採用: 送信中はボタンを「作成中…」「保存中…」「削除中…」にして `aria-busy`、成功は欄が閉じて「グループ」に出る(絞り込みも変わる)、失敗は欄の下に理由(role=alert) |
| Accessibility / Form Labels(label で包む、placeholder だけにしない) | 採用: 名前・一文・新しい名前はすべて label で包み、placeholder は例だけ |
| Forms / Inline Validation(blur で検証) | 一部採用: 空の名前は送信時にその場で理由を出す(blur では出さない。名前以外に検証する項目が無く、同名の重複はサーバしか分からないため) |

検査: typecheck 0 / 0、単体 105 通過(17 ファイル)(`serve.test.ts` 4 件を追加: 配信・token の差し込み・パスの正規化・API の作成 / 改名 / 削除・409・壊れたファイル・Sec-Fetch-Site と Origin・伏せ字版の 403・heartbeat による終了と .serve.json の削除)、E2E 50 通過 / 8 skipped(6 ファイル)(phase2 に j. を追加: build の HTML がプレースホルダのまま、serve の API で groups.json が書かれる、`--group` が同じファイルを読む、二重起動)。impeccable の検出器(静的)0 件。設計契約 + web-design-guidelines の照合(読み取り専用のサブエージェント)は初回 FAIL(停止の帯の証跡が無い、brief 未更新、停止後も作成欄が送れる、処理後にフォーカスが落ちる、1440px で削除の確認が欄から離れる)→ 全て直して撮り直した。残した P2: 同じ id 集合のグループが 2 つあると後の方は名前の変更・削除ができない(`currentGroup` を ids の一致で決めているため。同じ集合を 2 つ作る動機が薄いので保留)。ブラウザ(Playwright、実データ、1440 ライト / 1024 ダーク): 「グループを作成」→ 名前と一文 → 作成(groups.json に書かれ、絞り込み行に「画面の調査(3 件)」、表示中 3、フォーカスは「グループを作成」に戻る)→ 同名で 409 の理由が欄の下に出る → 名前の変更(「改名した調査」)→ 削除(確認 1 回 → groups.json が空、表示中 200)→ 詳細ページに移って 9 秒後もサーバが生きている → ブラウザを閉じて 5.2 秒で終了し `.serve.json` が消える。サーバを止めると約 5 秒で帯が出て「グループを作成」が消える。file:// では作成の操作が無く案内の 1 行だけで、console にエラーは出ない。スクリーンショットは `.impeccable/critique/phase10-serve/`(コミットしない)。

未実施: atlas.bat をダブルクリックして通す確認(ブラウザを開いて窓が残るため、非対話では確認できない。bat の変更は末尾の 1 行だけ)。impeccable の URL スキャンは puppeteer が無く未実施。

### Phase 10 第 3 段: グループの居場所と付け外し(2026-11-01)

動機(評価の結論、ユーザーが作り直しを決めた): 第 2 段は動作はするが「ラベル / 保存ビュー」の型に届いていない。(1) グループの居場所が無く、絞り込み行の select を開かないと何があるか分からず件数も一文も見えない。(2) 操作が上下に分かれている(作成は一覧、選択・改名・削除は絞り込み行)。(3) 既存のグループに足せず、外せない。(4) 0 件だと欄が出ず機能に気づけない。

契約:

1. **サイドバーの「グループ」の群**(1280px 以上): 節の目次の群と同じ作法で、目次の下(「付録」の後、件数の帯の上)に置く。先頭に「すべて」の行、各グループの行は名前と件数(記録に無い id があれば「m / n」)。押すとそのグループで絞り込み、現在のグループに aria-current の印。もう一度押すか「すべて」で外れる。一覧のチェックから集計しているときは「選んだ N 件」の行が現在として出る。0 件のときは「グループはまだありません。一覧でセッションを選ぶと作れます」の 1 行(編集モードでないときは「グループは atlas.bat から開くと作れます」)。件数が多いときはその群の中だけ縦に流す(最大 40vh)。
2. **操作の集約**: 改名・一文(note)の編集・削除はサイドバーの現在のグループの行に寄せ(行の下にインラインで「改名 / 一文 / 削除」、入力欄もその場。確認は 1 回、初期フォーカスは取消)、絞り込み行の「グループ」select と `.group-field` の操作は外す。理由: グループの居場所を 1 か所(サイドバー、狭い幅ではその中身を開く一覧)にし、絞り込み行は属性の軸(期間・プロジェクト・クライアント・モデル)だけにする。select は件数も一文も見せられず、同じ一覧を 2 か所に持つことになるため。
3. **選択の操作列**(一覧の見出し直下): 「選んだ N 件だけ集計」「選択を解除」に加えて「グループに追加 ▾」(既存グループの一覧を開いて 1 回で追加。末尾に「新しいグループ…」で今のインライン作成)。グループで絞り込み中は「このグループから外す」も出す。外して 0 件になったグループは消さず 0 件のまま残す。API は既存の `PUT /api/groups/<name>` の ids で足りる。追加後は絞り込みを変えず「N 件を「名前」に追加しました(既に入っていた K 件を除く)」を role=status で短く出す。重複は足さない。
4. **1280px 未満**: 固定目次行の末尾に「グループ」の 1 項目(ボタン、件数つき)を足し、押すと目次行の下に一覧が開く(サイドバーと同じ中身。外を押す / Esc で閉じ、焦点はボタンに戻る)。ダイアログ扱いにせず、キーボードで閉じられる。1024px で目次行の右端が切れている既知の点を悪化させない(項目は 1 つ増えるだけ。横に流れる)。
5. **選択を名前で持つ**: `FilterState` に `group: string`(名前)を足す。グループを選ぶと `group` に名前、`ids` にその時点の id(記録にあるもの)を両方書く。集計は「`group` の名前がグループにあればその今の ids、無ければ `ids`」で決める(共有した hash の相手にその名前が無ければ `ids` に落ちて「選んだ N 件」になる。グループを編集すれば絞り込みも追従する)。同じ id 集合のグループが 2 つあっても名前で区別できる。伏せ字版では名前を hash に出さず `ids` だけ(仮名でも出さない)。
6. **閲覧専用**(file://、伏せ字版): サイドバーの一覧は埋め込みの groups で出し、選んで絞り込める。作成・改名・一文・削除・追加・除外の操作は出さない。伏せ字版の名前は「グループ N」のまま。「グループに追加」の代わりの案内は 1 行だけ(伏せ字版では出さない)。
7. CLI と groups.json の形式は変えない。

検査: 単体(追加・除外の純関数: 重複・0 件、hash の往復: グループ名・相手に無い名前・伏せ字、serve.test に ids の更新)。E2E(API で追加 → groups.json に反映、0 件のグループが残る)。ブラウザ(Playwright、実データ、1440 ライト / 1024 ダーク): 0 件の案内 → 新しいグループ作成 → サイドバーに出る → 別のセッションを既存グループに追加 → 絞り込み → 外す → 改名 → 一文の編集 → 削除 → 同じ集合のグループ 2 つで改名できる → file:// で閲覧のみ。スクリーンショットは `.impeccable/critique/phase10-groups-rail/`(コミットしない)。impeccable critique / audit、web-design-guidelines、ui-ux-pro-max(「sidebar saved views labels」で 1 回)は従来どおり。surface brief の SELECTION と FIRST VIEWPORT を更新。README の絞り込みの節。

#### 実施(2026-11-01 深夜、第 3 段)

作ったもの・直したこと:

1. **居場所**: `GroupRail.svelte`(新規)。「すべて」→ 各グループ(button。名前・件数「m / n」・一文)、現在に aria-current。現在のグループの行の下に 改名 / 一文 / 削除(インライン、確認 1 回、初期フォーカスは取消、成功で行の先頭の操作に、失敗で入力欄に戻す)。0 件は案内の 1 行、閲覧専用でグループがあれば「このファイルは閲覧用です」の 1 行。多いときは群の中だけ 40vh で縦に流す。`App.svelte` は 1280px 以上でサイドバーの目次の下に「グループ」の群として出し、1280px 未満では目次行の末尾に「グループ N」ボタン(aria-expanded)を足して同じ中身を目次行の下に開く(tabindex=-1 の枠に焦点、Esc / 外を押すで閉じて焦点はボタンに戻す。ダイアログにしない)。
2. **操作の集約**: 絞り込み行の「グループ」select と `.group-field` の操作を外した(`FilterBar` は属性の軸だけに戻る)。理由: 居場所を 1 か所にし、同じ一覧を 2 か所に持たない。select は件数と一文を見せられず、狭い幅でも目次行の一覧で同じものに届くので残す必要が無い。
3. **選択の操作列**: 「グループに追加 ▾」(既存グループの一覧 + 末尾の「新しいグループ…」。Esc / 外を押す / ↑↓ で移動)と、グループで絞り込み中の「このグループから外す」。追加・除外は純関数 `addIds` / `removeIds`(`groups.ts`)で次の ids を決めて既存の `PUT /api/groups/<name>` の ids で保存する(API の追加は不要だった)。結果は「N 件を「名前」に追加しました(既に入っていた K 件を除く)」「N 件を「名前」から外しました(グループは 0 件のまま残ります)」を role=status で。追加では絞り込みを変えない(現在のグループに足したときだけ ids を追従させる)。
4. **名前で持つ**: `FilterState.group`(名前)。グループを選ぶと `group` と `ids`(その時点の記録にある id)の両方を hash に書く。集計は `effectiveIds`(名前が今のグループにあればその ids、無ければ `ids`)。現在のグループ名は名前で決め、決まらないとき(伏せ字版、相手に無い名前)だけ ids の一致で探す。0 件のグループは `NO_SESSION`('(none)')を ids にして「制限なし」と区別する(`groupIds`)。伏せ字版では名前を hash に出さない(Playwright で `#ids=(none)` だけになるのを確認)。同じ id 集合のグループが 2 つあっても名前で区別でき、後の方も改名・削除できる(第 2 段の残り P2 を解消)。
5. **閲覧専用**: 埋め込みの groups で同じ一覧を出し、選んで絞り込める。操作は出さない。

自分で決めたこと(戻し方は git): 群の位置は目次の下・件数の帯の上(目次と同じ「縦に並ぶ行」の作法で、件数の帯がグループの絞り込みの結果を受ける形になる)。「グループに追加 ▾」は既存グループが 0 件でも「新しいグループ…」だけの一覧として出す(作成の入口を 1 つにする)。「選択を解除」は第 2 段と同じく集計中ならその条件も外す。hash の `group` は `ids` の後ろ(順序は `FilterState` のキー順)。

容量: atlas.html は伏せ字版の同じデータで 1,691,558 → 1,702,814 バイト(+11.3KB。GroupRail・目次行のボタンと一覧・追加の一覧)。詳細ページは変わらない。

ui-ux-pro-max の照合(`--domain ux`、検索語「sidebar saved views labels」、1 回): Accessibility / Form Labels、Accessibility / ARIA Labels、Forms / Input Labels の 3 件(saved views そのものの規則はデータベースに無い)。採用: 改名・一文の入力欄は label で包み項目名を上に出す、▾ は aria-hidden でボタン自体に文字がある、件数には aria-label「N 件」。設計契約(同じ幅で同じ場所)は目次の作法を借りて判断した。

検査: typecheck 0 / 0、単体 107 通過(17 ファイル)(追加・除外の純関数、hash の往復と名前の解決・0 件のグループ、serve の ids の更新)、E2E 50 通過 / 8 skipped(6 ファイル)(j. に ids の PUT と 0 件のまま残ることを追加)。impeccable の検出器(静的)0 件。設計契約 + web-design-guidelines の照合(読み取り専用のサブエージェント): 初回 FAIL(P1 2 件: 狭い幅の一覧で削除した後の焦点が document から探した隠れた側の一覧に当たって消える、role=status を文と同時に挿入していて読み上げられない)→ 直した(戻し先は自分のルート要素の中、live 領域は常に置いて文だけ差し替え)。P2 も直した: 目次行の「グループ N」を先頭に置く(1024px で右端に隠れない)、一覧の枠に role=region と焦点の印、入力欄の Esc は編集の取消だけ(一覧は閉じない)、Tab で外へ出たら一覧・メニューを閉じる、件数は sr-only の文で「n 件のうち記録にあるのは m 件」、追加の一覧の件数もサイドバーと同じ「m / n」、処理中は取消を押せない、2 つの一覧で id が重ならないよう接頭辞、「選んだ N 件」の行に「押すと外す」、閲覧用の案内は操作列の 1 か所だけ、伏せ字版で 0 件のときは案内を出さない、状態の行は常に高さを確保して表を押し下げない。ブラウザ(Playwright、実データ、1440 ライト / 1024 ダーク): 0 件の案内 → 「グループに追加 ▾」→「新しいグループ…」で 3 件の「調査 A」(サイドバー / 一覧に出て絞り込まれる、表示中 3)→「すべて」→ 別の 3 件(1 件は重複)を追加(「2 件を「調査 A」に追加しました(既に入っていた 1 件を除く)」、絞り込みは 200 のまま)→ 絞り込み(5、全行チェック済み)→ 2 件を外す(3)→ 改名(hash も追従)→ 一文の編集(行の下に出る)→ 同じ集合のグループをもう 1 つ作り後の方を改名できる → 削除(初期フォーカスは「取消」)→ ブラウザを閉じて 5 秒で終了。1024px では目次行の「グループ N」から一覧が開き、焦点が枠に移る。file:// は埋め込みのグループを選んで絞り込めるだけ(操作無し、console エラー 0)。伏せ字版は「グループ 1」で hash に名前が出ない。スクリーンショットは `.impeccable/critique/phase10-groups-rail/`(コミットしない)。

#### 見直し(2026-11-01 深夜、第 3 段のレビュー: P1 1 件・P2 4 件を直した)

1. **P1 lost update**: 画面の追加・除外が起動時の一覧から ids 全体を作って `PUT` し、サーバが全置換していたため、画面を開いたまま CLI の `group add` で足した id が消えていた。`PUT /api/groups/<name>` に差分 `{ add, remove }` を足し(`ids` との同時指定は 400)、サーバが `loadGroupsForWrite` で読み直した最新の ids に `addIds` / `removeIds` を適用して保存し、`added / dup / removed` を返す。画面は差分だけを送り、件数と一覧はサーバの応答から作る。groups.json の形式は変えない。serve.test で「CLI が足した x が画面の add / remove で消えない」ことを見る。
2. **P2 0 件のグループの印**: 現在のグループを ids の一致で探す fallback が、0 件のグループ(全て `NO_SESSION`)で最初の 0 件グループに当たっていた。`currentGroupName`(filter.ts の純関数)にし、追加・除外・作成の `setFilter` に `group`(伏せ字版は '')を含め、fallback は `NO_SESSION` や同じ集合が 2 つ以上のときは null(伏せ字版で同じ集合が 2 つなら印を付けない)。
3. **P2 選んだ件数**: `#ids=a,b,zzz` で「選んだ 3 件」になっていた。`knownSelection`(記録にある id だけ)の件数にした。
4. **P2 チェックの同期**: グループで絞り込み中に一覧(liveGroups)が変わるたびに eff が新しいオブジェクトになり、選択を同期する effect が走ってチェックが全件に戻っていた。依存を `eff.ids` の文字列(`$derived`)に切り出した。Playwright で「1 件外す → 別グループの一文を編集 → 外れたまま」を確認。
5. **P2 無い名前の `#group=X`**: ids 無しの `group` だけが残ると 0 条件なのに「解除」が押せて hash に残っていた。effect で、名前があればその ids を補い、無ければ(グループの一覧が揃ってから)`group` を捨てる。

テストの補強: `& = % # , +` を含む名前の hash の往復(他のキーを壊さない)、`NO_SESSION` と未知の id を含む ids の受け取り、`currentGroupName` の fallback(名前 → ids の一致 → 0 件 / 重複は null)、`knownSelection`、serve の add / remove と 400。Playwright(`results-review.json`): lost update で x と y が両方残る、0 件にしても印は B のまま、`#ids=…,zzz,(none)` で「選んだ 2 件」、`#group=NOPE` だけは捨てられて「解除」が無効、`#group=C` だけは ids が補われる。

### Phase 11: 解析用の完全出力(2026-11-02)

動機(ユーザーの判断): 当面は外部に出さず、運用でカバーする。解析に必要な情報を全て出力し、出力データだけでローカルと同等の解析ができるようにする。data.db は資格情報に触れない形で取り込む。

実測(2026-11-02、~/.copilot): events.jsonl 203 本 538MB(内訳はキー別の集計 `out/coverage.json` に出す。大きい順に tool.execution_complete.result 158MB、assistant.message.encryptedContent 62MB、hook.start.input 60MB、system.message.content 42MB、reasoningBlocks 25MB、toolRequests 24MB、tool.execution_start.arguments 19MB、reasoningOpaque 18MB、session.binary_asset.data 11MB、reasoningText 6MB)。session-state は 671 フォルダ(events.jsonl があるのは 203)。セッションフォルダの中身: checkpoints/ 2.2MB、files/ 18MB、rewind-file-snapshots/ 0.8MB、rewind-snapshots/ 296MB、policies/ 32KB、plan.md 15 件、research/ は全て空、vscode.metadata.json、inuse.*.lock / .workspace-fork.lock(ロック)。一覧に無い大きな物は 1 セッション内の `fake-solution/`(535MB、開発用)と `sandbox-denials/`。~/.copilot 直下: chats/ 78MB(ユーザーが `/export` で書き出した Markdown 1 件 + 無関係なファイル群 376 件: idx / cs / cpp / dll / exe)、logs/ 23MB(アプリのログ github-app.<pid>.log、DB のパス等を含む)、attachments/ 420KB(貼り付けた画像 4 件)、plans/ 123KB(計画の Markdown 13 件)、repos/ 3MB(worktree のチェックアウト)。data.db 2.0MB + -wal 3.4MB(本体の更新は 10/31、WAL は今も書かれている)。

契約:

1. **原本の保全はスナップショットの拡張で行う**(二重に持たない)。`out/snapshot/session-state/<id>/` に plan.md・vscode.metadata.json・checkpoints/・files/・rewind-file-snapshots/・policies/ を足す(ファイルは mtime とサイズで再利用)。rewind-snapshots/ と、一覧に無い名前のもの(fake-solution 等)とロックファイルは既定で写さず、`--snapshot-all` で写す(ロックは写さない)。写さなかったものは名前と容量を manifest(`sessions.skipped[]`)に残す。~/.copilot 直下は plans/(写す)、attachments/(写す)、chats/(`*.md` だけ写す。他は解析に使えないので名前と容量だけ)、logs/(既定で写さない。資格情報を含みうるアプリのログで、セッション解析には使わない。`--snapshot-all` で写す)、repos/(写さない。ソースのチェックアウトで記録ではない。名前と容量だけ)。~/.copilot には書き込まない(読むだけ。data.db は immutable で開く)。
2. **全文記録** `atlas export --full`: `out/full/<id>.md`。上限なしで、依頼・応答・reasoningText・ツールの引数と結果(成功含む)・hook の入出力・system.message・compaction の要約・skill の本文・チェックポイント・plan を時系列で出す。除くのは暗号化・不透明データ(encryptedContent、reasoningOpaque、reasoningBlocks の中の base64 らしい値)と base64 本体(session.binary_asset.data は `out/full/assets/<id>/<assetId>.<ext>` に書き出してリンクにする)だけで、除いた箇所に種別とサイズを書く。reasoningBlocks は要素ごとに読めるか(base64 でない文字列か)を見て、読めるものは出す。hook の結果(toolResult.textResultForLlm)がツールの結果と同一なら参照にする。秘密情報の形式検査(redactSecrets)は全文記録にも掛け、件数を末尾に出す。`--anonymize` との併用はエラー。チェックポイントと plan はイベントに時刻が無いので、時系列の後に節として置き、compaction の行からチェックポイント番号で参照する。
3. **指示文・skill の閲覧ページ**: 重複なしで版ごと(contentHash)に `out/library/<hash>.md` に本文を置き、`out/instructions.html`(見出しごとの版一覧、本文、使われたセッション、初回と最終の利用日、前の版との差分)を作る。詳細ページの指示ファイルの行と skill からリンクする。本文は atlas.html に埋め込まない。伏せ字版では作らない。サイドバーの付録に入れる(export のときだけ。build だけでは作らない)。
4. **data.db**: 設計の変更(ユーザー了承済み。「読まない」を改める)。ファイルは複製せず、`file:///…/data.db?immutable=1` の読み取り専用で開く(node:sqlite 24 で動くことを確認した)。読むのは名前で固定した許可リストの列だけ(`select *` は禁止): sessions(id, title, session_type, mode, model, reasoning_effort, is_running, was_interrupted, interruption_reason, created_at, updated_at, remote_control_enabled, auto_approve, enabled_experiments_json, forked_from_session_id, fork_original_history_event_count, total_*, context_*, agent, provider_id, execution_location, title_source, archived_at, permission_mode, sandbox_enabled, provisional, agent_scope)、session_context_usage(全列)、session_checkpoints(全列)、activity_items(id, workspace_id, session_id, activity_type, preview, is_read, created_at, updated_at)、projects(id, name, container_kind, main_repo_path, default_branch, github_owner, github_repo, created_at, last_opened_at, auto_approve, sandbox_enabled, branch_prefix, show_in_sidebar, remote_default_branch)、workspaces(id, project_id, worktree_id, workspace_type, branch, name, created_at, updated_at, session_id, archived_at, created_pr_*(url / number / state)、source_pr_*(repo / number / state)、last_diff_*、total_*)。accounts / settings / app_state / model_providers / remote_environments は開かない。許可リストに列が無くても落ちない(その列は null)。許可外の列は名前だけ数える(値は読まない)。結果はスナップショット時に `out/snapshot/desktop.json` に書き、extract が sessions.json の `desktop` 欄に合成し、全文記録と詳細ページに出す。immutable では -wal の未反映分を読めないので、WAL のサイズ・更新日時と「最近の行が欠ける可能性」を desktop.json と全文記録に書く。単体テストで fixture の資格情報の値(合成)が out/ のどこにも出ないことを見る。
5. **網羅の検査** `out/coverage.json`: 元データの event type × data のキー(トップレベルのキーは `^` 付き)ごとに、件数・バイト数・扱い(full = 全文に出した / ref = 参照や要約にした / excluded = 理由付きで除外)を出す。扱いの表(`coverage.ts`)に無いキーは「未分類」(unclassified)として数え、export のログと全文記録の末尾に出す。E2E で fixture の全キーが分類済みであること、実データでは未分類の件数を報告する。同じ表を data.db の列にも適用し(許可 / 許可外 / 未分類)、未分類の列を数える(値は読まない)。
6. **bat と README**: `atlas-export-full.bat` を足す(`export --full`。atlas-export.bat は従来どおり共有向けの既定)。README に、out/ は原本と秘密情報を含みうるので共有しないこと、共有は伏せ字版を使うことを書く。容量の実測を PLAN.md に。5MB 制約は atlas.html の話で変えない。

検査: typecheck、unit、E2E(元データにある文字列が全文記録に現れること、除外キーが出ないこと、coverage、data.db の資格情報の非出力、~/.copilot を書き換えないこと)。実データで `export --full` を流して容量と未分類を報告。画面は instructions.html を 1440 / 1024 で確認。impeccable と web-design-guidelines は画面の追加分について従来どおり。

#### 実施(2026-11-02)

作ったもの・直したこと:

1. **スナップショットの拡張**(`core/snapshot.ts`): セッションフォルダの plan.md・vscode.metadata.json・checkpoints/・files/・rewind-file-snapshots/・policies/・research/・sandbox-denials/ を写す(`copyTree`、サイズと mtime で再利用)。rewind-snapshots/ と一覧に無い名前のもの(fake-solution 等)・ロック以外の未知のファイルは `--snapshot-all` のときだけ写し、写さなかったものは `extras.skipped[]`(相対パス・バイト数・理由)。直下は plans/・attachments/ を写し、chats/ は `*.md` だけ、logs/ は `--snapshot-all` のときだけ、repos/ は写さない。判断: chats/ の `*.md` 以外は 2026-10-28 のフォルダに入った無関係なファイル群(idx / cs / cpp / dll / exe、76MB)で解析に使えない。logs/ はアプリのログで DB のパスなどを含み、セッションの解析には使わないので既定で写さない。repos/ はソースのチェックアウトで記録ではない。plans/ と attachments/ は小さく、セッションから参照されうるので写す。
2. **data.db**(`core/desktop.ts` と型 `desktop-types.ts`): `file:///…?immutable=1` + readOnly で開く(node 24 の node:sqlite で URI が通ることを実測。-shm / -wal の mtime は不変)。`DESKTOP_ALLOWLIST`(表 → 列)の列だけ `SELECT` し、`DESKTOP_FORBIDDEN_TABLES` は開かない。許可リストに無い列は `coverage.tables[表].unlisted` に名前だけ。結果は snapshot が `out/snapshot/desktop.json` に書き、extract が `desktopForSession` で sessions.json の `desktop` 欄(session / contextUsage / checkpoints / activity / workspace / project)に合成し、`SessionsFile.desktop`(WAL の注意と列の扱い)も持つ(`SESSIONS_SCHEMA_VERSION` 5)。詳細ページに「デスクトップアプリの記録(data.db)」の欄、全文記録に節。
3. **全文記録**(`report/full.ts`): events.jsonl を全件読み、イベントごとに種別・id・親 id・agentId の 1 行と、本文・引数・結果・hook の入力・system.message・skill 本文・compaction の要約を囲みで出す。扱いは `coverage.ts` の表(`ruleFor`)で決め、`excluded` は「除外: 種別、バイト数」、`ref` は 1 行に短く、表に無いキーは落とさず全文に出して「未分類」に数える。不透明な文字列(base64 らしい 100 字以上)は JSON の中でも印に置き換える(reasoningBlocks の中の値もこれで除外)。hook の `toolResult.textResultForLlm` / `sessionLog` がツールの結果と同一なら「ツールの結果と同一: call …」に置き換える。binary_asset は `out/full/assets/<id>/<assetId>.<ext>` に書き出してリンク。plan.md・checkpoints/*.md は本文を節に、files/・rewind-file-snapshots/・policies/ は一覧(policies の JSON は本文も)。secret の形式検査は全文字列に掛ける。`--anonymize` との併用は args と build の両方で拒む。
4. **網羅の検査**(`report/coverage.ts`): `COVERAGE_RULES`(event type → キー → full / ref / excluded。`*` は既定)と共通のトップレベルキー(`^id` / `^parentId` は ref、`^timestamp` / `^agentId` は full)。`CoverageCounter` が全イベントのキーごとに件数とバイト数を数え、`out/coverage.json` に種別別・キー別・扱い別の合計と、data.db の列の扱い(`desktopCoverage`)を書く。未分類は export のログと各全文記録の末尾。単体テストで既知の全イベント種別に表があることを見る。
5. **閲覧ページ**(`report/library.ts`): `LibraryCollector` が system.message の指示ブロック(`extractInstructionBlocks` に本文 `body` を足した)と skill.invoked の本文を、見出し(skill は名前)→ 版(contentHash)に束ね、`out/library/<hash>.md` と `out/instructions.html`(版ごとの details: ハッシュ・字数・セッション数・初回・最終・本文 .md、前の版との行差分(LCS、変化の無い行は前後 2 行だけ)、使われたセッションへのリンク)を書く。export のときだけ作り、伏せ字版では作らない。詳細ページの指示ファイルの見出しと skill 名からリンク、サイドバーの付録に「指示文と skill」(`ReportData.library`、`REPORT_DATA_VERSION` 6)。
6. **CLI / bat / README**: `--full`(export だけ)、`--snapshot-all`(snapshot / all / export)。`atlas-export-full.bat`(snapshot → extract → export --full → serve)。README に「解析用の完全出力」の節と、out/ を共有しない注意、data.db の設計変更。

容量の実測(2026-11-02、実データ 800 セッション): スナップショットの付随物 1,106 ファイル 19.2MB、直下 plans 31 / attachments 4 / chats 2(`*.md`)。写さなかったもの 46 件 916MB(fake-solution 534MB、chats の `*.md` 以外 76MB、rewind-snapshots 26 セッション 296MB、logs 23MB、repos 3MB)。desktop.json 0.36MB(32 セッション、WAL 3.4MB は未反映 = 10/31 以降の更新は欠ける)。全文記録 800 件 309MB(イベント 144,302 件、画像など 26 ファイル 8.6MB)。coverage: full 407 キー 353MB、ref 137 キー 21.5MB、excluded 3 キー 91.4MB(encryptedContent 61.9MB、reasoningOpaque 18.1MB、binary_asset.data 11.4MB)、未分類 0。data.db の列 274 のうち許可 200、許可外 74(値は読んでいない)。閲覧ページ 30 項目・55 版(本文 0.37MB、instructions.html 0.62MB)。export --full の所要は 10.9 秒(build 全体)。reasoningBlocks は実データのスナップショットで中身を確かめられなかった(集計には 2,228 件 25MB と出るが、行の読み直しで見つからず。要素ごとに base64 らしい値だけを除外する実装にし、読めるものは出る)。

検査: typecheck 0 / 0、単体 113 通過(19 ファイル)(desktop の許可リストと資格情報の非出力・-shm を作らない、coverage の表と未分類、renderFull の出力と除外と秘密情報、library の束ねと差分とページ)、E2E 54 通過 / 8 skipped(7 ファイル。phase1 / phase2 のスキーマ版の期待値を 5 / 6 に更新)(phase11: スナップショットの拡張と --snapshot-all と元の不変、desktop.json と sessions.json と詳細ページ、export --full の文字列の出現と除外キーの非出現と coverage と assets と --anonymize との併用エラー、instructions.html と library と伏せ字版での非生成)。fixture の資格情報の合成値(accounts / settings / app_state / model_providers / logs)が out/ のどこにも出ないことを E2E で見る。実データで `export --full` を流し、~/.copilot の data.db-shm / -wal の mtime が変わらないことを確認。画面(instructions.html)は Playwright で 1440 ライト / 1024 ダーク(目次 30 項目、版 55、横あふれ 0、エラー 0)。impeccable の検出器(静的)は em-dash の advisory 1 件だけ(指示文の本文に由来)。設計契約 + web-design-guidelines の照合(読み取り専用のサブエージェント): 初回 FAIL(P0: 差分に秘密情報が伏せられずに出る。P1: summary の中のリンク、差分と本文を色だけで区別、見出しだけで束ねるので別リポジトリの同名ファイルが 1 つの系列になる、等幅フォントの直書き、1440px の証跡が .md を撮っていた)→ 全て直した(差分も伏せた本文で計算、リンクは details の中の行に、差分と本文に見出し、項目は見出し + 出所のパス、最後に使われた版に印と説明、`var(--mono)`、撮り直し)。P2 も直した: 目次の件数は「版」、項目名から # と HTML コメントの印を外して省略記号、差分の印を欄に分ける、pre に tabindex、skill の id にハッシュ、セッションの区切り。残した P2: 「ファイル不明」の項目(注入の形から特定できないもの。説明を添えた)。

#### 見直し(2026-11-02、Phase 11 のレビュー: P1 2 件・P2 7 件を直した)

1. **P1 不透明データの判定が全ての JSON 値に掛かっていた**: ツールの引数やファイルの内容にある 100 字以上の英数字列(16 進ダンプ、区切り線)が除外されていた。`looksOpaque` は reasoningBlocks の配下だけに掛け、他は秘密情報の形式検査だけにした。coverage に扱い `partial`(reasoningBlocks: 要素の中の base64 らしい値だけ除外)を足し、全文記録が実際に除外した箇所を `excludedN` / `excludedBytes` に数える(`CoverageCounter.addExcluded`)。
2. **P1 result の content と detailedContent の両方があると content が落ちていた**: 両方あって異なれば `result.content:` と `result.detailedContent:` を別々に、同じなら 1 回だけ書いて「同一」と記す。
3. **P2 文字列でない本文が黙って落ちる**: content / reasoningText / system.message.content / skill の content / summaryContent が文字列でなければ JSON の囲みに出す(`block`)。`used.add` は出力した分岐の中だけ。
4. **P2 シンボリックリンク・ジャンクション**: `walk` で辿らず、`extras.skipped` に「シンボリックリンク / ジャンクション(辿らない)」で残す(fixture のジャンクションで検査)。
5. **P2 削除の同期**: 元に無いファイルは複製先から消す(`copyTree` と追加のファイル、直下のフォルダ、chats の `*.md`。session.db と同じ作法)。`--snapshot-all` を外したときも写さなくなったものを消す。
6. **P2 ファイル単位の失敗**: `copyTree` / 追加のファイル / chats は 1 ファイルずつ catch し、`複製できなかった (EBUSY 等)` で skipped に積む(全体は止めない)。
7. **P2 生成物を黙って消さない**: `out/full/`・`coverage.json`・`instructions.html`・`library/` は、作り直すときと伏せ字モードのときだけ消す。素の build や --full なしの export では残し、「前回の … が残っています(生成日時)」をログに出す(`BuildResult.stale`)。README に古い全文記録が残る点を書いた。E2E d. を改めた。
8. **P2 テストの穴**: fixture の資格情報にトークンの形でない値(accounts / settings / model_providers / logs)を足し、許可外の列の値(remote_connect_target、empty_execution_failure_event_json、activity_items.metadata_json、projects.setup_script / instructions、workspaces.session_bootstrap_config)も out/ に出ないことを E2E で見る。
9. **P2 メモリ**: events.jsonl は `parseEvents`(1 行ずつ)で 1 回だけ走査し、閲覧ページの収集と全文記録の書き出しを同じ走査で行う。全文記録は `renderFullTo` が 64KB ごとに sink へ渡し、build は `createWriteStream` の `write` の戻り値で drain を待つ(backpressure)。`JSON.stringify` は値 1 つ単位(最大はツール結果 1 件)。出力の形は変えていない(明細の件数は末尾の「明細」の節に移した)。

測り直し(実データ 800 セッション): 全文記録 376MB(309MB → 365MB の書き出し。引数と結果の長い英数字列を除外しなくなった分が増えた)、除外 27,714 箇所 114.9MB(excluded 3 キー 91.4MB + partial の reasoningBlocks 4,158 箇所 23.5MB。reasoningBlocks 24.6MB のうち読めるのは約 1MB)、未分類 0、秘密情報の形式検査 11 件。~/.copilot の data.db-shm / -wal の mtime は不変。

#### 見直し 2(2026-11-02、Phase 11 の残り P2 を直した)

- **sink の error**(P2-A / B): `createFileSink`(full.ts)が stream の error を生成時に 1 回だけ受けて保持し、write / finish のたびに検査する。drain 待ちは error でも解ける(永久に待たない)。write ごとに `once('error')` を積まない。
- **壊れた記録**(P2-C): `<id>.md.tmp` に書いて成功時に rename。失敗時は destroy と tmp の削除をして、build を失敗にする(黙って残さない)。stale の判定は coverage.json が無くても `full/` の存在で見る。
- **大文字小文字だけの改名**(P2-D): `pruneTree` が削除の前に元の実在を確かめ(大文字小文字を区別しないファイルシステムでは残る)、削除で空になったフォルダも消す。
- **--snapshot-all の残り**(P2-E): 通常の snapshot では前回 `--snapshot-all` で写したもの(元にまだあるもの)を消さず、manifest の `extras.leftover`(パスと日時)とログに出す。`--snapshot-prune` で消す。元から消えたものは従来どおり消す。
- **walk の失敗**: 読めないフォルダ(EPERM / EACCES)はフォルダ単位で catch して skipped に「読めなかった」で積む。セッションフォルダ自体が読めないときも同じ。
- テスト: sink の正常系(drain 待ち)・abort・開けない場所(ENOENT で待たない)、ファイル単位の失敗(複製先に同名フォルダ)、大文字小文字だけの改名、leftover の残存と `--snapshot-prune`。

### Phase 12: 改善点の分析(2026-11-02)

動機(ユーザーの言葉): 「このツールで全てのことを完結したい。単純なセッションの出力や、全ての要素を含めた完全なセッション出力。ボトルネックな指示やスキルなど、新たにスキル化できそうなものなど」。出力の 2 種類(セッション記録・全文記録)は Phase 8 と 11 で済んだので、分析を足す。

契約:

1. **LLM を呼ばない規則の集計**。atlas.html の絞り込みに従うもの(指示文・skill・時間の使われ方)はレポート内で `SessionSummary` から再計算し、本文が要るもの(スキル化の候補)は build / export 時に `sessions.json` の本文(依頼文の先頭・ターンごとのツールの列)から計算して結果だけ埋め込む(5MB 制約を守る。候補の全文と表の全件は別ページ `out/insights.html` に置く)。サイドバーに「改善点」の節(id `insights`、群「概況」の「要点」の次)。各項目から根拠のセッションの詳細ページ、指示文の版(instructions.html#v-<hash>)へ移動できる。
2. **ボトルネックの指示文**: 版(contentHash)ごとに、文字数、注入されたセッション数、ツールの失敗率(失敗 + 拒否 / 結果のある呼び出し)、手戻り率(同じファイルを 2 回以上編集したセッションの割合)、compaction / セッション、出力トークン / セッションを比べる。同じ見出しの版を初回の順に並べ、「長いのに注入が少ない」(文字数が全版の上位 25% かつ注入セッション数が閾値未満)と「版を変えた前後で悪化」(前後ともセッション数 ≥ 閾値で、失敗率か手戻り率が 10 ポイント以上悪化)を挙げる。
3. **ボトルネックの skill**: skill ごとに、呼び出し回数(利用者 / エージェント)、本文の大きさ(skill.invoked の content の文字数、無ければ記録なし)、呼び出したセッションの失敗率と呼び出さなかったセッションの失敗率、出力トークン / セッション、インストール済みで未使用のもの。
4. **時間の使われ方**: セッションごとに、待ち時間(TTFT と全体の中央値、記録のあるモデル)、失敗の連続(ツール失敗の最長連続回数)、同じファイルの再編集(2 回以上編集したファイル数と余分な編集回数)、権限確認の数、compaction の数を並べ、止まっている箇所(閾値以上のもの)をセッション単位とプロジェクト単位(該当セッション数 / セッション数)で出す。
5. **スキル化の候補**: (a) 似た依頼文の繰り返し: 依頼文を正規化(小文字、パス・URL・数字・記号を印に置換、空白を詰める)して文字 3-gram の集合を作り、Jaccard 類似度 ≥ 0.6 のものを貪欲に束ねる(LLM なし)。(b) 同じツールの並びの繰り返し: 本体のターンごとのツール名の列から、長さ 3〜6 の部分列で 3 回以上(2 セッション以上)現れるものを数え、長い方を優先して重なりを除く。どちらも繰り返し回数、関係セッション、推定の所要時間(各出現のターンの所要の中央値 × 回数)、代表の依頼文(最も中央に近いもの)を持ち、スコア(回数 × 所要時間の中央値)の順に出す。
6. **統計の誠実さ**: 分かるのは相関までなので、画面と README に「傾向」と書き、指示文の効果は直接測れない(同じ版でも依頼が違う)と明記する。閾値は `lib/insights.ts` の定数: `MIN_SESSIONS = 5`(率を出す最小のセッション数。5 件未満の率は 1 件で 20 ポイント動くため結論にしない)、`MIN_REPEAT = 3`(候補の最小の繰り返し。2 回は偶然でも起きる)、`SIMILARITY = 0.6`(3-gram の Jaccard。言い回しの違いを許しつつ別の依頼を混ぜない値として実データで確かめる)、`WORSE_POINTS = 10`(悪化とみなす差。MIN_SESSIONS=5 での 1 件分 20 ポイントの半分)、`STUCK` の各閾値(TTFT 中央値 ≥ 20 秒、連続失敗 ≥ 3、再編集 ≥ 3 回、権限確認 ≥ 10、compaction ≥ 3。実データの分布の上位 10% 付近)。閾値未満の項目は件数を添えて「傾向」の表には出さない。欠測は既存の語(記録なし / 推計不可 / —)で区別する。
7. **伏せ字版**: 依頼文の本文と指示文の見出し、skill 名以外の自由記述は出さない。件数とスコアだけは出す。候補の代表文は出さない。insights.html も伏せ字版では候補の本文を持たない。
8. **LLM による下書き(任意)**: `atlas skill-draft <番号>` は `out/insights.json` の候補(番号)からスキルの下書き(SKILL.md の形)を作る。判定と同じバックエンド経路(copilot-cli / opencode / anthropic、`--backend` / `--model`)を使い、明示したときだけ動く(既定の処理では呼ばない)。クレジットを消費する実行はテストでも実データでも行わず、偽の copilot(fixtures/fake-copilot.mjs、`ATLAS_COPILOT_BIN`)で検査する。出力は `out/skill-drafts/<番号>-<名前>.md`。費用(1 回の生成で 1 リクエスト相当)は README に書く。

検査: 単体(各規則の境界、閾値未満の扱い、版の前後比較、正規化と類似度、部分列の数え方と重なりの除外、スコア順)。E2E(fixture で insights.html と insights.json ができる、伏せ字で本文が出ない、外部参照なし、atlas.html 5MB 未満、skill-draft が偽の copilot で下書きを書く)。実データで生成して候補の上位を自分で読み、役に立たない候補(定型の Reply OK、判定の繰り返しなど)が上に来るなら除外の規則を足して結果を PLAN.md に書く(本文は転記しない)。画面は 1440 / 1024、impeccable critique / audit、web-design-guidelines、ui-ux-pro-max(「actionable insights」で 1 回)。README と surface brief を更新。

#### Phase 12 の実施(2026-11-02)

- 置き場所: 規則は `packages/report/src/lib/insights.ts`(純関数、`THRESHOLDS` を 1 か所に)。core は `SessionRecord.analysis`(手戻り・失敗の連続・本体のターンごとのツール列と所要・依頼文の先頭 300 字、schema 6)。`SessionSummary` に `skillChars` / `instructionVersions` / `analysis`(data version 7)。レポートの節は `Insights.svelte`、全件は `insights-page.ts`(`out/insights.html`)と `out/insights.json`(version 1)。`atlas skill-draft` は `packages/judge/src/skill-draft.ts`。
- 実データ(800 セッション)での候補の見直し。最初の上位は役に立たないものだった: (1) 動作確認の定型文(行頭が reply with / respond with など)が依頼文の候補の上位 → `PROBE_REQUEST` で除外。(2) ツールの並びは `view → task → view` や `sql → rg → view` など閲覧中心の汎用の手順が上位を独占 → 閲覧系(`EXPLORE_TOOLS`)以外のツールが 2 種類以上(`SEQ_MIN_WORK = 2`)でないと候補にしない。連続の重複は潰し(`collapseRuns`)、`a → b → a → b` の周期的な繰り返しは除く(`isPeriodic`)。(3) ターンの所要に次の依頼までの待ちが入って数時間になっていた → ターンの最後のイベントまでに変更し、スコアの所要は 2 時間で頭打ち(`SCORE_MS_CAP`。自律実行の長いターンが回数より効きすぎないように)。(4) 同じセッションの同じ依頼文が例に重複 → 例は重複なし。(5) 「長いのに注入が少ない」に同じ見出しの旧版が並んだ → 見出しごとに最新の版だけ。見直し後の候補は 78 件(依頼文 4、ツールの並び 74)で、上位は `ask_user → apply_patch → sql` の繰り返し(4 セッションで 24 回)や編集と実行の往復など、作業の手順として読めるものになった。本文は転記しない。
- 残る限界: ツールの並びの候補は「手順の繰り返し」であって「スキルにすべき」とは限らない(スコア順は目安)。依頼文の候補は本文の先頭 300 字の 3-gram なので、長い依頼の後半の違いは見ない。指示文の「前後比較」は同じ見出しの連続する版だけで、同時期の他の変化(モデル・依頼の種類)は切り分けない(画面に明記)。
- Fable レビューの P2 への対応: `skill-draft` の作業フォルダを `atlas-judge-cwd-` に揃えて「(atlas の判定)」に分類させた。バックエンドは契約どおり copilot-cli / opencode / anthropic の 3 つにした(anthropic の呼び出しは `anthropicMessage` に切り出して判定と共有。本物の実行は未確認)。「長いのに注入が少ない」は全体での希少さなので、画面の絞り込みに関わらず全セッションで計算し、母集団が MIN_SESSIONS 未満なら出さない。
- 検査: 単体 120 件(Phase 12 は 6 件: 版と前後比較の境界、skill の率と未使用、止まっている箇所の理由と順序、正規化と Jaccard、依頼文の候補と伏せ字、並びの重なりとスコア順)。E2E 65 件中 57 通過・8 skip(Phase 12 は 3 件: 生成物と埋め込み、伏せ字、偽 copilot での skill-draft と拒否)。fixture に繰り返し用の 3 セッション(`addPhase12Fixtures`)を足した。
- 画面: 1440 ライト / 1024 ダークで横はみ出し 0、ページエラー 0(`.impeccable/critique/phase12-insights/`)。ui-ux-pro-max は「actionable insights」で 0 件、「data table dashboard insight」で表の横スクロール(既存の `.ledger` の包みで対応済み)。impeccable critique / audit と web-design-guidelines の結果は下の「見直し」に。
- サイズ: 実データで atlas.html 1.85 MB(埋め込み 1.64 MB)、insights.html 0.5 MB、insights.json 0.33 MB。
- 見直し(reviewer の critique / audit + WDG、同日): P1 を 3 件直した。(1) 伏せ字版で依頼文の候補の `key`(正規化した本文)が埋め込みデータと insights.json に残っていた → `request-<n>` にし、E2E で通常版の key が伏せ字版の両方に無いことを見る。(2) insights.html の指示文の見出しを esc していなかった → esc(ハッシュも)。(3) 止まっている箇所のプロジェクト別が 1 / 1 のプロジェクトで埋まっていた → 総数 5 未満は出さず、該当数の順。P2: 件数不足の率は全件ページでも「—」(README も揃えた)、スコアの「2 時間で頭打ち」を説明に、閾値の単位、「詳しく →」に aria-label、箱の最小幅 480px(1440 で 2 列)、プロジェクト別は短いラベル。P3 のうち周期 3 の往復の除外(isPeriodic maxPeriod 3)だけ採った。残した P3(率の小数桁、行見出しの th、.table-scroll の tabindex、「失敗率(呼ばない)」の情報量)は帳票の作法を全体で揃える話なので保留。

### Phase 13: セッションごとのメモ(2026-11-03)

動機: Phase 10 第 1 段で「将来はセッションごとのメモ(Markdown + 画像)を足す」とし、`atlas-notes/` を置き場に決めたまま先送りしていた。集計の数字だけでは残らない「なぜこのセッションが良かった / 悪かったか」を、利用者本人が根拠のセッションに書き残す。

契約:

1. **置き場**: `<notes-dir>/memos/<id>.md`(1 セッション 1 ファイルの素の Markdown。索引のファイルは持たない)と、画像の `<notes-dir>/memos/<id>/<名前>`。本文からは `![説明](<id>/<名前>)` の相対パスで参照するので、Obsidian や VS Code でもそのまま読める。手で置いた `.md` と画像も同じに扱う。`atlas-notes/` は Git の対象外のまま。id はファイル名に使える形(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$`)だけ受け付ける(`..` を通さない)。
2. **描画**: Node 側で marked(GFM、改行は `<br>`)を使い、renderer を差し替えて出力を組み立てる。生の HTML はエスケープして文字として出す。リンクは http / https / mailto だけ(それ以外は文字だけ)。見出しは 2 段下げる(節の h2 の下に入れる。h3〜h6)。画像は `<id>/` の直下の png / jpeg / gif / webp だけを読み、data: URI で埋め込む(詳細ページが単独で完結し、out/ に複製を持たなくて済む。外部参照の検査も変えない)。外部の画像は読み込まず「外部の画像(読み込みません)」のリンクにする。無い画像は欠測の語で 1 行出す。
3. **詳細ページ**: 表題の直下、概要の前に「メモ」の節。メモがあれば目次の先頭に出る。メモが無いページでは節は `hidden` で、file:// では何も見えない。CSS はメモのあるページだけに入れる(800 ページに同じ CSS を足さない)。
4. **編集(atlas serve から開いたとき)**: 編集の動きは静的ページに埋め込まず、`GET /api/memo-editor.js` を NAV_JS が serve のときだけ読み込む(file:// と共有用には 1 行も増えない)。読み込むと API の内容で節を描き直す(ビルド後に書いたメモも再読み込みで出る)。「メモを書く / 編集」→ テキスト欄(インライン、ダイアログにしない)→「保存」。Ctrl+S / Ctrl+Enter で保存。画像は貼り付け・ドロップ・「画像を追加」(キーボードで届く入口)。カーソル位置に Markdown を挿入する。本文を空にして保存するときと、入力のある取消のときだけ確認を 1 回出す(初期フォーカスは「やめる」)。保存していない入力があるまま離れるときはブラウザの確認を出す。サーバが止まったら編集の入口を消し、編集中なら入力を残して保存できない理由を出す。
5. **API**: `GET /api/memos/<id>` → `{ text, rev, html, updatedAt }`。`PUT /api/memos/<id>` `{ text, rev }`(rev は本文の sha256 の先頭 16 桁、無ければ '')。手元の rev と違えば 409 と最新の rev を返し、画面は入力を残して「別の場所で更新されました」と「上書きして保存」を出す(Obsidian や CLI と同時に触っても黙って消さない)。`POST /api/memos/<id>/images`(本文は画像そのもの、上限 10MB。形式は Content-Type ではなく先頭のバイトで判定。svg は通さない)→ `{ name, markdown }`。ファイル名は内容の sha256 の先頭 16 桁。`GET /api/state` に `memos`(id → 概要)を足す。書き込みの token・Origin の検査はグループと同じ。本文の書き込みは一時ファイル → rename。
6. **一覧**: `SessionSummary.memo`(先頭 80 字の抜粋・字数・画像数・更新日時。全文は atlas.html に埋め込まない)。セッション名の下に「メモ: 抜粋」を 1 行。「その他の条件」に「メモのあるセッションだけ」(`FilterState.memo`、hash に載せる)。メモが 1 件も無ければ出さない。編集モードでは `api/state` の値を使う。
7. **CLI**: `atlas memo list` / `show <id>` / `set <id> <本文...>` または `--file <path>` / `remove <id>`。id は先頭一致で解決(sessions.json があるとき)。`remove` は `.md` だけを消す(画像は残す。誤操作で戻せなくなるものを広げない)。
8. **伏せ字**: `--anonymize` ではメモを一切出さない(節・目次・一覧の抜粋・件数・絞り込み)。API は既存の判定で 403、エディタも配らない。
9. **判定には渡さない**: メモは bundle / judge / セッション記録 / 全文記録に入れない。利用者の自由記述を LLM や共有用の出力に黙って流さないため。

検査: 単体(描画の安全性: script・イベント属性・javascript: リンク・外部画像・`..` を含む画像・無い画像、見出しの段、`://` の実体参照、抜粋、読み書きと rev の競合、画像の判定、一覧の読み取り、filter の hash と matches、serve の API と token・400・409・413・415・403、CLI の解釈と runMemo)。E2E(fixture のメモで詳細ページ・埋め込み・外部参照の検査・伏せ字での非出力、CLI の往復、~/.copilot を書き換えないこと)。ブラウザ(架空データ、別の out / notes-dir で): 書く → 保存 → 再読み込み → 画像の貼り付け → 一覧の抜粋 → 絞り込み → 競合 → 削除 → サーバ停止、1440 ライト / 1024 ダーク。impeccable の検出器、設計契約 + web-design-guidelines の照合、ui-ux-pro-max(「inline editor markdown notes」で 1 回)は従来どおり。README と surface brief を更新。

#### 実施(2026-11-03)

- 置き場所: 形と抜粋は `lib/memo.ts`(ブラウザと Node で共用)、読み書きは `memo-io.ts`、描画は `memo-render.ts`、編集の script は `memo-editor.ts`(文字列で持ち `GET /api/memo-editor.js` で配る)。CLI は `runMemo`、API は `serve.ts` の `memoApi`。`ReportData` は version 8。
- 依存を 1 つ足した: `marked`(MIT、依存なし)。Markdown の自作は表やリストの入れ子で誤りやすいので採らなかった。使うのは Node 側だけで、atlas.html には入らない(`lib/` から import しない)。
- 自分で決めたこと(戻し方は git): CLI の名前は `memo`(`--note` と紛らわしい `note` を避けた)。置き場は `<notes-dir>/memos/`。画像は out/ に複製せず data: URI にした(詳細ページが単独で完結する)。プレビューは付けない(保存すれば同じ場所に描かれる)。保存時に参照の無くなった画像は消さない(取り消しの手段が無いため。`remove` と本文の削除も画像を残す)。
- ブラウザ(架空データ、別の out / notes-dir、Claude の組み込みブラウザ。1440 ライト / 800 ダーク): 「メモを書く」→ 入力 → 画像の貼り付け(DataTransfer で合成)→ Ctrl+S → 再読み込み → 一覧の「メモ: 調べた理由」→「メモのあるセッションだけ」(表示中 11 → 1、`#memo=1`、1 条件)→ ファイルを外から書き換えて保存(「別の場所でメモが更新されました」、入力は残る)→ 上書きして保存 → 入力ありの取消(確認 → やめる で入力が残る)→ 空にして保存(確認 → 削除、.md だけ消えて画像のフォルダは残る)→ サーバ停止(5 秒で帯、保存と画像追加が無効、入力は残る)。横はみ出しなし。見つけて直したもの: `.memo-actions` の `display:flex` が `hidden` に勝って編集中も「メモを書く」が出ていた。
- 大きな本文: 上限を超えた本文を読み切らずに例外にすると、送信中の相手が応答を受け取れない。最後まで読み捨ててから 413 にした。実測(別プロセスの fetch、各 8 回): 1KB 201 / 4ms、5MB 201 / 22ms、10MB 201 / 41ms、10MB+1 バイト 413 / 30ms、30MB 413 / 85ms。**同じプロセスの fetch で 10MB を送ると Windows で event loop ごと止まる**(タイマーも AbortSignal も発火しない。別プロセスでは起きないのでブラウザには関係しない)ので、単体テストは `memoImageLimit` で上限を小さくして境界を見る。
- 静的検出と照合: impeccable の検出器(`detect.mjs`、静的)は変更ファイルで 0 件。ui-ux-pro-max(`--domain ux`、検索語「inline editor markdown notes」、1 回): Forms / Error Placement を採用(失敗の枠をテキスト欄に `aria-describedby` で結ぶ)、Forms / Focusable Error Summary を採用(失敗したらテキスト欄へ焦点を戻す)、Forms / Inline Validation は採らない(本文に検証する項目が無い)。

#### 見直し(2026-11-03、reviewer の審査: P1 1 件・P2 4 件と P3 の多くを直した)

1. **P1 編集の開始と読み込みの競合**: 読み込み前に「編集」を押すと空の欄が開き、後から rev だけ最新になるので、1 行書いて保存すると既存の本文が 409 なしで置き換わっていた。取消の直後も同じ。初回の読み込みが終わるまで「編集」を出さず、押すたびに GET し直してから欄を作り、編集中は読み込みの結果で memo を書き換えない。
2. **P2 同時保存**: 確認と書き込みの間に別の PUT が入ると lost update になり、一時ファイル名も同じだった。serve で id ごとに直列化し、一時ファイルは randomUUID の名前にした。4 本同時で 200 が 1 本、409 が 3 本になることを単体で見る。
3. **P2 古い serve**: 古い serve の `/api/state` には memos が無く、空のマップが埋め込みを上書きしていた(`atlas.bat` は動いているサーバを使い回すので起きうる)。無ければ埋め込みのまま。
4. **P2 手で置いた画像の名前**: 英数字だけの許可リストで、`Pasted image 1.png` や日本語の名前が読めなかった。Windows で使えない文字・先頭の `.`・末尾の `.` と空白・予約名を拒否する形に改めた(`isSafeFileName`)。
5. **P2 既存の node_modules**: bat は node_modules が無いときだけ npm install するので、`marked` を足すと既存の環境で起動しなくなる。`scripts/deps-fresh.mjs`(lock と `node_modules/.package-lock.json` の版を比べる。node: だけで動く)で判定する形に 4 つの bat を変えた。mtime の比較は git の checkout で毎回 install になるので採らなかった。
6. **P3 で直したもの**: 画像の追加中は保存と取消を止める、保存の失敗時にテキスト欄へ焦点を戻す、Ctrl+S は欄の外でも効く、サーバ停止後の取消で未処理の例外を出さない、伏せ字版で `#memo=1` を捨てる、抜粋が語の中の `_` `*` `~` を消さず front matter と区切り線を飛ばす、h4〜h6 の大きさ、手で置いた画像にも 10MB の上限、id と画像名の Windows の予約名、Host の検査(DNS rebinding。静的ページも API も)。
7. **検査**: typecheck 0 / 0、単体 163 通過(22 ファイル、連続 3 回)、E2E 63 通過 / 8 skipped(9 ファイル)。ブラウザで編集の流れを撮り直した(開いたままのページから「編集」を押すと外で更新された本文から始まる、空白を含む名前の手で置いた画像が出る、ボタンに焦点があっても Ctrl+S が効く)。`atlas.bat` のダブルクリックでの確認は未実施(`scripts/deps-fresh.mjs` の判定は単体で見た)。
   実データ(801 セッション、うち非空 201)でも、`--out` と `--notes-dir` を一時フォルダにして確認した: 全 id がメモの条件を満たす、書く→画像→Ctrl+S→表示(生の script は文字のまま)、一覧の抜粋と `#memo=1`(2 / 201)、`atlas memo` の先頭一致と曖昧な id の拒否、CLI の更新と画面の保存の競合(古い本文からの削除も止まる)、再 build でメモが残る、伏せ字版・bundle・metrics にメモが入らない、タブを閉じると serve が止まる。本物の `atlas-notes/` と `out/` は変更なし。`file://` の表示は確認環境で見られず、ファイルの内容の検査まで。
8. **残した P3**: 詳細ページの目次はメモの有無に追従しない(ビルド後に書いたメモは節に出るが目次には次の build まで出ない。削除しても項目が残る。節は表題の直下で常に見えるので目次の項目が無くても届く)。

### `all` でもセッション記録を作る(2026-11-03)

動機: `atlas.bat`(`all`)で開いた詳細ページに経過が無く、記録は `atlas-export.bat` でしか作れなかった。さらに export の後に `atlas.bat` を実行すると build が `.md` とリンクを消す。どの bat で作ったかで経過が見えたり消えたりするのは、使う側に分かりにくい。

実測(実データ 802 セッション、同じスナップショットを一時フォルダに置いて。本物の out/ は使わない): build 1.16〜1.27 秒 / export 6.21〜6.36 秒(各 3 回)。bat の通し(2 回目以降)は `all` 5.9 秒 / snapshot+extract+export 11.6 秒(各 2 回で同値)。容量は記録 802 件で 11.4MB、詳細ページのリンクで +0.5MB、`instructions.html` と `library/` で約 1.2MB。out/ 全体 597MB(うち snapshot 553MB)の約 2%。Phase 5 で別コマンドにした理由(時間と容量)は、実測では小さい。

決めたこと:
1. `all` の最後を build から export(既定の `--tool-output fail`、上限 20,000 字、`--full` なし)にする。`atlas.bat`・`npm run atlas` が記録を作る。
2. 伏せ字版(`all --anonymize`)は記録を作らず build のまま。記録の伏せ字は自由記述を機械的に置き換えるだけで HTML より弱く、共有する `sessions/` に混ざるため。必要なら `export --anonymize` を明示する。
3. `atlas-judge.bat`(judge-flow)の最後の build も、伏せ字版でなければ export にする(直前の `all` が作った記録を消さない)。
4. `atlas-export.bat` は残す(`export` の引数を渡す入口)。素の `build` が `.md` を消す規則は変えない(絞り込みで外れたセッションの古い記録を残さないため)。
5. README の共有の説明を、`.md` を渡さない形に直す(`out/sessions/` に生の記録が常にあるため)。配布物の確認(`release-smoke.ts`)に記録ができることを足す。

見直し(独立レビュー PASS、P1 なし): P2 として、README の「伏せ字でない HTML はそのまま渡せる」が事実と違う(詳細ページと atlas.html にも最初の依頼と最後の応答が入る)ことと、記録の用途が「共有用」のままだったことを直した(共有は伏せ字版だけ)。P3 として、judge-flow の最後が export で記録を消さないこと・伏せ字版で消えること(phase3 c2)と、同じ out/ で通常版の後に伏せ字版を作っても生の記録が残らないこと(phase2 c)を E2E に足し、README の所要時間と PRODUCT.md の手順を直した。atlas-judge.bat は all と judge-flow で export を 2 回走らせる(+5 秒ほど)が、判定の後に記録を作り直す必要があるので残した。

採らなかった案: 詳細ページを開いたときに serve がその場で記録を作る(起動は速いままだが file:// で使えず、作りも複雑)。記録が無いときの案内だけを足す(つまずく場面が残る)。

### Phase 14(設計): 画面からの操作 — 起動は atlas.bat 1 つ(2026-11-03、設計 → 実装。実施は節の末尾)

動機: 起動用の bat が 4 つあり(`atlas` / `atlas-export` / `atlas-export-full` / `atlas-judge`)、「何をしたいか」を起動前に bat の名前で選ばせている。serve の画面でできるのは閲覧・グループ・メモだけで、集計し直す・全文を見る・判定するには、画面を閉じて別の bat を起動し直す必要がある。serve(Phase 10〜13)で、token と Origin / Host の検査を持つ書き込みの土台はすでにある。当初の「ローカルサーバ型ダッシュボードは採らない」(下の「採らなかった案」)は、HTML 単体で file:// でも共有でも読めることが理由で、その性質はこの設計でも変えない(サーバは操作のためだけに使い、生成物は今どおり静的ファイル)。

**目標**: 利用者が起動するのは `atlas.bat` だけ。起動後の操作はすべて画面から。CLI(`npm run atlas -- <コマンド>`)は今のまま残す(自動化と細かい指定はこちら)。

**調べた前提**(コードで確認): serve の API は `heartbeat` / `state` / `groups` / `memos` / `memo-editor.js` だけ(`packages/cli/src/serve.ts`)。書き込みは token(`X-Atlas-Token`)・`Sec-Fetch-Site` / `Origin`・`Host` を検査し、伏せ字版の out/ では 403。記録は `renderTranscript`、全文は `renderFullTo` がセッション 1 件ずつ呼べる(`packages/report/src/transcript.ts`・`full.ts`。ただし今は `buildReport` の中からしか呼んでいない)。判定は 1 件ごとに judgments.json を一時ファイル + rename で確定する(`judge/src/run.ts`・`judgments-io.ts`)ので、途中で止めても判定済みの分は残る。`export --session <id>` は atlas.html もそのセッションだけで作り直すので、1 件の全文を作る用途には使えない。

#### 契約

1. **画面の操作と実体**

| 画面の操作 | 置き場所 | API | 実体 |
|---|---|---|---|
| 集計し直す | atlas.html の上部(ジョブの帯) | `POST /api/jobs {kind:"refresh"}` | 子プロセス `main.ts all --out <out> --notes-dir <notes>` |
| 記録を読む | 詳細ページ(serve のときだけ) | `GET /view/<id>?kind=transcript` | out/sessions/<id>.md を安全に HTML にして返す(下記 4) |
| 全文を作って読む | 詳細ページ(serve のときだけ) | `POST /api/jobs {kind:"full", id}` → 終わったら `GET /view/<id>?kind=full` | サーバ内で 1 件だけ `renderFullTo` を呼び out/full/<id>.md を書く(新しい関数。atlas.html・coverage.json は触らない) |
| 工数を判定する | atlas.html(確認ダイアログ付き) | `POST /api/jobs {kind:"judge", limit, backend}` | 子プロセス `judge-flow.ts --limit <n> --backend <b>`(bundle → judge run → export) |

2. **ジョブ**: 同時に 1 つだけ(実行中に別の POST は 409)。`GET /api/jobs/current` → `{ id, kind, state: "running" | "done" | "failed" | "canceled", startedAt, endedAt, exitCode, log }`(log は子プロセスの stdout / stderr の末尾 200 行)。`POST /api/jobs/current/cancel` は判定と集計で子プロセスを止める(判定は 1 件ずつ確定済みなので途中までの結果が残る。集計は中断した旨を出し、次の集計で作り直す)。ジョブの実行中は heartbeat が途切れてもサーバを止めない(画面を閉じてもジョブは最後まで走り、終わってから idle の判定を再開する)。atlas.bat の窓にもジョブのログを流す。

3. **再集計の後の画面**: 自動では再読み込みしない(メモの入力中を守る)。帯に「新しい集計ができました」と「再読み込み」を出す。集計中は build が `out/sessions/` を消してから書くので、その間に詳細ページを開くと 404 になりうる。帯に「集計中(詳細ページは終わるまで開けないことがあります)」と出し、serve の 404 は「集計中です」の文面にする(書き出しを一時フォルダ経由の入れ替えにする案は、Windows で開いているファイルがあると rename が失敗するので採らない)。

4. **記録と全文の表示**(`GET /view/<id>?kind=transcript|full`): サーバが .md を HTML に描いて返す。描き方はメモと同じ規則(`memo-render.ts`: 生の HTML は文字のまま、リンクは http / https / mailto だけ、外部の画像は読まない)。全文の画像は out/full/assets/<id>/ への相対参照だけを通す。上限(全文 20MB)を超えるものは描かず、.md を直接開くリンクと大きさを出す。file:// で開いた詳細ページには出さない(今の「セッション記録(Markdown)を開く」リンクは残す)。

5. **安全**
   - 実行系の API(jobs)はすべて token・Origin / Sec-Fetch-Site・Host を検査する(既存の書き込みと同じ)。GET の `/api/jobs/current` と `/view/` も token を要求する(ログと本文に生の文字列が入るため)。
   - 子プロセスの引数はサーバが固定の配列で組み立て、`shell: false` で `process.execPath` を起動する。画面からの文字列をコマンドラインに入れない。`id` は `isSafeMemoId` と sessions.json にあることを確かめる。`limit` は 0〜500 の整数、`backend` は `copilot-cli` / `opencode` の列挙。
   - 伏せ字版の out/ を配信しているときは、実行系も 403(既存の規則のまま)。

6. **費用**: 判定は GitHub Copilot の AI クレジット(既存サブスクの範囲)を消費する。opencode は利用者の opencode の既定のモデル。画面の確認ダイアログに対象の件数(未判定のうち limit まで)・バックエンド・「AI クレジットを消費します」を出し、既定の limit は 10。従量課金の anthropic は画面に出さない(CLI の `--backend anthropic` だけ)。

7. **bat**(利用者が決定): `atlas.bat` だけを残し、`atlas-export.bat` / `atlas-export-full.bat` / `atlas-judge.bat` は消す。README・release-smoke(bat の数)・launchers.test を直す。CLI のコマンドはすべて残す。全件の全文と coverage.json(解析用の一括出力)は `npm run atlas -- export --full`、伏せ字版は `npm run atlas -- all --anonymize` で作る(画面からは作らない。下の「決めたこと」)。

#### ゲート

- 単体(serve.test): jobs の 409(同時実行)・403(token なし・他オリジン・別の Host)・引数の検証(不正な id・limit・backend・kind)・`/view/` の描画(script が文字のまま、外部画像なし、相対画像だけ)・上限超えの扱い。子プロセスは差し替え可能にして速く回す。
- E2E(fixture): serve を起動して refresh のジョブを流し、終わるまで待って atlas.html が作り直されること、ジョブ中に heartbeat を止めてもサーバが止まらないこと、full のジョブで out/full/<id>.md だけができ atlas.html と他の全文が変わらないこと、偽 copilot で judge のジョブ(phase3 と同じ)と確認なしでは走らないこと(API は件数を明示した要求だけ受ける)、cancel。
- 画面の操作(ui/ の Playwright、`npm run ui`。2e47ba8 で入った仕組みに足す): 「集計し直す」→ 帯が実行中から完了に変わり「再読み込み」で新しい集計が出る、判定の確認ダイアログで「やめる」なら API を呼ばず「実行」なら偽 copilot で判定が増える、詳細ページの「記録を読む」「全文を作って読む」で本文が描かれ script が実行されない。どの画面でも pageerror と console.error が無いこと。
- 画面の見た目: Claude の組み込みブラウザで、ジョブの帯(実行中・完了・失敗)・確認ダイアログ・記録の表示を 1440 ライト / 800 ダークで確認。impeccable の検出器と web-design-guidelines の照合(Phase 13 と同じ扱い)、surface brief の更新。
- 実データ: 一時の out / notes-dir で refresh・full(大きいセッション 1 件)を流し、所要時間を確かめる。判定は実行しない(クレジットを消費するため。利用者の確認がある場合だけ)。

#### 決めたこと(2026-11-03、利用者の判断)

- bat は `atlas.bat` 1 つにする(上の 7)。
- 判定は画面から実行できるようにする。確認ダイアログ付きで、既定は 10 件、従量課金の anthropic は出さない(上の 6)。
- 共有用の伏せ字版を画面から書き出す機能は作らない(不要)。CLI の `--anonymize` は今のまま残す。

後回しにした案: atlas.bat を「前回の out/ があれば先に画面を開き、集計は画面の中で走らせる」形にする(起動直後から見られるが、古い集計を見せる時間ができ、画面の状態が増える。上の契約が動いてから検討する)。採らなかった案: 記録を開くたびにサーバがその場で作る(Phase 13 の後の計測で、全件を先に作っても +5 秒・+13MB と小さかった。.md は LLM に渡す用途にも要る)。

#### 実施(2026-11-03)

作ったもの:

1. **ジョブ**(`packages/cli/src/jobs.ts`、serve から使う): `JobRunner`(同時に 1 つ。2 つ目は 409)、`parseJobRequest`(kind の列挙、知らないキーは 400、judge は `limit` が 0〜500 の整数で必須・`backend` は `copilot-cli` / `opencode` で必須、full は `isSafeMemoId` と sessions.json にあること(無ければ 404))、`jobArgs`(固定の配列: `main.ts all --out <out> --notes-dir <notes>` / `judge-flow.ts --limit <n> --backend <b> --out <out> --notes-dir <notes>`)。既定の起動は `spawn(process.execPath, args, { shell: false, windowsHide: true })`。止めるときは Windows では `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F`(judge-flow が起動した copilot を残さない)、他は SIGTERM。stdout / stderr は行に分けて末尾 200 行を残し、serve の窓(atlas.bat の窓)にも `[集計し直す] …` の形で流す。起動(`spawn`)・環境変数の追加(`env`)・全文の書き出し(`runFull`)は `ServeOptions.jobs` で差し替えられる。
2. **API**(`serve.ts`): `POST /api/jobs`(202 でジョブを返す)、`GET /api/jobs/current`(最後のジョブ。まだ無ければ `null`)、`POST /api/jobs/current/cancel`(動いていなければ 409)、`GET /api/jobs/judge-preview`(確認ダイアログの件数)。どれも token・Origin / Sec-Fetch-Site・Host を検査し、伏せ字版では 403。heartbeat が途切れてもジョブの実行中は止めず(`expire` が待つ。最初の heartbeat の待ちも同じ)、ジョブが終わってから猶予(idleMs)を測り直す。集計し直している間の 404(静的ページと記録の表示)は「集計し直している最中です…」の文面。
3. **全文 1 件**(`report/src/full.ts` の `writeFullRecord`): export --full と同じ `renderFullTo` / `createFileSink` で `out/full/<id>.md` と `out/full/assets/<id>/` だけを書く。網羅の集計はこの 1 件の中で数えて捨てる(`coverage.json` は書かない)。止めるときは AbortSignal をイベントの間で見て tmp を消す。
4. **記録の表示**(`report/src/viewer.ts`): `GET /view/<id>?kind=transcript|full` は殻(本文なし)、本文は `GET /api/view/<id>?kind=…`(token)が JSON で返す(下の「契約からのずれ」1)。描き方は `memo-render.ts` を `renderSafeMarkdown` に一般化して共用(メモの出力は変えない)。生の HTML は文字のまま、リンクは http / https / mailto だけ、外部の画像は読まない、全文記録だけ `assets/<id>/<名前>` の実在するファイル(画像は img、他はリンク)を `../full/assets/<id>/<名前>` で通す。先頭の `# 表題` はページの h1、`##` を h2 にして id を付け目次に(読んでいる節に印)。20MB を超えたら描かず大きさと「.md を開く」。見た目は詳細ページと同じ(page-nav、base.css、`.doc`)。
5. **画面**: atlas.html のマストヘッドに「集計し直す」「工数を判定する…」(`JobActions.svelte`)、本文の上に帯(`JobBand.svelte`、状態は `jobs.svelte.ts` の `JobStore` で共有。実行中は 1 秒、それ以外は 5 秒ごとに `api/jobs/current` を読む)。完了で「新しい集計ができました」+「再読み込み」(自動では読み直さない)。この画面のデータ(埋め込みの generatedAt)より後に始まった処理だけを出す。判定は `<dialog>`(件数の上限 既定 10、copilot -p / opencode、件数の行、「AI クレジットを消費します」、初期フォーカスは「やめる」、Esc・「やめる」では API を呼ばない)。詳細ページは NAV_JS が serve のときだけ `api/session-tools.js` を読み込み、表題の下に「記録を読む」「全文を作って読む」(`session-tools.ts`)。file:// と伏せ字版には何も出ない(静的な生成物は NAV_JS の読み込み先が 1 つ増えただけ)。
6. **bat と文書**: `atlas-export.bat` / `atlas-export-full.bat` / `atlas-judge.bat` を消した。`launchers.test.ts` は「直下の bat は atlas.bat だけ」、`release-smoke.ts` も同じ検査に。README(起動方法・新しい節「画面からの操作」・記録 / 完全出力 / 判定の節の bat の記述)、PRODUCT.md、CLI の USAGE(serve)、judge-flow の説明、atlas.bat の注記、surface brief(OPERATIONS)を直した。

契約からのずれ(どれも最小限。理由つき):

1. **`/view/<id>` は本文を持たない殻を返し、本文は token の要る `GET /api/view/<id>` から取る**。ページへの移動(リンク)には `X-Atlas-Token` ヘッダを付けられず、URL に token を載せると履歴と Referer に残り、cookie はポートを区別しないため。殻自体も Host・Origin / Sec-Fetch-Site・伏せ字版を検査する(他サイトからの移動は 403)。表題(セッション名)も API から取る。
2. **API を 2 つ足した**: `GET /api/jobs/judge-preview`(確認ダイアログに「未判定 N 件のうち M 件」を出すため。sessions.json の「依頼の記録がある」セッション(`turns > 0 || firstUserMessage`、bundle の hasRequest の近似)と judgments.json から数える)と `GET /api/session-tools.js`(詳細ページの操作の script。memo-editor.js と同じ配り方)。
3. **記録の表示で、属性の無い `<small>` `<details>` `<summary>` だけはタグとして描く**。atlas 自身が記録(compaction の要約の折りたたみ)と全文記録(各イベントの id の行)に書くもので、文字のままだと全文記録の全行に `<small>…</small>` が見えて読めないため。esc した後で `&lt;small&gt;` の形そのものだけを戻すので、属性・イベント・大文字の変形は入らない(単体で確認)。メモの描画は変えていない。
4. **見出しの段**: メモは 2 段下げだが、表示は先頭の `# 表題` をページの h1 に回し `##` を h2 にした(ページの h1 と本文の h1 が重ならないように)。
5. **judge の子プロセスにも `--out` / `--notes-dir` を渡す**(契約の表は `--limit` と `--backend` だけだが、「同じ out / notes」の意図どおりにするため)。
6. **`GET /api/jobs/current` に `target`(件数・バックエンド・id)を足し、ジョブが無いときは `null`(200)**。404 にするとブラウザのコンソールに毎回エラーが出るため。
7. **cancel は全文(サーバ内)にも効く**(AbortSignal。tmp を消す)。
8. **帯は実行中と完了だけ上に貼る(sticky)**。失敗・中止はログ(末尾 200 行)を開くので、貼ると本文を覆うため。実行中はログの代わりに最後の 1 行を出す。
9. 画面の「集計し直す」は atlas.bat に渡した引数(`--since` など)を引き継がない(契約どおり固定の `all --out --notes-dir`。README に明記)。

検査(このワークツリーで実行):

- `npm run typecheck`: tsc 0 件、svelte-check 0 errors / 0 warnings(121 files)。
- `npm test`(単体): 24 ファイル 179 件通過。Phase 14 の `packages/cli/test/jobs.test.ts` は 13 件(固定の引数と 409・ログの行分けと 200 行、引数の検証 17 通り(何も起動しない)、403(token なし・違う token・他オリジン・Sec-Fetch-Site・別の Host・伏せ字版)、cancel(子プロセスと全文)、full の成功と失敗、judge-preview、ジョブ中は idle で止まらない、集計中の 404 の文面、殻に本文が無いこと、記録の描画(script・イベント属性・javascript: リンク・相対リンク・外部画像・コードの中)、全文の assets(他のセッション・`..`・無いファイル)と許可したタグ、上限超え)。`launchers.test.ts` は bat が 1 つになったので 8 件 → 2 件(差し引きで総数は 185 → 179)。
- `npm run e2e`: 10 ファイル 69 件通過 / 8 skipped。新しい `e2e/phase14.test.ts` 5 件(本物の子プロセスで refresh → atlas.html の generatedAt が新しくなり記録がある / full で `out/full/<id>.md` と assets だけができ、他のファイル(サイズ・mtime・sha1)は全て不変、coverage.json なし、表示の API で描ける / judge は件数なし・anthropic を 400、偽 copilot で 2 件だけ判定され atlas.html に反映 / cancel で canceled、次を受け付ける / 判定 1 件に 2.5 秒かかる偽 copilot で、猶予 300ms の serve がジョブ中に止まらず終わってから止まる)。偽 copilot に `FAKE_COPILOT_DELAY_MS` を足した。
- `npm run ui`(Playwright): 2 ファイル 8 件通過。新しい `ui/jobs.test.ts` 4 件(「集計し直す」→ 帯が完了 →「再読み込み」で generatedAt が新しくなり帯が消える / 判定のダイアログで「やめる」と Esc は POST 0 回・judgments.json なし、上限 2 で実行すると POST の本文が `{kind:"judge",limit:2,backend:"copilot-cli"}` で 2 件判定 / 詳細ページの「記録を読む」で記録に混ぜた script・img onerror・javascript: リンクが実行されず文字のまま、「全文を作って読む」で全文を表示、coverage.json は作らない / file:// の atlas.html と詳細ページには操作が出ない)。全画面で pageerror と console.error が 0。
- 陽性コントロール(壊して落ちることを確かめ、戻した): (a) `renderSafeMarkdown` の html を esc しないと単体 3 件(メモ 1・記録の表示 2)が落ちる。(b) `expire` のジョブ中の待ちを外すと「ジョブの実行中は heartbeat が途切れても止まらず…」が落ちる。(c) 判定ダイアログの「やめる」が API を呼ぶようにすると ui の f. が落ちる。
- 見た目(Playwright の Chromium、架空の fixture、1440 ライト / 800 ダーク、`out/visual/shots/`): マストヘッドの操作、判定ダイアログ、帯(実行中・スクロール時・完了・失敗)、詳細ページの操作、記録と全文の表示、上限超え。横はみ出し 0、pageerror / console.error 0。見て直したもの: 失敗の帯が sticky でログが本文を覆う → 貼らない、実行中の帯が毎秒読み上げられる → 読み上げは状態の変化の 1 文だけ、全文記録の `<small>` が文字で出る → ずれ 3、0.00 MB の表示 → KB、上限超えの案内の「上の」(1440 では左)と空の目次の罫。
- impeccable の検出器(`detect.mjs`、静的): 変更した UI ファイル(JobActions / JobBand / App.svelte / viewer.ts / session-tools.ts / memo-render.ts / page-nav.ts)と生成した表示の殻・詳細ページで 0 件。ただし HTML は「DEGRADED(HTML パーサが無く正規表現だけ)」と出たので、計算されたコントラスト等は見ていない。web-design-guidelines の自己照合: 数値入力に name と autocomplete="off" を足した。残した P3: 上に貼った帯がキーボードで移った部品を覆う場合がある(scroll-padding は目次行の高さだけ)、表示の画像に width / height が無い(大きさが分からないため)。

実測(架空のデータと合成の .md。実データでは測っていない): fixture(14 セッション)で refresh 0.5 秒、全文 1 件 0.13 秒(22 KB)。合成した 20.0MB の全文記録の描画(サーバ)0.44〜0.49 秒(HTML 22.9MB、3 回)。19.5MB をブラウザで開いて描き終わるまで 2.69 秒(1440、1 回)。

未検証: 実データでの refresh・full の所要時間(この作業では実データを読まない指示のため)、`atlas.bat` のダブルクリックでの通し、本物の `copilot -p` / `opencode` での判定(クレジットを消費するため)、Windows の taskkill で judge-flow の孫プロセス(本物の copilot)が止まること(偽 copilot は node の子で、e2e の cancel は refresh で確かめた)。

#### 見直し(2026-11-03、reviewer の審査: FAIL。P1 1 件と P2 3 件、P3 の一部を直した)

1. **P1 全文記録の表示の svg**: 全文記録の assets を「画像なら img、他はリンク」で通していたので、セッション由来の svg(`session.binary_asset` の `image/svg+xml`)がサーバのオリジンのリンクになり、押すと中の script が `127.0.0.1:<port>` で動いて token を読めた(確認ダイアログを通さない判定、メモの書き換え、記録の読み出しが可能)。二重に塞いだ: (a) 表示がリンクにする形式を、開いても script が動かないもの(画像・txt・log・json・csv・pdf・bin)に限る(`viewer.ts` の `PASSIVE_EXT`。svg・html・xml は名前だけ)。(b) serve の静的配信の HTML 以外に `Content-Security-Policy: sandbox` と `X-Content-Type-Options: nosniff`、HTML(token 入り)に `X-Frame-Options: DENY` と `frame-ancestors 'none'`(費用のかかる判定のボタンをクリックジャッキングで押させない。審査の P3-1)。単体に svg・html の assets と応答のヘッダの検査を足した。陽性対照: (a) を外すと単体が落ちる。
   - 手元の環境の注意(実測): この PC の AdGuard は 127.0.0.1 への応答にも割り込み、CSP を `sandbox allow-scripts; script-src local.adguard.org` に書き換える(node の fetch でも同じ)。`allow-scripts` が足されても `allow-same-origin` は無いので、開いた svg はオリジンを持たない扱いになり token を読めない(再審査で Playwright により実測: 判定のジョブは起動されない)。テストは CSP の先頭が `sandbox` であることだけを見る。
2. **P2 `createFileSink.abort` の競合**(Phase 11 から): ファイルを開き終える前に `destroy` → `rm` すると、rm の後で tmp ができていた(審査の再現で 50 回中 47 個残る。phase11 の「flaky」とされていた単体の失敗はこれ)。`close` を待ってから消すようにして、同じ再現で 0 個。
3. **P2 atlas.bat の再実行とジョブの並行**: ジョブの実行中だけ `out/.job.json`(serve の pid・種類)を置き、`all` は他のプロセスの印があれば「画面から実行した処理(…)が動いています」で止まる(古い印=プロセスが無いもの・自分の印・ジョブの子プロセス(環境変数 `ATLAS_SERVE_JOB`)では止まらない)。実データの一時の out で、画面の集計し直しの最中に all を実行して止まることを確かめた。
4. **P2 cancel の e2e が止める処理の故障を検出しなかった**: fixture の集計は 0.5 秒で終わるので、kill が効かなくても canceled になっていた。1 件 30 秒かかる偽 copilot の判定を止め、10 秒以内に canceled になり判定が増えないことを見る e2e(phase14 d2)を足した。陽性対照: kill を何もしない形にすると d2 が落ちる。
5. **P3 で直したもの**: 判定の失敗の帯の文面(export の前に終わった場合に「反映しています」と言わない)、judge-flow の使い方とエラーの接頭辞(`atlas-judge` → `npm run atlas:judge`)。
6. **残した P3**: 許可タグ(details / summary)が対になっていない本文で表示が段落の中で崩れる(安全上の問題は無い)、1 件の全文記録の見出しが `atlas export --full` のまま・作った後の集計で「前回の --full の出力が残っています」のログが出る・既にある全文を作り直さずに読む入口が無い、`/sessions/<id>.md` は token なしで配信される(他のオリジンからは読めない。以前からの設計)。e2e/phase2 の外部参照の検査は `new URL(`(Svelte の実行時が src の比較に使う)を除く形にした(実装の途中のテンプレートで誤検出した。今のテンプレートには無いが、`http://` の検査は別にあるので緩めても外部参照は見逃さない)。
7. **検査**: typecheck 0 / 0、単体 180 件(2 回)、E2E 70 件 / 8 skipped、ui 8 件。実データ(一時の out / notes-dir、820 セッション): 画面の「集計し直す」11 秒、最大のセッション(元ログ 71MB)の「全文を作って読む」0.9 秒で 55MB(20MB を超えるので描かず「.md を開く」の案内)、記録の表示(156KB)0.3 秒で描画・目次 5・横はみ出しなし、判定のダイアログは「やめる」でジョブを起動しない(serve のログで確認)。判定そのものは実行していない(クレジットを消費するため)。

#### 再審査(2026-11-03、PASS)と追加の修正

再審査は PASS(前回の指摘は直っている。単体 180 件を 3 回、E2E 70 件、ui 8 件、svg を開いても判定のジョブが起動されないことをブラウザで実測、ヘッダで既存の 6 画面が壊れないこと、印がすべての終わり方で消えること)。参考の指摘のうち次を直した。

1. **R-1 out/ の下のどの .html も atlas の画面として配っていた**(P1 と同じ種類。アプリのリンクからは行けないが、URL を直接開くと `snapshot/` の写しの .html の script が token を読み、ジョブを起動できた(再審査で 202 を実測))。token の差し込みとフレーム禁止は atlas 自身の画面(直下の atlas / glossary / insights / instructions.html と `sessions/<id>.html`。`serve.ts` の `isAppPage`)だけにし、他の .html は token を入れず sandbox の静的ファイルとして返す。単体に写しの .html と atlas.html のヘッダの検査を足した(R-5)。陽性対照: `isAppPage` を常に真にすると単体が落ちる。
2. **R-2 serve が止まっても印が残る**: serve の終了時に自分の印を消す(`dropLock`)。`all` が止まったときの文面に、印のファイルを消せば抜けられることを書いた(pid が再利用されて古い印を生きているとみなす場合の抜け道)。
3. **R-3 印を消すときの例外で serve が落ちうる**: try / catch で包んだ(消せなくても止めない。次の all はプロセスの有無で古い印を無視する)。
4. **R-6** 判定の失敗の帯の文面を「ログに『export: セッション記録』があるときだけ」に直した。
5. 残したもの: R-4(atlas.bat の all の実行中に画面の「集計し直す」を押すことは防げない。印は serve 側だけ)。


### 画面の見直しと、記録を別のウィンドウで開く(2026-11-03)

利用者の依頼: 「セッション記録を Markdown で開くときは別ウィンドウで」「UI 全般が見やすいか見直す」。

- **点検の方法**: 実データ(一時の out / notes-dir、820 セッション)を `atlas serve` で開き、Playwright で atlas.html の全節・詳細ページ・記録の表示・用語・改善点・指示文のページを 1440px のライト / ダークと 390px で撮って見た。ページ内の例外とコンソールのエラーは 0 件。
- **別のウィンドウ**: 記録を読む操作(「記録を読む」「全文を作って読む」、詳細ページの「記録(Markdown)を開く」「全文記録(解析用)を開く」、表示の「.md を開く」)は `target=_blank` + `rel=noopener` で開き、詳細ページを残す。ラベルの後ろに ↗ と読み上げ用の文。保存(download)のリンクは対象外。「全文を作って読む」は作り終わるまで待つので、押した時点で空のウィンドウを開いておき(非同期の後の `window.open` はポップアップとして止められる)、できたらそこへ移す。開けなかったとき・再読み込みで続きから待ったときは状態の行に「全文記録を開く ↗」を出す。採らなかった案: 本物の別ウィンドウ(`window.open` の popup 指定)— 中クリックや「新しいタブで開く」が使えなくなり、タブかウィンドウかはブラウザの設定に任せるほうが自然なため。
- **表示の直し**(撮った画面で見つけたもの): セッション一覧の題名(多くは依頼文の先頭)が 4〜5 行に折り返して 1 行が 100px 近くあった → 2 行で切り(title に全文)、欄の最小幅を 18em に。パスが名前の途中で切れていた(`C:\work\my_projec` / `t` のような切れ方)→ 区切りの直後に `<wbr>`。要点の 4 枠を 3 列に並べると右下が空欄 → 最後の行の枠を横に伸ばす。入力トークン記録の凡例で色の印が下がっていた(行の高さが一番長い凡例に揃い、flex の行が引き伸ばされていた)→ `align-content: flex-start`。表題の説明文が日付の途中で折り返していた → 日付を nowrap、幅 100ch。見出しと説明文の「ありま / す。」→ `word-break: auto-phrase`。
- **残したもの**: 実行の性質の 2 列の箱は隣の表の高さに揃うので片側に空きが出る(様式の罫を保つ)。素の `build` で作り直すと、`.md` が残っていても詳細ページから記録へのリンクが消える(以前からの動き。記録を作るのは `all` / `export`)。
- **検査**: typecheck 0、単体 180、E2E 70 / 8 skipped、ui 8(g を別のウィンドウの形に直した: `popup` を待ち、詳細ページが残ること・`window.opener` が null・保存のリンクは同じウィンドウであること・「全文記録を開く」が出ること)。陽性対照: 「記録を読む」の `target` を外すと g が落ちる。impeccable の検出器(正規表現のみの縮退動作)は変更ファイルで 0 件、生成した atlas.html で 1 件(判定のダイアログの上の 3px の罫。角丸は無いので誤検出)。

### グループの管理のしやすさ(2026-11-03)

利用者の問い「グループ化は見やすく管理しやすい形か」に、実データの一時コピー(820 セッション、notes-dir も一時)で 3 つのグループを作り、追加・選択・改名・狭い幅を Playwright で撮って答えた。見やすさは十分(サイドバーの名前・件数・一文、現在の印、選ぶと全体が絞り込まれる、狭い幅の一覧)。管理のしやすさで 4 件を直した。

1. **チェックが残り、次のグループに前の分が黙って混ざる**: グループで絞り込むと行は全てチェック済みになるが(Phase 10 の設計)、「すべて」に戻してもチェックが残っていた(`App.svelte` の選択の effect が ids が空になったときに何もしなかった)。実データで、4 件のつもりのグループが 7 件、2 件のつもりが 9 件になった。ids が空になったとき(前が空でなかったときだけ。手でチェックしただけの選択は消さない)と、現在でないグループに足し終えたときに外す。
2. **所属が見えない**: 一覧の行に「グループ: 名前、…」、詳細ページ(serve のとき、`GET /api/state` から)に名前のリンク(`../atlas.html#group=名前`)。
3. **「グループに追加 ▾」のメニューが右にはみ出す**(1440px で 73px、ページが横に流れる): ボタンの右端に揃える。390 / 768 / 1100 / 1440px で画面内に収まることを測った。
4. 作成欄の説明文の古い場所(「絞り込み行の「グループ」」)を直した。

- **残したもの**(好みにも関わるので別に扱う): 選択は 1 ページ(50 件)ずつ、グループ同士を並べて比べる表は無い。
- **検査**: typecheck 0、単体 180、E2E 70 / 8 skipped、ui 9(b2 を足した: 甲を作って「すべて」→ チェック 0、1 件で乙を作ると乙はその 1 件だけ、既存の甲に足すとチェック 0 で「チェックは外しました」、メニューが画面内、行と詳細ページに所属、詳細ページの名前から 1 件に絞り込まれたレポートへ)。陽性対照: ids が空になったときの解除を外すと b2 が落ちる。メニューを左揃えに戻すと b2 が落ちる。実データでやり直すと 3 / 6 / 2 件(意図どおり。直す前は 3 / 11 / 9 件)。

### グループの管理を本文の見出しへ(2026-11-03)

利用者の問い「サイドバーに改名や削除を載せるのは良い UI か」に、A(サイドバーは切り替えだけ、管理は本文の見出し)と B(行の「⋯」メニュー)を示し、利用者が A を選んだ。あわせて同種の UI を見直した。

- **直したこと**: グループで絞り込み中だけ本文の先頭に `GroupHead.svelte`(名前・件数・説明、「編集」「絞り込みを外す」)。「編集」は名前と説明を 1 つの欄で直す(変わった分だけ `PUT /api/groups/<名前>` 1 回。サーバは以前から両方を受ける)。削除は編集欄の右端の「このグループを削除…」から確認つき。Esc は 1 段ずつ戻り、焦点は「やめる」→「このグループを削除…」→「編集」と戻る。`GroupRail.svelte` から操作を外した。
- **同種の見直しで直したこと**: 現在のグループを押し直すと絞り込みが外れる隠れた切り替え(押し直しても同じにした)、「選んだ N 件(押すと外す)」の行(ボタンでなく印に)、利用者向けの「一文」(「説明」に)。
- **残したもの**: プロジェクト別の表の名前を押し直すと解除(行に「もう一度押すと解除」と書いてあり、絞り込みの行のプロジェクトでも外せる)。メモの削除は本文を空にして保存する形(確認つき)。詳細ページのサイドバーの「記録を .md で保存」(別ページへのリンクと並ぶが、目次とは罫で分けてある)。
- **検査**: typecheck 0、単体 180、E2E 70 / 8 skipped、ui 9(b を書き換え: サイドバーにグループを選んでも高さが変わらず操作が無い、押し直しても外れない、見出しで名前と説明を 1 回で直すと groups.json と URL の名前が追従、確認で焦点が「やめる」・Esc で 1 段ずつ戻る、確認つきで削除)。陽性対照: サイドバーを main の形に戻すと b が落ちる(高さ 60 → 101px)、確認から戻ったときの焦点の移動を外すと b が落ちる。実データの一時コピー(844 セッション)で 390 / 768 / 1100 / 1440px を撮り、横にはみ出さず、ページの例外・コンソールのエラーが無いことを見た。

### 見出しの独立レビュー(2026-11-03)

上の変更(dbbc9e0)を、結論を渡さずに別のエージェントに読ませた。高・中は無く、低 7 件のうち次を直した。

- **編集中に一覧から別のグループへ足すと、打ちかけた入力が消えた**: `GroupHead` の effect が `group` オブジェクトに依存していた(追加・外しのたびに作り直される)。名前の文字列の `$derived` だけを見るようにした。
- **「絞り込みを外す」で見出しごと消え、焦点が body に落ちた**: 削除と同じく本文の先頭(`#main`)へ移す。編集中にサーバが止まったときも同じ。
- **削除の通信中に別のグループへ移ると、移った先の絞り込みまで外れた**(この変更より前から): 応答の後に ids が変わっていなければ外す。タイミングに依るので画面のテストは無い。
- 件数「m / n」の補足を読み上げにも出す。設計文書と README に残っていた古い記述(サイドバーの 改名 / 一文 / 削除、「絞り込み行の「グループ」」)を直した。
- **テスト**: ui に b3 を足した(編集中に別のグループへ足しても入力が残る、既にある名前への改名は理由を出して名前も URL も変えない、説明だけ空にできる、外すと焦点は本文)。409 の応答でブラウザがコンソールに出す 1 行は、b3 の中で想定どおりとして外す。陽性対照: effect を `group.name` に戻すと b3 が落ちる、外したときの焦点の移動を外すと b3 が落ちる。
- **残したもの**: 画面を開いたまま CLI で改名・削除したグループを見出しで直そうとすると 404 の理由が出るが、一覧は再読み込みまで古いまま(以前のサイドバーでも同じ)。

### セッションごとの指示文と skill(2026-11-04)

利用者の問い「詳細ページから指示文のページを開くと全部が出る。そのセッションに効いている指示や skill だけを一覧で見られないか」への答え。

- **調べたこと(実測)**: 詳細ページには以前から注入された指示ファイルの表と、呼んだ skill の表があったが、節が分かれ、サイドバーの「指示文と skill」は全部(実データで 36 項目・61 版)を開いていた。使えた skill はシステムメッセージの `<skill><available_skills><skill><name/><description/><location/></skill>…` に並ぶ。実データ(スナップショットの events.jsonl 245 件、システムメッセージのあるもの 225 件)では 89 件にあり、Copilot CLI 1.0.77 より前の版(1.0.25〜1.0.71)と `copilot -p`(producer: copilot-agent)のセッションには無かった。location は user / project / custom / builtin。1 セッションの中で一覧が変わったものが 4 件あったので和集合にする。閉じタグの無い(途中で切れた)ものが 1 件。
- **作ったもの**: `SessionRecord.availableSkills`(sessions.json の schemaVersion 7。一覧が無いセッションは null)。詳細ページの「指示ファイル」の節を「指示文と skill」にし、指示文の表と skill の表(使えた skill + 一覧に無い呼び出し、置き場所、呼んだ回数。呼んだものが先)を置く。伏せ字版では使えた skill の名前を出さず件数だけ(呼ばなかったプロジェクトの skill 名も含むため)。目次の「指示文と skill」と節の見出しの横のリンクは `instructions.html#session=<id>` を開き、指示文のページはそのセッションで使われた版だけを残す(版に `data-sessions`、帯に件数と「すべて表示」「セッションの詳細に戻る」)。
- **検査**: 単体(抽出: 名前と置き場所、一覧なしは null、切れた一覧、複数のシステムメッセージの和集合 / 詳細ページ: 並び・回数・一覧に無し・一覧なしの文言・伏せ字 / 指示文のページ: data-sessions と名前の表)、E2E(fixture に指示文と使えた skill の一覧を足した。schemaVersion 7、詳細ページの件数の文)、ui に e(詳細ページから開くと他のセッションだけの項目と版が隠れ、「すべて表示」で戻り、詳細に戻れる)。陽性対照: 項目を隠す処理を外すと e が落ちる、版を隠す処理を外すと e が落ちる、抽出を常に null にすると単体 3 件が落ちる。実データの一時コピーで 1440 / 390px を撮り、横にはみ出さず、ページの例外・コンソールのエラーが無いことを見た。
- **残したもの**: `custom` の意味(どこに置いた skill か)は公式の説明を確かめていないので、ログの値のまま出す。使えたが呼ばなかった skill の本文は記録に無いので指示文のページには出ない。

### 初期設定の setup.bat(2026-11-08)

利用者の依頼「wiki など初期設定をするための setup.bat を作って」への答え。Phase 14 の「起動用の bat は atlas.bat 1 つ」は集計と画面の起動の話として残し、設定だけをする bat を 1 つ足した(`launchers.test.ts` の一覧も atlas.bat・setup.bat の 2 つにした)。

- **作ったもの**: `setup.bat` → `packages/cli/src/setup.ts`。依存を入れ(atlas.bat と同じ判定)、vault(ドラッグしたフォルダはフォルダ名だけにする。`wiki/` があれば個別ページの場所として勧め、`index.md` が無ければ索引の名前を尋ねる。インストール済みの skill のうち名前に wiki を含むものを 1 度だけ候補に出す)と普段の工程名を尋ね、`parseConfig` を通してから書く。既存は `.bak` に退避し、「このままにする」を既定にする。設定にある項目は wikis と phases だけなので、尋ねるのもこの 2 つ。
- **決めたこと**: 入力は `rl.question` ではなく行の反復子で読む(入力を流し込んだときに、尋ねる前に届いた行を落として止まったため。実測)。入力が途中で終わったら書かずに失敗にする(空の答えは「既定のまま書く」になるため)。
- **採らなかった案**: `~/.claude/wiki-vaults.json` などの他ツールの設定から vault を推測する(Copilot の利用者には無いもので、置き場所も決まっていない)。終わった後に続けて集計する(設定を見直してから atlas.bat を押せばよく、尋ねる項目が増える)。
- **検査**: 単体 `setup.test.ts` 4 件(フォルダ名への変換と中の確認、答えから書いた設定を `loadConfig` で読める、既存の維持と .bak・工程名の誤りの尋ね直し、空の設定と書かない選択)。`setup.bat` を PowerShell から入力を流して実行し、最後の確認で「n」を答えて書かずに終わることを見た(手元の atlas.config.json は変えていない)。
- **残したもの**: 実際の黒い窓で日本語を打ち込む操作と、フォルダのドラッグは試していない。

### 人のレビューの前の機械・LLM の点検(2026-11-08)

利用者の依頼「人がレビューする前に、機械と LLM の点検で直せるものはすべて直す」への答え。typecheck・単体・E2E(架空 + 実データ `ATLAS_LIVE`)・画面の操作の検査・全ページの網羅チェック(架空 + 実データ)・impeccable の検出器・web-design-guidelines と設計契約の照合(読み取り専用のサブエージェント)を流し、出たものを直した。

- **実データで atlas.html が 5MB を超えていた(E2E 4 件の失敗)**: 2,212 セッションで 5.84 MB。埋め込みの大半はセッションの要約(4.76 MB)で、空のセッション(659 件)を含め、既定値のままの項目が多かった。`report/src/lib/pack.ts` で、既定値(空のセッションと同じ値)と一致する項目と id から作れる `href` を落として埋め込み、読み込み(`app/main.ts`)と `extractEmbedded` で埋め戻す。既定値と違う値は 0 も null も残すので、欠測と 0 の区別は失わない。実データの全セッションで「落として戻すと元と同じ」を確かめ、要約は 2.77 MB、atlas.html は 3.85 MB になった。採らなかった案: 埋め込みを gzip + base64 にして DecompressionStream で戻す(もっと小さくなるが、読み込みが非同期になり、埋め込みを直接読むテストと検査をすべて変える必要がある)。上限を緩める(共有するファイルの大きさの約束を変えることになる)。セッションが増え続ければいずれまた上限に近づくので、そのときは上の gzip を検討する。
- **前回のレビューで残していた 5 件**: 画面の「書き出す」の間は out/ の印を取り、同じ serve の集計などのジョブも始めない(書きかけの sessions.json を読まない)。turn-judgments.json が壊れていても、判定の列なしで書き出して注意を出す。表(turns.csv・sessions.csv)を作る処理を `cli/src/tables.ts` の 1 つにした(集計の表とグループの書き出し)。依頼の塊の文字数を測る描画を使い回す(最後の 1 回を描き直さない)。リクエストのターンへの振り分けを二分探索にした(開始の時刻が前後していても先頭から見るのと同じ結果になる。乱数で 20 万通りを突き合わせた)。
- **全ページの網羅チェック**: 架空 16 ページ・実データ 2,216 ページで要修正 0。要確認のうち、詳細ページの目次の「メモ」(2 文字)が 375px で 19px 幅だったので、目次のリンクに最小幅を付けた。もう 1 件は本文に引用された C++ のコード(問題なし)。
- **impeccable の検出器**: 段階 1・2 で変えた UI のソース 18 ファイルで 0 件。生成物の 1 件は判定ダイアログの上の罫(角丸が無いので誤検出、前回と同じ)、注意は詳細ページの表の空欄の印「—」(文章ではない)。
- **web-design-guidelines と設計契約の照合**(段階 1・2 で足した画面。P0 なし、P1 1・P2 11・P3 14): 直したもの — 「工程(普段)」の説明が無い(節の注記・表の読み方・詳細ページの説明と用語ページ `turn-verdict` に書いた)、file:// の共有版と伏せ字版でもボタンの場所を案内していた(`lib/hints.ts` で開き方ごとに文を分け、Overview・絞り込み・工程と詰まりで使う)、「最後の判定: モデル X、。」、合わなかった点が全部 0 でも見出しだけの表、colgroup の無い scope=colgroup、「表の読み方」が 2 つ下の表のさらに後ろ(工程別の表の直後へ)、採用率・判定不能の説明、グループの書き出しの結果を live 領域ごと差し込んでいた(常に置いて文だけ差し替え)、ボタン名「書き出す」(「表と記録を書き出す」)、件数の言い方、書き出し中に押すと結果が消える、チャットの手順で表示の名前と保存の名前が違う(turns-part-NN にそろえた)、詳細ページの判定の理由を 60 字で切って全文は title だけ(全文を出す)、依頼の判定の回数の目安、0 件を「—」で出していた(薄い 0。「—」は欠測と分母 0 だけ)、上限の桁区切り、判定するものを切り替えると上限が既定値に戻り前のエラーが残る、チャットに貼りかけた返答が消える(判定するものごとに親で持つ)、帯の「の」の連続、詳細ページの # を行の見出しに・「失敗」「ツール」の列名、未判定の行の空欄、説明文の句点と「工程と詰まり」・用語へのリンク、surface brief の OPERATIONS・目次の記述(TURNS を足した)。ブラウザ(serve、架空の判定入り)で 640px と 1440px を見て、工程別の表の名前の列が 1〜2 文字ずつ折り返していたので最小幅を付けた。残したもの: 伏せ字版でも普段の工程名(利用者の設定)がそのまま出る(グループ名と違い、作業の流れの一般的な名前なので出してよいと判断。伏せるなら設定の側で判断が要る)。列の定義を th の title に持たせている件は、表の直後に「表の読み方」を置いたのでそのまま。
- **Windows の画面テスト b3 が時々落ちる件**: CI(run 42120805755)では最初のグループの作成で、10 秒待っても groups.json に出なかった。手元で Chromium の CPU を 20 倍遅くし、前のテストから続けて 3 回流しても再現しなかったので、原因は特定できていない。次に落ちたときに原因が分かるよう、作成を押す前に入力が残っているかを確かめ、待ちが切れたら「作成の失敗: 理由」「入力欄が開いたまま」「入力欄が閉じたのに groups.json に無い」のどれかを出すようにした。CPU を遅くして流す `ATLAS_UI_CPU_SLOWDOWN` を足した(docs/development.md)。

### グループのアップロード(2026-11-08)

利用者の依頼「タスクごとにグループでまとめたセッションを、既定のパス(例: `E:\dev\atlas-logs`)の タスク名 のフォルダへアップしたい。既存の同じセッションは上書き」への答え。中身(生ログ / 記録 .md / 両方)と、セッションのフォルダ名(連番 / セッション ID)は利用者に確かめ、生ログ・セッション ID にした(連番はグループの増減で番号がずれ、「同じセッションは上書き」が別のセッションを上書きするため)。

- **作ったもの**: `packages/cli/src/group-upload.ts`(`<out>/snapshot/session-state/<id>/` を `<基底>/<グループ名>/<id>/` へ。隣に写してから置き換える。スナップショットの作業用の `.session.db.src` は入れない)。`session-store.db` のそのセッションの行を `atlas-session-store.json` で添える(生ログだけだとトークン数などが欠けることがある。fixture で外すと `sources` が `dir` だけになり、エージェント別の内訳が消えるのを確かめた)。デスクトップアプリのセッションの `data.db` の行(snapshot の `desktop.json` の、許可リストの列だけ)も同じファイルの `desktop` に添える(実データの直近 3 件で集計し直したとき、2 件の題名・モデル・トークン数が欠けていたのを見つけて足した。fixture の data.db を使う E2E で、外すと `desktop` が null になって落ちるのを確かめた)。グループの説明とメモも残す(2026-11-09): グループのフォルダに `README.md`(グループ名・説明・写した日時・何時点の集計か・今回写したセッションの一覧と題名・メモの有無・集計し直すコマンド。題名は集計の記録の name)、各セッションのフォルダに `atlas-memo.md` と `atlas-memo/`(本文の画像の参照 `<id>/…` を `atlas-memo/…` に直す)。採らなかった案: メモをグループのフォルダにまとめる(セッションと一緒に置き換わらず、外したセッションのメモが残る)、送った先で集計した画面にメモを出す(取り込み先の atlas-notes との突き合わせが要るので、必要になったら)。README は写すたびに書き直すので、一覧は最後に写した回の分になる。レビュー(2026-11-09)で直したもの: 置き換えは前のフォルダを `.<id>.old` に退けてから差し替えて最後に消す(開かれたファイルで消す途中に止まって前のフォルダが欠けるのを防ぐ。Windows では開いたファイルを含むフォルダの改名が EPERM になり、前のフォルダを残して止まる)、添えた desktop の形を確かめる(違えば使わず理由を出す)、フォルダ名が同じになる別のグループ・前回の集計に 1 件も無いグループは写さない、予約名は拡張子付き(`nul.log`)も避ける、`updateConfig` は値の差し替え・末尾への追加で済めば他の項目の書き方を残し、一時ファイルから置き換える。続けて直したもの: セッションの name が無いか仮の「New session」のままなら data.db の title を使う(extract の `sessionName`。画面・記録・README で同じ名前になる。実データの data.db のある 37 件では 33 件が同じ、3 件が「New session」、1 件は name の方が的確だったので、name があれば残す)。画面テスト(ui/report.test.ts の g)でアップロードの操作を通す(未定 → 記入欄 → 取り消し・無いフォルダ・選ぶ → そのまま写す → 置き換え → 開く → Esc。設定ファイルはテスト用の場所、フォルダを選ぶ画面は差し替え)。見送ったもの: 日時の書式の重複(`dateTime`)、DB をセッションごとに開く・sessions.json 全体を読む効率。送った先は `--home <基底>/<グループ名>` で集計し直せる(snapshot が「直下にセッションが並ぶ形」を `layout: flat` として読み、extract が添えた行を足す。同じセッションの行が DB にあれば DB を優先)。CLI `atlas group upload <名前> [--to <dir>]`、設定 `uploadRoot`(`setup.bat` の 3 つ目の質問、画面の「場所を決める…」)、serve の API(`PUT/POST api/upload-root`、`POST api/groups/<名前>/upload`、`…/upload/open`)、画面は GroupHead(surface brief の UPLOAD)。
- **決めたこと**: 元の `~/.copilot` ではなく前回の集計の複製を写す(SQLite の一貫した複製があり、元を開かない方針を保てる。atlas.bat は起動時に集計するので、普段は新しい)。結果の文に何時の集計かを出す。基底のフォルダは作らない(ネットワークドライブの切断などで思わぬ場所に作らない)。グループから外したセッションや、ほかの回・ほかの PC から写したフォルダは消さない。groups.json は手で書けるので、`..` や区切りを含む id は写さない。フォルダ名はグループ名を書き出しと同じ規則(`safeDirName`、report の lib/groups.ts に移して画面と共有)で直すだけにし、書き出しのような「他のグループと衝突したらハッシュを足す」はしない(ほかのグループの一覧によって先が変わってしまうため。画面に写す先をそのまま見せる)。フォルダを選ぶ画面はサーバが PowerShell(pwsh があれば新しい形のダイアログ、無ければ 5.1)で出す(ブラウザはフルパスを取れない)。設定ファイルは 1 項目だけ書き換え、他の項目と書き方を残す。壊れた設定は書き換えない。
- **採らなかった案**: ブラウザの File System Access API(フルパスが取れず、Chromium 限定で、毎回の許可が要る)。アップロード先ごとのグループ別の設定(依頼は「既定のパスを決めておいて、タスク名ごとに自動」)。記録の .md も一緒に写す(利用者が生ログを選んだ)。
- **検査**: 単体 `group-upload.test.ts` 5 件(写す形・作業用ファイル・外を指す id・置き換え・止まる条件・CLI・serve の API(token・未定・入力・選ぶ・取り消し・開く・501・壊れた設定))、`config.test.ts`(`uploadRoot`・`updateConfig`)、`setup.test.ts`(3 つ目の質問)。E2E `phase15.test.ts` 3 件(fixture で集計 → `group upload` → 写した形・置き換え・他人のフォルダ → アップ先を `--home` にして集計し直し、指示ファイルの名前の解決を除いて記録全体が元と一致 → 止まる条件)。型検査・単体 35 ファイル・E2E 11 ファイル通過。画面(fixture、serve)で 先が未定のまま「アップロード」→ 記入欄 → パスを入力 → そのまま写す → 2 回目は置き換え、を確認。375px ライトで横はみ出し 0。フォルダを選ぶ画面は、スクリプトの表示の 1 行だけを差し替えて pwsh / powershell.exe の両方で日本語のパスが返ることを確かめた。
- **残したもの**: 実際にフォルダを選ぶ画面を出して選ぶ操作と、「エクスプローラーで開く」で窓が開くことは試していない(利用者の画面に窓が出るため、デスクトップの操作の許可を得られなかった)。ダイアログがブラウザの後ろに出ることがありうる(最前面の親窓を付けたが未確認。画面に「タスクバーを確かめて」の 1 文を出す)。

### サイドバーを出す幅(2026-11-09)

利用者の指摘「サイドバーは画面サイズに関わらず出したほうが良い、画面上部は分かりにくい」への答え。サイドバーを出す幅を 1280px 以上から 768px 以上に下げた(atlas.html・詳細・用語の 3 画面。CSS の `@media (min-width: …)` と、`App.svelte`・`page-nav.ts`・`viewer.ts` の `matchMedia`)。1280px 未満では目次とグループが上部の 1 行に畳まれ、グループは行末の「グループ N」を押さないと見えず、グループを選んで初めて出る「アップロード」に辿り着きにくかった。

- **決めたこと**: 768px 未満(スマホの幅)は従来どおり上部の 1 行。13em のサイドバーを出すと本文が 150px ほどしか残らず読めないため。768〜1280px では本文が狭くなるぶん、表は横スクロールで読む(列幅は変えない)。
- **採らなかった案**: どの幅でも出す(スマホの幅で本文が読めない)。狭い幅ではサイドバーを細くする・畳めるようにする(項目の説明の 1 行が読めなくなり、畳む操作が増える。必要になったら)。
- **検査**: 画面(fixture、serve)で 800 / 1024px にサイドバーが出て、グループを選ぶと見出しに「アップロード」が出ること、375px は上部の 1 行のままであること、詳細ページも 800px でサイドバーが出ることを確認。`scripts/ui-audit.ts`(375 / 1024 / 1440px × ライト / ダーク、17 ページ)で指摘 0 件。

### アップロードを安心して使う(2026-11-09)

利用者が挙げた運用の懸念(秘密の情報がそのまま写る・大きいと止まって見える)への答え。

- **作ったもの**: 写す前の点検 `checkTarget`(合計の大きさ・大きいもの・秘密らしい文字列。種類は全文記録の伏せ字と同じ `SECRET_PATTERNS`)。画面は写す前に毎回確認を出す(送り先・件数・大きさ・置き換える件数。秘密らしい文字列があれば種類とファイルも出し、焦点は「やめる」、ボタンは「それでも写す」)。写している間は `upload/progress` を 0.5 秒ごとに尋ねてバイト数を出す(`cp` では進み具合が取れないので、ファイルごとに写す `copyFiles`)。CLI の `group upload` は秘密らしい文字列があれば止まり、`--force` で写す。
- **決めたこと**: バイナリ(先頭 8 KB に NUL)は調べない(session.db・画像・ビルドの成果物。件数は出す)。大きなファイルは 4 MB ずつ、16 KB 重ねて読み、重ねた部分は次の塊で数える(境目をまたぐ鍵を取りこぼさず、二重にも数えない)。確認は最初「秘密らしい文字列があるか 100 MB を超えるときだけ」にしたが、利用者の希望で毎回にした(送り先も毎回見せる)。
- **測ったこと**: 実データの元(~/.copilot)の最大のセッションは約 560 MB だったが、ほとんどがエージェントの作ったビルドの成果物で、集計の複製(写す元)には入らない。複製では最大 72 MB、全 2078 件で約 750 MB。大きい 5 件(170 MB)の点検は 0.5 秒。実データに秘密らしい文字列は無かった。
- **採らなかった案**: 秘密らしい文字列を伏せて写す(生ログを変えると集計し直した結果が元と変わる。受け取る人が要るなら記録の .md を別に添える案があり、利用者の判断待ち)。

### タスクタグとプロジェクト単位の送り(2026-11-09)

利用者の依頼「一般の利用者はアップロードするだけなので、セッションごとにタスクタグを付けられるようにし、bat でプロジェクト単位で送る。タスクごとの判別を人間と AI ができるように。タグの無いものも送る」への答え。

- **決めたこと**: タスクタグは今のグループをそのまま使う(1 つのセッションに複数付けられ、作ったグループがそのままタグになる)。画面の呼び名だけを「タスクタグ」にし、保存先(`atlas-notes/groups.json`)・API・CLI の `group` は変えない。詳細ページ(serve のとき)で付け外しできる(`session-tools.ts`。今あるタグは候補に出し、無い名前なら作る)。
- **`upload-project.bat`**(`upload-project.ts`): 集計し直してからプロジェクト(集計のプロジェクト別と同じ単位。空のセッションは数えない)を番号で選び、そのプロジェクトの全セッション(タグの無いものも)を `<送り先>/<プロジェクト名>/<id>/` に写す。送り先は一度エクスプローラーで選ぶと `uploadRoot` に覚え(画面と共通)、送る前に毎回確かめる(`y` で送る / `c` で選び直す / Enter でやめる)。利用者は「自動アップロードは不安定」として、自動ではなく bat を叩く形を選んだ。
- **送り先の索引**: README.md にタスクタグの列とタグごとの一覧(タグなしを含む)、`atlas-index.json`(プログラムや AI が読む。セッションごとのタグ・題名・作成と最終更新・プロジェクト・メモの有無)、各セッションのフォルダに `atlas-session.json`(1 つのフォルダだけを渡されても分かるように)。写すまとまりは `UploadTarget`(グループ / プロジェクト)にして、点検とアップロードを共通にした。
- **採らなかった案**: グループとは別にセッションごとのタグを持つ(同じ「名前 → セッションの集まり」が 2 つになる)。bat でタグの付いたセッションだけを送る・全プロジェクトを送る(利用者がプロジェクトを選ぶ形を選んだ)。
- **検査**: 単体 `upload-project.test.ts`(選ばない・未定なら選んで覚える・`c` で選び直す・空を送らない・タグと索引)、画面テスト(詳細ページでの付け外し、写す前の確認)、配布物の確認で `upload-project.ts` が何も送らずに終わること。送ったフォルダを `--home` で集計し直すと元と一致(増えたファイルは集計に影響しない)。

### サーバが頻繁に止まる(2026-11-09)

利用者の報告「サーバーが頻繁に落ちる」。原因は 2 つ。(1) heartbeat が 8 秒途切れると止まっていたが、ブラウザは隠れたタブのタイマーを間引く(Chrome は 5 分以上隠れたタブを 1 分に 1 回まで)ので、別のタブで作業している間に止まった。(2) 画面は heartbeat が 1 回失敗しただけで送るのをやめ、生きているサーバまで 8 秒後に止めていた。

- **決めたこと**: 止まる条件を「開いている画面がすべて閉じた(pagehide で bye を送る)後の 15 秒」にし、heartbeat の途切れは保険として 30 分にした。画面ごとに id(`x-atlas-client`)を送り、ほかの画面が開いていれば 1 つ閉じても止まらない(3 分 heartbeat の無い画面は数えない)。ページの移動・戻る / 進むは次のページの heartbeat が猶予の間に届く。画面は 3 回続けて失敗するまで止まったとみなさない(403 はすぐ)。タブが表に戻ったとき・bfcache から戻ったときはすぐ送る。
- **検査**: 画面テスト `ui/heartbeat.test.ts`(一覧 → 詳細 → 戻る → 進むで止まらず、外へ移ると猶予の後に止まる。Playwright の `page.close()` は閉じかけのページの要求を送らないので外へ移って確かめる)、serve の単体テスト(bye と猶予)。

### 戻る・進む(2026-11-09)

利用者の依頼「戻る、進むなどのバグ潰し」。プレビューで操作して 3 つ見つけた。

- 詳細ページから戻ると先頭・一覧の 1 ページ目に戻っていた: ブラウザがスクロール位置を戻す時点ではまだ描いておらずページが短い。離れるとき(pagehide)に履歴の項目(`history.state`)へ位置と一覧の並べ替え・ページを書き、戻る / 進む・再読み込みのときだけ描いてから戻す(`view-restore.ts`。`requestAnimationFrame` に頼らない: 描画の合図が来ない環境があった。後から高さが変わるときのため 0.3 秒後にもう一度だけ合わせ、その間に自分でスクロールしたら合わせない)。絞り込みの URL を書き直すときに `history.state` を消さない。
- 要点のリンクで絞り込んでから「戻る」を押しても絞り込みが残っていた: 絞り込みの無い状態は # を書かないので、# の無い URL に戻ったときを読み飛ばしていた。# が空になったら絞り込みを外す(#overview のようなページ内リンクは今までどおり触れない)。
- アップロード中に別のページへ移って戻ると、続いているアップロードを知らずに「書き出しています」で断っていた。理由を「アップロードしている最中」にし、戻った画面にも進み具合を出して終わりを知らせる。
- **検査**: 画面テスト i(スクロール位置・並べ替え・要点のリンクの戻る / 進む)。アップロード中に戻る場合は、手元では写すのが速すぎて途中の状態を作れず、画面では確かめていない。

### CI を整える(2026-11-09)

この日、CI が 3 回落ちた(配布物の確認を手元で回さずに push、Linux のパスの区切り、画面テストの競合)。

- **決めたこと**: CI と同じ順に手元で回す `npm run ci` と、配布物の確認だけの `npm run smoke`(`scripts/smoke-local.ts`。CI も同じものを使う)。画面テストが落ちたらその時点の画面を `out/ui-failures/` に残し(`ui/failure-shot.ts`)、CI では成果物として 7 日残す。Playwright のブラウザを版ごとにキャッシュする。
- **採らなかった案**: 画面テストの自動のやり直し(retry。競合を隠す。この日の競合は、開いた欄に焦点が移る前に打つテスト側の問題で、待ってから打つ `focusLands` で直した)。
- **検査**: わざと落とすテストで画面が残ること(陽性対照)。

### 3 回目のレビュー(2026-11-09)

PR #8 を網羅的なレビュー(code-review の xhigh)に通した指摘への答え。

- **確認から写すまでの変化**: 点検に指紋(写すセッション・ファイル数・大きさ・秘密らしい文字列の数・集計の時刻)を付け、写すときに渡す。写す直前に点検し直して違えば写さない(`UploadChangedError`。upload-project は確かめ直しに戻り、画面は理由を出す)。入力を待つ間はロックを放すので、その間に集計し直すと確かめていない中身を写してしまうため。
- **名前の衝突**: 名前を比べて止める(0 件のタグやまだ送っていない名前でも止まる)のをやめ、送り先のフォルダの `atlas-index.json` に別のもの(種類か名前が違う)が記録されていれば止める。タグの送信が sessions.json に頼らなくなった(壊れていても止まらない)。採らなかった案: 送り先をタグとプロジェクトで分ける(`<基底>/tags/<名前>`・`<基底>/projects/<名前>`)。根本的だが、すでに送ったフォルダとの関係が変わるので、利用者の判断を待つ。
- **効率**: session-store.db は点検とアップロードで 1 回だけ開く(`openSessionStoreReader`。以前はセッションごとに開き直し、416 件のプロジェクトで 800 回を超えた)。upload-project は sessions.json を 1 回だけ読む。
- **そのほか**: 確認の合計と進み具合の合計を揃える(メモの本文と画像、DB の行も入れる)。戻った画面の直近の結果は 1 回だけ出し、失敗の後にほかから送り直して成功していれば(索引の日時が新しければ)出さない。番号の無い bye(古いページ)は覚えない。日時は report の `dateTime` を使う。`npm run smoke` は回すたびに別の一時フォルダで回す。README と docs/screen.md に変わった動きを書く。

### zip での配布をやめる・記録は送った先で作る(2026-11-09)

- **zip での配布をやめる**: 利用者の判断「zip 対応は撤廃して良い」。`release.yml`(v* タグで GitHub Release に zip を添付)を外し、利用者は `git clone` と `git pull` で使う。CI の配布物の確認は、clone した直後と同じ中身(`scripts/fresh-checkout.ts`。git archive HEAD だけで、レポートのテンプレートは入れない)を `scripts/checkout-smoke.ts` で動かす形に変え、最初の atlas all がテンプレートを作ることも確かめる(以前は zip に入れたビルド済みのテンプレートを作り直さないことを見ていた)。
- **記録(.md)は送らない**: 利用者の判断「容量を圧迫するので、アップロード先のセッションから生成できるなら良い」。送った先で `atlas all --home <送り先>/<名前>` を実行すると、セッションごとの記録(`sessions/<id>.md`)ができることを E2E で確かめ(phase15 e)、送り先の README に作り方を書いた。送り先をタグとプロジェクトで分ける案も使わない。

### まとめて送るプロジェクトを画面で決めておく(2026-11-10)

利用者の依頼「upload-project.bat でアップするプロジェクトもあらかじめツールで設定したい。プロジェクトが多く、毎回 bat で選ぶのが大変」への答え。設定の場所と、新しいプロジェクトの扱いは利用者が推奨案を選んだ。

- **決めたこと**: 画面の「プロジェクト別」の表に「まとめて送る」の印(serve から開いたときだけ)。印は `atlas.config.json` の `uploadProjects`(プロジェクト名の配列)に書き、`PUT api/upload-projects`(`{ project, on }`)で 1 つずつ足す・外す(毎回設定を読み直してから書く。空になれば項目ごと消す)。bat は印があれば番号を聞かずに印のプロジェクトを送り、送る前の確認は 1 回(プロジェクトごとの 1 行と合計、秘密らしい文字列はまとめて)。印の無いプロジェクトは送らずに名前を出す(送るものを選ぶ形。新しいプロジェクトが勝手に送られない)。印が無ければ今までどおり番号で選び、`1 3 5-8` のように複数選べる。
- **まとめて送るときの決まり**: 送る間は集計のロックを持ち続ける(途中で集計し直されないように)。1 つ送れなくても残りは送り、最後に送れなかったものを出して止まる(終了コード 1)。フォルダ名が同じになるプロジェクトを一度に選んだら、何も送らずに止まる。確かめた後にログが変わったら、送っていない残りを確かめ直す。`setup.bat` は `uploadProjects` を尋ねず、書き直すときも残す。
- **採らなかった案**: `setup.bat` の 4 問目で番号を選ぶ(黒い窓でプロジェクトが多いと選びにくい)。bat で一度選んだものを覚える(利用者が画面で決める形を選んだ)。送らないものを選ぶ形(新しいプロジェクトも自動で送る)。
- **検査**: 単体 `upload-project.test.ts`(番号の読み方、複数を選んで送る、印のものだけ送り印の無いものと消えたものを知らせる、印のものが無ければ番号で選ぶ、フォルダ名の重なり、1 つ失敗しても残りを送る)、`group-upload.test.ts`(API の足す・外す・検査・壊れた設定)、`config.test.ts`、`setup.test.ts`(印を残す)、画面テスト j(印を付けると設定に書き、再読み込みしても残り、外すと消え、書けなければ戻す。印を戻す処理を外すと落ちることを確かめた)。

### まとめて送る印のレビュー(2026-11-10)

マージした変更を網羅的なレビュー(code-review の xhigh)に通した 11 件への答え。利用者の判断「直してマージして」。

- **設定ファイルの書き換え**: 読んでから書くまでを `atlas.config.json.lock`(排他で作る。10 秒より古いものは落ちた処理の残りとして消す)の中で行う `modifyConfig` にした。serve の中だけで順にしていたのでは、bat(別のプロセス)が送り先を書くのと重なると印が消えたため。値が配列でも、差し替える・足す・消すだけなら手で書いた他の項目の書き方を残す(括弧と文字列の対応を見て値の範囲を読み、書く前に中身が狙いどおりかを確かめる。外れたら整えて書く)。変わらないときは書かない(`NO_CHANGE`)。
- **画面**: 開いたときに設定ファイルを読めなければ、印を 0 件と見せずに理由を出し、押せないようにする。続けて押したときに先の答えが後から届いても、最後に出した要求の答えでだけ一覧を置き換え、ほかはその印だけを反映する(古い一覧で新しい印を消さない)。
- **bat**: 途中で止まったとき(確かめ直す間に画面で集計し直し始めたなど)も、ここまでに送ったものを出す(以前は「何も送っていません」と出ていた)。確認で `n` を押すと、印は変えずに今回送るものだけを番号で選び直せる。当たらない番号は尋ね直す(集計からやり直しにならないように)。`5 - 8` のように区切りの前後に空白があっても読む。印の無いプロジェクトは、全部の名前ではなく、最近更新した 5 件の名前を出す。確認の表示は 1 つの関数にまとめた。
- **効率**: 点検とアップロードで atlas が足して写すものを読む口(session-store.db・desktop.json)を、1 回の実行で 1 つだけ開いてプロジェクトの間で使い回す(`openUploadContext`)。
- **検査**: 単体(配列の書き方を残す・消す・`NO_CHANGE`・ロックの重なり・古いロック・待つロック、`n` で選び直す、途中で中身が変わったら残りだけ確かめ直す、途中で止まったら送ったものを出す、読む口を閉じずに使い回す、尋ね直す)、画面テスト j(壊れた設定で開いたとき)と j2(先の答えが後から届く)。ロックを外す・残りだけにする処理を外す・止まったときの文を戻す・答えの順の扱いを外すと、それぞれのテストが落ちることを確かめた。
- **採らなかった案**: 設定ファイルの書き換えを serve の中だけで順にする(別のプロセスと重なる)。印の無いプロジェクトのうち「前回の実行より後に増えたもの」だけを出す(前回の実行を覚える場所が要る)。

### アップロード中にタスクタグを切り替える(2026-11-10)

利用者の問い「タグ切り替え時の挙動(の懸念)は?」。これまで、写すのが速すぎて途中の状態を作れず、画面では確かめていなかった。画面テスト g4 で、写す要求の答えを画面に返すのを止めておき(大きなログを写している間と同じ状態)、その間に切り替えて確かめた。

- **見つけた不具合**: (1) 別のタグへ切り替えている間に写し終えると、写したタグへ戻っても結果が出なかった(失敗なら理由も出ない)。見出しに出していないのに「この画面で出した」と記録し、戻ったときの直近の結果を出さなかったため。(2) 写している途中に「すべて」へ外す(見出しが消える)と、写し終えたときに消えた見出しのタグ名を読んで、ページに例外が出ていた。
- **決めたこと**: 結果を「出した」と記録するのは、写したタグの見出しが出ていて実際に出したときだけにする。見出しが消えた後は、タグを読まない。ほかのタグを見ている間に終わったときは、その見出しに「「A」のアップロードが終わりました」(失敗なら理由)とだけ出す。結果の中身は、写したタグを開くと出す。
- **確かめたこと(画面テスト g4)**: 切り替えた先には写しているタグの名前が出て、そのタグでは写せない。終わると知らせが出る。戻ると結果が出る。「すべて」へ外して戻っても同じ。記録を元に戻すと g4 が落ち、見出しが消えた後に読まない処理を外すとページの例外で落ちることも確かめた。
- **レビューの指摘への答え**(code-review の xhigh で 6 件。PR #15 はそのままマージし、続けて直した): (1) 知らせが残ったままそのタグで写すと、進み具合の代わりに古い知らせが出ていた → 写し始めるときに知らせを消し、進み具合の欄に出すものを 1 つの derived(ほかのタグを写している > このタグを写している > ほかで終わった)で決める。(2) 知らせは差し込んだ要素の role=status では読まれないことがある → 常に置いてある status に入れる。(3) ほかのタグを写している間に開いたタグは、自分の直近の結果を尋ねていなかった → 写し終えたら今のタグについて尋ね直す。(4) 知らせの文の組み立てを 1 か所にする。(5) 失敗の場合と、知らせの後に写す場合を画面テスト g5 で確かめる(知らせを消す・尋ね直す・読み上げに入れる処理をそれぞれ外すと g5 が落ちることを確かめた)。
- **Fable のレビューへの答え**(利用者の依頼で、Fable のモデルにも同じ範囲をレビューさせた。重大な欠陥は無く、中〜低の 5 件と隣接する既存の問題 1 件): (1) 編集などの欄を開いている間にほかのタグのアップロードが終わると、今のタグの直近の失敗が欄の誤りとして出て、閉じると二度と出なかった → 欄を開いている間は尋ね直さず、結果も出さない(次に開いたときに出す)。(2) 失敗の知らせの「開くと出ます」は、サーバが覚えない失敗(確かめた後に中身が変わった)では成り立たない → 失敗のときは言わない(理由は知らせに入れる)。(3) 進み具合の問い合わせが重なると「終わった」を 2 回受け取り、その間に写し始めた状態を消しうる → 2 回目を捨てる。(4) 知らせの読み上げを結果とは別の status にする(結果が後から加わっても知らせを読み直さない)。(5) 確かめている間・書き出している間に切り替えると、前のタグの確認や書き出しの結果が切り替えた先に出ていた(既存) → 出さない。テストは g4 に「同じ結果は 1 回だけ」と前の実行の残りの掃除、g6(戻って続きを待っている場合・確かめている間の切り替え・編集している間の終わり)を足した。(1)(2)(5) は処理を外すとテストが落ちることを確かめた。(3) と書き出しの切り替えはテストで再現していない(問い合わせの重なりは画面テストで作りにくい)。

### setup.bat でもエクスプローラーで選ぶ(2026-11-10)

利用者の報告「setup.bat でエクスプローラーが開いていない」。アップロード先をエクスプローラーで選ぶ形は、画面と upload-project.bat にだけ入っていて、setup.bat は黒い窓へのドラッグとパスの入力だけで尋ねていた。

- **決めたこと**: setup.bat でもフォルダはエクスプローラー(画面と同じ `folder-picker.ts`)で選べるようにする。アップロード先は、まだ決めていなければ Enter で開く(決めないなら `n`)。決めてあれば Enter で今のまま、`y` で今の場所から開く。vault は、数えない人が多いので Enter は「終わる」のまま、`y` で開く。ドラッグとパスの入力も今までどおり使える。取り消したら尋ね直す。画面を出せなければ理由を出し、以後はドラッグかパスの入力で尋ねる(PowerShell が止められているなど、押し直しても同じ理由で出せないため。レビューで見つけて直した)。
- **流し込んだ入力では出さない**: エクスプローラーは、黒い窓で答えているとき(標準入力が端末のとき)だけ出す。入力を流し込んでいるとき(CI の clone した状態での確認は、setup.bat に答えを流し込んで動かす)に出すと、閉じる人がいなくて止まるため。そのときは今までどおりの尋ね方になる。
- **検査**: 単体 `setup.test.ts`(選ぶ画面の代わりを渡して、Enter で開く・取り消すと尋ね直す・vault は y で開く・決めてあれば Enter と n はそのまま・y は今の場所から開く・開けなければ理由を出す)。

### 画面の「設定…」(2026-11-10)

利用者の依頼「ツールで llm-wiki やアップロードプロジェクトも設定したい。setup.bat を使わなくてもできるように」への答え。

- **決めたこと**: レポートの右上(「集計し直す」「判定する…」の隣)に「設定…」を置き、ダイアログで setup.bat と同じ設定を決める。llm-wiki の vault(エクスプローラーか入力で調べ、ページのフォルダ・索引・wiki の skill を確かめてから足す。外す)、普段の工程名(保存・既定に戻す)、アップロード先(タスクタグの見出しと同じ操作)、まとめて送るプロジェクト(プロジェクト別の表の印と同じ。名前で絞り込める)。どれも押した時点で書く(modifyConfig。設定ファイルのロックの中で読んでから書く)。vault は集計で数えるので、変えたらダイアログに「集計し直す」を出す。setup.bat は残す(黒い窓で決めたい人のため)。
- **API**: `GET api/settings`(今の設定・既定の工程名・wiki の skill の候補・設定ファイルを読めない理由)、`POST api/settings/vault/describe`(入力を調べる。setup.bat の describeVault)、`POST api/settings/vault/pick`(エクスプローラーで選んで調べる)、`POST api/settings/wikis`(足す。同じ名前は 409)、`POST api/settings/wikis/remove`(番号と名前で外す。ほかで書き換えていて合わなければ 409)、`PUT api/settings/phases`(null で既定に戻す)。設定ファイルには setup.bat と同じ形(path だけなら文字列)で書き、外すときは書いてあるとおりの値(`~/` を展開していないもの)から外す(modifyConfig に書いてあるとおりの中身も渡すようにした)。
- **まとめて送るプロジェクトの一覧**: 空のセッションだけのプロジェクトは出さない(upload-project.bat は空のセッションを送らないので、印を付けても何も送られない)。実データでは、出さないと 88 件、出さなければ 60 件で bat の一覧と揃う。
- **採らなかった案**: 設定を別のページにする(ほかの操作と同じダイアログの形の方が迷わない)。vault の細かい項目(拡張子)を画面で決める(setup.bat も尋ねない。手で書く)。
- **検査**: 単体 `settings.test.ts`(token・候補の skill・調べる・選ぶ・足す・同じ名前・外す・ほかで書き換えた・~/ を残す・工程名・壊れた設定)、画面テスト k(エクスプローラーで vault を選んで足す・入力で足す・外す・工程名・アップロード先・まとめて送るプロジェクト・閉じると焦点が戻る・壊れた設定では変えさせない)。実データで、設定のダイアログに今の vault と 60 件のプロジェクトが出ることを確かめた(設定ファイルは写しを使った)。
- **Fable のレビューへの答え**(利用者の依頼。致命的な不具合は無く、軽微〜中程度の 5 件とテストの穴): (1) 設定ファイルを書けない(ほかのプログラムが開いている・フォルダが無い)ときも 400(入力の誤り)にしていた → 500 にする。(2) 同じ vault の判定が `~/` を展開せず、フルパスとフォルダ名を別のものとして二重に足せた → `~/` を展開し、Windows では大文字小文字を区別せず、フルパスの最後のフォルダ名とフォルダ名を同じ vault とみなす。(3) エクスプローラーでドライブの直下を選ぶと、名前の無い vault を足そうとしていた → 選んだ時点で理由を返す。(4) ヘッダの「集計し直す」で集計し直しても「集計し直します」の案内が残った → 集計し直し始めたら消す。(5) 足す・やめる・外すの後に焦点が本文の先頭へ落ちた → vault の入力欄へ戻す。テストは、同じ vault・ドライブの直下・書けない(500)・ロック(409)、画面から skill を書く経路と足した後の焦点を足した(同じ vault の判定と焦点を戻す処理を外すと落ちることを確かめた)。(4) はテストで再現していない(画面テストの中で本物の集計し直しを動かすことになるため)。

### 画面をすべて閉じてもサーバが止まり切らない(2026-11-10)

CI の画面テスト `ui/heartbeat.test.ts`(外へ移ると猶予の後に止まる)が、Windows・Node 24 だけで時々落ちていた(直近 30 回のうち 4 回)。手元では、CPU を遅くしても(20 回)、CPU を目いっぱい使わせても(25 回)落ちなかった。CI と同じ 4 コアに絞り、負荷をかけて回すと、25 回のうち 8 回落ちた。

- **原因(実測)**: 最後の bye はサーバに届き、猶予の後に止める処理(`close`)にも入っていた。そこで `server.close()` が、ブラウザが次の要求のために先に開けておき、まだ 1 バイトも送っていない接続を待ち続けていた。Node はこの接続を「要求の途中」とみなして閉じない。すべての接続を切る `closeAllConnections()` は `close()` が終わった後にしか呼んでいなかったので、ブラウザがその接続を閉じるまで止まらなかった(70 秒待っても止まらなかった)。実際の使い方では、atlas の画面をすべて閉じても、ブラウザを開いたままなら `atlas.bat` の黒い窓が残ることがあった。最初に推測した「bye が届かない」は外れ。
- **決めたこと**: 止めるときは、`server.close()` の直後に `closeAllConnections()` を呼び、待たずにすべての接続を切る(止める時点で開いている画面は無い)。
- **検査**: serve の単体テストに、何も送っていない接続と送りかけの要求を残したまま bye を送り、猶予の後に止まることを足した。直す前のコードでは 5 秒たっても止まらずに落ちることを確かめた(何も送らない接続 1 本だけでも止まらなかった)。手元で 4 コアに絞って負荷をかけた再現でも、直した後は 25 回すべて止まった。
- **同じ PR で直した画面テスト**: この PR の CI(ubuntu・Node 24)で、設定の画面テスト k が 1 回落ちた。設定ファイルに書かれたのを確かめた直後に画面の文字を読んでいたので、答えが画面に届いて書き換わる前に読むことがあった。待ってから読むようにした(同じ形の 4 か所)。

### 画面とサーバの版のずれを知らせる(2026-11-10)

利用者の報告「設定を読めませんでした、無い API です、と出た」。サーバ(黒い窓)は起動したときのコードのまま動き続けるが、「集計し直す」は子プロセスでディスク上の新しいコードを動かして画面を作り直す。そのため、atlas を更新した後に集計し直すと、「設定…」のある新しい画面が `/api/settings` の無い古いサーバにつながっていた。2 つ目の `atlas.bat` も、動いているサーバがあればブラウザを開くだけなので、古いサーバのままになる。利用者の判断「入れる」。

- **決めたこと**: 版の目印(`core/src/code-stamp.ts`。`packages/*/src` と report の `template.html` の中身から作る 16 桁のハッシュ。ビルドしたもの・テスト・説明書は入れない)を、集計がページ(atlas.html と詳細・用語・指示文・気づきのページ)の `<meta name="atlas-code">` に埋め込み、サーバは起動したときの目印をすべての応答の `x-atlas-code` で返す。画面は最初に成功した heartbeat の応答で 2 つを比べ、違えば(目印を返さない、これより前のサーバも)「画面とサーバの版が違います(atlas を更新した後に、サーバを起動し直していません)。atlas.bat の黒い窓を閉じてから、もう一度 atlas.bat を実行してください」の帯を出す。閲覧と編集はそのまま(新しい操作だけが使えない)。サーバが止まったら「サーバが止まっています」の帯に替える。2 つ目の `atlas serve` が動いているサーバを使い回すときも、目印が違えばターミナルに同じことを出す(`atlas.bat` はその後すぐ閉じるので、画面の帯が本来の知らせ方)。
- **採らなかった案**: 版の番号を手で上げる(上げ忘れると知らせない)。2 つ目の `atlas.bat` が古いサーバを止めて起動し直す(古いサーバに止めてもらう口が無く、プロセスを止めると動いている集計や判定の子プロセスが残る)。古いサーバのときに編集を止める(使える操作まで止まる)。
- **検査**: 単体 `code-stamp.test.ts`(src の下と template.html が変われば変わる・名前が変わっても変わる・dist とテストと説明書では変わらない)、serve の単体テスト(どの応答にも目印・`codeStamp: null` で返さない・`findRunningServer` が目印を返す)、E2E(CLI で作ったページの目印とサーバの目印が同じ・詳細ページにもある・違う版のサーバを使い回すとターミナルに出る)、画面テスト(同じ版・違う版・目印を返さないサーバで、一覧と詳細ページの帯)。詳細ページで比べる処理・一覧で比べる処理・サーバの目印をそれぞれ外すと、画面テストが落ちることを確かめた。

### 止まり方と版の目印のレビュー(2026-11-10)

上の 2 つ(止まり切らない・版のずれ)を入れた後のレビューで見つけた 6 件を直した。

- **止める前に、応えている途中の要求を待つ**: 上で入れた `closeAllConnections()` は、応答の途中の要求も接続ごと切っていた(フォルダを選ぶ画面を出したまま atlas の画面を閉じた、アップロードの途中に猶予が切れた、など。「止める時点で開いている画面は無い」は、応えている途中の要求が無いことまでは意味しない)。サーバが、処理が済んで応答を送り終える(か相手が切る)までの要求を数え、自分から止まるとき(`expire`)はジョブと同じように終わるまで待ち、終わってから猶予を測り直す。相手が先に切っても、処理が続いていれば待つ。中断(Ctrl+C)はこれまでどおりすぐ切る。採らなかった案: `closeIdleConnections()` で使っていない接続だけを切って待つ(Node は何も送っていない接続を「要求の途中」と数えるので、止まり切らない元の不具合に戻る)。
- **目印の材料**: `src` の下の、エディタや OS が置く作業ファイル(`.` で始まるもの、`~` `.bak` `.orig` `.rej` `.swp` `.swo` `.tmp`、`Thumbs.db` `desktop.ini`)は数えず、改行は LF にそろえてから数える(コードは同じなのに帯が出るのを避ける)。逆に、画面の作り方と依存を決めるファイルを足した(各パッケージの `vite.config.ts` `svelte.config.js` `tsconfig.json` `package.json`、リポジトリの直下の `package.json` `package-lock.json` `tsconfig.json`)。`scripts/` は、サーバも画面も読まないので入れない。採らなかった案: 拡張子の一覧にあるものだけを数える(新しい種類のソースを足したときに、黙って目印から漏れる)。
- **目印の置き換えの空振り**: テンプレートに `__ATLAS_CODE__` が無ければ、集計を止めて理由を出す(`embedCodeStamp`。以前は黙って進み、ページは版を比べられなかった)。
- **帯とターミナルの文**: 「atlas を更新した後に、サーバを起動し直していません」は、サーバが古いと決めつけていた。ページのほうが前の版のこともある(通常の `atlas build` が消さずに残す、前回の export の `instructions.html`。開いたままのタブ)。「この画面を作ったときと、サーバを起動したときとで、atlas のコードが違います」に改め、直し方に「新しく開いた画面を使ってください」を足した(ポートは起動のたびに変わるので、前のタブは読み込み直せない)。残した `instructions.html` の目印は書き換えない(前の版で作ったページなのは本当)。集計のログに、作り直し方(`atlas export` か `atlas all`)を足した。
- **検査**: serve の単体テストに、フォルダを選ぶ画面を出したまま bye を送り、猶予が過ぎても止まらず、応答が最後まで届き、その後で止まることを足した(相手が先に切ったときも)。待つ条件を外すと落ちることを確かめた。`code-stamp.test.ts` に、設定と依存のファイルで変わる・作業ファイルと改行では変わらない、を足した。`code-embed.test.ts` に、位置が無いテンプレートで止まることを足した。
- **見送ったもの(レビューで挙げたが直していない)**: 2 つ目の `atlas.bat` が古いサーバを見つけても知らせるだけで開く、画面テストの「同じ版なら出さない」が 500ms の待ちに頼っている、止まり方の単体テストの「3 秒以内」、Host を断る応答にも目印が付く、版を比べる決まりが `code-check.ts` と `NAV_JS` の 2 か所にある。

## 決めたこと・採らなかった案

- Svelte 5 を採用(理由は開発体験。単一 HTML のサイズ差はデータ量に比べて誤差)。
- 索引・トークンとも「正典を一つに決める」のではなく和集合+出所記録にした(実測で包含関係が無いため)。
- 公式スキーマを CI の正典にしない(1.0.18 のもので実データと乖離)。
- 採らなかった案: Python 標準ライブラリ構成、ローカルサーバ型ダッシュボード、生イベントの HTML 埋め込み、`--add-dir` によるバンドル受け渡し。
- `data.db`(デスクトップアプリ)は Phase 10 まで読まなかった(対象はアプリのセッションだけで、モード・推論強度・文脈の内訳は events.jsonl と session-store.db で代替でき、`accounts.access_token` などの資格情報列を含むため)。Phase 11 から、ユーザーの判断で許可リストの列だけを immutable の読み取り専用で読む(「Phase 11」)。

### upload-project.bat の黒い窓を短くする(2026-11-11)

利用者の依頼「upload.bat はもっと見やすく簡潔に。一般利用者は目が滑る」。前の表示は、集計の経過(長いパスの行が 18 行ほど)に続いて、1 行に事柄を 2〜3 つ詰めた文と、写している途中の行(1 割ごと)が並び、見るべき「何を・どこへ送るか」と「y で送る」が埋もれていた。

- **決めたこと**: 場面ごとに見出し(`== 送るプロジェクト ==`・`== 送り先 ==`・`== 送る前の確認 ==`・`== 送っています ==`・`== 終わりました ==`)で区切り、1 行に 1 つのことだけを書く。一覧は名前の列をそろえ(全角を 2 と数える。名前の列は 40 桁まで)、件数は「セッション」にそろえる。尋ねる文は 2 行(何を入れるかと `> `)。
- **出さなくしたもの**: 集計の経過(`%TEMP%\atlas-upload-project.log` に書く。失敗の理由はエラー出力なので窓に残る)、確認の「N ファイル」「大きいもの」「何時の集計の時点か」、印のときの印のプロジェクトの一覧(すぐ後の確認に並ぶ)、送り先を覚えたときの設定ファイルのパス、秘密らしい文字列のファイルは 10 件から 5 件に。
- **途中の様子**: 調べている・写している間は 1 行を書き換えて出す(`io.status`)。出力が端末のときだけで、ファイルやパイプに流すときは出さない。窓の幅に収めて切る(折り返すと 1 行では消えないため)。送った結果は 1 プロジェクト 1 行。
- **止まるとき**: 送れなかったものは画面の「送れなかったものがあります」にまとめて出し、`UploadIncompleteError` で止まる(bat の最後に同じことを 2 度書かない)。ほかの理由で止まったときは「止まりました: 理由」。
- **採らなかった案**: 集計の経過を 1 行の書き換えで見せる(main.ts の出力を変えることになり、atlas.bat の窓にも響く)。色を付ける(古い端末やリダイレクトで制御文字が残る)。
- **検査**: 単体 `upload-project.test.ts`(新しい文、途中の様子は status にだけ出る、送れなかったときの例外、画面での幅)、実際の端末で書き換えの行が残らないこと(架空のデータで 20 回書き換えて消えた)、`checkout-smoke.ts` の bat の起動(見出しまで進むこと)。

#### 見直しで直したこと(2026-11-11)

上の変更をレビューして見つけた 10 件を直した。

- **集計を upload-project.ts の中で動かす**: bat が `main.ts all` の出力を丸ごとファイルに流していたので、集計の「注意」(DB を今回は複製できず前回の複製を使った、など)が窓に出ず、古いログを送っても気づけなかった。集計が終わるまで窓が 1 行のまま動かず、その間に押した Enter が、別のプログラムである送る操作の最初の答え(やめる)になっていた。今は `refreshAggregate` が `run(parseCli(['all']))` を同じプロセスで動かす。経過は `%TEMP%\atlas-upload-project.log` に書き、段階は 1 行の書き換えで出し、「注意」を含む行は窓に出す。失敗したら理由とログの場所を出し、送る操作には進まない。bat の `goto all_failed` と、引用符の無い `echo %ATLAS_UPLOAD_LOG%` はなくした。main.ts の出力は変えていない(atlas.bat の窓には響かない)。
- **先打ちの入力を捨てる**: 入力が端末のときは、尋ねていない間に届いた行を捨てる。パイプで流し込んだ入力(スモークとテスト)では、今までどおり尋ねる前に届いた行も順に使う。
- **文**: 印のある流れでも、ログが無くて送れないセッションの数を出す。送る途中で確かめ直しになり、そこでやめたときの見出しは「途中でやめました」にして、残りのプロジェクトを出す(前は「終わりました」と出ていた)。置き換えた前のフォルダを消せなかったとき(送り先で開かれていた)は、その場所を出す(`GroupUploadResult.leftovers`)。
- **画面での幅**: 全角の範囲の外にある絵文字(☕ ✅ など)は 2、結合する記号・ZWJ・異体字セレクタは 0 と数え、U+FE0F が付いた文字は 2 とする。`fit` は、ここまでの全体の幅で切る。
- **検査を足した**: 集計の注意・段階・失敗の道(`refreshAggregate`)、`consoleIo`(偽の端末で、書き換えの行を窓の幅に収め、次の行の前に消すこと。端末でなければ status を持たないこと。先打ちを捨てることと、パイプでは使うこと)。スモークは upload-project.ts を架空の fixture で動かす(中で集計するので `ATLAS_COPILOT_HOME` を渡す)。
- **採らなかった案**: main.ts に「1 行で進み具合を出す」出し方を足す(atlas.bat と CLI の出力が変わる。送る操作だけで要るので、upload-project.ts の中に閉じた)。集計の時点の日時を確認に戻す(同じプロセスで集計したばかりなので、注意の方が役に立つ)。
- **bat の読み違え(見直しの途中で見つけた、前からの不具合)**: スモークを強めたら、`upload-project.bat` と `setup.bat` が、`node` や `pause` から戻った後に、冒頭の説明の行の途中(`'r'`・`'pm'` など)をコマンドとして実行していた。#25 の版でも、入力をパイプで渡しても NUL にしても毎回起きた(実測。cmd の文言が cp932 で出るため、前のスモークは文言で見つけられずに通っていた)。原因は、`chcp 65001` の前後の日本語の `rem` を読んだ分だけ、cmd が bat を読み直す位置がずれること(説明の行を ASCII に置き換えると起きなかった)。説明の `rem` は 3 本とも、最後に実行する行(`exit /b` で終える)の後ろに移した。移した版は、パイプと NUL で 15〜30 回ずつ動かして一度も起きなかった。`launchers.test.ts` でこの並びを確かめる。スモークは、bat のエラー出力に何か出たら止める(cp932 の文言も読む)。
  - 原因について確かめたのは次の範囲だけ: 説明の行を同じバイト数の ASCII に置き換えると起きない。説明を `chcp` の後ろに移しただけでは、パイプで入力を渡したときにときどき起きた(4〜12 回に 1 回)。最後に実行する行より後ろに移すと起きない。読み直す位置がずれる仕組みそのものは確かめていない。検査は「`chcp 65001` より前に日本語を書かない」と「説明の rem は最後に実行する行より後ろ」の 2 つを見る。

#### 2 度目の見直しで直したこと(2026-11-11)

上の直しを、別のモデル(Fable 5.1)にレビューしてもらって見つかった 6 件。

- **bat の終了コード**: `& exit /b` で終えると、cmd の終了コードは前のコマンドに関わらず 0 になる(実測: `cmd /c exit 7 & … & exit /b` は 0)。集計に失敗しても `upload-project.bat` が 0 を返していた。最後の `node` の次の行で `set "code=%errorlevel%"` と取っておき、`exit /b %code%` で返す(同じ行に `%errorlevel%` を書くと、行を読んだ node の前の値になる)。`atlas.bat` も `exit /b %errorlevel%` にした。`launchers.test.ts` で並びを確かめ、スモークは bat の終了コードが 0 かも見る。
- **集計の中で console に直に書かれるもの**: 初回のテンプレートのビルドで Vite が出す警告は、console に直に書かれ、書き換えている 1 行に混ざっていた。`refreshAggregate` の間だけ `console.log/info/warn/error` を log に通し、警告とエラーは注意として窓に出す。段階の頭が無い行(「レポートのテンプレートをビルドしています…」)は、その文のまま 1 行に出す。
- **集計中に押した Enter**: 行は捨てていたが、端末が写した改行で進み具合の行が上に残っていた。捨てたときに 1 行上へ戻って消し、書き換えていた 1 行を書き直す。
- **途中でやめたとき**: 「やめました(残りの N プロジェクトは送っていません)」と、まとめの「残りの N プロジェクト(…)は送っていません」が続けて出ていた。やめたときの行は「やめました。」だけにした。
- **画面での幅**: 国旗(地域指示記号 2 つ)と、ZWJ でつないだ絵文字は全体で 2 と数える。

#### 3 度目の見直しで直したこと(2026-11-11)

マージした後の差分を、別のモデル(Fable 5.2)でレビューして見つかった 10 件。

- **Enter を押していない先打ち**: 端末は、Enter を押すまでの文字を自分で持っていて、こちらには届かない。届いた行を捨てるだけでは、集計を待つ間に打って Enter を押さなかった文字が、次の答えの頭に付いた(実測: 待つ間に `y`・`z` を打ち、質問が出てから Enter だけを押すと、答えが `"yz"` になった)。入力が端末のときは、尋ねていない間は 1 文字ずつ届く状態(raw)にしてその場で捨て、尋ねている間だけ行で受け取る状態に戻す。尋ねる直前に 50 ミリ秒待つ(集計で手が離せなかった間のキーが届き切ってから捨てるため)。直した後は、同じ操作で答えが `""`、次の質問に `n` と Enter で `"n"`(実測。隠した本物のコンソールにキーを書き込んで確かめた。窓に余計な行は残らず、閉じた後は端末が元の状態に戻る)。raw の間は Ctrl+C も文字として届くので、端末を元に戻して終了コード 130 で終わる(実測。out のロックは、持ち主の処理が生きているかで見るので残っても害は無い)。`setRawMode` が無い端末では、前のやり方(届いた行を捨て、写った行を消す)に落とす。
- **集計の注意**: 「注意」を含む行をすべて窓に出していたので、送るものに関わらない注意(記録で伏せた文字列の数など)や、文の途中に「注意」とある行も出ていた。窓に出すのは、行の頭が `snapshot: 注意` のもの(ログを写す段階の注意 = 送るログが古いかもしれない)だけにした。ほかは経過のファイルにだけ書く。
- **console の警告と直書き**: `console.warn/error` を「注意」として窓に出すのをやめ、経過のファイルに `警告: …` と書いて、件数とファイルの場所を「集計しました」の前に 1 行で出す。`process.stdout/stderr.write` に直に書かれるもの(node の警告を stderr に書く `core/sqlite.ts` など)と `console.debug` も、集計の間は経過のファイルに通す(書き換えている 1 行に混ざらない)。`consoleIo` は書く口を作ったときに取っておく(差し替えの間も、自分の出力は窓に出る)。
- **経過のファイル**: 最後にまとめて書いていたので、途中で窓を閉じると何も残らなかった。1 行ごとにその場で書く。失敗したときはスタックも書く(窓には理由だけ)。
- **1 行の表示**: 改行やタブを含む文は、空白にして 1 行にする(status と、窓に出す注意・失敗の理由)。
- **まとめの文**: 送れなかったものがあるとき、確かめ直しでやめて送らなかった残りを書いていなかった(送れなかったものだけに見えた)。残りも出す。`n` で選び直してから何も選ばずにやめたときも「やめました。」だけにして、「送っていません」がまとめと 2 度出ないようにした。
- **画面での幅**: 肌の色の修飾(U+1F3FB〜1F3FF)は前の絵文字に重なるので 0(前に絵文字が無ければ 2)。ソフトハイフン(U+00AD)は 1。
- **消せなかった前のフォルダ**: 知らせるのが bat の流れだけだった。画面のアップロードの結果にも、件数と場所(3 件まで)を出す(`GroupUpload.leftovers`)。CLI は前からフォルダごとに 1 行出している。
- **スモークの読み方**: bat の出力を、UTF-8 として化けたら丸ごと cp932 で読んでいたので、cp932 の行(cmd の文言)と UTF-8 の行(中の node の出力)が混ざると、片方が化けた。1 行ずつ、UTF-8 として正しければ UTF-8、そうでなければ cp932 で読む(`scripts/console-text.ts`)。エラー出力に何か出たときの失敗の文も、「cmd が読めずに止まりました」(読み違えの文言があったとき)と「エラー出力に何かを書きました」に分けた。
- **採らなかった案**: 先打ちは README の書き方だけを直す(答えに混ざること自体は残る)。raw のまま自分で行を組み立てる(日本語入力や編集キーを自分で扱うことになる)。警告をすべて窓に出す(初回のビルドのたびに、送ることに関わらない Vite の警告が並ぶ)。
- **検査**: 単体 `upload-project.test.ts`(偽の端末で raw の切り替えの順・捨てること・Ctrl+C、注意の出し分け、直書きの取り込みと書く口の戻し、経過をその場で書くこと、まとめの文、幅)。直す前のコードに同じテストを流すと 11 件落ちる(確かめた)。`launchers.test.ts`(cp932 と UTF-8 が混ざった出力の読み方)。画面のテスト g(消せなかったフォルダの文。実際に残るのは送り先で開かれているときだけなので、サーバの答えに足して確かめる)。

### 判定から opencode を外す・本物の copilot で通す(2026-11-11)

- **外したもの**: 判定と下書きのバックエンド `opencode`(`packages/judge/src/backends/opencode.ts`、`--backend opencode`、`ATLAS_OPENCODE_BIN`、出力の読み取りの opencode の形)、画面の「判定に使うもの」の選ぶ欄(copilot -p の 1 行だけにした)、README と docs の記述。`POST /api/jobs` の `backend` は項目を残し、受ける値を `copilot-cli` だけにした(画面とサーバの版がずれても形は同じ)。この節より前の記述は、当時の記録としてそのまま残す。
- **残したもの**: 前に opencode で判定した `judgments.json` を読むこと(`schema.ts` の `BACKENDS` と、レポートの表示名)。単体テストを 1 つ足した。
- **本物の copilot での実走**(copilot 1.0.109、架空のデータだけ。Copilot に保存した自分のモデル `anthropic/claude-haiku-5-5` を `--model` で指定):
  - 工数: `all` → `bundle`(11 件、添付 3 つ)→ `judge run --limit 2` が 2 件成功・失敗 0(1 件 10 秒ほど)。使用量は GitHub の AI クレジット 0、入力 12,922・出力 2,633 トークン。
  - 依頼ごと: `turns bundle --unjudged`(20 依頼)→ `turns run --limit 12` が 5 回の呼び出しで 14 依頼を判定、失敗 0(32 秒)。
  - チャットの流れ(M365 Copilot の代わりに同じモデルに、画面の依頼文と添付ファイルの本文を渡した): `bundle --unjudged` の添付 → 返答 → `judge import` で 5 件、`turns bundle --unjudged` の添付 → 返答 → `turns import` で 6 件。`export` の後、`turns.csv` の「判定:」の列と atlas.html に判定が入った。
  - ツールの制限: 判定の間のツールの呼び出しは 0 回。同じ引数で起動してモデルに尋ねると、使えるツールは `view` だけと答え、作業フォルダの外のファイルの `view` は拒否された(シェル・書き込み・URL の取得は、ツールが無いので試せなかった)。
- **わかったこと**: 保存した自分のモデルは `--model <プロバイダー名>/<モデル ID>` で指定する(ID だけだと `Model "…" is not available`)。`turns run --limit` は依頼のまとまりごとに確かめるので、上限を少し超える(12 に対して 14)。どちらも docs/judge.md に書いた。
- **未検証**: M365 Copilot そのものでの判定(モデルも添付の扱いも違う)。画面の「判定する…」から本物の copilot を動かすこと(画面はモデルを選べないので Copilot の既定のモデルと AI クレジットを使う)。実データでの判定。
- **採らなかった案**: 文言だけを消して `--backend opencode` を残す(使い方がどこにも書かれていない機能が残る)。`BACKENDS` からも消す(前の判定結果が読めなくなる)。

### アップロード先から集計し直す側の見直し(2026-11-11)

送った先のフォルダを `--home` にして集計し直す側(読む側)を、コードを読むのと、架空のデータでの実走で見直した。見つけた 6 件を直した。

- **出力先の使い回しでセッションが混ざる**(高): 前に別の場所から集計した `--out` に別の `--home` を集計すると、前のセッションのフォルダと DB が残ったまま足され、両方のセッションが 1 つのレポートに出ていた(実測)。`snapshot` は、前の `snapshot-manifest.json` の `sourceRoot` と今の `--home` が違えば、何も書かずに止まる。同じ場所を別の書き方で指しているだけのときは、manifest を消せば続けられる(文に書く)。
- **置き換えの途中・消し残しのフォルダを数える**(中): `.<id>.old`(送り先で開かれていて消せなかった前のもの)と `.<id>.uploading` が、id の違う別のセッションとして入り、トークンが二重に数えられていた(実測)。`snapshot` は写さずに `extras.skipped` に記録し、`extract` は件数を警告に出す。前の版が写したスナップショットに残っていても、`listSessionDirs` が数えない。名前の決め方は core に置き、送る側と同じものを使う。
- **形が違う `atlas-session-store.json` で集計の全体が止まる**(中): `sessions: [null]` などで `extract` が例外で終わり、ほかのセッションも集計できなかった(実測)。行がオブジェクトであること、このセッションの行の列の型、必ずある列を確かめ、違えばそのファイルを使わずに警告を出して続ける。
- **プロジェクト名を読む側のディスクで決め直す**(中): ログのパスは送った PC のもので、読む PC の同じパスの `.git/config` を読んでプロジェクト名を決めていた。作業フォルダが無ければパスのままになり、同じパスに別のリポジトリがあればその名前になった(実測)。送る側が `atlas-session.json` に `projectSource` も書き、読む側は、直下にセッションが並ぶ形(`layout: flat`)のときは `.git/config` を読まず、この記録の `project` と `projectSource` を使う。`projectSource` の無い記録(前の版)は、名前の形から決め方を決める。
- **基底を指すと 0 件のレポートができる**(低): `--home <基底>` は、エラーにならずに 0 件のレポートを作っていた。下に写したフォルダがあれば、その名前と指定の例を出して止まる。
- **リンクを辿る**(低): セッションのフォルダの中のファイルがシンボリックリンクだと、指す先(フォルダの外)を出力先に写していた。辿らずに `extras.skipped` に記録する。
- **ついでに**: `desktop.json` が読めないときに、黙って使わなかったのを、警告に出すようにした。送り先の README の「出力先は好きな場所に」は、このフォルダ用に分けるように書き直した。
- **決めたこと**: 出力先が違うときは、前のスナップショットを消さずに止まる(前の出力先が、消えた PC のログの唯一の複製かもしれない)。記録の無い、手で作った直下の形のフォルダは、git の origin からプロジェクト名を決めなくなる(パスのまま)。
- **採らなかった案**: 出力先が違うときに前のスナップショットを自動で消して作り直す(上の理由)。基底を指したときに下のフォルダをまとめて集計する(タスクタグをまたいで同じセッションがあると二重に数える)。プロジェクト名を `atlas-index.json` から取る(セッションのフォルダだけを写して渡したときに無い)。
- **検査**: 単体 `packages/core/test/upload-read.test.ts`(8 件。形が違う 16 通り、記録の読み方、リンク)。E2E `e2e/phase16.test.ts`(6 件。送ってから、作業フォルダを消す・同じパスに別のリポジトリを置く・消し残しを置く・出力先を使い回す・添えた行を壊す・基底を指す・リンクを置く)。対照として、元の集計では同じセッションのプロジェクト名が作業フォルダの `.git/config` から決まることも確かめる。
- **未検証**: ほかの PC・ネットワークドライブ・実データでの集計し直し。UNC のパスの扱いと、写した `session.db` を書き込み可で開くところは、コードを読んだだけで、変えていない。DB にしか無いセッション(ログのフォルダが無い)は、前から送らない。

### 4 度目の見直しの 10 件(2026-11-11)

送る側(upload-project.bat)と読む側(送った先からの集計し直し)の差分を見直して見つけた 10 件を直した。

- **Ctrl+C の後始末**: 黒い窓が 1 文字ずつ受け取っている間の Ctrl+C は、書き換えていた 1 行を消して「中断しました。」を出し、SIGINT を受ける処理があればそれに任せ、無ければ終了コード 130 で終わる。`process.exit` は `finally` を通らないので、集計の作業中の印(`out/.job.json`)は `'exit'` で外す(自分の印だけ)。写している途中の `.<id>.uploading` は消さない(次のアップロードが片付け、集計は数えない)。
- **同じ場所かの判定**: 文字列の比較だけだったのを、実際の場所(`realpath`。違えば inode)でも比べる。ジャンクション・リンク・大文字と小文字の違いは同じ元として通す。無くなった場所は、書かれたパスのまま比べる。
- **途中で止まった集計の後の混ざり防止**: manifest は最後に書くので、途中で止まると前の元が分からず、別の元を足せた。始めるときに `snapshot-source.json` に元の場所を書き、manifest と両方を見る。続けたいときに消すファイルは、止めるときの文に両方を挙げる。
- **置き換えの途中で止まったセッション**: 本体のフォルダが無く、作業用のフォルダだけがあるセッションは、集計から丸ごと消えていた。写し終えている `.<id>.uploading`(最後に書く `atlas-session.json` まである)を先に、無ければ `.<id>.old` を、元の id で写す。`extras.recovered` に記録し、ログと警告に出す。送る側は、前の回が残した `.<id>.old` を、新しいフォルダを置けたら消す。
- **送った側の記録の扱い**: `atlas-session.json` の `project` は前後の空白を落とし、制御文字を含むものは使わない。まとめ用の名前と決め方が合わないものは、名前に合わせる。(id の一致と決め方の値の検査は前からあった。読む側の `projects` の設定より記録を優先するのは、前からの決めたこと)
- **基底かどうかの判定の読みすぎ**: 関係のない大きなフォルダを `--home` に指すと、下の全フォルダの中まで読んでいた。索引(`atlas-index.json`)は全フォルダで 1 回ずつ確かめ、索引の無いフォルダを中まで見るのは名前の順で先頭の 20 個まで。
- **前の版が写した作業用のフォルダ**: 出力先に残っていると、警告なしに数えなくなっていた(前の集計より件数が減る)。数えていないことと場所を警告に出す。
- **桁の数え方**: 肌の色の修飾(U+1F3FB〜1F3FF)が、修飾を受けない文字(漢字など)の後ろで 0 桁になっていた。修飾を受ける絵文字(`Emoji_Modifier_Base`)の後ろでだけ重ねる。
- **集計の警告の知らせ方**: 件数は、書き込みの回数で数えていて合わなかったので出さない(あったことと経過のファイルの場所だけ)。差し替えた出力を戻すのは 1 か所にした。
- **`POST /api/jobs` の backend**: 値が 1 つだけなので省けるようにし(無ければ `copilot-cli`)、画面は送らない。書いてあれば今までどおり確かめる(`copilot-cli` 以外は 400)。
- **決めたこと**: 元の場所の印は出力先のスナップショットの中に置く(`snapshot-source.json`)。中断のときに `.<id>.uploading` を消さない。backend はサーバ側の省ける項目として残す(子プロセスの引数は変えない)。
- **採らなかった案**: manifest を始めに書く(写さなかったものの一覧は終わるまで決まらず、`createdAt` を写した日時としてアップロードの README と索引に書いている)。作業用のフォルダを読む側で消す・名前を戻す(送り先は読む側のものとは限らない)。警告を行で数えて件数を出す(何行にもなる 1 つの警告で合わない)。backend を API から消す(前の画面が送ってくる値で 400 になる)。
- **検査**: 単体 `packages/core/test/upload-read.test.ts`(13 件。途中で止まった集計、ジャンクション、作業用のフォルダからの復元、基底の判定の上限、記録の名前)、`packages/cli/test/upload-project.test.ts`(桁、Ctrl+C の出力)、`group-upload.test.ts`(前の回の `.old` の片付け)、`jobs.test.ts`(backend の省略)。
- **未検証**: 割り当てたドライブ(subst・ネットワークドライブ)を同じ場所とみなせるか(`realpath` の仕様からの推測)。集計が同期の処理をしている間の Ctrl+C は、その処理が終わるまで届かない(構造上そのまま)。本物の黒い窓での Ctrl+C の見え方。

### 別のフォルダを開く(2026-11-11)

いつもの画面(この PC のセッション)のほかに、アップロード先に集まったセッションを選んで見られるようにした。送り先は `<送り先>\<名前>\<プロジェクト>\<セッション ID>\` の形で、`<送り先>` を選ぶと全員の分、`<名前>` を選ぶとその人の分、`<プロジェクト>` を選ぶとそのプロジェクトの分になる。

- **読む側**: アップロードしたフォルダが並ぶ場所を、2 段下まで読む(`describeSource`。それまでは 1 段下までで、人ごとのフォルダが並ぶ場所を指定すると止めていた)。2 段下まで読むかどうかは、直下の先頭の 20 個のフォルダについて、その下の先頭の 50 個に索引(`atlas-index.json`)があるか、索引が無ければ先頭の 3 個にセッションのフォルダが並ぶかで決める。束ねたフォルダは `<名前>/<プロジェクト>` の形で `sessions.json` の `source.folders` に残す。
- **コマンド**: `atlas open <フォルダ>`。フォルダを確かめ(`checkFolder`)、`<out>-folders/<キー>/out/` に `all` と同じ手順で集計し、そのフォルダのサーバを立てる。そのサーバがもう動いていれば、ブラウザを開くだけにする。状態は `<out>-folders/<キー>/folder.json`(`aggregating` → `serving` → 終わると消す。失敗は `failed` と理由)。
- **サーバ**: `/api/folders`(一覧)・`/api/folders/pick`(エクスプローラーで選ぶ)・`/api/folders/check`(調べる)・`/api/folders/open`(別のプロセスで `atlas open` を始める)・`/api/folders/forget`(一覧から外す)。どれも token が要る。開いたフォルダのサーバは、同じ一覧を返し、自分のフォルダを「この画面」とする。
- **画面**: レポートの右上の「別のフォルダを開く…」(`OpenFolder.svelte`)。フォルダを選ぶ → 調べる(何を読むかを出す)→ 集計して開く。「開いたことのあるフォルダ」に状態(集計しています… / 開いています / 前に開いた日時 / 失敗しました / この画面で表示中)を出す。開いた先は、上部に「対象: <フォルダ名>」を出し、タブの題名にフォルダ名を付ける。
- **決めたこと**:
  - 出力先はフォルダごとに分ける(`<out>-folders/<キー>/out/`)。メモとタスクタグも分ける(`<notes-dir>/folders/<キー>/`)。1 つの出力先に 1 つのサーバ、の決まりはそのまま。
  - `<キー>` は `<フォルダ名(40 文字まで)>-<パスの SHA-256 の先頭 8 桁>`(同じ名前の別のフォルダを混ぜない。Windows では大文字と小文字を区別しない)。
  - 開いたフォルダは `folder.json` に覚え、`atlas.config.json` には書かない。
  - 開くたびに集計し直す(送り先は増えていくので)。動いているサーバがあれば集計し直さない。
  - 新しいタブは、集計したプロセス(`atlas open`)が開く。画面にも「表示する」を出す。
  - 状態の `pid` だけでは動いているとみなさない: 集計中は、出力先の `.job.json` が同じ pid を持つこと。表示中は、60 秒たってもサーバが応えなければ止まったものとする。
  - 「調べる」は、集計できないフォルダを 200 の `{ ok: false, error }` で返す(選ぶ画面から選んだときと同じ形)。
  - 「調べる」の結果が出たら「集計して開く」に焦点を移す(処理中はボタンを押せなくしているので、それが外れてから)。調べられなかったときは、入力欄に焦点を戻す。
  - ダイアログを開いている間、集計中のものがあれば 1.5 秒ごと、開いているものがあれば 5 秒ごとに一覧を読み直す。画面に戻ったとき(window の focus)にも読み直す。架空データで動かしたときに、開いた先のサーバが止まった後も「開いています」と「表示する」(止まったサーバの URL)が残ったのを見つけて足した。
  - 操作の結果(開いた・もう開いている・一覧から外した)は、一覧の見出しの下に目に見える形で出す(`role="status"`)。読み上げだけにしていたのを、デザインの見直しで改めた。知らせた後でそのフォルダの状態が変わったら(開いていたサーバが止まった、など)、合わなくなった知らせは消す。
  - 狭い幅(34rem 以下)では、一覧の操作(表示する・一覧から外す)をパスの下の段に回す。
  - 起動用の bat は足さない(`atlas.bat` の画面から使う。コマンドは `atlas open`)。
  - `open` では `--home`・`--judgments`・`--bundle`・`--anonymize` を受け付けない。絞り込み(`--since` など)は集計に渡す。
  - 索引の無いフォルダ(前の版が写したもの)が 2 段下にあるかは、直下のフォルダごとに先頭の 3 個だけを見る(関係のない大きなフォルダを指したときに、下を全部読まないため)。`~/.copilot` の形のフォルダは、人ごとのフォルダとしては扱わない。
- **採らなかった案**:
  - `atlas.config.json` に開いたフォルダの一覧を書く(`parseConfig` は知らない項目があると読めないので、前の版の atlas が設定を読めなくなる)。
  - いつもの `out/` に混ぜる・1 つのサーバでフォルダを切り替える(出力先のロック・メモの置き場・集計し直しの引数が、出力先 1 つを前提にしている。この PC のセッションと人のセッションが混ざる)。
  - 画面から `window.open` で開く(集計が終わるのを待った後では、ブラウザがポップアップとして止める)。
  - 起動用の bat をもう 1 つ足す(`atlas.bat` の「起動用の bat はこれ 1 つ」を変えない)。
  - 状態の `pid` が生きていれば動いているとみなす(pid は使い回される)。
  - 集計できないフォルダを 400 で返す(ふつうの答えなのに、ブラウザのコンソールにエラーが出る)。
  - 全体のレポートの中に人ごとの内訳の軸を足す(頼まれていない。人ごとに見るときは、人のフォルダを開く)。
- **検査**: 単体 `packages/cli/test/folders.test.ts`(7 件。キー・状態の読み書き・フォルダの確かめ・一覧の状態・開く・外す)、`packages/core/test/upload-read.test.ts`(2 段下までの読み方)、`cli.test.ts`(`open` の引数)、`serve.test.ts`(`/api/folders` の 2 件)、`jobs.test.ts`(集計し直すときの `--home`)。e2e `e2e/phase16.test.ts` の g(`atlas open` で全員の分を集計し、いつもの出力先に何も作らないこと、もう一度開くと動いているサーバを使うこと、メモの置き場)。画面 `ui/folders.test.ts`(3 件。調べる・集計して開く・開いた先の画面・止まった後の一覧と「一覧から外す」)。
- **未検証**:
  - 本物の NAS・共有フォルダ(UNC パス)と、このダイアログからのエクスプローラーでの選択(テストは手元のパスと入力だけ)。
  - 件数の多い送り先での集計の時間(読むのは全セッションなので、人数に比例する)。
  - 画面から開こうとしたときに、同じフォルダの出力先へ書くコマンドが動いていると、子プロセスは始めずに終わり、一覧には「集計が途中で止まりました(記録: …open.log)」と出る(理由は `open.log` にある)。
  - `~/.copilot` の形のフォルダを開いたときは、埋め込みのデータに `source` が入らないので、「対象:」の印はサーバの一覧から取る(`file://` で開いた `atlas.html` には出ない)。
  - `open` に渡した絞り込みは、開いた先の画面の「集計し直す」には引き継がない(いつもの画面と同じ)。

### 「チャットに貼って判定する」の添付ファイルを作れなかったときの見せ方(2026-11-11)

「添付ファイルを作る」が失敗しても、画面に何も出ていなかった(実測)。作る処理(`bundle` / `turns bundle` の子プロセス)が 0 以外で終わると、ボタンが元に戻るだけで、理由がどこにも出ない。終わった処理は本文の上の帯に出さない作りで、ダイアログの側も失敗を見ていなかった。

- **再現のしかた**: 前に作った `bundle/parts/part-01.md` を、ほかのプログラムが掴んだまま「作り直す」を押す。`EBUSY: resource busy or locked, unlink …` で終了コード 1 になり、`sessions/` は空、古い `manifest.json` は残るので、画面は中身の無い添付ファイルを「作成済み」と出し続けていた。
- **失敗と中止をダイアログに出す**: 手順 1 のボタンの下に、「添付ファイルを作れませんでした(終了コード N)」と理由(処理が最後に書いた行)、ログ(折りたたみ)を出す。理由が `EBUSY` / `EPERM` / `ENOTEMPTY` のときは、ほかのアプリが開いたままだと書く。止めたときは「作成を止めました」。次に作れたら消える。
- **一覧(`manifest.json`)を最初に消す**: 前の生成物を消す順番を、一覧 → 中身にした。途中で止まっても、消した後のファイルを指す古い一覧が残らず、画面は「まだ作っていません」になる。工数(`bundle`)と依頼ごとの採用(`turn-bundle`)の両方。
- **一時的に掴まれているときはやり直す**: 消すときに `maxRetries: 3` / `retryDelay: 100` を付けた。やり直しはフォルダーとその中のファイルの両方で数えられるので、待ちは掛け算で延びる。直下のファイルが掴まれ続けたとき、諦めるまで 3.4 秒(実測)。1.5 秒だけ掴まれたときは、そのまま作れた(実測)。
- **決めたこと**: 失敗は、帯ではなく、始めたダイアログに出す(終わったことは始めた画面が示す、という今の分担のまま)。やり直しの回数は、画面が止まって見える時間を 3 秒ほどに抑える値にした。
- **採らなかった案**: `maxRetries: 5` / `retryDelay: 200`(掴まれ続けると諦めるまで 21.5 秒かかった。実測)。別のフォルダーに作ってから入れ替える(入れ替えのときに同じ掴みで止まり、途中の形が増える)。失敗を帯にも出す(同じことを 2 か所に出すことになる)。
- **検査**: 単体 `packages/judge/test/turns.test.ts`(途中で止まったら前の一覧を残さない。工数と依頼ごとの採用。直す前の版では失敗することを確かめた)。画面 `ui/jobs.test.ts` の f1(`bundle` をファイルに置き換えて失敗させ、ダイアログに失敗と理由が出て「まだ作っていません」になり、帯には出ない)と f2(作れたら失敗の表示が消える)。手元の画面で、ファイルを掴んだまま押して、表示を確かめた。
- **未検証**: `EPERM` / `ENOTEMPTY` になる掴まれ方(確かめたのは `EBUSY` だけ)。Windows 以外での掴まれ方(Linux は開いたままのファイルも消せるので、同じ失敗にはならないはず。推測)。

### 添付ファイルの作り直しと、失敗の見せ方の見直し(2026-11-12)

上の直し(2026-11-11)を見直して見つけた 10 件を直した。上の項のうち、「一覧を最初に消す」「理由は処理が最後に書いた行」「`EBUSY` などのときの案内」「まだ作っていませんに戻る」は、この項で置き換えた。

- **作り終えてから入れ替える**: 一覧を先に消す作りでは、作り直しに失敗すると、無傷の前の添付ファイルまで使えなくなり、渡した後の返答も取り込めなくなっていた。`<bundle>/.next` に全部を作り終えてから、決まった名前(一覧・`parts`・`sessions` など)だけを 1 つずつ入れ替える(`packages/core/src/fs-retry.ts` の `replaceEntries`)。前のものは入れ替えの間だけ `<bundle>/.prev` に退け、退けられなければ戻してから失敗にする。一覧は最初に退けて最後に入れる。工数(`bundle`)と依頼ごとの採用(`turns bundle`)の両方。
- **残る限界**: 入れ替えの最中(数回の rename の間)にプロセスが強制終了されると、一覧の無い状態になりうる(前のものは `.prev` に残り、次に作るときに片付ける)。
- **理由の取り出し方**: ログの最後の 1 行ではなく、処理が書いた `atlas: 失敗しました: …` の後ろを出す(`packages/report/src/lib/job-log.ts` の `failureReason`。600 文字まで)。その行が無ければ、理由は出さずにログを読んでもらう。`EBUSY` / `EPERM` / `ENOTEMPTY` を「ほかのアプリが開いたまま」と決めつける案内はやめた(`EPERM` は権限でも出る)。
- **出す条件**: この画面で動いているのを見た処理(`JobStore.live`)が失敗したか止められたときだけ出し、ダイアログを閉じたら(`dismissed`)もう出さない。読み込み直す前に終わっていた処理や、何日も前の失敗が出続けることは無くなった。前の添付ファイルが使えるときは「そのまま使えます」と書き、無いときだけ「まだありません」と書く。
- **止めた直後に終わっていた処理**: 止める操作の後でも、終了コード 0 で終わっていれば完了として扱う(結果は書かれている)。
- **ログの折りたたみ**: 帯(`JobBand`)とダイアログ(`ChatJudge`)で同じものを 2 つ持っていたので、`JobLog.svelte` にまとめた。
- **やり直し付きの削除**: `removeTree` を、添付ファイルの作成だけでなく、同じ理由で止まりうる `group export` の出力先・レポートの `detail` / `full` / ライブラリ・`tables` の作り直しにも使う。
- **決めたこと**: 入れ替えはフォルダごとではなく、決まった名前ごとに行う(`--bundle` は利用者が指定した既存のフォルダかもしれない)。読み込み直した後は、前の失敗を出さない(動くのを見ていない処理は、いつのものか分からない)。
- **採らなかった案**: `<bundle>` をフォルダごと置き換える(利用者が指定したフォルダのほかのファイルを消してしまう)。失敗の知らせを読み込み直した後も出す(サーバの最後の処理が失敗のままなので、関係のない日に開いても出続ける)。エラーコードごとに案内を書き分ける(原因を取り違える)。
- **検査**: 単体 `packages/core/test/fs-retry.test.ts`(入れ替え・失敗したときに前のものが残る・退けられないときに戻す・作りかけを残さない)、`packages/judge/test/turns.test.ts`(作り直しに失敗しても前の添付と一覧が残り、返答を取り込める)、`packages/cli/test/jobs.test.ts`(止めた後に 0 で終わったら完了)、`packages/report/test/job-log.test.ts`(理由の取り出し)。画面 `ui/jobs.test.ts` の f1(自分で 1 度作ってから失敗させる。理由・ログ・前の添付が使えること・閉じたら出ないこと・読み込み直しても出ないこと。後始末は `finally`)と f1b(止めたとき。サーバの返事を差し替えて確かめる)。
- **未検証**: 入れ替えの最中の強制終了(上の限界は、コードからの読み)。前のものを退けられない掴まれ方は、単体テストでは rename を失敗させて確かめた(本物のアプリが開いたままの状態では試していない)。ダイアログの見た目は画面のテストだけで確かめ、手元の画面での目視はしていない。

### 読む側の 5 度目の見直しの 10 件(2026-11-12)

送った先からの集計し直し(`snapshot` / `extract`)と黒い窓を見直して見つけた 10 件を直した。「4 度目の見直しの 10 件」のうち、「無ければ `.<id>.old` を写す」と「SIGINT を受ける処理があればそれに任せる」は、この項で置き換えた。

- **作業用のフォルダの名前から取った id をそのまま使わない**: `....uploading`(id が「..」)や、点・空白で終わる id、それ自体が作業用のフォルダの名前になる id は、写す先が出力先の外や別の名前のフォルダになり、前の複製を消しうる。そういう id からは写さない(`isRecoverableId`)。
- **写したときだけ記録する**: `--since` で写さなかったものまで `extras.recovered` に入り、「作業用のフォルダから読んだ」と警告していた。写し終えてから記録する。
- **`.<id>.old` だけのセッションは写さない**: 消し残し(`.old`)があるセッションを共有から消すと、次の集計で古い中身のまま戻っていた。置き換えの失敗が 2 度重なって `.old` だけが残った場合と、フォルダの形からは見分けられない。数えずに、理由を分けて `extras.skipped` に残し(`UPLOAD_OLD_ONLY_REASON`)、ログと警告に「消したのならこのフォルダも消す・消していなければ送り直す」と出す。件数はフォルダの数ではなくセッションの数。
- **本体のフォルダがあれば復元しない**: 本体の中がリンクだけのときに作業用のフォルダから写すと、後から本体側のリンクの片付けが、写したばかりのファイルを消すことがあった。本体のフォルダがあれば作業用のフォルダからは写さず、まとめて読むときに別のフォルダから写し終えた id は、リンクの片付けで消さない。
- **索引の無いフォルダが 21 個以上並ぶ場所**: 中を確かめるのは先頭の 20 個まで、という上限はそのまま(関係のない大きなフォルダを読み切らないため)。見つからなかったときに黙って 0 件にせず、`snapshot` のログと「別のフォルダを開く…」の理由に、指定のしかたとこの上限を出す(`UPLOAD_PROBE_HINT`)。
- **何も写していない出力先は縛らない**: 場所を間違えて 0 件だった出力先が、その場所の印のせいで正しい場所で使えなかった。写したもの(セッションのフォルダか `session-store.db`)が無ければ、前の印を消して続ける。
- **プロジェクト名の見えない文字**: 制御文字に加えて、書式文字(`\p{Cf}`。文字の向きを変える U+202E、幅の無い空白など)を含む名前も使わない。
- **Ctrl+C**: SIGINT を受ける処理に任せる分岐は、黒い窓の処理では通らない(受ける処理があるのは `serve` だけ)ので消し、いつも終了コード 130 で終わる。
- **重複の整理**: 作業用のフォルダの名前の正規表現を 1 つにし(`isUploadWorkDir` は `uploadWorkDirId` から)、「ログがあるか」の確かめを `hasSessionFile` にまとめた。`extract` は、セッションのフォルダと作業用のフォルダを 1 度の読み取りで分ける(同じフォルダを 2 度読まない)。
- **決めたこと**: `.old` だけのセッションは、戻すより「消したものが戻らない」ほうを取る(戻したいときの手順は警告に出す)。20 個の上限は緩めない。書式文字を含む名前は、絵文字の結合(ZWJ)を含むものも使わない(フォルダ名から決める側に回る)。
- **採らなかった案**: `.old` だけのセッションを今までどおり写す(消したセッションが戻る)。`.old` に目印を書いて見分ける(送る側の版がそろうまで見分けられず、前の版の消し残しには付かない)。索引の無いフォルダを全部確かめる(関係のない大きなフォルダで終わらない)。出力先の印を、0 件のときは書かない(途中で止まった集計と見分けられなくなる)。
- **検査**: 単体 `packages/core/test/upload-read.test.ts`(使えない id からは写さず出力先の外に何も書かない、`--since` で写さなかったものを記録しない、`.old` だけは写さず警告する、リンクだけの本体と作業用のフォルダ、まとめて読むときの片付け、0 件だった出力先の使い回し、書式文字)、`packages/cli/test/cli.test.ts`(`runSnapshot` の注意の行)、`folders.test.ts`(画面の理由)、`upload-project.test.ts`(SIGINT を聞くものがあっても 130 で終わる)。
- **未検証**: 本物の共有フォルダ(NAS)での動き。`.old` だけが残る場面を、実際のアップロードの失敗から作ってはいない(フォルダを手で置いて確かめた)。
