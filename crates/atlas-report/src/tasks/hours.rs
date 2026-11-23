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

/// 先頭の数字(min〜max 桁)と残り
fn take_num(s: &str, min: usize, max: usize) -> Option<(u32, &str)> {
    let n = s.bytes().take_while(u8::is_ascii_digit).count();
    if n < min || n > max {
        return None;
    }
    Some((s[..n].parse().ok()?, &s[n..]))
}

/// 読んだ完了日時
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DoneAt {
    /// 完了の時刻(ミリ秒)。日付だけのものは、読んだ PC の時間帯での、その日の稼働時間帯の終わり(前の版の atlas が読む値)
    pub ms: i64,
    /// 日付だけ(時刻の無い日付か、時差の無い 0:00 ちょうど)のときの暦の日付。工数(稼働時間帯の終わり)と、候補と「完了の後に始まった」の判定
    /// (その日の 24:00)は、この日付と集計する PC の時間帯から決める(date_work_end_ms・date_end_ms)。時刻つきなら None
    pub date: Option<Civil>,
}

impl DoneAt {
    pub fn date_only(&self) -> bool {
        self.date.is_some()
    }
}

/// 暦の日付を "YYYY-MM-DD" に
pub fn format_date(c: Civil) -> String {
    format!("{:04}-{:02}-{:02}", c.year, c.month, c.day)
}

/// "YYYY-MM-DD"(月と日は 2 桁)を暦の日付に。暦に無い日・ほかの書き方は None
pub fn parse_date(s: &str) -> Option<Civil> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return None;
    }
    Civil::date(s[..4].parse().ok()?, s[5..7].parse().ok()?, s[8..].parse().ok()?)
}

/// 日付の、稼働時間帯の終わり(workHours.end。24:00 なら翌日の 0 時)の、この PC の時間帯での時刻。日付だけの完了日の工数はここまで
pub fn date_work_end_ms(date: Civil, wh: &WorkHours) -> Option<i64> {
    let end = if wh.end_min >= 1440 { date.add_days(1)? } else { date.at(wh.end_min / 60, wh.end_min % 60, 0)? };
    local_ms(end)
}

/// 日付の終わり(翌日の 0 時)の、この PC の時間帯での時刻。日付だけの完了日の、候補と「完了の後に始まった」の判定に使う
pub fn date_end_ms(date: Civil) -> Option<i64> {
    local_ms(date.add_days(1)?)
}

/// 日付だけの完了日の、暦の日付の文字("YYYY-MM-DD")。
/// done_date(この版が書いたもの)が読めればそれを使う。無ければ(前の版の tasks.json・送った人の記録は doneDateOnly だけ)、
/// 前の版と同じ計算で決める: done_at(その日の稼働時間帯の終わり。24:00 なら翌日の 0 時)の 1 ミリ秒前の、この PC の時間帯での日付
pub fn done_date_text(done_date: Option<&str>, done_at: Option<&str>) -> Option<String> {
    if let Some(d) = done_date.and_then(parse_date) {
        return Some(format_date(d));
    }
    let ms = done_at.and_then(atlas_core::jsdate::parse_ms)?;
    let p = local_parts(ms - 1)?;
    Civil::date(p.year, p.month, p.day).map(format_date)
}

