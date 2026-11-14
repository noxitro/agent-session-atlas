//! スナップショットから sessions.json を作る(packages/core/src/extract.ts の移植)。
//! 索引は session-store.db の sessions とディレクトリの和集合。
//!
//! セッションごとのファイル(workspace.yaml・events.jsonl・session.db・送った側の記録)を読んで正規化するところは
//! rayon で並べて行う(TS 版は読み込みだけを 8 本並べ、解析は 1 つのスレッドで順に進めていた)。
//! プロジェクト名を決める・数を足す・警告を並べるところは、TS 版と同じく id の順に 1 つずつ行う。

use crate::atlas_version::{parse_atlas_build, AtlasBuild};
use crate::desktop::{desktop_for_session, DesktopData};
use crate::events::EventReader;
use crate::instructions::resolve_instructions;
use crate::js::{self, JsMap};
use crate::jsdate;
use crate::nodepath::platform;
use crate::normalize::{normalize_session, DbInput, NormalizeInput};
use crate::project::{os_homedir, ProjectInput, ProjectResolver, ProjectResolverOptions, ATLAS_JUDGE_PROJECT, HOME_PROJECT, TEMP_PROJECT};
use crate::snapshot::{
    has_session_file, is_upload_work_dir, person_of_folder, read_snapshot_manifest, upload_work_dir_id, SourceLayout, DESKTOP_JSON, SESSION_STORE_JSON, SNAPSHOT_SESSION_DB, UPLOAD_OLD_ONLY_REASON,
    UPLOAD_SESSION_META, UPLOAD_WORK_REASON,
};
use crate::sqlite::open_read_only;
use crate::types::*;
use crate::wiki::{WikiClassifier, WikiSpec};
use anyhow::{anyhow, Result};
use rayon::prelude::*;
use regex::Regex;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

/// session-store.db から読んだ行(セッション id ごと)
#[derive(Default)]
pub struct StoreData {
    pub sessions: HashMap<String, DbSessionRow>,
    pub turns: HashMap<String, Vec<DbTurnRow>>,
    pub usage: HashMap<String, Vec<DbUsageRow>>,
    pub files: HashMap<String, Vec<DbFileRow>>,
    pub schema_version: Option<f64>,
}

fn table_exists(db: &Connection, name: &str) -> rusqlite::Result<bool> {
    let mut st = db.prepare_cached("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")?;
    st.exists([name])
}

/// SQLite の値を JS の値にしたもの(node:sqlite と同じ: 整数・実数は数、文字列、NULL)
fn sql_value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => serde_json::json!(i as f64),
        ValueRef::Real(f) => serde_json::json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        // Uint8Array。String() にすると "1,2,3"
        ValueRef::Blob(b) => Value::String(b.iter().map(u8::to_string).collect::<Vec<_>>().join(",")),
    }
}

/// 行を列名 → 値のオブジェクトにする
fn rows_as_objects(db: &Connection, sql: &str) -> rusqlite::Result<Vec<serde_json::Map<String, Value>>> {
    let mut st = db.prepare(sql)?;
    let names: Vec<String> = st.column_names().map(|s| s.to_string()).collect();
    let mut rows = st.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let mut m = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), sql_value(r.get_ref(i)?));
        }
        out.push(m);
    }
    Ok(out)
}

fn s_col(m: &serde_json::Map<String, Value>, k: &str) -> Option<String> {
    js::string_or_null(m.get(k))
}

fn n_col(m: &serde_json::Map<String, Value>, k: &str) -> Option<f64> {
    m.get(k).and_then(Value::as_f64)
}

fn session_row(m: &serde_json::Map<String, Value>) -> DbSessionRow {
    DbSessionRow {
        id: s_col(m, "id").unwrap_or_default(),
        cwd: s_col(m, "cwd"),
        repository: s_col(m, "repository"),
        host_type: s_col(m, "host_type"),
        branch: s_col(m, "branch"),
        summary: s_col(m, "summary"),
        created_at: s_col(m, "created_at"),
        updated_at: s_col(m, "updated_at"),
    }
}

fn turn_row(m: &serde_json::Map<String, Value>) -> DbTurnRow {
    DbTurnRow {
        session_id: s_col(m, "session_id").unwrap_or_default(),
        turn_index: n_col(m, "turn_index").unwrap_or(0.0),
        user_message: s_col(m, "user_message"),
        assistant_response: s_col(m, "assistant_response"),
        timestamp: s_col(m, "timestamp"),
    }
}

fn usage_row(m: &serde_json::Map<String, Value>) -> DbUsageRow {
    DbUsageRow {
        id: n_col(m, "id"),
        session_id: s_col(m, "session_id").unwrap_or_default(),
        turn_index: n_col(m, "turn_index"),
        agent_id: s_col(m, "agent_id"),
        parent_tool_call_id: s_col(m, "parent_tool_call_id"),
        model: s_col(m, "model").unwrap_or_default(),
        input_tokens: n_col(m, "input_tokens"),
        output_tokens: n_col(m, "output_tokens"),
        cache_read_tokens: n_col(m, "cache_read_tokens"),
        cache_write_tokens: n_col(m, "cache_write_tokens"),
        reasoning_tokens: n_col(m, "reasoning_tokens"),
        total_nano_aiu: n_col(m, "total_nano_aiu"),
        request_multiplier: n_col(m, "request_multiplier"),
        initiator: s_col(m, "initiator"),
        reasoning_effort: s_col(m, "reasoning_effort"),
        finish_reason: s_col(m, "finish_reason"),
        duration_ms: n_col(m, "duration_ms"),
        time_to_first_token_ms: n_col(m, "time_to_first_token_ms"),
        created_at: s_col(m, "created_at"),
    }
}

