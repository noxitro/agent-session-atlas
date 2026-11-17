//! events.jsonl を 1 行ずつ読む(packages/core/src/events.ts の移植)。
//! 72MB 級のファイルを一括で読まず、行ごとに解析して渡す。壊れた行・type の無い行は stats.bad_lines に数えて飛ばす。
//! 行は \n(と \r\n)だけで区切る(U+2028 / U+2029 と単独の \r では区切らない)。

use crate::types::{CopilotEvent, ParseStats};
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub fn new_parse_stats() -> ParseStats {
    ParseStats::default()
}

/// events.jsonl の行を順に読む。読み込みの失敗は Err で返す(黙って打ち切らない)
pub struct EventReader {
    reader: BufReader<File>,
    buf: Vec<u8>,
    pub stats: ParseStats,
}

impl EventReader {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        Ok(EventReader { reader: BufReader::with_capacity(1024 * 1024, File::open(path)?), buf: Vec::with_capacity(64 * 1024), stats: ParseStats::default() })
    }

    /// 次のイベント。終わりなら None
    pub fn next_event(&mut self) -> std::io::Result<Option<CopilotEvent>> {
        loop {
            self.buf.clear();
            let n = self.reader.read_until(b'\n', &mut self.buf)?;
            if n == 0 {
                return Ok(None);
            }
            let mut line: &[u8] = &self.buf;
            if line.last() == Some(&b'\n') {
                line = &line[..line.len() - 1];
            } else if line.is_empty() {
                return Ok(None);
            }
            if let Some(ev) = parse_line(line, &mut self.stats) {
                return Ok(Some(ev));
            }
        }
    }
}

/// 1 行を読む(TS の parseLine)
pub fn parse_line(raw: &[u8], stats: &mut ParseStats) -> Option<CopilotEvent> {
    stats.lines += 1;
    let text = String::from_utf8_lossy(raw);
    let mut line: &str = &text;
    if let Some(s) = line.strip_suffix('\r') {
        line = s;
    }
    if let Some(s) = line.strip_prefix('\u{feff}') {
        line = s;
    }
    if crate::js::trim(line).is_empty() {
        stats.blank_lines += 1;
        return None;
    }
    let ev = match crate::js::parse_json(line) {
        Ok(Value::Object(m)) => m,
        _ => {
            stats.bad_lines += 1;
            return None;
        }
    };
    event_from_map(ev).or_else(|| {
        stats.bad_lines += 1;
        None
    })
    .inspect(|_| stats.parsed += 1)
}

fn event_from_map(mut m: serde_json::Map<String, Value>) -> Option<CopilotEvent> {
    let kind = match m.get("type") {
        Some(Value::String(s)) => s.clone(),
        _ => return None,
    };
    Some(CopilotEvent { kind, data: m.remove("data"), id: m.remove("id"), timestamp: m.remove("timestamp"), parent_id: m.remove("parentId"), agent_id: m.remove("agentId") })
}

/// テスト・小さいファイル用: 全件を配列で返す
pub fn read_events(path: &Path) -> std::io::Result<(Vec<CopilotEvent>, ParseStats)> {
    let mut r = EventReader::open(path)?;
    let mut out = Vec::new();
    while let Some(e) = r.next_event()? {
        out.push(e);
    }
    Ok((out, r.stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_and_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        let text = ["\u{feff}{\"type\":\"a\",\"data\":{}}", "", "{\"type\":\"b\"", "{\"data\":1}", "[1,2]", "{\"type\":\"c\",\"data\":{\"x\":\"日本語\"}}", ""].join("\r\n");
        std::fs::write(&p, text).unwrap();
        let (events, stats) = read_events(&p).unwrap();
        assert_eq!(events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!(stats, ParseStats { lines: 6, parsed: 2, bad_lines: 3, blank_lines: 1 });
    }

    #[test]
    fn line_separators() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        std::fs::write(&p, "{\"type\":\"a\",\"data\":{\"t\":\"x\u{2028}y\u{2029}z\"}}\n{\"type\":\"b\"}\n").unwrap();
        let (events, stats) = read_events(&p).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data.as_ref().unwrap()["t"], "x\u{2028}y\u{2029}z");
        assert_eq!(stats, ParseStats { lines: 2, parsed: 2, bad_lines: 0, blank_lines: 0 });
    }

    #[test]
    fn long_lines_and_no_trailing_newline() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        let long = "日本語".repeat(800_000);
        let first = format!("{{\"type\":\"a\",\"data\":{{\"t\":\"{long}\"}}}}");
        std::fs::write(&p, format!("{first}\r\n{{\"type\":\"b\",\"data\":{{\"t\":\"x\"}}}}\r\n{{\"type\":\"c\"}}")).unwrap();
        let (events, stats) = read_events(&p).unwrap();
        assert_eq!(events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(events[0].data.as_ref().unwrap()["t"].as_str().unwrap(), long);
        assert_eq!(stats, ParseStats { lines: 3, parsed: 3, bad_lines: 0, blank_lines: 0 });
    }
}
