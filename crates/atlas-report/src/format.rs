//! 数値・日時の表示(日本語、桁区切り)。packages/report/src/lib/format.ts の移植。atlas.html と詳細ページで共用する。
//!
//! 桁区切りは `Intl.NumberFormat('ja-JP', { maximumFractionDigits })` と同じにする。V8(ICU)は数を最短の 10 進表記
//! (`Number#toString` と同じ桁)にしてから、指定の桁で四捨五入(0 から遠い方へ)する。toFixed(正確な 2 進の値で丸める)
//! とは違い、1.005 は 1.01 になる。

use atlas_core::{jsdate, js};
use chrono::{Datelike, Local, TimeZone, Timelike};
use regex::Regex;
use std::sync::LazyLock;

/// `Intl.NumberFormat('ja-JP', { maximumFractionDigits: max_frac }).format(n)`
pub fn format_number(n: f64, max_frac: usize) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "∞".into() } else { "-∞".into() };
    }
    let neg = n.is_sign_negative();
    let (int_part, frac_part) = round_shortest(n.abs(), max_frac);
    let mut out = String::with_capacity(int_part.len() + frac_part.len() + 8);
    if neg {
        out.push('-');
    }
    let len = int_part.len();
    for (i, c) in int_part.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if !frac_part.is_empty() {
        out.push('.');
        out.push_str(&frac_part);
    }
    out
}

/// 正の有限の数を、最短の 10 進表記から小数 max_frac 桁に四捨五入する。戻りは (整数部, 末尾の 0 を除いた小数部)
fn round_shortest(x: f64, max_frac: usize) -> (String, String) {
    if x == 0.0 {
        return ("0".into(), String::new());
    }
    let s = js::num_to_string(x);
    let (mant, exp) = match s.split_once('e') {
        Some((m, e)) => (m, e.parse::<i64>().unwrap_or(0)),
        None => (s.as_str(), 0),
    };
    let (ip, fp) = mant.split_once('.').unwrap_or((mant, ""));
    let mut digits: Vec<u8> = ip.bytes().chain(fp.bytes()).map(|b| b - b'0').collect();
    // 小数点の前の桁数(digits の先頭からの位置)
    let mut point = ip.len() as i64 + exp;
    while digits.first() == Some(&0) {
        digits.remove(0);
        point -= 1;
    }
    let keep = point + max_frac as i64;
    if keep < 0 {
        return ("0".into(), String::new());
    }
    let keep = keep as usize;
    if keep < digits.len() {
        let up = digits[keep] >= 5;
        digits.truncate(keep);
        if up {
            let mut i = digits.len();
            loop {
                if i == 0 {
                    digits.insert(0, 1);
                    point += 1;
                    break;
                }
                i -= 1;
                if digits[i] == 9 {
                    digits[i] = 0;
                } else {
                    digits[i] += 1;
                    break;
                }
            }
        }
    }
    // 整数部と小数部に分ける
    let mut int_s = String::new();
    let mut frac_s = String::new();
    if point <= 0 {
        int_s.push('0');
        for _ in 0..(-point) {
            frac_s.push('0');
        }
        frac_s.extend(digits.iter().map(|d| (b'0' + d) as char));
    } else {
        let p = point as usize;
        for i in 0..p {
            int_s.push((b'0' + digits.get(i).copied().unwrap_or(0)) as char);
        }
        frac_s.extend(digits.iter().skip(p).map(|d| (b'0' + d) as char));
    }
    let frac_s = frac_s.trim_end_matches('0').to_string();
    if int_s.is_empty() {
        int_s.push('0');
    }
    (int_s, frac_s)
}

/// 桁区切りの整数。None は missing(既定「記録なし」)
pub fn int(n: Option<f64>, missing: &str) -> String {
    match n {
        Some(v) if !v.is_nan() => format_number(v, 0),
        _ => missing.to_string(),
    }
}

/// `int(n)`(欠測は「記録なし」)
pub fn int_n(n: f64) -> String {
    int(Some(n), "記録なし")
}

pub fn dec(n: Option<f64>, missing: &str) -> String {
    match n {
        Some(v) if !v.is_nan() => format_number(v, 2),
        _ => missing.to_string(),
    }
}

/// `dec(n)`(欠測は「記録なし」)
pub fn dec_n(n: f64) -> String {
    dec(Some(n), "記録なし")
}

