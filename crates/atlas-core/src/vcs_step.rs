//! 照合の段(atlas vcs。packages/core/src/vcs-step.ts の移植)。スナップショットの各セッションから AI の変更を取り出し(ai_changes.rs)、
//! 照合した時点の VCS のファイルと比べて(vcs_retention.rs)、out/vcs-retention.json にする。
//!
//! - この PC の記録を集計したとき: ログのパスのリポジトリを、この PC で読む(読むだけ。vcs.rs の許可リスト)
//! - アップロード先から集計し直したとき: 送り先にはリポジトリが無いか、同じパスに別のものがあるので、ディスクは読まない。
//!   送った側の PC が照合してセッションのフォルダに添えた結果(UPLOAD_VCS_META)を読む。無ければ「送った側で照合していない」
//! - リポジトリを別の場所へ移したときは、設定の対応づけ(pathMap)でログのパスを今の場所に読み替えてから照合する

use crate::ai_changes::{AiChangeBuilder, AiChangeSet, WorkspaceHints};
use crate::classify::resolve_file_path;
use crate::events::EventReader;
use crate::extract::{list_session_dirs, read_workspace_yaml};
use crate::js::{self, JsMap};
use crate::jsdate;
use crate::jsfs;
use crate::snapshot::{SNAPSHOT_MANIFEST, UPLOAD_VCS_META};
use crate::vcs::{EvalMode, Revision, RevisionSource, VcsKind};
use crate::vcs_retention::{
    measure_retention, status_of_lines, summarize_retention, tally, top_reason, ComputedOn, Evaluated, HunkRetention, LineCounts, Outcome, Provenance, RetentionOptions, RetentionStatus,
    RetentionSummary, SessionRetention, UnattributableReason, RETENTION_STATUSES,
};
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

pub const VCS_RETENTION_FILE: &str = "vcs-retention.json";
pub const VCS_RETENTION_SCHEMA_VERSION: i64 = 1;
/// 似た本文とみなす 2 字組の重なりの既定(vcs_retention.rs と同じ値)
pub const DEFAULT_SIMILARITY: f64 = 0.75;

/// ログに残るパス(from)を、今の場所(to)に読み替える。リポジトリを別のフォルダへ移したとき用
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathMapping {
    pub from: String,
    pub to: String,
}

/// 送った側の結果を読んだセッションの、照合した日時の範囲と見方の内訳
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SenderSummary {
    pub sessions: i64,
    pub from: Option<String>,
    pub to: Option<String>,
    /// 見方(EvalMode の名前)ごとのセッションの数
    pub modes: JsMap<i64>,
}

/// out/vcs-retention.json の中身。キーの順は TS 版が書く順(labels と note は runVcs が最後に足す)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsRetentionFile {
    pub schema_version: i64,
    pub generated_at: String,
    /// local = この PC で照合した。sender = アップロード先から集計し、送った側の PC の結果を読んだ
    pub computed_on: ComputedOn,
    pub mode: EvalMode,
    pub similarity: f64,
    /// 使ったパスの対応づけの数(0 なら読み替えていない)
    pub path_map: i64,
    /// mode が fixed のときの日数(セッションの終わりから何日後の版と比べたか)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lag_days: Option<i64>,
    /// computedOn が sender のとき、送った側が照合した日時の範囲と比べる版の見方(セッションの数)。
    /// 送った側の結果が 1 つも無ければ null。この PC で照合したときはキーが無い(外の None)
    #[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]
    pub senders: Option<Option<SenderSummary>>,
    pub summary: RetentionSummary,
    pub sessions: Vec<SessionRetention>,
    /// 設定(atlas.config.json の vcs.labels)で差し替えた状態の名前。表と画面はこれを使う(無ければ RetentionStatus::label)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<JsMap<String>>,
    /// 設定(vcs.note)で足した、画面の節の説明の一文
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 送った側がセッションのフォルダに添える結果(UPLOAD_VCS_META)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderVcsFile {
    pub version: i64,
    pub session_id: String,
    pub computed_at: String,
    pub mode: EvalMode,
    pub result: SessionRetention,
}

/// out/vcs-retention.json を読む。無い・形が違う(版が違う)なら None
pub fn read_vcs_retention(path: &Path) -> Option<VcsRetentionFile> {
    let text = std::fs::read(path).ok()?;
    let v = crate::js::parse_json(&String::from_utf8_lossy(&text)).ok()?;
    if v.get("schemaVersion").and_then(|x| x.as_f64()) != Some(VCS_RETENTION_SCHEMA_VERSION as f64) || !v.get("sessions").is_some_and(|s| s.is_array()) {
        return None;
    }
    serde_json::from_value(v).ok()
}

