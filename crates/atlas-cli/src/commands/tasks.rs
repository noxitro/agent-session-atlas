//! 管理ツールのタスクとの連携(atlas tasks sync / list / link と、集計のたびの処理)。
//! - 集計(build・export・all。画面の「集計し直す」も all)のたびに、設定の XML を読んでタスクの状態(tasks.json)を更新し、
//!   機械の紐づけ(task-links.json)を決め直す。XML を読めなければ前の状態のまま続け、注意をレポートに出す
//! - LLM の紐づけは頼んだときだけ(atlas tasks link --llm、画面の「タスクを LLM で紐づける」)。モデルの呼び方は判定と同じ
//! - 送り先から集計した(読むだけの)出力先では、XML は読まず、送った人がセッションごとに添えた記録だけを使う

use super::Log;
use crate::args::{CliOptions, JudgeCliOptions, TasksCliOptions};
use crate::config::{load_config, resolve_judge_model, CONFIG_FILE};
use crate::paths::{resolve, Paths, REPO_ROOT};
use anyhow::{bail, Result};
use atlas_core::types::{SessionRecord, SessionsFile};
use atlas_judge::task_link::{link_with_llm, LinkQuery};
use atlas_report::judgments::JudgmentsIndex;
use atlas_report::tasks::links::{apply_machine, llm_candidates, load_links, load_links_for_write, save_links, LinkSource, LinksFile, MachineSummary, SessionText, TaskLink};
use atlas_report::tasks::metrics::SessionFacts;
use atlas_report::tasks::sender::{read_sender_task, SenderTask};
use atlas_report::tasks::state::{load_tasks, sync_tasks, TasksFile};
use atlas_report::tasks::view::{local_view, sender_view, session_facts, LocalInputs, TasksView};
use atlas_report::tasks::{task_links_path, tasks_path, TaskSource, WorkHours};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// 設定の tasks(読めなければ理由)
#[derive(Debug, Clone, Default)]
pub struct TaskConfig {
    pub source: Option<TaskSource>,
    /// 設定ファイルを読めなかったとき(集計は止めず、注意に出す)
    pub error: Option<String>,
}

impl TaskConfig {
    pub fn work_hours(&self) -> WorkHours {
        self.source.as_ref().map(|s| s.work_hours.clone()).unwrap_or_default()
    }
}

/// 設定ファイルの場所(--config > 環境変数 ATLAS_CONFIG > リポジトリ直下)と、明示したか
fn config_path(config: Option<&str>) -> (String, bool) {
    let explicit = config.map(str::to_string).or_else(|| std::env::var("ATLAS_CONFIG").ok().filter(|v| !v.is_empty()));
    match &explicit {
        Some(c) => (resolve(c).to_string_lossy().into_owned(), true),
        None => (REPO_ROOT.join(CONFIG_FILE).to_string_lossy().into_owned(), false),
    }
}

/// 設定の tasks を読む。読めなくても止めない(理由を持たせる)
pub fn load_task_config(config: Option<&str>) -> TaskConfig {
    let (path, explicit) = config_path(config);
    match load_config(&path, explicit) {
        Ok(c) => TaskConfig { source: c.tasks, error: None },
        Err(e) => TaskConfig { source: None, error: Some(format!("{e:#}")) },
    }
}

/// 読むだけの画面の出力先か(送り先から集計した・別のフォルダを開いた)
pub fn is_read_only(p: &Paths, file: &SessionsFile) -> bool {
    let layout = file.source.layout.map(|l| match l {
        atlas_core::types::UploadLayout::Flat => "flat",
        atlas_core::types::UploadLayout::Merged => "merged",
    });
    crate::folders::is_read_only_view(&p.out.to_string_lossy(), layout)
}

/// 集計のたびの処理の結果
#[derive(Debug, Clone, Default)]
pub struct Refreshed {
    pub state: TasksFile,
    pub links: LinksFile,
    pub warnings: Vec<String>,
}

