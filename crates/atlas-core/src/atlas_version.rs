//! atlas 自身の版の形と集計(packages/core/src/atlas-version.ts の移植)。アップロードしたフォルダに添え、
//! 送り先から集計するときに、古い版で送ったものが混ざっていないかを、送った人ごとに数える。版の新旧は git のコミットの日時で決める。
//! 版をこの PC の git から読むのは atlas_build.rs。

use crate::collate::locale_compare;
use crate::js::{self, JsMap};
use crate::jsdate;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
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
pub struct LatestBuild {
    pub commit: String,
    pub committed_at: String,
    pub local: bool,
}

/// 送った人に対応を頼む理由 1 つ
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderProblem {
    /// older: 古い版で送った / dirty: 手で変えた版で送った / unknown: 版の記録が無い / undated: 新旧を決められない版で送った / unreadable: 索引を読めない
    pub reason: String,
    /// 当てはまるセッション
    pub sessions: i64,
    /// 最後に送ったときの版が当てはまるフォルダ
    pub folders: i64,
}

/// 送った人ごとのまとめ。人のフォルダの下に無いもの(プロジェクトのフォルダ 1 つなど)は、フォルダごと
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderBuilds {
    pub name: String,
    /// 送り先から集計したセッション
    pub sessions: i64,
    /// 対応を頼む理由(REASONS の順)。空なら、いちばん新しい版で送っている
    pub problems: Vec<SenderProblem>,
    /// 理由に当てはまる版の短い名前
    pub labels: Vec<String>,
    /// 理由に当てはまるフォルダを最後に送った日時(古い順)
    pub uploaded_at: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasBuildSummary {
    pub sessions: i64,
    pub latest: Option<LatestBuild>,
    pub local: Option<AtlasBuild>,
    /// 人ごとにまとめたか(送り先をまとめて集計したとき)。false ならフォルダごと
    pub by_people: bool,
    /// 送った人ごと。対応を頼む人が先(最後に送った日時の古い順)、その後にいちばん新しい版で送った人(名前の順)
    pub senders: Vec<SenderBuilds>,
}

/// 集計に使うセッションの項目(uploadAtlas が None = この PC の記録は数えない)
pub struct SentSession<'a> {
    pub person: Option<&'a str>,
    /// そのセッションを数えたフォルダ(送り先からの相対パス)。人の名前が無いときにまとめる名前と、最後に送った日時を引くのに使う
    pub folder: Option<&'a str>,
    pub upload_atlas: Option<Option<&'a AtlasBuild>>,
}

fn time(at: Option<&str>) -> Option<i64> {
    at.filter(|s| !s.is_empty()).and_then(jsdate::parse_ms)
}

fn cmp_f(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// 対応を頼む理由(出す順)
const REASONS: [&str; 5] = ["older", "dirty", "unknown", "undated", "unreadable"];

/// 版の新旧から決まる理由(いちばん新しい版なら None)。older: いちばん新しい版より古い / undated: git で取得していないなどで新旧を決められない
fn build_reason(b: &AtlasBuild, latest: Option<&LatestBuild>) -> Option<&'static str> {
    let t = time(b.committed_at.as_deref());
    if b.commit.as_deref().is_none_or(str::is_empty) || t.is_none() {
        return Some("undated");
    }
    let l = latest?;
    (b.commit.as_deref() != Some(l.commit.as_str()) && t.zip(time(Some(&l.committed_at))).is_some_and(|(a, c)| a < c)).then_some("older")
}

/// 送った人ごとに数える途中の形
#[derive(Default)]
struct SenderAcc {
    sessions: i64,
    /// 理由 → (セッション, フォルダ)
    counts: indexmap::IndexMap<&'static str, (i64, i64)>,
    labels: indexmap::IndexSet<String>,
    /// 理由に当てはまるフォルダ
    folders: indexmap::IndexSet<String>,
}

