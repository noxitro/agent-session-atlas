//! デスクトップアプリの data.db(~/.copilot/data.db)を、資格情報に触れない形で読む(packages/core/src/desktop.ts の移植。Phase 11)。
//! - 複製しない。`file:///…?immutable=1` の読み取り専用で開く(-shm / -wal に触れない。代わりに -wal の未反映分は読めない)
//! - 読むのは名前で固定した許可リストの列だけ。`select *` はしない。accounts / settings / app_state / model_providers / remote_environments は開かない
//! - 許可リストに列が無くても落ちない(その列は null)。許可外の列は名前と件数だけ数える(値は読まない)

use crate::types::{DesktopRow, DesktopSessionInfo};
use crate::{jsdate, jsfs, sqlite};
use anyhow::Result;
use indexmap::IndexMap;
use rusqlite::types::ValueRef;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopTableCoverage {
    /// 値を読んだ列
    pub allowed: Vec<String>,
    /// 名前だけ数えた列(値は読まない)
    pub unlisted: Vec<String>,
    pub rows: u64,
}

/// -wal の状態。immutable では未反映分を読めない
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWal {
    pub bytes: u64,
    pub mtime: Option<String>,
    pub main_mtime: Option<String>,
    pub note: String,
}

/// 表ごとの許可 / 許可外の列(値は読まない)。開かない表は forbidden に理由
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCoverage {
    pub tables: IndexMap<String, DesktopTableCoverage>,
    pub forbidden: IndexMap<String, String>,
    pub other_tables: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopData {
    /// 常に 1
    pub version: u32,
    pub read_at: String,
    pub path: String,
    pub wal: Option<DesktopWal>,
    pub tables: IndexMap<String, Vec<DesktopRow>>,
    pub coverage: DesktopCoverage,
    pub warnings: Vec<String>,
}

/// 開かない表(資格情報・設定)。許可リストに無い表はそもそも読まないが、ここは「理由付きで除外」として coverage に出す
pub const DESKTOP_FORBIDDEN_TABLES: &[(&str, &str)] = &[
    ("accounts", "アクセストークンを含む"),
    ("settings", "github_access_token を含む"),
    ("app_state", "任意の設定値(資格情報を含みうる)"),
    ("model_providers", "プロバイダの設定(キーを含みうる)"),
    ("remote_environments", "接続先の URL と設定"),
    ("plugin_marketplace_accounts", "アカウントの対応"),
];

/// 表 → 許可する列(値を読む)。ここに無い列は名前だけ数える
pub const DESKTOP_ALLOWLIST: &[(&str, &[&str])] = &[
    (
        "sessions",
        &[
            "id", "title", "session_type", "mode", "model", "reasoning_effort", "is_running", "was_interrupted", "interruption_reason",
            "created_at", "updated_at", "remote_control_enabled", "auto_approve", "enabled_experiments_json", "forked_from_session_id",
            "fork_original_history_event_count", "total_input_tokens", "total_output_tokens", "total_cached_tokens", "total_reasoning_tokens",
            "total_nano_aiu", "total_agent_merge_nano_aiu", "context_current_tokens", "context_input_token_limit", "context_output_token_limit",
            "context_tier", "context_system_tokens", "context_conversation_tokens", "context_tool_definitions_tokens", "context_mcp_tools_tokens",
            "context_buffer_tokens", "agent", "provider_id", "execution_location", "title_source", "archived_at", "permission_mode",
            "sandbox_enabled", "provisional", "agent_scope",
        ],
    ),
    ("session_context_usage", &["id", "session_id", "ts_ms", "current_tokens", "token_limit"]),
    ("session_checkpoints", &["session_id", "event_id", "commit_sha", "created_at"]),
    ("activity_items", &["id", "workspace_id", "session_id", "activity_type", "preview", "is_read", "created_at", "updated_at"]),
    (
        "projects",
        &[
            "id", "name", "container_kind", "main_repo_path", "default_branch", "github_owner", "github_repo", "created_at", "last_opened_at",
            "auto_approve", "sandbox_enabled", "branch_prefix", "show_in_sidebar", "remote_default_branch",
        ],
    ),
    (
        "workspaces",
        &[
            "id", "project_id", "worktree_id", "workspace_type", "branch", "name", "created_at", "updated_at", "session_id", "archived_at",
            "created_pr_repo_full_name", "created_pr_number", "created_pr_html_url", "created_pr_state", "created_pr_merged_at",
            "source_pr_repo_full_name", "source_pr_number", "source_pr_state", "source_pr_merged_at",
            "last_diff_files_changed", "last_diff_insertions", "last_diff_deletions", "last_diff_updated_at",
            "total_input_tokens", "total_output_tokens", "total_cache_read_tokens", "total_cache_write_tokens", "total_reasoning_tokens",
        ],
    ),
];

fn allowlist(table: &str) -> Option<&'static [&'static str]> {
    DESKTOP_ALLOWLIST.iter().find(|(t, _)| *t == table).map(|(_, c)| *c)
}

