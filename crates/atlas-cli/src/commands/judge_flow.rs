//! 判定の通し(packages/cli/src/judge-flow.ts の移植)。TS 版は別の入口(npm run atlas:judge)だったが、Rust 版は実行ファイルを 1 つに
//! 保つため、同じ atlas の隠しサブコマンド `atlas judge-flow [judge run のオプション]` にする(main.rs が引数の解釈より前に振り分ける)。
//! 画面の「工数を判定する」(serve の jobs)も、子プロセスとして `atlas judge-flow …` を起動する。
//!   atlas judge-flow [judge run のオプション]           bundle → judge run → export
//!   atlas judge-flow --turns [--limit <n>] [--model <名前>]   turns bundle --unjudged → turns run(GitHub Copilot CLI)→ export
//! --session / --group / --since などの絞り込みは判定する範囲(束)にだけ掛け、最後の export はレポート全体を作り直す。
//! 絞り込みがあるときの束は、共有の束(out/bundle・out/turn-bundle)ではなく作業用の場所(out/judge-work)に作り、終わったら消す。
//! 判定に失敗したセッションがあってもレポートは作り直す(判定済みの分は反映する)。終了コードは 1 にする。

use super::metrics::{has_filter, SessionFilter};
use super::{run_command, Log};
use crate::args::{parse_cli, CliOptions, USAGE};
use crate::paths::Paths;
use std::io::Write;
use std::path::PathBuf;

/// 絞った判定の束を作る場所(<out> の下)。共有の束(out/bundle・out/turn-bundle)は「チャットに貼って判定する」と M365 の判定が
/// 作成済みとして使い回すので、絞った範囲だけの束で上書きしない
pub const JUDGE_WORK_DIR: &str = "judge-work";

/// 作業用の場所。落とすときに(判定に失敗しても)消す。
/// 中身は束を作る処理(atlas_judge の bundle / turn_bundle)が書くファイルとフォルダだけで、リンク(junction・シンボリックリンク)は作らない。
/// 消すのは jsfs::rm_rf(std の remove_dir_all)で、Rust 1.58.1 以降はリンクを辿らずリンクそのものを消す(テスト: work_dir_removal_does_not_follow_junctions)
struct WorkDir(Option<PathBuf>);

impl Drop for WorkDir {
    fn drop(&mut self) {
        if let Some(d) = &self.0
            && let Err(e) = atlas_core::fs_retry::remove_tree(d)
        {
            eprintln!("atlas:judge: 作業用のフォルダを消せませんでした({}): {e}", d.display());
        }
    }
}

/// 絞り込みがあれば、束の場所を作業用の場所へ差し替える(--bundle で場所を指したときはそのまま。判定の結果の judgments.json などは共有のまま)
fn use_work_dir(p: &mut Paths, common: &CliOptions, log: Log<'_>) -> anyhow::Result<WorkDir> {
    if !has_filter(&SessionFilter::from_cli(common)) {
        return Ok(WorkDir(None));
    }
    let dir = p.out.join(JUDGE_WORK_DIR);
    // 前の回が止められて残っていれば消してから作る
    atlas_core::fs_retry::remove_tree(&dir)?;
    if common.bundle.is_none() {
        p.bundle = dir.join("bundle");
    }
    p.turn_bundle = dir.join("turn-bundle");
    log(&format!("判定の範囲を絞ったので、束は作業用の場所に作ります(共有の束は変えません。終わったら消します)→ {}", dir.display()));
    Ok(WorkDir(Some(dir)))
}

/// 最後の export。絞り込み(--session / --group / --since など)は判定する範囲を決めるためのものなので、レポートはいつも全体で作り直す
fn export_all(common: &CliOptions) -> CliOptions {
    CliOptions { command: "export".into(), since: None, project: None, client: None, model: None, branch: None, group: None, sessions: None, ..common.clone() }
}

fn stdout_log(msg: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}

