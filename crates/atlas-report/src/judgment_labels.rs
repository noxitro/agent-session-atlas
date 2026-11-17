//! 判定結果(judgments.json)の表示ラベル。packages/report/src/lib/judgment-labels.ts の移植。atlas.html と詳細ページで共用する。

use atlas_core::js;

/// 作業の分類の名前(CATEGORY_LABEL)
pub const CATEGORY_LABEL: [(&str, &str); 7] = [
    ("feature", "機能追加"),
    ("bugfix", "不具合修正"),
    ("investigation", "調査・質問"),
    ("refactor", "リファクタリング"),
    ("docs", "文書"),
    ("ops", "環境・運用"),
    ("other", "その他"),
];

fn lookup(table: &[(&str, &'static str)], k: &str) -> Option<&'static str> {
    table.iter().find(|(x, _)| *x == k).map(|(_, v)| *v)
}

pub fn category_label(c: Option<&str>) -> String {
    match c.filter(|x| !x.is_empty()) {
        None => "未分類".into(),
        Some(c) => lookup(&CATEGORY_LABEL, c).unwrap_or(c).to_string(),
    }
}

const EFFECT_LABEL: [(&str, &str); 5] = [("-2", "明確に悪影響"), ("-1", "やや悪影響"), ("0", "影響なし・未使用"), ("1", "やや役立った"), ("2", "明確に役立った")];

pub fn effect_label(score: Option<f64>) -> String {
    let Some(score) = score else {
        return "記録なし".into();
    };
    let n = js::num_to_string(score);
    let s = if score > 0.0 { format!("+{n}") } else { n.clone() };
    format!("{s}({})", lookup(&EFFECT_LABEL, &n).unwrap_or("範囲外"))
}

/// 確信度(0〜1)を「確信度 60%」に
pub fn confidence_label(c: Option<f64>) -> String {
    match c {
        None => "確信度 不明".into(),
        Some(c) => format!("確信度 {}%", js::num_to_string(js::round(c * 100.0))),
    }
}

pub const BACKEND_LABEL: [(&str, &str); 4] = [("external", "外部 LLM(取り込み)"), ("copilot-cli", "copilot -p"), ("opencode", "opencode"), ("anthropic", "Anthropic API")];

pub fn backend_label(b: Option<&str>) -> String {
    match b.filter(|x| !x.is_empty()) {
        None => "不明".into(),
        Some(b) => lookup(&BACKEND_LABEL, b).unwrap_or(b).to_string(),
    }
}
