//! 稼働時間帯(atlas.config.json の tasks.workHours)と、ある期間のうち稼働時間帯に入る長さ。
//! 時刻はこの PC のローカル時刻で見る(集計した PC の時間帯)。祝日は数えない(稼働日の曜日だけを見る)。

use atlas_core::jsdate::{local_ms, local_parts, Civil};

/// 稼働時間帯。days は曜日(1 = 月曜 … 7 = 日曜)、start_min・end_min は 0 時からの分(end は 24:00 = 1440 まで)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkHours {
    pub days: Vec<u8>,
    pub start_min: u32,
    pub end_min: u32,
}

impl Default for WorkHours {
    /// 月曜〜金曜の 9:00〜18:00
    fn default() -> Self {
        WorkHours { days: vec![1, 2, 3, 4, 5], start_min: 9 * 60, end_min: 18 * 60 }
    }
}

/// 数える日数の上限(誤った日付で長く回らないように。約 10 年。これより長い期間は、始めから 10 年分だけを数える)
pub const MAX_DAYS: i64 = 3_700;

/// "HH:MM" を 0 時からの分に。allow_24 なら "24:00" も受け付ける(終わりの時刻だけ)
pub fn parse_hhmm(s: &str, allow_24: bool) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    if h.len() != 2 || m.len() != 2 || !h.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    if m >= 60 {
        return None;
    }
    match h {
        0..=23 => Some(h * 60 + m),
        24 if allow_24 && m == 0 => Some(1440),
        _ => None,
    }
}

/// 0 時からの分を "HH:MM" に
pub fn format_hhmm(min: u32) -> String {
    format!("{:02}:{:02}", min / 60, min % 60)
}

/// 1970-01-01 からの日数(Howard Hinnant の days_from_civil)
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 曜日(1 = 月曜 … 7 = 日曜)
pub fn weekday(c: Civil) -> u8 {
    // 1970-01-01 は木曜(4)
    ((days_from_civil(c.year as i64, c.month, c.day) + 3).rem_euclid(7) + 1) as u8
}