fn is_forbidden(table: &str) -> bool {
    DESKTOP_FORBIDDEN_TABLES.iter().any(|(t, _)| *t == table)
}

fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// JS の Number で表せる整数の上限(node:sqlite はこれを超える整数を読めない)
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// SQLite の値を、node:sqlite が JS に渡す値と同じ JSON にする(BLOB は Uint8Array を JSON.stringify した形)
fn js_value(v: ValueRef<'_>) -> Result<Value> {
    Ok(match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => {
            if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
                anyhow::bail!("Value is too large to be represented as a JavaScript number: {i}");
            }
            Value::from(i)
        }
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Object(b.iter().enumerate().map(|(i, x)| (i.to_string(), Value::from(*x))).collect::<Map<_, _>>()),
    })
}

/// data.db を読む。無ければ None。読めなければ warnings に理由(落とさない)
pub fn read_desktop_db(path: &Path) -> Result<Option<DesktopData>> {
    if !jsfs::exists(path) {
        return Ok(None);
    }
    let read_at = jsdate::now_iso();
    let mut out = DesktopData {
        version: 1,
        read_at,
        path: path.to_string_lossy().into_owned(),
        wal: None,
        tables: IndexMap::new(),
        coverage: DesktopCoverage {
            tables: IndexMap::new(),
            forbidden: DESKTOP_FORBIDDEN_TABLES.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            other_tables: Vec::new(),
        },
        warnings: Vec::new(),
    };
    let mut wal_path = path.as_os_str().to_owned();
    wal_path.push("-wal");
    let wal_path = std::path::PathBuf::from(wal_path);
    let main_mtime = jsfs::mtime_iso(&fs::metadata(path)?);
    out.wal = Some(if jsfs::exists(&wal_path) {
        let w = fs::metadata(&wal_path)?;
        DesktopWal {
            bytes: w.len(),
            mtime: Some(jsfs::mtime_iso(&w)),
            main_mtime: Some(main_mtime),
            note: if w.len() > 0 { "immutable で開くため -wal の未反映分は読めない。本体の更新より後に書かれた行(最近のセッションの更新)が欠ける可能性がある" } else { "-wal は空で、欠けは無い" }.to_string(),
        }
    } else {
        DesktopWal { bytes: 0, mtime: None, main_mtime: Some(main_mtime), note: "-wal は無く、欠けは無い".to_string() }
    });

    let db = match sqlite::open_uri_read_only(&format!("{}?immutable=1", sqlite::path_to_file_url(path))) {
        Ok(db) => db,
        Err(e) => {
            out.warnings.push(format!("data.db を開けない ({e})"));
            return Ok(Some(out));
        }
    };
    let names: Vec<String> = match db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0))?.collect()) {
        Ok(n) => n,
        Err(e) => {
            out.warnings.push(format!("data.db を読めない ({e})"));
            Vec::new()
        }
    };
    for t in &names {
        if is_forbidden(t) {
            continue;
        }
        let Some(allow) = allowlist(t) else {
            out.coverage.other_tables.push(t.clone());
            continue;
        };
        let cols: Vec<String> = db.prepare(&format!("PRAGMA table_info({})", ident(t)))?.query_map([], |r| r.get::<_, String>("name"))?.collect::<rusqlite::Result<_>>()?;
        let present: Vec<String> = allow.iter().filter(|c| cols.iter().any(|x| x == *c)).map(|c| c.to_string()).collect();
        let unlisted: Vec<String> = cols.iter().filter(|c| !allow.contains(&c.as_str())).cloned().collect();
        let rows = if present.is_empty() {
            Ok(Vec::new())
        } else {
            read_rows(&db, t, allow, &present)
        };
        let rows = rows.unwrap_or_else(|e| {
            out.warnings.push(format!("{t} を読めない ({e})"));
            Vec::new()
        });
        let n = rows.len() as u64;
        out.tables.insert(t.clone(), rows);
        out.coverage.tables.insert(t.clone(), DesktopTableCoverage { allowed: present, unlisted, rows: n });
    }
    out.coverage.forbidden.retain(|k, _| names.contains(k));
    Ok(Some(out))
}

