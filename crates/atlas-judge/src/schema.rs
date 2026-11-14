//! judgments.json のスキーマ(schemaVersion 1)と検証(packages/judge/src/schema.ts の移植)。
//! 外部 LLM の出力も内部バックエンドの出力も、ここを通ったものだけを judgments.json に入れる。
//! 形が合わないものは黙って直さず、どこが違うかを列挙して落とす。

use atlas_core::js;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub const JUDGMENTS_SCHEMA_VERSION: i64 = 1;

pub const TASK_CATEGORIES: [&str; 7] = ["feature", "bugfix", "investigation", "refactor", "docs", "ops", "other"];

/// 判定を出したもの。opencode は今は選べないが、前に判定した judgments.json を読めるように残す
pub const BACKENDS: [&str; 4] = ["copilot-cli", "opencode", "anthropic", "external"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EffectScore {
    /// -2(逆効果)〜 +2(大いに役立った)。使われていなければ 0
    pub score: f64,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HumanEffort {
    pub hours: f64,
    pub low: f64,
    pub high: f64,
    pub confidence: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiOutcome {
    pub completed: bool,
    pub quality: f64,
    pub rework: f64,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgeMeta {
    pub backend: String,
    pub model: Option<String>,
    pub ran_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgmentItem {
    pub session_id: String,
    pub task_category: String,
    pub task_summary: String,
    pub human_effort: HumanEffort,
    pub ai_outcome: AiOutcome,
    pub instructions_effect: EffectScore,
    pub wiki_effect: EffectScore,
    pub skills_agents_effect: EffectScore,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// この項目を誰が判定したか(ツールが付ける。LLM の出力には不要)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge: Option<JudgeMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileJudge {
    pub backend: String,
    pub model: Option<String>,
    pub ran_at: String,
    /// 判定自体のトークン消費(形は検証しない。TS 版と同じくそのまま持つ)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgmentsFile {
    pub schema_version: i64,
    /// 最後に書き込んだ判定の実行情報(項目ごとの出所は items[].judge)
    pub judge: FileJudge,
    pub items: Vec<JudgmentItem>,
    /// 判定に失敗したセッション(成功したら消える。形は検証しない)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failures: Option<Vec<Value>>,
}

/// 形の問題をまとめたエラー
#[derive(Debug, Clone, PartialEq)]
pub struct JudgmentValidationError {
    pub problems: Vec<String>,
    pub prefix: String,
}

impl JudgmentValidationError {
    pub fn new(problems: Vec<String>) -> Self {
        Self::with_prefix(problems, "judgments の形が正しくありません")
    }
    pub fn with_prefix(problems: Vec<String>, prefix: &str) -> Self {
        JudgmentValidationError { problems, prefix: prefix.to_string() }
    }
}

impl std::fmt::Display for JudgmentValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:\n- {}", self.prefix, self.problems.join("\n- "))
    }
}

impl std::error::Error for JudgmentValidationError {}

type Obj = Map<String, Value>;

/// 有限の数(typeof v === 'number' && Number.isFinite(v))
fn num(v: Option<&Value>) -> Option<f64> {
    js::num(v)
}

fn is_int(x: f64) -> bool {
    x.fract() == 0.0
}

fn is_str(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(_)))
}

/// `JSON.stringify(v)`(undefined は "undefined")
fn stringify(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => atlas_core::json::to_js_string(v).unwrap_or_default(),
    }
}

/// `${n}`(数の文字列。数でなければ String(v))
fn str_of(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::to_js_string)
}

fn check_effect(v: Option<&Value>, path: &str, p: &mut Vec<String>) {
    let Some(v) = v.and_then(Value::as_object) else {
        p.push(format!("{path} が無いか、{{ … }} の形ではありません"));
        return;
    };
    if !num(v.get("score")).is_some_and(|s| is_int(s) && (-2.0..=2.0).contains(&s)) {
        p.push(format!("{path}.score は -2〜2 の整数です({})", stringify(v.get("score"))));
    }
    if !is_str(v.get("evidence")) {
        p.push(format!("{path}.evidence は文字列です"));
    }
}

