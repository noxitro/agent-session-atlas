//! JavaScript の `Date.parse` と `Date#toISOString` の代わり(TS 版と同じ時刻の扱いにするため)。
//!
//! 受け付ける形(V8 が受け付けるもののうち、Copilot の記録・設定・コマンドラインに現れるもの):
//! - ISO 8601: `YYYY`、`YYYY-MM`、`YYYY-MM-DD`(日付だけは UTC)、`YYYY-MM-DDTHH:mm[:ss[.fff…]]`(時刻つきでオフセットなしはローカル時刻)、
//!   末尾の `Z` / `±HH:MM` / `±HHMM`。日付と時刻の間は `T` か空白(V8 は空白も受け付ける)。小数秒は 4 桁目以降を切り捨てる。
//! - `YYYY/MM/DD[ HH:MM[:SS]]`(ローカル時刻)
//!
//! それ以外(英語の月名など)は None(TS 版では NaN 以外になりうるが、記録には現れない)。
//!
//! 暦の計算(日数と年月日の変換・繰り上がり・曜日)は整数の計算で行い、jiff はローカル時刻の時差を引くのにだけ使う。
//! 扱える日付は -262143-01-01〜+262142-12-31(前の実装と同じ範囲。出力を変えないため)。

use jiff::tz::AmbiguousOffset;
pub use jiff::tz::{Offset, TimeZone};
use jiff::Timestamp;
use regex::Regex;
use std::cell::RefCell;
use std::sync::LazyLock;

static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$").unwrap()
});
static SLASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})/(\d{1,2})/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$").unwrap());

const DAY_SECS: i64 = 86_400;

/// 1970-01-01 からの日数(先発グレゴリオ暦)
const fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 1970-01-01 からの日数を (年, 月, 日) に
const fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, month, day)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 扱える日付の端(1970-01-01 からの日数)
const MIN_DAYS: i64 = days_from_civil(-262_143, 1, 1);
const MAX_DAYS: i64 = days_from_civil(262_142, 12, 31);

/// 1970-01-01 からの秒数の日付が扱える範囲か
fn secs_in_range(secs: i64) -> bool {
    (MIN_DAYS..=MAX_DAYS).contains(&secs.div_euclid(DAY_SECS))
}

/// 暦の日時(ローカルか UTC か、どの時差のものかは使う側が決める)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Civil {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl Civil {
    /// 年月日の 0 時。暦に無い日・扱える範囲の外なら None
    pub fn date(year: i32, month: u32, day: u32) -> Option<Civil> {
        if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year as i64, month) {
            return None;
        }
        Some(Civil { year, month, day, hour: 0, minute: 0, second: 0 }).filter(|c| secs_in_range(c.secs()))
    }

    /// 同じ日の時刻。時 0〜23・分 0〜59・秒 0〜59 でなければ None
    pub fn at(self, hour: u32, minute: u32, second: u32) -> Option<Civil> {
        (hour < 24 && minute < 60 && second < 60).then_some(Civil { hour, minute, second, ..self })
    }

    /// n 日後(負なら前)。扱える範囲の外に出たら None
    pub fn add_days(self, n: i64) -> Option<Civil> {
        let secs = self.secs().checked_add(n.checked_mul(DAY_SECS)?)?;
        secs_in_range(secs).then(|| Civil::from_secs(secs))
    }

    /// UTC の時刻とみなした 1970-01-01T00:00:00 からの秒数
    fn secs(&self) -> i64 {
        days_from_civil(self.year as i64, self.month, self.day) * DAY_SECS + (self.hour * 3600 + self.minute * 60 + self.second) as i64
    }

    /// 1970-01-01T00:00:00 からの秒数の日時(範囲は見ない。端を 1 日越えても年月日にする)
    fn from_secs(secs: i64) -> Civil {
        let (y, month, day) = civil_from_days(secs.div_euclid(DAY_SECS));
        let s = secs.rem_euclid(DAY_SECS) as u32;
        Civil { year: y as i32, month, day, hour: s / 3600, minute: s / 60 % 60, second: s % 60 }
    }
}

thread_local! {
    static ZONE: RefCell<Option<TimeZone>> = const { RefCell::new(None) };
}

/// ローカル時刻の時間帯(TZ の環境変数か OS の設定。with_zone の中ならその時間帯)
fn zone() -> TimeZone {
    ZONE.with(|z| z.borrow().clone()).unwrap_or_else(TimeZone::system)
}