/// 送り先から集計したセッションの、送った atlas の版を、送った人ごとに数える。送り先から集計したセッションが 1 件も無ければ None
pub fn summarize_atlas_builds(sessions: &[SentSession<'_>], local: Option<&AtlasBuild>, folders: Option<&JsMap<FolderUpload>>) -> Option<AtlasBuildSummary> {
    let sent: Vec<&SentSession<'_>> = sessions.iter().filter(|s| s.upload_atlas.is_some()).collect();
    if sent.is_empty() {
        return None;
    }
    // 送った版(同じコミット、git が無ければ同じ目印をまとめる)。新しい順で、日時の無いものは後ろ
    let mut seen: indexmap::IndexMap<String, &AtlasBuild> = indexmap::IndexMap::new();
    for b in sent.iter().filter_map(|s| s.upload_atlas.unwrap()) {
        seen.entry(b.commit.clone().unwrap_or_else(|| format!("code:{}", b.code))).or_insert(b);
    }
    let order = |x: Option<i64>| x.map_or(f64::NEG_INFINITY, |v| v as f64);
    let mut builds: Vec<&AtlasBuild> = seen.into_values().collect();
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
    // 送った人ごと。人の名前が無いセッション(人のフォルダの下に無い)は、フォルダの名前でまとめる
    let by_people = sent.iter().any(|s| s.person.is_some_and(|p| !p.is_empty())) || folders.is_some_and(|f| f.keys().any(|k| k.contains('/')));
    let mut acc: indexmap::IndexMap<String, SenderAcc> = indexmap::IndexMap::new();
    for s in &sent {
        let name = match (s.person.filter(|p| !p.is_empty()), s.folder) {
            (Some(p), _) => p.to_string(),
            (None, Some(f)) => folder_owner(f),
            (None, None) => "(フォルダ不明)".to_string(),
        };
        let a = acc.entry(name).or_default();
        a.sessions += 1;
        let build = s.upload_atlas.unwrap();
        let reasons: Vec<&'static str> = match build {
            None => vec!["unknown"],
            Some(b) => build_reason(b, latest.as_ref()).into_iter().chain((b.dirty == Some(true)).then_some("dirty")).collect(),
        };
        if reasons.is_empty() {
            continue;
        }
        for r in reasons {
            a.counts.entry(r).or_default().0 += 1;
        }
        if let Some(b) = build {
            a.labels.insert(build_label(b.commit.as_deref(), &b.code));
        }
        if let Some(f) = s.folder {
            a.folders.insert(f.to_string());
        }
    }
    if let Some(f) = folders {
        // セッションを数えなかったフォルダの人も、送った人に数える。最後に送ったときの版が手で変えたものなら、それも理由にする
        for (folder, u) in f.js_entries() {
            let a = acc.entry(folder_owner(folder)).or_default();
            if let Some(b) = u.atlas.as_ref().filter(|b| b.dirty == Some(true) && u.unreadable != Some(true)) {
                a.counts.entry("dirty").or_default().1 += 1;
                a.labels.insert(build_label(b.commit.as_deref(), &b.code));
                a.folders.insert(folder.clone());
            }
        }
        for sf in stale_folders(f, latest.as_ref()) {
            let a = acc.entry(folder_owner(&sf.folder)).or_default();
            let reason = REASONS.into_iter().find(|r| *r == sf.reason).unwrap_or("unreadable");
            a.counts.entry(reason).or_default().1 += 1;
            if let Some(l) = sf.label {
                a.labels.insert(l);
            }
            a.folders.insert(sf.folder);
        }
    }
    let mut senders: Vec<SenderBuilds> = acc
        .into_iter()
        .map(|(name, a)| SenderBuilds {
            name,
            sessions: a.sessions,
            problems: REASONS.iter().filter_map(|r| a.counts.get(r).map(|(sessions, folders)| SenderProblem { reason: r.to_string(), sessions: *sessions, folders: *folders })).collect(),
            labels: a.labels.into_iter().collect(),
            uploaded_at: {
                let mut at: Vec<String> = a.folders.iter().filter_map(|k| folders.and_then(|f| f.get(k)).filter(|u| u.unreadable != Some(true)).and_then(|u| u.uploaded_at.clone())).collect();
                at.sort_by(|a, b| js::cmp_utf16(a, b));
                at
            },
        })
        .collect();
    // 対応を頼む人を先に(最後に送った日時の古い順。日時の分からないものは前)。その後に、いちばん新しい版で送った人
    let first = |x: &SenderBuilds| x.uploaded_at.first().and_then(|a| time(Some(a))).map_or(f64::NEG_INFINITY, |v| v as f64);
    senders.sort_by(|a, b| {
        a.problems.is_empty().cmp(&b.problems.is_empty()).then_with(|| {
            let d = if a.problems.is_empty() { 0.0 } else { first(a) - first(b) };
            let d = if d.is_nan() { 0.0 } else { d };
            cmp_f(d, 0.0).then_with(|| locale_compare(&a.name, &b.name))
        })
    });
    Some(AtlasBuildSummary { sessions: sent.len() as i64, latest, local: local.cloned(), by_people, senders })
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
                if let Some(reason) = build_reason(b, latest) {
                    out.push(sf(reason, f.uploaded_at.clone(), Some(build_label(b.commit.as_deref(), &b.code))));
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

/// 理由の言葉(「人」「フォルダ」が続く形)
fn reason_phrase(r: &str) -> &'static str {
    match r {
        "older" => "古い atlas で送った",
        "dirty" => "書き換えた atlas で送った",
        "unknown" => "版の記録が無い",
        "undated" => "版の新旧が分からない",
        _ => "送った記録を読めない",
    }
}

/// 理由ごとの、頼むこと
fn reason_action(r: &str) -> &'static str {
    match r {
        "older" => "atlas.bat を開いてもらう(開くと最新になります)。そのあと、送り直してもらう",
        "dirty" => "atlas のフォルダで書き換えたファイルを元に戻してもらう(書き換えたファイルは git status で分かります)。そのあと、atlas.bat を開いて送り直してもらう",
        "unknown" => "版を記録する前の古い atlas で送ったか、atlas を使わずに置いたものです。atlas.bat を開いて、送り直してもらう",
        "undated" => "git で取得していない atlas で送ったものです。git で取得した atlas から、送り直してもらう",
        _ => "送っている最中だったのかもしれません。集計し直すと読めることがあります",
    }
}

