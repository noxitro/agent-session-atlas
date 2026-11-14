//! 子プロセスの起動(packages/judge/src/backends/proc.ts の移植)。シェルを経由しない(プロンプトに改行・引用符・% などが入るため)。
//! Windows の npm シム(copilot.cmd 等)は中身を読んで node + JS / .exe を直接起動する。

use anyhow::{anyhow, bail, Result};
use regex::Regex;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedCommand {
    pub command: PathBuf,
    /// 本来の引数の前に付ける引数(node でスクリプトを起動する場合のスクリプトパス)
    pub prefix: Vec<String>,
    /// 表示用
    pub display: String,
}

const SCRIPT_EXT: [&str; 3] = ["js", "mjs", "cjs"];

static SHIM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)"%dp0%\\([^"]+\.(?:js|mjs|cjs|exe))"\s+%\*"#).unwrap());

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|d| !d.as_os_str().is_empty()).collect()).unwrap_or_default()
}

/// スクリプトを動かす node(TS 版は自分を動かしている process.execPath。Rust 版は PATH の node)
fn node_exe() -> Result<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["node.exe"] } else { &["node"] };
    for d in path_dirs() {
        for n in names {
            let p = d.join(n);
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    bail!("node が PATH に見つかりません(.js のスクリプトを起動するのに使います)")
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn from_file(p: &Path) -> Result<ResolvedCommand> {
    let ext = ext_of(p);
    if SCRIPT_EXT.contains(&ext.as_str()) {
        let s = p.display().to_string();
        return Ok(ResolvedCommand { command: node_exe()?, prefix: vec![s.clone()], display: format!("node {s}") });
    }
    if ext == "cmd" || ext == "bat" {
        // npm のシム: "%dp0%\node_modules\...\xxx.js" %* または "%dp0%\...\xxx.exe" %*
        let text = String::from_utf8_lossy(&std::fs::read(p)?).into_owned();
        let Some(m) = SHIM_RE.captures(&text) else {
            bail!("{} の起動先を読み取れません(npm のシム形式ではありません)。実行ファイルか .js のパスを直接指定してください。", p.display());
        };
        // シム内のパスは \ 区切り。POSIX でも解決できるように分割してから結合する
        let mut target = p.parent().map(Path::to_path_buf).unwrap_or_default();
        for seg in m[1].split('\\') {
            target.push(seg);
        }
        let target = atlas_core::jsfs::resolve(&target);
        if !target.exists() {
            bail!("{} の起動先 {} がありません", p.display(), target.display());
        }
        return from_file(&target);
    }
    Ok(ResolvedCommand { command: p.to_path_buf(), prefix: vec![], display: p.display().to_string() })
}

/// 実行ファイルを解決する。パス指定ならそれを、名前なら PATH から探す
pub fn resolve_command(bin: &str) -> Result<ResolvedCommand> {
    let looks_like_path = Path::new(bin).is_absolute() || bin.contains('/') || bin.contains('\\');
    if looks_like_path {
        let p = atlas_core::jsfs::resolve(Path::new(bin));
        if !p.exists() {
            bail!("実行ファイルが見つかりません: {}", p.display());
        }
        return from_file(&p);
    }
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    for d in path_dirs() {
        for e in exts {
            let p = d.join(format!("{bin}{e}"));
            if p.exists() && (!cfg!(windows) || !e.is_empty()) {
                return from_file(&p);
            }
        }
    }
    bail!("{bin} が PATH に見つかりません(インストールするか、実行ファイルのパスを指定してください)")
}

/// Windows の CreateProcess のコマンドライン上限(UTF-16 で 32,767)に余裕を見た値
pub const MAX_COMMAND_LINE: usize = 32_000;

pub fn command_line_length(cmd: &ResolvedCommand, args: &[String]) -> usize {
    let c = cmd.command.display().to_string();
    std::iter::once(c.as_str()).chain(cmd.prefix.iter().map(String::as_str)).chain(args.iter().map(String::as_str)).map(|s| atlas_core::js::utf16_len(s) + 3 + s.matches('"').count()).sum()
}

#[derive(Debug, Clone)]
pub struct ProcResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// 窓を出さずに起動する(Node の windowsHide)
pub fn hide_window(c: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = c;
}

pub fn run_process(cmd: &ResolvedCommand, args: &[String], cwd: &Path, timeout: Duration, input: Option<&str>) -> Result<ProcResult> {
    let mut c = Command::new(&cmd.command);
    c.args(&cmd.prefix).args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut c);
    let mut child = c.spawn().map_err(|e| anyhow!("{} を起動できません: {e}", cmd.display))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.unwrap_or("").as_bytes());
    }
    let mut out = child.stdout.take().expect("stdout");
    let mut err = child.stderr.take().expect("stderr");
    let to = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let te = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if start.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break child.wait()?;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = String::from_utf8_lossy(&to.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&te.join().unwrap_or_default()).into_owned();
    Ok(ProcResult { code: status.code(), stdout, stderr, timed_out })
}

/// `s.trim()` の末尾 n 字(長ければ … を付ける)
pub fn tail(s: &str, n: usize) -> String {
    let t = atlas_core::js::trim(s);
    if atlas_core::js::utf16_len(t) > n { format!("…{}", atlas_core::js::tail(t, n)) } else { t.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_npm_shim() {
        let d = tempfile::tempdir().unwrap();
        let pkg = d.path().join("node_modules").join("pkg");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("cli.js"), "").unwrap();
        std::fs::write(d.path().join("tool.cmd"), "@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\pkg\\cli.js\" %*\r\n").unwrap();
        if node_exe().is_ok() {
            let c = resolve_command(&d.path().join("tool.cmd").display().to_string()).unwrap();
            assert!(c.command.file_stem().unwrap().to_string_lossy().eq_ignore_ascii_case("node"));
            assert_eq!(PathBuf::from(&c.prefix[0]), atlas_core::jsfs::resolve(&pkg.join("cli.js")));
        }
        assert!(resolve_command(&d.path().join("missing.exe").display().to_string()).unwrap_err().to_string().contains("見つかりません"));
        std::fs::write(d.path().join("bad.cmd"), "echo hi").unwrap();
        assert!(resolve_command(&d.path().join("bad.cmd").display().to_string()).unwrap_err().to_string().contains("npm のシム形式ではありません"));
        assert_eq!(tail("  abcdef  ", 3), "…def");
        assert_eq!(tail("ab", 3), "ab");
    }
}
