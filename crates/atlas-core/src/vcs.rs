//! Git / Perforce / SVN を読むだけの共通口(packages/core/src/vcs.ts の移植。vcs_retention.rs が使う)。
//! - 呼ぶのは、読む系の副コマンドだけ(許可リスト。ほかは呼ぶ前に例外にする)。作業ツリー・索引・サーバの状態を変えない
//!   - git は --no-optional-locks と GIT_OPTIONAL_LOCKS=0 で、索引の書き戻しもさせない
//! - 照合した時点のファイルは、ディスクから直接読む(fs の読み取りだけ)
//! - 開始時の基準は、git ではログの headCommit を使う(記録)。無いとき・p4 と svn では、開始時刻から履歴をたどって推定する(推定と印を付ける)

use crate::classify::{file_path_key, relative_inside, resolve_file_path};
use crate::js;
use crate::jsdate;
use crate::jsfs;
use crate::nodepath::platform;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VcsKind {
    Git,
    P4,
    Svn,
}

pub const VCS_KINDS: [VcsKind; 3] = [VcsKind::Git, VcsKind::Svn, VcsKind::P4];

impl VcsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            VcsKind::Git => "git",
            VcsKind::P4 => "p4",
            VcsKind::Svn => "svn",
        }
    }

    pub fn parse(s: &str) -> Option<VcsKind> {
        VCS_KINDS.into_iter().find(|k| k.as_str() == s)
    }
}

/// 開始時の基準の出所。observed = ログに記録された版、estimated = 時刻から推定した版
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RevisionSource {
    Observed,
    Estimated,
}

impl RevisionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            RevisionSource::Observed => "observed",
            RevisionSource::Estimated => "estimated",
        }
    }

    pub fn parse(s: &str) -> Option<RevisionSource> {
        [RevisionSource::Observed, RevisionSource::Estimated].into_iter().find(|k| k.as_str() == s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revision {
    pub rev: String,
    pub source: RevisionSource,
}

/// 照合で比べる版の見方。worktree = 照合した時点の作業ツリー、committed = 照合した時点で最後に取り込んだ版、
/// fixed = セッションの終わりから決まった日数後の時点で取り込まれていた版(照合した時期で値が変わらない。取り込んでいない変更は見えない)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvalMode {
    Worktree,
    Committed,
    Fixed,
}

pub const EVAL_MODES: [EvalMode; 3] = [EvalMode::Worktree, EvalMode::Committed, EvalMode::Fixed];

impl EvalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            EvalMode::Worktree => "worktree",
            EvalMode::Committed => "committed",
            EvalMode::Fixed => "fixed",
        }
    }

    pub fn parse(s: &str) -> Option<EvalMode> {
        EVAL_MODES.into_iter().find(|k| k.as_str() == s)
    }
}

// ---------- 実行 ----------

/// VCS の呼び出しの結果
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunResult {
    /// 終了コード。コマンドが無い(未インストール)ときは -1
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// VCS を呼ぶ口(テストでは偽の CLI に差し替える)。引数は (コマンド, 引数, 作業フォルダ)
pub type VcsRunner = Arc<dyn Fn(VcsKind, &[String], &str) -> RunResult + Send + Sync>;

/// 許可する副コマンド(読むものだけ)
fn read_only(cmd: VcsKind) -> &'static [&'static str] {
    match cmd {
        VcsKind::Git => &["rev-parse", "cat-file", "show", "rev-list"],
        VcsKind::Svn => &["info", "cat"],
        VcsKind::P4 => &["info", "where", "changes", "print"],
    }
}

/// 副コマンドの前に置いてよいもの(値を取るものは次の 1 語も読み飛ばす)
fn global_flag(cmd: VcsKind, a: &str) -> Option<usize> {
    match (cmd, a) {
        (VcsKind::Git, "--no-optional-locks") => Some(0),
        (VcsKind::Git, "-C") | (VcsKind::Git, "-c") => Some(1),
        (VcsKind::Svn, "--non-interactive") => Some(0),
        (VcsKind::P4, "-d") => Some(1),
        (VcsKind::P4, "-ztag") | (VcsKind::P4, "-q") => Some(0),
        _ => None,
    }
}

/// どこにあっても許さない引数(ファイルへの書き出し。p4 print -o はファイルに書き出す)
fn forbidden_arg(cmd: VcsKind, a: &str) -> bool {
    a == "--output" || a.starts_with("--output=") || (cmd == VcsKind::P4 && a.starts_with("-o"))
}

