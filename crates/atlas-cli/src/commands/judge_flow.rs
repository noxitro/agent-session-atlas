//! 判定の通し(packages/cli/src/judge-flow.ts の移植)。TS 版は別の入口(npm run atlas:judge)だったが、Rust 版は実行ファイルを 1 つに
//! 保つため、同じ atlas の隠しサブコマンド `atlas judge-flow [judge run のオプション]` にする(main.rs が引数の解釈より前に振り分ける)。
//! 画面の「工数を判定する」(serve の jobs)も、子プロセスとして `atlas judge-flow …` を起動する。
//!   atlas judge-flow [judge run のオプション]           bundle → judge run → export(伏せ字版は build)
//!   atlas judge-flow --turns [--limit <n>] [--model <名前>]   turns bundle --unjudged → turns run(GitHub Copilot CLI)→ export
//! 判定に失敗したセッションがあってもレポートは作り直す(判定済みの分は反映する)。終了コードは 1 にする。

use super::{run_command, Log};
use crate::args::{parse_cli, CliOptions, USAGE};
use std::io::Write;

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
    let p = super::paths_of(&o);
    // TODO(段 5): acquireOutLock(jobs.ts)で out/ を排他する(serve の移植で足す)
    let r = (|| -> anyhow::Result<u8> {
        let mut t = o.turns.clone().expect("turns run");
        t.action = "bundle".into();
        t.unjudged = true;
        run_command(&CliOptions { command: "turns".into(), turns: Some(t), ..common.clone() }, &p, log)?;
        let failed = run_command(&o, &p, log).err().map(|e| e.to_string());
        let b = run_command(&CliOptions { command: "export".into(), ..common.clone() }, &p, log)?;
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
    // --anonymize は最後に作り直すレポートだけに効く(judge run 自体は伏せ字に対応しないので、judge run の解析には渡さない)
    let anonymize = argv.iter().any(|a| a == "--anonymize");
    let rest: Vec<String> = ["judge".to_string(), "run".to_string()].into_iter().chain(argv.iter().filter(|a| *a != "--anonymize").cloned()).collect();
    let judge_opts = match parse_cli(&rest) {
        Ok(o) => o,
        Err(e) => {
            eprint!("atlas:judge: {e}\n\n{USAGE}");
            return 2;
        }
    };
    if judge_opts.help {
        print!("使い方: atlas judge-flow [judge run のオプション]\nbundle → judge run → export(伏せ字版は build)を順に実行します。\n\n{USAGE}");
        return 0;
    }
    let log: Log<'_> = &stdout_log;
    // 判定の --model は判定モデルなので、bundle / build の絞り込みには使わない
    let common = CliOptions { model: None, judge: None, ..judge_opts.clone() };
    let p = super::paths_of(&judge_opts);
    // TODO(段 5): bundle → judge run → export の間ずっと acquireOutLock(jobs.ts)の印を持つ(serve の移植で足す)
    let r = (|| -> anyhow::Result<u8> {
        run_command(&CliOptions { command: "bundle".into(), ..common.clone() }, &p, log)?;
        let failed = match run_command(&judge_opts, &p, log) {
            Ok(r) => r.judge.map_or(0, |j| j.failed.len()),
            Err(e) => {
                eprintln!("atlas:judge: 判定を実行できませんでした: {e}");
                return Ok(1);
            }
        };
        // 直前の all が作ったセッション記録を消さないよう、伏せ字版でなければ export で作り直す
        let b = run_command(&CliOptions { anonymize, command: if anonymize { "build".into() } else { "export".into() }, ..common.clone() }, &p, log)?;
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
