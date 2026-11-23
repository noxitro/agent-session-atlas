//! 依頼ごとの判定: atlas turns bundle(添付ファイルと、--zip なら ZIP を作る)/ import(packages/cli/src/commands.ts の runTurns の移植)。
//! 判定するのは外部の LLM(チャットに貼る・ZIP をエージェントに渡す)で、このツールは LLM を呼ばない。ログの文言は TS 版と同じ。

use super::judge::read_sessions_value;
use super::metrics::{select_sessions, SessionFilter};
use super::{mb, Log};
use crate::args::TurnsCliOptions;
use crate::config::phase_names_in;
use crate::paths::{resolve, Paths};
use anyhow::Result;
use atlas_judge::turn_bundle::{build_turn_bundle, decidable_note, turn_import_phases, turn_zip_names, TurnBundleOptions};
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

/// 束を作る(bundle)か、返答を取り込む(import)。取り込んだときは、取り込んだ数を返す(1 件以上なら、呼ぶ側がレポートを作り直す)
pub fn run_turns(p: &Paths, f: &SessionFilter, t: &TurnsCliOptions, zip: bool, log: Log<'_>) -> Result<usize> {
    let phases = phase_names_in(p.settings.as_deref())?;
    if t.action == "bundle" {
        let sel = select_sessions(p, f, "turns", "先に atlas extract(または atlas all)を実行してください。", log)?;
        super::bundle::drop_old_judge_work(&p.out, "turns bundle", log);
        // --unjudged なら、まだ何も判定していなくても「未判定だけで作った」と記録する(画面の「未判定だけ」の表示)
        let judged: Option<HashMap<String, HashSet<i64>>> = if t.unjudged {
            let mut m: HashMap<String, HashSet<i64>> = HashMap::new();
            for i in read_turn_judgments(&p.turn_judgments)?.map(|e| e.items).unwrap_or_default() {
                m.entry(i.session_id).or_default().insert(i.turn);
            }
            Some(m)
        } else {
            None
        };
        let m = build_turn_bundle(&sel.sessions(), &TurnBundleOptions { bundle_dir: p.turn_bundle.clone(), snapshot_dir: p.snapshot.clone(), phases: phases.clone(), judged, limits: None, boundary: None, now: None })?;
        log(&format!(
            "turns bundle: 依頼 {} 件{}を、M365 Copilot などに添付する {} ファイル(parts/)と、フォルダ(ZIP)ごと渡すときの {} 個の塊(chunks/)にしました → {}{}",
            m.count,
            if t.unjudged { "(判定済みを除く)" } else { "" },
            m.parts.len(),
            m.chunks.len(),
            p.turn_bundle.display(),
            if m.skipped.is_empty() { String::new() } else { format!("。本文が読めず外したセッション {} 件", m.skipped.len()) }
        ));
        if let Some(note) = decidable_note(m.count, m.decidable.as_ref()) {
            log(&format!("turns bundle: {note}"));
        }
        log(&format!("turns bundle: 工程名 {}(atlas.config.json の phases で変えられます)", phases.join(" / ")));
        if let Some((path, z)) = super::bundle::zip_or_drop(&p.turn_bundle, &p.out.join("turn-bundle"), zip, &turn_zip_names(&m), "turns bundle", atlas_judge::zip::BUNDLE_NARROW, log)? {
            log(&format!("turns bundle: ZIP にまとめました({} ファイル、{}、無圧縮。parts/ は入れていません)→ {}", z.files, mb(z.bytes), path.display()));
            log("turns bundle: フォルダやファイルを読めるエージェントに渡し、INSTRUCTIONS.md を最初に読ませてください。返ってきた JSON は atlas turns import <ファイル> で取り込みます");
        }
        return Ok(0);
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
    Ok(r.imported)
}