/// 読む系の副コマンドか確かめる。違えば Err
pub fn assert_read_only(cmd: VcsKind, args: &[String]) -> Result<(), String> {
    let mut i = 0;
    while i < args.len() {
        match global_flag(cmd, &args[i]) {
            Some(n) => i += 1 + n,
            None => break,
        }
    }
    let sub = args.get(i);
    match sub {
        Some(s) if read_only(cmd).contains(&s.as_str()) => {}
        _ => return Err(format!("読み取り専用でない {} の呼び出しを止めました: {}", cmd.as_str(), sub.map(String::as_str).unwrap_or("(副コマンドなし)"))),
    }
    if cmd == VcsKind::Git && args.iter().enumerate().any(|(j, a)| j < i && a == "-c" && !args.get(j + 1).is_some_and(|v| v.starts_with("core.quotepath="))) {
        return Err("git -c は core.quotepath だけ許します".into());
    }
    if let Some(bad) = args.iter().find(|a| forbidden_arg(cmd, a)) {
        return Err(format!("書き出しの引数を止めました: {bad}"));
    }
    Ok(())
}

/// VCS に渡す環境変数(base から変えるものだけを返す。None は消す)。メッセージは英語にそろえる(見つからないことを英語の文で見分けるため)が、
/// 文字の扱い(LC_CTYPE)は利用者のものを残す。LC_ALL=C にすると、POSIX の svn が ASCII 以外のパスを UTF-8 に直せず、日本語のファイル名などを読めなくなる
pub fn vcs_env(get: impl Fn(&str) -> Option<String>) -> Vec<(&'static str, Option<String>)> {
    let ctype = get("LC_CTYPE").or_else(|| get("LC_ALL")).or_else(|| get("LANG"));
    let mut out: Vec<(&'static str, Option<String>)> = vec![("LC_ALL", None)];
    if let Some(c) = ctype.filter(|c| !c.is_empty()) {
        out.push(("LC_CTYPE", Some(c)));
    }
    for (k, v) in [("LC_MESSAGES", "C"), ("LANGUAGE", "C"), ("GIT_OPTIONAL_LOCKS", "0"), ("GIT_TERMINAL_PROMPT", "0")] {
        out.push((k, Some(v.to_string())));
    }
    out
}

const RUN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BUFFER: usize = 64 * 1024 * 1024;

/// 許可リストを通してから runner で呼ぶ。VCS を呼ぶところ(VcsRepo と detect)はすべてここを通るので、
/// 差し替えた runner でも、書く系のコマンドは呼ぶ前に止まる
pub(crate) fn run_read_only(runner: &VcsRunner, cmd: VcsKind, args: &[String], cwd: &str) -> Result<RunResult, String> {
    assert_read_only(cmd, args)?;
    Ok(runner(cmd, args, cwd))
}

/// 既定の実行(シェルを通さない。30 秒で打ち切る。出力が 64MB を超えたら失敗)。許可リストは確かめないので、
/// 外へは default_runner(確かめてから呼ぶ)として渡す
pub(crate) fn default_run(cmd: VcsKind, args: &[String], cwd: &str) -> RunResult {
    let mut c = Command::new(cmd.as_str());
    c.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in vcs_env(|k| std::env::var(k).ok()) {
        match v {
            Some(v) => c.env(k, v),
            None => c.env_remove(k),
        };
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return RunResult { code: -1, stdout: String::new(), stderr: format!("{} が見つかりません", cmd.as_str()) },
        Err(e) => return RunResult { code: 1, stdout: String::new(), stderr: e.to_string() },
    };
    let (tx, rx) = mpsc::channel::<(bool, Vec<u8>)>();
    let mut out = child.stdout.take().expect("stdout");
    let mut err = child.stderr.take().expect("stderr");
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        let _ = tx.send((true, b));
    });
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        let _ = tx2.send((false, b));
    });
    let deadline = Instant::now() + RUN_TIMEOUT;
    let (mut stdout, mut stderr) = (None, None);
    while stdout.is_none() || stderr.is_none() {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok((true, b)) => stdout = Some(b),
            Ok((false, b)) => stderr = Some(b),
            Err(_) => {
                // 打ち切り(Node の execFile の timeout と同じく、終了コードは数でないので 1)
                let _ = child.kill();
                let _ = child.wait();
                return RunResult { code: 1, stdout: String::new(), stderr: format!("{} が時間内に終わりませんでした", cmd.as_str()) };
            }
        }
    }
    let status = child.wait();
    let (stdout, stderr) = (stdout.unwrap_or_default(), stderr.unwrap_or_default());
    let mut code = match status {
        Ok(s) => s.code().unwrap_or(1),
        Err(_) => 1,
    };
    if stdout.len() > MAX_BUFFER || stderr.len() > MAX_BUFFER {
        code = 1;
    }
    RunResult { code, stdout: String::from_utf8_lossy(&stdout).into_owned(), stderr: String::from_utf8_lossy(&stderr).into_owned() }
}