/// 依頼ごとの判定の通し(--turns)
fn turns_flow(argv: &[String]) -> u8 {
    let rest: Vec<String> = ["turns".to_string(), "run".to_string()].into_iter().chain(argv.iter().filter(|a| *a != "--turns").cloned()).collect();
    let o = match parse_cli(&rest) {
        Ok(o) => o,
        Err(e) => {
            eprint!("atlas:judge --turns: {e}\n\n{USAGE}");
            return 2;
        }
    };
    let log: Log<'_> = &stdout_log;
    let common = CliOptions { model: None, turns: None, judge: None, ..o.clone() };
    let mut p = super::paths_of(&o);
    let r = (|| -> anyhow::Result<u8> {
        // bundle → run → export の間ずっと印を持つ(中の run_command は印を取らない)
        let _lock = crate::jobs::acquire_out_lock(&p.out, "turns", "cli")?;
        let _work = use_work_dir(&mut p, &common, log)?;
        let mut t = o.turns.clone().expect("turns run");
        t.action = "bundle".into();
        t.unjudged = true;
        run_command(&CliOptions { command: "turns".into(), turns: Some(t), ..common.clone() }, &p, log)?;
        let failed = run_command(&o, &p, log).err().map(|e| e.to_string());
        let b = run_command(&export_all(&common), &p, log)?;
        if let Some(b) = b.build {
            log(&format!("\nレポート: {}", b.html_path.display()));
        }
        if let Some(f) = failed {
            eprintln!("atlas:judge --turns: {f}");
            return Ok(1);
        }
        Ok(0)
    })();
    r.unwrap_or_else(|e| {
        eprintln!("atlas:judge --turns: 失敗しました: {e}");
        1
    })
}

/// `atlas judge-flow` の本体。終了コードを返す
pub fn main(argv: &[String]) -> u8 {
    if argv.iter().any(|a| a == "--turns") {
        return turns_flow(argv);
    }
    let rest: Vec<String> = ["judge".to_string(), "run".to_string()].into_iter().chain(argv.iter().cloned()).collect();
    let judge_opts = match parse_cli(&rest) {
        Ok(o) => o,
        Err(e) => {
            eprint!("atlas:judge: {e}\n\n{USAGE}");
            return 2;
        }
    };
    if judge_opts.help {
        print!("使い方: atlas judge-flow [judge run のオプション]\nbundle → judge run → export を順に実行します。\n\n{USAGE}");
        return 0;
    }
    let log: Log<'_> = &stdout_log;
    // 判定の --model は判定モデルなので、bundle / build の絞り込みには使わない
    let common = CliOptions { model: None, judge: None, ..judge_opts.clone() };
    let mut p = super::paths_of(&judge_opts);
    let r = (|| -> anyhow::Result<u8> {
        // bundle → judge run → export の間ずっと印を持つ(切れ目に画面の判定や atlas.bat の all が入らないように。中の run_command は印を取らない)
        let _lock = crate::jobs::acquire_out_lock(&p.out, "judge", "cli")?;
        let _work = use_work_dir(&mut p, &common, log)?;
        run_command(&CliOptions { command: "bundle".into(), ..common.clone() }, &p, log)?;
        // 絞り込みは上の bundle で使った。judge run には渡さない(judge を直に実行したときだけ止めるため)
        let judge_run = CliOptions { judge: judge_opts.judge.clone().map(|j| crate::args::JudgeCliOptions { ignored_filters: Vec::new(), ..j }), ..judge_opts.clone() };
        let failed = match run_command(&judge_run, &p, log) {
            Ok(r) => r.judge.map_or(0, |j| j.failed.len()),
            Err(e) => {
                eprintln!("atlas:judge: 判定を実行できませんでした: {e}");
                return Ok(1);
            }
        };
        // 直前の all が作ったセッション記録を消さないよう、export で作り直す
        let b = run_command(&export_all(&common), &p, log)?;
        if let Some(b) = b.build {
            log(&format!("\nレポート: {}", b.html_path.display()));
        }
        if failed > 0 {
            eprintln!("atlas:judge: 判定に失敗したセッションが {failed} 件あります(judgments.json の failures に記録しました。もう一度実行すると再試行します)");
            return Ok(1);
        }
        Ok(0)
    })();
    r.unwrap_or_else(|e| {
        eprintln!("atlas:judge: 失敗しました: {e}");
        if std::env::var_os("ATLAS_DEBUG").is_some() {
            eprintln!("{e:?}");
        }
        1
    })
}