/// f の中(同じスレッド)だけ、ローカル時刻を tz で扱う(テストで時間帯を決めて動かすため)
pub fn with_zone<R>(tz: &TimeZone, f: impl FnOnce() -> R) -> R {
    let prev = ZONE.with(|z| z.borrow_mut().replace(tz.clone()));
    struct Restore(Option<TimeZone>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let prev = self.0.take();
            ZONE.with(|z| *z.borrow_mut() = prev);
        }
    }
    let _restore = Restore(prev);
    f()
}

/// ある時刻(1970-01-01T00:00:00Z からの秒数)での tz の UTC からのずれ(秒)。jiff の範囲(±9999 年)の外は端の時刻のずれ
fn offset_at(secs: i64, tz: &TimeZone) -> i64 {
    let t = Timestamp::from_second(secs.clamp(Timestamp::MIN.as_second(), Timestamp::MAX.as_second())).expect("範囲に収めた秒数");
    tz.to_offset(t).seconds() as i64
}

/// ローカル時刻の時差。夏時間の飛びなら None
fn local_offsets(c: Civil, tz: &TimeZone) -> Option<(i64, i64)> {
    let jdt = i16::try_from(c.year).ok().and_then(|y| jiff::civil::DateTime::new(y, c.month as i8, c.day as i8, c.hour as i8, c.minute as i8, c.second as i8, 0).ok());
    let Some(jdt) = jdt else {
        // jiff の範囲の外の年は、端の時刻のずれ(重なり・飛びは見ない)
        let o = offset_at(c.secs(), tz);
        return Some((o, o));
    };
    match tz.to_ambiguous_timestamp(jdt).offset() {
        AmbiguousOffset::Unambiguous { offset } => Some((offset.seconds() as i64, offset.seconds() as i64)),
        AmbiguousOffset::Fold { before, after } => Some((before.seconds() as i64, after.seconds() as i64)),
        AmbiguousOffset::Gap { .. } => None,
    }
}

/// ローカル時刻 c を tz で UTC のミリ秒に。夏時間の重なりは早い方、飛びは 1 時間後にずらす(前の実装と同じ。飛びが 1 時間なら V8 と同じ)
fn local_ms_in(c: Civil, tz: &TimeZone) -> Option<i64> {
    let (c, (a, b)) = match local_offsets(c, tz) {
        Some(o) => (c, o),
        None => {
            let later = Civil::from_secs(c.secs() + 3600);
            (later, local_offsets(later, tz)?)
        }
    };
    // ずれが大きい方が早い時刻
    let secs = c.secs() - a.max(b);
    secs_in_range(secs).then_some(secs * 1000)
}

/// ローカル時刻の年月日時分秒を UTC のミリ秒に(`new Date(y, m - 1, d, h, mi, s).getTime()` の、繰り上がりを除いたもの)
pub fn local_ms(c: Civil) -> Option<i64> {
    local_ms_in(c, &zone())
}

fn local_parts_in(ms: i64, tz: &TimeZone) -> Option<Civil> {
    let secs = ms.div_euclid(1000);
    secs_in_range(secs).then(|| Civil::from_secs(secs + offset_at(secs, tz)))
}

/// ミリ秒の時刻のローカル時刻。扱える範囲の外なら None
pub fn local_parts(ms: i64) -> Option<Civil> {
    local_parts_in(ms, &zone())
}

/// ミリ秒の時刻を、UTC から offset_secs 秒ずれた時刻に。扱える範囲の外なら None
pub fn offset_parts(ms: i64, offset_secs: i64) -> Option<Civil> {
    let secs = ms.div_euclid(1000);
    secs_in_range(secs).then(|| Civil::from_secs(secs + offset_secs))
}

/// ISO の形の年(0〜9999 は 4 桁、それ以外は符号つきで 4 桁以上。前の実装と同じ)
fn year4(year: i32) -> String {
    if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+05}")
    }
}

/// UTC の日時。扱える範囲の外は 1970-01-01T00:00:00Z
fn utc_or_epoch(ms: i64) -> (Civil, i64) {
    let ms = if secs_in_range(ms.div_euclid(1000)) { ms } else { 0 };
    (Civil::from_secs(ms.div_euclid(1000)), ms.rem_euclid(1000))
}

