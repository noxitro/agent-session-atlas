//! 依頼ごとの判定(段階 2): atlas turns bundle / run(GitHub Copilot CLI)/ import(packages/cli/src/commands.ts の runTurns の移植)。
//! ログの文言は TS 版と同じ。

use super::judge::read_sessions_value;
use super::metrics::{select_sessions, SessionFilter};
use super::Log;
use crate::args::TurnsCliOptions;
use crate::config::{phase_names, resolve_judge_model};
use crate::paths::{resolve, Paths};
use anyhow::{bail, Result};
use atlas_judge::backends::copilot_cli::{copilot_cli_backend, CopilotCliOptions};
use atlas_judge::turn_bundle::{build_turn_bundle, TurnBundleOptions};
use atlas_judge::turn_run::{run_turn_judge, turn_import_phases, TurnRunOptions};
use atlas_judge::turn_schema::{import_turn_judgments_text, read_turn_judgments, TurnImportOptions};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// sessions.json の セッション ID → 依頼の数(analysis.turnStats の長さ)
pub(crate) fn turns_by_session(sessions: &[Value]) -> HashMap<String, usize> {
    sessions
        .iter()
        .filter_map(|s| {
            let id = s.get("id").and_then(Value::as_str)?;
            let n = s.get("analysis").and_then(|a| a.get("turnStats")).and_then(Value::as_array).map_or(0, Vec::len);
            Some((id.to_string(), n))
        })
        .collect()
}

pub fn run_turns(p: &Paths, f: &SessionFilter, t: &TurnsCliOptions, log: Log<'_>) -> Result<()> {
    let phases = phase_names()?;
    if t.action == "bundle" {
        let sel = select_sessions(p, f, "turns", "先に atlas extract(または atlas all)を実行してください。", log)?;
        let existing = if t.unjudged { read_turn_judgments(&p.turn_judgments)? } else { None };
        let judged: Option<HashMap<String, HashSet<i64>>> = existing.map(|e| {
            let mut m: HashMap<String, HashSet<i64>> = HashMap::new();
            for i in e.items {
                m.entry(i.session_id).or_default().insert(i.turn);
            }
            m
        });
        let m = build_turn_bundle(&sel.sessions(), &TurnBundleOptions { bundle_dir: p.turn_bundle.clone(), snapshot_dir: p.snapshot.clone(), phases: phases.clone(), judged, limits: None, boundary: None, now: None })?;
        log(&format!(
            "turns bundle: 依頼 {} 件{}を、M365 Copilot などに添付する {} ファイル(parts/)と、GitHub Copilot CLI で 1 回ずつ渡す {} 個の塊にしました → {}{}",
            m.count,
            if t.unjudged { "(判定済みを除く)" } else { "" },
            m.parts.len(),
            m.chunks.len(),
            p.turn_bundle.display(),
            if m.skipped.is_empty() { String::new() } else { format!("。本文が読めず外したセッション {} 件", m.skipped.len()) }
        ));
        log(&format!("turns bundle: 工程名 {}(atlas.config.json の phases で変えられます)", phases.join(" / ")));
        return Ok(());
    }
    if t.action == "run" {
        let model = resolve_judge_model(t.model.as_deref(), "turns", log)?;
        let backend = copilot_cli_backend(CopilotCliOptions { bin: None, model, allow_tools: None, timeout_ms: Some(t.timeout_sec * 1000) });
        let r = run_turn_judge(&TurnRunOptions { bundle_dir: p.turn_bundle.clone(), path: p.turn_judgments.clone(), backend: &backend, limit: t.limit, log, now: None })?;
        if !r.failed.is_empty() {
            bail!("判定できなかった塊が {} 個あります({} の failures。もう一度実行すると再試行します)", r.failed.len(), p.turn_judgments.display());
        }
        return Ok(());
    }
    let known = if p.sessions.exists() { read_sessions_value(&p.sessions)? } else { vec![] };
    let tbs = turns_by_session(&known);
    let text = atlas_judge::read_text(&resolve(t.file.as_deref().unwrap_or("")))?;
    let import_phases = turn_import_phases(&p.turn_bundle, &phases);
    let r = import_turn_judgments_text(&text, &p.turn_judgments, TurnImportOptions { phases: &import_phases, turns_by_session: Some(&tbs), now: None, backend: None, model: None })?;
    log(&format!("turns import: {} 件を取り込みました(既存の上書き {} 件)→ {}(計 {} 件)", r.imported, r.overwritten, p.turn_judgments.display(), r.total));
    if !r.unknown.is_empty() {
        log(&format!(
            "turns import: 注意 集計に無い依頼が {} 件あります(レポートには出ません): {}{}",
            r.unknown.len(),
            r.unknown.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
            if r.unknown.len() > 5 { " …" } else { "" }
        ));
    }
    Ok(())
}
