// セッション記録(Markdown)。1 セッションの経過を、人が読んで共有でき、LLM に渡して分析できる形に書き出す。
// - 本文はスナップショットの events.jsonl から読み直す(sessions.json には先頭・末尾 2000 字しか無い)
// - トークン・AIU・待ち時間は session-store.db の明細(assistant_usage_events)と usage_record を core の mergeUsage で合わせる
// - 既定では成功したツールの結果は入れない(容量の大半を占めるため)。--tool-output all で入れる
// - API キーらしい文字列は伏せて件数を出す(共有が目的のため。元の記録は書き換えない)
// - 伏せ字モードでは本文にも scrub(パスと既知の固有名の置換)を掛けるが、自由記述の固有名を機械的に保証はできないので先頭に注意を出す
import { existsSync } from 'node:fs';
import { isInternalTool, isUserTurn, mergeUsage, normalizeModel, parseEvents, type CopilotEvent, type DbUsageRow, type SessionRecord } from '../../core/src/index.ts';
import type { Anonymizer } from './lib/anonymize.ts';
import { dateTime, dec, duration, int } from './lib/format.ts';

export type ToolOutputMode = 'fail' | 'all' | 'none';
export const TOOL_OUTPUT_MODES: readonly ToolOutputMode[] = ['fail', 'all', 'none'];

export interface TranscriptOptions {
  anon: Anonymizer;
  generatedAt: string;
  /** ツールの結果を入れる条件(既定 fail = 失敗したときだけ) */
  toolOutput: ToolOutputMode;
  /** 依頼・応答・要約 1 件の上限(文字)。超えた分は中略して字数を書く */
  maxTextChars: number;
  /** ツールの結果 1 件の上限(文字) */
  maxToolChars: number;
  /** これ以上の空白を「待ち」として書く(ミリ秒) */
  gapMs: number;
}

export const DEFAULT_TRANSCRIPT_OPTIONS: Omit<TranscriptOptions, 'anon' | 'generatedAt'> = {
  toolOutput: 'fail',
  maxTextChars: 20_000,
  maxToolChars: 4_000,
  gapMs: 5 * 60_000,
};

export interface TranscriptResult {
  markdown: string;
  /** 読んだイベント数(events.jsonl が無ければ 0) */
  events: number;
  /** 中略した本文の数 */
  truncated: number;
  /** 伏せた秘密情報らしい文字列の数 */
  secretHits: number;
  /** 本文の出所。'events' = events.jsonl、'record' = sessions.json の抜粋のみ(スナップショットに無い) */
  source: 'events' | 'record';
}

export function transcriptFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

export function transcriptHref(id: string): string {
  return `sessions/${transcriptFileName(id)}`;
}

// ---------- 秘密情報 ----------

/** API キー・トークンらしい形(種類名, 正規表現)。偽陽性はありうるので、伏せたうえで件数を出す */
export const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ['GitHub トークン', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  ['OpenAI / Anthropic 系キー', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ['AWS アクセスキー', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slack トークン', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Google API キー', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['秘密鍵', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['Bearer トークン', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/g],
];

export function redactSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const [label, re] of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      hits++;
      return `[伏せました: ${label}]`;
    });
  }
  return { text: out, hits };
}

// ---------- 補助 ----------

