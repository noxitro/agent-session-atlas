//! 管理ツールのタスクとの連携(atlas tasks sync / list / link / bundle / import / m365 と、集計のたびの処理)。
//! - 集計(build・export・all。画面の「集計し直す」も all)のたびに、設定の XML を読んでタスクの状態(tasks.json)を更新し、
//!   機械の紐づけ(task-links.json)を決め直す。XML を読めなければ前の状態のまま続け、注意をレポートに出す
//! - LLM の紐づけは頼んだときだけで、このツールは LLM を呼ばない。紐づけの無いセッションを束(tasks bundle。<out>/task-bundle/)にして、
//!   工数の判定と同じく外部の LLM に渡し(チャットに貼る・ZIP をエージェントに渡す・M365 Copilot の自動操作)、返答を取り込む(tasks import)
//! - 送り先から集計した(読むだけの)出力先では、XML は読まず、送った人がセッションごとに添えた記録だけを使う。
//!   ただし設定のフォルダ(settings_dir.rs)の設定に tasks があれば、集計する人がこの PC と同じ決まりで紐づける
//!   (タスクの状態と紐づけは設定のフォルダに置き、送った人の記録は使わない。Paths::central_tasks)

use super::Log;
use crate::args::{CliOptions, TasksCliOptions};
use crate::config::{load_config, CONFIG_FILE};
use crate::paths::{resolve, Paths, REPO_ROOT};
use anyhow::{bail, Result};
use atlas_core::types::{SessionRecord, SessionsFile};
use atlas_judge::task_link::{build_task_bundle, parse_task_reply, read_task_bundle_manifest, task_zip_names, LinkQuery, TaskBundleManifest, TaskBundleOptions, PROMPTS_MAX};
use atlas_report::judgments::JudgmentsIndex;
use atlas_report::tasks::links::{apply_machine, has_text, llm_candidates, llm_eligible, CandidateQuery, load_links, update_links, LinkSource, LinksFile, MachineMatch, MachineSummary, Matcher, SessionText, TaskLink};
use atlas_report::tasks::metrics::SessionFacts;
use atlas_report::tasks::sender::{read_sender_tasks, SenderTask};
use atlas_report::tasks::state::{load_tasks, sync_tasks, TasksFile};
use atlas_report::tasks::view::{local_view, sender_view, session_facts, LocalInputs, TasksView};
use atlas_report::tasks::{task_links_path, tasks_path, TaskSource, WorkHours};
use indexmap::IndexMap;
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

/// 読むだけの画面の出力先か(送り先から集計した・別のフォルダを開いた)。メモの扱いはこれで決める
pub fn is_read_only(p: &Paths, file: &SessionsFile) -> bool {
    let layout = file.source.layout.map(|l| match l {
        atlas_core::types::UploadLayout::Flat => "flat",
        atlas_core::types::UploadLayout::Merged => "merged",
    });
    crate::folders::is_read_only_view(&p.out.to_string_lossy(), layout)
}

/// タスクの紐づけを読むだけにするか: 読むだけの画面で、設定のフォルダにタスクを置いていないとき(送った人の記録を使う)。
/// 設定のフォルダにタスクを置いていれば、読むだけの画面でも、集計する人が紐づける
pub fn tasks_read_only(p: &Paths, file: &SessionsFile) -> bool {
    !p.central_tasks && is_read_only(p, file)
}

/// 集計のたびの処理の結果
#[derive(Debug, Clone, Default)]
pub struct Refreshed {
    pub state: TasksFile,
    pub links: LinksFile,
    pub warnings: Vec<String>,
}

fn sync_line(r: &atlas_report::tasks::state::SyncSummary) -> String {
    if r.older {
        return "前に読んだものより古い XML なので、タスクの状態は変えていません".to_string();
    }
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
    let state_path = tasks_path(&p.tasks_dir);
    let links_path = task_links_path(&p.tasks_dir);
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
    // 機械の紐づけは、設定があってタスクを覚えているときだけ決め直す(設定を外しても、前の紐づけは消さない)。
    // 画面や LLM で紐づけるジョブが同時に書くことがあるので、ロックの中で読み直してから機械の分だけを直す
    let links = if cfg.source.is_some() && !state.tasks.is_empty() {
        let texts: Vec<SessionText> = sessions.iter().map(SessionText::of).collect();
        let now = atlas_core::jsdate::now_iso();
        match update_links(&links_path, |links| apply_machine(links, &texts, &state, &now)) {
            Ok((m, links)) => {
                log(&format!("{cmd}: {}", machine_line(&m)));
                links
            }
            Err(e) => {
                log(&format!("{cmd}: 注意 紐づけを決め直せませんでした({e:#})"));
                warnings.push(format!("紐づけを決め直せませんでした({e:#})"));
                let l = load_links(&links_path);
                warnings.extend(l.warnings);
                l.file
            }
        }
    } else {
        let l = load_links(&links_path);
        warnings.extend(l.warnings);
        l.file
    };
    Refreshed { state, links, warnings }
}

/// all の、metrics の前のタスクの処理(sessions.json を読み、タスクを読むだけの出力先でなければ refresh_tasks)。読むだけなら None
pub fn refresh_for_aggregation(p: &Paths, config: Option<&str>, cmd: &str, log: Log<'_>) -> Result<Option<Refreshed>> {
    let file = super::metrics::read_sessions_file(p, "先に atlas extract を実行してください。")?;
    if tasks_read_only(p, &file) {
        return Ok(None);
    }
    Ok(Some(refresh_tasks(p, &load_task_config(config), &file.sessions, cmd, log)))
}

/// 送り先のセッションのフォルダ(スナップショットに写したもの)から、送った人のタスクの記録を読む
pub fn sender_tasks_of(p: &Paths, sessions: &[SessionRecord]) -> Vec<(String, Vec<SenderTask>)> {
    let dir = p.snapshot.join("session-state");
    sessions.iter().map(|s| (s.id.clone(), read_sender_tasks(&dir.join(&s.id).join(atlas_core::snapshot::UPLOAD_SESSION_META), &s.id))).filter(|(_, ts)| !ts.is_empty()).collect()
}

/// セッション id → (推定人手工数, 確信度)。レポート(build)と GET /api/tasks と表が同じ読み方をする(judgments::parse_judgments。
/// 形の崩れた項目を飛ばし、確信度の無い推定は低いとみなさない)
pub fn human_of(j: Option<&JudgmentsIndex>) -> HashMap<String, (f64, Option<f64>)> {
    j.map(|j| j.by_session.iter().filter_map(|(id, s)| s.hours.map(|h| (id.clone(), (h, s.confidence)))).collect()).unwrap_or_default()
}

/// judgments.json を human_of と同じ読み方で読む(無い・読めなければ空)
pub fn judgment_hours(path: &Path) -> HashMap<String, (f64, Option<f64>)> {
    let Ok(bytes) = std::fs::read(path) else { return HashMap::new() };
    let Ok(v) = atlas_core::js::parse_json(&String::from_utf8_lossy(&bytes)) else { return HashMap::new() };
    human_of(atlas_report::judgments::parse_judgments(&v).ok().as_ref())
}

