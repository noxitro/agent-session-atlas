//! セッション id の並びの扱い(重複を除く・先頭一致で解決する)と、名前をフォルダ名にすること。
//! CLI の絞り込み(--session)・メモ・プロジェクトのアップロード・画面の絞り込み(ids)が使う。

use anyhow::{bail, Result};
use atlas_core::js;
use std::collections::HashSet;

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

/// 名前をフォルダ名にする。フォルダ名に使えない文字は _ にし、Windows の予約名・末尾の点と空白も避ける。
/// 何も残らないときの名前("group")は、前の版が送ったフォルダと同じ名前になるように変えていない
pub fn safe_dir_name(name: &str) -> String {
    let replaced: String = name.chars().map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 { '_' } else { c }).collect();
    let mut s = js::trim(replaced.trim_end_matches(['.', ' '])).to_string();
    // 拡張子が付いても予約名(nul.log など)。memo.rs の RESERVED_NAME と同じ
    if crate::memo::is_reserved_name(&s) {
        s = format!("_{s}");
    }
    if s.is_empty() { "group".into() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique() {
        assert_eq!(unique_ids(["a", " b ", "a", " ", "", "b"]), ["a", "b"]);
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
    fn dir_names() {
        assert_eq!(safe_dir_name("a/b:c"), "a_b_c");
        assert_eq!(safe_dir_name("nul.log"), "_nul.log");
        assert_eq!(safe_dir_name("x. . "), "x");
        assert_eq!(safe_dir_name("..."), "group");
        assert_eq!(safe_dir_name(" 調査 "), "調査");
    }
}
