//! プロジェクトの統合(packages/core/src/project.ts と project-keys.ts の移植)。
//! repository の記録が無いセッションを、git の origin・ホーム・一時フォルダで束ねる。
//! git は .git/config(worktree は .git ファイル → gitdir → commondir)を読むだけで、git コマンドは使わない。

use crate::js;
use crate::nodepath::platform;
use crate::normalize::project_key;
use crate::turns::js_re;
use crate::types::ProjectSource;
use regex::Regex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

// ---------- project-keys.ts ----------

pub const HOME_PROJECT: &str = "(ホーム)";
pub const TEMP_PROJECT: &str = "(一時フォルダ)";
pub const ATLAS_JUDGE_PROJECT: &str = "(atlas の判定)";
pub const GROUPED_PROJECTS: [&str; 3] = [HOME_PROJECT, TEMP_PROJECT, ATLAS_JUDGE_PROJECT];

/// このツールの判定(judge)が copilot を起動する作業フォルダ
static ATLAS_JUDGE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\\/])atlas-judge-cwd-[^\\/]+[\\/]*$").unwrap());
/// ホームディレクトリそのもの
static HOME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:[A-Za-z]:[\\/]Users[\\/][^\\/]+|/home/[^/]+|/Users/[^/]+)[\\/]*$").unwrap());
/// 一時フォルダ
static TEMP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?i){}", js_re(r"^(?:[A-Za-z]:[\\/].*?[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)|\/tmp(?:\/|$)|\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$))"))).unwrap());

#[derive(Debug, Clone, Default)]
pub struct ProjectResolverOptions {
    /// ホームディレクトリ(既定: os.homedir())
    pub homes: Option<Vec<String>>,
    /// 一時フォルダ(既定: os.tmpdir())
    pub temps: Option<Vec<String>>,
    /// 一時フォルダの既定のパターンも使うか(既定 true)
    pub temp_patterns: Option<bool>,
    /// .git/config を読むか(既定 true)
    pub read_git: Option<bool>,
}

/// Node の os.homedir()
pub fn os_homedir() -> String {
    let v = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    if v.is_empty() { crate::nodepath::process_cwd() } else { v }
}

/// Node の os.tmpdir()
pub fn os_tmpdir() -> String {
    let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    if cfg!(windows) {
        let p = get("TEMP").or_else(|| get("TMP")).unwrap_or_else(|| format!("{}\\temp", get("SystemRoot").or_else(|| get("windir")).unwrap_or_else(|| "undefined".into())));
        if p.len() > 1 && p.ends_with('\\') && !p.ends_with(":\\") {
            return p[..p.len() - 1].to_string();
        }
        p
    } else {
        let p = get("TMPDIR").or_else(|| get("TMP")).or_else(|| get("TEMP")).unwrap_or_else(|| "/tmp".into());
        if p.len() > 1 && p.ends_with('/') {
            return p[..p.len() - 1].to_string();
        }
        p
    }
}

/// 比較用にパスをそろえる(区切りを /、末尾の区切りを落とし、Windows のパスは小文字)
fn norm(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    let b = s.as_bytes();
    if (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || p.contains('\\') { js::to_lower(s) } else { s.to_string() }
}

fn under(p: &str, root: &str) -> bool {
    let a = norm(p);
    let r = norm(root);
    !r.is_empty() && (a == r || a.starts_with(&format!("{r}/")))
}

static SCP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r"^[\w.-]+@[\w.-]+:(.+)$")).unwrap());
static URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?i){}", js_re(r"^(?:https?|ssh|git):\/\/[^/]+\/(.+)$"))).unwrap());
static DOT_GIT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.git/?$").unwrap());

/// git の remote URL から owner/repo を得る。ローカルのパスは None
pub fn owner_repo_from_url(url: &str) -> Option<String> {
    let u = js::trim(url);
    let path = match SCP_RE.captures(u) {
        // (?!\/\/) の代わり
        Some(c) if !c[1].starts_with("//") => Some(c[1].to_string()),
        Some(_) => None,
        None => URL_RE.captures(u).map(|m| m[1].to_string()),
    }?;
    let p = DOT_GIT_RE.replace(&path, "");
    let p = p.trim_end_matches('/');
    let parts: Vec<&str> = p.split('/').filter(|x| !x.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    Some(format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]))
}

static SEC_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r#"^\[\s*([^\s\]]+)(?:\s+"([^"]*)")?\s*\]$"#)).unwrap());
static KV_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?i){}", js_re(r"^url\s*=\s*(.+)$"))).unwrap());
static QUOTED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&js_re(r#"^"(.*)"$"#)).unwrap());

/// .git/config の本文から [remote "origin"] の url を取り出す
pub fn origin_url_from_config(config: &str) -> Option<String> {
    let mut in_origin = false;
    for raw in config.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = js::trim(raw);
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(sec) = SEC_RE.captures(line) {
            in_origin = js::to_lower(&sec[1]) == "remote" && sec.get(2).map(|m| m.as_str()) == Some("origin");
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some(kv) = KV_RE.captures(line) {
            let v = js::trim(&kv[1]);
            return Some(QUOTED_RE.replace(v, "$1").into_owned());
        }
    }
    None
}

static GITDIR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?m){}", js_re(r"^gitdir:\s*(.+?)\s*$"))).unwrap());

