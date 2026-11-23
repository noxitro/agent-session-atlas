//! atlas 自身を新しい版にする(TS 版の packages/cli/src/self-update.ts の移植)。次の 2 か所から呼ぶ:
//!  - 自動で送る前(schedule-upload.bat で登録したタスクが、upload_auto.rs から)。定期の自動送信しか使わない PC では、
//!    atlas.bat を開かないので、git pull しないままだと古い版で送り続けてしまうため
//!  - 起動用の .bat を開いたとき(`atlas self-update`。下の main)。マージした変更が、git pull しなくても利用者に届くように。
//!    環境変数 ATLAS_NO_AUTO_UPDATE=1 なら、しない
//!
//! 新しい版にするのは、次をすべて満たすときだけ(手で触っているチェックアウトを壊さない):
//!  - git で取得したフォルダ(.git がある)で、git が使える
//!  - atlas の処理(画面のサーバ・集計など)が、このチェックアウトで動いていない
//!  - 今のブランチが、origin の既定のブランチ(origin/HEAD。分からなければ origin/main)を追っている
//!  - git が管理しているファイルを手で変えていない。ただし package-lock.json だけが変わっているときは、npm が書き換えたものとして元に戻してから進める
//!  - 早送り(fast-forward)だけで新しい版になる。ただし、origin の履歴が書き換えられた(force push)だけで、手元にだけあるコミットが無いときは、新しい main に合わせ直す
//!  - 新しい版が、前にこの PC で動かなかった版(avoid。コミットの全桁)ではない
//!  - この PC に、atlas をビルドするのに要るもの(Node.js・Rust・Windows では C++ のビルドツール)がある。atlas.exe は配っていない
//!    (GitHub のリリースで配るのは 2026-11-23 にやめた)ので、新しい版の実行ファイルはここでビルドするしかない。
//!    無ければ取り込まない(前の版の実行ファイルで、新しい版の .bat やスクリプトを動かさないように)。今の実行ファイルのまま続ける
//!
//!  - 新しい版が、前にこの PC でビルドできなかったコミット(bin/build-failed.txt)ではない。起動用の .bat からは同じコミットをもう試さず、
//!    自動で送るタスクは 1 日に 1 回まで試す(RETRY_FAILED_BUILD_AFTER)。もっと新しいコミットが出たら、それを試す
//!
//! 実行ファイル(bin/atlas.exe)は git pull では新しくならない。取り込んだ版の実行ファイルは、起動用の .bat と同じ scripts/ensure-atlas.ps1 で
//! ビルドする(-KeepOlder は付けない)。ビルドできなければ、前の版のコミットに戻す。実行ファイルは置き換えていないので、前と同じ
//! 実行ファイルのまま続く(ビルドに頼らずに送れる)。
//! 新しい版の実行ファイルがこの PC で動かなかったとき(upload_auto.rs)は、コミットを戻し、実行ファイルを置き換える前のもの(bin/atlas.prev.exe。
//! ensure-atlas.ps1 が置き換えるときに残す)に戻す(rollback)。ここでもビルドはしない。
//! コミットは変わらなくても、実行ファイルが今のコミットから作ったものでなければ(手で git pull した・前の回にビルドできなかった)、
//! 自動で送るタスクはここでビルドし直す(ビルドに要るものが無ければ、そのまま続ける。起動用の .bat は、毎回 ensure-atlas.ps1 がそろえる)。
//! ビルドの手順は .bat と同じものを使いたいので、Rust で書き直さずにスクリプトを呼ぶ。
//! どれかで止まっても、送ること・開くことは止めない(今の版のまま続ける)。何をしたか・しなかった理由と、どうすれば新しい版になるかは、記録と結果に残す。

use crate::upload_auto_files::AutoUpdateResult;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct CmdResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// コマンドを動かす口(テストでは偽物を渡せる)。動かせなかったときは code を -1 にして、理由を stderr に入れる
pub type CmdRunner<'a> = &'a dyn Fn(&str, &[&str], &Path, Duration) -> CmdResult;

/// 窓を出さずに動かす(Windows の CREATE_NO_WINDOW)
pub fn hide_window(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// 既定の口: 終わるまで待つ(timeout を過ぎたら止める)。窓が無いので、資格情報を尋ねられたら止まってしまう。尋ねずに失敗させる
pub fn run_cmd(cmd: &str, args: &[&str], cwd: &Path, timeout: Duration) -> CmdResult {
    let mut c = Command::new(cmd);
    c.args(args).current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "never").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut c);
    crate::jobs::ProcessTree::prepare(&mut c);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return CmdResult { code: -1, stdout: String::new(), stderr: e.to_string() },
    };
    // 出力は別のスレッドで読み続ける(パイプが詰まって止まらないように)
    let read = |r: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut b);
            }
            String::from_utf8_lossy(&b).into_owned()
        })
    };
    // 止めるときは子孫ごと(ensure-atlas.ps1 が動かした cargo・rustc・npm を、git reset の後まで残さない。Windows はジョブオブジェクト)
    let tree = crate::jobs::ProcessTree::of(&child);
    let out = read(child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
    let err = read(child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                return CmdResult { code: st.code().unwrap_or(-1), stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() };
            }
            Ok(None) if started.elapsed() > timeout => {
                tree.kill();
                let _ = child.kill();
                let _ = child.wait();
                return CmdResult { code: -1, stdout: out.join().unwrap_or_default(), stderr: format!("{} 秒で終わらなかった", (timeout.as_millis() as f64 / 1000.0).round()) };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return CmdResult { code: -1, stdout: String::new(), stderr: e.to_string() },
        }
    }
}

pub struct UpdateOptions<'a> {
    /// リポジトリの直下
    pub repo: &'a Path,
    pub log: &'a dyn Fn(&str),
    pub run: Option<CmdRunner<'a>>,
    /// bin/ の実行ファイルが、今のコミットから作ったものか(既定は scripts/ensure-atlas.ps1 -Check)
    pub exe_fresh: Option<&'a dyn Fn() -> bool>,
    /// 今のコミットの実行ファイルをビルドする。できたら true(既定は scripts/ensure-atlas.ps1)
    pub install_exe: Option<&'a dyn Fn() -> bool>,
    /// ビルドに要るもののうち、この PC に無いもの(そろっていれば None。既定は scripts/ensure-atlas.ps1 -CheckTools)
    pub missing_tools: Option<&'a dyn Fn() -> Option<String>>,
    /// 前にこの PC でビルドできなかったコミットと、それからの時間(無ければ None。既定は bin/build-failed.txt。ensure-atlas.ps1 が書く)
    pub failed_build: Option<&'a dyn Fn() -> Option<(String, Duration)>>,
    /// bin/atlas.exe を、置き換える前のもの(bin/atlas.prev.exe。ensure-atlas.ps1 が残す)に戻す。ビルドはしない(既定は restore_previous_exe)
    pub restore_exe: Option<&'a dyn Fn() -> Result<(), String>>,
    /// このチェックアウトで atlas の処理が動いていれば、その説明(動いていれば更新しない)
    pub busy: Option<&'a dyn Fn() -> Option<String>>,
    /// 使わない版(前にこの PC で動かなかった版。コミットの全桁)
    pub avoid: Option<String>,
    /// 新しい版にできなかったときに、この後どうするか(結果の文に入れる。既定は自動で送るタスクの「今の版のまま送ります」)
    pub carry_on: &'a str,
    /// もう最新で何もしなかったときは、結果を記録に書かない(起動用の .bat が開くたびに動かすので、何もしなかったときは何も出さない)
    pub quiet_latest: bool,
    /// 直前に scripts/ensure-atlas.ps1 -KeepOlder で実行ファイルを今のコミットのものにそろえたか(起動用の .bat)。そろえたなら、
    /// コミットが変わらないときは実行ファイルを確かめ直さない(そろえられなかったときも、同じビルドをもう一度試さない)。
    /// そろえていなければ(自動で送るタスク)、毎回確かめる
    pub exe_just_ensured: bool,
    /// git fetch を待つ長さ(起動用の .bat は、窓の前で待つので短くする)
    pub fetch_timeout: Duration,
}

