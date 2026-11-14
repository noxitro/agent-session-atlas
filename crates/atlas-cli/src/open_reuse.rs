//! 「別のフォルダを開く」(atlas open)で、前に集計したときから何も変わっていなければ、作り直さずにそのときのレポートを使う
//! (packages/cli/src/open-reuse.ts の移植)。共有フォルダから写す(snapshot)のは毎回行う。その後の extract・metrics・build は、
//! 入力が前と同じなら出力も同じなので省く。
//!   <置き場>/<キー>/built.json … 前に集計したときの入力の印(key)と、そのとき書いた出力の大きさと更新日時(outputs)
//! 入力の印に入れるもの(どれかが変われば作り直す): atlas のコードの版(code_stamp)、集計に渡したオプションと設定ファイルの中身、
//! 写した複製(<out>/snapshot/)の全ファイルの名前・大きさ・更新日時と manifest(作った日時は除く)、判定とタスクタグの大きさと更新日時。
//! 出力(atlas.html・sessions.json・metrics.json と、あれば vcs-retention.json)が built.json に書いたものと違えば作り直す。
//! TS 版と同じ built.json を読み書きする(印の作り方も同じ)。

#![allow(dead_code)] // open(段 5)が使う。今は all のテストだけ

use atlas_core::js::{self, JsMap};
use atlas_core::snapshot::{SNAPSHOT_MANIFEST, SNAPSHOT_SOURCE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const BUILT_FILE: &str = "built.json";
const VCS_RETENTION_FILE: &str = crate::paths::VCS_RETENTION_FILE;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltStamp {
    pub version: i64,
    /// 入力の印
    pub key: String,
    /// 出力のファイル(出力先からの相対パス)ごとの「大きさ:更新日時」
    pub outputs: JsMap<String>,
    pub built_at: String,
}

/// 入力の印と出力を確かめるのに使う場所
pub struct ReusePaths<'a> {
    pub out: &'a Path,
    pub snapshot: &'a Path,
    pub judgments: &'a Path,
    pub turn_judgments: &'a Path,
    pub groups: &'a Path,
}

/// 確かめる出力(出力先からの相対パス)
const OUTPUT_FILES: [&str; 3] = ["atlas.html", "sessions.json", "metrics.json"];
/// あれば確かめる出力(VCS の照合の結果)
const OPTIONAL_OUTPUT_FILES: [&str; 1] = [VCS_RETENTION_FILE];
/// 無いファイルの印
const ABSENT: &str = "none";
/// manifest の sessions のうち、元が同じでも変わる項目
const VOLATILE_SESSION_COUNTS: [&str; 4] = ["copiedFiles", "reusedFiles", "dbCopied", "dbReused"];

/// ファイルの「大きさ:更新日時」。無ければ None
fn stat_key(path: &Path) -> Option<String> {
    let m = std::fs::metadata(path).ok()?;
    if !m.is_file() {
        return None;
    }
    Some(format!("{}:{}", m.len(), js::num_to_string(atlas_core::jsfs::mtime_ms(&m))))
}

/// 出力のファイルごとの「大きさ:更新日時」。1 つでも無ければ None(使い回せない)
pub fn outputs_of(out: &Path) -> Option<JsMap<String>> {
    let mut r = JsMap::new();
    for f in OUTPUT_FILES {
        r.insert(f.to_string(), stat_key(&out.join(f))?);
    }
    for f in OPTIONAL_OUTPUT_FILES {
        r.insert(f.to_string(), stat_key(&out.join(f)).unwrap_or_else(|| ABSENT.to_string()));
    }
    Some(r)
}

/// `readdir(dir, { withFileTypes: true, recursive: true })` のファイル(Node と同じ順)
fn files_recursive(root: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut result = Vec::new();
    let mut stack = vec![(root.to_path_buf(), atlas_core::jsfs::read_dir(root)?)];
    while let Some((path, entries)) = stack.pop() {
        for d in entries {
            let p = path.join(&d.name);
            if d.is_dir() {
                let sub = atlas_core::jsfs::read_dir(&p)?;
                stack.push((p, sub));
            } else if d.is_file() {
                result.push(p);
            }
        }
    }
    Ok(result)
}

