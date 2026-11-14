//! 自動で送る(TS 版の packages/cli/src/upload-auto.ts の移植。schedule-upload.bat で登録したタスクが、毎日決まった時刻に窓を出さずに `atlas upload-auto` を動かす)。
//! 集計し直してから、画面で「まとめて送る」に印を付けたプロジェクトを、覚えた送り先へ尋ねずに送る(upload-project.bat の y まで進めたのと同じ)。
//! 窓が無いので、経過は out/auto-upload.log に、結果は out/auto-upload.json に書き、送れなかったときは Windows の通知で知らせる。
//! 送る前に、atlas 自身を新しい版にする(self_update.rs。タスクの引数に --no-update があればしない)。新しい版にしたら、
//! 新しい版で動かし直す。動かし直した側が結果を残さずに終わったら(新しい版がこの PC で動かない)、その版を覚えて前の版に戻し、前の版で動かし直して送る(run_update_flow)。

use crate::group_upload::GroupUploadPaths;
use crate::upload_auto_files::{
    AutoStatusFile, AutoUpdateResult, AUTO_AGGREGATE_LOG_FILE, AUTO_LOG_FILE, AUTO_STATUS_FILE, AUTO_UPDATE_STATE_FILE, JOB_LOCK_NAME, NO_UPDATE_FLAG, PARENT_ENV, SERVE_STATE_NAME, UPDATED_ENV,
};
use crate::upload_project::{ConsoleIo, UploadSummary};
use anyhow::Result;
use atlas_core::js;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// 画面などが out/ で集計し直している間は待つ長さと、見に行く間隔
const BUSY_WAIT: Duration = Duration::from_secs(60 * 60);
const BUSY_POLL: Duration = Duration::from_secs(30);

static WS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(&format!("{}+", js::RE_S)).unwrap());

/// `message.replace(/\s+/g, ' ').trim()`
fn squash(s: &str) -> String {
    js::trim(&WS.replace_all(s, " ")).to_string()
}

/// 結果を書く(書きかけを読まれないよう、別の名前に書いてから置き換える)。書けなくても止めない(記録には書いてある)
fn write_status(path: &Path, s: &AutoStatusFile) {
    let _ = (|| -> Result<()> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
        std::fs::write(&tmp, format!("{}\n", atlas_core::json::to_js_string_pretty(s)?))?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
}

pub struct AutoDeps<'a> {
    pub out_dir: PathBuf,
    /// 1 行を記録に書く
    pub log: &'a (dyn Fn(&str) + Sync),
    /// 集計し直す。失敗したら false(理由は記録に書いてある)
    pub aggregate: &'a dyn Fn() -> bool,
    /// 送る。summary に送ったものを書き込む
    pub upload: &'a dyn Fn(&Mutex<UploadSummary>) -> Result<bool>,
    /// out/ で動いている別の処理(画面の「集計し直す」など)の種類。無ければ None
    pub busy: &'a dyn Fn() -> Option<String>,
    /// 送れなかったことを知らせる(失敗しても止めない)
    pub notify: &'a dyn Fn(&str, &str) -> Result<()>,
    pub now: &'a dyn Fn() -> String,
    pub sleep: &'a dyn Fn(Duration),
    pub busy_wait: Duration,
    /// 送る前に atlas を新しい版にした結果(結果のファイルに残す)。更新しない設定なら None
    pub update: Option<AutoUpdateResult>,
}

fn real_now() -> String {
    atlas_core::jsdate::now_iso()
}

fn real_sleep(d: Duration) {
    std::thread::sleep(d);
}

impl<'a> AutoDeps<'a> {
    pub fn new(
        out_dir: PathBuf,
        log: &'a (dyn Fn(&str) + Sync),
        aggregate: &'a dyn Fn() -> bool,
        upload: &'a dyn Fn(&Mutex<UploadSummary>) -> Result<bool>,
        busy: &'a dyn Fn() -> Option<String>,
        notify: &'a dyn Fn(&str, &str) -> Result<()>,
    ) -> Self {
        AutoDeps { out_dir, log, aggregate, upload, busy, notify, now: &real_now, sleep: &real_sleep, busy_wait: BUSY_WAIT, update: None }
    }
}

