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
mod memo;
mod metrics;
pub mod open;
pub mod serve;
mod skill_draft;
mod snapshot;
pub(crate) mod tasks;
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

#[derive(Debug, Clone, Default)]
pub struct RunResult {
    pub build: Option<BuildResult>,
}

pub fn paths_of(o: &CliOptions) -> Paths {
    resolve_paths(PathInputs { home: o.home.as_deref(), out: o.out.as_deref(), judgments: o.judgments.as_deref(), bundle: o.bundle.as_deref(), notes_dir: o.notes_dir.as_deref() })
}

/// out/ に書くコマンド。実行中は out/.job.json に印を置き、他のプロセス(画面のジョブ・別の atlas)と並行して書かない
const WRITES_OUT: [&str; 11] = ["snapshot", "extract", "metrics", "build", "export", "bundle", "judge", "turns", "tasks", "skill-draft", "all"];

pub fn run(o: &CliOptions, log: Log<'_>) -> Result<RunResult> {
    if o.command == "open" {
        return open::run_open(o, log, None);
    }
    let mut p = paths_of(o);
    // 設定のフォルダ(--settings か、開いたフォルダの出力先の記録)があれば、その設定ファイルを読み、タスクの置き場も決める
    let o = &crate::settings_dir::apply_settings(o, &mut p, log)?;
    let lock = if WRITES_OUT.contains(&o.command.as_str()) { Some(crate::jobs::acquire_out_lock(&p.out, &o.command, "cli")?) } else { None };
    let r = run_command(o, &p, log);
    if let Some(l) = lock {
        l.release();
    }
    r
}

/// judge に、judge では効かない絞り込みを付けたときの知らせ(黙って添付の全体を扱わないように止める)
fn ignored_filters_message(action: &str, flags: &[String]) -> String {
    let list = flags.join(" ");
    match action {
        "import" => format!("{list} は judge import では使えません(返答に入っているセッションをすべて取り込みます)"),
        _ => format!("{list} は judge {action} では効きません。送るのは、作ってある添付(out/bundle)のファイルです。\n絞り込むときは、先に bin\\atlas.exe bundle {list} --unjudged で添付を作ってから judge {action} を実行してください"),
    }
}

/// judge m365 / turns m365 / tasks m365: 開いている M365 Copilot のアプリを操作して未判定の添付ファイルを送り(m365.rs)、
/// 1 件でも取り込めたらレポートに反映する(export)。送れなかった・取り込めなかったファイルがあれば、反映した後に失敗にする
pub(crate) fn run_m365_command(o: &CliOptions, p: &Paths, target: ChatTarget, model: Option<&str>, limit: Option<u64>, timeout_sec: u64, log: Log<'_>) -> Result<RunResult> {
    let s = run_m365_judge(
        &M365Paths { out: p.out.clone(), notes: p.tasks_dir.clone(), sessions: p.sessions.clone(), judgments: p.judgments.clone(), turn_judgments: p.turn_judgments.clone(), turn_bundle: p.turn_bundle.clone(), settings: p.settings.clone() },
        &M365Options { target, model: model.unwrap_or(M365_DEFAULT_MODEL).to_string(), limit, timeout_sec, retries: None },
        &|m: &str| log(m),
        &powershell_driver,
        cfg!(windows) || crate::m365::fake_driver().is_some(),
        &std::thread::sleep,
    )?;
    let build = if s.imported > 0 { run_command(&CliOptions { command: "export".into(), model: None, judge: None, turns: None, tasks_cmd: None, sessions: None, task: None, ..o.clone() }, p, log)?.build } else { None };
    if !s.failed.is_empty() {
        anyhow::bail!(
            "M365 Copilot で判定できなかったファイルが {} 個あります: {}",
            s.failed.len(),
            s.failed.iter().map(|f| format!("{}({})", f.name, f.reason)).collect::<Vec<_>>().join(" / ")
        );
    }
    Ok(RunResult { build })
}