/// 年月日から日付を作る。V8 は(ISO の形でも)日を 31 まで受け付けて繰り上げる(2026-02-30 は 3 月 2 日)
fn make_date(year: i32, month: u32, day: u32) -> Option<Civil> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Civil::date(year, month, 1)?.add_days((day - 1) as i64)
}

/// `Date.parse(s)`。解釈できなければ None(JS の NaN)
pub fn parse_ms(s: &str) -> Option<i64> {
    parse_ms_in(s, &zone())
}

fn parse_ms_in(s: &str, tz: &TimeZone) -> Option<i64> {
    // ES の日時の形そのもの(前後の空白なし、日付と時刻の間は T)なら仕様どおり: 日付だけは UTC、時刻つきでオフセットなしはローカル時刻。
    // それ以外は V8 の legacy の解釈: 前後の空白を許し、オフセットが無ければローカル時刻、日は 31 まで繰り上がる
    let strict = !s.contains(' ') && s == s.trim();
    if strict {
        if let Some(v) = parse_iso(s, false, tz) {
            return Some(v);
        }
    }
    let t = s.trim();
    if let Some(v) = parse_iso(t, true, tz) {
        return Some(v);
    }
    if let Some(c) = SLASH.captures(t) {
        let date = make_date(c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?)?;
        let (h, mi, sec) = match c.get(4) {
            Some(h) => (h.as_str().parse().ok()?, c[5].parse().ok()?, c.get(6).map_or(Some(0), |m| m.as_str().parse().ok())?),
            None => (0, 0, 0),
        };
        return local_ms_in(date.at(h, mi, sec)?, tz);
    }
    None
}

fn parse_iso(s: &str, legacy: bool, tz: &TimeZone) -> Option<i64> {
    let c = ISO.captures(s)?;
    let year: i32 = c[1].parse().ok()?;
    let month: u32 = c.get(2).map_or(Some(1), |m| m.as_str().parse().ok())?;
    let day: u32 = c.get(3).map_or(Some(1), |m| m.as_str().parse().ok())?;
    let date = make_date(year, month, day)?;
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
    let (date, h) = if h == 24 && mi == 0 && sec == 0 && frac_ms == 0 { (date.add_days(1)?, 0) } else { (date, h) };
    let naive = date.at(h, mi, sec)?;
    let base = match c.get(8).map(|m| m.as_str()) {
        Some("Z") | Some("z") => naive.secs() * 1000,
        Some(off) => {
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let digits: String = off[1..].chars().filter(|ch| ch.is_ascii_digit()).collect();
            let oh: i64 = digits[0..2].parse().ok()?;
            let om: i64 = digits[2..4].parse().ok()?;
            if oh > 23 || om > 59 {
                return None;
            }
            naive.secs() * 1000 - sign * (oh * 3600 + om * 60) * 1000
        }
        None if !has_time && !legacy => naive.secs() * 1000,
        None => local_ms_in(naive, tz)?,
    };
    Some(base + frac_ms)
}

/// `new Date(ms).toISOString()`(`YYYY-MM-DDTHH:mm:ss.sssZ`)。扱える範囲の外は 1970-01-01T00:00:00.000Z
pub fn to_iso(ms: i64) -> String {
    let (d, frac) = utc_or_epoch(ms);
    format!("{}-{:02}-{:02}T{:02}:{:02}:{:02}.{frac:03}Z", year4(d.year), d.month, d.day, d.hour, d.minute, d.second)
}

/// HTTP の date 見出しの値(IMF-fixdate。`Wed, 01 Jul 2026 00:00:00 GMT`)。扱える範囲の外は 1970-01-01T00:00:00Z
pub fn http_date(ms: i64) -> String {
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (d, _) = utc_or_epoch(ms);
    // 1970-01-01 は木曜
    let wd = WEEKDAYS[days_from_civil(d.year as i64, d.month, d.day).rem_euclid(7) as usize];
    format!("{wd}, {:02} {} {} {:02}:{:02}:{:02} GMT", d.day, MONTHS[d.month as usize - 1], year4(d.year), d.hour, d.minute, d.second)
}

/// `Date.now()`
pub fn now_ms() -> i64 {
    Timestamp::now().as_millisecond()
}

