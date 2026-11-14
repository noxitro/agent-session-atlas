//! atlas の各コマンド(packages/cli/src/commands.ts の移植)。コマンドごとにファイルを分ける。
//! 元データ(~/.copilot)は snapshot 経由でだけ読む(コピーしてから開く)。

use crate::args::CliOptions;
use crate::chat_parts::ChatTarget;
use crate::m365::{powershell_driver, run_m365_judge, M365Options, M365Paths, M365_DEFAULT_MODEL};
use crate::paths::{resolve_paths, PathInputs, Paths};
use anyhow::Result;
use atlas_core::jsnum::to_fixed;
use std::time::Duration;

mod all;
pub mod build;
mod bundle;
mod extract;
pub(crate) mod judge;
pub mod judge_flow;
mod metrics;
mod skill_draft;
mod snapshot;
pub(crate) mod turns;
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
pub use build::BuildResult;

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

/// judge m365 / turns m365: 開いている M365 Copilot のアプリを操作して未判定の添付ファイルを判定し(m365.rs)、
/// 1 件でも取り込めたらレポートに反映する(export)。送れなかった・取り込めなかったファイルがあれば、反映した後に失敗にする
fn run_m365_command(o: &CliOptions, p: &Paths, target: ChatTarget, model: Option<&str>, limit: Option<u64>, timeout_sec: u64, log: Log<'_>) -> Result<RunResult> {
    let s = run_m365_judge(
        &M365Paths { out: p.out.clone(), sessions: p.sessions.clone(), judgments: p.judgments.clone(), turn_judgments: p.turn_judgments.clone(), turn_bundle: p.turn_bundle.clone() },
        &M365Options { target, model: model.unwrap_or(M365_DEFAULT_MODEL).to_string(), limit, timeout_sec },
        &|m: &str| log(m),
        &powershell_driver,
        cfg!(windows),
    )?;
    // TODO(段 4): export を移したら、ここで run_command(export) がレポートを作り直す(今は not_ported のエラーになる)
    let build = if s.imported > 0 { run_command(&CliOptions { command: "export".into(), model: None, judge: None, turns: None, ..o.clone() }, p, log)?.build } else { None };
    if !s.failed.is_empty() {
        anyhow::bail!(
            "M365 Copilot で判定できなかったファイルが {} 個あります: {}",
            s.failed.len(),
            s.failed.iter().map(|f| format!("{}({})", f.name, f.reason)).collect::<Vec<_>>().join(" / ")
        );
    }
    Ok(RunResult { build, ..RunResult::of(p) })
}

pub fn run_command(o: &CliOptions, p: &Paths, log: Log<'_>) -> Result<RunResult> {
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
        "build" | "export" => {
            let transcripts = (o.command == "export").then(|| build::TranscriptCli { tool_output: o.tool_output, max_chars: o.max_chars, full: o.full });
            let b = build::run_build(p, &build::BuildOptions { filter: metrics::SessionFilter::from_cli(o), anonymize: o.anonymize, transcripts }, log)?;
            Ok(RunResult { build: Some(b), ..RunResult::of(p) })
        }
        "bundle" => {
            bundle::run_bundle(p, &metrics::SessionFilter::from_cli(o), &bundle::BundleCliOptions { include_empty: o.include_empty, per_part: o.per_part, unjudged: o.unjudged }, log)?;
            Ok(RunResult::of(p))
        }
        "turns" => {
            let t = o.turns.as_ref().ok_or_else(|| anyhow::anyhow!("turns の操作がありません"))?;
            if t.action == "m365" {
                return run_m365_command(o, p, ChatTarget::Turns, t.model.as_deref(), t.limit, t.timeout_sec, log);
            }
            turns::run_turns(p, &metrics::SessionFilter { model: None, ..metrics::SessionFilter::from_cli(o) }, t, log)?;
            Ok(RunResult::of(p))
        }
        "judge" => {
            let j = o.judge.as_ref().ok_or_else(|| anyhow::anyhow!("judge の操作がありません"))?;
            if j.action == "m365" {
                return run_m365_command(o, p, ChatTarget::Effort, j.model.as_deref(), j.limit, j.timeout_sec, log);
            }
            Ok(RunResult { judge: judge::run_judge_command(p, j, log)?, ..RunResult::of(p) })
        }
        "group" => {
            // TODO(段 5): list / add / remove / export も移す
            let g = o.group_cmd.as_ref().ok_or_else(|| anyhow::anyhow!("group の操作がありません"))?;
            if g.action != "upload" {
                return Err(not_ported(&format!("group {}", g.action)));
            }
            crate::group_upload::run_group_upload(p, g.name.as_deref().unwrap_or(""), g.to.as_deref(), g.force, o.config.as_deref(), log)?;
            Ok(RunResult::of(p))
        }
        "memo" => Err(not_ported("memo")),
        "serve" => Err(not_ported("serve")),
        "skill-draft" => {
            let sd = o.skill_draft.as_ref().ok_or_else(|| anyhow::anyhow!("skill-draft の番号がありません"))?;
            skill_draft::run_skill_draft(p, sd, log)?;
            Ok(RunResult::of(p))
        }
        "open" => Err(not_ported("open")),
        "all" => Ok(RunResult { build: Some(all::run_all(o, p, log)?), ..RunResult::of(p) }),
        other => Err(anyhow::anyhow!("不明なコマンドです: {other}")),
    }
}
