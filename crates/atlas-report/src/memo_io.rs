//! セッションごとのメモの読み書き(packages/report/src/memo-io.ts の移植)。1 セッション 1 ファイルの素の Markdown で、索引は持たない。
//! 画像は <id>/ の下に内容のハッシュの名前で置き、本文からは相対パスで参照する(他の Markdown ビューアでもそのまま読める)。

use crate::memo::{is_safe_file_name, is_safe_memo_id, MEMOS_DIR_NAME};
use crate::memo_render::render_memo_html;
use crate::viewer::{decode_uri, ext_lower};
use anyhow::{bail, Result};
use atlas_core::snapshot::{UPLOAD_MEMO_FILE, UPLOAD_MEMO_IMAGES, UPLOAD_MEMO_TEXT_LIMIT};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoFile {
    pub id: String,
    pub text: String,
    /// 本文の sha256 の先頭 16 桁(同時編集の検出に使う)
    pub rev: String,
    pub updated_at: String,
}

/// 画像 1 枚の上限(data: URI で詳細ページに埋め込むので大きくしない)
pub const MEMO_IMAGE_LIMIT: u64 = 10 * 1024 * 1024;

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        ".webp" => Some("image/webp"),
        _ => None,
    }
}

pub fn memos_dir(notes_dir: &Path) -> PathBuf {
    notes_dir.join(MEMOS_DIR_NAME)
}

pub fn memo_rev(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(crate::html::node_utf8(text).as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

fn memo_path(dir: &Path, id: &str) -> Result<PathBuf> {
    if !is_safe_memo_id(id) {
        bail!("メモに使えないセッション id です: {id}");
    }
    Ok(dir.join(format!("{id}.md")))
}

fn read_at(path: &Path, id: &str) -> Result<MemoFile> {
    let raw = String::from_utf8_lossy(&std::fs::read(path)?).into_owned();
    let text = raw.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(raw);
    let updated_at = atlas_core::jsfs::mtime_iso(&std::fs::metadata(path)?);
    Ok(MemoFile { id: id.to_string(), rev: memo_rev(&text), text, updated_at })
}

pub fn read_memo(dir: &Path, id: &str) -> Result<Option<MemoFile>> {
    let path = memo_path(dir, id)?;
    if path.exists() { Ok(Some(read_at(&path, id)?)) } else { Ok(None) }
}

/// 置き場のメモを全部読む(読めないファイルと、id に使えない名前は飛ばす)
pub fn load_memo_index(dir: &Path) -> IndexMap<String, MemoFile> {
    let mut out = IndexMap::new();
    let Ok(entries) = atlas_core::jsfs::read_dir(dir) else { return out };
    for e in entries {
        if !e.is_file() || !e.name.ends_with(".md") {
            continue;
        }
        let id = &e.name[..e.name.len() - 3];
        if !is_safe_memo_id(id) {
            continue;
        }
        // 読めないファイルがあっても他のメモと build を止めない
        if let Ok(m) = read_at(&dir.join(&e.name), id) {
            out.insert(id.to_string(), m);
        }
    }
    out
}

/// 保存の結果
#[derive(Debug, Clone, PartialEq)]
pub struct SaveResult {
    pub memo: Option<MemoFile>,
    pub conflict: Option<MemoFile>,
}

/// 保存する。空の本文はメモの削除(画像は残す)。base_rev が今の rev と違えば書かずに conflict を返す(None なら確かめない = CLI)。
/// 一時ファイルに書いてから rename する(途中で止まっても本文が欠けない)
pub fn save_memo(dir: &Path, id: &str, text: &str, base_rev: Option<&str>) -> Result<SaveResult> {
    let path = memo_path(dir, id)?;
    let cur = read_memo(dir, id)?;
    if let Some(b) = base_rev
        && b != cur.as_ref().map_or("", |c| c.rev.as_str())
    {
        let conflict = cur.clone().unwrap_or(MemoFile { id: id.to_string(), text: String::new(), rev: String::new(), updated_at: String::new() });
        return Ok(SaveResult { memo: cur, conflict: Some(conflict) });
    }
    if atlas_core::js::trim(text).is_empty() {
        atlas_core::jsfs::rm_force(&path)?;
        return Ok(SaveResult { memo: None, conflict: None });
    }
    std::fs::create_dir_all(dir)?;
    let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), random_hex()));
    crate::html::write_text(&tmp, text)?;
    if let Err(e) = atlas_core::fs_retry::rename_replacing(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(SaveResult { memo: Some(read_at(&path, id)?), conflict: None })
}