/// 作業フォルダ(git の作業ツリーの根)から、共有の config ファイルの場所を得る
pub fn git_config_path(work_tree: &str) -> std::io::Result<Option<String>> {
    let dot_git = platform::join(&[work_tree, ".git"]);
    if !Path::new(&dot_git).exists() {
        return Ok(None);
    }
    let st = std::fs::metadata(&dot_git)?;
    if st.is_dir() {
        return Ok(Some(platform::join(&[&dot_git, "config"])));
    }
    let text = String::from_utf8_lossy(&std::fs::read(&dot_git)?).into_owned();
    let Some(m) = GITDIR_RE.captures(&text) else { return Ok(None) };
    let gitdir = platform::resolve(&[work_tree, &m[1]]);
    let commondir_file = platform::join(&[&gitdir, "commondir"]);
    let common = if Path::new(&commondir_file).exists() {
        let c = String::from_utf8_lossy(&std::fs::read(&commondir_file)?).into_owned();
        platform::resolve(&[&gitdir, js::trim(&c)])
    } else {
        gitdir
    };
    Ok(Some(platform::join(&[&common, "config"])))
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedProject {
    pub project: String,
    pub source: ProjectSource,
}

/// プロジェクトを決めるのに使う、セッションの項目
pub struct ProjectInput<'a> {
    pub repository: Option<&'a str>,
    pub git_root: Option<&'a str>,
    pub cwd: Option<&'a str>,
}

/// セッションのプロジェクトキーを決める(優先順は project.ts の ProjectResolver の説明のとおり)
pub struct ProjectResolver {
    homes: Vec<String>,
    temps: Vec<String>,
    temp_patterns: bool,
    read_git: bool,
    cache: HashMap<String, Option<String>>,
    pub warnings: Vec<String>,
}

impl ProjectResolver {
    pub fn new(opts: ProjectResolverOptions) -> Self {
        ProjectResolver {
            homes: opts.homes.unwrap_or_else(|| vec![os_homedir()]).into_iter().filter(|s| !s.is_empty()).collect(),
            temps: opts.temps.unwrap_or_else(|| vec![os_tmpdir()]).into_iter().filter(|s| !s.is_empty()).collect(),
            temp_patterns: opts.temp_patterns.unwrap_or(true),
            read_git: opts.read_git.unwrap_or(true),
            cache: HashMap::new(),
            warnings: Vec::new(),
        }
    }

    pub fn is_atlas_judge(&self, cwd: Option<&str>) -> bool {
        cwd.is_some_and(|c| !c.is_empty() && ATLAS_JUDGE_RE.is_match(c))
    }

    pub fn is_temp(&self, p: Option<&str>) -> bool {
        match p {
            Some(p) if !p.is_empty() => (self.temp_patterns && TEMP_RE.is_match(p)) || self.temps.iter().any(|t| under(p, t)),
            _ => false,
        }
    }

    pub fn is_home(&self, p: Option<&str>) -> bool {
        match p {
            Some(p) if !p.is_empty() => HOME_RE.is_match(p) || self.homes.iter().any(|h| norm(p) == norm(h)),
            _ => false,
        }
    }

    /// 作業ツリーの根から origin の owner/repo(読めなければ None。結果は根ごとにキャッシュ)
    pub fn remote_of(&mut self, work_tree: &str) -> Option<String> {
        let key = norm(work_tree);
        if let Some(v) = self.cache.get(&key) {
            return v.clone();
        }
        let read = || -> std::io::Result<Option<String>> {
            if let Some(cfg) = git_config_path(work_tree)? {
                if Path::new(&cfg).exists() {
                    let text = String::from_utf8_lossy(&std::fs::read(&cfg)?).into_owned();
                    return Ok(origin_url_from_config(&text).and_then(|u| owner_repo_from_url(&u)));
                }
            }
            Ok(None)
        };
        let out = match read() {
            Ok(v) => v,
            Err(e) => {
                self.warnings.push(format!("{work_tree}: git の設定を読めない ({e})"));
                None
            }
        };
        self.cache.insert(key, out.clone());
        out
    }

    /// cwd から上へ .git を探す(ホーム・一時フォルダ・ドライブの根には上らない)
    fn find_work_tree(&self, cwd: &str) -> Option<String> {
        let mut dir = cwd.to_string();
        for _ in 0..64 {
            if self.is_home(Some(&dir)) || self.is_temp(Some(&dir)) {
                return None;
            }
            if Path::new(&platform::join(&[&dir, ".git"])).exists() {
                return Some(dir);
            }
            let up = platform::dirname(&dir);
            if up == dir {
                return None;
            }
            dir = up;
        }
        None
    }