/// 照合の段の設定(TS の VcsStepOptions)
#[derive(Clone, Default)]
pub struct VcsStepOptions {
    pub retention: RetentionOptions,
    pub path_map: Vec<PathMapping>,
    /// 照合するセッション(無ければスナップショットの全部)
    pub ids: Option<HashSet<String>>,
}

// --- パスの読み替え ---

static WIN_PATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());

fn is_win_path(p: &str) -> bool {
    WIN_PATH_RE.is_match(p) || p.starts_with("\\\\")
}

/// 区切りを / にして、末尾の / を落とす
fn slashed(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// 比べるための形(区切りを / に、Windows のパスは大文字小文字を無視、末尾の区切りを落とす)
fn norm_for_match(p: &str) -> String {
    let s = slashed(p);
    if is_win_path(p) { js::to_lower(&s) } else { s }
}

/// 1 つのパスを読み替える。どの from にも当たらなければ None。長い from を優先する
pub fn map_path(path: &str, map: &[PathMapping]) -> Option<String> {
    let key = norm_for_match(path);
    let mut best: Option<&PathMapping> = None;
    let mut best_len: i64 = -1;
    for m in map {
        let from = norm_for_match(&m.from);
        if from.is_empty() {
            continue;
        }
        let len = js::utf16_len(&from) as i64;
        if (key == from || key.starts_with(&format!("{from}/"))) && len > best_len {
            best = Some(m);
            best_len = len;
        }
    }
    let best = best?;
    // 残りの部分は元のパスから取る(大文字小文字を変えない)。読み替えた後は、ログのパスと同じ形(resolve_file_path)にそろえる。
    // そろえないと、to を / で書いたときに区切りが混ざり、file_path_key で同じファイルと見なされなくなる(二重計上の判定が外れる)
    let s = slashed(path);
    let rest = js::utf16_slice(&s, best_len as usize, usize::MAX);
    let rest = rest.strip_prefix('/').unwrap_or(&rest);
    let trimmed = best.to.trim_end_matches(['\\', '/']);
    let to = if trimmed.is_empty() { best.to.as_str() } else { trimmed };
    Some(resolve_file_path(&if rest.is_empty() { to.to_string() } else { format!("{to}/{rest}") }, None))
}

/// セッションの作業フォルダとファイルのパスを読み替える。1 つでも読み替えたら true
pub fn apply_path_map(mut set: AiChangeSet, map: &[PathMapping]) -> (AiChangeSet, bool) {
    if map.is_empty() {
        return (set, false);
    }
    let mut mapped = false;
    let mut m = |p: &mut String| {
        if let Some(r) = map_path(p, map) {
            *p = r;
            mapped = true;
        }
    };
    if let Some(c) = set.context.cwd.as_mut() {
        m(c);
    }
    if let Some(g) = set.context.git_root.as_mut() {
        m(g);
    }
    for f in &mut set.files {
        m(&mut f.path);
    }
    for h in &mut set.hunks {
        m(&mut h.path);
    }
    (set, mapped)
}

// --- 送った側の結果を読む(共有フォルダに置かれたものなので、形を確かめ、決めた項目だけを作り直す) ---

const SENDER_HUNKS_MAX: usize = 20_000;
const STR_MAX: usize = 4096;
static UNSAFE_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]").unwrap());

fn obj(v: Option<&Value>) -> Option<&Map<String, Value>> {
    match v {
        Some(Value::Object(o)) => Some(o),
        _ => None,
    }
}

/// 0 以上 1e9 未満の整数
fn count(v: Option<&Value>) -> Option<i64> {
    let n = v.filter(|v| v.is_number()).and_then(Value::as_f64)?;
    (n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n < 1e9).then_some(n as i64)
}

/// 制御文字と見えない書式の文字を含まない、長すぎない文字列
fn safe_str(v: Option<&Value>, max: usize) -> Option<&str> {
    match v {
        Some(Value::String(s)) if js::utf16_len(s) <= max && !UNSAFE_CHARS.is_match(s) => Some(s),
        _ => None,
    }
}

