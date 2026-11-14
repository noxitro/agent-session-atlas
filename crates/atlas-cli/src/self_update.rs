//! 自動で送る前に、atlas 自身を新しい版にする(TS 版の packages/cli/src/self-update.ts の移植。schedule-upload.bat で登録したタスクが、upload_auto.rs から呼ぶ)。
//! 作業メンバーは定期の自動送信しか使わず、atlas.bat を開かないので、git pull しないままだと古い版で送り続けてしまうため。
//!
//! 新しい版にするのは、次をすべて満たすときだけ(手で触っているチェックアウトを壊さない):
//!  - git で取得したフォルダ(.git がある)で、git が使える
//!  - atlas の処理(画面のサーバ・集計など)が、このチェックアウトで動いていない
//!  - 今のブランチが、origin の既定のブランチ(origin/HEAD。分からなければ origin/main)を追っている
//!  - git が管理しているファイルを手で変えていない。ただし package-lock.json だけが変わっているときは、npm が書き換えたものとして元に戻してから進める
//!  - 早送り(fast-forward)だけで新しい版になる。ただし、origin の履歴が書き換えられた(force push)だけで、手元にだけあるコミットが無いときは、新しい main に合わせ直す
//!  - 新しい版が、前にこの PC で動かなかった版(avoid)ではない
//!
//! 実行ファイル(bin/atlas.exe)は git pull では新しくならない。取り込んだ版の実行ファイルは、起動用の .bat と同じ scripts/ensure-atlas.ps1 で用意する
//! (Cargo.toml の version と同じ版のリリースがあれば取ってきて sha256 を確かめ、無ければ Node と Rust があればここでビルドする)。
//! 用意できなければ、前の版に戻して前の版の実行ファイルを用意し直す(rollback)。
//! ダウンロードと検証とビルドの手順は .bat と同じものを使いたいので、Rust で書き直さずにスクリプトを呼ぶ(HTTP と TLS のクレートを実行ファイルに入れずに済む)。
//! どれかで止まっても、送ることは止めない(今の版のまま送る)。何をしたか・しなかった理由と、どうすれば新しい版になるかは、記録と結果に残す。

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
    let out = read(child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
    let err = read(child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                return CmdResult { code: st.code().unwrap_or(-1), stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() };
            }
            Ok(None) if started.elapsed() > timeout => {
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
    /// bin/ の実行ファイルが、今のチェックアウトの版のものか(既定は scripts/ensure-atlas.ps1 -Check)
    pub exe_fresh: Option<&'a dyn Fn() -> bool>,
    /// 今のチェックアウトの版の実行ファイルを用意する。用意できたら true(既定は scripts/ensure-atlas.ps1)
    pub install_exe: Option<&'a dyn Fn() -> bool>,
    /// このチェックアウトで atlas の処理が動いていれば、その説明(動いていれば更新しない)
    pub busy: Option<&'a dyn Fn() -> Option<String>>,
    /// 使わない版(前にこの PC で動かなかった版。コミットの全桁)
    pub avoid: Option<String>,
}

impl<'a> UpdateOptions<'a> {
    pub fn new(repo: &'a Path, log: &'a dyn Fn(&str)) -> Self {
        UpdateOptions { repo, log, run: None, exe_fresh: None, install_exe: None, busy: None, avoid: None }
    }
    fn runner(&self) -> CmdRunner<'a> {
        self.run.unwrap_or(&run_cmd)
    }
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// 実行ファイルを用意する長さ(リリースが無くてここでビルドするときは、初めてなら数分かかる)
const ENSURE_TIMEOUT: Duration = Duration::from_secs(40 * 60);
/// npm が書き換えることのある、git が管理しているファイル(これだけが変わっているときは、元に戻してから進める)
const LOCK_FILE: &str = "package-lock.json";

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

/// scripts/ensure-atlas.ps1 を動かす(Windows は Windows PowerShell、ほかは pwsh)。窓は出さない
fn ensure_script(o: &UpdateOptions<'_>, check: bool) -> CmdResult {
    let script = o.repo.join("scripts").join("ensure-atlas.ps1");
    let script = script.to_string_lossy();
    let mut args = vec!["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", &script];
    if check {
        args.push("-Check");
    }
    (o.runner())(if cfg!(windows) { "powershell.exe" } else { "pwsh" }, &args, o.repo, if check { GIT_TIMEOUT } else { ENSURE_TIMEOUT })
}

fn exe_fresh(o: &UpdateOptions<'_>) -> bool {
    if let Some(f) = o.exe_fresh {
        return f();
    }
    ensure_script(o, true).code == 0
}

fn install_exe(o: &UpdateOptions<'_>) -> bool {
    if let Some(f) = o.install_exe {
        return f();
    }
    let r = ensure_script(o, false);
    for line in r.stdout.split('\n').map(|l| atlas_core::js::trim(l.strip_suffix('\r').unwrap_or(l))).filter(|l| !l.is_empty()) {
        (o.log)(&format!("  {line}"));
    }
    if r.code != 0 {
        (o.log)(&format!("atlas の更新: 実行ファイルを用意できませんでした({})", reason_of(&r)));
    }
    r.code == 0
}

/// rollback の結果
#[derive(Debug, Clone, PartialEq)]
pub struct RollbackResult {
    pub ok: bool,
    pub reverted: bool,
    pub note: String,
}

/// 前の版(from_sha)に戻し、実行ファイルが前の版のものでなければ用意し直す。新しい版の実行ファイルを用意できなかったときと、
/// 新しい版がこの PC で動かなかったとき(upload_auto.rs)に使う。手で変えたファイルが無いことは確かめてあるので、--keep で戻せる
pub fn rollback(o: &UpdateOptions<'_>, from_sha: &str) -> RollbackResult {
    let back = (o.runner())("git", &["reset", "--keep", from_sha], o.repo, GIT_TIMEOUT);
    let s = short_s(from_sha);
    if back.code != 0 {
        return RollbackResult { ok: false, reverted: false, note: format!("前の版({s})に戻せませんでした({})。atlas.bat を開いて確かめてください", reason_of(&back)) };
    }
    (o.log)(&format!("atlas の更新: 前の版({s})に戻しました"));
    if exe_fresh(o) {
        return RollbackResult { ok: true, reverted: true, note: format!("前の版({s})に戻しました") };
    }
    (o.log)("atlas の更新: 前の版の実行ファイルを用意し直します");
    if install_exe(o) {
        return RollbackResult { ok: true, reverted: true, note: format!("前の版({s})に戻し、実行ファイルも前の版にしました") };
    }
    RollbackResult { ok: false, reverted: true, note: format!("前の版({s})に戻しましたが、実行ファイルを前の版にできませんでした。atlas.bat を開くと用意し直します") }
}

/// atlas 自身を新しい版にする(できるときだけ)。失敗は結果に書き、止めない
pub fn self_update(o: &UpdateOptions<'_>) -> AutoUpdateResult {
    let run = o.runner();
    let git = |args: &[&str]| run("git", args, o.repo, GIT_TIMEOUT);
    let result = |outcome: &str, from: Option<&str>, to: Option<&str>, note: String| -> AutoUpdateResult {
        let r = AutoUpdateResult {
            outcome: outcome.into(),
            from: short(from),
            to: short(to),
            from_sha: Some(from.map(str::to_string)),
            to_sha: Some(to.map(str::to_string)),
            note,
        };
        (o.log)(&format!("atlas の更新: {}", r.note));
        r
    };
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
    let fetch = run("git", &["fetch", "--quiet", "origin"], o.repo, FETCH_TIMEOUT);
    if fetch.code != 0 {
        return result("failed", from, None, format!("新しい版を取りに行けなかったので、今の版のまま送ります({}。次の回にもう一度試します)", reason_of(&fetch)));
    }
    let target = git(&["rev-parse", "@{u}"]);
    if target.code != 0 {
        return result("failed", from, None, format!("新しい版を確かめられなかったので、今の版のまま送ります({})", reason_of(&target)));
    }
    let to = atlas_core::js::trim(&target.stdout).to_string();
    let from_s = from.unwrap_or_default();
    if to == from_s {
        return result("latest", from, from, format!("最新です({})", short_s(from_s)));
    }
    if o.avoid.as_deref().is_some_and(|a| !a.is_empty() && a == to) {
        return result("skipped", from, None, format!("新しい版({})は前にこの PC で動かなかったので、使いません(もっと新しい版が出たら、それにします)", short_s(&to)));
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
        return result("skipped", from, None, format!("早送りだけでは新しい版にできないので、更新しません(手元にだけあるコミットがあるなど。git log {main}..HEAD で確かめられます)"));
    }
    (o.log)(&format!("atlas の更新: 新しい版({})を取り込みました", short_s(&to)));
    if !exe_fresh(o) {
        (o.log)("atlas の更新: 版が変わったので、新しい版の実行ファイルを用意します");
        if !install_exe(o) {
            // 新しい版のソースを、前の版の実行ファイルで動かさない(設定やファイルの形が合わないことがある)
            let back = rollback(o, from_s);
            let note = if back.ok {
                format!("新しい版({})の実行ファイルを用意できなかったので、{}。今の版のまま送ります(次の回にもう一度試します)", short_s(&to), back.note)
            } else {
                format!("新しい版({})の実行ファイルを用意できず、{}", short_s(&to), back.note)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;

    /// 一時フォルダに本物の git のリポジトリ(origin・作る人・作業メンバー)を作る。この PC の git の設定は使わない
    struct Repos {
        _d: tempfile::TempDir,
        dev: PathBuf,
        member: PathBuf,
        cfg: PathBuf,
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
            let r = Repos { dev: base.join("dev"), member: base.join("member"), cfg, _d: d };
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
            let logs = RefCell::new(Vec::new());
            let log = |l: &str| logs.borrow_mut().push(l.to_string());
            let cfg = self.cfg.clone();
            let run = move |cmd: &str, args: &[&str], cwd: &Path, t: Duration| -> CmdResult {
                // テストでは git にこの PC の設定を読ませない
                unsafe_env_free_run(cmd, args, cwd, t, &cfg)
            };
            let fresh_f = move || fresh;
            let mut o = UpdateOptions::new(&self.member, &log);
            o.run = Some(&run);
            o.exe_fresh = Some(&fresh_f);
            o.install_exe = Some(installs);
            o.avoid = avoid;
            o.busy = busy;
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
        let next = r.release("a.txt", "second");
        let (u, logs) = r.update(true, &yes, None, None);
        assert_eq!(u.outcome, "updated");
        assert_eq!(r.head(&r.member), next);
        assert!(logs.join("\n").contains(&format!("{} から {} に更新しました", &before[..7], &next[..7])));
        // 実行ファイルを用意できなければ前の版に戻し、前の版の実行ファイルを用意し直す
        let mid = next;
        r.release("package-lock.json", "{\"v\":3}");
        let n = RefCell::new(0);
        let installs = || {
            *n.borrow_mut() += 1;
            *n.borrow() > 1
        };
        let (u, _) = r.update(false, &installs, None, None);
        assert_eq!((u.outcome.as_str(), u.from.as_deref(), u.to.as_deref(), u.from_sha()), ("failed", Some(&mid[..7]), Some(&mid[..7]), Some(mid.as_str())));
        assert!(u.note.contains("実行ファイルを用意できなかったので、前の版(") && u.note.contains(")に戻し、実行ファイルも前の版にしました。今の版のまま送ります"), "{}", u.note);
        assert_eq!(*n.borrow(), 2);
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
    fn rollback_reinstalls_when_needed() {
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
        let mut o = UpdateOptions::new(&r.member, &log);
        o.run = Some(&run);
        o.exe_fresh = Some(&stale);
        o.install_exe = Some(&yes);
        let b = rollback(&o, &first);
        assert_eq!(b, RollbackResult { ok: true, reverted: true, note: format!("前の版({})に戻し、実行ファイルも前の版にしました", &first[..7]) });
        assert_eq!(r.head(&r.member), first);
    }
}
