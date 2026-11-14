//! 共有用の伏せ字(--anonymize)。packages/report/src/lib/anonymize.ts の移植。
//! プロジェクト・パス・リポジトリ名・ブランチ・人のフォルダの名前を決定的な仮名に置き換える。
//! 仮名はキーの辞書順(UTF-16 の単位の順)で振るので、同じ入力からは常に同じ仮名になる。
//! 伏せ字モードでは、依頼本文・セッション名・指示ファイルの見出しなどの自由記述は出さない。
//! まとめたプロジェクト((ホーム)・(一時フォルダ)・(atlas の判定))は固有名を含まないので、そのまま出す。
//!
//! TS 版の scrub は後読み(`(?<![\w.-])`)と先読みを使う大文字小文字を無視した正規表現(`gi`、`u` なし)。
//! regex クレートには後読みが無いので、同じ一致を手で探す(候補を順に試し、前後の文字を確かめる)。
//! 大文字小文字の同一視は JS の `u` なしの規則(UTF-16 の単位ごとに toUpperCase。非 ASCII が ASCII に変わるものは変えない)。

use atlas_core::js;
use atlas_core::project_keys::GROUPED_PROJECTS;
use atlas_core::types::SessionRecord;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// 伏せ字の元にするセッションの項目
#[derive(Debug, Clone, Copy, Default)]
pub struct AnonSource<'a> {
    pub project: &'a str,
    pub cwd: Option<&'a str>,
    pub git_root: Option<&'a str>,
    pub repository: Option<&'a str>,
    pub branch: Option<&'a str>,
    /// 送り先の、人のフォルダの名前
    pub person: Option<&'a str>,
}

impl<'a> From<&'a SessionRecord> for AnonSource<'a> {
    fn from(r: &'a SessionRecord) -> Self {
        AnonSource {
            project: &r.project,
            cwd: r.cwd.as_deref(),
            git_root: r.git_root.as_deref(),
            repository: r.repository.as_deref(),
            branch: r.branch.as_deref(),
            person: r.person.as_ref().and_then(|p| p.as_deref()),
        }
    }
}

/// パスらしい文字列(Windows のドライブ付き、UNC、~ と /Users /home などの下)。anonymize.ts の PATH_RE
static PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    let src = [
        r#"(?:[A-Za-z]:\\|\\\\)(?:[^\\/\r\n"'<>|]*\\)*[^\s"'<>|]*"#,
        r#"(?:[A-Za-z]:/|~/|/(?:Users|home|mnt|tmp|var|opt|root|workspaces)/)(?:[^\\/\r\n"'<>|]*/)*[^\s"'<>|]*"#,
    ]
    .join("|");
    Regex::new(&atlas_core::turns::js_re(&src)).unwrap()
});

static HOME_WIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:\\[Uu][Ss][Ee][Rr][Ss]\\[^\\]+").unwrap());
static HOME_POSIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/(?:Users|home)/[^/]+").unwrap());
static OWNER_REPO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^\\/:]+/[^\\/:]+$").unwrap());

/// 表示用のプロジェクト名(伏せ字なし): ホームディレクトリを ~ に短縮
pub fn short_project_label(key: &str) -> String {
    let a = HOME_WIN.replace(key, "~");
    HOME_POSIX.replace(&a, "~").into_owned()
}

fn split_path(p: &str) -> Vec<&str> {
    p.split(['\\', '/']).filter(|s| !s.is_empty()).collect()
}

fn last_segment(p: &str) -> &str {
    split_path(p).last().copied().unwrap_or("")
}

/// `String(n).padStart(width, '0')`
fn pad(n: usize, width: usize) -> String {
    format!("{n:0>width$}")
}

/// JS の `u` なしの `i` の正規化(Canonicalize): UTF-16 の単位を toUpperCase し、1 単位にならないものと非 ASCII → ASCII は変えない
fn canon(c: char) -> char {
    if (c as u32) > 0xFFFF {
        return c;
    }
    let mut up = c.to_uppercase();
    match (up.next(), up.next()) {
        (Some(u), None) if (u as u32) <= 0xFFFF && !((c as u32) >= 128 && (u as u32) < 128) => u,
        _ => c,
    }
}