/// 対応を頼む人の内訳に出す人数の上限
const SENDERS_MAX: usize = 20;
/// いちばん新しい版で送った人の名前を出す数の上限
const OK_NAMES_MAX: usize = 5;

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

/// 対応を頼む人の 1 行(名前: 理由と数。使った版。最後に送った日)
fn sender_line(x: &SenderBuilds) -> String {
    let problems: Vec<String> = x.problems.iter().map(|p| format!("{}({})", reason_phrase(&p.reason), if p.sessions > 0 { format!("{} セッション", p.sessions) } else { format!("{} フォルダ", p.folders) })).collect();
    let labels = if x.labels.is_empty() { String::new() } else { format!("。使った atlas は {}{}", x.labels.iter().take(3).cloned().collect::<Vec<_>>().join("、"), if x.labels.len() > 3 { " ほか" } else { "" }) };
    let dates = match (x.uploaded_at.first(), x.uploaded_at.last()) {
        (Some(a), Some(b)) if day(Some(a)) != day(Some(b)) => format!("。最後に送ったのは {}〜{}", day(Some(a)), day(Some(b))),
        (Some(a), _) => format!("。最後に送ったのは {}", day(Some(a))),
        _ => String::new(),
    };
    format!("  {}: {}{labels}{dates}", x.name, problems.join("、"))
}

pub struct AtlasBuildsDescription {
    pub ok: bool,
    pub short: String,
    pub headline: String,
    pub lines: Vec<String>,
}

