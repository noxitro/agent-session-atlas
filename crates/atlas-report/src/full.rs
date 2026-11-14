//! Phase 11: 全文記録(out/full/<id>.md。packages/report/src/full.ts の移植)。上限なしで、events.jsonl の全イベントを時系列に書く。
//! - 除くのは暗号化・不透明データと base64 本体(binary_asset は assets/ に書き出してリンク)だけ。除いた箇所には種別とサイズを書く。
//!   扱いは coverage.rs の表で決め、表に無いキーは「未分類」として末尾に出す
//! - hook の入力に入っているツールの結果がツールの結果と同一なら参照にする
//! - 秘密情報の形式検査(redact_secrets)を全ての文字列に掛け、件数を末尾に出す
//! - チェックポイントと plan.md、data.db の許可列(desktop)も節として出す
//!
//! TS 版は全セッションで 1 つの網羅の集計器を共有し、末尾の「未分類のキー」に、それまでのセッションで出た分も含めていた。
//! Rust 版はセッションを並べて描くので、末尾(検査の節)だけを分けて返し(FullBody と full_tail)、呼び元が順に集計器を足してから書く。

use crate::coverage::{json_len, rule_for, CoverageCounter, Treatment};
use crate::format::{date_time_n, int_n};
use crate::raw_events::{truthy_string, RawEvent};
use crate::transcript::{fence, json_string, number, redact_secrets, rel, safe_name};
use crate::viewer::{encode_uri_component, ext_lower};
use anyhow::{Context, Result};
use atlas_core::classify::is_user_turn;
use atlas_core::js;
use atlas_core::jsdate;
use atlas_core::normalize::{from_usage_record, merge_usage};
use atlas_core::types::{DbUsageRow, SessionRecord};
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

pub struct FullOptions<'a> {
    pub generated_at: &'a str,
    /// 画像などの書き出し先(out/full/assets/<id>)。Markdown からの相対パスは assets_href
    pub assets_dir: PathBuf,
    pub assets_href: String,
    /// スナップショットのセッションフォルダ(plan.md / checkpoints/ など)。無ければ None
    pub session_dir: Option<PathBuf>,
    /// 全文記録から見たセッションフォルダへの相対パス(files/ へのリンク用)
    pub session_dir_href: Option<String>,
    /// data.db の WAL の注意(sessions.json の desktop)
    pub wal_note: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Counted {
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Excluded {
    pub n: u64,
    pub bytes: u64,
}

/// 全文記録の本体(末尾の検査の節の手前まで)と、その集計
pub struct FullBody {
    pub text: String,
    pub events: u64,
    pub secret_hits: u64,
    pub assets: Counted,
    pub excluded: Excluded,
    /// このセッションの本文の中で見つけた未分類のキー(type|key)
    pub unclassified: BTreeSet<String>,
}

pub fn full_file_name(id: &str) -> String {
    format!("{}.md", safe_name(id))
}

/// base64 らしい(復号できない)文字列か。reasoningBlocks の配下にだけ掛ける
pub fn looks_opaque(s: &str) -> bool {
    js::utf16_len(s) >= 100 && !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'_' | b'-'))
}

fn ext_of(mime: &str) -> &'static str {
    match mime {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        "application/pdf" => ".pdf",
        "text/plain" => ".txt",
        _ => ".bin",
    }
}

/// Node の `Buffer.from(s, 'base64')`(URL 用の文字も受け、読めない文字は飛ばし、= で止まる)
pub fn node_base64(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn ms(iso: Option<&Value>) -> Option<i64> {
    match iso {
        Some(Value::String(s)) if !s.is_empty() => jsdate::parse_ms(s),
        _ => None,
    }
}

/// `typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)`
fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        Some(x) => json_string(x),
    }
}

