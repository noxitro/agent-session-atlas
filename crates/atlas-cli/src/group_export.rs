//! グループの書き出し(packages/cli/src/group-export.ts の移植): そのグループのセッションだけを、表計算ソフトや別の分析に持ち出せる形で 1 つのフォルダにまとめる。
//!   <out>/groups/<グループ名>/turns.csv     依頼(ターン)ごとの表
//!                             sessions.csv  セッションごとの表
//!                             vcs-hunks.csv AI の変更のまとまりごとの、VCS の照合の結果(照合してあるときだけ)
//!                             atlas.sqlite  上の表と同じ中身の SQLite
//!                             metrics.json  集計(atlas metrics と同じ形)
//!                             README.md     何をいつ書き出したか・列の読み方
//!                             records/      セッション記録(.md。out/sessions/ にあるものだけ写す)
//! いつものレポート(atlas.html・metrics.json)は書き換えない。atlas group export と、atlas serve の画面の「書き出す」が使う。

use crate::paths::VCS_RETENTION_FILE;
use crate::tables::{build_tables, write_sqlite, TablePaths, SQLITE_FILE};
use anyhow::{anyhow, bail, Result};
use atlas_core::metrics::compute_metrics;
use atlas_core::types::{InstalledInventory, SessionRecord};
use atlas_report::groups::{load_groups, safe_dir_name};
use atlas_report::transcript::transcript_file_name;
use serde::Serialize;
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub struct GroupExportPaths<'a> {
    pub out: &'a Path,
    pub sessions: &'a Path,
    pub judgments: &'a Path,
    pub groups: &'a Path,
    /// 段階 2 の依頼ごとの判定(turn-judgments.json)。省略時は out/ の直下
    pub turn_judgments: Option<&'a Path>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GroupExportResult {
    pub name: String,
    pub dir: String,
    pub sessions: usize,
    pub turns: i64,
    pub records: usize,
    /// グループの id のうち、集計に無かったもの
    pub missing: usize,
}

/// sessions.json のうち、書き出しに使うところ(TS 版は JSON.parse の結果をそのまま使う。形の足りないファイルでも sessions があれば読む)
fn read_sessions(path: &Path) -> Result<(Vec<SessionRecord>, Option<InstalledInventory>)> {
    let text = std::fs::read(path).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?;
    let v = atlas_core::js::parse_json(&String::from_utf8_lossy(&text)).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?;
    let sessions: Vec<SessionRecord> = match v.get("sessions") {
        Some(s) => serde_json::from_value(s.clone()).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?,
        None => bail!("{} を読めません: sessions がありません", path.display()),
    };
    let installed = match v.get("installed") {
        Some(Value::Null) | None => None,
        Some(i) => serde_json::from_value(i.clone()).ok(),
    };
    Ok((sessions, installed))
}