fn valid_judge(j: Option<&Value>) -> bool {
    j.and_then(Value::as_object).is_some_and(|j| j.get("backend").and_then(Value::as_str).is_some_and(|b| BACKENDS.contains(&b)) && is_str(j.get("ranAt")))
}

/// 1 項目を検証して問題点を返す(空なら妥当)
pub fn item_problems(v: &Value, path: &str) -> Vec<String> {
    let mut p = Vec::new();
    let Some(v) = v.as_object() else {
        return vec![format!("{path} が無いか、{{ … }} の形ではありません")];
    };
    if !v.get("sessionId").and_then(Value::as_str).is_some_and(|s| !js::trim(s).is_empty()) {
        p.push(format!("{path}.sessionId がありません"));
    }
    if !v.get("taskCategory").and_then(Value::as_str).is_some_and(|c| TASK_CATEGORIES.contains(&c)) {
        p.push(format!("{path}.taskCategory は {} のいずれかです({})", TASK_CATEGORIES.join(" / "), stringify(v.get("taskCategory"))));
    }
    if !v.get("taskSummary").and_then(Value::as_str).is_some_and(|s| !js::trim(s).is_empty()) {
        p.push(format!("{path}.taskSummary がありません"));
    }

    match v.get("humanEffort").and_then(Value::as_object) {
        None => p.push(format!("{path}.humanEffort が無いか、{{ … }} の形ではありません")),
        Some(h) => {
            for k in ["hours", "low", "high"] {
                if !num(h.get(k)).is_some_and(|x| x >= 0.0) {
                    p.push(format!("{path}.humanEffort.{k} は 0 以上の数値です({})", stringify(h.get(k))));
                }
            }
            if let (Some(hours), Some(low), Some(high)) = (num(h.get("hours")), num(h.get("low")), num(h.get("high")))
                && !(low <= hours && hours <= high)
            {
                p.push(format!(
                    "{path}.humanEffort は low ≤ hours ≤ high を満たす必要があります({} / {} / {})",
                    str_of(h.get("low")),
                    str_of(h.get("hours")),
                    str_of(h.get("high"))
                ));
            }
            if !num(h.get("confidence")).is_some_and(|c| (0.0..=1.0).contains(&c)) {
                p.push(format!("{path}.humanEffort.confidence は 0〜1 の数値です({})", stringify(h.get("confidence"))));
            }
            if !is_str(h.get("rationale")) {
                p.push(format!("{path}.humanEffort.rationale は文字列です"));
            }
        }
    }

    match v.get("aiOutcome").and_then(Value::as_object) {
        None => p.push(format!("{path}.aiOutcome が無いか、{{ … }} の形ではありません")),
        Some(a) => {
            if !matches!(a.get("completed"), Some(Value::Bool(_))) {
                p.push(format!("{path}.aiOutcome.completed は true / false です"));
            }
            if !num(a.get("quality")).is_some_and(|q| is_int(q) && (1.0..=5.0).contains(&q)) {
                p.push(format!("{path}.aiOutcome.quality は 1〜5 の整数です({})", stringify(a.get("quality"))));
            }
            if !num(a.get("rework")).is_some_and(|r| is_int(r) && (0.0..=5.0).contains(&r)) {
                p.push(format!("{path}.aiOutcome.rework は 0〜5 の整数です({})", stringify(a.get("rework"))));
            }
            if !is_str(a.get("rationale")) {
                p.push(format!("{path}.aiOutcome.rationale は文字列です"));
            }
        }
    }
    check_effect(v.get("instructionsEffect"), &format!("{path}.instructionsEffect"), &mut p);
    check_effect(v.get("wikiEffect"), &format!("{path}.wikiEffect"), &mut p);
    check_effect(v.get("skillsAgentsEffect"), &format!("{path}.skillsAgentsEffect"), &mut p);
    if v.get("notes").is_some_and(|n| !n.is_null() && !n.is_string()) {
        p.push(format!("{path}.notes は文字列です"));
    }
    if v.get("judge").is_some_and(|j| !valid_judge(Some(j))) {
        p.push(format!("{path}.judge は {{backend, model, ranAt}} です"));
    }
    p
}

fn effect(o: &Obj, k: &str) -> EffectScore {
    let e = &o[k];
    EffectScore { score: e["score"].as_f64().unwrap_or(0.0), evidence: e["evidence"].as_str().unwrap_or("").to_string() }
}

