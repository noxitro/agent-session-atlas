//! 名前付きグループ(atlas-notes/groups.json)の形と読み取り。
//! packages/report/src/lib/groups.ts(純関数)と groups-io.ts の読み取り側の移植。
//! 壊れていてもエラーにせず、読めた分だけ返して理由を warnings に残す(build / export / judge を止めない)。
//! TODO(段 5): memberGroups・safeDirName・serializeGroups・addIds・removeIds・saveGroups・loadGroupsForWrite は group コマンドの移植で足す

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
}
