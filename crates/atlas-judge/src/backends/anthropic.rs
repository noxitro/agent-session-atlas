//! Anthropic Messages API を直接呼ぶ判定バックエンド(従量課金。明示指定したときだけ使う。packages/judge/src/backends/anthropic.ts の移植)。
//! 依存を増やさないため SDK を使わず raw HTTP(ureq)で実装している。テストでは HTTP の呼び出しを差し替える。

use super::output::item_from_texts;
use super::{JudgeBackend, JudgePacket, JudgeResult};
use crate::rubric::build_judge_prompt;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-5-5";
pub const ANTHROPIC_API_VERSION: &str = "2026-10-21";

/// HTTP の応答(状態コードと本文)
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// POST を 1 回送る(url, ヘッダー, 本文, 制限時間)。テスト用に差し替える
pub type HttpPost = Arc<dyn Fn(&str, &[(&str, String)], &str, Duration) -> Result<HttpResponse> + Send + Sync>;

#[derive(Clone, Default)]
pub struct AnthropicOptions {
    pub model: Option<String>,
    pub api_key: Option<String>,
    /// テスト用に差し替え可能
    pub post: Option<HttpPost>,
    pub base_url: Option<String>,
    pub timeout_ms: Option<u64>,
}

pub struct AnthropicText {
    pub texts: Vec<String>,
    pub usage: Option<Value>,
    pub notes: Vec<String>,
}

fn resolve_key(o: &AnthropicOptions) -> Result<String> {
    let api_key = match &o.api_key {
        Some(k) => k.clone(),
        None => std::env::var("ANTHROPIC_API_KEY").unwrap_or_default(),
    };
    if api_key.is_empty() {
        bail!("anthropic バックエンドには環境変数 ANTHROPIC_API_KEY が必要です(従量課金です)");
    }
    Ok(api_key)
}

/// ureq で送る(HTTP の失敗の状態コードもエラーにせず本文を返す)
fn ureq_post(url: &str, headers: &[(&str, String)], body: &str, timeout: Duration) -> Result<HttpResponse> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).build().into();
    let mut req = agent.post(url);
    for (k, v) in headers {
        req = req.header(*k, v.as_str());
    }
    let mut res = req.send(body).map_err(|e| anyhow!("{e}"))?;
    let status = res.status().as_u16();
    let body = res.body_mut().read_to_string().map_err(|e| anyhow!("{e}"))?;
    Ok(HttpResponse { status, body })
}

/// Messages API を 1 回呼んで本文を返す(判定と skill-draft で共通)
pub fn anthropic_message(prompt: &str, o: &AnthropicOptions) -> Result<AnthropicText> {
    let api_key = resolve_key(o)?;
    let model = o.model.clone().unwrap_or_else(|| ANTHROPIC_DEFAULT_MODEL.into());
    let base = o.base_url.clone().or_else(|| std::env::var("ANTHROPIC_BASE_URL").ok()).unwrap_or_else(|| "https://api.anthropic.com".into());
    let url = format!("{base}/v1/messages");
    let body = atlas_core::json::to_js_string(&json!({ "model": model, "max_tokens": 16000, "messages": [{ "role": "user", "content": prompt }] }))?;
    let headers = [("content-type", "application/json".to_string()), ("x-api-key", api_key), ("anthropic-version", ANTHROPIC_API_VERSION.to_string())];
    let timeout = Duration::from_millis(o.timeout_ms.unwrap_or(600_000));
    let res = match &o.post {
        Some(p) => p(&url, &headers, &body, timeout)?,
        None => ureq_post(&url, &headers, &body, timeout)?,
    };
    let text = res.body;
    let head = || atlas_core::js::head(&text, 300).into_owned();
    let Ok(body) = atlas_core::js::parse_json(&text) else {
        bail!("Anthropic API の応答が JSON ではありません(HTTP {}): {}", res.status, head());
    };
    if !(200..300).contains(&res.status) {
        let msg = body.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(head);
        bail!("Anthropic API がエラーを返しました(HTTP {}): {msg}", res.status);
    }
    let stop = body.get("stop_reason").and_then(Value::as_str);
    if stop == Some("refusal") {
        let cat = body.get("stop_details").and_then(|d| d.get("category")).and_then(Value::as_str).unwrap_or("理由不明");
        bail!("Anthropic API が判定を拒否しました({cat})");
    }
    let texts = body
        .get("content")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text")).filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_string)).collect())
        .unwrap_or_default();
    let usage = body.get("usage").filter(|u| !u.is_null()).cloned();
    Ok(AnthropicText { texts, usage, notes: if stop == Some("max_tokens") { vec!["応答が max_tokens で打ち切られました".into()] } else { vec![] } })
}

