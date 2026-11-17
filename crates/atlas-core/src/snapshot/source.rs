//! 集計の元に指したフォルダの形を調べる(snapshot.ts の describeSource・isFlatLayout などの移植。読むだけ)。

use super::par::{par_map, some_limit};
use super::{SNAPSHOT_CONCURRENCY, SNAPSHOT_SESSION_FILES, UPLOAD_INDEX, sort_utf16};
use crate::jsfs;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

/// アップロード先のフォルダが並ぶ場所かどうかを確かめるとき、索引の無いフォルダを中まで見る数の上限
pub const UPLOAD_PROBE_MAX: usize = 20;
/// 2 段下(人ごとのフォルダの下)にアップロード先のフォルダがあるかを確かめるとき、下のフォルダ 1 つにつき索引を探す数の上限
const NESTED_PROBE_MAX: usize = 50;
/// 同じく、索引の無いフォルダ(前の版が写した、手で写した)を中まで見る数の上限(下のフォルダ 1 つにつき)
const NESTED_FLAT_PROBE_MAX: usize = 3;

/// 集計の元に指したフォルダの形。
/// - copilot: ~/.copilot(session-state/ か session-store.db がある)
/// - flat: セッションのフォルダが直下に並ぶ(アップロードしたグループ・プロジェクトのフォルダ)
/// - merged: flat のフォルダが下に並ぶ。folders(src からの相対パス。/ 区切り)を 1 つのレポートにまとめて読む。
///   1 段下に並ぶもの(人ごとのフォルダなど。folders は名前だけ)と、2 段下に並ぶもの(送り先そのものなど。folders は <人>/<プロジェクト>)の両方
/// - none: どれでもない(セッションが 1 件も見つからない)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourceShape {
    Copilot,
    Flat,
    Merged { folders: Vec<String> },
    None,
}

/// 集計の元に指したフォルダの形を調べる(読むだけ)。無い・読めないフォルダは none
pub fn describe_source(src: &Path) -> SourceShape {
    if looks_like_copilot_home(src) {
        return SourceShape::Copilot;
    }
    if is_flat_layout(src) {
        return SourceShape::Flat;
    }
    // 1 段下: アップロードしたフォルダ(プロジェクトやグループ)
    let direct = all_upload_folders(src);
    let is_direct: HashSet<&str> = direct.iter().map(String::as_str).collect();
    // ~/.copilot の形のフォルダ(バックアップや、集計の出力先)は、人ごとのフォルダとしては見ない
    let candidates: Vec<String> = sub_dirs(src).into_iter().filter(|n| !is_direct.contains(n.as_str())).collect();
    let homes = par_map(&candidates, SNAPSHOT_CONCURRENCY, |n| looks_like_copilot_home_async(&src.join(n)));
    let rest: Vec<String> = candidates.iter().zip(&homes).filter(|(_, h)| !**h).map(|(n, _)| n.clone()).collect();
    // 2 段下: 直下のフォルダ(人ごとのフォルダ)の下のアップロードしたフォルダ。
    // 1 段下に 1 つも無いときは、先頭の UPLOAD_PROBE_MAX 個を軽く確かめてから読む(関係のない大きなフォルダを指したときに、2 段下まで全部読まないように)
    if direct.is_empty() && !has_nested_upload_folder(src, &rest[..rest.len().min(UPLOAD_PROBE_MAX)]) {
        return SourceShape::None;
    }
    let mut folders = direct.clone();
    // 人ごとのフォルダは並べて調べる(人が多いと、1 つずつでは往復の待ちが人数分積み重なる)
    let nested = par_map(&rest, SNAPSHOT_CONCURRENCY, |n| all_upload_folders(&src.join(n)));
    for (n, fs) in rest.iter().zip(nested) {
        folders.extend(fs.into_iter().map(|f| format!("{n}/{f}")));
    }
    sort_utf16(&mut folders);
    SourceShape::Merged { folders }
}

/// まとめて読んだフォルダ(manifest の merged.folders・merged.owners の書き方)から、人のフォルダの名前を取り出す。
/// 2 段下のフォルダ(<人>/<プロジェクト>)なら <人>。1 段下のフォルダ(名前だけ)や、フォルダが分からないときは None
pub fn person_of_folder(folder: Option<&str>) -> Option<String> {
    let f = folder?;
    match f.find('/') {
        Some(i) if i > 0 => Some(f[..i].to_string()),
        _ => None,
    }
}

