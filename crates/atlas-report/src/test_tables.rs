//! テストの実行の表(out/tables/ の test-runs.csv・test-results.csv・test-counts.csv と、sessions.csv に足すテストの列)。

use crate::summarize::tests_summary;
use atlas_core::js;
use atlas_core::tables::{Cell, Table};
use atlas_core::types::SessionRecord;

/// 秒(整数に丸める。turns.csv の「実働(秒)」と同じ)
fn sec(ms: Option<f64>) -> Cell {
    ms.map_or(Cell::Null, |m| Cell::Num(js::round(m / 1000.0)))
}
/// nano AIU → AIU(小数 3 桁。sessions.csv の AIU と同じ)
fn aiu_cell(nano: Option<f64>) -> Cell {
    nano.map_or(Cell::Null, |n| Cell::Num(js::round((n / 1e9) * 1000.0) / 1000.0))
}
fn header(names: &[&str]) -> Vec<String> {
    names.iter().map(|s| s.to_string()).collect()
}

/// sessions.csv に足す列の見出し(最初の依頼の列の前に入れる)
pub const SESSION_COLUMNS: [&str; 7] = ["テストの実行", "最初に全部通った実行", "最後に通っていないテスト", "通るまでの実働(秒)", "通るまでの AIU", "読めなかったテストの印の行", "上限で持たなかったテストの結果"];

/// sessions.csv に足す列の値(テストの列は、テストの実行があるセッションだけ。
/// 読めなかった印の行と、1 セッションの上限で持たなかった結果は、印の行があったセッションだけ(test-*.csv に入っていないものがあると分かるように))
pub fn session_cells(r: &SessionRecord) -> Vec<Cell> {
    let t = r.tests.as_ref().and_then(tests_summary);
    vec![
        t.as_ref().map(|t| t.runs).into(),
        t.as_ref().and_then(|t| t.first_pass).into(),
        t.as_ref().map(|t| t.last_failing).into(),
        sec(t.as_ref().and_then(|t| t.pass_active_ms)),
        aiu_cell(t.as_ref().and_then(|t| t.pass_nano_aiu)),
        r.tests.as_ref().map(|x| x.invalid).into(),
        r.tests.as_ref().map(|x| x.dropped).into(),
    ]
}

/// テストの実行・結果・件数の表(test-runs.csv・test-results.csv・test-counts.csv)
pub struct TestTables {
    pub runs: Table,
    pub results: Table,
    pub counts: Table,
}

/// テストの実行が 1 回もなければ None(見出しだけの表を書かない)
pub fn test_tables(sessions: &[&SessionRecord]) -> Option<TestTables> {
    let mut runs = Table { header: header(&["セッションID", "セッション名", "実行", "完了", "依頼番号", "ツール", "サブエージェント", "結果", "合格", "通っていないテスト", "実働(秒)", "AIU"]), rows: Vec::new() };
    let mut results = Table { header: header(&["セッションID", "実行", "結果", "テスト名", "合否", "時刻"]), rows: Vec::new() };
    let mut counts = Table { header: header(&["セッションID", "実行", "結果", "テスト名", "名前", "値"]), rows: Vec::new() };
    for r in sessions {
        let Some(t) = &r.tests else { continue };
        for (i, run) in t.runs.iter().enumerate() {
            let n = i + 1;
            runs.rows.push(vec![
                r.id.as_str().into(),
                r.name.as_deref().unwrap_or("").into(),
                n.into(),
                run.at.as_deref().into(),
                run.turn.into(),
                run.tool.as_deref().unwrap_or("").into(),
                run.subagent.into(),
                run.results.len().into(),
                run.results.iter().filter(|x| x.passed).count().into(),
                run.failing.into(),
                sec(Some(run.active_ms)),
                aiu_cell(run.nano_aiu),
            ]);
            for (j, x) in run.results.iter().enumerate() {
                let name = x.name.as_deref().unwrap_or("");
                results.rows.push(vec![r.id.as_str().into(), n.into(), (j + 1).into(), name.into(), x.passed.into(), x.at.as_deref().into()]);
                for (k, v) in x.counts.iter() {
                    counts.rows.push(vec![r.id.as_str().into(), n.into(), (j + 1).into(), name.into(), k.as_str().into(), Cell::Num(*v)]);
                }
            }
        }
    }
    (!runs.rows.is_empty()).then_some(TestTables { runs, results, counts })
}