/// タスクの節を作る(レポートの埋め込みと GET /api/tasks が同じものを使う)
pub struct ViewInputs<'a> {
    /// tasks.json と task-links.json の場所(Paths::tasks_dir)と、スナップショット(送った人の記録)
    pub notes: &'a Path,
    pub snapshot: &'a Path,
    pub cfg: &'a TaskConfig,
    /// タスクを読むだけにする(送った人の記録から作る。tasks_read_only)
    pub read_only: bool,
    /// 送った人の記録を読むセッション(読むだけの画面。集計のすべて)
    pub all: &'a [&'a str],
    /// 節に出すセッション
    pub shown: &'a [&'a str],
    pub facts: &'a HashMap<String, SessionFacts>,
    /// 集計のたびの処理の結果(無ければファイルから読む)
    pub refreshed: Option<&'a Refreshed>,
    /// 絞り込んだセッションだけで作った(画面は、API の値で置き換えない)
    pub scoped: bool,
}

pub fn tasks_view(i: ViewInputs<'_>) -> Option<TasksView> {
    let mut v = if i.read_only {
        let dir = i.snapshot.join("session-state");
        let per: Vec<(String, Vec<SenderTask>)> =
            i.all.iter().map(|id| (id.to_string(), read_sender_tasks(&dir.join(id).join(atlas_core::snapshot::UPLOAD_SESSION_META), id))).filter(|(_, ts)| !ts.is_empty()).collect();
        sender_view(&per, i.shown, i.facts, &i.cfg.work_hours(), i.cfg.source.is_some())
    } else {
        let owned;
        let r = match i.refreshed {
            Some(r) => r,
            None => {
                let st = load_tasks(&tasks_path(i.notes));
                let li = load_links(&task_links_path(i.notes));
                owned = Refreshed { state: st.file, links: li.file, warnings: st.warnings.into_iter().chain(li.warnings).chain(i.cfg.error.clone()).collect() };
                &owned
            }
        };
        local_view(LocalInputs { configured: i.cfg.source.is_some(), state: &r.state, links: &r.links, shown: i.shown, facts: i.facts, work_hours: &i.cfg.work_hours(), warnings: r.warnings.clone() })
    }?;
    v.scoped = i.scoped;
    Some(v)
}

/// レポートの節。read_only(tasks_read_only)なら送った人の記録から、それ以外はこの PC か設定のフォルダの記録から。shown が all より少なければ scoped
pub fn build_view(p: &Paths, cfg: &TaskConfig, read_only: bool, all: &[SessionRecord], shown: &[&SessionRecord], refreshed: Option<&Refreshed>, human: &HashMap<String, (f64, Option<f64>)>) -> Option<TasksView> {
    let ids: Vec<&str> = shown.iter().map(|s| s.id.as_str()).collect();
    let all_ids: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
    let facts: HashMap<String, SessionFacts> = session_facts(shown, human);
    tasks_view(ViewInputs { notes: &p.tasks_dir, snapshot: &p.snapshot, cfg, read_only, all: &all_ids, shown: &ids, facts: &facts, refreshed, scoped: shown.len() < all.len() })
}