/// 自動で送る本体。送れたら true
pub fn run_auto_upload(d: &AutoDeps<'_>) -> bool {
    let status_path = d.out_dir.join(AUTO_STATUS_FILE);
    let mut status = AutoStatusFile { started_at: (d.now)(), finished_at: None, ok: false, error: None, sent: vec![], secrets: 0.0, root: None, update: Some(d.update.clone()) };
    write_status(&status_path, &status);
    (d.log)(&format!("自動で送ります({})", status.started_at));
    let summary = Mutex::new(UploadSummary::default());
    let r = (|| -> Result<()> {
        // 画面で集計し直している最中なら、終わるまで待つ(重なると、写す元が書き換わるので止まる)
        let started = Instant::now();
        while let Some(b) = (d.busy)() {
            if started.elapsed() > d.busy_wait {
                anyhow::bail!("別の処理({b})が出力先で動き続けているので、送りませんでした。次の回に送ります");
            }
            (d.log)(&format!("別の処理({b})が出力先で動いているので、終わるのを待ちます"));
            (d.sleep)(BUSY_POLL);
        }
        if !(d.aggregate)() {
            anyhow::bail!("集計に失敗しました(理由は記録に書きました)");
        }
        let all = (d.upload)(&summary);
        let s = summary.lock().unwrap().clone();
        status.sent = s.sent;
        status.secrets = s.secrets as f64;
        status.root = s.root;
        if !all? {
            anyhow::bail!("送り終えませんでした(理由は記録に書きました)");
        }
        Ok(())
    })();
    let ok = match r {
        Ok(()) => {
            status.ok = true;
            (d.log)("終わりました");
            true
        }
        Err(e) => {
            let msg = squash(&e.to_string());
            status.error = Some(msg.clone());
            (d.log)(&format!("送れませんでした: {msg}"));
            if let Err(n) = (d.notify)("agent-session-atlas: 自動で送れませんでした", &format!("{msg}\nschedule-upload.bat を開くと、結果と記録の場所が見られます。")) {
                (d.log)(&format!("通知を出せませんでした: {n}"));
            }
            false
        }
    };
    status.finished_at = Some((d.now)());
    write_status(&status_path, &status);
    ok
}

/// Windows の通知(トースト)を出すスクリプト。題と本文は環境変数で渡す。PowerShell 5.1 の名前で出す(アプリとして登録しなくても出せる)
pub const TOAST_SCRIPT: &str = r#"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>$(& $esc $env:ATLAS_TOAST_TITLE)</text><text>$(& $esc $env:ATLAS_TOAST_BODY)</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))
"#;

/// 呼び出し元が止められていないかを見る間隔
const PARENT_POLL: Duration = Duration::from_secs(30);

/// このチェックアウトで atlas の処理が動いているか(動いていれば、その説明)。見るのは、いつもの出力先と、別のフォルダを開いた出力先
/// (<out>-folders/<キー>/out)の、集計の印(.job.json)とサーバの印(.serve.json)。印のプロセスが無ければ、動いていないとみなす
pub fn atlas_running(out_dir: &Path) -> Option<String> {
    let mut dirs = vec![out_dir.to_path_buf()];
    let root = PathBuf::from(format!("{}-folders", out_dir.display()));
    if let Ok(es) = atlas_core::jsfs::read_dir(&root) {
        for e in es.into_iter().filter(|e| e.is_dir()) {
            dirs.push(root.join(e.name).join("out"));
        }
    }
    for dir in &dirs {
        for (file, what) in [(JOB_LOCK_NAME, "集計など"), (SERVE_STATE_NAME, "画面のサーバ")] {
            let pid = std::fs::read(dir.join(file)).ok().and_then(|t| js::parse_json(&String::from_utf8_lossy(&t)).ok()).and_then(|v| v.get("pid").and_then(Value::as_f64));
            if let Some(pid) = pid.filter(|p| p.fract() == 0.0 && *p > 0.0 && *p <= u32::MAX as f64).map(|p| p as u32) {
                if pid != std::process::id() && crate::sys::alive(pid) {
                    return Some(format!("{what}。{}", dir.display()));
                }
            }
        }
    }
    None
}