const ms = (iso: string | undefined | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** 開始からの相対時刻 +h:mm:ss */
export function rel(fromMs: number | null, atMs: number | null): string {
  if (fromMs == null || atMs == null) return '+?:??:??';
  const s = Math.max(0, Math.round((atMs - fromMs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `+${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fence(text: string, lang = ''): string {
  // 本文に ``` が含まれていても壊れないよう、含まれる最長のバッククォート列より 1 つ長くする
  const runs = text.match(/`{3,}/g) ?? [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  const f = '`'.repeat(n);
  return `${f}${lang}\n${text.replace(/\s+$/, '')}\n${f}`;
}

function quote(text: string): string {
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** ツール引数の 1 行要約 */
export function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const pick = (keys: string[]): string | null => {
    for (const k of keys) if (typeof a[k] === 'string' && a[k] !== '') return a[k] as string;
    return null;
  };
  const one = pick(['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'skill', 'agent_type', 'agentType', 'description', 'prompt', 'intent']);
  const s = one ?? JSON.stringify(a);
  return s.replace(/\s+/g, ' ').slice(0, 160) + (s.length > 160 ? '…' : '');
}

function resultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.detailedContent === 'string' && r.detailedContent !== '') return r.detailedContent;
    if (typeof r.content === 'string') return r.content;
    return JSON.stringify(r);
  }
  return String(result);
}

function errorText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const code = typeof e.code === 'string' ? e.code : '';
    const msg = typeof e.message === 'string' ? e.message : JSON.stringify(e);
    return code ? `${code}: ${msg}` : msg;
  }
  return String(error);
}

interface UsageLike {
  model: string;
  at: number | null;
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  nanoAiu: number | null;
  agentId: string | null;
  ttft: number | null;
  duration: number | null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function p90(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
}

const sec = (v: number | null): string => (v == null ? '—' : `${(v / 1000).toFixed(1)} 秒`);

// ---------- 本体 ----------

/**
 * セッション記録を Markdown にする。eventsPath が無い(スナップショットに無い)ときは sessions.json の抜粋だけで組む。
 * dbUsage は session-store.db の assistant_usage_events のうちこのセッションの行。
 */
export async function renderTranscript(r: SessionRecord, eventsPath: string | null, dbUsage: DbUsageRow[], o: TranscriptOptions): Promise<TranscriptResult> {
  const { anon } = o;
  let truncated = 0;
  let secretHits = 0;

  /** 本文(自由記述)の整形: 上限で中略 → 秘密情報を伏せる → 伏せ字モードなら scrub */
  const text = (s: string, limit = o.maxTextChars): string => {
    let t = s;
    if (t.length > limit) {
      const head = Math.floor(limit * 0.7);
      const tail = limit - head;
      t = `${t.slice(0, head)}\n\n…(中略 ${int(t.length - limit)} 字)…\n\n${t.slice(t.length - tail)}`;
      truncated++;
    }
    const red = redactSecrets(t);
    secretHits += red.hits;
    return anon.enabled ? anon.scrub(red.text) : red.text;
  };
  const short = (s: string): string => (anon.enabled ? anon.scrub(s) : s);

  const events: CopilotEvent[] = [];
  const usageRecords: CopilotEvent[] = [];
  let source: TranscriptResult['source'] = 'record';
  if (eventsPath && existsSync(eventsPath)) {
    for await (const e of parseEvents(eventsPath)) {
      events.push(e);
      if (e.type === 'session.usage_record') usageRecords.push(e);
    }
    if (events.length) source = 'events';
  }

  // サブエージェントの対応表: toolCallId → 名前、agentId → toolCallId
  const agentNameByCall = new Map<string, string>();
  const callByAgentId = new Map<string, string>();
  for (const row of dbUsage) if (row.agent_id && row.parent_tool_call_id) callByAgentId.set(row.agent_id, row.parent_tool_call_id);
  for (const e of events) {
    if (e.type === 'subagent.started' && typeof e.data?.toolCallId === 'string') agentNameByCall.set(e.data.toolCallId, String(e.data.agentName ?? e.data.agentDisplayName ?? 'agent'));
    if (e.agentId && typeof e.data?.parentToolCallId === 'string') callByAgentId.set(e.agentId, e.data.parentToolCallId);
  }
  const agentOf = (e: CopilotEvent): string | null => {
    const d = e.data ?? {};
    const call = typeof d.parentToolCallId === 'string' ? d.parentToolCallId : e.agentId ? callByAgentId.get(e.agentId) : undefined;
    if (call) return agentNameByCall.get(call) ?? `agent(${call.slice(0, 8)})`;
    if (e.agentId) return `agent(${e.agentId.slice(0, 8)})`;
    return null;
  };
  const roleOfUsage = (u: UsageLike): string => {
    if (!u.agentId) return '本体';
    const call = callByAgentId.get(u.agentId);
    return (call && agentNameByCall.get(call)) ?? `agent(${u.agentId.slice(0, 8)})`;
  };

  const usage = mergeUsage(dbUsage, usageRecords).items as UsageLike[];
  const startMs = ms(r.createdAt) ?? ms(events[0]?.timestamp);

  // ---------- 見出し・概要 ----------
  const toolTotals = Object.values(r.tools.results ?? {}).reduce((a, x) => ({ failure: a.failure + x.failure, denied: a.denied + x.denied }), { failure: 0, denied: 0 });
  const name = anon.freeText(r.name);
  const title = name ? name.replace(/\s+/g, ' ').slice(0, 120) : anon.enabled ? 'セッション(伏せ字)' : r.id;
  const L: string[] = [];
  L.push(`# セッション記録: ${short(title)}`, '');
  L.push(`生成 ${dateTime(o.generatedAt)} · agent-session-atlas \`atlas export\` · 本文の出所: ${source === 'events' ? 'events.jsonl(スナップショット)' : 'sessions.json の抜粋のみ(スナップショットに記録が無い)'}`);
  if (anon.enabled)
    L.push(
      '',
      '> **伏せ字モード。** プロジェクト名・パス・リポジトリ名・ブランチは仮名に、絶対パスは `<path>` に置き換えてあります。依頼文や応答などの自由記述は機械的に置き換えただけで、本文中の固有名(相対パス、ファイル名、人名など)が残っている可能性があります。共有する前に中身を確認してください。',
    );
  L.push('');

  L.push('## 概要', '');
  const meta: [string, string][] = [
    ['セッション ID', r.id],
    ['プロジェクト', anon.projectLabel(r.project)],
    ['クライアント', r.client ?? '不明'],
    ['リポジトリ / ブランチ', `${anon.enabled ? (r.repository ? anon.project(r.project) : '—') : (r.repository ?? '—')} / ${anon.branch(r.branch) ?? '—'}`],
    ['作業フォルダ', anon.path(r.cwd) ?? (anon.enabled ? '(伏せ字)' : '—')],
    ['Copilot', r.copilotVersion ?? '不明'],
    ['開始 / 更新', `${dateTime(r.createdAt)} / ${dateTime(r.updatedAt)}`],
    ['所要時間 / 実働', `${duration(r.durationMs)} / ${duration(r.activeMs)}`],
    ['依頼 / 応答', `${int(r.turns)} / ${int(r.assistantMessages)}${r.autopilotContinuations ? `(autopilot の自動継続 ${int(r.autopilotContinuations)} 回は依頼に含めない)` : ''}`],
    ['モデル', r.models.join('、') || '不明'],
    ['トークン', `入力 ${r.tokens.input == null ? '記録なし' : int(r.tokens.input)} / 出力 ${int(r.tokens.output)} / キャッシュ読取 ${r.tokens.cacheRead == null ? '—' : int(r.tokens.cacheRead)}(出所: ${r.tokens.source})`],
    ['AI 使用量(AIU)', r.tokens.nanoAiu == null ? '記録なし' : dec(r.tokens.nanoAiu / 1e9)],
    ['ツール呼び出し', `${int(r.tools.total)}(失敗 ${int(toolTotals.failure)}・拒否 ${int(toolTotals.denied)})${r.tools.internal?.total ? `、内部ツール ${int(r.tools.internal.total)} 回は除外` : ''}`],
    ['skill / agent / hook', `${int(r.skills.length)} / ${int(r.agents.length)} / ${int(r.hooks.total)}`],
    ['摩擦', `compaction ${int(r.friction.compactions)}・中断 ${int(r.friction.aborts)}・エラー ${int(r.friction.errors)}・ツール失敗 ${int(r.friction.toolFailures)}・権限確認 ${int(r.friction.permissionRequests)}・ask_user ${int(r.friction.askUser)}`],
    ['変更行数', r.lines && r.lines.source !== 'none' ? `+${int(r.lines.added)} / −${int(r.lines.removed)}` : '記録なし'],
  ];
  L.push('| 項目 | 値 |', '|---|---|');
  for (const [k, v] of meta) L.push(`| ${k} | ${v.replace(/\|/g, '\\|')} |`);
  L.push('');

  // 役 × モデルの消費
  if (usage.length) {
    L.push('### 役 × モデルの消費', '');
    L.push('リクエスト単位の明細(session-store.db と usage_record)から。待ち時間は最初のトークンまで(TTFT)とリクエスト全体の中央値 / p90。', '');
    L.push('| 役 | モデル | リクエスト | 入力 | 出力 | キャッシュ読取 | AIU | TTFT 中央値 / p90 | 全体 中央値 / p90 |', '|---|---|---|---|---|---|---|---|---|');
    const groups = new Map<string, { role: string; model: string; n: number; input: number; output: number; cache: number; aiu: number | null; ttft: number[]; dur: number[] }>();
    for (const u of usage) {
      const role = roleOfUsage(u);
      const model = normalizeModel(u.model);
      const k = `${role}\u0000${model}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { role, model, n: 0, input: 0, output: 0, cache: 0, aiu: null, ttft: [], dur: [] }));
      g.n++;
      g.input += u.input;
      g.output += u.output;
      g.cache += u.cacheRead;
      if (u.nanoAiu != null) g.aiu = (g.aiu ?? 0) + u.nanoAiu;
      if (u.ttft != null) g.ttft.push(u.ttft);
      if (u.duration != null) g.dur.push(u.duration);
    }
    const rows = [...groups.values()].sort((a, b) => (a.role === '本体' ? -1 : b.role === '本体' ? 1 : a.role.localeCompare(b.role)) || b.n - a.n);
    for (const g of rows)
      L.push(
        `| ${g.role} | ${g.model} | ${int(g.n)} | ${int(g.input)} | ${int(g.output)} | ${int(g.cache)} | ${g.aiu == null ? '—' : dec(g.aiu / 1e9)} | ${sec(median(g.ttft))} / ${sec(p90(g.ttft))} | ${sec(median(g.dur))} / ${sec(p90(g.dur))} |`,
      );
    L.push('');
  } else {
    L.push('### 役 × モデルの消費', '', 'リクエスト単位の明細はありません(このセッションのトークンは終了時の累計か出力のみ、または記録なし)。', '');
  }

  // ツールの内訳(回数の多い順、失敗つき)
  const toolRows = Object.entries(r.tools.byName).sort((a, b) => b[1] - a[1]);
  if (toolRows.length) {
    L.push('### ツールの内訳', '');
    L.push('| ツール | 回数 | 失敗 | 拒否 |', '|---|---|---|---|');
    const res = r.tools.results ?? {};
    for (const [tool, n] of toolRows.slice(0, 25)) {
      const x = res[tool];
      L.push(`| ${tool} | ${int(n)} | ${x ? int(x.failure) : '—'} | ${x ? int(x.denied) : '—'} |`);
    }
    if (toolRows.length > 25) L.push(`| …他 ${int(toolRows.length - 25)} 種 | | | |`);
    L.push('');
  }

  // ---------- 経過 ----------
  L.push('## 経過', '');
  if (source === 'record') {
    L.push('スナップショットに events.jsonl が無いため、sessions.json に残る最初の依頼と最後の応答だけです。', '');
    const first = anon.freeText(r.firstUserMessage);
    const last = anon.freeText(r.lastAssistantMessage);
    if (first) L.push('### 最初の依頼', '', quote(text(first)), '');
    if (last) L.push('### 最後の応答', '', quote(text(last)), '');
    if (!first && !last) L.push('(本文の記録がありません)', '');
  } else {
    L.push(
      `時刻は開始からの相対(+時:分:秒)。${duration(o.gapMs)}以上の空白は「待ち」として書きます。ツールの結果は${o.toolOutput === 'all' ? '全件' : o.toolOutput === 'fail' ? '失敗したときだけ' : '入れていません'}。サブエージェントの発言とツールは \`[agent:名前]\` を付けて書きます。`,
      '',
    );
    const toolStart = new Map<string, { name: string; at: number | null; agent: string | null }>();
    const internalCalls = new Set<string>();
    let prevAt: number | null = null;
    let turnNo = 0;
    let turnStartMs: number | null = null;
    const line = (at: string | undefined, body: string): void => {
      L.push(`- ${rel(startMs, ms(at))} ${body}`);
    };
    /** 直前の依頼の本体の消費(その依頼から endMs までに記録されたリクエスト)を 1 回だけ書く */
    const flushTurn = (endMs: number | null): void => {
      if (turnNo === 0 || turnStartMs == null) return;
      const from = turnStartMs - 1000;
      const to = endMs == null ? Infinity : endMs + 1000;
      const inTurn = usage.filter((u) => !u.agentId && u.at != null && u.at >= from && u.at < to);
      if (!inTurn.length) return;
      const sum = (f: (u: UsageLike) => number) => inTurn.reduce((a, u) => a + f(u), 0);
      const aiu = inTurn.some((u) => u.nanoAiu != null) ? dec(sum((u) => u.nanoAiu ?? 0) / 1e9) : '—';
      const took = endMs != null ? `、所要 ${duration(endMs - turnStartMs)}` : '';
      L.push('', `_依頼 ${turnNo} の本体の消費: リクエスト ${int(inTurn.length)}、入力 ${int(sum((u) => u.input))}、出力 ${int(sum((u) => u.output))}、キャッシュ読取 ${int(sum((u) => u.cacheRead))}、AIU ${aiu}${took}_`, '');
    };
    for (const e of events) {
      const d = e.data ?? {};
      const at = ms(e.timestamp);
      if (prevAt != null && at != null && at - prevAt >= o.gapMs) L.push('', `_(待ち ${duration(at - prevAt)})_`, '');
      if (at != null) prevAt = at;
      const agent = agentOf(e);
      const tag = agent ? `[agent:${short(agent)}] ` : '';
      switch (e.type) {
        case 'user.message': {
          if (!agent && isUserTurn(d)) {
            flushTurn(at);
            turnNo++;
            turnStartMs = at;
            const mode = typeof d.agentMode === 'string' ? `、モード ${d.agentMode}` : '';
            L.push('', `### 依頼 ${turnNo}(${rel(startMs, at)}${mode})`, '');
            L.push(quote(text(String(d.content ?? ''))), '');
          } else if (!agent) {
            line(e.timestamp, `autopilot の自動継続(ユーザーの依頼には数えない)`);
          } else if (typeof d.content === 'string' && d.content.trim()) {
            line(e.timestamp, `${tag}委譲の指示:`);
            L.push('', quote(text(d.content)), '');
          }
          break;
        }
        case 'assistant.message': {
          const content = typeof d.content === 'string' ? d.content.trim() : '';
          const model = typeof d.model === 'string' ? normalizeModel(d.model) : null;
          const reqs = Array.isArray(d.toolRequests) ? d.toolRequests.length : 0;
          if (content) {
            line(e.timestamp, `${tag}**応答**${model ? `(${model})` : ''}${reqs ? `、続けてツール ${reqs} 件を要求` : ''}`);
            L.push('', quote(text(content)), '');
          } else if (reqs && !agent) {
            line(e.timestamp, `${model ? `(${model})` : ''}ツール ${reqs} 件を要求(本文なし)`);
          }
          break;
        }
        case 'tool.execution_start': {
          const nm = String(d.toolName ?? '(unknown)');
          if (isInternalTool(nm)) {
            if (typeof d.toolCallId === 'string') internalCalls.add(d.toolCallId);
            break;
          }
          if (typeof d.toolCallId === 'string') toolStart.set(d.toolCallId, { name: nm, at, agent });
          break;
        }
        case 'tool.execution_complete': {
          const call = typeof d.toolCallId === 'string' ? d.toolCallId : null;
          if (call && internalCalls.has(call)) break;
          const st = call ? toolStart.get(call) : undefined;
          const nm = st?.name ?? String(d.toolName ?? '(unknown)');
          if (isInternalTool(nm)) break;
          const startEv = call ? events.find((x) => x.type === 'tool.execution_start' && x.data?.toolCallId === call) : undefined;
          const args = summarizeArgs(nm, startEv?.data?.arguments);
          const dur = st?.at != null && at != null ? duration(at - st.at) : null;
          const ok = d.success !== false;
          const err = ok ? '' : errorText(d.error);
          const mcp = typeof startEv?.data?.mcpServerName === 'string' && startEv.data.mcpServerName ? ` (MCP ${startEv.data.mcpServerName})` : '';
          line(
            e.timestamp,
            `${st?.agent ? `[agent:${short(st.agent)}] ` : tag}${ok ? '✔' : '✖'} \`${nm}\`${mcp}${args ? ` ${short(redactSecrets(args).text)}` : ''}${dur ? `(${dur})` : ''}${err ? ` — 失敗: ${short(redactSecrets(err).text)}` : ''}`,
          );
          const show = o.toolOutput === 'all' || (o.toolOutput === 'fail' && !ok);
          if (show) {
            const rt = resultText(d.result);
            if (rt.trim()) L.push('', fence(text(rt, o.maxToolChars)), '');
          }
          if (call) toolStart.delete(call);
          break;
        }
        case 'subagent.started':
          line(e.timestamp, `**サブエージェント開始** \`${short(String(d.agentName ?? d.agentDisplayName ?? 'agent'))}\``);
          break;
        case 'subagent.completed':
          line(
            e.timestamp,
            `サブエージェント完了 \`${short(String(d.agentName ?? 'agent'))}\`${(() => {
              const parts = [d.durationMs != null ? duration(Number(d.durationMs)) : null, d.totalTokens != null ? `トークン ${int(Number(d.totalTokens))}` : null, d.totalToolCalls != null ? `ツール ${int(Number(d.totalToolCalls))} 回` : null].filter(Boolean);
              return parts.length ? `(${parts.join('、')})` : '';
            })()}`,
          );
          break;
        case 'subagent.failed':
          line(e.timestamp, `**サブエージェント失敗** \`${short(String(d.agentName ?? 'agent'))}\`: ${short(redactSecrets(String(d.error ?? d.message ?? '')).text).slice(0, 300)}`);
          break;
        case 'session.compaction_start':
          line(e.timestamp, `compaction 開始(文脈 ${int(Number(d.conversationTokens ?? 0))} + system ${int(Number(d.systemTokens ?? 0))} + ツール定義 ${int(Number(d.toolDefinitionsTokens ?? 0))} トークン)`);
          break;
        case 'session.compaction_complete': {
          line(
            e.timestamp,
            `compaction 完了${d.success === false ? '(失敗)' : ''}${d.preCompactionTokens != null ? `、圧縮前 ${int(Number(d.preCompactionTokens))} トークン` : ''}${d.compactionTokensUsed != null ? `、compaction 自体の消費 ${int(Number(d.compactionTokensUsed))}` : ''}`,
          );
          if (typeof d.summaryContent === 'string' && d.summaryContent.trim()) L.push('', '<details><summary>compaction の要約</summary>', '', quote(text(d.summaryContent)), '', '</details>', '');
          break;
        }
        case 'permission.requested':
          line(e.timestamp, `権限の確認を要求${typeof d.toolName === 'string' ? ` \`${d.toolName}\`` : ''}${typeof d.kind === 'string' ? `(${d.kind})` : ''}`);
          break;
        case 'permission.completed': {
          const kind = typeof d.result?.kind === 'string' ? d.result.kind : typeof d.result === 'string' ? d.result : '(unknown)';
          line(e.timestamp, `権限の確認の結果: ${kind}`);
          break;
        }
        case 'session.error':
          line(e.timestamp, `**エラー** ${String(d.errorType ?? '')}${d.statusCode != null ? ` (HTTP ${d.statusCode})` : ''}${typeof d.message === 'string' ? `: ${short(redactSecrets(d.message).text).slice(0, 300)}` : ''}`);
          break;
        case 'abort':
          line(e.timestamp, `**中断** ${typeof d.reason === 'string' ? short(d.reason).slice(0, 300) : ''}`);
          break;
        case 'session.mode_changed':
          line(e.timestamp, `モード変更 ${String(d.previousMode ?? '?')} → ${String(d.newMode ?? '?')}`);
          break;
        case 'session.model_change':
          line(e.timestamp, `モデル変更 ${String(d.previousModel ?? '?')} → ${String(d.newModel ?? '?')}${d.reasoningEffort ? `(推論強度 ${String(d.reasoningEffort)})` : ''}`);
          break;
        case 'session.task_complete':
          line(e.timestamp, `**タスク完了**${d.success === false ? '(失敗)' : ''}`);
          if (typeof d.summary === 'string' && d.summary.trim()) L.push('', quote(text(d.summary)), '');
          break;
        case 'session.resume':
          line(e.timestamp, 'セッション再開');
          break;
        case 'session.shutdown': {
          flushTurn(at);
          turnNo = 0;
          const cc = d.codeChanges;
          line(
            e.timestamp,
            `**セッション終了**${cc && typeof cc === 'object' ? `: 変更 +${int(Number(cc.linesAdded ?? 0))} / −${int(Number(cc.linesRemoved ?? 0))} 行${Array.isArray(cc.filesModified) ? `、ファイル ${int(cc.filesModified.length)} 件` : ''}` : ''}${d.totalPremiumRequestCost != null ? `、premium request ${dec(Number(d.totalPremiumRequestCost))}` : ''}`,
          );
          break;
        }
        default:
          break;
      }
    }
    flushTurn(prevAt);
    L.push('');
  }

  // ---------- 変更ファイル ----------
  const files = r.files;
  if (files && (files.changed.length || files.created.length || (files.deleted?.length ?? 0))) {
    L.push('## 変更したファイル', '');
    if (anon.enabled) L.push(`変更 ${int(files.changed.length)} / 作成 ${int(files.created.length)} / 削除 ${int(files.deleted?.length ?? 0)} 件(伏せ字モードのためパスは出しません)`, '');
    else {
      const list = (label: string, xs: string[]): void => {
        if (!xs.length) return;
        L.push(`### ${label}(${int(xs.length)})`, '');
        for (const f of xs.slice(0, 200)) L.push(`- \`${f}\``);
        if (xs.length > 200) L.push(`- …他 ${int(xs.length - 200)} 件`);
        L.push('');
      };
      list('変更', files.changed);
      list('作成', files.created);
      list('削除', files.deleted ?? []);
    }
  }

  // ---------- 秘密情報・分析の観点 ----------
  L.push('## 秘密情報の検査', '');
  L.push(
    secretHits
      ? `API キーやトークンらしい文字列を ${int(secretHits)} 件伏せました(\`[伏せました: 種類]\`)。偽陽性もありえますが、本物なら元の記録(~/.copilot)にも残っているので、鍵を作り直してください。`
      : 'API キーやトークンらしい文字列(GitHub / OpenAI / AWS / Slack / Google のキー、秘密鍵、JWT、Bearer)は見つかりませんでした。形式で探しているだけなので、共有する前に中身は確認してください。',
    '',
  );
  if (truncated) L.push(`本文 ${int(truncated)} 件を上限(本文 ${int(o.maxTextChars)} 字、ツール結果 ${int(o.maxToolChars)} 字)で中略しました。中略した箇所には字数を書いています。`, '');

  L.push('## 分析の観点(LLM に渡すとき)', '');
  L.push(
    'この記録を LLM に渡して振り返るときの観点です。「概要」と「経過」の数値・時刻だけを根拠にし、推測は推測と書くように指示してください。',
    '',
    '1. **時間の内訳**: 「待ち」(人の応答待ち・放置)、モデルの待ち時間(TTFT と全体)、ツールの所要時間のどれが所要時間の大半か。',
    '2. **トークンの内訳**: 役 × モデルで、どの役が入力トークンと AIU を使ったか。キャッシュ読取の比率が低いリクエストはどこか。',
    '3. **手戻り**: 同じファイルへの繰り返しの編集、同じコマンドの再実行、失敗したツールの直後に何をしたか。',
    '4. **失敗と摩擦**: ツール失敗・拒否・エラー・中断の原因(引数の誤り、権限、quota、タイムアウト)と、その後の回復にかかった時間。',
    '5. **compaction**: 前後で何が要約され、要約の後に同じ調査をやり直していないか。',
    '6. **委譲**: サブエージェントに渡した指示と戻った報告の質。本体がその報告を使ったか、やり直したか。',
    '7. **依頼の質**: 依頼文の曖昧さがどの往復を生んだか。指示ファイル(AGENTS.md 等)で防げた往復はあるか。',
    '',
  );

  return { markdown: L.join('\n'), events: events.length, truncated, secretHits, source };
}