fn iso_or_null(v: Option<&Value>) -> Option<&str> {
    safe_str(v, 64).filter(|s| !s.is_empty() && jsdate::parse_ms(s).is_some())
}

fn line_counts(v: Option<&Value>) -> Option<LineCounts> {
    let o = obj(v)?;
    let mut l = LineCounts::default();
    for k in RETENTION_STATUSES {
        *l.get_mut(k) = count(o.get(k.as_str()))?;
    }
    Some(l)
}

fn hunk_of(v: &Value) -> Option<HunkRetention> {
    let o = obj(Some(v))?;
    let id = count(o.get("id"));
    let path = safe_str(o.get("path"), STR_MAX);
    let status = o.get("status").and_then(Value::as_str).and_then(RetentionStatus::parse);
    let lines = line_counts(o.get("lines"));
    let (Some(id), Some(path), Some(status), Some(lines)) = (id, path, status, lines) else { return None };
    // 状態は行の内訳から決まる(vcs_retention.rs の classify_file と同じ決め方)。食い違うものは使わない(まとまりと行の内訳が合わなくなるため)
    if lines.kept + lines.modified + lines.missing + lines.unattributable == 0 || status_of_lines(&lines) != status {
        return None;
    }
    let reason = (status == RetentionStatus::Unattributable).then(|| o.get("reason").and_then(Value::as_str).and_then(UnattributableReason::parse).unwrap_or(UnattributableReason::ReadError));
    Some(HunkRetention { id, path: path.to_string(), status, reason, lines, at: iso_or_null(o.get("at")).map(str::to_string), reason_last: true })
}

/// 送った側の結果(UPLOAD_VCS_META の中身)を読む。形が違う・ほかのセッションのものなら None。
/// 件数は書いてある数を信じず、まとまりから数え直す(分母と内訳が食い違わないように)
pub fn parse_sender_vcs(json: &Value, id: &str) -> Option<SessionRetention> {
    let j = obj(Some(json))?;
    if !j.get("version").and_then(Value::as_f64).is_some_and(|v| v == 1.0) || j.get("sessionId").and_then(Value::as_str) != Some(id) {
        return None;
    }
    let r = obj(j.get("result"))?;
    if r.get("sessionId").and_then(Value::as_str) != Some(id) {
        return None;
    }
    let Some(Value::Array(raw_hunks)) = r.get("hunks") else { return None };
    if raw_hunks.len() > SENDER_HUNKS_MAX {
        return None;
    }
    let mut hunks = Vec::with_capacity(raw_hunks.len());
    let mut seen = HashSet::new();
    for h in raw_hunks {
        // 同じ番号のまとまりが 2 つあるものは、数え直しで二重に数えるので使わない
        let x = hunk_of(h)?;
        if !seen.insert(x.id) {
            return None;
        }
        hunks.push(x);
    }
    let vcs = r.get("vcs").and_then(Value::as_str).and_then(VcsKind::parse);
    let baseline = obj(r.get("baseline")).and_then(|b| {
        let rev = safe_str(b.get("rev"), 200).filter(|s| !s.is_empty())?;
        let source = match b.get("source").and_then(Value::as_str) {
            Some("observed") => RevisionSource::Observed,
            Some("estimated") => RevisionSource::Estimated,
            _ => return None,
        };
        Some(Revision { rev: rev.to_string(), source })
    });
    // 照合した日時と見方は送った側のもの(この PC で集計した日時・既定の見方で埋めない)。セッションの記録に無ければ、添えたファイルの値を使う
    let sender_mode = j.get("mode").and_then(Value::as_str).and_then(EvalMode::parse);
    let sender_at = iso_or_null(j.get("computedAt"));
    let evaluated = match obj(r.get("evaluated")).and_then(|e| Some((e, e.get("mode").and_then(Value::as_str).and_then(EvalMode::parse)?))) {
        Some((e, mode)) => Some(Evaluated { mode, rev: safe_str(e.get("rev"), 200).map(str::to_string), at: iso_or_null(e.get("at")).or(sender_at).unwrap_or("").to_string() }),
        None => sender_mode.map(|mode| Evaluated { mode, rev: None, at: sender_at.unwrap_or("").to_string() }),
    };
    let mut out = SessionRetention {
        session_id: id.to_string(),
        outcome: Outcome::NoAiChanges,
        reason: None,
        vcs,
        root: safe_str(r.get("root"), STR_MAX).map(str::to_string),
        provenance: Provenance { ai_changes: "events".into(), baseline: baseline.as_ref().map(|b| b.source), context: JsMap::new() },
        baseline,
        evaluated,
        hunks,
        excluded_hunks: count(r.get("excludedHunks")).unwrap_or(0),
        counts: LineCounts::default(),
        lines: LineCounts::default(),
        computed_on: Some(ComputedOn::Sender),
        path_mapped: matches!(r.get("pathMapped"), Some(Value::Bool(true))).then_some(true),
        session_end: iso_or_null(r.get("sessionEnd")).map(|s| Some(s.to_string())),
        unread_edits: count(r.get("unreadEdits")).filter(|n| *n != 0),
        sender_order: true,
    };
    // 送った側で「照合不可」だったときの理由も、まとまりの理由から決め直す
    finish_counts(&mut out);
    Some(out)
}

