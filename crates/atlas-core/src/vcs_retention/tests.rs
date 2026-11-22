//! AI の変更がその後の VCS のファイルに残っているか(packages/core/test/vcs-retention.test.ts の移植)。
//! git は一時フォルダに実際のリポジトリを作る。Perforce と SVN は偽の CLI(架空の版の履歴)で応答する。中身はすべて架空のもの

use super::*;
use crate::ai_changes::extract_ai_changes;
use crate::types::CopilotEvent;
use crate::vcs::{assert_read_only, default_runner, p4_escape, p4_server_offset, run_read_only, vcs_env, RunResult};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicU32;

static CALL_SEQ: AtomicU32 = AtomicU32::new(0);

/// 2026-11-01 の h 時 m 分(24 時を超えたら翌日以降)
pub(crate) fn at(h: i64, m: i64) -> String {
    jsdate::to_iso(jsdate::parse_ms("2026-11-01T00:00:00.000Z").unwrap() + h * 3_600_000 + m * 60_000)
}

fn ms_of(iso: &str) -> i64 {
    jsdate::parse_ms(iso).unwrap()
}

fn diff_of(path: &str, added: &[&str], removed: &[&str]) -> String {
    let p = path.replace('\\', "/");
    let mut v = vec![format!("diff --git a/{p} b/{p}"), format!("--- a/{p}"), format!("+++ b/{p}"), "@@ -1,1 +1,1 @@".into()];
    v.extend(removed.iter().map(|l| format!("-{l}")));
    v.extend(added.iter().map(|l| format!("+{l}")));
    v.push(String::new());
    v.join("\n")
}

fn ev(kind: &str, timestamp: &str, data: Value) -> CopilotEvent {
    CopilotEvent { kind: kind.into(), data: Some(data), id: None, timestamp: Some(Value::String(timestamp.into())), parent_id: None, agent_id: None }
}

struct EditSpec<'a> {
    path: String,
    added: Vec<&'a str>,
    removed: Vec<&'a str>,
    /// 時:分
    t: Option<(i64, i64)>,
}

fn ed<'a>(path: &str, added: &[&'a str]) -> EditSpec<'a> {
    EditSpec { path: path.to_string(), added: added.to_vec(), removed: vec![], t: None }
}

fn ed_at<'a>(path: &str, added: &[&'a str], t: (i64, i64)) -> EditSpec<'a> {
    EditSpec { t: Some(t), ..ed(path, added) }
}

/// セッションのイベントを作る(開始 → 編集 → 最後のイベント)
fn session(cwd: &str, git_root: Option<&str>, head_commit: Option<&str>, start: (i64, i64), end: (i64, i64), edits: Vec<EditSpec<'_>>) -> Vec<CopilotEvent> {
    let mut ctx = serde_json::Map::new();
    ctx.insert("cwd".into(), json!(cwd));
    if let Some(g) = git_root {
        ctx.insert("gitRoot".into(), json!(g));
    }
    if let Some(h) = head_commit {
        ctx.insert("headCommit".into(), json!(h));
    }
    let mut out = vec![ev("session.start", &at(start.0, start.1), json!({ "context": ctx }))];
    for e in edits {
        let id = format!("c{}", CALL_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
        let t = e.t.unwrap_or(start);
        let t = at(t.0, t.1);
        out.push(ev("tool.execution_start", &t, json!({"toolCallId": id, "toolName": "edit", "arguments": {"path": e.path, "old_str": "", "new_str": ""}})));
        out.push(ev("tool.execution_complete", &t, json!({"toolCallId": id, "success": true, "result": {"content": "ok", "detailedContent": diff_of(&e.path, &e.added, &e.removed)}})));
    }
    out.push(ev("assistant.turn_end", &at(end.0, end.1), json!({})));
    out
}

fn set_branch(ev: &mut [CopilotEvent], branch: &str) {
    ev[0].data.as_mut().unwrap()["context"]["branch"] = json!(branch);
}

pub(crate) struct Tmp(Vec<tempfile::TempDir>);

impl Tmp {
    pub(crate) fn new() -> Self {
        Tmp(Vec::new())
    }
    pub(crate) fn dir(&mut self) -> String {
        let d = tempfile::Builder::new().prefix("atlas-vcs-").tempdir().unwrap();
        let p = crate::jsfs::realpath(d.path()).unwrap().to_string_lossy().into_owned();
        self.0.push(d);
        p
    }
}

pub(crate) fn join(a: &str, parts: &[&str]) -> String {
    let mut p = std::path::PathBuf::from(a);
    for x in parts {
        p.push(x);
    }
    p.to_string_lossy().into_owned()
}

pub(crate) fn write(path: &str, lines: &[&str]) {
    std::fs::create_dir_all(Path::new(path).parent().unwrap()).unwrap();
    std::fs::write(path, lines.join("\n") + "\n").unwrap();
}

/// テスト用のリポジトリを作る git(atlas の照合とは別。一時フォルダの中だけに書く)
pub(crate) fn git(root: &str, args: &[&str], date: &str) -> String {
    let out = Command::new("git")
        .args(["-C", root, "-c", "commit.gpgsign=false"])
        .args(args)
        .envs([("GIT_AUTHOR_NAME", "zz"), ("GIT_AUTHOR_EMAIL", "zz@example.invalid"), ("GIT_COMMITTER_NAME", "zz"), ("GIT_COMMITTER_EMAIL", "zz@example.invalid"), ("GIT_AUTHOR_DATE", date), ("GIT_COMMITTER_DATE", date)])
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn git9(root: &str, args: &[&str]) -> String {
    git(root, args, &at(9, 0))
}

fn git_repo(tmp: &mut Tmp, files: &[(&str, &[&str])]) -> (String, String) {
    let root = tmp.dir();
    git9(&root, &["init", "-q", "-b", "main"]);
    for (rel, lines) in files {
        write(&join(&root, &[rel]), lines);
    }
    git9(&root, &["add", "-A"]);
    git9(&root, &["commit", "-q", "-m", "base"]);
    let head = git9(&root, &["rev-parse", "HEAD"]);
    (root, head)
}

fn opts() -> RetentionOptions {
    RetentionOptions::default()
}

fn measure(sets: &[AiChangeSet], o: &RetentionOptions) -> Vec<SessionRetention> {
    measure_retention(sets, o)
}

fn statuses(r: &SessionRetention) -> Vec<RetentionStatus> {
    r.hunks.iter().map(|h| h.status).collect()
}

fn lc(kept: i64, modified: i64, missing: i64, unattributable: i64) -> LineCounts {
    LineCounts { kept, modified, missing, unattributable }
}

#[test]
fn read_only_guard() {
    let ok: [(VcsKind, &[&str]); 5] = [
        (VcsKind::Git, &["--no-optional-locks", "-C", "x", "show", "HEAD:a"]),
        (VcsKind::Git, &["-C", "x", "-c", "core.quotepath=false", "rev-list", "-1", "HEAD"]),
        (VcsKind::Svn, &["--non-interactive", "cat", "-r", "3", "x"]),
        (VcsKind::P4, &["-d", "x", "-q", "print", "x@3"]),
        (VcsKind::P4, &["-d", "x", "-ztag", "info"]),
    ];
    for (cmd, args) in ok {
        let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        assert!(assert_read_only(cmd, &a).is_ok(), "{cmd:?} {args:?}");
    }
    let bad: [(VcsKind, &[&str]); 12] = [
        // ファイルに書き出す(-o)
        (VcsKind::P4, &["-d", "x", "-q", "print", "-o", "out.txt", "x@3"]),
        (VcsKind::P4, &["-d", "x", "-q", "print", "-oout.txt", "x@3"]),
        (VcsKind::Git, &["commit", "-m", "x"]),
        (VcsKind::Git, &["-C", "x", "checkout", "HEAD"]),
        (VcsKind::Git, &["-c", "user.name=x", "show", "HEAD"]),
        (VcsKind::Git, &["show", "--output=x", "HEAD"]),
        (VcsKind::Git, &["status"]),
        (VcsKind::Svn, &["update"]),
        (VcsKind::Svn, &["--non-interactive", "revert", "x"]),
        (VcsKind::P4, &["-d", "x", "sync"]),
        (VcsKind::P4, &["edit", "x"]),
        (VcsKind::P4, &[]),
    ];
    for (cmd, args) in bad {
        let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        assert!(assert_read_only(cmd, &a).is_err(), "{cmd:?} {args:?}");
    }
}

// ---- git(実際のリポジトリ) ----

#[test]
fn git_kept_modified_missing_and_baseline_lines() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("src/a.ts", &["export const base = 1;", "export const moved = 2;"])]);
    let f = join(&root, &["src", "a.ts"]);
    let ev = session(
        &root,
        Some(&root),
        Some(&head),
        (10, 0),
        (11, 0),
        vec![
            ed_at(&f, &["export const keptA = 10;", "export const keptB = 11;"], (10, 1)),
            ed_at(&f, &["export function similar(value: number) { return value * 2; }"], (10, 2)),
            ed_at(&f, &["export const goneAway = 99;"], (10, 3)),
            // 基準にもともとある行(移動しただけ)は数えない
            ed_at(&f, &["export const moved = 2;"], (10, 4)),
        ],
    );
    // 照合時: 1 つ目はそのまま、2 つ目は少し直した、3 つ目は消した
    write(&f, &["export const base = 1;", "export const moved = 2;", "export const keptA = 10;", "export const keptB = 11;", "export function similar(value: number) { return value * 3; }"]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { now_ms: Some(ms_of(&at(12, 0))), ..opts() })[0];
    assert_eq!(r.outcome, Outcome::Measured);
    assert_eq!(r.vcs, Some(VcsKind::Git));
    assert_eq!(r.baseline, Some(Revision { rev: head.clone(), source: RevisionSource::Observed }));
    assert_eq!(r.evaluated, Some(Evaluated { mode: EvalMode::Worktree, rev: Some(head.clone()), at: at(12, 0), source: None }));
    assert_eq!(r.excluded_hunks, 1);
    assert_eq!(statuses(r), [RetentionStatus::Kept, RetentionStatus::Modified, RetentionStatus::Missing]);
    assert_eq!(r.counts, lc(1, 1, 1, 0));
    assert_eq!(r.lines, lc(2, 1, 1, 0));
    assert_eq!((r.provenance.ai_changes.as_str(), r.provenance.baseline), ("events", Some(RevisionSource::Observed)));
    // 書き出す形(キーの順は TS 版と同じ)
    let v = serde_json::to_value(r).unwrap();
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["sessionId", "outcome", "vcs", "root", "baseline", "evaluated", "repos", "hunks", "excludedHunks", "counts", "lines", "provenance", "sessionEnd"]);
    // 照合に使ったリポジトリごとの基準と比べた版
    assert_eq!(v["repos"], json!([{ "vcs": "git", "root": root, "baseline": { "rev": head, "source": "observed" }, "evaluated": { "rev": head } }]));
    // 出所(どのツールの呼び出しの、ログのどこから取った変更か)と、照合に使ったリポジトリを添える。似た本文で当てた行は推定として別に数える
    assert_eq!(v["hunks"][0].as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "path", "status", "lines", "at", "toolCallId", "from", "vcs", "root"]);
    assert_eq!((v["hunks"][0]["from"].as_str(), v["hunks"][0]["toolCallId"].is_string(), v["hunks"][0]["vcs"].as_str(), v["hunks"][0]["root"].as_str()), (Some("diff"), true, Some("git"), Some(root.as_str())));
    assert_eq!(v["hunks"][1].as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "path", "status", "lines", "at", "similarLines", "toolCallId", "from", "vcs", "root"]);
    assert_eq!((r.hunks[0].similar_lines, r.hunks[1].similar_lines), (0, 1));
    let s = summarize_retention(std::slice::from_ref(r));
    assert_eq!((s.similar_lines, s.excluded_hunks, s.evaluated_estimated, s.unread_edits), (1, 1, 0, 0));
    let sv = serde_json::to_value(&s).unwrap();
    assert_eq!((sv.get("similarLines"), sv.get("excludedHunks"), sv.get("evaluatedEstimated"), sv.get("unreadEdits")), (Some(&json!(1)), Some(&json!(1)), None, None));
}