impl<'a> UpdateOptions<'a> {
    pub fn new(repo: &'a Path, log: &'a dyn Fn(&str)) -> Self {
        UpdateOptions {
            repo,
            log,
            run: None,
            exe_fresh: None,
            install_exe: None,
            missing_tools: None,
            failed_build: None,
            restore_exe: None,
            busy: None,
            avoid: None,
            carry_on: "今の版のまま送ります",
            quiet_latest: false,
            exe_just_ensured: false,
            fetch_timeout: FETCH_TIMEOUT,
        }
    }
    fn runner(&self) -> CmdRunner<'a> {
        self.run.unwrap_or(&run_cmd)
    }
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// 起動用の .bat から開いたときの git fetch の長さ(つながらない環境で、開くたびに長く待たせない)
const LAUNCHER_FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// 実行ファイルをビルドする長さ(初めてなら数分から十数分かかる)
const ENSURE_TIMEOUT: Duration = Duration::from_secs(40 * 60);
/// npm が書き換えることのある、git が管理しているファイル(これだけが変わっているときは、元に戻してから進める)
const LOCK_FILE: &str = "package-lock.json";
/// ビルドの経過を書くファイル(scripts/ensure-atlas.ps1 が書く)
const BUILD_LOG: &str = "bin\\build.log";
/// ビルドできなかったコミット(scripts/ensure-atlas.ps1 が、ビルドに失敗したときに書き、できたときに消す。中身はコミットの全桁)
pub const FAILED_BUILD_FILE: &str = "build-failed.txt";
/// 前にビルドできなかったのと同じコミットを、自動で送るタスクがもう一度試すまでの間(1 日に 1 回まで。毎日同じ時刻に動くタスクが、次の日に試せるよう少し短く)。
/// 起動用の .bat からは、同じコミットをもう一度は試さない(開くたびに数分待たせない。もっと新しいコミットが出たら、それにする)
const RETRY_FAILED_BUILD_AFTER: Duration = Duration::from_secs(20 * 60 * 60);

/// 失敗したコマンドの理由(エラー出力の最初の行)
fn reason_of(r: &CmdResult) -> String {
    r.stderr
        .split('\n')
        .map(|l| atlas_core::js::trim(l.strip_suffix('\r').unwrap_or(l)))
        .find(|l| !l.is_empty())
        .map(|l| atlas_core::js::head(l, 200).into_owned())
        .unwrap_or_else(|| format!("終了コード {}", r.code))
}

fn short(sha: Option<&str>) -> Option<String> {
    sha.filter(|s| !s.is_empty()).map(|s| atlas_core::js::head(atlas_core::js::trim(s), 7).into_owned())
}

fn short_s(sha: &str) -> String {
    short(Some(sha)).unwrap_or_default()
}

/// scripts/ensure-atlas.ps1 の動かし方
#[derive(Clone, Copy)]
enum Ensure {
    /// 今のコミットの実行ファイルをビルドする(-KeepOlder は付けない)
    Build,
    /// 実行ファイルが今のコミットのものか(-Check)
    Check,
    /// ビルドに要るものがそろっているか(-CheckTools)
    Tools,
}

/// scripts/ensure-atlas.ps1 を動かす(Windows は Windows PowerShell、ほかは pwsh)。窓は出さない
fn ensure_script(o: &UpdateOptions<'_>, how: Ensure) -> CmdResult {
    let script = o.repo.join("scripts").join("ensure-atlas.ps1");
    let script = script.to_string_lossy();
    let mut args = vec!["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &script];
    match how {
        Ensure::Build => {}
        Ensure::Check => args.push("-Check"),
        Ensure::Tools => args.push("-CheckTools"),
    }
    let timeout = if matches!(how, Ensure::Build) { ENSURE_TIMEOUT } else { GIT_TIMEOUT };
    (o.runner())(if cfg!(windows) { "powershell.exe" } else { "pwsh" }, &args, o.repo, timeout)
}

fn exe_fresh(o: &UpdateOptions<'_>) -> bool {
    if let Some(f) = o.exe_fresh {
        return f();
    }
    ensure_script(o, Ensure::Check).code == 0
}

fn install_exe(o: &UpdateOptions<'_>) -> bool {
    if let Some(f) = o.install_exe {
        return f();
    }
    let r = ensure_script(o, Ensure::Build);
    for line in r.stdout.split('\n').map(|l| atlas_core::js::trim(l.strip_suffix('\r').unwrap_or(l))).filter(|l| !l.is_empty()) {
        (o.log)(&format!("  {line}"));
    }
    if r.code != 0 {
        (o.log)(&format!("atlas の更新: 実行ファイルをビルドできませんでした({})", reason_of(&r)));
    }
    r.code == 0
}

/// ensure-atlas.ps1 -CheckTools の結果から、足りないもの(そろっていれば None)。
/// 終了コード 1 は足りない(出力の最後の行が、足りないものの並び)。スクリプトを動かせなければ、ビルドもできないので足りないものとして扱う
fn parse_missing_tools(r: &CmdResult) -> Option<String> {
    match r.code {
        0 => None,
        1 => Some(
            r.stdout
                .split('\n')
                .map(|l| atlas_core::js::trim(l.strip_suffix('\r').unwrap_or(l)))
                .filter(|l| !l.is_empty())
                .last()
                .map(str::to_string)
                .unwrap_or_else(|| "Node.js・Rust など".to_string()),
        ),
        _ => Some(format!("確かめられませんでした: {}", reason_of(r))),
    }
}

fn missing_tools(o: &UpdateOptions<'_>) -> Option<String> {
    if let Some(f) = o.missing_tools {
        return f();
    }
    parse_missing_tools(&ensure_script(o, Ensure::Tools))
}

/// bin/build-failed.txt の中身(コミット)と、書いてからの時間
fn read_failed_build(repo: &Path) -> Option<(String, Duration)> {
    let p = repo.join("bin").join(FAILED_BUILD_FILE);
    let text = std::fs::read_to_string(&p).ok()?;
    let sha = text.split_whitespace().next()?.to_string();
    let age = std::fs::metadata(&p).ok()?.modified().ok()?.elapsed().unwrap_or_default();
    Some((sha, age))
}

fn failed_build(o: &UpdateOptions<'_>) -> Option<(String, Duration)> {
    match o.failed_build {
        Some(f) => f(),
        None => read_failed_build(o.repo),
    }
}

/// 置き換える前の実行ファイルの名前(scripts/ensure-atlas.ps1 の Install-Exe が、置き換えるときに今のものをこの名前に移す)
fn exe_names() -> (&'static str, &'static str) {
    if cfg!(windows) { ("atlas.exe", "atlas.prev.exe") } else { ("atlas", "atlas.prev") }
}

/// bin/atlas.exe を、置き換える前のもの(bin/atlas.prev.exe)に戻す。ビルドはしない。
/// 今の bin/atlas.exe は消すか(動いていて消せなければ)別の名前に移し、前のものを写す(前のものは、呼んだプロセスが動かしていることがあるので、移さずに写す)
pub fn restore_previous_exe(repo: &Path) -> Result<(), String> {
    let bin = repo.join("bin");
    let (name, prev_name) = exe_names();
    let exe = bin.join(name);
    let prev = bin.join(prev_name);
    if !prev.is_file() {
        return Err(format!("置き換える前の実行ファイル(bin\\{prev_name})がありません"));
    }
    if exe.exists() && std::fs::remove_file(&exe).is_err() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
        let aside = bin.join(format!("atlas.old-{:x}{:x}{}", std::process::id(), nonce, if cfg!(windows) { ".exe" } else { "" }));
        std::fs::rename(&exe, &aside).map_err(|e| format!("今の bin\\{name} を移せません({e})"))?;
    }
    std::fs::copy(&prev, &exe).map_err(|e| format!("bin\\{prev_name} を bin\\{name} に写せません({e})"))?;
    // どのソースから作ったかの記録(調べるとき用)は、前のものと合わなくなるので消す
    let _ = std::fs::remove_file(bin.join("atlas-source.txt"));
    Ok(())
}