/// 1 項目を検証し、余分なキーを落とした正規形を返す。不正なら JudgmentValidationError
pub fn validate_judgment_item(v: &Value, path: &str) -> Result<JudgmentItem, JudgmentValidationError> {
    let p = item_problems(v, path);
    if !p.is_empty() {
        return Err(JudgmentValidationError::new(p));
    }
    let x = v.as_object().expect("item_problems で確かめた");
    let s = |o: &Value, k: &str| o[k].as_str().unwrap_or("").to_string();
    let f = |o: &Value, k: &str| o[k].as_f64().unwrap_or(0.0);
    let h = &x["humanEffort"];
    let a = &x["aiOutcome"];
    Ok(JudgmentItem {
        session_id: js::trim(x["sessionId"].as_str().unwrap_or("")).to_string(),
        task_category: s(v, "taskCategory"),
        task_summary: s(v, "taskSummary"),
        human_effort: HumanEffort { hours: f(h, "hours"), low: f(h, "low"), high: f(h, "high"), confidence: f(h, "confidence"), rationale: s(h, "rationale") },
        ai_outcome: AiOutcome { completed: a["completed"].as_bool().unwrap_or(false), quality: f(a, "quality"), rework: f(a, "rework"), rationale: s(a, "rationale") },
        instructions_effect: effect(x, "instructionsEffect"),
        wiki_effect: effect(x, "wikiEffect"),
        skills_agents_effect: effect(x, "skillsAgentsEffect"),
        notes: x.get("notes").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string),
        // TS は `if (x.judge)`(真のときだけ)。検証済みなのでオブジェクト
        judge: x.get("judge").and_then(Value::as_object).map(|j| JudgeMeta {
            backend: j["backend"].as_str().unwrap_or("").to_string(),
            model: j.get("model").and_then(Value::as_str).map(str::to_string),
            ran_at: j["ranAt"].as_str().unwrap_or("").to_string(),
        }),
    })
}

/// judgments.json 全体を検証する。問題はまとめて報告する
pub fn validate_judgments(v: &Value) -> Result<JudgmentsFile, JudgmentValidationError> {
    let Some(o) = v.as_object() else {
        return Err(JudgmentValidationError::new(vec!["ルートがオブジェクトではありません".into()]));
    };
    let mut p: Vec<String> = Vec::new();
    if o.get("schemaVersion").and_then(Value::as_f64) != Some(JUDGMENTS_SCHEMA_VERSION as f64) {
        p.push(format!("schemaVersion が 1 ではありません({})", stringify(o.get("schemaVersion"))));
    }
    let j = o.get("judge");
    if !valid_judge(j) {
        p.push(format!("judge は {{backend: {}, model, ranAt}} です", BACKENDS.join("|")));
    }
    match o.get("items").and_then(Value::as_array) {
        None => p.push("items が配列ではありません".into()),
        Some(items) => {
            for (i, it) in items.iter().enumerate() {
                p.extend(item_problems(it, &format!("items[{i}]")));
            }
            let mut seen: HashSet<&str> = HashSet::new();
            for it in items {
                let Some(id) = it.get("sessionId").and_then(Value::as_str) else { continue };
                if !seen.insert(id) {
                    p.push(format!("sessionId {id} が重複しています"));
                }
            }
        }
    }
    if o.get("failures").is_some_and(|f| !f.is_array()) {
        p.push("failures が配列ではありません".into());
    }
    if !p.is_empty() {
        return Err(JudgmentValidationError::new(p));
    }
    let jj = j.and_then(Value::as_object).expect("valid_judge で確かめた");
    let items = o["items"].as_array().expect("確かめた").iter().enumerate().map(|(i, it)| validate_judgment_item(it, &format!("items[{i}]"))).collect::<Result<Vec<_>, _>>()?;
    Ok(JudgmentsFile {
        schema_version: 1,
        judge: FileJudge {
            backend: jj["backend"].as_str().unwrap_or("").to_string(),
            model: jj.get("model").and_then(Value::as_str).map(str::to_string),
            ran_at: jj["ranAt"].as_str().unwrap_or("").to_string(),
            usage: jj.get("usage").filter(|u| u.is_object()).cloned(),
        },
        items,
        failures: o.get("failures").and_then(Value::as_array).filter(|f| !f.is_empty()).cloned(),
    })
}