fn hash_of(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(crate::html::node_utf8(s).as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

/// `readdir(dir, { withFileTypes: true, recursive: true })` と同じ順(Node は見つけたフォルダを積み、後から積んだものを先に読む)
fn readdir_recursive(root: &Path) -> std::io::Result<Vec<(PathBuf, atlas_core::jsfs::Dirent)>> {
    let mut result = Vec::new();
    let mut stack = vec![(root.to_path_buf(), atlas_core::jsfs::read_dir(root)?)];
    while let Some((path, entries)) = stack.pop() {
        for d in entries {
            let is_dir = d.is_dir();
            let name = d.name.clone();
            result.push((path.clone(), d));
            if is_dir {
                let p = path.join(&name);
                let sub = atlas_core::jsfs::read_dir(&p)?;
                stack.push((p, sub));
            }
        }
    }
    Ok(result)
}

/// `readFile(p, 'utf8')`
fn read_utf8(p: &Path) -> std::io::Result<String> {
    Ok(String::from_utf8_lossy(&std::fs::read(p)?).into_owned())
}

struct Ctx<'a> {
    secret_hits: u64,
    excluded: Excluded,
    coverage: &'a mut CoverageCounter,
}

impl Ctx<'_> {
    /// 文字列の整形: 秘密情報を伏せる(上限なし)
    fn text(&mut self, s: &str) -> String {
        let (t, n) = redact_secrets(s);
        self.secret_hits += n;
        t
    }

    fn omit(&mut self, what: &str, bytes: i64) -> String {
        self.excluded.n += 1;
        self.excluded.bytes += bytes as u64;
        format!("_(除外: {what}、{} バイト)_", int_n(bytes as f64))
    }

    /// 値を「書ける形」に。秘密情報を伏せる。opaque のとき(reasoningBlocks の配下だけ)は base64 らしい文字列を印に置き換える
    fn sanitize(&mut self, v: &Value, path: &str, opaque: bool, cov: Option<(&str, &str)>) -> Value {
        match v {
            Value::String(s) => {
                if opaque && looks_opaque(s) {
                    let len = js::utf16_len(s) as i64;
                    self.excluded.n += 1;
                    self.excluded.bytes += len as u64;
                    if let Some((t, k)) = cov {
                        self.coverage.add_excluded(t, k, len);
                    }
                    return Value::String(format!("<除外: 不透明データ {len} 文字 ({path})>"));
                }
                Value::String(self.text(s))
            }
            Value::Array(a) => Value::Array(a.iter().enumerate().map(|(i, x)| self.sanitize(x, &format!("{path}[{i}]"), opaque, cov)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), self.sanitize(x, &format!("{path}.{k}"), opaque, cov))).collect()),
            other => other.clone(),
        }
    }

    fn json(&mut self, v: &Value, path: &str, opaque: bool, cov: Option<(&str, &str)>) -> String {
        let s = self.sanitize(v, path, opaque, cov);
        fence(&atlas_core::json::to_js_string_indent(&s, b" ").unwrap_or_default(), "json")
    }

    /// 文字列ならそのまま囲みに、それ以外(配列・オブジェクト・数値)は JSON の囲みに(黙って落とさない)
    fn block(&mut self, l: &mut Lines, label: &str, v: Option<&Value>, path: &str, lang: &str) {
        let Some(v) = v.filter(|v| !v.is_null()) else { return };
        let head = if label.is_empty() { String::new() } else { format!("{label}:") };
        match v {
            Value::String(s) => {
                if !js::trim(s).is_empty() {
                    let t = self.text(s);
                    l.extend([head, String::new(), fence(&t, lang), String::new()]);
                }
            }
            other => {
                let j = self.json(other, path, false, None);
                l.extend([head, String::new(), j, String::new()]);
            }
        }
    }
}

/// `a !== b`(JSON の値。オブジェクトと配列は別の値として扱う)
fn strictly_differs(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => false,
        (Some(Value::Object(_) | Value::Array(_)), _) | (_, Some(Value::Object(_) | Value::Array(_))) => true,
        (Some(x), Some(y)) => match (x, y) {
            (Value::Number(p), Value::Number(q)) => p.as_f64() != q.as_f64(),
            _ => x != y,
        },
        _ => true,
    }
}