/// まとまりから件数・行数・結果を数え直す(measure_retention と同じ決め方)
fn finish_counts(r: &mut SessionRetention) {
    tally(r);
    r.reason = None;
    if r.counts.kept + r.counts.modified + r.counts.missing > 0 {
        r.outcome = Outcome::Measured;
    } else if r.counts.unattributable > 0 {
        r.outcome = Outcome::Unattributable;
        r.reason = Some(top_reason(&r.hunks).unwrap_or(UnattributableReason::ReadError));
    } else {
        r.outcome = Outcome::NoAiChanges;
    }
}

/// AI の変更はあるが照合していない(送った側の結果が無い)セッションの結果。
/// どこでも照合していないので computed_on は付けない(「送った側の PC で照合」と読めないように)
fn not_measured(set: AiChangeSet) -> SessionRetention {
    let hunks = set
        .hunks
        .iter()
        .map(|h| HunkRetention {
            id: h.id,
            path: h.path.clone(),
            status: RetentionStatus::Unattributable,
            reason: Some(UnattributableReason::NotMeasured),
            lines: LineCounts { unattributable: h.lines.len() as i64, ..Default::default() },
            at: h.at.clone().filter(|a| !a.is_empty()),
            reason_last: false,
        })
        .collect();
    let mut r = SessionRetention {
        session_id: set.session_id,
        outcome: Outcome::NoAiChanges,
        reason: None,
        vcs: None,
        root: None,
        baseline: None,
        evaluated: None,
        hunks,
        excluded_hunks: 0,
        counts: LineCounts::default(),
        lines: LineCounts::default(),
        provenance: Provenance { ai_changes: "events".into(), baseline: None, context: set.context.sources },
        path_mapped: None,
        computed_on: None,
        session_end: Some(set.context.end),
        unread_edits: (set.skipped.no_material != 0).then_some(set.skipped.no_material),
        sender_order: false,
    };
    finish_counts(&mut r);
    r
}

/// 送った側の結果の、照合した日時の範囲と見方の内訳(照合していないセッションは数えない)
fn sender_summary(results: &[SessionRetention]) -> Option<SenderSummary> {
    let mut s = SenderSummary::default();
    for r in results {
        if r.computed_on != Some(ComputedOn::Sender) {
            continue;
        }
        s.sessions += 1;
        if let Some(e) = &r.evaluated {
            s.modes.inc(e.mode.as_str(), 1);
            let at = &e.at;
            if !at.is_empty() {
                if s.from.as_ref().is_none_or(|f| js::cmp_utf16(at, f).is_lt()) {
                    s.from = Some(at.clone());
                }
                if s.to.as_ref().is_none_or(|t| js::cmp_utf16(at, t).is_gt()) {
                    s.to = Some(at.clone());
                }
            }
        }
    }
    (s.sessions != 0).then_some(s)
}

// --- 段の本体 ---

/// 1 つのセッションのフォルダから AI の変更を取り出す(events.jsonl が無ければ変更なし)
pub fn read_ai_changes(dir: &Path, id: &str) -> anyhow::Result<AiChangeSet> {
    let ws: Option<WorkspaceHints> = read_workspace_yaml(&dir.join("workspace.yaml")).ok().flatten().map(|w| WorkspaceHints::from(&w));
    let events_path = dir.join("events.jsonl");
    let mut b = AiChangeBuilder::new(id);
    if jsfs::exists(&events_path) {
        let mut r = EventReader::open(&events_path)?;
        while let Some(e) = r.next_event()? {
            b.push(&e);
        }
    }
    Ok(b.finish(ws.as_ref()))
}