/// 判定自体のトークン消費(バックエンドの usage を数値の葉ごとに合計したもの)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct JudgeUsage {
    /// usage を取れた判定の回数
    pub runs: i64,
    /// usage が取れなかった判定の回数
    pub missing: i64,
    /// "a.b.c" 形式の経路 → 合計値
    pub totals: js::JsMap<f64>,
}

pub fn empty_judgments(backend: &str, model: Option<&str>, ran_at: &str) -> JudgmentsFile {
    JudgmentsFile {
        schema_version: 1,
        judge: FileJudge { backend: backend.to_string(), model: model.map(str::to_string), ran_at: ran_at.to_string(), usage: None },
        items: Vec::new(),
        failures: None,
    }
}

/// 失敗の記録の sessionId(形は検証しないので Value のまま持つ)
fn failure_session(f: &Value) -> Option<&str> {
    f.get("sessionId").and_then(Value::as_str)
}

/// sessionId 単位で上書きマージ(新しい方が勝つ)。成功した項目の failures は消す
pub fn merge_judgments(base: &JudgmentsFile, add: &[JudgmentItem], judge: FileJudge) -> JudgmentsFile {
    let mut by: indexmap::IndexMap<String, JudgmentItem> = base.items.iter().map(|i| (i.session_id.clone(), i.clone())).collect();
    for it in add {
        by.insert(it.session_id.clone(), it.clone());
    }
    let done: HashSet<&str> = add.iter().map(|i| i.session_id.as_str()).collect();
    let failures: Vec<Value> = base.failures.iter().flatten().filter(|f| !failure_session(f).is_some_and(|id| done.contains(id))).cloned().collect();
    JudgmentsFile { schema_version: 1, judge, items: by.into_values().collect(), failures: if failures.is_empty() { None } else { Some(failures) } }
}

/// オブジェクトのキーを `Object.entries` の順(配列の添字の形のキーが先)で返す
pub fn js_object_entries(m: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut idx: Vec<(u32, &String)> = Vec::new();
    let mut rest: Vec<&String> = Vec::new();
    for k in m.keys() {
        match js::array_index(k) {
            Some(n) => idx.push((n, k)),
            None => rest.push(k),
        }
    }
    idx.sort_by_key(|x| x.0);
    idx.into_iter().map(|x| x.1).chain(rest).map(|k| (k, &m[k])).collect()
}

/// usage の JSON(形は問わない)から数値の葉を "a.b" 経路で集める
pub fn numeric_leaves(v: &Value, prefix: &str, out: &mut js::JsMap<f64>) {
    match v {
        Value::Number(_) => {
            if let Some(n) = js::num(Some(v)) {
                out.add(if prefix.is_empty() { "value" } else { prefix }, n);
            }
        }
        Value::Array(a) => {
            for x in a {
                numeric_leaves(x, prefix, out);
            }
        }
        Value::Object(o) => {
            for (k, x) in js_object_entries(o) {
                let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                numeric_leaves(x, &p, out);
            }
        }
        _ => {}
    }
}

pub fn add_usage(u: Option<&JudgeUsage>, raw: Option<&Value>) -> JudgeUsage {
    let mut out = u.cloned().unwrap_or_default();
    let Some(raw) = raw.filter(|r| !r.is_null()) else {
        out.missing += 1;
        return out;
    };
    out.runs += 1;
    let mut leaves = js::JsMap::new();
    numeric_leaves(raw, "", &mut leaves);
    for (k, n) in leaves.js_entries() {
        out.totals.add(k, *n);
    }
    out
}

// ---------- LLM 出力から JSON を取り出す ----------

