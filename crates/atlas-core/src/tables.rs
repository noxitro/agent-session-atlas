//! 表計算ソフトで開く CSV(依頼ごと・セッションごと・VCS の照合のまとまりごと。packages/core/src/tables.ts の移植)と、
//! ツールの失敗・拒否 1 件ごとの表(failures_table。失敗の台帳から作る。TS 版には無い)。
//! Excel が UTF-8 と判断できるよう先頭に BOM を付け、行末は CRLF。
//! 列の並びと見出しはここだけで決める(atlas metrics の out/tables/ と、グループの書き出しが同じものを使う。
//! 失敗・拒否ごとの表は out/tables/ だけ)。

use crate::js;
use crate::main_effort::main_effort_of;
use crate::metrics::is_empty_session;
use crate::tool_failure::failure_cause_label;
use crate::turns::{js_re, mismatch_label, outcome_label, phase_label, request_kind_label, session_turns};
use crate::types::{CallOutcome, FailureKind, NextKind, SessionRecord, TOOL_KINDS};
use crate::vcs_retention::{ComputedOn, Outcome, RetentionStatus, SessionRetention, RETENTION_STATUSES};
use crate::vcs::RevisionSource;
use indexmap::IndexMap;
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

fn tool_kind_label(k: &str) -> &'static str {
    match k {
        "read" => "読む",
        "edit" => "編集",
        "verify" => "検証",
        "git" => "git",
        "shell" => "シェル",
        "plan" => "計画",
        "web" => "Web",
        "delegate" => "委任",
        _ => "その他",
    }
}

/// Excel が UTF-8 と判断するための印
const BOM: char = '\u{feff}';

/// 表の 1 セル(TS の string | number | boolean | null | undefined。undefined は Null にそろえる)
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

impl From<&str> for Cell {
    fn from(s: &str) -> Self {
        Cell::Str(s.to_string())
    }
}
impl From<String> for Cell {
    fn from(s: String) -> Self {
        Cell::Str(s)
    }
}
impl From<f64> for Cell {
    fn from(v: f64) -> Self {
        Cell::Num(v)
    }
}
impl From<i64> for Cell {
    fn from(v: i64) -> Self {
        Cell::Num(v as f64)
    }
}
impl From<usize> for Cell {
    fn from(v: usize) -> Self {
        Cell::Num(v as f64)
    }
}
impl From<bool> for Cell {
    fn from(v: bool) -> Self {
        Cell::Bool(v)
    }
}
impl<T: Into<Cell>> From<Option<T>> for Cell {
    fn from(v: Option<T>) -> Self {
        v.map_or(Cell::Null, Into::into)
    }
}

/// 表 1 つ(見出しと行)。CSV と SQLite が同じものを使う
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Table {
    pub header: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

/// 段階 2 の依頼ごとの判定(turn-judgments.json の 1 項目。report の parseVerdicts が作る)
#[derive(Debug, Clone, PartialEq)]
pub struct TurnVerdict {
    pub turn: f64,
    /// REQUEST_KINDS のどれか
    pub kind: &'static str,
    /// OUTCOMES のどれか
    pub outcome: &'static str,
    /// MISMATCHES のどれか
    pub mismatch: Option<&'static str>,
    pub phase: String,
    pub confidence: f64,
    pub note: String,
}

/// 依頼番号 → 判定(JS の Map<number, …>。キーは turn_key、並びは足した順)
pub type TurnVerdicts = IndexMap<u64, TurnVerdict>;
/// セッション ID → 依頼番号 → 判定
pub type VerdictMap = HashMap<String, TurnVerdicts>;

/// JS の Map のキー(SameValueZero)としての依頼番号(-0 は 0 と同じ)
pub fn turn_key(turn: f64) -> u64 {
    if turn == 0.0 { 0f64.to_bits() } else { turn.to_bits() }
}

/// CSV の 1 セル(, " 改行を含むものは "" で囲む。null は空)。
/// 文字列が = + - @ タブ・復帰で始まるときは先頭に ' を足す(表計算ソフトが式として解釈しないように。OWASP の CSV Injection)
pub fn csv_cell(v: &Cell) -> String {
    let s = match v {
        Cell::Null => return String::new(),
        Cell::Bool(b) => (if *b { "1" } else { "0" }).to_string(),
        Cell::Str(s) if s.starts_with(['=', '+', '-', '@', '\t', '\r']) => format!("'{s}"),
        Cell::Str(s) => s.clone(),
        Cell::Num(n) => js::num_to_string(*n),
    };
    if s.contains(['"', ',', '\r', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s }
}

pub fn to_csv(header: &[String], rows: &[Vec<Cell>]) -> String {
    let mut out = String::new();
    out.push(BOM);
    out.push_str(&header.iter().map(|h| csv_cell(&Cell::Str(h.clone()))).collect::<Vec<_>>().join(","));
    for r in rows {
        out.push_str("\r\n");
        out.push_str(&r.iter().map(csv_cell).collect::<Vec<_>>().join(","));
    }
    out.push_str("\r\n");
    out
}

fn sec(ms: Option<f64>) -> Cell {
    ms.map_or(Cell::Null, |m| Cell::Num(js::round(m / 1000.0)))
}

fn aiu(nano: Option<f64>) -> Cell {
    nano.map_or(Cell::Null, |n| Cell::Num(js::round((n / 1e9) * 1000.0) / 1000.0))
}

static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"\s+")).unwrap());