fn file_row(m: &serde_json::Map<String, Value>) -> DbFileRow {
    DbFileRow {
        session_id: s_col(m, "session_id").unwrap_or_default(),
        file_path: s_col(m, "file_path").unwrap_or_default(),
        tool_name: s_col(m, "tool_name"),
        turn_index: n_col(m, "turn_index"),
        first_seen_at: s_col(m, "first_seen_at"),
    }
}

fn group<T>(rows: Vec<T>, key: impl Fn(&T) -> &str) -> HashMap<String, Vec<T>> {
    let mut m: HashMap<String, Vec<T>> = HashMap::new();
    for r in rows {
        m.entry(key(&r).to_string()).or_default().push(r);
    }
    m
}

/// session-store.db(スナップショット側)を読む。無ければ空
pub fn load_store(db_path: &Path) -> Result<StoreData> {
    if !db_path.exists() {
        return Ok(StoreData::default());
    }
    let db = open_read_only(db_path)?;
    let all = |table: &str, sql: &str| -> rusqlite::Result<Vec<serde_json::Map<String, Value>>> { if table_exists(&db, table)? { rows_as_objects(&db, sql) } else { Ok(Vec::new()) } };
    let sessions = all("sessions", "SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at FROM sessions")?;
    let turns = all("turns", "SELECT session_id, turn_index, user_message, assistant_response, timestamp FROM turns")?;
    let usage = all("assistant_usage_events", "SELECT * FROM assistant_usage_events ORDER BY id")?;
    let files = all("session_files", "SELECT session_id, file_path, tool_name, turn_index, first_seen_at FROM session_files")?;
    let sv = if table_exists(&db, "schema_version")? { rows_as_objects(&db, "SELECT version FROM schema_version")?.into_iter().next().and_then(|m| n_col(&m, "version")) } else { None };
    let mut out = StoreData { schema_version: sv, ..Default::default() };
    for s in sessions {
        let r = session_row(&s);
        out.sessions.insert(r.id.clone(), r);
    }
    out.turns = group(turns.iter().map(turn_row).collect(), |r| &r.session_id);
    out.usage = group(usage.iter().map(usage_row).collect(), |r| &r.session_id);
    out.files = group(files.iter().map(file_row).collect(), |r| &r.session_id);
    Ok(out)
}

fn is_row(v: &Value) -> bool {
    v.is_object()
}

fn is_row_or_null(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Null) | Some(Value::Object(_)))
}

fn is_rows(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Array(a)) if a.iter().all(is_row))
}

/// 添えた行の列の型。s / n は文字列 / 数値(null か欠けていてもよい)、S / N は必ずある文字列 / 数値
const SESSION_COLS: &[(&str, char)] = &[("cwd", 's'), ("repository", 's'), ("host_type", 's'), ("branch", 's'), ("summary", 's'), ("created_at", 's'), ("updated_at", 's')];
const TURN_COLS: &[(&str, char)] = &[("turn_index", 'N'), ("user_message", 's'), ("assistant_response", 's'), ("timestamp", 's')];
const USAGE_COLS: &[(&str, char)] = &[
    ("id", 'n'),
    ("turn_index", 'n'),
    ("agent_id", 's'),
    ("parent_tool_call_id", 's'),
    ("model", 'S'),
    ("input_tokens", 'n'),
    ("output_tokens", 'n'),
    ("cache_read_tokens", 'n'),
    ("cache_write_tokens", 'n'),
    ("reasoning_tokens", 'n'),
    ("total_nano_aiu", 'n'),
    ("request_multiplier", 'n'),
    ("initiator", 's'),
    ("reasoning_effort", 's'),
    ("finish_reason", 's'),
    ("duration_ms", 'n'),
    ("time_to_first_token_ms", 'n'),
    ("created_at", 's'),
];
const FILE_COLS: &[(&str, char)] = &[("file_path", 'S'), ("tool_name", 's'), ("turn_index", 'n'), ("first_seen_at", 's')];

/// 添えた行が、DB から読んだ行と同じ形か。違えば理由
fn check_rows(table: &str, rows: &[Value], key: &str, id: &str, cols: &[(&str, char)]) -> std::result::Result<(), String> {
    for r in rows {
        let Some(row) = r.as_object() else { return Err(format!("形が違います({table} の行)")) };
        if js::str_of(row.get(key)) != Some(id) {
            continue; // ほかのセッションの行は使わない
        }
        for (k, kind) in cols {
            if (*kind == 'S' || *kind == 'N') && js::present(row.get(*k)).is_none() {
                return Err(format!("形が違います({table} の {k} が無い)"));
            }
        }
        for (k, v) in row {
            if v.is_null() || k == key {
                continue;
            }
            let kind = cols.iter().find(|(c, _)| c == k).map(|(_, t)| t.to_ascii_lowercase());
            let ok = match kind {
                Some('s') => v.is_string(),
                Some('n') => v.is_number(),
                _ => !v.is_object() && !v.is_array(),
            };
            if !ok {
                return Err(format!("形が違います({table} の {k})"));
            }
        }
    }
    Ok(())
}

