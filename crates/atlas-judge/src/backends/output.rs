//! エージェント CLI の出力(JSONL)から最終的な assistant 本文を取り出し、判定 JSON を検証する(packages/judge/src/backends/output.ts の移植)。
//! copilot -p --output-format json の行の形は版によって違いうるので、
//! 既知の形を広く受け、どれにも当たらなければ出力全体を本文として扱う。

use crate::schema::{item_problems, items_from_candidates, json_candidates, validate_judgment_item, JudgmentItem};
use anyhow::{bail, Result};
use atlas_core::js;
use indexmap::IndexMap;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentOutput {
    /// assistant の本文(出現順)
    pub texts: Vec<String>,
    pub lines: usize,
    pub json_lines: usize,
    /// session.error 等のエラー本文(出現順)
    pub errors: Vec<String>,
}

pub fn parse_agent_jsonl(stdout: &str) -> AgentOutput {
    let mut out = AgentOutput::default();
    let mut deltas: IndexMap<String, String> = IndexMap::new();
    for raw in stdout.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = js::trim(raw);
        if line.is_empty() {
            continue;
        }
        out.lines += 1;
        let Ok(Value::Object(e)) = js::parse_json(line) else { continue };
        out.json_lines += 1;
        let empty = serde_json::Map::new();
        let d = e.get("data").and_then(Value::as_object).unwrap_or(&empty);
        let ty = e.get("type").and_then(Value::as_str);
        if ty == Some("assistant.message")
            && !js::truthy(d.get("parentToolCallId"))
            && let Some(c) = d.get("content").and_then(Value::as_str).filter(|c| !js::trim(c).is_empty())
        {
            // Copilot のセッションイベント形式
            out.texts.push(c.to_string());
        } else if ty == Some("assistant.message_delta")
            && let Some(dc) = d.get("deltaContent").and_then(Value::as_str)
        {
            let k = js::present(d.get("messageId")).map(js::to_js_string).unwrap_or_default();
            deltas.entry(k).or_default().push_str(dc);
        } else if ty == Some("session.error") {
            // Copilot: {type:"session.error", data:{errorType:"quota", errorCode:"quota_exceeded", statusCode:402, message:"…"}}
            let code = js::present(d.get("errorCode")).or(js::present(d.get("errorType")));
            let status = js::present(d.get("statusCode")).map(|s| format!("HTTP {}", js::to_js_string(s)));
            let parts: Vec<String> = [code.map(js::to_js_string), status, js::present(d.get("message")).map(js::to_js_string)].into_iter().flatten().filter(|x| !x.is_empty()).collect();
            out.errors.push(parts.join(" "));
        } else if ty == Some("result")
            && let Some(r) = e.get("result").and_then(Value::as_str)
        {
            // 汎用: {type:"result", result:"…"}
            out.texts.push(r.to_string());
        } else if e.get("role").and_then(Value::as_str) == Some("assistant")
            && let Some(c) = e.get("content").and_then(Value::as_str)
        {
            out.texts.push(c.to_string());
        }
    }
    if out.texts.is_empty() {
        for v in deltas.values() {
            if !js::trim(v).is_empty() {
                out.texts.push(v.clone());
            }
        }
    }
    if out.texts.is_empty() && out.json_lines == 0 && !js::trim(stdout).is_empty() {
        out.texts.push(stdout.to_string());
    }
    out
}

