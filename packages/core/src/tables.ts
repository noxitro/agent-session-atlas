// 表計算ソフトで開く CSV(依頼ごと・セッションごと)。Excel が UTF-8 と判断できるよう先頭に BOM を付け、行末は CRLF。
// 列の並びと見出しはここだけで決める(atlas metrics の out/tables/ と、グループの書き出しが同じものを使う)。
import { isEmptySession } from './metrics.ts';
import { followedByFix, isStuck, MISMATCH_LABEL, OUTCOME_LABEL, PHASE_LABEL, REQUEST_KIND_LABEL, sessionTurns, type Mismatch, type Outcome, type RequestKind } from './turns.ts';
import { TOOL_KINDS, type SessionRecord, type ToolKind } from './types.ts';
import { RETENTION_STATUS_LABEL, RETENTION_STATUSES, UNATTRIBUTABLE_REASON_LABEL, type RetentionStatus, type SessionRetention } from './vcs-retention.ts';

const TOOL_KIND_LABEL: Record<ToolKind, string> = { read: '読む', edit: '編集', verify: '検証', git: 'git', shell: 'シェル', plan: '計画', web: 'Web', delegate: '委任', other: 'その他' };

/** Excel が UTF-8 と判断するための印 */
const BOM = String.fromCharCode(0xfeff);

export type Cell = string | number | boolean | null | undefined;

/** 表 1 つ(見出しと行)。CSV と SQLite が同じものを使う */
export interface Table {
  header: string[];
  rows: Cell[][];
}

/** 段階 2 の依頼ごとの判定(turn-judgments.json の 1 項目のうち CSV に載せるもの) */
export interface TurnVerdictLike {
  kind: RequestKind;
  outcome: Outcome;
  mismatch: Mismatch | null;
  phase: string;
  confidence: number;
  note: string;
}
/** セッション ID → 依頼番号 → 判定 */
export type VerdictMap = Map<string, Map<number, TurnVerdictLike>>;

/**
 * CSV の 1 セル(, " 改行を含むものは "" で囲む。null / undefined は空)。
 * 文字列が = + - @ タブ・改行で始まるときは先頭に ' を足す(表計算ソフトが式として解釈しないように。OWASP の CSV Injection)
 */
