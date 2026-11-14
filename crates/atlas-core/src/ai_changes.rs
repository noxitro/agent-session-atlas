//! セッションの中で AI が作った変更(ファイルと、変更のまとまりごとの追加行)を、ログのイベントから取り出す
//! (packages/core/src/ai-changes.ts の移植)。VCS の差分と照合するための材料(vcs_retention.rs が使う)。LLM は使わない。
//!
//! 取り出し方:
//! - 編集の完了イベント(tool.execution_complete)の result.detailedContent にある unified diff を一次の材料にする
//!   (edit / create / apply_patch / str_replace_editor。2026-11 の手元のログで、diff --git 形式を確認)
//! - diff が無い古い形式では、開始イベントの引数(old_str / new_str / file_text / apply_patch のパッチ本文)から作る
//! - 失敗した編集(success:false)と、~/.copilot/session-state 配下(plan.md など)は数えない
//! - 同じファイルで、AI が前に足した行を後の編集で消した(書き直した)ときは、前の行を数えない。AI が最後に残した形だけを数える(二重計上を防ぐ)
//! - 空白だけの行は数えない

use crate::classify::{file_path_key, is_session_state_path, resolve_file_path};
use crate::js::{self, JsMap};
use crate::types::{CopilotEvent, WorkspaceInfo};
use crate::vcs_retention::ValueSource;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;

/// 材料の種類。diff = 完了イベントの unified diff、args = 開始イベントの引数から作った
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkFrom {
    Diff,
    Args,
}

/// AI の変更 1 まとまり(diff の連続した +/- の塊)のうち、セッションの終わりまで AI が残した追加行
#[derive(Debug, Clone, PartialEq)]
pub struct AiHunk {
    /// セッション内の通し番号
    pub id: i64,
    /// 絶対パス(Windows は \ 区切り)
    pub path: String,
    /// その編集の時刻(ISO)
    pub at: Option<String>,
    pub tool_call_id: Option<String>,
    /// 追加行(行末の空白と改行を除いた本文)。空白だけの行は含めない
    pub lines: Vec<String>,
    pub from: HunkFrom,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiFileChange {
    pub path: String,
    /// AI がこのセッションで作ったファイルか
    pub created: bool,
    /// AI がこのセッションの最後に消したファイルか
    pub deleted: bool,
    /// 数えた編集の回数(失敗を除く)
    pub edits: i64,
}

/// VCS の照合に使うセッションの文脈。値ごとに出所を持つ
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionVcsContext {
    /// 最初のイベントの時刻
    pub start: Option<String>,
    /// 最後のイベントの時刻
    pub end: Option<String>,
    pub cwd: Option<String>,
    pub git_root: Option<String>,
    pub branch: Option<String>,
    /// 開始時(最初に記録された)のコミット。git のときだけ記録される
    pub head_commit: Option<String>,
    pub base_commit: Option<String>,
    /// cwd / gitRoot / branch / headCommit の出所(決まった順)
    pub sources: JsMap<ValueSource>,
}

/// 数えなかった編集(失敗・session-state 配下・材料なし)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Skipped {
    pub failed: i64,
    pub session_state: i64,
    pub no_material: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiChangeSet {
    pub session_id: String,
    pub context: SessionVcsContext,
    pub files: Vec<AiFileChange>,
    /// AI が残した追加行を 1 行以上持つまとまり
    pub hunks: Vec<AiHunk>,
    pub skipped: Skipped,
}

/// workspace.yaml から補う値(イベントに無いときだけ使う)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorkspaceHints {
    pub cwd: Option<String>,
    pub git_root: Option<String>,
    pub branch: Option<String>,
}

impl From<&WorkspaceInfo> for WorkspaceHints {
    fn from(w: &WorkspaceInfo) -> Self {
        WorkspaceHints { cwd: w.cwd.clone(), git_root: w.git_root.clone(), branch: w.branch.clone() }
    }
}