/// 一時ファイルの名前に使う乱数(TS 版は randomUUID)
fn random_hex() -> String {
    let mut h = Sha256::new();
    h.update(format!("{:?}{}", std::time::SystemTime::now(), std::process::id()).as_bytes());
    h.update(format!("{:p}", &h as *const _).as_bytes());
    hex::encode(h.finalize())[..32].to_string()
}

/// 先頭のバイトで画像の形式を判定する(Content-Type は信じない。svg は script を持てるので通さない)
pub fn image_ext(b: &[u8]) -> Option<&'static str> {
    if b.len() >= 8 && b[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(".png");
    }
    if b.len() >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff {
        return Some(".jpg");
    }
    if b.len() >= 6 && (&b[..6] == b"GIF87a" || &b[..6] == b"GIF89a") {
        return Some(".gif");
    }
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(".webp");
    }
    None
}

/// 画像を置いて、本文に挿入する Markdown を返す。同じ内容は同じ名前になる
pub fn save_memo_image(dir: &Path, id: &str, data: &[u8]) -> Result<(String, String)> {
    memo_path(dir, id)?;
    let Some(ext) = image_ext(data) else { bail!("png / jpeg / gif / webp の画像だけ追加できます") };
    let mut h = Sha256::new();
    h.update(data);
    let name = format!("{}{ext}", &hex::encode(h.finalize())[..16]);
    std::fs::create_dir_all(dir.join(id))?;
    std::fs::write(dir.join(id).join(&name), data)?;
    let markdown = format!("![画像]({id}/{name})");
    Ok((name, markdown))
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 本文の画像の参照を data: URI にする。参照は <folder>/<名前> の形だけを受け、base/<folder>/ の直下の画像だけを読む
fn image_data_uri(base: &Path, folder_name: &str, href: &str) -> Option<String> {
    let path = decode_uri(href).ok()?;
    let path = path.strip_prefix("./").unwrap_or(&path);
    let parts: Vec<&str> = path.split('/').collect();
    let (folder, name) = (parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""));
    if folder != folder_name || name.is_empty() || parts.len() > 2 || !is_safe_file_name(name) {
        return None;
    }
    let mime = image_mime(&ext_lower(name))?;
    let file = base.join(folder_name).join(name);
    if !file.exists() {
        return None;
    }
    // 手で置いた画像にも同じ上限(詳細ページに埋め込むため)
    if std::fs::metadata(&file).ok()?.len() > MEMO_IMAGE_LIMIT {
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64(&std::fs::read(&file).ok()?)))
}

pub fn render_memo(dir: &Path, id: &str, text: &str) -> String {
    render_memo_html(text, &|href| image_data_uri(dir, id, href))
}

/// 送り先から集計したときの、送った人のメモ(写したセッションのフォルダ <state_dir>/<id>/atlas-memo.md)を読む。
/// 読むだけで、書き換えない。読めないもの・id に使えない名前・空のものは飛ばす
pub fn load_member_memos<'a>(state_dir: &Path, ids: impl IntoIterator<Item = &'a str>) -> IndexMap<String, MemoFile> {
    let mut out = IndexMap::new();
    for id in ids {
        if !is_safe_memo_id(id) {
            continue;
        }
        let path = state_dir.join(id).join(UPLOAD_MEMO_FILE);
        if !path.exists() {
            continue;
        }
        // 大きすぎるもの(写すときにも外すが、前の版で写したもの)は読まない
        match std::fs::metadata(&path) {
            Ok(m) if m.len() <= UPLOAD_MEMO_TEXT_LIMIT => {}
            _ => continue,
        }
        if let Ok(m) = read_at(&path, id)
            && !atlas_core::js::trim(&m.text).is_empty()
        {
            out.insert(id.to_string(), m);
        }
    }
    out
}

