//! judge run: バンドルの各パケットをバックエンドで判定し、judgments.json に 1 件ずつ追記する(packages/judge/src/run.ts の移植)。
//! 失敗したセッションは failures に記録して次へ進む(黙って捨てない)。

use crate::backends::{JudgeBackend, JudgePacket};
use crate::bundle::read_bundle_manifest;
use crate::judgments_io::{read_judgments, write_judgments};
use crate::packet::{missing_sections, packet_session_id};
use crate::schema::{add_usage, empty_judgments, merge_judgments, FileJudge, JudgeMeta, JudgeUsage, JudgmentsFile};
use anyhow::{bail, Result};
use atlas_core::jsnum::to_fixed;
use serde_json::json;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

pub struct RunOptions<'a> {
    pub bundle_dir: PathBuf,
    pub judgments_path: PathBuf,
    pub backend: &'a dyn JudgeBackend,
    /// 判定する最大件数(未判定のものから)
    pub limit: Option<u64>,
    /// このセッションだけ
    pub only: Option<Vec<String>>,
    /// 判定済みでも判定し直す
    pub force: bool,
    pub concurrency: u64,
    pub log: &'a (dyn Fn(&str) + Sync),
    /// 時刻(ISO)を返す。None なら今
    pub now: Option<&'a (dyn Fn() -> String + Sync)>,
}

#[derive(Debug, Clone, Default)]
pub struct RunFailure {
    pub session_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Default)]
pub struct RunSummary {
    /// バンドルのパケット数
    pub packets: usize,
    /// 判定済みのためスキップ
    pub already_judged: usize,
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: Vec<RunFailure>,
    pub usage: JudgeUsage,
    pub notes: Vec<String>,
}

struct Shared {
    judgments: JudgmentsFile,
    summary: RunSummary,
    next: usize,
    done: usize,
}

