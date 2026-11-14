//! 名前付きグループ(atlas-notes/groups.json)の形と読み取り。
//! packages/report/src/lib/groups.ts(純関数)と groups-io.ts の読み取り側の移植。
//! 壊れていてもエラーにせず、読めた分だけ返して理由を warnings に残す(build / export / judge を止めない)。
//! 書き込み側(loadGroupsForWrite・saveGroups)は groups_io.rs。

use anyhow::{bail, Result};
use atlas_core::js;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

pub const GROUPS_VERSION: i64 = 1;
/// 置き場の既定(リポジトリ直下)。--notes-dir で変えられる
pub const NOTES_DIR_NAME: &str = "atlas-notes";
pub const GROUPS_FILE_NAME: &str = "groups.json";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionGroup {
    /// 一意な名前
    pub name: String,
    /// 任意の一文('' も可)
    pub note: String,
    /// セッション id(重複なし、順序はファイルのまま)
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedGroups {
    pub groups: Vec<SessionGroup>,
    /// 無視した理由(1 件ごと。表示用の日本語)
    pub warnings: Vec<String>,
}

/// 重複を除いて順序を保つ(前後の空白を除き、空のものは捨てる)
pub fn unique_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        let t = js::trim(id);
        if !t.is_empty() && seen.insert(t) {
            out.push(t.to_string());
        }
    }
    out
}

/// `JSON.stringify(v)`(undefined は "undefined" と書く。メッセージ用)
fn stringify(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => atlas_core::json::to_js_string(v).unwrap_or_default(),
    }
}

/// groups.json の中身(JSON.parse 済み)を検証する。
/// ファイル全体の形が違えば groups は空で警告 1 件。1 件だけ形が違えばその 1 件を飛ばして警告。重複名は後の方を無視して警告。
pub fn parse_groups(raw: &Value, source: &str) -> ParsedGroups {
    let Some(obj) = raw.as_object() else {
        return ParsedGroups { groups: vec![], warnings: vec![format!("{source}: 全体がオブジェクトではないため無視しました")] };
    };
    if obj.get("version").and_then(Value::as_f64) != Some(GROUPS_VERSION as f64) {
        return ParsedGroups { groups: vec![], warnings: vec![format!("{source}: version が {GROUPS_VERSION} ではない({})ため無視しました", stringify(obj.get("version")))] };
    }
    let Some(list) = obj.get("groups").and_then(Value::as_array) else {
        return ParsedGroups { groups: vec![], warnings: vec![format!("{source}: groups が配列ではないため無視しました")] };
    };
    let mut warnings = Vec::new();
    let mut groups = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (i, g) in list.iter().enumerate() {
        let at = format!("{source} の groups[{i}]");
        let Some(g) = g.as_object() else {
            warnings.push(format!("{at}: オブジェクトではないため無視しました"));
            continue;
        };
        let name = g.get("name").and_then(Value::as_str).map(js::trim).unwrap_or("").to_string();
        if name.is_empty() {
            warnings.push(format!("{at}: name が空か文字列ではないため無視しました"));
            continue;
        }
        if seen.contains(&name) {
            warnings.push(format!("{at}: 名前「{name}」が重複しているため後の方を無視しました"));
            continue;
        }
        let ids: Option<Vec<&str>> = g.get("ids").and_then(Value::as_array).and_then(|a| a.iter().map(Value::as_str).collect());
        let Some(ids) = ids else {
            warnings.push(format!("{at}({name}): ids が文字列の配列ではないため無視しました"));
            continue;
        };
        let note = g.get("note");
        if note.is_some_and(|n| !n.is_null() && !n.is_string()) {
            warnings.push(format!("{at}({name}): note が文字列ではないため空にしました"));
        }
        seen.insert(name.clone());
        groups.push(SessionGroup { name, note: note.and_then(Value::as_str).unwrap_or("").to_string(), ids: unique_ids(ids) });
    }
    ParsedGroups { groups, warnings }
}

/// 先頭一致で id を解決する。完全一致があればそれ、無ければ先頭一致が 1 つだけならそれ。
/// 複数に当たれば曖昧、どれにも当たらなければ未知としてエラーにする(黙って無視しない)。
pub fn resolve_id_prefixes(known: &[&str], prefixes: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for p in unique_ids(prefixes.iter().map(String::as_str)) {
        if known.contains(&p.as_str()) {
            out.push(p);
            continue;
        }
        let hits: Vec<&str> = known.iter().copied().filter(|id| id.starts_with(p.as_str())).collect();
        match hits.len() {
            1 => out.push(hits[0].to_string()),
            0 => bail!("セッション {p} は記録にありません"),
            n => bail!("セッション {p} は曖昧です({n} 件に一致: {}{})", hits[..3.min(n)].join(", "), if n > 3 { " …" } else { "" }),
        }
    }
    Ok(unique_ids(out.iter().map(String::as_str)))
}

