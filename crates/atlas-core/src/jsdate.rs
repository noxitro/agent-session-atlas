//! JavaScript の `Date.parse` と `Date#toISOString` の代わり(TS 版と同じ時刻の扱いにするため)。
//!
//! 受け付ける形(V8 が受け付けるもののうち、Copilot の記録・設定・コマンドラインに現れるもの):
//! - ISO 8601: `YYYY`、`YYYY-MM`、`YYYY-MM-DD`(日付だけは UTC)、`YYYY-MM-DDTHH:mm[:ss[.fff…]]`(時刻つきでオフセットなしはローカル時刻)、
//!   末尾の `Z` / `±HH:MM` / `±HHMM`。日付と時刻の間は `T` か空白(V8 は空白も受け付ける)。小数秒は 4 桁目以降を切り捨てる。
//! - `YYYY/MM/DD[ HH:MM[:SS]]`(ローカル時刻)
//!
//! それ以外(英語の月名など)は None(TS 版では NaN 以外になりうるが、記録には現れない)。

use chrono::{DateTime, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use regex::Regex;
use std::sync::LazyLock;

static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$").unwrap()
});
static SLASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})/(\d{1,2})/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$").unwrap());

fn local_ms(dt: NaiveDateTime) -> Option<i64> {
    match Local.from_local_datetime(&dt) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        // 夏時間の重なりは早い方(V8 と同じ)
        LocalResult::Ambiguous(a, _) => Some(a.timestamp_millis()),
        // 夏時間の飛びは 1 時間後にずらす(V8 と同じ)
        LocalResult::None => Local.from_local_datetime(&(dt + chrono::Duration::hours(1))).earliest().map(|t| t.timestamp_millis()),
    }
}

/// 年月日から日付を作る。legacy(V8 の ISO 以外の解釈)では日の繰り上がりを許す(2026-02-30 は 3 月 2 日)
fn make_date(year: i32, month: u32, day: u32, overflow: bool) -> Option<NaiveDate> {
    if !overflow {
        return NaiveDate::from_ymd_opt(year, month, day);
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_days(chrono::Days::new((day - 1) as u64))
}

/// `Date.parse(s)`。解釈できなければ None(JS の NaN)
pub fn parse_ms(s: &str) -> Option<i64> {
    // ES の日時の形そのもの(前後の空白なし、日付と時刻の間は T)なら仕様どおり: 日付だけは UTC、時刻つきでオフセットなしはローカル時刻。
    // それ以外は V8 の legacy の解釈: 前後の空白を許し、オフセットが無ければローカル時刻、日は 31 まで繰り上がる
    let strict = !s.contains(' ') && s == s.trim();
    if strict {
        if let Some(v) = parse_iso(s, false) {
            return Some(v);
        }
    }
    let t = s.trim();
    if let Some(v) = parse_iso(t, true) {
        return Some(v);
    }
    if let Some(c) = SLASH.captures(t) {
        let date = make_date(c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?, true)?;
        let (h, mi, sec) = match c.get(4) {
            Some(h) => (h.as_str().parse().ok()?, c[5].parse().ok()?, c.get(6).map_or(Some(0), |m| m.as_str().parse().ok())?),
            None => (0, 0, 0),
        };
        return local_ms(date.and_hms_opt(h, mi, sec)?);
    }
    None
}

fn parse_iso(s: &str, legacy: bool) -> Option<i64> {
    let c = ISO.captures(s)?;
    let year: i32 = c[1].parse().ok()?;
    let month: u32 = c.get(2).map_or(Some(1), |m| m.as_str().parse().ok())?;
    let day: u32 = c.get(3).map_or(Some(1), |m| m.as_str().parse().ok())?;
    // V8 は ISO の形でも日を 31 まで受け付けて繰り上げる(2026-02-30 は 3 月 2 日)
    let date = make_date(year, month, day, true)?;
    let has_time = c.get(4).is_some();
    let (h, mi, sec) = if has_time {
        (c[4].parse::<u32>().ok()?, c[5].parse::<u32>().ok()?, c.get(6).map_or(Some(0), |m| m.as_str().parse::<u32>().ok())?)
    } else {
        (0, 0, 0)
    };
    let frac_ms: i64 = match c.get(7) {
        Some(f) => {
            let digits: String = f.as_str().chars().chain(std::iter::repeat('0')).take(3).collect();
            digits.parse().ok()?
        }
        None => 0,
    };
    // 24:00:00 は翌日の 0 時(ES の仕様)
    let (date, h) = if h == 24 && mi == 0 && sec == 0 && frac_ms == 0 { (date.succ_opt()?, 0) } else { (date, h) };
    if h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    let naive = date.and_hms_opt(h, mi, sec)?;
    let base = match c.get(8).map(|m| m.as_str()) {
        Some("Z") | Some("z") => Utc.from_utc_datetime(&naive).timestamp_millis(),
        Some(off) => {
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let digits: String = off[1..].chars().filter(|ch| ch.is_ascii_digit()).collect();
            let oh: i64 = digits[0..2].parse().ok()?;
            let om: i64 = digits[2..4].parse().ok()?;
            if oh > 23 || om > 59 {
                return None;
            }
            Utc.from_utc_datetime(&naive).timestamp_millis() - sign * (oh * 3600 + om * 60) * 1000
        }
        None if !has_time && !legacy => Utc.from_utc_datetime(&naive).timestamp_millis(),
        None => local_ms(naive)?,
    };
    Some(base + frac_ms)
}

/// `new Date(ms).toISOString()`(`YYYY-MM-DDTHH:mm:ss.sssZ`)
pub fn to_iso(ms: i64) -> String {
    let dt: DateTime<Utc> = Utc.timestamp_millis_opt(ms).single().unwrap_or_else(|| Utc.timestamp_millis_opt(0).unwrap());
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `Date.now()`
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// `new Date().toISOString()`
pub fn now_iso() -> String {
    to_iso(now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_forms() {
        assert_eq!(parse_ms("2026-07-01"), Some(1782864000000));
        assert_eq!(parse_ms("2026-07-01T00:00:00Z"), Some(1782864000000));
        assert_eq!(parse_ms("2026-07-01T09:00:00+09:00"), Some(1782864000000));
        assert_eq!(parse_ms("2026-07-01T00:00:00.123456Z"), Some(1782864000123));
        // 以下は Node(TZ=Asia/Tokyo)で確かめた値。legacy の解釈はローカル時刻なので JST を前提にする
        if chrono::Local::now().offset().local_minus_utc() == 9 * 3600 {
            assert_eq!(parse_ms("2026-02-30"), Some(1772409600000));
            assert_eq!(parse_ms("2026-07-01 10:00"), Some(1782867600000));
            assert_eq!(parse_ms("2026-07-01T10:00"), Some(1782867600000));
            assert_eq!(parse_ms("2026/7/1"), Some(1782831600000));
            assert_eq!(parse_ms(" 2026-07-01 "), Some(1782831600000));
        }
        assert_eq!(parse_ms("2026-07"), Some(1782864000000));
        assert_eq!(parse_ms("nope"), None);
        assert_eq!(to_iso(1782864000123), "2026-07-01T00:00:00.123Z");
    }
}
