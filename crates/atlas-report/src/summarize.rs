//! SessionRecord → SessionSummary(HTML に埋め込む要約)。packages/report/src/lib/summarize.ts の移植。
//! 生イベント・timeline・長文は落とす。

use crate::anonymize::Anonymizer;
use crate::filter::coverage_of;
use crate::format::truncate;
use crate::turns::turn_tuples;
use crate::types::*;
use atlas_core::js::JsMap;
use atlas_core::types::{AgentStatus, InstructionScope, SessionRecord, SkillTrigger};
use regex::Regex;
use std::sync::LazyLock;

static APPROVED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^approved").unwrap());
static DENIED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^denied|^rejected").unwrap());

/// permission.completed の result.kind を承認・拒否・その他にまとめる(approved-for-location などは承認)
pub fn permission_group(kind: &str) -> usize {
    // /^approved/i・/^denied|^rejected/i(u なしの i は ASCII の英字だけを同一視する)
    let k = kind.to_ascii_lowercase();
    if APPROVED.is_match(&k) {
        0
    } else if DENIED.is_match(&k) {
        1
    } else {
        2
    }
}

fn exec_summary(r: &SessionRecord) -> ExecSummary {
    let e = &r.exec;
    let tuple = |v: &atlas_core::types::EffortStat| [v.requests, v.input, v.output, v.nano_aiu];
    let mut efforts = JsMap::new();
    for (k, v) in e.efforts.js_entries() {
        efforts.insert(k.clone(), tuple(v));
    }
    let mut model_efforts = JsMap::new();
    if let Some(me) = &e.model_efforts {
        for (m, by) in me.js_entries() {
            let mut to = JsMap::new();
            for (k, v) in by.js_entries() {
                to.insert(k.clone(), tuple(v));
            }
            model_efforts.insert(m.clone(), to);
        }
    }
    let c = &e.context;
    let any = c.system_tokens.is_some() || c.conversation_tokens.is_some() || c.tool_definitions_tokens.is_some() || c.available_tool_count.is_some();
    let mut latency = JsMap::new();
    for (m, l) in e.latency.js_entries() {
        latency.insert(m.clone(), (l.ttft.clone(), l.duration.clone()));
    }
    ExecSummary {
        modes: e.modes.by_mode.clone(),
        modes_inferred: e.modes.inferred,
        efforts,
        model_efforts,
        initiators: e.initiators.clone(),
        context: any.then_some([c.system_tokens, c.conversation_tokens, c.tool_definitions_tokens, c.available_tool_count]),
        latency,
    }
}

fn friction_detail_summary(r: &SessionRecord) -> FrictionDetailSummary {
    let f = &r.friction_detail;
    let mut permissions = [0i64; 3];
    for (k, n) in f.permissions.js_entries() {
        permissions[permission_group(k)] += n;
    }
    let c = &f.compaction;
    FrictionDetailSummary {
        permissions,
        error_types: f.error_types.clone(),
        subagent_failures: f.subagent_failures.clone(),
        compaction: [c.recorded as f64, c.input, c.output, c.nano_aiu, c.tokens_removed],
    }
}

/// 一覧に出す本文の長さ(文字)
pub const SUMMARY_TEXT_CHARS: usize = 160;

/// 詳細ページのファイル名(セッション ID は通常 UUID。念のためファイル名に使えない文字を置き換える)
pub fn detail_file_name(id: &str) -> String {
    // /[^A-Za-z0-9._-]/g は UTF-16 の単位ごとに置き換える(サロゲートペアの文字は _ が 2 つ)
    let mut out = String::with_capacity(id.len() + 5);
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
        } else {
            let units = if (0x10000..atlas_core::js::LONE_BASE).contains(&(c as u32)) { 2 } else { 1 };
            for _ in 0..units {
                out.push('_');
            }
        }
    }
    out.push_str(".html");
    out
}

pub fn detail_href(id: &str) -> String {
    format!("sessions/{}", detail_file_name(id))
}