export function csvCell(v: Cell): string {
  if (v == null) return '';
  const s = typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return `${BOM}${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const sec = (ms: number | null | undefined): number | null => (ms == null ? null : Math.round(ms / 1000));
const aiu = (nano: number | null | undefined): number | null => (nano == null ? null : Math.round((nano / 1e9) * 1000) / 1000);
/** 依頼文は 1 行にして先頭だけ(表で読める長さ) */
const oneLine = (s: string, n = 200): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return [...t].length > n ? `${[...t].slice(0, n).join('')}…` : t;
};

/** 依頼(ターン)ごとの CSV。空のセッションは除く。verdicts があれば LLM の判定の列を足す(判定の無い依頼は空) */
export function turnsCsv(sessions: SessionRecord[], verdicts: VerdictMap | null = null): string {
  const t = turnsTable(sessions, verdicts);
  return toCsv(t.header, t.rows);
}

/** 依頼(ターン)ごとの表(turnsCsv の中身) */
export function turnsTable(sessions: SessionRecord[], verdicts: VerdictMap | null = null): Table {
  const header = [
    'セッションID',
    'セッション名',
    'プロジェクト',
    '依頼番号',
    '開始',
    '依頼の種類',
    '工程',
    '次の依頼の種類',
    '次の依頼で直し・差し戻し',
    '詰まり',
    '実働(秒)',
    '所要(秒)',
    'ツール',
    ...TOOL_KINDS.map((k) => `ツール:${TOOL_KIND_LABEL[k]}`),
    'ツールの失敗',
    '拒否',
    '失敗の連続(最長)',
    '編集',
    '再編集(前の依頼で編集したファイル)',
    '重ね編集(同じ依頼の中)',
    '中断',
    'エラー',
    'うち利用上限',
    'サブエージェントの失敗',
    '文脈圧縮',
    'ask_user',
    '入力トークン',
    '出力トークン',
    'AIU',
    '依頼文(先頭)',
    ...(verdicts ? ['判定:依頼の種類', '判定:扱い', '判定:合わなかった点', '判定:工程', '判定:確信度', '判定:理由'] : []),
  ];
  const rows: Cell[][] = [];
  for (const s of sessions) {
    if (isEmptySession(s)) continue;
    const vs = verdicts?.get(s.id);
    for (const t of sessionTurns(s)) {
      const v = vs?.get(t.index);
      rows.push([
        s.id,
        s.name ?? '',
        s.project,
        t.index,
        t.startedAt,
        REQUEST_KIND_LABEL[t.kind],
        PHASE_LABEL[t.phase],
        t.nextKind ? REQUEST_KIND_LABEL[t.nextKind] : '',
        followedByFix(t),
        isStuck(t),
        sec(t.activeMs),
        sec(t.ms),
        t.tools,
        ...TOOL_KINDS.map((k) => t.kinds[k] ?? 0),
        t.toolFailures,
        t.denied,
        t.maxConsecutiveFailures,
        t.edits,
        t.reEdits,
        t.repeatEdits ?? 0,
        t.aborts,
        t.errors,
        t.externalErrors,
        t.subagentFailures,
        t.compactions,
        t.askUser,
        t.input,
        t.output,
        aiu(t.nanoAiu),
        oneLine(t.text),
        ...(verdicts ? (v ? [REQUEST_KIND_LABEL[v.kind], OUTCOME_LABEL[v.outcome], v.mismatch ? MISMATCH_LABEL[v.mismatch] : '', v.phase, Math.round(v.confidence * 100) / 100, oneLine(v.note)] : ['', '', '', '', null, '']) : []),
      ]);
    }
  }
  return { header, rows };
}

/** セッションごとの CSV。空のセッションは除く。humanHours はセッション ID → 推定人手工数(時間。判定済みのものだけ) */
export function sessionsCsv(sessions: SessionRecord[], humanHours: Map<string, number> = new Map(), retention: ReadonlyMap<string, SessionRetention> | null = null, labels: RetentionLabels = {}): string {
  const t = sessionsTable(sessions, humanHours, retention, labels);
  return toCsv(t.header, t.rows);
}

/** 状態の名前の差し替え(atlas.config.json の vcs.labels。vcs-retention.json に入る)。無い状態は RETENTION_STATUS_LABEL */
export type RetentionLabels = Partial<Record<RetentionStatus, string>>;
const labelOf = (labels: RetentionLabels) => (k: RetentionStatus): string => labels[k] ?? RETENTION_STATUS_LABEL[k];
/** 開始時の基準の出所の言葉(記録 = ログに残った開始時の版、推定 = 開始時刻から VCS の履歴で探した版) */
const baselineCell = (r: SessionRetention): string => (r.baseline ? (r.baseline.source === 'observed' ? '記録' : '推定') : '');

/** VCS の照合の列(retention を渡したときだけ。最初の依頼の列の前に入れる) */
function retentionHeader(labels: RetentionLabels): string[] {
  const L = labelOf(labels);
  return [
    'VCS の照合',
    `${L('unattributable')}の理由`,
    'VCS',
    '開始時の基準',
    '照合した場所',
    ...RETENTION_STATUSES.map((k) => `${L(k)}(まとまり)`),
    ...RETENTION_STATUSES.map((k) => `${L(k)}(行)`),
  ];
}

function retentionCells(r: SessionRetention | undefined, labels: RetentionLabels): Cell[] {
  // 照合していないセッション(vcs-retention.json に無い)は空にする(0 と区別するため)
  if (!r) return retentionHeader(labels).map(() => null);
  const measured = r.outcome === 'measured';
  return [
    r.outcome === 'measured' ? '照合できた' : r.outcome === 'no_ai_changes' ? 'AI の変更なし' : labelOf(labels)('unattributable'),
    r.reason ? UNATTRIBUTABLE_REASON_LABEL[r.reason] : '',
    r.vcs ?? '',
    baselineCell(r),
    // computedOn が無いのは、送った側の結果が添えられておらず、どこでも照合していないもの
    r.computedOn === 'sender' ? '送った側の PC' : r.computedOn === 'local' ? 'この PC' : '照合していない',
    ...RETENTION_STATUSES.map((k) => (r.outcome === 'no_ai_changes' ? null : measured || k === 'unattributable' ? r.counts[k] : null)),
    ...RETENTION_STATUSES.map((k) => (r.outcome === 'no_ai_changes' ? null : measured || k === 'unattributable' ? r.lines[k] : null)),
  ];
}

/** AI の変更のまとまりごとの表(照合の結果。retention に入っているセッションの全部) */
export function retentionHunksTable(retention: readonly SessionRetention[], labels: RetentionLabels = {}): Table {
  const L = labelOf(labels);
  const header = ['セッションID', 'まとまり', 'パス', '状態', `${L('unattributable')}の理由`, 'VCS', '開始時の基準', ...RETENTION_STATUSES.map((k) => `${L(k)}(行)`)];
  const rows: Cell[][] = [];
  for (const r of retention)
    for (const h of r.hunks)
      rows.push([
        r.sessionId,
        h.id,
        h.path,
        L(h.status),
        h.reason ? UNATTRIBUTABLE_REASON_LABEL[h.reason] : '',
        r.vcs ?? '',
        baselineCell(r),
        ...RETENTION_STATUSES.map((k) => h.lines[k]),
      ]);
  return { header, rows };
}

/** セッションごとの表(sessionsCsv の中身) */
export function sessionsTable(sessions: SessionRecord[], humanHours: Map<string, number> = new Map(), retention: ReadonlyMap<string, SessionRetention> | null = null, labels: RetentionLabels = {}): Table {
  const header = [
    'セッションID',
    'セッション名',
    'プロジェクト',
    'クライアント',
    'ブランチ',
    '開始',
    '終了',
    '所要(分)',
    '実働(分)',
    '依頼',
    '依頼の記録',
    '詰まりのあった依頼',
    '次の依頼で直し・差し戻し',
    '応答',
    'モデル',
    '入力トークン',
    '出力トークン',
    'AIU',
    'premium request',
    'ツール',
    'ツールの失敗',
    '中断',
    'エラー',
    'サブエージェントの失敗',
    '文脈圧縮',
    '再編集したファイル',
    '余分な編集',
    '失敗の連続(最長)',
    '追加行',
    '削除行',
    '推定人手工数(時間)',
    ...(retention ? retentionHeader(labels) : []),
    '最初の依頼(先頭)',
  ];
  const min = (ms: number | null): number | null => (ms == null ? null : Math.round(ms / 6000) / 10);
  const rows: Cell[][] = [];
  for (const s of sessions) {
    if (isEmptySession(s)) continue;
    const turns = sessionTurns(s);
    rows.push([
      s.id,
      s.name ?? '',
      s.project,
      s.client ?? '',
      s.branch ?? '',
      s.createdAt,
      s.updatedAt,
      min(s.durationMs),
      min(s.activeMs),
      s.turns,
      turns.length,
      turns.filter(isStuck).length,
      turns.filter(followedByFix).length,
      s.assistantMessages,
      s.models.join(' '),
      s.tokens.input,
      s.tokens.output,
      aiu(s.tokens.nanoAiu),
      s.tokens.premiumRequests,
      s.tools.total,
      s.friction.toolFailures,
      s.friction.aborts,
      s.friction.errors,
      s.friction.subagentFailures,
      s.friction.compactions,
      s.analysis?.filesReedited ?? 0,
      s.analysis?.extraEdits ?? 0,
      s.analysis?.maxConsecutiveFailures ?? 0,
      s.lines?.source === 'none' ? null : s.lines?.added,
      s.lines?.source === 'none' ? null : s.lines?.removed,
      humanHours.get(s.id) ?? null,
      ...(retention ? retentionCells(retention.get(s.id), labels) : []),
      oneLine(s.firstUserMessage ?? ''),
    ]);
  }
  return { header, rows };
}