/// セッションのフォルダに添えた行(SESSION_STORE_JSON)を store に足す。session-store.db に同じセッションの行があればそちらを優先する。読めなければ理由を返す
pub fn merge_session_store_json(store: &mut StoreData, id: &str, path: &Path, desktops: &mut HashMap<String, DesktopSessionInfo>) -> Option<String> {
    let read = || -> std::result::Result<serde_json::Map<String, Value>, String> {
        let text = std::fs::read(path).map_err(|e| e.to_string())?;
        let v = js::parse_json(&String::from_utf8_lossy(&text)).map_err(|e| e.to_string())?;
        let Value::Object(j) = v else { return Err("形が違います".into()) };
        let arr = |k: &str| matches!(j.get(k), Some(Value::Array(_)));
        if !matches!(j.get("version"), Some(Value::Number(n)) if n.as_f64() == Some(1.0)) || !arr("sessions") || !arr("turns") || !arr("usage") || !arr("files") {
            return Err("形が違います".into());
        }
        let a = |k: &str| j[k].as_array().unwrap();
        check_rows("sessions", a("sessions"), "id", id, SESSION_COLS)?;
        check_rows("turns", a("turns"), "session_id", id, TURN_COLS)?;
        check_rows("usage", a("usage"), "session_id", id, USAGE_COLS)?;
        check_rows("files", a("files"), "session_id", id, FILE_COLS)?;
        Ok(j)
    };
    let j = match read() {
        Ok(j) => j,
        Err(e) => return Some(format!("{id}: {SESSION_STORE_JSON} を読めない ({e})")),
    };
    let mine = |k: &str, key: &str| -> Vec<serde_json::Map<String, Value>> {
        j[k].as_array().unwrap().iter().filter_map(|r| r.as_object()).filter(|r| js::str_of(r.get(key)) == Some(id)).cloned().collect()
    };
    // 別のセッションの行が混じっていても、このフォルダのセッションの分だけを使う
    if let Some(s) = mine("sessions", "id").into_iter().next() {
        if !store.sessions.contains_key(id) {
            store.sessions.insert(id.to_string(), session_row(&s));
        }
    }
    let turns: Vec<DbTurnRow> = mine("turns", "session_id").iter().map(turn_row).collect();
    if !turns.is_empty() && store.turns.get(id).is_none_or(Vec::is_empty) {
        store.turns.insert(id.to_string(), turns);
    }
    let usage: Vec<DbUsageRow> = mine("usage", "session_id").iter().map(usage_row).collect();
    if !usage.is_empty() && store.usage.get(id).is_none_or(Vec::is_empty) {
        store.usage.insert(id.to_string(), usage);
    }
    let files: Vec<DbFileRow> = mine("files", "session_id").iter().map(file_row).collect();
    if !files.is_empty() && store.files.get(id).is_none_or(Vec::is_empty) {
        store.files.insert(id.to_string(), files);
    }
    if store.schema_version.is_none() {
        if let Some(v) = js::present(j.get("schemaVersion")).and_then(Value::as_f64) {
            store.schema_version = Some(v);
        }
    }
    // data.db の行(desktop.json に同じセッションがあればそちらを使う)。形が違えば使わない
    let d = js::present(j.get("desktop"))?;
    let ok = d.as_object().is_some_and(|o| {
        is_row_or_null(o.get("session")) && is_rows(o.get("contextUsage")) && is_rows(o.get("checkpoints")) && is_rows(o.get("activity")) && is_row_or_null(o.get("workspace")) && is_row_or_null(o.get("project"))
    });
    match ok.then(|| serde_json::from_value::<DesktopSessionInfo>(d.clone()).ok()).flatten() {
        Some(info) => {
            desktops.insert(id.to_string(), info);
            None
        }
        None => Some(format!("{id}: {SESSION_STORE_JSON} の desktop の形が違うため使いません")),
    }
}

/// デスクトップアプリが作ったばかりのセッションの workspace.yaml に残る仮の名前
const PLACEHOLDER_NAMES: &[&str] = &["New session"];

/// セッションの名前。workspace.yaml の名前が無いか仮の名前のままなら、デスクトップアプリの data.db の題名を使う
pub fn session_name(name: Option<String>, desktop_title: Option<&Value>) -> Option<String> {
    let t = js::str_of(desktop_title).map(js::trim).unwrap_or("");
    let name_blank = name.as_deref().is_none_or(|n| js::trim(n).is_empty() || PLACEHOLDER_NAMES.contains(&js::trim(n)));
    if !t.is_empty() && name_blank { Some(t.to_string()) } else { name }
}

const PROJECT_SOURCES: &[&str] = &["repository", "git-remote", "path", "home", "temp", "atlas-judge", "unknown"];

fn grouped_source(project: &str) -> Option<ProjectSource> {
    match project {
        TEMP_PROJECT => Some(ProjectSource::Temp),
        HOME_PROJECT => Some(ProjectSource::Home),
        ATLAS_JUDGE_PROJECT => Some(ProjectSource::AtlasJudge),
        _ => None,
    }
}

static INVISIBLE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]").unwrap());

