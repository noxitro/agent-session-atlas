//! atlas judge run / import(packages/cli/src/commands.ts の makeBackend・runJudgeCommand の移植)。ログの文言は TS 版と同じ。
//! 判定のバックエンドとモデルの決め方は TS 版と同じにする(既定は copilot-cli。モデルは --model > atlas.config.json の judgeModel > なし)。

use super::{JudgeSummary, Log};
use crate::args::JudgeCliOptions;
use crate::config::resolve_judge_model;
use crate::paths::{resolve, Paths};
use anyhow::{bail, Result};
use atlas_judge::backends::anthropic::{anthropic_backend, AnthropicOptions};
use atlas_judge::backends::copilot_cli::{copilot_cli_backend, CopilotCliOptions};
use atlas_judge::backends::JudgeBackend;
use atlas_judge::judgments_io::{import_judgments, ImportOptions};
use atlas_judge::run::{run_judge, RunOptions};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// sessions.json を値のまま読む(セッション id と依頼の数だけを使うので、形は検証しない)
pub(crate) fn read_sessions_value(path: &Path) -> Result<Vec<Value>> {
    let text = atlas_judge::read_text(path)?;
    let v = atlas_core::js::parse_json(&text).map_err(|e| anyhow::anyhow!("{} を読めません: {e}", path.display()))?;
    match v.get("sessions") {
        Some(Value::Array(a)) => Ok(a.clone()),
        _ => bail!("{} の sessions が配列ではありません", path.display()),
    }
}

pub fn make_backend(j: &JudgeCliOptions, model: Option<String>) -> Result<Box<dyn JudgeBackend>> {
    let timeout_ms = j.timeout_sec * 1000;
    match j.backend.as_str() {
        "copilot-cli" => Ok(Box::new(copilot_cli_backend(CopilotCliOptions { bin: None, model, allow_tools: Some(j.allow_tools), timeout_ms: Some(timeout_ms) }))),
        "anthropic" => Ok(Box::new(anthropic_backend(AnthropicOptions { model, timeout_ms: Some(timeout_ms), ..Default::default() })?)),
        other => bail!("不明なバックエンドです: {other}"),
    }
}

pub fn run_judge_command(p: &Paths, j: &JudgeCliOptions, log: Log<'_>) -> Result<Option<JudgeSummary>> {
    if j.action == "import" {
        let known: Option<HashSet<String>> = if p.sessions.exists() {
            Some(read_sessions_value(&p.sessions)?.iter().filter_map(|s| s.get("id").and_then(Value::as_str).map(str::to_string)).collect())
        } else {
            None
        };
        let file = resolve(j.file.as_deref().unwrap_or(""));
        let r = import_judgments(&file, &p.judgments, ImportOptions { known_ids: known.as_ref(), ..Default::default() })?;
        log(&format!(
            "judge import: {} 件を取り込みました(既存の上書き {} 件、取り込み元の重複 {} 件)→ {}(計 {} 件)",
            r.imported,
            r.overwritten,
            r.duplicates,
            p.judgments.display(),
            r.total
        ));
        if !r.unknown_ids.is_empty() {
            log(&format!(
                "judge import: 注意 sessions.json に無いセッション ID が {} 件あります(レポートには出ません): {}{}",
                r.unknown_ids.len(),
                r.unknown_ids.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
                if r.unknown_ids.len() > 5 { " …" } else { "" }
            ));
        }
        return Ok(None);
    }
    if j.backend == "anthropic" {
        log("judge: 注意 anthropic バックエンドは Anthropic API の従量課金です");
    }
    let model = if j.backend == "copilot-cli" { resolve_judge_model(j.model.as_deref(), "judge", log)? } else { j.model.clone() };
    let backend = make_backend(j, model)?;
    let s = run_judge(&RunOptions {
        bundle_dir: p.bundle.clone(),
        judgments_path: p.judgments.clone(),
        backend: backend.as_ref(),
        limit: j.limit,
        only: j.only.clone(),
        force: j.force,
        concurrency: j.concurrency,
        log,
        now: None,
    })?;
    let usage = s.usage.totals.js_entries().into_iter().take(8).map(|(k, v)| format!("{k}={}", atlas_core::js::num_to_string(*v))).collect::<Vec<_>>().join(", ");
    log(&format!(
        "judge: 完了 成功 {} / 失敗 {} / 対象 {}(判定済みでスキップ {})→ {}",
        s.succeeded,
        s.failed.len(),
        s.attempted,
        s.already_judged,
        p.judgments.display()
    ));
    log(&format!(
        "judge: 判定自体の使用量 {} 回分{}{}",
        s.usage.runs,
        if usage.is_empty() { String::new() } else { format!("({usage})") },
        if s.usage.missing > 0 { format!("、取得できなかった {} 回", s.usage.missing) } else { String::new() }
    ));
    for n in s.notes.iter().take(5) {
        log(&format!("judge: 補足 {n}"));
    }
    Ok(Some(JudgeSummary { failed: s.failed.iter().map(|f| f.session_id.clone()).collect() }))
}
