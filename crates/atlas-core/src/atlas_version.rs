//! atlas 自身の版の形と集計(同じ計算を packages/report/src/shared/atlas-version.ts にも持つ)。アップロードしたフォルダに添え、
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestBuild {
    pub commit: String,
    pub committed_at: String,
    pub local: bool,
}

/// 送った人に対応を頼む理由
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    /// いちばん新しい版より古い版で送った
    Older,
    /// git が管理しているファイルを手で変えた版で送った
    Dirty,
    /// 版の記録が無い(この記録を書く前の版で送った)
    Unknown,
    /// git で取得していないなどで、新旧を決められない版で送った
    Undated,
    /// フォルダの索引はあるが読めなかった
    Unreadable,
}

/// 理由を出す順
const REASONS: [Reason; 5] = [Reason::Older, Reason::Dirty, Reason::Unknown, Reason::Undated, Reason::Unreadable];

/// 送った人に対応を頼む理由 1 つと、その数
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderProblem {
    pub reason: Reason,
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
    /// 理由に当てはまるフォルダ(送り先からの相対パス)。送り直してもらうのはこのフォルダ
    pub folders: Vec<String>,
    /// それらのフォルダを最後に送った日時(古い順。分からないものは入らない)
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
    /// 送った人ごと。対応を頼む人が先(当てはまるフォルダを送った日時の古い順。日時の分からないものは前)、その後にいちばん新しい版で送った人(名前の順)
    pub senders: Vec<SenderBuilds>,
}

/// 集計に使うセッションの項目(uploadAtlas が None = この PC の記録は数えない)
pub struct SentSession<'a> {
    pub person: Option<&'a str>,
    /// そのセッションを数えたフォルダ(送り先からの相対パス)。人の名前が無いときにまとめる名前と、送った日時を引くのに使う
    pub folder: Option<&'a str>,
    pub upload_atlas: Option<Option<&'a AtlasBuild>>,
}

fn time(at: Option<&str>) -> Option<i64> {
    at.filter(|s| !s.is_empty()).and_then(jsdate::parse_ms)
}