fn sync_line(r: &atlas_report::tasks::state::SyncSummary) -> String {
    if r.unchanged {
        return format!("前に読んだときから XML は変わっていません(タスク {} 件)", r.total);
    }
    format!("タスク {} 件(新しく見た {}・完了になった {}・開き直された {}・XML から消えた {}・また出てきた {})", r.total, r.added, r.completed, r.reopened, r.went_missing, r.returned)
}

fn machine_line(m: &MachineSummary) -> String {
    format!("機械の紐づけ {} セッション(今回決まった・変わった {}、外した {})、決まらない {}(当たり無し {}・複数に当たる {})、手動か LLM の紐づけのまま {}", m.linked, m.updated, m.removed, m.unmatched + m.ambiguous, m.unmatched, m.ambiguous, m.kept)
}

/// XML を読んで tasks.json を更新し(設定があるとき)、機械の紐づけを決め直す。失敗しても止めず、前の状態と注意を返す
pub fn refresh_tasks(p: &Paths, cfg: &TaskConfig, sessions: &[SessionRecord], cmd: &str, log: Log<'_>) -> Refreshed {
    let mut warnings: Vec<String> = cfg.error.iter().cloned().collect();
    let state_path = tasks_path(&p.notes);
    let links_path = task_links_path(&p.notes);
    let state = match &cfg.source {
        Some(src) => match sync_tasks(src, &state_path) {
            Ok(r) => {
                log(&format!("{cmd}: 管理ツールのタスク {}", sync_line(&r.summary)));
                for n in &r.notes {
                    log(&format!("{cmd}: 注意 タスクの XML: {n}"));
                    warnings.push(format!("タスクの XML: {n}"));
                }
                r.state
            }
            Err(e) => {
                log(&format!("{cmd}: 注意 {e}。前に読んだタスクの状態のまま続けます"));
                warnings.push(format!("{e}。前に読んだタスクの状態を使っています"));
                let l = load_tasks(&state_path);
                warnings.extend(l.warnings);
                l.file
            }
        },
        None => {
            let l = load_tasks(&state_path);
            warnings.extend(l.warnings);
            l.file
        }
    };
    // 機械の紐づけは、設定があってタスクを覚えているときだけ決め直す(設定を外しても、前の紐づけは消さない)
    let links = if cfg.source.is_some() && !state.tasks.is_empty() {
        match load_links_for_write(&links_path) {
            Ok(mut links) => {
                let texts: Vec<SessionText> = sessions.iter().map(SessionText::of).collect();
                let m = apply_machine(&mut links, &texts, &state, &atlas_core::jsdate::now_iso());
                log(&format!("{cmd}: {}", machine_line(&m)));
                if m.changed()
                    && let Err(e) = save_links(&links_path, &links)
                {
                    log(&format!("{cmd}: 注意 紐づけを書けませんでした({e:#})"));
                    warnings.push(format!("紐づけを書けませんでした({e:#})"));
                }
                links
            }
            Err(e) => {
                log(&format!("{cmd}: 注意 {e:#}"));
                warnings.push(format!("{e:#}"));
                LinksFile::default()
            }
        }
    } else {
        let l = load_links(&links_path);
        warnings.extend(l.warnings);
        l.file
    };
    Refreshed { state, links, warnings }
}

/// 送り先のセッションのフォルダ(スナップショットに写したもの)から、送った人のタスクの記録を読む
pub fn sender_tasks_of(p: &Paths, sessions: &[SessionRecord]) -> Vec<(String, SenderTask)> {
    let dir = p.snapshot.join("session-state");
    sessions.iter().filter_map(|s| read_sender_task(&dir.join(&s.id).join(atlas_core::snapshot::UPLOAD_SESSION_META), &s.id).map(|t| (s.id.clone(), t))).collect()
}

/// セッション id → (推定人手工数, 確信度)
pub fn human_of(j: Option<&JudgmentsIndex>) -> HashMap<String, (f64, Option<f64>)> {
    j.map(|j| j.by_session.iter().filter_map(|(id, s)| s.hours.map(|h| (id.clone(), (h, s.confidence)))).collect()).unwrap_or_default()
}

