//! セッションの本体(メインのエージェント)の (モデル, 推論強度) を決める。
//! 画面の packages/report/src/lib/main-effort.ts と同じ決め方(npm run parity:fixture で突き合わせる)。

use crate::js::JsMap;
use crate::normalize::UNKNOWN_KEY;
use crate::types::EffortStat;

/// 本体のリクエストのうち、同じ (モデル, 推論強度) がこの割合以上なら、その組をセッションの本体の強度とみなす
pub const MAIN_EFFORT_SHARE: f64 = 0.9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MainEffort {
    /// 本体のリクエストの MAIN_EFFORT_SHARE 以上が同じ組
    Decided { model: String, effort: String },
    /// 本体のリクエストはあるが、どの組も MAIN_EFFORT_SHARE に届かない
    Mixed,
    /// 本体のリクエストの記録が無い(古い sessions.json・終了時の累計だけ)か、いちばん多い組の強度が不明
    None,
}

impl MainEffort {
    /// 表(sessions.csv)に書く言葉。決まったときは強度の名前
    pub fn effort_cell(&self) -> &str {
        match self {
            MainEffort::Decided { effort, .. } => effort,
            MainEffort::Mixed => "混在",
            MainEffort::None => "記録なし",
        }
    }

    pub fn model_cell(&self) -> &str {
        match self {
            MainEffort::Decided { model, .. } => model,
            _ => "",
        }
    }
}

/// exec.mainModelEfforts から本体の (モデル, 推論強度) を決める
pub fn main_effort_of(main: Option<&JsMap<JsMap<EffortStat>>>) -> MainEffort {
    let Some(main) = main else { return MainEffort::None };
    let mut total = 0.0;
    let mut best: Option<(&String, &String, f64)> = None;
    for (m, by) in main.js_entries() {
        for (e, s) in by.js_entries() {
            total += s.requests;
            if best.is_none_or(|b| s.requests > b.2) {
                best = Some((m, e, s.requests));
            }
        }
    }
    match best {
        Some((m, e, n)) if total > 0.0 && n / total >= MAIN_EFFORT_SHARE => {
            if e == UNKNOWN_KEY {
                MainEffort::None
            } else {
                MainEffort::Decided { model: m.clone(), effort: e.clone() }
            }
        }
        _ if total > 0.0 => MainEffort::Mixed,
        _ => MainEffort::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(n: f64) -> EffortStat {
        EffortStat { requests: n, input: 0.0, output: 0.0, nano_aiu: 0.0 }
    }
    fn map(rows: &[(&str, &str, f64)]) -> JsMap<JsMap<EffortStat>> {
        let mut m: JsMap<JsMap<EffortStat>> = JsMap::new();
        for (model, e, n) in rows {
            m.entry(model.to_string()).or_default().insert(e.to_string(), stat(*n));
        }
        m
    }

    #[test]
    fn decides_by_share_of_main_requests() {
        // 9 / 10 = 90% はちょうど届く
        assert_eq!(main_effort_of(Some(&map(&[("m", "xhigh", 9.0), ("m", "medium", 1.0)]))), MainEffort::Decided { model: "m".into(), effort: "xhigh".into() });
        // 8 / 10 は届かない(モデルが違う組も分母に入る)
        assert_eq!(main_effort_of(Some(&map(&[("m", "xhigh", 8.0), ("n", "xhigh", 2.0)]))), MainEffort::Mixed);
        // いちばん多い組の強度が不明なら、記録なし
        assert_eq!(main_effort_of(Some(&map(&[("m", UNKNOWN_KEY, 10.0)]))), MainEffort::None);
        assert_eq!(main_effort_of(Some(&map(&[]))), MainEffort::None);
        assert_eq!(main_effort_of(Some(&map(&[("m", "low", 0.0)]))), MainEffort::None);
        assert_eq!(main_effort_of(None), MainEffort::None);
        assert_eq!(MainEffort::Mixed.effort_cell(), "混在");
        assert_eq!(MainEffort::None.model_cell(), "");
    }
}