/// [start_ms, end_ms] のうち、稼働時間帯に入る長さ(ミリ秒)。end が start より前なら 0
pub fn work_overlap_ms(start_ms: i64, end_ms: i64, wh: &WorkHours) -> f64 {
    if end_ms <= start_ms || wh.end_min <= wh.start_min || wh.days.is_empty() {
        return 0.0;
    }
    let (Some(a), Some(b)) = (local_parts(start_ms), local_parts(end_ms)) else { return 0.0 };
    let (Some(mut day), Some(last)) = (Civil::date(a.year, a.month, a.day), Civil::date(b.year, b.month, b.day)) else { return 0.0 };
    let mut total: i64 = 0;
    for _ in 0..MAX_DAYS {
        if wh.days.contains(&weekday(day)) {
            let from = day.at(wh.start_min / 60, wh.start_min % 60, 0).and_then(local_ms);
            let to = if wh.end_min >= 1440 { day.add_days(1).and_then(local_ms) } else { day.at(wh.end_min / 60, wh.end_min % 60, 0).and_then(local_ms) };
            if let (Some(from), Some(to)) = (from, to) {
                let lo = from.max(start_ms);
                let hi = to.min(end_ms);
                if hi > lo {
                    total += hi - lo;
                }
            }
        }
        if day == last {
            break;
        }
        match day.add_days(1) {
            Some(d) => day = d,
            None => break,
        }
    }
    total as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::jsdate::{parse_ms, with_zone, Offset, TimeZone};

    const H: f64 = 3_600_000.0;

    fn jst<R>(f: impl FnOnce() -> R) -> R {
        with_zone(&TimeZone::fixed(Offset::constant(9)), f)
    }

    fn ms(s: &str) -> i64 {
        parse_ms(s).unwrap()
    }

    #[test]
    fn hhmm() {
        assert_eq!(parse_hhmm("09:00", false), Some(540));
        assert_eq!(parse_hhmm("23:59", false), Some(1439));
        assert_eq!(parse_hhmm("24:00", true), Some(1440));
        for bad in ["24:00", "9:00", "09:60", "0900", "aa:bb", "", "09:00:00", "-1:00"] {
            assert_eq!(parse_hhmm(bad, false), None, "{bad}");
        }
        assert_eq!(parse_hhmm("24:01", true), None);
        assert_eq!(format_hhmm(540), "09:00");
        assert_eq!(format_hhmm(1440), "24:00");
    }

    #[test]
    fn weekdays() {
        assert_eq!(weekday(Civil::date(1970, 1, 1).unwrap()), 4);
        // 2026-11-23 は月曜、2026-11-29 は日曜
        assert_eq!(weekday(Civil::date(2026, 11, 23).unwrap()), 1);
        assert_eq!(weekday(Civil::date(2026, 11, 29).unwrap()), 7);
        assert_eq!(weekday(Civil::date(2024, 2, 29).unwrap()), 4);
    }

    #[test]
    fn same_day_partial_and_outside() {
        jst(|| {
            let wh = WorkHours::default();
            // 月曜 10:00〜12:30(JST) = 2.5 時間
            assert_eq!(work_overlap_ms(ms("2026-11-23T10:00:00+09:00"), ms("2026-11-23T12:30:00+09:00"), &wh), 2.5 * H);
            // 8:00〜10:00 は 9:00 から数える
            assert_eq!(work_overlap_ms(ms("2026-11-23T08:00:00+09:00"), ms("2026-11-23T10:00:00+09:00"), &wh), 1.0 * H);
            // 稼働時間帯の外だけ
            assert_eq!(work_overlap_ms(ms("2026-11-23T18:30:00+09:00"), ms("2026-11-23T23:00:00+09:00"), &wh), 0.0);
            // 逆向き・同じ時刻は 0
            assert_eq!(work_overlap_ms(ms("2026-11-23T12:00:00+09:00"), ms("2026-11-23T10:00:00+09:00"), &wh), 0.0);
            assert_eq!(work_overlap_ms(ms("2026-11-23T12:00:00+09:00"), ms("2026-11-23T12:00:00+09:00"), &wh), 0.0);
        });
    }

    #[test]
    fn overnight_and_weekend() {
        jst(|| {
            let wh = WorkHours::default();
            // 月曜 17:00 〜 火曜 10:00: 月曜 1 時間 + 火曜 1 時間(夜は数えない)
            assert_eq!(work_overlap_ms(ms("2026-11-23T17:00:00+09:00"), ms("2026-11-24T10:00:00+09:00"), &wh), 2.0 * H);
            // 金曜 17:00 〜 月曜 10:00: 土日を飛ばして 1 + 1 時間
            assert_eq!(work_overlap_ms(ms("2026-11-27T17:00:00+09:00"), ms("2026-11-30T10:00:00+09:00"), &wh), 2.0 * H);
            // 土曜だけ
            assert_eq!(work_overlap_ms(ms("2026-11-28T09:00:00+09:00"), ms("2026-11-28T18:00:00+09:00"), &wh), 0.0);
            // まる 1 週間(月曜 0:00 〜 翌月曜 0:00)は 5 日 × 9 時間
            assert_eq!(work_overlap_ms(ms("2026-11-23T00:00:00+09:00"), ms("2026-11-30T00:00:00+09:00"), &wh), 45.0 * H);
            // 土日も稼働日にした設定
            let all = WorkHours { days: (1..=7).collect(), ..WorkHours::default() };
            assert_eq!(work_overlap_ms(ms("2026-11-28T09:00:00+09:00"), ms("2026-11-28T18:00:00+09:00"), &all), 9.0 * H);
        });
    }

    #[test]
    fn uses_local_time_and_24_end() {
        let wh = WorkHours::default();
        // UTC の 00:00〜09:00 は JST では 9:00〜18:00(月曜)
        let (a, b) = (ms("2026-11-23T00:00:00Z"), ms("2026-11-23T09:00:00Z"));
        assert_eq!(jst(|| work_overlap_ms(a, b, &wh)), 9.0 * H);
        assert_eq!(with_zone(&TimeZone::UTC, || work_overlap_ms(a, b, &wh)), 0.0);
        let night = WorkHours { days: vec![1], start_min: 22 * 60, end_min: 1440 };
        assert_eq!(jst(|| work_overlap_ms(ms("2026-11-23T21:00:00+09:00"), ms("2026-11-24T03:00:00+09:00"), &night)), 2.0 * H);
        // 設定が空なら 0
        let none = WorkHours { days: vec![], ..WorkHours::default() };
        assert_eq!(jst(|| work_overlap_ms(a, b, &none)), 0.0);
    }

    #[test]
    fn daylight_saving_days_count_wall_clock_hours() {
        // 米国東部の夏時間の始まり(2026-03-08。2:00 が 3:00 に飛ぶ)でも、9:00〜18:00 は 9 時間
        with_zone(&TimeZone::posix("EST5EDT,M3.2.0,M11.1.0").unwrap(), || {
            let all = WorkHours { days: (1..=7).collect(), ..WorkHours::default() };
            assert_eq!(work_overlap_ms(ms("2026-03-08T00:00:00-05:00"), ms("2026-03-09T00:00:00-04:00"), &all), 9.0 * H);
        });
    }
}