pub struct AnthropicBackend {
    o: AnthropicOptions,
    model: String,
}

pub fn anthropic_backend(o: AnthropicOptions) -> Result<AnthropicBackend> {
    resolve_key(&o)?;
    let model = o.model.clone().unwrap_or_else(|| ANTHROPIC_DEFAULT_MODEL.into());
    Ok(AnthropicBackend { o, model })
}

impl JudgeBackend for AnthropicBackend {
    fn name(&self) -> &str {
        "anthropic"
    }
    fn model(&self) -> Option<&str> {
        Some(&self.model)
    }
    fn judge(&self, packet: &JudgePacket<'_>) -> Result<JudgeResult> {
        let r = anthropic_message(&build_judge_prompt(packet.markdown, packet.session_id, None), &self.o)?;
        let texts = if r.texts.is_empty() { vec![] } else { vec![r.texts.join("\n")] };
        Ok(JudgeResult { item: item_from_texts(&texts, packet.session_id)?, usage: r.usage, notes: r.notes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    pub fn item(id: &str) -> Value {
        json!({
            "sessionId": id,
            "taskCategory": "feature",
            "taskSummary": "要約",
            "humanEffort": { "hours": 2, "low": 1, "high": 4, "confidence": 0.5, "rationale": "根拠" },
            "aiOutcome": { "completed": true, "quality": 4, "rework": 1, "rationale": "成果" },
            "instructionsEffect": { "score": 1, "evidence": "e" },
            "wikiEffect": { "score": 0, "evidence": "参照なし" },
            "skillsAgentsEffect": { "score": 0, "evidence": "参照なし" },
        })
    }

    #[test]
    fn needs_key_and_reads_text_and_usage() {
        assert!(anthropic_backend(AnthropicOptions { api_key: Some(String::new()), ..Default::default() }).err().unwrap().to_string().contains("ANTHROPIC_API_KEY"));
        let sent: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));
        let s2 = sent.clone();
        let post: HttpPost = Arc::new(move |url, _h, body, _t| {
            *s2.lock().unwrap() = Some((url.to_string(), body.to_string()));
            Ok(HttpResponse { status: 200, body: json!({ "content": [{ "type": "text", "text": format!("```json\n{}\n```", item("s")) }], "stop_reason": "end_turn", "usage": { "input_tokens": 10, "output_tokens": 3 } }).to_string() })
        });
        let b = anthropic_backend(AnthropicOptions { api_key: Some("test-key".into()), post: Some(post), base_url: Some("http://127.0.0.1:9".into()), ..Default::default() }).unwrap();
        let r = b.judge(&JudgePacket { session_id: "s", markdown: "# p" }).unwrap();
        assert_eq!(r.item.session_id, "s");
        assert_eq!(r.usage, Some(json!({ "input_tokens": 10, "output_tokens": 3 })));
        assert_eq!(b.model(), Some("claude-sonnet-5-5"));
        let (url, body) = sent.lock().unwrap().clone().unwrap();
        assert_eq!(url, "http://127.0.0.1:9/v1/messages");
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["model"], "claude-sonnet-5-5");
        assert!(body.get("temperature").is_none());
        let refuse: HttpPost = Arc::new(|_, _, _, _| Ok(HttpResponse { status: 200, body: json!({ "content": [], "stop_reason": "refusal", "stop_details": { "category": "cyber" } }).to_string() }));
        let rb = anthropic_backend(AnthropicOptions { api_key: Some("k".into()), post: Some(refuse), base_url: Some("http://127.0.0.1:9".into()), ..Default::default() }).unwrap();
        assert!(rb.judge(&JudgePacket { session_id: "s", markdown: "" }).err().unwrap().to_string().contains("拒否"));
    }
}
