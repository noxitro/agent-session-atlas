//! 照合の段(packages/core/test/vcs-step.test.ts の移植。表の列のテストは tables の移植の側)。
//! パスの読み替え・スナップショットからの照合・アップロード先での送った側の結果の読み込み。
//! git は一時フォルダに実際のリポジトリを作る。イベントとパスはすべて架空のもの

use super::*;
use crate::ai_changes::extract_ai_changes;
use crate::types::CopilotEvent;
use crate::vcs_retention::tests::{at, git, join, Tmp};
use serde_json::json;

const B: &str = "\\";

fn git9(root: &str, args: &[&str]) -> String {
    git(root, args, &at(9, 0))
}

/// 1 セッション分の events.jsonl(開始 → 編集 1 回 → 終わり)
fn events_jsonl(cwd: &str, head_commit: Option<&str>, path: &str, added: &[&str]) -> String {
    let p = path.replace('\\', "/");
    let mut diff = vec![format!("diff --git a/{p} b/{p}"), format!("--- a/{p}"), format!("+++ b/{p}"), "@@ -1,1 +1,2 @@".into()];
    diff.extend(added.iter().map(|l| format!("+{l}")));
    diff.push(String::new());
    let mut ctx = json!({"cwd": cwd, "gitRoot": cwd});
    if let Some(h) = head_commit {
        ctx["headCommit"] = json!(h);
    }
    let ev = [
        json!({"type": "session.start", "timestamp": at(10, 0), "data": {"context": ctx}}),
        json!({"type": "tool.execution_start", "timestamp": at(10, 5), "data": {"toolCallId": "c1", "toolName": "edit", "arguments": {"path": path, "old_str": "", "new_str": added.join("\n")}}}),
        json!({"type": "tool.execution_complete", "timestamp": at(10, 5), "data": {"toolCallId": "c1", "success": true, "result": {"content": "ok", "detailedContent": diff.join("\n")}}}),
        json!({"type": "assistant.turn_end", "timestamp": at(10, 30), "data": {}}),
    ];
    ev.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n") + "\n"
}

fn write_session(snap: &str, id: &str, jsonl: &str, extra: &[(&str, String)]) {
    let dir = join(snap, &["session-state", id]);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(join(&dir, &["events.jsonl"]), jsonl).unwrap();
    for (name, body) in extra {
        std::fs::write(join(&dir, &[name]), body).unwrap();
    }
}

fn pm(from: &str, to: &str) -> PathMapping {
    PathMapping { from: from.into(), to: to.into() }
}

fn ms(iso: &str) -> Option<i64> {
    jsdate::parse_ms(iso)
}

fn step(snap: &str, o: VcsStepOptions) -> VcsRetentionFile {
    run_vcs_step(Path::new(snap), &o).unwrap()
}

#[test]
fn map_path_prefix() {
    let map = [pm(&format!("X:{B}old"), &format!("Y:{B}new")), pm(&format!("X:{B}old{B}deep"), &format!("Z:{B}deep")), pm("/home/zz/old", "/srv/new")];
    // 前方一致で読み替える。Windows のパスは大文字小文字と区切りの違いを無視し、長い from を優先する
    assert_eq!(map_path("x:/OLD/src/a.ts", &map).as_deref(), Some(format!("Y:{B}new{B}src{B}a.ts").as_str()));
    assert_eq!(map_path(&format!("X:{B}old{B}deep{B}b.ts"), &map), Some(format!("Z:{B}deep{B}b.ts")));
    assert_eq!(map_path(&format!("X:{B}old"), &map), Some(format!("Y:{B}new")));
    assert_eq!(map_path("/home/zz/old/x/y.ts", &map).as_deref(), Some("/srv/new/x/y.ts"));
    // 読み替え先を / で書いても、ログのパスと同じ形(\ 区切り)にそろえる(同じファイルの鍵が一致するように)
    let slash = [pm(&format!("X:{B}old"), "y:/new/")];
    assert_eq!(map_path(&format!("X:{B}old{B}src{B}a.ts"), &slash), Some(format!("Y:{B}new{B}src{B}a.ts")));
    assert_eq!(map_path(&format!("X:{B}old"), &slash), Some(format!("Y:{B}new")));
    assert_eq!(map_path("/home/zz/old/x/../y.ts", &[pm("/home/zz/old", "/srv/new//")]).as_deref(), Some("/srv/new/y.ts"));
    // 名前の途中で切れる一致や、当たらないものは読み替えない
    assert_eq!(map_path(&format!("X:{B}older{B}a.ts"), &map), None);
    assert_eq!(map_path("/home/zz/OLD/a.ts", &map), None); // POSIX は大文字小文字を区別する
    assert_eq!(map_path(&format!("W:{B}a.ts"), &map), None);
}

