# agent-session-atlas 実装計画

最終更新: 2026-10-31(Phase 8: セッション記録の Markdown 出力)

## 目的

GitHub Copilot(デスクトップ autopilot / CLI / SDK / VS Code)のセッションログから、

1. トークン使用量・コスト(premium request、nano AIU)
2. skills / agents / hooks の利用状況
3. 指示ファイル(AGENTS.md / CLAUDE.md / copilot-instructions.md)の注入状況
4. llm-wiki(`global-llm-wiki`)の参照状況
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
- wiki: ツール引数に `global-llm-wiki` を含むセッションと、system.message での言及がある。`view` で index.md → 個別ページの順に読んだか、`skill` の wiki-ingest/query 呼び出しかを区別する
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
  packages/judge/           評価バンドル生成、judgments.json スキーマ、バックエンド(copilot-cli / opencode / anthropic)
  fixtures/                 テスト用のコード(偽の copilot)だけ。サンプルデータは置かない
  scripts/                  fixture の生成器(架空の値だけ。テスト時に .fixtures/ へ書く。git 管理外)
  e2e/                      フェーズごとの E2E テスト(vitest)
  docs/                     PLAN.md
  out/                      生成物(git 管理外): snapshot/ sessions.json metrics.json bundle/ judgments.json atlas.html sessions/<id>.html sessions/<id>.md
  atlas.bat / atlas-judge.bat / atlas-export.bat
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

動機: (1) レポートからセッションの経過そのものを読みたい、(2) セッション画面から `.md` を出して他の人に共有したい(agent-toolkit の `/export-usage` と同じ用途)、(3) ボトルネック分析に必要な情報を 1 ファイルにして LLM に渡したい。

調べた結果、分析に必要な情報は events.jsonl(依頼・応答・ツールの引数と結果・時刻・compaction・権限・エラー・サブエージェント)と session-store.db(リクエスト単位のトークン・AIU・待ち時間・役)で揃っており、atlas は既に両方を読んでいる。足りないのは出力の形だけ。記録に無いのは、モデルの推論過程の多く(opaque)と Copilot の外で人がしていたこと。

実装:

1. `packages/report/src/transcript.ts`: 1 セッション → Markdown。概要、役 × モデルの消費(mergeUsage の明細から、TTFT と全体の中央値 / p90)、ツールの内訳、経過(相対時刻、依頼・応答・ツール 1 行・サブエージェント `[agent:名前]`・compaction・権限・エラー・中断・モード / モデル変更・終了、5 分以上の空白は「待ち」、依頼ごとの本体の消費 1 行)、変更ファイル、秘密情報の検査、分析の観点(定型)。
2. `atlas export`(= `build` + 記録)。`--tool-output fail|all|none`(既定 fail)、`--max-chars`。`build` の `sessions/` 削除に乗るので、素の `build` では `.md` も詳細ページのリンクも消える(古い記録を残さない)。
3. 詳細ページの上部に「セッション記録(Markdown)を開く / 保存」(`.md` があるときだけ)。
4. 秘密情報は形式(GitHub / OpenAI・Anthropic / AWS / Slack / Google のキー、秘密鍵、JWT、Bearer)で見つけて `[伏せました: 種類]` に置き換え、件数を出す(元の記録は書き換えない)。
5. 伏せ字モードでは本文に scrub(仮名・`<path>`)を掛け、ファイル一覧を出さず、先頭に「自由記述の固有名は機械的に保証できない」注意を書く。
6. `atlas-export.bat`。

決めたこと: HTML に本文を埋め込まない(5MB と file:// の制約。実データの events.jsonl は 202 本で 538MB)。`.md` の生成は `build` の既定にしない(容量と時間が増えるため別コマンド)。ブラウザ側でのファイル生成はしない(埋め込みが要るため)。

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

## 決めたこと・採らなかった案

- Svelte 5 を採用(理由は開発体験。単一 HTML のサイズ差はデータ量に比べて誤差)。
- 索引・トークンとも「正典を一つに決める」のではなく和集合+出所記録にした(実測で包含関係が無いため)。
- 公式スキーマを CI の正典にしない(1.0.18 のもので実データと乖離)。
- 採らなかった案: Python 標準ライブラリ構成、ローカルサーバ型ダッシュボード、生イベントの HTML 埋め込み、`--add-dir` によるバンドル受け渡し。
- `data.db`(デスクトップアプリ)は改善フェーズでも読まない。対象はアプリのセッションだけで(CLI のセッションは載らない)、モード・推論強度・文脈の内訳は events.jsonl と session-store.db で代替でき、`accounts.access_token` などの資格情報列を含むため。