/// 送った側が決めたプロジェクト名とその決め方
#[derive(Debug, Clone, PartialEq)]
pub struct SenderProject {
    pub project: String,
    pub source: Option<ProjectSource>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SenderMeta {
    pub project: Option<SenderProject>,
    pub tags: Vec<String>,
    pub atlas: Option<AtlasBuild>,
}

/// アップロードで添えた記録(UPLOAD_SESSION_META)を読み、プロジェクト名・タスクタグ・atlas の版を返す。
/// 無い・読めない・形が違う・ほかのセッションのものなら None
pub fn read_sender_meta(path: &Path, id: &str) -> Option<SenderMeta> {
    if !path.exists() {
        return None;
    }
    let text = std::fs::read(path).ok()?;
    let Value::Object(j) = js::parse_json(&String::from_utf8_lossy(&text)).ok()? else { return None };
    if !matches!(j.get("version"), Some(Value::Number(n)) if n.as_f64() == Some(1.0)) || js::str_of(j.get("id")) != Some(id) {
        return None;
    }
    Some(SenderMeta { project: sender_project_of(&j), tags: sender_tags_of(&j), atlas: parse_atlas_build(j.get("atlas")) })
}

pub fn read_sender_project(path: &Path, id: &str) -> Option<SenderProject> {
    read_sender_meta(path, id)?.project
}

pub fn read_sender_tags(path: &Path, id: &str) -> Vec<String> {
    read_sender_meta(path, id).map(|m| m.tags).unwrap_or_default()
}

fn sender_project_of(j: &serde_json::Map<String, Value>) -> Option<SenderProject> {
    let raw = js::str_of(j.get("project")).filter(|p| js::utf16_len(p) <= 1000)?;
    let project = js::trim(raw);
    if project.is_empty() || INVISIBLE_RE.is_match(project) {
        return None;
    }
    if let Some(g) = grouped_source(project) {
        return Some(SenderProject { project: project.into(), source: Some(g) });
    }
    let source = js::str_of(j.get("projectSource")).filter(|s| PROJECT_SOURCES.contains(s)).and_then(ProjectSource::parse);
    let source = source.filter(|s| !matches!(s, ProjectSource::Temp | ProjectSource::Home | ProjectSource::AtlasJudge));
    Some(SenderProject { project: project.into(), source })
}

/// 送った人のタスクタグの数と長さの上限
const SENDER_TAGS_MAX: usize = 50;
const SENDER_TAG_CHARS: usize = 100;

fn sender_tags_of(j: &serde_json::Map<String, Value>) -> Vec<String> {
    let Some(Value::Array(tags)) = j.get("tags") else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        if out.len() >= SENDER_TAGS_MAX {
            break;
        }
        let Value::String(t) = t else { continue };
        let name = js::trim(t);
        if name.is_empty() || js::code_points(name) > SENDER_TAG_CHARS || INVISIBLE_RE.is_match(name) || out.iter().any(|x| x == name) {
            continue;
        }
        out.push(name.to_string());
    }
    out
}

static OWNER_REPO_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&crate::turns::js_re(r"^[^\\/:\s]+\/[^\\/:\s]+$")).unwrap());

/// 決め方の記録が無いプロジェクト名から、決め方を推す
fn infer_project_source(project: &str) -> ProjectSource {
    if let Some(g) = grouped_source(project) {
        return g;
    }
    if OWNER_REPO_RE.is_match(project) { ProjectSource::GitRemote } else { ProjectSource::Path }
}

/// スナップショット側の session.db から todo の状態別件数と依存の数を読む(タイトル・説明は読まない)。ファイルが無ければ None
pub fn read_todos(db_path: &Path) -> Result<Option<TodoSummary>> {
    if !db_path.exists() {
        return Ok(None);
    }
    let db = open_read_only(db_path)?;
    let mut out = TodoSummary::default();
    if table_exists(&db, "todos")? {
        let mut st = db.prepare("SELECT status, count(*) AS n FROM todos GROUP BY status")?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let k = match sql_value(r.get_ref(0)?) {
                Value::Null => "(unknown)".to_string(),
                v => js::to_js_string(&v),
            };
            let n = sql_value(r.get_ref(1)?).as_f64().unwrap_or(0.0);
            *out.by_status.entry(k).or_insert(0.0) += n;
            out.total += n;
        }
    }
    if table_exists(&db, "todo_deps")? {
        out.deps = db.query_row("SELECT count(*) AS n FROM todo_deps", [], |r| r.get::<_, i64>(0))? as f64;
    }
    Ok(Some(out))
}

fn yaml_scalar(y: &yaml_rust2::Yaml) -> Option<String> {
    use yaml_rust2::Yaml;
    match y {
        Yaml::Null | Yaml::BadValue => None,
        Yaml::String(s) => Some(s.clone()),
        Yaml::Integer(i) => Some(js::num_to_string(*i as f64)),
        Yaml::Real(r) => Some(match r.parse::<f64>() {
            Ok(v) => js::num_to_string(v),
            Err(_) => match r.trim_start_matches(['+', '-']).to_ascii_lowercase().as_str() {
                ".inf" => if r.starts_with('-') { "-Infinity".into() } else { "Infinity".into() },
                _ => "NaN".into(),
            },
        }),
        Yaml::Boolean(b) => Some(b.to_string()),
        Yaml::Array(a) => Some(a.iter().map(|x| yaml_scalar(x).unwrap_or_default()).collect::<Vec<_>>().join(",")),
        Yaml::Hash(_) => Some("[object Object]".into()),
        Yaml::Alias(_) => None,
    }
}

/// workspace.yaml を読む(無ければ None)。マップでなければ失敗
pub fn read_workspace_yaml(path: &Path) -> Result<Option<WorkspaceInfo>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&std::fs::read(path)?).into_owned();
    let docs = yaml_rust2::YamlLoader::load_from_str(&text).map_err(|e| anyhow!("{e}"))?;
    if docs.len() > 1 {
        return Err(anyhow!("Source contains multiple documents; please use YAML.parseAllDocuments()"));
    }
    let Some(yaml_rust2::Yaml::Hash(h)) = docs.into_iter().next() else {
        return Err(anyhow!("workspace.yaml がマップでない: {}", path.display()));
    };
    let mut w = WorkspaceInfo::default();
    for (k, v) in h {
        let Some(k) = yaml_scalar(&k) else { continue };
        let v = yaml_scalar(&v);
        match k.as_str() {
            "id" => w.id = v,
            "cwd" => w.cwd = v,
            "git_root" => w.git_root = v,
            "repository" => w.repository = v,
            "branch" => w.branch = v,
            "name" => w.name = v,
            "summary" => w.summary = v,
            "client_name" => w.client_name = v,
            "host_type" => w.host_type = v,
            "created_at" => w.created_at = v,
            "updated_at" => w.updated_at = v,
            _ => {}
        }
    }
    Ok(Some(w))
}

