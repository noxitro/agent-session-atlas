//! atlas 自身の版の形と集計(packages/core/src/atlas-version.ts の移植)。アップロードしたフォルダに添え、
//! 送り先から集計するときに、古い版で送ったものが混ざっていないかを数える。版の新旧は git のコミットの日時で決める。
//! 版をこの PC の git から読むのは atlas_build.rs。

use crate::collate::locale_compare;
use crate::js::{self, JsMap};
use crate::jsdate;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasBuild {
    /// git のコミット(全桁)。分からなければ null
    pub commit: Option<String>,
    /// そのコミットの日時(ISO、UTC)。commit が null なら null
    pub committed_at: Option<String>,
    /// git が管理しているファイルを手で変えていた。分からなければ null
    pub dirty: Option<bool>,
    /// コードの目印(code_stamp.rs)
    pub code: String,
}

/// git のコミット(SHA-1 か SHA-256 の全桁)
pub static COMMIT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40}([0-9a-f]{24})?$").unwrap());
static CODE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{8,64}$").unwrap());

/// 添えた記録の atlas を読む(形が違えば None)
pub fn parse_atlas_build(v: Option<&Value>) -> Option<AtlasBuild> {
    let o = v?.as_object()?;
    let code = js::str_of(o.get("code")).filter(|c| CODE_RE.is_match(c))?;
    let commit = js::str_of(o.get("commit")).filter(|c| COMMIT_RE.is_match(c)).map(str::to_string);
    let t = match (&commit, js::str_of(o.get("committedAt"))) {
        (Some(_), Some(at)) if js::utf16_len(at) <= 40 => jsdate::parse_ms(at),
        _ => None,
    };
    let dirty = match o.get("dirty") {
        Some(Value::Bool(b)) => Some(*b),
        _ => None,
    };
    Some(AtlasBuild { commit, committed_at: t.map(jsdate::to_iso), dirty, code: code.to_string() })
}

/// フォルダごとの、最後に送ったときの記録
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderUpload {
    pub uploaded_at: Option<String>,
    pub atlas: Option<AtlasBuild>,
    /// 索引はあるが読めなかった
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unreadable: Option<bool>,
}

