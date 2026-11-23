//! タスクの表の、工数のほかの列(詰まりを見るためのもの): 紐づいたセッションの人数・主なモデル・摩擦・依頼ごとの判定。
//! 値はすべてここで決め、画面は出すだけ(数え直さない)。工数と違い、いくつかのタスクに紐づいたセッションの値も等分せず、
//! 紐づいたセッションすべて(セッションの数と同じ数え方)を 1 つずつ数える。
//! - 人数: 人の記録(送り先の人のフォルダ)のあるセッションの、人の数。どのセッションにも人の記録が無ければ null
//! - 主なモデル: 本体のリクエスト(exec.mainModelEfforts)を、紐づいたセッションで足して、いちばん多いモデル(同じ数なら名前の順)。
//!   割合は、そのモデルのリクエスト ÷ 本体のリクエストの合計
//! - 摩擦: ツールの失敗・拒否(friction.toolFailures。拒否を含む)・中断(aborts)・文脈圧縮(compactions)の数
//! - 依頼ごとの判定(turn-judgments.json): 判定した依頼の数と、直し(fix_content・fix_style)・不採用(rejected)・的外れ(off_target)の数。
//!   割合の分母は、直しと不採用は判定できた作業の依頼(as_is・fix_content・fix_style・rejected)、的外れは判定できた質問(helpful・follow_up・off_target)。
//!   分母が VERDICT_RATE_MIN_TURNS 件に届かなければ割合を出さない(null)
//!
//! 依頼ごとの判定は LLM の推定で、AI の変更の残存とも、工数の判定とも混ぜない(別の列に並べるだけ)。

use atlas_core::tables::TurnVerdicts;
use atlas_core::turns::OUTCOMES;
use atlas_core::types::SessionRecord;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

/// 依頼ごとの判定の割合を出す、分母の依頼の数の下限。画面の「比べる」で工程どうしの割合を出す下限(lib/compare.ts の COMPARE_MIN_TURNS)と
/// 同じ数にする(表示の決まりで、どこかの環境の件数に合わせたものではない)
pub const VERDICT_RATE_MIN_TURNS: usize = 5;

/// セッション 1 件の、タスクの表の詰まりの列に使う値
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionExtra {
    /// 人のフォルダの名前(送り先から集計したとき。空は無いとみなす)
    pub person: Option<String>,
    /// 本体のリクエストの数(モデルごと。exec.mainModelEfforts の推論強度を足したもの。並びは記録の順)
    pub main_requests: Vec<(String, f64)>,
    pub tool_failures: i64,
    pub aborts: i64,
    pub compactions: i64,
    /// 依頼ごとの判定の、扱い(OUTCOMES の並び)ごとの数。判定が無ければ None
    pub verdicts: Option<[i64; 8]>,
}

impl SessionExtra {
    /// sessions.json のセッションから(依頼ごとの判定は別に入れる)
    pub fn of(r: &SessionRecord) -> SessionExtra {
        let main_requests = r
            .exec
            .main_model_efforts
            .as_ref()
            .map(|m| m.js_entries().into_iter().map(|(model, by)| (model.clone(), by.js_entries().into_iter().map(|(_, s)| s.requests).sum::<f64>())).collect())
            .unwrap_or_default();
        SessionExtra {
            person: r.person.clone().flatten().filter(|p| !p.is_empty()),
            main_requests,
            tool_failures: r.friction.tool_failures,
            aborts: r.friction.aborts,
            compactions: r.friction.compactions,
            verdicts: None,
        }
    }

    /// sessions.json のセッションの JSON から(serve の GET /api/tasks。SessionExtra::of と同じ項目を読む)
    pub fn from_value(r: &Value) -> SessionExtra {
        let int = |v: Option<&Value>| v.and_then(Value::as_f64).map_or(0, |x| x as i64);
        let fr = r.get("friction");
        let main_requests = r
            .get("exec")
            .and_then(|e| e.get("mainModelEfforts"))
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(model, by)| (model.clone(), by.as_object().map_or(0.0, |b| b.values().filter_map(|s| s.get("requests").and_then(Value::as_f64)).sum()))).collect())
            .unwrap_or_default();
        SessionExtra {
            person: r.get("person").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string),
            main_requests,
            tool_failures: int(fr.and_then(|f| f.get("toolFailures"))),
            aborts: int(fr.and_then(|f| f.get("aborts"))),
            compactions: int(fr.and_then(|f| f.get("compactions"))),
            verdicts: None,
        }
    }
}

