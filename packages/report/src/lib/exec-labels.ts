// Phase 7 の表示名(atlas.html と詳細ページで共用)。記録の値そのものは変えず、表示だけ日本語にする。

const MODE: Record<string, string> = {
  interactive: '対話(interactive)',
  plan: '計画(plan)',
  autopilot: 'autopilot',
  '(unknown)': '不明(イベントログ無し)',
};
const INITIATOR: Record<string, string> = {
  user: '利用者の依頼',
  agent: 'エージェント',
  'sub-agent': 'サブエージェント',
  compaction: 'compaction',
  '(unknown)': '記録なし',
};
const SUBAGENT_FAILURE: Record<string, string> = {
  quota: '利用上限(402・quota)',
  rate_limit: '回数制限(429・rate limit)',
  aborted: '中断',
  no_response: '応答なし',
  other: 'その他',
  unknown: '理由の記録なし',
};
const TODO_STATUS: Record<string, string> = {
  pending: '未着手',
  in_progress: '進行中',
  done: '完了',
  blocked: '保留(blocked)',
};
export const TODO_STATUS_ORDER = ['done', 'in_progress', 'pending', 'blocked'];

export const modeLabel = (k: string): string => MODE[k] ?? k;
export const initiatorLabel = (k: string): string => INITIATOR[k] ?? k;
export const effortLabel = (k: string): string => (k === '(unknown)' ? '不明' : k);
export const subagentFailureLabel = (k: string): string => SUBAGENT_FAILURE[k] ?? k;
export const todoStatusLabel = (k: string): string => TODO_STATUS[k] ?? k;
export const errorTypeLabel = (k: string): string => (k === '(unknown)' ? '種別の記録なし' : k);
