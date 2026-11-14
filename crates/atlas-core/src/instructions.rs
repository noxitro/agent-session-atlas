//! system.message 本文から指示ファイルの注入を切り出す(packages/core/src/instructions.ts の移植)。
//! Copilot CLI は各ファイルを <custom_instruction> で包むだけでファイル名を書かない。
//! ファイル名が分かるのは <imported_custom_instruction source="..."> の場合だけなので、残りは見出し等から推定する。

use crate::js;
use crate::turns::js_re;
use crate::types::{InstructionFile, InstructionInjection, InstructionMethod, InstructionScope, SessionRecord};
use indexmap::IndexMap;
use regex::Regex;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq)]
pub struct InstructionBlock {
    pub file: InstructionFile,
    pub method: InstructionMethod,
    pub chars: i64,
    pub heading: String,
    pub content_hash: String,
    pub source_path: Option<String>,
    /// 本文(Phase 11 の閲覧ページ用。sessions.json には入れない)
    pub body: String,
}

static CUSTOM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<custom_instruction>\n?((?s:.)*?)\n?</custom_instruction>").unwrap());
static IMPORTED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<imported_custom_instruction source="([^"]*)">\n?((?s:.)*?)\n?</imported_custom_instruction>"#).unwrap());
const APPLY_TO_PREFIX: &str = "This instruction applies to files matching the pattern:";

/// コードポイント数(サロゲートペアを 1 字と数える)
pub fn char_count(s: &str) -> i64 {
    s.chars().count() as i64
}

/// Node が文字列を UTF-8 にするときと同じバイト列(サロゲートの片割れは U+FFFD)
pub(crate) fn node_utf8(s: &str) -> std::borrow::Cow<'_, str> {
    if s.chars().any(|c| js::lone_surrogate_unit(c).is_some()) {
        std::borrow::Cow::Owned(s.chars().map(|c| if js::lone_surrogate_unit(c).is_some() { '\u{fffd}' } else { c }).collect())
    } else {
        std::borrow::Cow::Borrowed(s)
    }
}

pub fn content_hash(s: &str) -> String {
    let t = s.replace("\r\n", "\n");
    let t = js::trim(&t);
    let mut h = Sha1::new();
    h.update(node_utf8(t).as_bytes());
    hex::encode(h.finalize())[..12].to_string()
}

pub fn first_heading(s: &str) -> String {
    for line in s.split('\n') {
        let t = js::trim(line);
        if !t.is_empty() {
            return js::utf16_slice(t, 0, 80).into_owned();
        }
    }
    String::new()
}

static GH_INSTR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.github/instructions/").unwrap());
static INSTR_MD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.instructions\.md$").unwrap());

pub fn file_from_path(p: &str) -> InstructionFile {
    let norm = p.replace('\\', "/");
    let base = norm.rsplit('/').next().unwrap_or("");
    let lower = js::to_lower(base);
    if GH_INSTR_RE.is_match(&norm) || INSTR_MD_RE.is_match(base) {
        return InstructionFile::GithubInstructions;
    }
    match lower.as_str() {
        "copilot-instructions.md" => InstructionFile::CopilotInstructions,
        "agents.md" => InstructionFile::AgentsMd,
        "claude.md" => InstructionFile::ClaudeMd,
        "gemini.md" => InstructionFile::GeminiMd,
        _ => InstructionFile::Unknown,
    }
}

static IMPORT_STUB_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"^@\S+$")).unwrap());
static AGENTS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)AGENTS\.md").unwrap());
static CLAUDE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?i){}", js_re(r"CLAUDE\.md|\bclaude\b"))).unwrap());
static COPILOT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?i){}", js_re(r"copilot-instructions\.md|\bcopilot\b"))).unwrap());

fn classify_by_content(text: &str) -> (InstructionFile, InstructionMethod) {
    let t = js::trim(text);
    if t.starts_with(APPLY_TO_PREFIX) {
        return (InstructionFile::GithubInstructions, InstructionMethod::ApplyTo);
    }
    let lines: Vec<&str> = t.split('\n').map(js::trim).filter(|l| !l.is_empty()).collect();
    if !lines.is_empty() && lines.iter().all(|l| IMPORT_STUB_RE.is_match(l)) {
        return (InstructionFile::ClaudeMd, InstructionMethod::ImportStub);
    }
    let h = first_heading(t);
    if h.starts_with('#') {
        if AGENTS_RE.is_match(&h) {
            return (InstructionFile::AgentsMd, InstructionMethod::HeadingKeyword);
        }
        if CLAUDE_RE.is_match(&h) {
            return (InstructionFile::ClaudeMd, InstructionMethod::HeadingKeyword);
        }
        if COPILOT_RE.is_match(&h) {
            return (InstructionFile::CopilotInstructions, InstructionMethod::HeadingKeyword);
        }
    }
    (InstructionFile::Unknown, InstructionMethod::Unresolved)
}

/// 1 つの system.message 本文から指示ブロックを取り出す
pub fn extract_instruction_blocks(content: &str) -> Vec<InstructionBlock> {
    let mut out = Vec::new();
    if !content.contains("<custom_instruction>") {
        return out;
    }
    for m in CUSTOM_RE.captures_iter(content) {
        let body = m.get(1).map_or("", |x| x.as_str());
        let mut outer = body.to_string();
        for im in IMPORTED_RE.captures_iter(body) {
            let inner = &im[2];
            out.push(InstructionBlock {
                file: file_from_path(&im[1]),
                method: InstructionMethod::ImportedSource,
                chars: char_count(inner),
                heading: first_heading(inner),
                content_hash: content_hash(inner),
                source_path: Some(im[1].to_string()),
                body: inner.to_string(),
            });
            outer = outer.replacen(&im[0], "", 1);
        }
        if js::trim(&outer).is_empty() {
            continue;
        }
        let (file, method) = classify_by_content(&outer);
        out.push(InstructionBlock { file, method, chars: char_count(&outer), heading: first_heading(&outer), content_hash: content_hash(&outer), source_path: None, body: outer });
    }
    out
}