/// groups.json を読んだ結果
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoadedGroups {
    pub path: String,
    /// ファイルがあったか(無ければ groups は空で警告も無い)
    pub exists: bool,
    pub groups: Vec<SessionGroup>,
    pub warnings: Vec<String>,
}

/// groups.json を読む(groups-io.ts の loadGroups)。読めない・形が違う箇所は警告にする
pub fn load_groups(path: &Path) -> LoadedGroups {
    let p = path.to_string_lossy().into_owned();
    if !path.exists() {
        return LoadedGroups { path: p, exists: false, groups: vec![], warnings: vec![] };
    }
    let raw = std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| js::parse_json(&String::from_utf8_lossy(&b)).map_err(|e| e.to_string()));
    match raw {
        Err(e) => LoadedGroups { warnings: vec![format!("{p}: JSON として読めないため無視しました({e})")], path: p, exists: true, groups: vec![] },
        Ok(raw) => {
            let parsed = parse_groups(&raw, &p);
            LoadedGroups { path: p, exists: true, groups: parsed.groups, warnings: parsed.warnings }
        }
    }
}

/// 送った人のタスクタグのグループ名の、人とタグの区切り
pub const MEMBER_TAG_SEP: &str = " / ";

/// memberGroups に渡すセッションの項目
#[derive(Debug, Clone, Copy)]
pub struct MemberSource<'a> {
    pub id: &'a str,
    pub person: Option<&'a str>,
    pub upload_tags: &'a [String],
}

impl<'a> From<&'a atlas_core::types::SessionRecord> for MemberSource<'a> {
    fn from(r: &'a atlas_core::types::SessionRecord) -> Self {
        MemberSource { id: &r.id, person: r.person.as_ref().and_then(|p| p.as_deref()), upload_tags: r.upload_tags.as_deref().unwrap_or(&[]) }
    }
}

/// 送り先から集計したセッションの、送った人が付けていたタスクタグ(uploadTags)をグループにする。
/// 人ごとに分ける。名前は「<人> / <タグ>」、人のフォルダが無ければタグだけ。並びは人の名前、タグの名前の順(ja の照合)
pub fn member_groups(sessions: &[MemberSource<'_>]) -> Vec<SessionGroup> {
    // 人とタグの組で分ける(名前をつないだ文字列で分けると、「a」の「b / c」と「a / b」の「c」が 1 つになる)
    let mut by_key: indexmap::IndexMap<(String, String), indexmap::IndexSet<String>> = indexmap::IndexMap::new();
    for s in sessions {
        for tag in s.upload_tags {
            let person = s.person.unwrap_or("").to_string();
            by_key.entry((person, tag.clone())).or_default().insert(s.id.to_string());
        }
    }
    let mut sorted: Vec<((String, String), indexmap::IndexSet<String>)> = by_key.into_iter().collect();
    sorted.sort_by(|a, b| atlas_core::collate::locale_compare(&a.0.0, &b.0.0).then_with(|| atlas_core::collate::locale_compare(&a.0.1, &b.0.1)));
    // 表示名が重なったら、後のものに番号を付けて分ける(名前はグループの鍵なので重ねない)
    let mut used: HashSet<String> = HashSet::new();
    sorted
        .into_iter()
        .map(|((person, tag), ids)| {
            let base = if person.is_empty() { tag } else { format!("{person}{MEMBER_TAG_SEP}{tag}") };
            let mut name = base.clone();
            let mut n = 2;
            while used.contains(&name) {
                name = format!("{base} ({n})");
                n += 1;
            }
            used.insert(name.clone());
            SessionGroup { name, note: String::new(), ids: ids.into_iter().collect() }
        })
        .collect()
}

/// グループ名をフォルダ名にする。フォルダ名に使えない文字は _ にし、Windows の予約名・末尾の点と空白も避ける
pub fn safe_dir_name(name: &str) -> String {
    let replaced: String = name.chars().map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 { '_' } else { c }).collect();
    let mut s = js::trim(replaced.trim_end_matches(['.', ' '])).to_string();
    // 拡張子が付いても予約名(nul.log など)。memo.rs の RESERVED_NAME と同じ
    if crate::memo::is_reserved_name(&s) {
        s = format!("_{s}");
    }
    if s.is_empty() { "group".into() } else { s }
}

