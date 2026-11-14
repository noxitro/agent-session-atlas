//! 表計算ソフトで開く CSV(依頼ごと・セッションごと・VCS の照合のまとまりごと。packages/core/src/tables.ts の移植)。
//! Excel が UTF-8 と判断できるよう先頭に BOM を付け、行末は CRLF。
//! 列の並びと見出しはここだけで決める(atlas metrics の out/tables/ と、グループの書き出しが同じものを使う)。

use crate::js;
use crate::metrics::is_empty_session;
use crate::turns::{js_re, mismatch_label, outcome_label, phase_label, request_kind_label, session_turns};
use crate::types::{SessionRecord, TOOL_KINDS};
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
        let mut row: Vec<Cell> = vec![
            s.id.as_str().into(),
            s.name.as_deref().unwrap_or("").into(),
            s.project.as_str().into(),
            s.client.as_deref().unwrap_or("").into(),
            s.branch.as_deref().unwrap_or("").into(),
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

    #[test]
    fn csv_has_bom_and_crlf() {
        let csv = to_csv(&["a".into(), "b".into()], &[vec![Cell::Num(1.0), Cell::Null]]);
        assert_eq!(csv, "\u{feff}a,b\r\n1,\r\n");
    }
}