#[test]
fn apply_path_map_rewrites_context_files_hunks() {
    let map = [pm(&format!("X:{B}old"), &format!("Y:{B}new"))];
    let ev = |kind: &str, data: Value| CopilotEvent { kind: kind.into(), data: Some(data), id: None, timestamp: Some(json!(at(10, 0))), parent_id: None, agent_id: None };
    let set = extract_ai_changes(
        "s",
        &[
            ev("session.start", json!({"context": {"cwd": format!("X:{B}old"), "gitRoot": format!("X:{B}old")}})),
            ev("tool.execution_start", json!({"toolCallId": "c", "toolName": "create", "arguments": {"path": format!("X:{B}old{B}a.ts"), "file_text": "x"}})),
            ev("tool.execution_complete", json!({"toolCallId": "c", "success": true, "result": {"content": "ok"}})),
        ],
        None,
    );
    let (m, mapped) = apply_path_map(set.clone(), &map);
    assert!(mapped);
    let y = format!("Y:{B}new");
    let ya = format!("Y:{B}new{B}a.ts");
    assert_eq!((m.context.cwd.as_deref(), m.context.git_root.as_deref(), m.files[0].path.as_str(), m.hunks[0].path.as_str()), (Some(y.as_str()), Some(y.as_str()), ya.as_str(), ya.as_str()));
    assert!(!apply_path_map(set, &[]).1);
}