pub fn run_judge(o: &RunOptions<'_>) -> Result<RunSummary> {
    let log = o.log;
    let now = || o.now.map_or_else(atlas_core::jsdate::now_iso, |f| f());
    let manifest = read_bundle_manifest(&o.bundle_dir)?;
    let mut entries: Vec<&crate::bundle::BundleEntry> = manifest.sessions.iter().collect();
    if let Some(only) = o.only.as_ref().filter(|x| !x.is_empty()) {
        let ids: HashSet<&str> = manifest.sessions.iter().map(|s| s.id.as_str()).collect();
        let unknown: Vec<&str> = only.iter().map(String::as_str).filter(|id| !ids.contains(id)).collect();
        if !unknown.is_empty() {
            bail!("バンドルに無いセッション ID です: {}", unknown.join(", "));
        }
        let want: HashSet<&str> = only.iter().map(String::as_str).collect();
        entries.retain(|e| want.contains(e.id.as_str()));
    }
    let backend = o.backend;
    let judgments = match read_judgments(&o.judgments_path)? {
        Some(j) => j,
        None => empty_judgments(backend.name(), backend.model(), &now()),
    };
    let judged: HashSet<String> = judgments.items.iter().map(|i| i.session_id.clone()).collect();
    let todo: Vec<&crate::bundle::BundleEntry> = if o.force { entries.clone() } else { entries.iter().copied().filter(|e| !judged.contains(&e.id)).collect() };
    let already_judged = entries.len() - todo.len();
    let targets: Vec<&crate::bundle::BundleEntry> = match o.limit {
        Some(l) => todo.into_iter().take(l as usize).collect(),
        None => todo,
    };
    log(&format!(
        "judge: バックエンド {}{}、対象 {} 件(パケット {}、判定済みでスキップ {already_judged})",
        backend.name(),
        backend.model().map(|m| format!("({m})")).unwrap_or_default(),
        targets.len(),
        manifest.sessions.len()
    ));

    let ran_at = now();
    let summary = RunSummary { packets: manifest.sessions.len(), already_judged, attempted: targets.len(), ..Default::default() };
    let meta = |s: &RunSummary| FileJudge { backend: backend.name().into(), model: backend.model().map(str::to_string), ran_at: ran_at.clone(), usage: Some(serde_json::to_value(&s.usage).unwrap_or_default()) };

    // judgments.json への書き込みは直列にする(並列判定でも 1 件ずつ確定させる)
    let shared = Mutex::new(Shared { judgments, summary, next: 0, done: 0 });
    let worker = || -> Result<()> {
        loop {
            let e = {
                let mut s = shared.lock().unwrap();
                if s.next >= targets.len() {
                    return Ok(());
                }
                s.next += 1;
                targets[s.next - 1]
            };
            let t0 = Instant::now();
            let r = (|| -> Result<crate::backends::JudgeResult> {
                let md = crate::util::read_text(&atlas_core::jsfs::join_slash(&o.bundle_dir, &e.path))?;
                let id = packet_session_id(&md);
                if id.as_deref() != Some(e.id.as_str()) {
                    bail!("パケット {} のセッション ID({})が manifest({})と一致しません", e.path, id.as_deref().unwrap_or("なし"), e.id);
                }
                let miss = missing_sections(&md);
                if !miss.is_empty() {
                    bail!("パケット {} に必須の見出しがありません: {}", e.path, miss.join("、"));
                }
                backend.judge(&JudgePacket { session_id: &e.id, markdown: &md })
            })();
            match r {
                Ok(mut r) => {
                    r.item.judge = Some(JudgeMeta { backend: backend.name().into(), model: backend.model().map(str::to_string), ran_at: now() });
                    let mut s = shared.lock().unwrap();
                    s.summary.usage = add_usage(Some(&s.summary.usage), r.usage.as_ref());
                    for n in &r.notes {
                        s.summary.notes.push(format!("{}: {n}", e.id));
                    }
                    s.summary.succeeded += 1;
                    let m = meta(&s.summary);
                    s.judgments = merge_judgments(&s.judgments, std::slice::from_ref(&r.item), m);
                    write_judgments(&o.judgments_path, &s.judgments)?;
                    s.done += 1;
                    let h = &r.item.human_effort;
                    log(&format!(
                        "judge: [{}/{}] {} → {} {} 時間(確信度 {})、{} 秒",
                        s.done,
                        targets.len(),
                        e.id,
                        r.item.task_category,
                        atlas_core::js::num_to_string(h.hours),
                        atlas_core::js::num_to_string(h.confidence),
                        to_fixed(t0.elapsed().as_secs_f64(), 1)
                    ));
                }
                Err(err) => {
                    let msg = err.to_string();
                    let mut s = shared.lock().unwrap();
                    s.summary.failed.push(RunFailure { session_id: e.id.clone(), error: msg.clone() });
                    let f = json!({ "sessionId": e.id, "backend": backend.name(), "model": backend.model(), "at": now(), "error": msg });
                    let mut failures: Vec<serde_json::Value> = s.judgments.failures.iter().flatten().filter(|x| x.get("sessionId").and_then(|v| v.as_str()) != Some(e.id.as_str())).cloned().collect();
                    failures.push(f);
                    let m = meta(&s.summary);
                    s.judgments = JudgmentsFile { judge: m, failures: Some(failures), ..s.judgments.clone() };
                    write_judgments(&o.judgments_path, &s.judgments)?;
                    s.done += 1;
                    log(&format!("judge: [{}/{}] {} 失敗: {msg}", s.done, targets.len(), e.id));
                }
            }
        }
    };
    let n = o.concurrency.max(1).min(targets.len().max(1) as u64) as usize;
    let results: Vec<Result<()>> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..n).map(|_| sc.spawn(worker)).collect();
        hs.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(anyhow::anyhow!("判定の処理が異常終了しました")))).collect()
    });
    for r in results {
        r?;
    }
    Ok(shared.into_inner().unwrap().summary)
}