/// 前にこの PC で動かなかった版(もっと新しい版が出るまで使わない)
pub fn read_avoid(out_dir: &Path) -> Option<String> {
    let t = std::fs::read(out_dir.join(AUTO_UPDATE_STATE_FILE)).ok()?;
    let v = js::parse_json(&String::from_utf8_lossy(&t)).ok()?;
    v.get("avoid").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

pub fn write_avoid(out_dir: &Path, sha: &str, note: &str) {
    let body = serde_json::json!({ "avoid": sha, "at": atlas_core::jsdate::now_iso(), "note": note });
    // 覚えられないだけ(次の回も新しい版を試し、同じように前の版に戻す)
    let _ = std::fs::write(out_dir.join(AUTO_UPDATE_STATE_FILE), format!("{}\n", atlas_core::json::to_js_string_pretty(&body).unwrap_or_default()));
}

/// 動かし直した結果(終了コードと、エラー出力)
pub struct Relaunched {
    pub code: Option<i32>,
    pub stderr: String,
}

pub struct UpdateFlowDeps<'a> {
    pub env: &'a HashMap<String, String>,
    pub argv: &'a [String],
    pub log: &'a dyn Fn(&str),
    /// この回を始めた時刻(動かし直した側が、この回の結果を書いたかを見分ける)
    pub started_at: String,
    /// 新しい版にする(self_update.rs の self_update)
    pub update: &'a dyn Fn() -> Result<AutoUpdateResult>,
    /// 今の版(新しい版にした後なら新しい版)で自分を動かし直す。env は足す環境変数
    pub relaunch: &'a dyn Fn(&[(String, String)]) -> Relaunched,
    pub read_status: &'a dyn Fn() -> Option<AutoStatusFile>,
    pub write_status: &'a dyn Fn(&AutoStatusFile),
    /// 前の版に戻す(self_update.rs の rollback)。ok と note
    pub rollback: &'a dyn Fn(&str) -> (bool, String),
    /// この PC で動かなかった版を覚える
    pub avoid: &'a dyn Fn(&str, &str),
    pub notify: &'a dyn Fn(&str, &str) -> Result<()>,
    pub now: &'a dyn Fn() -> String,
    /// 呼び出し元(このプロセス)の番号
    pub pid: u32,
}