#[test]
fn git_counts_added_copies_of_baseline_text() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.ts", &["function a() {", "  return null;", "}"])]);
    let f = join(&root, &["a.ts"]);
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed_at(&f, &["function b() {", "  return null;", "}"], (10, 1)), ed_at(&f, &["function c() {", "  return null;", "}"], (10, 2))]);
    // b は残し、c は消した。return null; と } は基準にもあるが、b の分だけ増えている
    write(&f, &["function a() {", "  return null;", "}", "function b() {", "  return null;", "}"]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!(r.hunks.iter().map(|h| (h.status, h.lines.kept, h.lines.missing)).collect::<Vec<_>>(), [(RetentionStatus::Kept, 3, 0), (RetentionStatus::Missing, 0, 1)]);
    assert_eq!((r.lines.kept, r.lines.missing), (3, 1));
}

#[test]
fn git_estimated_baseline_uses_session_branch() {
    let mut tmp = Tmp::new();
    let (root, _) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    git9(&root, &["checkout", "-q", "-b", "feat/x"]);
    write(&join(&root, &["a.txt"]), &["base", "on feature branch"]);
    git(&root, &["commit", "-q", "-am", "feature"], &at(9, 30));
    let feat = git9(&root, &["rev-parse", "HEAD"]);
    git9(&root, &["checkout", "-q", "main"]);
    let f = join(&root, &["a.txt"]);
    let mut ev = session(&root, Some(&root), None, (10, 0), (11, 0), vec![ed(&f, &["ai line here"])]);
    set_branch(&mut ev, "feat/x");
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!(r.baseline, Some(Revision { rev: feat, source: RevisionSource::Estimated }));
    // 名前が素直でないブランチ(引数として読まれうるもの)は使わず、HEAD で探す
    let mut ev2 = session(&root, Some(&root), None, (10, 0), (11, 0), vec![ed(&f, &["ai line here"])]);
    set_branch(&mut ev2, "--output=x");
    let r2 = &measure(&[extract_ai_changes("s2", &ev2, None)], &opts())[0];
    assert_eq!(r2.baseline.as_ref().unwrap().rev, git9(&root, &["rev-parse", "main"]));
}

#[test]
fn git_short_common_lines_do_not_conflict() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.ts", &["base"])]);
    let f = join(&root, &["a.ts"]);
    let a = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&f, &["export const fromA = 1;", "}"])]);
    let b = session(&root, Some(&root), Some(&head), (10, 30), (11, 30), vec![ed(&f, &["export const fromB = 2;", "}"])]);
    write(&f, &["base", "export const fromA = 1;", "}", "export const fromB = 2;", "}"]);
    let rs = measure(&[extract_ai_changes("a", &a, None), extract_ai_changes("b", &b, None)], &opts());
    for r in &rs {
        assert_eq!((r.hunks[0].status, r.hunks[0].lines.kept, r.hunks[0].lines.unattributable), (RetentionStatus::Kept, 2, 0));
    }
}

#[test]
fn git_partial_duplicate_and_deleted() {
    let mut tmp = Tmp::new();
    // 一部の行だけ残ったまとまりは「直されて残る」
    let (root, head) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let f = join(&root, &["a.txt"]);
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&f, &["first line kept", "second line removed"])]);
    write(&f, &["base", "first line kept"]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!((r.hunks[0].status, r.hunks[0].lines), (RetentionStatus::Modified, lc(1, 0, 1, 0)));
    // 同じ本文の行を 2 回足しても、照合時に 1 回しかなければ 1 行だけ残存
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed_at(&f, &["dup line"], (10, 1)), ed_at(&f, &["dup line"], (10, 2))]);
    write(&f, &["base", "dup line"]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!(statuses(r), [RetentionStatus::Kept, RetentionStatus::Missing]);
    // 照合時にファイルが消えていれば未確認(照合はできている)
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&f, &["ai line"])]);
    std::fs::remove_file(&f).unwrap();
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!((r.outcome, r.counts.missing), (Outcome::Measured, 1));
    // AI が作った新しいファイル(基準に無い)も照合する
    let nf = join(&root, &["new", "b.txt"]);
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&nf, &["brand new"])]);
    write(&nf, &["brand new"]);
    assert_eq!(measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0].counts.kept, 1);
}

#[test]
fn git_committed_mode_ignores_uncommitted() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let f = join(&root, &["a.txt"]);
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&f, &["uncommitted"])]);
    write(&f, &["base", "uncommitted"]);
    let sets = [extract_ai_changes("s1", &ev, None)];
    assert_eq!(measure(&sets, &opts())[0].counts.kept, 1);
    // 開始時から何も取り込んでいなければ、比べる版が基準と同じなので照合不可(見つからないに数えない)
    let c = &measure(&sets, &RetentionOptions { mode: EvalMode::Committed, ..opts() })[0];
    assert_eq!((c.outcome, c.reason, c.counts.missing, c.counts.unattributable), (Outcome::Unattributable, Some(UnattributableReason::NoCommits), 0, 1));
    assert_eq!(c.evaluated.as_ref().unwrap().mode, EvalMode::Committed);
    assert_eq!(serde_json::to_value(&summarize_retention(std::slice::from_ref(c)).unattributable).unwrap(), json!({"no_commits": 1}));
    // 別のファイルだけを取り込んだ後なら、取り込まれていない AI の行は見つからない
    write(&join(&root, &["other.txt"]), &["other"]);
    git(&root, &["add", "other.txt"], &at(12, 0));
    git(&root, &["commit", "-q", "-m", "other"], &at(12, 0));
    let c = &measure(&sets, &RetentionOptions { mode: EvalMode::Committed, ..opts() })[0];
    assert_eq!((c.outcome, c.counts.missing), (Outcome::Measured, 1));
    assert_eq!(c.evaluated.as_ref().unwrap().mode, EvalMode::Committed);
}

#[test]
fn fixed_mode_without_commits_is_unattributable() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let f = join(&root, &["a.txt"]);
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&f, &["never committed"])]);
    write(&f, &["base", "never committed"]);
    let sets = [extract_ai_changes("s1", &ev, None)];
    let now = Some(ms_of(&at(24 * 20, 0)));
    let r = &measure(&sets, &RetentionOptions { mode: EvalMode::Fixed, lag_days: 7, now_ms: now, ..opts() })[0];
    assert_eq!((r.outcome, r.reason, r.hunks[0].reason), (Outcome::Unattributable, Some(UnattributableReason::NoCommits), Some(UnattributableReason::NoCommits)));
    // 推定の基準(headCommit の記録が無い)でも同じ
    let ev2 = session(&root, Some(&root), None, (10, 0), (11, 0), vec![ed(&f, &["never committed"])]);
    let r2 = &measure(&[extract_ai_changes("s2", &ev2, None)], &RetentionOptions { mode: EvalMode::Fixed, lag_days: 7, now_ms: now, ..opts() })[0];
    assert_eq!((r2.outcome, r2.reason), (Outcome::Unattributable, Some(UnattributableReason::NoCommits)));
    // worktree は今のまま(ディスクのファイルと比べる)
    let w = &measure(&sets, &RetentionOptions { now_ms: now, ..opts() })[0];
    assert_eq!((w.outcome, w.counts.kept), (Outcome::Measured, 1));
}

