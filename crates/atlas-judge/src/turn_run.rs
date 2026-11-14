//! 段階 2: 依頼ごとの判定を GitHub Copilot CLI(copilot -p)で回す(packages/judge/src/turn-run.ts の移植)。塊(数件の依頼)ごとに 1 回呼び、
//! 返った JSON を検証して turn-judgments.json に 1 塊ずつ確定させる。失敗した塊は failures に残して次へ進む。

use crate::backends::JudgeBackend;
use crate::schema::{items_from_candidates, json_candidates};
use crate::turn_bundle::{build_turn_prompt, TurnBundleManifest, TurnChunk, TURN_BUNDLE_VERSION};
use crate::turn_schema::{empty_turn_judgments, merge_turn_judgments, read_turn_judgments, turn_item_problems, write_turn_judgments, TurnJudge, TurnJudgment};
use anyhow::{anyhow, bail, Result};
use atlas_core::js;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub struct TurnRunOptions<'a> {
    pub bundle_dir: PathBuf,
    pub path: PathBuf,
    pub backend: &'a dyn JudgeBackend,
    /// 判定する依頼の数の上限(塊の途中では切らないので、少し超えることがある)
    pub limit: Option<u64>,
    pub log: &'a (dyn Fn(&str) + Sync),
    pub now: Option<&'a (dyn Fn() -> String + Sync)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnRunFailure {
    pub session_id: String,
    pub turns: Vec<i64>,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TurnRunSummary {
    pub chunks: usize,
    pub attempted: usize,
    pub succeeded: usize,
    pub turns: usize,
    pub failed: Vec<TurnRunFailure>,
}

pub fn read_turn_bundle_manifest(bundle_dir: &Path) -> Result<TurnBundleManifest> {
    let p = bundle_dir.join("manifest.json");
    let v = std::fs::read(&p)
        .map_err(|e| anyhow!("{e}"))
        .and_then(|b| js::parse_json(&String::from_utf8_lossy(&b)).map_err(|e| anyhow!("{e}")))
        .map_err(|e| anyhow!("{} を読めません。先に atlas turns bundle を実行してください({e})", p.display()))?;
    let version = v.get("version");
    if version.and_then(Value::as_f64) != Some(TURN_BUNDLE_VERSION as f64) || !v.get("chunks").is_some_and(Value::is_array) {
        bail!("{} の形式が想定と違います(version {})", p.display(), version.map_or_else(|| "undefined".into(), js::to_js_string));
    }
    serde_json::from_value(v).map_err(|e| anyhow!("{} の形式が想定と違います({e})", p.display()))
}