fn read_rows(db: &rusqlite::Connection, table: &str, allow: &[&str], present: &[String]) -> Result<Vec<DesktopRow>> {
    let sql = format!("SELECT {} FROM {}", present.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", "), ident(table));
    let mut stmt = db.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let mut got: IndexMap<&str, Value> = IndexMap::new();
        for (i, c) in present.iter().enumerate() {
            got.insert(c.as_str(), js_value(r.get_ref(i)?)?);
        }
        let mut o = DesktopRow::new();
        for c in allow {
            o.insert(c.to_string(), got.get(c).cloned().unwrap_or(Value::Null));
        }
        out.push(o);
    }
    Ok(out)
}

fn rows_of<'a>(d: &'a DesktopData, t: &str) -> &'a [DesktopRow] {
    d.tables.get(t).map(Vec::as_slice).unwrap_or(&[])
}

fn is_id(v: Option<&Value>, id: &str) -> bool {
    v.and_then(Value::as_str) == Some(id)
}

pub fn desktop_for_session(d: &DesktopData, id: &str) -> Option<DesktopSessionInfo> {
    let session = rows_of(d, "sessions").iter().find(|r| is_id(r.get("id"), id)).cloned();
    let pick = |t: &str| rows_of(d, t).iter().filter(|r| is_id(r.get("session_id"), id)).cloned().collect::<Vec<_>>();
    let context_usage = pick("session_context_usage");
    let checkpoints = pick("session_checkpoints");
    let activity = pick("activity_items");
    let workspace = rows_of(d, "workspaces").iter().find(|r| is_id(r.get("session_id"), id)).cloned();
    let project = workspace.as_ref().and_then(|w| {
        // JS の === と同じ(型も値も同じもの)
        let pid = w.get("project_id").cloned().unwrap_or(Value::Null);
        rows_of(d, "projects").iter().find(|r| r.get("id").cloned().unwrap_or(Value::Null) == pid).cloned()
    });
    if session.is_none() && context_usage.is_empty() && checkpoints.is_empty() && activity.is_empty() && workspace.is_none() {
        return None;
    }
    Some(DesktopSessionInfo { session, context_usage, checkpoints, activity, workspace, project })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "00000000-0000-4000-8000-000000000001";

    fn secret() -> String {
        // トークンの形をソースに直書きしない
        ["ghp", "UNITFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE01"].join("_")
    }

    fn make(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("data.db");
        let db = sqlite::open_writable(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE accounts (id TEXT, access_token TEXT);
CREATE TABLE settings (id INTEGER, github_access_token TEXT);
CREATE TABLE sessions (id TEXT, title TEXT, model TEXT, remote_connect_target TEXT, created_at TEXT);
CREATE TABLE session_context_usage (id INTEGER, session_id TEXT, ts_ms INTEGER, current_tokens INTEGER, token_limit INTEGER);
CREATE TABLE workspaces (id TEXT, project_id TEXT, session_id TEXT, name TEXT, session_bootstrap_config TEXT);
CREATE TABLE projects (id TEXT, name TEXT, setup_script TEXT);
CREATE TABLE unrelated_table (x TEXT);",
        )
        .unwrap();
        let s = secret();
        db.execute("INSERT INTO accounts VALUES (?,?)", ("a", &s)).unwrap();
        db.execute("INSERT INTO settings VALUES (?,?)", (1, &s)).unwrap();
        db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", (SID, "title 1", "claude-opus-5.5", format!("ssh://{s}"), "2026-10-01T00:00:00Z")).unwrap();
        db.execute("INSERT INTO session_context_usage VALUES (?,?,?,?,?)", (1, SID, 1, 100, 1000)).unwrap();
        db.execute("INSERT INTO workspaces VALUES (?,?,?,?,?)", ("ws", "p", SID, "ws name", &s)).unwrap();
        db.execute("INSERT INTO projects VALUES (?,?,?)", ("p", "proj", &s)).unwrap();
        db.execute("INSERT INTO unrelated_table VALUES (?)", [&s]).unwrap();
        drop(db);
        let _ = fs::remove_file(dir.join("data.db-shm"));
        let _ = fs::remove_file(dir.join("data.db-wal"));
        path
    }

    #[test]
    fn reads_only_allowlisted_columns_and_never_touches_source() {
        let t = tempfile::tempdir().unwrap();
        let path = make(t.path());
        let before = jsfs::mtime_ms(&fs::metadata(&path).unwrap());
        let d = read_desktop_db(&path).unwrap().unwrap();
        let json = crate::json::to_js_string(&d).unwrap();
        assert!(!json.contains(&secret()));
        assert!(!d.tables.contains_key("accounts"));
        assert!(!d.tables.contains_key("settings"));
        assert!(d.coverage.forbidden.contains_key("accounts") && d.coverage.forbidden.contains_key("settings"));
        assert!(!d.coverage.forbidden.contains_key("app_state")); // 無い表は出さない
        assert_eq!(d.coverage.other_tables, ["unrelated_table"]);
        let s = &d.tables["sessions"][0];
        assert_eq!(s["id"], SID);
        assert_eq!(s["title"], "title 1");
        assert_eq!(s["model"], "claude-opus-5.5");
        assert_eq!(s["created_at"], "2026-10-01T00:00:00Z");
        assert_eq!(s["mode"], Value::Null);
        assert_eq!(s["total_input_tokens"], Value::Null);
        let mut keys: Vec<&str> = s.keys().map(String::as_str).collect();
        keys.sort();
        let mut want: Vec<&str> = allowlist("sessions").unwrap().to_vec();
        want.sort();
        assert_eq!(keys, want);
        assert_eq!(d.coverage.tables["sessions"], DesktopTableCoverage { allowed: vec!["id".into(), "title".into(), "model".into(), "created_at".into()], unlisted: vec!["remote_connect_target".into()], rows: 1 });
        assert_eq!(d.coverage.tables["workspaces"].unlisted, ["session_bootstrap_config"]);
        assert_eq!(d.coverage.tables["projects"].unlisted, ["setup_script"]);
        let wal = d.wal.as_ref().unwrap();
        assert_eq!((wal.bytes, wal.mtime.clone()), (0, None));
        // 元に触れない(mtime、-shm / -wal を作らない)
        assert_eq!(jsfs::mtime_ms(&fs::metadata(&path).unwrap()), before);
        let names: Vec<String> = fs::read_dir(t.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["data.db"]);
        // セッション単位の束ね
        let info = desktop_for_session(&d, SID).unwrap();
        assert_eq!(info.session.as_ref().unwrap()["title"], "title 1");
        assert_eq!(info.context_usage.len(), 1);
        assert_eq!(info.workspace.as_ref().unwrap()["name"], "ws name");
        assert_eq!(info.project.as_ref().unwrap()["name"], "proj");
        assert!(desktop_for_session(&d, "nope").is_none());
        assert!(!crate::json::to_js_string(&info).unwrap().contains(&secret()));
    }

    #[test]
    fn missing_is_none_and_broken_gives_warnings() {
        let t = tempfile::tempdir().unwrap();
        assert!(read_desktop_db(&t.path().join("none.db")).unwrap().is_none());
        let path = t.path().join("data.db");
        fs::write(&path, "not a database").unwrap();
        let d = read_desktop_db(&path).unwrap().unwrap();
        assert!(!d.warnings.is_empty());
        assert!(DESKTOP_FORBIDDEN_TABLES.iter().any(|(t, _)| *t == "accounts"));
    }
}