/// 入力の印。options は集計に渡したオプション(JSON にできる値)、config_path は読む設定ファイル(無ければ中身は空として数える)
pub fn inputs_key(p: &ReusePaths<'_>, options: &Value, config_path: &Path, code: &str) -> std::io::Result<String> {
    let mut h = Sha256::new();
    let mut add = |label: &str, value: &str| {
        h.update(label.as_bytes());
        h.update(b"\0");
        h.update(atlas_report::html::node_utf8(value).as_bytes());
        h.update(b"\0");
    };
    add("code", code);
    add("options", &atlas_core::json::to_js_string(options).unwrap_or_default());
    let config = std::fs::read(config_path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    add("config", &config);
    // manifest は、元が同じでも集計のたびに変わる項目(作った日時と、今回写した数・前の複製を使った数)を除いた中身を入れる
    let manifest = (|| -> Option<String> {
        let text = std::fs::read(p.snapshot.join(SNAPSHOT_MANIFEST)).ok()?;
        let mut m = js::parse_json(&String::from_utf8_lossy(&text)).ok()?;
        if let Value::Object(o) = &mut m {
            o.shift_remove("createdAt");
            if let Some(Value::Object(s)) = o.get_mut("sessions") {
                for k in VOLATILE_SESSION_COUNTS {
                    s.shift_remove(k);
                }
            }
            // フォルダごとの最後に送った日時は、日付までにして入れる
            if let Some(Value::Object(u)) = o.get_mut("uploads") {
                for v in u.values_mut() {
                    if let Some(Value::String(at)) = v.get_mut("uploadedAt") {
                        *at = js::utf16_slice(at, 0, 10).into_owned();
                    }
                }
            }
        }
        atlas_core::json::to_js_string(&m).ok()
    })()
    .unwrap_or_default();
    add("manifest", &manifest);
    let mut files: Vec<String> = Vec::new();
    for path in files_recursive(p.snapshot)? {
        let rel = path.strip_prefix(p.snapshot).unwrap_or(&path).components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
        if rel == SNAPSHOT_MANIFEST || rel == SNAPSHOT_SOURCE {
            continue;
        }
        files.push(format!("{rel}\0{}", stat_key(&path).unwrap_or_default()));
    }
    files.sort_by(|a, b| js::cmp_utf16(a, b));
    add("snapshot", &files.join("\n"));
    for (label, path) in [("judgments", p.judgments), ("turn-judgments", p.turn_judgments), ("groups", p.groups)] {
        add(label, &stat_key(path).unwrap_or_default());
    }
    Ok(hex::encode(h.finalize()))
}

pub fn read_built(file: &Path) -> Option<BuiltStamp> {
    let text = std::fs::read(file).ok()?;
    let j = js::parse_json(&String::from_utf8_lossy(&text)).ok()?;
    if j.get("version").and_then(Value::as_f64) != Some(1.0) || !j.get("key").is_some_and(Value::is_string) || !j.get("outputs").is_some_and(Value::is_object) || !j.get("builtAt").is_some_and(Value::is_string) {
        return None;
    }
    let outputs: JsMap<String> = JsMap(j["outputs"].as_object()?.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect());
    Some(BuiltStamp { version: 1, key: j["key"].as_str()?.to_string(), outputs, built_at: j["builtAt"].as_str()?.to_string() })
}

/// 前に集計したときのレポートを使い回せるか(入力の印が同じで、出力がそのときのまま)
pub fn can_reuse(prev: Option<&BuiltStamp>, key: &str, out: &Path) -> bool {
    let Some(prev) = prev.filter(|p| p.key == key) else { return false };
    let Some(now) = outputs_of(out) else { return false };
    OUTPUT_FILES.iter().chain(OPTIONAL_OUTPUT_FILES.iter()).all(|f| prev.outputs.get(*f) == now.get(*f))
}

/// 作り直す前に、前の印を消す
pub fn clear_built(file: &Path) -> std::io::Result<()> {
    atlas_core::jsfs::rm_force(file)
}

/// 集計が最後まで済んだら、入力の印と出力を書く。出力が揃っていなければ書かない
pub fn write_built(file: &Path, key: &str, out: &Path) -> std::io::Result<()> {
    let Some(outputs) = outputs_of(out) else { return Ok(()) };
    let s = BuiltStamp { version: 1, key: key.to_string(), outputs, built_at: atlas_core::jsdate::now_iso() };
    std::fs::write(file, format!("{}\n", atlas_core::json::to_js_string_pretty(&s).map_err(std::io::Error::other)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuse_round_trip() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out");
        let snap = out.join("snapshot");
        std::fs::create_dir_all(snap.join("session-state").join("a")).unwrap();
        std::fs::write(snap.join("session-state").join("a").join("events.jsonl"), "{}\n").unwrap();
        std::fs::write(snap.join(SNAPSHOT_MANIFEST), r#"{"createdAt":"x","sessions":{"dirs":1,"copiedFiles":3},"uploads":{"p":{"uploadedAt":"2026-01-02T03:04:05Z"}}}"#).unwrap();
        for f in OUTPUT_FILES {
            std::fs::write(out.join(f), "x").unwrap();
        }
        let none = d.path().join("none");
        let rp = ReusePaths { out: &out, snapshot: &snap, judgments: &none, turn_judgments: &none, groups: &none };
        let opts = serde_json::json!({ "since": null, "anonymize": false });
        let key = inputs_key(&rp, &opts, &none, "code1").unwrap();
        assert_eq!(key, inputs_key(&rp, &opts, &none, "code1").unwrap());
        assert_ne!(key, inputs_key(&rp, &opts, &none, "code2").unwrap());
        // manifest の作った日時と写した数は印に入れない
        std::fs::write(snap.join(SNAPSHOT_MANIFEST), r#"{"createdAt":"y","sessions":{"dirs":1,"copiedFiles":9},"uploads":{"p":{"uploadedAt":"2026-01-02T09:00:00Z"}}}"#).unwrap();
        assert_eq!(key, inputs_key(&rp, &opts, &none, "code1").unwrap());
        let built = d.path().join(BUILT_FILE);
        write_built(&built, &key, &out).unwrap();
        let prev = read_built(&built).unwrap();
        assert!(can_reuse(Some(&prev), &key, &out));
        assert!(!can_reuse(Some(&prev), "other", &out));
        std::fs::write(out.join("atlas.html"), "changed").unwrap();
        assert!(!can_reuse(Some(&prev), &key, &out));
        clear_built(&built).unwrap();
        assert!(read_built(&built).is_none());
    }
}