/// セッション内の指示ブロックを内容ハッシュで束ねる
#[derive(Default)]
pub struct InstructionCollector {
    map: IndexMap<String, InstructionInjection>,
}

impl InstructionCollector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, content: &str, at: Option<&str>) {
        for b in extract_instruction_blocks(content) {
            let key = format!("{}:{}", b.content_hash, b.source_path.as_deref().unwrap_or(""));
            if let Some(cur) = self.map.get_mut(&key) {
                cur.injections += 1;
                continue;
            }
            self.map.insert(
                key,
                InstructionInjection {
                    file: b.file,
                    scope: if b.file == InstructionFile::Unknown { InstructionScope::Unknown } else { InstructionScope::Repo },
                    method: b.method,
                    chars: b.chars,
                    first_seen_at: at.map(str::to_string),
                    heading: b.heading,
                    content_hash: b.content_hash,
                    injections: 1,
                    source_path: b.source_path.filter(|s| !s.is_empty()),
                },
            );
        }
    }

    pub fn result(self) -> Vec<InstructionInjection> {
        self.map.into_values().collect()
    }
}

/// 全セッションを見て未特定のブロックを埋める(破壊的に更新)。
/// 1) 3 プロジェクト以上で同一内容なら、ユーザー単位の指示とみなす(cross-project)
/// 2) 同じ内容ハッシュ / 同じ見出しが他所で特定済みならそれに合わせる(learned-heading)
pub fn resolve_instructions(sessions: &mut [SessionRecord], cross_project_threshold: usize) {
    let mut projects_by_hash: HashMap<String, HashSet<String>> = HashMap::new();
    for s in sessions.iter() {
        for i in &s.instructions {
            projects_by_hash.entry(i.content_hash.clone()).or_default().insert(s.project.clone());
        }
    }
    for s in sessions.iter_mut() {
        for i in s.instructions.iter_mut() {
            if i.method == InstructionMethod::ImportedSource {
                continue;
            }
            if projects_by_hash.get(&i.content_hash).map_or(0, HashSet::len) < cross_project_threshold {
                continue;
            }
            i.scope = InstructionScope::User;
            if i.file == InstructionFile::Unknown {
                i.file = InstructionFile::CopilotInstructions;
                i.method = InstructionMethod::CrossProject;
            }
        }
    }
    type Label = (InstructionFile, InstructionScope);
    let mut by_hash: HashMap<String, Label> = HashMap::new();
    let mut by_heading: HashMap<String, IndexMap<String, Label>> = HashMap::new();
    for s in sessions.iter() {
        for i in &s.instructions {
            if i.file == InstructionFile::Unknown {
                continue;
            }
            let label = (i.file, i.scope);
            by_hash.insert(i.content_hash.clone(), label);
            if !i.heading.starts_with('#') {
                continue;
            }
            by_heading.entry(i.heading.clone()).or_default().insert(format!("{}|{}", i.file.as_str(), i.scope.as_str()), label);
        }
    }
    for s in sessions.iter_mut() {
        for i in s.instructions.iter_mut() {
            if i.file != InstructionFile::Unknown {
                continue;
            }
            let hs = by_heading.get(&i.heading);
            let learned = by_hash.get(&i.content_hash).copied().or_else(|| hs.filter(|h| h.len() == 1).and_then(|h| h.values().next().copied()));
            let Some((file, scope)) = learned else { continue };
            i.file = file;
            i.scope = scope;
            i.method = InstructionMethod::LearnedHeading;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks() {
        let content = "<custom_instruction>\n<imported_custom_instruction source=\"C:/r/AGENTS.md\">\n# Rules\nbody\n</imported_custom_instruction>\n# Copilot notes\nx\n</custom_instruction>";
        let b = extract_instruction_blocks(content);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].file, InstructionFile::AgentsMd);
        assert_eq!(b[0].method, InstructionMethod::ImportedSource);
        assert_eq!(b[0].heading, "# Rules");
        assert_eq!(b[0].source_path.as_deref(), Some("C:/r/AGENTS.md"));
        assert_eq!(b[1].file, InstructionFile::CopilotInstructions);
        assert_eq!(b[1].method, InstructionMethod::HeadingKeyword);
        let stub = extract_instruction_blocks("<custom_instruction>@AGENTS.md\n@docs/x.md</custom_instruction>");
        assert_eq!((stub[0].file, stub[0].method), (InstructionFile::ClaudeMd, InstructionMethod::ImportStub));
        let apply = extract_instruction_blocks("<custom_instruction>This instruction applies to files matching the pattern: *.ts\nx</custom_instruction>");
        assert_eq!(apply[0].method, InstructionMethod::ApplyTo);
        assert_eq!(content_hash("a\r\nb  "), content_hash("a\nb"));
        assert_eq!(char_count("😀a"), 2);
        assert_eq!(file_from_path("x\\.github\\instructions\\a.md"), InstructionFile::GithubInstructions);
        assert_eq!(file_from_path("y/foo.instructions.md"), InstructionFile::GithubInstructions);
        assert_eq!(file_from_path("Claude.md"), InstructionFile::ClaudeMd);
    }
}
