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
    // 待っている間のメモリを小さくする(受け付けは 2 本、処理は要求ごとのスレッド)
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().thread_keep_alive(Duration::from_secs(10)).build()?;
    let reason = rt.block_on(async move {
        let h = start_serve(so).await?;
        let reason = tokio::select! {
            r = h.done() => r,
            _ = interrupted() => {
                h.close("中断");
                h.done().await
            }
        };
        anyhow::Ok(reason)
    });
    rt.shutdown_background();
    let reason = reason?;
    log(&format!("serve: 終了({reason})"));
    Ok(reason)
}

/// Ctrl+C(と、Windows で窓を閉じたとき・Unix の SIGTERM)
async fn interrupted() {
    #[cfg(windows)]
    {
        let mut close = tokio::signal::windows::ctrl_close().ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async { match close.as_mut() { Some(c) => { c.recv().await; } None => std::future::pending::<()>().await } } => {}
        }
    }
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async { match term.as_mut() { Some(t) => { t.recv().await; } None => std::future::pending::<()>().await } } => {}
        }
    }
}
