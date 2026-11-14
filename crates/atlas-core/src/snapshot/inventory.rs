//! インストール済みの skill / プラグインの記録と、アップロード先の索引を読む
//! (snapshot.ts の readInventory・readSentInventory・readUploadIndexes の移植)。

use super::par::par_map;
use super::source::person_of_folder;
use super::{SNAPSHOT_CONCURRENCY, UPLOAD_INDEX, UPLOAD_INSTALLED, sort_utf16};
use crate::atlas_version::{FolderUpload, parse_atlas_build};
use crate::js::{self, JsMap, RE_DOT, RE_S};
use crate::types::{InstalledInventory, InstalledPlugin};
use crate::{collate, jsdate, jsfs};
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;

/// ディレクトリ(とそれを指すシンボリックリンク・ジャンクション)の名前。無ければ空
fn dir_names(dir: &Path) -> std::io::Result<Vec<String>> {
    if !jsfs::exists(dir) {
        return Ok(Vec::new());
    }
    let mut out: Vec<String> = jsfs::read_dir(dir)?.into_iter().filter(|e| e.is_dir() || e.is_link()).map(|e| e.name).collect();
    sort_utf16(&mut out);
    Ok(out)
}

/// インストール済みの skill / プラグインを名前だけ記録する(SKILL.md などの中身は読まない)。
/// - ~/.copilot/skills/<name>/
/// - ~/.copilot/installed-plugins/<marketplace>/<plugin>/(と、その skills/<name>/)
/// - ~/.copilot/settings.json の disabledSkills(他のキーは記録しない)
///
/// 読めないものは warnings に理由を残し、黙って空にしない。
pub fn read_inventory(src: &Path) -> InstalledInventory {
    let mut inv = InstalledInventory { disabled_skills: Some(Vec::new()), ..Default::default() };
    match dir_names(&src.join("skills")) {
        Ok(s) => inv.skills = s,
        Err(e) => inv.warnings.push(format!("skills/ を読めない ({e})")),
    }
    let root = src.join("installed-plugins");
    let plugins = (|| -> std::io::Result<()> {
        for market in dir_names(&root)? {
            for name in dir_names(&root.join(&market))? {
                let skills = dir_names(&root.join(&market).join(&name).join("skills"))?;
                inv.plugins.push(InstalledPlugin { marketplace: market.clone(), name, skills });
            }
        }
        Ok(())
    })();
    if let Err(e) = plugins {
        inv.warnings.push(format!("installed-plugins/ を読めない ({e})"));
    }
    let settings = src.join("settings.json");
    if jsfs::exists(&settings) {
        match fs::read_to_string(&settings).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
            Ok(v) => match v.get("disabledSkills") {
                None | Some(Value::Null) => inv.disabled_skills = Some(Vec::new()),
                Some(Value::Array(a)) => {
                    let mut d: Vec<String> = a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
                    sort_utf16(&mut d);
                    inv.disabled_skills = Some(d);
                }
                Some(_) => {
                    inv.disabled_skills = None;
                    inv.warnings.push("settings.json の disabledSkills が配列でない".into());
                }
            },
            Err(e) => {
                inv.disabled_skills = None;
                inv.warnings.push(format!("settings.json を読めない ({e})"));
            }
        }
    }
    inv
}

/// 索引(UPLOAD_INDEX)のうち読む先頭の大きさ。索引にはそのフォルダの全セッションの一覧が入って大きくなるが、要るのは先頭に書く
/// uploadedAt と atlas だけ(group-upload.ts が sessions より前に書く)。共有フォルダから全体を読まないように、先頭だけを読む
const UPLOAD_INDEX_HEAD: usize = 64 * 1024;