/// 直下にセッションのフォルダ(workspace.yaml か events.jsonl を持つ)が並ぶ形か。~/.copilot の印(session-state/・session-store.db)があれば違う。
/// atlas のアップロード先(<基底>\<グループ>)を --home に指して集計し直すとき用
pub fn is_flat_layout(src: &Path) -> bool {
    if looks_like_copilot_home_async(src) {
        return false;
    }
    let Ok(ents) = jsfs::read_dir(src) else {
        return false;
    };
    // 並べて確かめ、見つかったところで止める(セッションが何千も並ぶフォルダでも、先頭の数件で決まる)
    let dirs: Vec<String> = ents.into_iter().filter(|e| e.is_dir()).map(|e| e.name).collect();
    some_limit(&dirs, SNAPSHOT_CONCURRENCY, |n| has_session_file_async(&src.join(n)))
}

/// ~/.copilot の印(session-state/ か session-store.db)があるか
pub(super) fn looks_like_copilot_home(src: &Path) -> bool {
    jsfs::exists(&src.join("session-state")) || jsfs::exists(&src.join("session-store.db"))
}

/// looks_like_copilot_home を fs.access で確かめるもの(TS 版の looksLikeCopilotHomeAsync。Windows では最後のリンクを辿らない)
fn looks_like_copilot_home_async(src: &Path) -> bool {
    jsfs::access_exists(&src.join("session-state")) || jsfs::access_exists(&src.join("session-store.db"))
}

/// has_session_file を fs.access で確かめるもの(TS 版の hasSessionFileAsync)
fn has_session_file_async(dir: &Path) -> bool {
    SNAPSHOT_SESSION_FILES.iter().any(|f| jsfs::access_exists(&dir.join(f)))
}

/// セッションのフォルダか(workspace.yaml か events.jsonl を持つ)
pub fn has_session_file(dir: &Path) -> bool {
    SNAPSHOT_SESSION_FILES.iter().any(|f| jsfs::exists(&dir.join(f)))
}

/// 直下のフォルダの名前(名前の順)。読めなければ空
pub(super) fn sub_dirs(src: &Path) -> Vec<String> {
    let mut v: Vec<String> = match jsfs::read_dir(src) {
        Ok(ents) => ents.into_iter().filter(|e| e.is_dir()).map(|e| e.name).collect(),
        Err(_) => return Vec::new(),
    };
    sort_utf16(&mut v);
    v
}

/// 直下のアップロードしたフォルダを全部(名前の順)。あるかどうかは、索引のあるフォルダと、索引の無いフォルダの先頭 UPLOAD_PROBE_MAX 個までで決め、
/// あると決めたら索引の無い残りも全部調べる(索引の無いフォルダを読み落とさないように)。
/// 確かめるのは並べて行い、同じフォルダを 2 度は見ない(共有フォルダでは 1 回ごとに往復の待ちがある)
fn all_upload_folders(src: &Path) -> Vec<String> {
    let names = sub_dirs(src);
    let indexed = par_map(&names, SNAPSHOT_CONCURRENCY, |n| jsfs::access_exists(&src.join(n).join(UPLOAD_INDEX)));
    let rest: Vec<String> = names.iter().zip(&indexed).filter(|(_, i)| !**i).map(|(n, _)| n.clone()).collect();
    let flat_of = |list: &[String]| par_map(list, SNAPSHOT_CONCURRENCY, |n| is_flat_layout(&src.join(n)));
    let head = rest.len().min(UPLOAD_PROBE_MAX);
    let mut flat = flat_of(&rest[..head]);
    if !indexed.iter().any(|b| *b) && !flat.iter().any(|b| *b) {
        return Vec::new();
    }
    flat.extend(flat_of(&rest[head..]));
    let is_flat: HashSet<&str> = rest.iter().zip(&flat).filter(|(_, f)| **f).map(|(n, _)| n.as_str()).collect();
    names.iter().zip(&indexed).filter(|(n, i)| **i || is_flat.contains(n.as_str())).map(|(n, _)| n.clone()).collect()
}

/// names(src の直下のフォルダ)のどれかが、アップロードしたフォルダを下に持つか。
/// 下のフォルダは名前の順で先頭の NESTED_PROBE_MAX 個までを索引(UPLOAD_INDEX)で確かめ、
/// 索引が無ければ先頭の NESTED_FLAT_PROBE_MAX 個だけ、セッションのフォルダが並ぶかを中まで見る
fn has_nested_upload_folder(src: &Path, names: &[String]) -> bool {
    for n in names {
        let mut subs = sub_dirs(&src.join(n));
        subs.truncate(NESTED_PROBE_MAX);
        if subs.iter().any(|s| jsfs::exists(&src.join(n).join(s).join(UPLOAD_INDEX))) {
            return true;
        }
        for s in subs.iter().take(NESTED_FLAT_PROBE_MAX) {
            if is_flat_layout(&src.join(n).join(s)) {
                return true;
            }
        }
    }
    false
}
