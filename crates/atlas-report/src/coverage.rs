//! Phase 11: 網羅の検査(packages/report/src/coverage.ts の移植)。元データ(events.jsonl)の event type × data のキーごとに
//! 「全文に出した / 参照にした / 理由付きで除外」を決める表と、件数・バイト数の集計(out/coverage.json)。表に無いキーは「未分類」として数える。
//! data.db の列は core の desktop.rs の許可リストで同じ扱いにする(許可 = full、許可外 = unclassified、開かない表 = excluded)。

use crate::raw_events::RawEvent;
use atlas_core::desktop::DesktopCoverage;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use std::io::Write;

/// partial: 全文に出すが、その中の不透明な値(base64 らしい文字列)だけ除外する(reasoningBlocks)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Treatment {
    Full,
    Ref,
    Excluded,
    Partial,
    Unclassified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub treatment: Treatment,
    /// 除外・参照の理由(full は省略可)
    pub reason: Option<&'static str>,
}

const FULL: Rule = Rule { treatment: Treatment::Full, reason: None };
const fn rf(reason: &'static str) -> Rule {
    Rule { treatment: Treatment::Ref, reason: Some(reason) }
}
const fn ex(reason: &'static str) -> Rule {
    Rule { treatment: Treatment::Excluded, reason: Some(reason) }
}
const ENC: Rule = ex("暗号化・不透明データ(復号できない。種別とサイズだけ書く)");
const IDS: Rule = rf("対応付けの id(本文の行に短く出す)");

/// 全イベントに共通のトップレベルのキー(`^` 付き)
fn common_top(key: &str) -> Option<Rule> {
    Some(match key {
        "^id" => rf("イベント id(行の参照に使う)"),
        "^parentId" => rf("親イベント id"),
        "^timestamp" | "^agentId" => FULL,
        _ => return None,
    })
}