/// 全文記録の本体を描く(末尾の検査の節は full_tail)。coverage は空の集計器を渡す(このセッションの分だけを数える)
pub fn render_full_body(r: &SessionRecord, events: &[RawEvent], db_usage: &[DbUsageRow], o: &FullOptions<'_>, coverage: &mut CoverageCounter) -> FullBody {
    let mut c = Ctx { secret_hits: 0, excluded: Excluded::default(), coverage };
    let mut assets = Counted::default();
    let mut unclassified: BTreeSet<String> = BTreeSet::new();
    let mut l = Lines::default();
    let start_ms = r.created_at.as_deref().filter(|s| !s.is_empty()).and_then(jsdate::parse_ms);

    // ---------- 見出し・概要 ----------
    let title = c.text(r.name.as_deref().unwrap_or(&r.id));
    l.extend([format!("# 全文記録: {title}"), String::new()]);
    l.push(format!(
        "生成 {} · agent-session-atlas `atlas export --full` · セッション ID `{}` · イベント {} 件(extract 時)",
        date_time_n(Some(o.generated_at)),
        r.id,
        int_n(r.events.total as f64)
    ));
    l.push(String::new());
    l.extend(["> **解析用の完全出力。** 原本の文字列をそのまま含みます(秘密情報の形式検査で伏せた箇所を除く)。共有しないでください。共有には伏せ字版(`--anonymize`)を使います。".to_string(), String::new()]);
    l.extend(["## 概要".to_string(), String::new()]);
    l.extend(["| 項目 | 値 |".to_string(), "|---|---|".to_string()]);
    let meta: Vec<(&str, String)> = vec![
        ("プロジェクト", r.project.clone()),
        ("クライアント", r.client.clone().unwrap_or_else(|| "不明".into())),
        ("リポジトリ / ブランチ", format!("{} / {}", r.repository.as_deref().unwrap_or("—"), r.branch.as_deref().unwrap_or("—"))),
        ("作業フォルダ", r.cwd.clone().unwrap_or_else(|| "—".into())),
        ("git ルート", r.git_root.clone().unwrap_or_else(|| "—".into())),
        ("Copilot", r.copilot_version.clone().unwrap_or_else(|| "不明".into())),
        ("開始 / 更新", format!("{} / {}", date_time_n(r.created_at.as_deref()), date_time_n(r.updated_at.as_deref()))),
        ("依頼 / 応答", format!("{} / {}", int_n(r.turns as f64), int_n(r.assistant_messages as f64))),
        ("モデル", if r.models.is_empty() { "不明".into() } else { r.models.join("、") }),
        ("記録の出所", r.sources.iter().map(|s| match s { atlas_core::types::SessionSource::Db => "db", atlas_core::types::SessionSource::Dir => "dir" }).collect::<Vec<_>>().join(" + ")),
    ];
    for (k, v) in meta {
        let t = c.text(&v);
        l.push(format!("| {k} | {} |", t.replace('|', "\\|")));
    }
    l.push(String::new());

    // ---------- data.db ----------
    if let Some(d) = r.desktop.as_ref().and_then(|x| x.as_ref()) {
        l.extend(["## デスクトップアプリの記録(data.db、許可リストの列だけ)".to_string(), String::new()]);
        if let Some(w) = o.wal_note.filter(|s| !s.is_empty()) {
            l.extend([format!("> {w}"), String::new()]);
        }
        if let Some(s) = &d.session {
            l.extend(["| 列 | 値 |".to_string(), "|---|---|".to_string()]);
            for (k, v) in s {
                if v.is_null() || v.as_str() == Some("") {
                    continue;
                }
                let t = c.text(&js::to_js_string(v));
                l.push(format!("| {k} | {} |", t.replace('|', "\\|")));
            }
            l.push(String::new());
        }
        if let Some(w) = &d.workspace {
            let j = c.json(&Value::Object(w.clone()), "desktop.workspace", false, None);
            l.extend([format!("workspace: {j}"), String::new()]);
        }
        if let Some(p) = &d.project {
            let j = c.json(&Value::Object(p.clone()), "desktop.project", false, None);
            l.extend([format!("project: {j}"), String::new()]);
        }
        if !d.context_usage.is_empty() {
            let xs: Vec<f64> = d.context_usage.iter().map(|x| number(Some(x.get("current_tokens").filter(|v| !v.is_null()).unwrap_or(&Value::from(0))))).collect();
            let min = xs.iter().copied().fold(f64::INFINITY, |a, x| if x.is_nan() || a.is_nan() { f64::NAN } else { a.min(x) });
            let max = xs.iter().copied().fold(f64::NEG_INFINITY, |a, x| if x.is_nan() || a.is_nan() { f64::NAN } else { a.max(x) });
            let limit = number(Some(d.context_usage[0].get("token_limit").filter(|v| !v.is_null()).unwrap_or(&Value::from(0))));
            l.extend([format!("context usage: {} 点(最小 {} / 最大 {} トークン、上限 {})", int_n(d.context_usage.len() as f64), int_n(min), int_n(max), int_n(limit)), String::new()]);
            let j = c.json(&Value::Array(d.context_usage.iter().cloned().map(Value::Object).collect()), "desktop.contextUsage", false, None);
            l.extend([j, String::new()]);
        }
        if !d.checkpoints.is_empty() {
            let j = c.json(&Value::Array(d.checkpoints.iter().cloned().map(Value::Object).collect()), "desktop.checkpoints", false, None);
            l.extend([format!("checkpoints(git のコミット): {j}"), String::new()]);
        }
        if !d.activity.is_empty() {
            let j = c.json(&Value::Array(d.activity.iter().cloned().map(Value::Object).collect()), "desktop.activity", false, None);
            l.extend([format!("activity: {j}"), String::new()]);
        }
    }

    // ---------- 経過 ----------
    l.extend(["## 経過(全イベント)".to_string(), String::new()]);
    l.extend([
        "時刻は開始からの相対(+時:分:秒)。各イベントは種別・id・親 id・agentId を 1 行に、本文と引数・結果は囲みに書きます。除外した箇所は「除外: 種別、バイト数」。".to_string(),
        String::new(),
    ]);

    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut result_hashes: HashMap<String, String> = HashMap::new();
    let mut agent_name: HashMap<String, String> = HashMap::new();
    let mut turn_no = 0i64;
    let mut event_count = 0u64;
    let mut first_ms: Option<i64> = None;
    let mut usage_records = Vec::new();
    let empty = Map::new();

    for e in events {
        event_count += 1;
        c.coverage.add(e);
        if e.kind() == "session.usage_record"
            && let Some(u) = from_usage_record(&e.to_copilot_event())
        {
            usage_records.push(u);
        }
        if first_ms.is_none() {
            first_ms = ms(e.get("timestamp"));
        }
        let d: &Map<String, Value> = e.get("data").and_then(Value::as_object).unwrap_or(&empty);
        let mut used: HashSet<&str> = HashSet::new();
        let kind = e.kind();
        let base_ms = start_ms.or(first_ms);
        let head = |l: &mut Lines, label: &str, agent_name: &HashMap<String, String>| {
            let mut ids: Vec<String> = Vec::new();
            if let Some(id) = truthy_string(e.get("id")) {
                ids.push(format!("id {}", js::utf16_slice(&id, 0, 8)));
            }
            if let Some(p) = truthy_string(e.get("parentId")) {
                ids.push(format!("parent {}", js::utf16_slice(&p, 0, 8)));
            }
            if let Some(a) = truthy_string(e.get("agentId")) {
                ids.push(format!("agent {}{}", js::utf16_slice(&a, 0, 8), agent_name.get(&a).filter(|n| !n.is_empty()).map(|n| format!(" ({n})")).unwrap_or_default()));
            }
            l.push(format!("- {} **{kind}** {label}{}", rel(base_ms, ms(e.get("timestamp"))), if ids.is_empty() { String::new() } else { format!(" <small>{}</small>", ids.join(" · ")) }));
        };
        let dstr = |k: &str| d.get(k).and_then(Value::as_str);
        match kind {
            "user.message" => {
                if truthy_string(e.get("agentId")).is_none() && is_user_turn(e.get("data")) {
                    turn_no += 1;
                    l.extend([String::new(), format!("### 依頼 {turn_no}({})", rel(base_ms, ms(e.get("timestamp")))), String::new()]);
                }
                head(&mut l, &dstr("agentMode").map(|m| format!("モード {m}")).unwrap_or_default(), &agent_name);
                if d.contains_key("content") {
                    used.insert("content");
                    c.block(&mut l, "", d.get("content"), "content", "");
                }
                if d.contains_key("transformedContent") {
                    used.insert("transformedContent");
                    if strictly_differs(d.get("transformedContent"), d.get("content")) {
                        c.block(&mut l, "transformedContent(添付等を展開した版)", d.get("transformedContent"), "transformedContent", "");
                    } else {
                        l.push("  <small>transformedContent は content と同じ</small>".into());
                    }
                }
                if let Some(a) = d.get("supportedNativeDocumentMimeTypes").and_then(Value::as_array) {
                    used.insert("supportedNativeDocumentMimeTypes");
                    l.push(format!("  <small>supportedNativeDocumentMimeTypes: {} 種</small>", a.len()));
                }
            }
            "assistant.message" => {
                let model = dstr("model").unwrap_or("");
                head(
                    &mut l,
                    &format!(
                        "{}{}",
                        if model.is_empty() { String::new() } else { format!("モデル {model} ") },
                        if d.get("outputTokens").is_some_and(|v| !v.is_null()) { format!("出力 {} トークン", int_n(number(d.get("outputTokens")))) } else { String::new() }
                    ),
                    &agent_name,
                );
                if d.contains_key("content") {
                    used.insert("content");
                    c.block(&mut l, "", d.get("content"), "content", "");
                }
                if d.contains_key("reasoningText") {
                    used.insert("reasoningText");
                    c.block(&mut l, "reasoningText", d.get("reasoningText"), "reasoningText", "");
                }
                if let Some(rb) = d.get("reasoningBlocks") {
                    used.insert("reasoningBlocks");
                    let n = rb.as_array().map(Vec::len);
                    if n != Some(0) {
                        let j = c.json(rb, "reasoningBlocks", true, Some((kind, "reasoningBlocks")));
                        l.extend([format!("reasoningBlocks{}:", n.map(|n| format!("({n} 件。不透明な値は除外の印)")).unwrap_or_default()), String::new(), j, String::new()]);
                    }
                }
                if let Some(tr) = d.get("toolRequests") {
                    used.insert("toolRequests");
                    if let Some(a) = tr.as_array() {
                        if !a.is_empty() {
                            let j = c.json(tr, "toolRequests", false, None);
                            l.extend([format!("toolRequests({} 件):", a.len()), String::new(), j, String::new()]);
                        }
                        for t in a {
                            if let (Some(call), Some(name)) = (truthy_string(t.get("toolCallId")), truthy_string(t.get("name"))) {
                                tool_names.insert(call, name);
                            }
                        }
                    } else {
                        c.block(&mut l, "toolRequests", Some(tr), "toolRequests", "");
                    }
                }
                if let Some(x) = d.get("encryptedContent") {
                    used.insert("encryptedContent");
                    let s = c.omit("encryptedContent: 暗号化された本文", json_len(x));
                    l.push(format!("  {s}"));
                }
                if let Some(x) = d.get("reasoningOpaque") {
                    used.insert("reasoningOpaque");
                    let s = c.omit("reasoningOpaque: 不透明な推論データ", json_len(x));
                    l.push(format!("  {s}"));
                }
            }
            "tool.execution_start" => {
                let name = str_of(d.get("toolName"));
                let call = dstr("toolCallId").unwrap_or("");
                if !call.is_empty() {
                    tool_names.insert(call.to_string(), name.clone());
                }
                head(
                    &mut l,
                    &format!(
                        "`{name}`{}{}",
                        dstr("mcpServerName").filter(|s| !s.is_empty()).map(|s| format!(" (MCP {s})")).unwrap_or_default(),
                        if call.is_empty() { String::new() } else { format!(" call {}", js::utf16_slice(call, 0, 8)) }
                    ),
                    &agent_name,
                );
                used.insert("toolName");
                if let Some(a) = d.get("arguments") {
                    used.insert("arguments");
                    let j = c.json(a, "arguments", false, None);
                    l.extend([String::new(), j, String::new()]);
                }
            }
            "tool.execution_complete" => {
                let call = dstr("toolCallId").unwrap_or("");
                let name = tool_names.get(call).cloned().unwrap_or_else(|| str_of(d.get("toolName")));
                head(
                    &mut l,
                    &format!("`{name}` {}{}", if d.get("success") == Some(&Value::Bool(false)) { "✖ 失敗" } else { "✔" }, if call.is_empty() { String::new() } else { format!(" call {}", js::utf16_slice(call, 0, 8)) }),
                    &agent_name,
                );
                let key = if call.is_empty() { name.clone() } else { call.to_string() };
                if let Some(res) = d.get("result").filter(|v| !v.is_null()) {
                    used.insert("result");
                    let (text, detailed, extra) = match res {
                        Value::String(s) => (Some(s.as_str()), None, None),
                        Value::Object(o) => {
                            let text = o.get("content").and_then(Value::as_str);
                            let detailed = o.get("detailedContent").and_then(Value::as_str);
                            let extra: Map<String, Value> = o.iter().filter(|(k, _)| !((k.as_str() == "content" && text.is_some()) || (k.as_str() == "detailedContent" && detailed.is_some()))).map(|(k, v)| (k.clone(), v.clone())).collect();
                            (text, detailed, if extra.is_empty() { None } else { Some(extra) })
                        }
                        _ => (None, None, None),
                    };
                    if text.is_some() || detailed.is_some() {
                        // content と detailedContent は両方出す(同じなら 1 回だけ書いて同一と記す)
                        match (text, detailed) {
                            (Some(t), Some(dt)) if t == dt => {
                                result_hashes.insert(hash_of(t), key.clone());
                                let x = c.text(t);
                                l.extend(["result(content と detailedContent は同一):".to_string(), String::new(), fence(&x, ""), String::new()]);
                            }
                            _ => {
                                if let Some(t) = text {
                                    result_hashes.insert(hash_of(t), key.clone());
                                    let x = c.text(t);
                                    l.extend([if detailed.is_some() { "result.content:" } else { "result:" }.to_string(), String::new(), fence(&x, ""), String::new()]);
                                }
                                if let Some(dt) = detailed {
                                    result_hashes.insert(hash_of(dt), key.clone());
                                    let x = c.text(dt);
                                    l.extend(["result.detailedContent:".to_string(), String::new(), fence(&x, ""), String::new()]);
                                }
                            }
                        }
                        if let Some(x) = extra {
                            let j = c.json(&Value::Object(x), "result", false, None);
                            l.extend(["result(他の項目):".to_string(), String::new(), j, String::new()]);
                        }
                    } else {
                        c.block(&mut l, "result", Some(res), "result", "");
                    }
                }
                if let Some(err) = d.get("error").filter(|v| !v.is_null()) {
                    used.insert("error");
                    c.block(&mut l, "error", Some(err), "error", "");
                }
            }
            "hook.start" => {
                head(&mut l, &format!("{}{}", str_of(d.get("hookType")), dstr("hookInvocationId").map(|h| format!(" {}", js::utf16_slice(h, 0, 8))).unwrap_or_default()), &agent_name);
                if let Some(input) = d.get("input") {
                    used.insert("input");
                    if let Value::Object(o) = input {
                        let mut inp = o.clone();
                        if let Some(Value::Object(tr)) = inp.get("toolResult") {
                            let mut t = tr.clone();
                            for k in ["textResultForLlm", "sessionLog"] {
                                if let Some(Value::String(v)) = t.get(k)
                                    && let Some(call) = result_hashes.get(&hash_of(v))
                                {
                                    let s = format!("<ツールの結果と同一: call {call} ({} 文字)>", js::utf16_len(v));
                                    t.insert(k.to_string(), Value::String(s));
                                }
                            }
                            inp.insert("toolResult".into(), Value::Object(t));
                        }
                        let j = c.json(&Value::Object(inp), "hook.input", false, None);
                        l.extend(["input:".to_string(), String::new(), j, String::new()]);
                    } else {
                        c.block(&mut l, "input", Some(input), "hook.input", "");
                    }
                }
            }
            "hook.end" => {
                head(&mut l, &format!("{} {}", str_of(d.get("hookType")), if d.get("success") == Some(&Value::Bool(false)) { "✖" } else { "✔" }), &agent_name);
            }
            "system.message" => {
                head(&mut l, &format!("role {}", str_of(d.get("role"))), &agent_name);
                if d.contains_key("content") {
                    used.insert("content");
                    c.block(&mut l, "", d.get("content"), "content", "");
                }
            }
            "skill.invoked" => {
                head(&mut l, &format!("`{}`{}", str_of(d.get("name")), dstr("trigger").map(|t| format!(" ({t})")).unwrap_or_default()), &agent_name);
                if d.contains_key("content") {
                    used.insert("content");
                    c.block(&mut l, "本文", d.get("content"), "content", "markdown");
                }
            }
            "session.binary_asset" => {
                head(
                    &mut l,
                    &format!("{} {}", str_of(d.get("mimeType")), if d.get("byteLength").is_some_and(|v| !v.is_null()) { format!("{} バイト", int_n(number(d.get("byteLength")))) } else { String::new() }),
                    &agent_name,
                );
                if let Some(data) = dstr("data") {
                    used.insert("data");
                    let id = match dstr("assetId").filter(|s| !s.is_empty()) {
                        Some(a) => safe_name(a),
                        None => format!("asset-{}", assets.files + 1),
                    };
                    let file = format!("{id}{}", ext_of(&str_of(d.get("mimeType"))));
                    let len = js::utf16_len(data) as i64;
                    let buf = node_base64(data);
                    let written = std::fs::create_dir_all(&o.assets_dir).and_then(|_| std::fs::write(o.assets_dir.join(&file), &buf));
                    match written {
                        Ok(()) => {
                            assets.files += 1;
                            assets.bytes += buf.len() as u64;
                            let s = c.omit("data: base64 の本体(ファイルに書き出した)", len);
                            l.push(format!("  {s} → [{file}]({}/{file})", o.assets_href));
                        }
                        Err(err) => {
                            let s = c.omit(&format!("data: base64 の本体(書き出せなかった: {err})"), len);
                            l.push(format!("  {s}"));
                        }
                    }
                }
            }
            "session.compaction_complete" => {
                head(
                    &mut l,
                    &format!(
                        "{}{}",
                        if d.get("success") == Some(&Value::Bool(false)) { "失敗" } else { "完了" },
                        match d.get("checkpointNumber").filter(|v| !v.is_null()) {
                            Some(v) => format!("、チェックポイント {}(下の節)", js::to_js_string(v)),
                            None => String::new(),
                        }
                    ),
                    &agent_name,
                );
                if d.contains_key("summaryContent") {
                    used.insert("summaryContent");
                    c.block(&mut l, "要約", d.get("summaryContent"), "summaryContent", "");
                }
            }
            "subagent.started" => {
                if let (Some(a), Some(n)) = (truthy_string(e.get("agentId")), dstr("agentName")) {
                    agent_name.insert(a, n.to_string());
                }
                head(&mut l, &format!("`{}`", str_of(d.get("agentName"))), &agent_name);
            }
            _ => head(&mut l, "", &agent_name),
        }
        // 残りのキー(特別扱いしなかったもの)を扱いに従って出す
        let mut full_keys: Map<String, Value> = Map::new();
        let mut refs: Vec<String> = Vec::new();
        for (k, v) in d {
            if used.contains(k.as_str()) {
                continue;
            }
            let rule = rule_for(kind, k);
            let bytes = json_len(v);
            match rule {
                None => {
                    unclassified.insert(format!("{kind}|{k}"));
                    full_keys.insert(k.clone(), v.clone());
                }
                Some(r) if r.treatment == Treatment::Excluded => {
                    let s = c.omit(&format!("{k}: {}", r.reason.unwrap_or("")), bytes);
                    l.push(format!("  {s}"));
                }
                Some(r) if r.treatment == Treatment::Ref => {
                    let shown = match v {
                        Value::String(s) => js::utf16_slice(&c.text(s), 0, 40).into_owned(),
                        Value::Array(a) => format!("[{}]", a.len()),
                        Value::Object(_) | Value::Null => "{…}".into(),
                        other => js::to_js_string(other),
                    };
                    refs.push(format!("{k}={shown}"));
                }
                Some(_) => {
                    full_keys.insert(k.clone(), v.clone());
                }
            }
        }
        if !refs.is_empty() {
            l.push(format!("  <small>{}</small>", refs.join(" · ")));
        }
        if !full_keys.is_empty() {
            let j = c.json(&Value::Object(full_keys), kind, false, None);
            l.extend([String::new(), j, String::new()]);
        }
    }
    l.push(String::new());

    // ---------- 明細の件数 ----------
    let (usage, _) = merge_usage(db_usage, usage_records);
    l.extend(["## 明細".to_string(), String::new()]);
    l.extend([format!("- リクエスト単位の明細: {} 件(session-store.db と usage_record)", int_n(usage.len() as f64)), format!("- イベント: {} 件", int_n(event_count as f64)), String::new()]);

    // ---------- セッションフォルダの付随物 ----------
    if let Some(dir) = o.session_dir.as_deref().filter(|d| d.exists()) {
        let plan = dir.join("plan.md");
        if plan.exists()
            && let Ok(t) = read_utf8(&plan)
        {
            let x = c.text(&t);
            l.extend(["## plan.md".to_string(), String::new(), fence(&x, "markdown"), String::new()]);
        }
        let cps = dir.join("checkpoints");
        if cps.exists() {
            let mut names: Vec<String> = atlas_core::jsfs::read_dir_names(&cps).unwrap_or_default().into_iter().filter(|f| js::to_lower(f).ends_with(".md")).collect();
            names.sort_by(|a, b| js::cmp_utf16(a, b));
            if !names.is_empty() {
                l.extend(["## チェックポイント(checkpoints/)".to_string(), String::new()]);
                for f in &names {
                    let t = read_utf8(&cps.join(f)).unwrap_or_default();
                    let x = c.text(&t);
                    l.extend([format!("### {f}"), String::new(), fence(&x, "markdown"), String::new()]);
                }
            }
        }
        for sub in ["files", "rewind-file-snapshots", "policies"] {
            let sd = dir.join(sub);
            if !sd.exists() {
                continue;
            }
            let ents: Vec<(PathBuf, atlas_core::jsfs::Dirent)> = readdir_recursive(&sd).unwrap_or_default().into_iter().filter(|(_, x)| x.is_file()).collect();
            if ents.is_empty() {
                continue;
            }
            l.extend([format!("## {sub}/({} ファイル)", int_n(ents.len() as f64)), String::new()]);
            let base_len = dir.to_string_lossy().encode_utf16().count();
            for (parent, x) in &ents {
                let p = parent.join(&x.name);
                let ps = p.to_string_lossy();
                let relp = js::utf16_slice(&ps, base_len + 1, usize::MAX).replace('\\', "/");
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                let link = match &o.session_dir_href {
                    Some(h) => format!("[{relp}]({h}/{})", relp.split('/').map(encode_uri_component).collect::<Vec<_>>().join("/")),
                    None => format!("`{relp}`"),
                };
                l.push(format!("- {link}({} バイト)", int_n(size as f64)));
                if sub == "policies" && ext_lower_exact(&x.name) == ".json" && size < 64 * 1024 {
                    let t = read_utf8(&p).unwrap_or_default();
                    let xx = c.text(&t);
                    l.extend([String::new(), fence(&xx, "json"), String::new()]);
                }
            }
            l.push(String::new());
        }
    }

    let mut text = l.0;
    text.push('\n');
    FullBody { text, events: event_count, secret_hits: c.secret_hits, assets, excluded: c.excluded, unclassified }
}

