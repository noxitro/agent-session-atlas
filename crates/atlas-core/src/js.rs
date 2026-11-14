//! JavaScript の値と文字列の扱いを TS 版とそろえる小さな道具(移植した各モジュールが共用する)。
//!
//! - 文字列の長さ・切り出しは UTF-16 の単位で数える(`.length`・`slice`)。
//!   サロゲートペアの途中で切ると JS では片割れ(lone surrogate)が残り、`JSON.stringify` は `\ud83d` のように書く。
//!   Rust の String は片割れを持てないので、片割れは私用領域の文字 U+10F800〜U+10FFFF に置き換えて持ち、
//!   JSON に書くとき(json.rs)に `\udXXX` に戻す。長さを数えるときは 1 単位と数える。
//! - `trim` と正規表現の `\s` は JS の空白(U+FEFF を含み、U+0085 を含まない)。
//! - `String(v)` と真偽(truthy)、数値の取り出し(`typeof v === 'number'`)。

use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use std::borrow::Cow;

// ---------- 空白 ----------

/// JS の `String#trim` と正規表現の `\s` が空白とみなす文字
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `s.trim()`
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `s.trimEnd()`
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// 正規表現の中で JS の `\s` の代わりに使う文字クラス(regex クレートの `\s` は U+0085 を含み U+FEFF を含まない)
pub const RE_S: &str = r"[\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
/// JS の `\S`
pub const RE_NOT_S: &str = r"[^\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
/// JS の `.`(`/s` なし。改行・復帰・U+2028・U+2029 以外)
pub const RE_DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

// ---------- UTF-16 の単位 ----------

/// サロゲートの片割れを置き換える私用領域の先頭(U+D800 → U+10F800 … U+DFFF → U+10FFFF)
pub const LONE_BASE: u32 = 0x10F800;

/// サロゲートの片割れ(0xD800〜0xDFFF)を表す文字
pub fn lone_surrogate_char(unit: u16) -> char {
    char::from_u32(LONE_BASE + (unit as u32 - 0xD800)).expect("私用領域の文字")
}

/// 片割れを表す文字なら、その UTF-16 の単位
pub fn lone_surrogate_unit(c: char) -> Option<u16> {
    let v = c as u32;
    (v >= LONE_BASE).then(|| (v - LONE_BASE + 0xD800) as u16)
}

/// 1 文字が UTF-16 で何単位か(片割れは 1)
fn units_of(c: char) -> usize {
    let v = c as u32;
    if (0x10000..LONE_BASE).contains(&v) { 2 } else { 1 }
}

/// `s.length`
pub fn utf16_len(s: &str) -> usize {
    if s.is_ascii() {
        return s.len();
    }
    s.chars().map(units_of).sum()
}

/// サロゲートペアの文字の高い方・低い方の単位
fn pair_units(c: char) -> (u16, u16) {
    let mut buf = [0u16; 2];
    let e = c.encode_utf16(&mut buf);
    (e[0], e[1])
}

/// `s.slice(start, end)`(start・end は UTF-16 の単位。JS と同じく範囲外は詰める)
pub fn utf16_slice(s: &str, start: usize, end: usize) -> Cow<'_, str> {
    if s.is_ascii() {
        let e = end.min(s.len());
        let b = start.min(e);
        return Cow::Borrowed(&s[b..e]);
    }
    if start >= end {
        return Cow::Borrowed("");
    }
    let mut pos = 0usize;
    let mut out: Option<String> = None;
    let mut first_byte: Option<usize> = None;
    let mut last_byte = 0usize;
    for (bi, c) in s.char_indices() {
        let w = units_of(c);
        let (a, b) = (pos, pos + w);
        pos = b;
        if b <= start {
            continue;
        }
        if a >= end {
            break;
        }
        if a >= start && b <= end {
            // 丸ごと入る
            match &mut out {
                Some(o) => o.push(c),
                None => {
                    if first_byte.is_none() {
                        first_byte = Some(bi);
                    }
                    last_byte = bi + c.len_utf8();
                }
            }
            continue;
        }
        // サロゲートペアの途中で切れる: 入る方の片割れだけを残す
        let (hi, lo) = pair_units(c);
        let o = out.get_or_insert_with(|| first_byte.map(|f| s[f..last_byte].to_string()).unwrap_or_default());
        if a < start {
            o.push(lone_surrogate_char(lo));
        } else {
            o.push(lone_surrogate_char(hi));
        }
    }
    match out {
        Some(o) => Cow::Owned(o),
        None => match first_byte {
            Some(f) => Cow::Borrowed(&s[f..last_byte]),
            None => Cow::Borrowed(""),
        },
    }
}

