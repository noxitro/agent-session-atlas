//! atlas serve(packages/cli/src/commands.ts の runServe の移植): 既に動いているサーバがあればブラウザを開くだけ。
//! 無ければ起動し、画面の heartbeat が途切れる(ブラウザを閉じる)まで待つ。

use super::Log;
use crate::paths::Paths;
use crate::serve::{find_running_server, open_in_browser, simple_request, start_serve, LogFn, OpenDirFn, PickFn, ReportsOptions, ServeOptions};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub struct ServeCli {
    pub port: Option<u64>,
    pub open: bool,
    pub config: Option<String>,
    /// 集計し直すときに読む場所(atlas open が立てたサーバ)
    pub home: Option<String>,
    pub reports: Option<ReportsOptions>,
}

fn env_ms(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

/// テスト用の差し替え(e2e と画面のテストが、環境変数 ATLAS_CLI で Rust 版のサーバを別のプロセスとして動かすときに使う。
/// TS 版のテストは startServe に直接渡していたもの)。ふだんは何も設定しない
fn test_overrides(o: &mut ServeOptions) {
    if let Some(v) = env_ms("ATLAS_SERVE_IDLE_MS") {
        o.idle_ms = v;
    }
    if let Some(v) = env_ms("ATLAS_SERVE_BYE_GRACE_MS") {
        o.bye_grace_ms = v;
    }
    if let Some(v) = env_ms("ATLAS_SERVE_FIRST_HEARTBEAT_MS") {
        o.first_heartbeat_ms = v;
    }
    if let Some(v) = env_ms("ATLAS_SERVE_VIEW_LIMIT") {
        o.view_limit = v;
    }
    if let Some(v) = env_ms("ATLAS_SERVE_MEMO_IMAGE_LIMIT") {
        o.memo_image_limit = v;
    }
    if let Ok(c) = std::env::var("ATLAS_SERVE_CODE_STAMP") {
        o.code_stamp = Some((c != "null").then_some(c));
    }
    if let Ok(c) = std::env::var("ATLAS_SERVE_CAN_PICK") {
        o.can_pick = Some(c == "1");
    }
    // フォルダを選ぶ画面とエクスプローラーで開く操作は、テストの側の小さなサーバに尋ねる(POST /pick・/open)
    if let Some(port) = std::env::var("ATLAS_TEST_HOOK_URL").ok().and_then(|u| u.rsplit(':').next().and_then(|p| p.trim_end_matches('/').parse::<u16>().ok())) {
        let pick: PickFn = Arc::new(move |title: &str, initial: Option<&str>| {
            let body = json!({ "title": title, "initial": initial }).to_string();
            let r = simple_request(port, "POST", "/pick", &[("content-type", "application/json")], body.as_bytes(), Duration::from_secs(600))?;
            if r.status != 200 {
                anyhow::bail!("フォルダを選ぶ画面の代わりが {} を返しました", r.status);
            }
            let v: Value = serde_json::from_slice(&r.body)?;
            Ok(v.get("path").and_then(Value::as_str).map(str::to_string))
        });
        let open: OpenDirFn = Arc::new(move |dir: &str| {
            let body = json!({ "dir": dir }).to_string();
            let _ = simple_request(port, "POST", "/open", &[("content-type", "application/json")], body.as_bytes(), Duration::from_secs(30));
        });
        o.pick = Some(pick);
        o.open_dir = Some(open);
    }
}

pub fn run_serve(p: &Paths, o: ServeCli, log: Log<'_>) -> Result<String> {
    if !p.html.exists() {
        bail!("{} がありません。先に atlas build(または atlas all)を実行してください。", p.html.display());
    }
    if let Some(running) = find_running_server(&p.out) {
        let url = format!("http://127.0.0.1:{}/atlas.html", running.port);
        log(&format!("serve: 既に動いているサーバがあります({url})。ブラウザで開くだけにします"));
        if running.code.as_deref() != Some(crate::version::CODE_STAMP) {
            log("serve: 動いているサーバは、今の atlas と版が違います(atlas のコードが変わる前に起動したもの)。前に開いた atlas.bat の黒い窓を閉じてから、もう一度 atlas.bat を実行してください");
        }
        if o.open {
            open_in_browser(&url, log);
        }
        return Ok("既存のサーバを使用".into());
    }
    // サーバのログは別のスレッド(ジョブの出力を読むスレッドなど)からも出す
    let out = |m: &str| {
        use std::io::Write;
        let mut s = std::io::stdout().lock();
        let _ = writeln!(s, "{m}");
        let _ = s.flush();
    };
    let server_log: LogFn = Arc::new(out);
    let mut so = ServeOptions::new(&p.out, &p.notes, &p.groups);
    so.port = o.port.unwrap_or(0) as u16;
    so.open = o.open;
    so.log = server_log;
    so.home = o.home;
    so.reports = o.reports.unwrap_or_default();
    so.config_path = o.config.map(PathBuf::from);
    test_overrides(&mut so);
    let h = start_serve(so)?;
    let close = h.closer();
    on_interrupt(move || close("中断"));
    let reason = h.wait();
    log(&format!("serve: 終了({reason})"));
    Ok(reason)
}

type Interrupt = Box<dyn Fn() + Send + Sync>;
static INTERRUPT: std::sync::Mutex<Option<Interrupt>> = std::sync::Mutex::new(None);

/// Ctrl+C(と、Windows で窓を閉じたとき・Unix の SIGTERM)で f を呼ぶ(サーバを止め、待っている run_serve が戻る)
fn on_interrupt(f: impl Fn() + Send + Sync + 'static) {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    *INTERRUPT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(f));
    INSTALL.call_once(install_interrupt);
}

fn fire_interrupt() -> bool {
    match INTERRUPT.lock() {
        Ok(g) => match g.as_ref() {
            Some(f) => {
                f();
                true
            }
            None => false,
        },
        Err(_) => false,
    }
}

#[cfg(windows)]
fn install_interrupt() {
    use windows_sys::Win32::System::Console::{SetConsoleCtrlHandler, CTRL_CLOSE_EVENT, CTRL_C_EVENT};
    unsafe extern "system" fn handler(kind: u32) -> windows_sys::core::BOOL {
        // 呼ばれるのは別のスレッド。窓を閉じたときは、戻ると OS がプロセスを終わらせるので、止める処理(.serve.json を消すなど)を済ませてから戻る
        if (kind == CTRL_C_EVENT || kind == CTRL_CLOSE_EVENT) && fire_interrupt() {
            return 1;
        }
        0
    }
    // SAFETY: プロセスの終わりまで残る関数を登録する
    unsafe {
        SetConsoleCtrlHandler(Some(handler), 1);
    }
}

#[cfg(unix)]
fn install_interrupt() {
    use std::sync::atomic::{AtomicI32, Ordering};
    static PIPE_W: AtomicI32 = AtomicI32::new(-1);
    extern "C" fn handler(_: libc::c_int) {
        // シグナルの中では、書き込み 1 回だけ(待っているスレッドが止める処理をする)
        let fd = PIPE_W.load(Ordering::SeqCst);
        if fd >= 0 {
            // SAFETY: write はシグナルの中で呼んでよい
            unsafe {
                libc::write(fd, b"x".as_ptr().cast(), 1);
            }
        }
    }
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: 2 つの fd を書かせる
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    PIPE_W.store(fds[1], Ordering::SeqCst);
    let rd = fds[0];
    let watcher = std::thread::Builder::new().name("atlas-serve-signal".into()).spawn(move || {
        let mut b = [0u8; 1];
        loop {
            // SAFETY: 1 バイトだけ読む
            let n = unsafe { libc::read(rd, b.as_mut_ptr().cast(), 1) };
            if n == 1 {
                fire_interrupt();
            } else if n == 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                return;
            }
        }
    });
    if watcher.is_err() {
        return;
    }
    // SAFETY: プロセスの終わりまで残る関数を登録する
    unsafe {
        libc::signal(libc::SIGINT, handler as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, handler as *const () as libc::sighandler_t);
    }
}
