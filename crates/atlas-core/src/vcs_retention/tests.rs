//! AI の変更がその後の VCS のファイルに残っているか(packages/core/test/vcs-retention.test.ts の移植)。
//! git は一時フォルダに実際のリポジトリを作る。Perforce と SVN は偽の CLI(架空の版の履歴)で応答する。中身はすべて架空のもの

use super::*;
use crate::ai_changes::extract_ai_changes;
use crate::types::CopilotEvent;
use crate::vcs::{assert_read_only, p4_escape, vcs_env, RunResult};
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
    let bad: [(VcsKind, &[&str]); 10] = [
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
    assert_eq!(r.evaluated, Some(Evaluated { mode: EvalMode::Worktree, rev: Some(head.clone()), at: at(12, 0) }));
    assert_eq!(r.excluded_hunks, 1);
    assert_eq!(statuses(r), [RetentionStatus::Kept, RetentionStatus::Modified, RetentionStatus::Missing]);
    assert_eq!(r.counts, lc(1, 1, 1, 0));
    assert_eq!(r.lines, lc(2, 1, 1, 0));
    assert_eq!((r.provenance.ai_changes.as_str(), r.provenance.baseline), ("events", Some(RevisionSource::Observed)));
    // 書き出す形(キーの順は TS 版と同じ)
    let v = serde_json::to_value(r).unwrap();
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["sessionId", "outcome", "vcs", "root", "baseline", "evaluated", "hunks", "excludedHunks", "counts", "lines", "provenance", "sessionEnd"]);
    assert_eq!(v["hunks"][0].as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "path", "status", "lines", "at"]);
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
    let c = &measure(&sets, &RetentionOptions { mode: EvalMode::Committed, ..opts() })[0];
    assert_eq!(c.counts.missing, 1);
    assert_eq!(c.evaluated.as_ref().unwrap().mode, EvalMode::Committed);
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
                let r = if spec.ends_with("#have") {
                    last
                } else {
                    let m = regex::Regex::new(r"@(\d+)/(\d+)/(\d+):(\d+):(\d+):(\d+)$").unwrap().captures(spec).unwrap();
                    rev_at(&format!("{}-{}-{}T{}:{}:{}.000Z", &m[1], &m[2], &m[3], &m[4], &m[5], &m[6]))
                };
                return ok(r.map(|r| format!("Change {} on 2026/11/01 by zz@zz-ws 'x'\n", r.rev)).unwrap_or_default());
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
    // セッションの終わりから 3 日しか経っていなければ、照合しない
    let early = &measure(&sets, &RetentionOptions { mode: EvalMode::Fixed, lag_days: 7, now_ms: Some(ms_of(&at(24 * 3, 0))), ..opts() })[0];
    assert_eq!((early.outcome, early.reason, early.evaluated.clone()), (Outcome::Unattributable, Some(UnattributableReason::TooRecent), None));

    // ログから変更を取り出せなかった編集の数を残す
    let mut ev = session(&root, Some(&root), Some(&head), (10, 0), (11, 0), vec![]);
    ev.push(ev_odd("tool.execution_start", json!({"toolCallId": "odd", "toolName": "apply_patch", "arguments": {"unknown": 1}})));
    ev.push(ev_odd("tool.execution_complete", json!({"toolCallId": "odd", "success": true, "result": {"content": "ok"}})));
    let r = &measure(&[extract_ai_changes("s1", &ev, None)], &opts())[0];
    assert_eq!((r.outcome, r.unread_edits), (Outcome::NoAiChanges, Some(1)));
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
