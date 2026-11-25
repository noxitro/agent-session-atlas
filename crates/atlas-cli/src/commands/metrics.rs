//! atlas metrics(packages/cli/src/commands.ts の runMetrics・writeTables と、CLI の絞り込み
//! SessionFilter・hasFilter・filterSessions・resolveIdFilter・describeFilter・selectSessions の移植)。
//! ログの文言は TS 版と同じ(out/tables/ の failures.csv と、その件数の注記は TS 版に無い)。

use super::Log;
use crate::paths::Paths;
use crate::tables::{build_tables, write_sqlite, TablePaths, SQLITE_FILE};
use anyhow::{anyhow, bail, Result};
use atlas_core::failure_ledger::MAX_ROWS;
use atlas_core::jsdate;
use atlas_core::metrics::{compute_metrics, is_empty_session};
use atlas_core::tables::{failures_table, to_csv, Cell};
use atlas_core::types::{MetricsFile, SessionRecord, SessionsFile};
use atlas_report::filter::{matches_base, BaseFilter};
use atlas_report::ids::resolve_id_prefixes;
use atlas_report::test_tables::{session_cells, test_tables, SESSION_COLUMNS};
use std::collections::HashSet;
use std::path::Path;

/// CLI の絞り込み(--since・--project・--client・--model・--branch・--session・--task)
#[derive(Debug, Clone, Default)]
pub struct SessionFilter {
    pub since: Option<String>,
    pub project: Option<String>,
    pub client: Option<String>,
    pub model: Option<String>,
    pub branch: Option<String>,
    /// 特定のセッション(id の先頭一致。解決前)
    pub sessions: Option<Vec<String>>,
    /// 管理ツールのタスクの ID(そのタスクに紐づいたセッションだけ)
    pub task: Option<String>,
}

/// JS の真偽(空文字・None は偽)
fn set(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|s| !s.is_empty())
}

impl SessionFilter {
    pub fn from_cli(o: &crate::args::CliOptions) -> Self {
        SessionFilter {
            since: o.since.clone(),
            project: o.project.clone(),
            client: o.client.clone(),
            model: o.model.clone(),
            branch: o.branch.clone(),
            sessions: o.sessions.clone(),
            task: o.task.clone(),
        }
    }
}

pub fn has_filter(f: &SessionFilter) -> bool {
    set(&f.since).is_some()
        || set(&f.project).is_some()
        || set(&f.client).is_some()
        || set(&f.model).is_some()
        || set(&f.branch).is_some()
        || f.sessions.as_ref().is_some_and(|s| !s.is_empty())
        || set(&f.task).is_some()
}

/// CLI のフィルタ。--project は完全一致するキーがあればそれだけ、無ければ部分一致(大文字小文字を区別しない)。
/// --since は core の snapshot と同じく「その時刻以降に更新された」セッション。
/// ids は --session を解決した後のセッション id の集合(None なら制限なし)。他の条件と AND。
#[allow(dead_code)] // build・bundle・turns の移植(段 4・6)で使う。今はテストだけ
pub fn filter_sessions<'a>(sessions: &'a [SessionRecord], f: &SessionFilter, ids: Option<&HashSet<String>>) -> (Vec<&'a SessionRecord>, Vec<String>) {
    let (index, projects) = filter_session_index(sessions, f, ids);
    (index.into_iter().map(|i| &sessions[i]).collect(), projects)
}

/// filter_sessions の、残ったセッションの位置(元の順)を返す版
pub fn filter_session_index(sessions: &[SessionRecord], f: &SessionFilter, ids: Option<&HashSet<String>>) -> (Vec<usize>, Vec<String>) {
    let mut projects: Vec<String> = Vec::new();
    if let Some(want) = set(&f.project) {
        let mut seen: HashSet<&str> = HashSet::new();
        let keys: Vec<&str> = sessions.iter().map(|s| s.project.as_str()).filter(|k| seen.insert(k)).collect();
        let exact: Vec<&str> = keys.iter().copied().filter(|k| *k == want).collect();
        let lw = atlas_core::js::to_lower(want);
        projects = if exact.is_empty() { keys.into_iter().filter(|k| atlas_core::js::to_lower(k).contains(&lw)).map(str::to_string).collect() } else { exact.into_iter().map(str::to_string).collect() };
    }
    let pset: HashSet<&str> = projects.iter().map(String::as_str).collect();
    // Date.parse が NaN のとき(引数の検査で弾くので普通は起きない)は、比べると常に偽なので何も外さない
    let since_ms: Option<Option<i64>> = set(&f.since).map(jsdate::parse_ms);
    let base = BaseFilter { client: f.client.as_deref().unwrap_or(""), model: f.model.as_deref().unwrap_or(""), branch: f.branch.as_deref().unwrap_or(""), ..Default::default() };
    let out = sessions
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            if ids.is_some_and(|ids| !ids.contains(&s.id)) {
                return false;
            }
            if set(&f.project).is_some() && !pset.contains(s.project.as_str()) {
                return false;
            }
            if !matches_base(*s, &base) {
                return false;
            }
            if let Some(since) = since_ms {
                let t = s.updated_at.as_deref().or(s.created_at.as_deref()).and_then(|x| if x.is_empty() { None } else { jsdate::parse_ms(x) });
                match (t, since) {
                    (None, _) => return false,
                    (Some(t), Some(since)) if t < since => return false,
                    _ => {}
                }
            }
            true
        })
        .map(|(i, _)| i)
        .collect();
    (out, projects)
}