pub fn summarize(r: &SessionRecord, anon: &Anonymizer, judgment: Option<&JudgmentSummary>) -> SessionSummary {
    let mut by_model = JsMap::new();
    for (m, t) in r.tokens.by_model.js_entries() {
        by_model.insert(m.clone(), ModelTokenSummary { input: t.input, output: t.output, cache_read: t.cache_read, premium_requests: t.premium_requests, requests: t.requests });
    }
    let mut skills: JsMap<SkillTriggers> = JsMap::new();
    let mut skill_chars: JsMap<Option<f64>> = JsMap::new();
    for s in &r.skills {
        let t = skills.entry(s.name.clone()).or_insert([0, 0, 0]);
        t[match s.trigger {
            Some(SkillTrigger::User) => 0,
            Some(SkillTrigger::Agent) => 1,
            None => 2,
        }] += 1;
        match s.chars.flatten() {
            Some(c) => {
                let cur = skill_chars.get(&s.name).copied().flatten().unwrap_or(0.0);
                skill_chars.insert(s.name.clone(), Some(cur.max(c)));
            }
            None => {
                skill_chars.entry(s.name.clone()).or_insert(None);
            }
        }
    }
    let mut agents_by_name: JsMap<AgentStat> = JsMap::new();
    for a in &r.agents {
        let t = agents_by_name.entry(a.name.clone()).or_insert((0, 0, 0.0));
        t.0 += 1;
        if a.status == AgentStatus::Failed {
            t.1 += 1;
        }
        t.2 += a.total_tokens.unwrap_or(0.0);
    }
    // metrics の instructions.byFile と同じキー(ユーザー単位は「(user)」付き)
    let mut instructions: JsMap<i64> = JsMap::new();
    for i in &r.instructions {
        let key = if i.scope == InstructionScope::User { format!("{} (user)", i.file.as_str()) } else { i.file.as_str().to_string() };
        instructions.inc(&key, i.chars);
    }
    let mut issues: JsMap<ToolIssue> = JsMap::new();
    let mut causes: JsMap<JsMap<i64>> = JsMap::new();
    for (tool, calls) in r.tools.by_name.js_entries() {
        let res = r.tools.results.get(tool);
        let completed = res.map_or(0, |x| x.success + x.failure + x.denied);
        if res.is_none_or(|x| x.failure > 0 || x.denied > 0) || completed != *calls {
            issues.insert(tool.clone(), [res.map_or(0, |x| x.failure), res.map_or(0, |x| x.denied), completed]);
        }
        if let Some(c) = res.and_then(|x| x.causes.as_ref()).filter(|c| !c.is_empty()) {
            causes.insert(tool.clone(), c.clone());
        }
    }
    let name = anon.free_text(r.name.as_deref());
    let first = anon.free_text(r.first_user_message.as_deref());
    let t = &r.tokens;
    let a = &r.analysis;
    SessionSummary {
        id: r.id.clone(),
        client: r.client.clone(),
        project: anon.project(&r.project),
        project_label: anon.project_label(&r.project),
        project_source: r.project_source,
        branch: anon.branch(r.branch.as_deref()),
        person: anon.person(r.person.as_ref().and_then(|p| p.as_deref())),
        name: name.filter(|x| !x.is_empty()).map(|x| truncate(Some(&x), SUMMARY_TEXT_CHARS)),
        first_user_message: first.filter(|x| !x.is_empty()).map(|x| truncate(Some(&x), SUMMARY_TEXT_CHARS)),
        created_at: r.created_at.clone(),
        updated_at: r.updated_at.clone(),
        duration_ms: r.duration_ms,
        active_ms: r.active_ms,
        turns: r.turns,
        autopilot_continuations: r.autopilot_continuations,
        empty: r.empty,
        models: r.models.clone(),
        tokens: TokenSummary {
            input: t.input,
            output: t.output,
            cache_read: t.cache_read,
            cache_write: t.cache_write,
            reasoning: t.reasoning,
            premium_requests: t.premium_requests,
            nano_aiu: t.nano_aiu,
            requests: t.requests,
            source: t.source,
        },
        coverage: coverage_of(t.input, t.output, t.source.as_str()).to_string(),
        by_model,
        tools: ToolsSummary {
            total: r.tools.total,
            by_name: r.tools.by_name.clone(),
            internal: r.tools.internal.total,
            mcp: r.tools.mcp.clone(),
            issues,
            causes: Some(causes),
            durations: r.tools.durations.clone(),
            outliers: r.tools.duration_outliers.clone(),
        },
        exec: exec_summary(r),
        friction_detail: friction_detail_summary(r),
        todos: r.todos.clone(),
        skills,
        agents: AgentsSummary { total: r.agents.len() as i64, failed: r.agents.iter().filter(|a| a.status == AgentStatus::Failed).count() as i64, by_name: agents_by_name },
        hooks: HooksSummary { total: r.hooks.total, by_type: r.hooks.by_type.clone() },
        instructions,
        lines: r.lines.clone(),
        wiki: WikiSummary { index_reads: r.wiki.index_reads, page_reads: r.wiki.page_reads.len() as i64, skill_calls: r.wiki.skill_calls.len() as i64, writes: r.wiki.writes },
        friction: r.friction.clone(),
        skill_chars,
        instruction_versions: r.instructions.iter().map(|i| (i.content_hash.clone(), i.chars, i.injections)).collect(),
        analysis: AnalysisSummary { files_reedited: a.files_reedited, extra_edits: a.extra_edits, max_consecutive_failures: a.max_consecutive_failures, turns: a.turn_tools.len() as i64 },
        turn_rows: a.turn_stats.as_ref().filter(|x| !x.is_empty()).map(|_| turn_tuples(r)),
        files: FilesSummary { changed: r.files.changed.len() as i64, created: r.files.created.len() as i64, deleted: r.files.deleted.len() as i64, session_state: r.files.session_state },
        href: detail_href(&r.id),
        // 根拠の自由記述は HTML 本体に埋め込まない(詳細ページだけ)。伏せ字モードでは要約も出さない
        judgment: judgment.map(|j| JudgmentSummary { rationale: None, task_summary: if anon.enabled { None } else { j.task_summary.clone() }, ..j.clone() }),
        turn_verdicts: None,
        retention: None,
        memo: None,
    }
}

