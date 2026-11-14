//! atlas コマンドの入口(packages/cli/src/main.ts の移植): atlas <command> [options]

mod args;
mod chat_parts;
mod commands;
mod config;
// 段 5(serve の画面・open)が使う関数を含む。今はまだ呼ばれないものがある
#[allow(dead_code)]
mod folder_picker;
#[allow(dead_code)]
mod folders;
mod group_upload;
mod jobs;
mod m365;
mod open_reuse;
mod paths;
mod self_update;
mod setup;
mod sys;
mod tables;
mod upload_auto;
mod upload_auto_files;
mod upload_project;
mod upload_schedule;

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // 判定の通し(TS 版の judge-flow.ts / npm run atlas:judge)。引数の解釈が違うので、先に振り分ける
    if argv.first().is_some_and(|a| a == "judge-flow") {
        return ExitCode::from(commands::judge_flow::main(&argv[1..]));
    }
    // .bat から動かす入口(TS 版では packages/cli/src/ の別のファイル。setup.ts・upload-project.ts・upload-schedule.ts・upload-auto.ts)。
    // 使い方には出さない。引数と出力は TS 版の各ファイルと同じ
    match argv.first().map(String::as_str) {
        Some("setup") => return ExitCode::from(setup::main(&argv[1..])),
        Some("upload-project") => return ExitCode::from(upload_project::main(&argv[1..])),
        Some("upload-schedule") => return ExitCode::from(upload_schedule::main(&argv[1..])),
        Some("upload-auto") => return ExitCode::from(upload_auto::main(&argv[1..])),
        _ => {}
    }
    let opts = match args::parse_cli(&argv) {
        Ok(o) => o,
        Err(e) => {
            eprint!("atlas: {e}\n\n{}", args::USAGE);
            return ExitCode::from(2);
        }
    };
    if opts.help {
        print!("{}", args::USAGE);
        return ExitCode::SUCCESS;
    }
    let log = |msg: &str| {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{msg}");
        let _ = out.flush();
    };
    match commands::run(&opts, &log) {
        Ok(r) => {
            if let Some(b) = &r.build {
                log(&format!("\nレポート: {}", b.html_path.display()));
            }
            if let Some(j) = &r.judge {
                if !j.failed.is_empty() {
                    eprintln!("atlas: 判定に失敗したセッションが {} 件あります(judgments.json の failures に記録しました。もう一度 judge run すると再試行します)", j.failed.len());
                    return ExitCode::from(1);
                }
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("atlas: 失敗しました: {e}");
            if std::env::var_os("ATLAS_DEBUG").is_some() {
                eprintln!("{e:?}");
            }
            ExitCode::from(1)
        }
    }
}
