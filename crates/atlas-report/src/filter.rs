//! セッションの絞り込み(packages/report/src/lib/filter.ts の移植のうち、CLI の --project 等が使う共通の述語)。
//! TODO(段 4・5): 画面の絞り込み(FilterState 全体・applyFilter・filterOptions など)は build・serve の移植で足す

use atlas_core::jsdate;
use atlas_core::types::SessionRecord;
use chrono::{Local, LocalResult, NaiveDate, TimeZone};

pub const ALL: &str = "";
pub const UNKNOWN: &str = "(unknown)";

/// 絞り込みに使う最小限の形(SessionRecord と画面の SessionSummary の両方が満たす)
pub trait Filterable {
    fn project(&self) -> &str;
    fn client(&self) -> Option<&str>;
    fn branch(&self) -> Option<&str>;
    fn models(&self) -> &[String];
    fn created_at(&self) -> Option<&str>;
    fn updated_at(&self) -> Option<&str>;
}

impl Filterable for SessionRecord {
    fn project(&self) -> &str {
        &self.project
    }
    fn client(&self) -> Option<&str> {
        self.client.as_deref()
    }
    fn branch(&self) -> Option<&str> {
        self.branch.as_deref()
    }
    fn models(&self) -> &[String] {
        &self.models
    }
    fn created_at(&self) -> Option<&str> {
        self.created_at.as_deref()
    }
    fn updated_at(&self) -> Option<&str> {
        self.updated_at.as_deref()
    }
}

/// 期間・プロジェクト・クライアント・モデル・ブランチ(FilterState の一部。空文字は制限なし)
#[derive(Debug, Clone, Copy, Default)]
pub struct BaseFilter<'a> {
    /// YYYY-MM-DD(ローカル日付、含む)
    pub from: &'a str,
    pub to: &'a str,
    pub project: &'a str,
    pub client: &'a str,
    pub model: &'a str,
    pub branch: &'a str,
}

/// セッションの基準時刻(作成日時、無ければ更新日時)。ミリ秒
pub fn session_time(s: &impl Filterable) -> Option<i64> {
    let t = s.created_at().or(s.updated_at())?;
    if t.is_empty() {
        return None;
    }
    jsdate::parse_ms(t)
}

/// セッションの最終更新の時刻(ミリ秒)。更新日時が無ければ開始日時、どちらも無ければ None
pub fn session_updated(s: &impl Filterable) -> Option<i64> {
    let t = s.updated_at().or(s.created_at())?;
    if t.is_empty() {
        return None;
    }
    jsdate::parse_ms(t)
}

/// YYYY-MM-DD をローカル日付の 0 時(ミリ秒)に。不正なら None
/// (JS の new Date(y, m - 1, d) と同じく、月日の繰り上がりを許す)
pub fn local_day_start(day: &str) -> Option<i64> {
    let b = day.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return None;
    }
    let (y, m, d): (i32, i64, i64) = (day[0..4].parse().ok()?, day[5..7].parse().ok()?, day[8..10].parse().ok()?);
    // new Date(y, …) は 0〜99 年を 1900 年代とみなす
    let y = if (0..=99).contains(&y) { 1900 + y } else { y };
    // 月・日の繰り上がり(13 月 → 翌年 1 月、0 日 → 前月末)
    let months = y as i64 * 12 + (m - 1);
    let first = NaiveDate::from_ymd_opt(months.div_euclid(12) as i32, (months.rem_euclid(12) + 1) as u32, 1)?;
    let date = first.checked_add_signed(chrono::Duration::days(d - 1))?;
    let dt = date.and_hms_opt(0, 0, 0)?;
    match Local.from_local_datetime(&dt) {
        LocalResult::Single(t) => Some(t.timestamp_millis()),
        LocalResult::Ambiguous(a, _) => Some(a.timestamp_millis()),
        LocalResult::None => Local.from_local_datetime(&(dt + chrono::Duration::hours(1))).earliest().map(|t| t.timestamp_millis()),
    }
}

fn eq_or_unknown(value: Option<&str>, want: &str) -> bool {
    if want == UNKNOWN { value.is_none() || value == Some(UNKNOWN) } else { value == Some(want) }
}

/// 期間・プロジェクト・クライアント・モデル・ブランチの共通述語
pub fn matches_base(s: &impl Filterable, f: &BaseFilter<'_>) -> bool {
    if !f.project.is_empty() && s.project() != f.project {
        return false;
    }
    if !f.client.is_empty() && !eq_or_unknown(s.client(), f.client) {
        return false;
    }
    if !f.branch.is_empty() && !eq_or_unknown(s.branch(), f.branch) {
        return false;
    }
    if !f.model.is_empty() {
        let ok = if f.model == UNKNOWN { s.models().is_empty() } else { s.models().iter().any(|m| m == f.model) };
        if !ok {
            return false;
        }
    }
    if !f.from.is_empty() || !f.to.is_empty() {
        // 日時不明は期間指定時に除外
        let Some(t) = session_time(s) else {
            return false;
        };
        let from = if f.from.is_empty() { None } else { local_day_start(f.from) };
        let to = if f.to.is_empty() { None } else { local_day_start(f.to) };
        if from.is_some_and(|x| t < x) {
            return false;
        }
        if to.is_some_and(|x| t >= x + 24 * 3600 * 1000) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_days() {
        let a = local_day_start("2026-01-31").unwrap();
        assert_eq!(local_day_start("2026-02-01").unwrap() - a, 24 * 3600 * 1000);
        // 月日の繰り上がりは JS の new Date と同じ
        assert_eq!(local_day_start("2026-01-32"), local_day_start("2026-02-01"));
        assert_eq!(local_day_start("2026-13-01"), local_day_start("2027-01-01"));
        assert_eq!(local_day_start("2026-1-01"), None);
    }
}
