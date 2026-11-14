//! 出力先などの場所(packages/cli/src/commands.ts の resolvePaths・REPO_ROOT の移植)。

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// メモとグループの置き場の既定の名前(report の NOTES_DIR_NAME)
pub const NOTES_DIR_NAME: &str = "atlas-notes";
/// グループの定義(report の GROUPS_FILE_NAME)
pub const GROUPS_FILE_NAME: &str = "groups.json";
/// AI の変更の残存(core の VCS_RETENTION_FILE)
pub const VCS_RETENTION_FILE: &str = "vcs-retention.json";

/// リポジトリ直下(既定の out/・atlas-notes/・atlas.config.json の場所)。
/// TS 版はソースの場所から決めていた。Rust 版は実行ファイルの場所から上へたどり、atlas.bat のあるフォルダを使う
/// (target/release/atlas.exe でも、リポジトリ直下に置いた atlas.exe でも同じ場所になる)。見つからなければ実行ファイルのフォルダ。
/// 環境変数 ATLAS_REPO_ROOT があればそれを使う(テスト用)。
pub static REPO_ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    if let Some(r) = std::env::var_os("ATLAS_REPO_ROOT") {
        return PathBuf::from(r);
    }
    let exe = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    let dir = exe.as_deref().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    for a in dir.ancestors() {
        if a.join("atlas.bat").is_file() {
            return strip_verbatim(a.to_path_buf());
        }
    }
    strip_verbatim(dir)
});

/// Windows の canonicalize が付ける \\?\ を外す(ログやパスの比較が TS 版とずれないように)
pub fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

/// Node の path.resolve 相当(カレントディレクトリからの絶対パスにし、. と .. を畳む。ファイルシステムは見ない)
pub fn resolve(p: impl AsRef<Path>) -> PathBuf {
    let p = p.as_ref();
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn home_dir() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Debug, Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub out: PathBuf,
    pub snapshot: PathBuf,
    pub sessions: PathBuf,
    pub metrics: PathBuf,
    pub judgments: PathBuf,
    pub bundle: PathBuf,
    /// 依頼ごとの判定(段階 2)の結果と、判定に渡すファイル
    pub turn_judgments: PathBuf,
    pub turn_bundle: PathBuf,
    /// AI の変更がその後の VCS のファイルに残っているか(atlas vcs)
    pub vcs_retention: PathBuf,
    pub html: PathBuf,
    /// メモとグループの置き場(既定はリポジトリ直下の atlas-notes/)
    pub notes: PathBuf,
    pub groups: PathBuf,
}

pub struct PathInputs<'a> {
    pub home: Option<&'a str>,
    pub out: Option<&'a str>,
    pub judgments: Option<&'a str>,
    pub bundle: Option<&'a str>,
    pub notes_dir: Option<&'a str>,
}

pub fn resolve_paths(o: PathInputs<'_>) -> Paths {
    let home = match o.home {
        Some(h) => resolve(h),
        None => match std::env::var_os("ATLAS_COPILOT_HOME") {
            Some(h) => resolve(PathBuf::from(h)),
            None => resolve(home_dir().join(".copilot")),
        },
    };
    let out = resolve(o.out.map(PathBuf::from).unwrap_or_else(|| REPO_ROOT.join("out")));
    let notes = resolve(o.notes_dir.map(PathBuf::from).unwrap_or_else(|| REPO_ROOT.join(NOTES_DIR_NAME)));
    Paths {
        snapshot: out.join("snapshot"),
        sessions: out.join("sessions.json"),
        metrics: out.join("metrics.json"),
        judgments: o.judgments.map(resolve).unwrap_or_else(|| out.join("judgments.json")),
        bundle: o.bundle.map(resolve).unwrap_or_else(|| out.join("bundle")),
        turn_judgments: out.join("turn-judgments.json"),
        turn_bundle: out.join("turn-bundle"),
        vcs_retention: out.join(VCS_RETENTION_FILE),
        html: out.join("atlas.html"),
        groups: notes.join(GROUPS_FILE_NAME),
        home,
        out,
        notes,
    }
}
