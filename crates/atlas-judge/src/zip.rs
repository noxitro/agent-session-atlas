//! 評価バンドルを 1 つの ZIP にまとめる(atlas bundle --zip)。
//! フォルダやファイルを読めるエージェント(GitHub Copilot CLI、ローカルの LLM など)に 1 ファイルで渡すためのもの。
//! 圧縮はしない(無圧縮の ZIP は CRC-32 だけで書けるので、依存を増やさない)。ZIP64 は書かないので、
//! ファイルが 65,535 個、全体が 4 GB を超えるときは作らずに止める。
//! 入れるのは INSTRUCTIONS.md・manifest.json・schema.json・sessions/ だけ(parts/ は sessions/ と同じ中身なので入れない)。

use crate::bundle::BundleManifest;
use anyhow::{bail, Context, Result};
use std::io::{BufWriter, Write};
use std::path::Path;

const CRC_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
};

pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for b in data {
        c = CRC_TABLE[((c ^ *b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

/// ZIP に書く更新日時(MS-DOS の形式)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DosTime {
    pub date: u16,
    pub time: u16,
}

impl DosTime {
    pub fn now() -> Self {
        use chrono::{Datelike, Timelike};
        let n = chrono::Local::now();
        let year = (n.year().clamp(1980, 2107) - 1980) as u16;
        DosTime { date: (year << 9) | ((n.month() as u16) << 5) | n.day() as u16, time: ((n.hour() as u16) << 11) | ((n.minute() as u16) << 5) | (n.second() as u16 / 2) }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ZipSummary {
    pub files: usize,
    pub bytes: u64,
}

struct Central {
    name: String,
    crc: u32,
    size: u32,
    offset: u32,
}

/// bundle_dir の中身を zip_path に書く。ZIP の中では root フォルダの下に置く(展開するとフォルダが 1 つできる)。
/// 作りかけは別の名前に書いてから入れ替えるので、途中で失敗しても前の ZIP は残る
pub fn write_bundle_zip(bundle_dir: &Path, manifest: &BundleManifest, zip_path: &Path, root: &str, stamp: DosTime) -> Result<ZipSummary> {
    let mut names: Vec<String> = vec![manifest.files.instructions.clone(), "manifest.json".into(), manifest.files.schema.clone()];
    names.extend(manifest.sessions.iter().map(|e| e.path.clone()));
    if names.len() > u16::MAX as usize {
        bail!("ZIP に入れるファイルが多すぎます({} 個。上限 65,535 個)。--since や --unjudged で対象を絞ってください", names.len());
    }

    let tmp = zip_path.with_extension("zip.tmp");
    let written = (|| -> Result<u64> {
        let mut w = BufWriter::new(std::fs::File::create(&tmp).with_context(|| format!("{} を作れません", tmp.display()))?);
        let mut offset: u64 = 0;
        let mut central: Vec<Central> = Vec::with_capacity(names.len());
        for rel in &names {
            let data = std::fs::read(bundle_dir.join(rel)).with_context(|| format!("{} を読めません", bundle_dir.join(rel).display()))?;
            let name = format!("{root}/{rel}");
            let next = offset + 30 + name.len() as u64 + data.len() as u64;
            if next > u32::MAX as u64 {
                bail!("ZIP が 4 GB を超えます。--since や --unjudged で対象を絞ってください");
            }
            let crc = crc32(&data);
            w.write_all(&0x0403_4b50u32.to_le_bytes())?;
            write_common(&mut w, stamp, crc, data.len() as u32, name.len() as u16)?;
            w.write_all(&0u16.to_le_bytes())?; // 拡張フィールドの長さ
            w.write_all(name.as_bytes())?;
            w.write_all(&data)?;
            central.push(Central { name, crc, size: data.len() as u32, offset: offset as u32 });
            offset = next;
        }
        let cd_start = offset;
        for c in &central {
            w.write_all(&0x0201_4b50u32.to_le_bytes())?;
            w.write_all(&20u16.to_le_bytes())?; // 作成したバージョン
            write_common(&mut w, stamp, c.crc, c.size, c.name.len() as u16)?;
            // 拡張フィールド・コメントの長さ、ディスク番号、内部属性(各 2 バイト)と外部属性(4 バイト)
            w.write_all(&[0u8; 12])?;
            w.write_all(&c.offset.to_le_bytes())?;
            w.write_all(c.name.as_bytes())?;
            offset += 46 + c.name.len() as u64;
        }
        if offset > u32::MAX as u64 {
            bail!("ZIP が 4 GB を超えます。--since や --unjudged で対象を絞ってください");
        }
        w.write_all(&0x0605_4b50u32.to_le_bytes())?;
        w.write_all(&[0u8; 4])?; // ディスク番号
        w.write_all(&(central.len() as u16).to_le_bytes())?;
        w.write_all(&(central.len() as u16).to_le_bytes())?;
        w.write_all(&((offset - cd_start) as u32).to_le_bytes())?;
        w.write_all(&(cd_start as u32).to_le_bytes())?;
        w.write_all(&0u16.to_le_bytes())?; // コメントの長さ
        w.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        Ok(offset + 22)
    })();
    match written {
        Ok(bytes) => {
            std::fs::rename(&tmp, zip_path).with_context(|| format!("{} に書けません", zip_path.display()))?;
            Ok(ZipSummary { files: names.len(), bytes })
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// ローカルヘッダと中央ディレクトリで同じ並びの部分(展開に要るバージョン 〜 拡張フィールドの長さの手前)。
/// ファイル名は UTF-8(汎用フラグの bit 11)
fn write_common(w: &mut impl Write, stamp: DosTime, crc: u32, size: u32, name_len: u16) -> Result<()> {
    w.write_all(&20u16.to_le_bytes())?;
    w.write_all(&0x0800u16.to_le_bytes())?;
    w.write_all(&0u16.to_le_bytes())?; // 無圧縮
    w.write_all(&stamp.time.to_le_bytes())?;
    w.write_all(&stamp.date.to_le_bytes())?;
    w.write_all(&crc.to_le_bytes())?;
    w.write_all(&size.to_le_bytes())?;
    w.write_all(&size.to_le_bytes())?;
    w.write_all(&name_len.to_le_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::BundleEntry;
    use crate::packet::TextSource;

    fn u16_at(b: &[u8], i: usize) -> usize {
        u16::from_le_bytes([b[i], b[i + 1]]) as usize
    }
    fn u32_at(b: &[u8], i: usize) -> usize {
        u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize
    }

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn writes_a_stored_zip_without_parts() {
        let d = tempfile::tempdir().unwrap();
        let b = d.path().join("bundle");
        std::fs::create_dir_all(b.join("sessions")).unwrap();
        std::fs::create_dir_all(b.join("parts")).unwrap();
        std::fs::write(b.join("INSTRUCTIONS.md"), "指示").unwrap();
        std::fs::write(b.join("manifest.json"), "{}").unwrap();
        std::fs::write(b.join("schema.json"), "{\"a\":1}").unwrap();
        std::fs::write(b.join("sessions/s1.md"), "123456789").unwrap();
        std::fs::write(b.join("parts/part-01.md"), "入れない").unwrap();
        let entry = BundleEntry { id: "s1".into(), path: "sessions/s1.md".into(), project: "p".into(), client: None, created_at: None, updated_at: None, turns: 1, chars: 9, bytes: 9, text_source: TextSource::Excerpt, truncated: 0 };
        let m = BundleManifest { sessions: vec![entry], ..Default::default() };
        let zip = d.path().join("bundle.zip");
        std::fs::write(&zip, "前の ZIP").unwrap();
        let s = write_bundle_zip(&b, &m, &zip, "bundle", DosTime { date: 0x5b6f, time: 0x6000 }).unwrap();
        let bytes = std::fs::read(&zip).unwrap();
        assert_eq!(s, ZipSummary { files: 4, bytes: bytes.len() as u64 });
        assert!(!d.path().join("bundle.zip.tmp").exists());

        // 末尾のレコードから中央ディレクトリをたどり、名前・CRC・中身を確かめる
        let end = bytes.len() - 22;
        assert_eq!(u32_at(&bytes, end), 0x0605_4b50);
        assert_eq!(u16_at(&bytes, end + 10), 4);
        let mut at = u32_at(&bytes, end + 16);
        assert_eq!(at + u32_at(&bytes, end + 12), end);
        let mut seen: Vec<(String, Vec<u8>)> = Vec::new();
        for _ in 0..4 {
            assert_eq!(u32_at(&bytes, at), 0x0201_4b50);
            assert_eq!(u16_at(&bytes, at + 10), 0, "無圧縮");
            let (crc, size, name_len, local) = (u32_at(&bytes, at + 16), u32_at(&bytes, at + 24), u16_at(&bytes, at + 28), u32_at(&bytes, at + 42));
            let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
            assert_eq!(u32_at(&bytes, local), 0x0403_4b50);
            assert_eq!(&bytes[local + 30..local + 30 + name_len], name.as_bytes());
            let data = bytes[local + 30 + name_len..local + 30 + name_len + size].to_vec();
            assert_eq!(crc32(&data) as usize, crc);
            seen.push((name, data));
            at += 46 + name_len;
        }
        assert_eq!(at, end);
        let names: Vec<&str> = seen.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["bundle/INSTRUCTIONS.md", "bundle/manifest.json", "bundle/schema.json", "bundle/sessions/s1.md"]);
        assert_eq!(seen[0].1, "指示".as_bytes());
        assert_eq!(seen[3].1, b"123456789");
    }

    #[test]
    fn keeps_the_previous_zip_when_a_file_is_missing() {
        let d = tempfile::tempdir().unwrap();
        let b = d.path().join("bundle");
        std::fs::create_dir_all(&b).unwrap();
        let zip = d.path().join("bundle.zip");
        std::fs::write(&zip, "前の ZIP").unwrap();
        let e = write_bundle_zip(&b, &BundleManifest::default(), &zip, "bundle", DosTime::now()).unwrap_err();
        assert!(format!("{e:#}").contains("INSTRUCTIONS.md"), "{e:#}");
        assert_eq!(std::fs::read_to_string(&zip).unwrap(), "前の ZIP");
        assert!(!d.path().join("bundle.zip.tmp").exists());
    }
}