/// --session を解決したもの
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedIds {
    /// 他の条件と AND する id の集合
    pub set: HashSet<String>,
    pub session_ids: Vec<String>,
}

/// --session をセッション id の集合に解決する(無ければ None)。曖昧な id・記録に無い id はエラー(黙って 0 件にしない)。
pub fn resolve_id_filter(all: &[SessionRecord], f: &SessionFilter) -> Result<Option<ResolvedIds>> {
    let Some(prefixes) = f.sessions.as_ref().filter(|s| !s.is_empty()) else { return Ok(None) };
    let known: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
    let session_ids = resolve_id_prefixes(&known, prefixes)?;
    Ok(Some(ResolvedIds { set: session_ids.iter().cloned().collect(), session_ids }))
}

fn describe_filter(f: &SessionFilter, projects: &[String], ids: Option<&ResolvedIds>, task_sessions: Option<usize>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(v) = set(&f.since) {
        parts.push(format!("since={v}"));
    }
    if let Some(v) = set(&f.project) {
        parts.push(format!("project={v}(該当 {} プロジェクト)", projects.len()));
    }
    if let Some(v) = set(&f.client) {
        parts.push(format!("client={v}"));
    }
    if let Some(v) = set(&f.model) {
        parts.push(format!("model={v}"));
    }
    if let Some(v) = set(&f.branch) {
        parts.push(format!("branch={v}"));
    }
    if let (true, Some(ids)) = (f.sessions.as_ref().is_some_and(|s| !s.is_empty()), ids) {
        parts.push(format!("session={} 件", ids.session_ids.len()));
    }
    if let (Some(t), Some(n)) = (set(&f.task), task_sessions) {
        parts.push(format!("task={t}(紐づいたセッション {n} 件)"));
    }
    parts.join(", ")
}

/// JSON を読む(無ければ hint を添えたエラー)
fn read_json<T: serde::de::DeserializeOwned>(path: &Path, hint: &str) -> Result<T> {
    if !path.exists() {
        bail!("{} がありません。{hint}", path.display());
    }
    let text = std::fs::read(path).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?;
    atlas_core::js::parse_json_as(&String::from_utf8_lossy(&text)).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))
}

/// sessions.json と、絞り込んだ後のセッションの位置
pub struct Selected {
    pub file: SessionsFile,
    /// file.sessions の中の位置(元の順)
    pub index: Vec<usize>,
}

impl Selected {
    pub fn sessions(&self) -> Vec<&SessionRecord> {
        self.index.iter().map(|&i| &self.file.sessions[i]).collect()
    }
}

/// sessions.json を読む(無ければ hint を添えたエラー)
pub fn read_sessions_file(p: &Paths, hint: &str) -> Result<SessionsFile> {
    read_json(&p.sessions, hint)
}

/// sessions.json を読み、CLI の絞り込みを掛ける。共通のログも出す
pub fn select_sessions(p: &Paths, f: &SessionFilter, cmd: &str, hint: &str, log: Log<'_>) -> Result<Selected> {
    let file: SessionsFile = read_sessions_file(p, hint)?;
    select_from(p, file, f, cmd, log)
}

/// 読んだ sessions.json に CLI の絞り込みを掛ける(--task は今の紐づけで決める)
pub fn select_from(p: &Paths, file: SessionsFile, f: &SessionFilter, cmd: &str, log: Log<'_>) -> Result<Selected> {
    let mut ids = resolve_id_filter(&file.sessions, f)?;
    let mut task_sessions = None;
    if let Some(t) = set(&f.task) {
        let of_task = super::tasks::sessions_of_task(p, &file, t)?;
        task_sessions = Some(of_task.len());
        ids = Some(match ids {
            Some(r) => ResolvedIds { set: r.set.into_iter().filter(|id| of_task.contains(id)).collect(), session_ids: r.session_ids },
            None => ResolvedIds { set: of_task, session_ids: vec![] },
        });
    }
    // 位置で持つ(sessions.json を持ったまま返すため)
    let (index, projects) = filter_session_index(&file.sessions, f, ids.as_ref().map(|x| &x.set));
    if has_filter(f) {
        log(&format!("{cmd}: 絞り込み {} → {} / {} セッション", describe_filter(f, &projects, ids.as_ref(), task_sessions), index.len(), file.sessions.len()));
    }
    Ok(Selected { file, index })
}

/// out/tables/ に表も書く
/// config は設定ファイル(--config。無ければ環境変数 ATLAS_CONFIG かリポジトリ直下)。管理ツールのタスクの表(tasks.csv)の稼働時間帯に使う
pub fn run_metrics(p: &Paths, f: &SessionFilter, config: Option<&str>, log: Log<'_>) -> Result<MetricsFile> {
    let sel = select_sessions(p, f, "metrics", "先に atlas extract を実行してください。", log)?;
    let sessions = sel.sessions();
    let m = compute_metrics(&sessions, sel.file.installed.as_ref());
    std::fs::write(&p.metrics, atlas_core::json::to_js_string_pretty(&m)?)?;
    log(&format!(
        "metrics: {} セッション(空のセッション {} 件を除外)、{} プロジェクト、{} モデル、トークン記録なし(欠測){} セッション → {}",
        m.overall.sessions,
        m.empty_sessions,
        m.by_project.len(),
        m.by_model.len(),
        m.overall.sessions_missing_tokens,
        p.metrics.display()
    ));
    if let Some(s) = &m.installed_skills {
        log(&format!("metrics: インストール済みで未使用の skill {} / {} 件", s.unused.len(), s.installed.len()));
    }
    let cfg = super::tasks::load_task_config(config);
    let tasks = super::tasks::build_view(p, &cfg, super::tasks::tasks_read_only(p, &sel.file), &sel.file.sessions, &sessions, None, &super::tasks::judgment_hours(&p.judgments));
    write_tables(p, &sessions, tasks.as_ref(), "metrics", log)?;
    Ok(m)
}