/// レポートの節。read_only なら送った人の記録から、それ以外はこの PC の記録から
pub fn build_view(p: &Paths, cfg: &TaskConfig, read_only: bool, all: &[SessionRecord], shown: &[&SessionRecord], refreshed: Option<&Refreshed>, human: &HashMap<String, (f64, Option<f64>)>) -> Option<TasksView> {
    let ids: Vec<&str> = shown.iter().map(|s| s.id.as_str()).collect();
    let facts: HashMap<String, SessionFacts> = session_facts(shown, human);
    if read_only {
        let per = sender_tasks_of(p, all);
        return sender_view(&per, &ids, &facts, &cfg.work_hours(), cfg.source.is_some());
    }
    let owned;
    let r = match refreshed {
        Some(r) => r,
        None => {
            let st = load_tasks(&tasks_path(&p.notes));
            let li = load_links(&task_links_path(&p.notes));
            owned = Refreshed { state: st.file, links: li.file, warnings: st.warnings.into_iter().chain(li.warnings).chain(cfg.error.clone()).collect() };
            &owned
        }
    };
    local_view(LocalInputs { configured: cfg.source.is_some(), state: &r.state, links: &r.links, shown: &ids, facts: &facts, work_hours: &cfg.work_hours(), warnings: r.warnings.clone() })
}

/// --task: そのタスクに紐づいたセッション。知らないタスクなら止める(黙って 0 件にしない)
pub fn sessions_of_task(p: &Paths, file: &SessionsFile, task: &str) -> Result<HashSet<String>> {
    if is_read_only(p, file) {
        let per = sender_tasks_of(p, &file.sessions);
        if !per.iter().any(|(_, t)| t.id == task) {
            bail!("タスク「{task}」に紐づいたセッションは、送った人の記録にありません");
        }
        return Ok(per.into_iter().filter(|(_, t)| t.id == task).map(|(s, _)| s).collect());
    }
    let state = load_tasks(&tasks_path(&p.notes)).file;
    let links = load_links(&task_links_path(&p.notes)).file;
    let ids: HashSet<String> = links.links.iter().filter(|(_, l)| l.task_id.as_deref() == Some(task)).map(|(s, _)| s.clone()).collect();
    if ids.is_empty() && !state.tasks.contains_key(task) {
        bail!("タスク「{task}」は {} にありません(atlas tasks list で ID を確かめられます)", tasks_path(&p.notes).display());
    }
    Ok(ids)
}

// ---------- atlas tasks ----------

fn read_sessions(p: &Paths) -> Result<Option<SessionsFile>> {
    if !p.sessions.exists() {
        return Ok(None);
    }
    let text = std::fs::read(&p.sessions)?;
    Ok(Some(atlas_core::js::parse_json_as(&String::from_utf8_lossy(&text)).map_err(|e| anyhow::anyhow!("{} を読めません: {e}", p.sessions.display()))?))
}

fn require_source(cfg: &TaskConfig) -> Result<&TaskSource> {
    if let Some(e) = &cfg.error {
        bail!("{e}");
    }
    cfg.source.as_ref().ok_or_else(|| anyhow::anyhow!("設定ファイル(atlas.config.json)に tasks がありません。管理ツールが書き出した XML を \"tasks\": {{ \"file\": \"…\" }} で指定してください(docs/outputs.md)"))
}

