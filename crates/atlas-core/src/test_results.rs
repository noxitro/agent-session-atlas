//! テストの実行ファイルが標準出力に書いた、印つきの 1 行 JSON を、ツールの結果から拾う(条件別の効果測定)。
//!
//! - 印: 行頭(前の空白は可)の `ATLAS_TEST_RESULT`、空白、1 行の JSON オブジェクト。
//!   例 `ATLAS_TEST_RESULT {"name":"描画","passed":false,"counts":{"assertFailures":2},"at":"2026-11-16T01:02:03.456Z"}`
//! - 読む項目: `passed`(真偽。必須)・`name`(文字列)・`counts`(名前 → 数。件数でも割合でもよい)・`at`(テストを実行した時刻)。
//!   ほかの項目は読み飛ばすので、項目を足しても古い atlas で読める。新しい数は `counts` に足す。
//! - 読む場所: `tool.execution_complete` の結果(`result.detailedContent`、無ければ `result.content`、文字列の `result`)。
//!   印の行が無ければ、失敗したツールのエラーの文(`error.message`)。同じ呼び出しの中で 2 か所から重ねて数えない。
//! - 行頭に印がある行だけを読む(テストのソースを読んだ結果の `print("ATLAS_TEST_RESULT …")` や、行番号・ファイル名の付いた検索の結果は拾わない)。
//! - 同じ行が 2 回出たとき(後から読む非同期のシェルや、保存したログを表示したとき): `at` のある行は 1 回だけ数え、重ねた数を残す。
//!   `at` の無い行は、別の実行と見分けられないので重ねても数える。
//! - 値は元のログに書かれたものだけで決める(LLM は使わない)。

use crate::js;
use crate::jsdate;
use crate::types::{SessionTests, TestResult, TestRun};
use serde_json::Value;
use std::collections::HashSet;

/// 行頭の印
pub const TEST_MARKER: &str = "ATLAS_TEST_RESULT";
/// 1 セッションで持つ結果の上限(超えた分は数だけ残す。sessions.json を大きくしすぎないため)
pub const MAX_TEST_RESULTS: usize = 5000;
/// テスト名の長さの上限(UTF-16 の単位)
const MAX_NAME: usize = 200;
/// 件数の名前の数と長さの上限
const MAX_COUNT_KEYS: usize = 50;
const MAX_COUNT_KEY: usize = 100;

/// 印のある 1 行を読んだもの
#[derive(Debug, Clone, PartialEq)]
pub enum MarkerLine {
    /// 読めた結果と、重ねて数えないための鍵(`at` のある行だけ。JSON の本文)
    Result(TestResult, Option<String>),
    /// 印はあるが、JSON のオブジェクトでないか `passed` が真偽でない
    Invalid,
}

fn clean_text(s: &str) -> String {
    js::trim(s).chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

fn parse_object(o: &serde_json::Map<String, Value>) -> Option<TestResult> {
    let passed = o.get("passed").and_then(Value::as_bool)?;
    let name = o.get("name").and_then(Value::as_str).map(clean_text).filter(|s| !s.is_empty()).map(|s| js::utf16_slice(&s, 0, MAX_NAME).into_owned());
    let mut counts = js::JsMap::new();
    if let Some(Value::Object(c)) = o.get("counts") {
        for (k, v) in c {
            if counts.len() >= MAX_COUNT_KEYS {
                break;
            }
            let key = clean_text(k);
            if key.is_empty() || js::utf16_len(&key) > MAX_COUNT_KEY {
                continue;
            }
            if let Some(n) = v.as_f64().filter(|n| n.is_finite()) {
                counts.insert(key, n);
            }
        }
    }
    let at = o.get("at").and_then(Value::as_str).and_then(jsdate::parse_ms).map(jsdate::to_iso);
    Some(TestResult { name, passed, counts, at })
}

/// 1 行を読む。印の行でなければ None
pub fn parse_line(line: &str) -> Option<MarkerLine> {
    let s = js::trim(line.strip_suffix('\r').unwrap_or(line));
    let rest = s.strip_prefix(TEST_MARKER)?;
    // ATLAS_TEST_RESULTS などの別の語は印にしない
    if !rest.is_empty() && !rest.starts_with(js::is_js_whitespace) {
        return None;
    }
    let body = js::trim(rest);
    let parsed = match js::parse_json(body) {
        Ok(Value::Object(o)) => parse_object(&o),
        _ => None,
    };
    Some(match parsed {
        Some(r) => {
            let key = r.at.is_some().then(|| body.to_string());
            MarkerLine::Result(r, key)
        }
        None => MarkerLine::Invalid,
    })
}

/// 文の中の印の行を、出た順に
pub fn scan(text: &str) -> Vec<MarkerLine> {
    if !text.contains(TEST_MARKER) {
        return Vec::new();
    }
    text.split('\n').filter_map(parse_line).collect()
}

/// ツールの結果から、印を探す文の候補(先のものから順に見て、印の行が見つかった最初の 1 つだけを使う)
fn candidates<'a>(result: Option<&'a Value>, error: Option<&'a Value>) -> Vec<&'a str> {
    let mut out = Vec::new();
    match result {
        Some(Value::String(s)) => out.push(s.as_str()),
        Some(Value::Object(o)) => {
            if let Some(d) = o.get("detailedContent").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                out.push(d);
            }
            if let Some(c) = o.get("content").and_then(Value::as_str) {
                out.push(c);
            }
        }
        _ => {}
    }
    match error {
        Some(Value::String(s)) => out.push(s.as_str()),
        Some(Value::Object(o)) => {
            if let Some(m) = o.get("message").and_then(Value::as_str) {
                out.push(m);
            }
        }
        _ => {}
    }
    out
}