/// sessions.csv(と SQLite の sessions)に足す、タスクの列(推定人手工数の列の後ろ)。
/// いくつかのタスクに紐づいたセッションは、taskId と taskName を TASK_JOIN でつなぐ(紐づけの順)。紐づけの出所はセッションごとに 1 つ。
/// タスクの数は紐づいたタスクの数(「どのタスクでもない」は 0、紐づけが無ければ空)。工数を等分する相手の数ではない
/// (一覧に無いタスクと、完了を確認した後に始めたセッションのタスクには数えないので、等分の割合は session-tasks.csv の按分で見る)
pub const TASK_SESSION_COLUMNS: [&str; 4] = ["taskId", "taskName", "紐づけの出所", "タスクの数"];
/// sessions.csv で、いくつかのタスクをつなぐ文字(1 件ずつ見るときは session-tasks.csv)
pub const TASK_JOIN: &str = "; ";

/// out/tables/session-tasks.csv(と SQLite の session_tasks)。セッション × 紐づいたタスクの 1 行ずつ。
/// 按分は、そのタスクに数えたセッションの値の割合(工数を数えるタスク(counted_task_ids)の数で等分。1 つなら 1)。
/// 一覧に無いタスクと、完了を確認した後に始めたセッションのタスクは 0(行は出す)
pub fn session_tasks_table(v: &atlas_report::tasks::view::TasksView) -> atlas_core::tables::Table {
    let header: Vec<String> = ["セッションID", "taskId", "taskName", "紐づけの出所", "按分"].iter().map(|s| s.to_string()).collect();
    let names: std::collections::HashMap<&str, &str> = v.items.iter().map(|t| (t.id.as_str(), t.name.as_str())).collect();
    let rows = v
        .links
        .iter()
        .flat_map(|(sid, l)| {
            let share = atlas_report::tasks::metrics::share_of(l.counted_task_ids.len());
            let names = &names;
            l.task_ids.iter().map(move |t| {
                let mine = if l.counted_task_ids.contains(t) { share } else { 0.0 };
                vec![sid.as_str().into(), t.as_str().into(), names.get(t.as_str()).copied().filter(|n| !n.is_empty()).map_or(Cell::Null, Cell::from), Cell::from(l.source.label()), Cell::Num(mine)]
            })
        })
        .collect();
    atlas_core::tables::Table { header, rows }
}