const EDIT_TOOLS: [&str; 4] = ["edit", "create", "str_replace_editor", "apply_patch"];

/// 比べるときの行の本文(行末の空白と CR を落とす)
pub fn line_text(s: &str) -> &str {
    js::trim_end(s)
}

fn is_blank(s: &str) -> bool {
    js::trim(s).is_empty()
}

// ---- unified diff の読み取り ----

/// 連続した +/- の塊の追加行と削除行
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Block {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DiffFile {
    /// diff の見出しのパス(a/ b/ を外したもの)。消したファイルは old_path だけ
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub blocks: Vec<Block>,
}

fn diff_path(raw: &str) -> Option<String> {
    let mut p = js::trim(raw);
    // タブ以降(時刻の注記)を落とす
    if let Some(tab) = p.find('\t') {
        p = &p[..tab];
    }
    let p = if p.starts_with('"') && p.ends_with('"') { if p.len() >= 2 { &p[1..p.len() - 1] } else { "" } } else { p };
    if matches!(p, "/dev/null" | "a/dev/null" | "b/dev/null" | "dev/null") {
        return None;
    }
    let p = if p.starts_with("a/") || p.starts_with("b/") { &p[2..] } else { p };
    Some(p.to_string())
}

fn split_crlf(text: &str) -> Vec<String> {
    text.replace("\r\n", "\n").split('\n').map(str::to_string).collect()
}

fn flush_into(blocks: Option<&mut Vec<Block>>, block: &mut Option<Block>) {
    if let (Some(bs), Some(b)) = (blocks, block.take()) {
        if !b.added.is_empty() || !b.removed.is_empty() {
            bs.push(b);
        }
    }
}

/// git 形式の unified diff(複数ファイル可)を読む。--- / +++ の無い節は飛ばす
pub fn parse_unified_diff(text: &str) -> Vec<DiffFile> {
    let mut out: Vec<DiffFile> = Vec::new();
    // cur は out の最後の要素を指す(None なら今のファイルが無い)
    let mut cur = false;
    let mut block: Option<Block> = None;
    let mut in_hunk = false;
    let lines = split_crlf(text);
    let mut i = 0;
    while i < lines.len() {
        let l = &lines[i];
        if l.starts_with("diff --git ") {
            flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
            cur = false;
            in_hunk = false;
            i += 1;
            continue;
        }
        // 見出しは塊の外で読む(塊の中の "--- x" は、"-- x" という行を消した印のことがある)。
        // diff --git の無い複数ファイルの diff では、塊の中でも、--- / +++ のすぐ後に @@ が続くものは次のファイルの見出しとして読む
        if (!in_hunk || lines.get(i + 2).is_some_and(|x| x.starts_with("@@"))) && l.starts_with("--- ") && lines.get(i + 1).is_some_and(|x| x.starts_with("+++ ")) {
            flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
            out.push(DiffFile { old_path: diff_path(&l[4..]), new_path: diff_path(&lines[i + 1][4..]), blocks: Vec::new() });
            cur = true;
            i += 2;
            in_hunk = false;
            continue;
        }
        if l.starts_with("@@") {
            flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
            in_hunk = cur;
            i += 1;
            continue;
        }
        if !in_hunk || !cur {
            i += 1;
            continue;
        }
        if let Some(rest) = l.strip_prefix('+') {
            block.get_or_insert_with(Block::default).added.push(line_text(rest).to_string());
        } else if let Some(rest) = l.strip_prefix('-') {
            block.get_or_insert_with(Block::default).removed.push(line_text(rest).to_string());
        } else if l.starts_with('\\') {
            // \ No newline at end of file
        } else {
            flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
        }
        i += 1;
    }
    flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchOp {
    Add,
    Update,
    Delete,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PatchFile {
    pub path: String,
    pub op: PatchOp,
    pub blocks: Vec<Block>,
}

static PATCH_FILE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^\*\*\* (Add|Update|Delete) File: ({}+)$", js::RE_DOT)).unwrap());

/// apply_patch の本文(*** Begin Patch 形式)を読む
pub fn parse_apply_patch(text: &str) -> Vec<PatchFile> {
    let mut out: Vec<PatchFile> = Vec::new();
    let mut cur = false;
    let mut block: Option<Block> = None;
    for l in split_crlf(text) {
        if let Some(m) = PATCH_FILE_RE.captures(&l) {
            flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
            let op = match &m[1] {
                "Add" => PatchOp::Add,
                "Update" => PatchOp::Update,
                _ => PatchOp::Delete,
            };
            out.push(PatchFile { path: js::trim(&m[2]).to_string(), op, blocks: Vec::new() });
            cur = true;
            continue;
        }
        if l.starts_with("*** ") {
            flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
            if let Some(to) = l.strip_prefix("*** Move to: ") {
                if cur {
                    if let Some(f) = out.last_mut() {
                        f.path = js::trim(to).to_string();
                    }
                }
            }
            continue;
        }
        if !cur {
            continue;
        }
        if let Some(rest) = l.strip_prefix('+') {
            block.get_or_insert_with(Block::default).added.push(line_text(rest).to_string());
        } else if let Some(rest) = l.strip_prefix('-') {
            block.get_or_insert_with(Block::default).removed.push(line_text(rest).to_string());
        } else {
            flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
        }
    }
    flush_into(if cur { out.last_mut().map(|f| &mut f.blocks) } else { None }, &mut block);
    out
}

/// 多重集合の差(a から b にある分を 1 つずつ除く)。順序は a のまま
fn minus(a: &[String], b: &[String]) -> Vec<String> {
    let mut left: HashMap<&str, i64> = HashMap::new();
    for x in b {
        *left.entry(x).or_insert(0) += 1;
    }
    let mut out = Vec::new();
    for x in a {
        match left.get_mut(x.as_str()) {
            Some(n) if *n > 0 => *n -= 1,
            _ => out.push(x.clone()),
        }
    }
    out
}

fn split_lines(s: Option<&Value>) -> Vec<String> {
    match s {
        Some(Value::String(s)) => s.replace("\r\n", "\n").split('\n').map(|l| line_text(l).to_string()).collect(),
        _ => Vec::new(),
    }
}

/// オブジェクトのキーの値(オブジェクトでなければ None。JS の `v?.k`)
fn field<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(o)) => o.get(k),
        _ => None,
    }
}