/// 既定の runner。実際にプロセスを起動するので、run_read_only を通らずに直接呼ばれても書く系のコマンドは起動しない
/// (run_read_only と二重に確かめる。止めたときは終了コード 1 と理由)
pub fn default_runner() -> VcsRunner {
    Arc::new(|cmd, args, cwd| match assert_read_only(cmd, args) {
        Ok(()) => default_run(cmd, args, cwd),
        Err(e) => RunResult { code: 1, stdout: String::new(), stderr: e },
    })
}

/// 本文を比べられる形にする(BOM を落とし、改行を LF に)
pub fn decode_text(s: &str) -> String {
    s.strip_prefix('\u{feff}').unwrap_or(s).replace("\r\n", "\n")
}

fn is_win(p: &str) -> bool {
    WIN_ABS_RE.is_match(p) || p.starts_with("\\\\")
}

fn read_disk(abs_path: &str) -> Result<Option<String>, String> {
    match std::fs::read(abs_path) {
        Ok(b) => Ok(Some(decode_text(&String::from_utf8_lossy(&b)))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn failed(cmd: VcsKind, args: &[String], r: &RunResult) -> String {
    let sub = args.iter().find(|a| read_only(cmd).contains(&a.as_str())).map(String::as_str).unwrap_or("");
    format!("{} {sub} に失敗しました({}): {}", cmd.as_str(), r.code, js::trim(&r.stderr).split('\n').next().unwrap_or(""))
}

static WIN_ABS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());
static GIT_MISSING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)does not exist|exists on disk, but not in|not in '|path {}* does not exist|bad revision|invalid object name|unknown revision", js::RE_DOT)).unwrap()
});
static SVN_MISSING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)E200009|E160013|E195012|W160013|E155010|path not found|is not under version control|was not found|no such file").unwrap());
static P4_MISSING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)no such file|no file\(s\) at that|file\(s\) not on client|not in client view|- delete change").unwrap());
// 版を調べるコマンド(rev-list・rev-parse・cat-file -e、svn info -r、p4 changes)が「その版が無い」と答えたときの文。
// ファイルを読むときの *_MISSING より狭くする(No such file or directory などの環境の失敗を、版が無いと取り違えない)
static GIT_NO_REV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)unknown revision|bad revision|invalid object name|not a valid object name").unwrap());
static SVN_NO_REV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"E200009|E160013|E195012|W160013|W170000").unwrap());
static P4_NO_REV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)no such file\(s\)|no file\(s\) at that|file\(s\) not on client|not in client view").unwrap());
/// ログの値のブランチ名のうち、ref の名前として素直なもの(JS の \w は ASCII だけ)
static PLAIN_BRANCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_./-]+$").unwrap());
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+$").unwrap());
/// JS の /^Change (\d+) /m(行の頭は \n・\r・U+2028・U+2029 の後)
static P4_CHANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\n\r\x{2028}\x{2029}])Change ([0-9]+) ").unwrap());
static P4_CLIENT_ROOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"(?:^|[\n\r\x{{2028}}\x{{2029}}])\.\.\. clientRoot ({}+)", js::RE_DOT)).unwrap());
static P4_CLIENT_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"(?:^|[\n\r\x{{2028}}\x{{2029}}])\.\.\. clientName ({}+)", js::RE_DOT)).unwrap());
/// p4 -ztag info の serverDate(... serverDate 2026/11/12 10:02:03 +0900 JST)のずれ
static P4_SERVER_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\n\r\x{2028}\x{2029}])\.\.\. serverDate [0-9/]+ [0-9:]+ ([+-])([0-9]{2})([0-9]{2})").unwrap());

