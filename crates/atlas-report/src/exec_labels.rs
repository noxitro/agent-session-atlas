//! Phase 7 の表示名(atlas.html と詳細ページで共用)。packages/report/src/lib/exec-labels.ts の移植。
//! 記録の値そのものは変えず、表示だけ日本語にする。

pub const TODO_STATUS_ORDER: [&str; 4] = ["done", "in_progress", "pending", "blocked"];

pub fn mode_label(k: &str) -> String {
    match k {
        "interactive" => "対話(interactive)",
        "plan" => "計画(plan)",
        "autopilot" => "autopilot",
        "(unknown)" => "不明(イベントログ無し)",
        _ => k,
    }
    .to_string()
}

pub fn initiator_label(k: &str) -> String {
    match k {
        "user" => "利用者の依頼",
        "agent" => "エージェント",
        "sub-agent" => "サブエージェント",
        "compaction" => "compaction",
        "(unknown)" => "記録なし",
        _ => k,
    }
    .to_string()
}

pub fn effort_label(k: &str) -> String {
    if k == "(unknown)" { "不明".into() } else { k.to_string() }
}

pub fn subagent_failure_label(k: &str) -> String {
    match k {
        "quota" => "利用上限(402・quota)",
        "rate_limit" => "回数制限(429・rate limit)",
        "aborted" => "中断",
        "no_response" => "応答なし",
        "other" => "その他",
        "unknown" => "理由の記録なし",
        _ => k,
    }
    .to_string()
}

pub fn todo_status_label(k: &str) -> String {
    match k {
        "pending" => "未着手",
        "in_progress" => "進行中",
        "done" => "完了",
        "blocked" => "保留(blocked)",
        _ => k,
    }
    .to_string()
}

pub fn error_type_label(k: &str) -> String {
    if k == "(unknown)" { "種別の記録なし".into() } else { k.to_string() }
}