/// 送った人のメモを HTML にする(画像は <state_dir>/<id>/atlas-memo/ の直下だけ)
pub fn render_member_memo(state_dir: &Path, id: &str, text: &str) -> String {
    let base = state_dir.join(id);
    render_memo_html(text, &|href| image_data_uri(&base, UPLOAD_MEMO_IMAGES, href))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: [u8; 12] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

    #[test]
    fn save_read_conflict_and_delete() {
        let d = tempfile::tempdir().unwrap();
        let m = d.path().join("memos");
        let r = save_memo(&m, "s1", "本文", None).unwrap();
        assert_eq!(r.memo.as_ref().unwrap().rev, memo_rev("本文"));
        assert_eq!(atlas_core::jsfs::read_dir_names(&m).unwrap(), ["s1.md"]);
        save_memo_image(&m, "s1", &PNG).unwrap();
        assert_eq!(save_memo(&m, "s1", "  \n", None).unwrap(), SaveResult { memo: None, conflict: None });
        assert!(read_memo(&m, "s1").unwrap().is_none());
        assert_eq!(atlas_core::jsfs::read_dir_names(&m.join("s1")).unwrap().len(), 1);
        // rev が違えば書かない
        assert_eq!(save_memo(&m, "s1", "A", Some("stale")).unwrap().conflict.unwrap().rev, "");
        let first = save_memo(&m, "s1", "A", Some("")).unwrap().memo.unwrap();
        std::fs::write(m.join("s1.md"), "別の場所で更新").unwrap();
        let r = save_memo(&m, "s1", "B", Some(&first.rev)).unwrap();
        assert_eq!(r.conflict.unwrap().rev, memo_rev("別の場所で更新"));
        assert!(save_memo(d.path(), "..", "A", None).unwrap_err().to_string().contains("使えない"));
    }

    #[test]
    fn index_skips_bad_names_and_bom() {
        let d = tempfile::tempdir().unwrap();
        let m = d.path();
        std::fs::create_dir_all(m.join("s1")).unwrap();
        std::fs::write(m.join("s1.md"), "\u{feff}A").unwrap();
        std::fs::write(m.join(".hidden.md"), "B").unwrap();
        std::fs::write(m.join("a b.md"), "C").unwrap();
        std::fs::write(m.join("x.txt"), "D").unwrap();
        let idx = load_memo_index(m);
        assert_eq!(idx.keys().collect::<Vec<_>>(), ["s1"]);
        assert_eq!(idx["s1"].rev, memo_rev("A"));
        assert!(load_memo_index(&m.join("none")).is_empty());
    }

    #[test]
    fn images_only_from_own_folder() {
        assert_eq!(image_ext(&PNG), Some(".png"));
        assert_eq!(image_ext(&[0xff, 0xd8, 0xff, 0xe0]), Some(".jpg"));
        assert_eq!(image_ext(b"GIF89a"), Some(".gif"));
        assert_eq!(image_ext(b"RIFF0000WEBPVP8 "), Some(".webp"));
        assert_eq!(image_ext(b"<svg/>"), None);
        let d = tempfile::tempdir().unwrap();
        let m = d.path().join("memos");
        let (name, md) = save_memo_image(&m, "s1", &PNG).unwrap();
        assert_eq!(md, format!("![画像](s1/{name})"));
        save_memo_image(&m, "s2", &PNG).unwrap();
        std::fs::write(d.path().join("secret.png"), PNG).unwrap();
        std::fs::write(m.join("s1").join("note.txt"), "x").unwrap();
        std::fs::write(m.join("s1").join("Pasted image 1.png"), PNG).unwrap();
        std::fs::write(m.join("s1").join("big.png"), vec![0u8; MEMO_IMAGE_LIMIT as usize + 1]).unwrap();
        assert!(render_memo(&m, "s1", &format!("![a](s1/{name})")).contains("src=\"data:image/png;base64,"));
        assert!(render_memo(&m, "s1", &format!("![a](./s1/{name})")).contains("src=\"data:image/png;base64,"));
        assert!(render_memo(&m, "s1", "![a](s1/Pasted%20image%201.png)").contains("src=\"data:image/png;base64,"));
        assert!(render_memo(&m, "s1", "![a](s1/big.png)").contains("画像を表示できません"));
        for href in [format!("s2/{name}"), "../secret.png".into(), "s1/../../secret.png".into(), "s1/..%2F..%2Fsecret.png".into(), "s1/note.txt".into(), format!("s1/x/{name}")] {
            assert!(!render_memo(&m, "s1", &format!("![a]({href})")).contains("<img"), "{href}");
        }
        assert_eq!(base64(b"hello"), "aGVsbG8=");
    }
}
