//! 実データの記録形式の揺れを吸収する小さな規則(packages/core/src/classify.ts の移植)。normalize と judge の packet で共用する。

use crate::js;
use crate::nodepath::{posix, process_cwd, win32};
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

// ---------- モデル名 ----------

static UUID_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/").unwrap());
/// claude-<family>-<major>-<minor>(minor は 1 桁、末尾に日付などが続かない)
static CLAUDE_DASHED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(claude-[a-z]+)-([0-9]+)-([0-9])$").unwrap());

/// モデル名の表記揺れを 1 つにする(先頭の「<UUID>/」を外し、claude-haiku-5-5 → claude-haiku-5.5)
pub fn normalize_model(name: &str) -> String {
    let t = js::trim(name);
    let m = UUID_PREFIX_RE.replace(t, "");
    match CLAUDE_DASHED_RE.captures(&m) {
        Some(c) => format!("{}-{}.{}", &c[1], &c[2], &c[3]),
        None => m.into_owned(),
    }
}

// ---------- ツール ----------

/// エージェントの内部処理に使われ、作業としてのツール呼び出しに数えないツール
pub const INTERNAL_TOOLS: &[&str] = &["report_intent"];

pub fn is_internal_tool(name: &str) -> bool {
    INTERNAL_TOOLS.contains(&name)
}

// ---------- メッセージ ----------

/// ユーザーの依頼(ターン)として数える user.message か(source 付きと autopilot の自動継続は数えない)
pub fn is_user_turn(d: Option<&Value>) -> bool {
    let d = d.and_then(Value::as_object);
    let source_null = d.and_then(|o| js::present(o.get("source"))).is_none();
    source_null && !is_autopilot_continuation_obj(d)
}

fn is_autopilot_continuation_obj(d: Option<&serde_json::Map<String, Value>>) -> bool {
    matches!(d.and_then(|o| o.get("isAutopilotContinuation")), Some(Value::Bool(true)))
}

pub fn is_autopilot_continuation(d: Option<&Value>) -> bool {
    is_autopilot_continuation_obj(d.and_then(Value::as_object))
}

/// 本体(親セッション)の応答として数える assistant.message か
pub fn is_main_assistant_message(agent_id: Option<&Value>, data: Option<&Value>) -> bool {
    let ptc = data.and_then(|d| d.as_object()).and_then(|o| o.get("parentToolCallId"));
    !js::truthy(ptc) && !js::truthy(agent_id)
}

// ---------- ファイルパス ----------

static WIN_ABS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:[A-Za-z]:[\\/]|\\\\)").unwrap());
/// ~/.copilot/session-state/ 配下
static SESSION_STATE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[\\/]\.copilot[\\/]session-state(?:[\\/]|$)").unwrap());

fn is_win_abs(p: &str) -> bool {
    WIN_ABS_RE.is_match(p)
}

fn looks_windows(p: Option<&str>) -> bool {
    match p {
        Some(p) if !p.is_empty() => is_win_abs(p) || (p.contains('\\') && !p.contains('/')),
        _ => false,
    }
}

/// Windows のパスの仕上げ: ドライブ文字を大文字に、末尾の区切りを落とす(ドライブ直下 C:\ と区切りだけのものは残す)
fn win_finish(s: String) -> String {
    let b = s.as_bytes();
    let out = if b.len() >= 2 && b[0].is_ascii_lowercase() && b[1] == b':' { format!("{}{}", (b[0] as char).to_ascii_uppercase(), &s[1..]) } else { s };
    let ob = out.as_bytes();
    if ob.len() == 3 && ob[0].is_ascii_alphabetic() && ob[1] == b':' && ob[2] == b'\\' {
        return out;
    }
    // /(?<=[^\\])\\+$/ を ''
    let trimmed = out.trim_end_matches('\\');
    if trimmed.len() < out.len() && !trimmed.is_empty() {
        return trimmed.to_string();
    }
    out
}