/// 大きな数を 万 / 億 で短く(グラフの軸・ラベル用)
pub fn compact(n: f64) -> String {
    let a = n.abs();
    if a >= 1e8 {
        return format!("{}億", format_number(js::round((n / 1e8) * 10.0) / 10.0, 2));
    }
    if a >= 1e4 {
        return format!("{}万", format_number(js::round((n / 1e4) * 10.0) / 10.0, 2));
    }
    format_number(js::round(n * 100.0) / 100.0, 2)
}

/// ミリ秒を「3時間12分」「45分」「30秒」に
pub fn duration(ms: Option<f64>, missing: &str) -> String {
    let Some(ms) = ms.filter(|v| !v.is_nan()) else {
        return missing.to_string();
    };
    let sec = js::round(ms / 1000.0);
    if sec < 60.0 {
        return format!("{}秒", js::num_to_string(sec));
    }
    let min = js::round(sec / 60.0);
    if min < 60.0 {
        return format!("{}分", js::num_to_string(min));
    }
    let h = (min / 60.0).floor();
    let m = min % 60.0;
    if h < 48.0 {
        return if m != 0.0 { format!("{}時間{}分", js::num_to_string(h), js::num_to_string(m)) } else { format!("{}時間", js::num_to_string(h)) };
    }
    format!("{}日", format_number(js::round((h / 24.0) * 10.0) / 10.0, 2))
}

/// `String(n).padStart(2, '0')`
fn pad2(n: i64) -> String {
    let s = n.to_string();
    if s.len() < 2 { format!("{s:0>2}") } else { s }
}

/// ISO 文字列のローカル時刻(年, 月, 日, 時, 分)。読めなければ None
fn local_parts(iso: Option<&str>) -> Option<(i32, u32, u32, u32, u32)> {
    let iso = iso.filter(|s| !s.is_empty())?;
    let ms = jsdate::parse_ms(iso)?;
    let d = Local.timestamp_millis_opt(ms).earliest()?;
    Some((d.year(), d.month(), d.day(), d.hour(), d.minute()))
}

/// ISO 文字列をローカル時刻の YYYY-MM-DD HH:mm に
pub fn date_time(iso: Option<&str>, missing: &str) -> String {
    match local_parts(iso) {
        Some((y, mo, d, h, mi)) => format!("{y}-{}-{} {}:{}", pad2(mo as i64), pad2(d as i64), pad2(h as i64), pad2(mi as i64)),
        None => missing.to_string(),
    }
}

/// `dateTime(iso)`(読めなければ「日時不明」)
pub fn date_time_n(iso: Option<&str>) -> String {
    date_time(iso, "日時不明")
}

pub fn date(iso: Option<&str>, missing: &str) -> String {
    match local_parts(iso) {
        Some((y, mo, d, _, _)) => format!("{y}-{}-{}", pad2(mo as i64), pad2(d as i64)),
        None => missing.to_string(),
    }
}

/// `date(iso)`(読めなければ「日時不明」)
pub fn date_n(iso: Option<&str>) -> String {
    date(iso, "日時不明")
}

/// YYYY-MM を「2026年7月」に
pub fn month(key: &str) -> String {
    let b = key.as_bytes();
    if b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit()) {
        return format!("{}年{}月", &key[0..4], key[5..7].parse::<i64>().unwrap_or(0));
    }
    key.to_string()
}

pub fn percent(part: f64, whole: f64) -> String {
    if whole <= 0.0 {
        return "—".into();
    }
    let p = (part / whole) * 100.0;
    let body = if p < 10.0 && p > 0.0 { format_number(js::round(p * 10.0) / 10.0, 2) } else { format_number(js::round(p), 0) };
    format!("{body}%")
}

static WS_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("{}+", js::RE_S)).unwrap());

/// `s.replace(/\s+/g, ' ').trim()`
pub fn squash_ws(s: &str) -> String {
    js::trim(&WS_RUN.replace_all(s, " ")).to_string()
}

/// 文字列を n 文字(コードポイント)で切る
pub fn truncate(s: Option<&str>, n: usize) -> String {
    let Some(s) = s.filter(|s| !s.is_empty()) else {
        return String::new();
    };
    let t = squash_ws(s);
    let mut it = t.char_indices();
    match it.nth(n) {
        Some((i, _)) => format!("{}…", &t[..i]),
        None => t,
    }
}

/// パスを区切り(\ と /)の直後で分けた断片(つなげると元の文字列に戻る)
pub fn path_parts(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        cur.push(c);
        if c == '\\' || c == '/' {
            out.push(std::mem::take(&mut cur));
        }
    }
    // JS の split は末尾が区切りでも空の断片を作らない(後読みの位置は文字列の終わりに当たらない)が、空文字列には [''] を返す
    if !cur.is_empty() || out.is_empty() {
        out.push(cur);
    }
    out
}