/// session-state/ 配下のセッションのフォルダ(名前の順)
pub fn list_session_dirs(state_dir: &Path) -> Result<Vec<String>> {
    Ok(list_state_dirs(state_dir)?.0)
}

/// session-state/ 配下の、セッションのファイルを持つフォルダの名前(セッションのフォルダ・アップロードの作業用のフォルダ。どちらも名前の順)
fn list_state_dirs(state_dir: &Path) -> Result<(Vec<String>, Vec<String>)> {
    let mut sessions = Vec::new();
    let mut work = Vec::new();
    if !state_dir.exists() {
        return Ok((sessions, work));
    }
    for ent in std::fs::read_dir(state_dir)? {
        let ent = ent?;
        if !ent.file_type()?.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        if !has_session_file(&state_dir.join(&name)) {
            continue;
        }
        if is_upload_work_dir(&name) { work.push(name) } else { sessions.push(name) }
    }
    sessions.sort_by(|a, b| js::cmp_utf16(a, b));
    work.sort_by(|a, b| js::cmp_utf16(a, b));
    Ok((sessions, work))
}

/// 進み具合の通知(done, total, id)
pub type Progress<'a> = &'a (dyn Fn(usize, usize, &str) + Sync);

#[derive(Default)]
pub struct ExtractOptions<'a> {
    /// 指定時はこの時刻以降に更新されたセッションだけ(None ならスナップショットの since を使う。Some(None) は絞らない)
    pub since: Option<Option<String>>,
    pub on_progress: Option<Progress<'a>>,
    /// プロジェクトの統合の設定。None なら統合しない(パスのまま)
    pub projects: Option<ProjectResolverOptions>,
    /// 参照を数える wiki の vault
    pub wikis: Vec<WikiSpec>,
}

impl ExtractOptions<'_> {
    /// プロジェクトの統合を既定の設定で行う
    pub fn new() -> Self {
        ExtractOptions { projects: Some(ProjectResolverOptions::default()), ..Default::default() }
    }
}

/// スナップショット元が <home>/.copilot なら、その <home> もホームとして扱う
fn with_source_home(mut o: ProjectResolverOptions, source_root: Option<&str>) -> ProjectResolverOptions {
    let Some(root) = source_root.filter(|r| !r.is_empty()) else { return o };
    if o.homes.is_some() {
        return o;
    }
    // split(/[\\/]+/) の最後(末尾が区切りなら空)
    let last = root.rsplit(['\\', '/']).next().unwrap_or("");
    if js::to_lower(last) != ".copilot" {
        return o;
    }
    o.homes = Some(vec![os_homedir(), platform::dirname(root)]);
    o
}

fn join_names(v: &[String], sep: &str) -> String {
    let more = if v.len() > 3 { " ほか" } else { "" };
    format!("{}{more}", v.iter().take(3).cloned().collect::<Vec<_>>().join(sep))
}

/// セッション 1 件を読んだもの(並べて読む部分の結果)
struct Loaded {
    id: String,
    rec: SessionRecord,
    bad_lines: i64,
    meta: Option<SenderMeta>,
    notes: Vec<String>,
}