/// 1 回のツールの完了の、どこから読んだかを除いた情報
pub struct CompleteInfo<'a> {
    pub at: Option<String>,
    /// 依頼の番号(1 から)。最初の依頼より前と、記録する依頼の数を超えた後は None
    pub turn: Option<i64>,
    pub tool: Option<&'a str>,
    pub tool_call_id: Option<&'a str>,
    pub subagent: bool,
}

/// セッションのテストの結果を集める
#[derive(Default)]
pub struct TestCollector {
    runs: Vec<TestRun>,
    invalid: i64,
    duplicates: i64,
    dropped: i64,
    results: usize,
    seen: HashSet<String>,
}

impl TestCollector {
    pub fn new() -> Self {
        Self::default()
    }

    /// tool.execution_complete の data の result と error から読む
    pub fn add_complete(&mut self, result: Option<&Value>, error: Option<&Value>, info: CompleteInfo<'_>) {
        let Some(lines) = candidates(result, error).into_iter().map(scan).find(|l| !l.is_empty()) else {
            return;
        };
        let mut results = Vec::new();
        for l in lines {
            match l {
                MarkerLine::Invalid => self.invalid += 1,
                MarkerLine::Result(r, key) => {
                    if let Some(k) = key {
                        if !self.seen.insert(k) {
                            self.duplicates += 1;
                            continue;
                        }
                    }
                    if self.results >= MAX_TEST_RESULTS {
                        self.dropped += 1;
                        continue;
                    }
                    self.results += 1;
                    results.push(r);
                }
            }
        }
        if results.is_empty() {
            return;
        }
        self.runs.push(TestRun {
            at: info.at,
            turn: info.turn,
            tool: info.tool.map(str::to_string),
            tool_call_id: info.tool_call_id.map(str::to_string),
            subagent: info.subagent,
            results,
        });
    }

    /// 印の行が 1 つも無ければ None(記録にキーを置かない)
    pub fn result(self) -> Option<SessionTests> {
        if self.runs.is_empty() && self.invalid == 0 && self.duplicates == 0 && self.dropped == 0 {
            return None;
        }
        Some(SessionTests { runs: self.runs, invalid: self.invalid, duplicates: self.duplicates, dropped: self.dropped })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(turn: Option<i64>) -> CompleteInfo<'static> {
        CompleteInfo { at: Some("2026-11-16T00:00:01.000Z".into()), turn, tool: Some("powershell"), tool_call_id: Some("c1"), subagent: false }
    }