#[test]
fn same_revision_prefix() {
    let full = "0123456789abcdef0123456789abcdef01234567";
    assert!(same_revision(VcsKind::Git, full, full));
    assert!(same_revision(VcsKind::Git, "0123456", full));
    assert!(same_revision(VcsKind::Git, &full.to_uppercase(), full));
    assert!(!same_revision(VcsKind::Git, "012345", full)); // 短すぎる印は同じとみなさない
    assert!(!same_revision(VcsKind::Git, "", full));
    assert!(same_revision(VcsKind::Svn, "7", " 7"));
    assert!(!same_revision(VcsKind::P4, "7", "70"));
}

#[test]
fn git_estimated_and_missing_baseline() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    write(&join(&root, &["a.txt"]), &["base", "after session"]);
    git(&root, &["commit", "-q", "-am", "later"], &at(13, 0));
    let f = join(&root, &["a.txt"]);
    let ev = session(&root, Some(&root), None, (10, 0), (11, 0), vec![ed(&f, &["after session"])]);
    let r = measure(&[extract_ai_changes("s1", &ev, None)], &opts());
    assert_eq!(r[0].baseline, Some(Revision { rev: head, source: RevisionSource::Estimated }));
    assert_eq!((r[0].provenance.baseline, r[0].counts.kept), (Some(RevisionSource::Estimated), 1));
    assert_eq!(summarize_retention(&r).baseline_estimated, 1);
    // 記録された headCommit がもう無ければ、推定で置き換えず照合不可
    let fff = "f".repeat(40);
    let ev = session(&root, Some(&root), Some(&fff), (10, 0), (11, 0), vec![ed(&f, &["x line"])]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!((r.outcome, r.reason, r.counts.unattributable), (Outcome::Unattributable, Some(UnattributableReason::BaselineMissing), 1));
}

#[test]
fn repo_not_found_and_no_vcs() {
    let mut tmp = Tmp::new();
    let gone = join(&tmp.dir(), &["gone", "repo"]);
    let ev = session(&gone, Some(&gone), Some("abc"), (10, 0), (11, 0), vec![ed(&join(&gone, &["a.txt"]), &["x line"])]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!((r.outcome, r.reason, r.vcs), (Outcome::Unattributable, Some(UnattributableReason::RepoNotFound), None));

    let plain = tmp.dir();
    let ev = session(&plain, None, None, (10, 0), (11, 0), vec![ed(&join(&plain, &["a.txt"]), &["x line"])]);
    write(&join(&plain, &["a.txt"]), &["x line"]);
    let runner: VcsRunner = Arc::new(|cmd, _, _| RunResult { code: if cmd == VcsKind::Git { 128 } else { -1 }, stdout: String::new(), stderr: "not a repository".into() });
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() })[0];
    assert_eq!((r.outcome, r.reason), (Outcome::Unattributable, Some(UnattributableReason::NoVcs)));
}

#[test]
fn outside_repo_only_that_hunk() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let plain = tmp.dir();
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&join(&root, &["a.txt"]), &["in repo"]), ed(&join(&plain, &["notes.txt"]), &["outside"])]);
    write(&join(&root, &["a.txt"]), &["base", "in repo"]);
    // git だけ本物(一時フォルダの外では、上のフォルダのリポジトリに当たらないよう svn・p4 は無いことにする)
    let runner: VcsRunner = Arc::new(|cmd, args, cwd| if cmd == VcsKind::Git { crate::vcs::default_run(cmd, args, cwd) } else { RunResult { code: -1, ..Default::default() } });
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() })[0];
    assert_eq!(r.outcome, Outcome::Measured);
    assert_eq!(r.hunks.iter().map(|h| (h.status, h.reason)).collect::<Vec<_>>(), [(RetentionStatus::Kept, None), (RetentionStatus::Unattributable, Some(UnattributableReason::OutsideRepo))]);
}

#[test]
fn double_counting_later_and_concurrent() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let f = join(&root, &["a.txt"]);
    let s1 = session(&root, Some(&root), Some(&head), (10, 0), (10, 30), vec![ed(&f, &["shared line", "only s1"])]);
    let s2 = session(&root, Some(&root), Some(&head), (11, 0), (11, 30), vec![ed_at(&f, &["shared line"], (11, 1))]);
    write(&f, &["base", "shared line", "only s1"]);
    let rs = measure(&[extract_ai_changes("s1", &s1, None), extract_ai_changes("s2", &s2, None)], &opts());
    // s1 のまとまりは only s1 だけで判定する(shared line は後の s2 の分なので、s1 では照合不可の行に数える)
    assert_eq!((rs[0].hunks[0].status, rs[0].hunks[0].lines.kept, rs[0].hunks[0].lines.unattributable), (RetentionStatus::Kept, 1, 1));
    assert_eq!((rs[1].hunks[0].status, rs[1].hunks[0].lines.kept), (RetentionStatus::Kept, 1));
    assert_eq!(summarize_retention(&rs).lines.kept, 2); // shared line は 1 回だけ数える

    let s3 = session(&root, Some(&root), Some(&head), (10, 10), (10, 40), vec![ed_at(&f, &["shared line"], (10, 11))]);
    let rs = measure(&[extract_ai_changes("s1", &s1, None), extract_ai_changes("s2", &s2, None), extract_ai_changes("s3", &s3, None)], &opts());
    assert_eq!((rs[0].hunks[0].status, rs[0].hunks[0].reason), (RetentionStatus::Unattributable, Some(UnattributableReason::ConcurrentSession)));
    assert_eq!((rs[2].outcome, rs[2].reason), (Outcome::Unattributable, Some(UnattributableReason::ConcurrentSession)));
}

#[test]
fn summary_scope() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let f = join(&root, &["a.txt"]);
    write(&f, &["base", "kept line"]);
    let gone = join(&tmp.dir(), &["gone"]);
    let sets = [
        extract_ai_changes("ok", &session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&f, &["kept line"])]), None),
        extract_ai_changes("gone", &session(&gone, None, None, (10, 0), (11, 0), vec![ed(&join(&gone, &["x.txt"]), &["zz"])]), None),
        extract_ai_changes("none", &session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![]), None),
    ];
    let s = summarize_retention(&measure(&sets, &opts()));
    assert_eq!((s.sessions, s.with_ai_changes, s.measured), (3, 2, 1));
    assert_eq!(serde_json::to_value(&s.unattributable).unwrap(), json!({"repo_not_found": 1}));
    assert_eq!(s.hunks, lc(1, 0, 0, 0));
    assert_eq!(serde_json::to_value(&s.by_vcs).unwrap(), json!({"git": 1}));
}

// ---- SVN と Perforce(偽の CLI) ----

#[derive(Clone)]
struct FakeRev {
    rev: u32,
    at: String,
    /// root からの相対パス(/ 区切り) → 本文
    files: Vec<(&'static str, Vec<&'static str>)>,
}

fn rev(rev: u32, at: String, files: &[(&'static str, &[&'static str])]) -> FakeRev {
    FakeRev { rev, at, files: files.iter().map(|(p, l)| (*p, l.to_vec())).collect() }
}

type Calls = Arc<Mutex<Vec<(VcsKind, Vec<String>)>>>;

/// 架空の版の履歴に、svn / p4 の読む系のコマンドだけで答える。呼ばれたコマンドは calls に残す
fn fake_vcs(kind: VcsKind, root: &str, revs: Vec<FakeRev>) -> (VcsRunner, Calls) {
    fake_vcs_tz(kind, root, revs, 0)
}