/// 本文の候補(後ろから)から判定項目を 1 つ取り出して検証する。
/// sessionId が無ければパケットの ID を補い、違う ID ならエラーにする。
pub fn item_from_texts(texts: &[String], session_id: &str) -> Result<JudgmentItem> {
    let mut problems: Vec<String> = Vec::new();
    for t in texts.iter().rev() {
        for raw in items_from_candidates(&json_candidates(t)) {
            let Value::Object(mut it) = raw else { continue };
            if matches!(it.get("sessionId"), None | Some(Value::Null)) || it.get("sessionId").and_then(Value::as_str) == Some("") {
                it.insert("sessionId".into(), Value::String(session_id.to_string()));
            }
            if it.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                problems.push(format!("sessionId が違います(期待 {session_id}、出力 {})", js::to_js_string(&it["sessionId"])));
                continue;
            }
            it.shift_remove("judge");
            let v = Value::Object(it);
            let p = item_problems(&v, "item");
            if !p.is_empty() {
                problems.extend(p);
                continue;
            }
            return Ok(validate_judgment_item(&v, "item")?);
        }
    }
    let Some(last) = texts.last() else { bail!("応答に assistant の本文がありません") };
    if problems.is_empty() {
        bail!("応答から JSON を取り出せません(本文の末尾: {})", js::tail(last, 300));
    }
    bail!("応答の JSON がスキーマに合いません: {}", problems.iter().take(8).cloned().collect::<Vec<_>>().join(" / "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: Option<&str>) -> Value {
        let mut v = json!({
            "taskCategory": "feature",
            "taskSummary": "要約",
            "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "根拠" },
            "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "成果" },
            "instructionsEffect": { "score": 1, "evidence": "e" },
            "wikiEffect": { "score": 0, "evidence": "参照なし" },
            "skillsAgentsEffect": { "score": 0, "evidence": "参照なし" },
        });
        if let Some(id) = id {
            v["sessionId"] = json!(id);
        }
        v
    }

    #[test]
    fn reads_copilot_jsonl_and_checks_session() {
        let lines = [
            json!({ "type": "session.start", "data": {} }),
            json!({ "type": "assistant.message", "data": { "content": "考え中", "parentToolCallId": null } }),
            json!({ "type": "assistant.message", "data": { "content": "サブエージェント", "parentToolCallId": "t1" } }),
            json!({ "type": "assistant.message", "data": { "content": format!("```json\n{}\n```", item(None)) } }),
        ];
        let out = parse_agent_jsonl(&lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n"));
        assert_eq!(out.texts.len(), 2);
        assert_eq!(item_from_texts(&out.texts, "S1").unwrap().session_id, "S1");
        assert!(item_from_texts(&[item(Some("other")).to_string()], "S1").unwrap_err().to_string().contains("sessionId が違います"));
        assert!(item_from_texts(&["```json\n{\"sessionId\":\"S1\"}\n```".into()], "S1").unwrap_err().to_string().contains("スキーマに合いません"));
        assert!(item_from_texts(&["ただの文章".into()], "S1").unwrap_err().to_string().contains("取り出せません"));
        // JSONL でない出力は全体を本文として扱う
        assert_eq!(parse_agent_jsonl(&format!("text {}", item(Some("S1")))).texts.len(), 1);
        // Copilot の session.error はエラー本文として拾う
        let err = parse_agent_jsonl(
            &[
                json!({ "type": "session.error", "data": { "errorType": "quota", "errorCode": "quota_exceeded", "statusCode": 402, "message": "You have exceeded your monthly quota" } }).to_string(),
                json!({ "type": "result", "sessionId": "x", "exitCode": 1, "usage": { "premiumRequests": 0 } }).to_string(),
            ]
            .join("\n"),
        );
        assert_eq!(err.errors, vec!["quota_exceeded HTTP 402 You have exceeded your monthly quota".to_string()]);
        assert!(err.texts.is_empty());
    }

    #[test]
    fn json_candidates_forms() {
        let md = format!("結果です。\n\n```json\n{}\n```\n\n続き\n\n```json\n{}\n```\n", item(Some("a")), json!({ "items": [item(Some("b"))] }));
        assert_eq!(json_candidates(&md).len(), 2);
        assert_eq!(json_candidates(&json!([item(Some("a"))]).to_string()).len(), 1);
        assert_eq!(json_candidates(&format!("はい: {} 以上", item(Some("a")))).len(), 1);
        assert_eq!(json_candidates("JSON はありません").len(), 0);
        // 囲みは同じ長さ以上の同じ文字で閉じる。言語名の無い囲みは { か [ で始まるものだけ
        assert_eq!(json_candidates("````\n{\"a\":1}\n```\n````").len(), 1);
        assert_eq!(json_candidates("~~~JSON\r\n[1]\r\n~~~"), vec![json!([1])]);
        assert_eq!(json_candidates("```\nnot json\n```\n```js\n{\"x\":2}\n```"), vec![json!({"x": 2})]);
    }
}