    #[test]
    fn reads_marker_lines() {
        let r = parse_line(r#"  ATLAS_TEST_RESULT {"name":" 描画\t","passed":false,"counts":{"assertFailures":2,"diffRate":0.125,"bad":"x","":1},"at":"2026-11-16T10:00:00+09:00","extra":{"x":1}}"#);
        let Some(MarkerLine::Result(t, key)) = r else { panic!("{r:?}") };
        assert_eq!(t.name.as_deref(), Some("描画"));
        assert!(!t.passed);
        assert_eq!(t.counts.iter().map(|(k, v)| (k.as_str(), *v)).collect::<Vec<_>>(), [("assertFailures", 2.0), ("diffRate", 0.125)]);
        assert_eq!(t.at.as_deref(), Some("2026-11-16T01:00:00.000Z"));
        assert!(key.is_some());
        // at の無い行は重ねて数えない鍵を持たない
        assert!(matches!(parse_line(r#"ATLAS_TEST_RESULT {"passed":true}"#), Some(MarkerLine::Result(TestResult { passed: true, name: None, at: None, .. }, None))));
        assert!(matches!(parse_line("ATLAS_TEST_RESULT {\"passed\":true}\r"), Some(MarkerLine::Result(..))));
    }

    #[test]
    fn rejects_and_ignores() {
        // 印はあるが読めない
        for l in ["ATLAS_TEST_RESULT", "ATLAS_TEST_RESULT {", r#"ATLAS_TEST_RESULT {"passed":"yes"}"#, r#"ATLAS_TEST_RESULT [true]"#, r#"ATLAS_TEST_RESULT {"name":"a"}"#] {
            assert_eq!(parse_line(l), Some(MarkerLine::Invalid), "{l}");
        }
        // 印の行ではない(行頭にない・別の語)
        for l in [r#"print("ATLAS_TEST_RESULT {\"passed\":true}")"#, r#"12: ATLAS_TEST_RESULT {"passed":true}"#, r#"ATLAS_TEST_RESULTS {"passed":true}"#, "ok"] {
            assert_eq!(parse_line(l), None, "{l}");
        }
        // 書式の崩れた時刻は捨てる。長い名前は切る
        let long = "あ".repeat(300);
        let Some(MarkerLine::Result(t, _)) = parse_line(&format!(r#"ATLAS_TEST_RESULT {{"name":"{long}","passed":true,"at":"きのう"}}"#)) else { panic!() };
        assert_eq!(t.at, None);
        assert_eq!(js::utf16_len(t.name.as_deref().unwrap()), MAX_NAME);
    }

    #[test]
    fn collects_runs_once_per_call() {
        let mut c = TestCollector::new();
        let a = r#"ATLAS_TEST_RESULT {"name":"a","passed":false,"at":"2026-11-16T00:00:00Z"}"#;
        let b = r#"ATLAS_TEST_RESULT {"name":"b","passed":true}"#;
        let text = format!("building...\n{a}\n{b}\nATLAS_TEST_RESULT oops\n");
        // detailedContent と content の両方に同じ行があっても 1 回だけ
        c.add_complete(Some(&json!({ "content": text, "detailedContent": text })), None, info(Some(1)));
        // 後から同じ出力を読んだ: at のある a は重ねない、at の無い b は数える
        c.add_complete(Some(&json!({ "content": format!("{a}\n{b}") })), None, info(Some(2)));
        // 失敗したツールはエラーの文から
        c.add_complete(None, Some(&json!({ "code": "failure", "message": "exit 1\nATLAS_TEST_RESULT {\"name\":\"c\",\"passed\":false}" })), info(None));
        // 印の無い結果は数えない
        c.add_complete(Some(&json!("ok")), None, info(Some(3)));
        let s = c.result().unwrap();
        assert_eq!(s.runs.iter().map(|r| (r.turn, r.results.iter().map(|x| x.name.clone().unwrap()).collect::<Vec<_>>())).collect::<Vec<_>>(), [
            (Some(1), vec!["a".to_string(), "b".to_string()]),
            (Some(2), vec!["b".to_string()]),
            (None, vec!["c".to_string()]),
        ]);
        assert_eq!((s.invalid, s.duplicates, s.dropped), (1, 1, 0));
        assert_eq!(s.runs[0].tool.as_deref(), Some("powershell"));
        assert!(TestCollector::new().result().is_none());
    }

    #[test]
    fn caps_results() {
        let mut c = TestCollector::new();
        let text = (0..MAX_TEST_RESULTS + 3).map(|_| r#"ATLAS_TEST_RESULT {"passed":true}"#).collect::<Vec<_>>().join("\n");
        c.add_complete(Some(&json!(text)), None, info(Some(1)));
        let s = c.result().unwrap();
        assert_eq!(s.runs[0].results.len(), MAX_TEST_RESULTS);
        assert_eq!(s.dropped, 3);
    }
}