/// --task: そのタスクに紐づいたセッション。知らないタスクなら止める(黙って 0 件にしない)
pub fn sessions_of_task(p: &Paths, file: &SessionsFile, task: &str) -> Result<HashSet<String>> {
    if tasks_read_only(p, file) {
        let per = sender_tasks_of(p, &file.sessions);
        let has = |ts: &[SenderTask]| ts.iter().any(|t| t.id == task);
        if !per.iter().any(|(_, ts)| has(ts)) {
            bail!("タスク「{task}」に紐づいたセッションは、送った人の記録にありません");
        }
        return Ok(per.into_iter().filter(|(_, ts)| has(ts)).map(|(s, _)| s).collect());
    }
    let state = load_tasks(&tasks_path(&p.tasks_dir)).file;
    let links = load_links(&task_links_path(&p.tasks_dir)).file;
    let ids: HashSet<String> = links.links.iter().filter(|(_, l)| l.task_ids.iter().any(|t| t == task)).map(|(s, _)| s.clone()).collect();
    if ids.is_empty() && !state.tasks.contains_key(task) {
        bail!("タスク「{task}」は {} にありません(atlas tasks list で ID を確かめられます)", tasks_path(&p.tasks_dir).display());
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

/// atlas tasks sync / list / link / bundle / import。戻り値は、レポートを作り直したほうがよいか(紐づけが変わった)
pub fn run_tasks(o: &CliOptions, p: &Paths, t: &TasksCliOptions, log: Log<'_>) -> Result<bool> {
    let cfg = load_task_config(o.config.as_deref());
    match t.action.as_str() {
        "sync" => {
            let src = require_source(&cfg)?;
            let r = sync_tasks(src, &tasks_path(&p.tasks_dir)).map_err(anyhow::Error::msg)?;
            log(&format!("tasks sync: {} → {}", sync_line(&r.summary), tasks_path(&p.tasks_dir).display()));
            for n in &r.notes {
                log(&format!("tasks sync: 注意 {n}"));
            }
            let Some(file) = read_sessions(p)? else {
                log("tasks sync: sessions.json がまだ無いので、紐づけは集計(atlas all)のときに決めます");
                return Ok(false);
            };
            let texts: Vec<SessionText> = file.sessions.iter().map(SessionText::of).collect();
            let now = atlas_core::jsdate::now_iso();
            let (m, _) = update_links(&task_links_path(&p.tasks_dir), |links| apply_machine(links, &texts, &r.state, &now))?;
            log(&format!("tasks sync: {}。レポートに出すには atlas export(画面の「集計し直す」)を実行してください", machine_line(&m)));
            Ok(false)
        }
        "list" => {
            let st = load_tasks(&tasks_path(&p.tasks_dir));
            for w in &st.warnings {
                log(&format!("tasks list: 注意 {w}"));
            }
            let links = load_links(&task_links_path(&p.tasks_dir)).file;
            let mut count: HashMap<&str, usize> = HashMap::new();
            // いくつかのタスクに紐づいたセッションは、それぞれのタスクに 1 つずつ数える
            for l in links.links.values() {
                for t in &l.task_ids {
                    *count.entry(t.as_str()).or_default() += 1;
                }
            }
            if st.file.tasks.is_empty() {
                log(&format!("tasks list: タスクはまだありません({})。atlas tasks sync で管理ツールの XML を読みます", tasks_path(&p.tasks_dir).display()));
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
        "bundle" => {
            run_task_bundle(o, p, log)?;
            Ok(false)
        }
        "import" => run_task_import(p, t, log),
        _ => run_link(p, log),
    }
}

fn run_link(p: &Paths, log: Log<'_>) -> Result<bool> {
    let (file, state) = sessions_and_tasks(p)?;
    let texts: Vec<SessionText> = file.sessions.iter().map(SessionText::of).collect();
    let now = atlas_core::jsdate::now_iso();
    let (m, _) = update_links(&task_links_path(&p.tasks_dir), |links| apply_machine(links, &texts, &state, &now))?;
    log(&format!("tasks link: {}", machine_line(&m)));
    Ok(m.changed())
}

/// 集計(sessions.json)とタスクの状態(tasks.json)。どちらかが無ければ、何をすればよいかを書いて止める
fn sessions_and_tasks(p: &Paths) -> Result<(SessionsFile, TasksFile)> {
    let Some(file) = read_sessions(p)? else { bail!("{} がありません。先に atlas all を実行してください", p.sessions.display()) };
    let state = load_tasks(&tasks_path(&p.tasks_dir));
    if let Some(w) = state.warnings.first() {
        bail!("{w}");
    }
    if state.file.tasks.is_empty() {
        bail!("タスクがまだありません({})。先に atlas tasks sync で管理ツールの XML を読んでください", tasks_path(&p.tasks_dir).display());
    }
    Ok((file, state.file))
}

/// LLM に頼むセッションでない理由(--session で指したとき。頼むなら None)
fn not_eligible_reason(links: &LinksFile, state: &TasksFile, s: &SessionText, empty: bool) -> Option<&'static str> {
    match links.links.get(&s.id).map(|l| l.source) {
        Some(LinkSource::Manual) => return Some("手動で紐づけてあるので、LLM には頼みません(画面で「自動に戻す」を押すと頼めます)"),
        Some(LinkSource::Llm) => return Some("前に LLM で紐づけてあるので、もう一度は頼みません(画面で「自動に戻す」を押すと頼み直せます)"),
        Some(LinkSource::Machine) => return Some("機械で紐づいたので、LLM には頼みません"),
        None => {}
    }
    if empty {
        return Some("開いただけのセッション(依頼・ツール・応答が無い)なので、頼みません");
    }
    if !has_text(&s.title, &s.prompts) {
        return Some("題名も依頼の文も無いので、頼みません");
    }
    if !llm_eligible(links, state, &s.id, empty, true, s.start_ms) {
        return Some("候補のタスクが無いので、頼みません");
    }
    None
}

/// LLM に頼むセッションが無かったときの知らせ(画面も、ジョブのログのこの文で知らせる)
pub const NO_TASK_BUNDLE: &str = "LLM に頼むセッションはありません";

/// LLM に渡す依頼の文: 最初の依頼から PROMPTS_MAX 件まで(依頼 1 件が 1 つ。改行を含む依頼も 1 つ)。
/// スナップショットのログ(events.jsonl)の本体の依頼を読み、無ければ sessions.json の最初の依頼と、各依頼の先頭(300 字まで)で代える
/// (sessions.json の各依頼の先頭の 1 件目は最初の依頼と同じ依頼なので、最初の依頼の方を使う)
pub fn task_prompts(snapshot: &Path, r: &SessionRecord) -> Vec<String> {
    let keep = |v: Vec<String>| -> Vec<String> { v.into_iter().filter(|x| !x.trim().is_empty()).take(PROMPTS_MAX).collect() };
    if let Ok(Some(t)) = atlas_judge::turn_bundle::collect_turn_texts(snapshot, &r.id) {
        let v = keep(t.requests);
        if !v.is_empty() {
            return v;
        }
    }
    let requests = &r.analysis.requests;
    let mut v: Vec<String> = Vec::new();
    let rest: &[String] = match r.first_user_message.as_deref().filter(|f| !f.trim().is_empty()) {
        Some(f) => {
            v.push(f.to_string());
            match requests.first() {
                Some(h) if f.starts_with(h.as_str()) => &requests[1..],
                _ => &requests[..],
            }
        }
        None => &requests[..],
    };
    v.extend(rest.iter().cloned());
    keep(v)
}

/// atlas tasks bundle: 機械の紐づけを決め直してから、紐づけの無いセッション(links::llm_eligible。--session ならその中)を、
/// 外部の LLM に頼む束(<out>/task-bundle/。--zip なら task-bundle.zip も)にする。LLM は呼ばない。
/// 頼むセッションが 1 つも無ければ、前に作った束と ZIP には触らずに None(--session で紐づいたセッションだけを指したときなど)
pub fn run_task_bundle(o: &CliOptions, p: &Paths, log: Log<'_>) -> Result<Option<TaskBundleManifest>> {
    let (file, state) = sessions_and_tasks(p)?;
    let texts: Vec<SessionText> = file.sessions.iter().map(SessionText::of).collect();
    let now = atlas_core::jsdate::now_iso();
    let (m, links) = update_links(&task_links_path(&p.tasks_dir), |links| apply_machine(links, &texts, &state, &now))?;
    log(&format!("tasks bundle: {}", machine_line(&m)));
    // 対象: 紐づけの無いセッションのうち、開いただけのもの(依頼 0・ツール 0・応答 0)・題名も依頼の文も無いもの・候補のタスクが無いものを除く
    // (画面の件数と同じ決め方。links::llm_eligible)。--session ならその中だけ
    let empty: HashSet<&str> = file.sessions.iter().filter(|s| atlas_core::metrics::is_empty_session(s)).map(|s| s.id.as_str()).collect();
    let eligible = |s: &SessionText| llm_eligible(&links, &state, &s.id, empty.contains(s.id.as_str()), has_text(&s.title, &s.prompts), s.start_ms);
    let targets: Vec<&SessionText> = match o.sessions.as_ref().filter(|s| !s.is_empty()) {
        Some(prefixes) => {
            let known: Vec<&str> = texts.iter().map(|s| s.id.as_str()).collect();
            let ids = atlas_report::ids::resolve_id_prefixes(&known, prefixes)?;
            let mut v = Vec::new();
            for id in &ids {
                let Some(s) = texts.iter().find(|s| &s.id == id) else { continue };
                match not_eligible_reason(&links, &state, s, empty.contains(id.as_str())) {
                    Some(why) => log(&format!("tasks bundle: {id} は{why}")),
                    None => v.push(s),
                }
            }
            v
        }
        None => texts.iter().filter(|s| eligible(s)).collect(),
    };
    let matcher = Matcher::new(&state);
    let records: HashMap<&str, &SessionRecord> = file.sessions.iter().map(|r| (r.id.as_str(), r)).collect();
    let queries: Vec<LinkQuery> = targets.iter().filter_map(|s| llm_query(&state, &matcher, s, records.get(s.id.as_str()).map(|r| task_prompts(&p.snapshot, r)).unwrap_or_default())).collect();
    if queries.is_empty() {
        // 空の束で前の束(と ZIP)を置き換えない。前の束への返答は、そのまま取り込める
        log(&format!(
            "tasks bundle: {NO_TASK_BUNDLE}(紐づけの無いセッションがありません)。前に作った束{}はそのまま残します",
            if p.task_bundle.join("manifest.json").exists() { format!("({})", p.task_bundle.display()) } else { String::new() }
        ));
        return Ok(None);
    }
    let mut scope: IndexMap<String, Option<String>> = IndexMap::new();
    scope.insert("session".into(), o.sessions.as_ref().filter(|s| !s.is_empty()).map(|s| s.join(",")));
    let bm = build_task_bundle(&queries, &TaskBundleOptions { bundle_dir: p.task_bundle.clone(), per_part: o.per_part.map(|n| n as usize), boundary: None, scope, now: None })?;
    log(&format!(
        "tasks bundle: 紐づけの無いセッション {} 件を、チャットに添付する {} ファイル(parts/。{} 件ずつ)と、フォルダ(ZIP)ごと渡すときのパケット(sessions/)にしました → {}",
        bm.count,
        bm.parts.len(),
        bm.per_part,
        p.task_bundle.display()
    ));
    if let Some((path, z)) = super::bundle::zip_or_drop(&p.task_bundle, &p.out.join(crate::paths::TASK_BUNDLE_DIR), o.zip, &task_zip_names(&bm), "tasks bundle", "--session で対象を絞ってください", log)? {
        log(&format!("tasks bundle: ZIP にまとめました({} ファイル、{}、無圧縮。parts/ は入れていません)→ {}", z.files, super::mb(z.bytes), path.display()));
        log("tasks bundle: フォルダやファイルを読めるエージェントに渡し、INSTRUCTIONS.md を最初に読ませてください。返ってきた JSON は atlas tasks import <ファイル> で取り込みます");
    }
    Ok(Some(bm))
}

/// 返答の取り込みの結果
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskImportSummary {
    /// 書いたセッション
    pub imported: usize,
    /// 書かなかったセッション: 取り込む前に手動で紐づけてあった・LLM で紐づけてあった・
    /// 答えが「どのタスクでもない」で、機械がタスクに紐づけてあった(束を作った後に機械の当たりが決まったもの)
    pub kept_manual: Vec<String>,
    pub kept_llm: Vec<String>,
    pub kept_machine: Vec<String>,
    /// 返答の中の同じセッションの重なり(後ろのものを使った)
    pub duplicates: usize,
    /// 除いた ID などの知らせ
    pub notes: Vec<String>,
}

/// 外部の LLM の返答(JSON か、JSON のコードブロックを含む文)を、作った束(<out>/task-bundle/manifest.json)と照らして確かめ、
/// task-links.json に紐づけの出所 LLM で書く。形の合わない項目が 1 件でもあれば何も書かない(JudgmentValidationError)。
/// ロックの中で読み直し、手動の紐づけと、前に LLM で決めた紐づけは変えない(取り込む前に決まったものを、古い答えで上書きしない)。
/// 機械の紐づけは、タスクを選んだ答えなら置き換える(LLM は機械より先に使う)。「どのタスクでもない」の答えでは、タスクのある機械の紐づけを消さない
pub fn import_task_links_text(text: &str, notes: &Path, bundle_dir: &Path) -> Result<TaskImportSummary> {
    let m = read_task_bundle_manifest(bundle_dir)?;
    let reply = parse_task_reply(text, &m)?;
    let now = atlas_core::jsdate::now_iso();
    let (s, _) = update_links(&task_links_path(notes), |l| {
        let mut s = TaskImportSummary { duplicates: reply.duplicates, notes: reply.notes.clone(), ..Default::default() };
        for x in &reply.links {
            match l.links.get(&x.session_id).map(|e| e.source) {
                Some(LinkSource::Manual) => s.kept_manual.push(x.session_id.clone()),
                Some(LinkSource::Llm) => s.kept_llm.push(x.session_id.clone()),
                Some(LinkSource::Machine) if x.task_ids.is_empty() && l.links.get(&x.session_id).is_some_and(|e| !e.is_none()) => s.kept_machine.push(x.session_id.clone()),
                _ => {
                    l.links.insert(x.session_id.clone(), TaskLink { task_ids: x.task_ids.clone(), source: LinkSource::Llm, reason: x.reason.clone(), confidence: Some(x.confidence), at: now.clone() });
                    s.imported += 1;
                }
            }
        }
        s
    })?;
    Ok(s)
}

/// 取り込みの結果のログの行
pub fn import_lines(cmd: &str, s: &TaskImportSummary, links_path: &Path) -> Vec<String> {
    let mut v = vec![format!(
        "{cmd}: {} セッションの紐づけを取り込みました(出所 LLM)→ {}{}",
        s.imported,
        links_path.display(),
        if s.duplicates > 0 { format!("。返答の中の重なり {} 件は後ろのものを使いました", s.duplicates) } else { String::new() }
    )];
    let ids = |xs: &[String]| xs.iter().take(5).cloned().collect::<Vec<_>>().join(", ") + if xs.len() > 5 { " …" } else { "" };
    if !s.kept_manual.is_empty() {
        v.push(format!("{cmd}: 手動で紐づけてあるので書かなかったセッション {} 件: {}", s.kept_manual.len(), ids(&s.kept_manual)));
    }
    if !s.kept_llm.is_empty() {
        v.push(format!("{cmd}: 前に LLM で紐づけてあるので書かなかったセッション {} 件: {}(頼み直すときは、画面で「自動に戻す」を押してから束を作り直します)", s.kept_llm.len(), ids(&s.kept_llm)));
    }
    if !s.kept_machine.is_empty() {
        v.push(format!("{cmd}: 答えは「どのタスクでもない」でしたが、機械がタスクに紐づけてあるので書かなかったセッション {} 件: {}", s.kept_machine.len(), ids(&s.kept_machine)));
    }
    for n in &s.notes {
        v.push(format!("{cmd}: 注意 {n}"));
    }
    v
}

fn run_task_import(p: &Paths, t: &TasksCliOptions, log: Log<'_>) -> Result<bool> {
    let text = atlas_judge::read_text(&resolve(t.file.as_deref().unwrap_or("")))?;
    let s = import_task_links_text(&text, &p.tasks_dir, &p.task_bundle)?;
    for l in import_lines("tasks import", &s, &task_links_path(&p.tasks_dir)) {
        log(&l);
    }
    Ok(s.imported > 0)
}

/// LLM に頼む中身。機械の紐づけで決めなかったときに当たったタスクを候補の先頭に置き(上限で切られないように)、
/// 残りはパケットに書くのと同じ題名と依頼の文に、名前の文字が多く重なる順に並べる(links::llm_candidates)。候補が無ければ None(頼まない)。
/// prompts は依頼の文(依頼 1 件が 1 つ。task_prompts)
pub fn llm_query(state: &TasksFile, matcher: &Matcher<'_>, s: &SessionText, prompts: Vec<String>) -> Option<LinkQuery> {
    let first: Vec<String> = match matcher.match_session(s) {
        MachineMatch::Many(ids) => ids,
        _ => vec![],
    };
    let text = atlas_judge::task_link::packet_text(&s.title, &prompts);
    let c = llm_candidates(state, &CandidateQuery { start_ms: s.start_ms, end_ms: s.end_ms, text: &text, first: &first });
    if c.items.is_empty() {
        return None;
    }
    Some(LinkQuery { session_id: s.id.clone(), title: s.title.clone(), prompts, candidates: c.items, candidates_total: c.total })
}

/// atlas tasks の後に、紐づけが変わっていればレポートを作り直す(export で)。m365 は取り込めたら作り直す
pub fn run_tasks_command(o: &CliOptions, p: &Paths, log: Log<'_>) -> Result<super::RunResult> {
    let t = o.tasks_cmd.as_ref().ok_or_else(|| anyhow::anyhow!("tasks の操作がありません"))?;
    if t.action == "m365" {
        return super::run_m365_command(o, p, crate::chat_parts::ChatTarget::Tasks, t.model.as_deref(), t.limit, t.timeout_sec, log);
    }
    let changed = run_tasks(o, p, t, log)?;
    if matches!(t.action.as_str(), "link" | "import") && changed && p.sessions.exists() {
        let export = CliOptions { command: "export".into(), sessions: None, task: None, tasks_cmd: None, model: None, ..o.clone() };
        return super::run_command(&export, p, log);
    }
    Ok(super::RunResult::default())
}

/// 送るときの、セッション id → タスクの記録(notes にある tasks.json と task-links.json から。無ければ空)。
/// starts はセッション id → 開始(紐づけがあるときだけ呼ぶ)
pub fn sender_records(notes: &Path, starts: &dyn Fn() -> HashMap<String, String>) -> HashMap<String, Vec<SenderTask>> {
    let links = load_links(&task_links_path(notes)).file;
    if !links.links.values().any(|l| !l.is_none()) {
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
        assert_eq!(r.links.links["s1"].task_ids.first().map(String::as_str), Some("DEMO-101"));
        assert!(!r.links.links.contains_key("s2"));
        assert!(logs.lock().unwrap().iter().any(|l| l.starts_with("build: 管理ツールのタスク タスク 6 件")));
        assert!(task_links_path(&p.notes).exists());

        // 最初の書き出しには DEMO-105 が無いので、s3 は DEMO-103 だけ
        assert_eq!(r.links.links["s3"].task_ids, ["DEMO-103"]);
        // 完了した書き出し → s1 のタスクは完了。s3 は 2 つの ID を書いてあるので(DEMO-105 が増えた)、両方に紐づける
        std::fs::write(&xml, fixture("export-after.xml")).unwrap();
        let later = atlas_core::jsdate::now_ms() + 60_000;
        atlas_core::jsfs::utimes(&xml, later, later).unwrap();
        let r = refresh_tasks(&p, &cfg, &sessions, "build", &log);
        assert!(r.state.tasks["DEMO-101"].done);
        assert_eq!(r.links.links["s3"].task_ids, ["DEMO-103", "DEMO-105"], "{:?}", r.links);

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
        assert!(lines[0].starts_with("\u{feff}taskId,taskName,status,完了,XML に無い,開始,完了を確認した時刻,完了時刻の出所,稼働時間帯の工数(時間),AI の実働(時間),推定人手工数(時間),セッション数,共有のセッション,判定済み"), "{}", lines[0]);
        assert_eq!(lines.len(), 1 + view.items.len());
        let row: Vec<&str> = lines.iter().find(|l| l.starts_with("DEMO-101,")).unwrap().split(',').collect();
        // 完了時刻の出所は、XML に完了日時が無いので観測
        assert_eq!((row[3], row[7], row[10], row[11], row[12], row[16]), ("1", "観測", "6", "1", "0", "1"));
        // s3 は DEMO-103 と DEMO-105 の共有のセッション
        let row: Vec<&str> = lines.iter().find(|l| l.starts_with("DEMO-105,")).unwrap().split(',').collect();
        assert_eq!((row[11], row[12]), ("1", "1"));
        let sess = std::fs::read_to_string(tables.join("sessions.csv")).unwrap();
        let header: Vec<&str> = sess.lines().next().unwrap().trim_start_matches('\u{feff}').split(',').collect();
        let at = header.iter().position(|h| *h == "推定人手工数(時間)").unwrap();
        assert_eq!(&header[at + 1..at + 5], ["taskId", "taskName", "紐づけの出所", "タスクの数"]);
        let s1: Vec<&str> = sess.lines().find(|l| l.starts_with("s1,")).unwrap().split(',').collect();
        assert_eq!(&s1[at + 1..at + 5], ["DEMO-101", "fix the app", "機械", "1"]);
        let s2: Vec<&str> = sess.lines().find(|l| l.starts_with("s2,")).unwrap().split(',').collect();
        assert_eq!(&s2[at + 1..at + 5], ["", "", "", ""]);
        // いくつかのタスクは「; 」でつなぐ(紐づけの順)
        let s3: Vec<&str> = sess.lines().find(|l| l.starts_with("s3,")).unwrap().split(',').collect();
        assert_eq!(&s3[at + 1..at + 5], ["DEMO-103; DEMO-105", "帳票の出力を速くする; 後から増えたタスク", "機械", "2"]);
        // セッション × タスクの表(按分は等分の割合)
        let st = std::fs::read_to_string(tables.join("session-tasks.csv")).unwrap();
        let st: Vec<&str> = st.trim_end().split("\r\n").collect();
        assert_eq!(st[0], "\u{feff}セッションID,taskId,taskName,紐づけの出所,按分");
        assert_eq!(&st[1..], ["s1,DEMO-101,fix the app,機械,1", "s3,DEMO-103,帳票の出力を速くする,機械,0.5", "s3,DEMO-105,後から増えたタスク,機械,0.5"]);
        let db = rusqlite::Connection::open(tables.join(crate::tables::SQLITE_FILE)).unwrap();
        let n: i64 = db.query_row(r#"SELECT count(*) FROM tasks WHERE "taskId" = 'DEMO-101' AND "セッション数" = 1"#, [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let half: f64 = db.query_row(r#"SELECT sum("按分") FROM session_tasks WHERE "セッションID" = 's3'"#, [], |r| r.get(0)).unwrap();
        assert_eq!(half, 1.0);
        drop(db);
        // 一覧に無いタスクだけに紐づけたセッション: taskName は NULL、按分は 0(タスクの数は紐づいた数のまま)
        let mut r2 = r.clone();
        r2.links.links.insert("s2".into(), link(Some("NOPE"), LinkSource::Manual));
        let view2 = build_view(&p, &cfg, false, &sessions, &refs, Some(&r2), &human).unwrap();
        assert!(view2.links["s2"].counted_task_ids.is_empty());
        super::super::metrics::write_tables(&p, &refs, Some(&view2), "build", &log).unwrap();
        let db = rusqlite::Connection::open(tables.join(crate::tables::SQLITE_FILE)).unwrap();
        let (name_null, n): (bool, f64) = db.query_row(r#"SELECT "taskName" IS NULL, "タスクの数" FROM sessions WHERE "セッションID" = 's2'"#, [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((name_null, n), (true, 1.0));
        let share: f64 = db.query_row(r#"SELECT "按分" FROM session_tasks WHERE "セッションID" = 's2'"#, [], |r| r.get(0)).unwrap();
        assert_eq!(share, 0.0);
        drop(db);
        // タスクの節が無ければ、前の tasks.csv と session-tasks.csv を残さない(sessions.csv の列は空で残る)
        super::super::metrics::write_tables(&p, &refs, None, "build", &log).unwrap();
        assert!(!tables.join("tasks.csv").exists());
        assert!(!tables.join("session-tasks.csv").exists());

        // XML を読めなくなっても、前の状態のまま続け、注意を出す
        std::fs::write(&xml, "<Export><Task").unwrap();
        let later = later + 60_000;
        atlas_core::jsfs::utimes(&xml, later, later).unwrap();
        let r = refresh_tasks(&p, &cfg, &sessions, "build", &log);
        assert_eq!(r.state.tasks.len(), 7);
        assert!(r.warnings[0].contains("XML として読めません"), "{:?}", r.warnings);
        assert_eq!(r.links.links["s1"].task_ids.first().map(String::as_str), Some("DEMO-101"));
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

    fn link(task: Option<&str>, source: LinkSource) -> TaskLink {
        TaskLink { task_ids: task.map(str::to_string).into_iter().collect(), source, reason: String::new(), confidence: None, at: "t".into() }
    }

    /// tasks bundle: 機械の紐づけを決め直してから、紐づけの無いセッションだけを束にする(候補は manifest に残す)。--session でも、紐づいたセッションは入れない。
    /// tasks import: 束の候補と照らして確かめ、手動と前の LLM の紐づけは変えずに、出所 LLM で書く(機械の紐づけは置き換える)。形の誤りがあれば何も書かない
    #[test]
    fn task_bundle_and_import_keep_precedence() {
        let d = tempfile::tempdir().unwrap();
        let p = paths(d.path());
        let xml = d.path().join("export.xml");
        std::fs::write(&xml, fixture("export-before.xml")).unwrap();
        let cfg = TaskConfig { source: Some(TaskSource::with_file(&xml)), error: None };
        let sessions = vec![rec("s1", "2026-11-20T01:00:00.000Z", "fix the app"), rec("s2", "2026-11-20T02:00:00.000Z", "雑談だけ"), rec("s3", "2026-11-20T03:00:00.000Z", "画面の文言を直す"), rec("s4", "2026-11-20T04:00:00.000Z", "別の話"), rec("s5", "2026-11-20T05:00:00.000Z", "もう一つ別の話")];
        let file = serde_json::json!({
            "schemaVersion": 1, "generatedAt": "2026-11-23T00:00:00.000Z", "source": { "root": null, "snapshotDir": "x", "since": null },
            "counts": { "sessions": 5, "dbOnly": 0, "dirOnly": 0, "both": 0, "empty": 0 }, "installed": null,
            "warnings": { "unknownEventTypes": {}, "badLines": 0, "messages": [] }, "sessions": serde_json::to_value(&sessions).unwrap()
        });
        std::fs::create_dir_all(&p.out).unwrap();
        std::fs::write(&p.sessions, file.to_string()).unwrap();
        refresh_tasks(&p, &cfg, &sessions, "build", &|_| {});
        let logs = Mutex::new(Vec::<String>::new());
        let log = |m: &str| logs.lock().unwrap().push(m.to_string());
        let (o, n) = (p.out.to_string_lossy().into_owned(), p.notes.to_string_lossy().into_owned());
        let opts = |extra: &[&str]| crate::args::parse_cli(&["tasks", "bundle", "--out", &o, "--notes-dir", &n].iter().chain(extra).map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
        let m = run_task_bundle(&opts(&["--zip"]), &p, &log).unwrap().unwrap();
        // s1 は機械で紐づいた。残りの 4 つを、候補のタスク(未完了のもの)と一緒に束にする
        assert_eq!(m.sessions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["s2", "s3", "s4", "s5"]);
        assert!(m.sessions[0].candidates.contains(&"DEMO-103".to_string()));
        assert!(p.task_bundle.join("parts").join("part-01.md").exists());
        assert!(p.out.join("task-bundle.zip").exists());
        // 頼むセッションが無いとき(--session で紐づいたセッションだけを指した)は、前の束と ZIP に触らずに理由を出す
        let manifest_before = std::fs::read(p.task_bundle.join("manifest.json")).unwrap();
        assert!(run_task_bundle(&opts(&["--session", "s1"]), &p, &log).unwrap().is_none());
        assert_eq!(std::fs::read(p.task_bundle.join("manifest.json")).unwrap(), manifest_before);
        assert!(p.out.join("task-bundle.zip").exists());
        assert!(logs.lock().unwrap().iter().any(|l| l.starts_with(&format!("tasks bundle: {NO_TASK_BUNDLE}")) && l.contains("そのまま残します")), "{:?}", logs.lock().unwrap());
        // --session で指しても、紐づいたセッションは入れず、理由を出す(ZIP は作らなかったので、前のものを消す)
        let one = run_task_bundle(&opts(&["--session", "s1,s3"]), &p, &log).unwrap().unwrap();
        assert_eq!(one.sessions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["s3"]);
        assert!(logs.lock().unwrap().iter().any(|l| l == "tasks bundle: s1 は機械で紐づいたので、LLM には頼みません"), "{:?}", logs.lock().unwrap());
        assert!(!p.out.join("task-bundle.zip").exists());
        let m = run_task_bundle(&opts(&[]), &p, &log).unwrap().unwrap();

        // 束を作った後に、画面で s4 を手動で紐づけ、s2 は前に LLM で紐づけ、s3 と s5 は機械の当たりが決まった
        let links_path = task_links_path(&p.notes);
        update_links(&links_path, |l| {
            l.links.insert("s4".into(), link(Some("DEMO-102"), LinkSource::Manual));
            l.links.insert("s2".into(), link(Some("DEMO-102"), LinkSource::Llm));
            l.links.insert("s3".into(), link(Some("DEMO-101"), LinkSource::Machine));
            l.links.insert("s5".into(), link(Some("DEMO-101"), LinkSource::Machine));
        })
        .unwrap();
        // 形の誤り(候補に無い ID だけ)が 1 件でもあれば、何も書かない
        let before = std::fs::read(&links_path).unwrap();
        let bad = serde_json::json!({ "links": [{ "sessionId": "s3", "taskIds": ["DEMO-103"], "confidence": 0.7 }, { "sessionId": "s2", "taskIds": ["NOPE"], "confidence": 0.5 }] }).to_string();
        let e = import_task_links_text(&bad, &p.notes, &p.task_bundle).unwrap_err();
        assert!(e.downcast_ref::<atlas_judge::schema::JudgmentValidationError>().is_some_and(|v| v.problems.len() == 1 && v.problems[0].contains("NOPE")), "{e:#}");
        assert_eq!(std::fs::read(&links_path).unwrap(), before);
        let reply = format!(
            "決めました\n```json\n{}\n```",
            serde_json::json!({ "schemaVersion": 1, "links": [
                { "sessionId": "s2", "taskIds": ["DEMO-103"], "confidence": 0.7, "reason": "r" },
                { "sessionId": "s3", "taskIds": ["DEMO-103", "DEMO-102", "DEMO-103"], "confidence": 0.8, "reason": "両方" },
                { "sessionId": "s4", "taskIds": [], "confidence": 0.9, "reason": "どれでもない" },
                { "sessionId": "s5", "taskIds": [], "confidence": 0.9, "reason": "どれでもない" }
            ] })
        );
        // ほかの書き手(画面の手動の紐づけ)と同時に書いても、どちらの変更も残る
        let r = std::thread::scope(|sc| {
            let lp = &links_path;
            let h = sc.spawn(move || {
                for i in 0..20 {
                    update_links(lp, |l| {
                        l.links.insert(format!("h{i}"), link(Some("DEMO-101"), LinkSource::Manual));
                    })
                    .unwrap();
                }
            });
            let r = import_task_links_text(&reply, &p.notes, &p.task_bundle).unwrap();
            h.join().unwrap();
            r
        });
        assert_eq!((r.imported, r.kept_manual.clone(), r.kept_llm.clone(), r.kept_machine.clone()), (1, vec!["s4".to_string()], vec!["s2".to_string()], vec!["s5".to_string()]));
        let got = load_links(&links_path).file;
        // タスクを選んだ答えは機械の紐づけを置き換え、「どのタスクでもない」の答えは機械の紐づけを残す
        assert_eq!((got.links["s3"].task_ids.clone(), got.links["s3"].source, got.links["s3"].confidence), (vec!["DEMO-103".to_string(), "DEMO-102".to_string()], LinkSource::Llm, Some(0.8)));
        assert_eq!((got.links["s5"].task_ids.clone(), got.links["s5"].source), (vec!["DEMO-101".to_string()], LinkSource::Machine));
        assert_eq!((got.links["s4"].source, got.links["s2"].task_ids.clone()), (LinkSource::Manual, vec!["DEMO-102".to_string()]));
        assert!((0..20).all(|i| got.links[&format!("h{i}")].source == LinkSource::Manual));
        assert_eq!(got.links["s1"].source, LinkSource::Machine);
        // 束に入っていないセッション(s1)の答えは、形の誤りとして断る
        let other = serde_json::json!({ "links": [{ "sessionId": "s1", "taskIds": ["DEMO-101"], "confidence": 0.7 }] }).to_string();
        assert!(import_task_links_text(&other, &p.notes, &p.task_bundle).unwrap_err().downcast_ref::<atlas_judge::schema::JudgmentValidationError>().is_some());
        // ログの行(書かなかった数を出す)
        let lines = import_lines("tasks import", &r, &links_path);
        assert!(lines[0].starts_with("tasks import: 1 セッションの紐づけを取り込みました(出所 LLM)"), "{lines:?}");
        assert!(lines.iter().any(|l| l.starts_with("tasks import: 手動で紐づけてあるので書かなかったセッション 1 件: s4")));
        assert!(lines.iter().any(|l| l.starts_with("tasks import: 前に LLM で紐づけてあるので書かなかったセッション 1 件: s2")));
        assert!(lines.iter().any(|l| l.starts_with("tasks import: 答えは「どのタスクでもない」でしたが、機械がタスクに紐づけてあるので書かなかったセッション 1 件: s5")));
        let _ = m;
    }

    /// LLM に渡す依頼の文は、依頼 1 件が 1 つ(改行を含む最初の依頼を、行ごとの依頼にしない)。最初の依頼から 3 件まで
    #[test]
    fn task_prompts_keep_each_request_whole() {
        use atlas_core::types::CopilotEvent;
        let d = tempfile::tempdir().unwrap();
        let snap = d.path().join("snapshot");
        let multi = "一行目の依頼\n二行目\n三行目\n四行目";
        // スナップショットが無ければ sessions.json から(最初の依頼と、各依頼の先頭の 2 件目から)
        let r = rec("m1", "2026-11-20T01:00:00.000Z", multi);
        assert_eq!(task_prompts(&snap, &r), [multi]);
        // スナップショットのログがあれば、本体の依頼を最初から 3 件まで
        let dir = snap.join("session-state").join("m1");
        std::fs::create_dir_all(&dir).unwrap();
        let ev = |content: &str, at: &str| CopilotEvent { kind: "user.message".into(), data: Some(serde_json::json!({ "content": content })), timestamp: Some(serde_json::json!(at)), ..Default::default() };
        let events = [ev(multi, "2026-11-20T01:00:00.000Z"), ev("二つ目の依頼", "2026-11-20T01:01:00.000Z"), ev("三つ目の依頼", "2026-11-20T01:02:00.000Z"), ev("四つ目の依頼", "2026-11-20T01:03:00.000Z")];
        std::fs::write(dir.join("events.jsonl"), events.iter().map(|e| serde_json::to_string(e).unwrap()).collect::<Vec<_>>().join("\n")).unwrap();
        assert_eq!(task_prompts(&snap, &r), [multi, "二つ目の依頼", "三つ目の依頼"]);
        // パケットでは、1 件の依頼の改行は空白にして、依頼 1 に入れる
        let md = atlas_judge::task_link::render_task_packet(&LinkQuery { session_id: "m1".into(), title: "t".into(), prompts: task_prompts(&snap, &r), candidates: vec![("T-1".into(), "x".into())], candidates_total: 1 });
        assert!(md.contains("依頼 1: 一行目の依頼 二行目 三行目 四行目\n依頼 2: 二つ目の依頼\n依頼 3: 三つ目の依頼\n"), "{md}");
        assert!(!md.contains("四つ目の依頼"));
    }

    /// 候補が無いセッションは頼まない(束に入れない)。機械で 2 つ以上に当たったタスクを候補の先頭に置く
    #[test]
    fn llm_query_skips_without_candidates_and_puts_ambiguous_first() {
        let task = |name: &str, done_at: Option<&str>| atlas_report::tasks::state::TaskState {
            name: name.into(),
            status: "x".into(),
            done: done_at.is_some(),
            first_seen_at: "t".into(),
            done_at: done_at.map(str::to_string),
            last_seen_at: "t".into(),
            missing: false,
            done_observed: done_at.is_some(),
            done_at_source: None,
        };
        let mut state = TasksFile::default();
        state.tasks.insert("OLD-1".into(), task("前に終わった仕事", Some("2026-11-01T00:00:00.000Z")));
        let m = Matcher::new(&state);
        let s = SessionText { id: "s".into(), start_ms: atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z"), title: "題名".into(), prompts: "依頼 1\n\n依頼 2".into(), ..Default::default() };
        assert!(llm_query(&state, &m, &s, vec![]).is_none());
        for i in 0..atlas_report::tasks::links::LLM_CANDIDATES_MAX + 5 {
            state.tasks.insert(format!("T-{i}"), task(&format!("仕事 {i}"), None));
        }
        let last = atlas_report::tasks::links::LLM_CANDIDATES_MAX + 4;
        let m = Matcher::new(&state);
        // 名前だけで 2 つに当たる(ID で書いたものは機械で両方に紐づくので、LLM には名前で当たったものを聞く)
        assert!(matches!(m.match_session(&SessionText { title: format!("T-{last} と T-{} の件", last - 1), ..s.clone() }), MachineMatch::Linked { .. }));
        let s = SessionText { title: format!("仕事 {last} と 仕事 {} の件", last - 1), ..s };
        let q = llm_query(&state, &m, &s, vec!["依頼 1".into(), "依頼 2".into()]).unwrap();
        assert_eq!(q.prompts, ["依頼 1", "依頼 2"]);
        assert_eq!(q.candidates.len(), atlas_report::tasks::links::LLM_CANDIDATES_MAX);
        assert_eq!(q.candidates_total, atlas_report::tasks::links::LLM_CANDIDATES_MAX + 5);
        let firsts: Vec<&str> = q.candidates.iter().take(2).map(|c| c.0.as_str()).collect();
        assert_eq!(firsts, [format!("T-{}", last - 1), format!("T-{last}")]);
        // 何日もかけて終えたタスク(完了が遅い)も、依頼の文(パケットに書くのと同じ文)と名前が重なれば、機械の当たりの次に入る
        state.tasks.insert("SLOW".into(), task("帳票の出力を速くする", Some("2026-11-30T00:00:00.000Z")));
        let m = Matcher::new(&state);
        let q = llm_query(&state, &m, &s, vec!["帳票の出力が遅いので直して".into()]).unwrap();
        assert_eq!((q.candidates[2].0.as_str(), q.candidates.len(), q.candidates_total), ("SLOW", atlas_report::tasks::links::LLM_CANDIDATES_MAX, atlas_report::tasks::links::LLM_CANDIDATES_MAX + 6));
        // パケットにも、候補を絞ったことを書く。manifest.json に残す候補の ID は、パケットと同じ並びと上限
        let md = atlas_judge::task_link::render_task_packet(&q);
        assert!(md.contains(&format!("全 {} 件のうち、題名と依頼の文に近いものから {} 件", q.candidates_total, q.candidates.len())), "{md}");
        let d = tempfile::tempdir().unwrap();
        let bm = atlas_judge::task_link::build_task_bundle(std::slice::from_ref(&q), &TaskBundleOptions { bundle_dir: d.path().join("tb"), per_part: None, boundary: None, scope: IndexMap::new(), now: None }).unwrap();
        assert_eq!(bm.sessions[0].candidates, q.candidates.iter().map(|c| c.0.clone()).collect::<Vec<_>>());
    }

    /// all は metrics の前にタスクを処理する(初めての集計でも --task で絞れる)。metrics は --config の稼働時間帯を使う
    #[test]
    fn aggregation_refresh_runs_before_metrics_and_metrics_uses_config() {
        let d = tempfile::tempdir().unwrap();
        let p = paths(d.path());
        let xml = d.path().join("export.xml");
        std::fs::write(&xml, fixture("export-before.xml")).unwrap();
        let t1 = atlas_core::jsdate::parse_ms("2026-11-20T00:00:00Z").unwrap();
        atlas_core::jsfs::utimes(&xml, t1, t1).unwrap();
        // 毎日 0:00〜24:00 を稼働時間帯にする(どの時間帯の PC でも、工数 = 開始から完了を確認した時刻まで)
        let cfg = d.path().join("atlas.config.json");
        std::fs::write(&cfg, serde_json::json!({ "tasks": { "file": "export.xml", "workHours": { "days": [1, 2, 3, 4, 5, 6, 7], "start": "00:00", "end": "24:00" } } }).to_string()).unwrap();
        let cfg_s = cfg.to_string_lossy().into_owned();
        let sessions = vec![rec("s1", "2026-11-20T01:00:00.000Z", "fix the app"), rec("s2", "2026-11-20T02:00:00.000Z", "雑談")];
        let file = serde_json::json!({
            "schemaVersion": 1, "generatedAt": "2026-11-23T00:00:00.000Z", "source": { "root": null, "snapshotDir": "x", "since": null },
            "counts": { "sessions": 2, "dbOnly": 0, "dirOnly": 0, "both": 0, "empty": 0 }, "installed": null,
            "warnings": { "unknownEventTypes": {}, "badLines": 0, "messages": [] }, "sessions": serde_json::to_value(&sessions).unwrap()
        });
        std::fs::create_dir_all(&p.out).unwrap();
        std::fs::write(&p.sessions, file.to_string()).unwrap();
        let filter = super::super::metrics::SessionFilter { task: Some("DEMO-101".into()), ..Default::default() };
        // タスクを処理する前は、知らないタスクとして止まる
        assert!(super::super::metrics::run_metrics(&p, &filter, Some(&cfg_s), &|_| {}).is_err());
        assert!(refresh_for_aggregation(&p, Some(&cfg_s), "all", &|_| {}).unwrap().is_some());
        std::fs::write(&xml, fixture("export-after.xml")).unwrap();
        let t2 = atlas_core::jsdate::parse_ms("2026-11-21T01:00:00Z").unwrap();
        atlas_core::jsfs::utimes(&xml, t2, t2).unwrap();
        let r = refresh_for_aggregation(&p, Some(&cfg_s), "all", &|_| {}).unwrap().unwrap();
        assert!(r.state.tasks["DEMO-101"].done_observed);
        super::super::metrics::run_metrics(&p, &filter, Some(&cfg_s), &|_| {}).unwrap();
        let csv = std::fs::read_to_string(p.out.join("tables").join("tasks.csv")).unwrap();
        let row: Vec<&str> = csv.lines().find(|l| l.starts_with("DEMO-101,")).unwrap().split(',').collect();
        // 開始 11/20 1:00 → 完了を確認した時刻 11/21 1:00 = 24 時間(--config の稼働時間帯)
        assert_eq!(row[8], "24");
        // 初めから完了していたタスク(DEMO-104)は、完了の時刻が分からない
        let view = build_view(&p, &load_task_config(Some(&cfg_s)), false, &sessions, &sessions.iter().collect::<Vec<_>>(), None, &HashMap::new()).unwrap();
        let t104 = view.items.iter().find(|t| t.id == "DEMO-104").unwrap();
        assert!(t104.done && !t104.done_observed);
        // 全部のセッションで作れば scoped ではなく、絞れば scoped
        assert!(!view.scoped);
        let one = build_view(&p, &load_task_config(Some(&cfg_s)), false, &sessions, &[&sessions[0]], None, &HashMap::new()).unwrap();
        assert!(one.scoped);
    }

    /// judgments.json は、レポートと同じゆるい読み方で読む(必須の項目が欠けた判定でも、時間があれば数える)
    #[test]
    fn judgment_hours_reads_like_the_report() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("judgments.json");
        assert!(judgment_hours(&p).is_empty());
        std::fs::write(&p, serde_json::json!({ "schemaVersion": 1, "items": [{ "sessionId": "s1", "humanEffort": { "hours": 3 } }, { "sessionId": "s2", "humanEffort": { "hours": 2, "confidence": 0.2 } }] }).to_string()).unwrap();
        let h = judgment_hours(&p);
        assert_eq!(h["s1"], (3.0, None));
        assert_eq!(h["s2"], (2.0, Some(0.2)));
        std::fs::write(&p, "{").unwrap();
        assert!(judgment_hours(&p).is_empty());
    }
}