/// 1 セッションの依頼ごとの判定を、扱いごとに数える(判定が 1 件も無ければ None)
pub fn verdict_counts(m: Option<&TurnVerdicts>) -> Option<[i64; 8]> {
    let m = m.filter(|m| !m.is_empty())?;
    let mut c = [0i64; 8];
    for v in m.values() {
        if let Some(i) = OUTCOMES.iter().position(|o| *o == v.outcome) {
            c[i] += 1;
        }
    }
    Some(c)
}

/// タスクの摩擦(紐づいたセッションの和)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFriction {
    /// ツールの失敗・拒否
    pub tool_failures: i64,
    /// 中断
    pub aborts: i64,
    /// 文脈圧縮
    pub compactions: i64,
}

impl TaskFriction {
    pub fn total(&self) -> i64 {
        self.tool_failures + self.aborts + self.compactions
    }
}

/// タスクの依頼ごとの判定(紐づいたセッションの和)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskVerdicts {
    /// 判定した依頼(判定不能を含む)
    pub judged: i64,
    /// 判定できた作業の依頼(そのまま・中身の直し・体裁の直し・不採用。直しと不採用の割合の分母)
    pub work_decided: i64,
    /// 判定できた質問(役に立った・追加で聞いた・的外れ。的外れの割合の分母)
    pub question_decided: i64,
    /// 直し(中身の直し + 体裁の直し)
    pub fix: i64,
    pub rejected: i64,
    pub off_target: i64,
    /// 割合(0〜1)。分母が min_turns に届かなければ null
    pub fix_rate: Option<f64>,
    pub rejected_rate: Option<f64>,
    pub off_target_rate: Option<f64>,
}

/// タスクの、工数のほかの列
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskExtras {
    pub people: Option<usize>,
    pub main_model: Option<String>,
    pub main_model_share: Option<f64>,
    pub friction: TaskFriction,
    pub verdicts: Option<TaskVerdicts>,
}

fn outcome(c: &[i64; 8], name: &str) -> i64 {
    OUTCOMES.iter().position(|o| *o == name).map_or(0, |i| c[i])
}

/// 紐づいたセッション(重ねずに 1 つずつ)の値から、タスクの列を決める
pub fn task_extras<'a>(sessions: impl IntoIterator<Item = &'a SessionExtra>) -> TaskExtras {
    let mut people: BTreeSet<&str> = BTreeSet::new();
    let mut with_person = false;
    let mut requests: indexmap::IndexMap<&str, f64> = indexmap::IndexMap::new();
    let mut friction = TaskFriction::default();
    let mut counts: Option<[i64; 8]> = None;
    for s in sessions {
        if let Some(p) = &s.person {
            with_person = true;
            people.insert(p.as_str());
        }
        for (m, n) in &s.main_requests {
            *requests.entry(m.as_str()).or_default() += n;
        }
        friction.tool_failures += s.tool_failures;
        friction.aborts += s.aborts;
        friction.compactions += s.compactions;
        if let Some(v) = &s.verdicts {
            let c = counts.get_or_insert([0; 8]);
            for i in 0..8 {
                c[i] += v[i];
            }
        }
    }
    let total: f64 = requests.values().sum();
    let best = requests.iter().filter(|(_, n)| **n > 0.0).max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| b.0.cmp(a.0)));
    let verdicts = counts.map(|c| {
        let work_decided = ["as_is", "fix_content", "fix_style", "rejected"].iter().map(|k| outcome(&c, k)).sum();
        let question_decided = ["helpful", "follow_up", "off_target"].iter().map(|k| outcome(&c, k)).sum();
        let fix = outcome(&c, "fix_content") + outcome(&c, "fix_style");
        let rejected = outcome(&c, "rejected");
        let off_target = outcome(&c, "off_target");
        let rate = |part: i64, whole: i64| (whole as usize >= VERDICT_RATE_MIN_TURNS && whole > 0).then(|| part as f64 / whole as f64);
        TaskVerdicts {
            judged: c.iter().sum(),
            work_decided,
            question_decided,
            fix,
            rejected,
            off_target,
            fix_rate: rate(fix, work_decided),
            rejected_rate: rate(rejected, work_decided),
            off_target_rate: rate(off_target, question_decided),
        }
    });
    TaskExtras {
        people: with_person.then_some(people.len()),
        main_model: best.map(|(m, _)| m.to_string()),
        main_model_share: best.map(|(_, n)| n / total),
        friction,
        verdicts,
    }
}