/// 依頼文は 1 行にして先頭だけ(表で読める長さ。数えるのはコードポイント)
fn one_line(s: &str) -> String {
    one_line_n(s, 200)
}

fn one_line_n(s: &str, n: usize) -> String {
    let replaced = SPACES.replace_all(s, " ");
    let t = js::trim(&replaced);
    if js::code_points(t) > n {
        let mut out: String = t.chars().take(n).collect();
        out.push('…');
        out
    } else {
        t.to_string()
    }
}

/// 依頼(ターン)ごとの CSV。空のセッションは除く。verdicts があれば LLM の判定の列を足す(判定の無い依頼は空)
pub fn turns_csv(sessions: &[&SessionRecord], verdicts: Option<&VerdictMap>) -> String {
    let t = turns_table(sessions, verdicts);
    to_csv(&t.header, &t.rows)
}

/// 依頼(ターン)ごとの表(turns_csv の中身)
pub fn turns_table(sessions: &[&SessionRecord], verdicts: Option<&VerdictMap>) -> Table {
    let mut header: Vec<String> = [
        "セッションID",
        "セッション名",
        "プロジェクト",
        "依頼番号",
        "開始",
        "依頼の種類",
        "工程",
        "次の依頼の種類",
        "次の依頼で直し・差し戻し",
        "詰まり",
        "実働(秒)",
        "所要(秒)",
        "ツール",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    header.extend(TOOL_KINDS.iter().map(|k| format!("ツール:{}", tool_kind_label(k))));
    header.extend(
        [
            "ツールの失敗",
            "拒否",
            "失敗の連続(最長)",
            "編集",
            "再編集(前の依頼で編集したファイル)",
            "重ね編集(同じ依頼の中)",
            "中断",
            "エラー",
            "うち利用上限",
            "サブエージェントの失敗",
            "文脈圧縮",
            "ask_user",
            "入力トークン",
            "出力トークン",
            "AIU",
            "依頼文(先頭)",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    if verdicts.is_some() {
        header.extend(["判定:依頼の種類", "判定:扱い", "判定:合わなかった点", "判定:工程", "判定:確信度", "判定:理由"].iter().map(|s| s.to_string()));
    }
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    for s in sessions {
        if is_empty_session(s) {
            continue;
        }
        let vs = verdicts.and_then(|v| v.get(&s.id));
        for t in session_turns(s) {
            let st = t.stats;
            let mut row: Vec<Cell> = vec![
                s.id.as_str().into(),
                s.name.as_deref().unwrap_or("").into(),
                s.project.as_str().into(),
                t.index.into(),
                st.started_at.as_deref().into(),
                request_kind_label(t.kind).into(),
                phase_label(t.phase).into(),
                t.next_kind.map_or("", request_kind_label).into(),
                t.followed_by_fix().into(),
                t.is_stuck().into(),
                sec(t.active_ms),
                sec(t.ms),
                st.tools.into(),
            ];
            row.extend(TOOL_KINDS.iter().map(|k| Cell::from(st.kinds.get(*k).copied().unwrap_or(0))));
            row.extend([
                st.tool_failures.into(),
                st.denied.into(),
                st.max_consecutive_failures.into(),
                st.edits.into(),
                st.re_edits.into(),
                st.repeat_edits.unwrap_or(0).into(),
                st.aborts.into(),
                st.errors.into(),
                st.external_errors.into(),
                st.subagent_failures.into(),
                st.compactions.into(),
                st.ask_user.into(),
                st.input.into(),
                st.output.into(),
                aiu(st.nano_aiu),
                one_line(t.text).into(),
            ]);
            if verdicts.is_some() {
                match vs.and_then(|m| m.get(&turn_key(t.index as f64))) {
                    Some(v) => row.extend([
                        request_kind_label(v.kind).into(),
                        outcome_label(v.outcome).into(),
                        v.mismatch.map_or("", mismatch_label).into(),
                        v.phase.as_str().into(),
                        Cell::Num(js::round(v.confidence * 100.0) / 100.0),
                        one_line(&v.note).into(),
                    ]),
                    None => row.extend(["".into(), "".into(), "".into(), "".into(), Cell::Null, "".into()]),
                }
            }
            rows.push(row);
        }
    }
    Table { header, rows }
}

/// 状態の名前の差し替え(atlas.config.json の vcs.labels。vcs-retention.json に入る)。無い状態は RetentionStatus::label
pub type RetentionLabels = crate::js::JsMap<String>;

fn label_of(labels: Option<&RetentionLabels>, k: RetentionStatus) -> String {
    labels.and_then(|l| l.get(k.as_str())).cloned().unwrap_or_else(|| k.label().to_string())
}

/// 開始時の基準の出所の言葉(記録 = ログに残った開始時の版、推定 = 開始時刻から VCS の履歴で探した版)
fn baseline_cell(r: &SessionRetention) -> &'static str {
    match &r.baseline {
        Some(b) if b.source == RevisionSource::Observed => "記録",
        Some(_) => "推定",
        None => "",
    }
}

/// VCS の照合の列(retention を渡したときだけ。最初の依頼の列の前に入れる)
fn retention_header(labels: Option<&RetentionLabels>) -> Vec<String> {
    let mut h = vec![
        "VCS の照合".to_string(),
        format!("{}の理由", label_of(labels, RetentionStatus::Unattributable)),
        "VCS".into(),
        "開始時の基準".into(),
        "照合した場所".into(),
    ];
    h.extend(RETENTION_STATUSES.iter().map(|k| format!("{}(まとまり)", label_of(labels, *k))));
    h.extend(RETENTION_STATUSES.iter().map(|k| format!("{}(行)", label_of(labels, *k))));
    h
}

fn retention_cells(r: Option<&SessionRetention>, labels: Option<&RetentionLabels>) -> Vec<Cell> {
    // 照合していないセッション(vcs-retention.json に無い)は空にする(0 と区別するため)
    let Some(r) = r else {
        return retention_header(labels).iter().map(|_| Cell::Null).collect();
    };
    let measured = r.outcome == Outcome::Measured;
    let mut cells: Vec<Cell> = vec![
        match r.outcome {
            Outcome::Measured => "照合できた".to_string(),
            Outcome::NoAiChanges => "AI の変更なし".to_string(),
            Outcome::Unattributable => label_of(labels, RetentionStatus::Unattributable),
        }
        .into(),
        r.reason.map_or("", |x| x.label()).into(),
        r.vcs.map_or("", |v| v.as_str()).into(),
        baseline_cell(r).into(),
        // computedOn が無いのは、送った側の結果が添えられておらず、どこでも照合していないもの
        match r.computed_on {
            Some(ComputedOn::Sender) => "送った側の PC",
            Some(ComputedOn::Local) => "この PC",
            None => "照合していない",
        }
        .into(),
    ];
    let pick = |k: RetentionStatus, v: i64| -> Cell {
        if r.outcome == Outcome::NoAiChanges {
            Cell::Null
        } else if measured || k == RetentionStatus::Unattributable {
            v.into()
        } else {
            Cell::Null
        }
    };
    cells.extend(RETENTION_STATUSES.iter().map(|k| pick(*k, r.counts.get(*k))));
    cells.extend(RETENTION_STATUSES.iter().map(|k| pick(*k, r.lines.get(*k))));
    cells
}

/// AI の変更のまとまりごとの表(照合の結果。retention に入っているセッションの全部)
pub fn retention_hunks_table(retention: &[&SessionRetention], labels: Option<&RetentionLabels>) -> Table {
    let mut header: Vec<String> = vec![
        "セッションID".into(),
        "まとまり".into(),
        "パス".into(),
        "状態".into(),
        format!("{}の理由", label_of(labels, RetentionStatus::Unattributable)),
        "VCS".into(),
        "開始時の基準".into(),
    ];
    header.extend(RETENTION_STATUSES.iter().map(|k| format!("{}(行)", label_of(labels, *k))));
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    for r in retention {
        for h in &r.hunks {
            let mut row: Vec<Cell> = vec![
                r.session_id.as_str().into(),
                h.id.into(),
                h.path.as_str().into(),
                label_of(labels, h.status).into(),
                h.reason.map_or("", |x| x.label()).into(),
                r.vcs.map_or("", |v| v.as_str()).into(),
                baseline_cell(r).into(),
            ];
            row.extend(RETENTION_STATUSES.iter().map(|k| Cell::from(h.lines.get(*k))));
            rows.push(row);
        }
    }
    Table { header, rows }
}

/// セッションごとの CSV。空のセッションは除く。human_hours はセッション ID → 推定人手工数(時間。判定済みのものだけ)
pub fn sessions_csv(sessions: &[&SessionRecord], human_hours: &HashMap<String, f64>, retention: Option<&HashMap<String, &SessionRetention>>, labels: Option<&RetentionLabels>) -> String {
    let t = sessions_table(sessions, human_hours, retention, labels);
    to_csv(&t.header, &t.rows)
}

/// セッションごとの表(sessions_csv の中身)
pub fn sessions_table(sessions: &[&SessionRecord], human_hours: &HashMap<String, f64>, retention: Option<&HashMap<String, &SessionRetention>>, labels: Option<&RetentionLabels>) -> Table {
    let mut header: Vec<String> = [
        "セッションID",
        "セッション名",
        "プロジェクト",
        "クライアント",
        "ブランチ",
        "利用者",
        "開始",
        "終了",
        "所要(分)",
        "実働(分)",
        "依頼",
        "依頼の記録",
        "詰まりのあった依頼",
        "次の依頼で直し・差し戻し",
        "応答",
        "モデル",
        "本体のモデル",
        "本体の推論強度",
        "入力トークン",
        "出力トークン",
        "AIU",
        "premium request",
        "ツール",
        "ツールの失敗",
        "中断",
        "エラー",
        "サブエージェントの失敗",
        "文脈圧縮",
        "再編集したファイル",
        "余分な編集",
        "失敗の連続(最長)",
        "追加行",
        "削除行",
        "推定人手工数(時間)",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if retention.is_some() {
        header.extend(retention_header(labels));
    }
    header.push("最初の依頼(先頭)".into());
    let min = |ms: Option<f64>| -> Cell { ms.map_or(Cell::Null, |m| Cell::Num(js::round(m / 6000.0) / 10.0)) };
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    for s in sessions {
        if is_empty_session(s) {
            continue;
        }
        let turns = session_turns(s);
        let lines = &s.lines;
        let no_lines = lines.source == crate::types::LineSource::None;
        let main = main_effort_of(s.exec.main_model_efforts.as_ref());
        let mut row: Vec<Cell> = vec![
            s.id.as_str().into(),
            s.name.as_deref().unwrap_or("").into(),
            s.project.as_str().into(),
            s.client.as_deref().unwrap_or("").into(),
            s.branch.as_deref().unwrap_or("").into(),
            s.person.clone().flatten().unwrap_or_default().into(),
            s.created_at.as_deref().into(),
            s.updated_at.as_deref().into(),
            min(s.duration_ms),
            min(s.active_ms),
            s.turns.into(),
            turns.len().into(),
            turns.iter().filter(|t| t.is_stuck()).count().into(),
            turns.iter().filter(|t| t.followed_by_fix()).count().into(),
            s.assistant_messages.into(),
            s.models.join(" ").into(),
            main.model_cell().into(),
            main.effort_cell().into(),
            s.tokens.input.into(),
            s.tokens.output.into(),
            aiu(s.tokens.nano_aiu),
            s.tokens.premium_requests.into(),
            s.tools.total.into(),
            s.friction.tool_failures.into(),
            s.friction.aborts.into(),
            s.friction.errors.into(),
            s.friction.subagent_failures.into(),
            s.friction.compactions.into(),
            s.analysis.files_reedited.into(),
            s.analysis.extra_edits.into(),
            s.analysis.max_consecutive_failures.into(),
            if no_lines { Cell::Null } else { lines.added.into() },
            if no_lines { Cell::Null } else { lines.removed.into() },
            human_hours.get(&s.id).copied().into(),
        ];
        if let Some(ret) = retention {
            row.extend(retention_cells(ret.get(&s.id).copied(), labels));
        }
        row.push(one_line(s.first_user_message.as_deref().unwrap_or("")).into());
        rows.push(row);
    }
    Table { header, rows }
}

pub fn failure_kind_label(k: FailureKind) -> &'static str {
    match k {
        FailureKind::Failure => "失敗",
        FailureKind::Denied => "拒否",
    }
}

/// 失敗の後に何が起きたか(その後の列。詳細ページも同じ語を使う)
pub fn next_kind_label(k: NextKind) -> &'static str {
    match k {
        NextKind::Tool => "ツール",
        NextKind::User => "利用者の次の依頼",
        NextKind::End => "続きなし",
    }
}

/// 失敗の後の呼び出しの結果(終わりの記録が無いものは、ツールの表と同じ「結果なし」)
pub fn call_outcome_label(o: CallOutcome) -> &'static str {
    match o {
        CallOutcome::Success => "成功",
        CallOutcome::Failure => "失敗",
        CallOutcome::Denied => "拒否",
        CallOutcome::Unknown => "結果なし",
    }
}

