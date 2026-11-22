# agent-session-atlas 設計と判断の記録

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
- それ以前のセッションでも、`session.shutdown.data.modelMetrics` にモデル別の累計(input/output/cache/reasoning)が残っているものがある。DB と両方あるセッションでほぼすべて完全一致したため、DB も usage_record も無いときは **`shutdown` を第 3 の出所**として採用する。
- それも無いセッションは `assistant.message.data.outputTokens` と `session.compaction_complete.preCompactionTokens`、`subagent.completed.totalTokens` しか無い。入力トークンは `null`(`source: partial`)とし、UI で「推計不可」を明示する。

### イベント種別(実データ由来)

`session.start` は全件 `version: 1`。npm グローバルの `@github/copilot@1.0.18` に同梱の `schemas/session-events.schema.json`(74 種別)は**古く**、実データにある `session.usage_record` `session.usage_checkpoint` `session.permissions_changed` `subagent.configured` `session.binary_asset` `model.*` `skill.*_ref` `session.canvas.*` 等を含まない。実際に動く 1.0.103 はスキーマファイルを同梱しない。

よって **実データで観測した種別名の一覧** をコード(`packages/core/src/event-types.ts`。件数などのデータは持たない)に持って正典とする(公式スキーマは古く、参考にならないので置かない)。未知種別は捨てずに `unknown` として件数を数え、警告を出す。

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
  e2e/                      E2E テスト(vitest)
  docs/                     PLAN.md
  out/                      生成物(git 管理外): snapshot/ sessions.json metrics.json bundle/ judgments.json atlas.html sessions/<id>.html sessions/<id>.md
  atlas.bat(起動用の bat はこれ 1 つ。他の操作は serve の画面とコマンド)
  setup.bat(2026-11-08 から。初期設定: atlas.config.json の wikis と phases を対話で書く。集計はしない)
  README.md(日本語)
```

### データの流れ

1. `snapshot`: `~/.copilot` の必要部分を `out/snapshot/` へ複製(SQLite は VACUUM INTO、events.jsonl はコピー。`--since` で範囲を絞れる)。元を一切書かない。
2. `extract`: snapshot → `out/sessions.json`(セッション単位の正規化レコード。生イベントは含めず、集計に必要な派生値と、ドリルダウン用の時系列要約だけ)。
3. `metrics`: sessions.json → `out/metrics.json`(全体 / プロジェクト / クライアント / モデル / 期間別の集計)。
4. `bundle`: sessions.json → `out/bundle/sessions/<session>.md` + `manifest.json` + `INSTRUCTIONS.md` + `schema.json`(外部 LLM へ渡す評価パケット。`--zip` で 1 つの ZIP にもまとめる。依頼の記録が無いセッションは既定で除外。1 パケット 24,000 字以内に中略)。
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
  "judge": {"backend": "copilot-cli|anthropic|external", "model": "...", "ranAt": "..."},
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

追加(互換): `items[].judge = {backend, model, ranAt}`(項目ごとの出所)、トップレベル `failures[]`(判定失敗。成功すると消える)、`judge.usage`(直近 run のトークン消費)。

### judge バックエンドの注意

- `copilot -p` は `--output-format json`(JSONL)+ `--stream off` + `--no-ask-user` + `-s`。`--allow-all-tools` は「非対話モードで必須」とヘルプにあるので既定で付け、`shell` / `write` / `url` は `--deny-tool` で常に拒否する([judge.md](judge.md))。`--allow-all` と `COPILOT_ALLOW_ALL=true` は使わない。
- 2026-10-28 実走(CLI 1.0.103)で確認した出力の形: stdout は session.* / commands.changed / user.message / assistant.turn_start / model.call_start / model.call_failure / session.error / assistant.idle などのセッションイベントと同じ JSONL で、最終行が `{"type":"result","sessionId","exitCode","usage":{premiumRequests,totalApiDurationMs,sessionDurationMs,codeChanges}}`。stderr は空。`--usage-output-file` は `{totalPremiumRequestCost,totalUserRequests,totalNanoAiu,totalApiDurationMs,sessionStartTime,codeChanges,modelMetrics,agentMetrics,providerModelMetrics,lastCallInputTokens,lastCallOutputTokens}`。上記フラグの組み合わせは受理される(引数エラーなし)。
- 実走時は月間 AI クレジット超過で全モデル(sonnet-5.5 / haiku-5.5 / gpt-5.6-terra / mai-code-1.1-flash / auto)が `session.error {errorType:"quota", errorCode:"quota_exceeded", statusCode:402}` を返し、終了コード 1、消費 0。`gpt-5-mini` / `gpt-5.4-nano` は「not available」で stderr のみ。公式文書(copilot-requests)は超過後も「included models」が使えるとするが、新課金(AI クレジット)の環境では実測で使えなかった。
- **`--add-dir` は使わない**(そのディレクトリの `.github/skills` と `.github/agents` を信頼設定として読むため、他セッション本文を含むバンドルは注入の入口になる)。バンドルは本文埋め込みか stdin で渡す。
- `--usage-output-file <file>` で判定自体のトークン消費を記録する。
- 従量課金のバックエンド(Anthropic API)は明示指定時のみ。

### HTML の方針

- 埋め込むのは metrics.json と sessions.json の要約のみ。**生イベントは埋め込まない**。
- `file://` で動く(fetch 不可)。セッション詳細は `out/sessions/<id>.html` を別生成して相対リンク。
- フィルタ: プロジェクト、期間、クライアント、モデル、ブランチ、タスク分類(judgments があれば)、入力トークン記録の有無。
- ライト/ダーク両対応、グラフはインライン SVG。
- 本文はタブ(概況・内訳・一覧)に分けるが、どのタブも同じ 1 つの HTML に描き、ほかのタブは隠すだけ(下の「atlas.html をタブで分ける(2026-11-20)」)。

## 機能ごとの設計

共通の制約: 元の `~/.copilot` は書かない(mtime 不変の E2E を維持)。HTML は 5MB 未満・外部参照なし。fixture に新しい記録形式を足すときは生成器に架空の値で足す(実データ・匿名化した実データは使わない)。

### 正しさとノイズ

実測した問題と直し方:

1. **空セッション**(依頼 0・ツール 0・応答 0)が全体の大半を占める。レコードに `empty: boolean` を持たせ、レポートの絞り込みに「空のセッションを含める」(既定オフ、URL の `#` に残す)を足す。既定の集計・一覧・プロジェクト表・中央値はすべて空を除いた値にし、全体サマリに「空のセッション N 件を除外」と出す。`metrics.json` は空を除いた集計と、空の件数を持つ。
2. **モデル名の表記揺れ**: `claude-haiku-5-5` と `claude-haiku-5.5` などが別モデルになる。`claude-<family>-<major>-<minor>`(minor が 1 桁、末尾に日付等が続かない)を `<major>.<minor>` に正規化し、`models` を重複除去する。usage_record の `modelDisplayName` 由来の `<UUID>/` 接頭辞も外す(同一リクエストに `model` と両方残るのを実測)。正規化前の名前は捨てる(どの出所も同じモデルを指すため)。
3. **内部ツールの混入**: `report_intent` がツール数に入る。内部ツールの一覧を定数で持ち(少なくとも `report_intent`)、`tools.byName` / `total` から外して `tools.internal` に別計上する。
4. **摩擦の「エラー」表記**: 全体サマリの「エラー」はツール失敗と session.error の合計になっている。「ツール失敗」と「エラー」を分けて表示する。
5. **変更ファイルの二重計上**: 相対パスと絶対パスで同じファイルが 2 回載る。cwd 基準で絶対パスに解決し、Windows では大文字小文字を無視して重複除去する。`~/.copilot/session-state/` 配下(plan.md 等)は変更ファイルから外し、件数だけ別に持つ。
6. **新形式への追従**(実データで確認):
   - `session.workspace_file_changed` は 2026-07-09 以降出ない。`tool.execution_complete.data.fileEdits[]`(`path`, `kind`: edit/create/delete)を読み、`files.deleted` を新設する。両方ある場合は重複除去。
   - `user.message` の `isAutopilotContinuation: true` はユーザーのターンに数えず、`autopilotContinuations` に別計上する。
   - subagent の `assistant.message` で `data.parentToolCallId` が無くトップレベルの `agentId` だけを持つものを本体の応答として数えない(`assistantMessages` と `lastAssistantMessage`)。
   - `assistant.message.outputTokens` は 2026-08-31 以降出ない。出力トークンの出所ごとの件数を月別に数え、DB・usage_record・shutdown・outputTokens のいずれも無い非空セッションの件数を `metrics.json` と全体サマリの「入力トークン記録の内訳」に出す(黙って 0 にしない)。
7. **クライアント不明のセッション**: 原因(workspace.yaml の無い DB だけのセッション等)を調べ、`session-store.db.sessions.host_type` 等から決められるなら埋める。決められないものは「不明」のまま理由を README に書く。

### 利用の内訳と成果量

1. **利用ランキング欄**(トップページ、絞り込みに追従): ツール(MCP ツールは `tool.execution_start.data.mcpServerName` でサーバー別にまとめる)、skill(`skill.invoked.data.trigger` で自動/手動を区別)、agent(回数・失敗・トークン)、hook(種別)、指示ファイル(ファイル別のセッション数)。上位 N 件 + 「全件を表で見る」。
2. **インストール済みとの突き合わせ**: `~/.copilot/skills/` のディレクトリ名と `installed-plugins/` のプラグイン名、`settings.json` の `disabledSkills` を snapshot で名前だけ記録し(中身は読まない)、「インストール済みだが期間内に未使用の skill」を出す。
3. **変更行数**: `session.shutdown.data.codeChanges.linesAdded/linesRemoved` と、`tool.execution_complete` の `toolTelemetry.metrics.linesAdded/linesRemoved`。shutdown を優先し、無ければツール側の合計。全体・プロジェクト・セッションに出す。
4. **ツール別の成功率**: `tool.execution_complete.data.success` と `error.code`(failure / denied 等)で、ツール別に成功・失敗・拒否を数える。ランキング欄に失敗率を並べる。
5. **プロジェクトの統合**: `repository` が無いとき、`gitRoot` の `.git/config` から origin の URL を読んで `owner/repo` を得る(worktree は `.git` ファイル → gitdir → commondir を辿る)。読み取りのみ。読めない・リモート無しはパスのまま。ホーム直下と一時フォルダ(`%TEMP%`、scratchpad)は「(ホーム)」「(一時フォルダ)」にまとめる。
6. **AI 使用量の表示**: nano AIU は 10^9 で割った AIU で表示し(桁区切り、単位の説明を用語集に)、金額には換算しない。premium request を全体サマリと月別推移に戻す(記録のあるセッションだけの合計と明記)。

### 実行の性質と要点

1. **モードと推論強度**: `session.start` / `session.mode_changed` / `user.message.agentMode` からモード(interactive / plan / autopilot)別のターン数、`reasoningEffort`(session.start・model_change・usage_record・DB の `reasoning_effort`)別のリクエスト数・トークン・AIU。
2. **リクエストの起点**: DB / usage_record の `initiator`(user / agent / sub-agent / compaction)の比率。
3. **文脈の内訳**: shutdown / compaction の `systemTokens` / `conversationTokens` / `toolDefinitionsTokens` と usage の `availableToolCount` から、ツール定義が常時占める量をセッション・プロジェクト別に。
4. **待ち時間**: DB の `time_to_first_token_ms` / `duration_ms` と usage_record の同等値から、モデル別の中央値と p90。
5. **ツールの所要時間**: start → complete を `toolCallId` で対応付け、ツール別の中央値と p90(1 時間超は外れ値として除外し件数を出す)。
6. **摩擦の詳細**: permission の結果(承認 / 拒否)、session.error の種別(quota / rate_limit 等)、subagent 失敗の理由、compaction 自体のトークン。
7. **todo**: `session-state/<id>/session.db` を snapshot に含め(VACUUM INTO)、todo の状態別件数と完了率。
8. **要点欄**: 上の集計から機械的に出す短い一覧(コストの大きいセッション上位、失敗率の高いツール、compaction の多いセッション、未使用の skill)。各項目は根拠のセッション / 絞り込みへのリンクを持つ。LLM は使わない。

### セッション記録の Markdown 出力(2026-10-31)

動機: (1) レポートからセッションの経過そのものを読みたい、(2) セッション画面から `.md` を出して共有したい(agent-toolkit の `/export-usage` と同じ用途)、(3) ボトルネック分析に必要な情報を 1 ファイルにして LLM に渡したい。

調べた結果、分析に必要な情報は events.jsonl(依頼・応答・ツールの引数と結果・時刻・compaction・権限・エラー・サブエージェント)と session-store.db(リクエスト単位のトークン・AIU・待ち時間・役)で揃っており、atlas は既に両方を読んでいる。足りないのは出力の形だけ。記録に無いのは、モデルの推論過程の多く(opaque)と Copilot の外で人がしていたこと。

実装:

1. `packages/report/src/transcript.ts`: 1 セッション → Markdown。概要、役 × モデルの消費(mergeUsage の明細から、TTFT と全体の中央値 / p90)、ツールの内訳、経過(相対時刻、依頼・応答・ツール 1 行・サブエージェント `[agent:名前]`・compaction・権限・エラー・中断・モード / モデル変更・終了、5 分以上の空白は「待ち」、依頼ごとの本体の消費 1 行)、変更ファイル、秘密情報の検査、分析の観点(定型)。
2. `atlas export`(= `build` + 記録)。`--tool-output fail|all|none`(既定 fail)、`--max-chars`。`build` の `sessions/` 削除に乗るので、素の `build` では `.md` も詳細ページのリンクも消える(古い記録を残さない)。
3. 詳細ページの上部に「セッション記録(Markdown)を開く / 保存」(`.md` があるときだけ)。
4. 秘密情報は形式(GitHub / OpenAI・Anthropic / AWS / Slack / Google のキー、秘密鍵、JWT、Bearer)で見つけて `[伏せました: 種類]` に置き換え、件数を出す(元の記録は書き換えない)。