/// rollback の結果
#[derive(Debug, Clone, PartialEq)]
pub struct RollbackResult {
    pub ok: bool,
    pub reverted: bool,
    pub note: String,
}

/// 前の版(from_sha)に戻す。新しい版がこの PC で動かなかったとき(upload_auto.rs)に使う。手で変えたファイルが無いことは確かめてあるので、--keep で戻せる。
/// 実行ファイルが前の版のものでなければ、置き換える前のもの(bin/atlas.prev.exe)に戻す。ビルドはしない(ビルドに頼らずに送れるように。
/// 戻せなくても、呼んだプロセスが前の版の実行ファイルなので、この回はそのプロセスが送る)
pub fn rollback(o: &UpdateOptions<'_>, from_sha: &str) -> RollbackResult {
    let r = revert_commit(o, from_sha);
    if !r.ok {
        return r;
    }
    let s = short_s(from_sha);
    if exe_fresh(o) {
        return RollbackResult { ok: true, reverted: true, note: format!("前の版({s})に戻しました") };
    }
    let restored = match o.restore_exe {
        Some(f) => f(),
        None => restore_previous_exe(o.repo),
    };
    match restored {
        Ok(()) => {
            (o.log)("atlas の更新: 実行ファイルを、置き換える前のもの(bin\\atlas.prev.exe)に戻しました");
            RollbackResult { ok: true, reverted: true, note: format!("前の版({s})に戻し、実行ファイルも置き換える前のものに戻しました") }
        }
        Err(e) => RollbackResult { ok: true, reverted: true, note: format!("前の版({s})に戻しましたが、実行ファイルは前のものに戻せませんでした({e}。atlas.bat を開くとビルドし直します)") },
    }
}

/// コミットだけを戻す(新しい版の実行ファイルをビルドできなかったとき。実行ファイルは置き換えていないので、前と同じ実行ファイルのまま続ける。
/// 前の版をもう一度ビルドしに行かない)
fn revert_commit(o: &UpdateOptions<'_>, from_sha: &str) -> RollbackResult {
    let back = (o.runner())("git", &["reset", "--keep", from_sha], o.repo, GIT_TIMEOUT);
    let s = short_s(from_sha);
    if back.code != 0 {
        return RollbackResult { ok: false, reverted: false, note: format!("前の版({s})に戻せませんでした({})。atlas.bat を開いて確かめてください", reason_of(&back)) };
    }
    (o.log)(&format!("atlas の更新: 前の版({s})に戻しました"));
    RollbackResult { ok: true, reverted: true, note: format!("前の版({s})に戻しました(実行ファイルは置き換えていないので、前のまま)") }
}

/// コミットはそのままのときの、今のコミットの実行ファイル
#[derive(Debug, Clone, PartialEq)]
enum HeadExe {
    /// 今のコミットから作ったもの(か、起動用の .bat が直前にそろえた)。何もしない
    Fresh,
    /// 今のコミットから作ったものではないが、ビルドに要るもの(中身)が無いので、そのまま
    NoTools(String),
    /// ビルドし直した。できたか
    Built(bool),
}

/// 実行ファイルが今のコミットから作ったものでなければ(手で git pull した・前の回にビルドできなかった)、ビルドし直す
/// (起動用の .bat からは、直前に ensure-atlas.ps1 が同じことをしたので、しない)
fn refresh_head_exe(o: &UpdateOptions<'_>) -> HeadExe {
    if o.exe_just_ensured || exe_fresh(o) {
        return HeadExe::Fresh;
    }
    if let Some(m) = missing_tools(o) {
        return HeadExe::NoTools(m);
    }
    (o.log)(&format!("atlas の更新: 実行ファイルが今のソースから作ったものではないので、ビルドし直します(経過は {BUILD_LOG})"));
    HeadExe::Built(install_exe(o))
}

