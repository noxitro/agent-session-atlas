//! ナレッジ vault(llm-wiki)参照の分類(packages/core/src/wiki.ts の移植)。どの vault をどの形式で数えるかは WikiSpec で指定する。
//!
//! TS 版は先読み・後読みのある正規表現(/iu)で探す。regex クレートには先読み・後読みが無いので、
//! vault の名前(大文字小文字を区別しない固定の文字列)の候補の位置を順に見て、前後の文字を確かめる形に書き換えた。
//! 位置を左から 1 つずつ試し、最初に当たったものを使う(JS の正規表現の探し方と同じ)。

use crate::js::{self, JsMap};
use crate::types::WikiUsage;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

/// 参照を数える vault 1 つの指定。index / pages / extensions の省略時は既定の形式
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WikiSpec {
    /// vault のフォルダ名か、その末尾を含むパス
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
}

const WRITE_TOOLS: &[&str] = &["edit", "create", "apply_patch", "write", "str_replace_editor"];

static NAME_CHAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_-]$").unwrap());
static LETTER_OR_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}]$").unwrap());
static SEPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/]+").unwrap());
static LEAD_DOT_SLASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\./)+").unwrap());

fn is_name_char(c: char) -> bool {
    let mut b = [0u8; 4];
    NAME_CHAR.is_match(c.encode_utf8(&mut b))
}

fn is_letter_or_number(c: char) -> bool {
    let mut b = [0u8; 4];
    LETTER_OR_NUMBER.is_match(c.encode_utf8(&mut b))
}

/// 区切りを / にそろえて連続もまとめる
fn norm_path(s: &str) -> String {
    SEPS.replace_all(s, "/").into_owned()
}

fn trim_path(s: &str) -> String {
    let n = norm_path(s);
    let n = LEAD_DOT_SLASH.replace(&n, "");
    n.strip_suffix('/').unwrap_or(&n).to_string()
}

/// 固定の文字列(大文字小文字を区別しない)が、その位置から始まるか。始まるなら終わりの位置
struct Literal(Regex);

impl Literal {
    fn new(s: &str) -> Self {
        Literal(Regex::new(&format!("(?i)^(?:{})", regex::escape(s))).unwrap())
    }
    fn at(&self, text: &str, pos: usize) -> Option<usize> {
        self.0.find(&text[pos..]).map(|m| pos + m.end())
    }
}

struct CompiledWiki {
    label: String,
    /// vault の位置を探すもの
    finder: Regex,
    vault: Literal,
    index: Vec<Literal>,
    /// ページのフォルダ(空なら vault 全体)
    prefixes: Vec<Literal>,
    exts: Vec<Literal>,
    has_page: bool,
}

/// 参照をまとめた結果(TS の WikiUsage の空のもの)
pub fn empty_wiki() -> WikiUsage {
    WikiUsage::default()
}