決めたこと: HTML に本文を埋め込まない(5MB と file:// の制約。実データの events.jsonl は 202 本で 538MB)。`.md` の生成は `build` の既定にしない(容量と時間が増えるため別コマンド。2026-11-03 に `all` は記録を作るよう改めた。下の「`all` でもセッション記録を作る」)。ブラウザ側でのファイル生成はしない(埋め込みが要るため)。

### UI/UX の磨き込み(2026-11-01)

動機: 技術カンファレンスで見せられる水準にする。`/impeccable critique`(デザインレビューと検出器を別のサブエージェントで)、`/impeccable audit`(a11y・性能・テーマ・レスポンシブ・実装整合)、web-design-guidelines の照合を実データのレポートに掛け、指摘を「設計契約(官公庁の帳票)を守ったまま直せるもの」と「契約の変更が要るもの」に分けた。前者だけを直した。

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

- `.seg` の押下状態(緑ベタ)を帳票らしい印(✓ や下線)に替える案(識別性が落ちる)。
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

契約変更が要る判断待ち(推奨付き):

| 案 | 推奨 | 理由 |
|---|---|---|
| 絞り込み行の固定表示を外し、表示中の件数(と解除)だけを固定する | 実施(2026-11-01 夕、下の追記) | 第一画面の 2 行分が本文に戻る。条件の変更はページ上部に戻れば済み、件数の印は残る |
| 詳細ページから戻るときに絞り込みを保つ | 実施(2026-11-01 夕、下の追記) | `file://` では referrer が無いので、atlas.html が別ページへ移るときに sessionStorage に印を残し、詳細・用語ページの「戻る」が印を見て `history.back()` にする。直接開いたときは今のリンクのまま |
| atlas.html の節の目次を広い画面ではサイドバーにする | 実施(2026-11-01 夕、下の追記) | 10 項目を 1 行に並べると主従が無く、表題帯が消えると欄の移動に先頭へ戻る必要があり、現在地の印も無かった |
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

#### 追記(2026-11-01 夜): 詳細ページもサイドバーにし、3 画面のナビの作法を揃える

ユーザーの指摘: 詳細ページを開いたら節の目次が上部のままで「この画面はタブが上部のまま?」。前の追記で「詳細ページの節目次は 1 ページ内のスクロールだけなので上部で足りる」としたが、トップをサイドバーにした今は詳細だけ上部で固定も現在地の印も無いのは一貫せず、時系列の節は長いセッションで数百行になるので上部の目次は読んでいる途中で使えない。判断を改めて揃えた。

直したこと(surface brief の SUBPAGES を同じコミットで変更):

21. **共通の目次の帯**: 目次の帯の見た目(`.rail` / `.toc` / `.shell` / `.top`)を `App.svelte` から `base.css` に移し、3 画面で 1 つにした。静的ページの上部と帯の描画と動き(配色の切り替え・固定行の高さ `--topbar-h`・現在地の印・狭い画面での目次行の送り・「← 戻る」の `history.back()`)は新しい `page-nav.ts`(`renderTop` / `renderRail` / `NAV_JS`)に寄せ、詳細ページと用語ページが同じものを使う。
22. **詳細ページ**: 1280px 以上は左に 13em のサイドバー(上から 戻る → 12 節の目次(現在地の印)→ セッション記録 (Markdown) を開く / .md で保存(記録があるときだけ)→ 用語の説明 → 配色)。1280px 未満は上部の帯(戻る・リンク・配色。固定しない)と、その下に固定した 36px の目次行(横に流れ、現在地に印)。表題・メタ欄・ID は本文側のまま。
23. **用語ページ**: 切り替え幅を 960px から 1280px にして 3 画面で統一し、サイドバーに「← レポートに戻る」と配色を入れて詳細と同じ構成にした。狭い画面の分類の目次は 44px の枠の折り返しから、他と同じ横に流れる 36px の行に変えた(固定行が 2〜3 行分になるのを避ける)。理由は brief に書いた: 用語ページは表が無いので 960px でも成立するが、「どの画面でも同じ幅で同じ場所に目次がある」ことを優先した。
24. **配色の切り替え**: 詳細・用語ページには無かったので足した(atlas.html と同じ `localStorage` の鍵。1280px 以上はサイドバーの末尾、未満は上部の帯の右端)。
25. **統一点検**: 戻るリンクの位置(サイドバーの先頭 / 上部の帯の左端)と文言(詳細「← レポート(セッション一覧)に戻る」、用語「← レポートに戻る」)、固定行の高さ(3 画面とも 37px、飛び先の余白は `scroll-padding-top: var(--topbar-h)` + `scroll-margin-top: 12px`)、ページ下部のフッタ(`.page-foot` / `.foot`、同じ余白と字の大きさ)、ダークのサイドバーの罫線(`--rule` / `--rule-strong`、atlas と同じ変数)、Tab 順(戻る → 目次 → リンク → 配色 → 本文。`:focus-visible` の 2px 枠は base.css)、375px の固定行(37px)を確認した。

容量: 静的ページに埋め込む base.css からコメントと空白を落とすようにした(`build.ts` の `compactCss`)ので、サイドバーの CSS 分(+6KB/件)はこれで吸収している。

### セッションの選択とグループ(2026-11-01)

動機(ユーザーの言葉): 「ユーザーはすべてのセッション、または特定のセッション、または特定の複数セッション単位で分析がしたい」。「UI/UX の磨き込み」まではリポジトリなどの属性でしか絞れなかった。将来はセッションごとのメモ(Markdown + 画像)を足す予定で、その置き場 `atlas-notes/` の最初の住人として「名前付きグループ」のファイルを作る。

契約:

1. **選択の軸**: 画面の絞り込みに「セッションの選択」の軸を足す。`FilterState` に `ids: string`(セッション id をカンマ区切り。`''` は制限なし)を追加し、`matches` は `ids` に含まれるものだけにする。既存の軸と AND。URL ハッシュへの encode / decode にも載せ、再読み込み・戻る・共有で保てるようにする(200 件 × 36 文字で 7KB 程度。`file://` でも問題ない。カンマはそのまま書く)。
2. **一覧のチェック欄**: セッション一覧(`SessionTable`)にチェック欄を足し、選んだ件数と「選んだ N 件だけ集計」「選択を解除」のボタンを一覧の見出し近くに置く(選択が 0 件のときは無効)。見出し行のチェックでそのページの行をまとめて選べる。「集計」を押すと `filter.ids` に入り、レポート全体(概況・内訳・実行の性質・一覧)が再計算される。絞り込み行とサイドバーの「絞り込み中」の印・件数・解除は既存の作法に従い、`ids` の絞り込みも 1 条件として数える。チェック状態そのものは画面内だけ(保存しない)。`ids` の絞り込み中は一覧にその id のセッションだけが出るので、チェックは全てオンで表示する(`ids` が変わるたびに選択を `ids` に揃える。ハッシュから開いたときも同じ)。「解除」で `ids` を外しても選択は残す(もう一度「集計」で戻せる)。
3. **名前付きグループのファイル** `atlas-notes/groups.json`(リポジトリ直下。`--notes-dir <dir>` で変更可。無ければ無いものとして動く。`.gitignore` には入れない = ユーザーが管理するかを決める)。形式:
   `{ "version": 1, "groups": [ { "name": "<名前>", "note": "<任意の一文>", "ids": ["<session id>", ...] } ] }`
   名前は一意。壊れていれば build / export / judge はエラーにせず警告して無視する(ファイル全体が読めなければ全部、1 件だけ形が違えばその 1 件。重複名は後の方を無視)。警告は `data.warnings.notes[]` として埋め込み、全体サマリの注記と脚注に出す(既存の `warnings` の経路)。
4. **CLI**: `--group <名前>` を既存の絞り込み(`--since` / `--project` / …)と同列に追加(build / export / metrics / bundle に効く。AND。無い名前はエラー)。`--session <id>`(カンマ区切り、複数回指定可)で特定のセッションだけ。id は先頭一致で解決してよいが、曖昧なら(複数に当たれば)エラー、どれにも当たらなければエラー。さらに `atlas group list`、`atlas group add <名前> <id...> [--note <一文>]`(既存名なら ids を追記、重複は除く)、`atlas group remove <名前>` を足す。add / remove は壊れた `groups.json` を上書きしない(エラーにして直してもらう)。
5. **埋め込みデータ**: `ReportData.groups[]`(name, note, ids)を入れる(`REPORT_DATA_VERSION` 5)。
8. **容量**: atlas.html の増分は小さい(チェック欄と埋め込みグループ)。5MB 制約・外部参照なしは従来どおり。

#### 実施(2026-11-01 夜)

直したこと・作ったもの:

2. **CLI**: bundle の manifest の scope にも `group` / `session` を入れる。
3. **埋め込みと画面**: `SessionTable` のチェック欄(見出し行で 50 件まとめて、`indeterminate` も出す)と操作列。`App` が選択の集合を持ち、`filter.ids` が変わるたびに記録にある id に揃える。「選択を解除」は選択で集計中ならその条件も外す(チェックが無いのに「選んだ N 件」で絞られたままにしない)。
5. **警告の経路**: `warnings.notes[]` を全体サマリ(集計明細の注記)と脚注に出す。CLI の標準出力にも「注意」で出す。

自分で決めたこと(戻し方は git): 見出し行のチェックで「このページの 50 件」をまとめて選べるようにした(ui-ux-pro-max の Bulk Actions の「Checkbox column + Action bar」に沿う。全件選択は、絞り込み自体が全件を表すので付けていない)。`group add` に `--note` を足した(形式に note があるのに CLI から書けないのは半端なため)。

残した P2: 「選んだ N 件だけ集計」の N は他の条件で隠れた行も含むので、AND の結果の件数と一致しないことがある(件数は「表示中」で分かるため、そのまま)。

### ローカルサーバ経由で画面からグループを作る(2026-11-01)

動機(ユーザーの判断): 「セッションの選択とグループ」の「グループとして保存」が JSON をコピーして貼る形なのは一般的でなく分かりづらい。技術的な事情(HTML からファイルを書けない)をユーザーに負わせない。ダイアログを毎回出すのも嫌。Gmail / VS Code / Obsidian のように「作成を押したら保存される」形にする。そのために atlas.bat がローカルサーバを立ててブラウザを開き、画面を閉じたらサーバも止まる運用に変える。アプリ化(Electron)は後回しにし、画面と保存の境界を小さな HTTP API にして後で差し替えられるようにする。

契約:

1. **`atlas serve [--port <n>] [--no-open]`**: 127.0.0.1 だけに bind(既定は空きポートを自動取得)。out/ を静的に配信(atlas.html、glossary.html、sessions/)。ディレクトリ一覧は出さず(`/` は atlas.html へ)、out/ の外は読めない(パスの正規化で検査)。起動したら既定のブラウザで `http://127.0.0.1:<port>/atlas.html` を開き、標準出力に URL と「ブラウザを閉じるか、この窓を閉じると終了します」を出す。
2. **API**(JSON、同一オリジンのみ):
   - `GET /api/state` → `{ groups, notesDir, warnings, version }`。groups はその時点の groups.json(`groups-io.loadGroups`)。
   - `POST /api/groups` `{ name, note, ids }` → 作成(同名があれば 409)。`PUT /api/groups/<name>` `{ name?, note?, ids? }` → 改名・更新(改名先が既にあれば 409)。`DELETE /api/groups/<name>` → 削除(無ければ 404)。書き込みは groups-io(`loadGroupsForWrite` / `saveGroups`)を通し、壊れたファイルは上書きしない(409 と理由)。書ける先は notes-dir 配下の groups.json だけ。
   - `POST /api/heartbeat` → 204。
   - `/api/*` の全てで `Sec-Fetch-Site` が same-origin / none 以外なら 403、`Origin` があれば自分のオリジンと一致しなければ 403。書き込み系(POST / PUT / DELETE。heartbeat も含む)は起動ごとのランダムな token を `X-Atlas-Token` に要求する(無ければ 403)。token は serve が HTML を配信するときに `<meta name="atlas-token" content="__ATLAS_TOKEN__">` のプレースホルダを置き換えて渡す(build 時の HTML はプレースホルダのまま = file:// では空扱い。詳細・用語ページにも同じ meta を入れ、heartbeat に使う)。
3. **終了の規則**: 3 画面(atlas.html・詳細・用語)は http(s) で開かれているときだけ 3 秒ごとに heartbeat を送る(page-nav.ts の NAV_JS にも入れる)。最初の heartbeat が 60 秒来なければ終了する(ブラウザが開かなかったとき)。詳細ページへ移っている間も heartbeat は続く。サーバが止まった後の画面は heartbeat の失敗を検知して「サーバが止まっています。atlas.bat を実行し直してください」の帯を出し、編集の操作を無効にする(閲覧はそのまま)。
4. **二重起動**: serve は起動時に `out/.serve.json`(port、pid。token は書かない)を見て、既に動いているサーバがあれば(`GET /api/state` が `X-Atlas-Serve` 付きで応える)ブラウザを開くだけで終了する。自分が終了するときに消す。
5. **画面の編集モード**: 読み込み時に http(s) かつ token があり `GET /api/state` が成功したら編集モード。グループの一覧は埋め込みではなく API の結果を使う(CLI で足したグループも再読み込みで出る。埋め込みの groups は file:// 用に残す)。
   - セッション一覧の操作列: 「選んだ N 件だけ集計」「選択を解除」はそのまま。「グループを作成」を押すと名前と一文の入力欄がインラインで開き(ダイアログにしない)、「作成」で POST → 成功したらそのグループで絞り込んだ状態にする。失敗は入力欄の下に理由を出す。
6. **bat**: atlas.bat は最後の `start out\atlas.html` をやめ、`atlas serve` で終える(窓はサーバが終わるまで残る。失敗時の pause は従来どおり)。
7. **設計契約の文言**: 「サーバ無しで開ける 1 ファイル」は共有用の out/atlas.html として維持(閲覧のみ)。「外部参照なし」の検査(e2e の externalRefs)は、同一オリジンの相対パス `api/…`(詳細ページからは `../api/…`)への fetch だけ許し、http(s) の参照は従来どおり禁止、に改める。file:// で開いたときに fetch の失敗で console にエラーを出さない(try/catch、1 回だけ試す)。

#### 実施(2026-11-01 夜)

作ったもの・直したこと:

1. **サーバ** `packages/cli/src/serve.ts`(`startServe` / `findRunningServer` / `openInBrowser`)。node:http だけで、127.0.0.1 に bind。静的配信は `resolve(out, '.' + path)` が out/ 配下か(と `.serve.json` でないか)を見て、ディレクトリと外は 404、`/` は atlas.html へ 302。HTML は配信時に `__ATLAS_TOKEN__` を起動ごとの token(24 バイトの base64url)に置き換える。
2. **CLI**: `serve [--port <n>] [--no-open]`(`--port` / `--no-open` は serve 以外で UsageError)。`runServe` は atlas.html が無ければエラー、`.serve.json` のサーバが `X-Atlas-Serve` 付きで応えればブラウザを開くだけ、そうでなければ起動して `done` を待つ(SIGINT / SIGTERM で閉じる)。atlas.bat は末尾の `start out\atlas.html` を `node packages\cli\src\main.ts serve` にした(atlas.bat の追加引数は `all` にだけ渡す)。
3. **画面**: `packages/report/src/app/api.ts`(`serveToken` / `api.state|create|update|remove` / `startHeartbeat`。fetch の宛先は相対パス `api/…` の文字列だけ。接続できないときは「サーバに接続できません」の日本語に変える)。`App.svelte` は token があれば heartbeat を始め、`api/state` を 1 回だけ試して成功したら編集モード(`liveGroups` を使う)。`createGroup` / `renameGroup` / `deleteGroup` は API の返す groups で差し替え、作成後はそのグループで絞り込み、削除後は `ids` を外す。heartbeat が失敗したら `serverDown`(帯 `.down-band` を sticky で上に貼り、編集を消す)。`SessionTable` の「グループを作成」は入力欄をインラインで開く(名前 / 一文 / 作成 / 取消。空の名前でも送れて理由を下に出す。送信中は `readonly` + `aria-busy`。成功で「グループを作成」に、失敗で名前の欄にフォーカスを戻す。`editable` が外れたら閉じる)。削除の確認は初期フォーカスを「取消」に置く(Enter の連打で消さない)。編集できないときの 1 行は「このファイルは閲覧用です。グループの作成は atlas.bat から開いたときにできます」。
4. **静的ページ**: template.html・詳細・用語の head に `<meta name="atlas-token" content="__ATLAS_TOKEN__">`。`page-nav.ts` の NAV_JS に heartbeat(http(s) で token がプレースホルダでないときだけ。詳細は `../api/heartbeat`、用語は `api/heartbeat`。失敗したら帯を出して止める)。

自分で決めたこと(戻し方は git): heartbeat にも token を要求した(書き込み系の規則をそのまま適用。静的ページにも meta を入れたので困らない)。`.serve.json` のサーバ確認は `X-Atlas-Serve` ヘッダで見分ける。`--no-open` を足した(テストと、既にブラウザを開いているとき用)。`PUT` の改名先が既にあれば 409。サーバが止まった帯は 3 画面とも同じ文言と見た目にし、詳細・用語ページでも出す。削除の確認の初期フォーカスは「取消」。

未実施: atlas.bat をダブルクリックして通す確認(ブラウザを開いて窓が残るため、非対話では確認できない。bat の変更は末尾の 1 行だけ)。impeccable の URL スキャンは puppeteer が無く未実施。

### グループの居場所と付け外し(2026-11-01)

動機(評価の結論、ユーザーが作り直しを決めた): 「ローカルサーバ経由で画面からグループを作る」は動作はするが「ラベル / 保存ビュー」の型に届いていない。(1) グループの居場所が無く、絞り込み行の select を開かないと何があるか分からず件数も一文も見えない。(2) 操作が上下に分かれている(作成は一覧、選択・改名・削除は絞り込み行)。(3) 既存のグループに足せず、外せない。(4) 0 件だと欄が出ず機能に気づけない。

契約:

1. **サイドバーの「グループ」の群**(1280px 以上): 節の目次の群と同じ作法で、目次の下(「付録」の後、件数の帯の上)に置く。先頭に「すべて」の行、各グループの行は名前と件数(記録に無い id があれば「m / n」)。押すとそのグループで絞り込み、現在のグループに aria-current の印。「すべて」で外れる。一覧のチェックから集計しているときは「選んだ N 件」の行が現在として出る。0 件のときは「グループはまだありません。一覧でセッションを選ぶと作れます」の 1 行(編集モードでないときは「グループは atlas.bat から開くと作れます」)。件数が多いときはその群の中だけ縦に流す(最大 40vh)。
2. **操作の集約**: 絞り込み行の「グループ」select と `.group-field` の操作は外す。理由: グループの居場所を 1 か所(サイドバー、狭い幅ではその中身を開く一覧)にし、絞り込み行は属性の軸(期間・プロジェクト・クライアント・モデル)だけにする。select は件数も一文も見せられず、同じ一覧を 2 か所に持つことになるため。
3. **選択の操作列**(一覧の見出し直下): 「選んだ N 件だけ集計」「選択を解除」に加えて「グループに追加 ▾」(既存グループの一覧を開いて 1 回で追加。末尾に「新しいグループ…」で今のインライン作成)。グループで絞り込み中は「このグループから外す」も出す。外して 0 件になったグループは消さず 0 件のまま残す。追加後は絞り込みを変えず「N 件を「名前」に追加しました(既に入っていた K 件を除く)」を role=status で短く出す。重複は足さない。
4. **1280px 未満**: 固定目次行に「グループ」の 1 項目(ボタン、件数つき)を足し、押すと目次行の下に一覧が開く(サイドバーと同じ中身。外を押す / Esc で閉じ、焦点はボタンに戻る)。ダイアログ扱いにせず、キーボードで閉じられる。1024px で目次行の右端が切れている既知の点を悪化させない(項目は 1 つ増えるだけ。横に流れる)。
5. **選択を名前で持つ**: `FilterState` に `group: string`(名前)を足す。グループを選ぶと `group` に名前、`ids` にその時点の id(記録にあるもの)を両方書く。集計は「`group` の名前がグループにあればその今の ids、無ければ `ids`」で決める(共有した hash の相手にその名前が無ければ `ids` に落ちて「選んだ N 件」になる。グループを編集すれば絞り込みも追従する)。同じ id 集合のグループが 2 つあっても名前で区別できる。
6. **閲覧専用**(file://): サイドバーの一覧は埋め込みの groups で出し、選んで絞り込める。作成・改名・一文・削除・追加・除外の操作は出さない。「グループに追加」の代わりの案内は 1 行だけ。
7. CLI と groups.json の形式は変えない。

#### 実施(2026-11-01 深夜)

作ったもの・直したこと:

3. **選択の操作列**: 「グループに追加 ▾」(既存グループの一覧 + 末尾の「新しいグループ…」。Esc / 外を押す / ↑↓ で移動)と、グループで絞り込み中の「このグループから外す」。結果は「N 件を「名前」に追加しました(既に入っていた K 件を除く)」「N 件を「名前」から外しました(グループは 0 件のまま残ります)」を role=status で。追加では絞り込みを変えない(現在のグループに足したときだけ ids を追従させる)。
4. **名前で持つ**: `FilterState.group`(名前)。グループを選ぶと `group` と `ids`(その時点の記録にある id)の両方を hash に書く。集計は `effectiveIds`(名前が今のグループにあればその ids、無ければ `ids`)。現在のグループ名は名前で決め、決まらないとき(相手に無い名前)だけ ids の一致で探す。0 件のグループは `NO_SESSION`('(none)')を ids にして「制限なし」と区別する(`groupIds`)。同じ id 集合のグループが 2 つあっても名前で区別でき、後の方も改名・削除できる。

自分で決めたこと(戻し方は git): 群の位置は目次の下・件数の帯の上(目次と同じ「縦に並ぶ行」の作法で、件数の帯がグループの絞り込みの結果を受ける形になる)。「グループに追加 ▾」は既存グループが 0 件でも「新しいグループ…」だけの一覧として出す(作成の入口を 1 つにする)。「選択を解除」は集計中ならその条件も外す。hash の `group` は `ids` の後ろ(順序は `FilterState` のキー順)。

#### 見直し(2026-11-01 深夜)

1. **P1 lost update**: 画面の追加・除外が起動時の一覧から ids 全体を作って `PUT` し、サーバが全置換していたため、画面を開いたまま CLI の `group add` で足した id が消えていた。`PUT /api/groups/<name>` に差分 `{ add, remove }` を足し(`ids` との同時指定は 400)、サーバが `loadGroupsForWrite` で読み直した最新の ids に `addIds` / `removeIds` を適用して保存し、`added / dup / removed` を返す。画面は差分だけを送り、件数と一覧はサーバの応答から作る。groups.json の形式は変えない。
2. **P2 0 件のグループの印**: 現在のグループを ids の一致で探す fallback が、0 件のグループ(全て `NO_SESSION`)で最初の 0 件グループに当たっていた。`currentGroupName`(filter.ts の純関数)にし、追加・除外・作成の `setFilter` に `group` を含め、fallback は `NO_SESSION` や同じ集合が 2 つ以上のときは null。
3. **P2 選んだ件数**: `#ids=a,b,zzz` で「選んだ 3 件」になっていた。`knownSelection`(記録にある id だけ)の件数にした。
4. **P2 チェックの同期**: グループで絞り込み中に一覧(liveGroups)が変わるたびに eff が新しいオブジェクトになり、選択を同期する effect が走ってチェックが全件に戻っていた。依存を `eff.ids` の文字列(`$derived`)に切り出した。
5. **P2 無い名前の `#group=X`**: ids 無しの `group` だけが残ると 0 条件なのに「解除」が押せて hash に残っていた。effect で、名前があればその ids を補い、無ければ(グループの一覧が揃ってから)`group` を捨てる。

### 解析用の完全出力(2026-11-02)

動機(ユーザーの判断): 当面は外部に出さず、運用でカバーする。解析に必要な情報を全て出力し、出力データだけでローカルと同等の解析ができるようにする。data.db は資格情報に触れない形で取り込む。

契約:

1. **原本の保全はスナップショットの拡張で行う**(二重に持たない)。`out/snapshot/session-state/<id>/` に plan.md・vscode.metadata.json・checkpoints/・files/・rewind-file-snapshots/・policies/ を足す(ファイルは mtime とサイズで再利用)。rewind-snapshots/ と、一覧に無い名前のもの(fake-solution 等)とロックファイルは既定で写さず、`--snapshot-all` で写す(ロックは写さない)。写さなかったものは名前と容量を manifest(`sessions.skipped[]`)に残す。~/.copilot 直下は plans/(写す)、attachments/(写す)、chats/(`*.md` だけ写す。他は解析に使えないので名前と容量だけ)、logs/(既定で写さない。資格情報を含みうるアプリのログで、セッション解析には使わない。`--snapshot-all` で写す)、repos/(写さない。ソースのチェックアウトで記録ではない。名前と容量だけ)。~/.copilot には書き込まない(読むだけ。data.db は immutable で開く)。
2. **全文記録** `atlas export --full`: `out/full/<id>.md`。上限なしで、依頼・応答・reasoningText・ツールの引数と結果(成功含む)・hook の入出力・system.message・compaction の要約・skill の本文・チェックポイント・plan を時系列で出す。除くのは暗号化・不透明データ(encryptedContent、reasoningOpaque、reasoningBlocks の中の base64 らしい値)と base64 本体(session.binary_asset.data は `out/full/assets/<id>/<assetId>.<ext>` に書き出してリンクにする)だけで、除いた箇所に種別とサイズを書く。reasoningBlocks は要素ごとに読めるか(base64 でない文字列か)を見て、読めるものは出す。hook の結果(toolResult.textResultForLlm)がツールの結果と同一なら参照にする。秘密情報の形式検査(redactSecrets)は全文記録にも掛け、件数を末尾に出す。チェックポイントと plan はイベントに時刻が無いので、時系列の後に節として置き、compaction の行からチェックポイント番号で参照する。
3. **指示文・skill の閲覧ページ**: 重複なしで版ごと(contentHash)に `out/library/<hash>.md` に本文を置き、`out/instructions.html`(見出しごとの版一覧、本文、使われたセッション、初回と最終の利用日、前の版との差分)を作る。詳細ページの指示ファイルの行と skill からリンクする。本文は atlas.html に埋め込まない。サイドバーの付録に入れる(export のときだけ。build だけでは作らない)。
4. **data.db**: 設計の変更(ユーザー了承済み。「読まない」を改める)。ファイルは複製せず、`file:///…/data.db?immutable=1` の読み取り専用で開く(node:sqlite 24 で動くことを確認した)。読むのは名前で固定した許可リストの列だけ(`select *` は禁止): sessions(id, title, session_type, mode, model, reasoning_effort, is_running, was_interrupted, interruption_reason, created_at, updated_at, remote_control_enabled, auto_approve, enabled_experiments_json, forked_from_session_id, fork_original_history_event_count, total_*, context_*, agent, provider_id, execution_location, title_source, archived_at, permission_mode, sandbox_enabled, provisional, agent_scope)、session_context_usage(全列)、session_checkpoints(全列)、activity_items(id, workspace_id, session_id, activity_type, preview, is_read, created_at, updated_at)、projects(id, name, container_kind, main_repo_path, default_branch, github_owner, github_repo, created_at, last_opened_at, auto_approve, sandbox_enabled, branch_prefix, show_in_sidebar, remote_default_branch)、workspaces(id, project_id, worktree_id, workspace_type, branch, name, created_at, updated_at, session_id, archived_at, created_pr_*(url / number / state)、source_pr_*(repo / number / state)、last_diff_*、total_*)。accounts / settings / app_state / model_providers / remote_environments は開かない。許可リストに列が無くても落ちない(その列は null)。許可外の列は名前だけ数える(値は読まない)。結果はスナップショット時に `out/snapshot/desktop.json` に書き、extract が sessions.json の `desktop` 欄に合成し、全文記録と詳細ページに出す。immutable では -wal の未反映分を読めないので、WAL のサイズ・更新日時と「最近の行が欠ける可能性」を desktop.json と全文記録に書く。
5. **網羅の検査** `out/coverage.json`: 元データの event type × data のキー(トップレベルのキーは `^` 付き)ごとに、件数・バイト数・扱い(full = 全文に出した / ref = 参照や要約にした / excluded = 理由付きで除外)を出す。扱いの表(`coverage.ts`)に無いキーは「未分類」(unclassified)として数え、export のログと全文記録の末尾に出す。同じ表を data.db の列にも適用し(許可 / 許可外 / 未分類)、未分類の列を数える(値は読まない)。
6. **README**: README に、out/ は原本と秘密情報を含みうるので共有しないことを書く。5MB 制約は atlas.html の話で変えない。

#### 実施(2026-11-02)

作ったもの・直したこと:

1. **スナップショットの拡張**(`core/snapshot.ts`): セッションフォルダの plan.md・vscode.metadata.json・checkpoints/・files/・rewind-file-snapshots/・policies/・research/・sandbox-denials/ を写す(`copyTree`、サイズと mtime で再利用)。rewind-snapshots/ と一覧に無い名前のもの(fake-solution 等)・ロック以外の未知のファイルは `--snapshot-all` のときだけ写し、写さなかったものは `extras.skipped[]`(相対パス・バイト数・理由)。直下は plans/・attachments/ を写し、chats/ は `*.md` だけ、logs/ は `--snapshot-all` のときだけ、repos/ は写さない。判断: chats/ の `*.md` 以外は 2026-10-28 のフォルダに入った無関係なファイル群(idx / cs / cpp / dll / exe、76MB)で解析に使えない。logs/ はアプリのログで DB のパスなどを含み、セッションの解析には使わないので既定で写さない。repos/ はソースのチェックアウトで記録ではない。plans/ と attachments/ は小さく、セッションから参照されうるので写す。
2. **data.db**(`core/desktop.ts` と型 `desktop-types.ts`): `file:///…?immutable=1` + readOnly で開く(node 24 の node:sqlite で URI が通ることを実測。-shm / -wal の mtime は不変)。`DESKTOP_ALLOWLIST`(表 → 列)の列だけ `SELECT` し、`DESKTOP_FORBIDDEN_TABLES` は開かない。許可リストに無い列は `coverage.tables[表].unlisted` に名前だけ。結果は snapshot が `out/snapshot/desktop.json` に書き、extract が `desktopForSession` で sessions.json の `desktop` 欄(session / contextUsage / checkpoints / activity / workspace / project)に合成し、`SessionsFile.desktop`(WAL の注意と列の扱い)も持つ(`SESSIONS_SCHEMA_VERSION` 5)。詳細ページに「デスクトップアプリの記録(data.db)」の欄、全文記録に節。
3. **全文記録**(`report/full.ts`): events.jsonl を全件読み、イベントごとに種別・id・親 id・agentId の 1 行と、本文・引数・結果・hook の入力・system.message・skill 本文・compaction の要約を囲みで出す。扱いは `coverage.ts` の表(`ruleFor`)で決め、`excluded` は「除外: 種別、バイト数」、`ref` は 1 行に短く、表に無いキーは落とさず全文に出して「未分類」に数える。hook の `toolResult.textResultForLlm` / `sessionLog` がツールの結果と同一なら「ツールの結果と同一: call …」に置き換える。binary_asset は `out/full/assets/<id>/<assetId>.<ext>` に書き出してリンク。plan.md・checkpoints/*.md は本文を節に、files/・rewind-file-snapshots/・policies/ は一覧(policies の JSON は本文も)。secret の形式検査は全文字列に掛ける。
4. **網羅の検査**(`report/coverage.ts`): `COVERAGE_RULES`(event type → キー → full / ref / excluded。`*` は既定)と共通のトップレベルキー(`^id` / `^parentId` は ref、`^timestamp` / `^agentId` は full)。`CoverageCounter` が全イベントのキーごとに件数とバイト数を数え、`out/coverage.json` に種別別・キー別・扱い別の合計と、data.db の列の扱い(`desktopCoverage`)を書く。未分類は export のログと各全文記録の末尾。
5. **閲覧ページ**(`report/library.ts`): `LibraryCollector` が system.message の指示ブロック(`extractInstructionBlocks` に本文 `body` を足した)と skill.invoked の本文を、見出し(skill は名前)→ 版(contentHash)に束ね、`out/library/<hash>.md` と `out/instructions.html`(版ごとの details: ハッシュ・字数・セッション数・初回・最終・本文 .md、前の版との行差分(LCS、変化の無い行は前後 2 行だけ)、使われたセッションへのリンク)を書く。export のときだけ作る。詳細ページの指示ファイルの見出しと skill 名からリンク、サイドバーの付録に「指示文と skill」(`ReportData.library`、`REPORT_DATA_VERSION` 6)。
6. **CLI**: `--full`(export だけ)、`--snapshot-all`(snapshot / all / export)。

#### 見直し(2026-11-02)

1. **P1 不透明データの判定が全ての JSON 値に掛かっていた**: ツールの引数やファイルの内容にある 100 字以上の英数字列(16 進ダンプ、区切り線)が除外されていた。`looksOpaque` は reasoningBlocks の配下だけに掛け、他は秘密情報の形式検査だけにした。coverage に扱い `partial`(reasoningBlocks: 要素の中の base64 らしい値だけ除外)を足し、全文記録が実際に除外した箇所を `excludedN` / `excludedBytes` に数える(`CoverageCounter.addExcluded`)。
2. **P1 result の content と detailedContent の両方があると content が落ちていた**: 両方あって異なれば `result.content:` と `result.detailedContent:` を別々に、同じなら 1 回だけ書いて「同一」と記す。
3. **P2 文字列でない本文が黙って落ちる**: content / reasoningText / system.message.content / skill の content / summaryContent が文字列でなければ JSON の囲みに出す(`block`)。`used.add` は出力した分岐の中だけ。
4. **P2 シンボリックリンク・ジャンクション**: `walk` で辿らず、`extras.skipped` に「シンボリックリンク / ジャンクション(辿らない)」で残す。
5. **P2 削除の同期**: 元に無いファイルは複製先から消す(`copyTree` と追加のファイル、直下のフォルダ、chats の `*.md`。session.db と同じ作法)。`--snapshot-all` を外したときも写さなくなったものを消す。
6. **P2 ファイル単位の失敗**: `copyTree` / 追加のファイル / chats は 1 ファイルずつ catch し、`複製できなかった (EBUSY 等)` で skipped に積む(全体は止めない)。
7. **P2 生成物を黙って消さない**: `out/full/`・`coverage.json`・`instructions.html`・`library/` は、作り直すときだけ消す。素の build や --full なしの export では残し、「前回の … が残っています(生成日時)」をログに出す(`BuildResult.stale`)。
9. **P2 メモリ**: events.jsonl は `parseEvents`(1 行ずつ)で 1 回だけ走査し、閲覧ページの収集と全文記録の書き出しを同じ走査で行う。全文記録は `renderFullTo` が 64KB ごとに sink へ渡し、build は `createWriteStream` の `write` の戻り値で drain を待つ(backpressure)。`JSON.stringify` は値 1 つ単位(最大はツール結果 1 件)。出力の形は変えていない(明細の件数は末尾の「明細」の節に移した)。

#### 見直し 2(2026-11-02)

- **sink の error**(P2-A / B): `createFileSink`(full.ts)が stream の error を生成時に 1 回だけ受けて保持し、write / finish のたびに検査する。drain 待ちは error でも解ける(永久に待たない)。write ごとに `once('error')` を積まない。
- **壊れた記録**(P2-C): `<id>.md.tmp` に書いて成功時に rename。失敗時は destroy と tmp の削除をして、build を失敗にする(黙って残さない)。stale の判定は coverage.json が無くても `full/` の存在で見る。
- **大文字小文字だけの改名**(P2-D): `pruneTree` が削除の前に元の実在を確かめ(大文字小文字を区別しないファイルシステムでは残る)、削除で空になったフォルダも消す。
- **--snapshot-all の残り**(P2-E): 通常の snapshot では前回 `--snapshot-all` で写したもの(元にまだあるもの)を消さず、manifest の `extras.leftover`(パスと日時)とログに出す。`--snapshot-prune` で消す。元から消えたものは従来どおり消す。
- **walk の失敗**: 読めないフォルダ(EPERM / EACCES)はフォルダ単位で catch して skipped に「読めなかった」で積む。セッションフォルダ自体が読めないときも同じ。

### 改善点の分析(2026-11-02)

動機(ユーザーの言葉): 「このツールで全てのことを完結したい。単純なセッションの出力や、全ての要素を含めた完全なセッション出力。ボトルネックな指示やスキルなど、新たにスキル化できそうなものなど」。出力の 2 種類(セッション記録・全文記録)は「セッション記録の Markdown 出力」と「解析用の完全出力」で済んだので、分析を足す。

契約:

1. **LLM を呼ばない規則の集計**。atlas.html の絞り込みに従うもの(指示文・skill・時間の使われ方)はレポート内で `SessionSummary` から再計算し、本文が要るもの(スキル化の候補)は build / export 時に `sessions.json` の本文(依頼文の先頭・ターンごとのツールの列)から計算して結果だけ埋め込む(5MB 制約を守る。候補の全文と表の全件は別ページ `out/insights.html` に置く)。サイドバーに「改善点」の節(id `insights`、群「概況」の「要点」の次)。各項目から根拠のセッションの詳細ページ、指示文の版(instructions.html#v-<hash>)へ移動できる。
2. **ボトルネックの指示文**: 版(contentHash)ごとに、文字数、注入されたセッション数、ツールの失敗率(失敗 + 拒否 / 結果のある呼び出し)、手戻り率(同じファイルを 2 回以上編集したセッションの割合)、compaction / セッション、出力トークン / セッションを比べる。同じ見出しの版を初回の順に並べ、「長いのに注入が少ない」(文字数が全版の上位 25% かつ注入セッション数が閾値未満)と「版を変えた前後で悪化」(前後ともセッション数 ≥ 閾値で、失敗率か手戻り率が 10 ポイント以上悪化)を挙げる。
3. **ボトルネックの skill**: skill ごとに、呼び出し回数(利用者 / エージェント)、本文の大きさ(skill.invoked の content の文字数、無ければ記録なし)、呼び出したセッションの失敗率と呼び出さなかったセッションの失敗率、出力トークン / セッション、インストール済みで未使用のもの。
4. **時間の使われ方**: セッションごとに、待ち時間(TTFT と全体の中央値、記録のあるモデル)、失敗の連続(ツール失敗の最長連続回数)、同じファイルの再編集(2 回以上編集したファイル数と余分な編集回数)、権限確認の数、compaction の数を並べ、止まっている箇所(閾値以上のもの)をセッション単位とプロジェクト単位(該当セッション数 / セッション数)で出す。
5. **スキル化の候補**: (a) 似た依頼文の繰り返し: 依頼文を正規化(小文字、パス・URL・数字・記号を印に置換、空白を詰める)して文字 3-gram の集合を作り、Jaccard 類似度 ≥ 0.6 のものを貪欲に束ねる(LLM なし)。(b) 同じツールの並びの繰り返し: 本体のターンごとのツール名の列から、長さ 3〜6 の部分列で 3 回以上(2 セッション以上)現れるものを数え、長い方を優先して重なりを除く。どちらも繰り返し回数、関係セッション、推定の所要時間(各出現のターンの所要の中央値 × 回数)、代表の依頼文(最も中央に近いもの)を持ち、スコア(回数 × 所要時間の中央値)の順に出す。
6. **統計の誠実さ**: 分かるのは相関までなので、画面と README に「傾向」と書き、指示文の効果は直接測れない(同じ版でも依頼が違う)と明記する。閾値は `lib/insights.ts` の定数: `MIN_SESSIONS = 5`(率を出す最小のセッション数。5 件未満の率は 1 件で 20 ポイント動くため結論にしない)、`MIN_REPEAT = 3`(候補の最小の繰り返し。2 回は偶然でも起きる)、`SIMILARITY = 0.6`(3-gram の Jaccard。言い回しの違いを許しつつ別の依頼を混ぜない値として実データで確かめる)、`WORSE_POINTS = 10`(悪化とみなす差。MIN_SESSIONS=5 での 1 件分 20 ポイントの半分)、`STUCK` の各閾値(TTFT 中央値 ≥ 20 秒、連続失敗 ≥ 3、再編集 ≥ 3 回、権限確認 ≥ 10、compaction ≥ 3。実データの分布の上位 10% 付近)。閾値未満の項目は件数を添えて「傾向」の表には出さない。欠測は既存の語(記録なし / 推計不可 / —)で区別する。
7. **LLM による下書き(任意)**: `atlas skill-draft <番号>` は `out/insights.json` の候補(番号)からスキルの下書き(SKILL.md の形)を作る。判定と同じバックエンド経路(copilot-cli / anthropic、`--backend` / `--model`)を使い、明示したときだけ動く(既定の処理では呼ばない)。出力は `out/skill-drafts/<番号>-<名前>.md`。費用(1 回の生成で 1 リクエスト相当)は README に書く。

#### 実施(2026-11-02)

- 置き場所: 規則は `packages/report/src/lib/insights.ts`(純関数、`THRESHOLDS` を 1 か所に)。core は `SessionRecord.analysis`(手戻り・失敗の連続・本体のターンごとのツール列と所要・依頼文の先頭 300 字、schema 6)。`SessionSummary` に `skillChars` / `instructionVersions` / `analysis`(data version 7)。レポートの節は `Insights.svelte`、全件は `insights-page.ts`(`out/insights.html`)と `out/insights.json`(version 1)。`atlas skill-draft` は `packages/judge/src/skill-draft.ts`。
- 実データでの候補の見直し。最初の上位は役に立たないものだった: (1) 動作確認の定型文(行頭が reply with / respond with など)が依頼文の候補の上位 → `PROBE_REQUEST` で除外。(2) ツールの並びは `view → task → view` や `sql → rg → view` など閲覧中心の汎用の手順が上位を独占 → 閲覧系(`EXPLORE_TOOLS`)以外のツールが 2 種類以上(`SEQ_MIN_WORK = 2`)でないと候補にしない。連続の重複は潰し(`collapseRuns`)、`a → b → a → b` の周期的な繰り返しは除く(`isPeriodic`)。(3) ターンの所要に次の依頼までの待ちが入って数時間になっていた → ターンの最後のイベントまでに変更し、スコアの所要は 2 時間で頭打ち(`SCORE_MS_CAP`。自律実行の長いターンが回数より効きすぎないように)。(4) 同じセッションの同じ依頼文が例に重複 → 例は重複なし。(5) 「長いのに注入が少ない」に同じ見出しの旧版が並んだ → 見出しごとに最新の版だけ。
- 残る限界: ツールの並びの候補は「手順の繰り返し」であって「スキルにすべき」とは限らない(スコア順は目安)。依頼文の候補は本文の先頭 300 字の 3-gram なので、長い依頼の後半の違いは見ない。指示文の「前後比較」は同じ見出しの連続する版だけで、同時期の他の変化(モデル・依頼の種類)は切り分けない(画面に明記)。
- `skill-draft` の作業フォルダを `atlas-judge-cwd-` に揃えて「(atlas の判定)」に分類させた。バックエンドは契約どおり copilot-cli / anthropic にした(anthropic の呼び出しは `anthropicMessage` に切り出して判定と共有。本物の実行は未確認)。「長いのに注入が少ない」は全体での希少さなので、画面の絞り込みに関わらず全セッションで計算し、母集団が MIN_SESSIONS 未満なら出さない。
- 残した P3(率の小数桁、行見出しの th、.table-scroll の tabindex、「失敗率(呼ばない)」の情報量)は帳票の作法を全体で揃える話なので保留。

### セッションごとのメモ(2026-11-03)

動機: 「セッションの選択とグループ」で「将来はセッションごとのメモ(Markdown + 画像)を足す」とし、`atlas-notes/` を置き場に決めたまま先送りしていた。集計の数字だけでは残らない「なぜこのセッションが良かった / 悪かったか」を、利用者本人が根拠のセッションに書き残す。

契約:

1. **置き場**: `<notes-dir>/memos/<id>.md`(1 セッション 1 ファイルの素の Markdown。索引のファイルは持たない)と、画像の `<notes-dir>/memos/<id>/<名前>`。本文からは `![説明](<id>/<名前>)` の相対パスで参照するので、Obsidian や VS Code でもそのまま読める。手で置いた `.md` と画像も同じに扱う。`atlas-notes/` は Git の対象外のまま。id はファイル名に使える形(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$`)だけ受け付ける(`..` を通さない)。
2. **描画**: Node 側で marked(GFM、改行は `<br>`)を使い、renderer を差し替えて出力を組み立てる。生の HTML はエスケープして文字として出す。リンクは http / https / mailto だけ(それ以外は文字だけ)。見出しは 2 段下げる(節の h2 の下に入れる。h3〜h6)。画像は `<id>/` の直下の png / jpeg / gif / webp だけを読み、data: URI で埋め込む(詳細ページが単独で完結し、out/ に複製を持たなくて済む。外部参照の検査も変えない)。外部の画像は読み込まず「外部の画像(読み込みません)」のリンクにする。無い画像は欠測の語で 1 行出す。
3. **詳細ページ**: 表題の直下、概要の前に「メモ」の節。メモがあれば目次の先頭に出る。メモが無いページでは節は `hidden` で、file:// では何も見えない。CSS はメモのあるページだけに入れる(800 ページに同じ CSS を足さない)。
4. **編集(atlas serve から開いたとき)**: 編集の動きは静的ページに埋め込まず、`GET /api/memo-editor.js` を NAV_JS が serve のときだけ読み込む(file:// と共有用には 1 行も増えない)。読み込むと API の内容で節を描き直す(ビルド後に書いたメモも再読み込みで出る)。「メモを書く / 編集」→ テキスト欄(インライン、ダイアログにしない)→「保存」。Ctrl+S / Ctrl+Enter で保存。画像は貼り付け・ドロップ・「画像を追加」(キーボードで届く入口)。カーソル位置に Markdown を挿入する。本文を空にして保存するときと、入力のある取消のときだけ確認を 1 回出す(初期フォーカスは「やめる」)。保存していない入力があるまま離れるときはブラウザの確認を出す。サーバが止まったら編集の入口を消し、編集中なら入力を残して保存できない理由を出す。
5. **API**: `GET /api/memos/<id>` → `{ text, rev, html, updatedAt }`。`PUT /api/memos/<id>` `{ text, rev }`(rev は本文の sha256 の先頭 16 桁、無ければ '')。手元の rev と違えば 409 と最新の rev を返し、画面は入力を残して「別の場所で更新されました」と「上書きして保存」を出す(Obsidian や CLI と同時に触っても黙って消さない)。`POST /api/memos/<id>/images`(本文は画像そのもの、上限 10MB。形式は Content-Type ではなく先頭のバイトで判定。svg は通さない)→ `{ name, markdown }`。ファイル名は内容の sha256 の先頭 16 桁。`GET /api/state` に `memos`(id → 概要)を足す。書き込みの token・Origin の検査はグループと同じ。本文の書き込みは一時ファイル → rename。
6. **一覧**: `SessionSummary.memo`(先頭 80 字の抜粋・字数・画像数・更新日時。全文は atlas.html に埋め込まない)。セッション名の下に「メモ: 抜粋」を 1 行。「その他の条件」に「メモのあるセッションだけ」(`FilterState.memo`、hash に載せる)。メモが 1 件も無ければ出さない。編集モードでは `api/state` の値を使う。
7. **CLI**: `atlas memo list` / `show <id>` / `set <id> <本文...>` または `--file <path>` / `remove <id>`。id は先頭一致で解決(sessions.json があるとき)。`remove` は `.md` だけを消す(画像は残す。誤操作で戻せなくなるものを広げない)。
8. **判定には渡さない**: メモは bundle / judge / セッション記録 / 全文記録に入れない。利用者の自由記述を LLM や共有用の出力に黙って流さないため。

#### 実施(2026-11-03)

- 置き場所: 形と抜粋は `lib/memo.ts`(ブラウザと Node で共用)、読み書きは `memo-io.ts`、描画は `memo-render.ts`、編集の script は `memo-editor.ts`(文字列で持ち `GET /api/memo-editor.js` で配る)。CLI は `runMemo`、API は `serve.ts` の `memoApi`。`ReportData` は version 8。
- 依存を 1 つ足した: `marked`(MIT、依存なし)。Markdown の自作は表やリストの入れ子で誤りやすいので採らなかった。使うのは Node 側だけで、atlas.html には入らない(`lib/` から import しない)。
- 自分で決めたこと(戻し方は git): CLI の名前は `memo`(`--note` と紛らわしい `note` を避けた)。置き場は `<notes-dir>/memos/`。画像は out/ に複製せず data: URI にした(詳細ページが単独で完結する)。プレビューは付けない(保存すれば同じ場所に描かれる)。保存時に参照の無くなった画像は消さない(取り消しの手段が無いため。`remove` と本文の削除も画像を残す)。
- 大きな本文: 上限を超えた本文を読み切らずに例外にすると、送信中の相手が応答を受け取れない。最後まで読み捨ててから 413 にした。**同じプロセスの fetch で 10MB を送ると Windows で event loop ごと止まる**(タイマーも AbortSignal も発火しない。別プロセスでは起きないのでブラウザには関係しない)ので、単体テストは `memoImageLimit` で上限を小さくして境界を見る。

#### 見直し(2026-11-03)

1. **P1 編集の開始と読み込みの競合**: 読み込み前に「編集」を押すと空の欄が開き、後から rev だけ最新になるので、1 行書いて保存すると既存の本文が 409 なしで置き換わっていた。取消の直後も同じ。初回の読み込みが終わるまで「編集」を出さず、押すたびに GET し直してから欄を作り、編集中は読み込みの結果で memo を書き換えない。
2. **P2 同時保存**: 確認と書き込みの間に別の PUT が入ると lost update になり、一時ファイル名も同じだった。serve で id ごとに直列化し、一時ファイルは randomUUID の名前にした。
3. **P2 古い serve**: 古い serve の `/api/state` には memos が無く、空のマップが埋め込みを上書きしていた(`atlas.bat` は動いているサーバを使い回すので起きうる)。無ければ埋め込みのまま。
4. **P2 手で置いた画像の名前**: 英数字だけの許可リストで、`Pasted image 1.png` や日本語の名前が読めなかった。Windows で使えない文字・先頭の `.`・末尾の `.` と空白・予約名を拒否する形に改めた(`isSafeFileName`)。
5. **P2 既存の node_modules**: bat は node_modules が無いときだけ npm install するので、`marked` を足すと既存の環境で起動しなくなる。`scripts/deps-fresh.mjs`(lock と `node_modules/.package-lock.json` の版を比べる。node: だけで動く)で判定する形に bat を変えた。mtime の比較は git の checkout で毎回 install になるので採らなかった。
6. **P3 で直したもの**: 画像の追加中は保存と取消を止める、保存の失敗時にテキスト欄へ焦点を戻す、Ctrl+S は欄の外でも効く、サーバ停止後の取消で未処理の例外を出さない、抜粋が語の中の `_` `*` `~` を消さず front matter と区切り線を飛ばす、h4〜h6 の大きさ、手で置いた画像にも 10MB の上限、id と画像名の Windows の予約名、Host の検査(DNS rebinding。静的ページも API も)。
7. **残した P3**: 詳細ページの目次はメモの有無に追従しない(ビルド後に書いたメモは節に出るが目次には次の build まで出ない。削除しても項目が残る。節は表題の直下で常に見えるので目次の項目が無くても届く)。

### `all` でもセッション記録を作る(2026-11-03)

動機: `atlas.bat`(`all`)で開いた詳細ページに経過が無く、記録は `atlas-export.bat` でしか作れなかった。さらに export の後に `atlas.bat` を実行すると build が `.md` とリンクを消す。どの bat で作ったかで経過が見えたり消えたりするのは、使う側に分かりにくい。

決めたこと:
1. `all` の最後を build から export(既定の `--tool-output fail`、上限 20,000 字、`--full` なし)にする。`atlas.bat`・`npm run atlas` が記録を作る。
2. judge-flow の最後の build も export にする(直前の `all` が作った記録を消さない)。
3. 素の `build` が `.md` を消す規則は変えない(絞り込みで外れたセッションの古い記録を残さないため)。

採らなかった案: 詳細ページを開いたときに serve がその場で記録を作る(起動は速いままだが file:// で使えず、作りも複雑)。記録が無いときの案内だけを足す(つまずく場面が残る)。

### 画面からの操作 — 起動は atlas.bat 1 つ(2026-11-03)

動機: 起動用の bat が 4 つあり(`atlas` / `atlas-export` / `atlas-export-full` / `atlas-judge`)、「何をしたいか」を起動前に bat の名前で選ばせている。serve の画面でできるのは閲覧・グループ・メモだけで、集計し直す・全文を見る・判定するには、画面を閉じて別の bat を起動し直す必要がある。serve(「セッションの選択とグループ」〜「セッションごとのメモ」)で、token と Origin / Host の検査を持つ書き込みの土台はすでにある。当初の「ローカルサーバ型ダッシュボードは採らない」(下の「採らなかった案」)は、HTML 単体で file:// でも共有でも読めることが理由で、その性質はこの設計でも変えない(サーバは操作のためだけに使い、生成物は今どおり静的ファイル)。

**目標**: 利用者が起動するのは `atlas.bat` だけ。起動後の操作はすべて画面から。CLI(`npm run atlas -- <コマンド>`)は今のまま残す(自動化と細かい指定はこちら)。

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
   - 子プロセスの引数はサーバが固定の配列で組み立て、`shell: false` で `process.execPath` を起動する。画面からの文字列をコマンドラインに入れない。`id` は `isSafeMemoId` と sessions.json にあることを確かめる。`limit` は 0〜500 の整数、`backend` は `copilot-cli` の列挙。

6. **費用**: 判定は GitHub Copilot の AI クレジット(既存サブスクの範囲)を消費する。画面の確認ダイアログに対象の件数(未判定のうち limit まで)・バックエンド・「AI クレジットを消費します」を出し、既定の limit は 10。従量課金の anthropic は画面に出さない(CLI の `--backend anthropic` だけ)。

7. **bat**(利用者が決定): `atlas.bat` だけを残し、`atlas-export.bat` / `atlas-export-full.bat` / `atlas-judge.bat` は消す。CLI のコマンドはすべて残す。全件の全文と coverage.json(解析用の一括出力)は `npm run atlas -- export --full` で作る。

#### 決めたこと(2026-11-03、利用者の判断)

- bat は `atlas.bat` 1 つにする(上の 7)。
- 判定は画面から実行できるようにする。確認ダイアログ付きで、既定は 10 件、従量課金の anthropic は出さない(上の 6)。

後回しにした案: atlas.bat を「前回の out/ があれば先に画面を開き、集計は画面の中で走らせる」形にする(起動直後から見られるが、古い集計を見せる時間ができ、画面の状態が増える。上の契約が動いてから検討する)。採らなかった案: 記録を開くたびにサーバがその場で作る(「セッションごとのメモ」の後の計測で、全件を先に作っても +5 秒・+13MB と小さかった。.md は LLM に渡す用途にも要る)。

#### 実施(2026-11-03)

作ったもの:

1. **ジョブ**(`packages/cli/src/jobs.ts`、serve から使う): `JobRunner`(同時に 1 つ。2 つ目は 409)、`parseJobRequest`(kind の列挙、知らないキーは 400、judge は `limit` が 0〜500 の整数で必須、full は `isSafeMemoId` と sessions.json にあること(無ければ 404))、`jobArgs`(固定の配列: `main.ts all --out <out> --notes-dir <notes>` / `judge-flow.ts --limit <n> --backend <b> --out <out> --notes-dir <notes>`)。既定の起動は `spawn(process.execPath, args, { shell: false, windowsHide: true })`。止めるときは Windows では `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F`(judge-flow が起動した copilot を残さない)、他は SIGTERM。stdout / stderr は行に分けて末尾 200 行を残し、serve の窓(atlas.bat の窓)にも `[集計し直す] …` の形で流す。起動(`spawn`)・環境変数の追加(`env`)・全文の書き出し(`runFull`)は `ServeOptions.jobs` で差し替えられる。
2. **API**(`serve.ts`): `POST /api/jobs`(202 でジョブを返す)、`GET /api/jobs/current`(最後のジョブ。まだ無ければ `null`)、`POST /api/jobs/current/cancel`(動いていなければ 409)、`GET /api/jobs/judge-preview`(確認ダイアログの件数)。どれも token・Origin / Sec-Fetch-Site・Host を検査する。heartbeat が途切れてもジョブの実行中は止めず(`expire` が待つ。最初の heartbeat の待ちも同じ)、ジョブが終わってから猶予(idleMs)を測り直す。集計し直している間の 404(静的ページと記録の表示)は「集計し直している最中です…」の文面。
3. **全文 1 件**(`report/src/full.ts` の `writeFullRecord`): export --full と同じ `renderFullTo` / `createFileSink` で `out/full/<id>.md` と `out/full/assets/<id>/` だけを書く。網羅の集計はこの 1 件の中で数えて捨てる(`coverage.json` は書かない)。止めるときは AbortSignal をイベントの間で見て tmp を消す。
4. **記録の表示**(`report/src/viewer.ts`): `GET /view/<id>?kind=transcript|full` は殻(本文なし)、本文は `GET /api/view/<id>?kind=…`(token)が JSON で返す(下の「契約からのずれ」1)。描き方は `memo-render.ts` を `renderSafeMarkdown` に一般化して共用(メモの出力は変えない)。生の HTML は文字のまま、リンクは http / https / mailto だけ、外部の画像は読まない、全文記録だけ `assets/<id>/<名前>` の実在するファイル(画像は img、他はリンク)を `../full/assets/<id>/<名前>` で通す。先頭の `# 表題` はページの h1、`##` を h2 にして id を付け目次に(読んでいる節に印)。20MB を超えたら描かず大きさと「.md を開く」。見た目は詳細ページと同じ(page-nav、base.css、`.doc`)。
5. **画面**: atlas.html のマストヘッドに「集計し直す」「工数を判定する…」(`JobActions.svelte`)、本文の上に帯(`JobBand.svelte`、状態は `jobs.svelte.ts` の `JobStore` で共有。実行中は 1 秒、それ以外は 5 秒ごとに `api/jobs/current` を読む)。完了で「新しい集計ができました」+「再読み込み」(自動では読み直さない)。この画面のデータ(埋め込みの generatedAt)より後に始まった処理だけを出す。判定は `<dialog>`(件数の上限 既定 10、copilot -p、件数の行、「AI クレジットを消費します」、初期フォーカスは「やめる」、Esc・「やめる」では API を呼ばない)。詳細ページは NAV_JS が serve のときだけ `api/session-tools.js` を読み込み、表題の下に「記録を読む」「全文を作って読む」(`session-tools.ts`)。file:// には何も出ない(静的な生成物は NAV_JS の読み込み先が 1 つ増えただけ)。

契約からのずれ(どれも最小限。理由つき):

1. **`/view/<id>` は本文を持たない殻を返し、本文は token の要る `GET /api/view/<id>` から取る**。ページへの移動(リンク)には `X-Atlas-Token` ヘッダを付けられず、URL に token を載せると履歴と Referer に残り、cookie はポートを区別しないため。殻自体も Host・Origin / Sec-Fetch-Site を検査する(他サイトからの移動は 403)。表題(セッション名)も API から取る。
2. **API を 2 つ足した**: `GET /api/jobs/judge-preview`(確認ダイアログに「未判定 N 件のうち M 件」を出すため。sessions.json の「依頼の記録がある」セッション(`turns > 0 || firstUserMessage`、bundle の hasRequest の近似)と judgments.json から数える)と `GET /api/session-tools.js`(詳細ページの操作の script。memo-editor.js と同じ配り方)。
3. **記録の表示で、属性の無い `<small>` `<details>` `<summary>` だけはタグとして描く**。atlas 自身が記録(compaction の要約の折りたたみ)と全文記録(各イベントの id の行)に書くもので、文字のままだと全文記録の全行に `<small>…</small>` が見えて読めないため。esc した後で `&lt;small&gt;` の形そのものだけを戻すので、属性・イベント・大文字の変形は入らない(単体で確認)。メモの描画は変えていない。
4. **見出しの段**: メモは 2 段下げだが、表示は先頭の `# 表題` をページの h1 に回し `##` を h2 にした(ページの h1 と本文の h1 が重ならないように)。
5. **judge の子プロセスにも `--out` / `--notes-dir` を渡す**(契約の表は `--limit` と `--backend` だけだが、「同じ out / notes」の意図どおりにするため)。
6. **`GET /api/jobs/current` に `target`(件数・バックエンド・id)を足し、ジョブが無いときは `null`(200)**。404 にするとブラウザのコンソールに毎回エラーが出るため。
7. **cancel は全文(サーバ内)にも効く**(AbortSignal。tmp を消す)。
8. **帯は実行中と完了だけ上に貼る(sticky)**。失敗・中止はログ(末尾 200 行)を開くので、貼ると本文を覆うため。実行中はログの代わりに最後の 1 行を出す。
9. 画面の「集計し直す」は atlas.bat に渡した引数(`--since` など)を引き継がない(契約どおり固定の `all --out --notes-dir`。README に明記)。

- 残した P3: 上に貼った帯がキーボードで移った部品を覆う場合がある(scroll-padding は目次行の高さだけ)、表示の画像に width / height が無い(大きさが分からないため)。

未検証: `atlas.bat` のダブルクリックでの通し、本物の `copilot -p` での判定(クレジットを消費するため)、Windows の taskkill で judge-flow の孫プロセス(本物の copilot)が止まること(偽 copilot は node の子で、e2e の cancel は refresh で確かめた)。

#### 見直し(2026-11-03)

1. **P1 全文記録の表示の svg**: 全文記録の assets を「画像なら img、他はリンク」で通していたので、セッション由来の svg(`session.binary_asset` の `image/svg+xml`)がサーバのオリジンのリンクになり、押すと中の script が `127.0.0.1:<port>` で動いて token を読めた(確認ダイアログを通さない判定、メモの書き換え、記録の読み出しが可能)。二重に塞いだ: (a) 表示がリンクにする形式を、開いても script が動かないもの(画像・txt・log・json・csv・pdf・bin)に限る(`viewer.ts` の `PASSIVE_EXT`。svg・html・xml は名前だけ)。(b) serve の静的配信の HTML 以外に `Content-Security-Policy: sandbox` と `X-Content-Type-Options: nosniff`、HTML(token 入り)に `X-Frame-Options: DENY` と `frame-ancestors 'none'`(費用のかかる判定のボタンをクリックジャッキングで押させない。審査の P3-1)。
2. **P2 atlas.bat の再実行とジョブの並行**: ジョブの実行中だけ `out/.job.json`(serve の pid・種類)を置き、`all` は他のプロセスの印があれば「画面から実行した処理(…)が動いています」で止まる(古い印=プロセスが無いもの・自分の印・ジョブの子プロセス(環境変数 `ATLAS_SERVE_JOB`)では止まらない)。
3. **残した P3**: 許可タグ(details / summary)が対になっていない本文で表示が段落の中で崩れる(安全上の問題は無い)、1 件の全文記録の見出しが `atlas export --full` のまま・作った後の集計で「前回の --full の出力が残っています」のログが出る・既にある全文を作り直さずに読む入口が無い、`/sessions/<id>.md` は token なしで配信される(他のオリジンからは読めない。以前からの設計)。

#### 追加の修正(2026-11-03)

1. **R-1 out/ の下のどの .html も atlas の画面として配っていた**(P1 と同じ種類。アプリのリンクからは行けないが、URL を直接開くと `snapshot/` の写しの .html の script が token を読み、ジョブを起動できた)。token の差し込みとフレーム禁止は atlas 自身の画面(直下の atlas / glossary / insights / instructions.html と `sessions/<id>.html`。`serve.ts` の `isAppPage`)だけにし、他の .html は token を入れず sandbox の静的ファイルとして返す。
2. **R-2 serve が止まっても印が残る**: serve の終了時に自分の印を消す(`dropLock`)。`all` が止まったときの文面に、印のファイルを消せば抜けられることを書いた(pid が再利用されて古い印を生きているとみなす場合の抜け道)。
3. **R-3 印を消すときの例外で serve が落ちうる**: try / catch で包んだ(消せなくても止めない。次の all はプロセスの有無で古い印を無視する)。
4. 残したもの: R-4(atlas.bat の all の実行中に画面の「集計し直す」を押すことは防げない。印は serve 側だけ)。

### 画面の見直しと、記録を別のウィンドウで開く(2026-11-03)

利用者の依頼: 「セッション記録を Markdown で開くときは別ウィンドウで」「UI 全般が見やすいか見直す」。

- **別のウィンドウ**: 記録を読む操作(「記録を読む」「全文を作って読む」、詳細ページの「記録(Markdown)を開く」「全文記録(解析用)を開く」、表示の「.md を開く」)は `target=_blank` + `rel=noopener` で開き、詳細ページを残す。ラベルの後ろに ↗ と読み上げ用の文。保存(download)のリンクは対象外。「全文を作って読む」は作り終わるまで待つので、押した時点で空のウィンドウを開いておき(非同期の後の `window.open` はポップアップとして止められる)、できたらそこへ移す。開けなかったとき・再読み込みで続きから待ったときは状態の行に「全文記録を開く ↗」を出す。採らなかった案: 本物の別ウィンドウ(`window.open` の popup 指定)— 中クリックや「新しいタブで開く」が使えなくなり、タブかウィンドウかはブラウザの設定に任せるほうが自然なため。
- **表示の直し**(撮った画面で見つけたもの): セッション一覧の題名(多くは依頼文の先頭)が 4〜5 行に折り返して 1 行が 100px 近くあった → 2 行で切り(title に全文)、欄の最小幅を 18em に。パスが名前の途中で切れていた(`C:\work\my_projec` / `t` のような切れ方)→ 区切りの直後に `<wbr>`。要点の 4 枠を 3 列に並べると右下が空欄 → 最後の行の枠を横に伸ばす。入力トークン記録の凡例で色の印が下がっていた(行の高さが一番長い凡例に揃い、flex の行が引き伸ばされていた)→ `align-content: flex-start`。表題の説明文が日付の途中で折り返していた → 日付を nowrap、幅 100ch。見出しと説明文の「ありま / す。」→ `word-break: auto-phrase`。
- **残したもの**: 実行の性質の 2 列の箱は隣の表の高さに揃うので片側に空きが出る(様式の罫を保つ)。素の `build` で作り直すと、`.md` が残っていても詳細ページから記録へのリンクが消える(以前からの動き。記録を作るのは `all` / `export`)。

### グループの管理のしやすさ(2026-11-03)

利用者の問い「グループ化は見やすく管理しやすい形か」に答えた。見やすさは十分(サイドバーの名前・件数・一文、現在の印、選ぶと全体が絞り込まれる、狭い幅の一覧)。管理のしやすさで 4 件を直した。

1. **チェックが残り、次のグループに前の分が黙って混ざる**: グループで絞り込むと行は全てチェック済みになるが(「セッションの選択とグループ」の設計)、「すべて」に戻してもチェックが残っていた(`App.svelte` の選択の effect が ids が空になったときに何もしなかった)。ids が空になったとき(前が空でなかったときだけ。手でチェックしただけの選択は消さない)と、現在でないグループに足し終えたときに外す。
2. **所属が見えない**: 一覧の行に「グループ: 名前、…」、詳細ページ(serve のとき、`GET /api/state` から)に名前のリンク(`../atlas.html#group=名前`)。
3. **「グループに追加 ▾」のメニューが右にはみ出す**(1440px で 73px、ページが横に流れる): ボタンの右端に揃える。
4. 作成欄の説明文の古い場所(「絞り込み行の「グループ」」)を直した。

- **残したもの**(好みにも関わるので別に扱う): 選択は 1 ページ(50 件)ずつ、グループ同士を並べて比べる表は無い。

### グループの管理を本文の見出しへ(2026-11-03)

利用者の問い「サイドバーに改名や削除を載せるのは良い UI か」に、A(サイドバーは切り替えだけ、管理は本文の見出し)と B(行の「⋯」メニュー)を示し、利用者が A を選んだ。あわせて同種の UI を見直した。

- **直したこと**: グループで絞り込み中だけ本文の先頭に `GroupHead.svelte`(名前・件数・説明、「編集」「絞り込みを外す」)。「編集」は名前と説明を 1 つの欄で直す(変わった分だけ `PUT /api/groups/<名前>` 1 回。サーバは以前から両方を受ける)。削除は編集欄の右端の「このグループを削除…」から確認つき。Esc は 1 段ずつ戻り、焦点は「やめる」→「このグループを削除…」→「編集」と戻る。`GroupRail.svelte` から操作を外した。
- **同種の見直しで直したこと**: 現在のグループを押し直すと絞り込みが外れる隠れた切り替え(押し直しても同じにした)、「選んだ N 件(押すと外す)」の行(ボタンでなく印に)、利用者向けの「一文」(「説明」に)。
- **残したもの**: プロジェクト別の表の名前を押し直すと解除(行に「もう一度押すと解除」と書いてあり、絞り込みの行のプロジェクトでも外せる)。メモの削除は本文を空にして保存する形(確認つき)。詳細ページのサイドバーの「記録を .md で保存」(別ページへのリンクと並ぶが、目次とは罫で分けてある)。

- **残したもの**: 画面を開いたまま CLI で改名・削除したグループを見出しで直そうとすると 404 の理由が出るが、一覧は再読み込みまで古いまま(以前のサイドバーでも同じ)。

### セッションごとの指示文と skill(2026-11-04)

利用者の問い「詳細ページから指示文のページを開くと全部が出る。そのセッションに効いている指示や skill だけを一覧で見られないか」への答え。

- **調べたこと(実測)**: 詳細ページには以前から注入された指示ファイルの表と、呼んだ skill の表があったが、節が分かれ、サイドバーの「指示文と skill」は全部を開いていた。使えた skill はシステムメッセージの `<skill><available_skills><skill><name/><description/><location/></skill>…` に並ぶ。Copilot CLI 1.0.77 より前の版(1.0.25〜1.0.71)と `copilot -p`(producer: copilot-agent)のセッションには無かった。location は user / project / custom / builtin。1 セッションの中で一覧が変わったものが 4 件あったので和集合にする。閉じタグの無い(途中で切れた)ものが 1 件。
- **作ったもの**: `SessionRecord.availableSkills`(sessions.json の schemaVersion 7。一覧が無いセッションは null)。詳細ページの「指示ファイル」の節を「指示文と skill」にし、指示文の表と skill の表(使えた skill + 一覧に無い呼び出し、置き場所、呼んだ回数。呼んだものが先)を置く。目次の「指示文と skill」と節の見出しの横のリンクは `instructions.html#session=<id>` を開き、指示文のページはそのセッションで使われた版だけを残す(版に `data-sessions`、帯に件数と「すべて表示」「セッションの詳細に戻る」)。
- **残したもの**: `custom` の意味(どこに置いた skill か)は公式の説明を確かめていないので、ログの値のまま出す。使えたが呼ばなかった skill の本文は記録に無いので指示文のページには出ない。

### 初期設定の setup.bat(2026-11-08)

利用者の依頼「wiki など初期設定をするための setup.bat を作って」への答え。「画面からの操作」の「起動用の bat は atlas.bat 1 つ」は集計と画面の起動の話として残し、設定だけをする bat を 1 つ足した。

- **作ったもの**: `setup.bat` → `packages/cli/src/setup.ts`。依存を入れ(atlas.bat と同じ判定)、vault(ドラッグしたフォルダはフォルダ名だけにする。`wiki/` があれば個別ページの場所として勧め、`index.md` が無ければ索引の名前を尋ねる。インストール済みの skill のうち名前に wiki を含むものを 1 度だけ候補に出す)と普段の工程名を尋ね、`parseConfig` を通してから書く。既存は `.bak` に退避し、「このままにする」を既定にする。
- **決めたこと**: 入力は `rl.question` ではなく行の反復子で読む(入力を流し込んだときに、尋ねる前に届いた行を落として止まったため。実測)。入力が途中で終わったら書かずに失敗にする(空の答えは「既定のまま書く」になるため)。
- **採らなかった案**: `~/.claude/wiki-vaults.json` などの他ツールの設定から vault を推測する(Copilot の利用者には無いもので、置き場所も決まっていない)。終わった後に続けて集計する(設定を見直してから atlas.bat を押せばよく、尋ねる項目が増える)。
- **残したもの**: 実際の黒い窓で日本語を打ち込む操作と、フォルダのドラッグは試していない。

### 人のレビューの前の機械・LLM の点検(2026-11-08)

利用者の依頼「人がレビューする前に、機械と LLM の点検で直せるものはすべて直す」への答え。

- **実データで atlas.html が 5MB を超えていた(E2E 4 件の失敗)**: 2,212 セッションで 5.84 MB。埋め込みの大半はセッションの要約(4.76 MB)で、空のセッション(659 件)を含め、既定値のままの項目が多かった。`report/src/lib/pack.ts` で、既定値(空のセッションと同じ値)と一致する項目と id から作れる `href` を落として埋め込み、読み込み(`app/main.ts`)と `extractEmbedded` で埋め戻す。既定値と違う値は 0 も null も残すので、欠測と 0 の区別は失わない。採らなかった案: 埋め込みを gzip + base64 にして DecompressionStream で戻す(もっと小さくなるが、読み込みが非同期になり、埋め込みを直接読むテストと検査をすべて変える必要がある)。上限を緩める(共有するファイルの大きさの約束を変えることになる)。セッションが増え続ければいずれまた上限に近づくので、そのときは上の gzip を検討する。
- **前回のレビューで残していた 5 件**: 画面の「書き出す」の間は out/ の印を取り、同じ serve の集計などのジョブも始めない(書きかけの sessions.json を読まない)。turn-judgments.json が壊れていても、判定の列なしで書き出して注意を出す。表(turns.csv・sessions.csv)を作る処理を `cli/src/tables.ts` の 1 つにした(集計の表とグループの書き出し)。依頼の塊の文字数を測る描画を使い回す(最後の 1 回を描き直さない)。リクエストのターンへの振り分けを二分探索にした(開始の時刻が前後していても先頭から見るのと同じ結果になる)。

### グループのアップロード(2026-11-08)

利用者の依頼「タスクごとにグループでまとめたセッションを、既定のパス(例: `E:\dev\atlas-logs`)の タスク名 のフォルダへアップしたい。既存の同じセッションは上書き」への答え。中身(生ログ / 記録 .md / 両方)と、セッションのフォルダ名(連番 / セッション ID)は利用者に確かめ、生ログ・セッション ID にした(連番はグループの増減で番号がずれ、「同じセッションは上書き」が別のセッションを上書きするため)。

- **作ったもの**: `packages/cli/src/group-upload.ts`(`<out>/snapshot/session-state/<id>/` を `<基底>/<グループ名>/<id>/` へ。隣に写してから置き換える。スナップショットの作業用の `.session.db.src` は入れない)。`session-store.db` のそのセッションの行を `atlas-session-store.json` で添える(生ログだけだとトークン数などが欠けることがある)。デスクトップアプリのセッションの `data.db` の行(snapshot の `desktop.json` の、許可リストの列だけ)も同じファイルの `desktop` に添える(実データの直近 3 件で集計し直したとき、2 件の題名・モデル・トークン数が欠けていたのを見つけて足した)。グループの説明とメモも残す(2026-11-09): グループのフォルダに `README.md`(グループ名・説明・写した日時・何時点の集計か・今回写したセッションの一覧と題名・メモの有無・集計し直すコマンド。題名は集計の記録の name)、各セッションのフォルダに `atlas-memo.md` と `atlas-memo/`(本文の画像の参照 `<id>/…` を `atlas-memo/…` に直す)。採らなかった案: メモをグループのフォルダにまとめる(セッションと一緒に置き換わらず、外したセッションのメモが残る)。README は写すたびに書き直すので、一覧は最後に写した回の分になる。レビュー(2026-11-09)で直したもの: 置き換えは前のフォルダを `.<id>.old` に退けてから差し替えて最後に消す(開かれたファイルで消す途中に止まって前のフォルダが欠けるのを防ぐ。Windows では開いたファイルを含むフォルダの改名が EPERM になり、前のフォルダを残して止まる)、添えた desktop の形を確かめる(違えば使わず理由を出す)、フォルダ名が同じになる別のグループ・前回の集計に 1 件も無いグループは写さない、予約名は拡張子付き(`nul.log`)も避ける、`updateConfig` は値の差し替え・末尾への追加で済めば他の項目の書き方を残し、一時ファイルから置き換える。続けて直したもの: セッションの name が無いか仮の「New session」のままなら data.db の title を使う(extract の `sessionName`。画面・記録・README で同じ名前になる。実データの data.db のある 37 件では 33 件が同じ、3 件が「New session」、1 件は name の方が的確だったので、name があれば残す)。送った先は `--home <基底>/<グループ名>` で集計し直せる(snapshot が「直下にセッションが並ぶ形」を `layout: flat` として読み、extract が添えた行を足す。同じセッションの行が DB にあれば DB を優先)。CLI `atlas group upload <名前> [--to <dir>]`、設定 `uploadRoot`(`setup.bat` の 3 つ目の質問、画面の「場所を決める…」)、serve の API(`PUT/POST api/upload-root`、`POST api/groups/<名前>/upload`、`…/upload/open`)、画面は GroupHead(surface brief の UPLOAD)。
- **決めたこと**: 元の `~/.copilot` ではなく前回の集計の複製を写す(SQLite の一貫した複製があり、元を開かない方針を保てる。atlas.bat は起動時に集計するので、普段は新しい)。結果の文に何時の集計かを出す。基底のフォルダは作らない(ネットワークドライブの切断などで思わぬ場所に作らない)。グループから外したセッションや、ほかの回・ほかの PC から写したフォルダは消さない。groups.json は手で書けるので、`..` や区切りを含む id は写さない。フォルダ名はグループ名を書き出しと同じ規則(`safeDirName`、report の lib/groups.ts に移して画面と共有)で直すだけにし、書き出しのような「他のグループと衝突したらハッシュを足す」はしない(ほかのグループの一覧によって先が変わってしまうため。画面に写す先をそのまま見せる)。フォルダを選ぶ画面はサーバが PowerShell(pwsh があれば新しい形のダイアログ、無ければ 5.1)で出す(ブラウザはフルパスを取れない)。設定ファイルは 1 項目だけ書き換え、他の項目と書き方を残す。壊れた設定は書き換えない。
- **採らなかった案**: ブラウザの File System Access API(フルパスが取れず、Chromium 限定で、毎回の許可が要る)。アップロード先ごとのグループ別の設定(依頼は「既定のパスを決めておいて、タスク名ごとに自動」)。記録の .md も一緒に写す(利用者が生ログを選んだ)。
- **残したもの**: 実際にフォルダを選ぶ画面を出して選ぶ操作と、「エクスプローラーで開く」で窓が開くことは試していない(利用者の画面に窓が出るため、デスクトップの操作の許可を得られなかった)。ダイアログがブラウザの後ろに出ることがありうる(最前面の親窓を付けたが未確認。画面に「タスクバーを確かめて」の 1 文を出す)。

### サイドバーを出す幅(2026-11-09)

利用者の指摘「サイドバーは画面サイズに関わらず出したほうが良い、画面上部は分かりにくい」への答え。サイドバーを出す幅を 1280px 以上から 768px 以上に下げた(atlas.html・詳細・用語の 3 画面。CSS の `@media (min-width: …)` と、`App.svelte`・`page-nav.ts`・`viewer.ts` の `matchMedia`)。1280px 未満では目次とグループが上部の 1 行に畳まれ、グループは行末の「グループ N」を押さないと見えず、グループを選んで初めて出る「アップロード」に辿り着きにくかった。

- **決めたこと**: 768px 未満(スマホの幅)は従来どおり上部の 1 行。13em のサイドバーを出すと本文が 150px ほどしか残らず読めないため。768〜1280px では本文が狭くなるぶん、表は横スクロールで読む(列幅は変えない)。
- **採らなかった案**: どの幅でも出す(スマホの幅で本文が読めない)。狭い幅ではサイドバーを細くする・畳めるようにする(項目の説明の 1 行が読めなくなり、畳む操作が増える。必要になったら)。

### アップロードを安心して使う(2026-11-09)

利用者が挙げた運用の懸念(秘密の情報がそのまま写る・大きいと止まって見える)への答え。

- **作ったもの**: 写す前の点検 `checkTarget`(合計の大きさ・大きいもの・秘密らしい文字列。種類は全文記録の伏せ字と同じ `SECRET_PATTERNS`)。画面は写す前に毎回確認を出す(送り先・件数・大きさ・置き換える件数。秘密らしい文字列があれば種類とファイルも出し、焦点は「やめる」、ボタンは「それでも写す」)。写している間は `upload/progress` を 0.5 秒ごとに尋ねてバイト数を出す(`cp` では進み具合が取れないので、ファイルごとに写す `copyFiles`)。CLI の `group upload` は秘密らしい文字列があれば止まり、`--force` で写す。
- **決めたこと**: バイナリ(先頭 8 KB に NUL)は調べない(session.db・画像・ビルドの成果物。件数は出す)。大きなファイルは 4 MB ずつ、16 KB 重ねて読み、重ねた部分は次の塊で数える(境目をまたぐ鍵を取りこぼさず、二重にも数えない)。確認は最初「秘密らしい文字列があるか 100 MB を超えるときだけ」にしたが、利用者の希望で毎回にした(送り先も毎回見せる)。
- **採らなかった案**: 秘密らしい文字列を伏せて写す(生ログを変えると集計し直した結果が元と変わる)。

### タスクタグとプロジェクト単位の送り(2026-11-09)

利用者の依頼「一般の利用者はアップロードするだけなので、セッションごとにタスクタグを付けられるようにし、bat でプロジェクト単位で送る。タスクごとの判別を人間と AI ができるように。タグの無いものも送る」への答え。

- **決めたこと**: タスクタグは今のグループをそのまま使う(1 つのセッションに複数付けられ、作ったグループがそのままタグになる)。画面の呼び名だけを「タスクタグ」にし、保存先(`atlas-notes/groups.json`)・API・CLI の `group` は変えない。詳細ページ(serve のとき)で付け外しできる(`session-tools.ts`。今あるタグは候補に出し、無い名前なら作る)。
- **`upload-project.bat`**(`upload-project.ts`): 集計し直してからプロジェクト(集計のプロジェクト別と同じ単位。空のセッションは数えない)を番号で選び、そのプロジェクトの全セッション(タグの無いものも)を `<送り先>/<プロジェクト名>/<id>/` に写す。送り先は一度エクスプローラーで選ぶと `uploadRoot` に覚え(画面と共通)、送る前に毎回確かめる(`y` で送る / `c` で選び直す / Enter でやめる)。利用者は「自動アップロードは不安定」として、自動ではなく bat を叩く形を選んだ。
- **送り先の索引**: README.md にタスクタグの列とタグごとの一覧(タグなしを含む)、`atlas-index.json`(プログラムや AI が読む。セッションごとのタグ・題名・作成と最終更新・プロジェクト・メモの有無)、各セッションのフォルダに `atlas-session.json`(1 つのフォルダだけを渡されても分かるように)。写すまとまりは `UploadTarget`(グループ / プロジェクト)にして、点検とアップロードを共通にした。
- **採らなかった案**: グループとは別にセッションごとのタグを持つ(同じ「名前 → セッションの集まり」が 2 つになる)。bat でタグの付いたセッションだけを送る・全プロジェクトを送る(利用者がプロジェクトを選ぶ形を選んだ)。

### サーバが頻繁に止まる(2026-11-09)

利用者の報告「サーバーが頻繁に落ちる」。原因は 2 つ。(1) heartbeat が 8 秒途切れると止まっていたが、ブラウザは隠れたタブのタイマーを間引く(Chrome は 5 分以上隠れたタブを 1 分に 1 回まで)ので、別のタブで作業している間に止まった。(2) 画面は heartbeat が 1 回失敗しただけで送るのをやめ、生きているサーバまで 8 秒後に止めていた。

- **決めたこと**: 止まる条件を「開いている画面がすべて閉じた(pagehide で bye を送る)後の 15 秒」にし、heartbeat の途切れは保険として 30 分にした。画面ごとに id(`x-atlas-client`)を送り、ほかの画面が開いていれば 1 つ閉じても止まらない(3 分 heartbeat の無い画面は数えない)。ページの移動・戻る / 進むは次のページの heartbeat が猶予の間に届く。画面は 3 回続けて失敗するまで止まったとみなさない(403 はすぐ)。タブが表に戻ったとき・bfcache から戻ったときはすぐ送る。

### 戻る・進む(2026-11-09)

利用者の依頼「戻る、進むなどのバグ潰し」。プレビューで操作して 3 つ見つけた。

- 詳細ページから戻ると先頭・一覧の 1 ページ目に戻っていた: ブラウザがスクロール位置を戻す時点ではまだ描いておらずページが短い。離れるとき(pagehide)に履歴の項目(`history.state`)へ位置と一覧の並べ替え・ページを書き、戻る / 進む・再読み込みのときだけ描いてから戻す(`view-restore.ts`。`requestAnimationFrame` に頼らない: 描画の合図が来ない環境があった。後から高さが変わるときのため 0.3 秒後にもう一度だけ合わせ、その間に自分でスクロールしたら合わせない)。絞り込みの URL を書き直すときに `history.state` を消さない。
- 要点のリンクで絞り込んでから「戻る」を押しても絞り込みが残っていた: 絞り込みの無い状態は # を書かないので、# の無い URL に戻ったときを読み飛ばしていた。# が空になったら絞り込みを外す(#overview のようなページ内リンクは今までどおり触れない)。
- アップロード中に別のページへ移って戻ると、続いているアップロードを知らずに「書き出しています」で断っていた。理由を「アップロードしている最中」にし、戻った画面にも進み具合を出して終わりを知らせる。

### CI を整える(2026-11-09)

この日、CI が 3 回落ちた(配布物の確認を手元で回さずに push、Linux のパスの区切り、画面テストの競合)。

- **決めたこと**: CI と同じ順に手元で回す `npm run ci` と、配布物の確認だけの `npm run smoke`(`scripts/smoke-local.ts`。CI も同じものを使う)。画面テストが落ちたらその時点の画面を `out/ui-failures/` に残し(`ui/failure-shot.ts`)、CI では成果物として 7 日残す。Playwright のブラウザを版ごとにキャッシュする。
- **採らなかった案**: 画面テストの自動のやり直し(retry。競合を隠す。この日の競合は、開いた欄に焦点が移る前に打つテスト側の問題で、待ってから打つ `focusLands` で直した)。

### 3 回目のレビュー(2026-11-09)

PR #8 を網羅的なレビューに通した指摘への答え。

- **確認から写すまでの変化**: 点検に指紋(写すセッション・ファイル数・大きさ・秘密らしい文字列の数・集計の時刻)を付け、写すときに渡す。写す直前に点検し直して違えば写さない(`UploadChangedError`。upload-project は確かめ直しに戻り、画面は理由を出す)。入力を待つ間はロックを放すので、その間に集計し直すと確かめていない中身を写してしまうため。
- **名前の衝突**: 名前を比べて止める(0 件のタグやまだ送っていない名前でも止まる)のをやめ、送り先のフォルダの `atlas-index.json` に別のもの(種類か名前が違う)が記録されていれば止める。タグの送信が sessions.json に頼らなくなった(壊れていても止まらない)。採らなかった案: 送り先をタグとプロジェクトで分ける(`<基底>/tags/<名前>`・`<基底>/projects/<名前>`)。根本的だが、すでに送ったフォルダとの関係が変わるので、利用者の判断を待つ。
- **効率**: session-store.db は点検とアップロードで 1 回だけ開く(`openSessionStoreReader`。以前はセッションごとに開き直し、416 件のプロジェクトで 800 回を超えた)。upload-project は sessions.json を 1 回だけ読む。
- **そのほか**: 確認の合計と進み具合の合計を揃える(メモの本文と画像、DB の行も入れる)。戻った画面の直近の結果は 1 回だけ出し、失敗の後にほかから送り直して成功していれば(索引の日時が新しければ)出さない。番号の無い bye(古いページ)は覚えない。日時は report の `dateTime` を使う。`npm run smoke` は回すたびに別の一時フォルダで回す。

### zip での配布をやめる・記録は送った先で作る(2026-11-09)

- **zip での配布をやめる**: 利用者の判断「zip 対応は撤廃して良い」。`release.yml`(v* タグで GitHub Release に zip を添付)を外し、利用者は `git clone` と `git pull` で使う。CI の配布物の確認は、clone した直後と同じ中身(`scripts/fresh-checkout.ts`。git archive HEAD だけで、レポートのテンプレートは入れない)を `scripts/checkout-smoke.ts` で動かす形に変え、最初の atlas all がテンプレートを作ることも確かめる。
- **記録(.md)は送らない**: 利用者の判断「容量を圧迫するので、アップロード先のセッションから生成できるなら良い」。送った先で `atlas all --home <送り先>/<名前>` を実行すると、セッションごとの記録(`sessions/<id>.md`)ができることを E2E で確かめ(phase15 e)、送り先の README に作り方を書いた。送り先をタグとプロジェクトで分ける案も使わない。

### まとめて送るプロジェクトを画面で決めておく(2026-11-10)

利用者の依頼「upload-project.bat でアップするプロジェクトもあらかじめツールで設定したい。プロジェクトが多く、毎回 bat で選ぶのが大変」への答え。設定の場所と、新しいプロジェクトの扱いは利用者が推奨案を選んだ。

- **決めたこと**: 画面の「プロジェクト別」の表に「まとめて送る」の印(serve から開いたときだけ)。印は `atlas.config.json` の `uploadProjects`(プロジェクト名の配列)に書き、`PUT api/upload-projects`(`{ project, on }`)で 1 つずつ足す・外す(毎回設定を読み直してから書く。空になれば項目ごと消す)。bat は印があれば番号を聞かずに印のプロジェクトを送り、送る前の確認は 1 回(プロジェクトごとの 1 行と合計、秘密らしい文字列はまとめて)。印の無いプロジェクトは送らずに名前を出す(送るものを選ぶ形。新しいプロジェクトが勝手に送られない)。印が無ければ今までどおり番号で選び、`1 3 5-8` のように複数選べる。
- **まとめて送るときの決まり**: 送る間は集計のロックを持ち続ける(途中で集計し直されないように)。1 つ送れなくても残りは送り、最後に送れなかったものを出して止まる(終了コード 1)。フォルダ名が同じになるプロジェクトを一度に選んだら、何も送らずに止まる。確かめた後にログが変わったら、送っていない残りを確かめ直す。`setup.bat` は `uploadProjects` を尋ねず、書き直すときも残す。
- **採らなかった案**: `setup.bat` の 4 問目で番号を選ぶ(黒い窓でプロジェクトが多いと選びにくい)。bat で一度選んだものを覚える(利用者が画面で決める形を選んだ)。送らないものを選ぶ形(新しいプロジェクトも自動で送る)。

### まとめて送る印のレビュー(2026-11-10)

マージした変更を網羅的なレビューに通した 11 件への答え。

- **設定ファイルの書き換え**: 読んでから書くまでを `atlas.config.json.lock`(排他で作る。10 秒より古いものは落ちた処理の残りとして消す)の中で行う `modifyConfig` にした。serve の中だけで順にしていたのでは、bat(別のプロセス)が送り先を書くのと重なると印が消えたため。値が配列でも、差し替える・足す・消すだけなら手で書いた他の項目の書き方を残す(括弧と文字列の対応を見て値の範囲を読み、書く前に中身が狙いどおりかを確かめる。外れたら整えて書く)。変わらないときは書かない(`NO_CHANGE`)。
- **画面**: 開いたときに設定ファイルを読めなければ、印を 0 件と見せずに理由を出し、押せないようにする。続けて押したときに先の答えが後から届いても、最後に出した要求の答えでだけ一覧を置き換え、ほかはその印だけを反映する(古い一覧で新しい印を消さない)。
- **bat**: 途中で止まったとき(確かめ直す間に画面で集計し直し始めたなど)も、ここまでに送ったものを出す(以前は「何も送っていません」と出ていた)。確認で `n` を押すと、印は変えずに今回送るものだけを番号で選び直せる。当たらない番号は尋ね直す(集計からやり直しにならないように)。`5 - 8` のように区切りの前後に空白があっても読む。印の無いプロジェクトは、全部の名前ではなく、最近更新した 5 件の名前を出す。
- **効率**: 点検とアップロードで atlas が足して写すものを読む口(session-store.db・desktop.json)を、1 回の実行で 1 つだけ開いてプロジェクトの間で使い回す(`openUploadContext`)。
- **採らなかった案**: 設定ファイルの書き換えを serve の中だけで順にする(別のプロセスと重なる)。印の無いプロジェクトのうち「前回の実行より後に増えたもの」だけを出す(前回の実行を覚える場所が要る)。

### アップロード中にタスクタグを切り替える(2026-11-10)

利用者の問い「タグ切り替え時の挙動(の懸念)は?」。

- **見つけた不具合**: (1) 別のタグへ切り替えている間に写し終えると、写したタグへ戻っても結果が出なかった(失敗なら理由も出ない)。見出しに出していないのに「この画面で出した」と記録し、戻ったときの直近の結果を出さなかったため。(2) 写している途中に「すべて」へ外す(見出しが消える)と、写し終えたときに消えた見出しのタグ名を読んで、ページに例外が出ていた。
- **決めたこと**: 結果を「出した」と記録するのは、写したタグの見出しが出ていて実際に出したときだけにする。見出しが消えた後は、タグを読まない。ほかのタグを見ている間に終わったときは、その見出しに「「A」のアップロードが終わりました」(失敗なら理由)とだけ出す。結果の中身は、写したタグを開くと出す。

### setup.bat でもエクスプローラーで選ぶ(2026-11-10)

利用者の報告「setup.bat でエクスプローラーが開いていない」。アップロード先をエクスプローラーで選ぶ形は、画面と upload-project.bat にだけ入っていて、setup.bat は黒い窓へのドラッグとパスの入力だけで尋ねていた。

- **決めたこと**: setup.bat でもフォルダはエクスプローラー(画面と同じ `folder-picker.ts`)で選べるようにする。アップロード先は、まだ決めていなければ Enter で開く(決めないなら `n`)。決めてあれば Enter で今のまま、`y` で今の場所から開く。vault は、数えない人が多いので Enter は「終わる」のまま、`y` で開く。ドラッグとパスの入力も今までどおり使える。取り消したら尋ね直す。画面を出せなければ理由を出し、以後はドラッグかパスの入力で尋ねる(PowerShell が止められているなど、押し直しても同じ理由で出せないため)。
- **流し込んだ入力では出さない**: エクスプローラーは、黒い窓で答えているとき(標準入力が端末のとき)だけ出す。入力を流し込んでいるとき(CI の clone した状態での確認は、setup.bat に答えを流し込んで動かす)に出すと、閉じる人がいなくて止まるため。そのときは今までどおりの尋ね方になる。

### 画面の「設定…」(2026-11-10)

利用者の依頼「ツールで llm-wiki やアップロードプロジェクトも設定したい。setup.bat を使わなくてもできるように」への答え。

- **決めたこと**: レポートの右上(「集計し直す」「判定する…」の隣)に「設定…」を置き、ダイアログで setup.bat と同じ設定を決める。llm-wiki の vault(エクスプローラーか入力で調べ、ページのフォルダ・索引・wiki の skill を確かめてから足す。外す)、普段の工程名(保存・既定に戻す)、アップロード先(タスクタグの見出しと同じ操作)、まとめて送るプロジェクト(プロジェクト別の表の印と同じ。名前で絞り込める)。どれも押した時点で書く(modifyConfig。設定ファイルのロックの中で読んでから書く)。vault は集計で数えるので、変えたらダイアログに「集計し直す」を出す。setup.bat は残す(黒い窓で決めたい人のため)。
- **API**: `GET api/settings`(今の設定・既定の工程名・wiki の skill の候補・設定ファイルを読めない理由)、`POST api/settings/vault/describe`(入力を調べる。setup.bat の describeVault)、`POST api/settings/vault/pick`(エクスプローラーで選んで調べる)、`POST api/settings/wikis`(足す。同じ名前は 409)、`POST api/settings/wikis/remove`(番号と名前で外す。ほかで書き換えていて合わなければ 409)、`PUT api/settings/phases`(null で既定に戻す)。設定ファイルには setup.bat と同じ形(path だけなら文字列)で書き、外すときは書いてあるとおりの値(`~/` を展開していないもの)から外す(modifyConfig に書いてあるとおりの中身も渡すようにした)。
- **まとめて送るプロジェクトの一覧**: 空のセッションだけのプロジェクトは出さない(upload-project.bat は空のセッションを送らないので、印を付けても何も送られない)。
- **採らなかった案**: 設定を別のページにする(ほかの操作と同じダイアログの形の方が迷わない)。vault の細かい項目(拡張子)を画面で決める(setup.bat も尋ねない。手で書く)。

### 画面をすべて閉じてもサーバが止まり切らない(2026-11-10)

CI の画面テスト `ui/heartbeat.test.ts`(外へ移ると猶予の後に止まる)が、Windows・Node 24 だけで時々落ちていた(直近 30 回のうち 4 回)。

- **原因(実測)**: 最後の bye はサーバに届き、猶予の後に止める処理(`close`)にも入っていた。そこで `server.close()` が、ブラウザが次の要求のために先に開けておき、まだ 1 バイトも送っていない接続を待ち続けていた。Node はこの接続を「要求の途中」とみなして閉じない。すべての接続を切る `closeAllConnections()` は `close()` が終わった後にしか呼んでいなかったので、ブラウザがその接続を閉じるまで止まらなかった(70 秒待っても止まらなかった)。実際の使い方では、atlas の画面をすべて閉じても、ブラウザを開いたままなら `atlas.bat` の黒い窓が残ることがあった。最初に推測した「bye が届かない」は外れ。
- **決めたこと**: 止めるときは、`server.close()` の直後に `closeAllConnections()` を呼び、待たずにすべての接続を切る(止める時点で開いている画面は無い)。

### 画面とサーバの版のずれを知らせる(2026-11-10)

利用者の報告「設定を読めませんでした、無い API です、と出た」。サーバ(黒い窓)は起動したときのコードのまま動き続けるが、「集計し直す」は子プロセスでディスク上の新しいコードを動かして画面を作り直す。そのため、atlas を更新した後に集計し直すと、「設定…」のある新しい画面が `/api/settings` の無い古いサーバにつながっていた。2 つ目の `atlas.bat` も、動いているサーバがあればブラウザを開くだけなので、古いサーバのままになる。利用者の判断「入れる」。

- **決めたこと**: 版の目印(`core/src/code-stamp.ts`。`packages/*/src` と report の `template.html` の中身から作る 16 桁のハッシュ。ビルドしたもの・テスト・説明書は入れない)を、集計がページ(atlas.html と詳細・用語・指示文・気づきのページ)の `<meta name="atlas-code">` に埋め込み、サーバは起動したときの目印をすべての応答の `x-atlas-code` で返す。画面は最初に成功した heartbeat の応答で 2 つを比べ、違えば(目印を返さない、これより前のサーバも)「画面とサーバの版が違います(atlas を更新した後に、サーバを起動し直していません)。atlas.bat の黒い窓を閉じてから、もう一度 atlas.bat を実行してください」の帯を出す。閲覧と編集はそのまま(新しい操作だけが使えない)。サーバが止まったら「サーバが止まっています」の帯に替える。2 つ目の `atlas serve` が動いているサーバを使い回すときも、目印が違えばターミナルに同じことを出す(`atlas.bat` はその後すぐ閉じるので、画面の帯が本来の知らせ方)。
- **採らなかった案**: 版の番号を手で上げる(上げ忘れると知らせない)。2 つ目の `atlas.bat` が古いサーバを止めて起動し直す(古いサーバに止めてもらう口が無く、プロセスを止めると動いている集計や判定の子プロセスが残る)。古いサーバのときに編集を止める(使える操作まで止まる)。

### 止まり方と版の目印のレビュー(2026-11-10)

上の 2 つ(止まり切らない・版のずれ)を入れた後のレビューで見つけた 6 件を直した。

- **止める前に、応えている途中の要求を待つ**: 上で入れた `closeAllConnections()` は、応答の途中の要求も接続ごと切っていた(フォルダを選ぶ画面を出したまま atlas の画面を閉じた、アップロードの途中に猶予が切れた、など。「止める時点で開いている画面は無い」は、応えている途中の要求が無いことまでは意味しない)。サーバが、処理が済んで応答を送り終える(か相手が切る)までの要求を数え、自分から止まるとき(`expire`)はジョブと同じように終わるまで待ち、終わってから猶予を測り直す。相手が先に切っても、処理が続いていれば待つ。中断(Ctrl+C)はこれまでどおりすぐ切る。採らなかった案: `closeIdleConnections()` で使っていない接続だけを切って待つ(Node は何も送っていない接続を「要求の途中」と数えるので、止まり切らない元の不具合に戻る)。
- **目印の材料**: `src` の下の、エディタや OS が置く作業ファイル(`.` で始まるもの、`~` `.bak` `.orig` `.rej` `.swp` `.swo` `.tmp`、`Thumbs.db` `desktop.ini`)は数えず、改行は LF にそろえてから数える(コードは同じなのに帯が出るのを避ける)。逆に、画面の作り方と依存を決めるファイルを足した(各パッケージの `vite.config.ts` `svelte.config.js` `tsconfig.json` `package.json`、リポジトリの直下の `package.json` `package-lock.json` `tsconfig.json`)。`scripts/` は、サーバも画面も読まないので入れない。採らなかった案: 拡張子の一覧にあるものだけを数える(新しい種類のソースを足したときに、黙って目印から漏れる)。
- **目印の置き換えの空振り**: テンプレートに `__ATLAS_CODE__` が無ければ、集計を止めて理由を出す(`embedCodeStamp`。以前は黙って進み、ページは版を比べられなかった)。
- **帯とターミナルの文**: 「atlas を更新した後に、サーバを起動し直していません」は、サーバが古いと決めつけていた。ページのほうが前の版のこともある(通常の `atlas build` が消さずに残す、前回の export の `instructions.html`。開いたままのタブ)。「この画面を作ったときと、サーバを起動したときとで、atlas のコードが違います」に改め、直し方に「新しく開いた画面を使ってください」を足した(ポートは起動のたびに変わるので、前のタブは読み込み直せない)。残した `instructions.html` の目印は書き換えない(前の版で作ったページなのは本当)。集計のログに、作り直し方(`atlas export` か `atlas all`)を足した。
- **見送ったもの(レビューで挙げたが直していない)**: 2 つ目の `atlas.bat` が古いサーバを見つけても知らせるだけで開く、画面テストの「同じ版なら出さない」が 500ms の待ちに頼っている、止まり方の単体テストの「3 秒以内」、Host を断る応答にも目印が付く、版を比べる決まりが `code-check.ts` と `NAV_JS` の 2 か所にある。

## 決めたこと・採らなかった案

- Svelte 5 を採用(理由は開発体験。単一 HTML のサイズ差はデータ量に比べて誤差)。
- 索引・トークンとも「正典を一つに決める」のではなく和集合+出所記録にした(実測で包含関係が無いため)。
- 公式スキーマを CI の正典にしない(1.0.18 のもので実データと乖離)。
- 採らなかった案: Python 標準ライブラリ構成、ローカルサーバ型ダッシュボード、生イベントの HTML 埋め込み、`--add-dir` によるバンドル受け渡し。
- `data.db`(デスクトップアプリ)は「セッションの選択とグループ」まで読まなかった(対象はアプリのセッションだけで、モード・推論強度・文脈の内訳は events.jsonl と session-store.db で代替でき、`accounts.access_token` などの資格情報列を含むため)。「解析用の完全出力」から、ユーザーの判断で許可リストの列だけを immutable の読み取り専用で読む(「解析用の完全出力」)。

### upload-project.bat の黒い窓を短くする(2026-11-11)

利用者の依頼「upload.bat はもっと見やすく簡潔に。一般利用者は目が滑る」。前の表示は、集計の経過(長いパスの行が 18 行ほど)に続いて、1 行に事柄を 2〜3 つ詰めた文と、写している途中の行(1 割ごと)が並び、見るべき「何を・どこへ送るか」と「y で送る」が埋もれていた。

- **決めたこと**: 場面ごとに見出し(`== 送るプロジェクト ==`・`== 送り先 ==`・`== 送る前の確認 ==`・`== 送っています ==`・`== 終わりました ==`)で区切り、1 行に 1 つのことだけを書く。一覧は名前の列をそろえ(全角を 2 と数える。名前の列は 40 桁まで)、件数は「セッション」にそろえる。尋ねる文は 2 行(何を入れるかと `> `)。
- **出さなくしたもの**: 集計の経過(`%TEMP%\atlas-upload-project.log` に書く。失敗の理由はエラー出力なので窓に残る)、確認の「N ファイル」「大きいもの」「何時の集計の時点か」、印のときの印のプロジェクトの一覧(すぐ後の確認に並ぶ)、送り先を覚えたときの設定ファイルのパス、秘密らしい文字列のファイルは 10 件から 5 件に。
- **途中の様子**: 調べている・写している間は 1 行を書き換えて出す(`io.status`)。出力が端末のときだけで、ファイルやパイプに流すときは出さない。窓の幅に収めて切る(折り返すと 1 行では消えないため)。送った結果は 1 プロジェクト 1 行。
- **止まるとき**: 送れなかったものは画面の「送れなかったものがあります」にまとめて出し、`UploadIncompleteError` で止まる(bat の最後に同じことを 2 度書かない)。ほかの理由で止まったときは「止まりました: 理由」。
- **採らなかった案**: 色を付ける(古い端末やリダイレクトで制御文字が残る)。

#### 見直しで直したこと(2026-11-11)

- **集計を upload-project.ts の中で動かす**: bat が `main.ts all` の出力を丸ごとファイルに流していたので、集計の「注意」(DB を今回は複製できず前回の複製を使った、など)が窓に出ず、古いログを送っても気づけなかった。集計が終わるまで窓が 1 行のまま動かず、その間に押した Enter が、別のプログラムである送る操作の最初の答え(やめる)になっていた。今は `refreshAggregate` が `run(parseCli(['all']))` を同じプロセスで動かす。経過は `%TEMP%\atlas-upload-project.log` に書き、段階は 1 行の書き換えで出す。失敗したら理由とログの場所を出し、送る操作には進まない。bat の `goto all_failed` と、引用符の無い `echo %ATLAS_UPLOAD_LOG%` はなくした。main.ts の出力は変えていない(atlas.bat の窓には響かない)。
- **先打ちの入力を捨てる**: 入力が端末のときは、尋ねていない間に届いた行を捨てる。パイプで流し込んだ入力(スモークとテスト)では、今までどおり尋ねる前に届いた行も順に使う。
- **文**: 印のある流れでも、ログが無くて送れないセッションの数を出す。送る途中で確かめ直しになり、そこでやめたときの見出しは「途中でやめました」にして、残りのプロジェクトを出す(前は「終わりました」と出ていた)。置き換えた前のフォルダを消せなかったとき(送り先で開かれていた)は、その場所を出す(`GroupUploadResult.leftovers`)。
- **画面での幅**: 全角の範囲の外にある絵文字(☕ ✅ など)は 2、結合する記号・ZWJ・異体字セレクタは 0 と数え、U+FE0F が付いた文字は 2 とする。`fit` は、ここまでの全体の幅で切る。
- **採らなかった案**: main.ts に「1 行で進み具合を出す」出し方を足す(atlas.bat と CLI の出力が変わる。送る操作だけで要るので、upload-project.ts の中に閉じた)。集計の時点の日時を確認に戻す(同じプロセスで集計したばかりなので、注意の方が役に立つ)。
- **bat の読み違え(見直しの途中で見つけた、前からの不具合)**: スモークを強めたら、`upload-project.bat` と `setup.bat` が、`node` や `pause` から戻った後に、冒頭の説明の行の途中(`'r'`・`'pm'` など)をコマンドとして実行していた。#25 の版でも、入力をパイプで渡しても NUL にしても毎回起きた(実測。cmd の文言が cp932 で出るため、前のスモークは文言で見つけられずに通っていた)。原因は、`chcp 65001` の前後の日本語の `rem` を読んだ分だけ、cmd が bat を読み直す位置がずれること(説明の行を ASCII に置き換えると起きなかった)。説明の `rem` は 3 本とも、最後に実行する行(`exit /b` で終える)の後ろに移した。`launchers.test.ts` でこの並びを確かめる。スモークは、bat のエラー出力に何か出たら止める(cp932 の文言も読む)。
  - 原因について確かめたのは次の範囲だけ: 説明の行を同じバイト数の ASCII に置き換えると起きない。説明を `chcp` の後ろに移しただけでは、パイプで入力を渡したときにときどき起きた(4〜12 回に 1 回)。最後に実行する行より後ろに移すと起きない。読み直す位置がずれる仕組みそのものは確かめていない。検査は「`chcp 65001` より前に日本語を書かない」と「説明の rem は最後に実行する行より後ろ」の 2 つを見る。

#### 2 度目の見直しで直したこと(2026-11-11)

- **bat の終了コード**: `& exit /b` で終えると、cmd の終了コードは前のコマンドに関わらず 0 になる(実測: `cmd /c exit 7 & … & exit /b` は 0)。集計に失敗しても `upload-project.bat` が 0 を返していた。最後の `node` の次の行で `set "code=%errorlevel%"` と取っておき、`exit /b %code%` で返す(同じ行に `%errorlevel%` を書くと、行を読んだ node の前の値になる)。`atlas.bat` も `exit /b %errorlevel%` にした。`launchers.test.ts` で並びを確かめ、スモークは bat の終了コードが 0 かも見る。
- **集計の中で console に直に書かれるもの**: 初回のテンプレートのビルドで Vite が出す警告は、console に直に書かれ、書き換えている 1 行に混ざっていた。`refreshAggregate` の間だけ `console.log/info/warn/error` を log に通す。段階の頭が無い行(「レポートのテンプレートをビルドしています…」)は、その文のまま 1 行に出す。
- **集計中に押した Enter**: 行は捨てていたが、端末が写した改行で進み具合の行が上に残っていた。捨てたときに 1 行上へ戻って消し、書き換えていた 1 行を書き直す。
- **途中でやめたとき**: 「やめました(残りの N プロジェクトは送っていません)」と、まとめの「残りの N プロジェクト(…)は送っていません」が続けて出ていた。やめたときの行は「やめました。」だけにした。
- **画面での幅**: 国旗(地域指示記号 2 つ)と、ZWJ でつないだ絵文字は全体で 2 と数える。

#### 3 度目の見直しで直したこと(2026-11-11)

- **Enter を押していない先打ち**: 端末は、Enter を押すまでの文字を自分で持っていて、こちらには届かない。届いた行を捨てるだけでは、集計を待つ間に打って Enter を押さなかった文字が、次の答えの頭に付いた(実測: 待つ間に `y`・`z` を打ち、質問が出てから Enter だけを押すと、答えが `"yz"` になった)。入力が端末のときは、尋ねていない間は 1 文字ずつ届く状態(raw)にしてその場で捨て、尋ねている間だけ行で受け取る状態に戻す。尋ねる直前に 50 ミリ秒待つ(集計で手が離せなかった間のキーが届き切ってから捨てるため)。raw の間は Ctrl+C も文字として届くので、端末を元に戻して終了コード 130 で終わる(実測。out のロックは、持ち主の処理が生きているかで見るので残っても害は無い)。`setRawMode` が無い端末では、前のやり方(届いた行を捨て、写った行を消す)に落とす。
- **集計の注意**: 「注意」を含む行をすべて窓に出していたので、送るものに関わらない注意(記録で伏せた文字列の数など)や、文の途中に「注意」とある行も出ていた。窓に出すのは、行の頭が `snapshot: 注意` のもの(ログを写す段階の注意 = 送るログが古いかもしれない)だけにした。ほかは経過のファイルにだけ書く。
- **console の警告と直書き**: `console.warn/error` を「注意」として窓に出すのをやめ、経過のファイルに `警告: …` と書いて、ファイルの場所を「集計しました」の前に 1 行で出す。`process.stdout/stderr.write` に直に書かれるもの(node の警告を stderr に書く `core/sqlite.ts` など)と `console.debug` も、集計の間は経過のファイルに通す(書き換えている 1 行に混ざらない)。`consoleIo` は書く口を作ったときに取っておく(差し替えの間も、自分の出力は窓に出る)。
- **経過のファイル**: 最後にまとめて書いていたので、途中で窓を閉じると何も残らなかった。1 行ごとにその場で書く。失敗したときはスタックも書く(窓には理由だけ)。
- **1 行の表示**: 改行やタブを含む文は、空白にして 1 行にする(status と、窓に出す注意・失敗の理由)。
- **まとめの文**: 送れなかったものがあるとき、確かめ直しでやめて送らなかった残りを書いていなかった(送れなかったものだけに見えた)。残りも出す。`n` で選び直してから何も選ばずにやめたときも「やめました。」だけにして、「送っていません」がまとめと 2 度出ないようにした。
- **画面での幅**: 肌の色の修飾(U+1F3FB〜1F3FF)は前の絵文字に重なるので 0(前に絵文字が無ければ 2)。ソフトハイフン(U+00AD)は 1。
- **消せなかった前のフォルダ**: 知らせるのが bat の流れだけだった。画面のアップロードの結果にも、件数と場所(3 件まで)を出す(`GroupUpload.leftovers`)。CLI は前からフォルダごとに 1 行出している。
- **スモークの読み方**: bat の出力を、UTF-8 として化けたら丸ごと cp932 で読んでいたので、cp932 の行(cmd の文言)と UTF-8 の行(中の node の出力)が混ざると、片方が化けた。1 行ずつ、UTF-8 として正しければ UTF-8、そうでなければ cp932 で読む(`scripts/console-text.ts`)。エラー出力に何か出たときの失敗の文も、「cmd が読めずに止まりました」(読み違えの文言があったとき)と「エラー出力に何かを書きました」に分けた。
- **採らなかった案**: 先打ちは README の書き方だけを直す(答えに混ざること自体は残る)。raw のまま自分で行を組み立てる(日本語入力や編集キーを自分で扱うことになる)。警告をすべて窓に出す(初回のビルドのたびに、送ることに関わらない Vite の警告が並ぶ)。

### 判定から opencode を外す・本物の copilot で通す(2026-11-11)

- **外したもの**: 判定と下書きのバックエンド `opencode`(`packages/judge/src/backends/opencode.ts`、`--backend opencode`、`ATLAS_OPENCODE_BIN`、出力の読み取りの opencode の形)、画面の「判定に使うもの」の選ぶ欄(copilot -p の 1 行だけにした)、README と docs の記述。`POST /api/jobs` の `backend` は項目を残し、受ける値を `copilot-cli` だけにした(画面とサーバの版がずれても形は同じ)。
- **残したもの**: 前に opencode で判定した `judgments.json` を読むこと(`schema.ts` の `BACKENDS` と、レポートの表示名)。
- **わかったこと**: 保存した自分のモデルは `--model <プロバイダー名>/<モデル ID>` で指定する(ID だけだと `Model "…" is not available`)。`turns run --limit` は依頼のまとまりごとに確かめるので、上限を少し超える(12 に対して 14)。どちらも docs/judge.md に書いた。
- **未検証**: 画面の「判定する…」から本物の copilot を動かすこと。実データでの判定。
- **採らなかった案**: 文言だけを消して `--backend opencode` を残す(使い方がどこにも書かれていない機能が残る)。`BACKENDS` からも消す(前の判定結果が読めなくなる)。

### アップロード先から集計し直す側の見直し(2026-11-11)

- **出力先の使い回しでセッションが混ざる**(高): 前に別の場所から集計した `--out` に別の `--home` を集計すると、前のセッションのフォルダと DB が残ったまま足され、両方のセッションが 1 つのレポートに出ていた(実測)。`snapshot` は、前の `snapshot-manifest.json` の `sourceRoot` と今の `--home` が違えば、何も書かずに止まる。同じ場所を別の書き方で指しているだけのときは、manifest を消せば続けられる(文に書く)。
- **置き換えの途中・消し残しのフォルダを数える**(中): `.<id>.old`(送り先で開かれていて消せなかった前のもの)と `.<id>.uploading` が、id の違う別のセッションとして入り、トークンが二重に数えられていた(実測)。`snapshot` は写さずに `extras.skipped` に記録し、`extract` は件数を警告に出す。前の版が写したスナップショットに残っていても、`listSessionDirs` が数えない。名前の決め方は core に置き、送る側と同じものを使う。
- **形が違う `atlas-session-store.json` で集計の全体が止まる**(中): `sessions: [null]` などで `extract` が例外で終わり、ほかのセッションも集計できなかった(実測)。行がオブジェクトであること、このセッションの行の列の型、必ずある列を確かめ、違えばそのファイルを使わずに警告を出して続ける。
- **プロジェクト名を読む側のディスクで決め直す**(中): ログのパスは送った PC のもので、読む PC の同じパスの `.git/config` を読んでプロジェクト名を決めていた。作業フォルダが無ければパスのままになり、同じパスに別のリポジトリがあればその名前になった(実測)。送る側が `atlas-session.json` に `projectSource` も書き、読む側は、直下にセッションが並ぶ形(`layout: flat`)のときは `.git/config` を読まず、この記録の `project` と `projectSource` を使う。`projectSource` の無い記録(前の版)は、名前の形から決め方を決める。
- **基底を指すと 0 件のレポートができる**(低): `--home <基底>` は、エラーにならずに 0 件のレポートを作っていた。下に写したフォルダがあれば、その名前と指定の例を出して止まる。
- **リンクを辿る**(低): セッションのフォルダの中のファイルがシンボリックリンクだと、指す先(フォルダの外)を出力先に写していた。辿らずに `extras.skipped` に記録する。
- **ついでに**: `desktop.json` が読めないときに、黙って使わなかったのを、警告に出すようにした。送り先の README の「出力先は好きな場所に」は、このフォルダ用に分けるように書き直した。
- **決めたこと**: 出力先が違うときは、前のスナップショットを消さずに止まる(前の出力先が、消えた PC のログの唯一の複製かもしれない)。記録の無い、手で作った直下の形のフォルダは、git の origin からプロジェクト名を決めなくなる(パスのまま)。
- **採らなかった案**: 出力先が違うときに前のスナップショットを自動で消して作り直す(上の理由)。基底を指したときに下のフォルダをまとめて集計する(タスクタグをまたいで同じセッションがあると二重に数える)。プロジェクト名を `atlas-index.json` から取る(セッションのフォルダだけを写して渡したときに無い)。
- **未検証**: ほかの PC・ネットワークドライブ・実データでの集計し直し。写した `session.db` を書き込み可で開くところは、コードを読んだだけで、変えていない。DB にしか無いセッション(ログのフォルダが無い)は、前から送らない。

### 4 度目の見直しの 10 件(2026-11-11)

- **Ctrl+C の後始末**: 黒い窓が 1 文字ずつ受け取っている間の Ctrl+C は、書き換えていた 1 行を消して「中断しました。」を出し、終了コード 130 で終わる。`process.exit` は `finally` を通らないので、集計の作業中の印(`out/.job.json`)は `'exit'` で外す(自分の印だけ)。写している途中の `.<id>.uploading` は消さない(次のアップロードが片付け、集計は数えない)。
- **同じ場所かの判定**: 文字列の比較だけだったのを、実際の場所(`realpath`。違えば inode)でも比べる。ジャンクション・リンク・大文字と小文字の違いは同じ元として通す。無くなった場所は、書かれたパスのまま比べる。
- **途中で止まった集計の後の混ざり防止**: manifest は最後に書くので、途中で止まると前の元が分からず、別の元を足せた。始めるときに `snapshot-source.json` に元の場所を書き、manifest と両方を見る。続けたいときに消すファイルは、止めるときの文に両方を挙げる。
- **置き換えの途中で止まったセッション**: 本体のフォルダが無く、作業用のフォルダだけがあるセッションは、集計から丸ごと消えていた。写し終えている `.<id>.uploading`(最後に書く `atlas-session.json` まである)を、元の id で写す。`extras.recovered` に記録し、ログと警告に出す。送る側は、前の回が残した `.<id>.old` を、新しいフォルダを置けたら消す。
- **送った側の記録の扱い**: `atlas-session.json` の `project` は前後の空白を落とし、制御文字を含むものは使わない。まとめ用の名前と決め方が合わないものは、名前に合わせる。(id の一致と決め方の値の検査は前からあった。読む側の `projects` の設定より記録を優先するのは、前からの決めたこと)
- **基底かどうかの判定の読みすぎ**: 関係のない大きなフォルダを `--home` に指すと、下の全フォルダの中まで読んでいた。索引(`atlas-index.json`)は全フォルダで 1 回ずつ確かめ、索引の無いフォルダを中まで見るのは名前の順で先頭の 20 個まで。
- **前の版が写した作業用のフォルダ**: 出力先に残っていると、警告なしに数えなくなっていた(前の集計より件数が減る)。数えていないことと場所を警告に出す。
- **桁の数え方**: 肌の色の修飾(U+1F3FB〜1F3FF)が、修飾を受けない文字(漢字など)の後ろで 0 桁になっていた。修飾を受ける絵文字(`Emoji_Modifier_Base`)の後ろでだけ重ねる。
- **集計の警告の知らせ方**: 件数は、書き込みの回数で数えていて合わなかったので出さない(あったことと経過のファイルの場所だけ)。
- **`POST /api/jobs` の backend**: 値が 1 つだけなので省けるようにし(無ければ `copilot-cli`)、画面は送らない。書いてあれば今までどおり確かめる(`copilot-cli` 以外は 400)。
- **決めたこと**: 元の場所の印は出力先のスナップショットの中に置く(`snapshot-source.json`)。中断のときに `.<id>.uploading` を消さない。backend はサーバ側の省ける項目として残す(子プロセスの引数は変えない)。
- **採らなかった案**: manifest を始めに書く(写さなかったものの一覧は終わるまで決まらず、`createdAt` を写した日時としてアップロードの README と索引に書いている)。作業用のフォルダを読む側で消す・名前を戻す(送り先は読む側のものとは限らない)。警告を行で数えて件数を出す(何行にもなる 1 つの警告で合わない)。backend を API から消す(前の画面が送ってくる値で 400 になる)。
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
  - `open` では `--home`・`--judgments`・`--bundle` を受け付けない。絞り込み(`--since` など)は集計に渡す。
  - 索引の無いフォルダ(前の版が写したもの)が 2 段下にあるかは、直下のフォルダごとに先頭の 3 個だけを見る(関係のない大きなフォルダを指したときに、下を全部読まないため)。`~/.copilot` の形のフォルダは、人ごとのフォルダとしては扱わない。
- **採らなかった案**:
  - `atlas.config.json` に開いたフォルダの一覧を書く(`parseConfig` は知らない項目があると読めないので、前の版の atlas が設定を読めなくなる)。
  - いつもの `out/` に混ぜる・1 つのサーバでフォルダを切り替える(出力先のロック・メモの置き場・集計し直しの引数が、出力先 1 つを前提にしている。この PC のセッションと人のセッションが混ざる)。
  - 画面から `window.open` で開く(集計が終わるのを待った後では、ブラウザがポップアップとして止める)。
  - 状態の `pid` が生きていれば動いているとみなす(pid は使い回される)。
  - 集計できないフォルダを 400 で返す(ふつうの答えなのに、ブラウザのコンソールにエラーが出る)。
- **未検証**:
  - 本物の NAS・共有フォルダ(UNC パス)と、このダイアログからのエクスプローラーでの選択(テストは手元のパスと入力だけ)。
  - 件数の多い送り先での集計の時間(読むのは全セッションなので、人数に比例する)。
  - 画面から開こうとしたときに、同じフォルダの出力先へ書くコマンドが動いていると、子プロセスは始めずに終わり、一覧には「集計が途中で止まりました(記録: …open.log)」と出る(理由は `open.log` にある)。
  - `~/.copilot` の形のフォルダを開いたときは、埋め込みのデータに `source` が入らないので、「対象:」の印はサーバの一覧から取る(`file://` で開いた `atlas.html` には出ない)。
  - `open` に渡した絞り込みは、開いた先の画面の「集計し直す」には引き継がない(いつもの画面と同じ)。

### 「チャットに貼って判定する」の添付ファイルを作れなかったときの見せ方(2026-11-11)

「添付ファイルを作る」が失敗しても、画面に何も出ていなかった(実測)。作る処理(`bundle` / `turns bundle` の子プロセス)が 0 以外で終わると、ボタンが元に戻るだけで、理由がどこにも出ない。終わった処理は本文の上の帯に出さない作りで、ダイアログの側も失敗を見ていなかった。

- **失敗と中止をダイアログに出す**: 手順 1 のボタンの下に、「添付ファイルを作れませんでした(終了コード N)」と理由、ログ(折りたたみ)を出す。止めたときは「作成を止めました」。次に作れたら消える。
- **一時的に掴まれているときはやり直す**: 消すときに `maxRetries: 3` / `retryDelay: 100` を付けた。やり直しはフォルダーとその中のファイルの両方で数えられるので、待ちは掛け算で延びる。直下のファイルが掴まれ続けたとき、諦めるまで 3.4 秒(実測)。1.5 秒だけ掴まれたときは、そのまま作れた(実測)。
- **決めたこと**: 失敗は、帯ではなく、始めたダイアログに出す(終わったことは始めた画面が示す、という今の分担のまま)。やり直しの回数は、画面が止まって見える時間を 3 秒ほどに抑える値にした。
- **採らなかった案**: `maxRetries: 5` / `retryDelay: 200`(掴まれ続けると諦めるまで 21.5 秒かかった。実測)。失敗を帯にも出す(同じことを 2 か所に出すことになる)。
- **未検証**: `EPERM` / `ENOTEMPTY` になる掴まれ方(確かめたのは `EBUSY` だけ)。Windows 以外での掴まれ方(Linux は開いたままのファイルも消せるので、同じ失敗にはならないはず。推測)。

### 添付ファイルの作り直しと、失敗の見せ方の見直し(2026-11-12)

- **作り終えてから入れ替える**: 一覧を先に消す作りでは、作り直しに失敗すると、無傷の前の添付ファイルまで使えなくなり、渡した後の返答も取り込めなくなっていた。`<bundle>/.next` に全部を作り終えてから、決まった名前(一覧・`parts`・`sessions` など)だけを 1 つずつ入れ替える(`packages/core/src/fs-retry.ts` の `replaceEntries`)。前のものは入れ替えの間だけ `<bundle>/.prev` に退け、退けられなければ戻してから失敗にする。一覧は最初に退けて最後に入れる。工数(`bundle`)と依頼ごとの採用(`turns bundle`)の両方。
- **残る限界**: 入れ替えの最中(数回の rename の間)にプロセスが強制終了されると、一覧の無い状態になりうる(前のものは `.prev` に残り、次に作るときに片付ける)。
- **理由の取り出し方**: ログの最後の 1 行ではなく、処理が書いた `atlas: 失敗しました: …` の後ろを出す(`packages/report/src/lib/job-log.ts` の `failureReason`。600 文字まで)。その行が無ければ、理由は出さずにログを読んでもらう。`EBUSY` / `EPERM` / `ENOTEMPTY` を「ほかのアプリが開いたまま」と決めつける案内はやめた(`EPERM` は権限でも出る)。
- **出す条件**: この画面で動いているのを見た処理(`JobStore.live`)が失敗したか止められたときだけ出し、ダイアログを閉じたら(`dismissed`)もう出さない。読み込み直す前に終わっていた処理や、何日も前の失敗が出続けることは無くなった。前の添付ファイルが使えるときは「そのまま使えます」と書き、無いときだけ「まだありません」と書く。
- **止めた直後に終わっていた処理**: 止める操作の後でも、終了コード 0 で終わっていれば完了として扱う(結果は書かれている)。
- **やり直し付きの削除**: `removeTree` を、添付ファイルの作成だけでなく、同じ理由で止まりうる `group export` の出力先・レポートの `detail` / `full` / ライブラリ・`tables` の作り直しにも使う。
- **決めたこと**: 入れ替えはフォルダごとではなく、決まった名前ごとに行う(`--bundle` は利用者が指定した既存のフォルダかもしれない)。読み込み直した後は、前の失敗を出さない(動くのを見ていない処理は、いつのものか分からない)。
- **採らなかった案**: `<bundle>` をフォルダごと置き換える(利用者が指定したフォルダのほかのファイルを消してしまう)。失敗の知らせを読み込み直した後も出す(サーバの最後の処理が失敗のままなので、関係のない日に開いても出続ける)。エラーコードごとに案内を書き分ける(原因を取り違える)。
- **未検証**: 前のものを退けられない掴まれ方は、単体テストでは rename を失敗させて確かめた(本物のアプリが開いたままの状態では試していない)。

### 読む側の 5 度目の見直し(2026-11-12)

- **作業用のフォルダの名前から取った id をそのまま使わない**: `....uploading`(id が「..」)や、点・空白で終わる id、それ自体が作業用のフォルダの名前になる id は、写す先が出力先の外や別の名前のフォルダになり、前の複製を消しうる。そういう id からは写さない(`isRecoverableId`)。
- **写したときだけ記録する**: `--since` で写さなかったものまで `extras.recovered` に入り、「作業用のフォルダから読んだ」と警告していた。写し終えてから記録する。
- **`.<id>.old` だけのセッションは写さない**: 消し残し(`.old`)があるセッションを共有から消すと、次の集計で古い中身のまま戻っていた。置き換えの失敗が 2 度重なって `.old` だけが残った場合と、フォルダの形からは見分けられない。数えずに、理由を分けて `extras.skipped` に残し(`UPLOAD_OLD_ONLY_REASON`)、ログと警告に「消したのならこのフォルダも消す・消していなければ送り直す」と出す。件数はフォルダの数ではなくセッションの数。
- **本体のフォルダがあれば復元しない**: 本体の中がリンクだけのときに作業用のフォルダから写すと、後から本体側のリンクの片付けが、写したばかりのファイルを消すことがあった。本体のフォルダがあれば作業用のフォルダからは写さず、まとめて読むときに別のフォルダから写し終えた id は、リンクの片付けで消さない。
- **索引の無いフォルダが 21 個以上並ぶ場所**: 中を確かめるのは先頭の 20 個まで、という上限はそのまま(関係のない大きなフォルダを読み切らないため)。見つからなかったときに黙って 0 件にせず、`snapshot` のログと「別のフォルダを開く…」の理由に、指定のしかたとこの上限を出す(`UPLOAD_PROBE_HINT`)。
- **何も写していない出力先は縛らない**: 場所を間違えて 0 件だった出力先が、その場所の印のせいで正しい場所で使えなかった。写したもの(セッションのフォルダか `session-store.db`)が無ければ、前の印を消して続ける。
- **プロジェクト名の見えない文字**: 制御文字に加えて、書式文字(`\p{Cf}`。文字の向きを変える U+202E、幅の無い空白など)を含む名前も使わない。
- **決めたこと**: `.old` だけのセッションは、戻すより「消したものが戻らない」ほうを取る(戻したいときの手順は警告に出す)。20 個の上限は緩めない。書式文字を含む名前は、絵文字の結合(ZWJ)を含むものも使わない(フォルダ名から決める側に回る)。
- **採らなかった案**: `.old` だけのセッションを今までどおり写す(消したセッションが戻る)。`.old` に目印を書いて見分ける(送る側の版がそろうまで見分けられず、前の版の消し残しには付かない)。索引の無いフォルダを全部確かめる(関係のない大きなフォルダで終わらない)。出力先の印を、0 件のときは書かない(途中で止まった集計と見分けられなくなる)。
- **未検証**: 本物の共有フォルダ(NAS)での動き。`.old` だけが残る場面を、実際のアップロードの失敗から作ってはいない(フォルダを手で置いて確かめた)。

### 人ごとの内訳(2026-11-12)

送り先の全体(`<送り先>\<名前>\<プロジェクト>\<セッション ID>\`)を集計したレポートに、人のフォルダの名前ごとの軸を足した。それまでは、人ごとに見るには人のフォルダを 1 つずつ開くしかなかった。

- **読む側**: `snapshot` が、まとめて集計したときに、セッション id ごとの数えたフォルダ(元からの相対パス)を `snapshot-manifest.json` の `merged.owners` に書く。作業用のフォルダ(`.<id>.uploading`)から写したセッションは、そのフォルダ。元から消えて出力先に複製だけが残ったセッションは、前の manifest の値を引き継ぐ(今の元にあれば、そちらを先に見る)。`extract` は、数えたフォルダが 2 段(`<名前>/<プロジェクト>`)のときだけ、1 段目を `SessionRecord.person` に入れる(`personOfFolder`)。1 段のフォルダ・`~/.copilot` の形・古い manifest では `null`。
- **レポート**: `SessionSummary.person`(既定値の `null` は埋め込みから落とす)。絞り込み `FilterState.person`(URL は `#person=`。`(unknown)` は人のフォルダの下に無いセッション)、選択肢 `filterOptions().person`、集計 `Aggregate.byPerson`。画面は、絞り込みの「人」、「人別」の表(`ProjectTable.svelte` を `kind="person"` で使う)、目次の「人別」、詳細ページの「人: <名前>」の札。どれも、人のフォルダの名前が 1 件でも付いているレポートだけに出す。
- **版**: `SESSIONS_SCHEMA_VERSION` 10 → 11、`REPORT_DATA_VERSION` 9 → 10。
- **決めたこと**:
  - `person` は、`SessionRecord` でも `SessionSummary` でも省ける項目にする(人の軸が無い集計がほとんどで、前の版の `sessions.json` や埋め込みをそのまま読めるようにするため)。
  - 人を決めるのは、数えたフォルダだけ。同じ id が 2 人のフォルダにあるときは、数えたほうの 1 人に入れる(2 人に数えると、人別の合計が全体と合わなくなる)。
  - 人のフォルダを 1 つ選んだときは、人の軸を出さない(全部その人の分なので、1 行の表にしかならない)。
  - 絞り込んだ後に人の付いたセッションが残らなくても(「不明」に絞ったとき)、レポート全体に人の軸があれば、人別の表には行を出す(`aggregate` の第 2 引数)。
  - 人別の表は、プロジェクト別の表の部品を使い回す(列・並べ替え・絞り込みの動きが同じ)。「まとめて送る」の印は出さない。
  - 判定に渡すもの(添付ファイル・パケット)には、人の名前を入れない。
- **採らなかった案**:
  - CLI に `--person` を足す(人ごとに出したいときは、人のフォルダを `--home` に指定すれば足りる)。
  - `tables` の CSV / xlsx に人の列を足す(列の並びを変えると、前の版の表を読む側が崩れる)。
  - プロジェクト名から人を決める(送った側の記録の名前には、人のフォルダの名前は入っていない)。
  - 人別の表を別の部品として写して作る(同じ表が 2 つになる)。
- **未検証**: 本物の送り先(NAS)での人数の多い集計。人のフォルダの名前に、フォルダ名として使えるがレポートで読みにくい文字(とても長い名前など)があるときの見え方。

### デザインの記録 DESIGN.md(2026-11-12)

レポートの見た目の決まりを、リポジトリ直下の `DESIGN.md` に書き出した(impeccable の `document`。今のコードから読み取る方式)。それまでは `PRODUCT.md` だけがあり、色・字・罫の決まりは `packages/report/src/styles/base.css` のコメントにしか無かった。

- **元にしたもの**: `base.css` の変数(ライト / ダーク)と部品の指定、各 `.svelte` の `<style>`。新しい見た目は決めていない(今あるものの記録)。
- **中身**: 先頭の YAML(色 19 種のライト / ダーク、字の役割 8 種、角の丸み、余白、部品 13 種)と、決まった見出しの本文(Overview / Colors / Typography / Layout / Elevation & Depth / Shapes / Components / Do's and Don'ts)。YAML に入らない分(色の呼び名と濃淡、影に当たるもの、動き、切り替え幅、部品の見本)は `.impeccable/design.json` に置く。
- **決めたこと**(コードには無く、書き出すときに付けた名前。変えてよい):
  - 全体の方向の名前を「記入済みの様式」にした(CSS のコメントが今の見た目を「様式」と呼び、基調の緑の変数名が `--form` のため)。
  - 色の呼び名(様式の緑・注意の茶・墨・薄墨・淡墨・罫・濃い罫 など)。
  - 名前を付けた決まり 5 つ(緑は様式の色・色だけにしない・値が主役・文節で折る・平らな紙)。どれも、今のコードがそうなっていることを言い直したもの。
- **採らなかった案**: 聞き取りをして方向を決め直す(今ある見た目を変える話になる。頼まれたのは記録のずれを直すこと)。`packages/*` ごとに `PRODUCT.md` を置く(画面を持つのは report だけで、直下の 1 つで足りる。impeccable の点検は、4 つのワークスペースが直下の記録を引き継いでいることを知らせるだけで、不具合としては挙げない)。
- **戻し方**: `DESIGN.md` と `.impeccable/design.json` を消す(コードからは読んでいない)。

### 未検証だった項目を確かめた結果(2026-11-12)

- Git Bash から `--home '\\localhost\…'` を渡すと、シェルが先頭の `\\` を 1 つに縮めて、別の場所(`<今のドライブ>:\localhost\…`)を探しに行く。PowerShell・cmd(`atlas.bat`)・画面からは起きない。
- **まだ試していないもの**: 本物の共有フォルダ(NAS)と、エクスプローラーのフォルダを選ぶ画面(人の操作が要る)。人数やセッションの多い送り先での集計の時間。本物のログを LLM に渡す判定(渡してよいかを決めるのは使う人)。

### 添付ファイルを作れない「パケットが上限に収まりません」(2026-11-12)

人の多い送り先を開いた画面で「添付ファイルを作る」が失敗し、ログに「セッション <id> のパケットが上限 24000 字に収まりません」と出た(利用者の報告)。

- **原因**: パケットの依頼文は、本文の字数だけを予算(12,000 字)に数えていた。1 件ごとの見出し(`### 依頼 N(日時)`)と囲みは数えず、予算を使い切った後の依頼にも 1 件ずつ「上限のため省略」の見出しを付けていた。短い依頼が数百件あるセッションでは、本文の上限を下げても見出しの分が縮まず、8 回下げても 24,000 字に収まらずに止まる。経過の要約(compaction・タスク完了)も同じ形で、wiki skill の呼び出しは件数の上限なしに並べていた。1 件でも収まらないと、添付ファイル全体を作れない。
- **直し**: 見出しと囲みも予算に数える。予算を使い切った後の依頼は「`### 依頼 N〜M`(K 件、計 X 字)」の 1 行に、古い要約は「それより前の要約 K 件」の 1 行にまとめる。wiki skill は名前ごとの回数にして、上位 20 種まで(ほかは件数)にする。どのセッションでも、パケットの大きさは本文の上限と列挙の上限で決まる(件数に比例して増えるところが無い)。
- **採らなかった案**: 収まらないセッションを飛ばして作り続ける(判定されないセッションが黙って残る)。上限の 24,000 字を上げる(`copilot -p` のコマンドラインの上限 32,767 字から、判定の指示の分を引いた値なので上げられない)。

### 初めからフォルダを選んで開く bat(open-folder.bat、2026-11-12)

いつもの画面(この PC の集計)を開かずに、アップロード先のフォルダだけを見たいという要望。

- **`atlas open --pick`**: フォルダを選ぶ画面(画面の「エクスプローラーで選ぶ…」と同じ `folder-picker.ts`)を出し、選んだフォルダを `open` と同じ手順で集計して開く。選ぶ画面は、前に開いたフォルダ(`folder.json` のうちいちばん新しく開いたもの)の場所で出す。取り消したら何も書かずに終了コード 0。集計できないフォルダを選んだら、`open` と同じ理由を出して止まる(選び直しの繰り返しはしない。bat をもう一度実行すればよい)。
- **`open-folder.bat`**: 引数が無ければ `open --pick`、あれば(フォルダを bat に重ねて離したとき)`open %*`。失敗したら理由を残して `pause` する(`atlas.bat` と同じ)。出力先とメモは画面から開いたときと同じ `out-folders\<キー>\` と `atlas-notes\folders\<キー>\`。
- **採らなかった案**: `atlas.bat --pick` のように既存の bat に引数で足す(ダブルクリックでは引数を渡せない)。いつもの画面を開いてから「別のフォルダを開く…」を自動で出す(この PC の集計を毎回待つことになる)。

### 判定に使うモデルの設定 judgeModel(2026-11-12)

画面の「このツールが判定する」は、モデルを指定せずに Copilot CLI を呼んでいた。そのため、いつも Copilot の既定のモデルで判定し、AI クレジットを使っていた。自分の API キーのモデル(BYOK)で判定したい利用者は、画面からは選べなかった。また、Copilot CLI の既定のモデル(`~/.copilot/settings.json` の `model`)が使えなくなっていると、`Model "…" is not available` で全件が失敗していた。

- **`atlas.config.json` の `judgeModel`**: `judge run`・`turns run`・`skill-draft` の copilot-cli で、`--model` が無いときに使う。決まる順は `--model` > `judgeModel` > Copilot の既定。どれを使ったかと、AI クレジットを使うかを、判定のログの最初に出す。
- **画面**: 確認ダイアログに、使うモデルと、費用の出どころ(BYOK なら「API の利用料」、それ以外は「AI クレジット」)を出す。`/api/jobs/judge-preview` が `model`・`byok`・`modelError` を返す。BYOK かどうかは、名前が `<プロバイダー名>/<モデル ID>` の形かで決める(Copilot が用意するモデルの名前には `/` が無い)。
- **設定ファイルを子プロセスにも渡す**: `--config` で起動したサーバは、画面から動かす処理(集計し直す・判定)に `ATLAS_CONFIG` で同じ設定ファイルを渡す。前は子プロセスがリポジトリ直下の設定を読んでいたので、wiki や工程名もサーバとずれることがあった。
- **採らなかった案**: 既定を BYOK のモデルにする(`providers.json` に Anthropic を入れていない利用者は、全件が失敗する)。画面で選ぶ欄を足す(設定は利用者ごとに 1 つ決めれば足り、選び間違えると費用の出どころが変わる)。

### 別のフォルダを開いた画面は読むだけ(2026-11-12)

管理する人が、送り先(NAS など)に集まったセッションを見る画面で、タスクタグやメモを付けてしまわないようにする。送った人はそれぞれの PC でタスクタグを付けて送るので、その画面では送った人のタスクタグを読むだけで出す。

- **送った人のタスクタグ**: アップロードは、各セッションのフォルダの `atlas-session.json` に、送った時点のタスクタグ(`tags`)を書いている。集計し直すとき(送り先から集計したとき)に `readSenderMeta` でプロジェクト名と一緒に 1 度だけ読み、`SessionRecord.uploadTags` に持つ(`sessions.json` の版 12)。名前は `readSenderProject` と同じ扱い(前後の空白を落とし、制御文字・見えない書式の文字・100 字を超えるもの・文字列以外は使わない。使えるものを数えて 50 個まで)。
- **人ごとに分ける**: レポートのタスクタグは `memberGroups` で作る。名前は「<人> / <タグ>」(人のフォルダが無ければタグだけ)。同じ名前のタグでも、別の人のものは別のタスクタグにする(人によって同じ名前を別の意味で使うことがあるため)。分けるのは人とタグの組で、名前をつないだ文字列ではない(人の名前やタグに「 / 」が入っていて名前が重なったら、後のものに「 (2)」などを付ける。名前はグループの鍵なので重ねない)。並びは `Intl.Collator('ja')`(実行する PC のロケールによらない)。
- **送った人のメモ**: アップロードは `atlas-memo.md` と画像の `atlas-memo/` も入れている。前は集計し直すときに写さなかったが、写すようにし、レポートを作るときに写したセッションのフォルダから読む(`loadMemberMemos`。画像は `atlas-memo/` の直下だけ)。共有フォルダに置かれたものなので、本文は 1 MB まで(この PC でメモを保存できる大きさと同じ)、画像のフォルダは 1 セッションで合計 100 MB までにし、超えるものは写さず理由を snapshot の「写さなかったもの」に残す。送り先から集計した出力先から CLI でアップロードしても、写してある送った人のメモ・画像・`atlas-session.json` は送らない(`sessionFiles`。メモはこの PC の置き場のものだけ)。
- **送り先から集計したレポート**(`--home` や `atlas open`)は、この PC の置き場(`groups.json`・`memos/`)のタスクタグとメモを混ぜず、送った人のものだけを出す。
- **読むだけの判定**: build とサーバで同じ `isReadOnlyView` を使う。送り先から集計した(`sessions.json` の `source.layout` が `flat` / `merged`。`--home` のあと `atlas serve` で開いても)か、別のフォルダを開いた出力先(`<out>-folders/<キー>/out/` で隣に `folder.json` がある。copilot の形のフォルダを開いたときも)なら読むだけ。`atlas open` が立てたサーバ(`reports.current` があるもの)は、まだ集計していなくても読むだけ。サーバは `sessions.json` を mtime が変わるまで覚え(送った人のタスクタグも)、読めないとき(集計の途中)は前に読んだものを使う。読むだけで作ったレポートには `readOnly` を埋め込み、ファイルで開いたときも案内の文言を読むだけの画面のものにする。サーバは、タスクタグ(作る・変える・消す・書き出す・アップロード)・メモ・アップロード先・まとめて送る印の書き換えを 403 で断る。`/api/state` は `readOnly: true` と送った人のタスクタグを返し、メモの編集のスクリプトは何もしないものを返す。画面は「読むだけ」の札を出し、タスクタグの編集・アップロード・まとめて送る印を出さない。
- **使えるままにしたもの**: 集計し直す・判定(手元の `out-folders/<キー>/out/` に書くだけで、送り先は書き換えない。管理する人の分析そのもの)、全文を作って読む、設定、別のフォルダを開く。
- **採らなかった案**: 同じ名前のタグを人をまたいでまとめる(人によって意味が違うことがある。必要なら名前で絞り込める)。開いた画面でも管理する人のタグを付けられるようにする(誰のタグか分からなくなる)。
- **懸念として残るもの**: タスクタグとメモは送った時点のもので、送った人が後で付け替えても、送り直すまで変わらない。古い版で送ったセッションには `tags` が無い。前の版で開いた画面に書いたメモとタスクタグ(`atlas-notes/folders/<キー>/`)は、ファイルには残るが画面には出さない(copilot の形のフォルダを開いたときも同じ)。

### M365 Copilot のアプリを UI Automation で操作して判定する(2026-11-12)

チャットに貼って判定する流れ(添付ファイルを作る → 添付して送る → 返答を貼る → 反映する)の、添付と送信と返答の貼り戻しを、開いている M365 Copilot のアプリを操作して代わりに行う。M365 Copilot には、この PC から手軽に使える API が無い(Microsoft 365 Copilot Chat API は Graph の beta で、組織の Microsoft Entra ID のアカウントとアプリの登録・広い権限が要る)ので、画面を操作する。

- **操作の仕方**: `packages/cli/src/m365-uia.ps1`(Windows PowerShell 5.1、System.Windows.Automation)が 1 ファイルごとに、新しいチャット → モデルの選択(既定 Think Deeper。既に選ばれていればそのまま)→「ソースの追加と管理」→「画像とファイルのアップロード」→ ファイルを選ぶ画面(アプリの窓の下にあり、中の部品は UIA の pattern を出さない)の「ファイル名」(AutomationId 1148 の Edit)に WM_SETTEXT でパスを入れ、画面に WM_COMMAND の IDOK を送る(止まったときは IDCANCEL で閉じる)→ 入力欄(`m365-chat-editor-target-element`)に依頼文を ValuePattern で入れる → 送信 → 返答(`fai-CopilotMessage`)にコピーのボタンが出て停止のボタンが消え、文字が 2 回続けて同じになるまで待つ → 返答の文字(文書の TextPattern)を書き出す。読んだ文字のコードブロックは「行番号(と字下げ)」の行と本文の行が交互に並び、囲みもボタンの名前も混じるので、`cleanCopilotReply` が 1 から続く行番号の並びを見つけて ```json のブロックに組み立て直す(本文に数字だけの行があっても、続き番号でなければ崩さない)。
- **探し方**: 入力欄がある窓を、M365 Copilot のアプリ(`copilotapp`)、Edge の順に探す。要素は AutomationId と、名前(日本語・英語)で探す。見つからなければ、何を探していたかを出して止まり、残りのファイルは送らない(画面の状態が分からないため)。
- **取り込み**: `packages/cli/src/m365.ts` が未判定のファイル(`chat-parts.ts` の一覧。画面の一覧と同じ)を順に送り、返答を `importJudgmentsText` / `importTurnJudgmentsText` で取り込む(画面の「取り込む」と同じ検証)。形が合わない返答は `<bundle>/replies/` に残して次へ進む。1 件でも取り込めたら `export` で反映する。
- **入口**: `atlas judge m365` / `atlas turns m365`(`--model` `--limit` `--timeout`)と、画面のジョブ `m365` / `turn-m365`(「チャットに貼って判定する」の手順 2。サーバが Windows のときだけ出す)。
- **採らなかった案**: クリップボードとキー入力で貼る(フォーカスを奪い、ほかの窓に打ち込むおそれがある)。Chat API(beta で本番は対象外、権限が広い)。
- **懸念として残るもの**: M365 Copilot の画面の作りが変わると動かなくなる(そのときは手で行う)。Edge の画面は確かめていない。添付は OneDrive に入る(手で添付したときと同じ)。Think Deeper の待ち時間は内容次第で、既定の 900 秒で足りないことがある。
- **並行作業との両立(2026-11-14)**: 利用者がほかのアプリで作業している間に `turns m365` を流すと止まった。前面の窓を 100 ms ごとに記録して調べると、「新しいチャット」などを UIA で押すと少し遅れて M365 Copilot が前面に出て、利用者の打った文字が入力欄に入っていた。入力欄に文字が残っていると UIA の `SetValue` は効かず(M365 Copilot が前面でも同じ)、裏の窓へ `PostMessage` したキーも無視された。直したこと: (1) M365 Copilot が前面に出たら直前の利用者の窓へ戻す見張りのスレッド(`AttachThreadInput` には入力のキューが要るので、スレッドの初めに `PeekMessage` する)、(2) 依頼文は M365 Copilot を一瞬前面に出し、Ctrl+A・Backspace・`KEYEVENTF_UNICODE` の文字を 1 回の `SendInput` で送り(クリップボードは使わない)、値を確かめて違えば打ち直す、(3) 依頼文を添付より先に打つ(空の入力欄での Backspace で添付を消さないため)、(4) 添付の名前は Text でなく Button / Group で出ることがあるので両方探す、(5) 依頼文が先に入っているとアップロード中でも送信ボタンが押せて空振りするので、入力欄が空くまで 3 秒おきに押し直す、(6) 崩れたファイルは新しいチャットで 2 回までやり直す(画面が無いときは終了コード 3 で、やり直さない)。M365 Copilot の 1 日の利用上限に達すると(返答が「1 日の上限に達しました」になり、入力欄が消える)、上限の知らせを見分けて終了コード 3 で止まるようにした(待ち時間を使い切らず、やり直さない)。ほかに、画面から読んだコードにノーブレークスペースだけの行が混じって JSON が読めない返答があり、`clean_copilot_reply`(`crates/atlas-cli/src/m365.rs`)で普通の空白にした。

### AI の変更の残存(VCS の照合)と「比べる」(2026-11-13)

AI がセッションの中で足した行が、その後の VCS(Git / SVN / Perforce)のファイルに残っているかを数える。あわせて、2 つの条件を並べる「比べる」の節を足した。

- **部品**: 取り出し(`core/src/ai-changes.ts`。編集の完了イベントの diff、無ければ引数)、VCS の読む口(`core/src/vcs.ts`。読む系の副コマンドだけを許可リストで通す)、分類と集計(`core/src/vcs-retention.ts`)、照合の段(`core/src/vcs-step.ts`、`atlas vcs`)。
- **分類**: まとまり(1 回の編集で続けて足した行)ごとに、そのまま残る / 直されて残る / 見つからない / 照合不可。割合の分母は照合できたまとまりで、照合不可は理由別の件数を並べる。
- **基準と比べる版**: Git はログに残った開始時のコミット、無いときと SVN・Perforce は開始時刻から推定する。比べる版は照合した時点の作業ツリー(設定で最後に取り込んだ版も選べる)。ログに終了時の版が残らないため。
- **重なり**: 時間の重なる別のセッションと同じ行は照合不可、後のセッションも足した行は後のセッションの分にする。
- **出力**: `out/vcs-retention.json`、`sessions.csv` の列、`vcs-hunks.csv`、同じ中身の `atlas.sqlite`、レポートの節と詳細ページの節。アップロードには送る側の結果を `atlas-vcs.json` として添える。
- **設定**: `vcs.pathMap`(移したリポジトリのパスの読み替え)、`vcs.mode`、`vcs.labels`(状態の名前の差し替え)、`vcs.note`(節の説明に足す一文)。環境ごとの決まりや言葉づかいは未追跡の設定ファイルに置く。
- **人別の表**: 送り先をまとめて集計したレポートでは、人別の表を最初から出す。
- **工程ごと**: 照合の結果のまとまりに、作った編集の時刻(at)を持たせ、レポートを作るときに依頼の開始時刻から工程を決めて、工程ごとのまとまりの数を埋め込む。「比べる」で工程を選ぶと依頼の単位で並べ、残存の節に工程ごとの表を出す。
- **確かめていないこと**: Perforce と SVN の実物(偽の CLI でだけ確かめた)。
- **割合を出す条件(2026-11-16 に直した)**: 「AI の変更の残存」の節の割合(4 つの欄・帯と凡例・工程ごと・プロジェクトごと)は、照合できたまとまりが 1 つでもあれば出していた。照合できたセッションが `RETENTION_MIN_SESSIONS`(5。「比べる」と同じ値)に届かなければ、割合と帯を出さずに件数だけ出す形にした(1 つのセッションのまとまりだけで割合が大きく動くため)。工程ごと・プロジェクトごとの表は行ごとに決め、工程ごとの表にはその工程に照合できたまとまりのあるセッションの数を並べる(`retentionByPhase` の `sessions`。Rust の `retention_by_phase` にも同じ数を足し、`npm run parity:fixture` で突き合わせる)。「比べる」の工程どうしの残存の割合も、まとまりが 5 つ以上かではなく、このセッションの数で決める(まとまりは同じセッションの中で似るので、1 件のセッションの 6 つのまとまりから割合を出していた)。採らなかった案: 帯だけは残す(帯は割合を目で読ませる表示なので、数字を伏せても同じことになる)。
- **割合を出す条件の見直し(2026-11-16、レビューの後)**: 残存の割合を出す件数を 1 つの定数(`lib/retention.ts` の `RETENTION_MIN_SESSIONS`)にまとめた。「比べる」の残存の行と「モデルと推論強度の効果」の残っている割合も同じ関数(`enoughMeasured`・`shareOf`)で決める。「モデルと推論強度の効果」は 3 件で出していたので、同じセッションでも節によって出る・出ないが分かれていた(その節のほかの列と読み取りの 3 件は変えていない)。残存の節の最初の欄の「照合できた割合」も、AI の変更があったセッションが足りないときは出さない。Rust の `retention.rs` に置いた閾値と `share_of` は、どこからも呼ばれず突き合わせもされないので消した(割合と閾値は画面だけが持つ。用語集の文は TS が定数から作り、Rust の同じ文と `npm run parity:fixture` で突き合わせるので、定数を変えると parity が落ちて気づける)。

### 推論強度どうしを比べる(2026-11-15)

何人かで推論強度(medium と xhigh など)を週替わりで入れ替えて 1〜2 か月使い、強い強度を勧める根拠を数字で出せるようにする。今の道具では、(1) セッションの推論強度の記録が本体とサブエージェントのリクエストを合算していて、割り当てどおりに使われたかを確かめられない、(2)「比べる」に推論強度の単位が無く、差に幅が無い、(3) AI の変更の残存で、比べる版が開始時の基準と同じ(その間にコミットが無い)セッションをすべて「見つからない」に数えていた。

- **本体の推論強度**: `build_exec` で、本体のリクエスト(`agentId` が無いか空)だけのモデル → 推論強度 → リクエスト数・トークン・nano AIU を `exec.mainModelEfforts` に持つ(`sessions.json` の版 17、埋め込みの版 14)。明細が無く終了時の累計だけのセッションは、本体とサブエージェントを分けられないので持たない。セッションの本体の (モデル, 強度) は、本体のリクエストの 90%(`MAIN_EFFORT_SHARE`)以上が同じ組ならその組、届かなければ「混在」、記録が無いか強度が不明なら「記録なし」(`lib/main-effort.ts` と `crates/atlas-core/src/main_effort.rs`。`npm run parity:fixture` で突き合わせる)。`sessions.csv`(と `atlas.sqlite`)に利用者・本体のモデル・本体の推論強度の列を足した。90% は、切り替えの直後の 1〜2 リクエストや、短い問い合わせを混ぜても決まり、半々のような使い方は外す線として決めた。
- **推論強度どうしの比較**: 「比べる」の単位に推論強度を足した。モデル・A と B の強度(既定は medium と xhigh)・期間(両方に同じ期間)を選び、本体がその組と決まったセッションを並べる。混在と記録なしの件数を表の下に出し、利用者が記録されていれば利用者 × 週(月曜始まり、ローカルの日付)ごとの件数の表を出す(割り当てどおりかを見る)。
- **手戻りのないセッション**(主な指標): 分母は依頼の記録(`turnRows`)が 2 件以上のセッション(採点できたセッション)。2 件目以降の依頼の種類が直し(fix)か差し戻し(revert)、または、どれかの依頼に中断があれば手戻りあり。依頼の数で割合が動くので、2〜4 件と 5 件以上にも分けて出す。前からある「同じファイルを編集し直したセッションの割合」(名前を変えた)とは別の数え方。AI 使用量は、ばらつきの大きい AIU / セッションのほかに、AIU / リクエストとリクエスト / セッションに分けた。
- **差の幅(95%)**: 割合の行(分母がセッション)は 2 つの割合の差の Newcombe の方法(それぞれの Wilson の区間から作る。少ない件数でも 0〜1 の外にはみ出しにくい)、平均の行はセッションを単位にした Welch の方法(差 ± t × 標準誤差。下の「レビューの後の直し」)。比・件数・中央値の行と、ツール呼び出しやまとまりの単位の割合(同じセッションの中で似るので、独立とみなすと幅が狭すぎる)には出さない。片側が 5 件未満なら「—」。0 をまたぐことは文字で書く。
- **コミットの無いセッション**: 比べる版が `fixed` か `committed` で、その版が開始時の基準と同じなら、まとまりを照合不可(理由 `no_commits`「開始時から取り込まれた変更が無い」)にする。Git の版の印は 7 字以上の前方一致で同じとみなす。送る側の結果(`atlas-vcs.json`)は、理由を名前で読むので、新しい理由のある結果も古い結果も読める(古い atlas が新しい理由を読むと「VCS かファイルを読めなかった」になる)。
- **採らなかった案**: 依頼ごとに強度を振り分けて比べる(依頼の結果の記録は依頼ごとにあっても、残存や判定はセッションの単位で、混ぜると分母が揃わない。切り替えたら新しいセッションで始める運用にした)。VCS の残存と LLM の判定を 1 つの点数に混ぜる(重みの決め方に根拠が無く、どちらが効いたか読めなくなる)。BYOK の換算(BYOK のリクエストをどう区別して数えるかを決めておらず、今回の比較の範囲の外にした)。
- **残る限界**: 差の幅は同じ人のセッションの似かた(まとまり)を入れていないので、実際の幅はこれより広い。依頼が 1 件だけのセッションは採点できない。当該のファイルだけを取り込まなかった(ほかのファイルのコミットはある)セッションは「見つからない」のまま。再開したセッション(前の日のセッションを開き直したもの)で強度がどう記録されるかは、まだ確かめていない。
- **レビューの後の直し(2026-11-15)**: (1) SVN の `committed` では `no_commits` を判定しない(作業コピーのルートの版は、ファイルを取り込んだだけでは進まないので、取り込み済みの行まで照合不可になっていた)。(2) 平均の差の幅は、1.96 の固定をやめ、Welch–Satterthwaite の自由度での t の値を掛ける(5 件ずつだと 1.96 では 2〜4 割狭い)。(3) AIU / リクエストは、AIU とリクエストの両方の記録があるセッションが 5 件未満なら「—」。(4) A と B に同じ強度を選ぶと、両側に同じセッションを出す(B だけ 0 件になっていた)。(5) 埋め込みの `exec.mainModelEfforts` はリクエスト数だけにした(埋め込みの版 15。`sessions.json` の形は変えていない)。(6) 手戻りのないセッションの割合を依頼の数で分けた 2 行は、推論強度を比べるときだけ出す。

### バンドルの ZIP と、返答のファイルからの取り込み(2026-11-15)

- **きっかけ**: 判定を Copilot CLI に頼らず、束を LLM に渡して結果を取り込む形にできないか、という相談。束の書き出し・チャットに貼る取り込み・M365 Copilot の自動操作は既にあったので、足りなかった 3 つを足した。
- **`bundle --zip`**: `INSTRUCTIONS.md`・`manifest.json`・`schema.json`・`sessions/` を `<out>/bundle.zip` にまとめる(`crates/atlas-judge/src/zip.rs`)。無圧縮で、CRC-32 は自前。ZIP64 は書かず、65,535 個か 4 GB を超えたら止める。作りかけは別名に書いてから入れ替える。
- **画面**: 「返答を取り込む」に、保存したファイルを選ぶ入力を足した。中身を欄に入れるだけで、取り込むのは「取り込む」を押したとき(サーバは変えていない)。
- **文書**: フォルダを読めるエージェントやローカルの LLM に渡す手順と、パケットの本文が指示の注入口になる注意を judge.md に書いた。
- **採らなかった案**: Copilot CLI の判定をやめる(BYOK での無人の判定と `skill-draft` がこの上にあり、ツールを絞って起動する守りも失う)。圧縮する(deflate の依存が要る)。ZIP で結果を返してもらう(展開の依存が要り、LLM に ZIP を作らせるのも安定しない)。画面の「添付ファイルを作る」で ZIP も作る(チャットに貼る流れでは使わず、作る時間と容量が倍になる。後に、選んだときだけ押す別の操作として画面に足した。次の節)。依頼ごとの判定の ZIP(`turn-bundle` は 1 ファイルで完結する `parts/` だけなので、まとめる意味が薄い)。ローカルの LLM を HTTP で直接呼ぶバックエンド(HTTP の依存が要る)。
- **確かめていないこと**: ローカルの LLM での実際の判定。M365 Copilot が ZIP の添付を受け付けるか。

### 画面から ZIP を作って渡す(2026-11-16)

- **きっかけ**: ZIP を作れるのがコマンドだけで、画面からは「ほかの LLM に渡す方法が無い」ように見える、という指摘。調べると 3 つあった。(1) ZIP を作る操作も案内も画面に無い。(2) 画面の文言が「M365 Copilot など」で、添付ファイルをほかの LLM にも渡せると読めない。(3) 返答のファイルの上限が、画面(5 MB)とサーバ(本文 4 MiB)で食い違っていた。
- **決めたこと**: 判定ダイアログの「判定の方法」に、3 つ目の「ZIP にまとめてエージェントに渡す」を足す(工数の判定だけ)。手順は 4 つ。1 は束と ZIP を同じ回に作るジョブ `bundle-zip`(`bundle --unjudged --zip`)。2 は ZIP の保存のリンクと依頼文(保存先で展開して、できた `bundle` フォルダだけを読ませる)。3 と 4 はチャットの流れと同じ部品で、結果のファイルを選ぶ欄を先に置く。渡してよい相手か確かめることと、ツールを使えるエージェントにシェルの実行と Web へのアクセスを許可しないこと、書き込みを許可するのは結果のファイルだけにすること、出力先を開かせないことは、手順の上の注意の枠に出す。
- **依頼文**: 「bundle フォルダの INSTRUCTIONS.md に従って判定し、結果を bundle フォルダの中の judgments.json に書いてください。」にした(下の「実際に通して確かめたこと」で、返答で返させる形から変えた)。展開は頼まず、書く先は展開したフォルダの中の 1 つのファイルに限る。ファイルを書けない相手への頼み方(「JSON を返してください」)は補足に出す。
- **上の節の「採らなかった案」との関係**: 「添付ファイルを作るたびに ZIP も作る」は今も採らない。足したのは、選んだときだけ押す別の操作。依頼ごとの判定の ZIP も引き続き作らない(ダイアログでは選べないようにして、添付ファイルをそのまま渡せることを理由として出す)。
- **古い ZIP**: `--zip` なしで束を作り直すと(画面の「添付ファイルを作る」と「このツールが判定する」も同じ)、前の `bundle.zip` を消す。消すのは出力先の既定の場所だけで、`--bundle` で指した先の隣の `<dir>.zip` は消さずに知らせる(利用者が別に置いたファイルかもしれない)。画面に返す ZIP は、束の一覧(`manifest.json`)より後に書いたものだけにする(消せなかったときと、消さなかった古い版が残した ZIP を、今の束のものとして渡させない)。
- **そのほか**: 取り込みの本文の上限を 12 MiB にした(5 MB のファイルを JSON の文字列にしても収まる大きさ)。`INSTRUCTIONS.md` に、`parts/` は ZIP に入っていないと書いた。「チャットに貼って判定する」の説明を、相手を選ばないと読める文にした。取り込みの応答にも `canAutomate` を入れた(返答を 1 つ取り込むと、M365 Copilot の自動の判定の欄が消えていた)。
- **採らなかった案**: 画面にコマンドと場所の案内だけを出す(コマンドを打つ手間が残る)。既にある `bundle.zip` へのリンクだけを出す(前の束の ZIP を渡させる)。束を作り直さずに ZIP だけを作る(束と ZIP の作った回がずれる)。出力先の中の ZIP の場所(フルパス)を出して写させる操作と、エクスプローラーで開く操作(エージェントを出力先で開かせることになる。そこには判定の保存先 `judgments.json` とほかのセッションの記録があり、「`judgments.json` に書いて」と頼むと、それまでの判定が今回の分だけで上書きされる。出力先の中で展開すると束の一覧の日時も変わる)。ZIP の流れを「チャットに貼って判定する」の中の折りたたみにする(見つけにくい。指摘のもとが「方法が無いように見える」だった)。
- **実際に通して確かめたこと(2026-11-16、マージの後)**: 架空のログ(`.fixtures/copilot-home`)の 11 件で、ZIP を作る → 展開する → GitHub Copilot CLI(1.0.112。自分の API キーのモデル)に判定させる → 取り込む、を通した。
  - **返答で返させる形は、取り込めなかった。** Copilot CLI は返答を画面の幅で折り返して出すので、JSON の文字列の途中に改行が入り、コードブロックの印も消える(`judge import` は「JSON を取り出せません」)。当初の依頼文(「…JSON を返してください。」)と、ファイルに書かせる頼み方を補足に回した形は、ターミナルで動くエージェントでは働かない。
  - これを受けて、画面の依頼文と注意を、結果をファイルに書かせる形に変えた。注意の「ファイルの変更を許可しない」は、「書き込みを許可するのは結果のファイルだけ」にした。
  - 採らなかった案: 取り込みの側で、文字列の途中の改行を取り除いて読む(折り返しで消えた空白を戻せず、英文の理由の文が崩れる。壊れた入力を黙って直すより、壊れない渡し方にする)。
  - 対話の画面(`-i`。2026-11-17)でも、返答を画面から写す形は取り込めなかった(返答の JSON が、文字列の途中で画面の幅に合わせて折り返して表示される。画面に出ている形のまま(1 画面分を写した)では取り込めず、その折り返しを手でつなぐと取り込めた)。結果のファイルだけ書き込みを許可してファイルに書かせる形は、対話の画面でも問い合わせなしに通った。
- **確かめていないこと**: ローカルの LLM での実際の判定(確かめた PC に、ローカルの LLM を動かす道具が無かった)。Copilot CLI 以外のコーディングエージェント(opencode の無料のモデルと Gemini CLI を試したが、認証で断られるか、応答が無く、動かせなかった)。

### atlas を止める stop.bat(2026-11-16)

- **きっかけ**: 利用者の相談「どこかのブラウザで開いていて見つけられず、atlas.bat を開いても更新できない事態を防ぎたい」。画面のサーバはタブが開いている間(閉じずに放ったときは heartbeat が途絶えてから 30 分)動き続け、その間は `self-update` が「atlas が動いている」で更新を飛ばし、`serve` は前のサーバを開き直すだけになる。画面から別のフォルダを開いたサーバは窓の無いまま動く(`launch_detached`)ので、黒い窓を閉じる直し方が使えない。
- **決めたこと**: `stop.bat` と `scripts/stop-atlas.ps1` を足した。止める相手は、実行ファイルがこのフォルダの `bin\atlas.exe`(置き換えで移した `atlas.old-*.exe` を含む)のプロセスと、その子孫(親より後に作られたものだけ。エクスプローラーは除く)。画面のサーバ(`serve`・`open`)だけなら尋ねずに止め、ほかの処理が動いていれば尋ねる(`-Yes` で尋ねない)。止めた後、残った印(`out\` と `out-folders\<キー>\out\` の `.serve.json`・`.job.json`)と前の実行ファイルを消す。atlas.exe を動かさず、`ensure-atlas.ps1` と `self-update` も通らない(実行ファイルが壊れていても・前の版でも止められるように)。
- **採らなかった案**: 印の pid で止める(pid は使い回されるので、別のプロセスを止めかねない。印は消すだけに使う)。`taskkill /T`(親子を pid だけで辿るので、使い回された pid の無関係なプロセスまで辿りうる)。`atlas stop` のサブコマンド(止めたいのは前の版が動いているときで、前の版の実行ファイルには無い)。`atlas.bat` が版の違うサーバを見つけたら自分で止める(別のタブで開いている画面が予告なく切れる。利用者は stop.bat を選んだ)。
- **残る限界**: atlas が異常に終わって親を失った子(判定の copilot など)は、辿る親が無いので止めない。

### 失敗の台帳(2026-11-16)

- **前の決め方**: 2026-11-12(`9c30fde`)に、ツールの失敗を要因別に数える形にしたとき、エラーの文そのものは記録に残さないと決めた。文にはパス・URL・秘密が入りうるので、決まった規則で分けた要因の回数だけを残した。
- **今回残す理由**: 要因の回数だけでは、どの MCP・ツール・エージェントが同じ文で繰り返し失敗しているか、失敗の後に呼び直したのか別の手に移ったのかを追えない。失敗と拒否を 1 件 1 行で残す(`analysis.failures`。`sessions.json` の版 18)。行は `tools.results` の failure + denied と同じ条件で作り、上限で切った行の数は `failuresDropped` に持つ。
- **秘密の扱い**: エラー文・引数・サブエージェントの prompt は、全文の秘密らしい文字列を伏せてから上限で切る(先に切ると、途中で切れた鍵が形に当たらず残る)。伏せる処理(`redact_secrets`)は `atlas-core` の `secrets.rs` に移し、URL の認証情報(`user:pass@`)と、名前の付いた値(`password=…` や `"api_key": "…"`)も伏せる形を足した。足した 2 つは送り先のフォルダの検査(`scan_secrets`)には数えない(形が決まらず、検査が誤って止まるのを避ける)。
- **上限**: エラー文と引数は 1000 字、prompt は 500 字、似た文をまとめる鍵(`group`)は 200 字、行は 1 セッション 500 件(時刻の早い順)。字数は UTF-16 の単位で、切ったときの … を含む。
- **next(失敗の後に何をしたか)**: 読み終えた後に、同じエージェントの呼び出しのうち、失敗の完了より後に始まり、失敗と同じ応答(`assistant.message` の `toolRequests`)で要求されたものでない最初の呼び出しを入れる。並列の呼び出しと、別のエージェントの呼び出しは数えない。本体では、その前に利用者の新しい依頼が来たら user、呼び出しが無ければ end。
- **エージェントの見分け方**: 親の呼び出しの toolCallId(`parentToolCallId`。無ければ `agentId` から引いた親の呼び出し、それも無ければ `agentId`)。名前で見分けると、同じ種類のエージェントが並列に動いたときに混ざる。prompt は行ごとに持たず、`agents[].prompt` に 1 回だけ持って `agentCall` で引く。
- **turn**: 本体の依頼の通し番号(0 から)。200 件を超えても数え、最初の依頼より前だけ null にする(200 件までは `turnStats` の添字と同じ)。
- **あわせて足したもの**: モデル別 × ツール別の結果(`tools.resultsByModel`)。台帳の行だけでは率の分母が無いため。
- **採らなかった案**: 引数を主な項目(command・path など)だけにする(失敗の理由がどの引数にあるかはツールごとに決まっておらず、呼び直しの判定にも全体が要る)。prompt を行ごとに持つ(同じエージェントの失敗の数だけ重なる)。
- **表と詳細ページ(2026-11-16)**: `out/tables/failures.csv` と SQLite の `failures` 表は、`out/tables` を書く所でだけ足す(グループの書き出しは同じ関数を共有しているので、そちらには入れない)。依頼番号は `turns.csv` と同じ 1 からの番号。台帳の無い古い記録だけのときは表を書かず、前のものも消す(見出しだけの表は「失敗が 0 件」と読める)。詳細ページは、依頼ごとの表に「失敗・拒否の内訳」の欄を足し、1 件ごとの節を別に置いた(最初の依頼より前の失敗と、依頼ごとの表に載らない依頼の失敗も載せるため。エラー文は表が縦に伸びすぎないよう 400 字、引数は 200 字まで)。
- **集計のページ(2026-11-16)**: `out/failures.html` と `out/failures.json`。単位はツール・MCP サーバー・エージェント・skill・指示文の版。回数と率の分母は `tools.results` から、要因・エラー文・呼び直しは台帳の行から数える(台帳は 1 セッション 500 行までなので、行から回数を数えると上限を超えたセッションで少なく出る)。台帳の無い記録は分母にも入れない(分子と分母を同じセッションにそろえる)。skill と指示文の版は、失敗をそれに結び付ける記録が無いので、使ったセッションの単位で数え、相関までと書く。
- **閾値**(`crates/atlas-report/src/failure_stats.rs` の `thresholds`): 率を出すのは、結果の記録がある呼び出しが 20 回以上のとき(これより少ないと、1 回の失敗で率が 5 ポイントを超えて動く)。セッションの単位で比べるのは 5 セッション以上、繰り返しは 3 回以上(どちらも改善点の分析と同じ値)。ページの表は 50 行までで、JSON には全件を書く。どれも実行時にこの定数で決め、手元の件数に合わせた値は置いていない。
- **言葉**: 似たエラー文をまとめる鍵は「そろえたエラー文」と呼ぶ(初めは「まとまり」としたが、VCS の照合で「1 回の編集で続けて足した行」の意味に使っているので分けた)。ページの名前は「失敗の台帳の集計」(1 件ごとの一覧ではなく集計なので)。
- **採らなかった案**: 集計を `atlas.html` の中で絞り込みに従って計算し直す(台帳の行を埋め込むことになり、埋め込みデータが大きくなる。エラー文と引数を `atlas.html` に入れたくない)。ブラウザ側の TS に同じ集計を持つ(build のときだけ計算するので要らない)。エージェントごとの失敗率(エージェントごとの、結果の記録がある呼び出しの数が記録に無い)。失敗の行を skill に結び付ける(skill が効いている区間の記録が無い。最初に呼んだ後の行の数だけを添えた)。
- **確かめていないこと**: 本物のログでの動き。ダークの配色と 375px の実機(色は変数だけを使い、表は横スクロールの枠の中)。

### 伏せ字版の廃止(2026-11-16)

- **決めたこと**(利用者の判断): 共有用の伏せ字版(`--anonymize`)を廃止した。オプションと、伏せ字版だけの出し分けを除く。秘密情報の検査(API キーらしい文字列を `[伏せました: 種類]` に置き換えて件数を出すもの)は別の機能なので残す。
- **共有**: atlas には名前やパスを伏せて出す機能が無い。人に渡すときは、名前やパスがそのまま入る前提で中身を確かめ、渡してよいファイルだけを渡す(README の「共有するときの注意」)。
- **失敗の台帳**: 伏せ字版では作らなかった集計のページ(`failures.html` / `failures.json`)は、出し分けを外して常に作る。詳細ページの「失敗と拒否(1 件ごと)」も、エラー文と引数をそのまま(秘密情報の検査で伏せた後のもの)出す。

### テストの結果の取り込み(2026-11-16)

同じ課題を条件(素 / wiki あり / コード参照ツールあり など)を変えて何度も実行し、条件ごとの成功率と費用を比べたい、という依頼の最初の段。テストの合否と件数をセッションに結び付ける。依頼ごとの推移・条件比較の表・書き出しは、この上に後で足す。

- **決めたこと**: テストの実行ファイルが、行頭に `ATLAS_TEST_RESULT` の印を付けた 1 行の JSON を標準出力に書き、atlas はツールの完了(`tool.execution_complete`)の結果の本文から拾う(`crates/atlas-core/src/test_results.rs`)。ログの中だけで決まるので、別のファイルとの突き合わせが要らず、アップロードした生ログから集計し直しても同じになる(送る側に手を入れない)。結果は `sessions.json` の `tests`(版 19。main の失敗の台帳が 18 を使った)に、ツールの呼び出し 1 回ごとに、時刻・依頼の番号・ツール・呼び出しの ID と結果の並びで持つ。印の行が無いセッションにはキーを置かない(前の版の記録と同じ形のまま)。
- **項目**: 必須は `passed`(真偽)だけ。`name`・`counts`(名前 → 数。件数も割合も同じ形で持ち、名前は書いた側のまま)・`at`。ほかの項目は読み飛ばす(項目を足しても古い atlas で読める。新しい数は `counts` に足す)。上限(1 セッション 5,000 件・名前 200 字・`counts` 50 個)は、記録を大きくしすぎないための線で、超えた分は数だけ残す。
- **拾い方**: 行頭の印だけを読む(テストのソースを読んだ結果の `print("ATLAS_TEST_RESULT …")` や、行番号の付いた表示・検索の結果を拾わないため)。`result.detailedContent` → `result.content` → `error.message` の順に見て、印の行が見つかった最初の 1 つだけを使う(同じ呼び出しで重ねて数えない。テストが落ちて終了コードが 0 でないと結果がエラーの側に入ることがあるため、エラーの文も見る)。同じ行が後から再び出たとき(非同期のシェルの出力を読み直す・保存したログを表示する)は、`at` のある行だけ 1 回にし、重ねた数を残す(`at` の無い行は別の実行と見分けられない)。
- **採らなかった案**: テストの結果を別のファイルに書いて atlas が突き合わせる(時刻とセッションの対応を決め直す必要があり、アップロードにもファイルを足すことになる)。印を行のどこにあってもよいことにする(ctest の `1: ` のような前置きを許せるが、ソースや検索の結果も拾う)。ツールの名前でシェルだけに絞る(MCP のツールでテストを走らせる使い方を外す。行頭の印で足りる)。
- **確かめていないこと**: 長い出力を Copilot のログがどう残すか(途中で切るなら、切られた所の印の行は拾えない)。非同期のシェルの出力を読み直すと同じ行が実際に重なるか(重なっても `at` があれば 1 回にする)。

### テストの推移(2026-11-16)

テストの結果の取り込みの上に、1 セッションの中の推移を足した。実装 → テスト → 修正の繰り返しで、何回目に全部通ったか、そこまでにどれだけ使ったか、最後まで通らなかったかを出す。

- **実行**: 結果を出したツールの呼び出し 1 回を 1 つの実行とする(`tests.runs` の 1 件)。繰り返しの回数はこの実行の数で数える。
- **全部通った**: これまでに出たテストの名前ごとに、いちばん新しい結果を持ち、不合格のものの数を実行ごとの `failing` にする。0 なら全部通った。最初に 0 になった実行の番号をセッションの `firstPass` に持つ。実行が 1 回以上あって `firstPass` が無いセッションが「未達」。実行が無いセッション(印の行が無い・読めなかった行だけ)は「テストの記録なし」で、未達と同じに扱わない。
- **通るまでの実働と AI 使用量**: 実行ごとに、セッションの始まりからの実働(セッションの実働時間と同じ数え方)と、その実行までに記録されたリクエストの AI 使用量の累計を持つ(`activeMs`・`nanoAiu`)。AI 使用量は、AIU の記録があるリクエストのすべてに時刻があるときだけ出し、無ければ `null`(0 にしない。終了時の累計だけのセッションは、どの実行より前かを決められない)。サブエージェントのリクエストも入れる(そのセッションで使った量なので)。
- **持ち方**: 推移の値は集計のとき(normalize)に決めて `sessions.json` に持つ。リクエストの時刻が要る累計は、ここでしか求められない。`failing` と `firstPass` は結果の並びから求め直せるが、画面の TS と Rust の両方に同じ計算を持たないよう、決めた値を持つ。版は 19 のまま(テストの結果の取り込みと同じ版)。
- **画面**: 詳細ページに「テストの推移」の節(印の行を読めたセッションだけ)。件数は、実行ごとに名前別の合計を出す(割合を書いた名前では合計の意味が薄いが、名前から件数か割合かを決められない。0 かどうかと増減は読める)。
- **採らなかった案**: 「全部通った」を、その実行の結果がすべて合格のことにする(1 つのテストだけを走らせ直して通った時点で、ほかの落ちたままのテストがあっても通ったことになる)。これまでに出たすべてのテストをその実行で走らせたときだけ通ったとみなす(テストの実行ファイルを分けて走らせる使い方や、名前を変えたテストがあると、いつまでも通らない)。通るまでの AI 使用量を、依頼ごとの値(依頼に振り分けた AIU)の和で出す(1 つの依頼の中でテストを何度も走らせると、その依頼の全部が入る)。
- **残る限界**: 走らせ直していないテストが、後の修正で壊れていても分からない(毎回すべてのテストを走らせる運用なら起きない)。
- **確かめていないこと**: リクエストの使用量の記録の時刻が、そのリクエストが呼んだツールの完了より前か後か(累計は、実行の完了の時刻までに記録されたものを足す。記録がツールの完了より後に付くログでは、テストを呼んだリクエストの分が、その実行ではなく次の実行の累計に入る)。

### 課題 × 条件の表(2026-11-16)

同じ課題を条件を変えて何度も実行し、条件ごとの成功率と費用を並べる。「比べる」は 2 つの条件だけなので、条件が 3 つ以上でも 1 つの表になる節を足した。テストの結果の取り込み・テストの推移の上に作る。

- **課題・条件・回の持ち方**: タスクタグ(グループ)の名前の決まりから読む。`課題__条件` か `課題__条件__番号`(番号は半角の数字だけ)。専用の項目は足さない(以前に「同じ『名前 → セッションの集まり』が 2 つになる」として採らなかった判断と同じ。保存先・アップロード・送り先の読み取りがそのまま使える)。区切りは定数(`CONDITION_SEP`)で、設定にはしない。設定の項目を足すと、古い版の atlas が「不明な項目」で集計を止める。分けるのは集計する側なので、定数なら送った人と集計する人で決まりが食い違わない。`-` は `Player-Weapon` のような名前に入るので区切りにしない。どの部分も空でなく、区切りの隣に `_` が続かないこと(`a___b` のように切る場所が 1 つに決まらない名前を受けない)。4 つ以上の部分・数字でない番号は合わないものとして表に入れない(推測で切らない)。各部分の前後の空白は落とす(`a __ b` は `a__b` と同じ)。大文字小文字・全角半角はそろえない。
- **回数の数え方**: 番号は決まりに合うかの確認にだけ使い、回数はセッションの数で数える。1 つのタグに繰り返しを全部入れても、1 回ごとにタグを分けても同じ結果になる。
- **複数のタグ**: セッションごとに、付いているタグから決まる (課題, 条件) の組を集め、1 つならその行に 1 回、2 つ以上ならどの行にも入れずに件数を出す。この 1 つの決まりで、同じセッションを 2 回数えず、課題をまとめた行の件数が課題ごとの行の合計と合う。
- **送り先のレポート**: タスクタグの表示名は「人 / タグ」(重なると番号が付く)なので、表示名からは読まない。送り先から作るグループに元のタグを添え(`member_groups_keyed`)、レポートへの埋め込みと、読むだけの画面の `/api/state` の両方に `tag` として載せる。行は人をまたいでまとめる(名前の決まりは、同じ課題を同じ条件で実行するための共通の約束。人ごとに分けると 1 行の件数が人数分の 1 になり、ほとんどが「—」になる)。2 人以上のセッションが入った行があるときは、まとめていることと人数を表の下に出す。タスクタグそのもの(サイドバー・絞り込み・「比べる」)は、今までどおり人ごと。
- **集計の場所**: 画面(TS の `lib/conditions.ts`)で計算する(「比べる」と同じ。表に書くために、後で Rust にも同じ計算を置いた。下の「テストの結果と課題 × 条件の表の書き出し」)。画面で付け替えたタスクタグがすぐ表に効く。レポートには、テストの実行があるセッションだけに数だけの要約 `tests`(実行の数・`firstPass`・最後の実行の `failing`・通るまでの実働と AI 使用量・最後の実行までの AI 使用量)を埋め込む(埋め込みの版 17。main の失敗の台帳が 16 を使った。`sessions.json` の形は変えていない)。要約は Rust と TS の両方に持ち、`npm run parity:fixture` に決まった形の入力(`tests-summary`)を足して突き合わせる(架空の fixture には印つきの行が無いため)。
- **最後に全部通った**: 最後の実行の後に通っていないテストが無いセッション ÷ テストの記録があるセッション。「通った後に不合格」と「未達」は合格に数えず、件数の列で別に出す。テストの記録が無いセッションは分母に入れず、「テストの記録なし」の件数で出す(未達と同じに扱わない)。
- **最初に全部通るまでの中央値**: 通ったセッションだけで取ると、未達の多い条件ほど小さく(良く)見える。テストの記録があるセッション全部を母数にし、未達のセッションをどの値よりも後ろに並べて中央値を取る。通ったセッションが半分以下なら数を出さず「未達」と出す。AI 使用量は、そこまでの量が分かるセッションだけを母数にする(通ったセッションは最初に通った実行までの量があるもの、未達のセッションは最後の実行までの量がある = リクエストごとの記録があるもの。未達のセッションに記録があるかを見分けるため、要約に最後の実行までの AI 使用量を持つ)。
- **5 件未満の扱い**: 既存の閾値(`COMPARE_MIN_SESSIONS`)を、実際に割る数に掛ける(テストの記録があるセッション、AI 使用量の記録があるセッションなど)。件数はいつも出し、割合と中央値のセルの下に割った数を添える。課題をまとめた行にも同じ決まりが掛かる。ツールの失敗・拒否だけは「比べる」と同じ式(セッションの数で決める)にして、同じ名前の行と値をそろえる。
- **同じ課題どうしの比べ方**: 課題ごとの表で、どの課題にも全部の条件を同じ順で並べる(その課題に無い条件は 0 件の行)。課題をまとめた行は、その条件のセッションを全部の課題から集め、セッションのある課題の数(k / K)と、条件でセッションの数が違う課題の件数を出す。差・差の幅・順位は出さない。
- **節を出す条件**: 決まりに合い、セッションが 1 件以上あるタスクタグがあるとき。目次と本文の両方を同じ 1 つの値から決める。テストの記録が 1 件も無ければ、テストの列を出さずに理由を書く(件数・実働・AI 使用量・ツールの失敗は読める)。
- **採らなかった案**: 区切りを設定にする(上の理由)。「比べる」の中の単位として足す(A・B の 2 列の表と形が違う)。通るまでの中央値を通ったセッションだけで取る(未達の多い条件が良く見える)。課題をまとめた行を、全部の条件にセッションがある課題だけに絞る(1 つの条件が 1 つの課題にしか無いだけで、全部の条件のまとめが消える。k / K を出して読む側が見分けられるようにした)。基準の条件を選んで、課題ごとの「良い / 同じ / 悪い」を数える(課題 × 条件の行は 5 件未満が多く、ほとんどが「比べられない」になる。操作の部品と、指標ごとの良い向きの決まりが増える)。人ごとに行を分ける。大文字小文字・全角半角をそろえて同じ名前にする(タスクタグの完全一致と食い違う。同じになる名前があれば知らせるだけにした)。
- **残る限界**: 課題をまとめた行には、課題の難しさと件数の偏りが混ざる(重みをそろえる計算はしていない)。送り先のレポートで、ある人が片方の条件だけを実行していると、人の違いが条件の差に混ざる。ツールの失敗・拒否には、テストが落ちて失敗を返した実行も入るので、テストの結果と別々の証拠にならない。テストをこまめに走らせるほど「テストの実行」は増える。名前の打ち間違い(`wikii`)は別の条件になる(0 件の行が増えるので気づける)。通った後も作業を続けたセッションは、セッション全体の実働と AI 使用量が大きくなる。

### 条件が実際に効いたかの確認(2026-11-16)

「課題 × 条件」の節に「利用の確認」を足した。「wiki ありの条件なのに wiki を一度も読んでいない」セッションや、「素の条件なのに wiki を読んだ」セッションを一覧にして、条件の割り当てが実際に効いていたかを確かめる。

- **決めたこと(利用者の判断)**: どの条件で何を使うはずかは、読む人が画面で選ぶ(確かめるものを選び、条件の行の「使うはず」に印を付ける)。設定の項目にはしない(古い版の atlas が「不明な項目」で集計を止める。期待は条件の名前と同じく読む側の約束で、集計に持たせる必要が無い)。条件の名前から推測もしない(名前に wiki が入っていても、wiki を使う条件とは限らない)。印は確かめるものごとに覚え、画面の中だけで保存しない。
- **確かめるもの**: llm-wiki の参照(索引・個別ページを読んだ回数、wiki の skill の呼び出し、vault の検索・一覧などそのほかの呼び出し。書き込みだけは数えない。そのほかの呼び出しを数えるため、埋め込みの wiki の要約に `otherCalls` を足した)、skill の呼び出し、MCP サーバー(そのサーバーのツールの呼び出しをまとめる)、ツールの呼び出し。どれもレポートに埋め込んだセッションの要約から数える。選べるのは、表のセッションで使われたものだけ(llm-wiki はいつも)。MCP のツールはサーバーにまとめて出し、ツールには並べない。
- **wiki を数えたかの記録**: llm-wiki の参照は、集計した PC の設定で vault を指定したときだけ数える。指定の無い集計では、どのセッションも 0 で、「wiki ありの条件で読まなかった」が全部に見える。集計の記録 `sessions.json` の `source.wikis`(参照を数えた vault の数)と、レポートの `wikiVaults` に残し、0 なら数えていないと注意を出す(送り先から集計したときは、集計した側の設定が効く)。古い集計(記録が無い)では、使ったセッションが 0 件のときだけ、記録が無いことを書く。
- **数え方**: 表の行に入ったセッション(課題 × 条件の行。複数の条件のタグが付いたセッションは入らない)だけを数える。条件ごとの「使った割合」は、件数が 5 件未満なら「—」(既存の閾値)。一覧は条件・課題の名前の順で、多いときは先頭の 50 件。
- **採らなかった案**: 設定(`atlas.config.json`)に条件ごとの期待を書く(上の理由)。条件の名前と確かめるものの名前が似ていたら、使うはずとして既定で印を付ける(推測になる)。使った回数の多い少ないで食い違いを決める(どれだけ使えば「効いた」かは条件によって違い、決まりを置けない)。
- **確かめていないこと**: 実際のログでの wiki の参照の数え方(既存の数え方をそのまま使っている。vault の指定の仕方は cli.md の「wiki の指定」)。

### テストの結果と課題 × 条件の表の書き出し(2026-11-16)

テストの結果(取り込み・推移)と課題 × 条件の表を、表計算ソフトや SQL で扱えるように `out/tables/` に書く。

- **書くもの**: `test-runs.csv`(テストの実行 1 回 1 行。そこまでの実働と AI 使用量の累計、まだ通っていないテストの数)、`test-results.csv`(結果 1 件 1 行)、`test-counts.csv`(件数 1 つ 1 行。`counts` の名前は書いた側が自由に足せるので、列にせず縦に持つ)、`conditions.csv`(画面の課題 × 条件の表と同じ行)と、`sessions.csv` の課題・条件・テストの列(最初の依頼の列の前)。SQLite には `test_runs`・`test_results`・`test_counts`・`conditions` の表と、`sessions` の同じ列。
- **書かないとき**: テストの実行が 1 回も無ければテストの 3 つの表を、名前の決まりに合うタスクタグが無ければ `conditions.csv` を書かず、前のものも消す(見出しだけの表は「0 件」と読めてしまう。失敗の台帳の `failures.csv` と同じ扱い)。
- **課題 × 条件の表の計算**: 画面は TS(`lib/conditions.ts`)で計算するので、表を書くために同じ計算を Rust(`crates/atlas-report/src/conditions.rs`)にも置いた。`npm run parity:fixture` の `conditions` で、決まった入力(セッション・タスクタグ・名前の読み取り・並び)から作った表を突き合わせる。名前の並び(数字は数として比べる)は、ICU4X の照合の数の並びの設定で、画面の `Intl.Collator('ja', { numeric: true })` に合わせた。大文字小文字・全角半角だけが違う名前の知らせは画面だけなので、Rust には無い。
- **タスクタグ**: 画面のレポートと同じ選び方(送り先から集計した出力先は送った人の元のタグ、それ以外は `groups.json`)。画面でタスクタグを付け替えたら、表は次の集計で変わる(画面はその場で変わる)。
- **値の形**: 割合は小数 4 桁、AI 使用量は小数 3 桁、実働は秒。割合と中央値は、もとになるセッションが 5 件未満なら空。最初に全部通るまでの中央値が未達(通ったセッションが半分以下)のときは、中央値の列を空にして、隣の「…が未達」の列を 1 にする(中央値の列に文字「未達」を入れると、SQLite の平均や比較で文字が 0 などに読まれるため)。何件から取ったかは「母数」の列で分かる。`sessions.csv` には、読めなかった印の行と、1 セッションの上限(5,000 件)で持たなかった結果の数も入れる(test-*.csv が全件でないことが分かるように)。
- **採らなかった案**: 件数(`counts`)を列にする(名前ごとに列が増え、セッションやテストで列の並びが変わる)。課題 × 条件の表を出さず、`sessions.csv` の課題・条件の列だけにして、集計は読む側に任せる(画面と同じ数え方の表を、手で作り直さずに使えるようにした)。グループの書き出し(`out/groups/<名前>/`)にも入れる(1 つのタスクタグのセッションだけなので、課題 × 条件の表の意味が薄い。`failures.csv` と同じく `out/tables/` だけにした)。
- **確かめていないこと**: 大きな実データでの書き出しの時間(テストの結果の行の数は、印の行の数に比例する。1 セッション 5,000 件の上限は取り込みのときに掛かる)。

### 依頼ごとの判定で、採用を判定できる依頼を先に渡す(2026-11-15)

セッションの最後の依頼には次の依頼が無く、成果の扱いは必ず判定不能になる。1 依頼だけのセッションが多いと、先頭の添付ファイルが判定不能ばかりになり、何往復しても採用率が出ない。

- **塊の分け方**: セッションの最後の依頼は、どのセッションでも 1 件だけの塊にする(`chunks_of`)。前の依頼と同じ塊に入るセッションと入らないセッションが混ざると、先頭だけを判定したときに、最後の依頼の種類・工程が判定されるセッションとされないセッションに分かれるため。
- **並び**: 判定できる依頼の塊を先、最後の依頼だけの塊を後ろにする。添付ファイルも別々に詰め、同じファイルに混ぜない。先頭のファイルと塊には、判定できる依頼だけが入る。
- **どこまでが先頭か**: `manifest.json` の `decidable`(`turns`・`chunks`・`parts`。省略可で、`TURN_BUNDLE_VERSION` は上げない)。`turns run --limit <decidable.turns>` は先頭の塊をちょうど回す。添付を作ったときのログ(`decidable_note`)と、画面の「チャットに貼って判定する」(手順 1 の文、一覧の「最後の依頼だけ」、次のファイルが後ろに入ったときの案内)に出す。
- **費用**: 最後の依頼が前の依頼と同じ塊に入らなくなるので、全部を `copilot -p` で回すときの回数は、最後の依頼を含むセッションの数だけ増えうる。採用だけなら先頭の塊だけで足りる。
- **採らなかった案**: 塊はそのままで、判定できる依頼を含む塊を先に並べるだけにする。最後の依頼が先頭に混ざり、`--limit` に渡す数も決まらない。セッション単位で並べる案は、判定済みを除いた後に最後の依頼だけが残ったセッションが前に来る。

### 開いたフォルダから消したセッションを数え続けない(2026-11-16)

- **きっかけ**: 利用者の報告「open-folder で開くと、消したフォルダもレポートに入っている」。開いたフォルダは `out-folders/<キー>/out/snapshot/` に複製してから集計する。複製の同期は、セッションの中のファイルは元に合わせて消すが、セッションのフォルダごと元から消えたものは複製を残し、数えたフォルダ(人・プロジェクト)も前の集計から引き継いでいた。`~/.copilot` では Copilot が消したログの最後の複製を残すための決まりで、アップロード先にも同じ決まりが掛かっていた。
- **決めたこと**(利用者の判断): アップロード先を読むとき(直下にセッションが並ぶ形と、そのフォルダが並ぶ形)は、元から無くなったセッションの複製を消す(`remove_gone_sessions`)。消した件数は `snapshot-manifest.json` の `sessions.removed`(0 のときは書かない)とログに出す。`~/.copilot` を読むときは今までどおり残す。
- **消すのは、無いと確かめられたものだけ**: 複製先にあって今回の一覧に無い id について、前の集計までの記録からどこにあったかを決め(`Previous::folder_of`)、そのフォルダを上から順に読み直す(`confirm_gone`)。読めて、そこに無ければ消す(上のフォルダごと無くなっていても同じ)。読めなければ消さず、そこにフォルダがあれば消さない。一覧に無いことだけを証拠にしないのは、形を調べる処理(`describe_source`)と一覧(`list_state_dirs`)が、読めないフォルダを「無い・空」として扱うため(アクセス権の無い人のフォルダ、つながらない共有フォルダを、無くなったものとして消してしまう)。
- **どこにあったかの記録**: まとめて読む形の回は、数えたフォルダ(`merged.owners`)。直下にセッションが並ぶ形の回は、元のルート。消さなかった複製は、分かっているフォルダを `extras.goneKept` の `folder` に持ち越し、次の集計は数えたフォルダの記録に無い id をそこから引く。持ち越すのは、形が変わって読まれた回(直下にセッションのフォルダが紛れた)や、セッションが 1 件も見つからなかった回の manifest には数えたフォルダの記録が無く、次の回に「元のルートにあった」とみなして、まだ元にあるセッションの複製を消してしまうため(独立したレビューが 2 回目の集計で見つけた)。
- **消さずに残すもの**(`extras.goneKept` に id・理由・フォルダを残し、`atlas snapshot` のログと、レポートの警告に出す): 前にあったフォルダを読めなかった、前にあった場所にフォルダはあるのに今回は読まなかった(フォルダの並びが別の形として読まれた・リンクになった)、元のフォルダに集計できるセッションが 1 件も見つからなかった(このときは全部残す)、前の集計にどのフォルダのセッションかの記録が無い(前の版が写した複製・途中で止まった集計の複製)、複製を動かせなかった(ほかのプログラムが開いている、など)。まとめて読む形の回は、残した複製の数えたフォルダも前の記録から引き継ぐ(人ごとの内訳から外さない)。
- **消し方**: 複製のフォルダを、まず複製先の `.removed/<時刻>/` へ丸ごと動かしてから消す。動かせなければそのまま残す。半分だけ消えた複製を数えることが無く、消せない複製が 1 つあっても集計は止まらない(初めは `rm` が失敗すると集計ごと止まっていた)。動かせないときは少し待ってやり直すが、待つのは 1 件目だけ(開いたままの複製がいくつあっても、待ち時間を積み重ねない)。消し切れなかった分は次の集計の初めに消す。
- **退けた前のフォルダだけが残る id**: 本体も写している途中のものも無く、`.<id>.old` だけが残っているセッションは、共有から消したセッションの消し残しなので、元にあるものとして数えず、複製も消す。snapshot は前からこのセッションを写さず(古い中身で戻さない)、警告も「数えていない」と書いていたが、前に写した複製があるとそれで数え続け、警告も出していなかった(同じ送り先でも、読む人によって件数が違った)。写している途中の `.<id>.uploading` だけがある id は、送っている最中かもしれないので消さない。
- **名前の比べ方**: 大文字小文字を区別しない(Windows で元の名前の大文字小文字だけが変わったときに、写したばかりの複製を消さない)。大文字にそろえて比べる(小文字にそろえると、語末かどうかで形が変わる文字で、同じ名前が別の名前になる)。
- **使い回しの判定**: 消した件数と、退けた場所(`.removed`)の消し残りは入力の印に入れない(消した次の回や、消し残りが片付いた回に、何も変わっていないのに作り直さないように)。消した回は複製のファイルの一覧が変わるので作り直す。消さなかったものの記録は、レポートの警告に出るので印に入れる。
- **採らなかった案**: `--rebuild` や「一覧から外す」で複製を消す(利用者が操作しないと古いセッションが残る。開くたびに元に合わせるほうが、送り先を見たとおりになる)。`~/.copilot` でも消す(Copilot は古いログを自分で消すので、過去の集計が減っていく)。今回の一覧に無いものをそのまま消す(初めの実装。読めないフォルダのセッションを消し、形が変わって読まれたときに全部消していた。独立したレビューの指摘で改めた)。元から 1 件も読めなかったときは何も消さない、という守り(初めの実装。索引だけが残って最後のセッションを消したときに、複製が残り続けた。読み直して確かめる形にしたので外した)。記録の無い複製も、元を広く読み直して消す(どこまで読めば「無い」と言えるかが決まらず、関係のない大きなフォルダを読むことになる。件数は少ないはずなので、警告で消し方を案内する)。動かせない複製を、その場で中身から消す(消せたファイルと消せないファイルが混ざり、半分だけの複製を数えることになる)。
- **残る限界**: 読めて、空だったフォルダは「無くなった」と確かめたことになる(共有フォルダの割り当てが外れて空のフォルダに見えるときも、複製を消す。もう一度つながれば写し直す)。記録の無い複製(前の版が写したもの)は、利用者が出力先のフォルダを消すまで数え続ける(警告は出る)。元がアップロード先の形でなくなり、`~/.copilot` の形として読まれた回は、記録を持ち越さない。フォルダの並びが変わって別の形として読まれている間に、セッションを別のフォルダへ移すと、記録の場所に無いので複製を消す(並びを直した回に写し直す)。フォルダは残っていて中身だけを消したセッションは、元にあるものとして複製が残る(今までどおり)。大文字小文字を区別するディスクで、名前の大文字小文字だけを変えると、両方の複製が残る。`--since` で写さなかったセッションの複製は、元にあるかぎり残る(今までどおり)。直下にセッションが並ぶ形かどうかは形だけで決まるので、`~/.copilot/session-state` を直接指したときも、消す側に入る。読み書きも削除も共有して開かれているだけの複製は、中身からなら消せても、フォルダごとは動かせないので残る(閉じた後の集計で消える)。複製を動かせなかった理由は 1 つの文にまとめている(退ける場所を作れない、なども同じ文になる)。
- **確かめていないこと**: 本物の共有フォルダ(NAS)でのアクセス権とつながらないときのエラー(テストは、フォルダの代わりに同じ名前のファイルを置いて「読めない」を作った。独立したレビューでは、Windows のアクセス権の拒否で確かめた)。macOS で、開いているファイルのある複製を動かしたときの動き(Linux は単体テスト `copy_with_an_open_file_is_removed_on_unix` を CI で回す。フォルダごと動かして消せる)。退けた場所に消し残りが実際に残る場面(作れなかった)。

### llm-wiki の参照の数え方と、確かめ方(2026-11-17)

- **きっかけ**: 「wiki を使ったセッション」の決め方がコードに 3 通りあった。集計明細・プロジェクト別・人別は書き込みを入れて検索・一覧を入れず、課題 × 条件の利用の確認は書き込みを入れずに検索・一覧を入れ(文書に決まりとして書いてあったのはこれだけ)、詳細ページ・判定パケット・`extract` のログ・`metrics.json` は全部を入れていた。同じレポートの中で件数が食い違い、vault を指定していない集計では、集計明細やプロジェクト別に 0 が並んで「だれも使っていない」に見えた。
- **決めたこと(数え方)**: 「参照した」セッションは、索引の読み取り・個別ページの読み取り・wiki の skill の呼び出し・そのほかの呼び出し(vault の検索・一覧など)が合わせて 1 回以上のもの。書き込みだけのセッションは「書き込みだけ」として別に数え、参照したには入れない。5 つ全部の合計は「vault に触れた」と呼び、使うのは詳細ページの欄を出す条件・判定パケットの「参照なし」の判定・`metrics.json` の `sessionsWithAny` だけ。判定は Rust(`crates/atlas-core/src/wiki.rs` の `wiki_referenced`。`WikiUsage` と `WikiSummary` の両方から呼ぶ)と TS(`packages/report/src/lib/wiki.ts`)に 1 つずつ置き、`npm run parity:fixture` の `wiki` で決まった入力(参照した / 検索だけ / 書き込みだけ / 触れていない / skill だけ / `otherCalls` の無い古い形)を突き合わせる(fixture のセッションは古い式でも新しい式でも同じ値になるため)。画面の言葉は「参照した」のまま。理由: 書き込みは wiki の手入れで、読んで作業に使ったかの問い(条件が効いたか)に入れると、素の条件で wiki を手入れしたセッションが「使った」になる。検索・一覧は vault を見に行った呼び出しなので参照に入れる。文書に決まりとして書いてあった利用の確認の数え方に、ほかをそろえた。
- **数えていない集計**: `sessions.json` の `source.wikis`(レポートの `wikiVaults`)が 0 なら「数えていない」、記録が無く vault に触れた(参照か書き込みをした)セッションも無ければ「記録なし」(数えていないのか、使っていないのか分からない)、それ以外は「数えた」(書き込みだけのセッションでも、vault を指定していたと分かる)。数えていない・記録なしのときは、集計明細の wiki の欄、プロジェクト別・人別の wiki の列、改善点の箱の件数、利用の確認の使った・使わなかった・割合と一覧を出さず、理由の文(状態ごとに 1 つの定数)だけにする。全文を出すのは集計明細・改善点の箱・利用の確認と、数えていないときの詳細ページで、プロジェクト別・人別の表は「wiki の列は出していません(…理由は集計明細)」の短い断り(これも定数)にする(同じ 2 文が 1 画面に何度も出ないように)。利用の確認の「確かめるもの」の既定は、このときは表の出る llm-wiki 以外の最初のものにし、llm-wiki は「(数えていません)」か「(記録なし)」を付けて選択肢に残す(記録なしでは数えていないと言い切らない)。全行に「—」を並べないのは、表のほかの列と見分けにくく、並べ替えの対象にも残るため。状態は絞り込み前の全セッションと vault の数で 1 度だけ決める(絞り込みで、参照したセッションが無くなっただけで「記録なし」に変わらないように)。詳細ページは「参照はありません」の代わりに同じ文、判定パケットは「この集計では数えていません(vault の指定なし)」か「この集計では数えたか分かりません(vault の指定の記録なし)」にし、判定の指示に「数えていない・数えたか分からないときも 0」を足した(vault の数はパケットを作るときに `sessions.json` から取れるので、記録の形は変えていない)。Rust の判定は `atlas_core::wiki::wiki_state`(画面の `wikiState` と同じ。詳細ページは埋め込む全セッション、`bundle` は `sessions.json` の全セッションで決める)。
- **改善点の箱は件数だけ**: 「llm-wiki の利用」の箱(画面だけ。`insights.html` には足さない)は、隣の箱と同じ題つきの罫線の表 2 つ(セッションの数: 参照した / うち書き込みもあり / 書き込みだけ / 参照なし。参照の内訳の回数: 索引 / 個別ページ(読んだページの延べ)/ wiki の skill / 検索・一覧など)と、注 1 段落だけ。率・差・差の幅は出さない。参照するかどうかは作業の中身で決まり(調べものの始めにも、詰まった後にも読む)、引数に vault の場所が出ない読み(相対パスだけの読み、vault の場所を渡さない MCP 経由の読みなど)は数えないので「参照なし」に参照したセッションが混ざり、件数は指定した vault をまとめて数えているので(vault 別には分けていない)skill のように名前どうしを見比べることもできないため。注には率を並べない理由と「参照なし」に参照したセッションが混ざることだけを書き、数え方の細目(skill・シェル・相対パス・vault の場所を渡さない MCP など)は用語の説明の「llm-wiki」に寄せてリンクし、wiki あり / なしの比べ方は用語の説明の「課題 × 条件」へリンクする(screen.md は出力に入らないのでリンクしない。手順は screen.md の「skill・llm-wiki・MCP サーバー・推論強度の違いを確かめる」)。注を長くすると、隣の箱(注は数十字)と並べたときに件数が埋もれる。skill の箱は率の決まりと列の見出し(「失敗率(呼んだ / 呼ばない)」。見出しは折り返さないので長くすると表が箱からはみ出す)を変えず、注の頭に「失敗率: ツールの失敗・拒否 / 呼び出し」と「差は skill が原因とは限らない」の 1 文を足した(`insights.html` の skill の節も同じ言い方)。
- **vault の中に置いた skill**: Copilot の `skill.invoked` に、skill のファイルの場所 `path` が載ることをイベントの形式で確かめた。今までは skill ツールと対にならない `skill.invoked` だけを `path` で判定していたので、skill ツールと対になった側でも、ツールの引数から wiki の skill と分からなかったときは `path` で判定して足す(二重には数えない)。
- **前の集計と件数が変わるところ**:
  - 参照の定義を変えたことで変わるもの: 集計明細・プロジェクト別・人別の wiki の件数(書き込みだけのセッションが減り、検索・一覧だけのセッションが増える)。`extract` のログ(「参照したセッション N 件・書き込みだけ M 件」に分けた)。詳細ページの欄の出る・出ないと `metrics.json` は、どちらも「vault に触れた」で決めるので、この変更では変わらない。
  - vault の中の skill の数え直し(上の項)で、集計し直すと増えることがあるもの: `sessions.json` の wiki の skill の呼び出しと `metrics.json` の `wiki.skillCalls`、`metrics.json` の `wiki.sessionsWithAny`、それまで vault に触れていなかったセッションの詳細ページの「llm-wiki の参照」の欄(新しく出る)、各画面の参照したセッションの件数。
  - 記録の版は変えていない(`sessions.json` 19、埋め込み 17、`metrics.json` 6、判定のスキーマ)。
- **採らなかった案**:
  - 普段のログで、参照あり / なしのセッションの率(失敗率・手戻り率など)を並べる: 参照するかは作業の中身で決まり、差の原因が分からない。数えない読みが「なし」の側に混ざる。
  - 「比べる」の条件に wiki の利用の有無を足す: 上と同じ理由で、差と差の幅を出しても wiki の差とは読めない。
  - 参照 1 件ごとの記録と、それを並べる別のページ: 件数の問いには要らず、`sessions.json` の形を変えることになる。
  - 課題 × 条件に差・差の幅・順位を出す: 表を足したときの決めごと(並べるだけ)のまま。1 つの条件が数回では、幅が広すぎて読めない。
  - 判定の `wikiEffect` を集計して並べる: LLM の推定で、パケットには参照の回数しか無い。判定と数えたものを混ぜない。
  - 読んだセッション(索引・個別ページだけ)で並べ直す: wiki の skill が中で読むセッションや、検索から読みに行くセッションが外れる。数え方を 1 つにする目的とも逆になる。
  - 段階や回数で分ける(索引だけ / ページまで、1 回 / 何回も): 回数の多さが何を意味するかは作業で違い、決まりを置けない。
- **残る限界**: `metrics.json` の `sessionsWithAny` は名前どおり「vault に触れた」のままで、画面の「参照した」件数と合わない(意味を変えると、読む側の版を上げることになる)。引数に vault の場所が出ない読み(相対パスだけの読み、vault の場所を渡さない MCP 経由の読みなど)と、指定に入っていない vault は数えない(「参照なし」に参照したセッションが混ざる)。シェルで vault に書いた呼び出しは、書き込みでなく参照に入る(パスの形によって、索引・個別ページ・その他のどれか)。件数は指定した vault をまとめて数え、vault 別には分けていない。記録の無い古い集計で、参照したセッションが 1 件でもあれば「数えた」とみなす。古い集計(記録なし)の詳細ページは、今までどおり「参照はありません」と出る。

### llm-wiki のページごとの参照率と役立った率(2026-11-17)

- **きっかけ**: 持ち主が知りたいのは、wiki 全体の利用の件数ではなく、ページごとに「どれだけ読まれたか」と「読んで役に立ったか」。単位はページ、「役立った」は LLM の判定で決める、と持ち主が決めた。
- **決めたこと(参照率)**: 読んだページの名前(本文は入れない)を、埋め込みのデータの上の辞書 `wikiPageNames` に 1 回だけ置き、セッションの要約には、読んだページ(重複を除いて読んだ順)の番号を `wiki.pages` として足し、埋め込みの版を 17 → 18 にした(Rust と TS の型・版の定数・辞書の並び・既定値で落とす形をそろえる。空なら落とすので、ページを読まないセッションは大きさが変わらない)。名前を要約ごとに持つ最初の形は、大きな vault を毎週全部読む使い方で atlas.html が MB 単位で増え、上限の 5MB に近づくので、独立レビューの指摘で辞書にした(件数での切り捨てはしない)。参照率 = そのページを読んだセッション ÷ wiki を参照したセッション(絞り込み後。`wikiReferenced` で数える)。ログで分かるのは「読んだ」ことまでなので、画面の言葉は「引用率」でなく「参照率」にし、注に「回答の中で引用したかは見ていません」と書く。版 17 以前の埋め込みにはページの名前が無いので、版で見分けて表を出さず、理由を出す(既定値で `[]` に埋め戻すので、空と無いを中身では見分けられないため)。
- **決めたこと(役立った率)**: 工数の判定(`judgments.json`)のセッションの項目に `wikiPages: [{ page, helpful: yes | no | unknown, reason }]` を足し、判定のスキーマの版を 1 → 2 にした(読むときは 1 も受け付け、版 1 の判定のページは未判定)。判定役が見立てられるよう、パケットに、判定に載せるページごとの読んだ時刻・依頼の番号・読んだ後のツール(5 件)・抜粋(読んだツールの結果の先頭。秘密らしい文字列を `redact_secrets` で伏せてから 400 字に切る)を入れる。その後の流れ(依頼・最終応答・変更ファイル)はパケットのほかの節にあるので足さない。抜粋がログに無い形なら「抜粋なし」と書き、名前と前後の流れだけで判断させる。判定に載せるのは 1 セッション 10 ページまでで、残りは未判定(パケットが大きくなりすぎないように。抜粋の字数はパケットの上限に合わせてほかの本文と一緒に下げる)。基準は rubric に書いた(yes = 中身が後の作業に使われ作業を進めた、no = 使われなかった・誤った方向に導いた、unknown = 記録から判断できない)。`wikiPages` が無い・配列でない・要素が壊れているときは、ほかの判定を捨てずにそのページを未判定にし、壊れているときだけログに知らせる(`judge run` は件数の 1 行にまとめ、補足の先頭 5 件に埋もれないようにする)。`judgments.json` は、どの項目も `wikiPages` を持たない間は版 1 で書く(前の版の atlas.exe は版 2 を読めず build が止まるため)。抜粋を取る呼び出しは、束を作るときに設定の vault の指定で集計と同じ分類器を当てて決める(名前だけで探すと、vault の直下のページがプロジェクトの同じ名前のファイルに当たる、区切りが二重の形を見落とす、失敗した読み取りやサブエージェントへの依頼文が抜粋になる、`a.md.bak` に当たる、の 4 つで誤るため。独立レビューの指摘)。設定に指定が無いときだけ名前で探し、区切りのまとめ方・名前の境目・失敗と本文なしの読み取りを飛ばすこと・サブエージェントへの依頼を除くことは同じにする。パケットに無いページの名前は、レポートを作るときに捨てる(読んだページの先頭 10 件という同じ決まりで、Rust と TS の両方で落とす)。役立った率 = 役立った ÷(役立った + 役立たなかった)で、分からない・未判定は分母に入れずに件数を並べる。
- **閾値**: 参照率は wiki を参照したセッション、役立った率は役立った + 役立たなかったが、改善点のほかの率と同じ `THRESHOLDS.MIN_SESSIONS` に届かなければ「—」。新しい閾値は置かない。
- **置き場所**: 改善点の「絞り込みに従う」群の最後に、幅いっぱいの箱で表を出す(上位 10 行、残りは「全件を表で見る」)。数えていない・記録なしの扱い(`wikiStateNote`)を「llm-wiki の利用」の箱と同じに使え、絞り込みにも従うため。利用ランキングの切り替えに足す案は、隣の切り替えがどれもログの回数だけで、LLM の見立ての列を混ぜることになり、数えていない集計の理由も持っていないので採らなかった。改善点の節は LLM を呼ばない集計なので、見出しの説明と箱の注に「役立ったかの列だけは LLM の見立て」と書いた。詳細ページの「LLM による判定(推定)」には、ページごとの見立てと理由を出す(理由は埋め込まない)。
- **分けたまま並べる**: ログで数えた参照率と、LLM の見立ての役立った率は別の列で、1 つの点数にしない。セッション全体の `wikiEffect`(−2〜+2)は残し、この表には使わない。判定は今までどおり、持ち主が judge を回したときだけ(どの経路で作った判定も同じ項目で読む)。
- **採らなかった案**:
  - vault ごとに数える: 持ち主の問いはページの単位。vault を複数指定したときは、ページの名前の先頭に vault の名前が付くので、ページの行から分かる。
  - 今の `wikiEffect` をページに割り振る: セッション全体の見立てで、どのページが効いたかの情報を持たない。読んだページの数で割ると、たくさん読んだセッションのページほど薄まる。
  - 結果(テストの合否・手戻りなど)との相関で見る: 読むかどうかは作業の中身で決まり、差の原因が分からない(「llm-wiki の利用」の箱で率を並べない理由と同じ)。
- **残る限界**: 役立ったかは LLM の見立てで、測った値ではない(判定役が見るのは名前・抜粋・パケットの流れまで)。読んだことと、回答の中で引用したことは別で、引用は見ていない。引数に vault の場所が出ない読み(相対パスだけの読み、vault の場所を渡さない MCP 経由の読みなど)は、ページとして数えない(参照率の分子に入らない)。抜粋は、そのページを読んだ最初の成功した呼び出しの結果で、検索の結果のように複数のページが 1 回で出たときは同じ抜粋を共有する(パケットにそう書く)。設定に vault の指定が無いときは名前で探すので、vault の直下のページはプロジェクトの同じ名前のファイルと見分けられない。判定に載せるのは 1 セッション 10 ページまで。vault の指定を変えると(vault を足して複数にする・個別ページのフォルダを変えるなど)ページの名前の付き方が変わり、前の判定のページの名前と合わなくなって、そのページは未判定になる(判定し直すと付く)。

### llm-wiki の箱の見つけ方と、ページの表の操作(2026-11-17)

- **きっかけ**: 持ち主が「wiki の参照数はどこで見るか」「どのページを読み、どのページが役立ったか」を画面から探せなかった。箱は改善点の中にあり目次から直接行けない、ページの表から読んだセッションに行けない、wiki を読んだセッションだけで絞れない、の 3 つが原因。
- **決めたこと**:
  - 目次: 改善点の下に「llm-wiki」(`#insights-wiki`。「llm-wiki の利用」の箱)を足す。数えていないレポートでは出さない。
  - 絞り込み: `FilterState.wiki`(`''` / `'1'`。hash の `wiki=1`)を「その他の条件」に足す。数え方は `wikiReferenced`(書き込みだけは入れない)で、TS(`filter.ts`)と Rust(`filter.rs`)の `matches` をそろえ、パリティの例 `filter-wiki` で確かめる。数えていないレポート・参照したセッションが 0 件のときは出さない(hash に残っているときは外せるよう出す)。
  - ページの表: 名前を押すと、そのページを読んだセッション(詳細へのリンク)とそれぞれの見立てを開く(`WikiPageRow.readers`)。並べるのは 50 セッションまで。列の見出しで並べ替え(`sortWikiPageRows`。率が無いページはどちらの向きでも後ろ)。名前は全ページに共通のフォルダと `.md` を除いて出し(`shortPageNames`。除くと重なるなら `.md` は残す)、元の名前を title に出す。
  - どのページも「—」の率の列は出さず、理由を注に書く。閾値は今までどおり `THRESHOLDS.MIN_SESSIONS` を実行時に読む(件数に合わせた新しい決まりは置かない)。参照率と役立った率は別の列のまま。
- **採らなかった案**: 改善点の外に wiki の節を新しく作る(「llm-wiki の利用」の箱の数えていない・記録なしの扱いと、絞り込みに従う群の決まりを二重に持つことになる)。

### LLM 判定の範囲をタスクタグ・1 セッションに絞る(2026-11-18)

- **きっかけ**: 持ち主が、LLM 判定をタスクタグやセッションの単位でできるか、セッションの詳細ページから判定できるかを尋ねた。コマンド(`bundle --session` / `--group`、`judge run --only`)ではできたが、画面の「判定する…」はいつも未判定のすべてのセッションが相手で、詳細ページには判定の入口が無かった。あわせて、判定済みかどうかを見て分かるようにしたい、と持ち主が決めた。
- **決めたこと**:
  - サーバの判定の仕事(`jobs.rs` の `JudgeScope`)に、`session`(`sessions.json` にある ID)か `group`(`groups.json` にある名前)の範囲を足す。両方の指定は 400、知らないセッション・タグは 404。仕事は `judge-flow` に `--session=` / `--group=` を渡す(値が `-` で始まっても読めるよう `=` でつなぐ)。件数の確かめ(`jobs/judge-preview`)も同じ `?session=` / `?group=` で数える。範囲の確かめ方(セッション ID の形、空のタグ名は 400 など)は、仕事を始めるときと件数の確かめで同じ関数(`jobs.rs` の `judge_scope`)を使う。
  - `groups.json` が壊れている(読めなかった箇所がある)ときに名前が見つからなければ、「無い」(404)とは言わず、読めなかった箇所を添えて 409 にする(壊れた所にそのタグがあるのかもしれないため)。ファイルが無いときは 404 のまま。
  - `jobs/judge-preview?target=turns` は、依頼ごとの判定で 1 回にまとめる依頼の数の上限(`chunk`。`DEFAULT_TURN_LIMITS.chunk_turns`)も返す。画面の「約 N 回以上の判定」はこれで割る(返さない古いサーバのときだけ 6)。
  - 絞るのは判定する範囲(バンドル)だけで、`judge-flow` の最後の `export` は絞り込みをすべて外し、レポート全体を作り直す(絞った範囲でレポートを作ると、ほかのセッションが消えた画面になるため)。
  - 「判定する…」の「このツールが判定する」に「判定する範囲」(すべて / 左で選んだタスクタグ)を足し、タグを選んでいればそれを選んだ状態で開く。工数と依頼ごとのどちらでも同じ。
  - 詳細ページ(`atlas.bat` から開いたときだけ)に、そのセッションだけを判定するボタン(工数・依頼ごと)を足す。押したら、何を判定するか・モデル・費用(AI クレジットか、BYOK なら API の利用料)を確認してから始める。終わっても自動では読み直さず「読み込み直す」を出す(メモの入力中などを消さないため。「集計し直す」と同じ)。
  - 判定し直す(`force`)は、詳細ページの工数の 1 セッションだけに許す。サーバも `session` の無い `force` を 400 で断る。
  - 済み具合は、詳細ページの表題の下の印(「LLM 判定(工数)」「LLM 判定(依頼ごと)n / m 件」)と、一覧の「依頼」の列の印で見せる。済んだ印には ✓ を付け、色だけで伝えない。未判定は欠測と同じ薄い色(ink-3)。依頼ごとの印は、レポートに依頼ごとの判定が 1 件でもあるときだけ出す(使っていない人の一覧に「未判定」を並べないため)。
- **採らなかった案**:
  - タスクタグやすべてのセッションでの判定し直し: 押し間違いで、判定済みの多くのセッションの分の AI クレジットを使ってしまう。まとめて判定し直すときはコマンドの `--force` を使う。
  - 判定の後に自動で読み直す: 「集計し直す」と同じ理由(入力中のものを消す)で採らない。
  - 「チャットに貼って判定する」「ZIP にまとめて…」の範囲も絞る: 添付・ZIP を作る手順と取り込みの確かめが範囲を持つことになり、手順が増える。範囲を絞りたいときは「このツールが判定する」かコマンド(`bundle --group`)を使う。
- **残る限界**: 依頼ごとの判定は塊(6 依頼まで。長い依頼が続けばもっと少ない)ごとに `copilot -p` を呼ぶので、詳細ページの 1 セッションでも、未判定の依頼が多ければ何回も呼ぶ(確認に「約 N 回以上」と出す)。上限は塊の単位で確かめるので、タスクタグで絞ったときも 1 塊の分まで上限を超えることがある(前からの動き)。詳細ページの判定は、ほかの処理が動いているときは押した後に断る(押す前には分からない)。`file://` で開いた画面と詳細ページには入口が出ない。

### atlas.html をタブで分ける(2026-11-20)

- **きっかけ**: atlas.html は 15〜20 の節が 1 本の長いスクロールに並び、目当ての節に行くまでが長い。利用者からタブに分けたいと依頼があった。atlas.html は今までどおり 1 つの HTML(`file://` で開く・fetch しない・外部を読まない・5MB 以下。上の「HTML の方針」)のままにする。
- **決めたこと**:
  - タブは目次の群のうち 概況 / 内訳 / 一覧 の 3 つ(付録は別ページへのリンクのまま)。節の分け方と名前は変えない。開いたときは概況。
  - どのタブの節も描いておき、ほかのタブは `hidden` で隠す(`App.svelte` の `data-tab-panel`)。ページ内リンクの行き先は `getElementById` でそのまま引け、節の中の処理は変えない。印刷ではどのタブも出す(タブの帯は出さない)。月別推移のグラフは、隠れている間に測った幅 0 を使わず、最後に測れた幅で描く(印刷で潰れないため)。
  - URL ハッシュに `tab=breakdown` / `tab=list` を足す(概況は書かない。id は URL に残るので変えない)。絞り込み(`FilterState`)には入れず、条件の数にも「解除」にも入らない(`filter.ts` の `decodeTab` / `encodeState`。`filterHref` の 3 つ目の引数。2 つで呼べばこれまでと同じで、Rust の `filter_href` と同じ形)。絞り込みを変えて URL を書き換えるときは今のタブを残す。
  - タブを開くのは、本文の上端のタブの帯・サイドバーの群の題・狭い幅の目次の行の先頭。どれも `aria-current="page"` のリンクで(ARIA の tablist にしない。URL で開ける画面なので、戻る / 進む・新しいタブで開くが効くように)、押すと履歴に積む。帯より下までスクロールしていれば、帯が上端に来る位置へ移る(ページの先頭までは戻さない)。
  - ページ内リンク(詳細ページからの `atlas.html#phases`、`#exec-modes-h`、目次の別のタブの節、`#main`)は、行き先が隠れたタブにあれば、先にそのタブを出してから行き先へ移る(開いたとき・押したとき・`hashchange`・戻る / 進む)。表示の指定(`view=`)のリンクは行き先のタブで終わり、URL には `view=` を残さず絞り込みとタブだけに書き換える(絞り込みが変わらなくても。残すと、戻る / 進むでその項目に来るたびにその場所へ飛び直す)。要点の「このツールを使ったセッションに絞り込む」は `view=sessions` を付けて一覧のタブへ移す(TS と Rust の `highlights` をそろえた。これまでは `view` の無い絞り込みのハッシュをすべて一覧へ移していたが、それだとタブを戻る / 進むでも一覧へ飛ぶ)。
  - 戻る / 進む: `popstate` で、移った先の URL の絞り込みとタブを両方当てて描き直してから(`flushSync`)位置を戻す。イベントは popstate → ブラウザが位置を戻す → `hashchange` の順に来るので、絞り込みを `hashchange` まで待つと、戻した後で上の節の高さが変わり、ブラウザのスクロールの固定(scroll anchoring)で位置がずれる(要点の絞り込みのリンクから戻ったときに数百 px ずれた)。`hashchange` は同じ絞り込みなら置き換えない。タブが変わるときは、その履歴の項目に残した位置(スクロールが止まったときとページ内リンクを押す前に `history.state` へ書く。`view-restore.ts` と同じ印)へ戻す。戻している間(0.5 秒)はスクロールの位置を書かない(途中の位置を残さない)。再読み込みと別のページから戻ったときは今までどおり `restoredView()`。
  - どのタブにも入っていない行き先へのページ内リンク(「本文へ移動」の `#main`)は URL を書き換えず、スクロールと焦点だけ移す(書くと `tab=` が消え、再読み込みで概況に戻る)。
  - タブを切り替えて、焦点のあった要素が隠れたタブに入ったら(戻る / 進む・ページ内リンク)、焦点を帯の今のタブのリンクへ移す(スクロールはさせない)。
  - 目次の現在地の印は今のタブの節だけで決める。狭い幅の目次の行は、タブ → 今のタブの節 → 付録 の順(行の高さと「タスクタグ」のボタンはそのまま)。
  - 網羅チェック(`scripts/ui-audit.ts`)は本文のタブを 1 つずつ開き、その中の切り替え(利用ランキングの種類など)も押して見る(陽性コントロールは `ui/audit.test.ts`)。
- **採らなかった案**:
  - タブごとに別の HTML に分ける: 渡すファイルが増え、絞り込みをファイルをまたいで持ち回る仕組みが要る。1 ファイルのまま `file://` で開ける今の形を崩す。
  - 節を組み替える・タブの名前を付け直す: 目次の群(概況 / 内訳 / 一覧)は読み手に馴染んでいて、群と節の対応も文書(画面の見方)にある。組み替えはタブとは別に決めることにする。
  - 隠れたタブを描かない(`{#if}`): ページ内リンクの行き先を引けず、節ごとに今の状態(並べ替え・開いた欄)が切り替えのたびに消える。
  - Ctrl+F をどのタブにも効かせる: ブラウザのページ内検索は隠れた節を探さない。今開いているタブだけを探すと文書に書く(ほかのタブはそのタブを開いて探す)。
- **戻し方**: `App.svelte` の `.tab-panel` の `hidden` を外し、タブの帯と目次のタブのリンクを消せば 1 本のスクロールに戻る(URL の `tab=` は読まれなくなるだけで、古いブックマークも開ける)。`highlights` の `view=sessions` はそのままでも、一覧の節へ移る動きは変わらない。

### タスクタグをやめ、管理ツールとの連携に置き換える(2026-11-23)

- **決めたこと**(利用者の判断): タスクタグ(画面と保存先では「グループ」。`atlas-notes/groups.json`)をやめる。セッションをタスクに結びつけるのは、管理ツールが書き出すタスクの一覧との連携に置き換える(次の変更で入れる)。タスクで絞り込む操作だけは、連携したタスクで作り直す。
- **やめたもの**(置き換えずに外す):
  - タスクタグを付ける・外す・名前と説明を変える・消す操作(セッション一覧の「タスクタグを付ける ▾」、詳細ページの付け外し、サイドバーの「タスクタグ」の群、本文の先頭の見出し)。
  - タスクタグの書き出し(`out/groups/<名前>/`)と、タスクタグのアップロード(`<送り先>\<タグ名>\`)。
  - コマンドの `atlas group`(list / add / remove / export / upload)と、絞り込みの `--group`。
  - LLM 判定の範囲をタスクタグに絞ること(画面の「判定する…」とサーバの API)。1 セッションに絞る判定(詳細ページ・`--session`)は残す。
  - 「比べる」のタスクタグどうしの並べ比べ。期間・プロジェクト・工程・推論強度は残す。
  - 「課題 × 条件」の節と、その中の「利用の確認」、表の `conditions.csv`(と `atlas.sqlite` の `conditions`)、`sessions.csv` と `test-runs.csv` の課題・条件の列。テストの結果の取り込みと、その表(`test-runs.csv`・`test-results.csv`・`test-counts.csv`、`sessions.csv` のテストの列)は残す。
  - 送るときに添えていた各セッションのタスクタグ(`atlas-session.json` と `atlas-index.json` の `tags`、`README.md` のタスクタグの列とタグごとの一覧)。
- **残したもの**: プロジェクトのアップロード(`upload-project.bat`・画面の「まとめて送る」の印・毎日自動で送るタスク)はそのまま。写し方の中身(前に送ったときから変わったセッションだけを写す・秘密らしい文字列の点検など)はタスクタグのアップロードと共通だったので、名前を変えて残した(`crates/atlas-cli/src/upload_copy.rs`)。
- **前の版のファイル**: 利用者の PC にある `atlas-notes/groups.json` は読まず、消しもしない。前の版で送ったセッションの `atlas-session.json` の `tags` は読み飛ばす(ほかの項目はそのまま読む)。前の版でタスクタグを送ったフォルダは、そのまま集計し直せる。同じフォルダ名のプロジェクトは混ざるので送らない(送り先を変えてもらう)。前の版の URL の `#group=…` は読まずに捨てる。前の版が書いた `conditions.csv` は、集計し直すと消す。
- **埋め込みの版**: レポートに埋め込むデータの版を 19 に上げた(`groups` をやめた)。

#### 管理ツールとの連携(同じ日に入れた)

- **読むもの**: 管理ツールが書き出した XML から、タスクの ID・名前・状態の 3 つだけを読む。手元に実物の書き出しが無いので、読み方(タスクの要素の名前、3 つの項目の属性か子の要素か、完了とみなす状態)を設定の `tasks` で決める形にした。名前空間は見ず、入れ子のタスクも 1 件と数える。外部の実体や DTD は読まない。64 MB を超える XML は読まない。
- **完了の時刻**: タスクを完了と最初に見た XML の、ファイルの更新時刻を「完了を確認した時刻」にする(初めて見たときに完了していたら、そのときの時刻)。管理ツールの完了の日時は書き出しに無いことが多いので、時刻は書き出しの間隔の分だけ遅れる。完了から戻ったら消す。XML から消えたタスクは最後の値のまま残す。同じ更新時刻・同じ読み方なら読み直しても変えない。読めなかったときは前の状態のまま続け、注意をレポートに出す。
- **紐づけの優先**: 手動 > LLM > 機械。機械の紐づけ(題名と依頼の文に ID か名前が当たる。ちょうど 1 つのタスクに当たったときだけ)は集計のたびに決め直すが、LLM と手動の紐づけは変えない。LLM は機械で決まらなかったセッションだけに、頼んだときだけ聞く(集計では呼ばない)。手動で「自動に戻す」と、機械の紐づけをすぐ決め直す(LLM には聞き直さない)。候補は、未完了のタスクと、セッションの開始より後に完了を確認したタスク(始める前に終わったタスクには紐づけない)。
- **2 つの工数**: AI を使わなかった場合の工数は、今の推定人手工数(確信度の低い推定は入れない、という全体サマリと同じ決まり)の合計。AI を使った場合の工数は、紐づいた最初のセッションの開始から完了を確認した時刻までのうち、稼働時間帯(既定は月〜金の 9:00〜18:00、この PC の時刻)に入る時間。祝日は持たない(国や会社で違い、設定を増やすほどの理由がまだ無い)。AI の実働も並べる。3 つは別の欄・別の列に並べるだけで、1 つの点数にしない。
- **比べられるタスクと比**: 合計は、完了していて、紐づいたセッションのすべてに確信度の低くない推定があるタスクだけで出し、外したタスクは理由(未完了・開始が分からない・判定なし・確度が低い)ごとに数える。比(AI を使わなかった場合 ÷ AI を使った場合)は、比べられるタスクが下限に届いたときだけ出す。下限は改善点の率と同じ表示の決まり(`insights::thresholds::MIN_SESSIONS`)で、どこかの環境の件数に合わせたものではない。値は Rust で決めて埋め込み、画面は数え直さない(TS と Rust の突き合わせが要らない)。
- **画面**: 概況に「管理ツールのタスク」の節(AI 投入量 vs 推定人手工数の次)。数の欄の組と工数の欄の組を分けた(狭い幅でも 2 つの工数が隣り合うように)。節の値は絞り込みに従わない(集計のときに決めた値だから)ことを説明に書く。タスクの表の名前を押すとそのタスクに絞り込む。絞り込みの行に「タスク」を足した(`#task=<ID>`、タスクなしは `task=(none)`)。タスクタグのときのようにサイドバーに一覧を置くのはやめた(管理ツールのタスクは数百件になりうるので、選ぶ欄の方が扱いやすい)。絞り込みは TS(`filter.ts`)と Rust(`filter.rs`)の両方に足し、`npm run parity:lib` で同じ結果になるかを見る(紐づけは決まった割り振りを両側で使う)。serve から開いた画面は `GET /api/tasks` で今の紐づけを読む(詳細ページで直した分が、集計し直さなくても出る)。
- **詳細ページ**: 表題の下に「タスク」の行。この PC の画面だけ、「変える…」で探す欄・選ぶ欄・「このタスクにする」「どのタスクでもない」「自動に戻す」を出す(読むだけの画面には出さず、サーバも書き換えを断る)。
- **LLM のボタン**: 「判定する…」の隣に「タスクを LLM で紐づける…(件数)」。費用がかかるので判定と同じく確かめてから始める。設定にもタスクの記録にも `tasks` が無ければボタンを出さない(使わない人の画面を増やさない)。聞くセッションが無い・読むだけの画面・ほかの処理の実行中は `aria-disabled` にして、理由を読み上げとボタンの説明に出す。
- **送るとき**: 紐づいたセッションの `atlas-session.json` と `atlas-index.json` に `task`(ID・名前・状態・完了・完了を確認した時刻・開始・出所)を添える。送り先では XML を読まず、この記録からタスクの節・絞り込み・工数を作る(稼働時間帯は送り先の設定)。
- **埋め込みの版**: 20 に上げた(`tasks` を足した)。
- **採らなかった案**: 完了の時刻を XML の中の日付の項目から取る(管理ツールごとに項目と書式が違い、無いこともある。必要になったら読み方の設定に足す)。祝日の一覧を持つ。2 つの工数の差や比を 1 つの指標として目立たせる(推定どうしの比で、良し悪しの評価ではないため、欄の 1 つに留めた)。

#### 連携の見直し(同じ日の審査を受けて)

- **同時に書く**: 画面の手動の紐づけ(serve)・LLM で紐づける処理(別のプロセス)・集計が同じ `task-links.json` を書くので、プロセスをまたぐロック(`<ファイル>.lock` を排他で作る。設定ファイルと同じ形)の中で読み直し、自分の変更だけを足して書く。前は LLM の処理が最初に読んだ全体を書き戻し、聞いている間の手動の紐づけを消していた。`tasks.json` も同じロックで読み書きする。
- **LLM の「どのタスクでもない」**: 候補が無いセッションには聞かず、何も書かない(書くと、後でタスクが増えても聞き直さない)。LLM が「どのタスクでもない」とした紐づけは、機械の当たりがちょうど 1 つに決まれば置き換える(LLM がタスクを選んだ紐づけと手動の紐づけは、機械では変えない)。「自動に戻す」は LLM の紐づけにも使える。LLM に渡す候補は、機械で 2 つ以上に当たったタスクを先に置く(上限で切られないように)。
- **当たりの重なりと数字の ID**: 重なった当たりは長い方だけ(`DEMO-102-1` の中の `DEMO-102`、長い名前の中の短い名前は数えない)。数字だけの ID は `#<数字>` だけを探す(件数などのただの数字に当たりすぎるため。`ID 101` のような書き方まで広げると規則が増えるので、まずは `#` だけにした)。
- **完了の時刻を見ていないタスク**: 初めて見たときに完了していたタスクは `doneObserved: false` で、完了とは出すが、工数を数えず「完了の時刻が分からない」として比べない(`doneAt` は完了した時刻ではなく、初めて読んだ時刻のため)。完了を確認した時刻より後に始まったセッション(手動か LLM の紐づけだけでありうる)は開始に使わず、そのタスクを「完了の後に始まったセッション」として比べない(推定人手工数に完了の後の作業が混ざるため。工数から外すだけにする案は、推定と工数の範囲がずれるので採らなかった)。前に読んだものより古い XML では状態を変えずに注意を出す。
- **`all` の順と `metrics` の設定**: `all` は `metrics` の前にタスクを処理する(`metrics` と `build` が同じ紐づけを使い、初めての集計でも `--task` で絞れる)。`metrics` も `--config` を読む。
- **画面と API**: `GET /api/tasks` はレポートと同じ関数と、同じゆるい読み方の `judgments.json` で数える(前は API だけ厳しい読み方で、項目の欠けた判定ファイル全体を読まず、値が埋め込みとずれた)。絞り込んで作ったレポートは `tasks.scoped` を持ち、画面は API の値で置き換えない。
- **送った人の記録**: 食い違うときは「完了と見た人がいれば完了」ではなく、いちばん新しく見た記録を使う(後で開き直されたタスクを完了のまま出さないため)。日時は 2000-01-01 から読んだ時刻の 1 日後まで、開始から完了まで 3,660 日までを受け付ける。稼働時間帯の数え方も最大で約 10 年分までにした。XML の節の数の上限は 2,000,000 にした。属性が空なら子の要素を見る。

#### 連携の見直し(2 回目の審査を受けて)

- **ロック**: `<ファイル>.lock` を排他で作り、古いものを消して取り直す形は、待っている 2 人が同時に消して作り直すと 2 人とも取れた。OS のファイルのロック(Rust の `File::try_lock`。Windows は LockFileEx、ほかは flock)に変えた。ロックはハンドルに付くので、落ちたプロセスのロックは OS が外し、古いロックを消す手順そのものが要らない。`.lock` のファイルは消さずに残す(消すと、開いたままの別の書き手と別のファイルを取り合う)。ロックは Drop で外す(f が panic しても残らない)。待つのは別の書き手が持っているときだけで、開けない・ロックできないときはその理由で止まる。serve は待ちきれなかったとき・壊れたファイルのときは 409、ほかは 500。
- **完了を見たか**: 読み方を変えたせいで完了になったものは見ていないとする(同じ読み方の 2 回の読み込みで変わったときだけ見たとする)。読み方の目印からファイルの場所を外し、場所は `source.path` に別に持つ(ファイルを移しても、完了の見方は変えない)。
- **古い XML**: 同じファイル・同じ読み方のときだけ止める。前に読んだ時刻が今より 1 日以上先なら止めない。注意に直し方を書く。
- **送った人の記録**: 完了を確認した時刻は、いちばん新しい記録と同じく完了で、完了に変わるのを見た記録のうち最も早いもの。
- **XML の節の数**: roxmltree が数えるのは要素・文字(字下げの空白も)・コメント・処理命令と根で、属性は数えない。字下げした書き出しで節はおよそ 13 バイト、1 文字の値ばかりでも 5 バイトほどだったので、上限をファイルの大きさ ÷ 4(少なくとも 100,000)にした(固定の 2,000,000 では、64 MB の書き出しが読めなかった)。
- **数字だけの ID**: 2 文字未満は `#` を付けても探さない。`#<数字>` は PR や課題の番号の書き方と同じなので、誤って紐づくことがあると README に書いた。
- **LLM に聞く件数**: 画面の確認の件数と `tasks link --llm` の対象を同じ関数(`links::llm_eligible`。紐づけが無い・開いただけではない・題名か依頼の文がある・候補のタスクがある)で決める。確認の答えは開き直したら古いものを捨て、20 秒で答えが無ければ理由を出す。
