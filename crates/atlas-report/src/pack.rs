//! 埋め込むセッションの要約を小さくする(packages/report/src/lib/pack.ts の移植。atlas.html の大きさの上限 5MB に収めるため)。
//! 既定値(空のセッションと同じ値)と一致する項目を落として埋め込み、読むときに既定値で埋め戻す。
//! 既定値と違う値は 0 も null もそのまま残すので、欠測(null)と 0 の区別は失わない。href は id から作れるので埋め込まない。

use crate::summarize::detail_href;
use crate::types::SessionSummary;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

/// 項目ごとの既定値。入れ子のオブジェクトは項目ごとに比べる。中身の決まっていない辞書は {} を既定値にし、空のときだけ落とす。
/// 省略可能な項目(turnRows・turnVerdicts・memo)は既定値を持たない
static DEFAULTS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "client": null,
        "projectSource": "path",
        "branch": null,
        "person": null,
        "name": null,
        "firstUserMessage": null,
        "durationMs": 0,
        "activeMs": null,
        "turns": 0,
        "autopilotContinuations": 0,
        "empty": false,
        "models": [],
        "tokens": { "input": null, "output": null, "cacheRead": null, "cacheWrite": null, "reasoning": null, "premiumRequests": null, "nanoAiu": null, "requests": 0, "source": "none" },
        "coverage": "none",
        "byModel": {},
        "tools": { "total": 0, "byName": {}, "internal": 0, "mcp": {}, "issues": {}, "causes": {}, "durations": {}, "outliers": {} },
        "exec": { "modes": {}, "modesInferred": 0, "efforts": {}, "modelEfforts": {}, "initiators": {}, "context": null, "latency": {} },
        "frictionDetail": { "permissions": [0, 0, 0], "errorTypes": {}, "subagentFailures": {}, "compaction": [0, 0, 0, 0, 0] },
        "todos": null,
        "skills": {},
        "agents": { "total": 0, "failed": 0, "byName": {} },
        "hooks": { "total": 0, "byType": {} },
        "instructions": {},
        "lines": { "added": 0, "removed": 0, "source": "none" },
        "wiki": { "indexReads": 0, "pageReads": 0, "skillCalls": 0, "writes": 0 },
        "friction": { "compactions": 0, "aborts": 0, "errors": 0, "permissionRequests": 0, "askUser": 0, "modelChanges": 0, "modeChanges": 0, "toolFailures": 0, "subagentFailures": 0 },
        "skillChars": {},
        "instructionVersions": [],
        "analysis": { "filesReedited": 0, "extraEdits": 0, "maxConsecutiveFailures": 0, "turns": 0 },
        "files": { "changed": 0, "created": 0, "deleted": 0, "sessionState": 0 },
        "judgment": null,
    })
});

/// 中身の決まった既定値(項目ごとに比べる)。{} は辞書の既定値なので項目ごとには比べない
fn structured(d: &Value) -> Option<&Map<String, Value>> {
    d.as_object().filter(|m| !m.is_empty())
}

/// JS の深い比較(数は値で比べる。1 と 1.0 は同じ)
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn pack_obj(o: Map<String, Value>, d: &Map<String, Value>) -> Map<String, Value> {
    let mut r = Map::new();
    for (k, v) in o {
        match d.get(&k) {
            None => {
                r.insert(k, v);
            }
            Some(dv) if same(&v, dv) => {}
            Some(dv) => match (structured(dv), v) {
                (Some(ds), Value::Object(vo)) => {
                    r.insert(k, Value::Object(pack_obj(vo, ds)));
                }
                (_, v) => {
                    r.insert(k, v);
                }
            },
        }
    }
    r
}

fn unpack_obj(o: &Map<String, Value>, d: &Map<String, Value>) -> Map<String, Value> {
    let mut r = o.clone();
    for (k, dv) in d {
        match r.get(k) {
            None => {
                r.insert(k.clone(), dv.clone());
            }
            Some(v) => {
                if let (Some(ds), Some(vo)) = (structured(dv), v.as_object()) {
                    let u = unpack_obj(vo, ds);
                    r.insert(k.clone(), Value::Object(u));
                }
            }
        }
    }
    r
}

/// 埋め込む形にする(既定値と同じ項目と href を落とす)
pub fn pack_summary(s: &SessionSummary) -> Value {
    let v = serde_json::to_value(s).expect("SessionSummary は JSON にできる");
    let mut o = match v {
        Value::Object(o) => o,
        _ => unreachable!("SessionSummary はオブジェクト"),
    };
    o.shift_remove("href");
    Value::Object(pack_obj(o, DEFAULTS.as_object().expect("既定値はオブジェクト")))
}

/// 埋め込んだ形から元の要約(JSON)に戻す
pub fn unpack_summary_value(p: &Map<String, Value>) -> Value {
    let mut s = unpack_obj(p, DEFAULTS.as_object().expect("既定値はオブジェクト"));
    let id = s.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    s.insert("href".into(), Value::String(detail_href(&id)));
    Value::Object(s)
}

/// 埋め込んだ形から元の要約に戻す
pub fn unpack_summary(p: &Value) -> serde_json::Result<SessionSummary> {
    let o = p.as_object().ok_or_else(|| serde::de::Error::custom("要約がオブジェクトではありません"))?;
    serde_json::from_value(unpack_summary_value(o))
}

/// 埋め込みデータの sessions を元の形に戻す(sessions が無い・配列でないときはそのまま)
pub fn unpack_data(data: Value) -> Value {
    let Value::Object(mut o) = data else { return data };
    let Some(Value::Array(list)) = o.get("sessions") else { return Value::Object(o) };
    let list: Vec<Value> = list
        .iter()
        .map(|x| match x.as_object() {
            Some(m) if m.get("id").is_some_and(Value::is_string) => unpack_summary_value(m),
            _ => x.clone(),
        })
        .collect();
    o.insert("sessions".into(), Value::Array(list));
    Value::Object(o)
}
