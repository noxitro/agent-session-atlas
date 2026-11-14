//! 既知のイベント種別(packages/core/src/event-types.ts の移植)。ここに無い種別は unknownEventTypes に計上する。

/// Copilot CLI のログで観測した種別名(名前の順)
pub const KNOWN_EVENT_TYPES: &[&str] = &[
    "abort",
    "assistant.message",
    "assistant.turn_end",
    "assistant.turn_start",
    "external_tool.completed",
    "external_tool.requested",
    "hook.end",
    "hook.start",
    "model.captured_assignment_context",
    "model.message",
    "model.messages_snapshot",
    "model.model_call_started",
    "model.model_call_success",
    "model.response",
    "model.turn_ended",
    "model.turn_started",
    "permission.completed",
    "permission.requested",
    "session.auto_mode_resolved",
    "session.binary_asset",
    "session.canvas.recorded",
    "session.canvas.removed",
    "session.compaction_complete",
    "session.compaction_start",
    "session.context_changed",
    "session.error",
    "session.info",
    "session.mode_changed",
    "session.mode_notice_delivered",
    "session.model_change",
    "session.permissions_changed",
    "session.plan_changed",
    "session.resume",
    "session.shutdown",
    "session.start",
    "session.task_complete",
    "session.usage_checkpoint",
    "session.usage_record",
    "session.workspace_file_changed",
    "skill.context_delivered_ref",
    "skill.invoked",
    "skill.invoked_ref",
    "subagent.completed",
    "subagent.configured",
    "subagent.failed",
    "subagent.selected",
    "subagent.started",
    "system.message",
    "system.notification",
    "tool.execution_complete",
    "tool.execution_start",
    "user.message",
];

pub fn is_known_event_type(t: &str) -> bool {
    KNOWN_EVENT_TYPES.binary_search(&t).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorted_and_shaped() {
        let mut sorted = KNOWN_EVENT_TYPES.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted, KNOWN_EVENT_TYPES);
        let re = regex::Regex::new(r"^[a-z_]+(\.[a-z_]+)*$").unwrap();
        for t in KNOWN_EVENT_TYPES {
            assert!(re.is_match(t), "{t}");
        }
        assert!(is_known_event_type("session.shutdown"));
        assert!(!is_known_event_type("session.future_thing"));
    }
}