/// p4 の日時指定(@2026/11/01:19:00:00)を、UTC から tz_min 分ずれた地方時として読む fake_vcs(サーバの地方時を真似る)
fn fake_vcs_tz(kind: VcsKind, root: &str, revs: Vec<FakeRev>, tz_min: i64) -> (VcsRunner, Calls) {
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let c2 = calls.clone();
    let root = root.to_string();
    let runner: VcsRunner = Arc::new(move |cmd, args, _cwd| {
        c2.lock().unwrap().push((cmd, args.to_vec()));
        let ok = |s: String| RunResult { code: 0, stdout: s, stderr: String::new() };
        let rel = |p: &str| p.strip_prefix(&root).unwrap_or(p).trim_start_matches(['\\', '/']).replace('\\', "/");
        let rev_at = |iso: &str| revs.iter().rev().find(|r| r.at.as_str() <= iso).cloned();
        let content = |r: Option<FakeRev>, p: &str| -> RunResult {
            if let Some(lines) = r.as_ref().and_then(|r| r.files.iter().find(|f| f.0 == rel(p))).map(|f| f.1.clone()) {
                return ok(lines.join("\n") + "\n");
            }
            if kind == VcsKind::Svn {
                RunResult { code: 1, stdout: String::new(), stderr: format!("svn: E200009: '{p}' path not found") }
            } else {
                RunResult { code: 0, stdout: String::new(), stderr: format!("{p} - no such file(s).") }
            }
        };
        if cmd == VcsKind::Git {
            return RunResult { code: 128, stdout: String::new(), stderr: "fatal: not a git repository".into() };
        }
        if cmd != kind {
            return RunResult { code: -1, stdout: String::new(), stderr: format!("{} が見つかりません", cmd.as_str()) };
        }
        let ztag = args.iter().any(|x| x == "-ztag");
        let mut a: Vec<String> = args.iter().filter(|x| !["--non-interactive", "-q", "-ztag"].contains(&x.as_str())).cloned().collect();
        if a.first().map(String::as_str) == Some("-d") {
            a.drain(0..2);
        }
        let g = |i: usize| a.get(i).map(String::as_str).unwrap_or("");
        let last = revs.last().cloned();
        if kind == VcsKind::Svn {
            if g(0) == "info" && g(2) == "wc-root" {
                return ok(format!("{root}\n"));
            }
            if g(0) == "info" && g(2) == "revision" && g(3) == "-r" {
                let d = g(4);
                return match rev_at(&d[1..d.len() - 1]) {
                    Some(r) => ok(format!("{}\n", r.rev)),
                    None => RunResult { code: 1, stdout: String::new(), stderr: "svn: E195012: no revision".into() },
                };
            }
            if g(0) == "info" && g(2) == "revision" {
                return ok(format!("{}\n", last.unwrap().rev));
            }
            // 実物の svn と同じく、パスの末尾の @(空の peg 版)は外して読む
            if g(0) == "cat" {
                assert!(g(3).ends_with('@'));
                let r = if g(2) == "BASE" { last } else { revs.iter().find(|r| r.rev.to_string() == g(2)).cloned() };
                return content(r, &g(3)[..g(3).len() - 1]);
            }
        } else {
            if g(0) == "info" {
                return ok(format!("... clientName zz-ws\n... clientRoot {root}\n"));
            }
            if g(0) == "changes" {
                let spec = a.last().unwrap();
                let change = |r: Option<FakeRev>| ok(r.map(|r| format!("Change {} on 2026/11/01 by zz@zz-ws 'x'\n", r.rev)).unwrap_or_default());
                if spec.ends_with("#have") {
                    return change(last);
                }
                // 地方時の日時を UTC の ISO に
                let dates: Vec<String> = regex::Regex::new(r"@(\d+)/(\d+)/(\d+):(\d+):(\d+):(\d+)")
                    .unwrap()
                    .captures_iter(spec)
                    .map(|m| jsdate::to_iso(ms_of(&format!("{}-{}-{}T{}:{}:{}.000Z", &m[1], &m[2], &m[3], &m[4], &m[5], &m[6])) - tz_min * 60_000))
                    .collect();
                if let [from, to] = dates.as_slice() {
                    // 範囲(@a,@b)は -ztag で、取り込んだ時刻(UTC の秒)つき。新しい順
                    assert!(ztag, "範囲は -ztag で読む");
                    let out: String = revs.iter().rev().filter(|r| r.at >= *from && r.at <= *to).map(|r| format!("... change {}\n... time {}\n... user zz\n\n", r.rev, ms_of(&r.at) / 1000)).collect();
                    return ok(out);
                }
                return change(rev_at(&dates[0]));
            }
            if g(0) == "print" {
                let m = regex::Regex::new(r"^(.*)(?:@(\d+)|#have)$").unwrap().captures(g(1)).unwrap();
                let r = match m.get(2) {
                    Some(n) => revs.iter().find(|r| r.rev.to_string() == n.as_str()).cloned(),
                    None => last,
                };
                return content(r, &m[1]);
            }
        }
        RunResult { code: 1, stdout: String::new(), stderr: format!("unexpected {} {}", cmd.as_str(), args.join(" ")) }
    });
    (runner, calls)
}

#[test]
fn fake_svn_and_p4() {
    for kind in [VcsKind::Svn, VcsKind::P4] {
        let mut tmp = Tmp::new();
        // 開始時刻から基準を推定し、残存・直されて残る・未確認を分ける
        let root = tmp.dir();
        let f = join(&root, &["src", "a.c"]);
        let (runner, calls) = fake_vcs(kind, &root, vec![rev(7, at(8, 0), &[("src/a.c", &["int base = 0;"])]), rev(9, at(12, 0), &[("src/a.c", &["int base = 0;", "int kept = 1;"])])]);
        let ev = session(
            &root,
            None,
            None,
            (10, 0),
            (11, 0),
            vec![ed_at(&f, &["int kept = 1;"], (10, 1)), ed_at(&f, &["int computeTotal(int a, int b) { return a + b; }"], (10, 2)), ed_at(&f, &["int removedLater = 3;"], (10, 3))],
        );
        write(&f, &["int base = 0;", "int kept = 1;", "int computeTotal(int a, int b) { return a + b + 1; }"]);
        let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() })[0];
        assert_eq!((r.outcome, r.vcs), (Outcome::Measured, Some(kind)));
        assert_eq!(r.baseline, Some(Revision { rev: "7".into(), source: RevisionSource::Estimated }));
        assert_eq!(r.evaluated.as_ref().unwrap().rev.as_deref(), Some("9"));
        assert_eq!(statuses(r), [RetentionStatus::Kept, RetentionStatus::Modified, RetentionStatus::Missing]);
        // 呼んだのは読む系だけ
        for (c, a) in calls.lock().unwrap().iter() {
            assert!(assert_read_only(*c, a).is_ok(), "{c:?} {a:?}");
        }

        // committed では最後に取り込んだ版と比べる
        let root = tmp.dir();
        let f = join(&root, &["a.c"]);
        let (runner, _) = fake_vcs(kind, &root, vec![rev(1, at(8, 0), &[("a.c", &["base"])]), rev(2, at(12, 0), &[("a.c", &["base", "submitted line"])])]);
        let ev = session(&root, None, None, (10, 0), (11, 0), vec![ed(&f, &["submitted line", "local only"])]);
        write(&f, &["base", "local only"]);
        let sets = [extract_ai_changes("s1", &ev, None)];
        let w = &measure(&sets, &RetentionOptions { runner: runner.clone(), ..opts() })[0];
        let c = &measure(&sets, &RetentionOptions { runner, mode: EvalMode::Committed, ..opts() })[0];
        assert_eq!((w.hunks[0].lines.kept, w.hunks[0].lines.missing), (1, 1));
        assert_eq!((c.hunks[0].lines.kept, c.hunks[0].lines.missing, c.hunks[0].status), (1, 1, RetentionStatus::Modified));

        // committed で、今の版の印が基準と同じとき。p4 は取り込みが無いので照合不可(no_commits)。
        // svn の印は作業コピーのルートの版で、ファイルを取り込んでも進まないので、この判定をせず BASE を読んで照合する
        let root = tmp.dir();
        let f = join(&root, &["a.c"]);
        let (runner, _) = fake_vcs(kind, &root, vec![rev(1, at(8, 0), &[("a.c", &["base"])])]);
        let ev = session(&root, None, None, (10, 0), (11, 0), vec![ed(&f, &["local only"])]);
        write(&f, &["base", "local only"]);
        let c = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, mode: EvalMode::Committed, ..opts() })[0];
        if kind == VcsKind::Svn {
            assert_eq!((c.outcome, c.reason, c.counts.missing), (Outcome::Measured, None, 1));
        } else {
            assert_eq!((c.outcome, c.reason, c.counts.missing), (Outcome::Unattributable, Some(UnattributableReason::NoCommits), 0));
        }

        // 開始時刻より前の版が無ければ照合不可(baseline_missing)。欠測として数え、未確認にはしない
        let root = tmp.dir();
        let f = join(&root, &["a.c"]);
        let (runner, _) = fake_vcs(kind, &root, vec![rev(5, at(12, 0), &[("a.c", &["x"])])]);
        write(&f, &["x"]);
        let ev = session(&root, None, None, (10, 0), (11, 0), vec![ed(&f, &["ai"])]);
        let r = measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() });
        assert_eq!((r[0].outcome, r[0].reason), (Outcome::Unattributable, Some(UnattributableReason::BaselineMissing)));
        let s = summarize_retention(&r);
        assert_eq!((s.measured, s.with_ai_changes, s.hunks.missing), (0, 1, 0));
        assert_eq!(serde_json::to_value(&s.unattributable).unwrap(), json!({"baseline_missing": 1}));

        // セッションをまたいで同じ版のファイルは 1 回だけ読む(結果は各セッションに同じように付く)
        let root = tmp.dir();
        let f = join(&root, &["a.c"]);
        let (runner, calls) = fake_vcs(kind, &root, vec![rev(1, at(8, 0), &[("a.c", &["base"])])]);
        write(&f, &["base", "line one", "line two"]);
        let s1 = session(&root, None, None, (10, 0), (10, 20), vec![ed(&f, &["line one"])]);
        let s2 = session(&root, None, None, (11, 0), (11, 20), vec![ed_at(&f, &["line two"], (11, 1))]);
        let rs = measure(&[extract_ai_changes("a", &s1, None), extract_ai_changes("b", &s2, None)], &RetentionOptions { runner, ..opts() });
        assert_eq!(
            rs.iter().map(|r| (r.session_id.as_str(), r.outcome, r.counts.kept, r.baseline.as_ref().map(|b| b.rev.as_str()))).collect::<Vec<_>>(),
            [("a", Outcome::Measured, 1, Some("1")), ("b", Outcome::Measured, 1, Some("1"))]
        );
        let read_cmd = if kind == VcsKind::Svn { "cat" } else { "print" };
        assert_eq!(calls.lock().unwrap().iter().filter(|c| c.1.iter().any(|a| a == read_cmd)).count(), 1);

        // 二重計上を防ぎ、時間が重なるセッションの同じ行は照合不可にする
        let root = tmp.dir();
        let f = join(&root, &["a.c"]);
        let (runner, _) = fake_vcs(kind, &root, vec![rev(1, at(8, 0), &[("a.c", &["base"])])]);
        write(&f, &["base", "same line"]);
        let o = RetentionOptions { runner, ..opts() };
        let early = session(&root, None, None, (10, 0), (10, 20), vec![ed(&f, &["same line"])]);
        let late = session(&root, None, None, (11, 0), (11, 20), vec![ed_at(&f, &["same line"], (11, 1))]);
        let rs = measure(&[extract_ai_changes("e", &early, None), extract_ai_changes("l", &late, None)], &o);
        assert_eq!((rs[0].outcome, rs[0].reason), (Outcome::Unattributable, Some(UnattributableReason::LaterSession)));
        assert_eq!((rs[1].outcome, rs[1].counts.kept), (Outcome::Measured, 1));
        let overlap = session(&root, None, None, (10, 10), (10, 30), vec![ed_at(&f, &["same line"], (10, 11))]);
        let rs = measure(&[extract_ai_changes("e", &early, None), extract_ai_changes("o", &overlap, None)], &o);
        assert_eq!(rs.iter().map(|x| x.reason).collect::<Vec<_>>(), [Some(UnattributableReason::ConcurrentSession); 2]);
        assert_eq!(summarize_retention(&rs).lines.kept, 0);
    }
}