/// ツール引数の文字列値だけをつなぐ
fn arg_text(args: Option<&Value>) -> String {
    match args {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().map(|x| arg_text(Some(x))).collect::<Vec<_>>().join("\n"),
        Some(Value::Object(o)) => js_values(o).into_iter().map(|x| arg_text(Some(x))).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// `Object.values(o)` の順(添字の形のキーが先)
pub(crate) fn js_values(o: &serde_json::Map<String, Value>) -> Vec<&Value> {
    if !o.keys().any(|k| js::array_index(k).is_some()) {
        return o.values().collect();
    }
    let mut idx: Vec<(u32, &Value)> = Vec::new();
    let mut rest = Vec::new();
    for (k, v) in o {
        match js::array_index(k) {
            Some(n) => idx.push((n, v)),
            None => rest.push(v),
        }
    }
    idx.sort_by_key(|x| x.0);
    idx.into_iter().map(|x| x.1).chain(rest).collect()
}

fn compile(spec: &WikiSpec) -> CompiledWiki {
    let path = trim_path(&spec.path);
    let index: Vec<String> = spec.index.clone().unwrap_or_else(|| vec!["index.md".into()]).iter().map(|f| trim_path(f)).collect();
    let dirs: Vec<String> = spec.pages.clone().unwrap_or_else(|| vec![".".into()]).iter().map(|d| trim_path(d)).collect();
    let exts: Vec<String> = spec.extensions.clone().unwrap_or_else(|| vec![".md".into()]).iter().map(|e| e.strip_prefix('.').unwrap_or(e).to_string()).collect();
    let whole = dirs.iter().any(|d| d.is_empty() || d == ".");
    CompiledWiki {
        label: path.rsplit('/').next().unwrap_or(&path).to_string(),
        finder: Regex::new(&format!("(?i){}", regex::escape(&path))).unwrap(),
        vault: Literal::new(&path),
        index: index.iter().map(|f| Literal::new(f)).collect(),
        prefixes: if whole { Vec::new() } else { dirs.iter().map(|d| Literal::new(&format!("{d}/"))).collect() },
        exts: exts.iter().map(|e| Literal::new(e)).collect(),
        has_page: !dirs.is_empty() && !exts.is_empty(),
    }
}

fn char_before(text: &str, pos: usize) -> Option<char> {
    text[..pos].chars().next_back()
}

fn char_at(text: &str, pos: usize) -> Option<char> {
    text[pos..].chars().next()
}

impl CompiledWiki {
    /// pos に vault がある(前後の確かめも通る)なら、vault の終わりの位置
    fn vault_at(&self, text: &str, pos: usize) -> Option<usize> {
        // (?<![\p{L}\p{N}_-]|\.)
        if let Some(c) = char_before(text, pos) {
            if is_name_char(c) || c == '.' {
                return None;
            }
        }
        let end = self.vault.at(text, pos)?;
        // (?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])
        let mut it = text[end..].chars();
        match (it.next(), it.next()) {
            (Some(c), _) if is_name_char(c) => None,
            (Some('.'), Some(n)) if is_letter_or_number(n) => None,
            _ => Some(end),
        }
    }

    /// vault がありうる位置(左から順)
    fn candidates<'t>(&'t self, text: &'t str) -> impl Iterator<Item = usize> + 't {
        let mut start = 0usize;
        std::iter::from_fn(move || {
            if start > text.len() {
                return None;
            }
            let m = self.finder.find_at(text, start)?;
            let p = m.start();
            start = p + char_at(text, p).map_or(1, char::len_utf8);
            Some(p)
        })
    }

    fn marker(&self, text: &str) -> bool {
        self.candidates(text).any(|p| self.vault_at(text, p).is_some())
    }

    fn index_test(&self, text: &str) -> bool {
        if self.index.is_empty() {
            return false;
        }
        self.candidates(text).any(|p| {
            let Some(end) = self.vault_at(text, p) else { return false };
            if char_at(text, end) != Some('/') {
                return false;
            }
            let s = end + 1;
            self.index.iter().any(|lit| match lit.at(text, s) {
                // (?![\p{L}\p{N}_-]|\.)
                Some(e) => !matches!(char_at(text, e), Some(c) if is_name_char(c) || c == '.'),
                None => false,
            })
        })
    }

    /// pos から始まるページの参照(グループ 1 の文字列と、一致の終わり)
    fn page_at(&self, text: &str, pos: usize) -> Option<(usize, String)> {
        let end = self.vault_at(text, pos)?;
        if char_at(text, end) != Some('/') {
            return None;
        }
        let g = end + 1;
        let starts: Vec<usize> = if self.prefixes.is_empty() { vec![g] } else { self.prefixes.iter().filter_map(|l| l.at(text, g)).collect() };
        for body_start in starts {
            // [^"'`*?<>|:\n]+? を 1 字ずつ伸ばし、\.(ext) と (?![\p{L}\p{N}_-]) が通る最初の位置
            let mut cur = body_start;
            for c in text[body_start..].chars() {
                if matches!(c, '"' | '\'' | '`' | '*' | '?' | '<' | '>' | '|' | ':' | '\n') {
                    break;
                }
                cur += c.len_utf8();
                if char_at(text, cur) != Some('.') {
                    continue;
                }
                for ext in &self.exts {
                    if let Some(e) = ext.at(text, cur + 1) {
                        if !matches!(char_at(text, e), Some(c) if is_name_char(c)) {
                            return Some((e, text[g..e].to_string()));
                        }
                    }
                }
            }
        }
        None
    }

    /// matchAll(page) のグループ 1
    fn pages(&self, text: &str) -> Vec<String> {
        if !self.has_page {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut start = 0usize;
        while start <= text.len() {
            let mut found: Option<(usize, String)> = None;
            let mut s = start;
            while let Some(m) = self.finder.find_at(text, s) {
                let p = m.start();
                if let Some(r) = self.page_at(text, p) {
                    found = Some(r);
                    break;
                }
                s = p + char_at(text, p).map_or(1, char::len_utf8);
                if s > text.len() {
                    break;
                }
            }
            match found {
                Some((e, g)) => {
                    out.push(g);
                    start = e;
                }
                None => break,
            }
        }
        out
    }
}

/// 指定の vault に対してツール呼び出しと skill を分類する。指定が無ければ何も数えない
pub struct WikiClassifier {
    wikis: Vec<CompiledWiki>,
    skills: HashSet<String>,
}

impl Default for WikiClassifier {
    fn default() -> Self {
        Self::new(&[])
    }
}

impl WikiClassifier {
    pub fn new(specs: &[WikiSpec]) -> Self {
        WikiClassifier { wikis: specs.iter().map(compile).collect(), skills: specs.iter().flat_map(|s| s.skills.clone().unwrap_or_default()).collect() }
    }

    /// 名前か、skill のファイルの場所から wiki の skill か判定する
    pub fn is_skill(&self, name: &str, path: Option<&Value>) -> bool {
        if self.skills.contains(name) {
            return true;
        }
        if self.wikis.is_empty() {
            return false;
        }
        let p = match js::present(path) {
            Some(v) => js::to_js_string(v),
            None => String::new(),
        };
        self.find(&norm_path(&p)).is_some()
    }

    fn find(&self, text: &str) -> Option<&CompiledWiki> {
        self.wikis.iter().find(|w| w.marker(text))
    }

    /// ツール呼び出し 1 件を分類して w に加える。対象でなければ false
    pub fn classify(&self, w: &mut WikiUsage, tool_name: &str, args: Option<&Value>) -> bool {
        if self.wikis.is_empty() && self.skills.is_empty() {
            return false;
        }
        let text = norm_path(&arg_text(args));
        let vault = self.find(&text);
        if tool_name == "skill" {
            let skill = match args {
                Some(Value::Object(o)) => js::str_of(o.get("skill")).unwrap_or(""),
                _ => "",
            };
            if vault.is_none() && !self.skills.contains(skill) {
                return false;
            }
            w.skill_calls.push(if skill.is_empty() { "(unknown)".into() } else { skill.to_string() });
            return true;
        }
        let Some(vault) = vault else { return false };
        if WRITE_TOOLS.contains(&tool_name) {
            w.writes += 1;
            return true;
        }
        if vault.index_test(&text) {
            w.index_reads += 1;
            return true;
        }
        let pages = vault.pages(&text);
        if !pages.is_empty() {
            let mut seen = HashSet::new();
            for p in pages {
                if seen.insert(p.clone()) {
                    w.page_reads.push(if self.wikis.len() > 1 { format!("{}/{p}", vault.label) } else { p });
                }
            }
            return true;
        }
        w.other_calls += 1;
        true
    }
}

/// JsMap を使う箇所のため(未使用の警告を避ける)
#[allow(dead_code)]
type _Unused = JsMap<i64>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(path: &str) -> WikiSpec {
        WikiSpec { path: path.into(), ..Default::default() }
    }

    #[test]
    fn classify_basic() {
        let c = WikiClassifier::new(&[WikiSpec { skills: Some(vec!["wiki-query".into()]), ..spec("my-notes") }]);
        let mut w = empty_wiki();
        assert!(c.classify(&mut w, "view", Some(&json!({"path": "D:\\x\\my-notes\\index.md"}))));
        assert!(c.classify(&mut w, "view", Some(&json!({"path": "D:/x/my-notes/wiki/a.md"}))));
        assert!(c.classify(&mut w, "edit", Some(&json!({"path": "D:/x/my-notes/wiki/a.md"}))));
        assert!(c.classify(&mut w, "glob", Some(&json!({"pattern": "**/*", "path": "D:/x/my-notes"}))));
        assert!(!c.classify(&mut w, "view", Some(&json!({"path": "D:/x/my-notes-app/index.md"}))));
        assert!(!c.classify(&mut w, "view", Some(&json!({"path": "D:/x/old.my-notes/index.md"}))));
        assert!(c.classify(&mut w, "skill", Some(&json!({"skill": "wiki-query"}))));
        assert!(!c.classify(&mut w, "skill", Some(&json!({"skill": "other"}))));
        assert_eq!(w.index_reads, 1);
        assert_eq!(w.page_reads, vec!["wiki/a.md"]);
        assert_eq!(w.writes, 1);
        assert_eq!(w.other_calls, 1);
        assert_eq!(w.skill_calls, vec!["wiki-query"]);
        assert!(c.is_skill("x", Some(&json!("D:\\x\\my-notes\\skills\\q\\SKILL.md"))));
        assert!(!c.is_skill("x", None));
    }

    #[test]
    fn pages_folders_and_multiple() {
        let c = WikiClassifier::new(&[WikiSpec { pages: Some(vec!["wiki".into()]), ..spec("a-vault") }, spec("b")]);
        let mut w = empty_wiki();
        assert!(c.classify(&mut w, "rg", Some(&json!({"command": "rg x a-vault/wiki/p1.md a-vault/wiki/p1.md A-VAULT/wiki/p2.md"}))));
        assert_eq!(w.page_reads, vec!["a-vault/wiki/p1.md".to_string(), "a-vault/wiki/p2.md".to_string()]);
        let mut w = empty_wiki();
        assert!(c.classify(&mut w, "view", Some(&json!({"path": "a-vault/raw/x.md"}))));
        assert_eq!(w.other_calls, 1);
        // .mdx は .md として数えない(拡張子の後に名前の文字が続く)
        let mut w = empty_wiki();
        assert!(c.classify(&mut w, "view", Some(&json!({"path": "b/x.mdx"}))));
        assert_eq!(w.other_calls, 1);
    }

    #[test]
    fn empty_specs() {
        let c = WikiClassifier::default();
        let mut w = empty_wiki();
        assert!(!c.classify(&mut w, "view", Some(&json!({"path": "x/index.md"}))));
        assert!(!c.classify(&mut w, "skill", Some(&json!({"skill": ""}))));
    }
}