/// judge import・turns import の後に、1 件以上取り込めて集計の結果(sessions.json)があれば、レポートを作り直す(export。tasks import と同じ)。
/// 設定のフォルダを使うときも、同じ設定(o と p は当てた後のもの)で作り直す
fn rebuild_after_import(o: &CliOptions, p: &Paths, imported: usize, log: Log<'_>) -> Result<RunResult> {
    if imported == 0 || !p.sessions.exists() {
        return Ok(RunResult::default());
    }
    run_command(&CliOptions { command: "export".into(), model: None, judge: None, turns: None, tasks_cmd: None, sessions: None, task: None, ..o.clone() }, p, log)
}

pub fn run_command(o: &CliOptions, p: &Paths, log: Log<'_>) -> Result<RunResult> {
    match o.command.as_str() {
        "snapshot" => {
            snapshot::run_snapshot(p, o.since.as_deref(), log, o.snapshot_all, o.snapshot_prune)?;
            Ok(RunResult::default())
        }
        "extract" => {
            extract::run_extract(p, o.since.as_deref(), log, o.temp_dirs.as_deref(), o.config.as_deref())?;
            Ok(RunResult::default())
        }
        "metrics" => {
            metrics::run_metrics(p, &metrics::SessionFilter::from_cli(o), o.config.as_deref(), log)?;
            Ok(RunResult::default())
        }
        "vcs" => {
            vcs::run_vcs(p, log, o.vcs_mode.as_deref(), o.config.as_deref())?;
            Ok(RunResult::default())
        }
        "build" | "export" => {
            let transcripts = (o.command == "export").then(|| build::TranscriptCli { tool_output: o.tool_output, max_chars: o.max_chars, full: o.full });
            let b = build::run_build(p, &build::BuildOptions { filter: metrics::SessionFilter::from_cli(o), transcripts, config: o.config.clone(), refreshed: None }, log)?;
            Ok(RunResult { build: Some(b) })
        }
        "bundle" => {
            bundle::run_bundle(p, &metrics::SessionFilter::from_cli(o), &bundle::BundleCliOptions { include_empty: o.include_empty, per_part: o.per_part, unjudged: o.unjudged, zip: o.zip, config: o.config.clone() }, log)?;
            Ok(RunResult::default())
        }
        "turns" => {
            let t = o.turns.as_ref().ok_or_else(|| anyhow::anyhow!("turns の操作がありません"))?;
            if t.action == "m365" {
                return run_m365_command(o, p, ChatTarget::Turns, t.model.as_deref(), t.limit, t.timeout_sec, log);
            }
            let imported = turns::run_turns(p, &metrics::SessionFilter { model: None, ..metrics::SessionFilter::from_cli(o) }, t, o.zip, log)?;
            rebuild_after_import(o, p, imported, log)
        }
        "judge" => {
            let j = o.judge.as_ref().ok_or_else(|| anyhow::anyhow!("judge の操作がありません"))?;
            if !j.ignored_filters.is_empty() {
                anyhow::bail!("{}", ignored_filters_message(&j.action, &j.ignored_filters));
            }
            if j.action == "m365" {
                return run_m365_command(o, p, ChatTarget::Effort, j.model.as_deref(), j.limit, j.timeout_sec, log);
            }
            let imported = judge::run_judge_import(p, j, log)?;
            rebuild_after_import(o, p, imported, log)
        }
        "tasks" => tasks::run_tasks_command(o, p, log),
        "memo" => {
            let m = o.memo_cmd.as_ref().ok_or_else(|| anyhow::anyhow!("memo の操作がありません"))?;
            memo::run_memo(p, m, log)?;
            Ok(RunResult::default())
        }
        "serve" => {
            serve::run_serve(p, serve::ServeCli { port: o.port, open: o.open, config: o.config.clone(), home: None, reports: None, settings: p.settings.clone() }, log)?;
            Ok(RunResult::default())
        }
        "skill-draft" => {
            let sd = o.skill_draft.as_ref().ok_or_else(|| anyhow::anyhow!("skill-draft の番号がありません"))?;
            skill_draft::run_skill_draft(p, sd, log)?;
            Ok(RunResult::default())
        }
        "open" => open::run_open(o, log, None),
        "all" => Ok(RunResult { build: Some(all::run_all(o, p, log)?) }),
        other => Err(anyhow::anyhow!("不明なコマンドです: {other}")),
    }
}

#[cfg(test)]
mod tests;