/// atlas tasks sync / list / link。戻り値は、レポートを作り直したほうがよいか(紐づけが変わった)
pub fn run_tasks(o: &CliOptions, p: &Paths, t: &TasksCliOptions, log: Log<'_>) -> Result<bool> {
    let cfg = load_task_config(o.config.as_deref());
    match t.action.as_str() {
        "sync" => {
            let src = require_source(&cfg)?;
            let r = sync_tasks(src, &tasks_path(&p.notes)).map_err(anyhow::Error::msg)?;
            log(&format!("tasks sync: {} → {}", sync_line(&r.summary), tasks_path(&p.notes).display()));
            for n in &r.notes {
                log(&format!("tasks sync: 注意 {n}"));
            }
            let Some(file) = read_sessions(p)? else {
                log("tasks sync: sessions.json がまだ無いので、紐づけは集計(atlas all)のときに決めます");
                return Ok(false);
            };
            let mut links = load_links_for_write(&task_links_path(&p.notes))?;
            let texts: Vec<SessionText> = file.sessions.iter().map(SessionText::of).collect();
            let m = apply_machine(&mut links, &texts, &r.state, &atlas_core::jsdate::now_iso());
            if m.changed() {
                save_links(&task_links_path(&p.notes), &links)?;
            }
            log(&format!("tasks sync: {}。レポートに出すには atlas export(画面の「集計し直す」)を実行してください", machine_line(&m)));
            Ok(false)
        }
        "list" => {
            let st = load_tasks(&tasks_path(&p.notes));
            for w in &st.warnings {
                log(&format!("tasks list: 注意 {w}"));
            }
            let links = load_links(&task_links_path(&p.notes)).file;
            let mut count: HashMap<&str, usize> = HashMap::new();
            for l in links.links.values() {
                if let Some(t) = l.task_id.as_deref() {
                    *count.entry(t).or_default() += 1;
                }
            }
            if st.file.tasks.is_empty() {
                log(&format!("tasks list: タスクはまだありません({})。atlas tasks sync で管理ツールの XML を読みます", tasks_path(&p.notes).display()));
                return Ok(false);
            }
            log("ID\t状態\t完了\t完了を確認した時刻\tセッション\t名前");
            for (id, s) in &st.file.tasks {
                log(&format!(
                    "{id}\t{}\t{}\t{}\t{}\t{}{}",
                    if s.status.is_empty() { "-" } else { &s.status },
                    if s.done { "完了" } else { "-" },
                    s.done_at.as_deref().map(|d| atlas_report::format::date_time(Some(d), "-")).unwrap_or_else(|| "-".into()),
                    count.get(id.as_str()).copied().unwrap_or(0),
                    s.name,
                    if s.missing { "(XML に無い)" } else { "" }
                ));
            }
            Ok(false)
        }
        _ => run_link(o, p, t, log),
    }
}