/// `s.length > n ? s.slice(0, n) : s`
pub fn head(s: &str, n: usize) -> Cow<'_, str> {
    if s.len() <= n {
        return Cow::Borrowed(s);
    }
    utf16_slice(s, 0, n)
}

/// `s.length > n ? s.slice(s.length - n) : s`
pub fn tail(s: &str, n: usize) -> Cow<'_, str> {
    if s.len() <= n {
        return Cow::Borrowed(s);
    }
    let len = utf16_len(s);
    if len <= n { Cow::Borrowed(s) } else { utf16_slice(s, len - n, len) }
}

/// コードポイントの数(`[...s].length`。片割れも 1 つ)
pub fn code_points(s: &str) -> usize {
    s.chars().count()
}

/// JS の文字列の比べ方(`a < b`。UTF-16 の単位の順)
pub fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    let to_units = |s: &str| -> Vec<u16> {
        let mut v = Vec::with_capacity(s.len());
        for c in s.chars() {
            if let Some(u) = lone_surrogate_unit(c) {
                v.push(u);
            } else {
                let mut buf = [0u16; 2];
                v.extend_from_slice(c.encode_utf16(&mut buf));
            }
        }
        v
    };
    if a.is_ascii() && b.is_ascii() {
        return a.cmp(b);
    }
    to_units(a).cmp(&to_units(b))
}

/// `s.toLowerCase()`(JS と同じく、文脈に依らない Unicode の小文字化。片割れはそのまま)
pub fn to_lower(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    // Rust の to_lowercase は語末のシグマ(Σ → ς)を JS と同じく文脈で扱う
    s.to_lowercase()
}

// ---------- 数値 ----------

/// JS の `Number#toString`
pub fn num_to_string(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if v == 0.0 {
        return "0".into();
    }
    let mut buf = ryu_js::Buffer::new();
    buf.format_finite(v).to_string()
}

/// `Math.round(x)`(0.5 は +∞ の方へ)
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `typeof v === 'number' && Number.isFinite(v)` なら数値
pub fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    }
}

/// `typeof v === 'number'`(JSON の数値は常に有限)
pub fn is_num(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Number(_)))
}

/// 数値として足し算に使う値(`v ?? 0` の v が数値のとき)。数値でなければ None
pub fn as_f64(v: &Value) -> Option<f64> {
    v.as_f64()
}

// ---------- 値 ----------

/// `v ?? x` の v が null・undefined でないか
pub fn present(v: Option<&Value>) -> Option<&Value> {
    match v {
        None | Some(Value::Null) => None,
        Some(x) => Some(x),
    }
}