fn cmp_f(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// 送った版から決まる理由(いちばん新しい版で、手で変えてもいなければ空)。版の記録が無ければ Unknown
fn reasons_of(build: Option<&AtlasBuild>, latest: Option<&LatestBuild>) -> Vec<Reason> {
    let Some(b) = build else { return vec![Reason::Unknown] };
    let t = time(b.committed_at.as_deref());
    let age = if b.commit.as_deref().is_none_or(str::is_empty) || t.is_none() {
        Some(Reason::Undated)
    } else {
        latest.filter(|l| b.commit.as_deref() != Some(l.commit.as_str()) && t.zip(time(Some(&l.committed_at))).is_some_and(|(a, c)| a < c)).map(|_| Reason::Older)
    };
    age.into_iter().chain((b.dirty == Some(true)).then_some(Reason::Dirty)).collect()
}

/// 送った人ごとに数える途中の形
#[derive(Default)]
struct SenderAcc {
    sessions: i64,
    /// 理由 → (セッション, フォルダ)
    counts: indexmap::IndexMap<Reason, (i64, i64)>,
    labels: indexmap::IndexSet<String>,
    /// 理由に当てはまるフォルダ
    folders: indexmap::IndexSet<String>,
}

impl SenderAcc {
    /// 理由に当てはまったセッション(folder_hit = false)かフォルダ(true)を 1 つ数える
    fn hit(&mut self, reasons: &[Reason], folder_hit: bool, build: Option<&AtlasBuild>, folder: Option<&str>) {
        for r in reasons {
            let c = self.counts.entry(*r).or_default();
            if folder_hit {
                c.1 += 1;
            } else {
                c.0 += 1;
            }
        }
        if let Some(b) = build {
            self.labels.insert(build_label(b.commit.as_deref(), &b.code));
        }
        if let Some(f) = folder {
            self.folders.insert(f.to_string());
        }
    }
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
        let reasons = reasons_of(build, latest.as_ref());
        if !reasons.is_empty() {
            a.hit(&reasons, false, build, s.folder);
        }
    }
    // フォルダの記録(最後に送ったときの版)。セッションを数えなかったフォルダの人も、送った人に数える。
    // 索引を読めなかったフォルダは、黙って外さずに理由にする
    for (folder, u) in folders.map(|f| f.js_entries()).unwrap_or_default() {
        let a = acc.entry(folder_owner(folder)).or_default();
        let (reasons, build) = if u.unreadable == Some(true) { (vec![Reason::Unreadable], None) } else { (reasons_of(u.atlas.as_ref(), latest.as_ref()), u.atlas.as_ref()) };
        if !reasons.is_empty() {
            a.hit(&reasons, true, build, Some(folder));
        }
    }
    // 対応を頼む人を先に(当てはまるフォルダを送った日時の古い順。日時の分からないフォルダがあれば前)。その後に、いちばん新しい版で送った人
    let mut keyed: Vec<(f64, SenderBuilds)> = acc
        .into_iter()
        .map(|(name, a)| {
            let at: Vec<Option<String>> = a.folders.iter().map(|k| folders.and_then(|f| f.get(k)).filter(|u| u.unreadable != Some(true)).and_then(|u| u.uploaded_at.clone()).filter(|at| time(Some(at)).is_some())).collect();
            let first = if at.is_empty() || at.iter().any(Option::is_none) { f64::NEG_INFINITY } else { at.iter().flatten().filter_map(|x| time(Some(x))).min().map_or(f64::NEG_INFINITY, |v| v as f64) };
            let mut uploaded_at: Vec<String> = at.into_iter().flatten().collect();
            uploaded_at.sort_by(|a, b| js::cmp_utf16(a, b));
            let problems = REASONS.iter().filter_map(|r| a.counts.get(r).map(|(sessions, folders)| SenderProblem { reason: *r, sessions: *sessions, folders: *folders })).collect();
            (first, SenderBuilds { name, sessions: a.sessions, problems, labels: a.labels.into_iter().collect(), folders: a.folders.into_iter().collect(), uploaded_at })
        })
        .collect();
    keyed.sort_by(|(fa, a), (fb, b)| {
        a.problems.is_empty().cmp(&b.problems.is_empty()).then_with(|| {
            let d = if a.problems.is_empty() || fa == fb { 0.0 } else { fa - fb };
            cmp_f(d, 0.0).then_with(|| locale_compare(&a.name, &b.name))
        })
    });
    Some(AtlasBuildSummary { sessions: sent.len() as i64, latest, local: local.cloned(), by_people, senders: keyed.into_iter().map(|(_, x)| x).collect() })
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

/// 理由の言葉(「人」「フォルダ」「セッション」が続く形)
fn reason_phrase(r: Reason) -> &'static str {
    match r {
        Reason::Older => "古い atlas で送った",
        Reason::Dirty => "書き換えた atlas で送った",
        Reason::Unknown => "版の記録が無い",
        Reason::Undated => "版の新旧が分からない",
        Reason::Unreadable => "送った記録を読めない",
    }
}

/// 理由ごとの、頼むこと
fn reason_action(r: Reason) -> &'static str {
    match r {
        Reason::Older => "atlas.bat を開いてもらう(開くと最新になります)。そのあと、そのフォルダを送り直してもらう",
        Reason::Dirty => "atlas のフォルダで書き換えたファイルを元に戻してもらう(書き換えたファイルは git status で分かります)。そのあと、atlas.bat を開いて、そのフォルダを送り直してもらう",
        Reason::Unknown => "版を記録する前の古い atlas で送ったか、atlas を使わずに置いたものです。atlas.bat を開いて、そのフォルダを送り直してもらう",
        Reason::Undated => "git で取得していない atlas で送ったものです。git で取得した atlas から、そのフォルダを送り直してもらう",
        Reason::Unreadable => "送っている最中だったのかもしれません。集計し直すと読めることがあります",
    }
}

/// 対応を頼む人の内訳に出す人数の上限
const SENDERS_MAX: usize = 20;
/// いちばん新しい版で送った人の名前を出す数の上限
const OK_NAMES_MAX: usize = 5;
/// 対応を頼む人の 1 行に出す、フォルダと版の数の上限
const LINE_ITEMS_MAX: usize = 3;

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

/// 上限までを「、」でつなぐ(超えた分は「 ほか」)
fn some_of(xs: &[String]) -> String {
    format!("{}{}", xs.iter().take(LINE_ITEMS_MAX).cloned().collect::<Vec<_>>().join("、"), if xs.len() > LINE_ITEMS_MAX { " ほか" } else { "" })
}