/// スナップショットの形(snapshot-manifest.json の layout)。アップロード先から集計したもの(flat・merged)か
fn is_uploaded(snapshot_dir: &Path) -> anyhow::Result<bool> {
    let p = snapshot_dir.join(SNAPSHOT_MANIFEST);
    if !jsfs::exists(&p) {
        return Ok(false);
    }
    let v = js::parse_json(&String::from_utf8_lossy(&std::fs::read(&p)?))?;
    Ok(matches!(v.get("layout").and_then(Value::as_str), Some("flat" | "merged")))
}

/// スナップショット(out/snapshot)の全セッションを照合する
pub fn run_vcs_step(snapshot_dir: &Path, opts: &VcsStepOptions) -> anyhow::Result<VcsRetentionFile> {
    let uploaded = is_uploaded(snapshot_dir)?;
    let state_dir = snapshot_dir.join("session-state");
    let ids: Vec<String> = if jsfs::exists(&state_dir) { list_session_dirs(&state_dir)? } else { Vec::new() };
    let ids: Vec<String> = ids.into_iter().filter(|id| opts.ids.as_ref().is_none_or(|s| s.contains(id))).collect();
    let mode = opts.retention.mode;
    let similarity = opts.retention.similarity;
    let map = &opts.path_map;
    let mut results: Vec<SessionRetention>;

    // events.jsonl はディスクを読むだけなので、いくつか同時に(結果は ids の順)
    if uploaded {
        results = ids
            .par_iter()
            .map(|id| -> anyhow::Result<SessionRetention> {
                let dir = state_dir.join(id);
                let meta_path = dir.join(UPLOAD_VCS_META);
                let sender = if jsfs::exists(&meta_path) {
                    std::fs::read(&meta_path).ok().and_then(|b| js::parse_json(&String::from_utf8_lossy(&b)).ok()).and_then(|v| parse_sender_vcs(&v, id))
                } else {
                    None
                };
                Ok(match sender {
                    Some(s) => s,
                    None => not_measured(read_ai_changes(&dir, id)?),
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
    } else {
        let read = ids.par_iter().map(|id| Ok(apply_path_map(read_ai_changes(&state_dir.join(id), id)?, map))).collect::<anyhow::Result<Vec<_>>>()?;
        let mapped: HashSet<String> = read.iter().filter(|r| r.1).map(|r| r.0.session_id.clone()).collect();
        let sets: Vec<AiChangeSet> = read.into_iter().map(|r| r.0).collect();
        results = measure_retention(&sets, &opts.retention);
        for r in &mut results {
            r.computed_on = Some(ComputedOn::Local);
            if mapped.contains(&r.session_id) {
                r.path_mapped = Some(true);
            }
        }
    }
    results.sort_by(|a, b| js::cmp_utf16(&a.session_id, &b.session_id));
    let senders = if uploaded { sender_summary(&results) } else { None };
    // 送り先から集計したときの見方は、送った側でいちばん多かったもの(送った側の結果が無ければ指定・既定のまま)
    let sender_mode = senders.as_ref().and_then(|s| {
        let mut e: Vec<(&String, &i64)> = s.modes.js_entries();
        e.sort_by(|a, b| b.1.cmp(a.1));
        e.first().and_then(|x| EvalMode::parse(x.0))
    });
    Ok(VcsRetentionFile {
        schema_version: VCS_RETENTION_SCHEMA_VERSION,
        generated_at: jsdate::to_iso(opts.retention.now_ms.unwrap_or_else(jsdate::now_ms)),
        computed_on: if uploaded { ComputedOn::Sender } else { ComputedOn::Local },
        mode: sender_mode.unwrap_or(mode),
        similarity,
        path_map: map.len() as i64,
        lag_days: (mode == EvalMode::Fixed && !uploaded).then_some(opts.retention.lag_days),
        senders: uploaded.then_some(senders),
        summary: summarize_retention(&results),
        sessions: results,
        labels: None,
        note: None,
    })
}

/// アップロードでセッションのフォルダに添える中身(送った側の PC の結果)
pub fn sender_vcs_json(r: &SessionRetention, generated_at: &str, mode: EvalMode) -> String {
    let body = SenderVcsFile { version: 1, session_id: r.session_id.clone(), computed_at: generated_at.to_string(), mode, result: r.clone() };
    format!("{}\n", crate::json::to_js_string_pretty(&body).expect("JSON に書ける"))
}

#[cfg(test)]
mod tests;