/// 表示用のモデル名。「<UUID>/claude-haiku-5.5」のようなプレフィックス付きの ID は最後の「/」以降に短縮する。'(unknown)' は「不明」
pub fn model_label(id: &str) -> String {
    if id == "(unknown)" {
        return "不明".into();
    }
    match id.rfind('/') {
        Some(i) if i < id.len() - 1 => id[i + 1..].to_string(),
        _ => id.to_string(),
    }
}

/// 待ち時間・所要時間の表示(850ms / 1.2秒 / 3分)。None は missing(既定「—」)
pub fn ms_label(v: Option<f64>, missing: &str) -> String {
    let Some(v) = v.filter(|x| !x.is_nan()) else {
        return missing.to_string();
    };
    if v < 1000.0 {
        return format!("{}ms", format_number(js::round(v), 0));
    }
    if v < 60_000.0 {
        return format!("{}秒", format_number(js::round(v / 100.0) / 10.0, 2));
    }
    duration(Some(v), missing)
}

/// 共通の書き出しとみなす最短の長さ(文字)
const SHARED_LEAD_MIN: usize = 20;
/// 省いたあとに残す書き出しの長さ(文字)
const SHARED_LEAD_KEEP: usize = 10;

/// 区切りとみなす文字(空白・和文の句読点と閉じ括弧・パスの区切り)。`/[\s、。，．：；！？）」』/\\]/u`
fn lead_break(c: Option<char>) -> bool {
    c.is_some_and(|c| js::is_js_whitespace(c) || "、。，．：；！？）」』/\\".contains(c))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct SharedLead {
    pub cut: usize,
    pub same: usize,
}

/// 一覧の題名を見分けるための情報(format.ts の sharedLeads)
pub fn shared_leads(texts: &[&str]) -> Vec<SharedLead> {
    let cps: Vec<Vec<char>> = texts.iter().map(|t| squash_ws(t).chars().collect()).collect();
    let keys: Vec<String> = cps.iter().map(|c| c.iter().collect()).collect();
    let mut count: indexmap::IndexMap<&str, usize> = indexmap::IndexMap::new();
    for k in &keys {
        *count.entry(k.as_str()).or_insert(0) += 1;
    }
    let mut uniq: Vec<&str> = count.keys().copied().collect();
    uniq.sort_by(|a, b| js::cmp_utf16(a, b));
    let uniq: Vec<Vec<char>> = uniq.iter().map(|k| k.chars().collect()).collect();
    let lcp = |a: &[char], b: &[char]| a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let mut shared: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (k, c) in uniq.iter().enumerate() {
        let prev = if k > 0 { lcp(c, &uniq[k - 1]) } else { 0 };
        let next = if k + 1 < uniq.len() { lcp(c, &uniq[k + 1]) } else { 0 };
        shared.insert(c.iter().collect(), prev.max(next));
    }
    cps.iter()
        .enumerate()
        .map(|(i, c)| {
            let same = count.get(keys[i].as_str()).copied().unwrap_or(1);
            let n = shared.get(&keys[i]).copied().unwrap_or(0);
            if n < SHARED_LEAD_MIN || n >= c.len() {
                return SharedLead { cut: 0, same };
            }
            let mut cut = n;
            let mut k = n;
            while k as i64 > n as i64 - 12 && k > SHARED_LEAD_KEEP {
                if lead_break(c.get(k - 1).copied()) {
                    cut = k;
                    break;
                }
                k -= 1;
            }
            SharedLead { cut, same }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SplitLead {
    pub lead: String,
    pub rest: String,
}

/// sharedLeads の cut で題名を分ける(format.ts の splitLead)
pub fn split_lead(text: &str, cut: usize, n: usize) -> SplitLead {
    let c: Vec<char> = squash_ws(text).chars().collect();
    let mut keep = SHARED_LEAD_KEEP.min(cut);
    let mut k = keep;
    while k >= 4 {
        if lead_break(c.get(k - 1).copied()) {
            keep = k;
            break;
        }
        k -= 1;
    }
    let mut from = cut;
    while !c.is_empty() && from < c.len() - 1 && lead_break(c.get(from).copied()) {
        from += 1;
    }
    let head: String = c.iter().take(keep).collect();
    let rest: String = c.iter().skip(from).collect();
    SplitLead { lead: format!("{}…", js::trim_end(&head)), rest: truncate(Some(&rest), n) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intl_like_v8() {
        let i = |x: f64| format_number(x, 0);
        let d = |x: f64| format_number(x, 2);
        assert_eq!((i(1.005), d(1.005)), ("1".into(), "1.01".into()));
        assert_eq!((i(0.125), d(0.125)), ("0".into(), "0.13".into()));
        assert_eq!((i(2.5), d(-2.5)), ("3".into(), "-2.5".into()));
        assert_eq!(i(-2.5), "-3");
        assert_eq!(d(1e21), "1,000,000,000,000,000,000,000");
        assert_eq!(d(2f64.powi(70)), "1,180,591,620,717,411,300,000");
        assert_eq!((i(-0.0), d(-0.001)), ("-0".into(), "-0".into()));
        assert_eq!((i(1234567.891), d(1234567.891)), ("1,234,568".into(), "1,234,567.89".into()));
        assert_eq!(d(1e-7), "0");
        assert_eq!(i(999.995), "1,000");
        assert_eq!(d(999.995), "1,000");
        assert_eq!((d(f64::INFINITY), d(f64::NAN)), ("∞".into(), "NaN".into()));
    }

    #[test]
    fn small_formats() {
        assert_eq!([ms_label(Some(850.0), "—"), ms_label(Some(1234.0), "—"), ms_label(Some(125_000.0), "—"), ms_label(None, "—")], ["850ms", "1.2秒", "2分", "—"]);
        assert_eq!(model_label("11111111-2222-4333-8444-555555555555/claude-haiku-5-5"), "claude-haiku-5-5");
        assert_eq!(model_label("gpt-5.5"), "gpt-5.5");
        assert_eq!(model_label("(unknown)"), "不明");
        assert_eq!(model_label("odd/"), "odd/");
        assert_eq!(truncate(Some("  a \n b  "), 10), "a b");
        assert_eq!(truncate(Some("あいうえお"), 3), "あいう…");
        assert_eq!(path_parts("C:\\a\\b/c"), ["C:\\", "a\\", "b/", "c"]);
        assert_eq!(path_parts(""), [""]);
        assert_eq!(duration(Some(3.0 * 3_600_000.0 + 12.0 * 60_000.0), "不明"), "3時間12分");
        assert_eq!(percent(1.0, 3.0), "33%");
        assert_eq!(percent(1.0, 30.0), "3.3%");
        assert_eq!(month("2026-07"), "2026年7月");
    }

    // report-lib.test.ts の「一覧の題名の見分け(sharedLeads)」
    #[test]
    fn shared_leads_cases() {
        let a = "HARNESS.md の Phase 1 の節。実装役の報告: ビルド成功";
        let b = "HARNESS.md の Phase 1 の節。実装役の報告は次のとおり";
        let r = shared_leads(&[a, b, "短い依頼", "OK と返して", "OK と返して"]);
        let tail = |s: &str, cut: usize| s.chars().skip(cut).collect::<String>();
        assert_eq!(tail(a, r[0].cut), "実装役の報告: ビルド成功");
        assert_eq!(tail(b, r[1].cut), "実装役の報告は次のとおり");
        assert_eq!(r[2], SharedLead { cut: 0, same: 1 });
        assert_eq!(r[3], SharedLead { cut: 0, same: 2 });

        let head = "このフォルダは C++ のライブラリのソースです。";
        let x = format!("{head}Reset を呼ぶ箇所");
        let y = format!("{head}Read を呼ぶ箇所");
        let r = shared_leads(&[&x, &x, &y]);
        assert_eq!(tail(&x, r[0].cut), "Reset を呼ぶ箇所");
        assert_eq!(r[0].same, 2);
        assert_eq!(r[2].same, 1);
        assert_eq!(r[2].cut, r[0].cut);

        let a = format!("{head}`lib::io::File::Read` を呼ぶ箇所");
        let b = format!("{head}`lib::net::Socket::Open` を呼ぶ箇所");
        let ra = shared_leads(&[&a, &b])[0];
        assert_eq!(split_lead(&a, ra.cut, 70), SplitLead { lead: "このフォルダは…".into(), rest: "`lib::io::File::Read` を呼ぶ箇所".into() });

        let r = shared_leads(&["リポジトリの README を  更新して。章立ては変えない", "リポジトリの README を 更新して。章立ては変える", "リポジトリの別の話"]);
        assert!(r[0].cut > 0);
        assert_eq!(r[2], SharedLead { cut: 0, same: 1 });
    }
}
