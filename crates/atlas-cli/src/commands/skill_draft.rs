//! atlas skill-draft: out/insights.json の候補(番号)から SKILL.md の下書きを copilot -p で作る
//! (クレジットを消費。明示したときだけ。packages/cli/src/commands.ts の runSkillDraft の移植)。

use super::Log;
use crate::args::SkillDraftOptions;
use crate::config::resolve_judge_model;
use crate::paths::Paths;
use anyhow::{anyhow, bail, Result};
use atlas_core::js;
use atlas_judge::backends::ensure_backend_built;
use atlas_judge::skill_draft::{draft_skill, DraftCandidate, SkillDraftOptions as DraftOptions};
use regex::Regex;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::LazyLock;

#[derive(Deserialize)]
struct Insights {
    #[serde(default)]
    candidates: Vec<DraftCandidate>,
}

static SLUG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9\x{3040}-\x{30ff}\x{3400}-\x{9fff}_-]+").unwrap());

/// 下書きのファイル名に使う短い名前
fn slug(c: &DraftCandidate) -> String {
    let base = match &c.tools {
        Some(t) => t.join("-"),
        None => c.representative.clone().unwrap_or_else(|| c.key.clone()),
    };
    let s = SLUG_RE.replace_all(&base, "-");
    let s = s.trim_matches('-');
    let s = js::head(s, 40).into_owned();
    if s.is_empty() { "draft".into() } else { s }
}

/// LLM に渡せる中身(ツールの並び・代表の依頼文・ほかの例)が候補にあるか。無ければプロンプトは回数だけになる
fn has_material(c: &DraftCandidate) -> bool {
    c.tools.as_ref().is_some_and(|t| !t.is_empty()) || c.representative.as_deref().is_some_and(|r| !r.is_empty()) || !c.examples.is_empty()
}

pub fn run_skill_draft(p: &Paths, o: &SkillDraftOptions, log: Log<'_>) -> Result<PathBuf> {
    // このビルドに入っていないバックエンド(機能 anthropic-backend なしの anthropic)なら、入力を読む前に入れ方を書いて止める
    ensure_backend_built(&o.backend)?;
    let path = p.out.join("insights.json");
    if !path.exists() {
        bail!("{} がありません。先に atlas build(または export)を実行してください。", path.display());
    }
    let text = atlas_judge::read_text(&path)?;
    let j: Insights = js::parse_json_as(&text).map_err(|e| anyhow!("{} を読めません: {e}", path.display()))?;
    let Some(c) = j.candidates.get((o.index as usize).wrapping_sub(1)) else {
        bail!("候補 {} はありません(候補は {} 件)", o.index, j.candidates.len());
    };
    // 回数しか渡せない候補は、LLM を呼ぶ前に止める(クレジットや従量課金を使わない)
    if !has_material(c) {
        bail!("候補 {} には依頼文もツールの並びも無いので下書きを作れません。atlas build(または export)で {} を作り直してください。", o.index, path.display());
    }
    let label = if c.kind == "tools" { c.key.clone() } else { js::head(c.representative.as_deref().unwrap_or(&c.key), 60).into_owned() };
    log(&format!(
        "skill-draft: 候補 {}({label})を {} で下書きします{}",
        o.index,
        o.backend,
        if o.backend == "anthropic" { "(Anthropic API の従量課金です)" } else { "(クレジットを消費する場合があります)" }
    ));
    let model = if o.backend == "copilot-cli" { resolve_judge_model(o.model.as_deref(), p.settings.as_deref(), "skill-draft", log)? } else { o.model.clone() };
    let r = draft_skill(c, o.index, &DraftOptions { backend: Some(o.backend.clone()), model, timeout_ms: Some(o.timeout_sec * 1000), ..Default::default() })?;
    let dir = p.out.join("skill-drafts");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{:03}-{}.md", o.index, slug(c)));
    let head = format!("<!-- atlas skill-draft: 候補 {}({}、{} 回、{} セッション)。LLM の下書きなので内容を確かめてから skills/ に置くこと -->\n", o.index, c.kind, c.count, c.sessions.len());
    std::fs::write(&file, format!("{head}{}{}", r.markdown, if r.markdown.ends_with('\n') { "" } else { "\n" }))?;
    log(&format!(
        "skill-draft: {}({} バイト){}",
        file.display(),
        r.markdown.len(),
        if r.notes.is_empty() { String::new() } else { format!("、補足 {}", r.notes.join(" / ")) }
    ));
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 依頼文もツールの並びも無い候補は、下書きの材料が無い。ツールの並びだけの候補(代表の依頼文なし)は材料がある
    #[test]
    fn material_needs_text_or_tools() {
        let parse = |candidate: &str| -> DraftCandidate {
            let text = format!(r#"{{"version":1,"sessions":2,"candidates":[{candidate}]}}"#);
            let j: Insights = js::parse_json_as(&text).unwrap();
            j.candidates.into_iter().next().unwrap()
        };
        let request = |rep: &str, examples: &str| parse(&format!(r#"{{"kind":"request","key":"k","count":3,"sessions":["a","b"],"medianMs":null,"score":1,"representative":{rep},"examples":{examples},"tools":null}}"#));
        assert!(has_material(&request(r#""r""#, "[]")));
        assert!(has_material(&request("null", r#"["e"]"#)));
        assert!(!has_material(&request("null", "[]")));
        assert!(!has_material(&request(r#""""#, "[]")));
        let tools = parse(r#"{"kind":"tools","key":"view → apply_patch","count":3,"sessions":["a","b"],"medianMs":null,"score":1,"representative":null,"examples":[],"tools":["view","apply_patch"]}"#);
        assert!(has_material(&tools));
    }
}