/// `/(`{3,}|~{3,})[ \t]*(json|jsonc|javascript|js)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1/gi` の 1 つの一致(言語名・本文・終わりの位置)。
/// regex クレートは後方参照(\1)を持たないので、同じ順で後戻りする照合を手で書く
fn fence_at(t: &[u8], s: usize) -> Option<(String, std::ops::Range<usize>, usize)> {
    let c = *t.get(s)?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let run = t[s..].iter().take_while(|&&x| x == c).count();
    if run < 3 {
        return None;
    }
    let spaces = |mut p: usize| {
        while p < t.len() && (t[p] == b' ' || t[p] == b'\t') {
            p += 1;
        }
        p
    };
    let newline = |p: usize| -> Option<usize> {
        if t.get(p) == Some(&b'\r') && t.get(p + 1) == Some(&b'\n') {
            Some(p + 2)
        } else if t.get(p) == Some(&b'\n') {
            Some(p + 1)
        } else {
            None
        }
    };
    for f in (3..=run).rev() {
        let p1 = spaces(s + f);
        // 言語名の選択肢は正規表現の並び(json → jsonc → javascript → js → なし)
        for lang in ["json", "jsonc", "javascript", "js", ""] {
            let l = lang.len();
            if l > 0 && !(p1 + l <= t.len() && t[p1..p1 + l].eq_ignore_ascii_case(lang.as_bytes())) {
                continue;
            }
            let Some(p4) = newline(spaces(p1 + l)) else { continue };
            // 本文は最短一致: 改行・空白の後に同じ囲みが来る最初の位置
            for end in p4..t.len() {
                let Some(q) = newline(end) else { continue };
                let q = spaces(q);
                if q + f <= t.len() && t[q..q + f].iter().all(|&x| x == c) {
                    let lang_text = String::from_utf8_lossy(&t[p1..p1 + l]).into_owned();
                    return Some((lang_text, p4..end, q + f));
                }
            }
        }
    }
    None
}

/// `JSON.parse`(読めなければ None)
fn try_parse(s: &str) -> Option<Value> {
    js::parse_json(s).ok()
}

/// テキスト中の JSON 候補(```json フェンス → 全体 → 最外の {…} / […])を順に返す
pub fn json_candidates(text: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let t = text.as_bytes();
    let mut fenced = 0;
    let mut i = 0;
    while i < t.len() {
        let Some((lang, body, end)) = fence_at(t, i) else {
            i += 1;
            continue;
        };
        i = end;
        let lang = lang.to_ascii_lowercase();
        let body = js::trim(&text[body]);
        if lang.is_empty() && !(body.starts_with('[') || body.starts_with('{')) {
            continue;
        }
        if let Some(v) = try_parse(body) {
            out.push(v);
            fenced += 1;
        }
    }
    if fenced > 0 {
        return out;
    }
    let t = js::trim(text);
    if let Some(v) = try_parse(t) {
        out.push(v);
        return out;
    }
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(a), Some(b)) = (t.find(open), t.rfind(close))
            && b > a
            && let Some(v) = try_parse(&t[a..=b])
        {
            out.push(v);
            return out;
        }
    }
    out
}

/// JSON 候補を項目の配列に平らにする({items:[…]} / […] / 単一項目のいずれも受ける)
pub fn items_from_candidates(cands: &[Value]) -> Vec<Value> {
    let mut items = Vec::new();
    for c in cands {
        match c {
            Value::Array(a) => items.extend(a.iter().cloned()),
            Value::Object(o) => match o.get("items") {
                Some(Value::Array(a)) => items.extend(a.iter().cloned()),
                _ => items.push(c.clone()),
            },
            _ => {}
        }
    }
    items
}

// ---------- JSON Schema(外部 LLM と人が読む用。検証の正典は上の関数) ----------

fn effect_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "required": ["score", "evidence"],
        "additionalProperties": false,
        "properties": {
            "score": { "type": "integer", "minimum": -2, "maximum": 2, "description": "-2: 逆効果 / 0: 影響なし・使われていない / +2: 大いに役立った" },
            "evidence": { "type": "string", "description": "パケット内の根拠(使われていなければ「参照なし」など)" }
        }
    })
}