#[test]
fn vcs_args() {
    // p4 のファイル指定で特別な文字を逃がす(% を先に)
    assert_eq!(p4_escape("/w/img@2x.png"), "/w/img%402x.png");
    assert_eq!(p4_escape("/w/C#notes 100%*.md"), "/w/C%23notes 100%25%2A.md");
    // メッセージだけ英語にし、文字の扱いは利用者のものを残す(LC_ALL を外して LC_CTYPE に移す)
    let env = |pairs: &[(&str, &str)]| {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        vcs_env(|k| m.get(k).cloned())
    };
    let e = env(&[("LC_ALL", "ja_JP.UTF-8"), ("PATH", "/bin")]);
    let get = |e: &[(&str, Option<String>)], k: &str| e.iter().find(|x| x.0 == k).map(|x| x.1.clone());
    assert_eq!(get(&e, "LC_ALL"), Some(None));
    assert_eq!(get(&e, "LC_CTYPE"), Some(Some("ja_JP.UTF-8".into())));
    for (k, v) in [("LC_MESSAGES", "C"), ("LANGUAGE", "C"), ("GIT_OPTIONAL_LOCKS", "0")] {
        assert_eq!(get(&e, k), Some(Some(v.into())));
    }
    assert_eq!(get(&e, "PATH"), None); // そのまま
    assert_eq!(get(&env(&[("LANG", "en_US.UTF-8")]), "LC_CTYPE"), Some(Some("en_US.UTF-8".into())));
    assert_eq!(get(&env(&[]), "LC_CTYPE"), None);
}

#[test]
fn fixed_mode_and_unread_edits() {
    let mut tmp = Tmp::new();
    let (root, head) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let f = join(&root, &["a.txt"]);
    let ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![ed(&f, &["ai line that stays a while"])]);
    // 翌日に取り込み、10 日後に消した
    write(&f, &["base", "ai line that stays a while"]);
    git(&root, &["commit", "-q", "-am", "take ai line"], &at(24 + 10, 0));
    write(&f, &["base"]);
    git(&root, &["commit", "-q", "-am", "remove ai line"], &at(24 * 10 + 10, 0));
    let sets = [extract_ai_changes("s1", &ev, None)];
    let now = Some(ms_of(&at(24 * 20, 0)));
    assert_eq!(measure(&sets, &RetentionOptions { now_ms: now, ..opts() })[0].hunks[0].status, RetentionStatus::Missing);
    let fixed = &measure(&sets, &RetentionOptions { mode: EvalMode::Fixed, lag_days: 7, now_ms: now, ..opts() })[0];
    assert_eq!(fixed.outcome, Outcome::Measured);
    let e = fixed.evaluated.as_ref().unwrap();
    assert_eq!((e.mode, e.at.clone()), (EvalMode::Fixed, at(11 + 24 * 7, 0)));
    assert_eq!(fixed.session_end, Some(Some(at(11, 0))));
    assert_eq!(fixed.hunks[0].status, RetentionStatus::Kept);
    // fixed の版は日時から推定したもの。今の版を見る worktree には印を付けない
    assert_eq!(e.source, Some(RevisionSource::Estimated));
    assert_eq!(summarize_retention(std::slice::from_ref(fixed)).evaluated_estimated, 1);
    let w = &measure(&sets, &RetentionOptions { now_ms: now, ..opts() })[0];
    assert_eq!(w.evaluated.as_ref().unwrap().source, None);
    assert!(serde_json::to_value(w).unwrap()["evaluated"].get("source").is_none());
    // セッションの終わりから 3 日しか経っていなければ、照合しない
    let early = &measure(&sets, &RetentionOptions { mode: EvalMode::Fixed, lag_days: 7, now_ms: Some(ms_of(&at(24 * 3, 0))), ..opts() })[0];
    assert_eq!((early.outcome, early.reason, early.evaluated.clone()), (Outcome::Unattributable, Some(UnattributableReason::TooRecent), None));

    // ログから変更を取り出せなかった編集の数を残す
    let mut ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![]);
    ev.push(ev_odd("tool.execution_start", json!({"toolCallId": "odd", "toolName": "apply_patch", "arguments": {"unknown": 1}})));
    ev.push(ev_odd("tool.execution_complete", json!({"toolCallId": "odd", "success": true, "result": {"content": "ok"}})));
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!((r.outcome, r.unread_edits), (Outcome::NoAiChanges, Some(1)));
    // AI の変更を取り出せなかったセッションの読めない編集も、集計に残す(記録の欠けを隠さない)
    let s = summarize_retention(std::slice::from_ref(r));
    assert_eq!((s.with_ai_changes, s.unread_edits, s.unread_sessions), (0, 1, 1));
}

#[test]
fn read_only_runner_and_p4_timezone() {
    // 書く系のコマンドは呼ぶ前に止める。run_read_only は差し替えた runner を呼ばずに止め、
    // 既定の runner は run_read_only を通らずに直接呼ばれても起動しない(止まらなかったときに備えて、空の一時フォルダで呼ぶ)
    let mut tmp = Tmp::new();
    let empty = tmp.dir();
    let called = Arc::new(Mutex::new(0));
    let c2 = called.clone();
    let counting: VcsRunner = Arc::new(move |_, _, _| {
        *c2.lock().unwrap() += 1;
        RunResult::default()
    });
    for (kind, args) in [(VcsKind::Git, vec!["commit", "-m", "x"]), (VcsKind::Svn, vec!["update"]), (VcsKind::P4, vec!["print", "-o", "out.txt", "//d/a.c"])] {
        let a = args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(run_read_only(&counting, kind, &a, &empty).is_err(), "{kind:?} {args:?}");
        let r = default_runner()(kind, &a, &empty);
        assert_eq!((r.code, r.stdout.as_str()), (1, ""), "{kind:?} {args:?}");
        assert!(r.stderr.contains("止めました"), "{kind:?} {args:?}: {}", r.stderr);
    }
    assert_eq!(*called.lock().unwrap(), 0);

    assert_eq!(p4_server_offset("... serverDate 2026/11/01 19:00:00 +0900 JST\n"), Some(540));
    assert_eq!(p4_server_offset("... clientName zz\n... serverDate 2026/11/01 05:00:00 -0500 EST\n"), Some(-300));
    assert_eq!(p4_server_offset("... clientName zz\n"), None);

    // サーバの時差(p4 info の serverDate)で日時を直し、取り込んだ時刻で確かめる。
    // 照合したときの時差と、セッションのころの時差(夏時間)が 1 時間違っても、開始時刻 10:00(UTC)の直前の版 2 を基準にする
    let base_of = |now_min: i64, then_min: i64, timeless: bool| -> (Option<String>, Vec<String>) {
        let mut tmp = Tmp::new();
        let root = tmp.dir();
        let f = join(&root, &["a.c"]);
        let revs = vec![rev(1, at(8, 0), &[("a.c", &["old"])]), rev(2, at(9, 30), &[("a.c", &["base"])]), rev(3, at(10, 30), &[("a.c", &["base", "later"])])];
        let (inner, calls) = fake_vcs_tz(VcsKind::P4, &root, revs, then_min);
        let date = format!("... serverDate 2026/11/01 19:00:00 {}{:02}{:02} ZZ\n", if now_min < 0 { '-' } else { '+' }, now_min.abs() / 60, now_min.abs() % 60);
        let runner: VcsRunner = Arc::new(move |cmd, args, cwd| {
            let mut r = inner(cmd, args, cwd);
            if cmd == VcsKind::P4 && args.last().map(String::as_str) == Some("info") {
                r.stdout.push_str(&date);
            }
            // 取り込んだ時刻を出さないサーバを真似る
            if timeless {
                r.stdout = r.stdout.lines().filter(|l| !l.starts_with("... time ")).map(|l| format!("{l}\n")).collect();
            }
            r
        });
        write(&f, &["base", "ai"]);
        let ev = session(&root, None, None, (10, 0), (11, 0), vec![ed(&f, &["ai"])]);
        let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() })[0];
        assert_eq!((r.outcome, r.counts.kept), (Outcome::Measured, 1), "{now_min} {then_min}");
        let specs = calls.lock().unwrap().iter().filter(|c| c.1.iter().any(|a| a == "changes")).filter_map(|c| c.1.last().cloned()).collect();
        (r.baseline.as_ref().map(|b| b.rev.clone()), specs)
    };
    let (rev_same, specs) = base_of(540, 540, false);
    assert_eq!(rev_same.as_deref(), Some("2"));
    // UTC の 10:00 はサーバの 19:00。前後 1 時間を範囲で読む
    assert!(specs.iter().any(|s| s.ends_with("@2026/11/01:18:00:00,@2026/11/01:20:00:00")), "{specs:?}");
    // 時差だけで決めると、+0900 → +1000 では 9:00 の版 1、+1000 → +0900 では 11:00 の版 3 になる
    assert_eq!(base_of(540, 600, false).0.as_deref(), Some("2"));
    assert_eq!(base_of(600, 540, false).0.as_deref(), Some("2"));
    // 取り込んだ時刻を読めなければ確かめず、時差だけで決めた日時(サーバの 19:00)で探す。窓の前(18:00)の版 1 にはしない
    let (rev_timeless, specs) = base_of(540, 540, true);
    assert_eq!(rev_timeless.as_deref(), Some("2"));
    assert!(specs.iter().any(|s| s.ends_with("...@2026/11/01:19:00:00")), "{specs:?}");
}