/// パスを cwd 基準の絶対パスにそろえる。Windows のパスは \ 区切り・ドライブ文字は大文字に。
/// cwd が無い相対パスはそのまま(区切りだけ整える)
pub fn resolve_file_path(p: &str, cwd: Option<&str>) -> String {
    let raw = js::trim(p);
    if is_win_abs(raw) {
        return win_finish(win32::normalize(raw));
    }
    if raw.starts_with('/') {
        return posix::normalize(raw);
    }
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        if looks_windows(Some(cwd)) {
            let r = if is_win_abs(cwd) { win32::resolve(&[cwd, raw], &process_cwd()) } else { win32::join(&[cwd, raw]) };
            return win_finish(r);
        }
        return if cwd.starts_with('/') { posix::resolve(&[cwd, raw], "/") } else { posix::join(&[cwd, raw]) };
    }
    if looks_windows(Some(raw)) { win_finish(win32::normalize(raw)) } else { posix::normalize(raw) }
}

/// root の中のパスなら、root からの相対パス(区切りは /)。中でなければ null
pub fn relative_inside(root: &str, abs_path: &str) -> Option<String> {
    let r = resolve_file_path(root, None);
    let p = resolve_file_path(abs_path, None);
    let cwd = process_cwd();
    let rel = if is_win_abs(&r) { win32::relative(&r, &p, &cwd) } else { posix::relative(&r, &p, &posix_cwd(&cwd)) };
    if rel.is_empty() || rel == ".." || rel.starts_with("../") || rel.starts_with("..\\") || win32::is_absolute(&rel) || posix::is_absolute(&rel) {
        return None;
    }
    Some(rel.replace('\\', "/"))
}

/// Node の posix 側の process.cwd()(Windows では区切りを / にしてドライブを除いたもの)
fn posix_cwd(cwd: &str) -> String {
    if cfg!(windows) {
        let s = cwd.replace('\\', "/");
        let b = s.as_bytes();
        if b.len() >= 2 && b[1] == b':' { s[2..].to_string() } else { s }
    } else {
        cwd.to_string()
    }
}

/// 重複除去のキー。Windows のパスは大文字小文字を区別しない
pub fn file_path_key(resolved: &str) -> String {
    if looks_windows(Some(resolved)) { js::to_lower(resolved) } else { resolved.to_string() }
}

pub fn is_session_state_path(p: &str) -> bool {
    SESSION_STATE_RE.is_match(p)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileOp {
    Create,
    Edit,
    Delete,
}

struct TrackedFile {
    path: String,
    first: FileOp,
    last: FileOp,
}

/// セッション中のファイル操作をパス単位にまとめる。
/// 最終状態: 最後の操作が delete → deleted / 最初の操作が create → created / それ以外 → changed。
/// ~/.copilot/session-state/ 配下は一覧から外し、件数(異なるパスの数)だけ数える
#[derive(Default)]
pub struct FileTracker {
    files: IndexMap<String, TrackedFile>,
    session_state: IndexSet<String>,
}

pub struct FileResult {
    pub changed: Vec<String>,
    pub created: Vec<String>,
    pub deleted: Vec<String>,
    pub session_state: i64,
}

impl FileTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, op: FileOp, path: &str, cwd: Option<&str>) {
        if js::trim(path).is_empty() {
            return;
        }
        let resolved = resolve_file_path(path, cwd);
        let key = file_path_key(&resolved);
        if is_session_state_path(&resolved) {
            self.session_state.insert(key);
            return;
        }
        match self.files.get_mut(&key) {
            Some(f) => f.last = op,
            None => {
                self.files.insert(key, TrackedFile { path: resolved, first: op, last: op });
            }
        }
    }

    /// 要約の記録(session.shutdown.codeChanges.filesModified)から足す。セッション中の操作で既に載っているパスは上書きしない
    pub fn add_summary(&mut self, path: &str, cwd: Option<&str>) {
        if js::trim(path).is_empty() {
            return;
        }
        let key = file_path_key(&resolve_file_path(path, cwd));
        if self.files.contains_key(&key) || self.session_state.contains(&key) {
            return;
        }
        self.add(FileOp::Edit, path, cwd);
    }

    pub fn size(&self) -> usize {
        self.files.len() + self.session_state.len()
    }

    pub fn result(&self) -> FileResult {
        let mut r = FileResult { changed: Vec::new(), created: Vec::new(), deleted: Vec::new(), session_state: self.session_state.len() as i64 };
        for f in self.files.values() {
            if f.last == FileOp::Delete {
                r.deleted.push(f.path.clone());
            } else if f.first == FileOp::Create {
                r.created.push(f.path.clone());
            } else {
                r.changed.push(f.path.clone());
            }
        }
        r
    }
}

