//! atlas bundle(packages/cli/src/commands.ts の runBundle の移植)。ログの文言は TS 版と同じ。

use super::metrics::{select_sessions, SessionFilter};
use super::{mb, ms, Log};
use crate::paths::Paths;
use anyhow::Result;
use atlas_core::jsnum::to_fixed;
use atlas_judge::bundle::{build_bundle, BundleManifest, BundleOptions};
use atlas_judge::judgments_io::read_judgments;
use indexmap::IndexMap;
use std::collections::HashSet;
use std::time::Instant;

/// 容量(TS 版の kb())
pub(crate) fn kb(b: i64) -> String {
    format!("{} KB", to_fixed(b as f64 / 1024.0, 1))
}

pub struct BundleCliOptions {
    pub include_empty: bool,
    pub per_part: Option<u64>,
    pub unjudged: bool,
}

pub fn run_bundle(p: &Paths, f: &SessionFilter, o: &BundleCliOptions, log: Log<'_>) -> Result<BundleManifest> {
    let sel = select_sessions(p, f, "bundle", "先に atlas extract(または atlas all)を実行してください。", log)?;
    let mut sessions = sel.sessions();
    if o.unjudged {
        let judged: HashSet<String> = read_judgments(&p.judgments)?.map(|j| j.items.into_iter().map(|i| i.session_id).collect()).unwrap_or_default();
        let before = sessions.len();
        sessions.retain(|s| !judged.contains(&s.id));
        log(&format!("bundle: 判定済みの {} 件を除きました(--unjudged)", before - sessions.len()));
    }
    let t = Instant::now();
    let nz = |v: &Option<String>| v.clone();
    let mut scope: IndexMap<String, Option<String>> = IndexMap::new();
    scope.insert("since".into(), nz(&f.since));
    scope.insert("project".into(), nz(&f.project));
    scope.insert("client".into(), nz(&f.client));
    scope.insert("model".into(), nz(&f.model));
    scope.insert("branch".into(), nz(&f.branch));
    scope.insert("group".into(), nz(&f.group));
    scope.insert("session".into(), f.sessions.as_ref().filter(|s| !s.is_empty()).map(|s| s.join(",")));
    scope.insert("unjudged".into(), if o.unjudged { Some("yes".into()) } else { None });
    let m = build_bundle(
        &sessions,
        &BundleOptions {
            bundle_dir: p.bundle.clone(),
            snapshot_dir: Some(p.snapshot.clone()),
            limits: None,
            include_empty: o.include_empty,
            per_part: o.per_part.map(|n| n as usize),
            boundary: None,
            scope,
            log,
            now: None,
        },
    )?;
    let excerpt = m.sessions.iter().filter(|e| e.text_source == atlas_judge::packet::TextSource::Excerpt).count();
    let truncated = m.sessions.iter().filter(|e| e.truncated > 0).count();
    log(&format!(
        "bundle: パケット {} 件(依頼の記録が無く対象外 {} 件)、合計 {}、最大 {}、本文を中略したもの {truncated} 件{} → {}、{}",
        m.count,
        m.skipped.len(),
        mb(m.total_bytes.max(0) as u64),
        kb(m.max_bytes),
        if excerpt > 0 { format!("、抜粋のみ {excerpt} 件") } else { String::new() },
        p.bundle.display(),
        ms(t.elapsed())
    ));
    log("bundle: 外部の LLM に渡すときは bundle フォルダごと ZIP にして、INSTRUCTIONS.md を最初に読ませてください");
    if let Some(parts) = m.parts.as_ref().filter(|x| !x.is_empty()) {
        let max_part = parts.iter().map(|x| x.bytes).max().unwrap_or(0);
        log(&format!(
            "bundle: ZIP を渡せないときは parts/ の {} ファイル({} 件ずつ、最大 {})を 1 つずつ添付してください(指示と JSON Schema も中に入っています)",
            parts.len(),
            m.per_part.unwrap_or(0),
            kb(max_part)
        ));
    }
    Ok(m)
}