fn str_field<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a str> {
    field(v, k).and_then(Value::as_str)
}

/// 引数から変更を作る(diff が無いとき)。パスは未解決のまま返す
fn changes_from_args(tool: &str, args: Option<&Value>) -> Vec<PatchFile> {
    if tool == "apply_patch" {
        let text = match args {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => str_field(args, "input").or_else(|| str_field(args, "patch")),
        };
        return match text {
            Some(t) if !t.is_empty() => parse_apply_patch(t),
            _ => Vec::new(),
        };
    }
    // 配列は `typeof args === 'object'` だが path を持たない
    let Some(path) = str_field(args, "path") else { return Vec::new() };
    let cmd = str_field(args, "command");
    let path = path.to_string();
    if tool == "create" || cmd == Some("create") {
        return vec![PatchFile { path, op: PatchOp::Add, blocks: vec![Block { added: split_lines(field(args, "file_text")), removed: Vec::new() }] }];
    }
    if tool == "edit" || cmd == Some("str_replace") {
        let old_l = split_lines(field(args, "old_str"));
        let new_l = split_lines(field(args, "new_str"));
        return vec![PatchFile { path, op: PatchOp::Update, blocks: vec![Block { added: minus(&new_l, &old_l), removed: minus(&old_l, &new_l) }] }];
    }
    if cmd == Some("insert") {
        // args.new_str ?? args.insert_text
        let v = match field(args, "new_str") {
            None | Some(Value::Null) => field(args, "insert_text"),
            x => x,
        };
        return vec![PatchFile { path, op: PatchOp::Update, blocks: vec![Block { added: split_lines(v), removed: Vec::new() }] }];
    }
    Vec::new()
}

