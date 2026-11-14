//! atlas コマンドの入口(packages/cli/src/main.ts の移植): atlas <command> [options]

mod args;
mod commands;
mod config;
mod paths;
mod tables;

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
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