#[test]
fn local_step_with_path_map() {
    let mut tmp = Tmp::new();
    let repo = tmp.dir();
    git9(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(join(&repo, &["a.ts"]), "base\n").unwrap();
    git9(&repo, &["add", "-A"]);
    git9(&repo, &["commit", "-q", "-m", "base"]);
    let head = git9(&repo, &["rev-parse", "HEAD"]);
    std::fs::write(join(&repo, &["a.ts"]), "base\nconst kept = 1;\n").unwrap();
    let snap = tmp.dir();
    // ログには前の場所(今は無い)が残っている
    let old = join(&tmp.dir(), &["moved-away"]);
    write_session(&snap, "sess-a", &events_jsonl(&old, Some(&head), &join(&old, &["a.ts"]), &["const kept = 1;", "const gone = 2;"]), &[]);
    write_session(&snap, "sess-b", &(json!({"type": "session.start", "timestamp": at(8, 0), "data": {"context": {"cwd": repo}}}).to_string() + "\n"), &[]);

    let before = step(&snap, VcsStepOptions { retention: RetentionOptions { now_ms: ms(&at(12, 0)), ..Default::default() }, ..Default::default() });
    assert_eq!((before.schema_version, before.computed_on, before.mode, before.path_map, before.generated_at.clone()), (1, ComputedOn::Local, EvalMode::Worktree, 0, at(12, 0)));
    assert_eq!(
        before.sessions.iter().map(|s| (s.session_id.as_str(), s.outcome, s.reason)).collect::<Vec<_>>(),
        [("sess-a", Outcome::Unattributable, Some(UnattributableReason::RepoNotFound)), ("sess-b", Outcome::NoAiChanges, None)]
    );
    assert_eq!(before.senders, None);

    let after = step(&snap, VcsStepOptions { path_map: vec![pm(&old, &repo)], ..Default::default() });
    let a = after.sessions.iter().find(|s| s.session_id == "sess-a").unwrap();
    assert_eq!((a.outcome, a.vcs, a.path_mapped, a.computed_on), (Outcome::Measured, Some(VcsKind::Git), Some(true), Some(ComputedOn::Local)));
    assert_eq!(a.baseline, Some(Revision { rev: head, source: RevisionSource::Observed }));
    assert_eq!(a.hunks.iter().map(|h| (h.status, h.lines)).collect::<Vec<_>>(), [(RetentionStatus::Modified, LineCounts { kept: 1, modified: 0, missing: 1, unattributable: 0 })]);
    assert_eq!((after.summary.sessions, after.summary.with_ai_changes, after.summary.measured), (2, 1, 1));
    // キーの順は TS 版と同じ(reason・computedOn・pathMapped は後から足したもの)
    let v = serde_json::to_value(a).unwrap();
    assert_eq!(v.as_object().unwrap().keys().rev().take(3).collect::<Vec<_>>(), ["pathMapped", "computedOn", "sessionEnd"]);
}

#[test]
fn ids_filter() {
    let mut tmp = Tmp::new();
    let snap = tmp.dir();
    let nope = join(&tmp.dir(), &["nope"]);
    write_session(&snap, "x1", &events_jsonl(&nope, None, &join(&nope, &["a.ts"]), &["a"]), &[]);
    write_session(&snap, "x2", &events_jsonl(&nope, None, &join(&nope, &["a.ts"]), &["a"]), &[]);
    let r = step(&snap, VcsStepOptions { ids: Some(["x2".to_string()].into_iter().collect()), ..Default::default() });
    assert_eq!(r.sessions.iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>(), ["x2"]);
}

fn result_of(id: &str) -> Value {
    json!({
        "sessionId": id,
        "outcome": "measured",
        "vcs": "p4",
        "root": "//depot/zz",
        "baseline": {"rev": "41", "source": "estimated"},
        "evaluated": {"mode": "worktree", "rev": "42", "at": at(11, 0)},
        "hunks": [
            {"id": 1, "path": format!("X:{B}zz{B}a.cpp"), "status": "kept", "lines": {"kept": 3, "modified": 0, "missing": 0, "unattributable": 0}},
            {"id": 2, "path": format!("X:{B}zz{B}b.cpp"), "status": "missing", "lines": {"kept": 0, "modified": 0, "missing": 2, "unattributable": 0}},
        ],
        "excludedHunks": 0,
        // 書いてある件数は信じない(まとまりから数え直す)
        "counts": {"kept": 99, "modified": 0, "missing": 0, "unattributable": 0},
        "lines": {"kept": 99, "modified": 0, "missing": 0, "unattributable": 0},
        "provenance": {"aiChanges": "events", "baseline": "estimated", "context": {}},
    })
}

fn flat_manifest(snap: &str) {
    std::fs::write(join(snap, &[SNAPSHOT_MANIFEST]), json!({"layout": "flat"}).to_string()).unwrap();
}

#[test]
fn uploaded_reads_sender_results() {
    let mut tmp = Tmp::new();
    let snap = tmp.dir();
    flat_manifest(&snap);
    // 送り先の PC に、ログと同じパスのリポジトリがあっても読まない(sess-2 は送った側の結果が無い)
    let local = tmp.dir();
    git9(&local, &["init", "-q", "-b", "main"]);
    let meta = json!({"version": 1, "sessionId": "sess-1", "computedAt": at(11, 0), "mode": "worktree", "result": result_of("sess-1")}).to_string();
    write_session(&snap, "sess-1", &events_jsonl(&local, None, &join(&local, &["a.ts"]), &["x"]), &[(UPLOAD_VCS_META, meta)]);
    write_session(&snap, "sess-2", &events_jsonl(&local, None, &join(&local, &["a.ts"]), &["x", "y"]), &[]);
    write_session(&snap, "sess-3", &(json!({"type": "session.start", "timestamp": at(8, 0), "data": {}}).to_string() + "\n"), &[]);
    let r = step(&snap, VcsStepOptions::default());
    assert_eq!(r.computed_on, ComputedOn::Sender);
    let (s1, s2, s3) = (&r.sessions[0], &r.sessions[1], &r.sessions[2]);
    assert_eq!((s1.outcome, s1.vcs, s1.baseline.as_ref().map(|b| b.source), s1.computed_on), (Outcome::Measured, Some(VcsKind::P4), Some(RevisionSource::Estimated), Some(ComputedOn::Sender)));
    assert_eq!((s1.counts.kept, s1.counts.missing, s1.lines.kept, s1.lines.missing), (1, 1, 3, 2));
    assert_eq!((s2.outcome, s2.reason, s2.vcs, s2.counts.unattributable, s2.lines.unattributable), (Outcome::Unattributable, Some(UnattributableReason::NotMeasured), None, 1, 2));
    // どこでも照合していないので、照合した場所は付けない(「送った側の PC で照合」と読めないように)
    assert_eq!(s2.computed_on, None);
    assert_eq!(s3.outcome, Outcome::NoAiChanges);
    let s = &r.summary;
    assert_eq!((s.with_ai_changes, s.measured, s.baseline_estimated), (2, 1, 1));
    assert_eq!(serde_json::to_value(&s.unattributable).unwrap(), json!({"not_measured": 1}));
    assert_eq!(serde_json::to_value(&s.by_vcs).unwrap(), json!({"p4": 1}));
    // 送った側の結果を読み直したもののキーの順(TS 版と同じ)
    let v = serde_json::to_value(s1).unwrap();
    assert_eq!(v.as_object().unwrap().keys().skip(10).collect::<Vec<_>>(), ["provenance", "computedOn"]);
    assert_eq!(v["hunks"][1].as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "path", "status", "lines"]);
}

