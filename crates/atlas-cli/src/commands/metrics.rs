//! atlas metrics(packages/cli/src/commands.ts の runMetrics・writeTables と、CLI の絞り込み
//! SessionFilter・hasFilter・filterSessions・resolveIdFilter・describeFilter・selectSessions の移植)。
//! ログの文言は TS 版と同じ。

use super::Log;
use crate::paths::Paths;
use crate::tables::{build_tables, write_sqlite, TablePaths, SQLITE_FILE};
use anyhow::{anyhow, bail, Result};
use atlas_core::jsdate;
use atlas_core::metrics::compute_metrics;
use atlas_core::types::{MetricsFile, SessionRecord, SessionsFile};
use atlas_report::filter::{matches_base, BaseFilter};
use atlas_report::groups::{load_groups, resolve_id_prefixes, LoadedGroups};
use std::collections::HashSet;
use std::path::Path;

/// CLI の絞り込み(--since・--project・--client・--model・--branch・--group・--session)
#[derive(Debug, Clone, Default)]
pub struct SessionFilter {
    pub since: Option<String>,
    pub project: Option<String>,
    pub client: Option<String>,
    pub model: Option<String>,
    pub branch: Option<String>,
    /// 名前付きグループ(groups.json)の名前
    pub group: Option<String>,
    /// 特定のセッション(id の先頭一致。解決前)
    pub sessions: Option<Vec<String>>,
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
            group: o.group.clone(),
            sessions: o.sessions.clone(),
        }
    }
}

pub fn has_filter(f: &SessionFilter) -> bool {
    set(&f.since).is_some()
        || set(&f.project).is_some()
        || set(&f.client).is_some()
        || set(&f.model).is_some()
        || set(&f.branch).is_some()
        || set(&f.group).is_some()
        || f.sessions.as_ref().is_some_and(|s| !s.is_empty())
}

/// CLI のフィルタ。--project は完全一致するキーがあればそれだけ、無ければ部分一致(大文字小文字を区別しない)。
/// --since は core の snapshot と同じく「その時刻以降に更新された」セッション。
/// ids は --group / --session を解決した後のセッション id の集合(None なら制限なし)。他の条件と AND。
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

/// --group と --session を解決したもの
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedIds {
    /// 他の条件と AND する id の集合
    pub set: HashSet<String>,
    pub group_total: usize,
    pub group_known: usize,
    pub session_ids: Vec<String>,
}

/// --group と --session をセッション id の集合に解決する(どちらも無ければ None)。
/// グループが無い名前・曖昧な id・記録に無い id はエラー(黙って 0 件にしない)。グループの ids に記録に無い id があるのは許す(件数だけ知らせる)。
pub fn resolve_id_filter(all: &[SessionRecord], f: &SessionFilter, groups: &LoadedGroups) -> Result<Option<ResolvedIds>> {
    let sessions_given = f.sessions.as_ref().is_some_and(|s| !s.is_empty());
    if set(&f.group).is_none() && !sessions_given {
        return Ok(None);
    }
    let known: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
    let known_set: HashSet<&str> = known.iter().copied().collect();
    let mut result: Option<HashSet<String>> = None;
    let (mut group_total, mut group_known) = (0usize, 0usize);
    if let Some(name) = set(&f.group) {
        let Some(g) = groups.groups.iter().find(|x| x.name == name) else {
            let names: Vec<&str> = groups.groups.iter().map(|x| x.name.as_str()).collect();
            if groups.exists {
                bail!(
                    "グループ「{name}」は {} にありません{}{}",
                    groups.path,
                    if names.is_empty() { String::new() } else { format!("(あるのは: {})", names.join(", ")) },
                    if groups.warnings.is_empty() { String::new() } else { format!("。読めなかった箇所: {}", groups.warnings.join(" / ")) }
                );
            }
            bail!("グループ「{name}」を探す {} がありません(atlas group add で作れます。場所は --notes-dir で変えられます)", groups.path);
        };
        result = Some(g.ids.iter().cloned().collect());
        group_total = g.ids.len();
        group_known = g.ids.iter().filter(|id| known_set.contains(id.as_str())).count();
    }
    let mut session_ids: Vec<String> = Vec::new();
    if let Some(prefixes) = f.sessions.as_ref().filter(|s| !s.is_empty()) {
        session_ids = resolve_id_prefixes(&known, prefixes)?;
        let s: HashSet<String> = session_ids.iter().cloned().collect();
        result = Some(match result {
            Some(set) => set.into_iter().filter(|id| s.contains(id)).collect(),
            None => s,
        });
    }
    Ok(Some(ResolvedIds { set: result.unwrap_or_default(), group_total, group_known, session_ids }))
}