fn run_link(o: &CliOptions, p: &Paths, t: &TasksCliOptions, log: Log<'_>) -> Result<bool> {
    let Some(file) = read_sessions(p)? else { bail!("{} がありません。先に atlas all を実行してください", p.sessions.display()) };
    let state = load_tasks(&tasks_path(&p.notes));
    if let Some(w) = state.warnings.first() {
        bail!("{w}");
    }
    let state = state.file;
    if state.tasks.is_empty() {
        bail!("タスクがまだありません({})。先に atlas tasks sync で管理ツールの XML を読んでください", tasks_path(&p.notes).display());
    }
    let links_path = task_links_path(&p.notes);
    let mut links = load_links_for_write(&links_path)?;
    let texts: Vec<SessionText> = file.sessions.iter().map(SessionText::of).collect();
    let m = apply_machine(&mut links, &texts, &state, &atlas_core::jsdate::now_iso());
    let mut changed = m.changed();
    if changed {
        save_links(&links_path, &links)?;
    }
    log(&format!("tasks link: {}", machine_line(&m)));
    if !t.llm {
        return Ok(changed);
    }
    // 対象: --session があればそのセッション(手動の紐づけは変えない)、無ければ紐づけの無いセッション(依頼の記録があるもの)
    let targets: Vec<&SessionText> = match o.sessions.as_ref().filter(|s| !s.is_empty()) {
        Some(prefixes) => {
            let known: Vec<&str> = texts.iter().map(|s| s.id.as_str()).collect();
            let ids = atlas_report::ids::resolve_id_prefixes(&known, prefixes)?;
            let mut v = Vec::new();
            for id in &ids {
                if links.links.get(id).is_some_and(|l| l.source == LinkSource::Manual) {
                    log(&format!("tasks link: {id} は手動で紐づけてあるので、LLM には聞きません(画面で「自動に戻す」と聞けます)"));
                    continue;
                }
                v.extend(texts.iter().filter(|s| &s.id == id));
            }
            v
        }
        None => {
            // 開いただけのセッション(依頼 0・ツール 0・応答 0)と、題名も依頼の文も無いセッションは聞かない
            let empty: HashSet<&str> = file.sessions.iter().filter(|s| atlas_core::metrics::is_empty_session(s)).map(|s| s.id.as_str()).collect();
            texts.iter().filter(|s| !links.links.contains_key(&s.id) && !empty.contains(s.id.as_str()) && !(s.title.trim().is_empty() && s.prompts.trim().is_empty())).collect()
        }
    };
    if targets.is_empty() {
        log("tasks link: LLM に聞くセッションはありません");
        return Ok(changed);
    }
    let model = resolve_judge_model(None, "tasks link", log)?;
    let j = JudgeCliOptions {
        action: "run".into(),
        file: None,
        backend: "copilot-cli".into(),
        model: None,
        limit: None,
        only: None,
        concurrency: 1,
        force: false,
        allow_tools: true,
        timeout_sec: t.timeout_sec,
        ignored_filters: vec![],
    };
    let backend = super::judge::make_backend(&j, model)?;
    log(&format!("tasks link: LLM で紐づけます {} セッション(バックエンド {}{})", targets.len(), backend.name(), backend.model().map(|m| format!("({m})")).unwrap_or_default()));
    let mut failed: Vec<String> = Vec::new();
    for (i, s) in targets.iter().enumerate() {
        let q = LinkQuery {
            session_id: s.id.clone(),
            title: s.title.clone(),
            prompts: s.prompts.split('\n').filter(|x| !x.trim().is_empty()).map(str::to_string).collect(),
            candidates: llm_candidates(&state, s.start_ms),
        };
        match link_with_llm(backend.as_ref(), &q) {
            Ok(a) => {
                log(&format!(
                    "tasks link: [{}/{}] {} → {}(確信度 {})",
                    i + 1,
                    targets.len(),
                    s.id,
                    a.task_id.as_deref().unwrap_or("どのタスクでもない"),
                    atlas_core::js::num_to_string(a.confidence)
                ));
                links.links.insert(s.id.clone(), TaskLink { task_id: a.task_id, source: LinkSource::Llm, reason: a.reason, confidence: Some(a.confidence), at: atlas_core::jsdate::now_iso() });
                // 1 件ずつ書く(途中で止めても、決まった分は残す)
                save_links(&links_path, &links)?;
                changed = true;
            }
            Err(e) => {
                log(&format!("tasks link: [{}/{}] {} 失敗: {e:#}", i + 1, targets.len(), s.id));
                failed.push(s.id.clone());
            }
        }
    }
    if !failed.is_empty() {
        log(&format!("tasks link: LLM で紐づけられなかったセッション {} 件(もう一度実行すると聞き直します)", failed.len()));
    }
    if failed.len() == targets.len() {
        bail!("LLM で 1 件も紐づけられませんでした");
    }
    Ok(changed)
}

/// atlas tasks の後に、紐づけが変わっていればレポートを作り直す(判定の通しと同じく export で)
pub fn run_tasks_command(o: &CliOptions, p: &Paths, log: Log<'_>) -> Result<super::RunResult> {
    let t = o.tasks_cmd.as_ref().ok_or_else(|| anyhow::anyhow!("tasks の操作がありません"))?;
    let changed = run_tasks(o, p, t, log)?;
    if t.action == "link" && changed && p.sessions.exists() {
        let export = CliOptions { command: "export".into(), sessions: None, task: None, tasks_cmd: None, ..o.clone() };
        return super::run_command(&export, p, log);
    }
    Ok(super::RunResult::default())
}

