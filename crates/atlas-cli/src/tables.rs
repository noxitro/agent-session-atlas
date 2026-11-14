//! 表計算ソフトで開く表(依頼ごとの turns.csv・セッションごとの sessions.csv・VCS の照合のまとまりごとの vcs-hunks.csv)と、
//! 同じ中身の SQLite(atlas.sqlite)を作る(packages/cli/src/tables.ts の移植)。
//! out/tables/(metrics・build・export)とグループの書き出し(out/groups/<名前>/)が同じものを使う。

use anyhow::Result;
use atlas_core::fs_retry::rename_replacing;
use atlas_core::jsfs::rm_force;
use atlas_core::sqlite::open_writable;
use atlas_core::tables::{retention_hunks_table, sessions_table, to_csv, turns_table, Cell, Table};
use atlas_core::types::SessionRecord;
use atlas_core::vcs_retention::SessionRetention;
use atlas_core::vcs_step::read_vcs_retention;
use atlas_judge::judgments_io::read_judgments;
use atlas_report::verdicts::parse_verdicts;
use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// 表と同じ中身の SQLite(out/tables/ とグループの書き出しの中)
pub const SQLITE_FILE: &str = "atlas.sqlite";

pub struct TablePaths<'a> {
    /// 工数の判定(judgments.json)
    pub judgments: &'a Path,
    /// 依頼ごとの判定(turn-judgments.json)
    pub turn_judgments: &'a Path,
    /// AI の変更がその後の VCS のファイルに残っているか(vcs-retention.json)。無ければ照合の列を付けない
    pub vcs_retention: Option<&'a Path>,
}

pub struct Tables {
    pub turns: String,
    pub sessions: String,
    /// VCS の照合のまとまりごとの表(照合の結果が無ければ None)
    pub vcs_hunks: Option<String>,
    /// SQLite に入れる表(名前 → 中身。入れる順)
    pub data: Vec<(String, Table)>,
    /// turns.csv に依頼ごとの判定の列が入ったか
    pub with_verdicts: bool,
    /// sessions.csv に VCS の照合の列が入ったか
    pub with_retention: bool,
    /// 判定のファイルを読めなかったとき(表は判定の列なしで作る)
    pub warnings: Vec<String>,
}

pub fn build_tables(sessions: &[&SessionRecord], p: &TablePaths<'_>) -> Tables {
    let mut warnings: Vec<String> = Vec::new();
    let j = match read_judgments(p.judgments) {
        Ok(j) => j,
        Err(e) => {
            warnings.push(format!("{} を読めないため、推定人手工数の列は空にします({e})", p.judgments.display()));
            None
        }
    };
    let mut verdicts = None;
    if p.turn_judgments.exists() {
        let raw = std::fs::read(p.turn_judgments).map_err(|e| e.to_string()).and_then(|b| atlas_core::js::parse_json(&String::from_utf8_lossy(&b)).map_err(|e| e.to_string()));
        match raw {
            Ok(raw) => verdicts = parse_verdicts(&raw),
            Err(e) => warnings.push(format!("{} を読めないため、依頼ごとの判定の列は付けません({e})", p.turn_judgments.display())),
        }
    }
    let mut retention = None;
    if let Some(vr) = p.vcs_retention.filter(|x| x.exists()) {
        retention = read_vcs_retention(vr);
        if retention.is_none() {
            warnings.push(format!("{} を読めないため、VCS の照合の列は付けません(atlas vcs で作り直せます)", vr.display()));
        }
    }
    // 表に載せるセッションの照合の結果だけを使う(絞り込みに合わせる)
    let ids: HashSet<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
    let by_id: Option<IndexMap<String, &SessionRetention>> =
        retention.as_ref().map(|r| r.sessions.iter().filter(|x| ids.contains(x.session_id.as_str())).map(|x| (x.session_id.clone(), x)).collect());
    let labels = retention.as_ref().and_then(|r| r.labels.as_ref());
    let turns = turns_table(sessions, verdicts.as_ref().map(|v| &v.by_session));
    let human_hours: HashMap<String, f64> = j.iter().flat_map(|j| j.items.iter().map(|i| (i.session_id.clone(), i.human_effort.hours))).collect();
    let by_id_map: Option<HashMap<String, &SessionRetention>> = by_id.as_ref().map(|m| m.iter().map(|(k, v)| (k.clone(), *v)).collect());
    let sess = sessions_table(sessions, &human_hours, by_id_map.as_ref(), labels);
    let hunks = by_id.as_ref().map(|m| retention_hunks_table(&m.values().copied().collect::<Vec<_>>(), labels));
    let mut data = vec![("turns".to_string(), turns.clone()), ("sessions".to_string(), sess.clone())];
    if let Some(h) = &hunks {
        data.push(("vcs_hunks".to_string(), h.clone()));
    }
    Tables {
        turns: to_csv(&turns.header, &turns.rows),
        sessions: to_csv(&sess.header, &sess.rows),
        vcs_hunks: hunks.as_ref().map(|h| to_csv(&h.header, &h.rows)),
        data,
        with_verdicts: verdicts.is_some(),
        with_retention: by_id.is_some(),
        warnings,
    }
}