/// p4 のサーバの UTC からのずれ(分)。serverDate が無い・読めなければ None
pub(crate) fn p4_server_offset(info: &str) -> Option<i32> {
    let m = P4_SERVER_DATE.captures(info)?;
    let (h, mi): (i32, i32) = (m[2].parse().ok()?, m[3].parse().ok()?);
    if h > 23 || mi > 59 {
        return None;
    }
    let off = h * 60 + mi;
    Some(if &m[1] == "-" { -off } else { off })
}

/// svn の日付指定({2026-11-12T01:02:03Z})。読めない時刻は Err(JS の toISOString が投げるのと同じ)
fn svn_date(iso: &str) -> Result<String, String> {
    let ms = jsdate::parse_ms(iso).ok_or_else(|| "Invalid time value".to_string())?;
    let s = jsdate::to_iso(ms);
    // /\.\d{3}Z$/ → Z
    let b = s.as_bytes();
    let n = b.len();
    let s = if n >= 5 && b[n - 1] == b'Z' && b[n - 5] == b'.' && b[n - 4..n - 1].iter().all(u8::is_ascii_digit) { format!("{}Z", &s[..n - 5]) } else { s };
    Ok(format!("{{{s}}}"))
}

/// p4 の日時指定(@2026/11/12:01:02:03)。p4 はサーバの地方時で解釈するので、サーバの UTC からのずれ(分)で直す。
/// 読めない時刻は NaN のまま(JS と同じ)
fn p4_date(ms: Option<i64>, offset_min: i32) -> String {
    // 1 日以上のずれは使えないので UTC にする
    let secs = offset_min as i64 * 60;
    let secs = if secs.abs() < 86_400 { secs } else { 0 };
    let Some(d) = ms.and_then(|ms| jsdate::offset_parts(ms, secs)) else { return "@NaN/NaN/NaN:NaN:NaN:NaN".into() };
    let pad = |n: u32| format!("{n:02}");
    format!("@{}/{}/{}:{}:{}:{}", d.year, pad(d.month), pad(d.day), pad(d.hour), pad(d.minute), pad(d.second))
}

/// p4 -ztag changes の出力の (変更番号, 取り込んだ時刻(UTC の秒))
fn p4_ztag_changes(out: &str) -> Vec<(u64, Option<i64>)> {
    let mut v: Vec<(u64, Option<i64>)> = Vec::new();
    for line in out.lines() {
        if let Some(n) = line.strip_prefix("... change ").and_then(|n| n.trim().parse().ok()) {
            v.push((n, None));
        } else if let (Some(t), Some(last)) = (line.strip_prefix("... time ").and_then(|t| t.trim().parse().ok()), v.last_mut()) {
            last.1.get_or_insert(t);
        }
    }
    v
}

/// サーバの時差が夏時間で変わっても版を取り違えないよう、前後に見る幅
const P4_DATE_SLACK_MS: i64 = 60 * 60 * 1000;

/// 版を調べたコマンドの結果。成功なら value(stdout)、版が無いと答えたなら None、それ以外の失敗は Err(版が無いと取り違えない)
fn revision_of(cmd: VcsKind, args: &[&str], r: &RunResult, no_rev: &Regex, value: impl FnOnce(&str) -> Option<String>) -> Result<Option<String>, String> {
    if r.code == 0 {
        return Ok(value(&r.stdout));
    }
    if no_rev.is_match(&r.stderr) {
        return Ok(None);
    }
    Err(failed(cmd, &strings(args), r))
}

/// 空でなければ前後の空白を除いた stdout
fn nonempty(out: &str) -> Option<String> {
    Some(js::trim(out).to_string()).filter(|s| !s.is_empty())
}

/// p4 のファイル指定で特別な意味を持つ文字(@ # % *)を逃がす(% を先に)
pub fn p4_escape(path: &str) -> String {
    path.replace('%', "%25").replace('@', "%40").replace('#', "%23").replace('*', "%2A")
}

// ---------- リポジトリ ----------

/// 開いた作業ツリー(git / svn / p4)。呼ぶコマンドは許可リストを通す
pub struct VcsRepo {
    pub kind: VcsKind,
    /// 作業ツリーの根(絶対パス。Windows は \ 区切り)
    pub root: String,
    /// p4 のサーバの UTC からのずれ(分。p4 info の serverDate から)。わからなければ None(日時を UTC として渡す)
    pub p4_offset_min: Option<i32>,
    run: VcsRunner,
}