/// セッション id → 依頼ごとの判定の扱いごとの数(turn-judgments.json の読み方は verdicts::parse_verdicts と同じ)
pub fn verdict_counts_by_session(index: Option<&crate::verdicts::VerdictIndex>) -> HashMap<String, [i64; 8]> {
    index.map(|ix| ix.by_session.iter().filter_map(|(sid, m)| verdict_counts(Some(m)).map(|c| (sid.clone(), c))).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(person: Option<&str>, reqs: &[(&str, f64)], f: (i64, i64, i64), v: Option<[i64; 8]>) -> SessionExtra {
        SessionExtra { person: person.map(str::to_string), main_requests: reqs.iter().map(|(m, n)| (m.to_string(), *n)).collect(), tool_failures: f.0, aborts: f.1, compactions: f.2, verdicts: v }
    }

    /// 人数・主なモデル・摩擦・判定を、紐づいたセッションの和で決める。割合は分母が下限に届いたときだけ
    #[test]
    fn extras_from_linked_sessions() {
        // [as_is, fix_content, fix_style, rejected, helpful, follow_up, off_target, unknown]
        let a = ex(Some("p1"), &[("m-a", 6.0), ("m-b", 1.0)], (2, 1, 0), Some([2, 1, 1, 0, 1, 0, 1, 2]));
        let b = ex(Some("p2"), &[("m-b", 4.0)], (1, 0, 1), Some([1, 0, 0, 1, 0, 0, 0, 0]));
        let c = ex(None, &[], (0, 0, 0), None);
        let t = task_extras([&a, &b, &c]);
        assert_eq!(t.people, Some(2));
        // m-a 6・m-b 5 → m-a(6 / 11)
        assert_eq!((t.main_model.as_deref(), t.main_model_share), (Some("m-a"), Some(6.0 / 11.0)));
        assert_eq!(t.friction, TaskFriction { tool_failures: 3, aborts: 1, compactions: 1 });
        assert_eq!(t.friction.total(), 5);
        let v = t.verdicts.unwrap();
        assert_eq!((v.judged, v.work_decided, v.question_decided, v.fix, v.rejected, v.off_target), (10, 6, 2, 2, 1, 1));
        // 作業の依頼 6 件(下限 5 以上)なので直しと不採用の割合は出す。質問は 2 件なので的外れの割合は出さない
        assert_eq!((v.fix_rate, v.rejected_rate, v.off_target_rate), (Some(2.0 / 6.0), Some(1.0 / 6.0), None));
        // 人の記録も判定も無ければ null。リクエストが同じ数なら名前の順
        let t = task_extras([&ex(None, &[("z", 2.0), ("a", 2.0)], (0, 0, 0), None)]);
        assert_eq!((t.people, t.main_model.as_deref(), t.verdicts), (None, Some("a"), None));
        assert_eq!(task_extras([&c]).main_model, None);
        // 下限より少ない作業の依頼では割合を出さない
        let few = task_extras([&ex(None, &[], (0, 0, 0), Some([1, 1, 0, 1, 0, 0, 0, 0]))]).verdicts.unwrap();
        assert_eq!((few.work_decided, few.fix_rate, few.rejected_rate), (3, None, None));
    }

    /// sessions.json の JSON から読んでも、SessionRecord から作っても同じ値(serve の GET /api/tasks とレポートで同じ)
    #[test]
    fn extra_from_value_matches_record() {
        let mut it = std::iter::empty();
        let ws = atlas_core::types::WorkspaceInfo { created_at: Some("2026-11-23T01:00:00Z".into()), ..Default::default() };
        let mut r = atlas_core::normalize::normalize_session(atlas_core::normalize::NormalizeInput { id: "s".into(), has_dir: None, workspace: Some(&ws), db: Default::default(), events: Some(&mut it), wiki_classifier: None }).unwrap();
        r.person = Some(Some("p".into()));
        r.friction.tool_failures = 3;
        r.friction.aborts = 2;
        r.friction.compactions = 1;
        let mut by = atlas_core::js::JsMap::new();
        by.insert("high".to_string(), atlas_core::types::EffortStat { requests: 3.0, input: 0.0, output: 0.0, nano_aiu: 0.0 });
        by.insert("low".to_string(), atlas_core::types::EffortStat { requests: 2.0, input: 0.0, output: 0.0, nano_aiu: 0.0 });
        let mut main = atlas_core::js::JsMap::new();
        main.insert("m".to_string(), by);
        r.exec.main_model_efforts = Some(main);
        let a = SessionExtra::of(&r);
        let b = SessionExtra::from_value(&serde_json::to_value(&r).unwrap());
        assert_eq!(a, b);
        assert_eq!((a.person.as_deref(), a.main_requests.clone(), a.tool_failures), (Some("p"), vec![("m".to_string(), 5.0)], 3));
        // 空の人の名前は無いとみなす
        r.person = Some(Some(String::new()));
        assert_eq!((SessionExtra::of(&r).person, SessionExtra::from_value(&serde_json::to_value(&r).unwrap()).person), (None, None));
    }
}