#[derive(serde::Serialize)]
struct GroupsFile<'a> {
    version: i64,
    groups: &'a [SessionGroup],
}

/// 書き出す形(キーの順を固定し、空の note も書いて雛形になるようにする)
pub fn serialize_groups(groups: &[SessionGroup]) -> String {
    let file = GroupsFile { version: GROUPS_VERSION, groups };
    format!("{}\n", atlas_core::json::to_js_string_pretty(&file).expect("groups.json は JSON にできる"))
}

/// addIds の戻り
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Added {
    pub group: SessionGroup,
    /// 実際に増えた数
    pub added: usize,
    /// 既に入っていた数
    pub dup: usize,
}

/// グループに id を足す(重複は足さない、順序は元のまま + 足した順)
pub fn add_ids<'a>(group: &SessionGroup, ids: impl IntoIterator<Item = &'a str>) -> Added {
    let mut have: HashSet<String> = group.ids.iter().cloned().collect();
    let mut next = group.ids.clone();
    let (mut added, mut dup) = (0, 0);
    for id in unique_ids(ids) {
        if have.contains(&id) {
            dup += 1;
        } else {
            have.insert(id.clone());
            next.push(id);
            added += 1;
        }
    }
    Added { group: SessionGroup { ids: next, ..group.clone() }, added, dup }
}