static HEAD_VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#"^{RE_S}*\{{{RE_S}*"version"{RE_S}*:{RE_S}*1{RE_S}*,"#)).unwrap());
static HEAD_AT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#""uploadedAt"{RE_S}*:{RE_S}*("(?:[^"\\]|\\{RE_DOT}){{0,64}}"|null)"#)).unwrap());
static HEAD_ATLAS: LazyLock<Regex> =
    LazyLock::new(|| regex::RegexBuilder::new(&format!(r#""atlas"{RE_S}*:{RE_S}*(\{{[^{{}}]{{0,2000}}\}}|null)"#)).size_limit(64 << 20).build().unwrap());

/// 索引の先頭(全体が UPLOAD_INDEX_HEAD に収まらないとき)から、uploadedAt と atlas を取り出す。形が合わなければ None
fn upload_index_head(text: &str) -> Option<serde_json::Map<String, Value>> {
    // version は先頭の項目(group-upload.ts の書き方)。atlas は入れ子の無いオブジェクトか null
    if !HEAD_VERSION.is_match(text) {
        return None;
    }
    let at = HEAD_AT.captures(text).map(|c| c[1].to_string());
    let atlas = HEAD_ATLAS.captures(text).map(|c| c[1].to_string());
    let mut o = serde_json::Map::new();
    o.insert("version".into(), Value::from(1));
    if let Some(at) = at {
        o.insert("uploadedAt".into(), serde_json::from_str(&at).ok()?);
    }
    if let Some(atlas) = atlas {
        o.insert("atlas".into(), serde_json::from_str(&atlas).ok()?);
    }
    Some(o)
}

/// JSON の値が数の 1 か(JS の `=== 1`)
fn is_one(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64) == Some(1.0)
}

/// アップロードしたフォルダ(src からの相対パス。'.' は src そのもの)の索引から、最後に送ったときの日時と atlas の版を読む。
/// 索引の無いフォルダは入れない(前の版や手で写したもの)。索引はあるが読めない・書きかけ・形が違うものは、unreadable として入れる
/// (黙って外すと、ほかが最新なら「すべて最新」と出てしまう)。版の記録が無い atlas で送った索引は、atlas が null
pub fn read_upload_indexes(src: &Path, folders: &[String]) -> JsMap<FolderUpload> {
    let unreadable = FolderUpload { uploaded_at: None, atlas: None, unreadable: Some(true) };
    let read = par_map(folders, SNAPSHOT_CONCURRENCY, |f| -> Option<FolderUpload> {
        let path = jsfs::join_slash(src, f).join(UPLOAD_INDEX);
        let mut buf = Vec::new();
        let r = fs::File::open(&path).and_then(|fh| fh.take(UPLOAD_INDEX_HEAD as u64 + 1).read_to_end(&mut buf));
        if let Err(e) = r {
            return if jsfs::is_not_found(&e) { None } else { Some(unreadable.clone()) };
        }
        let whole = buf.len() <= UPLOAD_INDEX_HEAD;
        buf.truncate(UPLOAD_INDEX_HEAD);
        let text = String::from_utf8_lossy(&buf);
        let j = if whole {
            serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok().and_then(|v| match v {
                Value::Object(o) => Some(o),
                _ => None,
            })
        } else {
            upload_index_head(&text)
        };
        let Some(j) = j.filter(|j| is_one(j.get("version"))) else {
            return Some(unreadable.clone());
        };
        let t = j.get("uploadedAt").and_then(Value::as_str).filter(|s| s.encode_utf16().count() <= 40).and_then(jsdate::parse_ms);
        Some(FolderUpload { uploaded_at: t.map(jsdate::to_iso), atlas: parse_atlas_build(j.get("atlas")), unreadable: None })
    });
    let mut out = JsMap::new();
    for (f, r) in folders.iter().zip(read) {
        if let Some(r) = r {
            out.insert(f.clone(), r);
        }
    }
    out
}

/// 送った人のインストール済みの記録で使う名前の上限(共有フォルダに置かれたファイルなので、大きすぎるもの・おかしな名前は使わない)
const SENT_NAMES_MAX: usize = 5000;
const SENT_NAME_CHARS: usize = 200;

static BAD_NAME_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]").unwrap());

/// 名前の並び。文字列でないもの・長すぎるもの・制御文字や見えない書式の文字を含むものは除く。並びでなければ None
fn sent_names(v: Option<&Value>) -> Option<Vec<String>> {
    let a = v?.as_array()?;
    let mut out: IndexSet<String> = IndexSet::new();
    for x in a {
        if out.len() >= SENT_NAMES_MAX {
            break;
        }
        let Some(x) = x.as_str() else { continue };
        let n = js::trim(x);
        if !n.is_empty() && n.chars().count() <= SENT_NAME_CHARS && !BAD_NAME_CHARS.is_match(n) {
            out.insert(n.to_string());
        }
    }
    Some(out.into_iter().collect())
}

/// 送った人のインストール済みの記録(UPLOAD_INSTALLED)の大きさの上限。名前だけなので、これを超えるものは読まない
pub const UPLOAD_INSTALLED_LIMIT: u64 = 1024 * 1024;

/// 送った人のインストール済みの記録を合わせた結果
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SentInventory {
    /// 全員分を合わせたもの(誰かが入れているもの)。1 つも無ければ None(この版より前の atlas で送ったもの)
    pub installed: Option<InstalledInventory>,
    /// 人のフォルダの名前ごと(person_of_folder と同じ名前)。人のフォルダの下に無いものだけなら None
    pub by_person: Option<JsMap<InstalledInventory>>,
}

/// 1 つの記録を、名前を確かめてインストール済みの形にする
fn sent_inventory_of(j: &serde_json::Map<String, Value>, place: &str) -> InstalledInventory {
    let mut plugins: IndexMap<String, InstalledPlugin> = IndexMap::new();
    if let Some(Value::Array(ps)) = j.get("plugins") {
        for p in ps.iter().take(SENT_NAMES_MAX) {
            let Some(o) = p.as_object() else { continue };
            let market = sent_names(Some(&Value::Array(vec![o.get("marketplace").cloned().unwrap_or(Value::Null)]))).and_then(|v| v.into_iter().next());
            let name = sent_names(Some(&Value::Array(vec![o.get("name").cloned().unwrap_or(Value::Null)]))).and_then(|v| v.into_iter().next());
            if let (Some(market), Some(name)) = (market, name) {
                let skills = sent_names(o.get("skills")).unwrap_or_default();
                plugins.insert(format!("{market}/{name}"), InstalledPlugin { marketplace: market, name, skills });
            }
        }
    }
    InstalledInventory {
        skills: sent_names(j.get("skills")).unwrap_or_default(),
        plugins: plugins.into_values().collect(),
        disabled_skills: sent_names(j.get("disabledSkills")),
        warnings: sent_names(j.get("warnings")).unwrap_or_default().into_iter().take(20).map(|w| format!("{place}{w}")).collect(),
    }
}

/// 何人分かを合わせる(名前はどれかにあれば入れる。無効にした skill も、どれかで無効なら入れる)
fn merge_inventories(list: &[&InstalledInventory]) -> InstalledInventory {
    let mut skills: IndexSet<String> = IndexSet::new();
    let mut plugins: IndexMap<String, (String, String, IndexSet<String>)> = IndexMap::new();
    let mut disabled: IndexSet<String> = IndexSet::new();
    let mut any_disabled = false;
    let mut warnings = Vec::new();
    for inv in list {
        skills.extend(inv.skills.iter().cloned());
        for p in &inv.plugins {
            let x = plugins.entry(format!("{}/{}", p.marketplace, p.name)).or_insert_with(|| (p.marketplace.clone(), p.name.clone(), IndexSet::new()));
            x.2.extend(p.skills.iter().cloned());
        }
        if let Some(d) = &inv.disabled_skills {
            any_disabled = true;
            disabled.extend(d.iter().cloned());
        }
        warnings.extend(inv.warnings.iter().cloned());
    }
    let mut skills: Vec<String> = skills.into_iter().collect();
    sort_utf16(&mut skills);
    let mut plugins: Vec<InstalledPlugin> = plugins
        .into_values()
        .map(|(marketplace, name, s)| {
            let mut skills: Vec<String> = s.into_iter().collect();
            sort_utf16(&mut skills);
            InstalledPlugin { marketplace, name, skills }
        })
        .collect();
    plugins.sort_by(|a, b| collate::locale_compare(&format!("{}/{}", a.marketplace, a.name), &format!("{}/{}", b.marketplace, b.name)));
    let disabled_skills = any_disabled.then(|| {
        let mut d: Vec<String> = disabled.into_iter().collect();
        sort_utf16(&mut d);
        d
    });
    InstalledInventory { skills, plugins, disabled_skills, warnings }
}

/// アップロードしたフォルダ(src からの相対パス。/ 区切り。'.' は src そのもの)に添えられた、送った人のインストール済みの記録
/// (UPLOAD_INSTALLED)を読む。同じ人(人のフォルダの名前。人のフォルダの下に無いものは 1 人とみなす)の記録が何プロジェクト分かあれば、
/// 送った日時(sentAt)が新しいものだけを使う(印を外して送らなくなったプロジェクトに、前に入れていた skill が残り続けないように)。
/// 全員分は、人ごとの記録を合わせる(誰かが入れているもの)。人ごとの記録は、画面で人に絞ったときに使う。
/// 共有フォルダに置かれたファイルなので、大きすぎるもの(UPLOAD_INSTALLED_LIMIT 超)は読まない。
/// 無いフォルダ・読めないフォルダは warnings に数を残す
pub fn read_sent_inventory(src: &Path, folders: &[String]) -> SentInventory {
    let mut newest: IndexMap<String, (String, InstalledInventory)> = IndexMap::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut missing = 0;
    for f in folders {
        let path = jsfs::join_slash(src, f).join(UPLOAD_INSTALLED);
        let place = if f == "." { String::new() } else { format!("{f}: ") };
        if !jsfs::exists(&path) {
            missing += 1;
            continue;
        }
        let read = || -> Result<serde_json::Map<String, Value>, String> {
            let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if size > UPLOAD_INSTALLED_LIMIT {
                return Err(format!("大きすぎる({size} バイト。{} MB まで)", UPLOAD_INSTALLED_LIMIT / 1024 / 1024));
            }
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            match v {
                Value::Object(o) if is_one(o.get("version")) => Ok(o),
                _ => Err("形が違う".into()),
            }
        };
        let j = match read() {
            Ok(j) => j,
            Err(e) => {
                warnings.push(format!("{}{UPLOAD_INSTALLED} を読めない ({e})", if f == "." { String::new() } else { format!("{f} の ") }));
                continue;
            }
        };
        let person = person_of_folder(Some(f)).unwrap_or_default();
        let at = j.get("sentAt").and_then(Value::as_str).unwrap_or("").to_string();
        let newer = newest.get(&person).is_none_or(|(prev, _)| js::cmp_utf16(&at, prev).is_gt());
        if newer {
            newest.insert(person, (at, sent_inventory_of(&j, &place)));
        }
    }
    if newest.is_empty() {
        return SentInventory::default();
    }
    let mut installed = merge_inventories(&newest.values().map(|(_, inv)| inv).collect::<Vec<_>>());
    warnings.append(&mut installed.warnings);
    installed.warnings = warnings;
    if missing > 0 {
        installed.warnings.push(format!("送った人のインストール済みの記録が無いフォルダが {missing} 件あります(この版より前の atlas で送ったもの。送り直すと付きます)"));
    }
    let people: IndexMap<String, InstalledInventory> = newest.iter().filter(|(p, _)| !p.is_empty()).map(|(p, (_, inv))| (p.clone(), merge_inventories(&[inv]))).collect();
    SentInventory { installed: Some(installed), by_person: (!people.is_empty()).then_some(JsMap(people)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sent_names_filters_like_ts() {
        let v = json!([" 武器 ", "武器", "", "a\u{202e}b", "x".repeat(201), 3, "UI", "\u{feff}z\u{feff}"]);
        assert_eq!(sent_names(Some(&v)).unwrap(), ["武器", "UI", "z"]);
        assert_eq!(sent_names(Some(&json!("x"))), None);
    }

    #[test]
    fn index_head_reads_only_the_top() {
        let atlas = json!({ "commit": "a".repeat(40), "committedAt": "2026-11-13T09:00:00+09:00", "dirty": false, "code": "0123456789abcdef" });
        let big = json!({ "version": 1, "kind": "project", "uploadedAt": "2026-11-12T00:00:00.000Z", "atlas": atlas, "sessions": [] });
        let text = crate::json::to_js_string_pretty(&big).unwrap();
        let o = upload_index_head(&text).unwrap();
        assert_eq!(o["uploadedAt"], "2026-11-12T00:00:00.000Z");
        assert_eq!(o["atlas"]["code"], "0123456789abcdef");
        assert!(upload_index_head("{ \"kind\": 1, \"version\": 1 }").is_none());
    }

    #[test]
    fn merges_inventories() {
        let a = InstalledInventory { skills: vec!["b".into(), "a".into()], plugins: vec![InstalledPlugin { marketplace: "m".into(), name: "z".into(), skills: vec!["s2".into()] }], disabled_skills: None, warnings: vec!["w1".into()] };
        let b = InstalledInventory { skills: vec!["a".into(), "c".into()], plugins: vec![InstalledPlugin { marketplace: "m".into(), name: "z".into(), skills: vec!["s1".into()] }, InstalledPlugin { marketplace: "l".into(), name: "y".into(), skills: vec![] }], disabled_skills: Some(vec!["q".into()]), warnings: vec![] };
        let m = merge_inventories(&[&a, &b]);
        assert_eq!(m.skills, ["a", "b", "c"]);
        assert_eq!(m.plugins.iter().map(|p| format!("{}/{}", p.marketplace, p.name)).collect::<Vec<_>>(), ["l/y", "m/z"]);
        assert_eq!(m.plugins[1].skills, ["s1", "s2"]);
        assert_eq!(m.disabled_skills, Some(vec!["q".to_string()]));
        assert_eq!(m.warnings, ["w1"]);
    }
}