#[cfg(test)]
mod tests {
    /// Windows のホームの親フォルダの名前(パスの形をソースに直書きしない)
    const USERS: &str = "Users";
    use super::*;
    use serde_json::json;

    #[test]
    fn models() {
        assert_eq!(normalize_model("claude-haiku-5-5"), "claude-haiku-5.5");
        assert_eq!(normalize_model("0f3c2a1b-1234-5678-9abc-def012345678/claude-haiku-5-5"), "claude-haiku-5.5");
        assert_eq!(normalize_model("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5-20250929");
        assert_eq!(normalize_model(" gpt-5 "), "gpt-5");
    }

    #[test]
    fn turns_and_messages() {
        assert!(is_user_turn(Some(&json!({"content": "x"}))));
        assert!(!is_user_turn(Some(&json!({"source": "skill"}))));
        assert!(!is_user_turn(Some(&json!({"isAutopilotContinuation": true}))));
        assert!(is_user_turn(None));
        assert!(is_main_assistant_message(None, Some(&json!({}))));
        assert!(!is_main_assistant_message(Some(&json!("a1")), Some(&json!({}))));
        assert!(!is_main_assistant_message(None, Some(&json!({"parentToolCallId": "t"}))));
        assert!(is_main_assistant_message(Some(&json!("")), None));
    }

    #[test]
    fn file_paths() {
        assert_eq!(resolve_file_path("src/a.ts", Some("c:\\repo")), "C:\\repo\\src\\a.ts");
        assert_eq!(resolve_file_path("c:/repo/src/", None), "C:\\repo\\src");
        assert_eq!(resolve_file_path("C:\\", None), "C:\\");
        assert_eq!(resolve_file_path("a/../b.ts", Some("/home/u/repo")), "/home/u/repo/b.ts");
        assert_eq!(resolve_file_path("x.ts", Some("repo")), "repo/x.ts");
        assert_eq!(resolve_file_path("x.ts", None), "x.ts");
        assert_eq!(file_path_key("C:\\Repo\\A.ts"), "c:\\repo\\a.ts");
        assert!(is_session_state_path(&format!("C:\\{}\\u\\.copilot\\session-state\\abc\\plan.md", USERS)));
        assert_eq!(relative_inside("C:\\repo", "c:/repo/src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(relative_inside("C:\\repo", "C:\\repo"), None);
        assert_eq!(relative_inside("C:\\repo", "D:\\repo\\a"), None);
        assert_eq!(relative_inside("/home/u/r", "/home/u/r/a/b").as_deref(), Some("a/b"));
    }

    #[test]
    fn tracker() {
        let mut t = FileTracker::new();
        t.add(FileOp::Create, "a.ts", Some("C:\\r"));
        t.add(FileOp::Edit, "A.ts", Some("C:\\r"));
        t.add(FileOp::Edit, "b.ts", Some("C:\\r"));
        t.add(FileOp::Delete, "b.ts", Some("C:\\r"));
        t.add(FileOp::Edit, &format!("C:\\{}\\u\\.copilot\\session-state\\x\\plan.md", USERS), None);
        t.add_summary("b.ts", Some("C:\\r"));
        t.add_summary("c.ts", Some("C:\\r"));
        let r = t.result();
        assert_eq!(r.created, vec!["C:\\r\\a.ts"]);
        assert_eq!(r.deleted, vec!["C:\\r\\b.ts"]);
        assert_eq!(r.changed, vec!["C:\\r\\c.ts"]);
        assert_eq!(r.session_state, 1);
    }
}