/// out/tables/tasks.csv(と SQLite の tasks)。タスクごとの工数
pub fn tasks_table(v: &atlas_report::tasks::view::TasksView) -> atlas_core::tables::Table {
    let header: Vec<String> = [
        "taskId",
        "taskName",
        "status",
        "完了",
        "XML に無い",
        "開始",
        "完了を確認した時刻",
        "完了時刻の出所",
        "稼働時間帯の工数(時間)",
        "AI の実働(時間)",
        "推定人手工数(時間)",
        "セッション数",
        "共有のセッション",
        "判定済み",
        "確度が低い",
        "判定なし",
        "紐づけ(機械)",
        "紐づけ(LLM)",
        "紐づけ(手動)",
        "比べられる",
        "比べない理由",
        // 詰まりを見る列(紐づいたセッションすべての値。等分しない。atlas_report::tasks::extras)
        "人数",
        "主なモデル",
        "主なモデルの割合",
        "ツールの失敗・拒否",
        "中断",
        "文脈圧縮",
        "判定した依頼",
        "判定できた作業の依頼",
        "直し",
        "不採用",
        "判定できた質問",
        "的外れ",
        "直しの割合",
        "不採用の割合",
        "的外れの割合",
        // 推定の幅(推定人手工数と同じ数え方。幅の無い推定があれば空)と、このタスクの比(比べられるタスクだけ)。前の版の列の並びを変えないよう後ろに足す
        "推定の幅の下(時間)",
        "推定の幅の上(時間)",
        "比(推定人手工数 ÷ 稼働時間帯の工数)",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let hours = |ms: f64| Cell::Num(atlas_core::js::round(ms / 36_000.0) / 100.0);
    let h2 = |h: Option<f64>| h.map_or(Cell::Null, |h| Cell::Num(atlas_core::js::round(h * 100.0) / 100.0));
    // 割合は 0〜1 の小数 3 桁(分母が下限に届かなければ空)
    let rate = |x: Option<f64>| x.map_or(Cell::Null, |x| Cell::Num(atlas_core::js::round(x * 1000.0) / 1000.0));
    let rows = v
        .items
        .iter()
        .map(|t| {
            vec![
                t.id.as_str().into(),
                t.name.as_str().into(),
                t.status.as_str().into(),
                Cell::Bool(t.done),
                Cell::Bool(t.missing),
                t.start.as_deref().into(),
                // 日付だけの完了日は、日付の文字("2026-11-20")をそのまま出す(見る PC の時間帯で日付がずれないように。出所にも添える)
                t.done_date.as_deref().or(t.done_at.as_deref()).into(),
                t.done_at_source.map_or(Cell::Null, |s| if t.done_date.is_some() { format!("{}(日付だけ)", s.label()).into() } else { s.label().into() }),
                t.work_ms.map_or(Cell::Null, hours),
                hours(t.ai_active_ms),
                Cell::Num(atlas_core::js::round(t.human_hours * 100.0) / 100.0),
                t.sessions.into(),
                t.shared_sessions.into(),
                t.judged_sessions.into(),
                t.low_confidence_sessions.into(),
                t.unjudged_sessions.into(),
                t.links.machine.into(),
                t.links.llm.into(),
                t.links.manual.into(),
                if t.sessions == 0 { Cell::Null } else { Cell::Bool(t.comparable) },
                t.excluded.map_or(Cell::Null, |e| e.label().into()),
                t.people.map_or(Cell::Null, Cell::from),
                t.main_model.as_deref().into(),
                t.main_model_share.map_or(Cell::Null, |x| Cell::Num(atlas_core::js::round(x * 1000.0) / 1000.0)),
                if t.sessions == 0 { Cell::Null } else { t.friction.tool_failures.into() },
                if t.sessions == 0 { Cell::Null } else { t.friction.aborts.into() },
                if t.sessions == 0 { Cell::Null } else { t.friction.compactions.into() },
                t.verdicts.as_ref().map_or(Cell::Null, |v| v.judged.into()),
                t.verdicts.as_ref().map_or(Cell::Null, |v| v.work_decided.into()),
                t.verdicts.as_ref().map_or(Cell::Null, |v| v.fix.into()),
                t.verdicts.as_ref().map_or(Cell::Null, |v| v.rejected.into()),
                t.verdicts.as_ref().map_or(Cell::Null, |v| v.question_decided.into()),
                t.verdicts.as_ref().map_or(Cell::Null, |v| v.off_target.into()),
                rate(t.verdicts.as_ref().and_then(|v| v.fix_rate)),
                rate(t.verdicts.as_ref().and_then(|v| v.rejected_rate)),
                rate(t.verdicts.as_ref().and_then(|v| v.off_target_rate)),
                if t.sessions == 0 { Cell::Null } else { h2(t.human_low) },
                if t.sessions == 0 { Cell::Null } else { h2(t.human_high) },
                h2(t.ratio),
            ]
        })
        .collect();
    atlas_core::tables::Table { header, rows }
}

/// 判定のぶれ(atlas_report::judgment_repeats)。セッションは表とレポートに載せるもの。
/// 判定の履歴(judgments-history.json。工数の判定のファイルの隣)が無ければ None。履歴か今の判定が読めなければ、注意を出して None
pub fn judgment_repeats_of(p: &Paths, sessions: &[&SessionRecord], cmd: &str, log: Log<'_>) -> Option<(Vec<atlas_report::judgment_repeats::RepeatPair>, atlas_report::judgment_repeats::JudgmentRepeats)> {
    let hp = atlas_judge::judgments_io::history_path(&p.judgments);
    if !hp.exists() {
        return None;
    }
    let read = |path: &std::path::Path| -> std::result::Result<serde_json::Value, String> {
        let b = std::fs::read(path).map_err(|e| e.to_string())?;
        atlas_core::js::parse_json(&String::from_utf8_lossy(&b)).map_err(|e| e.to_string())
    };
    let hist = match read(&hp).and_then(|v| atlas_report::judgments::parse_history(&v).map_err(|e| e.to_string())) {
        Ok(h) => h,
        Err(e) => {
            log(&format!("{cmd}: 注意 {} を読めないため、判定のぶれは出しません({e})", hp.display()));
            return None;
        }
    };
    let cur = if p.judgments.exists() {
        match read(&p.judgments).and_then(|v| atlas_report::judgments::parse_judgments(&v).map_err(|e| e.to_string())) {
            Ok(j) => j.by_session,
            Err(e) => {
                log(&format!("{cmd}: 注意 {} を読めないため、判定のぶれは出しません({e})", p.judgments.display()));
                return None;
            }
        }
    } else {
        indexmap::IndexMap::new()
    };
    let ss: Vec<atlas_report::judgment_repeats::RepeatSession<'_>> =
        sessions.iter().map(|s| atlas_report::judgment_repeats::RepeatSession { id: s.id.as_str(), end_ms: s.updated_at.as_deref().filter(|x| !x.is_empty()).and_then(atlas_core::jsdate::parse_ms) }).collect();
    Some(atlas_report::judgment_repeats::compute_repeats(&ss, &cur, &hist))
}

/// 判定のぶれの組ごとの表(judgment-repeats.csv と SQLite の judgment_repeats)。1 行が 1 組(古い判定と新しい判定)
pub fn judgment_repeats_table(pairs: &[atlas_report::judgment_repeats::RepeatPair], sessions: &[&SessionRecord]) -> atlas_core::tables::Table {
    let header: Vec<String> = [
        "sessionId",
        "project",
        "セッションの終わり",
        "古い判定の日時",
        "新しい判定の日時",
        "古い判定のモデル",
        "新しい判定のモデル",
        "達成(古い)",
        "達成(新しい)",
        "推定人手工数(古い)",
        "推定の幅の下(古い)",
        "推定の幅の上(古い)",
        "確信度(古い)",
        "推定人手工数(新しい)",
        "推定の幅の下(新しい)",
        "推定の幅の上(新しい)",
        "確信度(新しい)",
        "成果の質(古い)",
        "成果の質(新しい)",
        "手戻り(古い)",
        "手戻り(新しい)",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let by: std::collections::HashMap<&str, &SessionRecord> = sessions.iter().map(|s| (s.id.as_str(), *s)).collect();
    let num = |x: Option<f64>| x.map_or(Cell::Null, Cell::Num);
    let rows = pairs
        .iter()
        .map(|p| {
            let s = by.get(p.session_id.as_str());
            vec![
                p.session_id.as_str().into(),
                s.map(|s| s.project.as_str()).into(),
                s.and_then(|s| s.updated_at.as_deref()).into(),
                p.older.ran_at.as_str().into(),
                p.newer.ran_at.as_str().into(),
                p.older.model.as_deref().into(),
                p.newer.model.as_deref().into(),
                p.older.completed.map_or(Cell::Null, Cell::Bool),
                p.newer.completed.map_or(Cell::Null, Cell::Bool),
                num(p.older.hours),
                num(p.older.low),
                num(p.older.high),
                num(p.older.confidence),
                num(p.newer.hours),
                num(p.newer.low),
                num(p.newer.high),
                num(p.newer.confidence),
                num(p.older.quality),
                num(p.newer.quality),
                num(p.older.rework),
                num(p.newer.rework),
            ]
        })
        .collect();
    atlas_core::tables::Table { header, rows }
}

/// 表計算ソフトで開く表(依頼ごと・セッションごと・VCS の照合のまとまりごと・ツールの失敗と拒否ごと)を out/tables/ に書く。
/// metrics・build・export が、それぞれの絞り込みのセッションで書く(判定を取り込んだ後の export でも、判定の列が表に入るように)。
/// ツールの失敗と拒否ごとの表(failures.csv と SQLite の failures)と、テストの実行の表は、ここで足す
/// tasks は管理ツールのタスクの節(あれば tasks.csv を書き、sessions.csv のタスクの列を埋める。無ければ tasks.csv を残さない)
pub fn write_tables(p: &Paths, sessions: &[&SessionRecord], tasks: Option<&atlas_report::tasks::view::TasksView>, cmd: &str, log: Log<'_>) -> Result<()> {
    let dir = p.out.join("tables");
    std::fs::create_dir_all(&dir)?;
    let mut t = build_tables(sessions, &TablePaths { judgments: &p.judgments, turn_judgments: &p.turn_judgments, vcs_retention: Some(&p.vcs_retention) });
    for w in &t.warnings {
        log(&format!("{cmd}: 注意 {w}"));
    }
    std::fs::write(dir.join("turns.csv"), &t.turns)?;
    // 照合の結果が無くなったとき(vcs が失敗した等)は、前の vcs-hunks.csv を残さない
    match &t.vcs_hunks {
        Some(h) => std::fs::write(dir.join("vcs-hunks.csv"), h)?,
        None => atlas_core::jsfs::rm_force(&dir.join("vcs-hunks.csv"))?,
    }
    // 失敗の台帳の無い古い記録だけのときは、表を書かず、前の failures.csv も残さない(見出しだけの表は「失敗が 0 件」と読めてしまう)。
    // SQLite には、この関数の中の t.data に足して入れる
    let failures = failures_table(sessions);
    match &failures {
        Some(f) => std::fs::write(dir.join("failures.csv"), to_csv(&f.header, &f.rows))?,
        None => atlas_core::jsfs::rm_force(&dir.join("failures.csv"))?,
    }
    let with_failures = failures.is_some();
    if let Some(f) = failures {
        t.data.push(("failures".to_string(), f));
    }
    // sessions.csv(と SQLite の sessions)に、テストの列を、最初の依頼の列の前に足す
    if let Some((_, sess)) = t.data.iter_mut().find(|(n, _)| n == "sessions") {
        let at = sess.header.iter().position(|h| h == "最初の依頼(先頭)").unwrap_or(sess.header.len());
        sess.header.splice(at..at, SESSION_COLUMNS.iter().map(|h| h.to_string()));
        let by_id: std::collections::HashMap<&str, &SessionRecord> = sessions.iter().map(|s| (s.id.as_str(), *s)).collect();
        for row in &mut sess.rows {
            let cells = match &row[0] {
                Cell::Str(id) => by_id.get(id.as_str()).map(|r| session_cells(r)),
                _ => None,
            }
            .unwrap_or_else(|| SESSION_COLUMNS.iter().map(|_| Cell::Null).collect());
            row.splice(at..at, cells);
        }
        // タスクの列(推定人手工数の後ろ)。タスクの設定も記録も無ければ空
        let at = sess.header.iter().position(|h| h == "推定人手工数(時間)").map_or(sess.header.len(), |i| i + 1);
        sess.header.splice(at..at, TASK_SESSION_COLUMNS.iter().map(|h| h.to_string()));
        let names: std::collections::HashMap<&str, &str> = tasks.map(|v| v.items.iter().map(|t| (t.id.as_str(), t.name.as_str())).collect()).unwrap_or_default();
        for row in &mut sess.rows {
            let link = match (&row[0], tasks) {
                (Cell::Str(id), Some(v)) => v.links.get(id.as_str()),
                _ => None,
            };
            let cells = match link {
                Some(l) => {
                    // つないだ値が空(タスクが無い・名前がどれも分からない)なら NULL
                    let joined = |v: Vec<&str>| if v.iter().all(|x| x.is_empty()) { Cell::Null } else { Cell::from(v.join(TASK_JOIN).as_str()) };
                    vec![
                        joined(l.task_ids.iter().map(String::as_str).collect()),
                        joined(l.task_ids.iter().map(|t| names.get(t.as_str()).copied().unwrap_or("")).collect()),
                        Cell::from(l.source.label()),
                        l.task_ids.len().into(),
                    ]
                }
                None => vec![Cell::Null, Cell::Null, Cell::Null, Cell::Null],
            };
            row.splice(at..at, cells);
        }
        t.sessions = to_csv(&sess.header, &sess.rows);
    }
    // タスクごとの表と、セッション × タスクの表。タスクの設定も記録も無ければ書かず、前のものも残さない
    match tasks {
        Some(v) => {
            let tt = tasks_table(v);
            std::fs::write(dir.join("tasks.csv"), to_csv(&tt.header, &tt.rows))?;
            t.data.push(("tasks".to_string(), tt));
            let st = session_tasks_table(v);
            std::fs::write(dir.join("session-tasks.csv"), to_csv(&st.header, &st.rows))?;
            t.data.push(("session_tasks".to_string(), st));
        }
        None => {
            atlas_core::jsfs::rm_force(&dir.join("tasks.csv"))?;
            atlas_core::jsfs::rm_force(&dir.join("session-tasks.csv"))?;
        }
    }
    // テストの列を足してから書く
    std::fs::write(dir.join("sessions.csv"), &t.sessions)?;
    // 判定のぶれの組ごとの表。判定の履歴が無ければ書かず、前のものも残さない(履歴があって組が 0 なら見出しだけを書く。組が無いことは本当なので)
    match judgment_repeats_of(p, sessions, cmd, log) {
        Some((pairs, _)) => {
            let rt = judgment_repeats_table(&pairs, sessions);
            std::fs::write(dir.join("judgment-repeats.csv"), to_csv(&rt.header, &rt.rows))?;
            t.data.push(("judgment_repeats".to_string(), rt));
        }
        None => atlas_core::jsfs::rm_force(&dir.join("judgment-repeats.csv"))?,
    }
    // 前の版が書いた課題 × 条件の表(conditions.csv)は、もう作らないので残さない
    atlas_core::jsfs::rm_force(&dir.join("conditions.csv"))?;
    // テストの実行が 1 回も無ければ書かず、前のものも残さない(見出しだけの表は「0 件」と読めてしまう)
    let listed_sessions: Vec<&SessionRecord> = sessions.iter().filter(|s| !is_empty_session(s)).copied().collect();
    let tests = test_tables(&listed_sessions);
    for (file, table) in [("test-runs.csv", tests.as_ref().map(|x| &x.runs)), ("test-results.csv", tests.as_ref().map(|x| &x.results)), ("test-counts.csv", tests.as_ref().map(|x| &x.counts))] {
        match table {
            Some(tb) => std::fs::write(dir.join(file), to_csv(&tb.header, &tb.rows))?,
            None => atlas_core::jsfs::rm_force(&dir.join(file))?,
        }
    }
    let with_tests = tests.is_some();
    if let Some(x) = tests {
        t.data.push(("test_runs".to_string(), x.runs));
        t.data.push(("test_results".to_string(), x.results));
        t.data.push(("test_counts".to_string(), x.counts));
    }
    // 表に載せるセッション(空のセッションを除く)のうち、行数の上限で載せなかった失敗・拒否の数と、台帳の無い記録の数
    let listed = || sessions.iter().filter(|s| !is_empty_session(s));
    let dropped: i64 = listed().filter(|s| s.analysis.failures.is_some()).filter_map(|s| s.analysis.failures_dropped).sum();
    let no_ledger = listed().filter(|s| s.analysis.failures.is_none()).count();
    let sqlite = match write_sqlite(&dir.join(SQLITE_FILE), &t.data) {
        Ok(()) => format!("・{SQLITE_FILE}"),
        Err(e) => {
            log(&format!("{cmd}: 注意 {SQLITE_FILE} を書けませんでした({e})。CSV は書きました"));
            String::new()
        }
    };
    log(&format!(
        "{cmd}: 表 → {}・sessions.csv{}{}{}{}{sqlite}{}{}{}{}",
        dir.join("turns.csv").display(),
        if tasks.is_some() { "・tasks.csv・session-tasks.csv" } else { "" },
        if t.vcs_hunks.is_some() { "・vcs-hunks.csv" } else { "" },
        if with_failures { "・failures.csv" } else { "" },
        if with_tests { "・test-runs.csv・test-results.csv・test-counts.csv" } else { "" },
        if t.with_verdicts { "(依頼ごとの判定の列つき)" } else { "" },
        if t.with_retention { "(VCS の照合の列つき)" } else { "" },
        if dropped > 0 { format!("(1 セッション {MAX_ROWS} 行の上限で failures.csv に載せていない失敗・拒否 {dropped} 件)") } else { String::new() },
        if no_ledger > 0 { format!("(失敗の台帳が無い古い記録 {no_ledger} セッションは failures.csv に入りません。集計し直すと付きます)") } else { String::new() }
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::normalize::{normalize_session, NormalizeInput};
    use atlas_core::types::WorkspaceInfo;

    fn mk(id: &str, repository: &str, client: &str, at: &str) -> SessionRecord {
        let ws = WorkspaceInfo { repository: Some(repository.into()), client_name: Some(client.into()), created_at: Some(at.into()), updated_at: Some(at.into()), ..Default::default() };
        let mut it = std::iter::empty();
        normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: Some(&ws), db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
    }

    fn ids(v: &[&SessionRecord]) -> Vec<String> {
        v.iter().map(|s| s.id.clone()).collect()
    }

    #[test]
    fn filters_like_the_ts_cli() {
        let rs = vec![
            mk("1", "quokka/app", "github/cli", "2026-07-01T00:00:00Z"),
            mk("2", "quokka/app-docs", "github/autopilot", "2026-09-01T00:00:00Z"),
            mk("3", "other/x", "github/cli", "2026-10-01T00:00:00Z"),
        ];
        let none = SessionFilter::default();
        assert!(!has_filter(&none));
        assert!(has_filter(&SessionFilter { sessions: Some(vec!["1".into()]), ..Default::default() }));
        assert!(!has_filter(&SessionFilter { sessions: Some(vec![]), ..Default::default() }));
        let cli = SessionFilter { client: Some("github/cli".into()), ..Default::default() };
        let set12: HashSet<String> = ["1".to_string(), "2".to_string()].into_iter().collect();
        assert_eq!(ids(&filter_sessions(&rs, &cli, Some(&set12)).0), ["1"]);

        let s2 = SessionFilter { sessions: Some(vec!["2".into()]), ..Default::default() };
        let r = resolve_id_filter(&rs, &s2).unwrap().unwrap();
        assert_eq!(r.set.iter().collect::<Vec<_>>(), ["2"]);
        assert_eq!(ids(&filter_sessions(&rs, &cli, Some(&r.set)).0), Vec::<String>::new());
        assert!(resolve_id_filter(&rs, &SessionFilter { sessions: Some(vec!["9".into()]), ..Default::default() }).unwrap_err().to_string().contains("記録にありません"));
        assert!(resolve_id_filter(&rs, &none).unwrap().is_none());

        assert_eq!(ids(&filter_sessions(&rs, &SessionFilter { project: Some("quokka/app".into()), ..Default::default() }, None).0), ["1"]);
        let (partial, mut projects) = filter_sessions(&rs, &SessionFilter { project: Some("QUOKKA".into()), ..Default::default() }, None);
        assert_eq!(ids(&partial), ["1", "2"]);
        projects.sort();
        assert_eq!(projects, ["quokka/app", "quokka/app-docs"]);
        assert_eq!(ids(&filter_sessions(&rs, &cli, None).0), ["1", "3"]);
        assert_eq!(ids(&filter_sessions(&rs, &SessionFilter { since: Some("2026-08-15".into()), ..Default::default() }, None).0), ["2", "3"]);
        let both = SessionFilter { client: Some("github/cli".into()), sessions: Some(vec!["1".into(), "2".into()]), ..Default::default() };
        assert_eq!(describe_filter(&both, &[], Some(&ResolvedIds { set: HashSet::new(), session_ids: vec!["1".into(), "2".into()] }), None), "client=github/cli, session=2 件");
    }

    /// 失敗 1 件と拒否 1 件のあるセッション(イベントは架空のもの)
    fn failing(id: &str) -> SessionRecord {
        use atlas_core::types::CopilotEvent;
        use serde_json::json;
        const T0: i64 = 1_794_009_600_000; // 2026-11-06T00:00:00.000Z
        let ev = |dt: i64, kind: &str, data: serde_json::Value| -> std::io::Result<CopilotEvent> {
            Ok(CopilotEvent { kind: kind.into(), data: Some(data), timestamp: Some(json!(jsdate::to_iso(T0 + dt))), ..Default::default() })
        };
        let events = vec![
            ev(0, "session.start", json!({ "context": { "cwd": "X:\\synthetic-p" } })),
            ev(1000, "user.message", json!({ "content": "直して" })),
            ev(1100, "tool.execution_start", json!({ "toolCallId": "a", "toolName": "view", "arguments": { "path": "X:\\synthetic-p\\a.ts" } })),
            ev(1350, "tool.execution_complete", json!({ "toolCallId": "a", "success": false, "error": { "code": "failure", "message": "Path does not exist" } })),
            ev(1400, "tool.execution_start", json!({ "toolCallId": "b", "toolName": "edit", "arguments": { "path": "X:\\synthetic-p\\a.ts" } })),
            ev(1500, "tool.execution_complete", json!({ "toolCallId": "b", "success": false, "error": { "code": "denied", "message": "denied by user" } })),
        ];
        let mut it = events.into_iter();
        normalize_session(NormalizeInput { id: id.into(), has_dir: None, workspace: None, db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap()
    }

    fn sqlite_tables(path: &Path) -> Vec<String> {
        let db = rusqlite::Connection::open(path).unwrap();
        let names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        names
    }

    /// out/tables/ には failures.csv と SQLite の failures を書く。台帳の無い古い記録だけなら書かず、前のファイルも残さない
    #[test]
    fn write_tables_adds_failures_when_there_is_a_ledger() {
        use crate::paths::{resolve_paths, PathInputs};
        let tmp = tempfile::tempdir().unwrap();
        let (home, out, notes) = (tmp.path().join("home"), tmp.path().join("out"), tmp.path().join("notes"));
        let p = resolve_paths(PathInputs { home: Some(&home.to_string_lossy()), out: Some(&out.to_string_lossy()), judgments: None, bundle: None, notes_dir: Some(&notes.to_string_lossy()) });
        let logs = std::sync::Mutex::new(Vec::<String>::new());
        let log = |m: &str| logs.lock().unwrap().push(m.to_string());
        let last = || logs.lock().unwrap().last().cloned().unwrap();
        let dir = p.out.join("tables");
        let csv = dir.join("failures.csv");

        let rec = failing("00000000-0000-4000-8000-000000000031");
        write_tables(&p, &[&rec], None, "metrics", &log).unwrap();
        let text = std::fs::read_to_string(&csv).unwrap();
        let lines: Vec<&str> = text.trim_end().split("\r\n").collect();
        assert!(lines[0].starts_with("\u{feff}セッションID,セッション名,プロジェクト,依頼番号,開始,種類,要因,ツール,"), "{}", lines[0]);
        assert_eq!(lines.len(), 3);
        assert!(last().contains("・sessions.csv・failures.csv・atlas.sqlite"), "{}", last());
        assert!(!last().contains("古い記録") && !last().contains("上限"), "{}", last());
        assert_eq!(sqlite_tables(&dir.join(SQLITE_FILE)), ["failures", "sessions", "turns"]);
        {
            let db = rusqlite::Connection::open(dir.join(SQLITE_FILE)).unwrap();
            // 列名は CSV の見出しと同じ
            let cols: Vec<String> = db.prepare("SELECT name FROM pragma_table_info('failures')").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
            assert_eq!(cols, lines[0].trim_start_matches('\u{feff}').split(',').collect::<Vec<_>>());
            // 数と真偽は REAL、文は TEXT、値の無いところは NULL(呼び直しは、その後がツールのときだけ)
            let types: Vec<Vec<String>> = db
                .prepare(r#"SELECT typeof("依頼番号"), typeof("開始"), typeof("所要(ミリ秒)"), typeof("エラー文"), typeof("要因"), typeof("呼び直し") FROM failures ORDER BY rowid"#)
                .unwrap()
                .query_map([], |r| (0..6).map(|i| r.get(i)).collect())
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_eq!(types, [["real", "text", "real", "text", "text", "real"], ["real", "text", "real", "text", "text", "null"]]);
            let rows: Vec<(f64, String, String, f64, String, Option<f64>)> = db
                .prepare(r#"SELECT "依頼番号", "種類", "要因", "所要(ミリ秒)", "その後", "呼び直し" FROM failures ORDER BY rowid"#)
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_eq!(rows, [(1.0, "失敗".to_string(), "対象が見つからない".to_string(), 250.0, "ツール".to_string(), Some(0.0)), (1.0, "拒否".to_string(), String::new(), 100.0, "続きなし".to_string(), None)]);
            // 依頼番号で turns と結べる
            let joined: i64 = db.query_row(r#"SELECT count(*) FROM failures f JOIN turns t ON t."セッションID" = f."セッションID" AND t."依頼番号" = f."依頼番号""#, [], |r| r.get(0)).unwrap();
            assert_eq!(joined, 2);
        }

        // 台帳の無い古い記録だけ: 表を書かず、前の failures.csv を消す。SQLite にも入れない
        let mut old = rec.clone();
        old.analysis.failures = None;
        old.analysis.failures_dropped = None;
        write_tables(&p, &[&old], None, "metrics", &log).unwrap();
        assert!(!csv.exists());
        assert_eq!(sqlite_tables(&dir.join(SQLITE_FILE)), ["sessions", "turns"]);
        assert!(!last().contains("・failures.csv"), "{}", last());
        assert!(last().contains("(失敗の台帳が無い古い記録 1 セッションは failures.csv に入りません。集計し直すと付きます)"), "{}", last());

        // 混ざっているとき: 台帳のある記録の行だけを書き、載せていない件数を知らせる
        let mut capped = failing("00000000-0000-4000-8000-000000000032");
        capped.analysis.failures_dropped = Some(3);
        write_tables(&p, &[&old, &capped], None, "build", &log).unwrap();
        let text = std::fs::read_to_string(&csv).unwrap();
        assert_eq!(text.trim_end().split("\r\n").skip(1).map(|l| l.split(',').next().unwrap()).collect::<Vec<_>>(), vec![capped.id.as_str(); 2]);
        assert_eq!(sqlite_tables(&dir.join(SQLITE_FILE)), ["failures", "sessions", "turns"]);
        assert!(last().starts_with("build: 表 → "), "{}", last());
        assert!(last().contains(&format!("(1 セッション {MAX_ROWS} 行の上限で failures.csv に載せていない失敗・拒否 3 件)")), "{}", last());
        assert!(last().contains("(失敗の台帳が無い古い記録 1 セッション"), "{}", last());
    }
}