// ---- 1 セッション分 ----

struct Entry {
    text: String,
    alive: bool,
}

struct FileState {
    path: String,
    created: bool,
    deleted: bool,
    edits: i64,
    /// 生きている追加行(新しい順に探すため、追加した順に並べる。entries の添字)
    entries: Vec<usize>,
}

struct HunkHead {
    id: i64,
    path: String,
    at: Option<String>,
    tool_call_id: Option<String>,
    from: HunkFrom,
}

struct StartInfo {
    tool: String,
    args: Option<Value>,
}

/// イベントを 1 つずつ渡して、AI が残した変更を取り出す(大きな events.jsonl を全部読み込まずに済むように)
pub struct AiChangeBuilder {
    session_id: String,
    ctx: SessionVcsContext,
    cwd: Option<String>,
    starts: HashMap<String, StartInfo>,
    files: indexmap::IndexMap<String, FileState>,
    entries: Vec<Entry>,
    hunk_lines: Vec<(HunkHead, Vec<usize>)>,
    skipped: Skipped,
    next_id: i64,
}

fn non_empty_str<'a>(c: &'a serde_json::Map<String, Value>, k: &str) -> Option<&'a str> {
    match c.get(k) {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

impl AiChangeBuilder {
    pub fn new(session_id: &str) -> Self {
        AiChangeBuilder {
            session_id: session_id.to_string(),
            ctx: SessionVcsContext::default(),
            cwd: None,
            starts: HashMap::new(),
            files: indexmap::IndexMap::new(),
            entries: Vec::new(),
            hunk_lines: Vec::new(),
            skipped: Skipped::default(),
            next_id: 1,
        }
    }

    fn set_ctx(&mut self, c: Option<&Value>) {
        let Some(Value::Object(c)) = c else { return };
        let ctx = &mut self.ctx;
        if let Some(cwd) = non_empty_str(c, "cwd") {
            self.cwd = Some(cwd.to_string());
            if ctx.cwd.is_none() {
                ctx.cwd = Some(cwd.to_string());
                ctx.sources.insert("cwd".into(), ValueSource::Events);
            }
        }
        if ctx.git_root.is_none() {
            if let Some(v) = non_empty_str(c, "gitRoot") {
                ctx.git_root = Some(v.to_string());
                ctx.sources.insert("gitRoot".into(), ValueSource::Events);
            }
        }
        if ctx.branch.is_none() {
            if let Some(v) = non_empty_str(c, "branch") {
                ctx.branch = Some(v.to_string());
                ctx.sources.insert("branch".into(), ValueSource::Events);
            }
        }
        // 開始時の基準は最初に記録されたものを使う(再開後のコミットには、前半の AI の変更が入っていることがあるため)
        if ctx.head_commit.is_none() {
            if let Some(v) = non_empty_str(c, "headCommit") {
                ctx.head_commit = Some(v.to_string());
                ctx.sources.insert("headCommit".into(), ValueSource::Events);
            }
        }
        if ctx.base_commit.is_none() {
            if let Some(v) = non_empty_str(c, "baseCommit") {
                ctx.base_commit = Some(v.to_string());
            }
        }
    }

    fn apply(&mut self, raw_path: &str, op: PatchOp, blocks: &[Block], at: &Option<String>, tool_call_id: &Option<String>, from: HunkFrom) {
        let path = resolve_file_path(raw_path, self.cwd.as_deref());
        if is_session_state_path(&path) {
            self.skipped.session_state += 1;
            return;
        }
        let key = file_path_key(&path);
        let f = self.files.entry(key).or_insert_with(|| FileState { path: path.clone(), created: false, deleted: false, edits: 0, entries: Vec::new() });
        f.edits += 1;
        if op == PatchOp::Delete {
            for &e in &f.entries {
                self.entries[e].alive = false;
            }
            f.deleted = true;
            return;
        }
        if op == PatchOp::Add && f.edits == 1 {
            f.created = true;
        }
        // ファイルを作り直した(create で上書きした)なら、前の中身は残っていない。前に足した行は数えない
        if op == PatchOp::Add {
            for &e in &f.entries {
                self.entries[e].alive = false;
            }
        }
        f.deleted = false;
        for b in blocks {
            // AI が前に足した行を消したなら、その行は数えない(同じ本文のうち、いちばん新しい生きている行)
            for r in &b.removed {
                for &e in f.entries.iter().rev() {
                    let en = &mut self.entries[e];
                    if en.alive && en.text == *r {
                        en.alive = false;
                        break;
                    }
                }
            }
            let added: Vec<&String> = b.added.iter().filter(|x| !is_blank(x)).collect();
            if added.is_empty() {
                continue;
            }
            let mut ids = Vec::with_capacity(added.len());
            for text in added {
                ids.push(self.entries.len());
                self.entries.push(Entry { text: text.clone(), alive: true });
            }
            f.entries.extend_from_slice(&ids);
            self.hunk_lines.push((HunkHead { id: self.next_id, path: path.clone(), at: at.clone(), tool_call_id: tool_call_id.clone(), from }, ids));
            self.next_id += 1;
        }
    }

    pub fn push(&mut self, e: &CopilotEvent) {
        let at = match &e.timestamp {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        };
        if let Some(a) = at.as_ref().filter(|a| !a.is_empty()) {
            if self.ctx.start.is_none() {
                self.ctx.start = Some(a.clone());
            }
            self.ctx.end = Some(a.clone());
        }
        // d = e.data ?? {}
        let d = e.data.as_ref().filter(|v| !v.is_null());
        match e.kind.as_str() {
            "session.start" | "session.resume" => self.set_ctx(field(d, "context")),
            "session.context_changed" => self.set_ctx(d),
            "tool.execution_start" => {
                if let (Some(id), Some(tool)) = (str_field(d, "toolCallId"), str_field(d, "toolName")) {
                    if EDIT_TOOLS.contains(&tool) {
                        self.starts.insert(id.to_string(), StartInfo { tool: tool.to_string(), args: field(d, "arguments").cloned() });
                    }
                }
            }
            "tool.execution_complete" => {
                let Some(id) = str_field(d, "toolCallId") else { return };
                let Some(s) = self.starts.remove(id) else { return };
                let tcid = Some(id.to_string());
                if matches!(field(d, "success"), Some(Value::Bool(false))) {
                    self.skipped.failed += 1;
                    return;
                }
                let dc = field(field(d, "result"), "detailedContent").and_then(Value::as_str);
                let diff = match dc {
                    Some(t) if t.contains("@@") => parse_unified_diff(t),
                    _ => Vec::new(),
                };
                if !diff.is_empty() {
                    // パスは引数を優先する(diff の見出しは絶対パスの先頭の / が落ちることがあるため)。1 ファイルの編集だけ
                    let arg_path = if s.tool != "apply_patch" { str_field(s.args.as_ref(), "path").filter(|p| !p.is_empty()).map(str::to_string) } else { None };
                    let single = diff.len() == 1;
                    for df in &diff {
                        let raw = match (&arg_path, single) {
                            (Some(a), true) => Some(a.clone()),
                            _ => df.new_path.clone().filter(|p| !p.is_empty()).or_else(|| df.old_path.clone().filter(|p| !p.is_empty())),
                        };
                        let Some(raw) = raw else { continue };
                        let path = if arg_path.is_some() && single { raw } else { header_path(&raw, self.cwd.as_deref()) };
                        let op = if df.new_path.is_none() {
                            PatchOp::Delete
                        } else if df.old_path.is_none() {
                            PatchOp::Add
                        } else {
                            PatchOp::Update
                        };
                        self.apply(&path, op, &df.blocks, &at, &tcid, HunkFrom::Diff);
                    }
                    return;
                }
                let from_args = changes_from_args(&s.tool, s.args.as_ref());
                if from_args.is_empty() {
                    self.skipped.no_material += 1;
                    return;
                }
                for c in &from_args {
                    self.apply(&c.path, c.op, &c.blocks, &at, &tcid, HunkFrom::Args);
                }
            }
            _ => {}
        }
    }

    /// 取り出しを終える。workspace は events に cwd / gitRoot / branch が無いときの補完にだけ使う
    pub fn finish(mut self, workspace: Option<&WorkspaceHints>) -> AiChangeSet {
        if let Some(w) = workspace {
            let ctx = &mut self.ctx;
            if ctx.cwd.is_none() {
                if let Some(v) = w.cwd.as_ref().filter(|v| !v.is_empty()) {
                    ctx.cwd = Some(v.clone());
                    ctx.sources.insert("cwd".into(), ValueSource::Workspace);
                }
            }
            if ctx.git_root.is_none() {
                if let Some(v) = w.git_root.as_ref().filter(|v| !v.is_empty()) {
                    ctx.git_root = Some(v.clone());
                    ctx.sources.insert("gitRoot".into(), ValueSource::Workspace);
                }
            }
            if ctx.branch.is_none() {
                if let Some(v) = w.branch.as_ref().filter(|v| !v.is_empty()) {
                    ctx.branch = Some(v.clone());
                    ctx.sources.insert("branch".into(), ValueSource::Workspace);
                }
            }
        }
        let mut hunks = Vec::new();
        for (h, ids) in self.hunk_lines {
            let lines: Vec<String> = ids.iter().filter(|&&i| self.entries[i].alive).map(|&i| self.entries[i].text.clone()).collect();
            if !lines.is_empty() {
                hunks.push(AiHunk { id: h.id, path: h.path, at: h.at, tool_call_id: h.tool_call_id, lines, from: h.from });
            }
        }
        AiChangeSet {
            session_id: self.session_id,
            context: self.ctx,
            files: self.files.into_values().filter(|f| f.edits > 0).map(|f| AiFileChange { path: f.path, created: f.created, deleted: f.deleted, edits: f.edits }).collect(),
            hunks,
            skipped: self.skipped,
        }
    }
}

/// セッションのイベントから、AI が残した変更を取り出す。
/// workspace は events に cwd / gitRoot / branch が無いときの補完にだけ使う
pub fn extract_ai_changes(session_id: &str, events: &[CopilotEvent], workspace: Option<&WorkspaceHints>) -> AiChangeSet {
    let mut b = AiChangeBuilder::new(session_id);
    for e in events {
        b.push(e);
    }
    b.finish(workspace)
}

static WIN_ABS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());

/// diff の見出しのパス(E:/x/y や home/u/x)を絶対パスに戻す
fn header_path(p: &str, cwd: Option<&str>) -> String {
    if WIN_ABS_RE.is_match(p) || p.starts_with('/') || p.starts_with("\\\\") {
        return p.to_string();
    }
    // git の a/ b/ を外すと posix の絶対パスは先頭の / が落ちる。cwd が posix で、cwd の先頭と同じなら / を戻す
    if let Some(cwd) = cwd.filter(|c| !c.is_empty() && c.starts_with('/')) {
        let head: Vec<&str> = cwd.split('/').take(2).collect();
        if format!("/{p}").starts_with(&format!("{}/", head.join("/"))) {
            return format!("/{p}");
        }
    }
    p.to_string()
}

#[cfg(test)]
mod tests;
