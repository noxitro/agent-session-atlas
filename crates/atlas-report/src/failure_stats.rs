//! 失敗の台帳(analysis.failures)の集計(build 時。failures.html と failures.json に出す)。
//!
//! - 単位: ツール・MCP サーバー・エージェント・skill・指示文の版と、似たエラー文のまとまり(group)。
//! - 対象は、空でなく台帳のあるセッションだけ。台帳の無い古い記録は「台帳なし」として別に数え、失敗 0 件とは扱わない
//!   (分子と分母を同じセッションにそろえるため、分母にも入れない)。
//! - 失敗と拒否の回数と、結果の記録がある呼び出しの数(率の分母)は tools.results から取る。台帳の行は 1 セッション
//!   failure_ledger::MAX_ROWS 件までなので、行から数えるのは要因・まとまり・その後の内訳だけにする。
//! - ツールと MCP は、失敗がどの呼び出しのものか分かる。skill と指示文の版は、失敗をそれに結び付ける記録が無いので、
//!   「それを使ったセッション」の単位で数える(相関まで)。skill は、最初に呼んだ後の失敗の行も数える。
//! - 閾値は下の thresholds に定数で置く。件数で変わる判断(率を出すか)は、どの環境でも実行時にこの閾値で決める。

use atlas_core::collate::locale_compare;
use atlas_core::jsdate;
use atlas_core::types::{CallOutcome, FailureKind, NextKind, SessionRecord, ToolFailure};
use indexmap::IndexMap;
use serde::Serialize;
use std::collections::HashSet;

pub mod thresholds {
    /// 率を出すのに要る、結果の記録がある呼び出しの数。これより少ないと 1 回の失敗で率が 5 ポイントを超えて動くので、率は出さず回数だけにする
    pub const MIN_CALLS: i64 = 20;
    /// セッションの単位で比べるもの(skill・指示文の版)に要るセッション数(改善点の分析の MIN_SESSIONS と同じ)
    pub const MIN_SESSIONS: i64 = crate::insights::thresholds::MIN_SESSIONS as i64;
    /// 「繰り返している失敗」に挙げる、同じまとまりの回数(改善点の分析の MIN_REPEAT と同じ。2 回は偶然の呼び直しでも起きる)
    pub const MIN_REPEAT: i64 = crate::insights::thresholds::MIN_REPEAT as i64;
    /// ページの 1 つの表に載せる行の数(ページを読める長さに保つ。載せなかった数は表の下に出し、全件は failures.json に書く)
    pub const TOP_ROWS: usize = 50;
    /// 1 行に添える内訳(要因・まとまり・ツール)の数
    pub const TOP_DETAILS: usize = 3;
    /// まとまりに添える、例のセッションの数
    pub const EXAMPLE_SESSIONS: usize = 3;
}
use thresholds as T;

/// 名前と回数(内訳の 1 項目)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Count {
    pub key: String,
    pub n: i64,
}

/// 集計の対象と、載っていないもの
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    /// 空でないセッション
    pub sessions: i64,
    /// うち失敗の台帳のあるセッション(集計の対象)
    pub with_ledger: i64,
    /// うち台帳の無い古い記録(集計に入らない)
    pub without_ledger: i64,
    /// 台帳の無い記録にある失敗と拒否の数(tools.results から。1 件ごとの中身は分からない)
    pub without_ledger_failures: i64,
    /// 対象のセッションの、結果の記録がある呼び出し
    pub completed: i64,
    pub failures: i64,
    pub denied: i64,
    /// 台帳の行の数
    pub rows: i64,
    /// 行数の上限で台帳に残さなかった数
    pub dropped: i64,
}

/// ツール・MCP サーバーごと
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitStat {
    pub key: String,
    /// 結果の記録がある呼び出し(成功 + 失敗 + 拒否)
    pub completed: i64,
    pub failures: i64,
    pub denied: i64,
    /// (失敗 + 拒否) / completed。completed が MIN_CALLS 未満なら None
    pub rate: Option<f64>,
    /// 失敗か拒否のあったセッション
    pub sessions: i64,
    /// 失敗の要因(多い順。台帳の行から)
    pub causes: Vec<Count>,
    /// 似たエラー文のまとまり(多い順。台帳の行から)
    pub groups: Vec<Count>,
    /// 同じ引数で呼び直した回数と、そのうち成功した回数
    pub retries: i64,
    pub retries_ok: i64,
}