/// 集計した版を、CLI のログと画面の見出しに出す言葉にする。送った人ごとに、対応が要るかと、頼むことを出す
pub fn describe_atlas_builds(s: &AtlasBuildSummary) -> AtlasBuildsDescription {
    // 数える単位(人ごとにまとめたときは人、そうでなければフォルダ)
    let unit = if s.by_people { "人" } else { "フォルダ" };
    let count = |n: usize| if s.by_people { format!("{n} 人") } else { format!("{n} 件") };
    let flagged: Vec<&SenderBuilds> = s.senders.iter().filter(|x| !x.problems.is_empty()).collect();
    let fine: Vec<&SenderBuilds> = s.senders.iter().filter(|x| x.problems.is_empty()).collect();
    let ok = flagged.is_empty();
    let reasons: Vec<&str> = REASONS.into_iter().filter(|r| flagged.iter().any(|x| x.problems.iter().any(|p| p.reason == *r))).collect();
    // 見出しは、人ごとにまとめたときは人の数。そうでなければ送った人は 1 人なので、セッションの数(セッションが無い理由はフォルダの数)
    let parts: Vec<String> = reasons
        .iter()
        .map(|r| {
            let hit: Vec<&SenderProblem> = flagged.iter().flat_map(|x| x.problems.iter().filter(|p| p.reason == *r)).collect();
            let sessions: i64 = hit.iter().map(|p| p.sessions).sum();
            match (s.by_people, sessions > 0) {
                (true, _) => format!("{}人 {} 人", reason_phrase(r), hit.len()),
                (false, true) => format!("{}セッション {sessions} 件", reason_phrase(r)),
                (false, false) => format!("{}フォルダ {} 件", reason_phrase(r), hit.iter().map(|p| p.folders).sum::<i64>()),
            }
        })
        .collect();
    // 画面のタグは、人ごとにまとめたときは対応が要る人の数だけ(理由ごとの内訳は見出しの 1 行に出す)
    let short = match (ok, s.by_people) {
        (true, _) => "すべて最新".to_string(),
        (false, true) => format!("対応が要る人 {} 人", flagged.len()),
        (false, false) => parts.join("・"),
    };
    let headline = match (ok, s.by_people) {
        (true, _) => format!("送った atlas: すべて最新{}", s.latest.as_ref().map(|l| format!("({})", js::utf16_slice(&l.commit, 0, 7))).unwrap_or_default()),
        (false, true) => format!("送った atlas: {} 人のうち {short}({})", s.senders.len(), parts.join("・")),
        (false, false) => format!("送った atlas: {} セッションのうち {short}", s.sessions),
    };
    let mut lines = Vec::new();
    if let Some(l) = &s.latest {
        lines.push(format!("最新の atlas: {}({} のコミット{})", js::utf16_slice(&l.commit, 0, 7), day(Some(&l.committed_at)), if l.local { "。この PC の atlas" } else { "" }));
    }
    if !ok {
        lines.push(format!("対応が要る{unit}({}):", count(flagged.len())));
        lines.extend(flagged.iter().take(SENDERS_MAX).map(|x| sender_line(x)));
        if flagged.len() > SENDERS_MAX {
            lines.push(format!("  ほか {}", count(flagged.len() - SENDERS_MAX)));
        }
        lines.push("頼むこと:".into());
        lines.extend(reasons.iter().map(|r| format!("  {} → {}", reason_phrase(r), reason_action(r))));
    }
    if !fine.is_empty() {
        let more = if fine.len() > OK_NAMES_MAX { format!(" ほか {}", count(fine.len() - OK_NAMES_MAX)) } else { String::new() };
        lines.push(format!("最新の atlas で送った{unit}({}): {}{more}", count(fine.len()), fine.iter().take(OK_NAMES_MAX).map(|x| x.name.clone()).collect::<Vec<_>>().join("、")));
    }
    if let Some(local) = &s.local {
        let same = s.latest.as_ref().is_some_and(|l| l.local && Some(l.commit.as_str()) == local.commit.as_deref());
        if !same {
            lines.push(format!("この PC の atlas: {}({}){}", build_label(local.commit.as_deref(), &local.code), day(local.committed_at.as_deref()), if local.dirty == Some(true) { "。ファイルを書き換えています" } else { "" }));
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
            SentSession { person: Some("p1"), folder: Some("p1/a"), upload_atlas: Some(Some(&bn)) },
            SentSession { person: Some("p2"), folder: Some("p2/a"), upload_atlas: Some(Some(&bo)) },
            SentSession { person: Some("p2"), folder: Some("p2/a"), upload_atlas: Some(Some(&bo)) },
            SentSession { person: Some("p3"), folder: Some("p3/a"), upload_atlas: Some(None) },
            SentSession { person: None, folder: None, upload_atlas: None },
        ];
        let s = summarize_atlas_builds(&ss, None, None).unwrap();
        assert_eq!(s.sessions, 4);
        assert!(s.by_people);
        assert_eq!(s.latest.as_ref().unwrap().commit, new);
        // 対応を頼む人が先、その後にいちばん新しい版で送った人
        assert_eq!(s.senders.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["p2", "p3", "p1"]);
        assert_eq!(s.senders[0].problems, [SenderProblem { reason: "older".into(), sessions: 2, folders: 0 }]);
        let d = describe_atlas_builds(&s);
        assert!(!d.ok);
        assert_eq!(d.short, "対応が要る人 2 人");
        assert_eq!(d.headline, "送った atlas: 3 人のうち 対応が要る人 2 人(古い atlas で送った人 1 人・版の記録が無い人 1 人)");
        assert_eq!(
            d.lines,
            [
                "最新の atlas: bbbbbbb(2026-07-02 のコミット)",
                "対応が要る人(2 人):",
                "  p2: 古い atlas で送った(2 セッション)。使った atlas は aaaaaaa",
                "  p3: 版の記録が無い(1 セッション)",
                "頼むこと:",
                "  古い atlas で送った → atlas.bat を開いてもらう(開くと最新になります)。そのあと、送り直してもらう",
                "  版の記録が無い → 版を記録する前の古い atlas で送ったか、atlas を使わずに置いたものです。atlas.bat を開いて、送り直してもらう",
                "最新の atlas で送った人(1 人): p1",
            ]
        );
        assert!(summarize_atlas_builds(&ss[4..], None, None).is_none());
    }

    fn up(at: &str, atlas: Option<&AtlasBuild>) -> FolderUpload {
        FolderUpload { uploaded_at: Some(at.into()), atlas: atlas.cloned(), unreadable: None }
    }

    /// 人ごと: 1 人に理由が重なれば 1 行にまとめ、フォルダの記録から最後に送った日を出す。セッションを数えなかったフォルダの人(kato)も数える
    #[test]
    fn by_person_with_folders() {
        let new = "b".repeat(40);
        let old = "a".repeat(40);
        let bn = b(Some(&new), Some("2026-07-02T00:00:00.000Z"), "11111111");
        let bo = b(Some(&old), Some("2026-07-01T00:00:00.000Z"), "22222222");
        let dirty = AtlasBuild { dirty: Some(true), ..bn.clone() };
        let nogit = b(None, None, "33333333");
        let mut folders: JsMap<FolderUpload> = JsMap::new();
        folders.insert("tanaka/x".into(), up("2026-07-03T01:00:00.000Z", Some(&bo)));
        folders.insert("tanaka/y".into(), up("2026-07-05T01:00:00.000Z", Some(&dirty)));
        folders.insert("sato/x".into(), up("2026-07-06T01:00:00.000Z", Some(&bn)));
        folders.insert("suzuki/x".into(), up("2026-07-01T01:00:00.000Z", Some(&nogit)));
        folders.insert("ito/x".into(), FolderUpload { uploaded_at: None, atlas: None, unreadable: Some(true) });
        folders.insert("kato/x".into(), up("2026-07-04T01:00:00.000Z", Some(&dirty)));
        let ss = [
            SentSession { person: Some("tanaka"), folder: Some("tanaka/x"), upload_atlas: Some(Some(&bo)) },
            SentSession { person: Some("tanaka"), folder: Some("tanaka/y"), upload_atlas: Some(Some(&dirty)) },
            SentSession { person: Some("sato"), folder: Some("sato/x"), upload_atlas: Some(Some(&bn)) },
            SentSession { person: Some("suzuki"), folder: Some("suzuki/x"), upload_atlas: Some(Some(&nogit)) },
        ];
        let local = AtlasBuild { dirty: Some(true), ..bo.clone() };
        let s = summarize_atlas_builds(&ss, Some(&local), Some(&folders)).unwrap();
        let d = describe_atlas_builds(&s);
        assert_eq!(d.headline, "送った atlas: 5 人のうち 対応が要る人 4 人(古い atlas で送った人 1 人・書き換えた atlas で送った人 2 人・版の新旧が分からない人 1 人・送った記録を読めない人 1 人)");
        assert_eq!(
            d.lines,
            [
                "最新の atlas: bbbbbbb(2026-07-02 のコミット)",
                "対応が要る人(4 人):",
                "  ito: 送った記録を読めない(1 フォルダ)",
                "  suzuki: 版の新旧が分からない(1 セッション)。使った atlas は 目印 33333333。最後に送ったのは 2026-07-01",
                "  tanaka: 古い atlas で送った(1 セッション)、書き換えた atlas で送った(1 セッション)。使った atlas は aaaaaaa、bbbbbbb。最後に送ったのは 2026-07-03〜2026-07-05",
                "  kato: 書き換えた atlas で送った(1 フォルダ)。使った atlas は bbbbbbb。最後に送ったのは 2026-07-04",
                "頼むこと:",
                "  古い atlas で送った → atlas.bat を開いてもらう(開くと最新になります)。そのあと、送り直してもらう",
                "  書き換えた atlas で送った → atlas のフォルダで書き換えたファイルを元に戻してもらう(書き換えたファイルは git status で分かります)。そのあと、atlas.bat を開いて送り直してもらう",
                "  版の新旧が分からない → git で取得していない atlas で送ったものです。git で取得した atlas から、送り直してもらう",
                "  送った記録を読めない → 送っている最中だったのかもしれません。集計し直すと読めることがあります",
                "最新の atlas で送った人(1 人): sato",
                "この PC の atlas: aaaaaaa(2026-07-01)。ファイルを書き換えています",
            ]
        );
    }

    /// 人のフォルダの下に無いもの(プロジェクトのフォルダを開いたとき)は、見出しをセッションの数で、内訳をフォルダごとに出す。すべて最新なら、その 1 行
    #[test]
    fn by_folder_and_all_latest() {
        let new = "b".repeat(40);
        let old = "a".repeat(40);
        let bn = b(Some(&new), Some("2026-07-02T00:00:00.000Z"), "11111111");
        let bo = b(Some(&old), Some("2026-07-01T00:00:00.000Z"), "22222222");
        let mut folders: JsMap<FolderUpload> = JsMap::new();
        folders.insert(".".into(), up("2026-07-03T01:00:00.000Z", Some(&bo)));
        let ss = [SentSession { person: None, folder: Some("."), upload_atlas: Some(Some(&bo)) }];
        let s = summarize_atlas_builds(&ss, Some(&bn), Some(&folders)).unwrap();
        assert!(!s.by_people);
        let d = describe_atlas_builds(&s);
        assert_eq!(d.short, "古い atlas で送ったセッション 1 件");
        assert_eq!(d.headline, "送った atlas: 1 セッションのうち 古い atlas で送ったセッション 1 件");
        assert_eq!(d.lines[0], "最新の atlas: bbbbbbb(2026-07-02 のコミット。この PC の atlas)");
        assert_eq!(d.lines[1], "対応が要るフォルダ(1 件):");
        assert_eq!(d.lines[2], "  (このフォルダ): 古い atlas で送った(1 セッション)。使った atlas は aaaaaaa。最後に送ったのは 2026-07-03");

        let s = summarize_atlas_builds(&ss, Some(&bo), Some(&folders)).unwrap();
        let d = describe_atlas_builds(&s);
        assert!(d.ok);
        assert_eq!(d.short, "すべて最新");
        assert_eq!(d.headline, "送った atlas: すべて最新(aaaaaaa)");
        assert_eq!(d.lines, ["最新の atlas: aaaaaaa(2026-07-01 のコミット)", "最新の atlas で送ったフォルダ(1 件): (このフォルダ)", "この PC の atlas: aaaaaaa(2026-07-01)"]);
    }
}