/// 送るときの、セッション id → タスクの記録(notes にある tasks.json と task-links.json から。無ければ空)。
/// starts はセッション id → 開始(紐づけがあるときだけ呼ぶ)
pub fn sender_records(notes: &Path, starts: &dyn Fn() -> HashMap<String, String>) -> HashMap<String, SenderTask> {
    let links = load_links(&task_links_path(notes)).file;
    if !links.links.values().any(|l| l.task_id.is_some()) {
        return HashMap::new();
    }
    let state = load_tasks(&tasks_path(notes)).file;
    atlas_report::tasks::sender::sender_tasks(&state, &links, &starts())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::{resolve_paths, PathInputs};
    use atlas_core::normalize::{normalize_session, NormalizeInput};
    use atlas_core::types::WorkspaceInfo;
    use std::sync::Mutex;

    fn rec(id: &str, at: &str, prompt: &str) -> SessionRecord {
        use atlas_core::types::CopilotEvent;
        let ws = WorkspaceInfo { created_at: Some(at.into()), updated_at: Some(at.into()), ..Default::default() };
        let ev = CopilotEvent { kind: "user.message".into(), data: Some(serde_json::json!({ "content": prompt })), timestamp: Some(serde_json::json!(at)), ..Default::default() };
        let mut it = vec![Ok(ev)].into_iter();
        normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: Some(&ws), db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
    }

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/tasks").join(name)).unwrap()
    }

    fn paths(d: &Path) -> Paths {
        let s = |n: &str| d.join(n).to_string_lossy().into_owned();
        resolve_paths(PathInputs { home: Some(&s("home")), out: Some(&s("out")), judgments: None, bundle: None, notes_dir: Some(&s("notes")) })
    }

    /// 集計のたび: XML を読んで状態を更新し、機械の紐づけを決め直す。XML を読めなければ前の状態のまま、注意を出す。表とレポートの節も作る
    #[test]
    fn refresh_view_and_tables() {
        let d = tempfile::tempdir().unwrap();
        let p = paths(d.path());
        let xml = d.path().join("export.xml");
        std::fs::write(&xml, fixture("export-before.xml")).unwrap();
        let cfg = TaskConfig { source: Some(TaskSource::with_file(&xml)), error: None };
        let sessions = vec![rec("s1", "2026-11-20T01:00:00.000Z", "fix the app"), rec("s2", "2026-11-20T02:00:00.000Z", "雑談だけ"), rec("s3", "2026-11-20T03:00:00.000Z", "DEMO-103 と DEMO-105 のどちらか")];
        let logs = Mutex::new(Vec::<String>::new());
        let log = |m: &str| logs.lock().unwrap().push(m.to_string());
        let r = refresh_tasks(&p, &cfg, &sessions, "build", &log);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        assert_eq!(r.state.tasks.len(), 6);
        assert_eq!(r.links.links["s1"].task_id.as_deref(), Some("DEMO-101"));
        assert!(!r.links.links.contains_key("s2"));
        assert!(logs.lock().unwrap().iter().any(|l| l.starts_with("build: 管理ツールのタスク タスク 6 件")));
        assert!(task_links_path(&p.notes).exists());

        // 完了した書き出し → s1 のタスクは完了。s3 は 2 つに当たる(DEMO-105 が増えた)ので決めない
        std::fs::write(&xml, fixture("export-after.xml")).unwrap();
        let later = atlas_core::jsdate::now_ms() + 60_000;
        atlas_core::jsfs::utimes(&xml, later, later).unwrap();
        let r = refresh_tasks(&p, &cfg, &sessions, "build", &log);
        assert!(r.state.tasks["DEMO-101"].done);
        assert!(!r.links.links.contains_key("s3"), "{:?}", r.links);

        let refs: Vec<&SessionRecord> = sessions.iter().collect();
        let human: HashMap<String, (f64, Option<f64>)> = HashMap::from([("s1".to_string(), (6.0, Some(0.8)))]);
        let view = build_view(&p, &cfg, false, &sessions, &refs, Some(&r), &human).unwrap();
        let t101 = view.items.iter().find(|t| t.id == "DEMO-101").unwrap();
        assert_eq!((t101.sessions, t101.human_hours, t101.comparable), (1, 6.0, true));
        assert_eq!(view.summary.included, 1);

        // 表: tasks.csv と、sessions.csv のタスクの列
        super::super::metrics::write_tables(&p, &refs, Some(&view), "build", &log).unwrap();
        let tables = p.out.join("tables");
        let csv = std::fs::read_to_string(tables.join("tasks.csv")).unwrap();
        let lines: Vec<&str> = csv.trim_end().split("\r\n").collect();
        assert!(lines[0].starts_with("\u{feff}taskId,taskName,status,完了,XML に無い,開始,完了を確認した時刻,稼働時間帯の工数(時間),AI の実働(時間),推定人手工数(時間),セッション数"), "{}", lines[0]);
        assert_eq!(lines.len(), 1 + view.items.len());
        let row: Vec<&str> = lines.iter().find(|l| l.starts_with("DEMO-101,")).unwrap().split(',').collect();
        assert_eq!((row[3], row[9], row[10], row[14]), ("1", "6", "1", "1"));
        let sess = std::fs::read_to_string(tables.join("sessions.csv")).unwrap();
        let header: Vec<&str> = sess.lines().next().unwrap().trim_start_matches('\u{feff}').split(',').collect();
        let at = header.iter().position(|h| *h == "推定人手工数(時間)").unwrap();
        assert_eq!(&header[at + 1..at + 4], ["taskId", "taskName", "紐づけの出所"]);
        let s1: Vec<&str> = sess.lines().find(|l| l.starts_with("s1,")).unwrap().split(',').collect();
        assert_eq!(&s1[at + 1..at + 4], ["DEMO-101", "fix the app", "機械"]);
        let s2: Vec<&str> = sess.lines().find(|l| l.starts_with("s2,")).unwrap().split(',').collect();
        assert_eq!(&s2[at + 1..at + 4], ["", "", ""]);
        let db = rusqlite::Connection::open(tables.join(crate::tables::SQLITE_FILE)).unwrap();
        let n: i64 = db.query_row(r#"SELECT count(*) FROM tasks WHERE "taskId" = 'DEMO-101' AND "セッション数" = 1"#, [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        drop(db);
        // タスクの節が無ければ、前の tasks.csv を残さない(sessions.csv の列は空で残る)
        super::super::metrics::write_tables(&p, &refs, None, "build", &log).unwrap();
        assert!(!tables.join("tasks.csv").exists());

        // XML を読めなくなっても、前の状態のまま続け、注意を出す
        std::fs::write(&xml, "<Export><Task").unwrap();
        let later = later + 60_000;
        atlas_core::jsfs::utimes(&xml, later, later).unwrap();
        let r = refresh_tasks(&p, &cfg, &sessions, "build", &log);
        assert_eq!(r.state.tasks.len(), 7);
        assert!(r.warnings[0].contains("XML として読めません"), "{:?}", r.warnings);
        assert_eq!(r.links.links["s1"].task_id.as_deref(), Some("DEMO-101"));
        let view = build_view(&p, &cfg, false, &sessions, &refs, Some(&r), &human).unwrap();
        assert!(view.warnings[0].contains("前に読んだタスクの状態"));
    }

    /// --task: そのタスクに紐づいたセッション。知らないタスクは止める
    #[test]
    fn task_filter_ids() {
        let d = tempfile::tempdir().unwrap();
        let p = paths(d.path());
        let xml = d.path().join("export.xml");
        std::fs::write(&xml, fixture("export-before.xml")).unwrap();
        let cfg = TaskConfig { source: Some(TaskSource::with_file(&xml)), error: None };
        let sessions = vec![rec("s1", "2026-11-20T01:00:00.000Z", "fix the app")];
        refresh_tasks(&p, &cfg, &sessions, "build", &|_| {});
        let file: SessionsFile = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "generatedAt": "2026-11-23T00:00:00.000Z", "source": { "root": null, "snapshotDir": "x", "since": null },
            "counts": { "sessions": 0, "dbOnly": 0, "dirOnly": 0, "both": 0, "empty": 0 }, "installed": null,
            "warnings": { "unknownEventTypes": {}, "badLines": 0, "messages": [] }, "sessions": []
        }))
        .unwrap();
        assert_eq!(sessions_of_task(&p, &file, "DEMO-101").unwrap(), HashSet::from(["s1".to_string()]));
        assert!(sessions_of_task(&p, &file, "DEMO-103").unwrap().is_empty());
        assert!(sessions_of_task(&p, &file, "NOPE").unwrap_err().to_string().contains("タスク「NOPE」"));
    }
}
