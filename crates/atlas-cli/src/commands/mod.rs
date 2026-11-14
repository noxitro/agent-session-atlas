//! atlas の各コマンド(packages/cli/src/commands.ts の移植)。コマンドごとにファイルを分ける。
//! 元データ(~/.copilot)は snapshot 経由でだけ読む(コピーしてから開く)。

use crate::args::CliOptions;
use crate::paths::{resolve_paths, PathInputs, Paths};
use anyhow::Result;
use std::path::PathBuf;

/// 進み具合を 1 行ずつ出す先(TS 版の Log)
pub type Log<'a> = &'a (dyn Fn(&str) + Sync);

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
        "snapshot" => Err(not_ported("snapshot")),
        "extract" => Err(not_ported("extract")),
        "metrics" => Err(not_ported("metrics")),
        "vcs" => Err(not_ported("vcs")),
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