#[test]
fn unknown_reason_and_revision_errors() {
    // 理由の無い照合不可は unknown として数える(読めなかったとは決めつけない)
    let r = SessionRetention { reason: None, ..not_measured_session() };
    let s = summarize_retention(std::slice::from_ref(&r));
    assert_eq!(serde_json::to_value(&s.unattributable).unwrap(), json!({"unknown": 1}));

    // 今の版を調べるコマンドが失敗したら、版が無い(no_commits)ではなく読めなかった(read_error)
    let mut tmp = Tmp::new();
    let root = tmp.dir();
    let f = join(&root, &["a.c"]);
    let (inner, _) = fake_vcs(VcsKind::P4, &root, vec![rev(1, at(8, 0), &[("a.c", &["base"])])]);
    let runner: VcsRunner = Arc::new(move |cmd, args, cwd| {
        if args.iter().any(|a| a == "changes") && args.last().is_some_and(|a| a.ends_with("#have")) {
            return RunResult { code: 1, stdout: String::new(), stderr: "Perforce client error: connect failed".into() };
        }
        inner(cmd, args, cwd)
    });
    write(&f, &["base", "ai"]);
    let ev = session(&root, None, None, (10, 0), (11, 0), vec![ed(&f, &["ai"])]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, mode: EvalMode::Committed, ..opts() })[0];
    assert_eq!((r.outcome, r.reason), (Outcome::Unattributable, Some(UnattributableReason::ReadError)));

    // 開始時の版の推定が失敗したら、基準を決められない(baseline_missing)ではなく読めなかった
    let root = tmp.dir();
    let f = join(&root, &["a.c"]);
    let (inner, _) = fake_vcs(VcsKind::Svn, &root, vec![rev(1, at(8, 0), &[("a.c", &["base"])])]);
    let runner: VcsRunner = Arc::new(move |cmd, args, cwd| {
        if args.iter().any(|a| a == "-r") && args.iter().any(|a| a.starts_with('{')) {
            return RunResult { code: 1, stdout: String::new(), stderr: "svn: E170013: Unable to connect to a repository".into() };
        }
        inner(cmd, args, cwd)
    });
    write(&f, &["base", "ai"]);
    let ev = session(&root, None, None, (10, 0), (11, 0), vec![ed(&f, &["ai"])]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() })[0];
    assert_eq!((r.outcome, r.reason), (Outcome::Unattributable, Some(UnattributableReason::ReadError)));

    // 環境の失敗(ファイルが開けない)を、版が無いと取り違えない。「その版・変更が無い」と答えたときだけ baseline_missing
    for (stderr, want) in [("open for read: zz.p4tickets: No such file or directory", UnattributableReason::ReadError), ("//zz/... - no such file(s).", UnattributableReason::BaselineMissing)] {
        let root = tmp.dir();
        let f = join(&root, &["a.c"]);
        let (inner, _) = fake_vcs(VcsKind::P4, &root, vec![rev(1, at(8, 0), &[("a.c", &["base"])])]);
        let runner: VcsRunner = Arc::new(move |cmd, args, cwd| {
            if args.iter().any(|a| a == "changes") && !args.last().is_some_and(|a| a.ends_with("#have")) {
                return RunResult { code: 1, stdout: String::new(), stderr: stderr.into() };
            }
            inner(cmd, args, cwd)
        });
        write(&f, &["base", "ai"]);
        let ev = session(&root, None, None, (10, 0), (11, 0), vec![ed(&f, &["ai"])]);
        let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() })[0];
        assert_eq!((r.outcome, r.reason), (Outcome::Unattributable, Some(want)), "{stderr}");
    }

    // git: ログの開始時のコミットが無ければ baseline_missing、確かめるコマンドが失敗したら読めなかった
    let (root, _) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let f = join(&root, &["a.txt"]);
    write(&f, &["base", "ai"]);
    let gone = "0123456789abcdef0123456789abcdef01234567";
    let ev = session(&root, Some(&root), Some(gone), (10, 0), (11, 0), vec![ed(&f, &["ai"])]);
    let sets = [extract_ai_changes("s1", &ev, None)];
    assert_eq!(measure(&sets, &opts())[0].reason, Some(UnattributableReason::BaselineMissing));
    let timeout: VcsRunner = Arc::new(|cmd, args, cwd| {
        if args.iter().any(|a| a == "cat-file") {
            return RunResult { code: 1, stdout: String::new(), stderr: "git が時間内に終わりませんでした".into() };
        }
        crate::vcs::default_run(cmd, args, cwd)
    });
    assert_eq!(measure(&sets, &RetentionOptions { runner: timeout, ..opts() })[0].reason, Some(UnattributableReason::ReadError));
}

#[test]
fn evaluated_without_session_repo() {
    // 作業フォルダに VCS が無く、ファイルの場所のリポジトリだけで照合したときも、比べた時点と見方を残す(セッションの版の印は付けず、repos に残す)。
    // 使ったリポジトリが 1 つだけなので、セッションの VCS と根はそれにする
    let mut tmp = Tmp::new();
    let plain = tmp.dir();
    let (root, _) = git_repo(&mut tmp, &[("a.txt", &["base"])]);
    let f = join(&root, &["a.txt"]);
    write(&f, &["base", "ai line"]);
    git(&root, &["commit", "-q", "-am", "take ai line"], &at(24, 0));
    let ev = session(&plain, None, None, (10, 0), (11, 0), vec![ed(&f, &["ai line"])]);
    let sets = [extract_ai_changes("s1", &ev, None)];
    let now = Some(ms_of(&at(24 * 20, 0)));
    let w = &measure(&sets, &RetentionOptions { now_ms: now, ..opts() })[0];
    assert_eq!((w.outcome, w.vcs, w.root.as_deref(), w.evaluated.clone()), (Outcome::Measured, Some(VcsKind::Git), Some(root.as_str()), Some(Evaluated { mode: EvalMode::Worktree, rev: None, at: at(24 * 20, 0), source: None })));
    assert_eq!((w.repos.len(), w.repos[0].vcs, w.repos[0].baseline.as_ref().map(|b| b.source), w.repos[0].evaluated.is_some()), (1, VcsKind::Git, Some(RevisionSource::Estimated), true));
    let fx = &measure(&sets, &RetentionOptions { mode: EvalMode::Fixed, lag_days: 7, now_ms: now, ..opts() })[0];
    assert_eq!((fx.outcome, fx.hunks[0].status), (Outcome::Measured, RetentionStatus::Kept));
    assert_eq!(fx.evaluated, Some(Evaluated { mode: EvalMode::Fixed, rev: None, at: at(11 + 24 * 7, 0), source: Some(RevisionSource::Estimated) }));
    assert_eq!(summarize_retention(std::slice::from_ref(fx)).evaluated_estimated, 1);
}

fn not_measured_session() -> SessionRetention {
    let mut tmp = Tmp::new();
    let gone = join(&tmp.dir(), &["gone"]);
    let ev = session(&gone, None, None, (10, 0), (11, 0), vec![ed(&join(&gone, &["x.txt"]), &["zz"])]);
    let r = measure(&[extract_ai_changes("s1", &ev, None)], &opts()).remove(0);
    assert_eq!(r.outcome, Outcome::Unattributable);
    r
}