/// `[\w.-]`(先頭側の境界)
fn word_dot_dash(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// `[\w-]`(固有名の後ろの境界)
fn word_dash(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// s の pos(バイト位置)から lit が大文字小文字を無視して一致すれば、一致の終わりのバイト位置
fn match_ci(s: &str, pos: usize, lit: &[char]) -> Option<usize> {
    let mut it = s[pos..].char_indices();
    for &l in lit {
        let (_, c) = it.next()?;
        if c != l && canon(c) != canon(l) {
            return None;
        }
    }
    Some(it.next().map_or(s.len(), |(i, _)| pos + i))
}

/// 作業フォルダの絶対パス(区切りの違いを許す)の一致の終わり。parts は空でない断片
fn match_dir(s: &str, pos: usize, parts: &[Vec<char>]) -> Option<usize> {
    let mut at = pos;
    for (k, part) in parts.iter().enumerate() {
        if k > 0 {
            // [\\/]+(断片は区切りを含まないので、取れるだけ取ってよい)
            let rest = &s[at..];
            let n = rest.bytes().take_while(|b| *b == b'\\' || *b == b'/').count();
            if n == 0 {
                return None;
            }
            at += n;
        }
        at = match_ci(s, at, part)?;
    }
    Some(at)
}

fn prev_char(s: &str, pos: usize) -> Option<char> {
    s[..pos].chars().next_back()
}

fn next_char(s: &str, pos: usize) -> Option<char> {
    s[pos..].chars().next()
}

/// `[^\s"'<>|]`
fn path_tail_char(c: char) -> bool {
    !(js::is_js_whitespace(c) || matches!(c, '"' | '\'' | '<' | '>' | '|'))
}

#[derive(Debug, Clone)]
struct AnonMaps {
    project_map: HashMap<String, String>,
    branch_map: HashMap<String, String>,
    person_map: HashMap<String, String>,
    /// 作業フォルダの断片(長いものから)
    dir_parts: Vec<Vec<Vec<char>>>,
    /// 既知の固有名(長いものから)と、小文字にしたもの → 仮名
    keys: Vec<Vec<char>>,
    repl_lower: HashMap<String, String>,
    /// 先頭の文字(正規化済み)→ keys の番号(候補を絞るため。順は keys の順)
    keys_by_first: HashMap<char, Vec<usize>>,
}

/// 伏せ字の置き換え(identity は何も変えない)
#[derive(Debug, Clone)]
pub struct Anonymizer {
    pub enabled: bool,
    maps: Option<AnonMaps>,
}

pub fn identity_anonymizer() -> Anonymizer {
    Anonymizer { enabled: false, maps: None }
}

fn grouped(p: &str) -> bool {
    GROUPED_PROJECTS.contains(&p)
}

pub fn create_anonymizer(sessions: &[AnonSource<'_>]) -> Anonymizer {
    let uniq_sorted = |it: &mut dyn Iterator<Item = &str>| -> Vec<String> {
        let mut seen = HashSet::new();
        let mut v: Vec<String> = it.filter(|x| seen.insert(*x)).map(str::to_string).collect();
        v.sort_by(|a, b| js::cmp_utf16(a, b));
        v
    };
    let projects = uniq_sorted(&mut sessions.iter().map(|s| s.project).filter(|p| !grouped(p)));
    let branches = uniq_sorted(&mut sessions.iter().filter_map(|s| s.branch).filter(|b| !b.is_empty()));
    let people = uniq_sorted(&mut sessions.iter().filter_map(|s| s.person).filter(|n| !n.is_empty()));
    let width = |n: usize| 2usize.max(n.to_string().len());
    let (pw, bw, nw) = (width(projects.len()), width(branches.len()), width(people.len()));
    let project_map: HashMap<String, String> = projects.iter().enumerate().map(|(i, p)| (p.clone(), format!("project-{}", pad(i + 1, pw)))).collect();
    let branch_map: HashMap<String, String> = branches.iter().enumerate().map(|(i, b)| (b.clone(), format!("branch-{}", pad(i + 1, bw)))).collect();
    let person_map: HashMap<String, String> = people.iter().enumerate().map(|(i, n)| (n.clone(), format!("person-{}", pad(i + 1, nw)))).collect();

    // scrub で置き換える既知の固有名(長いものから)。3 文字未満は誤置換が多いので除く
    let mut repl: indexmap::IndexMap<String, String> = indexmap::IndexMap::new();
    let mut add = |s: Option<&str>, to: &str| {
        if let Some(s) = s
            && js::utf16_len(s) >= 3 && !repl.contains_key(s) {
                repl.insert(s.to_string(), to.to_string());
            }
    };
    for s in sessions {
        // まとめたプロジェクトのパス(ホーム・一時フォルダ)は PATH_RE で <path> になる。最後のフォルダ名は伏せる
        let g = grouped(s.project);
        let p = if g { "<path>".to_string() } else { project_map[s.project].clone() };
        if !g {
            add(Some(s.project), &p);
        }
        // git の origin から決めた owner/repo(repository の記録が無い)も、所有者名とリポジトリ名を伏せる
        if !g && s.repository.is_none_or(str::is_empty) && OWNER_REPO.is_match(s.project) {
            for part in s.project.split('/') {
                add(Some(part), &p);
            }
        }
        add(s.cwd, &p);
        add(s.git_root, &p);
        add(s.repository, &p);
        if let Some(r) = s.repository.filter(|r| !r.is_empty()) {
            for part in r.split('/') {
                add(Some(part), &p);
            }
        }
        for path in [s.cwd, s.git_root].into_iter().flatten().filter(|x| !x.is_empty()) {
            add(Some(last_segment(path)), &p);
        }
        if let Some(b) = s.branch.filter(|b| !b.is_empty()) {
            add(Some(b), &branch_map[b]);
        }
        if let Some(n) = s.person.filter(|n| !n.is_empty()) {
            add(Some(n), &person_map[n]);
        }
    }
    // 作業フォルダの絶対パスは、その下を含めて先に <path> にする(大文字小文字は無視)
    let mut seen = HashSet::new();
    let mut dirs: Vec<Vec<&str>> = sessions
        .iter()
        .flat_map(|s| [s.cwd, s.git_root])
        .flatten()
        .filter(|d| !d.is_empty() && d.contains(['\\', '/']) && seen.insert(*d))
        .map(split_path)
        .filter(|parts| parts.len() >= 2)
        .collect();
    dirs.sort_by_key(|parts| std::cmp::Reverse(js::utf16_len(&parts.join("/"))));
    let dir_parts: Vec<Vec<Vec<char>>> = dirs.iter().map(|parts| parts.iter().map(|p| p.chars().collect()).collect()).collect();

    let mut repl_lower: HashMap<String, String> = HashMap::new();
    for (k, v) in &repl {
        repl_lower.entry(js::to_lower(k)).or_insert_with(|| v.clone());
    }
    let mut keys: Vec<&String> = repl.keys().collect();
    keys.sort_by_key(|k| std::cmp::Reverse(js::utf16_len(k)));
    let keys: Vec<Vec<char>> = keys.iter().map(|k| k.chars().collect()).collect();
    let mut keys_by_first: HashMap<char, Vec<usize>> = HashMap::new();
    for (i, k) in keys.iter().enumerate() {
        keys_by_first.entry(canon(k[0])).or_default().push(i);
    }
    Anonymizer {
        enabled: true,
        maps: Some(AnonMaps { project_map, branch_map, person_map, dir_parts, keys, repl_lower, keys_by_first }),
    }
}

impl Anonymizer {
    pub fn project(&self, k: &str) -> String {
        match &self.maps {
            None => k.to_string(),
            Some(_) if grouped(k) => k.to_string(),
            Some(m) => m.project_map.get(k).cloned().unwrap_or_else(|| "project-??".into()),
        }
    }

    pub fn project_label(&self, k: &str) -> String {
        match &self.maps {
            None => short_project_label(k),
            Some(_) if grouped(k) => k.to_string(),
            Some(m) => m.project_map.get(k).cloned().unwrap_or_else(|| "project-??".into()),
        }
    }

    pub fn branch(&self, b: Option<&str>) -> Option<String> {
        let b = b?;
        Some(match &self.maps {
            None => b.to_string(),
            Some(m) => m.branch_map.get(b).cloned().unwrap_or_else(|| "branch-??".into()),
        })
    }

    /// 人のフォルダの名前。伏せ字モードでは person-01 など
    pub fn person(&self, n: Option<&str>) -> Option<String> {
        let n = n?;
        Some(match &self.maps {
            None => n.to_string(),
            Some(m) => m.person_map.get(n).cloned().unwrap_or_else(|| "person-??".into()),
        })
    }

    /// 自由記述。伏せ字モードでは None(表示しない)
    pub fn free_text(&self, s: Option<&str>) -> Option<String> {
        if self.enabled { None } else { s.map(str::to_string) }
    }

    /// ファイルパス。伏せ字モードでは None
    pub fn path(&self, p: Option<&str>) -> Option<String> {
        if self.enabled { None } else { p.map(str::to_string) }
    }

    /// エラー文やツール名など、短い機械的な文字列。伏せ字モードでは既知の固有名とパスを置き換える
    pub fn scrub(&self, s: &str) -> String {
        let Some(m) = &self.maps else {
            return s.to_string();
        };
        let out = if m.dir_parts.is_empty() { s.to_string() } else { replace_dirs(s, &m.dir_parts) };
        let out = PATH_RE.replace_all(&out, "<path>").into_owned();
        if m.keys.is_empty() {
            return out;
        }
        replace_keys(&out, m)
    }
}

/// `s.replace(dirRe, '<path>')`。dirRe = `(?<![\w.-])(?:dir1|dir2|…)(?![\w.-])(?:[\\/][^\s"'<>|]*)?`(gi)
fn replace_dirs(s: &str, dirs: &[Vec<Vec<char>>]) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    let mut pos = 0;
    while pos < s.len() {
        let mut hit = None;
        if !word_dot_dash(prev_char(s, pos)) {
            for parts in dirs {
                if let Some(end) = match_dir(s, pos, parts)
                    && !word_dot_dash(next_char(s, end)) {
                        hit = Some(end);
                        break;
                    }
            }
        }
        match hit {
            Some(mut end) => {
                // (?:[\\/][^\s"'<>|]*)?
                if matches!(next_char(s, end), Some('\\' | '/')) {
                    end += 1;
                    for c in s[end..].chars() {
                        if !path_tail_char(c) {
                            break;
                        }
                        end += c.len_utf8();
                    }
                }
                out.push_str(&s[last..pos]);
                out.push_str("<path>");
                last = end;
                pos = end;
            }
            None => pos += next_char(s, pos).map_or(1, char::len_utf8),
        }
    }
    out.push_str(&s[last..]);
    out
}

/// `out.replace(re, (m) => replLower.get(m.toLowerCase()) ?? m)`。re = `(?<![\w.-])(?:k1|k2|…)(?![\w-])`(gi)
fn replace_keys(s: &str, m: &AnonMaps) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    let mut pos = 0;
    while pos < s.len() {
        let c = next_char(s, pos).expect("文字の境界");
        let mut hit = None;
        if !word_dot_dash(prev_char(s, pos))
            && let Some(cands) = m.keys_by_first.get(&canon(c)) {
                for &i in cands {
                    if let Some(end) = match_ci(s, pos, &m.keys[i])
                        && !word_dash(next_char(s, end)) {
                            hit = Some(end);
                            break;
                        }
                }
            }
        match hit {
            Some(end) => {
                let matched = &s[pos..end];
                out.push_str(&s[last..pos]);
                out.push_str(m.repl_lower.get(&js::to_lower(matched)).map_or(matched, String::as_str));
                last = end;
                pos = end;
            }
            None => pos += c.len_utf8(),
        }
    }
    out.push_str(&s[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src<'a>(project: &'a str, cwd: Option<&'a str>, git_root: Option<&'a str>, repository: Option<&'a str>, branch: Option<&'a str>) -> AnonSource<'a> {
        AnonSource { project, cwd, git_root, repository, branch, person: None }
    }

    /// report-lib.test.ts の fixture と同じ項目
    fn fixture() -> Vec<AnonSource<'static>> {
        vec![
            src("quokka/secret-proj", Some("C:\\work\\secret-proj"), None, Some("quokka/secret-proj"), Some("feature/x1")),
            src("/home/me/.copilot/chats/c1", Some("/home/me/.copilot/chats/c1"), None, None, None),
            src("quokka/secret-proj", Some("C:\\work\\secret-proj"), None, Some("quokka/secret-proj"), Some("main")),
            src("D:\\other", Some("D:\\other"), None, None, None),
        ]
    }

    #[test]
    fn pseudonyms_are_sorted() {
        let anon = create_anonymizer(&fixture());
        let projects: Vec<String> = fixture().iter().map(|s| anon.project(s.project)).collect();
        // UTF-16 の単位の順: '/home/…' < 'D:\other' < 'quokka/…'
        assert_eq!(projects, ["project-03", "project-01", "project-03", "project-02"]);
        assert_eq!(fixture().iter().map(|s| anon.branch(s.branch)).collect::<Vec<_>>(), [Some("branch-01".into()), None, Some("branch-02".into()), None]);
        assert_eq!(anon.free_text(Some("x")), None);
        assert_eq!(create_anonymizer(&fixture()).project("quokka/secret-proj"), "project-03");
    }

    #[test]
    fn people() {
        let mut a = fixture();
        a[0].person = Some("zz-kakuu-taro");
        a[1].person = Some("aa-kakuu-hanako");
        let named = create_anonymizer(&a[..2]);
        assert_eq!(named.person(Some("zz-kakuu-taro")).as_deref(), Some("person-02"));
        assert_eq!(named.person(Some("aa-kakuu-hanako")).as_deref(), Some("person-01"));
        assert_eq!(named.person(None), None);
        assert_eq!(named.scrub("reviewed by zz-kakuu-taro"), "reviewed by person-02");
        assert_eq!(identity_anonymizer().person(Some("zz-kakuu-taro")).as_deref(), Some("zz-kakuu-taro"));
    }

    #[test]
    fn scrub_paths_and_names() {
        let anon = create_anonymizer(&fixture());
        assert_eq!(anon.scrub("failed at C:\\work\\secret-proj\\src\\a.ts in secret-proj on feature/x1"), "failed at <path> in project-03 on branch-01");
        assert_eq!(anon.scrub("domain main"), "domain branch-02");

        let cwd = "E:\\Files\\Quokka Den";
        let mut srcs = fixture();
        srcs.push(src("quokka-den-app", Some(cwd), None, None, None));
        let anon = create_anonymizer(&srcs);
        assert_eq!(anon.scrub("read D:\\Profiles\\John Smith\\Cloud Sync - Quokka Den\\notes.txt failed"), "read <path> failed");
        assert_eq!(anon.scrub(&format!("in {cwd} now")), "in <path> now");
        assert_eq!(anon.scrub("in e:\\files\\quokka den\\src\\a.ts now"), "in <path> now");
        let p = anon.project("quokka/secret-proj");
        assert_eq!(anon.scrub("Secret-Proj and SECRET-PROJ"), format!("{p} and {p}"));
        for s in ["~/projects/secret-x/a.md", "/root/secret-x/a", "/workspaces/secret-x/a", "C:/Profiles/John Smith/a.txt"] {
            assert_eq!(anon.scrub(&format!("at {s} end")), "at <path> end");
        }
        assert_eq!(anon.scrub("C:\\a\\b.ts on topic/x"), "<path> on topic/x");
    }

    // phase6.test.ts の「まとめたプロジェクト名はそのまま、git の origin で決めた owner/repo は伏せる」
    #[test]
    fn grouped_and_origin_projects() {
        use atlas_core::project_keys::{HOME_PROJECT, TEMP_PROJECT};
        let anon = create_anonymizer(&[
            src(HOME_PROJECT, Some("X:\\home\\someone"), None, None, None),
            src(TEMP_PROJECT, Some("X:\\home\\someone\\AppData\\Local\\Temp\\probe"), None, None, None),
            src("secret-owner/secret-repo", Some("X:\\code\\secret-repo"), Some("X:\\code\\secret-repo"), None, Some("main")),
        ]);
        assert_eq!(anon.project(HOME_PROJECT), HOME_PROJECT);
        assert_eq!(anon.project_label(TEMP_PROJECT), TEMP_PROJECT);
        assert_eq!(anon.project("secret-owner/secret-repo"), "project-01");
        let s = anon.scrub("cloned secret-owner/secret-repo into X:\\code\\secret-repo; secret-owner wrote it");
        assert!(!s.contains("secret-owner") && !s.contains("secret-repo"), "{s}");
    }

    #[test]
    fn short_labels() {
        assert_eq!(short_project_label("/home/me/.copilot/chats/c1"), "~/.copilot/chats/c1");
        assert_eq!(short_project_label("quokka/x"), "quokka/x");
        let win = format!("C:\\{}\\someone\\proj", "Users");
        assert_eq!(short_project_label(&win), "~\\proj");
        assert_eq!(short_project_label(&win.replace("Users", "USERS")), "~\\proj");
    }

    #[test]
    fn js_case_folding() {
        // u なしの i は、非 ASCII の文字を ASCII と同じとみなさない(ſ と s、K(ケルビン)と k)
        assert_ne!(canon('ſ'), canon('s'));
        assert_ne!(canon('\u{212A}'), canon('k'));
        assert_eq!(canon('é'), canon('É'));
    }
}