/// 管理ツールの XML にある完了日時(設定の tasks.doneAt)を読む。読めなければ None。読む書き方は次のとおり:
/// - 日付: YYYY-MM-DD か YYYY/MM/DD(月と日は 1 桁でもよい)。暦に無い日(2 月 30 日など)は読まない
/// - 時刻(任意): 日付の後に T か空白を挟んで HH:MM、HH:MM:SS、HH:MM:SS.fff
/// - 時差(任意。時刻があるときだけ): Z か ±HH:MM か ±HHMM。無ければこの PC のローカル時刻
/// 時刻の無い日付と、時差の無い 0:00 ちょうど(`2026/11/20 0:00:00` など。日付だけの項目を日時の形で書き出す管理ツールがあるため)は、
/// 日付だけとして読む(date_only)。ms はその日の稼働時間帯の終わり(workHours.end。24:00 なら翌日の 0 時)のローカル時刻にする
/// (その日のうちに終わったとみなし、その日の稼働時間をすべて数える。稼働日でない曜日でも同じ時刻にする)。
/// 時差を書いた 0:00 は、書いたとおりの時刻にする(時差まで書いたものは、時刻も意図したものとみなす)
pub fn parse_done_at(s: &str, wh: &WorkHours) -> Option<DoneAt> {
    let s = s.trim();
    let (y, rest) = take_num(s, 4, 4)?;
    let sep = rest.chars().next().filter(|c| *c == '-' || *c == '/')?;
    let (m, rest) = take_num(&rest[1..], 1, 2)?;
    let rest = rest.strip_prefix(sep)?;
    let (d, rest) = take_num(rest, 1, 2)?;
    let date = Civil::date(y as i32, m, d)?;
    let date_only = |date: Civil| date_work_end_ms(date, wh).map(|ms| DoneAt { ms, date: Some(date) });
    if rest.is_empty() {
        return date_only(date);
    }
    let rest = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' '))?.trim_start();
    let (h, rest) = take_num(rest, 1, 2)?;
    let (mi, rest) = take_num(rest.strip_prefix(':')?, 2, 2)?;
    let (sec, rest) = match rest.strip_prefix(':') {
        Some(r) => take_num(r, 2, 2)?,
        None => (0, rest),
    };
    let (frac_ms, rest) = match rest.strip_prefix('.') {
        Some(r) => {
            let n = r.bytes().take_while(u8::is_ascii_digit).count();
            if n == 0 {
                return None;
            }
            let ms: String = r[..n].chars().chain(std::iter::repeat('0')).take(3).collect();
            (ms.parse::<i64>().ok()?, &r[n..])
        }
        None => (0, rest),
    };
    let at = date.at(h, mi, sec)?;
    let zone = rest.trim();
    if zone.is_empty() && (h, mi, sec, frac_ms) == (0, 0, 0, 0) {
        return date_only(date);
    }
    let base = if zone.is_empty() {
        local_ms(at)?
    } else {
        let off = if zone == "Z" || zone == "z" {
            "Z".to_string()
        } else {
            let sign = zone.chars().next().filter(|c| *c == '+' || *c == '-')?;
            let digits = zone[1..].replacen(':', "", 1);
            if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            format!("{sign}{}:{}", &digits[..2], &digits[2..])
        };
        atlas_core::jsdate::parse_ms(&format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{sec:02}{off}"))?
    };
    Some(DoneAt { ms: base + frac_ms, date: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::jsdate::{parse_ms, with_zone, Offset, TimeZone};

    /// 完了日時の書き方: ISO 8601・YYYY-MM-DD・YYYY/MM/DD(時刻あり・なし)。時刻の無い日付は稼働時間帯の終わり
    #[test]
    fn done_at_formats() {
        jst(|| {
            let wh = WorkHours::default();
            let p = |s: &str| parse_done_at(s, &wh).filter(|d| !d.date_only()).map(|d| d.ms);
            let day = |s: &str| parse_done_at(s, &wh).filter(|d| d.date_only()).map(|d| d.ms);
            assert_eq!(p("2026-11-20T15:30:00+09:00"), Some(ms("2026-11-20T15:30:00+09:00")));
            assert_eq!(p("2026-11-20T06:30:00Z"), Some(ms("2026-11-20T15:30:00+09:00")));
            assert_eq!(p("2026-11-20T15:30:00.250+0900"), Some(ms("2026-11-20T15:30:00+09:00") + 250));
            // 時差が無ければローカル時刻
            assert_eq!(p("2026-11-20T15:30"), Some(ms("2026-11-20T15:30:00+09:00")));
            assert_eq!(p("2026-11-20 15:30:10"), Some(ms("2026-11-20T15:30:10+09:00")));
            assert_eq!(p("2026/11/20 9:05"), Some(ms("2026-11-20T09:05:00+09:00")));
            assert_eq!(day(" 2026/1/5 "), Some(ms("2026-01-05T18:00:00+09:00")));
            // 時刻の無い日付は日付だけ(時刻はその日の稼働時間帯の終わり)
            assert_eq!(day("2026-11-20"), Some(ms("2026-11-20T18:00:00+09:00")));
            let late = WorkHours { end_min: 1440, ..WorkHours::default() };
            assert_eq!(parse_done_at("2026-11-20", &late), Some(DoneAt { ms: ms("2026-11-21T00:00:00+09:00"), date: Civil::date(2026, 11, 20) }));
            // 書いた日付の文字は、読んだ書き方によらず YYYY-MM-DD
            assert_eq!(parse_done_at(" 2026/1/5 ", &wh).and_then(|d| d.date).map(format_date).as_deref(), Some("2026-01-05"));
            // 時差の無い 0:00 ちょうどは日付だけとみなす(日付だけの項目を日時の形で書き出す管理ツールのため)
            for s in ["2026/11/20 0:00:00", "2026-11-20T00:00", "2026-11-20 00:00:00.000"] {
                assert_eq!(day(s), Some(ms("2026-11-20T18:00:00+09:00")), "{s}");
            }
            // 0:00 でも、時差を書いたもの・秒や小数があるものは書いたとおりの時刻
            assert_eq!(p("2026-11-20T00:00:00+09:00"), Some(ms("2026-11-20T00:00:00+09:00")));
            assert_eq!(p("2026-11-20T00:00:00Z"), Some(ms("2026-11-20T09:00:00+09:00")));
            assert_eq!(p("2026-11-20 0:00:01"), Some(ms("2026-11-20T00:00:01+09:00")));
            assert_eq!(p("2026-11-20 00:00:00.5"), Some(ms("2026-11-20T00:00:00+09:00") + 500));
            for bad in ["", "済み", "2026-02-30", "2026-13-01", "20261120", "2026-11-20T25:00", "2026-11-20T10", "2026-11/20", "26-11-20", "2026-11-20T10:00+9", "2026-11-20 10:00 JST", "2026-11-20T10:00:00.", "11/20/2026"] {
                assert_eq!(parse_done_at(bad, &wh), None, "{bad}");
            }
            // その日の終わり(候補と「完了の後に始まった」の判定に使う)
            let d = Civil::date(2026, 11, 20).unwrap();
            assert_eq!(date_end_ms(d), Some(ms("2026-11-21T00:00:00+09:00")));
            assert_eq!(date_work_end_ms(d, &late), Some(ms("2026-11-21T00:00:00+09:00")));
        });
    }

    /// 日付の文字は、見る PC の時間帯によらず同じ。締め切りと稼働時間帯の終わりは、その日付と集計する PC の時間帯から決める。
    /// 前の版の記録(doneDateOnly だけ)は、前の版と同じ計算で日付を決める
    #[test]
    fn done_date_text_does_not_move_with_the_time_zone() {
        let wh = WorkHours::default();
        // JST の PC で読んだ日付だけの完了日(doneAt は JST の 18:00 = 09:00Z)
        let read = jst(|| parse_done_at("2026/11/20", &wh)).unwrap();
        let date = read.date.map(format_date).unwrap();
        assert_eq!(date, "2026-11-20");
        assert_eq!(atlas_core::jsdate::to_iso(read.ms), "2026-11-20T09:00:00.000Z");
        let iso = atlas_core::jsdate::to_iso(read.ms);
        for off in [-10, -5, 0, 9, 14] {
            with_zone(&TimeZone::fixed(Offset::constant(off)), || {
                // 書いた日付の文字は、どの時間帯の PC でも同じ
                assert_eq!(done_date_text(Some(&date), Some(&iso)).as_deref(), Some("2026-11-20"), "{off}");
                // 締め切りと稼働時間帯の終わりは、その PC の時間帯の 11/21 0:00 と 11/20 18:00
                let d = parse_date(&date).unwrap();
                let local = |h: u32| local_ms(d.at(h, 0, 0).unwrap()).unwrap();
                assert_eq!(date_end_ms(d), Some(local(0) + 86_400_000), "{off}");
                assert_eq!(date_work_end_ms(d, &wh), Some(local(18)), "{off}");
            });
        }
        // 前の版の記録(日付の文字が無い)は、doneAt の 1 ミリ秒前の、見る PC の時間帯の日付(前と同じずれ方)
        assert_eq!(jst(|| done_date_text(None, Some(&iso))).as_deref(), Some("2026-11-20"));
        assert_eq!(with_zone(&TimeZone::fixed(Offset::constant(-10)), || done_date_text(None, Some(&iso))).as_deref(), Some("2026-11-19"));
        // 稼働時間帯の終わりが 24:00(翌日の 0 時)でも、前の日の日付
        assert_eq!(jst(|| done_date_text(None, Some("2026-11-20T15:00:00.000Z"))).as_deref(), Some("2026-11-20"));
        // 読めない日付の文字は、前の版と同じ計算に戻す
        assert_eq!(jst(|| done_date_text(Some("2026/11/20"), Some(&iso))).as_deref(), Some("2026-11-20"));
        for bad in ["2026-2-03", "2026-02-30", "20261120", "2026-11-20T00:00", ""] {
            assert_eq!(parse_date(bad), None, "{bad}");
        }
        assert_eq!(done_date_text(Some("x"), None), None);
    }

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