impl std::fmt::Debug for VcsRepo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VcsRepo").field("kind", &self.kind).field("root", &self.root).finish()
    }
}

fn strings(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

impl VcsRepo {
    /// 許可リストを通してから呼ぶ
    fn call(&self, cmd: VcsKind, args: Vec<String>) -> Result<RunResult, String> {
        run_read_only(&self.run, cmd, &args, &self.root)
    }

    fn git(&self, args: &[&str]) -> Result<RunResult, String> {
        let mut a = strings(&["--no-optional-locks", "-C", &self.root, "-c", "core.quotepath=false"]);
        a.extend(strings(args));
        self.call(VcsKind::Git, a)
    }

    fn svn(&self, args: &[&str]) -> Result<RunResult, String> {
        let mut a = strings(&["--non-interactive"]);
        a.extend(strings(args));
        self.call(VcsKind::Svn, a)
    }

    fn p4(&self, args: &[&str]) -> Result<RunResult, String> {
        let mut a = strings(&["-d", &self.root]);
        a.extend(strings(args));
        self.call(VcsKind::P4, a)
    }

    /// root の中なら root からの相対パス(/ 区切り)、外なら None
    pub fn relative(&self, abs_path: &str) -> Option<String> {
        relative_inside(&self.root, abs_path)
    }

    fn git_show(&self, spec: &str) -> Result<Option<String>, String> {
        let r = self.git(&["show", spec])?;
        if r.code == 0 {
            return Ok(Some(decode_text(&r.stdout)));
        }
        if GIT_MISSING.is_match(&r.stderr) {
            return Ok(None);
        }
        Err(failed(VcsKind::Git, &strings(&["show", spec]), &r))
    }

    fn svn_cat(&self, rev: &str, abs_path: &str) -> Result<Option<String>, String> {
        // 末尾の @ は空の peg 版(既定)。付けないと、名前に @ を含むファイル(icon@2x.png など)の @ 以降を版の指定として読む
        let target = format!("{abs_path}@");
        let r = self.svn(&["cat", "-r", rev, &target])?;
        if r.code == 0 {
            return Ok(Some(decode_text(&r.stdout)));
        }
        if SVN_MISSING.is_match(&r.stderr) {
            return Ok(None);
        }
        Err(failed(VcsKind::Svn, &strings(&["cat", "-r", rev, &target]), &r))
    }

    fn p4_print(&self, spec: &str) -> Result<Option<String>, String> {
        let r = self.p4(&["-q", "print", spec])?;
        if r.code == 0 && !P4_MISSING.is_match(&r.stderr) {
            return Ok(Some(decode_text(&r.stdout)));
        }
        // 本文に同じ語があっても取り違えないよう、stdout はエラーのときだけ見る
        if P4_MISSING.is_match(&r.stderr) || (r.code != 0 && P4_MISSING.is_match(&r.stdout)) {
            return Ok(None);
        }
        Err(failed(VcsKind::P4, &strings(&["-q", "print", spec]), &r))
    }

    /// spec に当てはまる最後の変更。当てはまる変更が無いだけなら None
    fn p4_last_change(&self, spec: &str) -> Result<Option<String>, String> {
        let args = ["changes", "-m1", "-s", "submitted", spec];
        let r = self.p4(&args)?;
        revision_of(VcsKind::P4, &args, &r, &P4_NO_REV, |out| P4_CHANGE.captures(out).map(|m| m[1].to_string()))
    }

    /// 時刻 t(ミリ秒)までに取り込まれた最後の変更。p4 の日時はサーバの地方時で、今の時差で直しても、夏時間をまたぐ過去の日時は
    /// 1 時間ずれうる。そこで前後 1 時間の変更を、取り込んだ時刻(UTC)で確かめる。窓に t 以前の変更が無ければ、窓の前の最後の変更
    fn p4_change_at(&self, t: i64, offset_min: i32) -> Result<Option<String>, String> {
        let tree = self.p4_tree();
        let range = format!("{tree}{},{}", p4_date(Some(t - P4_DATE_SLACK_MS), offset_min), p4_date(Some(t + P4_DATE_SLACK_MS), offset_min));
        let args = ["-ztag", "changes", "-s", "submitted", &range];
        let r = self.p4(&args)?;
        // 取り込んだ時刻を読めない変更があれば確かめられないので、時差だけで決めた日時で探す(推定。夏時間のずれは補えない)
        let mut timeless = false;
        let found = revision_of(VcsKind::P4, &args, &r, &P4_NO_REV, |out| {
            let changes = p4_ztag_changes(out);
            timeless = changes.iter().any(|(_, s)| s.is_none());
            changes.into_iter().filter(|(_, s)| s.is_some_and(|s| s * 1000 <= t)).map(|(n, _)| n).max().map(|n| n.to_string())
        })?;
        match found {
            _ if timeless => self.p4_last_change(&format!("{tree}{}", p4_date(Some(t), offset_min))),
            Some(n) => Ok(Some(n)),
            None => self.p4_last_change(&format!("{tree}{}", p4_date(Some(t - P4_DATE_SLACK_MS), offset_min))),
        }
    }

    fn p4_tree(&self) -> String {
        format!("{}{}...", p4_escape(&self.root), if is_win(&self.root) { "\\" } else { "/" })
    }

    /// 時刻 at の時点で取り込まれていた最後の版(git はブランチの履歴、無ければ HEAD)。無ければ None
    pub fn revision_at(&self, at: &str, branch: Option<&str>) -> Result<Option<String>, String> {
        match self.kind {
            VcsKind::Git => {
                // 時刻 at までの最後のコミット。セッションのブランチの履歴で探す(今の HEAD が別のブランチでも取り違えない)。ブランチが無い・読めなければ HEAD。
                // ブランチ名はログの値なので、ref の名前として素直なものだけを refs/heads/ の下で使う(引数として読まれないように)
                let refs: Vec<String> = match branch {
                    Some(b) if !b.is_empty() && PLAIN_BRANCH.is_match(b) && !b.starts_with('-') && !b.contains("..") => vec![format!("refs/heads/{b}"), "HEAD".into()],
                    _ => vec!["HEAD".into()],
                };
                let before = format!("--before={at}");
                // ブランチで見つからなければ HEAD で探す。結果は最後に試した HEAD のもの(版が無いのではなく失敗したなら Err)
                let mut last = Ok(None);
                for r in &refs {
                    let args = ["rev-list", "-1", &before, r];
                    let res = self.git(&args)?;
                    match revision_of(VcsKind::Git, &args, &res, &GIT_NO_REV, nonempty) {
                        Ok(Some(rev)) => return Ok(Some(rev)),
                        other => last = other,
                    }
                }
                last
            }
            VcsKind::Svn => {
                let d = svn_date(at)?;
                let args = ["info", "--show-item", "revision", "-r", &d, &self.root];
                let r = self.svn(&args)?;
                revision_of(VcsKind::Svn, &args, &r, &SVN_NO_REV, |out| Some(js::trim(out).to_string()).filter(|v| DIGITS.is_match(v)))
            }
            // サーバの時差がわかれば、取り込んだ時刻で確かめる。わからなければ UTC のまま渡す(推定)
            VcsKind::P4 => match (self.p4_offset_min, jsdate::parse_ms(at)) {
                (Some(off), Some(t)) => self.p4_change_at(t, off),
                (off, t) => self.p4_last_change(&format!("{}{}", self.p4_tree(), p4_date(t, off.unwrap_or(0)))),
            },
        }
    }

    /// 開始時の基準。head_commit は git のときだけ使う(別のリポジトリの値は渡さない)。決められなければ None(baseline_missing)
    pub fn baseline(&self, head_commit: Option<&str>, start: Option<&str>, branch: Option<&str>) -> Result<Option<Revision>, String> {
        if self.kind == VcsKind::Git {
            if let Some(h) = head_commit.filter(|h| !h.is_empty()) {
                let spec = format!("{h}^{{commit}}");
                let args = ["cat-file", "-e", &spec];
                let r = self.git(&args)?;
                // ログに記録された版がもう無い(履歴の書き換え・別の複製)なら None で、推定で置き換えない。
                // 調べるコマンドの失敗(打ち切り・読めないリポジトリなど)は Err(版が無いと取り違えない)
                return Ok(revision_of(VcsKind::Git, &args, &r, &GIT_NO_REV, |_| Some(h.to_string()))?.map(|rev| Revision { rev, source: RevisionSource::Observed }));
            }
        }
        // svn と p4 はログに版が残らないので、開始時刻の版を推定する
        let Some(start) = start.filter(|s| !s.is_empty()) else { return Ok(None) };
        let rev = self.revision_at(start, if self.kind == VcsKind::Git { branch } else { None })?;
        Ok(rev.map(|rev| Revision { rev, source: RevisionSource::Estimated }))
    }

    /// 照合時の版の印(git: HEAD、svn: 作業コピーの版、p4: have の最新の変更番号)
    /// まだ版が無い(コミットの無いリポジトリなど)は None。それ以外の失敗は Err
    pub fn current_revision(&self) -> Result<Option<String>, String> {
        match self.kind {
            VcsKind::Git => {
                let args = ["rev-parse", "HEAD"];
                revision_of(VcsKind::Git, &args, &self.git(&args)?, &GIT_NO_REV, nonempty)
            }
            VcsKind::Svn => {
                let args = ["info", "--show-item", "revision", &self.root];
                revision_of(VcsKind::Svn, &args, &self.svn(&args)?, &SVN_NO_REV, nonempty)
            }
            VcsKind::P4 => self.p4_last_change(&format!("{}#have", self.p4_tree())),
        }
    }

    /// 版 rev のファイル。その版に無ければ None。読めないときは Err
    pub fn read_at(&self, rev: &str, abs_path: &str) -> Result<Option<String>, String> {
        let rel = self.relative(abs_path);
        match self.kind {
            VcsKind::Git => match rel {
                Some(rel) => self.git_show(&format!("{rev}:{rel}")),
                None => Err("リポジトリの外のファイルです".into()),
            },
            VcsKind::Svn => match rel {
                Some(_) => self.svn_cat(rev, abs_path),
                None => Err("作業コピーの外のファイルです".into()),
            },
            VcsKind::P4 => match rel {
                Some(_) => self.p4_print(&format!("{}@{rev}", p4_escape(abs_path))),
                None => Err("クライアントの外のファイルです".into()),
            },
        }
    }

    /// 照合した時点のファイル。worktree = ディスク、committed = 最後に取り込んだ版(fixed は read_at で読む)
    pub fn read_after(&self, mode: EvalMode, abs_path: &str) -> Result<Option<String>, String> {
        if mode == EvalMode::Worktree {
            return read_disk(abs_path);
        }
        match self.kind {
            VcsKind::Git => match self.relative(abs_path) {
                Some(rel) => self.git_show(&format!("HEAD:{rel}")),
                None => Err("リポジトリの外のファイルです".into()),
            },
            VcsKind::Svn => self.svn_cat("BASE", abs_path),
            VcsKind::P4 => self.p4_print(&format!("{}#have", p4_escape(abs_path))),
        }
    }
}

// ---------- 見つける ----------

/// 作業ツリーが見つからなかった理由
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoRepo {
    RepoNotFound,
    NoVcs,
}

/// 開いた結果。見つからなければ Err(理由)
pub type OpenRepoResult = Result<Arc<VcsRepo>, NoRepo>;

/// open_repo の結果を作業フォルダごとに残す(同じフォルダは 1 度だけ調べる。並べて呼んでもよい)
pub type RepoCache = Memo<OpenRepoResult>;

/// いちばん近い、ディスクにあるフォルダ(ファイルが消えていても、その上のフォルダで VCS を探すため)
pub fn nearest_existing_dir(p: &str) -> Option<String> {
    let mut cur = p.to_string();
    for _ in 0..64 {
        if Path::new(&cur).is_dir() {
            return Some(cur);
        }
        let up = platform::dirname(&cur);
        if up == cur {
            return None;
        }
        cur = up;
    }
    None
}

/// dir を含む作業ツリーを探す(git → svn → p4 の順)。dir がディスクに無ければ RepoNotFound。
/// 結果は cache に dir ごとに残す
pub fn open_repo(dir: &str, runner: &VcsRunner, cache: &RepoCache) -> OpenRepoResult {
    let key = file_path_key(&resolve_file_path(dir, None));
    cache.get_or_init(key, || detect(dir, runner, &VCS_KINDS))
}

/// open_repo と同じく dir を含む作業ツリーを探すが、kinds の種類だけを(git → svn → p4 の順で)調べる。
/// 入れ子の作業コピーを探すときに、要らない VCS(サーバーに問い合わせる p4 など)を呼ばないため。
/// 結果は cache に dir と種類の組ごとに残す(open_repo の鍵はパスだけで \0 を含まないので、混ざらない)
pub fn open_repo_kinds(dir: &str, kinds: &[VcsKind], runner: &VcsRunner, cache: &RepoCache) -> OpenRepoResult {
    let names: Vec<&str> = VCS_KINDS.iter().filter(|k| kinds.contains(k)).map(|k| k.as_str()).collect();
    let key = format!("{}\0{}", names.join(","), file_path_key(&resolve_file_path(dir, None)));
    cache.get_or_init(key, || detect(dir, runner, kinds))
}

fn detect(dir: &str, runner: &VcsRunner, kinds: &[VcsKind]) -> OpenRepoResult {
    if !jsfs::exists(Path::new(dir)) {
        return Err(NoRepo::RepoNotFound);
    }
    // ここで呼ぶのは読む系だけ(rev-parse・info)
    let run = |cmd: VcsKind, args: &[&str]| -> RunResult { run_read_only(runner, cmd, &strings(args), dir).expect("読む系のコマンド") };
    let repo = |kind: VcsKind, root: &str, p4_offset_min: Option<i32>| Ok(Arc::new(VcsRepo { kind, root: resolve_file_path(root, None), p4_offset_min, run: runner.clone() }));
    if kinds.contains(&VcsKind::Git) {
        let g = run(VcsKind::Git, &["--no-optional-locks", "-C", dir, "rev-parse", "--show-toplevel"]);
        if g.code == 0 && !js::trim(&g.stdout).is_empty() {
            return repo(VcsKind::Git, js::trim(&g.stdout), None);
        }
    }
    if kinds.contains(&VcsKind::Svn) {
        let s = run(VcsKind::Svn, &["--non-interactive", "info", "--show-item", "wc-root", dir]);
        if s.code == 0 && !js::trim(&s.stdout).is_empty() {
            return repo(VcsKind::Svn, js::trim(&s.stdout), None);
        }
    }
    if !kinds.contains(&VcsKind::P4) {
        return Err(NoRepo::NoVcs);
    }
    let p = run(VcsKind::P4, &["-d", dir, "-ztag", "info"]);
    if p.code == 0 {
        let root = P4_CLIENT_ROOT.captures(&p.stdout).map(|m| js::trim(&m[1]).to_string()).filter(|s| !s.is_empty());
        let client = P4_CLIENT_NAME.captures(&p.stdout).map(|m| js::trim(&m[1]).to_string()).filter(|s| !s.is_empty());
        if let (Some(root), Some(client)) = (root, client) {
            if client != "*unknown*" && (relative_inside(&root, dir).is_some() || file_path_key(&resolve_file_path(&root, None)) == file_path_key(&resolve_file_path(dir, None))) {
                return repo(VcsKind::P4, &root, p4_server_offset(&p.stdout));
            }
        }
    }
    Err(NoRepo::NoVcs)
}

// ---------- 使い回し ----------

/// 同じ鍵の読み取りは 1 回だけ行い、結果(失敗も)を使い回す。並べて呼ぶと、同じ鍵は先に始めたものの終わりを待つ
pub struct Memo<T> {
    cells: Mutex<HashMap<String, Arc<OnceLock<T>>>>,
}

impl<T> Default for Memo<T> {
    fn default() -> Self {
        Memo { cells: Mutex::new(HashMap::new()) }
    }
}

impl<T: Clone> Memo<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_or_init(&self, key: String, load: impl FnOnce() -> T) -> T {
        let cell = self.cells.lock().expect("memo").entry(key).or_default().clone();
        cell.get_or_init(load).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p4_date_uses_server_offset() {
        let t = Some(1782864000123); // 2026-07-01T00:00:00.123Z
        assert_eq!(p4_date(t, 540), "@2026/07/01:09:00:00");
        assert_eq!(p4_date(t, -300), "@2026/06/30:19:00:00");
        assert_eq!(p4_date(t, 0), "@2026/07/01:00:00:00");
        assert_eq!(p4_date(t, 1439), "@2026/07/01:23:59:00");
        // 1 日以上のずれは UTC
        assert_eq!(p4_date(t, 100_000), "@2026/07/01:00:00:00");
        assert_eq!(p4_date(t, -1440), "@2026/07/01:00:00:00");
        // 年は詰めない
        assert_eq!(p4_date(Some(-59042995200000), 0), "@99/01/01:00:00:00");
        assert_eq!(p4_date(None, 540), "@NaN/NaN/NaN:NaN:NaN:NaN");
        assert_eq!(p4_date(Some(8210266876800000), 0), "@NaN/NaN/NaN:NaN:NaN:NaN");
    }
}
