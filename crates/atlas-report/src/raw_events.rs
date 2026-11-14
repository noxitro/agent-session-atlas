//! events.jsonl を、JSON.parse した形のまま(全てのキーを元の順で)読む。セッション記録・全文記録・網羅の検査が使う
//! (core の events.rs の CopilotEvent は type・data・id・timestamp・parentId・agentId だけを持つので、全文記録には足りない)。
//! 行の区切りと壊れた行の扱いは core の events.rs(TS の parseEvents)と同じ。

use atlas_core::types::CopilotEvent;
use serde_json::{Map, Value};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

#[derive(Debug, Clone)]
pub struct RawEvent {
    pub obj: Map<String, Value>,
}

impl RawEvent {
    pub fn kind(&self) -> &str {
        self.obj.get("type").and_then(Value::as_str).unwrap_or("")
    }

    pub fn get(&self, k: &str) -> Option<&Value> {
        self.obj.get(k)
    }

    /// `(e.data ?? {}) as Record<string, unknown>`(オブジェクトでなければ空)
    pub fn data(&self) -> &Map<String, Value> {
        self.obj.get("data").and_then(Value::as_object).unwrap_or(&EMPTY)
    }

    /// `d[k]`(undefined は None。null は Some(Null))
    pub fn d(&self, k: &str) -> Option<&Value> {
        self.data().get(k)
    }

    /// `typeof d[k] === 'string' ? d[k] : null`
    pub fn d_str(&self, k: &str) -> Option<&str> {
        self.d(k).and_then(Value::as_str)
    }

    /// e.timestamp(文字列のときだけ)
    pub fn timestamp(&self) -> Option<&str> {
        self.obj.get("timestamp").and_then(Value::as_str)
    }

    /// e.agentId が真のとき、その値の文字列(`String(e.agentId)`)
    pub fn agent_id(&self) -> Option<String> {
        truthy_string(self.obj.get("agentId"))
    }

    /// core の normalize が使う形
    pub fn to_copilot_event(&self) -> CopilotEvent {
        CopilotEvent {
            kind: self.kind().to_string(),
            data: self.obj.get("data").cloned(),
            id: self.obj.get("id").cloned(),
            timestamp: self.obj.get("timestamp").cloned(),
            parent_id: self.obj.get("parentId").cloned(),
            agent_id: self.obj.get("agentId").cloned(),
        }
    }
}

/// JS で真の値なら `String(v)`(null・undefined・空文字・0・false は None)
pub fn truthy_string(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Null => None,
        Value::Bool(false) => None,
        Value::String(s) if s.is_empty() => None,
        Value::Number(n) if n.as_f64().is_some_and(|x| x == 0.0 || x.is_nan()) => None,
        other => Some(atlas_core::js::to_js_string(other)),
    }
}

fn parse_line(raw: &[u8]) -> Option<RawEvent> {
    let text = String::from_utf8_lossy(raw);
    let mut line: &str = &text;
    if let Some(s) = line.strip_suffix('\r') {
        line = s;
    }
    if let Some(s) = line.strip_prefix('\u{feff}') {
        line = s;
    }
    if atlas_core::js::trim(line).is_empty() {
        return None;
    }
    match atlas_core::js::parse_json(line) {
        Ok(Value::Object(m)) if matches!(m.get("type"), Some(Value::String(_))) => Some(RawEvent { obj: m }),
        _ => None,
    }
}

/// events.jsonl を全部読む(読み込みの失敗は Err。黙って打ち切らない)
pub fn read_raw_events(path: &Path) -> std::io::Result<Vec<RawEvent>> {
    let mut reader = BufReader::with_capacity(1024 * 1024, File::open(path)?);
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut out = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        let line: &[u8] = if buf.last() == Some(&b'\n') { &buf[..buf.len() - 1] } else { &buf };
        if let Some(e) = parse_line(line) {
            out.push(e);
        }
    }
    Ok(out)
}