/// エージェントごと(本体は main: true)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStat {
    pub name: String,
    pub main: bool,
    /// サブエージェントの起動の回数(本体は None)
    pub runs: Option<i64>,
    /// 失敗か拒否のあった起動の回数(本体は None)
    pub runs_with_failures: Option<i64>,
    /// 失敗か拒否のあったセッション
    pub sessions: i64,
    /// 台帳の行から数えた失敗と拒否
    pub failures: i64,
    pub denied: i64,
    pub causes: Vec<Count>,
    pub groups: Vec<Count>,
    pub retries: i64,
    pub retries_ok: i64,
}

/// セッションの単位で数えるもの(skill・指示文の版)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUnitStat {
    /// skill の名前か、指示文の版のハッシュ
    pub key: String,
    /// それを使ったセッション(台帳のあるもの)
    pub sessions: i64,
    pub completed: i64,
    /// 失敗 + 拒否
    pub failed: i64,
    /// failed / completed。セッションが MIN_SESSIONS 未満か、completed が MIN_CALLS 未満なら None。other_rate が出せないときも None(比べるための率なので)
    pub rate: Option<f64>,
    /// それを使わなかったセッションと、その率(同じ条件で None)
    pub other_sessions: i64,
    pub other_rate: Option<f64>,
    /// skill だけ: そのセッションで最初に呼んだ後の、台帳の行の数(時刻の無い行は数えない。呼んだ時刻がどのセッションでも分からなければ無い)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows_after: Option<i64>,
    /// まとまり(多い順)。skill は最初に呼んだ後の行、指示文の版はそのセッションの行
    pub groups: Vec<Count>,
}

/// 似たエラー文のまとまり
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupStat {
    pub group: String,
    pub n: i64,
    pub sessions: i64,
    /// うち拒否
    pub denied: i64,
    /// 失敗の要因(多い順)
    pub causes: Vec<Count>,
    pub tools: Vec<Count>,
    /// 最初に出た行のエラー文(記録のまま)
    pub example: String,
    /// 例のセッション(出た順に EXAMPLE_SESSIONS 件まで)
    pub example_sessions: Vec<String>,
    pub retries: i64,
    pub retries_ok: i64,
}

/// 失敗の後に何をしたか(台帳の行の内訳)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextStat {
    pub rows: i64,
    /// 同じツールを同じ引数で呼び直した(と、そのうち成功)
    pub retries: i64,
    pub retries_ok: i64,
    /// 別のツールか別の引数で続けた(と、そのうち次の呼び出しが成功)
    pub moved_on: i64,
    pub moved_on_ok: i64,
    /// 次の呼び出しより先に利用者の依頼が来た
    pub user: i64,
    /// 同じエージェントの呼び出しがその後に無い
    pub end: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureStats {
    pub coverage: Coverage,
    /// 回数が MIN_REPEAT 以上のまとまり(多い順)と、その数
    pub groups: Vec<GroupStat>,
    pub groups_total: i64,
    /// 失敗か拒否のあったツール(多い順)と、その数
    pub tools: Vec<UnitStat>,
    pub tools_total: i64,
    pub mcp: Vec<UnitStat>,
    pub mcp_total: i64,
    pub agents: Vec<AgentStat>,
    pub agents_total: i64,
    /// 使ったセッションで失敗か拒否のあった skill(多い順)
    pub skills: Vec<SessionUnitStat>,
    pub skills_total: i64,
    pub instructions: Vec<SessionUnitStat>,
    pub instructions_total: i64,
    pub next: NextStat,
}

/// 名前ごとの回数を、多い順(同じ回数は出た順)に n 件
#[derive(Default)]
struct Tally(IndexMap<String, i64>);

