//! 判定のぶれを測るために、判定済みのセッションを判定し直す束(atlas bundle --rejudge <n>)の選び方。
//! 選ぶのは、入力が変わっていようのないセッションだけ: セッションの終わり(最後のイベント。sessions.json の updatedAt)が、
//! 今の判定の日時(項目の judge.ranAt)より前のもの。終わりか判定の日時が分からなければ選ばない。
//! まだ判定し直していない(判定の履歴に無い)セッションを先に選び、その中はセッション ID の決まったハッシュの順
//! (実行のたびに変わる乱数を使わない。同じ判定のファイルと履歴なら、何度作っても同じものを選ぶ)。
//! LLM に渡すパケットには、前の判定の中身を入れない(packet.rs はセッションの記録だけから作る。tests で確かめる)。

use std::collections::HashSet;

/// 一度に選べる数の上限(--rejudge と画面の数の上限)
pub const REJUDGE_MAX: u64 = 1000;

/// 入力が変わっていようがないか: セッションの終わりが、今の判定の日時より前。どちらかが分からなければ false
pub fn input_unchanged(end_ms: Option<i64>, ran_at: Option<&str>) -> bool {
    match (end_ms, ran_at.and_then(atlas_core::jsdate::parse_ms)) {
        (Some(end), Some(at)) => end < at,
        _ => false,
    }
}

/// セッション ID の決まったハッシュ(FNV-1a 64 bit。版やプロセスで変わらない)
pub fn stable_hash(id: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in id.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// 選ぶ候補 1 件
#[derive(Debug, Clone, PartialEq)]
pub struct RejudgeCandidate<'a> {
    pub id: &'a str,
    /// セッションの終わり(ミリ秒)
    pub end_ms: Option<i64>,
    /// 今の判定の日時(項目の judge.ranAt)。判定が無ければ None
    pub ran_at: Option<&'a str>,
    /// 判定の履歴にもうある(一度は判定し直した)
    pub repeated: bool,
}

/// 選んだ結果
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RejudgeSelection {
    /// 選んだセッション(選んだ順)
    pub ids: Vec<String>,
    /// 入力が変わっていようがない判定済みのセッションの数(選べた数)
    pub eligible: usize,
    /// そのうち、まだ判定し直していないもの
    pub fresh: usize,
}

/// 判定し直すセッションを n 件まで選ぶ
pub fn select_rejudge(cands: &[RejudgeCandidate<'_>], n: usize) -> RejudgeSelection {
    let mut ok: Vec<&RejudgeCandidate<'_>> = cands.iter().filter(|c| input_unchanged(c.end_ms, c.ran_at)).collect();
    let mut seen: HashSet<&str> = HashSet::new();
    ok.retain(|c| seen.insert(c.id));
    ok.sort_by(|a, b| a.repeated.cmp(&b.repeated).then_with(|| stable_hash(a.id).cmp(&stable_hash(b.id))).then_with(|| a.id.cmp(b.id)));
    RejudgeSelection { eligible: ok.len(), fresh: ok.iter().filter(|c| !c.repeated).count(), ids: ok.iter().take(n).map(|c| c.id.to_string()).collect() }
}

/// 判定の履歴に 1 件でもあるセッション
pub fn repeated_sessions(history: Option<&crate::judgments_io::HistoryFile>) -> HashSet<String> {
    history.map(|h| h.items.iter().map(|e| e.item.session_id.clone()).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c<'a>(id: &'a str, end: Option<&str>, ran_at: Option<&'a str>, repeated: bool) -> RejudgeCandidate<'a> {
        RejudgeCandidate { id, end_ms: end.and_then(atlas_core::jsdate::parse_ms), ran_at, repeated }
    }

    /// 入力が変わっていようがないもの(終わりが判定より前)だけ。終わりか判定の日時が分からないもの・判定の後に続いたものは選ばない
    #[test]
    fn only_sessions_that_ended_before_the_judgment() {
        assert!(input_unchanged(Some(1), Some("2026-11-20T00:00:00Z")));
        assert!(!input_unchanged(None, Some("2026-11-20T00:00:00Z")));
        assert!(!input_unchanged(Some(1), None));
        assert!(!input_unchanged(Some(1), Some("日時でない")));
        let at = atlas_core::jsdate::parse_ms("2026-11-20T00:00:00Z").unwrap();
        // 同じ時刻は前ではない(その時刻のイベントを判定が見たか分からない)
        assert!(!input_unchanged(Some(at), Some("2026-11-20T00:00:00Z")));
        let cands = [
            c("ended-before", Some("2026-11-19T10:00:00Z"), Some("2026-11-20T00:00:00Z"), false),
            c("continued-after", Some("2026-11-21T10:00:00Z"), Some("2026-11-20T00:00:00Z"), false),
            c("no-end", None, Some("2026-11-20T00:00:00Z"), false),
            c("no-ran-at", Some("2026-11-19T10:00:00Z"), None, false),
        ];
        let s = select_rejudge(&cands, 10);
        assert_eq!(s, RejudgeSelection { ids: vec!["ended-before".into()], eligible: 1, fresh: 1 });
    }

    /// まだ判定し直していないものを先に、その中は決まったハッシュの順。何度選んでも、並べ替えて渡しても同じ
    #[test]
    fn prefers_fresh_sessions_in_a_fixed_order() {
        let end = Some("2026-11-01T00:00:00Z");
        let at = Some("2026-11-02T00:00:00Z");
        let ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
        let cands: Vec<RejudgeCandidate<'_>> = ids.iter().map(|id| c(id, end, at, *id == "s2" || *id == "s5")).collect();
        let a = select_rejudge(&cands, 3);
        assert_eq!((a.eligible, a.fresh), (6, 4));
        assert!(a.ids.iter().all(|id| id != "s2" && id != "s5"), "{:?}", a.ids);
        let mut rev = cands.clone();
        rev.reverse();
        assert_eq!(select_rejudge(&rev, 3), a);
        // 全部なら、判定し直したものは後ろ
        let all = select_rejudge(&cands, 100);
        assert_eq!(all.ids.len(), 6);
        assert!(all.ids[4..].iter().all(|id| id == "s2" || id == "s5"), "{:?}", all.ids);
        // ハッシュは版で変わらない値
        assert_eq!(stable_hash(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(stable_hash("a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(select_rejudge(&cands, 0).ids, Vec::<String>::new());
    }
}
