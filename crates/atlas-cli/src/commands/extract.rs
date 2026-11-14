//! atlas extract(packages/cli/src/commands.ts の runExtract の移植)。ログの文言は TS 版と同じ(所要時間だけ違う)。

use super::ms;
use super::Log;
use crate::config::{load_config, CONFIG_FILE};
use crate::paths::{resolve, Paths, REPO_ROOT};
use anyhow::{bail, Result};
use atlas_core::atlas_build::current_atlas_build;
use atlas_core::atlas_version::{describe_atlas_builds, summarize_atlas_builds, SentSession};
use atlas_core::extract::{extract, ExtractOptions};
use atlas_core::js::JsMap;
use atlas_core::nodepath::{posix, win32};
use atlas_core::project::ProjectResolverOptions;
use atlas_core::types::SessionsFile;
use std::collections::HashSet;
use std::io::{BufWriter, Write};
use std::time::Instant;

/// プロジェクトの決め方の名前(ログ用)
fn project_source_label(k: &str) -> &str {
    match k {
        "repository" => "記録の repository",
        "git-remote" => "git の origin",
        "path" => "パス",
        "home" => "(ホーム)",
        "temp" => "(一時フォルダ)",
        "atlas-judge" => "(atlas の判定)",
        "unknown" => "不明",
        other => other,
    }
}

pub fn run_extract(p: &Paths, since: Option<&str>, log: Log<'_>, temp_dirs: Option<&[String]>, config: Option<&str>) -> Result<SessionsFile> {
    if !p.snapshot.exists() {
        bail!("スナップショットがありません: {}。先に atlas snapshot を実行してください。", p.snapshot.display());
    }
    let t = Instant::now();
    let env_config = std::env::var("ATLAS_CONFIG").ok();
    let config_path = config.map(str::to_string).or(env_config);
    let cfg_file = match &config_path {
        Some(c) => resolve(c).to_string_lossy().into_owned(),
        None => REPO_ROOT.join(CONFIG_FILE).to_string_lossy().into_owned(),
    };
    let cfg = load_config(&cfg_file, config_path.is_some())?;
    let mut opts = ExtractOptions::new();
    if let Some(s) = since.filter(|s| !s.is_empty()) {
        opts.since = Some(Some(s.to_string()));
    }
    if let Some(w) = &cfg.wikis {
        opts.wikis = w.clone();
    }
    // --temp-dir: 挙げたフォルダだけを一時フォルダとみなす(既定のパターンは使わない)
    // (Windows 形式の絶対パスは POSIX でもそのまま。ログの記録は元のマシンのパスのため)
    if let Some(dirs) = temp_dirs {
        let temps = dirs.iter().map(|d| if win32::is_absolute(d) || posix::is_absolute(d) { d.clone() } else { resolve(d).to_string_lossy().into_owned() }).collect();
        opts.projects = Some(ProjectResolverOptions { temps: Some(temps), temp_patterns: Some(false), ..Default::default() });
    }
    let s = extract(&p.snapshot, &opts)?;
    std::fs::create_dir_all(&p.out)?;
    {
        let mut w = BufWriter::with_capacity(1 << 20, std::fs::File::create(&p.sessions)?);
        atlas_core::json::write_js(&mut w, &s)?;
        w.flush()?;
    }
    let unknown: i64 = s.warnings.unknown_event_types.values().sum();
    log(&format!(
        "extract: {} セッション(DB のみ {} / ディレクトリのみ {} / 両方 {}、うち空のセッション {})→ {}、{}",
        s.counts.sessions,
        s.counts.db_only,
        s.counts.dir_only,
        s.counts.both,
        s.counts.empty,
        p.sessions.display(),
        ms(t.elapsed())
    ));
    let mut by_source: JsMap<i64> = JsMap::new();
    for x in &s.sessions {
        by_source.inc(x.project_source.as_str(), 1);
    }
    let projects: HashSet<&str> = s.sessions.iter().map(|x| x.project.as_str()).collect();
    log(&format!(
        "extract: プロジェクト {} 件(決め方: {})",
        projects.len(),
        by_source.js_entries().iter().map(|(k, v)| format!("{} {v}", project_source_label(k))).collect::<Vec<_>>().join(" / ")
    ));
    if let Some(inst) = &s.installed {
        let skills: HashSet<&String> = inst.skills.iter().chain(inst.plugins.iter().flat_map(|x| x.skills.iter())).collect();
        let warn = if inst.warnings.is_empty() { String::new() } else { format!("、注意 {}", inst.warnings.join(" / ")) };
        log(&format!("extract: インストール済み skill {} 件・プラグイン {} 件を記録(名前だけ){warn}", skills.len(), inst.plugins.len()));
    }
    match cfg.wikis.as_ref().filter(|w| !w.is_empty()) {
        Some(w) => {
            let used = s.sessions.iter().filter(|x| x.wiki.index_reads + x.wiki.page_reads.len() as i64 + x.wiki.skill_calls.len() as i64 + x.wiki.writes + x.wiki.other_calls > 0).count();
            log(&format!(
                "extract: wiki の対象 {}({})、参照のあったセッション {used} 件",
                w.iter().map(|x| x.path.as_str()).collect::<Vec<_>>().join("、"),
                cfg.path.as_deref().unwrap_or("null")
            ));
        }
        None => log(&format!("extract: wiki は未設定のため集計しません({CONFIG_FILE} の wikis で vault を指定できます)")),
    }
    if unknown > 0 || s.warnings.bad_lines > 0 {
        log(&format!("extract: 注意 未知のイベント種別 {unknown} 件、読めなかった行 {} 行", s.warnings.bad_lines));
    }
    // 送り先から集計したときは、送った atlas の版を数える(古い版で送ったものが混ざっていないか)
    let sent: Vec<SentSession<'_>> = s.sessions.iter().map(|x| SentSession { person: x.person.as_ref().and_then(|p| p.as_deref()), upload_atlas: x.upload_atlas.as_ref().map(|a| a.as_ref()) }).collect();
    if sent.iter().any(|x| x.upload_atlas.is_some()) {
        let local = current_atlas_build(&REPO_ROOT);
        if let Some(builds) = summarize_atlas_builds(&sent, Some(&local), s.source.uploads.as_ref()) {
            let d = describe_atlas_builds(&builds);
            log(&format!("extract: {}{}", if d.ok { "" } else { "注意 " }, d.headline));
            if !d.ok {
                for l in &d.lines {
                    log(&format!("extract:   {l}"));
                }
            }
        }
    }
    Ok(s)
}