impl Tally {
    fn add(&mut self, key: &str) {
        *self.0.entry(key.to_string()).or_insert(0) += 1;
    }
    fn top(&self, n: usize) -> Vec<Count> {
        let mut v: Vec<Count> = self.0.iter().map(|(k, n)| Count { key: k.clone(), n: *n }).collect();
        v.sort_by(|a, b| b.n.cmp(&a.n));
        v.truncate(n);
        v
    }
}

/// 台帳の行から数える内訳
#[derive(Default)]
struct Detail {
    causes: Tally,
    groups: Tally,
    retries: i64,
    retries_ok: i64,
}

impl Detail {
    fn add(&mut self, f: &ToolFailure) {
        if let Some(c) = f.cause.as_deref() {
            self.causes.add(c);
        }
        self.groups.add(&f.group);
        if is_retry(f) {
            self.retries += 1;
            if f.next.outcome == Some(CallOutcome::Success) {
                self.retries_ok += 1;
            }
        }
    }
}

fn is_retry(f: &ToolFailure) -> bool {
    f.next.kind == NextKind::Tool && f.next.retry == Some(true)
}

fn rate(failed: i64, completed: i64) -> Option<f64> {
    (completed >= T::MIN_CALLS && completed > 0).then(|| failed as f64 / completed as f64)
}

#[derive(Default)]
struct UnitAcc {
    completed: i64,
    failures: i64,
    denied: i64,
    sessions: i64,
    detail: Detail,
}

impl UnitAcc {
    fn finish(self, key: String) -> UnitStat {
        UnitStat {
            rate: rate(self.failures + self.denied, self.completed),
            key,
            completed: self.completed,
            failures: self.failures,
            denied: self.denied,
            sessions: self.sessions,
            causes: self.detail.causes.top(T::TOP_DETAILS),
            groups: self.detail.groups.top(T::TOP_DETAILS),
            retries: self.detail.retries,
            retries_ok: self.detail.retries_ok,
        }
    }
}

#[derive(Default)]
struct AgentAcc {
    runs: i64,
    failed_runs: HashSet<String>,
    sessions: HashSet<usize>,
    failures: i64,
    denied: i64,
    detail: Detail,
}

#[derive(Default)]
struct SessionUnitAcc {
    sessions: i64,
    completed: i64,
    failed: i64,
    rows_after: i64,
    /// 最初に呼んだ時刻の分かったセッションの数(skill だけ)
    timed: i64,
    groups: Tally,
}

#[derive(Default)]
struct GroupAcc {
    n: i64,
    sessions: Vec<String>,
    denied: i64,
    tools: Tally,
    example: String,
    detail: Detail,
}

/// 多い順(同じ数は名前の順)に並べ、数を返す。ここでは切らない(failures.json には全件を書き、ページが TOP_ROWS 件まで載せる)
fn top_rows<R>(mut v: Vec<R>, weight: impl Fn(&R) -> i64, key: impl Fn(&R) -> &str) -> (Vec<R>, i64) {
    v.sort_by(|a, b| weight(b).cmp(&weight(a)).then_with(|| locale_compare(key(a), key(b))));
    let total = v.len() as i64;
    (v, total)
}