/// `new Date().toISOString()`
pub fn now_iso() -> String {
    to_iso(now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jst() -> TimeZone {
        TimeZone::fixed(Offset::constant(9))
    }

    /// 米国東部(夏時間あり)。tzdb を使わない POSIX の形
    fn est() -> TimeZone {
        TimeZone::posix("EST5EDT,M3.2.0,M11.1.0").unwrap()
    }

    fn civil(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> Civil {
        Civil { year, month, day, hour, minute, second }
    }

    #[test]
    fn iso_forms() {
        assert_eq!(parse_ms("2026-07-01"), Some(1782864000000));
        assert_eq!(parse_ms("2026-07-01T00:00:00Z"), Some(1782864000000));
        assert_eq!(parse_ms("2026-07-01T09:00:00+09:00"), Some(1782864000000));
        assert_eq!(parse_ms("2026-07-01T00:00:00.123456Z"), Some(1782864000123));
        // 以下は Node(TZ=Asia/Tokyo)で確かめた値。legacy の解釈はローカル時刻なので JST で動かす
        with_zone(&jst(), || {
            assert_eq!(parse_ms("2026-02-30"), Some(1772409600000));
            assert_eq!(parse_ms("2026-07-01 10:00"), Some(1782867600000));
            assert_eq!(parse_ms("2026-07-01T10:00"), Some(1782867600000));
            assert_eq!(parse_ms("2026/7/1"), Some(1782831600000));
            assert_eq!(parse_ms(" 2026-07-01 "), Some(1782831600000));
        });
        assert_eq!(parse_ms("2026-07"), Some(1782864000000));
        assert_eq!(parse_ms("nope"), None);
        assert_eq!(to_iso(1782864000123), "2026-07-01T00:00:00.123Z");
    }

    /// 前の実装の出力(時間帯は Asia/Tokyo)。入力 → (parse_ms, to_iso)
    #[test]
    fn parse_matches_previous_output() {
        let cases: &[(&str, Option<i64>, &str)] = &[
            ("2026-07-01", Some(1782864000000), "2026-07-01T00:00:00.000Z"),
            ("2026-07-01T00:00:00Z", Some(1782864000000), "2026-07-01T00:00:00.000Z"),
            ("2026-07-01T10:00", Some(1782867600000), "2026-07-01T01:00:00.000Z"),
            ("2026-07-01 10:00", Some(1782867600000), "2026-07-01T01:00:00.000Z"),
            (" 2026-07-01 ", Some(1782831600000), "2026-06-30T15:00:00.000Z"),
            ("2026-07-01T10:00:00", Some(1782867600000), "2026-07-01T01:00:00.000Z"),
            ("2026-07-01T10:00:00.5", Some(1782867600500), "2026-07-01T01:00:00.500Z"),
            ("2026/7/1", Some(1782831600000), "2026-06-30T15:00:00.000Z"),
            ("2026/7/1 9:05", Some(1782864300000), "2026-07-01T00:05:00.000Z"),
            ("2026/07/01 09:05:07", Some(1782864307000), "2026-07-01T00:05:07.000Z"),
            ("2026/2/31", Some(1772463600000), "2026-03-02T15:00:00.000Z"),
            ("2026-02-30", Some(1772409600000), "2026-03-02T00:00:00.000Z"),
            ("2026-02-30T10:00", Some(1772413200000), "2026-03-02T01:00:00.000Z"),
            ("2026-02-32", None, ""),
            ("2026-07-01T24:00:00", Some(1782918000000), "2026-07-01T15:00:00.000Z"),
            ("2026-07-01T24:00:00Z", Some(1782950400000), "2026-07-02T00:00:00.000Z"),
            ("2026-07-01T24:00", Some(1782918000000), "2026-07-01T15:00:00.000Z"),
            ("2026-07-01T10:00:00.5+0530", Some(1782880200500), "2026-07-01T04:30:00.500Z"),
            ("2026-07-01T10:00:00,1239-08:00", Some(1782928800123), "2026-07-01T18:00:00.123Z"),
            ("2026-07-01T10:00:00 Z", Some(1782900000000), "2026-07-01T10:00:00.000Z"),
            ("2026-07-01T10:00:00+24:00", None, ""),
            ("+002026-07-01T00:00:00Z", Some(1782864000000), "2026-07-01T00:00:00.000Z"),
            ("-000001-01-01T00:00:00Z", Some(-62198755200000), "-0001-01-01T00:00:00.000Z"),
            ("+010000-01-01T00:00:00Z", Some(253402300800000), "+10000-01-01T00:00:00.000Z"),
            ("+262143-12-31T23:59:59Z", None, ""),
            ("+262144-01-01T00:00:00Z", None, ""),
            ("1969-12-31T23:59:59.999Z", Some(-1), "1969-12-31T23:59:59.999Z"),
            ("1899-12-31T23:59:59", Some(-2209021201000), "1899-12-31T14:59:59.000Z"),
            ("0099-01-01", Some(-59042995200000), "0099-01-01T00:00:00.000Z"),
            ("2026", Some(1767225600000), "2026-01-01T00:00:00.000Z"),
            ("2026-07", Some(1782864000000), "2026-07-01T00:00:00.000Z"),
            ("2026-13-01", None, ""),
            ("2026-07-01T25:00", None, ""),
            ("2026-07-01T10:60", None, ""),
            ("nope", None, ""),
            ("", None, ""),
            ("2026-07-01T10:00:00.999999999Z", Some(1782900000999), "2026-07-01T10:00:00.999Z"),
            ("2026-12-31T15:00:00Z", Some(1798729200000), "2026-12-31T15:00:00.000Z"),
            ("2026-12-31T14:59:59.999Z", Some(1798729199999), "2026-12-31T14:59:59.999Z"),
        ];
        let tz = jst();
        for &(input, ms, iso) in cases {
            let got = parse_ms_in(input, &tz);
            assert_eq!(got, ms, "{input:?}");
            assert_eq!(got.map(to_iso).unwrap_or_default(), iso, "{input:?}");
        }
    }

    /// 前の実装の to_iso の出力(範囲の外は 1970-01-01)
    #[test]
    fn to_iso_matches_previous_output() {
        let cases: &[(i64, &str)] = &[
            (0, "1970-01-01T00:00:00.000Z"),
            (-1, "1969-12-31T23:59:59.999Z"),
            (1, "1970-01-01T00:00:00.001Z"),
            (1782864000123, "2026-07-01T00:00:00.123Z"),
            (-62135596800000, "0001-01-01T00:00:00.000Z"),
            (253402300799999, "9999-12-31T23:59:59.999Z"),
            (253402300800000, "+10000-01-01T00:00:00.000Z"),
            (8210266876799999, "+262142-12-31T23:59:59.999Z"),
            (8210266876800000, "1970-01-01T00:00:00.000Z"),
            (i64::MAX, "1970-01-01T00:00:00.000Z"),
            (i64::MIN, "1970-01-01T00:00:00.000Z"),
            (-8640000000000000, "1970-01-01T00:00:00.000Z"),
        ];
        for &(ms, iso) in cases {
            assert_eq!(to_iso(ms), iso, "{ms}");
        }
        // 下の端(-262143-01-01)は扱え、その前の日は扱えない
        let min = days_from_civil(-262_143, 1, 1) * DAY_SECS * 1000;
        assert_eq!(to_iso(min), "-262143-01-01T00:00:00.000Z");
        assert_eq!(to_iso(min - 1), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn calendar_round_trip() {
        for days in (MIN_DAYS..=MAX_DAYS).step_by(997).chain([MIN_DAYS, MAX_DAYS, -1, 0, 1]) {
            let (y, m, d) = civil_from_days(days);
            assert!(d >= 1 && d <= days_in_month(y, m), "{days}");
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(MAX_DAYS), (262_142, 12, 31));
        assert_eq!(Civil::date(2026, 2, 29), None);
        assert_eq!(Civil::date(2024, 2, 29).map(|c| c.day), Some(29));
        assert_eq!(Civil::date(262_142, 12, 31).and_then(|c| c.add_days(1)), None);
    }

    #[test]
    fn dst_local_to_utc() {
        let tz = est();
        let iso = |c: Civil| local_ms_in(c, &tz).map(to_iso);
        // 飛び(2:00 → 3:00)は 1 時間後にずらす
        assert_eq!(iso(civil(2026, 3, 8, 2, 30, 0)).as_deref(), Some("2026-03-08T07:30:00.000Z"));
        assert_eq!(iso(civil(2026, 3, 8, 1, 59, 59)).as_deref(), Some("2026-03-08T06:59:59.000Z"));
        assert_eq!(iso(civil(2026, 3, 8, 3, 0, 0)).as_deref(), Some("2026-03-08T07:00:00.000Z"));
        // 重なり(2:00 → 1:00)は早い方(夏時間のまま)
        assert_eq!(iso(civil(2026, 11, 1, 1, 30, 0)).as_deref(), Some("2026-11-01T05:30:00.000Z"));
        assert_eq!(iso(civil(2026, 11, 1, 2, 0, 0)).as_deref(), Some("2026-11-01T07:00:00.000Z"));
        // 夏と冬
        assert_eq!(iso(civil(2026, 7, 1, 10, 0, 0)).as_deref(), Some("2026-07-01T14:00:00.000Z"));
        assert_eq!(iso(civil(2026, 1, 15, 10, 0, 0)).as_deref(), Some("2026-01-15T15:00:00.000Z"));
        // parse_ms からも同じ
        assert_eq!(parse_ms_in("2026-03-08T02:30", &tz), Some(1772955000000));
        assert_eq!(parse_ms_in("2026-11-01 01:30", &tz).map(to_iso).as_deref(), Some("2026-11-01T05:30:00.000Z"));
    }

    #[test]
    fn dst_utc_to_local() {
        let tz = est();
        let local = |iso: &str| local_parts_in(parse_ms_in(iso, &tz).unwrap(), &tz).unwrap();
        assert_eq!(local("2026-03-08T06:59:59Z"), civil(2026, 3, 8, 1, 59, 59));
        assert_eq!(local("2026-03-08T07:00:00Z"), civil(2026, 3, 8, 3, 0, 0));
        assert_eq!(local("2026-11-01T05:30:00Z"), civil(2026, 11, 1, 1, 30, 0));
        assert_eq!(local("2026-11-01T06:30:00Z"), civil(2026, 11, 1, 1, 30, 0));
        assert_eq!(local("2026-11-01T07:00:00Z"), civil(2026, 11, 1, 2, 0, 0));
        assert_eq!(local("2026-07-01T14:00:00Z"), civil(2026, 7, 1, 10, 0, 0));
        assert_eq!(local("2026-01-15T15:00:00Z"), civil(2026, 1, 15, 10, 0, 0));
    }

    #[test]
    fn far_years_use_boundary_offset() {
        let tz = jst();
        // jiff の範囲(±9999 年)の外も、固定の時差ならそのまま引く
        assert_eq!(parse_ms_in("+010000-01-01T09:00", &tz), Some(253402300800000));
        assert_eq!(local_parts_in(253402300800000, &tz), Some(civil(10000, 1, 1, 9, 0, 0)));
        // 範囲の端のあと 9 時間は、ローカル時刻だと翌年(+262143 年)になる
        assert_eq!(local_parts_in(8210266876799999, &tz), Some(civil(262_143, 1, 1, 8, 59, 59)));
        assert_eq!(local_parts_in(8210266876800000, &tz), None);
        // UTC が範囲の外になるローカル時刻は None
        assert_eq!(parse_ms_in("-262143-01-01T00:00", &tz), None);
        assert_eq!(parse_ms_in("-262143-01-01T09:00", &tz).map(to_iso).as_deref(), Some("-262143-01-01T00:00:00.000Z"));
    }

    #[test]
    fn offset_parts_and_http_date() {
        assert_eq!(offset_parts(1782864000123, 9 * 3600), Some(civil(2026, 7, 1, 9, 0, 0)));
        assert_eq!(offset_parts(1782864000123, -5 * 3600), Some(civil(2026, 6, 30, 19, 0, 0)));
        assert_eq!(offset_parts(8210266876800000, 0), None);
        assert_eq!(http_date(1782864000123), "Wed, 01 Jul 2026 00:00:00 GMT");
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(-1), "Wed, 31 Dec 1969 23:59:59 GMT");
        assert_eq!(http_date(951782400000), "Tue, 29 Feb 2000 00:00:00 GMT");
    }

    #[test]
    fn with_zone_restores() {
        let before = local_parts(0);
        with_zone(&TimeZone::fixed(Offset::constant(-3)), || {
            assert_eq!(local_parts(0), Some(civil(1969, 12, 31, 21, 0, 0)));
            with_zone(&jst(), || assert_eq!(local_parts(0), Some(civil(1970, 1, 1, 9, 0, 0))));
            assert_eq!(local_parts(0), Some(civil(1969, 12, 31, 21, 0, 0)));
        });
        assert_eq!(local_parts(0), before);
    }
}
