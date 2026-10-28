# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript / Node 24 / npm workspaces。レポートは Vite + Svelte 5 を単一 HTML(`out/atlas.html`)にビルドし、`file://` でサーバ無しに開く。CLI は `@atlas/cli`、抽出・集計は `@atlas/core`(docs/PLAN.md で確定済み)。

## Users

- 主利用者: 作者本人(個人開発者)。GitHub Copilot(デスクトップ autopilot / CLI / SDK)を主軸に複数プロジェクトを開発しており、自分の AI 活用を定量的に振り返りたい。
- 二次読者: 作者がレポートを共有する相手(チームや発表の聴衆)。元セッションを知らないため、文脈なしで読める説明が要る。プロジェクト名や経路を伏せて共有する場合がある。
- 閲覧環境は PC ブラウザが主。モバイルは崩れなければよい。

## Product Purpose

`~/.copilot` のセッションログ(events.jsonl、session-store.db 等)から、トークン使用量とコスト、skills / agents / hooks の利用、指示ファイルの注入、llm-wiki の参照、摩擦(compaction・abort・ask_user・permission・error)を **LLM を使わずに**抽出・集計し、プロジェクト別・期間別に可視化する。さらに「各タスクを人手でやった場合の工数」を LLM に推定させる評価バンドルを出し、外部 LLM(M365 Copilot 等)でもツール内(`copilot -p`)でも同じ形式 `judgments.json` で戻してレポートに合成する。

成功の定義: 各プロジェクトについて「AI にどれだけ投入し、どれだけの摩擦があり、人手比でどれだけ削減できたと推定されるか」が一画面で読め、絞り込みで根拠のセッションまで辿れること。

## Positioning

- ローカル完結。ログは手元で複製してから読み、元の `~/.copilot` を一切書き換えない(mtime 不変を E2E で保証)。
- Copilot の全クライアント(autopilot / cli / sdk / vscode)と、新旧のログ形式(usage_record の有無、skill の記録形式の違い)を一つの正規化レコードに揃える。
- 「集計(機械)」と「判定(LLM)」を分離し、判定は外部でも内部でも同じスキーマで往復できる。推定値は常に推定と明示する。

## Operating Context

- 入力: `%USERPROFILE%\.copilot`(Windows)。Copilot が並行して書いている可能性がある。
- 実行: `atlas.bat` または `npm run atlas` で snapshot → extract → metrics → build。判定は別コマンド。
- 出力: `out/atlas.html`(単一ファイル、集計と要約のみ埋め込み)、`out/sessions/<id>.html`(詳細)、`out/sessions.json` / `metrics.json` / `bundle/` / `judgments.json`。
- 共有: HTML をそのまま相手に渡す。共有時はプロジェクト名・パスを伏せ字にするオプションを使う。

## Capabilities and Constraints

- 実データの規模(2026-10-28): セッション 756、events.jsonl 合計 512MB、session-state 全体 1.4GB。入力トークンが分かるのは 128 セッション、出力のみ 46、無し 582。この欠測を UI で隠さない。
- HTML に生イベントは埋め込まない(サイズ上限の目安 5MB)。`file://` で動くため fetch は使えない。
- フィルタ軸: プロジェクト、期間、クライアント、モデル、ブランチ、タスク分類(judgments があれば)、入力トークン記録の有無。
- 用語: nano AIU(AI クレジットの内部単位)、compaction(文脈圧縮)、skill / agent / hook(Copilot の拡張機構)、指示ファイル(AGENTS.md / CLAUDE.md / copilot-instructions.md)、llm-wiki(作者の個人ナレッジ vault)。
- 判定バックエンドは既存サブスク内(`copilot -p`、opencode 無料モデル)を既定にし、従量課金は明示指定のみ。
- 未決: 判定結果の品質をどう検証するか(人手評価との突合せ)は Phase 3 以降で決める。

## Evidence on Hand

- 実データ一式(手元のみ、リポジトリには入れない)。
- テスト時に架空の値だけで生成する fixture(`scripts/synthetic-fixtures.ts` → `.fixtures/`。リポジトリには置かない)と、既知のイベント種別名の一覧(`packages/core/src/event-types.ts`)。
- 集計の実出力 `out/live/sessions.json` / `metrics.json`(gitignore)。
- 存在しないもの: 人手工数の実測値、利用者の声、ベンチマーク。これらを捏造しない。

## Product Principles

1. 欠測を隠さない。推定は推定、記録なしは記録なしと表示する。
2. 元データを汚さない。読むだけ、複製してから開く。
3. 一画面で全体 → 絞り込み → 根拠のセッション、の順に辿れる。
4. 共有可能。文脈を知らない読者が用語の説明を見つけられ、固有名を伏せられる。
5. 判定(LLM)は差し替え可能で、集計(機械)の正しさに依存させない。

## Accessibility & Inclusion

ライト/ダーク両対応。色だけに頼らない(凡例・ラベル・パターン)。キーボードでフィルタ操作ができること。日本語 UI、数値は桁区切り。