/// `typeof v === 'string'` なら文字列
pub fn str_of(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// JS の真偽(`!!v`)
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `String(v)`
pub fn to_js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { to_js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// オブジェクトのキーに使うときの文字列(`obj[v]`)。null・undefined は呼ぶ側で除く
pub fn key_of(v: &Value) -> String {
    to_js_string(v)
}

/// `v ?? fallback` を文字列のキーにしたもの(`inc(map, v ?? '(unknown)')`)
pub fn key_or(v: Option<&Value>, fallback: &str) -> String {
    match present(v) {
        Some(x) => key_of(x),
        None => fallback.to_string(),
    }
}

/// `v ?? null` を文字列として持つ(文字列でない値は `String(v)`。記録には文字列しか現れない)
pub fn string_or_null(v: Option<&Value>) -> Option<String> {
    present(v).map(|x| match x {
        Value::String(s) => s.clone(),
        other => to_js_string(other),
    })
}

/// JSON の 1 行を `JSON.parse` と同じように読む。
/// serde_json はサロゲートの片割れ(`"\ud83d"`)を受け付けないので、そのときは片割れを私用領域の文字に置き換えて読み直す
pub fn parse_json(text: &str) -> Result<Value, serde_json::Error> {
    parse_json_as(text)
}

pub fn parse_json_as<T: DeserializeOwned>(text: &str) -> Result<T, serde_json::Error> {
    match serde_json::from_str::<T>(text) {
        Ok(v) => Ok(v),
        Err(e) => {
            if text.contains("\\u") {
                if let Some(fixed) = replace_lone_surrogate_escapes(text) {
                    if let Ok(v) = serde_json::from_str::<T>(&fixed) {
                        return Ok(v);
                    }
                }
            }
            Err(e)
        }
    }
}

/// JSON の文字列の中の `\uD800`〜`\uDFFF` の片割れを、私用領域の文字(のサロゲートペアの書き方)に書き換える。書き換えが無ければ None
fn replace_lone_surrogate_escapes(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let hex = |i: usize| -> Option<u16> {
        let s = text.get(i..i + 4)?;
        u16::from_str_radix(s, 16).ok().filter(|_| s.bytes().all(|c| c.is_ascii_hexdigit()))
    };
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    let mut in_str = false;
    let mut i = 0usize;
    let mut last = 0usize;
    while i < b.len() {
        let c = b[i];
        if !in_str {
            if c == b'"' {
                in_str = true;
            }
            i += 1;
            continue;
        }
        if c == b'"' {
            in_str = false;
            i += 1;
            continue;
        }
        if c != b'\\' {
            i += 1;
            continue;
        }
        // エスケープ
        if b.get(i + 1) != Some(&b'u') {
            i += 2;
            continue;
        }
        let Some(u) = hex(i + 2) else {
            i += 2;
            continue;
        };
        if (0xD800..=0xDBFF).contains(&u) {
            // 続きが低い方の \uXXXX ならペア
            if b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') {
                if let Some(u2) = hex(i + 8) {
                    if (0xDC00..=0xDFFF).contains(&u2) {
                        i += 12;
                        continue;
                    }
                }
            }
        } else if !(0xDC00..=0xDFFF).contains(&u) {
            i += 6;
            continue;
        }
        // 片割れ
        out.push_str(&text[last..i]);
        let ch = lone_surrogate_char(u);
        let mut buf = [0u16; 2];
        for unit in ch.encode_utf16(&mut buf) {
            out.push_str(&format!("\\u{unit:04x}"));
        }
        changed = true;
        i += 6;
        last = i;
    }
    if !changed {
        return None;
    }
    out.push_str(&text[last..]);
    Some(out)
}

// ---------- オブジェクト(キーの順) ----------

/// JS のオブジェクト(`Record<string, V>`)。キーは足した順に並ぶが、配列の添字の形のキー("0"・"12" など)は
/// JS と同じく先に数の順で並ぶ(`JSON.stringify` の順)
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(transparent)]
pub struct JsMap<V>(pub IndexMap<String, V>);

impl<V> Default for JsMap<V> {
    fn default() -> Self {
        JsMap(IndexMap::new())
    }
}