/// 最後に送ったときの版が、いちばん新しい版でないフォルダ
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleFolder {
    pub folder: String,
    pub uploaded_at: Option<String>,
    /// older / unknown / undated / unreadable
    pub reason: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasBuildGroup {
    pub commit: Option<String>,
    pub committed_at: Option<String>,
    pub code: String,
    pub dirty: i64,
    pub sessions: i64,
    pub persons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestBuild {
    pub commit: String,
    pub committed_at: String,
    pub local: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasBuildSummary {
    pub sessions: i64,
    pub unknown: i64,
    pub unknown_persons: Vec<String>,
    pub undated: i64,
    pub latest: Option<LatestBuild>,
    pub older: i64,
    pub older_persons: Vec<String>,
    pub dirty: i64,
    pub builds: Vec<AtlasBuildGroup>,
    pub local: Option<AtlasBuild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<StaleFolder>>,
}

/// 集計に使うセッションの項目(uploadAtlas が None = この PC の記録は数えない)
pub struct SentSession<'a> {
    pub person: Option<&'a str>,
    pub upload_atlas: Option<Option<&'a AtlasBuild>>,
}

fn time(at: Option<&str>) -> Option<i64> {
    at.filter(|s| !s.is_empty()).and_then(jsdate::parse_ms)
}

fn cmp_f(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

fn sorted_js(v: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = v.into_iter().collect();
    out.sort_by(|a, b| js::cmp_utf16(a, b));
    out
}

/// 送り先から集計したセッションの、送った atlas の版を数える。送り先から集計したセッションが 1 件も無ければ None
pub fn summarize_atlas_builds(sessions: &[SentSession<'_>], local: Option<&AtlasBuild>, folders: Option<&JsMap<FolderUpload>>) -> Option<AtlasBuildSummary> {
    let sent: Vec<&SentSession<'_>> = sessions.iter().filter(|s| s.upload_atlas.is_some()).collect();
    if sent.is_empty() {
        return None;
    }
    struct G {
        g: AtlasBuildGroup,
        people: BTreeSet<String>,
    }
    let mut groups: indexmap::IndexMap<String, G> = indexmap::IndexMap::new();
    let mut unknown_people: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    let mut unknown = 0;
    let mut dirty = 0;
    for s in &sent {
        let Some(b) = s.upload_atlas.unwrap() else {
            unknown += 1;
            if let Some(p) = s.person.filter(|p| !p.is_empty()) {
                unknown_people.insert(p.to_string());
            }
            continue;
        };
        let key = b.commit.clone().unwrap_or_else(|| format!("code:{}", b.code));
        let g = groups.entry(key).or_insert_with(|| G {
            g: AtlasBuildGroup { commit: b.commit.clone(), committed_at: b.committed_at.clone(), code: b.code.clone(), dirty: 0, sessions: 0, persons: Vec::new() },
            people: BTreeSet::new(),
        });
        g.g.sessions += 1;
        if b.dirty == Some(true) {
            g.g.dirty += 1;
            dirty += 1;
        }
        if let Some(p) = s.person.filter(|p| !p.is_empty()) {
            g.people.insert(p.to_string());
        }
    }
    let order = |x: Option<i64>| x.map_or(f64::NEG_INFINITY, |v| v as f64);
    let mut builds: Vec<AtlasBuildGroup> = groups
        .into_values()
        .map(|G { mut g, people }| {
            g.persons = sorted_js(people);
            g
        })
        .collect();
    builds.sort_by(|a, b| {
        let d = order(time(b.committed_at.as_deref())) - order(time(a.committed_at.as_deref()));
        let d = if d.is_nan() { 0.0 } else { d };
        cmp_f(d, 0.0).then_with(|| locale_compare(a.commit.as_deref().unwrap_or(&a.code), b.commit.as_deref().unwrap_or(&b.code)))
    });
    // いちばん新しい版(同じ日時なら送った側を先に見る)
    let mut latest: Option<LatestBuild> = None;
    let mut cands: Vec<(Option<String>, Option<String>, bool)> = builds.iter().map(|g| (g.commit.clone(), g.committed_at.clone(), false)).collect();
    if let Some(f) = folders {
        for (_, u) in f.js_entries() {
            if let Some(a) = &u.atlas {
                cands.push((a.commit.clone(), a.committed_at.clone(), false));
            }
        }
    }
    if let Some(l) = local {
        cands.push((l.commit.clone(), l.committed_at.clone(), true));
    }
    for (commit, at, is_local) in cands {
        let (Some(commit), Some(at)) = (commit.filter(|c| !c.is_empty()), at.filter(|a| !a.is_empty())) else { continue };
        let Some(t) = time(Some(&at)) else { continue };
        if latest.as_ref().is_none_or(|l| time(Some(&l.committed_at)).is_none_or(|lt| t > lt)) {
            latest = Some(LatestBuild { commit, committed_at: at, local: is_local });
        }
    }
    let mut older = 0;
    let mut undated = 0;
    let mut older_people: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for g in &builds {
        let gt = time(g.committed_at.as_deref());
        if g.commit.as_deref().is_none_or(str::is_empty) || gt.is_none() {
            undated += g.sessions;
            continue;
        }
        if let Some(l) = &latest {
            if g.commit.as_deref() != Some(l.commit.as_str()) && gt.zip(time(Some(&l.committed_at))).is_some_and(|(a, b)| a < b) {
                older += g.sessions;
                for p in &g.persons {
                    older_people.insert(p.clone());
                }
            }
        }
    }
    let folders_out = folders.map(|f| stale_folders(f, latest.as_ref()));
    Some(AtlasBuildSummary {
        sessions: sent.len() as i64,
        unknown,
        unknown_persons: sorted_js(unknown_people),
        undated,
        latest,
        older,
        older_persons: sorted_js(older_people),
        dirty,
        builds,
        local: local.cloned(),
        folders: folders_out,
    })
}

/// 最後に送ったときの版が、いちばん新しい版でないフォルダ。最後に送った日時の古い順
pub fn stale_folders(folders: &JsMap<FolderUpload>, latest: Option<&LatestBuild>) -> Vec<StaleFolder> {
    let mut out = Vec::new();
    for (folder, f) in folders.js_entries() {
        let sf = |reason: &str, uploaded_at: Option<String>, label: Option<String>| StaleFolder { folder: folder.clone(), uploaded_at, reason: reason.into(), label };
        match &f.atlas {
            _ if f.unreadable == Some(true) => out.push(sf("unreadable", None, None)),
            None => out.push(sf("unknown", f.uploaded_at.clone(), None)),
            Some(b) => {
                let bt = time(b.committed_at.as_deref());
                if b.commit.as_deref().is_none_or(str::is_empty) || bt.is_none() {
                    out.push(sf("undated", f.uploaded_at.clone(), Some(build_label(b.commit.as_deref(), &b.code))));
                } else if let Some(l) = latest {
                    if b.commit.as_deref() != Some(l.commit.as_str()) && bt.zip(time(Some(&l.committed_at))).is_some_and(|(a, c)| a < c) {
                        out.push(sf("older", f.uploaded_at.clone(), Some(build_label(b.commit.as_deref(), &b.code))));
                    }
                }
            }
        }
    }
    let at = |x: &StaleFolder| time(x.uploaded_at.as_deref()).map_or(f64::NEG_INFINITY, |v| v as f64);
    out.sort_by(|a, b| {
        let d = at(a) - at(b);
        let d = if d.is_nan() { 0.0 } else { d };
        cmp_f(d, 0.0).then_with(|| locale_compare(&a.folder, &b.folder))
    });
    out
}

/// 版の短い名前(コミットの先頭 7 桁、git が無ければ目印)
pub fn build_label(commit: Option<&str>, code: &str) -> String {
    match commit.filter(|c| !c.is_empty()) {
        Some(c) => js::utf16_slice(c, 0, 7).into_owned(),
        None => format!("目印 {}", js::utf16_slice(code, 0, 8)),
    }
}

fn day(at: Option<&str>) -> String {
    match at.filter(|s| !s.is_empty()) {
        Some(a) => js::utf16_slice(a, 0, 10).into_owned(),
        None => "日時不明".into(),
    }
}

fn whose(persons: &[String]) -> String {
    if persons.is_empty() {
        return String::new();
    }
    let more = if persons.len() > 5 { format!(" ほか {} 人", persons.len() - 5) } else { String::new() };
    format!("({}{more})", persons.iter().take(5).cloned().collect::<Vec<_>>().join("、"))
}

const STALE_REASONS: [&str; 4] = ["older", "unknown", "undated", "unreadable"];

fn stale_short(r: &str) -> &'static str {
    match r {
        "older" => "古い版で最後に送ったフォルダ",
        "unknown" => "版の記録が無いフォルダ",
        "undated" => "新旧を決められない版で最後に送ったフォルダ",
        _ => "索引を読めないフォルダ",
    }
}

fn stale_why(r: &str) -> &'static str {
    match r {
        "older" => "古い版",
        "unknown" => "版の記録なし",
        "undated" => "新旧を決められない版",
        _ => "索引を読めない",
    }
}

/// 人ごとのまとめに出す人数の上限
const STALE_PEOPLE_MAX: usize = 20;

/// フォルダの持ち主
pub fn folder_owner(folder: &str) -> String {
    if folder == "." {
        return "(このフォルダ)".into();
    }
    match folder.find('/') {
        Some(i) => folder[..i].to_string(),
        None => folder.to_string(),
    }
}

fn stale_by_owner(stale: &[StaleFolder]) -> Vec<String> {
    let mut by: indexmap::IndexMap<String, Vec<&StaleFolder>> = indexmap::IndexMap::new();
    for f in stale {
        by.entry(folder_owner(&f.folder)).or_default().push(f);
    }
    let order = |xs: &[&StaleFolder]| xs.iter().map(|f| time(f.uploaded_at.as_deref()).map_or(f64::NEG_INFINITY, |v| v as f64)).fold(f64::INFINITY, f64::min);
    let mut people: Vec<(String, Vec<&StaleFolder>)> = by.into_iter().collect();
    people.sort_by(|a, b| {
        let d = order(&a.1) - order(&b.1);
        let d = if d.is_nan() { 0.0 } else { d };
        cmp_f(d, 0.0).then_with(|| locale_compare(&a.0, &b.0))
    });
    let mut lines: Vec<String> = people
        .iter()
        .take(STALE_PEOPLE_MAX)
        .map(|(owner, xs)| {
            let counts: Vec<(&str, usize)> = STALE_REASONS.iter().map(|r| (*r, xs.iter().filter(|f| f.reason == *r).count())).filter(|(_, n)| *n > 0).collect();
            let dates = sorted_js(xs.iter().filter_map(|f| f.uploaded_at.clone()));
            let mut labels: indexmap::IndexSet<String> = indexmap::IndexSet::new();
            for f in xs {
                if let Some(l) = &f.label {
                    labels.insert(l.clone());
                }
            }
            let labels: Vec<String> = labels.into_iter().collect();
            let counts_s = counts.iter().map(|(r, n)| format!("{} {n}", stale_why(r))).collect::<Vec<_>>().join("・");
            let labels_s = if labels.is_empty() { String::new() } else { format!("。版 {}{}", labels.iter().take(3).cloned().collect::<Vec<_>>().join("、"), if labels.len() > 3 { " ほか" } else { "" }) };
            let dates_s = if dates.is_empty() { String::new() } else { format!("。いちばん前に送ったのは {}", day(Some(&dates[0]))) };
            format!("  {owner}: {} フォルダ({counts_s}{labels_s}{dates_s})", xs.len())
        })
        .collect();
    if people.len() > STALE_PEOPLE_MAX {
        lines.push(format!("  ほか {} 人", people.len() - STALE_PEOPLE_MAX));
    }
    lines
}

pub struct AtlasBuildsDescription {
    pub ok: bool,
    pub short: String,
    pub headline: String,
    pub lines: Vec<String>,
}

/// 集計した版を、CLI のログと画面の見出しに出す言葉にする
pub fn describe_atlas_builds(s: &AtlasBuildSummary) -> AtlasBuildsDescription {
    let empty = Vec::new();
    let stale = s.folders.as_ref().unwrap_or(&empty);
    let ok = s.older == 0 && s.unknown == 0 && s.undated == 0 && s.dirty == 0 && stale.is_empty();
    let mut parts: Vec<String> = Vec::new();
    if s.older > 0 {
        parts.push(format!("古い版 {} 件", s.older));
    }
    if s.unknown > 0 {
        parts.push(format!("版の記録なし {} 件", s.unknown));
    }
    if s.undated > 0 {
        parts.push(format!("新旧を決められない版 {} 件", s.undated));
    }
    if s.dirty > 0 {
        parts.push(format!("手で変えた版 {} 件", s.dirty));
    }
    for r in STALE_REASONS {
        let n = stale.iter().filter(|f| f.reason == r).count();
        if n > 0 {
            parts.push(format!("{} {n} 件", stale_short(r)));
        }
    }
    let short = if ok { "すべて最新".to_string() } else { parts.join("・") };
    let headline = if ok {
        format!("送った atlas の版: すべて最新{}", s.latest.as_ref().map(|l| format!("({})", js::utf16_slice(&l.commit, 0, 7))).unwrap_or_default())
    } else {
        format!("送った atlas の版: {} 件のうち {short}", s.sessions)
    };
    let mut lines = Vec::new();
    if let Some(l) = &s.latest {
        lines.push(format!("いちばん新しい版: {}({} のコミット{})", js::utf16_slice(&l.commit, 0, 7), day(Some(&l.committed_at)), if l.local { "。この PC の版" } else { "" }));
    }
    for g in &s.builds {
        let old = match &s.latest {
            Some(l) => g.commit.as_deref().is_some_and(|c| !c.is_empty() && c != l.commit) && time(g.committed_at.as_deref()).zip(time(Some(&l.committed_at))).is_some_and(|(a, b)| a < b),
            None => false,
        };
        lines.push(format!(
            "{}({}){}: {} 件{}{}",
            build_label(g.commit.as_deref(), &g.code),
            day(g.committed_at.as_deref()),
            if old { " 古い版" } else { "" },
            g.sessions,
            if g.dirty > 0 { format!("(うち手で変えた版 {} 件)", g.dirty) } else { String::new() },
            whose(&g.persons)
        ));
    }
    if s.unknown > 0 {
        lines.push(format!("版の記録なし(この記録を書く前の版で送ったもの): {} 件{}", s.unknown, whose(&s.unknown_persons)));
    }
    if !stale.is_empty() {
        lines.push(format!("最後に送ったときの版が最新でないフォルダ {} 件(人ごと。フォルダごとの全部は sessions.json の source.uploads):", stale.len()));
        lines.extend(stale_by_owner(stale));
        if stale.iter().any(|f| f.reason == "unreadable") {
            lines.push("索引を読めなかったフォルダは、送っている最中だったのかもしれません。集計し直すと読めることがあります".into());
        }
    }
    if let Some(local) = &s.local {
        let same = s.latest.as_ref().is_some_and(|l| l.local && Some(l.commit.as_str()) == local.commit.as_deref());
        if !same {
            lines.push(format!("この PC の版: {}({}){}", build_label(local.commit.as_deref(), &local.code), day(local.committed_at.as_deref()), if local.dirty == Some(true) { "。手で変えた版" } else { "" }));
        }
    }
    AtlasBuildsDescription { ok, short, headline, lines }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b(commit: Option<&str>, at: Option<&str>, code: &str) -> AtlasBuild {
        AtlasBuild { commit: commit.map(str::to_string), committed_at: at.map(str::to_string), dirty: Some(false), code: code.into() }
    }

    #[test]
    fn parse() {
        let c = "a".repeat(40);
        let v = json!({"commit": c, "committedAt": "2026-07-01T09:00:00+09:00", "dirty": true, "code": "0123abcd"});
        let p = parse_atlas_build(Some(&v)).unwrap();
        assert_eq!(p.committed_at.as_deref(), Some("2026-07-01T00:00:00.000Z"));
        assert_eq!(p.dirty, Some(true));
        assert_eq!(parse_atlas_build(Some(&json!({"code": "xyz"}))), None);
        assert_eq!(parse_atlas_build(Some(&json!({"commit": "nope", "code": "0123abcd"}))).unwrap().commit, None);
    }

    #[test]
    fn summarize_and_describe() {
        let new = "b".repeat(40);
        let old = "a".repeat(40);
        let bn = b(Some(&new), Some("2026-07-02T00:00:00.000Z"), "11111111");
        let bo = b(Some(&old), Some("2026-07-01T00:00:00.000Z"), "22222222");
        let ss = [
            SentSession { person: Some("p1"), upload_atlas: Some(Some(&bn)) },
            SentSession { person: Some("p2"), upload_atlas: Some(Some(&bo)) },
            SentSession { person: Some("p3"), upload_atlas: Some(None) },
            SentSession { person: None, upload_atlas: None },
        ];
        let s = summarize_atlas_builds(&ss, None, None).unwrap();
        assert_eq!(s.sessions, 3);
        assert_eq!(s.older, 1);
        assert_eq!(s.unknown, 1);
        assert_eq!(s.latest.as_ref().unwrap().commit, new);
        let d = describe_atlas_builds(&s);
        assert!(!d.ok);
        assert_eq!(d.headline, "送った atlas の版: 3 件のうち 古い版 1 件・版の記録なし 1 件");
        assert_eq!(d.lines[0], "いちばん新しい版: bbbbbbb(2026-07-02 のコミット)");
        assert_eq!(d.lines[2], "aaaaaaa(2026-07-01) 古い版: 1 件(p2)");
        assert!(summarize_atlas_builds(&ss[3..], None, None).is_none());
    }
}