/// 送る前に atlas を新しい版にする。返すのは、この回で使う更新の結果と、動かし直したならその終了コード(動かし直さなければ None。
/// そのときは、呼び出した側がこのまま送る)
pub fn run_update_flow(d: &UpdateFlowDeps<'_>) -> (Option<AutoUpdateResult>, Option<i32>) {
    if let Some(passed) = d.env.get(UPDATED_ENV) {
        return (js::parse_json_as::<AutoUpdateResult>(passed).ok(), None);
    }
    if d.argv.iter().any(|a| a == NO_UPDATE_FLAG) {
        (d.log)("atlas の更新: しない設定です(schedule-upload.bat の u で切り替えられます)");
        return (None, None);
    }
    let update = match (d.update)() {
        Ok(u) => u,
        Err(e) => {
            let u = AutoUpdateResult { outcome: "failed".into(), from: None, to: None, from_sha: None, to_sha: None, note: format!("更新できませんでした({})", squash(&e.to_string())) };
            (d.log)(&format!("atlas の更新: {}", u.note));
            u
        }
    };
    if update.outcome != "updated" {
        return (Some(update), None);
    }
    // 動かし直して、その側がこの回の結果を書き終えたか
    let relaunch = |u: &AutoUpdateResult| -> (bool, Option<i32>) {
        let r = (d.relaunch)(&[(UPDATED_ENV.to_string(), atlas_core::json::to_js_string(u).unwrap_or_default()), (PARENT_ENV.to_string(), d.pid.to_string())]);
        let done = (d.read_status)().is_some_and(|s| js::cmp_utf16(&s.started_at, &d.started_at).is_ge() && s.finished_at.is_some());
        if !done {
            (d.log)(&format!("atlas の更新: 動かし直した側が、結果を残さずに終わりました(終了コード {})", r.code.map_or("不明".to_string(), |c| c.to_string())));
            let lines: Vec<&str> = r.stderr.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !js::trim(l).is_empty()).collect();
            for line in &lines[lines.len().saturating_sub(20)..] {
                (d.log)(&format!("  {line}"));
            }
        }
        (done, r.code)
    };
    let fail = |message: &str, u: AutoUpdateResult| -> (Option<AutoUpdateResult>, Option<i32>) {
        (d.log)(&format!("送れませんでした: {message}"));
        (d.write_status)(&AutoStatusFile { started_at: d.started_at.clone(), finished_at: Some((d.now)()), ok: false, error: Some(message.into()), sent: vec![], secrets: 0.0, root: None, update: Some(Some(u.clone())) });
        if let Err(e) = (d.notify)("agent-session-atlas: 自動で送れませんでした", &format!("{message}\nschedule-upload.bat を開くと、結果と記録の場所が見られます。")) {
            (d.log)(&format!("通知を出せませんでした: {e}"));
        }
        (Some(u), Some(1))
    };

    (d.log)("atlas の更新: 新しい版で動かし直します");
    let first = relaunch(&update);
    if first.0 {
        return (Some(update), Some(first.1.unwrap_or(1)));
    }
    // 新しい版がこの PC で動かない。もっと新しい版が出るまで使わず、前の版で送る
    let (Some(from_sha), Some(to_sha)) = (update.from_sha().map(str::to_string), update.to_sha().map(str::to_string)) else {
        let m = format!("新しい版({})で動かせませんでした(記録をご覧ください)", update.to.as_deref().unwrap_or("不明"));
        return fail(&m, update);
    };
    let bad = format!("新しい版({})はこの PC で動かなかった", update.to.as_deref().unwrap_or("null"));
    (d.avoid)(&to_sha, &bad);
    let (ok, note) = (d.rollback)(&from_sha);
    if !ok {
        let u = AutoUpdateResult { outcome: "failed".into(), note: format!("{bad}。{note}"), ..update.clone() };
        return fail(&format!("{bad}ので前の版に戻そうとしましたが、{note}"), u);
    }
    let fallback = AutoUpdateResult {
        outcome: "failed".into(),
        from: update.from.clone(),
        to: update.from.clone(),
        from_sha: Some(Some(from_sha.clone())),
        to_sha: Some(Some(from_sha)),
        note: format!("{bad}ので、{note}。前の版で送ります(もっと新しい版が出たら、それにします。直らなければ atlas を作っている人に知らせてください)"),
    };
    (d.log)(&format!("atlas の更新: {}", fallback.note));
    let second = relaunch(&fallback);
    if second.0 {
        return (Some(fallback), Some(second.1.unwrap_or(1)));
    }
    fail(&format!("{bad}ので前の版に戻しましたが、前の版でも動かせませんでした(記録をご覧ください)"), fallback)
}

/// 自動で送るときの io(尋ねない。表示は記録に書く)
struct LogIo<'a> {
    log: &'a (dyn Fn(&str) + Sync),
}

impl ConsoleIo for LogIo<'_> {
    fn ask(&self, _q: &str) -> String {
        String::new()
    }
    fn print(&self, line: &str) {
        (self.log)(line);
    }
}

/// Windows の通知を出す(Windows 以外では何もしない)
fn toast(title: &str, body: &str) -> Result<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    let r = crate::upload_schedule::run_power_shell(TOAST_SCRIPT, &[("ATLAS_TOAST_TITLE".into(), title.into()), ("ATLAS_TOAST_BODY".into(), body.into())])?;
    if r.code != 0 {
        let first = js::trim(&r.stderr).split('\n').next().map(|l| l.strip_suffix('\r').unwrap_or(l).to_string());
        anyhow::bail!("{}", first.unwrap_or_else(|| format!("終了コード {}", r.code)));
    }
    Ok(())
}