/// グループから id を外す(0 件になっても消さない)。戻りの数は実際に減った数
pub fn remove_ids<'a>(group: &SessionGroup, ids: impl IntoIterator<Item = &'a str>) -> (SessionGroup, usize) {
    let drop: HashSet<String> = unique_ids(ids).into_iter().collect();
    let next: Vec<String> = group.ids.iter().filter(|id| !drop.contains(*id)).cloned().collect();
    let removed = group.ids.len() - next.len();
    (SessionGroup { ids: next, ..group.clone() }, removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_and_dedupes() {
        let r = parse_groups(&json!({ "version": 1, "groups": [{ "name": " 調査 ", "note": "x", "ids": ["a", "b", "a", " "] }, { "name": "空", "ids": [] }] }), GROUPS_FILE_NAME);
        assert!(r.warnings.is_empty());
        assert_eq!(
            r.groups,
            vec![
                SessionGroup { name: "調査".into(), note: "x".into(), ids: vec!["a".into(), "b".into()] },
                SessionGroup { name: "空".into(), note: "".into(), ids: vec![] },
            ]
        );
    }

    #[test]
    fn broken_shapes_become_warnings() {
        let r = parse_groups(&Value::Null, GROUPS_FILE_NAME);
        assert!(r.groups.is_empty());
        assert!(r.warnings[0].contains("オブジェクトではない"));
        assert_eq!(parse_groups(&json!({ "version": 2, "groups": [] }), "g").warnings[0], "g: version が 1 ではない(2)ため無視しました");
        assert_eq!(parse_groups(&json!({ "groups": [] }), "g").warnings[0], "g: version が 1 ではない(undefined)ため無視しました");
        assert!(parse_groups(&json!({ "version": 1, "groups": {} }), "g").warnings[0].contains("配列ではない"));
        let r = parse_groups(
            &json!({ "version": 1, "groups": [{ "name": "ok", "ids": ["a"] }, "junk", { "name": "", "ids": [] }, { "name": "bad", "ids": "a" }, { "name": "ok", "ids": ["b"] }, { "name": "n", "ids": ["c"], "note": 3 }] }),
            "g",
        );
        assert_eq!(r.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["ok", "n"]);
        assert_eq!(r.groups[0].ids, ["a"]);
        assert_eq!(r.groups[1].note, "");
        assert_eq!(r.warnings.len(), 5);
        assert!(r.warnings.iter().find(|w| w.contains("重複")).unwrap().contains("「ok」"));
        assert!(r.warnings.iter().find(|w| w.contains("note")).unwrap().contains("(n)"));
    }

    #[test]
    fn id_prefixes() {
        let known = ["abc-1", "abc-2", "abd-1", "abc"];
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(resolve_id_prefixes(&known, &s(&["abc"])).unwrap(), ["abc"]);
        assert_eq!(resolve_id_prefixes(&known, &s(&["abd", "abc-2", "abd"])).unwrap(), ["abd-1", "abc-2"]);
        assert!(resolve_id_prefixes(&known, &s(&["abc-"])).unwrap_err().to_string().contains("曖昧"));
        assert!(resolve_id_prefixes(&known, &s(&["zzz"])).unwrap_err().to_string().contains("記録にありません"));
    }

    #[test]
    fn loads_missing_and_broken_files() {
        let dir = std::env::temp_dir().join(format!("atlas-groups-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(GROUPS_FILE_NAME);
        let _ = std::fs::remove_file(&p);
        let g = load_groups(&p);
        assert!(!g.exists && g.groups.is_empty() && g.warnings.is_empty());
        std::fs::write(&p, "{ broken").unwrap();
        let g = load_groups(&p);
        assert!(g.exists && g.warnings[0].contains("JSON として読めない"));
        std::fs::write(&p, r#"{"version":1,"groups":[{"name":"g","ids":["1"]}]}"#).unwrap();
        assert_eq!(load_groups(&p).groups[0].ids, ["1"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
    // report-lib.test.ts の「addIds は重複を足さず順序を保ち、removeIds は 0 件になっても消さない」
    #[test]
    fn add_and_remove() {
        let g = SessionGroup { name: "g".into(), note: "".into(), ids: vec!["a".into(), "b".into()] };
        let r = add_ids(&g, ["b", "c", "c", " ", "a"]);
        assert_eq!((r.group.ids.clone(), r.added, r.dup), (vec!["a".to_string(), "b".into(), "c".into()], 1, 2));
        assert_eq!(g.ids, ["a", "b"]);
        assert_eq!(add_ids(&g, []).added, 0);
        let (d, n) = remove_ids(&g, ["a", "zzz"]);
        assert_eq!((d.ids.clone(), n), (vec!["b".to_string()], 1));
        let (e, n) = remove_ids(&d, ["b"]);
        assert_eq!((e.ids.len(), n), (0, 1));
        assert_eq!(remove_ids(&e, ["a"]).1, 0);
    }

    #[test]
    fn serialize_like_json_stringify() {
        let r = parse_groups(&json!({ "version": 1, "groups": [{ "name": " 調査 ", "note": "x", "ids": ["a", "b", "a", " "] }, { "name": "空", "ids": [] }] }), GROUPS_FILE_NAME);
        assert_eq!(serialize_groups(&r.groups), "{\n  \"version\": 1,\n  \"groups\": [\n    {\n      \"name\": \"調査\",\n      \"note\": \"x\",\n      \"ids\": [\n        \"a\",\n        \"b\"\n      ]\n    },\n    {\n      \"name\": \"空\",\n      \"note\": \"\",\n      \"ids\": []\n    }\n  ]\n}\n");
    }

    // report-lib.test.ts の memberGroups
    #[test]
    fn member_groups_by_person_and_tag() {
        let t = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let (a, b, c, d, e) = (t(&["武器"]), t(&["武器", "UI"]), t(&["武器"]), t(&["共有"]), t(&[]));
        let src = [
            MemberSource { id: "s1", person: Some("person-b"), upload_tags: &a },
            MemberSource { id: "s2", person: Some("person-a"), upload_tags: &b },
            MemberSource { id: "s3", person: Some("person-a"), upload_tags: &c },
            MemberSource { id: "s4", person: None, upload_tags: &d },
            MemberSource { id: "s5", person: Some("person-a"), upload_tags: &e },
            MemberSource { id: "s6", person: None, upload_tags: &[] },
        ];
        let g = member_groups(&src);
        assert_eq!(g.iter().map(|x| (x.name.as_str(), x.ids.join(","))).collect::<Vec<_>>(), [("共有", "s4".into()), ("person-a / UI", "s2".into()), ("person-a / 武器", "s2,s3".into()), ("person-b / 武器", "s1".to_string())]);
        assert!(member_groups(&[]).is_empty());
        let (x, y) = (t(&["b / c"]), t(&["c"]));
        let z = t(&["b / c", "b / c"]);
        let g = member_groups(&[MemberSource { id: "s1", person: Some("a"), upload_tags: &x }, MemberSource { id: "s2", person: Some("a / b"), upload_tags: &y }, MemberSource { id: "s3", person: Some("a"), upload_tags: &z }]);
        assert_eq!(g.iter().map(|x| (x.name.as_str(), x.ids.join(","))).collect::<Vec<_>>(), [("a / b / c", "s1,s3".to_string()), ("a / b / c (2)", "s2".into())]);
    }

    #[test]
    fn dir_names() {
        assert_eq!(safe_dir_name("a/b:c"), "a_b_c");
        assert_eq!(safe_dir_name("nul.log"), "_nul.log");
        assert_eq!(safe_dir_name("x. . "), "x");
        assert_eq!(safe_dir_name("..."), "group");
        assert_eq!(safe_dir_name(" 調査 "), "調査");
    }
}