pub fn export_group(p: &GroupExportPaths<'_>, name: &str, log: &dyn Fn(&str)) -> Result<GroupExportResult> {
    let loaded = load_groups(p.groups);
    let Some(g) = loaded.groups.iter().find(|x| x.name == name) else {
        let names = loaded.groups.iter().map(|x| x.name.as_str()).collect::<Vec<_>>().join(", ");
        bail!("グループ「{name}」はありません{}", if loaded.groups.is_empty() { String::new() } else { format!("(あるのは: {names})") });
    };
    if !p.sessions.exists() {
        bail!("{} がありません。先に集計してください(atlas.bat か atlas all)", p.sessions.display());
    }
    let (all, installed) = read_sessions(p.sessions)?;
    let ids: HashSet<&str> = g.ids.iter().map(String::as_str).collect();
    let sessions: Vec<&SessionRecord> = all.iter().filter(|s| ids.contains(s.id.as_str())).collect();
    // 別のグループと同じフォルダ名になるとき(「a/b」と「a_b」、大文字小文字だけ違う名前)は、名前の短いハッシュを足して分ける
    let safe = safe_dir_name(name);
    let clash = loaded.groups.iter().any(|x| x.name != name && atlas_core::js::to_lower(&safe_dir_name(&x.name)) == atlas_core::js::to_lower(&safe));
    let dir: PathBuf = p.out.join("groups").join(if clash {
        let mut h = Sha1::new();
        h.update(atlas_report::html::node_utf8(name).as_bytes());
        format!("{safe}-{}", &hex::encode(h.finalize())[..6])
    } else {
        safe
    });
    // 前回の書き出しを消してから書く(グループから外したセッションの記録を残さない)
    atlas_core::fs_retry::remove_tree(&dir)?;
    std::fs::create_dir_all(dir.join("records"))?;
    // 判定のファイルが壊れていても、判定の列を付けずに書き出す(集計の表と同じ扱い)
    let tj = p.turn_judgments.map(Path::to_path_buf).unwrap_or_else(|| p.out.join("turn-judgments.json"));
    let vr = p.out.join(VCS_RETENTION_FILE);
    let t = build_tables(&sessions, &TablePaths { judgments: p.judgments, turn_judgments: &tj, vcs_retention: Some(&vr) });
    for w in &t.warnings {
        log(&format!("group export: 注意 {w}"));
    }
    std::fs::write(dir.join("turns.csv"), &t.turns)?;
    std::fs::write(dir.join("sessions.csv"), &t.sessions)?;
    if let Some(v) = &t.vcs_hunks {
        std::fs::write(dir.join("vcs-hunks.csv"), v)?;
    }
    if let Err(e) = write_sqlite(&dir.join(SQLITE_FILE), &t.data) {
        log(&format!("group export: 注意 {SQLITE_FILE} を書けませんでした({e:#})"));
    }
    let m = compute_metrics(&sessions, installed.as_ref());
    std::fs::write(dir.join("metrics.json"), format!("{}\n", atlas_core::json::to_js_string_pretty(&m)?))?;
    let mut records = 0;
    for s in &sessions {
        let md = p.out.join("sessions").join(transcript_file_name(&s.id));
        if !md.exists() {
            continue;
        }
        std::fs::copy(&md, dir.join("records").join(transcript_file_name(&s.id)))?;
        records += 1;
    }
    let turn_count = m.turns.as_ref().map_or(0, |t| t.turns);
    let generated_at = atlas_core::jsdate::now_iso();
    let missing = g.ids.len() - sessions.len();
    let mut lines: Vec<String> = vec![
        format!("# グループ「{name}」の書き出し"),
        String::new(),
        format!("- 書き出した日時: {generated_at}"),
        format!(
            "- セッション: {} 件(グループの {} 件のうち集計にあったもの{})",
            sessions.len(),
            g.ids.len(),
            if missing > 0 { format!("。無かった {missing} 件は入っていません") } else { String::new() }
        ),
        format!("- 依頼(ターン): {turn_count} 件"),
        format!("- セッション記録: {records} 件(records/。atlas.bat か export で作った記録があるものだけ)"),
        if g.note.is_empty() { String::new() } else { format!("- グループの説明: {}", g.note) },
        String::new(),
        "## ファイル".into(),
        String::new(),
        "| ファイル | 中身 |".into(),
        "|---|---|".into(),
        "| turns.csv | 依頼ごとの表。工程・依頼の種類・詰まり(ツールの失敗・拒否・中断・エラー・再編集・文脈圧縮)・使用量。依頼ごとの LLM 判定があれば「判定:」の列(扱い・合わなかった点・普段の工程・確信度・理由) |".into(),
        "| sessions.csv | セッションごとの表。規模・使用量・摩擦・推定人手工数(判定済みのものだけ)。VCS の照合をしてあれば、AI の変更が照合した時点のファイルに残っているかの列 |".into(),
    ];
    if t.vcs_hunks.is_some() {
        lines.push("| vcs-hunks.csv | AI の変更のまとまりごとの、VCS の照合の結果(そのまま残る・直されて残る・見つからない・照合不可) |".into());
    }
    lines.extend([
        format!("| {SQLITE_FILE} | 上の表と同じ中身の SQLite(表 turns・sessions{}。列名は CSV の見出し) |", if t.vcs_hunks.is_some() { "・vcs_hunks" } else { "" }),
        "| metrics.json | 集計(atlas metrics と同じ形。turns に工程別・依頼の種類別の集計) |".into(),
        "| records/ | セッション記録(Markdown) |".into(),
        String::new(),
        "CSV は UTF-8(BOM 付き)なので、Excel でそのまま開けます。工程はその依頼で使ったツール、依頼の種類は依頼文の語からの推定です(LLM は使っていません)。".into(),
        "依頼文や記録には、パス・リポジトリ名・依頼の本文がそのまま入ります。共有する前に中身を確かめてください。".into(),
        String::new(),
    ]);
    // 空の行が続くところは 1 つにする
    let mut kept: Vec<&str> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if !(l.is_empty() && i > 0 && lines[i - 1].is_empty()) {
            kept.push(l);
        }
    }
    std::fs::write(dir.join("README.md"), kept.join("\n"))?;
    let dir_s = dir.to_string_lossy().into_owned();
    log(&format!("group export: 「{name}」 {} セッション・{turn_count} 依頼・記録 {records} 件 → {dir_s}", sessions.len()));
    Ok(GroupExportResult { name: name.to_string(), dir: dir_s, sessions: sessions.len(), turns: turn_count, records, missing })
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::normalize::{normalize_session, NormalizeInput};
    use atlas_core::types::CopilotEvent;
    use serde_json::json;
    use std::fs;

    const T0: i64 = 1_794_009_600_000; // 2026-11-06T00:00:00.000Z

    fn ev(dt: i64, kind: &str, data: Value) -> std::io::Result<CopilotEvent> {
        Ok(CopilotEvent { kind: kind.into(), data: Some(data), timestamp: Some(json!(atlas_core::jsdate::to_iso(T0 + dt))), ..Default::default() })
    }

    fn session(id: &str, requests: &[&str]) -> Value {
        let mut events = vec![ev(0, "session.start", json!({ "context": { "cwd": "X:\\p" } }))];
        for (i, q) in requests.iter().enumerate() {
            let t = 1000 * (i as i64 + 1);
            events.push(ev(t, "user.message", json!({ "content": q })));
            events.push(ev(t + 100, "tool.execution_start", json!({ "toolCallId": format!("{id}-{i}"), "toolName": "view", "arguments": { "path": "a" } })));
            events.push(ev(t + 200, "tool.execution_complete", json!({ "toolCallId": format!("{id}-{i}"), "success": true })));
        }
        let mut it = events.into_iter();
        let r = normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: None, db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap();
        serde_json::to_value(&r).unwrap()
    }

    struct Env {
        _t: tempfile::TempDir,
        out: PathBuf,
        notes: PathBuf,
    }

    fn env() -> Env {
        let t = tempfile::tempdir().unwrap();
        let out = t.path().join("out");
        let notes = t.path().join("notes");
        fs::create_dir_all(out.join("sessions")).unwrap();
        fs::create_dir_all(&notes).unwrap();
        // 形の足りない sessions.json(TS 版のテストと同じ。sessions があれば読む)
        let file = json!({ "schemaVersion": 10, "generatedAt": atlas_core::jsdate::to_iso(T0), "home": "x", "sessions": [session("s1", &["ボタンを足して", "違う、右に"]), session("s2", &["これは何？"]), session("s3", &["無関係"])], "installed": null });
        fs::write(out.join("sessions.json"), file.to_string()).unwrap();
        fs::write(out.join("sessions").join("s1.md"), "# 記録 s1").unwrap();
        fs::write(out.join("metrics.json"), "いつもの集計").unwrap();
        fs::write(notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "調査: A/B", "note": "比べる", "ids": ["s1", "s2", "gone"] }] }).to_string()).unwrap();
        Env { _t: t, out, notes }
    }

    fn run(e: &Env, name: &str, log: &dyn Fn(&str)) -> Result<GroupExportResult> {
        let (s, j, g) = (e.out.join("sessions.json"), e.out.join("judgments.json"), e.notes.join("groups.json"));
        export_group(&GroupExportPaths { out: &e.out, sessions: &s, judgments: &j, groups: &g, turn_judgments: None }, name, log)
    }

    fn names(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().map(|x| x.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn exports_only_the_group() {
        let e = env();
        let r = run(&e, "調査: A/B", &|_| {}).unwrap();
        assert_eq!((r.sessions, r.turns, r.records, r.missing), (2, 3, 1, 1));
        let dir = PathBuf::from(&r.dir);
        assert_eq!(dir, e.out.join("groups").join("調査_ A_B"));
        assert_eq!(names(&dir), vec!["README.md", "atlas.sqlite", "metrics.json", "records", "sessions.csv", "turns.csv"]);
        let turns = fs::read_to_string(dir.join("turns.csv")).unwrap();
        let lines: Vec<&str> = turns.trim_end().split("\r\n").collect();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[1..].iter().map(|l| l.split(',').next().unwrap()).collect::<Vec<_>>(), vec!["s1", "s1", "s2"]);
        let m: Value = serde_json::from_str(&fs::read_to_string(dir.join("metrics.json")).unwrap()).unwrap();
        assert_eq!(m["turns"]["byKind"]["fix"]["turns"], 1);
        assert_eq!(names(&dir.join("records")), vec!["s1.md"]);
        assert!(fs::read_to_string(dir.join("README.md")).unwrap().contains("無かった 1 件は入っていません"));
        assert_eq!(fs::read_to_string(e.out.join("metrics.json")).unwrap(), "いつもの集計");
        // 前回の書き出しは消してから書く
        fs::write(dir.join("records").join("old.md"), "x").unwrap();
        run(&e, "調査: A/B", &|_| {}).unwrap();
        assert!(!dir.join("records").join("old.md").exists());
        assert!(run(&e, "無い", &|_| {}).unwrap_err().to_string().contains("はありません"));
    }

    #[test]
    fn broken_turn_judgments_are_skipped_with_a_note() {
        let e = env();
        fs::write(e.out.join("turn-judgments.json"), "{ 壊れた").unwrap();
        let logs = std::sync::Mutex::new(Vec::<String>::new());
        let r = run(&e, "調査: A/B", &|m| logs.lock().unwrap().push(m.to_string())).unwrap();
        assert_eq!(r.sessions, 2);
        assert!(!fs::read_to_string(PathBuf::from(&r.dir).join("turns.csv")).unwrap().contains("判定:"));
        let all = logs.lock().unwrap().join("\n");
        assert!(all.contains("注意 ") && all.contains("turn-judgments.json を読めないため"), "{all}");
        assert!(all.contains("2 セッション・3 依頼・記録 1 件"));
    }

    #[test]
    fn same_folder_names_get_a_hash() {
        let e = env();
        fs::write(e.notes.join("groups.json"), json!({ "version": 1, "groups": [{ "name": "A/B", "note": "", "ids": ["s1"] }, { "name": "A_B", "note": "", "ids": ["s2"] }] }).to_string()).unwrap();
        let x = run(&e, "A/B", &|_| {}).unwrap();
        let y = run(&e, "A_B", &|_| {}).unwrap();
        assert_ne!(x.dir, y.dir);
        assert!(regex::Regex::new(r"A_B-[0-9a-f]{6}$").unwrap().is_match(&x.dir), "{}", x.dir);
        assert!(Path::new(&x.dir).join("turns.csv").exists() && Path::new(&y.dir).join("turns.csv").exists());
    }
}