fn describe_filter(f: &SessionFilter, projects: &[String], ids: Option<&ResolvedIds>) -> String {
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
    if let (Some(g), Some(ids)) = (set(&f.group), ids) {
        parts.push(format!("group={g}({} / {} 件が記録にある)", ids.group_known, ids.group_total));
    }
    if let (true, Some(ids)) = (f.sessions.as_ref().is_some_and(|s| !s.is_empty()), ids) {
        parts.push(format!("session={} 件", ids.session_ids.len()));
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
    #[allow(dead_code)] // build の移植(段 4)で使う
    pub groups: LoadedGroups,
}

impl Selected {
    pub fn sessions(&self) -> Vec<&SessionRecord> {
        self.index.iter().map(|&i| &self.file.sessions[i]).collect()
    }
}

/// sessions.json を読み、groups.json を読み(無ければ空)、CLI の絞り込みを掛ける。共通のログも出す
pub fn select_sessions(p: &Paths, f: &SessionFilter, cmd: &str, hint: &str, log: Log<'_>) -> Result<Selected> {
    let file: SessionsFile = read_json(&p.sessions, hint)?;
    let groups = load_groups(&p.groups);
    for w in &groups.warnings {
        log(&format!("{cmd}: 注意 {w}"));
    }
    let ids = resolve_id_filter(&file.sessions, f, &groups)?;
    // 位置で持つ(sessions.json を持ったまま返すため)
    let (index, projects) = filter_session_index(&file.sessions, f, ids.as_ref().map(|x| &x.set));
    if has_filter(f) {
        log(&format!("{cmd}: 絞り込み {} → {} / {} セッション", describe_filter(f, &projects, ids.as_ref()), index.len(), file.sessions.len()));
    }
    Ok(Selected { file, index, groups })
}

/// tables: out/tables/ に表も書く(伏せ字版の all では書かない。依頼文とパスがそのまま入るため)
pub fn run_metrics(p: &Paths, f: &SessionFilter, log: Log<'_>, tables: bool) -> Result<MetricsFile> {
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
    if tables {
        write_tables(p, &sessions, "metrics", log)?;
    }
    Ok(m)
}

/// 表計算ソフトで開く表(依頼ごと・セッションごと)を out/tables/ に書く。metrics・build・export が、それぞれの絞り込みのセッションで書く
/// (判定を取り込んだ後の export でも、判定の列が表に入るように)
pub fn write_tables(p: &Paths, sessions: &[&SessionRecord], cmd: &str, log: Log<'_>) -> Result<()> {
    let dir = p.out.join("tables");
    std::fs::create_dir_all(&dir)?;
    let t = build_tables(sessions, &TablePaths { judgments: &p.judgments, turn_judgments: &p.turn_judgments, vcs_retention: Some(&p.vcs_retention) });
    for w in &t.warnings {
        log(&format!("{cmd}: 注意 {w}"));
    }
    std::fs::write(dir.join("turns.csv"), &t.turns)?;
    std::fs::write(dir.join("sessions.csv"), &t.sessions)?;
    // 照合の結果が無くなったとき(vcs が失敗した等)は、前の vcs-hunks.csv を残さない
    match &t.vcs_hunks {
        Some(h) => std::fs::write(dir.join("vcs-hunks.csv"), h)?,
        None => atlas_core::jsfs::rm_force(&dir.join("vcs-hunks.csv"))?,
    }
    let sqlite = match write_sqlite(&dir.join(SQLITE_FILE), &t.data) {
        Ok(()) => format!("・{SQLITE_FILE}"),
        Err(e) => {
            log(&format!("{cmd}: 注意 {SQLITE_FILE} を書けませんでした({e})。CSV は書きました"));
            String::new()
        }
    };
    log(&format!(
        "{cmd}: 表 → {}・sessions.csv{}{sqlite}{}{}",
        dir.join("turns.csv").display(),
        if t.vcs_hunks.is_some() { "・vcs-hunks.csv" } else { "" },
        if t.with_verdicts { "(依頼ごとの判定の列つき)" } else { "" },
        if t.with_retention { "(VCS の照合の列つき)" } else { "" }
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::normalize::{normalize_session, NormalizeInput};
    use atlas_core::types::WorkspaceInfo;
    use atlas_report::groups::SessionGroup;

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
        assert!(has_filter(&SessionFilter { group: Some("g".into()), ..Default::default() }));
        assert!(has_filter(&SessionFilter { sessions: Some(vec!["1".into()]), ..Default::default() }));
        assert!(!has_filter(&SessionFilter { sessions: Some(vec![]), ..Default::default() }));
        let cli = SessionFilter { client: Some("github/cli".into()), ..Default::default() };
        let set12: HashSet<String> = ["1".to_string(), "2".to_string()].into_iter().collect();
        assert_eq!(ids(&filter_sessions(&rs, &cli, Some(&set12)).0), ["1"]);

        let groups = LoadedGroups { path: "g.json".into(), exists: true, groups: vec![SessionGroup { name: "g".into(), note: "".into(), ids: vec!["1".into(), "3".into(), "x".into()] }], warnings: vec![] };
        let g = SessionFilter { group: Some("g".into()), ..Default::default() };
        let r = resolve_id_filter(&rs, &g, &groups).unwrap().unwrap();
        let mut got: Vec<&String> = r.set.iter().collect();
        got.sort();
        assert_eq!(got, ["1", "3", "x"]);
        assert_eq!((r.group_total, r.group_known), (3, 2));
        assert_eq!(ids(&filter_sessions(&rs, &g, Some(&r.set)).0), ["1", "3"]);
        let nope = SessionFilter { group: Some("nope".into()), ..Default::default() };
        let e = resolve_id_filter(&rs, &nope, &groups).unwrap_err().to_string();
        assert!(e.contains("「nope」") && e.contains("あるのは: g"), "{e}");
        let missing = LoadedGroups { exists: false, groups: vec![], ..groups.clone() };
        assert!(resolve_id_filter(&rs, &g, &missing).unwrap_err().to_string().contains("がありません"));
        let s2 = SessionFilter { sessions: Some(vec!["2".into()]), ..Default::default() };
        assert_eq!(resolve_id_filter(&rs, &s2, &groups).unwrap().unwrap().set.into_iter().collect::<Vec<_>>(), ["2"]);
        let both = SessionFilter { group: Some("g".into()), sessions: Some(vec!["1".into(), "2".into()]), ..Default::default() };
        assert_eq!(resolve_id_filter(&rs, &both, &groups).unwrap().unwrap().set.into_iter().collect::<Vec<_>>(), ["1"]);
        assert!(resolve_id_filter(&rs, &none, &groups).unwrap().is_none());

        assert_eq!(ids(&filter_sessions(&rs, &SessionFilter { project: Some("quokka/app".into()), ..Default::default() }, None).0), ["1"]);
        let (partial, mut projects) = filter_sessions(&rs, &SessionFilter { project: Some("QUOKKA".into()), ..Default::default() }, None);
        assert_eq!(ids(&partial), ["1", "2"]);
        projects.sort();
        assert_eq!(projects, ["quokka/app", "quokka/app-docs"]);
        assert_eq!(ids(&filter_sessions(&rs, &cli, None).0), ["1", "3"]);
        assert_eq!(ids(&filter_sessions(&rs, &SessionFilter { since: Some("2026-08-15".into()), ..Default::default() }, None).0), ["2", "3"]);
        assert_eq!(
            describe_filter(&both, &[], Some(&ResolvedIds { set: HashSet::new(), group_total: 3, group_known: 2, session_ids: vec!["1".into()] })),
            "group=g(2 / 3 件が記録にある), session=1 件"
        );
    }
}