pub fn item_json_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "required": ["sessionId", "taskCategory", "taskSummary", "humanEffort", "aiOutcome", "instructionsEffect", "wikiEffect", "skillsAgentsEffect"],
        "additionalProperties": false,
        "properties": {
            "sessionId": { "type": "string", "description": "パケット冒頭の「セッション ID」をそのまま" },
            "taskCategory": { "type": "string", "enum": TASK_CATEGORIES },
            "taskSummary": { "type": "string", "description": "タスクの要約(日本語 1〜2 文)" },
            "humanEffort": {
                "type": "object",
                "required": ["hours", "low", "high", "confidence", "rationale"],
                "additionalProperties": false,
                "description": "同じ成果を熟練した人が AI なしで出す場合の作業時間(low ≤ hours ≤ high)",
                "properties": {
                    "hours": { "type": "number", "minimum": 0 },
                    "low": { "type": "number", "minimum": 0 },
                    "high": { "type": "number", "minimum": 0 },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "rationale": { "type": "string" }
                }
            },
            "aiOutcome": {
                "type": "object",
                "required": ["completed", "quality", "rework", "rationale"],
                "additionalProperties": false,
                "properties": {
                    "completed": { "type": "boolean" },
                    "quality": { "type": "integer", "minimum": 1, "maximum": 5 },
                    "rework": { "type": "integer", "minimum": 0, "maximum": 5, "description": "手戻り・やり直しの多さ(0: なし〜5: 大半がやり直し)" },
                    "rationale": { "type": "string" }
                }
            },
            "instructionsEffect": effect_schema(),
            "wikiEffect": effect_schema(),
            "skillsAgentsEffect": effect_schema(),
            "notes": { "type": "string" },
            "judge": {
                "type": "object",
                "description": "ツールが付ける出所情報(LLM は出力しない)",
                "properties": { "backend": { "type": "string", "enum": BACKENDS }, "model": { "type": ["string", "null"] }, "ranAt": { "type": "string" } }
            }
        }
    })
}

/// JUDGMENTS_JSON_SCHEMA(評価バンドルの schema.json と分割ファイルに載せる)
pub fn judgments_json_schema() -> Value {
    serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "agent-session-atlas judgments.json (schemaVersion 1)",
        "type": "object",
        "required": ["schemaVersion", "judge", "items"],
        "properties": {
            "schemaVersion": { "const": 1 },
            "judge": {
                "type": "object",
                "required": ["backend", "ranAt"],
                "properties": {
                    "backend": { "type": "string", "enum": BACKENDS },
                    "model": { "type": ["string", "null"] },
                    "ranAt": { "type": "string", "description": "ISO 8601" },
                    "usage": { "type": "object" }
                }
            },
            "items": { "type": "array", "items": item_json_schema() },
            "failures": { "type": "array" }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str) -> Value {
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
    fn validates_and_reports_all_problems() {
        let ok = json!({ "schemaVersion": 1, "judge": { "backend": "external", "model": null, "ranAt": "2026-10-28T00:00:00Z" }, "items": [item("a"), item("b")] });
        assert_eq!(validate_judgments(&ok).unwrap().items.len(), 2);
        let mut op = ok.clone();
        op["judge"]["backend"] = json!("opencode");
        assert_eq!(validate_judgments(&op).unwrap().judge.backend, "opencode");
        let mut a1 = item("a");
        a1["humanEffort"] = json!({ "hours": 5, "low": 6, "high": 7, "confidence": 1.5, "rationale": "" });
        let mut a2 = item("a");
        a2["taskCategory"] = json!("nope");
        a2["aiOutcome"] = json!({ "completed": true, "quality": 9, "rework": 0, "rationale": "" });
        let mut bad = ok.clone();
        bad["items"] = json!([a1, a2]);
        let p = validate_judgments(&bad).unwrap_err().problems.join("\n");
        for w in ["low ≤ hours ≤ high を満たす必要があります(6 / 5 / 7)", "confidence", "taskCategory", "quality", "重複"] {
            assert!(p.contains(w), "{w}: {p}");
        }
        let mut v2 = ok.clone();
        v2["schemaVersion"] = json!(2);
        assert!(validate_judgments(&v2).unwrap_err().to_string().contains("schemaVersion"));
        // 正規形はキーの順を固定し、余分なキーを落とす
        let mut extra = item(" c ");
        extra["junk"] = json!(1);
        extra["notes"] = json!("");
        let it = validate_judgment_item(&extra, "item").unwrap();
        assert_eq!(it.session_id, "c");
        assert_eq!(it.notes, None);
    }
}