/// 返答を取り込むときに認める工程名。添付を作った時点の工程名(manifest.json)を先に、今の設定の工程名を後ろに足す
/// (添付を作った後に atlas.config.json の phases を変えても、その添付への返答を取り込めるように)
pub fn turn_import_phases(bundle_dir: &Path, configured: &[String]) -> Vec<String> {
    let p = bundle_dir.join("manifest.json");
    // 添付がまだ無い・読めないときは設定の工程名だけ
    let from_bundle: Vec<String> = std::fs::read(&p)
        .ok()
        .and_then(|b| js::parse_json(&String::from_utf8_lossy(&b)).ok())
        .filter(|v| v.get("version").and_then(Value::as_f64) == Some(TURN_BUNDLE_VERSION as f64) && v.get("chunks").is_some_and(Value::is_array))
        .and_then(|v| v.get("phases").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).collect()))
        .unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for x in from_bundle.into_iter().chain(configured.iter().cloned()) {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

/// 返った本文から、塊の依頼の判定を取り出して検証する(全部そろっていなければエラー)
pub fn turn_items_from_texts(texts: &[String], session_id: &str, turns: &[i64], phases: &[String]) -> Result<Vec<TurnJudgment>> {
    let mut problems: Vec<String> = Vec::new();
    for t in texts.iter().rev() {
        let raw = items_from_candidates(&json_candidates(t));
        if raw.is_empty() {
            continue;
        }
        let items: Vec<Value> = raw
            .into_iter()
            .map(|it| match it {
                Value::Object(o) => {
                    let mut m = Map::new();
                    m.insert("sessionId".into(), json!(session_id));
                    for (k, v) in o {
                        m.insert(k, v);
                    }
                    Value::Object(m)
                }
                // 配列も `{ sessionId, ...it }` で添字のキーのオブジェクトになる
                Value::Array(a) => {
                    let mut m = Map::new();
                    m.insert("sessionId".into(), json!(session_id));
                    for (i, v) in a.into_iter().enumerate() {
                        m.insert(i.to_string(), v);
                    }
                    Value::Object(m)
                }
                other => other,
            })
            .collect();
        let mut p: Vec<String> = items.iter().enumerate().flat_map(|(k, it)| turn_item_problems(it, &format!("{} 件目", k + 1), Some(phases))).collect();
        let got: Vec<f64> = items.iter().filter_map(|it| it.get("turn").and_then(Value::as_f64)).collect();
        let missing: Vec<String> = turns.iter().filter(|t| !got.contains(&(**t as f64))).map(|t| t.to_string()).collect();
        let wrong = items.iter().filter(|it| it.get("sessionId").and_then(Value::as_str) != Some(session_id)).count();
        if !missing.is_empty() {
            p.push(format!("依頼 {} の判定がありません", missing.join(", ")));
        }
        if wrong > 0 {
            p.push(format!("sessionId が違う項目が {wrong} 件あります"));
        }
        if !p.is_empty() {
            problems.extend(p);
            continue;
        }
        return Ok(items
            .iter()
            .filter(|it| it.get("turn").and_then(Value::as_f64).is_some_and(|t| turns.iter().any(|x| *x as f64 == t)))
            .map(|it| {
                let x = it.as_object().expect("検証済み");
                TurnJudgment {
                    session_id: session_id.to_string(),
                    turn: x["turn"].as_f64().unwrap_or(0.0) as i64,
                    kind: x["kind"].as_str().unwrap_or("").to_string(),
                    outcome: x["outcome"].as_str().unwrap_or("").to_string(),
                    mismatch: x.get("mismatch").and_then(Value::as_str).map(str::to_string),
                    phase: x["phase"].as_str().unwrap_or("").to_string(),
                    confidence: x["confidence"].as_f64().unwrap_or(0.0),
                    note: x.get("note").and_then(Value::as_str).map(|n| js::trim(n).to_string()).unwrap_or_default(),
                    judge: None,
                }
            })
            .collect());
    }
    let Some(last) = texts.last() else { bail!("応答に assistant の本文がありません") };
    if problems.is_empty() {
        bail!("応答から JSON を取り出せません(本文の末尾: {})", js::tail(last, 300));
    }
    bail!("応答の JSON が形式に合いません: {}", problems.iter().take(8).cloned().collect::<Vec<_>>().join(" / "))
}

fn same_turns(f: &Value, turns: &[i64]) -> bool {
    // `f.turns.join() === c.turns.join()`
    let a = f.get("turns").and_then(Value::as_array).map(|a| a.iter().map(|x| if x.is_null() { String::new() } else { js::to_js_string(x) }).collect::<Vec<_>>().join(","));
    a.as_deref() == Some(turns.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(",").as_str())
}

pub fn run_turn_judge(o: &TurnRunOptions<'_>) -> Result<TurnRunSummary> {
    let log = o.log;
    let now = || o.now.map_or_else(atlas_core::jsdate::now_iso, |f| f());
    let backend = o.backend;
    if !backend.can_ask() {
        bail!("{} では依頼ごとの判定を回せません(GitHub Copilot CLI か、チャットに貼る方法を使ってください)", backend.name());
    }
    let m = read_turn_bundle_manifest(&o.bundle_dir)?;
    let mut file = match read_turn_judgments(&o.path)? {
        Some(f) => f,
        None => empty_turn_judgments(&m.phases, backend.name(), backend.model(), &now()),
    };
    let done: HashSet<String> = file.items.iter().map(|i| format!("{}#{}", i.session_id, i.turn)).collect();
    let todo: Vec<(usize, &crate::turn_bundle::ChunkEntry)> = m.chunks.iter().enumerate().map(|(i, c)| (i + 1, c)).filter(|(_, c)| c.turns.iter().any(|t| !done.contains(&format!("{}#{t}", c.session_id)))).collect();
    let mut targets = Vec::new();
    let mut planned = 0usize;
    for c in &todo {
        if o.limit.is_some_and(|l| planned as u64 >= l) {
            break;
        }
        targets.push(*c);
        planned += c.1.turns.len();
    }
    log(&format!(
        "turns: バックエンド {}{}、対象 {planned} 依頼・{} 回(未判定 {} 依頼)",
        backend.name(),
        backend.model().map(|m| format!("({m})")).unwrap_or_default(),
        targets.len(),
        todo.iter().map(|c| c.1.turns.len()).sum::<usize>()
    ));
    let mut summary = TurnRunSummary { chunks: m.chunks.len(), attempted: targets.len(), ..Default::default() };
    for (no, c) in targets {
        let md = crate::util::read_text(&o.bundle_dir.join("chunks").join(format!("{no:04}.md")))?;
        let label = format!("{}-{}", c.session_id, c.turns[0]);
        let first = c.turns[0];
        let last = c.turns[c.turns.len() - 1];
        let r = (|| -> Result<Vec<TurnJudgment>> {
            let r = backend.ask(&build_turn_prompt(&TurnChunk { session_id: c.session_id.clone(), turns: c.turns.clone(), markdown: md.clone() }, &m.phases, None), &label)?;
            // 塊の中で判定済みの依頼は判定し直さない(画面の「判定済みは判定し直しません」と揃える)
            Ok(turn_items_from_texts(&r.texts, &c.session_id, &c.turns, &m.phases)?.into_iter().filter(|i| !done.contains(&format!("{}#{}", i.session_id, i.turn))).collect())
        })();
        match r {
            Ok(items) => {
                let judge = TurnJudge { backend: backend.name().into(), model: backend.model().map(str::to_string), ran_at: now() };
                let n = items.len();
                let items: Vec<TurnJudgment> = items.into_iter().map(|i| TurnJudgment { judge: Some(judge.clone()), ..i }).collect();
                file = merge_turn_judgments(&file, &items, &m.phases, judge);
                write_turn_judgments(&o.path, &file)?;
                summary.succeeded += 1;
                summary.turns += n;
                log(&format!("turns: {} の依頼 {first}〜{last} を判定しました", c.session_id));
            }
            Err(e) => {
                let error = e.to_string();
                summary.failed.push(TurnRunFailure { session_id: c.session_id.clone(), turns: c.turns.clone(), error: error.clone() });
                file.failures.retain(|f| !(f.get("sessionId").and_then(Value::as_str) == Some(c.session_id.as_str()) && same_turns(f, &c.turns)));
                file.failures.push(json!({ "sessionId": c.session_id, "turns": c.turns, "error": error, "at": now() }));
                write_turn_judgments(&o.path, &file)?;
                log(&format!("turns: {} の依頼 {first}〜{last} を判定できませんでした: {error}", c.session_id));
            }
        }
    }
    log(&format!("turns: {} 依頼を判定(成功 {} 回、失敗 {} 回)→ {}", summary.turns, summary.succeeded, summary.failed.len(), o.path.display()));
    Ok(summary)
}