/// path.extname(大文字小文字はそのまま)
fn ext_lower_exact(name: &str) -> String {
    let lower = ext_lower(name);
    if lower.is_empty() { lower } else { name[name.len() - lower.len()..].to_string() }
}

/// 末尾の検査の節。uc は未分類のキー(並べ替え済み)
pub fn full_tail(secret_hits: u64, excluded: Excluded, assets: Counted, uc: &[String]) -> String {
    let lines = [
        "## 検査".to_string(),
        String::new(),
        format!("- 秘密情報の形式検査: {}", if secret_hits > 0 { format!("{} 件を伏せました(`[伏せました: 種類]`)", int_n(secret_hits as f64)) } else { "該当なし".into() }),
        format!("- 除外した箇所: {}({} バイト。暗号化・不透明データと base64 本体だけ)", int_n(excluded.n as f64), int_n(excluded.bytes as f64)),
        format!("- 書き出した画像など: {} ファイル({} バイト)", int_n(assets.files as f64), int_n(assets.bytes as f64)),
        format!("- 未分類のキー(扱いの表に無く、そのまま全文に出したもの): {}", if uc.is_empty() { "無し".to_string() } else { uc.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join("、") }),
        String::new(),
    ];
    let mut s = lines.join("\n");
    s.push('\n');
    s
}

