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

## 決めたこと・採らなかった案

- Svelte 5 を採用(理由は開発体験。単一 HTML のサイズ差はデータ量に比べて誤差)。
- 索引・トークンとも「正典を一つに決める」のではなく和集合+出所記録にした(実測で包含関係が無いため)。
- 公式スキーマを CI の正典にしない(1.0.18 のもので実データと乖離)。
- 採らなかった案: Python 標準ライブラリ構成、ローカルサーバ型ダッシュボード、生イベントの HTML 埋め込み、`--add-dir` によるバンドル受け渡し。
- `data.db`(デスクトップアプリ)は Phase 10 まで読まなかった(対象はアプリのセッションだけで、モード・推論強度・文脈の内訳は events.jsonl と session-store.db で代替でき、`accounts.access_token` などの資格情報列を含むため)。Phase 11 から、ユーザーの判断で許可リストの列だけを immutable の読み取り専用で読む(「Phase 11」)。