/// 対応を頼む人の 1 行(名前: 理由と数。当てはまるフォルダ。使った版。そのフォルダを送った日)
fn sender_line(x: &SenderBuilds) -> String {
    let problems: Vec<String> = x.problems.iter().map(|p| format!("{}({})", reason_phrase(p.reason), if p.sessions > 0 { format!("{} セッション", p.sessions) } else { format!("{} フォルダ", p.folders) })).collect();
    // フォルダは、人のフォルダの下の名前で出す(名前と同じフォルダ・送り先そのものは、行の頭の名前で分かるので出さない)
    let own = format!("{}/", x.name);
    let names: Vec<String> = x.folders.iter().filter(|f| *f != "." && **f != x.name).map(|f| f.strip_prefix(&own).unwrap_or(f).to_string()).collect();
    let folders = if names.is_empty() { String::new() } else { format!("。フォルダは {}", some_of(&names)) };
    let labels = if x.labels.is_empty() { String::new() } else { format!("。使った atlas は {}", some_of(&x.labels)) };
    let dates = match (x.uploaded_at.first(), x.uploaded_at.last()) {
        (Some(a), Some(b)) if day(Some(a)) != day(Some(b)) => format!("。送ったのは {}〜{}", day(Some(a)), day(Some(b))),
        (Some(a), _) => format!("。送ったのは {}", day(Some(a))),
        _ => String::new(),
    };
    format!("  {}: {}{folders}{labels}{dates}", x.name, problems.join("、"))
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
    let reasons: Vec<Reason> = REASONS.into_iter().filter(|r| flagged.iter().any(|x| x.problems.iter().any(|p| p.reason == *r))).collect();
    // 理由ごとの数は、人ごとにまとめたときは人の数。そうでなければ送った人は 1 人なので、セッションの数と、セッションの無いフォルダの数
    let parts: Vec<String> = reasons
        .iter()
        .map(|r| {
            let hit: Vec<&SenderProblem> = flagged.iter().flat_map(|x| x.problems.iter().filter(|p| p.reason == *r)).collect();
            let sessions: i64 = hit.iter().map(|p| p.sessions).sum();
            let folders: i64 = hit.iter().filter(|p| p.sessions == 0).map(|p| p.folders).sum();
            match (s.by_people, sessions > 0, folders > 0) {
                (true, _, _) => format!("{}人 {} 人", reason_phrase(*r), hit.len()),
                (false, true, true) => format!("{}セッション {sessions} 件とフォルダ {folders} 件", reason_phrase(*r)),
                (false, true, false) => format!("{}セッション {sessions} 件", reason_phrase(*r)),
                (false, false, _) => format!("{}フォルダ {folders} 件", reason_phrase(*r)),
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
        lines.extend(reasons.iter().map(|r| format!("  {} → {}", reason_phrase(*r), reason_action(*r))));
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
        assert_eq!(s.senders[0].problems, [SenderProblem { reason: Reason::Older, sessions: 2, folders: 0 }]);
        let d = describe_atlas_builds(&s);
        assert!(!d.ok);
        assert_eq!(d.short, "対応が要る人 2 人");
        assert_eq!(d.headline, "送った atlas: 3 人のうち 対応が要る人 2 人(古い atlas で送った人 1 人・版の記録が無い人 1 人)");
        assert_eq!(
            d.lines,
            [
                "最新の atlas: bbbbbbb(2026-07-02 のコミット)",
                "対応が要る人(2 人):",
                "  p2: 古い atlas で送った(2 セッション)。フォルダは a。使った atlas は aaaaaaa",
                "  p3: 版の記録が無い(1 セッション)。フォルダは a",
                "頼むこと:",
                "  古い atlas で送った → atlas.bat を開いてもらう(開くと最新になります)。そのあと、そのフォルダを送り直してもらう",
                "  版の記録が無い → 版を記録する前の古い atlas で送ったか、atlas を使わずに置いたものです。atlas.bat を開いて、そのフォルダを送り直してもらう",
                "最新の atlas で送った人(1 人): p1",
            ]
        );
        assert!(summarize_atlas_builds(&ss[4..], None, None).is_none());
    }

    fn up(at: &str, atlas: Option<&AtlasBuild>) -> FolderUpload {
        FolderUpload { uploaded_at: Some(at.into()), atlas: atlas.cloned(), unreadable: None }
    }

    /// 人ごと: 1 人に理由が重なれば 1 行にまとめ、当てはまるフォルダと、それを送った日を出す(最新で送ったフォルダ tanaka/z の日付は入れない)。
    /// セッションを数えなかったフォルダの人(kato)も数える。日時の分からないフォルダがある人(ito)は、日付のあるフォルダがあっても前に並べる
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
        folders.insert("tanaka/z".into(), up("2026-07-09T01:00:00.000Z", Some(&bn)));
        folders.insert("ito/x".into(), FolderUpload { uploaded_at: None, atlas: None, unreadable: Some(true) });
        folders.insert("ito/y".into(), up("2026-07-08T01:00:00.000Z", Some(&bo)));
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
        assert_eq!(d.headline, "送った atlas: 5 人のうち 対応が要る人 4 人(古い atlas で送った人 2 人・書き換えた atlas で送った人 2 人・版の新旧が分からない人 1 人・送った記録を読めない人 1 人)");
        assert_eq!(
            d.lines,
            [
                "最新の atlas: bbbbbbb(2026-07-02 のコミット)",
                "対応が要る人(4 人):",
                "  ito: 古い atlas で送った(1 フォルダ)、送った記録を読めない(1 フォルダ)。フォルダは x、y。使った atlas は aaaaaaa。送ったのは 2026-07-08",
                "  suzuki: 版の新旧が分からない(1 セッション)。フォルダは x。使った atlas は 目印 33333333。送ったのは 2026-07-01",
                "  tanaka: 古い atlas で送った(1 セッション)、書き換えた atlas で送った(1 セッション)。フォルダは x、y。使った atlas は aaaaaaa、bbbbbbb。送ったのは 2026-07-03〜2026-07-05",
                "  kato: 書き換えた atlas で送った(1 フォルダ)。フォルダは x。使った atlas は bbbbbbb。送ったのは 2026-07-04",
                "頼むこと:",
                "  古い atlas で送った → atlas.bat を開いてもらう(開くと最新になります)。そのあと、そのフォルダを送り直してもらう",
                "  書き換えた atlas で送った → atlas のフォルダで書き換えたファイルを元に戻してもらう(書き換えたファイルは git status で分かります)。そのあと、atlas.bat を開いて、そのフォルダを送り直してもらう",
                "  版の新旧が分からない → git で取得していない atlas で送ったものです。git で取得した atlas から、そのフォルダを送り直してもらう",
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
        assert_eq!(d.lines[2], "  (このフォルダ): 古い atlas で送った(1 セッション)。使った atlas は aaaaaaa。送ったのは 2026-07-03");

        // 人のフォルダを開いたとき(プロジェクトのフォルダが並ぶ): セッションの無いフォルダも、見出しに数える
        let mut folders2: JsMap<FolderUpload> = JsMap::new();
        folders2.insert("x".into(), up("2026-07-03T01:00:00.000Z", Some(&bo)));
        folders2.insert("y".into(), up("2026-07-04T01:00:00.000Z", Some(&bo)));
        let ss2 = [SentSession { person: None, folder: Some("x"), upload_atlas: Some(Some(&bo)) }];
        let d = describe_atlas_builds(&summarize_atlas_builds(&ss2, Some(&bn), Some(&folders2)).unwrap());
        assert_eq!(d.headline, "送った atlas: 1 セッションのうち 古い atlas で送ったセッション 1 件とフォルダ 1 件");
        assert_eq!(d.lines[1], "対応が要るフォルダ(2 件):");

        let s = summarize_atlas_builds(&ss, Some(&bo), Some(&folders)).unwrap();
        let d = describe_atlas_builds(&s);
        assert!(d.ok);
        assert_eq!(d.short, "すべて最新");
        assert_eq!(d.headline, "送った atlas: すべて最新(aaaaaaa)");
        assert_eq!(d.lines, ["最新の atlas: aaaaaaa(2026-07-01 のコミット)", "最新の atlas で送ったフォルダ(1 件): (このフォルダ)", "この PC の atlas: aaaaaaa(2026-07-01)"]);
    }
}
