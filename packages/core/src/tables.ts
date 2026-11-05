// 表計算ソフトで開く CSV(依頼ごと・セッションごと)。Excel が UTF-8 と判断できるよう先頭に BOM を付け、行末は CRLF。
// 列の並びと見出しはここだけで決める(atlas metrics の out/tables/ と、グループの書き出しが同じものを使う)。
import { isEmptySession } from './metrics.ts';
import { followedByFix, isStuck, PHASE_LABEL, REQUEST_KIND_LABEL, sessionTurns } from './turns.ts';
import { TOOL_KINDS, type SessionRecord, type ToolKind } from './types.ts';

const TOOL_KIND_LABEL: Record<ToolKind, string> = { read: '読む', edit: '編集', verify: '検証', git: 'git', shell: 'シェル', plan: '計画', web: 'Web', delegate: '委任', other: 'その他' };

/** Excel が UTF-8 と判断するための印 */
const BOM = String.fromCharCode(0xfeff);

type Cell = string | number | boolean | null | undefined;

/** CSV の 1 セル(, " 改行を含むものは "" で囲む。null / undefined は空) */
export function csvCell(v: Cell): string {
  if (v == null) return '';
  const s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
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

/** 依頼(ターン)ごとの CSV。空のセッションは除く */
export function turnsCsv(sessions: SessionRecord[]): string {
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
    '再編集',
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
  ];
  const rows: Cell[][] = [];
  for (const s of sessions) {
    if (isEmptySession(s)) continue;
    for (const t of sessionTurns(s)) {
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
      ]);
    }
  }
  return toCsv(header, rows);
}

/** セッションごとの CSV。空のセッションは除く。humanHours はセッション ID → 推定人手工数(時間。判定済みのものだけ) */
export function sessionsCsv(sessions: SessionRecord[], humanHours: Map<string, number> = new Map()): string {
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
      oneLine(s.firstUserMessage ?? ''),
    ]);
  }
  return toCsv(header, rows);
}
