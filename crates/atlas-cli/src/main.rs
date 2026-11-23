//! atlas コマンドの入口(TS 版の packages/cli/src/main.ts の移植): atlas <command> [options]

mod args;
mod chat_parts;
mod commands;
mod config;
mod folder_picker;
mod folders;
mod jobs;
mod m365;
mod open_reuse;
mod paths;
mod self_update;
mod serve;
mod settings_dir;
mod setup;
mod sys;
mod tables;
mod upload_auto;
mod upload_auto_files;
mod upload_copy;
mod upload_project;
mod upload_schedule;
mod version;
// 版の形を確かめる(build.rs が使う。ここではテストだけ)
#[cfg(test)]
mod version_format;

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // 版(scripts/ensure-atlas.ps1 が、置いてある実行ファイルの版を確かめるのに使う)
    if argv.first().is_some_and(|a| a == "--version" || a == "-V") {
        println!("{}", version::version_line());
        return ExitCode::SUCCESS;
    }
    // 判定の通し(judge-flow)は無くなった(判定は外部の LLM に頼む)。前の呼び方には、代わりの手順を知らせる
    if argv.first().is_some_and(|a| a == "judge-flow") {
        eprintln!("atlas: judge-flow は無くなりました。{}", args::NO_IN_TOOL_JUDGING);
        return ExitCode::from(2);
    }
    // .bat から動かす入口(TS 版では packages/cli/src/ の別のファイル。setup.ts・upload-project.ts・upload-schedule.ts・upload-auto.ts)。
    // 使い方には出さない。引数と出力は TS 版の各ファイルと同じ
    match argv.first().map(String::as_str) {
        Some("setup") => return ExitCode::from(setup::main(&argv[1..])),
        Some("upload-project") => return ExitCode::from(upload_project::main(&argv[1..])),
        Some("upload-schedule") => return ExitCode::from(upload_schedule::main(&argv[1..])),
        Some("upload-auto") => return ExitCode::from(upload_auto::main(&argv[1..])),
        // 開くたびに atlas を新しい版にする(起動用の .bat がすべて、scripts/ensure-atlas.ps1 の後に動かす。self_update.rs)
        Some("self-update") => return ExitCode::from(self_update::main(&argv[1..])),
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