#[test]
fn uploaded_keeps_sender_times_and_modes() {
    let mut tmp = Tmp::new();
    let snap = tmp.dir();
    flat_manifest(&snap);
    let mut committed = result_of("c1");
    committed["evaluated"] = json!({"mode": "committed", "rev": "42", "at": at(7, 0)});
    // セッションの記録に比べる版が無いものは、添えたファイルの日時と見方を使う
    let mut bare = result_of("c2");
    bare["evaluated"] = Value::Null;
    let cwd = tmp.dir();
    let ev = events_jsonl(&cwd, None, "X:/zz/a.cpp", &["x"]);
    write_session(&snap, "c1", &ev, &[(UPLOAD_VCS_META, json!({"version": 1, "sessionId": "c1", "computedAt": at(7, 0), "mode": "committed", "result": committed}).to_string())]);
    write_session(&snap, "c2", &ev, &[(UPLOAD_VCS_META, json!({"version": 1, "sessionId": "c2", "computedAt": at(9, 0), "mode": "committed", "result": bare}).to_string())]);
    write_session(&snap, "c3", &ev, &[]);
    let r = step(&snap, VcsStepOptions { retention: RetentionOptions { now_ms: ms(&at(20, 0)), ..Default::default() }, ..Default::default() });
    assert_eq!((r.computed_on, r.generated_at.clone(), r.mode), (ComputedOn::Sender, at(20, 0), EvalMode::Committed));
    let s = r.senders.clone().unwrap().unwrap();
    assert_eq!((s.sessions, s.from.clone(), s.to.clone()), (2, Some(at(7, 0)), Some(at(9, 0))));
    assert_eq!(serde_json::to_value(&s.modes).unwrap(), json!({"committed": 2}));
    assert_eq!(r.sessions.iter().find(|x| x.session_id == "c2").unwrap().evaluated, Some(Evaluated { mode: EvalMode::Committed, rev: None, at: at(9, 0) }));
    // 送った側の結果が 1 つも無ければ senders は null、見方は指定のまま
    let none = tmp.dir();
    flat_manifest(&none);
    write_session(&none, "n1", &ev, &[]);
    let r = step(&none, VcsStepOptions::default());
    assert_eq!((r.senders.clone(), r.mode), (Some(None), EvalMode::Worktree));
    assert_eq!(serde_json::to_value(&r).unwrap()["senders"], Value::Null);
    // この PC で照合したときは senders を付けない
    let local_snap = tmp.dir();
    let gone = join(&tmp.dir(), &["gone"]);
    write_session(&local_snap, "l1", &events_jsonl(&gone, None, &join(&gone, &["a.ts"]), &["x"]), &[]);
    let r = step(&local_snap, VcsStepOptions::default());
    assert!(serde_json::to_value(&r).unwrap().get("senders").is_none());
}

