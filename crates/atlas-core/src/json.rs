//! JSON の書き出しを JavaScript の `JSON.stringify` と同じ形にそろえる。
//!
//! TS 版と出力をバイト単位で比べられるようにするため、数値は JS の `Number#toString` と同じ規則(ryu-js)で書く
//! (serde_json の既定は 1.0 を `1.0` と書くが、JS は `1`)。NaN・Infinity は JS と同じく `null` にする。
//! 文字列のエスケープは serde_json と JS で同じ(制御文字だけを `\uXXXX`(小文字の 16 進)か短い形にし、非 ASCII はそのまま)。

use serde::Serialize;
use serde_json::ser::{CompactFormatter, Formatter, PrettyFormatter};
use std::io::{self, Write};

fn write_js_number<W: ?Sized + Write>(writer: &mut W, value: f64) -> io::Result<()> {
    if !value.is_finite() {
        return writer.write_all(b"null");
    }
    if value == 0.0 {
        // JS は -0 も "0" と書く
        return writer.write_all(b"0");
    }
    let mut buf = ryu_js::Buffer::new();
    writer.write_all(buf.format_finite(value).as_bytes())
}

/// `JSON.stringify(v)` と同じ形(空白なし)
pub struct JsCompact;

impl Formatter for JsCompact {
    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        write_js_number(writer, value)
    }
    fn write_f32<W: ?Sized + Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        write_js_number(writer, value as f64)
    }
}

/// `JSON.stringify(v, null, indent)` と同じ形
pub struct JsPretty<'a>(PrettyFormatter<'a>);

impl<'a> JsPretty<'a> {
    pub fn with_indent(indent: &'a [u8]) -> Self {
        JsPretty(PrettyFormatter::with_indent(indent))
    }
}

impl Formatter for JsPretty<'_> {
    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        write_js_number(writer, value)
    }
    fn write_f32<W: ?Sized + Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        write_js_number(writer, value as f64)
    }
    fn begin_array<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_array(w)
    }
    fn end_array<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_array(w)
    }
    fn begin_array_value<W: ?Sized + Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.0.begin_array_value(w, first)
    }
    fn end_array_value<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_array_value(w)
    }
    fn begin_object<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_object(w)
    }
    fn end_object<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object(w)
    }
    fn begin_object_key<W: ?Sized + Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.0.begin_object_key(w, first)
    }
    fn end_object_key<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object_key(w)
    }
    fn begin_object_value<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_object_value(w)
    }
    fn end_object_value<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object_value(w)
    }
}

/// `JSON.stringify(v)` 相当
pub fn to_js_string<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    let mut out = Vec::with_capacity(1024);
    let mut ser = serde_json::Serializer::with_formatter(&mut out, JsCompact);
    value.serialize(&mut ser)?;
    // serde_json は妥当な UTF-8 しか書かない
    Ok(String::from_utf8(out).expect("serde_json writes UTF-8"))
}

/// `JSON.stringify(v, null, 2)` 相当
pub fn to_js_string_pretty<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    to_js_string_indent(value, b"  ")
}

/// `JSON.stringify(v, null, indent)` 相当
pub fn to_js_string_indent<T: Serialize + ?Sized>(value: &T, indent: &[u8]) -> serde_json::Result<String> {
    let mut out = Vec::with_capacity(1024);
    let mut ser = serde_json::Serializer::with_formatter(&mut out, JsPretty::with_indent(indent));
    value.serialize(&mut ser)?;
    Ok(String::from_utf8(out).expect("serde_json writes UTF-8"))
}

/// 書き出し先へ直接 `JSON.stringify(v)` を流す(大きい sessions.json を文字列に溜めないため)
pub fn write_js<W: Write, T: Serialize + ?Sized>(writer: W, value: &T) -> serde_json::Result<()> {
    let mut ser = serde_json::Serializer::with_formatter(writer, JsCompact);
    value.serialize(&mut ser)
}

// CompactFormatter を使っていないことを明示(JsCompact は既定メソッドが CompactFormatter と同じ出力)
#[allow(dead_code)]
fn _assert_compact_is_default(_: CompactFormatter) {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_like_js() {
        assert_eq!(to_js_string(&json!([1.0, 1.5, -0.0, 1e21, 1e-7, 0.1 + 0.2, 123456789012345680000.0])).unwrap(), "[1,1.5,0,1e+21,1e-7,0.30000000000000004,123456789012345680000]");
        assert_eq!(to_js_string(&f64::NAN).unwrap(), "null");
    }

    #[test]
    fn pretty_like_js() {
        let v = json!({"a": [], "b": {}, "c": [1, {"d": 2.0}]});
        assert_eq!(to_js_string_pretty(&v).unwrap(), "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": 2\n    }\n  ]\n}");
    }

    #[test]
    fn escapes_like_js() {
        assert_eq!(to_js_string("a\u{1}\u{7f}\u{2028}\"\\\n日本").unwrap(), "\"a\\u0001\u{7f}\u{2028}\\\"\\\\\\n日本\"");
    }
}