impl<V> std::ops::Deref for JsMap<V> {
    type Target = IndexMap<String, V>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<V> std::ops::DerefMut for JsMap<V> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl<V> JsMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    /// JS の `Object.keys` の順(添字の形のキーが先)
    pub fn js_keys(&self) -> Vec<&String> {
        let mut idx: Vec<(u32, &String)> = Vec::new();
        let mut rest: Vec<&String> = Vec::new();
        for k in self.0.keys() {
            match array_index(k) {
                Some(n) => idx.push((n, k)),
                None => rest.push(k),
            }
        }
        if idx.is_empty() {
            return rest;
        }
        idx.sort_by_key(|x| x.0);
        idx.into_iter().map(|x| x.1).chain(rest).collect()
    }

    /// `Object.entries` の順
    pub fn js_entries(&self) -> Vec<(&String, &V)> {
        self.js_keys().into_iter().map(|k| (k, &self.0[k])).collect()
    }
}

impl JsMap<i64> {
    /// `map[key] = (map[key] ?? 0) + by`
    pub fn inc(&mut self, key: &str, by: i64) {
        *self.0.entry(key.to_string()).or_insert(0) += by;
    }
}

impl JsMap<f64> {
    pub fn add(&mut self, key: &str, by: f64) {
        *self.0.entry(key.to_string()).or_insert(0.0) += by;
    }
}

/// 配列の添字の形のキー(0〜2^32-2 の正規の 10 進表記)
pub fn array_index(k: &str) -> Option<u32> {
    let b = k.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) || (b.len() > 1 && b[0] == b'0') {
        return None;
    }
    let n: u64 = k.parse().ok()?;
    (n <= 4_294_967_294).then_some(n as u32)
}

impl<V: Serialize> Serialize for JsMap<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(self.0.len()))?;
        if self.0.keys().any(|k| array_index(k).is_some()) {
            for k in self.js_keys() {
                m.serialize_entry(k, &self.0[k])?;
            }
        } else {
            for (k, v) in &self.0 {
                m.serialize_entry(k, v)?;
            }
        }
        m.end()
    }
}

/// `undefined`(キーが無い)と `null` を分けて持つ項目の読み書き(`Option<Option<T>>`。外の None はキーを書かない)。
/// `#[serde(default, skip_serializing_if = "Option::is_none", with = "crate::js::double_option")]` で使う
pub mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer, T: Serialize>(v: &Option<Option<T>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utf16_slices() {
        let s = "a😀b";
        assert_eq!(utf16_len(s), 4);
        assert_eq!(utf16_slice(s, 0, 3), "a😀");
        let cut = utf16_slice(s, 0, 2);
        assert_eq!(utf16_len(&cut), 2);
        assert_eq!(lone_surrogate_unit(cut.chars().nth(1).unwrap()), Some(0xD83D));
        let t = tail(s, 2);
        assert_eq!(lone_surrogate_unit(t.chars().next().unwrap()), Some(0xDE00));
        assert_eq!(head("日本語", 2), "日本");
        assert_eq!(head("abc", 5), "abc");
    }

    #[test]
    fn js_strings() {
        assert_eq!(to_js_string(&json!(1.0)), "1");
        assert_eq!(to_js_string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(to_js_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(0.49999999999999994), 0.0);
    }

    #[test]
    fn lone_surrogates_in_json() {
        let v = parse_json(r#"{"a":"x\ud83d","b":"😀","c":"\\ud83d"}"#).unwrap();
        let a = v["a"].as_str().unwrap();
        assert_eq!(lone_surrogate_unit(a.chars().nth(1).unwrap()), Some(0xD83D));
        assert_eq!(v["b"], "😀");
        assert_eq!(v["c"], "\\ud83d");
        assert_eq!(crate::json::to_js_string(&v).unwrap(), r#"{"a":"x\ud83d","b":"😀","c":"\\ud83d"}"#);
    }

    #[test]
    fn js_map_order() {
        let mut m: JsMap<i64> = JsMap::new();
        m.inc("b", 1);
        m.inc("10", 1);
        m.inc("a", 1);
        m.inc("2", 1);
        assert_eq!(crate::json::to_js_string(&m).unwrap(), r#"{"2":1,"10":1,"b":1,"a":1}"#);
    }
}