fn svn_cmd(bin: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(bin).args(args).output().ok()?;
    assert!(out.status.success(), "{bin} {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn now_iso() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    jsdate::to_iso(ms)
}

/// 実物の svn で、ローカルのリポジトリ(file://)を作って照合する。svn が無ければ飛ばす
#[test]
fn real_svn_local_repository() {
    if Command::new("svn").arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) || Command::new("svnadmin").arg("--version").output().is_err() {
        eprintln!("svn が無いので飛ばす");
        return;
    }
    let mut tmp = Tmp::new();
    let repo = tmp.dir();
    let wc = tmp.dir();
    svn_cmd("svnadmin", &["create", &repo]).unwrap();
    let p = repo.replace('\\', "/");
    let url = if p.starts_with('/') { format!("file://{p}") } else { format!("file:///{p}") };
    // 準備の書き込みは svn を直接呼ぶ(atlas の実行経路は書く系を止める)
    let svn = |args: &[&str]| svn_cmd("svn", &[&["--non-interactive", "-q"], args].concat()).unwrap();
    svn(&["checkout", &url, &wc]);
    let f = join(&wc, &["src", "a.c"]);
    write(&f, &["int base = 0;"]);
    svn(&["add", &join(&wc, &["src"])]);
    svn(&["commit", "-m", "base", &wc]);
    // 取り込んだだけでは作業コピーの根の版は 0 のまま(版の混ざった作業コピー)なので、普段どおり更新しておく
    svn(&["update", &wc]);
    std::thread::sleep(std::time::Duration::from_millis(1100));

    let start = now_iso();
    let call = |id: &str, added: &str| {
        let t = now_iso();
        [
            ev("tool.execution_start", &t, json!({"toolCallId": id, "toolName": "edit", "arguments": {"path": f, "old_str": "", "new_str": ""}})),
            ev("tool.execution_complete", &t, json!({"toolCallId": id, "success": true, "result": {"content": "ok", "detailedContent": diff_of(&f, &[added], &[])}})),
        ]
    };
    let mut events = vec![ev("session.start", &start, json!({"context": {"cwd": wc}}))];
    events.extend(call("k", "int kept = 1;"));
    events.extend(call("m", "int computeTotal(int a, int b) { return a + b; }"));
    events.extend(call("x", "int removedLater = 3;"));
    std::thread::sleep(std::time::Duration::from_millis(50));
    events.push(ev("assistant.turn_end", &now_iso(), json!({})));
    write(&f, &["int base = 0;", "int kept = 1;", "int computeTotal(int a, int b) { return a + b + 1; }"]);
    let sets = [extract_ai_changes("s1", &events, None)];

    let r = &measure(&sets, &opts())[0];
    assert_eq!((r.outcome, r.vcs, r.reason), (Outcome::Measured, Some(VcsKind::Svn), None));
    assert_eq!(r.baseline, Some(Revision { rev: "1".into(), source: RevisionSource::Estimated }));
    assert_eq!(statuses(r), [RetentionStatus::Kept, RetentionStatus::Modified, RetentionStatus::Missing]);
    assert_eq!(r.hunks.iter().map(|h| (h.similar_lines, h.tool_call_id.as_deref(), h.from)).collect::<Vec<_>>(), [(0, Some("k"), Some(HunkFrom::Diff)), (1, Some("m"), Some(HunkFrom::Diff)), (0, Some("x"), Some(HunkFrom::Diff))]);
    assert_eq!(r.evaluated.as_ref().map(|e| (e.rev.as_deref(), e.source)), Some((Some("1"), None)));

    // 取り込んだ後の committed は、作業コピーの BASE(取り込んだ本文)と比べる
    std::thread::sleep(std::time::Duration::from_millis(1100));
    svn(&["commit", "-m", "take", &wc]);
    write(&f, &["int base = 0;"]);
    let c = &measure(&sets, &RetentionOptions { mode: EvalMode::Committed, ..opts() })[0];
    assert_eq!((c.outcome, c.reason), (Outcome::Measured, None));
    assert_eq!(statuses(c), [RetentionStatus::Kept, RetentionStatus::Modified, RetentionStatus::Missing]);
    // 作業コピーの今の本文(AI の行を消した)では未確認になる
    let w = &measure(&sets, &opts())[0];
    assert_eq!(statuses(w), [RetentionStatus::Missing; 3]);
}

fn ev_odd(kind: &str, data: Value) -> CopilotEvent {
    ev(kind, &at(10, 5), data)
}

#[test]
fn dice_on_utf16_units() {
    assert_eq!(dice("a", "a"), 1.0);
    assert_eq!(dice("abc", "abc"), 1.0);
    assert_eq!(dice("abcd", "abce"), 2.0 * 2.0 / 6.0);
    // サロゲートペアは 2 単位として数える(JS と同じ)
    assert_eq!(dice("😀", "😀"), 1.0);
}

// ---- 複数の VCS にまたがるセッション(複合 VCS のプロジェクト・入れ子の作業コピー) ----

/// 根ごとの偽の CLI を、呼ばれたフォルダ(作業ツリーを探すときはそのフォルダ、読むときは根)で振り分ける。
/// そのフォルダを含む同じ種類の根のうち、いちばん内側のものに答えさせる。どれにも入らなければ「作業コピーではない」
fn routed(fakes: Vec<(VcsKind, String, VcsRunner)>) -> VcsRunner {
    Arc::new(move |cmd, args, cwd| {
        let key = |p: &str| file_path_key(&crate::classify::resolve_file_path(p, None));
        let inside = |root: &str| key(root) == key(cwd) || crate::classify::relative_inside(root, cwd).is_some();
        let hit = fakes.iter().filter(|(k, root, _)| *k == cmd && inside(root)).max_by_key(|(_, root, _)| root.len());
        match hit {
            Some((_, _, run)) => run(cmd, args, cwd),
            None if cmd == VcsKind::Git => RunResult { code: 128, stdout: String::new(), stderr: "fatal: not a git repository".into() },
            None if cmd == VcsKind::Svn => RunResult { code: 1, stdout: String::new(), stderr: "svn: E155007: not a working copy".into() },
            None => RunResult { code: 1, stdout: String::new(), stderr: "Client unknown.".into() },
        }
    })
}

#[test]
fn mixed_vcs_without_session_repo() {
    // 作業フォルダ(VCS の管理外)の下に、Perforce のワークスペース(assets)と SVN の作業コピー(tools)がある
    let mut tmp = Tmp::new();
    let parent = tmp.dir();
    let assets = join(&parent, &["assets"]);
    let tools = join(&parent, &["tools"]);
    let fa = join(&assets, &["a.c"]);
    let fb = join(&tools, &["b.py"]);
    write(&fa, &["int base = 0;", "int p4Kept = 1;"]);
    write(&fb, &["base = 0", "svn_kept = 1"]);
    let (p4, p4_calls) = fake_vcs(VcsKind::P4, &assets, vec![rev(3, at(8, 0), &[("a.c", &["int base = 0;"])])]);
    let (svn, _) = fake_vcs(VcsKind::Svn, &tools, vec![rev(1, at(8, 0), &[("b.py", &["base = 0"])])]);
    let runner = routed(vec![(VcsKind::P4, assets.clone(), p4), (VcsKind::Svn, tools.clone(), svn)]);
    let ev = session(&parent, None, None, (10, 0), (11, 0), vec![ed_at(&fa, &["int p4Kept = 1;"], (10, 1)), ed_at(&fb, &["svn_kept = 1"], (10, 2))]);
    let rs = measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() });
    let r = &rs[0];
    assert_eq!(r.outcome, Outcome::Measured);
    // 2 つのリポジトリにまたがるので、セッションの VCS と根は決めない。基準は最初に当たったもの(今までどおり)
    assert_eq!((r.vcs, r.root.as_deref()), (None, None));
    assert_eq!(r.baseline, Some(Revision { rev: "3".into(), source: RevisionSource::Estimated }));
    assert_eq!(
        r.repos,
        [
            RepoRetention { vcs: VcsKind::P4, root: assets.clone(), baseline: Some(Revision { rev: "3".into(), source: RevisionSource::Estimated }), evaluated: Some(RepoEvaluated { rev: "3".into(), source: None }) },
            RepoRetention { vcs: VcsKind::Svn, root: tools.clone(), baseline: Some(Revision { rev: "1".into(), source: RevisionSource::Estimated }), evaluated: Some(RepoEvaluated { rev: "1".into(), source: None }) },
        ]
    );
    assert_eq!(r.hunks.iter().map(|h| (h.status, h.vcs, h.root.as_deref())).collect::<Vec<_>>(), [(RetentionStatus::Kept, Some(VcsKind::P4), Some(assets.as_str())), (RetentionStatus::Kept, Some(VcsKind::Svn), Some(tools.as_str()))]);
    // まとまりの基準は、そのまとまりのリポジトリのもの
    assert_eq!(hunk_baseline(r, &r.hunks[1]).map(|b| b.rev.as_str()), Some("1"));
    // VCS 別はセッションごとに種類を 1 回ずつ数える(合計が照合できたセッションの数を超えうる)。基準はどれかが推定なら推定
    let s = summarize_retention(&rs);
    assert_eq!((s.measured, s.baseline_estimated), (1, 1));
    assert_eq!(serde_json::to_value(&s.by_vcs).unwrap(), json!({"svn": 1, "p4": 1}));
    // 書いて読み直しても、repos とまとまりの VCS が残り、同じ形で書ける
    let text = crate::json::to_js_string(r).unwrap();
    let back: SessionRetention = serde_json::from_str(&text).unwrap();
    assert_eq!((&back.repos, back.hunks[1].vcs), (&r.repos, Some(VcsKind::Svn)));
    assert_eq!(crate::json::to_js_string(&back).unwrap(), text);
    // 表: まとまりごとの VCS と基準
    let t = crate::tables::retention_hunks_table(&[r], None);
    let col = |name: &str| t.header.iter().position(|h| h == name).unwrap();
    assert_eq!(t.rows.iter().map(|row| row[col("VCS")].clone()).collect::<Vec<_>>(), [crate::tables::Cell::from("p4"), crate::tables::Cell::from("svn")]);
    assert_eq!(t.rows[1][col("開始時の基準")], crate::tables::Cell::from("推定"));
    // 呼んだのは読む系だけ
    for (c, a) in p4_calls.lock().unwrap().iter() {
        assert!(assert_read_only(*c, a).is_ok(), "{c:?} {a:?}");
    }

    // 使ったリポジトリが 1 つだけなら、セッションの VCS と根もそれにする
    let ev = session(&parent, None, None, (10, 0), (11, 0), vec![ed(&fb, &["svn_kept = 1"])]);
    let (svn, _) = fake_vcs(VcsKind::Svn, &tools, vec![rev(1, at(8, 0), &[("b.py", &["base = 0"])])]);
    let one = &measure(&[extract_ai_changes("s2", &ev, None)], &RetentionOptions { runner: routed(vec![(VcsKind::Svn, tools.clone(), svn)]), ..opts() })[0];
    assert_eq!((one.outcome, one.vcs, one.root.as_deref(), one.repos.len()), (Outcome::Measured, Some(VcsKind::Svn), Some(tools.as_str()), 1));
}