/// タスクから(`atlas upload-auto [--no-update]`)
pub fn main(argv: &[String]) -> u8 {
    // 置き場は atlas.bat と同じ既定(out/)。ATLAS_OUT は試すとき用
    let out_dir = match std::env::var("ATLAS_OUT").ok().filter(|s| !s.is_empty()) {
        Some(o) => crate::paths::resolve(o),
        None => crate::paths::resolve(crate::paths::REPO_ROOT.join("out")),
    };
    let _ = std::fs::create_dir_all(&out_dir);
    let log_path = out_dir.join(AUTO_LOG_FILE);
    let env: HashMap<String, String> = std::env::vars().collect();
    // 記録は回ごとに書き直す。新しい版にして動かし直した側は、前の側が書いた記録(更新の経過)に続けて書く
    if !env.contains_key(UPDATED_ENV) {
        let _ = std::fs::write(&log_path, "");
    }
    let lp = log_path.clone();
    let log = move |line: &str| {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&lp) {
            let _ = writeln!(f, "{line}");
        }
    };
    if env.contains_key(crate::upload_auto_files::TS_TASK_ENV) && !env.contains_key(UPDATED_ENV) {
        log("このタスクは前の版(Node.js で動かす版)で登録したものです。schedule-upload.bat を開くと、atlas.exe で動くように登録し直します");
    }
    // 動かし直された側: 呼び出し元が止められたら(タスクの打ち切りなど)、こちらも止まる(残って次の回と重ならないように)
    if let Some(parent) = env.get(PARENT_ENV).and_then(|p| p.parse::<u32>().ok()).filter(|p| *p > 0) {
        let log = log.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(PARENT_POLL);
            if !crate::sys::alive(parent) {
                log("呼び出し元が止められたので、止まります");
                std::process::exit(1);
            }
        });
    }
    let status_path = out_dir.join(AUTO_STATUS_FILE);
    let repo = crate::paths::REPO_ROOT.clone();
    let busy = || atlas_running(&out_dir);
    let avoid = read_avoid(&out_dir);
    let update_opts = || {
        let mut o = crate::self_update::UpdateOptions::new(&repo, &log);
        o.busy = Some(&busy);
        o.avoid = avoid.clone();
        o
    };
    let rest: Vec<String> = argv.to_vec();
    let relaunch = |extra: &[(String, String)]| -> Relaunched {
        // 新しい版にしたときは、bin/ に用意した新しい実行ファイルで動かす(動いている実行ファイルは、置き換えるときに別の名前に移されている)
        let exe = crate::paths::installed_exe().unwrap_or_else(|| std::env::current_exe().unwrap_or_else(|_| PathBuf::from("atlas")));
        let mut c = std::process::Command::new(exe);
        c.arg("upload-auto").args(&rest).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
        for (k, v) in extra {
            c.env(k, v);
        }
        crate::self_update::hide_window(&mut c);
        match c.output() {
            Ok(o) => Relaunched { code: o.status.code(), stderr: String::from_utf8_lossy(&o.stderr).into_owned() },
            Err(e) => Relaunched { code: None, stderr: format!("\n{e}") },
        }
    };
    let flow = UpdateFlowDeps {
        env: &env,
        argv,
        log: &log,
        started_at: atlas_core::jsdate::now_iso(),
        update: &|| Ok(crate::self_update::self_update(&update_opts())),
        relaunch: &relaunch,
        read_status: &|| std::fs::read(&status_path).ok().and_then(|t| js::parse_json_as(&String::from_utf8_lossy(&t)).ok()),
        write_status: &|s| write_status(&status_path, s),
        rollback: &|sha| {
            let r = crate::self_update::rollback(&update_opts(), sha);
            (r.ok, r.note)
        },
        avoid: &|sha, note| write_avoid(&out_dir, sha, note),
        notify: &toast,
        now: &real_now,
        pid: std::process::id(),
    };
    let (update, code) = run_update_flow(&flow);
    if let Some(code) = code {
        return code.clamp(0, 255) as u8;
    }
    let paths = crate::paths::resolve_paths(crate::paths::PathInputs { home: None, out: Some(&out_dir.to_string_lossy()), judgments: None, bundle: None, notes_dir: None });
    let io = LogIo { log: &log };
    let out_s = out_dir.to_string_lossy().into_owned();
    let aggregate = || crate::upload_project::refresh_aggregate(&io, &out_dir.join(AUTO_AGGREGATE_LOG_FILE), &|l| crate::upload_project::run_all(Some(&out_s), l));
    let upload = |summary: &Mutex<UploadSummary>| {
        crate::upload_project::run_upload_project(
            &io,
            &crate::upload_project::UploadProjectOptions { paths: GroupUploadPaths::of(&paths), config_path: crate::config::default_config_path(), auto: true, summary: Some(summary) },
        )
    };
    let job_busy = || crate::jobs::running_job_in(&out_dir);
    let mut deps = AutoDeps::new(out_dir.clone(), &log, &aggregate, &upload, &job_busy, &toast);
    deps.update = update;
    let ok = run_auto_upload(&deps);
    // 途中で止められたときも、集計の作業中の印は外す(自分の印だけを消す)
    crate::jobs::release_out_lock(&paths.out);
    if ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const STARTED: &str = "2026-11-13T09:00:00.000Z";

    fn updated() -> AutoUpdateResult {
        AutoUpdateResult {
            outcome: "updated".into(),
            from: Some("aaaaaaa".into()),
            to: Some("bbbbbbb".into()),
            from_sha: Some(Some("a".repeat(40))),
            to_sha: Some(Some("b".repeat(40))),
            note: "aaaaaaa から bbbbbbb に更新しました".into(),
        }
    }

    fn finished(started: &str, ok: bool) -> AutoStatusFile {
        AutoStatusFile { started_at: started.into(), finished_at: Some("2026-11-13T09:01:00.000Z".into()), ok, error: None, sent: vec![], secrets: 0.0, root: None, update: None }
    }

    struct Flow {
        logs: RefCell<Vec<String>>,
        relaunches: RefCell<Vec<Vec<(String, String)>>>,
        written: RefCell<Vec<AutoStatusFile>>,
        avoided: RefCell<Vec<String>>,
        rolled: RefCell<Vec<String>>,
        notes: RefCell<Vec<String>>,
        status: RefCell<Option<AutoStatusFile>>,
        children: RefCell<Vec<Option<AutoStatusFile>>>,
    }

    fn run(update: AutoUpdateResult, children: Vec<Option<AutoStatusFile>>, rollback_ok: bool, env: HashMap<String, String>, argv: Vec<String>) -> (Flow, (Option<AutoUpdateResult>, Option<i32>)) {
        let f = Flow {
            logs: RefCell::default(),
            relaunches: RefCell::default(),
            written: RefCell::default(),
            avoided: RefCell::default(),
            rolled: RefCell::default(),
            notes: RefCell::default(),
            status: RefCell::new(Some(finished("2026-11-12T09:00:00.000Z", true))),
            children: RefCell::new(children.into_iter().rev().collect()),
        };
        let r = {
            let d = UpdateFlowDeps {
                env: &env,
                argv: &argv,
                log: &|l| f.logs.borrow_mut().push(l.into()),
                started_at: STARTED.into(),
                update: &|| Ok(update.clone()),
                relaunch: &|e| {
                    f.relaunches.borrow_mut().push(e.to_vec());
                    let next = f.children.borrow_mut().pop().flatten();
                    match next {
                        Some(s) => {
                            let ok = s.ok;
                            *f.status.borrow_mut() = Some(s);
                            Relaunched { code: Some(if ok { 0 } else { 1 }), stderr: String::new() }
                        }
                        None => Relaunched { code: Some(1), stderr: "SyntaxError: 新しい版が読めない\n    at 1:1".into() },
                    }
                },
                read_status: &|| f.status.borrow().clone(),
                write_status: &|s| {
                    f.written.borrow_mut().push(s.clone());
                    *f.status.borrow_mut() = Some(s.clone());
                },
                rollback: &|sha| {
                    f.rolled.borrow_mut().push(sha.into());
                    if rollback_ok { (true, "前の版(aaaaaaa)に戻しました".into()) } else { (false, "前の版(aaaaaaa)に戻せませんでした(x)".into()) }
                },
                avoid: &|sha, _| f.avoided.borrow_mut().push(sha.into()),
                notify: &|t, _| {
                    f.notes.borrow_mut().push(t.into());
                    Ok(())
                },
                now: &|| "2026-11-13T09:05:00.000Z".into(),
                pid: 4321,
            };
            run_update_flow(&d)
        };
        (f, r)
    }

    #[test]
    fn update_flow() {
        // 動かし直した側は更新せず、渡された結果を使う。--no-update なら更新しない
        let env: HashMap<String, String> = [(UPDATED_ENV.to_string(), atlas_core::json::to_js_string(&updated()).unwrap())].into();
        let (_, r) = run(updated(), vec![], true, env, vec![]);
        assert_eq!(r, (Some(updated()), None));
        let (f, r) = run(updated(), vec![], true, HashMap::new(), vec![NO_UPDATE_FLAG.into()]);
        assert_eq!(r, (None, None));
        assert!(f.relaunches.borrow().is_empty());
        // 新しい版にならなければ、動かし直さない
        let latest = AutoUpdateResult { outcome: "latest".into(), ..updated() };
        let (f, r) = run(latest.clone(), vec![], true, HashMap::new(), vec![]);
        assert_eq!(r, (Some(latest), None));
        assert!(f.relaunches.borrow().is_empty());
        // 新しい版にしたら動かし直し、その終了コードを返す
        let (f, r) = run(updated(), vec![Some(finished("2026-11-13T09:00:05.000Z", true))], true, HashMap::new(), vec![]);
        assert_eq!(r, (Some(updated()), Some(0)));
        let rel = &f.relaunches.borrow()[0];
        assert_eq!(rel[1], (PARENT_ENV.to_string(), "4321".to_string()));
        // 結果を残さずに落ちたら、その版を覚えて前の版に戻し、前の版で送る
        let (f, r) = run(updated(), vec![None, Some(finished("2026-11-13T09:00:09.000Z", true))], true, HashMap::new(), vec![]);
        assert_eq!(r.1, Some(0));
        let u = r.0.unwrap();
        assert_eq!((u.outcome.as_str(), u.to.as_deref(), u.to_sha()), ("failed", Some("aaaaaaa"), Some("a".repeat(40).as_str())));
        assert_eq!(*f.avoided.borrow(), vec!["b".repeat(40)]);
        assert_eq!(*f.rolled.borrow(), vec!["a".repeat(40)]);
        assert!(f.logs.borrow().iter().any(|l| l == "  SyntaxError: 新しい版が読めない"));
        // 前の版に戻せなければ、送れなかったことを結果に書いて知らせる(前の回の結果のままにしない)
        let (f, r) = run(updated(), vec![None], false, HashMap::new(), vec![]);
        assert_eq!(r.1, Some(1));
        let w = f.written.borrow();
        assert_eq!(w[0].started_at, STARTED);
        assert_eq!(w[0].error.as_deref(), Some("新しい版(bbbbbbb)はこの PC で動かなかったので前の版に戻そうとしましたが、前の版(aaaaaaa)に戻せませんでした(x)"));
        assert_eq!(f.notes.borrow().len(), 1);
        // 途中で落ちた(始めたが終わっていない)ときも、結果が残らなかったものとして前の版で送る
        let half = AutoStatusFile { finished_at: None, ..finished("2026-11-13T09:00:05.000Z", false) };
        let (f, r) = run(updated(), vec![Some(half), Some(finished("2026-11-13T09:00:09.000Z", true))], true, HashMap::new(), vec![]);
        assert_eq!(r.1, Some(0));
        assert_eq!(f.relaunches.borrow().len(), 2);
    }

    #[test]
    fn running_and_avoid() {
        assert_eq!(JOB_LOCK_NAME, crate::jobs::JOB_LOCK_FILE);
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        assert_eq!(atlas_running(&out), None);
        // 自分の印・プロセスが無い印は動いていないとみなす
        std::fs::write(out.join(JOB_LOCK_NAME), format!("{{\"pid\":{}}}", std::process::id())).unwrap();
        assert_eq!(atlas_running(&out), None);
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" }).args(if cfg!(windows) { ["/c", "ping -n 5 127.0.0.1 >nul"] } else { ["-c", "sleep 5"] }).spawn().unwrap();
        let other = PathBuf::from(format!("{}-folders", out.display())).join("k").join("out");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(SERVE_STATE_NAME), format!("{{\"pid\":{}}}", child.id())).unwrap();
        assert_eq!(atlas_running(&out), Some(format!("画面のサーバ。{}", other.display())));
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(read_avoid(&out), None);
        write_avoid(&out, "abc", "動かなかった");
        assert_eq!(read_avoid(&out).as_deref(), Some("abc"));
        std::fs::write(out.join(AUTO_UPDATE_STATE_FILE), "{").unwrap();
        assert_eq!(read_avoid(&out), None);
    }

    #[test]
    fn auto_upload() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().to_path_buf();
        let logs = RefCell::new(Vec::<String>::new());
        let lg = Mutex::new(Vec::<String>::new());
        let log = |l: &str| lg.lock().unwrap().push(l.into());
        let notes = RefCell::new(0);
        // 集計し直してから送り、送ったものを結果のファイルに残す(送れたときは知らせない)
        let agg = || true;
        let up = |s: &Mutex<UploadSummary>| {
            let mut s = s.lock().unwrap();
            s.root = Some("R".into());
            s.sent.push(crate::upload_auto_files::SentProject { name: "owner/app".into(), sessions: 2.0, unchanged: Some(0.0) });
            s.secrets = 1;
            Ok(true)
        };
        let busy_n = RefCell::new(2);
        let busy = || {
            let mut n = busy_n.borrow_mut();
            if *n > 0 {
                *n -= 1;
                Some("refresh".to_string())
            } else {
                None
            }
        };
        let notify = |_: &str, _: &str| {
            *notes.borrow_mut() += 1;
            Ok(())
        };
        let mut deps = AutoDeps::new(out.clone(), &log, &agg, &up, &busy, &notify);
        deps.sleep = &|_| {};
        assert!(run_auto_upload(&deps));
        let s = crate::upload_schedule::read_auto_status(&out).unwrap();
        assert!(s.ok && s.finished_at.is_some());
        assert_eq!(s.sent[0].sessions, 2.0);
        assert_eq!(s.secrets, 1.0);
        assert_eq!(s.update, Some(None));
        assert_eq!(*notes.borrow(), 0);
        assert!(lg.lock().unwrap().iter().any(|l| l == "別の処理(refresh)が出力先で動いているので、終わるのを待ちます"));
        // 集計か送るのに失敗したら、理由を結果と記録に残し、通知で知らせる。通知に失敗しても止まらない
        let bad = || false;
        let fail_notify = |_: &str, _: &str| -> Result<()> { anyhow::bail!("通知が無い") };
        let deps = AutoDeps::new(out.clone(), &log, &bad, &up, &|| None, &fail_notify);
        assert!(!run_auto_upload(&deps));
        let s = crate::upload_schedule::read_auto_status(&out).unwrap();
        assert_eq!(s.error.as_deref(), Some("集計に失敗しました(理由は記録に書きました)"));
        assert!(lg.lock().unwrap().iter().any(|l| l == "通知を出せませんでした: 通知が無い"));
        // 途中で送り終えなかったとき(false)も失敗として残す。送れた分は結果に残る
        let partial = |s: &Mutex<UploadSummary>| {
            s.lock().unwrap().sent.push(crate::upload_auto_files::SentProject { name: "a".into(), sessions: 1.0, unchanged: None });
            Ok(false)
        };
        let deps = AutoDeps::new(out.clone(), &log, &agg, &partial, &|| None, &notify);
        assert!(!run_auto_upload(&deps));
        let s = crate::upload_schedule::read_auto_status(&out).unwrap();
        assert_eq!(s.sent.len(), 1);
        assert_eq!(s.error.as_deref(), Some("送り終えませんでした(理由は記録に書きました)"));
        drop(logs);
    }
}
