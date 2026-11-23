//! エージェント CLI の出力(JSONL)から最終的な assistant 本文を取り出す(skill-draft が使う。packages/judge/src/backends/output.ts の移植)。
//! copilot -p --output-format json の行の形は版によって違いうるので、
//! 既知の形を広く受け、どれにも当たらなければ出力全体を本文として扱う。

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::json_candidates;
    use serde_json::json;

    #[test]
    fn reads_copilot_jsonl() {
        let lines = [
            json!({ "type": "session.start", "data": {} }),
            json!({ "type": "assistant.message", "data": { "content": "考え中", "parentToolCallId": null } }),
            json!({ "type": "assistant.message", "data": { "content": "サブエージェント", "parentToolCallId": "t1" } }),
            json!({ "type": "assistant.message", "data": { "content": "---\nname: x\n---" } }),
        ];
        let out = parse_agent_jsonl(&lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n"));
        assert_eq!(out.texts, ["考え中", "---\nname: x\n---"]);
        // JSONL でない出力は全体を本文として扱う
        assert_eq!(parse_agent_jsonl("ただの文 {\"a\": 1}").texts.len(), 1);
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
        let item = |id: &str| json!({ "sessionId": id });
        let md = format!("結果です。\n\n```json\n{}\n```\n\n続き\n\n```json\n{}\n```\n", item("a"), json!({ "items": [item("b")] }));
        assert_eq!(json_candidates(&md).len(), 2);
        assert_eq!(json_candidates(&json!([item("a")]).to_string()).len(), 1);
        assert_eq!(json_candidates(&format!("はい: {} 以上", item("a"))).len(), 1);
        assert_eq!(json_candidates("JSON はありません").len(), 0);
        // 囲みは同じ長さ以上の同じ文字で閉じる。言語名の無い囲みは { か [ で始まるものだけ
        assert_eq!(json_candidates("````\n{\"a\":1}\n```\n````").len(), 1);
        assert_eq!(json_candidates("~~~JSON\r\n[1]\r\n~~~"), vec![json!([1])]);
        assert_eq!(json_candidates("```\nnot json\n```\n```js\n{\"x\":2}\n```"), vec![json!({"x": 2})]);
    }
}