#[test]
fn nested_svn_inside_p4_workspace() {
    // Perforce のワークスペースの根が作業フォルダで、その中の tools が SVN の作業コピー。tools のファイルは SVN で照合する
    let mut tmp = Tmp::new();
    let parent = tmp.dir();
    let tools = join(&parent, &["tools"]);
    let fa = join(&parent, &["assets", "a.c"]);
    let fb = join(&tools, &["b.py"]);
    write(&fa, &["int base = 0;", "int p4Kept = 1;"]);
    // Perforce には tools のファイルが無い(SVN の作業コピーを探さずに P4 で照合すると、基準に無いので AI の行がすべて残ったことになる)
    let (p4, p4_calls) = fake_vcs(VcsKind::P4, &parent, vec![rev(3, at(8, 0), &[("assets/a.c", &["int base = 0;"])])]);
    // SVN の基準には、AI が足した行の 1 つがもうある(取り込んだ版から始めた)ので、SVN で照合すればその行は数えない
    let (svn, _) = fake_vcs(VcsKind::Svn, &tools, vec![rev(1, at(8, 0), &[("b.py", &["base = 0", "svn_kept = 1"])])]);
    let runner = routed(vec![(VcsKind::P4, parent.clone(), p4), (VcsKind::Svn, tools.clone(), svn)]);
    let ev = session(&parent, None, None, (10, 0), (11, 0), vec![ed_at(&fa, &["int p4Kept = 1;"], (10, 1)), ed_at(&fb, &["svn_kept = 1", "svn_new = 2"], (10, 2))]);
    write(&fb, &["base = 0", "svn_kept = 1", "svn_new = 2"]);
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() })[0];
    // セッションの VCS と根は、作業フォルダのリポジトリ(Perforce)のまま
    assert_eq!((r.outcome, r.vcs, r.root.as_deref()), (Outcome::Measured, Some(VcsKind::P4), Some(parent.as_str())));
    assert_eq!(r.baseline, Some(Revision { rev: "3".into(), source: RevisionSource::Estimated }));
    assert_eq!(
        r.repos.iter().map(|x| (x.vcs, x.root.as_str(), x.baseline.as_ref().map(|b| b.rev.as_str()))).collect::<Vec<_>>(),
        [(VcsKind::P4, parent.as_str(), Some("3")), (VcsKind::Svn, tools.as_str(), Some("1"))]
    );
    // SVN の基準にあった行は数えないので、tools のまとまりは 1 行だけ
    assert_eq!(r.hunks.iter().map(|h| (h.vcs, h.status, h.lines)).collect::<Vec<_>>(), [(Some(VcsKind::P4), RetentionStatus::Kept, lc(1, 0, 0, 0)), (Some(VcsKind::Svn), RetentionStatus::Kept, lc(1, 0, 0, 0))]);
    // Perforce には tools のファイルを聞いていない
    assert!(!p4_calls.lock().unwrap().iter().any(|(_, a)| a.iter().any(|x| x.contains("b.py"))));
    let s = summarize_retention(std::slice::from_ref(r));
    assert_eq!(serde_json::to_value(&s.by_vcs).unwrap(), json!({"svn": 1, "p4": 1}));
}

#[test]
fn nested_git_inside_git() {
    // git のリポジトリの中に、別の git のリポジトリ(inner)がある。inner のファイルは inner で照合する
    let mut tmp = Tmp::new();
    let (outer, head) = git_repo(&mut tmp, &[("a.txt", &["outer base"])]);
    let inner = join(&outer, &["inner"]);
    std::fs::create_dir_all(&inner).unwrap();
    git9(&inner, &["init", "-q", "-b", "main"]);
    write(&join(&inner, &["b.txt"]), &["inner base", "inner ai line"]);
    git9(&inner, &["add", "-A"]);
    git9(&inner, &["commit", "-q", "-m", "inner base"]);
    let inner_head = git9(&inner, &["rev-parse", "HEAD"]);
    let fa = join(&outer, &["a.txt"]);
    let fb = join(&inner, &["b.txt"]);
    write(&fa, &["outer base", "outer ai line"]);
    write(&fb, &["inner base", "inner ai line", "inner new line"]);
    let ev = session(&outer, Some(&outer), Some(&head), (10, 0), (11, 0), vec![ed_at(&fa, &["outer ai line"], (10, 1)), ed_at(&fb, &["inner ai line", "inner new line"], (10, 2))]);
    // git だけ本物(一時フォルダの外で、上のフォルダのリポジトリに当たらないよう svn・p4 は無いことにする)
    let runner: VcsRunner = Arc::new(|cmd, args, cwd| if cmd == VcsKind::Git { crate::vcs::default_run(cmd, args, cwd) } else { RunResult { code: -1, ..Default::default() } });
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &RetentionOptions { runner, ..opts() })[0];
    assert_eq!((r.outcome, r.vcs, r.root.as_deref()), (Outcome::Measured, Some(VcsKind::Git), Some(outer.as_str())));
    // 外のリポジトリはログの開始時のコミット(記録)、inner は開始時刻から探した版(推定)
    assert_eq!(r.baseline, Some(Revision { rev: head.clone(), source: RevisionSource::Observed }));
    assert_eq!(
        r.repos.iter().map(|x| (x.root.as_str(), x.baseline.clone())).collect::<Vec<_>>(),
        [(outer.as_str(), Some(Revision { rev: head.clone(), source: RevisionSource::Observed })), (inner.as_str(), Some(Revision { rev: inner_head.clone(), source: RevisionSource::Estimated }))]
    );
    // inner の基準にあった行は数えない(外のリポジトリで照合すると、inner のファイルは基準に無いので 2 行とも残ったことになる)
    assert_eq!(
        r.hunks.iter().map(|h| (h.root.as_deref(), h.status, h.lines)).collect::<Vec<_>>(),
        [(Some(outer.as_str()), RetentionStatus::Kept, lc(1, 0, 0, 0)), (Some(inner.as_str()), RetentionStatus::Kept, lc(1, 0, 0, 0))]
    );
    // 同じ種類はセッションごとに 1 回。基準は inner が推定なので推定に数える(推定を混ぜて記録と言わない)
    let s = summarize_retention(std::slice::from_ref(r));
    assert_eq!((serde_json::to_value(&s.by_vcs).unwrap(), s.baseline_estimated), (json!({"git": 1}), 1));
}

#[test]
fn old_results_without_repos_read_and_write_unchanged() {
    // repos とまとまりの vcs・root の無い古い結果は、そのまま読めて、書き直しても同じ形。集計はセッションの vcs と baseline で数える
    let old = json!({
        "sessionId": "s", "outcome": "measured", "vcs": "svn", "root": "X:\\zz", "baseline": {"rev": "4", "source": "estimated"},
        "evaluated": {"mode": "worktree", "rev": "5", "at": at(12, 0)},
        "hunks": [{"id": 1, "path": "X:\\zz\\a.c", "status": "kept", "lines": {"kept": 1, "modified": 0, "missing": 0, "unattributable": 0}, "at": at(10, 1), "from": "diff"}],
        "excludedHunks": 0, "counts": {"kept": 1, "modified": 0, "missing": 0, "unattributable": 0}, "lines": {"kept": 1, "modified": 0, "missing": 0, "unattributable": 0},
        "provenance": {"aiChanges": "events", "baseline": "estimated", "context": {}}, "sessionEnd": at(11, 0), "computedOn": "local",
    });
    let text = crate::json::to_js_string(&old).unwrap();
    let r: SessionRetention = serde_json::from_str(&text).unwrap();
    assert!(r.repos.is_empty());
    assert_eq!((r.hunks[0].vcs, r.hunks[0].root.as_deref()), (None, None));
    assert_eq!(crate::json::to_js_string(&r).unwrap(), text);
    assert_eq!((vcs_kinds_of(&r), baseline_source_of(&r)), (vec![VcsKind::Svn], Some(RevisionSource::Estimated)));
    assert_eq!(hunk_baseline(&r, &r.hunks[0]).map(|b| b.rev.as_str()), Some("4"));
    let s = summarize_retention(std::slice::from_ref(&r));
    assert_eq!((serde_json::to_value(&s.by_vcs).unwrap(), s.baseline_estimated), (json!({"svn": 1}), 1));
}