/// event type → data のキー → 扱い。`*` はその type の未知のキーの既定(無ければ未分類)。表に無い type のキーは未分類
fn type_rules(t: &str) -> Option<&'static [(&'static str, Rule)]> {
    const ALL: &[(&str, Rule)] = &[("*", FULL)];
    Some(match t {
        "user.message" => { const T: &[(&str, Rule)] = &[
            ("content", FULL),
            ("transformedContent", rf("content に添付等を展開した版。content と同じなら省き、違えば全文")),
            ("attachments", FULL),
            ("agentMode", FULL),
            ("source", FULL),
            ("delivery", FULL),
            ("isAutopilotContinuation", FULL),
            ("parentAgentTaskId", IDS),
            ("interactionId", IDS),
            ("messageId", IDS),
            ("turnId", IDS),
            ("responsesReasoning", FULL),
            ("supportedNativeDocumentMimeTypes", rf("対応 MIME の一覧(種類の数だけ書く)")),
        ]; T },
        "assistant.message" => { const T: &[(&str, Rule)] = &[
            ("content", FULL),
            ("reasoningText", FULL),
            ("reasoningBlocks", Rule { treatment: Treatment::Partial, reason: Some("要素の中の base64 らしい値(不透明データ)だけ除外し、読める値は出す") }),
            ("toolRequests", FULL),
            ("encryptedContent", ENC),
            ("reasoningOpaque", ENC),
            ("model", FULL),
            ("outputTokens", FULL),
            ("phase", FULL),
            ("serverTools", FULL),
            ("providerId", FULL),
            ("rte", FULL),
            ("chunkCount", FULL),
            ("chunkIndex", FULL),
            ("messageId", IDS),
            ("interactionId", IDS),
            ("requestId", IDS),
            ("apiCallId", IDS),
            ("serviceRequestId", IDS),
            ("clientRequestId", IDS),
            ("originatingMessageId", IDS),
            ("parentToolCallId", IDS),
            ("turnId", IDS),
        ]; T },
        "assistant.turn_start" => { const T: &[(&str, Rule)] = &[("interactionId", IDS), ("turnId", IDS), ("model", FULL), ("parentToolCallId", IDS)]; T },
        "assistant.turn_end" => { const T: &[(&str, Rule)] = &[("turnId", IDS), ("model", FULL), ("parentToolCallId", IDS)]; T },
        "tool.execution_start" => { const T: &[(&str, Rule)] = &[
            ("toolName", FULL),
            ("arguments", FULL),
            ("toolCallId", IDS),
            ("parentToolCallId", IDS),
            ("turnId", IDS),
            ("model", FULL),
            ("toolTitle", FULL),
            ("shellToolInfo", FULL),
            ("rte", FULL),
            ("mcpServerName", FULL),
            ("mcpToolName", FULL),
            ("mcpConfigServerName", FULL),
            ("mcpConfigSource", FULL),
            ("mcpTransport", FULL),
        ]; T },
        "tool.execution_complete" => { const T: &[(&str, Rule)] = &[
            ("result", FULL),
            ("success", FULL),
            ("error", FULL),
            ("toolTelemetry", FULL),
            ("fileEdits", FULL),
            ("shellExecution", FULL),
            ("sandboxed", FULL),
            ("model", FULL),
            ("rte", FULL),
            ("toolCallId", IDS),
            ("parentToolCallId", IDS),
            ("interactionId", IDS),
            ("turnId", IDS),
        ]; T },
        "hook.start" => { const T: &[(&str, Rule)] = &[("hookType", FULL), ("input", FULL), ("hookInvocationId", IDS), ("parentToolCallId", IDS)]; T },
        "hook.end" => { const T: &[(&str, Rule)] = &[("hookType", FULL), ("success", FULL), ("output", FULL), ("hookInvocationId", IDS), ("parentToolCallId", IDS)]; T },
        "system.message" => { const T: &[(&str, Rule)] = &[("role", FULL), ("content", FULL), ("contentBlocks", FULL), ("metadata", FULL), ("interactionId", IDS)]; T },
        "system.notification" => { const T: &[(&str, Rule)] = &[("kind", FULL), ("content", FULL), ("message", FULL), ("responsesReasoning", FULL)]; T },
        "session.usage_record" => { const T: &[(&str, Rule)] = &[("usage", FULL)]; T },
        "session.compaction_complete" => { const T: &[(&str, Rule)] = &[("summaryContent", FULL), ("checkpointPath", rf("チェックポイントのパス(番号で節を参照)")), ("*", FULL)]; T },
        "session.binary_asset" => { const T: &[(&str, Rule)] = &[
            ("data", ex("base64 の本体(out/full/assets/ にファイルとして書き出し、リンクにする)")),
            ("assetId", FULL),
            ("type", FULL),
            ("mimeType", FULL),
            ("byteLength", FULL),
            ("description", FULL),
        ]; T },
        "skill.invoked" => { const T: &[(&str, Rule)] = &[("content", FULL), ("*", FULL)]; T },
        "session.start" | "session.resume" | "session.info" | "session.shutdown" | "session.usage_checkpoint" | "session.compaction_start" | "session.error" | "session.task_complete" | "session.mode_changed"
        | "session.mode_notice_delivered" | "session.model_change" | "session.permissions_changed" | "session.plan_changed" | "session.workspace_file_changed" | "session.context_changed" | "session.auto_mode_resolved"
        | "session.canvas.recorded" | "session.canvas.removed" | "abort" | "permission.requested" | "permission.completed" | "external_tool.requested" | "external_tool.completed" | "subagent.started"
        | "subagent.completed" | "subagent.failed" | "subagent.selected" | "subagent.configured" | "skill.invoked_ref" | "skill.context_delivered_ref" | "model.captured_assignment_context" | "model.message"
        | "model.messages_snapshot" | "model.model_call_started" | "model.model_call_success" | "model.response" | "model.turn_ended" | "model.turn_started" => ALL,
        _ => return None,
    })
}