/// ツールの失敗・拒否 1 件ごとの CSV(failures_table の中身)。台帳のある記録が 1 件も無ければ None
pub fn failures_csv(sessions: &[&SessionRecord]) -> Option<String> {
    failures_table(sessions).map(|t| to_csv(&t.header, &t.rows))
}

/// ツールの失敗・拒否 1 件ごとの表(失敗の台帳 analysis.failures の 1 行が 1 行。セッションは渡した順、その中は台帳の順)。
/// 空のセッションは除く。依頼番号は turns_table と同じ 1 からの番号(台帳の turn + 1。最初の依頼より前の失敗は空)。
/// エラー文・引数・エージェントへの依頼は記録のまま(台帳を作るときに秘密らしい文字列を伏せ、上限で切ってある。ここでは切らず、改行も残す)。
/// 台帳の無い古い記録は行にならない。載せるセッションのどれにも台帳が無ければ None
/// (見出しだけの表を書くと「失敗が 0 件」と読めてしまうので、呼ぶ側は表を書かない)
pub fn failures_table(sessions: &[&SessionRecord]) -> Option<Table> {
    let header: Vec<String> = [
        "セッションID",
        "セッション名",
        "プロジェクト",
        "依頼番号",
        "開始",
        "種類",
        "要因",
        "ツール",
        "MCP サーバー",
        "MCP のツール",
        "MCP の設定元",
        "モデル",
        "エージェント",
        "エージェントの呼び出し",
        "エージェントへの依頼",
        "所要(ミリ秒)",
        "エラー文",
        "引数",
        "その後",
        "次のツール",
        "次の結果",
        "呼び直し",
        "そろえたエラー文",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let mut any_ledger = false;
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    for s in sessions {
        if is_empty_session(s) {
            continue;
        }
        let Some(ledger) = &s.analysis.failures else {
            continue;
        };
        any_ledger = true;
        for f in ledger {
            // サブエージェントへの依頼文は agents[] に 1 回だけ持つので、呼び出しの id で引く(同じ id が 2 つあれば先のもの)
            let prompt = f.agent_call.as_deref().and_then(|call| s.agents.iter().find(|a| a.id.as_deref() == Some(call))).and_then(|a| a.prompt.as_deref());
            let by_tool = f.next.kind == NextKind::Tool;
            rows.push(vec![
                s.id.as_str().into(),
                s.name.as_deref().unwrap_or("").into(),
                s.project.as_str().into(),
                f.turn.map(|t| t + 1).into(),
                f.started_at.as_deref().into(),
                failure_kind_label(f.kind).into(),
                f.cause.as_deref().map_or("", failure_cause_label).into(),
                f.tool.as_str().into(),
                f.mcp_server.as_deref().unwrap_or("").into(),
                f.mcp_tool.as_deref().unwrap_or("").into(),
                f.mcp_config_source.as_deref().unwrap_or("").into(),
                f.model.as_deref().unwrap_or("").into(),
                f.agent.as_deref().unwrap_or("").into(),
                f.agent_call.as_deref().unwrap_or("").into(),
                prompt.unwrap_or("").into(),
                f.duration_ms.into(),
                f.error.as_str().into(),
                f.args.as_deref().unwrap_or("").into(),
                next_kind_label(f.next.kind).into(),
                f.next.tool.as_deref().filter(|_| by_tool).unwrap_or("").into(),
                f.next.outcome.filter(|_| by_tool).map_or("", call_outcome_label).into(),
                f.next.retry.filter(|_| by_tool).into(),
                f.group.as_str().into(),
            ]);
        }
    }
    any_ledger.then_some(Table { header, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_cells() {
        assert_eq!(csv_cell(&"a".into()), "a");
        assert_eq!(csv_cell(&"a,b".into()), "\"a,b\"");
        assert_eq!(csv_cell(&"say \"hi\"".into()), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell(&"1\n2".into()), "\"1\n2\"");
        assert_eq!(csv_cell(&Cell::Null), "");
        assert_eq!(csv_cell(&true.into()), "1");
        // 表計算ソフトが式として読まないよう、= + - @ 始まりの文字列には ' を足す(数値はそのまま)
        assert_eq!(csv_cell(&"@plan.md を見て".into()), "'@plan.md を見て");
        assert_eq!(csv_cell(&"--foo=bar は?".into()), "'--foo=bar は?");
        assert_eq!(csv_cell(&"=1+1,2".into()), "\"'=1+1,2\"");
        assert_eq!(csv_cell(&Cell::Num(-3.0)), "-3");
        assert_eq!(csv_cell(&Cell::Num(2.5)), "2.5");
    }

    #[test]
    fn one_line_cuts_by_code_points() {
        assert_eq!(one_line_n("  a\n\tb  ", 10), "a b");
        assert_eq!(one_line_n("😀😀😀", 2), "😀😀…");
        assert_eq!(one_line_n("abc", 3), "abc");
    }

    /// packages/core/test/vcs-step.test.ts の「照合の結果を渡したときだけ列を足し…」の移植
    #[test]
    fn retention_columns() {
        use crate::normalize::{normalize_session, NormalizeInput};
        use crate::vcs_step::parse_sender_vcs;
        use serde_json::json;
        let rec = |id: &str| {
            let ev = crate::types::CopilotEvent { kind: "user.message".into(), data: Some(json!({ "content": "x" })), timestamp: Some(json!("2026-11-01T10:00:00.000Z")), ..Default::default() };
            let mut it = std::iter::once(Ok(ev));
            normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: None, db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
        };
        let measured = parse_sender_vcs(
            &json!({ "version": 1, "sessionId": "a", "computedAt": "2026-11-01T11:00:00.000Z", "mode": "worktree", "result": {
                "sessionId": "a", "outcome": "measured", "vcs": "git", "root": "r", "baseline": { "rev": "h", "source": "observed" }, "evaluated": null,
                "hunks": [{ "id": 1, "path": "f", "status": "kept", "lines": { "kept": 2, "modified": 0, "missing": 0, "unattributable": 0 } }], "excludedHunks": 0 } }),
            "a",
        )
        .unwrap();
        let mut none = measured.clone();
        none.session_id = "b".into();
        none.outcome = Outcome::NoAiChanges;
        none.hunks = vec![];
        none.counts = Default::default();
        let (a, b, c) = (rec("a"), rec("b"), rec("c"));
        let without = sessions_table(&[&a], &HashMap::new(), None, None);
        assert!(!without.header.iter().any(|h| h == "VCS の照合"));
        let ret: HashMap<String, &SessionRetention> = [("a".to_string(), &measured), ("b".to_string(), &none)].into_iter().collect();
        let t = sessions_table(&[&a, &b, &c], &HashMap::new(), Some(&ret), None);
        let col = |name: &str| t.header.iter().position(|h| h == name).unwrap();
        assert_eq!(t.header.last().unwrap(), "最初の依頼(先頭)");
        let column = |name: &str| t.rows.iter().map(|r| r[col(name)].clone()).collect::<Vec<_>>();
        assert_eq!(column("VCS の照合"), [Cell::from("照合できた"), Cell::from("AI の変更なし"), Cell::Null]);
        assert_eq!(column("そのまま残る(まとまり)"), [Cell::Num(1.0), Cell::Null, Cell::Null]);
        assert_eq!(column("そのまま残る(行)"), [Cell::Num(2.0), Cell::Null, Cell::Null]);
        assert_eq!(t.rows[0][col("開始時の基準")], Cell::from("記録"));
        assert_eq!(t.rows[0][col("照合した場所")], Cell::from("送った側の PC"));
        // 状態の名前を差し替えると、列名とまとまりの状態の言葉が変わる
        let labels: RetentionLabels = crate::js::JsMap([("kept".to_string(), "残った".to_string()), ("unattributable".to_string(), "不明".to_string())].into_iter().collect());
        let ra: HashMap<String, &SessionRetention> = [("a".to_string(), &measured)].into_iter().collect();
        let named = sessions_table(&[&a], &HashMap::new(), Some(&ra), Some(&labels));
        assert!(named.header.iter().any(|h| h == "残った(まとまり)"));
        assert!(named.header.iter().any(|h| h == "不明の理由"));
        assert_eq!(retention_hunks_table(&[&measured], Some(&labels)).rows[0][3], Cell::from("残った"));
        let h = retention_hunks_table(&[&measured], None);
        assert_eq!(
            h.rows,
            vec![vec![Cell::from("a"), Cell::Num(1.0), Cell::from("f"), Cell::from("そのまま残る"), Cell::from(""), Cell::from("git"), Cell::from("記録"), Cell::Num(2.0), Cell::Num(0.0), Cell::Num(0.0), Cell::Num(0.0)]]
        );
        // 照合した場所の無いもの(送った側の結果が無かった)は「照合していない」
        let mut not_measured = measured.clone();
        not_measured.session_id = "c".into();
        not_measured.outcome = Outcome::Unattributable;
        not_measured.computed_on = None;
        let rc: HashMap<String, &SessionRetention> = [("c".to_string(), &not_measured)].into_iter().collect();
        let t2 = sessions_table(&[&c], &HashMap::new(), Some(&rc), None);
        assert_eq!(t2.rows[0][t2.header.iter().position(|h| h == "照合した場所").unwrap()], Cell::from("照合していない"));
    }

    const LEDGER_T0: i64 = 1_790_812_800_000; // 2026-10-01T00:00:00.000Z

    fn ledger_ev(kind: &str, data: serde_json::Value, s: i64) -> crate::types::CopilotEvent {
        crate::types::CopilotEvent { kind: kind.into(), data: Some(data), timestamp: Some(serde_json::json!(crate::jsdate::to_iso(LEDGER_T0 + s * 1000))), ..Default::default() }
    }

    fn ledger_rec(id: &str, events: Vec<crate::types::CopilotEvent>) -> SessionRecord {
        use crate::normalize::{normalize_session, NormalizeInput};
        let mut it = events.into_iter().map(Ok);
        normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: None, db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
    }

    /// 台帳の無い古い記録(sessions.json に failures・failuresDropped が無い)
    fn without_ledger(mut r: SessionRecord, id: &str) -> SessionRecord {
        r.id = id.into();
        r.analysis.failures = None;
        r.analysis.failures_dropped = None;
        r
    }

    const LEDGER_HEADER: [&str; 23] = [
        "セッションID",
        "セッション名",
        "プロジェクト",
        "依頼番号",
        "開始",
        "種類",
        "要因",
        "ツール",
        "MCP サーバー",
        "MCP のツール",
        "MCP の設定元",
        "モデル",
        "エージェント",
        "エージェントの呼び出し",
        "エージェントへの依頼",
        "所要(ミリ秒)",
        "エラー文",
        "引数",
        "その後",
        "次のツール",
        "次の結果",
        "呼び直し",
        "そろえたエラー文",
    ];

    /// 失敗・拒否ごとの表: 1 件 1 行、依頼番号は turns.csv と同じ 1 からの番号、サブエージェントへの依頼は agents[] から引く
    #[test]
    fn failures_rows() {
        use serde_json::json;
        let id = "00000000-0000-4000-8000-000000000001";
        let start = |call: &str, tool: &str, args: serde_json::Value, s: i64| ledger_ev("tool.execution_start", json!({ "toolCallId": call, "toolName": tool, "arguments": args }), s);
        let r = ledger_rec(
            id,
            vec![
                // 最初の依頼より前の失敗(依頼番号は空。その後は利用者の次の依頼)
                start("p", "view", json!({ "path": "X:\\synthetic-p\\none.ts" }), 0),
                ledger_ev("tool.execution_complete", json!({ "toolCallId": "p", "success": false, "error": "boom" }), 1),
                ledger_ev("user.message", json!({ "content": "直して" }), 10),
                start("a", "view", json!({ "path": "X:\\synthetic-p\\a.ts" }), 11),
                ledger_ev("tool.execution_complete", json!({ "toolCallId": "a", "success": false, "error": { "code": "failure", "message": "Path does not exist" }, "model": "synthetic-model" }), 12),
                start("b", "edit", json!({ "path": "X:\\synthetic-p\\b.ts" }), 13),
                ledger_ev("tool.execution_complete", json!({ "toolCallId": "b", "success": false, "error": { "code": "denied", "message": "denied by user" } }), 14),
                // サブエージェントの中の失敗と、同じ引数での呼び直し
                start("t1", "task", json!({ "agent_type": "explore", "prompt": "呼び出し元を調べて" }), 15),
                ledger_ev("subagent.started", json!({ "toolCallId": "t1", "agentName": "explore" }), 16),
                ledger_ev("tool.execution_start", json!({ "toolCallId": "x1", "toolName": "grep", "arguments": { "pattern": "foo" }, "parentToolCallId": "t1" }), 17),
                ledger_ev("tool.execution_complete", json!({ "toolCallId": "x1", "success": false, "error": "timed out", "parentToolCallId": "t1" }), 18),
                ledger_ev("tool.execution_start", json!({ "toolCallId": "x2", "toolName": "grep", "arguments": { "pattern": "foo" }, "parentToolCallId": "t1" }), 19),
                ledger_ev("tool.execution_complete", json!({ "toolCallId": "x2", "success": true, "parentToolCallId": "t1" }), 20),
                ledger_ev("subagent.completed", json!({ "toolCallId": "t1", "agentName": "explore" }), 21),
                ledger_ev("tool.execution_complete", json!({ "toolCallId": "t1", "success": true }), 22),
                ledger_ev("user.message", json!({ "content": "次は検索" }), 30),
                // MCP のツールの失敗(その後の呼び出しなし)
                ledger_ev("tool.execution_start", json!({ "toolCallId": "m", "toolName": "srv-search", "mcpServerName": "srv", "mcpToolName": "search", "mcpConfigSource": "user", "arguments": { "q": "x" } }), 31),
                ledger_ev("tool.execution_complete", json!({ "toolCallId": "m", "success": false, "error": { "code": "failure", "message": "rate limit" } }), 32),
            ],
        );
        let t = failures_table(&[&r]).unwrap();
        assert_eq!(t.header, LEDGER_HEADER);
        assert!(t.rows.iter().all(|row| row.len() == t.header.len()));
        // 行の数は tools.results の failure + denied と同じ(上限で切っていないとき)
        assert_eq!(t.rows.len() as i64, r.tools.results.values().map(|x| x.failure + x.denied).sum::<i64>());
        let col = |name: &str| t.header.iter().position(|h| h == name).unwrap();
        let column = |name: &str| t.rows.iter().map(|row| row[col(name)].clone()).collect::<Vec<_>>();
        let s = |v: &str| Cell::from(v);
        assert_eq!(column("セッションID"), vec![s(id); 5]);
        assert_eq!(column("プロジェクト"), vec![s(&r.project); 5]);
        // analysis.turnStats の添字(0 から)に 1 を足して、turns.csv の依頼番号に合わせる
        assert_eq!(column("依頼番号"), [Cell::Null, Cell::Num(1.0), Cell::Num(1.0), Cell::Num(1.0), Cell::Num(2.0)]);
        assert_eq!(turns_table(&[&r], None).rows.iter().map(|row| row[3].clone()).collect::<Vec<_>>(), [Cell::Num(1.0), Cell::Num(2.0)]);
        assert_eq!(t.rows[1][col("開始")], s(&crate::jsdate::to_iso(LEDGER_T0 + 11_000)));
        assert_eq!(column("種類"), [s("失敗"), s("失敗"), s("拒否"), s("失敗"), s("失敗")]);
        assert_eq!(column("要因"), [s("その他"), s("対象が見つからない"), s(""), s("時間切れ"), s("上限・回数制限")]);
        assert_eq!(column("ツール"), [s("view"), s("view"), s("edit"), s("grep"), s("srv-search")]);
        assert_eq!(column("MCP サーバー")[4], s("srv"));
        assert_eq!(column("MCP のツール")[4], s("search"));
        assert_eq!(column("MCP の設定元")[4], s("user"));
        assert_eq!(column("MCP サーバー")[0], s(""));
        assert_eq!(column("モデル")[1], s("synthetic-model"));
        assert_eq!(column("エージェント"), [s(""), s(""), s(""), s("explore"), s("")]);
        assert_eq!(column("エージェントの呼び出し"), [s(""), s(""), s(""), s("t1"), s("")]);
        assert_eq!(column("エージェントへの依頼"), [s(""), s(""), s(""), s("呼び出し元を調べて"), s("")]);
        assert_eq!(column("所要(ミリ秒)"), vec![Cell::Num(1000.0); 5]);
        assert_eq!(column("エラー文"), [s("boom"), s("failure: Path does not exist"), s("denied: denied by user"), s("timed out"), s("failure: rate limit")]);
        assert_eq!(column("引数")[1], s(r#"{"path":"X:\\synthetic-p\\a.ts"}"#));
        assert_eq!(column("その後"), [s("利用者の次の依頼"), s("ツール"), s("ツール"), s("ツール"), s("続きなし")]);
        assert_eq!(column("次のツール"), [s(""), s("edit"), s("task"), s("grep"), s("")]);
        assert_eq!(column("次の結果"), [s(""), s("拒否"), s("成功"), s("成功"), s("")]);
        // 呼び直しは、その後がツールのときだけ値を持つ
        assert_eq!(column("呼び直し"), [Cell::Null, Cell::Bool(false), Cell::Bool(false), Cell::Bool(true), Cell::Null]);
        assert_eq!(column("そろえたエラー文"), r.analysis.failures.as_ref().unwrap().iter().map(|f| s(&f.group)).collect::<Vec<_>>());
        // agents[] に同じ id が無ければ、依頼文は空
        let mut no_agent = r.clone();
        no_agent.agents.clear();
        assert_eq!(failures_table(&[&no_agent]).unwrap().rows[3][col("エージェントへの依頼")], s(""));
    }

    /// 台帳の無い古い記録だけなら表を作らない(0 件の表と区別する)。混ざっていれば、台帳のある記録の行だけの表
    #[test]
    fn failures_table_needs_a_ledger() {
        use serde_json::json;
        let failing = |id: &str| {
            ledger_rec(
                id,
                vec![
                    ledger_ev("user.message", json!({ "content": "x" }), 0),
                    ledger_ev("tool.execution_start", json!({ "toolCallId": "a", "toolName": "view", "arguments": {} }), 1),
                    ledger_ev("tool.execution_complete", json!({ "toolCallId": "a", "success": false, "error": "boom" }), 2),
                ],
            )
        };
        let new = failing("00000000-0000-4000-8000-000000000011");
        let old = without_ledger(failing("x"), "00000000-0000-4000-8000-000000000012");
        let clean = ledger_rec("00000000-0000-4000-8000-000000000013", vec![ledger_ev("user.message", json!({ "content": "x" }), 0)]);
        assert_eq!(clean.analysis.failures.as_deref(), Some(&[][..]));
        assert_eq!(failures_table(&[]), None);
        assert_eq!(failures_table(&[&old]), None);
        assert_eq!(failures_csv(&[&old]), None);
        // 失敗が 0 件でも、台帳があれば見出しだけの表にする
        let zero = failures_table(&[&clean]).unwrap();
        assert_eq!((zero.header.len(), zero.rows.len()), (LEDGER_HEADER.len(), 0));
        // 渡した順。古い記録は行にならない
        let mixed = failures_table(&[&old, &new, &clean, &new]).unwrap();
        assert_eq!(mixed.rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(), vec![Cell::from(new.id.as_str()); 2]);
        // 空のセッションは turns.csv・sessions.csv と同じく除く(台帳があっても数に入れない)
        let mut empty = new.clone();
        empty.empty = true;
        assert_eq!(failures_table(&[&empty]), None);
        assert_eq!(failures_table(&[&empty, &clean]).unwrap().rows.len(), 0);
    }

    /// エラー文は切らず、改行もそのまま CSV に入れる。= や - で始まる文には、表計算ソフトが式として読まないよう ' が付く
    #[test]
    fn failures_csv_guards_formulas_and_keeps_newlines() {
        use serde_json::json;
        let fail = |call: &str, error: &str, s: i64| {
            [
                ledger_ev("tool.execution_start", json!({ "toolCallId": call, "toolName": "bash", "arguments": "-rf X:\\synthetic-tmp" }), s),
                ledger_ev("tool.execution_complete", json!({ "toolCallId": call, "success": false, "error": error }), s + 1),
            ]
        };
        let mut events = vec![ledger_ev("user.message", json!({ "content": "x" }), 0)];
        events.extend(fail("a", "=1+1 を評価できません\r\n2 行目, \"引用\" つき\n3 行目", 1));
        events.extend(fail("b", "-n は使えません", 3));
        let r = ledger_rec("00000000-0000-4000-8000-000000000021", events);
        let t = failures_table(&[&r]).unwrap();
        let col = |name: &str| t.header.iter().position(|h| h == name).unwrap();
        // 表の値は記録のまま(' を足すのは CSV にするときだけ。SQLite には足さない)
        assert_eq!(t.rows[0][col("エラー文")], Cell::from("=1+1 を評価できません\r\n2 行目, \"引用\" つき\n3 行目"));
        assert_eq!(t.rows[0][col("引数")], Cell::from("-rf X:\\synthetic-tmp"));
        let csv = failures_csv(&[&r]).unwrap();
        assert!(csv.starts_with("\u{feff}セッションID,セッション名,プロジェクト,依頼番号,"));
        assert!(csv.contains(",\"'=1+1 を評価できません\r\n2 行目, \"\"引用\"\" つき\n3 行目\",'-rf X:\\synthetic-tmp,"), "{csv}");
        assert!(csv.contains(",'-n は使えません,'-rf X:\\synthetic-tmp,"), "{csv}");
        // 引用符の外の行の区切りは、見出し + 2 行 + 末尾の分だけ(エラー文の中の改行は引用符の中に残る)
        let mut quoted = false;
        let mut records = 0;
        let chars: Vec<char> = csv.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            match c {
                '"' => quoted = !quoted,
                '\n' if !quoted && i > 0 && chars[i - 1] == '\r' => records += 1,
                _ => {}
            }
        }
        assert_eq!(records, 3);
    }

    #[test]
    fn csv_has_bom_and_crlf() {
        let csv = to_csv(&["a".into(), "b".into()], &[vec![Cell::Num(1.0), Cell::Null]]);
        assert_eq!(csv, "\u{feff}a,b\r\n1,\r\n");
    }
}
