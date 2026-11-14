//! atlas vcs(packages/cli/src/commands.ts の runVcs の移植)。ログの文言は TS 版と同じ(所要時間だけ違う)。
//! AI が作った変更が、その後の VCS のファイルに残っているかを照合し、out/vcs-retention.json に書く。
//! VCS は読むだけ。アップロード先から集計したときは、送った側の PC の結果(セッションのフォルダの atlas-vcs.json)を読む

use super::{ms, Log};
use crate::config::{load_config, CONFIG_FILE};
use crate::paths::{resolve, Paths, REPO_ROOT};
use anyhow::{bail, Result};
use atlas_core::vcs::EvalMode;
use atlas_core::vcs_retention::{ComputedOn, RetentionOptions, UnattributableReason, RETENTION_STATUSES};
use atlas_core::vcs_step::{run_vcs_step, VcsRetentionFile, VcsStepOptions};
use std::time::Instant;

pub fn run_vcs(p: &Paths, log: Log<'_>, mode: Option<&str>, config: Option<&str>) -> Result<VcsRetentionFile> {
    if !p.snapshot.exists() {
        bail!("スナップショットがありません: {}。先に atlas snapshot(または atlas all)を実行してください。", p.snapshot.display());
    }
    let t = Instant::now();
    let env_config = std::env::var("ATLAS_CONFIG").ok();
    let config_path = config.map(str::to_string).or(env_config);
    let cfg_file = match &config_path {
        Some(c) => resolve(c).to_string_lossy().into_owned(),
        None => REPO_ROOT.join(CONFIG_FILE).to_string_lossy().into_owned(),
    };
    let cfg = load_config(&cfg_file, config_path.is_some())?;
    let vcs_cfg = cfg.vcs.as_ref();
    let mode_name = mode.map(str::to_string).or_else(|| vcs_cfg.and_then(|v| v.mode.clone())).unwrap_or_else(|| "worktree".into());
    let mode = EvalMode::parse(&mode_name).ok_or_else(|| anyhow::anyhow!("--vcs-mode は worktree / committed / fixed のどれかです: {mode_name}"))?;
    let mut retention = RetentionOptions { mode, ..Default::default() };
    if let Some(d) = vcs_cfg.and_then(|v| v.lag_days).filter(|d| *d != 0) {
        retention.lag_days = d;
    }
    let opts = VcsStepOptions { retention, path_map: vcs_cfg.map(|v| v.path_map.clone()).unwrap_or_default(), ids: None };
    // 状態の名前と節の一文は、設定(atlas.config.json の vcs.labels・vcs.note)で差し替えたものを結果に入れる(表と画面はそれを使う)
    let mut r = run_vcs_step(&p.snapshot, &opts)?;
    r.labels = vcs_cfg.and_then(|v| v.labels.clone());
    r.note = vcs_cfg.and_then(|v| v.note.clone()).filter(|n| !n.is_empty());
    std::fs::create_dir_all(&p.out)?;
    std::fs::write(&p.vcs_retention, atlas_core::json::to_js_string_pretty(&r)?)?;
    let s = &r.summary;
    let mut entries: Vec<(&String, &i64)> = s.unattributable.js_entries();
    entries.sort_by(|a, b| b.1.cmp(a.1));
    let reasons = entries.iter().map(|(k, n)| format!("{} {n}", UnattributableReason::parse(k).map(|x| x.label()).unwrap_or(k.as_str()))).collect::<Vec<_>>().join("、");
    let place = if r.computed_on == ComputedOn::Sender {
        let read = match &r.senders {
            Some(Some(x)) => format!(" {} 件、照合 {}〜{}", x.sessions, x.from.as_deref().unwrap_or("不明"), x.to.as_deref().unwrap_or("不明")),
            _ => "(添えた結果なし)".into(),
        };
        format!("送った側の PC の結果を読んだ{read}")
    } else {
        let which = match mode {
            EvalMode::Worktree => "今の作業ツリー".to_string(),
            EvalMode::Committed => "最後に取り込んだ版".to_string(),
            EvalMode::Fixed => format!("セッションの終わりから {} 日後の版", r.lag_days.map(|d| d.to_string()).unwrap_or_else(|| "undefined".into())),
        };
        format!("比べる版: {which}")
    };
    log(&format!(
        "vcs: AI の変更があったセッション {} / {} 件、照合できた {} 件(基準を推定 {} 件){}({place}{}、{})→ {}",
        s.with_ai_changes,
        s.sessions,
        s.measured,
        s.baseline_estimated,
        if reasons.is_empty() { String::new() } else { format!("、照合不可 {reasons}") },
        if r.path_map != 0 { format!("、パスの読み替え {} 件", r.path_map) } else { String::new() },
        ms(t.elapsed()),
        p.vcs_retention.display()
    ));
    // ログの形が変わると、AI の編集から変更を取り出せなくなる(黙って 0 件にならないよう、数を出す)
    let unread: i64 = r.sessions.iter().map(|x| x.unread_edits.unwrap_or(0)).sum();
    if unread != 0 {
        let n = r.sessions.iter().filter(|x| x.unread_edits.is_some_and(|u| u != 0)).count();
        log(&format!("vcs: 注意 ログから変更を取り出せなかった AI の編集 {unread} 件({n} セッション)。Copilot のログの形が変わった可能性があります"));
    }
    if s.measured != 0 {
        let parts: Vec<String> = RETENTION_STATUSES
            .iter()
            .map(|k| format!("{} {}", r.labels.as_ref().and_then(|l| l.get(k.as_str())).map(String::as_str).unwrap_or(k.label()), s.hunks.get(*k)))
            .collect();
        log(&format!("vcs: 変更のまとまり {}", parts.join("、")));
    }
    Ok(r)
}
