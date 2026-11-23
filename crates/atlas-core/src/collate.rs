//! `String#localeCompare` の代わり。
//!
//! TS 版は既定のロケール(この利用環境では ja-JP)の ICU 照合で並べていた。環境で並びが変わらないよう、ここでは ja に固定する
//! (V8 と同じ ICU の照合規則を ICU4X で引く。'_x' < '-y' < '10' < '9' < 'a' < 'A' < 'b' < 'あ' < 'ア' < '亜' の順)。

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};
use icu_locale_core::locale;
use std::cmp::Ordering;
use std::sync::LazyLock;

static COLLATOR: LazyLock<CollatorBorrowed<'static>> =
    LazyLock::new(|| Collator::try_new(locale!("ja").into(), CollatorOptions::default()).expect("ICU4X の ja 照合データは組み込み"));

/// `a.localeCompare(b)` 相当(ja の照合)
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    COLLATOR.compare(a, b)
}

/// 符号付きの比較値(JS の比較関数に合わせたいとき)
pub fn locale_compare_i32(a: &str, b: &str) -> i32 {
    match locale_compare(a, b) {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_ja_order() {
        let mut v = vec!["b", "a", "B", "_x", "-y", "10", "9", "あ", "ア", "亜", "A"];
        v.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(v, ["_x", "-y", "10", "9", "a", "A", "b", "B", "あ", "ア", "亜"]);
    }
}