/// SQLite の名前(表・列)の引用。列名は CSV の見出しそのもの(日本語)なので、必ず "…" で囲む
fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// 表を SQLite のファイルに書く(CSV と同じ列。型は値から SQLite が決める)。一時ファイルに書き終えてから置き換える
/// (rename_replacing: 前のファイルを先に消さないので、置き換えに失敗しても前のファイルは残る)。失敗したら一時ファイルを残さない。
/// 数は TS 版(node:sqlite は JS の数を常に double で渡す)と同じく REAL で入れる
pub fn write_sqlite(path: &Path, tables: &[(String, Table)]) -> Result<()> {
    let tmp = PathBuf::from(format!("{}.writing", path.display()));
    rm_force(&tmp)?;
    let res = (|| -> Result<()> {
        {
            let mut db = open_writable(&tmp)?;
            db.execute_batch("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;")?;
            let tx = db.transaction()?;
            for (name, t) in tables {
                // 同じ見出しが 2 回ある表は無いが、念のため 2 つ目以降に番号を付ける
                let mut seen: HashMap<&str, usize> = HashMap::new();
                let cols: Vec<String> = t
                    .header
                    .iter()
                    .map(|h| {
                        let n = seen.entry(h.as_str()).or_insert(0);
                        *n += 1;
                        if *n > 1 { format!("{h}_{n}") } else { h.clone() }
                    })
                    .collect();
                tx.execute_batch(&format!("CREATE TABLE {} ({})", ident(name), cols.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ")))?;
                let mut ins = tx.prepare(&format!("INSERT INTO {} VALUES ({})", ident(name), vec!["?"; cols.len()].join(", ")))?;
                for r in &t.rows {
                    let vals: Vec<rusqlite::types::Value> = r
                        .iter()
                        .map(|v| match v {
                            Cell::Null => rusqlite::types::Value::Null,
                            Cell::Bool(b) => rusqlite::types::Value::Real(if *b { 1.0 } else { 0.0 }),
                            Cell::Num(n) => rusqlite::types::Value::Real(*n),
                            Cell::Str(s) => rusqlite::types::Value::Text(s.clone()),
                        })
                        .collect();
                    ins.execute(rusqlite::params_from_iter(vals))?;
                }
            }
            tx.commit()?;
        }
        rename_replacing(&tmp, path)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = rm_force(&tmp);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_tables_with_real_numbers() {
        let dir = std::env::temp_dir().join(format!("atlas-sqlite-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(SQLITE_FILE);
        let t = Table { header: vec!["a".into(), "a".into(), "名\"前".into()], rows: vec![vec![Cell::Num(3.0), Cell::Bool(true), Cell::Str("x".into())], vec![Cell::Null, Cell::Num(2.5), Cell::Null]] };
        write_sqlite(&p, &[("t".into(), t)]).unwrap();
        assert!(!dir.join(format!("{SQLITE_FILE}.writing")).exists());
        let db = rusqlite::Connection::open(&p).unwrap();
        let cols: Vec<String> = db.prepare("SELECT name FROM pragma_table_info('t')").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(cols, ["a", "a_2", "名\"前"]);
        let types: Vec<(String, String)> = db.prepare("SELECT typeof(a), typeof(a_2) FROM t").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
        assert_eq!(types, [("real".to_string(), "real".to_string()), ("null".to_string(), "real".to_string())]);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