/// 行を改行でつないで溜める(TS 版の行の配列と join の代わり。行の配列と join した文字列を同時に持たない)
#[derive(Default)]
struct Lines(String, bool);

impl Lines {
    fn push(&mut self, line: String) {
        if self.1 {
            self.0.push('\n');
        }
        self.1 = true;
        self.0.push_str(&line);
    }

    fn extend<const N: usize>(&mut self, lines: [String; N]) {
        for x in lines {
            self.push(x);
        }
    }
}

fn tmp_of(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.tmp", path.display()))
}

/// 本体を <path>.tmp に書く(失敗したら tmp を消す)
pub fn write_full_body(path: &Path, body: &str) -> Result<()> {
    let tmp = tmp_of(path);
    if let Err(e) = crate::html::write_text(&tmp, body) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("{} を書けません", tmp.display()));
    }
    Ok(())
}

/// <path>.tmp に末尾を足して <path> に rename する(途中で失敗した壊れた記録を残さない)
pub fn finish_full_file(path: &Path, tail: &str) -> Result<()> {
    let tmp = tmp_of(path);
    let r = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&tmp)?;
        f.write_all(crate::html::node_utf8(tail).as_bytes())?;
        f.flush()?;
        drop(f);
        atlas_core::fs_retry::rename_replacing(&tmp, path)
    })();
    if let Err(e) = r {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("{} を書けません", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_and_base64() {
        assert!(looks_opaque(&"A".repeat(100)));
        assert!(!looks_opaque(&"A".repeat(99)));
        assert!(!looks_opaque(&format!("{} x", "A".repeat(100))));
        assert_eq!(node_base64("aGVsbG8="), b"hello");
        assert_eq!(node_base64("aGVs bG8"), b"hello");
        assert_eq!(node_base64("_-8"), vec![0xff, 0xef]);
    }
}