#[test]
fn sender_validation() {
    let ok = json!({"version": 1, "sessionId": "s", "computedAt": at(11, 0), "mode": "worktree", "result": result_of("s")});
    let h0 = result_of("s")["hunks"][0].clone();
    let with_hunks = |hunks: Value| {
        let mut v = ok.clone();
        v["result"]["hunks"] = hunks;
        v
    };
    let patched = |k: &str, val: Value| {
        let mut h = h0.clone();
        h[k] = val;
        h
    };
    // 「そのまま残る」なのに行は未確認だけ
    assert!(parse_sender_vcs(&with_hunks(json!([patched("lines", json!({"kept": 0, "modified": 0, "missing": 5, "unattributable": 0}))])), "s").is_none());
    // 「照合不可」なのに残った行がある
    let mut h = patched("status", json!("unattributable"));
    h["reason"] = json!("no_vcs");
    assert!(parse_sender_vcs(&with_hunks(json!([h])), "s").is_none());
    // 行が 1 つも無い
    assert!(parse_sender_vcs(&with_hunks(json!([patched("lines", json!({"kept": 0, "modified": 0, "missing": 0, "unattributable": 0}))])), "s").is_none());
    assert!(parse_sender_vcs(&with_hunks(json!([h0, patched("path", json!("X:/zz/c.cpp"))])), "s").is_none());
    // 一部だけ残ったものは「直されて残る」
    let mut m = patched("status", json!("modified"));
    m["lines"] = json!({"kept": 1, "modified": 0, "missing": 1, "unattributable": 0});
    assert_eq!(parse_sender_vcs(&with_hunks(json!([m])), "s").unwrap().counts.modified, 1);

    // 形を確かめる(ほかのセッションのもの・知らない状態・制御文字を含むパスは使わない)
    assert_eq!(parse_sender_vcs(&ok, "s").unwrap().outcome, Outcome::Measured);
    assert!(parse_sender_vcs(&ok, "other").is_none());
    let mut v2 = ok.clone();
    v2["version"] = json!(2);
    assert!(parse_sender_vcs(&v2, "s").is_none());
    assert!(parse_sender_vcs(&with_hunks(json!([patched("status", json!("rejected"))])), "s").is_none());
    assert!(parse_sender_vcs(&with_hunks(json!([patched("path", json!("a\u{202e}b"))])), "s").is_none());
    assert!(parse_sender_vcs(&with_hunks(json!([patched("lines", json!({"kept": -1, "modified": 0, "missing": 0, "unattributable": 0}))])), "s").is_none());
    // 知らない VCS の名前は None にして使う
    let mut cvs = ok.clone();
    cvs["result"]["vcs"] = json!("cvs");
    assert_eq!(parse_sender_vcs(&cvs, "s").unwrap().vcs, None);
    // 照合不可の理由が無ければ read_error。キーは id, path, status, lines, reason の順
    let mut u = patched("status", json!("unattributable"));
    u["lines"] = json!({"kept": 0, "modified": 0, "missing": 0, "unattributable": 2});
    let r = parse_sender_vcs(&with_hunks(json!([u])), "s").unwrap();
    assert_eq!((r.outcome, r.reason), (Outcome::Unattributable, Some(UnattributableReason::ReadError)));
    assert_eq!(serde_json::to_value(&r.hunks[0]).unwrap().as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "path", "status", "lines", "reason"]);
}

#[test]
fn sender_json_round_trip() {
    let mut tmp = Tmp::new();
    let snap = tmp.dir();
    let repo = tmp.dir();
    git9(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(join(&repo, &["a.ts"]), "base\n").unwrap();
    git9(&repo, &["add", "-A"]);
    git9(&repo, &["commit", "-q", "-m", "base"]);
    let head = git9(&repo, &["rev-parse", "HEAD"]);
    std::fs::write(join(&repo, &["a.ts"]), "base\nnew line here\n").unwrap();
    write_session(&snap, "sx", &events_jsonl(&repo, Some(&head), &join(&repo, &["a.ts"]), &["new line here"]), &[]);
    let local = step(&snap, VcsStepOptions::default());
    let text = sender_vcs_json(&local.sessions[0], &local.generated_at, local.mode);
    assert!(text.ends_with("}\n"));
    let back = parse_sender_vcs(&js::parse_json(&text).unwrap(), "sx").unwrap();
    assert_eq!((back.outcome, back.vcs, back.computed_on), (Outcome::Measured, Some(VcsKind::Git), Some(ComputedOn::Sender)));
    assert_eq!(back.baseline, Some(Revision { rev: head, source: RevisionSource::Observed }));
    assert_eq!((back.counts, back.lines), (local.sessions[0].counts, local.sessions[0].lines));
    // まとまりを作った編集の時刻も残る(工程ごとの集計に使う)
    assert!(local.sessions[0].hunks[0].at.is_some());
    assert_eq!(back.hunks[0].at, local.sessions[0].hunks[0].at);
}

#[test]
fn read_back_keeps_key_order() {
    // 書いたファイルを読み直して書き直しても、キーの順が変わらない(後の工程が読み直して書き出すときのため)
    let ok = json!({"version": 1, "sessionId": "s", "computedAt": at(11, 0), "mode": "worktree", "result": result_of("s")});
    let sender = parse_sender_vcs(&ok, "s").unwrap();
    let text = crate::json::to_js_string(&sender).unwrap();
    let back: SessionRetention = serde_json::from_str(&text).unwrap();
    assert_eq!(crate::json::to_js_string(&back).unwrap(), text);
    assert!(back.sender_order);
    let mut local = sender.clone();
    local.sender_order = false;
    local.computed_on = Some(ComputedOn::Local);
    local.session_end = Some(None);
    local.reason = Some(UnattributableReason::NoVcs);
    let text = crate::json::to_js_string(&local).unwrap();
    let back: SessionRetention = serde_json::from_str(&text).unwrap();
    assert!(!back.sender_order);
    assert_eq!(crate::json::to_js_string(&back).unwrap(), text);
}
