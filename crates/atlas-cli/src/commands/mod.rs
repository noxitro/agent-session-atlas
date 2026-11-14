//! atlas の各コマンド(packages/cli/src/commands.ts の移植)。コマンドごとにファイルを分ける。
//! 元データ(~/.copilot)は snapshot 経由でだけ読む(コピーしてから開く)。

use crate::args::CliOptions;
use crate::paths::{resolve_paths, PathInputs, Paths};
use anyhow::Result;
use atlas_core::jsnum::to_fixed;
use std::path::PathBuf;
use std::time::Duration;

mod extract;
mod metrics;
mod snapshot;
mod vcs;

/// 進み具合を 1 行ずつ出す先(TS 版の Log)
pub type Log<'a> = &'a (dyn Fn(&str) + Sync);

/// 所要時間(TS 版の ms())
pub(crate) fn ms(d: Duration) -> String {
    format!("{} 秒", to_fixed(d.as_secs_f64(), 1))
}

/// 容量(TS 版の mb())
pub(crate) fn mb(b: u64) -> String {
    format!("{} MB", to_fixed(b as f64 / 1024.0 / 1024.0, 2))
}

/// build・export・all の結果(main がレポートの場所を出す)
#[derive(Debug, Clone, Default)]
pub struct BuildResult {
    pub html_path: PathBuf,
}

/// judge run の結果(失敗したセッションがあれば終了コード 1)
#[derive(Debug, Clone, Default)]
pub struct JudgeSummary {
    pub failed: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RunResult {
    pub paths: Paths,
    pub build: Option<BuildResult>,
    pub judge: Option<JudgeSummary>,
}

impl RunResult {
    pub fn of(paths: &Paths) -> Self {
        RunResult { paths: paths.clone(), build: None, judge: None }
    }
}

/// まだ Rust に移していないコマンド
pub fn not_ported(what: &str) -> anyhow::Error {
    anyhow::anyhow!("{what} はまだ Rust 版に移していません(docs/rust-migration.md)")
}

pub fn paths_of(o: &CliOptions) -> Paths {
    resolve_paths(PathInputs { home: o.home.as_deref(), out: o.out.as_deref(), judgments: o.judgments.as_deref(), bundle: o.bundle.as_deref(), notes_dir: o.notes_dir.as_deref() })
}

pub fn run(o: &CliOptions, log: Log<'_>) -> Result<RunResult> {
    // TODO(serve の移植): open は自分で出力先を決める。out/ に書くコマンドは acquireOutLock(jobs.ts)で排他する
    let p = paths_of(o);
    run_command(o, &p, log)
}

pub fn run_command(o: &CliOptions, p: &Paths, log: Log<'_>) -> Result<RunResult> {
    let _ = (p, log);
    match o.command.as_str() {
        "snapshot" => {
            snapshot::run_snapshot(p, o.since.as_deref(), log, o.snapshot_all, o.snapshot_prune)?;
            Ok(RunResult::of(p))
        }
        "extract" => {
            extract::run_extract(p, o.since.as_deref(), log, o.temp_dirs.as_deref(), o.config.as_deref())?;
            Ok(RunResult::of(p))
        }
        "metrics" => {
            metrics::run_metrics(p, &metrics::SessionFilter::from_cli(o), log, true)?;
            Ok(RunResult::of(p))
        }
        "vcs" => {
            vcs::run_vcs(p, log, o.vcs_mode.as_deref(), o.config.as_deref())?;
            Ok(RunResult::of(p))
        }
        "build" | "export" => Err(not_ported(&o.command)),
        "bundle" => Err(not_ported("bundle")),
        "turns" => Err(not_ported("turns")),
        "judge" => Err(not_ported("judge")),
        "group" => Err(not_ported("group")),
        "memo" => Err(not_ported("memo")),
        "serve" => Err(not_ported("serve")),
        "skill-draft" => Err(not_ported("skill-draft")),
        "open" => Err(not_ported("open")),
        "all" => Err(not_ported("all")),
        other => Err(anyhow::anyhow!("不明なコマンドです: {other}")),
    }
}