/// スナップショット(snapshot() の出力先、または同じ構造のディレクトリ)から sessions.json を作る
pub fn extract(snapshot_dir: &Path, opts: &ExtractOptions<'_>) -> Result<SessionsFile> {
    let manifest = read_snapshot_manifest(snapshot_dir)?;
    let since: Option<String> = match &opts.since {
        Some(s) => s.clone(),
        None => manifest.as_ref().and_then(|m| m.since.clone()),
    };
    // Date.parse が NaN なら、どのセッションも残らない(TS 版と同じ)
    let since_ms: Option<f64> = since.as_deref().filter(|s| !s.is_empty()).map(|s| jsdate::parse_ms(s).map_or(f64::NAN, |v| v as f64));
    let mut store = load_store(&snapshot_dir.join("session-store.db"))?;
    let mut messages: Vec<String> = Vec::new();
    // Phase 11: data.db の許可リストの列(snapshot が desktop.json に書いたもの)。無ければ None
    let mut desktop: Option<DesktopData> = None;
    let desktop_path = snapshot_dir.join(DESKTOP_JSON);
    if desktop_path.exists() {
        match std::fs::read(&desktop_path).map_err(|e| e.to_string()).and_then(|b| js::parse_json_as::<DesktopData>(&String::from_utf8_lossy(&b)).map_err(|e| e.to_string())) {
            Ok(d) => desktop = Some(d),
            Err(e) => messages.push(format!("{DESKTOP_JSON} を読めない(デスクトップアプリの記録は使っていない): {e}")),
        }
    }
    let state_dir = snapshot_dir.join("session-state");
    let (listed_sessions, listed_work) = list_state_dirs(&state_dir)?;
    let dirs: HashSet<String> = listed_sessions.iter().cloned().collect();
    let skipped = manifest.as_ref().and_then(|m| m.extras.as_ref()).map(|x| x.skipped.as_slice()).unwrap_or(&[]);
    let work: Vec<String> = skipped.iter().filter(|x| x.reason == UPLOAD_WORK_REASON).map(|x| x.path.clone()).collect();
    if !work.is_empty() {
        messages.push(format!("アップロードの置き換えの途中か消し残しのフォルダ {} 件は、セッションとして数えていない({})", work.len(), join_names(&work, "、")));
    }
    // 本体が無く、退けた前のフォルダだけが残っているもの
    let old_only_id = |p: &str| upload_work_dir_id(&platform::basename(p)).unwrap_or_default();
    let old_only_rows: Vec<&crate::snapshot::SkippedEntry> = skipped.iter().filter(|x| x.reason == UPLOAD_OLD_ONLY_REASON && !dirs.contains(&old_only_id(&x.path))).collect();
    if !old_only_rows.is_empty() {
        let old_only: Vec<String> = old_only_rows.iter().map(|x| x.path.clone()).collect();
        let ids: HashSet<String> = old_only_rows.iter().map(|x| old_only_id(&x.path)).collect();
        messages.push(format!(
            "本体のフォルダが無く、アップロードの置き換えで退けた前のフォルダだけが残っているセッション {} 件は、数えていない({})。共有から消したセッションなら、このフォルダも消すと出なくなる。消した覚えが無ければ、送った PC でもう一度アップロードすると戻る",
            ids.len(),
            join_names(&old_only, "、")
        ));
    }
    // 前の版が写した作業用のフォルダが出力先に残っているとき
    if !listed_work.is_empty() {
        messages.push(format!(
            "前の版が写した、アップロードの作業用のフォルダ {} 件が出力先に残っている。セッションとして数えていない({})。要らなければ {} の下から消してよい",
            listed_work.len(),
            join_names(&listed_work, "、"),
            state_dir.display()
        ));
    }
    let recovered: Vec<String> = manifest.as_ref().and_then(|m| m.extras.as_ref()).and_then(|x| x.recovered.as_ref()).map(|r| r.iter().map(|x| x.path.clone()).collect()).unwrap_or_default();
    if !recovered.is_empty() {
        messages.push(format!(
            "アップロードの置き換えが途中で止まっていたセッション {} 件は、写し終えていた作業用のフォルダから読んだ({})。送った PC でもう一度アップロードすると、元の形に戻る",
            recovered.len(),
            join_names(&recovered, "、")
        ));
    }
    // アップロード先から集計し直すとき: セッションのフォルダに添えた session-store.db と data.db の行を足す
    let mut dir_desktops: HashMap<String, DesktopSessionInfo> = HashMap::new();
    for id in &listed_sessions {
        let p = state_dir.join(id).join(SESSION_STORE_JSON);
        if !p.exists() {
            continue;
        }
        if let Some(w) = merge_session_store_json(&mut store, id, &p, &mut dir_desktops) {
            messages.push(w);
        }
    }

    let mut all_ids: BTreeSet<String> = store.sessions.keys().cloned().collect();
    all_ids.extend(dirs.iter().cloned());
    let mut ids: Vec<String> = all_ids.into_iter().collect();
    ids.sort_by(|a, b| js::cmp_utf16(a, b));
    let layout = manifest.as_ref().and_then(|m| m.layout).filter(|l| matches!(l, SourceLayout::Flat | SourceLayout::Merged));
    let uploaded = layout.is_some();
    let mut resolver = opts.projects.clone().map(|p| {
        let mut o = with_source_home(p, manifest.as_ref().map(|m| m.source_root.as_str()));
        if uploaded {
            o.read_git = Some(false);
        }
        ProjectResolver::new(o)
    });
    let wiki_classifier = WikiClassifier::new(&opts.wikis);

    let load = |id: &String| -> Result<Loaded> {
        let has_dir = dirs.contains(id);
        let dir = state_dir.join(id);
        let mut notes = Vec::new();
        let mut workspace: Option<WorkspaceInfo> = None;
        if has_dir {
            match read_workspace_yaml(&dir.join("workspace.yaml")) {
                Ok(w) => workspace = w,
                Err(e) => notes.push(format!("{id}: workspace.yaml を読めない ({e})")),
            }
        }
        let events_path = dir.join("events.jsonl");
        let mut reader = if has_dir && events_path.exists() { Some(EventReader::open(&events_path)?) } else { None };
        let mut iter = reader.as_mut().map(|r| std::iter::from_fn(move || r.next_event().transpose()));
        let empty: &[DbTurnRow] = &[];
        let mut rec = normalize_session(NormalizeInput {
            id: id.clone(),
            has_dir: Some(has_dir),
            workspace: workspace.as_ref(),
            db: DbInput {
                session: store.sessions.get(id),
                turns: store.turns.get(id).map(Vec::as_slice).unwrap_or(empty),
                usage: store.usage.get(id).map(Vec::as_slice).unwrap_or(&[]),
                files: store.files.get(id).map(Vec::as_slice).unwrap_or(&[]),
            },
            events: iter.as_mut().map(|i| i as &mut dyn Iterator<Item = std::io::Result<CopilotEvent>>),
            wiki_classifier: Some(&wiki_classifier),
        })?;
        drop(iter);
        let bad_lines = reader.as_ref().map_or(0, |r| r.stats.bad_lines);
        rec.events.bad_lines = bad_lines;
        if has_dir {
            match read_todos(&dir.join(SNAPSHOT_SESSION_DB)) {
                Ok(t) => rec.todos = t,
                Err(e) => notes.push(format!("{id}: session.db を読めない ({e})")),
            }
        }
        // 送り先から集計したときは、添えた記録(プロジェクト名とタスクタグ)を 1 度だけ読む
        let meta = if uploaded && has_dir { read_sender_meta(&dir.join(UPLOAD_SESSION_META), id) } else { None };
        Ok(Loaded { id: id.clone(), rec, bad_lines, meta, notes })
    };
    let loaded: Vec<Loaded> = ids.par_iter().map(load).collect::<Result<Vec<_>>>()?;

    let mut sessions: Vec<SessionRecord> = Vec::with_capacity(loaded.len());
    let mut unknown_all: JsMap<i64> = JsMap::new();
    let mut bad_lines_total: i64 = 0;
    let owners = manifest.as_ref().and_then(|m| m.merged.as_ref()).and_then(|m| m.owners.as_ref());
    for (done, Loaded { id, mut rec, bad_lines, meta, notes }) in loaded.into_iter().enumerate() {
        messages.extend(notes);
        if let Some(r) = resolver.as_mut() {
            let p = r.resolve(ProjectInput { repository: rec.repository.as_deref(), git_root: rec.git_root.as_deref(), cwd: rec.cwd.as_deref() });
            let sent = meta.as_ref().and_then(|m| m.project.as_ref());
            match sent {
                Some(s) => {
                    rec.project = s.project.clone();
                    rec.project_source = s.source.unwrap_or_else(|| if s.project == p.project { p.source } else { infer_project_source(&s.project) });
                }
                None => {
                    rec.project = p.project;
                    rec.project_source = p.source;
                }
            }
        }
        let owner = owners.and_then(|o| o.get(&id)).cloned();
        // 送り先をまとめて集計したとき(<人>/<プロジェクト> の下のセッション)は、人のフォルダの名前を持たせる
        rec.person = Some(if layout == Some(SourceLayout::Merged) { person_of_folder(owner.as_deref()) } else { None });
        if uploaded {
            // そのセッションを数えたフォルダ・送った人のタスクタグ・フォルダを写した atlas の版
            rec.upload_folder = Some(if layout == Some(SourceLayout::Merged) { owner.clone() } else { Some(".".into()) });
            rec.upload_tags = Some(meta.as_ref().map(|m| m.tags.clone()).unwrap_or_default());
            rec.upload_atlas = Some(meta.as_ref().and_then(|m| m.atlas.clone()));
        }
        rec.desktop = Some(desktop.as_ref().and_then(|d| desktop_for_session(d, &id)).or_else(|| dir_desktops.get(&id).cloned()));
        let title = rec.desktop.as_ref().and_then(|d| d.as_ref()).and_then(|d| d.session.as_ref()).and_then(|s| s.get("title"));
        rec.name = session_name(rec.name.take(), title);
        if let Some(cb) = opts.on_progress {
            cb(done + 1, ids.len(), &id);
        }
        if let Some(sm) = since_ms {
            let u = rec.updated_at.as_deref().filter(|s| !s.is_empty()).and_then(jsdate::parse_ms).map_or(f64::NAN, |v| v as f64);
            if !(u >= sm) {
                continue;
            }
        }
        if bad_lines > 0 {
            messages.push(format!("{id}: 壊れた行 {bad_lines} 件をスキップ"));
        }
        bad_lines_total += bad_lines;
        for (t, n) in rec.unknown_event_types.js_entries() {
            unknown_all.inc(t, *n);
        }
        sessions.push(rec);
    }
    resolve_instructions(&mut sessions, 3);
    for (t, n) in unknown_all.js_entries() {
        messages.push(format!("未知のイベント種別: {t} ({n} 件)"));
    }
    if let Some(r) = &resolver {
        messages.extend(r.warnings.iter().cloned());
    }
    if let Some(m) = &manifest {
        for e in m.session_db_errors.iter().flatten() {
            messages.push(format!("session.db を複製できなかった: {e}"));
        }
        for (name, d) in &m.databases {
            if let Some(err) = d.error.as_ref().filter(|e| !d.copied && !e.is_empty()) {
                messages.push(format!("{name} を今回は複製できなかった({}): {err}", if d.bytes > 0 { "前回の複製を使用" } else { "前回の複製も無いため、このファイルの内容は使っていない" }));
            }
        }
    }
    let installed = manifest.as_ref().and_then(|m| m.installed.clone());
    if let Some(inst) = &installed {
        for w in &inst.warnings {
            messages.push(format!("インストール済みの記録: {w}"));
        }
    }
    let both = sessions.iter().filter(|s| s.sources.len() == 2).count() as i64;
    let db_only = sessions.iter().filter(|s| s.sources.len() == 1 && s.sources[0] == SessionSource::Db).count() as i64;
    if let Some(d) = &desktop {
        for w in &d.warnings {
            messages.push(format!("data.db: {w}"));
        }
    }
    let n = sessions.len() as i64;
    let empty = sessions.iter().filter(|s| s.empty).count() as i64;
    let merged = manifest.as_ref().and_then(|m| m.merged.as_ref());
    Ok(SessionsFile {
        schema_version: SESSIONS_SCHEMA_VERSION,
        generated_at: jsdate::now_iso(),
        source: SessionsSource {
            root: manifest.as_ref().map(|m| m.source_root.clone()),
            snapshot_dir: snapshot_dir.to_string_lossy().into_owned(),
            since,
            layout: layout.map(|l| if l == SourceLayout::Flat { UploadLayout::Flat } else { UploadLayout::Merged }),
            folders: layout.and(merged).map(|m| m.folders.clone()),
            uploads: layout.and(manifest.as_ref().and_then(|m| m.uploads.clone())),
        },
        desktop: Some(desktop.as_ref().map(|d| SessionsDesktop {
            read_at: d.read_at.clone(),
            wal: d.wal.clone(),
            coverage: d.coverage.clone(),
            warnings: d.warnings.clone(),
            sessions: d.tables.get("sessions").map_or(0, Vec::len) as i64,
        })),
        counts: SessionCounts { sessions: n, db_only, dir_only: n - both - db_only, both, empty },
        installed,
        installed_by_person: manifest.as_ref().and_then(|m| m.installed_by_person.clone()).map(Some),
        warnings: SessionsWarnings { unknown_event_types: unknown_all, bad_lines: bad_lines_total, messages },
        sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names() {
        assert_eq!(session_name(Some("New session".into()), Some(&json!(" 題名 "))), Some("題名".into()));
        assert_eq!(session_name(Some("mine".into()), Some(&json!("題名"))), Some("mine".into()));
        assert_eq!(session_name(None, Some(&json!("  "))), None);
        assert_eq!(session_name(Some(" ".into()), Some(&json!("t"))), Some("t".into()));
    }

    #[test]
    fn sender_meta() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("atlas-session.json");
        std::fs::write(&p, r#"{"version":1,"id":"s1","project":" o/r ","projectSource":"temp","tags":["a"," a ","b\u0007",1,"c"]}"#).unwrap();
        let m = read_sender_meta(&p, "s1").unwrap();
        assert_eq!(m.project, Some(SenderProject { project: "o/r".into(), source: None }));
        assert_eq!(m.tags, vec!["a", "c"]);
        assert!(read_sender_meta(&p, "s2").is_none());
        std::fs::write(&p, r#"{"version":1,"id":"s1","project":"(ホーム)","projectSource":"path"}"#).unwrap();
        assert_eq!(read_sender_project(&p, "s1"), Some(SenderProject { project: HOME_PROJECT.into(), source: Some(ProjectSource::Home) }));
        std::fs::write(&p, "{\"version\":1,\"id\":\"s1\",\"project\":\"a\u{202e}b\"}").unwrap();
        assert_eq!(read_sender_project(&p, "s1"), None);
        assert_eq!(infer_project_source("o/r"), ProjectSource::GitRemote);
        assert_eq!(infer_project_source("C:\\x"), ProjectSource::Path);
    }

    #[test]
    fn workspace_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("workspace.yaml");
        std::fs::write(&p, "id: abc\ncwd: C:\\repo\nname: |-\n  line1\n  line2\nsummary: 123\ncreated_at: 2026-07-01T00:00:00.000Z\nbranch: ~\n").unwrap();
        let w = read_workspace_yaml(&p).unwrap().unwrap();
        assert_eq!(w.cwd.as_deref(), Some("C:\\repo"));
        assert_eq!(w.name.as_deref(), Some("line1\nline2"));
        assert_eq!(w.summary.as_deref(), Some("123"));
        assert_eq!(w.created_at.as_deref(), Some("2026-07-01T00:00:00.000Z"));
        assert_eq!(w.branch, None);
        std::fs::write(&p, "- a\n").unwrap();
        assert!(read_workspace_yaml(&p).is_err());
        assert!(read_workspace_yaml(&dir.path().join("none.yaml")).unwrap().is_none());
    }

    #[test]
    fn store_json_checks() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(SESSION_STORE_JSON);
        let mut store = StoreData::default();
        let mut desk = HashMap::new();
        std::fs::write(&p, r#"{"version":1,"schemaVersion":3,"sessions":[{"id":"s1","cwd":"C:\\r"},{"id":"other","cwd":5}],"turns":[{"session_id":"s1","turn_index":0,"user_message":"hi"}],"usage":[{"session_id":"s1","model":"m","input_tokens":1}],"files":[],"desktop":{"session":null,"contextUsage":[],"checkpoints":[],"activity":[],"workspace":null,"project":null}}"#).unwrap();
        assert_eq!(merge_session_store_json(&mut store, "s1", &p, &mut desk), None);
        assert_eq!(store.sessions["s1"].cwd.as_deref(), Some("C:\\r"));
        assert!(!store.sessions.contains_key("other"));
        assert_eq!(store.turns["s1"].len(), 1);
        assert_eq!(store.usage["s1"][0].input_tokens, Some(1.0));
        assert!(desk.contains_key("s1"));
        std::fs::write(&p, r#"{"version":1,"sessions":[{"id":"s1","cwd":5}],"turns":[],"usage":[],"files":[]}"#).unwrap();
        let mut store = StoreData::default();
        assert_eq!(merge_session_store_json(&mut store, "s1", &p, &mut desk).as_deref(), Some("s1: atlas-session-store.json を読めない (形が違います(sessions の cwd))"));
        std::fs::write(&p, r#"{"version":1,"sessions":[],"turns":[{"session_id":"s1"}],"usage":[],"files":[]}"#).unwrap();
        assert_eq!(merge_session_store_json(&mut store, "s1", &p, &mut desk).as_deref(), Some("s1: atlas-session-store.json を読めない (形が違います(turns の turn_index が無い))"));
        std::fs::write(&p, r#"{"version":1,"sessions":[],"turns":[],"usage":[],"files":[],"desktop":{"session":null}}"#).unwrap();
        assert_eq!(merge_session_store_json(&mut store, "s1", &p, &mut desk).as_deref(), Some("s1: atlas-session-store.json の desktop の形が違うため使いません"));
    }
}
