//! atlas all(packages/cli/src/commands.ts の runAllAfterSnapshot と、open が使う runAllOrReuse の移植)。
//! snapshot → extract → vcs → metrics → build(セッション記録も作る)。ログの文言は TS 版と同じ(所要時間だけ違う)。

use super::build::{elapsed, run_build, BuildOptions, BuildResult, TranscriptCli};
use super::extract::run_extract;
use super::metrics::{run_metrics, SessionFilter};
use super::snapshot::run_snapshot;
use super::vcs::run_vcs;
use super::Log;
use crate::args::CliOptions;
use crate::config::CONFIG_FILE;
use crate::open_reuse::{can_reuse, clear_built, inputs_key, read_built, write_built, ReusePaths};
use crate::paths::{resolve, Paths, REPO_ROOT};
use anyhow::Result;
use atlas_core::snapshot::{read_snapshot_manifest, SourceLayout};
use serde_json::json;
use std::path::Path;
use std::time::Instant;

/// atlas all(snapshot から)
pub fn run_all(o: &CliOptions, p: &Paths, log: Log<'_>) -> Result<BuildResult> {
    let t = Instant::now();
    run_snapshot(p, o.since.as_deref(), log, o.snapshot_all, o.snapshot_prune)?;
    run_all_after_snapshot(o, p, log, t)
}

/// all の、snapshot の後(extract → vcs → metrics → build)。t は all を始めた時刻
pub fn run_all_after_snapshot(o: &CliOptions, p: &Paths, log: Log<'_>, t: Instant) -> Result<BuildResult> {
    let f = SessionFilter::from_cli(o);
    run_extract(p, o.since.as_deref(), log, o.temp_dirs.as_deref(), o.config.as_deref())?;
    // 照合は集計の補足なので、失敗しても止めない(前の結果は使わないよう消す)
    if let Err(e) = run_vcs(p, log, o.vcs_mode.as_deref(), o.config.as_deref()) {
        atlas_core::jsfs::rm_force(&p.vcs_retention)?;
        log(&format!("vcs: 注意 照合できませんでした({e})。レポートの「AI の変更の残存」は出しません"));
    }
    run_metrics(p, &f, log)?;
    // セッション記録(.md)も作る
    let build = run_build(p, &BuildOptions { filter: f, transcripts: Some(TranscriptCli { tool_output: o.tool_output, max_chars: o.max_chars, full: false }), config: o.config.clone() }, log)?;
    log(&format!("all: 完了 {}", elapsed(t)));
    Ok(build)
}

/// `new Date(iso).toLocaleString('ja-JP')`(2026/1/5 9:03:07 の形)
fn ja_locale(iso: &str) -> String {
    match atlas_core::jsdate::parse_ms(iso).and_then(atlas_core::jsdate::local_parts) {
        Some(d) => format!("{}/{}/{} {}:{:02}:{:02}", d.year, d.month, d.day, d.hour, d.minute, d.second),
        None => "Invalid Date".into(),
    }
}

/// open の集計: 共有フォルダから写した後、前に集計したときから何も変わっていなければ(open_reuse.rs)、作り直さずにそのときのレポートを使う。
/// 使い回したときは None(レポートは前のまま)
pub fn run_all_or_reuse(o: &CliOptions, p: &Paths, built_file: &Path, log: Log<'_>) -> Result<Option<BuildResult>> {
    let t = Instant::now();
    run_snapshot(p, o.since.as_deref(), log, o.snapshot_all, o.snapshot_prune)?;
    let config_path = o.config.clone().or_else(|| std::env::var("ATLAS_CONFIG").ok());
    let config_file = match &config_path {
        Some(c) => resolve(c),
        None => REPO_ROOT.join(CONFIG_FILE),
    };
    let options = json!({
        "since": o.since, "project": o.project, "client": o.client, "model": o.model, "branch": o.branch, "sessions": o.sessions, "task": o.task,
        "toolOutput": o.tool_output.as_str(), "maxChars": o.max_chars, "tempDirs": o.temp_dirs, "vcsMode": o.vcs_mode,
    });
    let code = crate::version::CODE_STAMP.to_string();
    let key = inputs_key(&ReusePaths { snapshot: &p.snapshot, judgments: &p.judgments, turn_judgments: &p.turn_judgments }, &options, &config_file, &code)?;
    let prev = read_built(built_file);
    // 使い回すのは、アップロードしたフォルダ(送った側が添えた記録だけで集計が決まる)のときだけ
    let layout = read_snapshot_manifest(&p.snapshot)?.and_then(|m| m.layout);
    let uploaded = matches!(layout, Some(SourceLayout::Flat) | Some(SourceLayout::Merged));
    if uploaded && !o.rebuild && can_reuse(prev.as_ref(), &key, &p.out) {
        log(&format!(
            "open: 前に集計したとき({})から、フォルダの中身も atlas も変わっていないので、そのときのレポートを使います(作り直すときは --rebuild か、画面の「集計し直す」)、{}",
            ja_locale(&prev.as_ref().map(|x| x.built_at.clone()).unwrap_or_default()),
            elapsed(t)
        ));
        return Ok(None);
    }
    clear_built(built_file)?;
    let build = run_all_after_snapshot(o, p, log, t)?;
    if uploaded {
        write_built(built_file, &key, &p.out)?;
    }
    Ok(Some(build))
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::jsdate::{with_zone, Offset, TimeZone};

    #[test]
    fn ja_locale_form() {
        with_zone(&TimeZone::fixed(Offset::constant(9)), || {
            assert_eq!(ja_locale("2026-01-05T00:03:07.999Z"), "2026/1/5 9:03:07");
            assert_eq!(ja_locale("2026-12-31T15:00:00Z"), "2027/1/1 0:00:00");
            assert_eq!(ja_locale("nope"), "Invalid Date");
            assert_eq!(ja_locale(""), "Invalid Date");
        });
        with_zone(&TimeZone::posix("EST5EDT,M3.2.0,M11.1.0").unwrap(), || {
            assert_eq!(ja_locale("2026-07-01T14:05:09Z"), "2026/7/1 10:05:09");
            assert_eq!(ja_locale("2026-01-15T15:05:09Z"), "2026/1/15 10:05:09");
        });
    }
}