/// 失敗の台帳を、単位ごとに集計する。records は絞り込みの後のセッション(空のセッションは数えない)
pub fn failure_stats(records: &[&SessionRecord]) -> FailureStats {
    let mut cov = Coverage::default();
    let mut tools: IndexMap<String, UnitAcc> = IndexMap::new();
    let mut mcp: IndexMap<String, UnitAcc> = IndexMap::new();
    let mut agents: IndexMap<Option<String>, AgentAcc> = IndexMap::new();
    let mut skills: IndexMap<String, SessionUnitAcc> = IndexMap::new();
    let mut instructions: IndexMap<String, SessionUnitAcc> = IndexMap::new();
    let mut groups: IndexMap<String, GroupAcc> = IndexMap::new();
    let mut next = NextStat::default();

    for (si, r) in records.iter().enumerate() {
        if r.empty {
            continue;
        }
        cov.sessions += 1;
        let completed: i64 = r.tools.results.values().map(|x| x.success + x.failure + x.denied).sum();
        let failures: i64 = r.tools.results.values().map(|x| x.failure).sum();
        let denied: i64 = r.tools.results.values().map(|x| x.denied).sum();
        let Some(ledger) = r.analysis.failures.as_deref() else {
            cov.without_ledger += 1;
            cov.without_ledger_failures += failures + denied;
            continue;
        };
        cov.with_ledger += 1;
        cov.completed += completed;
        cov.failures += failures;
        cov.denied += denied;
        cov.rows += ledger.len() as i64;
        cov.dropped += r.analysis.failures_dropped.unwrap_or(0);

        // ツール: 回数は tools.results から
        for (tool, x) in r.tools.results.iter() {
            let a = tools.entry(tool.clone()).or_default();
            a.completed += x.success + x.failure + x.denied;
            a.failures += x.failure;
            a.denied += x.denied;
            if x.failure + x.denied > 0 {
                a.sessions += 1;
            }
        }
        // MCP サーバー: そのサーバーのツールの結果を足す(結果はツール名だけが鍵なので、2 つのサーバーに同じ名前のツールがあると両方に入る)
        for (server, by_tool) in r.tools.mcp.iter() {
            let a = mcp.entry(server.clone()).or_default();
            let mut failed = 0;
            for tool in by_tool.keys() {
                if let Some(x) = r.tools.results.get(tool) {
                    a.completed += x.success + x.failure + x.denied;
                    a.failures += x.failure;
                    a.denied += x.denied;
                    failed += x.failure + x.denied;
                }
            }
            if failed > 0 {
                a.sessions += 1;
            }
        }
        // サブエージェントの起動の回数
        for a in &r.agents {
            agents.entry(Some(a.name.clone())).or_default().runs += 1;
        }

        // 台帳の行: 要因・まとまり・その後
        for f in ledger {
            tools.entry(f.tool.clone()).or_default().detail.add(f);
            if let Some(server) = f.mcp_server.as_deref().filter(|s| !s.is_empty()) {
                mcp.entry(server.to_string()).or_default().detail.add(f);
            }
            let a = agents.entry(f.agent.clone()).or_default();
            a.sessions.insert(si);
            match f.kind {
                FailureKind::Failure => a.failures += 1,
                FailureKind::Denied => a.denied += 1,
            }
            if let Some(call) = &f.agent_call {
                a.failed_runs.insert(format!("{si}:{call}"));
            }
            a.detail.add(f);

            let g = groups.entry(f.group.clone()).or_default();
            if g.n == 0 {
                g.example = f.error.clone();
            }
            g.n += 1;
            // セッションの順に回しているので、同じセッションは末尾にだけある
            if g.sessions.last() != Some(&r.id) {
                g.sessions.push(r.id.clone());
            }
            if f.kind == FailureKind::Denied {
                g.denied += 1;
            }
            g.tools.add(&f.tool);
            g.detail.add(f);

            next.rows += 1;
            match f.next.kind {
                NextKind::Tool => {
                    let ok = f.next.outcome == Some(CallOutcome::Success);
                    if f.next.retry == Some(true) {
                        next.retries += 1;
                        next.retries_ok += ok as i64;
                    } else {
                        next.moved_on += 1;
                        next.moved_on_ok += ok as i64;
                    }
                }
                NextKind::User => next.user += 1,
                NextKind::End => next.end += 1,
            }
        }

        // skill: 使ったセッションの単位。最初に呼んだ後の行も数える
        let mut first_at: IndexMap<&str, Option<i64>> = IndexMap::new();
        for s in &r.skills {
            let at = s.at.as_deref().and_then(jsdate::parse_ms);
            let e = first_at.entry(s.name.as_str()).or_insert(at);
            *e = match (*e, at) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
        }
        for (name, at) in &first_at {
            let a = skills.entry(name.to_string()).or_default();
            a.sessions += 1;
            a.completed += completed;
            a.failed += failures + denied;
            let Some(at) = at else { continue };
            a.timed += 1;
            for f in ledger {
                if f.started_at.as_deref().and_then(jsdate::parse_ms).is_some_and(|t| t >= *at) {
                    a.rows_after += 1;
                    a.groups.add(&f.group);
                }
            }
        }
        // 指示文の版: 読み込んだセッションの単位
        let mut seen: HashSet<&str> = HashSet::new();
        for i in &r.instructions {
            let h = i.content_hash.as_str();
            if !seen.insert(h) {
                continue;
            }
            let a = instructions.entry(h.to_string()).or_default();
            a.sessions += 1;
            a.completed += completed;
            a.failed += failures + denied;
            for f in ledger {
                a.groups.add(&f.group);
            }
        }
    }

    let session_unit = |key: String, a: SessionUnitAcc, with_rows_after: bool| -> SessionUnitStat {
        let other_sessions = cov.with_ledger - a.sessions;
        let enough = |sessions: i64| sessions >= T::MIN_SESSIONS;
        // 比べるための 2 つの率なので、片方が出せないときは両方出さない
        let mine = if enough(a.sessions) { rate(a.failed, a.completed) } else { None };
        let other = if enough(other_sessions) { rate(cov.failures + cov.denied - a.failed, cov.completed - a.completed) } else { None };
        let both = mine.is_some() && other.is_some();
        SessionUnitStat {
            rate: mine.filter(|_| both),
            other_rate: other.filter(|_| both),
            other_sessions,
            key,
            sessions: a.sessions,
            completed: a.completed,
            failed: a.failed,
            // 呼んだ時刻がどのセッションでも分からなければ、0 ではなく無し
            rows_after: (with_rows_after && a.timed > 0).then_some(a.rows_after),
            groups: a.groups.top(T::TOP_DETAILS),
        }
    };

    let (groups, groups_total) = top_rows(
        groups
            .into_iter()
            .filter(|(_, g)| g.n >= T::MIN_REPEAT)
            .map(|(group, g)| GroupStat {
                group,
                n: g.n,
                sessions: g.sessions.len() as i64,
                denied: g.denied,
                causes: g.detail.causes.top(T::TOP_DETAILS),
                tools: g.tools.top(T::TOP_DETAILS),
                example: g.example,
                example_sessions: g.sessions.into_iter().take(T::EXAMPLE_SESSIONS).collect(),
                retries: g.detail.retries,
                retries_ok: g.detail.retries_ok,
            })
            .collect(),
        |g| g.n,
        |g| &g.group,
    );
    let unit = |m: IndexMap<String, UnitAcc>| top_rows(m.into_iter().filter(|(_, a)| a.failures + a.denied > 0).map(|(k, a)| a.finish(k)).collect(), |u: &UnitStat| u.failures + u.denied, |u| &u.key);
    let (tools, tools_total) = unit(tools);
    let (mcp, mcp_total) = unit(mcp);
    let (agents, agents_total) = top_rows(
        agents
            .into_iter()
            .filter(|(_, a)| a.failures + a.denied > 0)
            .map(|(name, a)| {
                let main = name.is_none();
                AgentStat {
                    name: name.unwrap_or_default(),
                    main,
                    // 起動のイベントが無く、親の呼び出しだけが分かる記録では、失敗のあった起動の方が多くなる。そのときは後者に合わせる
                    runs: (!main).then_some(a.runs.max(a.failed_runs.len() as i64)),
                    runs_with_failures: (!main).then_some(a.failed_runs.len() as i64),
                    sessions: a.sessions.len() as i64,
                    failures: a.failures,
                    denied: a.denied,
                    causes: a.detail.causes.top(T::TOP_DETAILS),
                    groups: a.detail.groups.top(T::TOP_DETAILS),
                    retries: a.detail.retries,
                    retries_ok: a.detail.retries_ok,
                }
            })
            .collect(),
        |a: &AgentStat| a.failures + a.denied,
        |a| &a.name,
    );
    let (skills, skills_total) = top_rows(skills.into_iter().filter(|(_, a)| a.failed > 0).map(|(k, a)| session_unit(k, a, true)).collect(), |s: &SessionUnitStat| s.failed, |s| &s.key);
    let (instructions, instructions_total) = top_rows(instructions.into_iter().filter(|(_, a)| a.failed > 0).map(|(k, a)| session_unit(k, a, false)).collect(), |s: &SessionUnitStat| s.failed, |s| &s.key);

    FailureStats { coverage: cov, groups, groups_total, tools, tools_total, mcp, mcp_total, agents, agents_total, skills, skills_total, instructions, instructions_total, next }
}