    pub fn resolve(&mut self, s: ProjectInput<'_>) -> ResolvedProject {
        fn nonempty(x: Option<&str>) -> Option<&str> {
            x.filter(|v| !v.is_empty())
        }
        if self.is_atlas_judge(s.cwd) {
            return ResolvedProject { project: ATLAS_JUDGE_PROJECT.into(), source: ProjectSource::AtlasJudge };
        }
        if let Some(r) = nonempty(s.repository) {
            return ResolvedProject { project: r.into(), source: ProjectSource::Repository };
        }
        if self.is_temp(s.cwd) || self.is_temp(s.git_root) {
            return ResolvedProject { project: TEMP_PROJECT.into(), source: ProjectSource::Temp };
        }
        if self.read_git {
            let root = match (nonempty(s.git_root), nonempty(s.cwd)) {
                (Some(g), _) if platform::is_absolute(g) => Some(g.to_string()),
                (_, Some(c)) if platform::is_absolute(c) => self.find_work_tree(c),
                _ => None,
            };
            if let Some(repo) = root.and_then(|r| self.remote_of(&r)) {
                return ResolvedProject { project: repo, source: ProjectSource::GitRemote };
            }
        }
        if self.is_home(s.cwd) && (nonempty(s.git_root).is_none() || self.is_home(s.git_root)) {
            return ResolvedProject { project: HOME_PROJECT.into(), source: ProjectSource::Home };
        }
        if s.git_root.or(s.cwd).is_none_or(str::is_empty) {
            return ResolvedProject { project: project_key(None, None, None), source: ProjectSource::Unknown };
        }
        ResolvedProject { project: project_key(None, s.git_root, s.cwd), source: ProjectSource::Path }
    }
}

#[cfg(test)]
mod tests {
    /// Windows のホームの親フォルダの名前(パスの形をソースに直書きしない)
    const USERS: &str = "Users";
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(owner_repo_from_url("https://github.com/o/r.git").as_deref(), Some("o/r"));
        assert_eq!(owner_repo_from_url("git@github.com:o/r.git").as_deref(), Some("o/r"));
        assert_eq!(owner_repo_from_url("ssh://git@host:22/a/b/c.git/").as_deref(), Some("b/c"));
        assert_eq!(owner_repo_from_url("C:\\repos\\x"), None);
        assert_eq!(owner_repo_from_url("../x"), None);
        assert_eq!(owner_repo_from_url("file:///x/y"), None);
    }

    #[test]
    fn config() {
        let cfg = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://h/u/x\n[remote \"origin\"]\r\n\turl = \"git@h:o/r.git\"\n";
        assert_eq!(origin_url_from_config(cfg).as_deref(), Some("git@h:o/r.git"));
    }

    #[test]
    fn grouping() {
        let mut r = ProjectResolver::new(ProjectResolverOptions { homes: Some(vec!["D:\\me".into()]), temps: Some(vec![]), temp_patterns: Some(true), read_git: Some(false) });
        let p = |r: &mut ProjectResolver, repo: Option<&str>, git: Option<&str>, cwd: Option<&str>| r.resolve(ProjectInput { repository: repo, git_root: git, cwd });
        assert_eq!(p(&mut r, None, None, Some(&format!("C:\\{}\\x\\AppData\\Local\\Temp\\atlas-judge-cwd-abc", USERS))).source, ProjectSource::AtlasJudge);
        assert_eq!(p(&mut r, Some("o/r"), None, Some("C:\\a")).project, "o/r");
        assert_eq!(p(&mut r, None, None, Some(&format!("C:\\{}\\x\\AppData\\Local\\Temp\\w", USERS))).project, TEMP_PROJECT);
        assert_eq!(p(&mut r, None, None, Some("/tmp/x")).project, TEMP_PROJECT);
        assert_eq!(p(&mut r, None, None, Some(&format!("C:\\{}\\x", USERS))).project, HOME_PROJECT);
        assert_eq!(p(&mut r, None, None, Some("d:\\me\\")).project, HOME_PROJECT);
        assert_eq!(p(&mut r, None, Some("c:/repo/"), Some("C:\\repo\\sub")).project, "C:\\repo");
        assert_eq!(p(&mut r, None, None, Some("/home/u/repo")).project, "\\home\\u\\repo");
        assert_eq!(p(&mut r, None, None, None).source, ProjectSource::Unknown);
    }

    #[test]
    fn git_remote_from_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join(".git").join("config"), "[remote \"origin\"]\n  url = https://github.com/o/r.git\n").unwrap();
        // worktree: .git ファイル → gitdir → commondir
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        let gd = root.join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(&gd).unwrap();
        std::fs::write(gd.join("commondir"), "../..\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gd.display())).unwrap();
        let mut r = ProjectResolver::new(ProjectResolverOptions { homes: Some(vec![]), temps: Some(vec![]), temp_patterns: Some(false), read_git: None });
        let sub = root.join("sub").to_string_lossy().into_owned();
        let got = r.resolve(ProjectInput { repository: None, git_root: None, cwd: Some(&sub) });
        assert_eq!(got, ResolvedProject { project: "o/r".into(), source: ProjectSource::GitRemote });
        let w = wt.to_string_lossy().into_owned();
        let got = r.resolve(ProjectInput { repository: None, git_root: Some(&w), cwd: None });
        assert_eq!(got.project, "o/r");
    }
}
