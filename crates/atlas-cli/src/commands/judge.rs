//! atlas judge import(外部の LLM で作った工数の判定を取り込む。packages/cli/src/commands.ts の runJudgeCommand の移植)。ログの文言は TS 版と同じ。
//! 判定はこのツールの中では回さない(チャットに貼るか ZIP にまとめて、外部の LLM に頼む。docs/judge.md)。

use super::Log;
use crate::args::JudgeCliOptions;
use crate::paths::{resolve, Paths};
use anyhow::{bail, Result};
use atlas_judge::judgments_io::{import_judgments, ImportOptions};
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

pub fn run_judge_import(p: &Paths, j: &JudgeCliOptions, log: Log<'_>) -> Result<()> {
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
    for n in &r.notes {
        log(&format!("judge import: 注意 {n}"));
    }
    Ok(())
}