/// キーの扱い。無ければ None(未分類)
pub fn rule_for(t: &str, key: &str) -> Option<Rule> {
    if key.starts_with('^') {
        return common_top(key);
    }
    let rules = type_rules(t)?;
    rules.iter().find(|(k, _)| *k == key).or_else(|| rules.iter().find(|(k, _)| *k == "*")).map(|x| x.1)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageEntry {
    #[serde(rename = "type")]
    pub kind: String,
    pub key: String,
    pub n: i64,
    pub bytes: i64,
    pub treatment: Treatment,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// partial で実際に除外した箇所の数とバイト数(全文記録が数える)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_n: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_bytes: Option<i64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct TypeCount {
    pub n: i64,
    pub bytes: i64,
}

/// UTF-8 のバイト列を、JS の文字列の長さ(UTF-16 の単位)で数える書き出し先
struct Utf16Counter(i64);
impl Write for Utf16Counter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        for &b in buf {
            if b & 0xC0 != 0x80 {
                self.0 += 1;
            }
            if b >= 0xF0 {
                self.0 += 1;
            }
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// `JSON.stringify(v).length`
pub fn json_len(v: &Value) -> i64 {
    let mut c = Utf16Counter(0);
    let _ = atlas_core::json::write_js(&mut c, v);
    c.0
}

/// `JSON.stringify(ev).length`(トップレベルのキーを元の順で)
fn event_len(ev: &serde_json::Map<String, Value>) -> i64 {
    let mut c = Utf16Counter(0);
    let _ = atlas_core::json::write_js(&mut c, ev);
    c.0
}

/// 集計器。1 イベントずつ add する(値は数えるだけ)
#[derive(Debug, Clone, Default)]
pub struct CoverageCounter {
    map: IndexMap<(String, String), CoverageEntry>,
    pub types: IndexMap<String, TypeCount>,
    pub events: i64,
}

impl CoverageCounter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, ev: &RawEvent) {
        self.events += 1;
        let t = ev.kind().to_string();
        let line = event_len(&ev.obj);
        let tc = self.types.entry(t.clone()).or_default();
        tc.n += 1;
        tc.bytes += line;
        for (k, v) in &ev.obj {
            if k != "type" && k != "data" {
                self.bump(&t, &format!("^{k}"), json_len(v));
            }
        }
        match ev.obj.get("data") {
            Some(Value::Object(d)) => {
                for (k, v) in d {
                    self.bump(&t, k, json_len(v));
                }
            }
            Some(Value::Array(a)) => {
                for (i, v) in a.iter().enumerate() {
                    self.bump(&t, &i.to_string(), json_len(v));
                }
            }
            _ => {}
        }
    }

    fn bump(&mut self, t: &str, key: &str, bytes: i64) {
        let e = self.map.entry((t.to_string(), key.to_string())).or_insert_with(|| {
            let r = rule_for(t, key);
            CoverageEntry {
                kind: t.to_string(),
                key: key.to_string(),
                n: 0,
                bytes: 0,
                treatment: r.map_or(Treatment::Unclassified, |r| r.treatment),
                reason: r.and_then(|r| r.reason),
                excluded_n: None,
                excluded_bytes: None,
            }
        });
        e.n += 1;
        e.bytes += bytes;
    }

    /// 全文記録が partial のキーの中で除外した箇所を数える
    pub fn add_excluded(&mut self, t: &str, key: &str, bytes: i64) {
        if let Some(e) = self.map.get_mut(&(t.to_string(), key.to_string())) {
            e.excluded_n = Some(e.excluded_n.unwrap_or(0) + 1);
            e.excluded_bytes = Some(e.excluded_bytes.unwrap_or(0) + bytes);
        }
    }

    /// 別の集計器の分を足す(セッションを並べて数えたものを、TS 版と同じく順に足した形にする)
    pub fn merge(&mut self, other: &CoverageCounter) {
        self.events += other.events;
        for (t, c) in &other.types {
            let x = self.types.entry(t.clone()).or_default();
            x.n += c.n;
            x.bytes += c.bytes;
        }
        for (k, e) in &other.map {
            match self.map.get_mut(k) {
                Some(cur) => {
                    cur.n += e.n;
                    cur.bytes += e.bytes;
                    if let Some(n) = e.excluded_n {
                        cur.excluded_n = Some(cur.excluded_n.unwrap_or(0) + n);
                        cur.excluded_bytes = Some(cur.excluded_bytes.unwrap_or(0) + e.excluded_bytes.unwrap_or(0));
                    }
                }
                None => {
                    self.map.insert(k.clone(), e.clone());
                }
            }
        }
    }

    pub fn entries(&self) -> Vec<CoverageEntry> {
        let mut v: Vec<CoverageEntry> = self.map.values().cloned().collect();
        v.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        v
    }

    /// 未分類のキー(type|key)。並びは entries と同じ
    pub fn unclassified_keys(&self) -> Vec<String> {
        self.entries().into_iter().filter(|e| e.treatment == Treatment::Unclassified).map(|e| format!("{}|{}", e.kind, e.key)).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DesktopColumnCoverage {
    pub table: String,
    pub column: String,
    pub treatment: Treatment,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// data.db の列の扱い(core の desktop.rs の許可リスト。値は読まない)
pub fn desktop_coverage(c: Option<&DesktopCoverage>) -> Vec<DesktopColumnCoverage> {
    let Some(c) = c else { return vec![] };
    let mut out = Vec::new();
    for (table, t) in &c.tables {
        for column in &t.allowed {
            out.push(DesktopColumnCoverage { table: table.clone(), column: column.clone(), treatment: Treatment::Full, reason: None });
        }
        for column in &t.unlisted {
            out.push(DesktopColumnCoverage { table: table.clone(), column: column.clone(), treatment: Treatment::Unclassified, reason: Some("許可リストに無い列(値は読んでいない)".into()) });
        }
    }
    for (table, reason) in &c.forbidden {
        out.push(DesktopColumnCoverage { table: table.clone(), column: "*".into(), treatment: Treatment::Excluded, reason: Some(reason.clone()) });
    }
    for table in &c.other_tables {
        out.push(DesktopColumnCoverage { table: table.clone(), column: "*".into(), treatment: Treatment::Excluded, reason: Some("セッションの解析に使わない表(開いていない)".into()) });
    }
    out
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct SummaryCount {
    pub keys: i64,
    pub n: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CoverageSummary {
    pub full: SummaryCount,
    #[serde(rename = "ref")]
    pub ref_: SummaryCount,
    pub excluded: SummaryCount,
    pub partial: SummaryCount,
    pub unclassified: SummaryCount,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DesktopCoverageOut {
    pub columns: Vec<DesktopColumnCoverage>,
    pub unclassified: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageFile {
    pub version: i64,
    pub generated_at: String,
    pub sessions: i64,
    pub events: i64,
    pub types: IndexMap<String, TypeCount>,
    pub keys: Vec<CoverageEntry>,
    pub summary: CoverageSummary,
    pub desktop: Option<DesktopCoverageOut>,
}

pub fn coverage_file(counter: &CoverageCounter, sessions: i64, desktop: Option<Vec<DesktopColumnCoverage>>, generated_at: &str) -> CoverageFile {
    let keys = counter.entries();
    let mut summary = CoverageSummary::default();
    for e in &keys {
        let s = match e.treatment {
            Treatment::Full => &mut summary.full,
            Treatment::Ref => &mut summary.ref_,
            Treatment::Excluded => &mut summary.excluded,
            Treatment::Partial => &mut summary.partial,
            Treatment::Unclassified => &mut summary.unclassified,
        };
        s.keys += 1;
        s.n += e.n;
        s.bytes += e.bytes;
    }
    CoverageFile {
        version: 1,
        generated_at: generated_at.to_string(),
        sessions,
        events: counter.events,
        types: counter.types.clone(),
        keys,
        summary,
        desktop: desktop.map(|columns| {
            let unclassified = columns.iter().filter(|c| c.treatment == Treatment::Unclassified).count() as i64;
            DesktopCoverageOut { columns, unclassified }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules() {
        assert_eq!(rule_for("assistant.message", "encryptedContent").unwrap().treatment, Treatment::Excluded);
        assert_eq!(rule_for("session.start", "anything").unwrap().treatment, Treatment::Full);
        assert!(rule_for("brand.new", "x").is_none());
        assert!(rule_for("user.message", "unknownKey").is_none());
        assert_eq!(rule_for("x", "^id").unwrap().treatment, Treatment::Ref);
        assert_eq!(json_len(&serde_json::json!({"a": "日本😀"})), r#"{"a":"日本😀"}"#.encode_utf16().count() as i64);
    }
}