/// atlas 自身を新しい版にする(できるときだけ)。失敗は結果に書き、止めない
pub fn self_update(o: &UpdateOptions<'_>) -> AutoUpdateResult {
    let run = o.runner();
    let git = |args: &[&str]| run("git", args, o.repo, GIT_TIMEOUT);
    let make = |outcome: &str, from: Option<&str>, to: Option<&str>, note: String| AutoUpdateResult {
        outcome: outcome.into(),
        from: short(from),
        to: short(to),
        from_sha: Some(from.map(str::to_string)),
        to_sha: Some(to.map(str::to_string)),
        note,
    };
    let result = |outcome: &str, from: Option<&str>, to: Option<&str>, note: String| -> AutoUpdateResult {
        let r = make(outcome, from, to, note);
        (o.log)(&format!("atlas の更新: {}", r.note));
        r
    };
    let carry = o.carry_on;
    if !o.repo.join(".git").exists() {
        return result("skipped", None, None, "git で取得したフォルダではないので、更新しません(git clone し直すと、自動で新しい版にできます)".into());
    }
    let head = git(&["rev-parse", "HEAD"]);
    if head.code != 0 {
        return result("skipped", None, None, format!("git を使えないので、更新しません({})", reason_of(&head)));
    }
    let from = atlas_core::js::trim(&head.stdout).to_string();
    let from = Some(from.as_str());
    if let Some(busy) = o.busy.and_then(|b| b()) {
        return result("skipped", from, None, format!("atlas が動いている({busy})ので、今回は更新しません(次の回に新しい版にします)"));
    }
    let branch = atlas_core::js::trim(&git(&["rev-parse", "--abbrev-ref", "HEAD"]).stdout).to_string();
    let upstream = git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let main = atlas_core::js::trim(&git(&["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).stdout).to_string();
    let main = if main.is_empty() { "origin/main".to_string() } else { main };
    if upstream.code != 0 || atlas_core::js::trim(&upstream.stdout) != main {
        return result(
            "skipped",
            from,
            None,
            format!(
                "{main} を追っていないブランチ({})なので、更新しません(git switch {} で戻すと、次の回から新しい版にします)",
                if branch.is_empty() { "不明" } else { &branch },
                main.strip_prefix("origin/").unwrap_or(&main)
            ),
        );
    }
    let status = git(&["status", "--porcelain", "--untracked-files=no"]);
    if status.code != 0 {
        return result("skipped", from, None, format!("git の状態を読めないので、更新しません({})", reason_of(&status)));
    }
    let changed: Vec<String> = status
        .stdout
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !atlas_core::js::trim(l).is_empty())
        .map(|l| atlas_core::js::trim(&atlas_core::js::utf16_slice(l, 3, usize::MAX)).to_string())
        .collect();
    if !changed.is_empty() && changed.iter().all(|f| f == LOCK_FILE) {
        // npm install が書き直した package-lock.json(ほかに変えたファイルは無い)。元に戻してから進める
        let restore = git(&["checkout", "--", LOCK_FILE]);
        if restore.code != 0 {
            return result("skipped", from, None, format!("npm が書き換えた {LOCK_FILE} を元に戻せないので、更新しません({})", reason_of(&restore)));
        }
        (o.log)(&format!("atlas の更新: npm が書き換えた {LOCK_FILE} を元に戻しました"));
    } else if !changed.is_empty() {
        return result("skipped", from, None, "atlas のファイルを手で変えているので、更新しません(git status で確かめ、元に戻すと、次の回から新しい版にします)".into());
    }
    // 取りに行く前の origin の main(前に取りに行ったときのもの)。origin の履歴が書き換えられたかを見分けるのに使う
    let before = atlas_core::js::trim(&git(&["rev-parse", "@{u}"]).stdout).to_string();
    let fetch = run("git", &["fetch", "--quiet", "origin"], o.repo, o.fetch_timeout);
    if fetch.code != 0 {
        return result("failed", from, None, format!("新しい版を取りに行けなかったので、{carry}({}。次の回にもう一度試します)", reason_of(&fetch)));
    }
    let target = git(&["rev-parse", "@{u}"]);
    if target.code != 0 {
        return result("failed", from, None, format!("新しい版を確かめられなかったので、{carry}({})", reason_of(&target)));
    }
    let to = atlas_core::js::trim(&target.stdout).to_string();
    let from_s = from.unwrap_or_default();
    // コミットは変えないとき(使わない・早送りできない)の、今のコミットの実行ファイルの結果(結果の文の後ろに足す)
    let head_exe_note = |r: HeadExe| match r {
        HeadExe::Fresh => String::new(),
        HeadExe::NoTools(m) => format!("。今の実行ファイルは今のソースから作ったものではありませんが、Rust などが無いので作り直していません(足りないもの: {m})"),
        HeadExe::Built(true) => "。今の版の実行ファイルは、今のソースからビルドし直しました".to_string(),
        HeadExe::Built(false) => format!("。今の版の実行ファイルもビルドできませんでした(次の回にもう一度試します。経過は {BUILD_LOG})"),
    };
    if to == from_s {
        return match refresh_head_exe(o) {
            HeadExe::Fresh => {
                // 何もしなかった。起動用の .bat から開くたびに動かすので、そのときは何も出さない
                let r = make("latest", from, from, format!("最新です({})", short_s(from_s)));
                if !o.quiet_latest {
                    (o.log)(&format!("atlas の更新: {}", r.note));
                }
                r
            }
            HeadExe::NoTools(m) => result(
                "skipped",
                from,
                from,
                format!("最新です({})が、実行ファイルは今のソースから作ったものではありません。Rust などが無いので作り直さず、{carry}(足りないもの: {m})", short_s(from_s)),
            ),
            HeadExe::Built(true) => result("latest", from, from, format!("最新です({})。実行ファイルを今のソースからビルドし直しました", short_s(from_s))),
            HeadExe::Built(false) => {
                result("failed", from, from, format!("最新です({})が、今のソースから実行ファイルをビルドできなかったので、{carry}(次の回にもう一度試します。経過は {BUILD_LOG})", short_s(from_s)))
            }
        };
    }
    if o.avoid.as_deref().is_some_and(|a| !a.is_empty() && a == to) {
        let exe = head_exe_note(refresh_head_exe(o));
        return result("skipped", from, None, format!("新しい版({})は前にこの PC で動かなかったので、使いません(もっと新しい版が出たら、それにします){exe}", short_s(&to)));
    }
    // 前にこの PC でビルドできなかったコミットは、起動用の .bat からはもう試さない(開くたびに数分待たせない)。自動で送るタスクは 1 日に 1 回まで試す
    if let Some((_, age)) = failed_build(o).filter(|(sha, _)| *sha == to) {
        if o.exe_just_ensured || age < RETRY_FAILED_BUILD_AFTER {
            let retry = if o.exe_just_ensured { "" } else { "自動で送るタスクは、1 日たったらもう一度試します。" };
            return result(
                "skipped",
                from,
                None,
                format!(
                    "新しい版({})は前にこの PC でビルドできなかったので、今回は取り込みません。{carry}(もっと新しい版が出たら、それにします。{retry}経過は {BUILD_LOG}。bin\\{FAILED_BUILD_FILE} を消すと、次の回にもう一度試します)",
                    short_s(&to)
                ),
            );
        }
    }
    // 新しい版の実行ファイルは、ここでビルドするしかない。ビルドに要るものが無ければ、取り込まない(前の版の実行ファイルで、新しい版の
    // .bat やスクリプトを動かさないように)
    if let Some(m) = missing_tools(o) {
        return result(
            "skipped",
            from,
            None,
            format!("新しい版({})がありますが、Rust などが無いので新しい版にしていません(足りないもの: {m}。atlas.exe はこの PC でビルドするので、入れると次の回から新しい版にします)。{carry}", short_s(&to)),
        );
    }
    let is_ancestor = |a: &str, b: &str| git(&["merge-base", "--is-ancestor", a, b]).code == 0;
    // origin の履歴が書き換えられていて(force push)、新しい main に合わせ直したか
    let mut rewritten = false;
    if is_ancestor(from_s, &to) {
        let merge = git(&["merge", "--ff-only", "--quiet", &to]);
        if merge.code != 0 {
            return result("skipped", from, None, format!("新しい版を取り込めないので、更新しません({})", reason_of(&merge)));
        }
    } else if !before.is_empty() && before != to && is_ancestor(from_s, &before) && !is_ancestor(&before, &to) {
        // 早送りできないのが、origin の履歴が書き換えられたためだけのとき。手で変えたファイルが無いことは確かめてあるので、
        // 新しい main に合わせ直す(--keep は、手元の変更を消さない。前の版のコミットも手元には残る)
        let reset = git(&["reset", "--keep", &to]);
        if reset.code != 0 {
            return result("skipped", from, None, format!("origin の履歴が書き換えられていて、新しい版に合わせられないので、更新しません({})", reason_of(&reset)));
        }
        rewritten = true;
        (o.log)(&format!("atlas の更新: origin の {main} の履歴が書き換えられていたので、新しい {main} に合わせました"));
    } else {
        let exe = head_exe_note(refresh_head_exe(o));
        return result("skipped", from, None, format!("早送りだけでは新しい版にできないので、更新しません(手元にだけあるコミットがあるなど。git log {main}..HEAD で確かめられます){exe}"));
    }
    (o.log)(&format!("atlas の更新: 新しい版({})を取り込みました", short_s(&to)));
    if !exe_fresh(o) {
        (o.log)(&format!("atlas の更新: 版が変わったので、新しい版の実行ファイルをビルドします(数分かかることがあります。経過は {BUILD_LOG})"));
        if !install_exe(o) {
            // 新しい版のソースを、前の版の実行ファイルで動かさない(設定やファイルの形が合わないことがある)。実行ファイルは置き換えていないので、
            // コミットだけを戻せば、前と同じ実行ファイルで続けられる
            let back = revert_commit(o, from_s);
            // 同じコミットを次にいつ試すか(bin/build-failed.txt を見て決める。上の「前にこの PC でビルドできなかった」)
            let retry = if o.exe_just_ensured { "同じ版はもう試さず、もっと新しい版が出たらそれにします" } else { "同じ版は 1 日たったらもう一度試します" };
            let note = if back.ok {
                format!("新しい版({})の実行ファイルをビルドできなかったので、{}。{carry}({retry}。経過は {BUILD_LOG})", short_s(&to), back.note)
            } else {
                format!("新しい版({})の実行ファイルをビルドできず、{}", short_s(&to), back.note)
            };
            return result("failed", from, Some(if back.reverted { from_s } else { &to }), note);
        }
    }
    let note = format!(
        "{} から {} に更新しました{}",
        short_s(from_s),
        short_s(&to),
        if rewritten { format!("(origin の {main} の履歴が書き換えられていたので、新しい {main} に合わせました)") } else { String::new() }
    );
    result("updated", from, Some(&to), note)
}

/// `atlas self-update` の終了コード: チェックアウトのコミットが変わった(起動用の .bat は、自分を動かし直す)
pub const UPDATED_EXIT: u8 = 10;
/// 起動用の .bat を開いたときに更新しない(1 のとき)
pub const NO_AUTO_UPDATE_ENV: &str = "ATLAS_NO_AUTO_UPDATE";

/// 終了コード: コミットが変わったら UPDATED_EXIT、それ以外(最新・しなかった・失敗した)はいつも 0(開くのを止めない)
fn exit_code(from_sha: Option<&str>, head_after: Option<&str>) -> u8 {
    match (from_sha, head_after) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() && a != b => UPDATED_EXIT,
        _ => 0,
    }
}

/// 起動用の .bat から(`atlas self-update`。使い方には出さない)。自動で送るタスクと同じ確かめをして、できるときだけ新しい版にする。
/// 出すのは、したこと・しなかった理由だけ(最新なら何も出さない)。
/// git が .bat を書き換えたかもしれないので、コミットが変わったら UPDATED_EXIT で終わる。.bat は 1 行の中で自分を動かし直す
/// (cmd は .bat を、読んだところまでの位置で読み進めるので、書き換えた後の行を、ずれた位置から読まないように)
pub fn main(_argv: &[String]) -> u8 {
    if std::env::var(NO_AUTO_UPDATE_ENV).is_ok_and(|v| v == "1") {
        return 0;
    }
    let out_dir = crate::paths::auto_out_dir();
    let repo = crate::paths::REPO_ROOT.clone();
    let log = |line: &str| {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    };
    let busy = || crate::upload_auto::atlas_running(&out_dir);
    let mut o = UpdateOptions::new(&repo, &log);
    o.busy = Some(&busy);
    o.avoid = crate::upload_auto::read_avoid(&out_dir);
    o.carry_on = "今の版のまま開きます";
    o.quiet_latest = true;
    o.exe_just_ensured = true;
    o.fetch_timeout = LAUNCHER_FETCH_TIMEOUT;
    let r = self_update(&o);
    let head = run_cmd("git", &["rev-parse", "HEAD"], &repo, GIT_TIMEOUT);
    let head = (head.code == 0).then(|| atlas_core::js::trim(&head.stdout).to_string());
    exit_code(r.from_sha(), head.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;

    /// 一時フォルダに本物の git のリポジトリ(origin・作る側・自動で送る側)を作る。この PC の git の設定は使わない
    struct Repos {
        _d: tempfile::TempDir,
        dev: PathBuf,
        member: PathBuf,
        cfg: PathBuf,
        /// ビルドに要るもののうち、無いもの(None ならそろっている)
        missing: RefCell<Option<String>>,
        /// ビルドに要るものを確かめた回数
        tool_checks: RefCell<usize>,
        /// 前にビルドできなかったコミットと、それからの時間
        failed: RefCell<Option<(String, Duration)>>,
    }

    impl Repos {
        fn git(&self, cwd: &Path, args: &[&str]) -> String {
            let o = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_GLOBAL", &self.cfg)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "test")
                .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
                .env("GIT_COMMITTER_NAME", "test")
                .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
                .output()
                .unwrap();
            assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
        fn new() -> Self {
            let d = tempfile::tempdir().unwrap();
            let base = d.path().to_path_buf();
            let cfg = base.join("gitconfig");
            fs::write(&cfg, "").unwrap();
            let r = Repos { dev: base.join("dev"), member: base.join("member"), cfg, _d: d, missing: RefCell::new(None), tool_checks: RefCell::new(0), failed: RefCell::new(None) };
            let origin = base.join("origin.git");
            r.git(&base, &["init", "-q", "--bare", "-b", "main", &origin.to_string_lossy()]);
            r.git(&base, &["clone", "-q", &origin.to_string_lossy(), &r.dev.to_string_lossy()]);
            r.git(&r.dev, &["checkout", "-q", "-b", "main"]);
            fs::write(r.dev.join("a.txt"), "first").unwrap();
            r.git(&r.dev, &["add", "-A"]);
            r.git(&r.dev, &["commit", "-q", "-m", "first"]);
            r.git(&r.dev, &["push", "-q", "-u", "origin", "main"]);
            r.git(&base, &["clone", "-q", &origin.to_string_lossy(), &r.member.to_string_lossy()]);
            r
        }
        fn release(&self, file: &str, text: &str) -> String {
            fs::write(self.dev.join(file), text).unwrap();
            self.git(&self.dev, &["add", "-A"]);
            self.git(&self.dev, &["commit", "-q", "-m", &format!("update {file}")]);
            self.git(&self.dev, &["push", "-q", "origin", "main"]);
            self.head(&self.dev)
        }
        fn head(&self, cwd: &Path) -> String {
            self.git(cwd, &["rev-parse", "HEAD"])
        }
        /// 偽の実行ファイルの口で更新する(git は本物。この PC の設定は使わない)
        fn update(&self, fresh: bool, installs: &dyn Fn() -> bool, avoid: Option<String>, busy: Option<&dyn Fn() -> Option<String>>) -> (AutoUpdateResult, Vec<String>) {
            self.update_as(fresh, installs, avoid, busy, false)
        }
        /// launcher: 起動用の .bat から(直前に ensure-atlas.ps1 で実行ファイルをそろえてある)
        fn update_as(&self, fresh: bool, installs: &dyn Fn() -> bool, avoid: Option<String>, busy: Option<&dyn Fn() -> Option<String>>, launcher: bool) -> (AutoUpdateResult, Vec<String>) {
            let logs = RefCell::new(Vec::new());
            let log = |l: &str| logs.borrow_mut().push(l.to_string());
            let cfg = self.cfg.clone();
            let run = move |cmd: &str, args: &[&str], cwd: &Path, t: Duration| -> CmdResult {
                // テストでは git にこの PC の設定を読ませない
                unsafe_env_free_run(cmd, args, cwd, t, &cfg)
            };
            let fresh_f = move || fresh;
            let tools = || {
                *self.tool_checks.borrow_mut() += 1;
                self.missing.borrow().clone()
            };
            let failed = || self.failed.borrow().clone();
            let mut o = UpdateOptions::new(&self.member, &log);
            o.run = Some(&run);
            o.exe_fresh = Some(&fresh_f);
            o.install_exe = Some(installs);
            o.missing_tools = Some(&tools);
            o.failed_build = Some(&failed);
            o.avoid = avoid;
            o.busy = busy;
            o.exe_just_ensured = launcher;
            let r = self_update(&o);
            (r, logs.into_inner())
        }
    }

    fn unsafe_env_free_run(cmd: &str, args: &[&str], cwd: &Path, _t: Duration, cfg: &Path) -> CmdResult {
        let o = Command::new(cmd).args(args).current_dir(cwd).env("GIT_CONFIG_GLOBAL", cfg).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_TERMINAL_PROMPT", "0").output();
        match o {
            Ok(o) => CmdResult { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into(), stderr: String::from_utf8_lossy(&o.stderr).into() },
            Err(e) => CmdResult { code: -1, stdout: String::new(), stderr: e.to_string() },
        }
    }

    #[test]
    fn fast_forward_latest_avoid_and_rollback() {
        let r = Repos::new();
        let before = r.head(&r.member);
        let yes = || true;
        let (u, _) = r.update(true, &yes, None, None);
        assert_eq!((u.outcome.as_str(), u.from.as_deref(), u.to.as_deref()), ("latest", Some(&before[..7]), Some(&before[..7])));
        // 最新で実行ファイルも今のコミットのものなら、ビルドに要るものは確かめない
        assert_eq!(*r.tool_checks.borrow(), 0);
        let next = r.release("a.txt", "second");
        let (u, logs) = r.update(true, &yes, None, None);
        assert_eq!(u.outcome, "updated");
        assert_eq!(r.head(&r.member), next);
        assert!(logs.join("\n").contains(&format!("{} から {} に更新しました", &before[..7], &next[..7])));
        // ビルドできたら、新しい版の実行ファイルで続ける
        r.release("a.txt", "built");
        let n = RefCell::new(0);
        let counted = || {
            *n.borrow_mut() += 1;
            true
        };
        let (u, logs) = r.update(false, &counted, None, None);
        assert_eq!(u.outcome, "updated");
        assert_eq!(*n.borrow(), 1);
        assert!(logs.iter().any(|l| l.starts_with("atlas の更新: 版が変わったので、新しい版の実行ファイルをビルドします")), "{logs:?}");
        // ビルドできなければ前の版に戻す。実行ファイルは置き換えていないので、前の版をビルドし直しには行かない(今の実行ファイルのまま送る)
        let mid = r.head(&r.member);
        r.release("package-lock.json", "{\"v\":3}");
        let n = RefCell::new(0);
        let fails = || {
            *n.borrow_mut() += 1;
            false
        };
        let (u, _) = r.update(false, &fails, None, None);
        assert_eq!((u.outcome.as_str(), u.from.as_deref(), u.to.as_deref(), u.from_sha()), ("failed", Some(&mid[..7]), Some(&mid[..7]), Some(mid.as_str())));
        assert_eq!(
            u.note,
            format!(
                "新しい版({})の実行ファイルをビルドできなかったので、前の版({})に戻しました(実行ファイルは置き換えていないので、前のまま)。今の版のまま送ります(同じ版は 1 日たったらもう一度試します。経過は bin\\build.log)",
                &r.head(&r.dev)[..7],
                &mid[..7]
            )
        );
        assert_eq!(*n.borrow(), 1);
        assert_eq!(r.head(&r.member), mid);
        // 前にこの PC で動かなかった版は使わない。もっと新しい版が出たら、それにする
        let bad = r.git(&r.dev, &["rev-parse", "HEAD"]);
        let (u, _) = r.update(true, &yes, Some(bad.clone()), None);
        assert_eq!(u.outcome, "skipped");
        assert!(u.note.contains("前にこの PC で動かなかったので、使いません"));
        let newer = r.release("a.txt", "third");
        let (u, _) = r.update(true, &yes, Some(bad), None);
        assert_eq!(u.outcome, "updated");
        assert_eq!(r.head(&r.member), newer);
    }

    #[test]
    fn without_build_tools_new_commits_are_not_pulled_and_the_current_exe_keeps_going() {
        let r = Repos::new();
        let before = r.head(&r.member);
        *r.missing.borrow_mut() = Some("Rust(cargo)、Visual Studio の C++ のビルドツール(MSVC)".into());
        let n = RefCell::new(0);
        let installs = || {
            *n.borrow_mut() += 1;
            true
        };
        let next = r.release("a.txt", "second");
        let (u, logs) = r.update(false, &installs, None, None);
        assert_eq!((u.outcome.as_str(), u.from_sha(), u.to_sha()), ("skipped", Some(before.as_str()), None));
        assert_eq!(
            u.note,
            format!(
                "新しい版({})がありますが、Rust などが無いので新しい版にしていません(足りないもの: Rust(cargo)、Visual Studio の C++ のビルドツール(MSVC)。atlas.exe はこの PC でビルドするので、入れると次の回から新しい版にします)。今の版のまま送ります",
                &next[..7]
            )
        );
        assert!(logs.iter().any(|l| l.contains("Rust などが無いので新しい版にしていません")), "{logs:?}");
        // 早送りしていない(取り込んでから戻したのでもない)。ビルドもしない
        assert_eq!(r.head(&r.member), before);
        let reflog = r.git(&r.member, &["reflog", "--format=%gs"]);
        assert!(!reflog.contains("merge") && !reflog.contains("reset"), "{reflog}");
        assert_eq!(*n.borrow(), 0);
        // 入れたら、次の回に新しい版にする
        *r.missing.borrow_mut() = None;
        let (u, _) = r.update(false, &installs, None, None);
        assert_eq!((u.outcome.as_str(), u.to_sha()), ("updated", Some(next.as_str())));
        assert_eq!(*n.borrow(), 1);
    }

    #[test]
    fn a_stale_exe_at_the_current_commit_is_rebuilt_or_kept() {
        let r = Repos::new();
        let head = r.head(&r.member);
        let n = RefCell::new(0);
        let installs = || {
            *n.borrow_mut() += 1;
            true
        };
        // 手で git pull したなど: コミットは最新だが、実行ファイルが今のコミットのものではない。自動で送るタスクはビルドし直す
        let (u, logs) = r.update(false, &installs, None, None);
        assert_eq!((u.outcome.as_str(), u.note.as_str()), ("latest", format!("最新です({})。実行ファイルを今のソースからビルドし直しました", &head[..7]).as_str()));
        assert!(logs.iter().any(|l| l.starts_with("atlas の更新: 実行ファイルが今のソースから作ったものではないので、ビルドし直します")), "{logs:?}");
        assert_eq!(*n.borrow(), 1);
        // ビルドできなければ、今の実行ファイルのまま続ける(戻すコミットは無い)
        let no = || false;
        let (u, _) = r.update(false, &no, None, None);
        assert_eq!(u.outcome, "failed");
        assert_eq!(u.note, format!("最新です({})が、今のソースから実行ファイルをビルドできなかったので、今の版のまま送ります(次の回にもう一度試します。経過は bin\\build.log)", &head[..7]));
        assert_eq!(r.head(&r.member), head);
        // ビルドに要るものが無ければ、ビルドしに行かずにそのまま続け、そのことを結果に残す(最新でも結果を見せる skipped)
        *r.missing.borrow_mut() = Some("Rust(cargo)".into());
        let (u, _) = r.update(false, &installs, None, None);
        assert_eq!(u.outcome, "skipped");
        assert_eq!(u.note, format!("最新です({})が、実行ファイルは今のソースから作ったものではありません。Rust などが無いので作り直さず、今の版のまま送ります(足りないもの: Rust(cargo))", &head[..7]));
        assert_eq!(*n.borrow(), 1);
        // 起動用の .bat からは、確かめ直さない(直前に ensure-atlas.ps1 -KeepOlder がそろえたか、そろえられないことを出した)
        let checks = *r.tool_checks.borrow();
        let (u, logs) = r.update_as(false, &installs, None, None, true);
        assert_eq!((u.outcome.as_str(), u.note.as_str()), ("latest", format!("最新です({})", &head[..7]).as_str()));
        assert!(logs.iter().all(|l| !l.contains("ビルド")), "{logs:?}");
        assert_eq!((*n.borrow(), *r.tool_checks.borrow()), (1, checks));
    }

    #[test]
    fn the_tools_check_reads_the_script_result() {
        let res = |code: i32, stdout: &str| CmdResult { code, stdout: stdout.into(), stderr: String::new() };
        assert_eq!(parse_missing_tools(&res(0, "")), None);
        assert_eq!(parse_missing_tools(&res(1, "Node.js、Rust(cargo)\r\n")).as_deref(), Some("Node.js、Rust(cargo)"));
        assert_eq!(parse_missing_tools(&res(1, "")).as_deref(), Some("Node.js・Rust など"));
        // PowerShell を動かせない(ビルドもできない)
        let none = CmdResult { code: -1, stdout: String::new(), stderr: "program not found".into() };
        assert_eq!(parse_missing_tools(&none).as_deref(), Some("確かめられませんでした: program not found"));
    }

    #[test]
    fn hand_edited_checkouts_are_left_alone() {
        let r = Repos::new();
        let yes = || true;
        // 管理しているファイルを手で変えていれば、新しい版にしない
        fs::write(r.member.join("a.txt"), "local").unwrap();
        r.release("a.txt", "second");
        let (u, _) = r.update(true, &yes, None, None);
        assert_eq!(u.outcome, "skipped");
        assert!(u.note.contains("手で変えているので"));
        r.git(&r.member, &["checkout", "--", "a.txt"]);
        // package-lock.json だけなら元に戻してから進める
        r.release("package-lock.json", "{}");
        r.update(true, &yes, None, None);
        fs::write(r.member.join("package-lock.json"), "{\"rewritten\":true}").unwrap();
        r.release("a.txt", "third");
        let (u, logs) = r.update(true, &yes, None, None);
        assert_eq!(u.outcome, "updated");
        assert!(logs.iter().any(|l| l == "atlas の更新: npm が書き換えた package-lock.json を元に戻しました"));
        // main 以外のブランチなら、新しい版にしない
        r.git(&r.member, &["switch", "-q", "-c", "topic"]);
        let (u, _) = r.update(true, &yes, None, None);
        assert_eq!(u.outcome, "skipped");
        assert_eq!(u.note, "origin/main を追っていないブランチ(topic)なので、更新しません(git switch main で戻すと、次の回から新しい版にします)");
        r.git(&r.member, &["switch", "-q", "main"]);
        // 動いていれば取りに行かない
        let busy = || Some("画面のサーバ。x".to_string());
        let (u, _) = r.update(true, &yes, None, Some(&busy));
        assert_eq!(u.outcome, "skipped");
        assert_eq!(u.note, "atlas が動いている(画面のサーバ。x)ので、今回は更新しません(次の回に新しい版にします)");
        // git で取得したフォルダでなければ、何もしない
        let plain = tempfile::tempdir().unwrap();
        let log = |_: &str| {};
        let o = UpdateOptions::new(plain.path(), &log);
        let u = self_update(&o);
        assert_eq!(u.outcome, "skipped");
        assert_eq!(u.from_sha, Some(None));
        // git を動かせなければ、何もしない
        let mut o = UpdateOptions::new(&r.member, &log);
        let none = |_: &str, _: &[&str], _: &Path, _: Duration| CmdResult { code: -1, stdout: String::new(), stderr: "spawn git ENOENT".into() };
        o.run = Some(&none);
        let u = self_update(&o);
        assert_eq!(u.note, "git を使えないので、更新しません(spawn git ENOENT)");
    }

    #[test]
    fn a_rewritten_origin_is_followed_when_nothing_is_local() {
        let r = Repos::new();
        let yes = || true;
        r.release("a.txt", "second");
        r.update(true, &yes, None, None);
        // origin の main を書き換える(force push)
        r.git(&r.dev, &["reset", "-q", "--hard", "HEAD~1"]);
        fs::write(r.dev.join("b.txt"), "other").unwrap();
        r.git(&r.dev, &["add", "-A"]);
        r.git(&r.dev, &["commit", "-q", "-m", "rewritten"]);
        r.git(&r.dev, &["push", "-q", "--force", "origin", "main"]);
        let rewritten = r.head(&r.dev);
        let (u, _) = r.update(true, &yes, None, None);
        assert_eq!((u.outcome.as_str(), u.to_sha()), ("updated", Some(rewritten.as_str())));
        assert!(u.note.ends_with("(origin の origin/main の履歴が書き換えられていたので、新しい origin/main に合わせました)"), "{}", u.note);
        assert_eq!(r.head(&r.member), rewritten);
    }

    #[test]
    fn launcher_wording_quiet_when_latest_and_exit_code() {
        let r = Repos::new();
        let logs = RefCell::new(Vec::new());
        let log = |l: &str| logs.borrow_mut().push(l.to_string());
        let cfg = r.cfg.clone();
        let run = move |cmd: &str, args: &[&str], cwd: &Path, t: Duration| unsafe_env_free_run(cmd, args, cwd, t, &cfg);
        let yes = || true;
        let tools = || None;
        let mut o = UpdateOptions::new(&r.member, &log);
        o.run = Some(&run);
        o.exe_fresh = Some(&yes);
        o.install_exe = Some(&yes);
        o.missing_tools = Some(&tools);
        o.carry_on = "今の版のまま開きます";
        o.quiet_latest = true;
        // 最新なら何も出さない
        let u = self_update(&o);
        assert_eq!(u.outcome, "latest");
        assert_eq!(*logs.borrow(), Vec::<String>::new());
        // 取りに行けなければ、開く側の言い方で 1 行
        r.git(&r.member, &["remote", "set-url", "origin", &r.member.join("no-such-origin").to_string_lossy()]);
        let u = self_update(&o);
        assert_eq!(u.outcome, "failed");
        assert!(u.note.starts_with("新しい版を取りに行けなかったので、今の版のまま開きます("), "{}", u.note);
        assert_eq!(logs.borrow().len(), 1);
        // コミットが変わったときだけ UPDATED_EXIT
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        assert_eq!(exit_code(Some(&a), Some(&b)), UPDATED_EXIT);
        assert_eq!(exit_code(Some(&a), Some(&a)), 0);
        assert_eq!(exit_code(None, Some(&a)), 0);
        assert_eq!(exit_code(Some(&a), None), 0);
    }

    #[test]
    fn rollback_restores_the_previous_exe_without_building() {
        let r = Repos::new();
        let first = r.head(&r.member);
        r.release("a.txt", "second");
        let yes = || true;
        r.update(true, &yes, None, None);
        let logs = RefCell::new(Vec::new());
        let log = |l: &str| logs.borrow_mut().push(l.to_string());
        let cfg = r.cfg.clone();
        let run = move |cmd: &str, args: &[&str], cwd: &Path, t: Duration| unsafe_env_free_run(cmd, args, cwd, t, &cfg);
        let stale = || false;
        // ビルドしに行ったら失敗にする(戻すときはビルドしない)
        let builds = RefCell::new(0);
        let build = || {
            *builds.borrow_mut() += 1;
            false
        };
        let restores = RefCell::new(0);
        let restore = || {
            *restores.borrow_mut() += 1;
            Ok(())
        };
        let mut o = UpdateOptions::new(&r.member, &log);
        o.run = Some(&run);
        o.exe_fresh = Some(&stale);
        o.install_exe = Some(&build);
        o.restore_exe = Some(&restore);
        let b = rollback(&o, &first);
        assert_eq!(b, RollbackResult { ok: true, reverted: true, note: format!("前の版({})に戻し、実行ファイルも置き換える前のものに戻しました", &first[..7]) });
        assert_eq!(r.head(&r.member), first);
        assert_eq!((*builds.borrow(), *restores.borrow()), (0, 1));
        // 前のものに戻せなくても、コミットは戻せたので ok(この回は、呼んだプロセス(前の版)が送る)
        r.git(&r.member, &["reset", "-q", "--hard", "origin/main"]);
        let broken = || Err("置き換える前の実行ファイル(bin\\atlas.prev.exe)がありません".to_string());
        o.restore_exe = Some(&broken);
        let b = rollback(&o, &first);
        assert!(b.ok && b.reverted, "{b:?}");
        assert!(b.note.contains("実行ファイルは前のものに戻せませんでした(置き換える前の実行ファイル"), "{}", b.note);
        assert_eq!(*builds.borrow(), 0);
        // 実行ファイルがもう前の版のものなら、何も戻さない
        r.git(&r.member, &["reset", "-q", "--hard", "origin/main"]);
        o.exe_fresh = Some(&yes);
        o.restore_exe = Some(&restore);
        let b = rollback(&o, &first);
        assert_eq!(b.note, format!("前の版({})に戻しました", &first[..7]));
        assert_eq!(*restores.borrow(), 1);
    }

    #[test]
    fn restore_previous_exe_copies_the_kept_one_back() {
        let d = tempfile::tempdir().unwrap();
        let bin = d.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let (name, prev) = exe_names();
        assert_eq!(restore_previous_exe(d.path()), Err(format!("置き換える前の実行ファイル(bin\\{prev})がありません")));
        fs::write(bin.join(name), "new").unwrap();
        fs::write(bin.join(prev), "old").unwrap();
        fs::write(bin.join("atlas-source.txt"), "local x\n").unwrap();
        restore_previous_exe(d.path()).unwrap();
        assert_eq!(fs::read_to_string(bin.join(name)).unwrap(), "old");
        // 前のものは残す(呼んだプロセスが動かしていることがある)
        assert_eq!(fs::read_to_string(bin.join(prev)).unwrap(), "old");
        assert!(!bin.join("atlas-source.txt").exists());
    }

    #[test]
    fn a_commit_that_failed_to_build_is_not_retried_from_launchers_and_once_a_day_from_the_task() {
        let r = Repos::new();
        let before = r.head(&r.member);
        let next = r.release("a.txt", "second");
        let n = RefCell::new(0);
        let installs = || {
            *n.borrow_mut() += 1;
            true
        };
        *r.failed.borrow_mut() = Some((next.clone(), Duration::from_secs(60)));
        // 起動用の .bat からは、同じコミットをもう試さない
        let (u, _) = r.update_as(true, &installs, None, None, true);
        assert_eq!(u.outcome, "skipped");
        assert!(u.note.starts_with(&format!("新しい版({})は前にこの PC でビルドできなかったので、今回は取り込みません。", &next[..7])), "{}", u.note);
        assert!(!u.note.contains("1 日たったら"));
        assert_eq!((r.head(&r.member), *n.borrow()), (before.clone(), 0));
        // 自動で送るタスクも、1 日たつまでは試さない
        let (u, _) = r.update(true, &installs, None, None);
        assert_eq!(u.outcome, "skipped");
        assert!(u.note.contains("自動で送るタスクは、1 日たったらもう一度試します。"), "{}", u.note);
        assert_eq!(*n.borrow(), 0);
        // 起動用の .bat は、1 日たっても同じコミットは試さない
        *r.failed.borrow_mut() = Some((next.clone(), Duration::from_secs(21 * 60 * 60)));
        let (u, _) = r.update_as(true, &installs, None, None, true);
        assert_eq!(u.outcome, "skipped");
        // 自動で送るタスクは、1 日たったらもう一度試す
        let (u, _) = r.update(false, &installs, None, None);
        assert_eq!((u.outcome.as_str(), u.to_sha()), ("updated", Some(next.as_str())));
        assert_eq!(*n.borrow(), 1);
        // もっと新しいコミットが出たら、起動用の .bat からも試す
        *r.failed.borrow_mut() = Some((next.clone(), Duration::from_secs(60)));
        let newer = r.release("a.txt", "third");
        let (u, _) = r.update_as(false, &installs, None, None, true);
        assert_eq!((u.outcome.as_str(), u.to_sha()), ("updated", Some(newer.as_str())));
    }

    #[test]
    fn the_failed_build_file_is_read_with_its_age() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read_failed_build(d.path()), None);
        fs::create_dir_all(d.path().join("bin")).unwrap();
        fs::write(d.path().join("bin").join(FAILED_BUILD_FILE), format!("{}\r\n", "c".repeat(40))).unwrap();
        let (sha, age) = read_failed_build(d.path()).unwrap();
        assert_eq!(sha, "c".repeat(40));
        assert!(age < Duration::from_secs(60 * 60));
    }

    /// 時間切れで止めるときは子孫ごと止める(ensure-atlas.ps1 が動かした cargo などを残さない)。
    /// 子の cmd が、親が止められた後に印のファイルを書く。子孫ごと止まれば書かれない
    #[cfg(windows)]
    #[test]
    fn a_timed_out_command_is_stopped_with_its_children() {
        let d = tempfile::tempdir().unwrap();
        let mark = d.path().join("mark.txt");
        let line = format!("start /b cmd /d /c \"ping -n 4 127.0.0.1 >nul & echo x > \"{}\"\" & ping -n 30 127.0.0.1 >nul", mark.display());
        let started = Instant::now();
        let r = run_cmd("cmd.exe", &["/d", "/s", "/c", &line], d.path(), Duration::from_secs(1));
        assert_eq!(r.code, -1);
        // 子が残っていれば、出力のパイプが閉じるまで待たされる
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        std::thread::sleep(Duration::from_secs(5));
        assert!(!mark.exists(), "子のプロセスが残って書いた");
    }
}
