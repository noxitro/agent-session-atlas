//! 判定のぶれを測るために、判定済みのセッションを判定し直す束(atlas bundle --rejudge <n>)の選び方。
//! 選ぶのは、入力が変わっていようのないセッションだけ: セッションの終わり(最後のイベント。sessions.json の updatedAt)が、
//! 今の判定の日時(項目の judge.ranAt)より前のもの。終わりか判定の日時が分からなければ選ばない。
//! まだ判定し直していない(判定のぶれの組にならない。repeated_sessions)セッションを先に選び、その中はセッション ID の決まったハッシュの順
//! (実行のたびに変わる乱数を使わない。同じ判定のファイルと履歴なら、何度作っても同じものを選ぶ)。
//! LLM に渡すパケットには、前の判定の中身を入れない(packet.rs はセッションの記録だけから作る。tests で確かめる)。

use std::collections::{HashMap, HashSet};

/// 一度に選べる数の上限(--rejudge と画面の数の上限)
pub const REJUDGE_MAX: u64 = 1000;

/// 入力が変わっていようがないか: セッションの終わりが、今の判定の日時より前。どちらかが分からなければ false
/// (判定のぶれの組にする決まり atlas_report::judgment_repeats::judged_after_end と同じ関数)
pub fn input_unchanged(end_ms: Option<i64>, ran_at: Option<&str>) -> bool {
    atlas_report::judgment_repeats::judged_after_end(end_ms, ran_at)
}

/// 依頼の記録があるか(依頼の数か最初の依頼の文。束が対象外にする「依頼の記録が無い」セッションを、判定し直す候補から外すのに使う)。
/// sessions.json だけで決める近い値で、束(bundle --rejudge)と画面の数(serve の judge-preview。前からこの決め方)で同じものを使う
pub fn has_request_hint(turns: i64, first_user_message: Option<&str>) -> bool {
    turns > 0 || first_user_message.is_some_and(|m| !m.is_empty())
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

/// もう判定し直した(判定のぶれの組になる)セッション: 今の判定と、履歴のうち判定の日時がいちばん新しいもの
/// (atlas_report::judgment_repeats::latest_history。今の判定と同じ日時のものは除く)が、どちらもセッションの終わりより後のもの。
/// 履歴があっても組にならない(終わる前に判定した)セッションは、まだ判定し直していないものとして先に選ぶ。
/// sessions はセッション id → (終わりのミリ秒, 今の判定の日時)。束(bundle --rejudge)と画面の数(serve)が同じこの関数を使う
pub fn repeated_sessions(history: Option<&crate::judgments_io::HistoryFile>, sessions: &HashMap<&str, (Option<i64>, Option<&str>)>) -> HashSet<String> {
    let Some(h) = history else { return HashSet::new() };
    let mut by: HashMap<&str, Vec<&crate::judgments_io::HistoryEntry>> = HashMap::new();
    for e in &h.items {
        by.entry(e.item.session_id.as_str()).or_default().push(e);
    }
    let ran = |e: &crate::judgments_io::HistoryEntry| e.item.judge.as_ref().map(|j| j.ran_at.clone());
    by.into_iter()
        .filter(|(id, entries)| {
            let Some((end, cur)) = sessions.get(id) else { return false };
            let latest = atlas_report::judgment_repeats::latest_history(entries.iter().copied(), |e| e.item.judge.as_ref().map(|j| j.ran_at.as_str()), |e| ran(e).as_deref() == *cur);
            latest.is_some_and(|l| input_unchanged(*end, l.item.judge.as_ref().map(|j| j.ran_at.as_str())) && input_unchanged(*end, *cur))
        })
        .map(|(id, _)| id.to_string())
        .collect()
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

    /// 判定し直したセッションに数えるのは、履歴のいちばん新しい判定と今の判定が、どちらもセッションの終わりより後のもの(組になるもの)だけ
    #[test]
    fn repeated_means_it_already_forms_a_pair() {
        use crate::judgments_io::{HistoryEntry, HistoryFile};
        let entry = |id: &str, ran_at: &str| -> HistoryEntry {
            let v = serde_json::json!({
                "sessionId": id, "taskCategory": "feature", "taskSummary": "s",
                "humanEffort": { "hours": 1, "low": 1, "high": 1, "confidence": 0.5, "rationale": "r" },
                "aiOutcome": { "completed": true, "quality": 3, "rework": 0, "rationale": "r" },
                "instructionsEffect": { "score": 0, "evidence": "e" }, "wikiEffect": { "score": 0, "evidence": "e" }, "skillsAgentsEffect": { "score": 0, "evidence": "e" },
                "judge": { "backend": "external", "ranAt": ran_at },
            });
            HistoryEntry { replaced_at: "t".into(), item: serde_json::from_value(v).unwrap() }
        };
        let end = atlas_core::jsdate::parse_ms("2026-11-10T00:00:00Z");
        let h = HistoryFile {
            schema_version: 1,
            items: vec![
                // pair: 履歴も今も終わりの後
                entry("pair", "2026-11-11T00:00:00Z"),
                // before: 履歴は終わる前の判定(組にならない)
                entry("before", "2026-11-09T00:00:00Z"),
                // later-first: 後に書いたのは終わる前の判定だが、日時のいちばん新しい履歴は終わりの後
                entry("later-first", "2026-11-11T00:00:00Z"),
                entry("later-first", "2026-11-09T00:00:00Z"),
                // same: 今の判定と同じ日時の履歴だけ(本体を書く前に止まった残り)
                entry("same", "2026-11-12T00:00:00Z"),
            ],
        };
        let cur = Some("2026-11-12T00:00:00Z");
        let sessions: HashMap<&str, (Option<i64>, Option<&str>)> = ["pair", "before", "later-first", "same"].into_iter().map(|id| (id, (end, cur))).collect();
        let mut r: Vec<String> = repeated_sessions(Some(&h), &sessions).into_iter().collect();
        r.sort();
        assert_eq!(r, ["later-first", "pair"]);
        assert!(repeated_sessions(None, &sessions).is_empty());
        // 終わりが分からないセッションは組にならない
        let unknown: HashMap<&str, (Option<i64>, Option<&str>)> = [("pair", (None, cur))].into_iter().collect();
        assert!(repeated_sessions(Some(&h), &unknown).is_empty());
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
