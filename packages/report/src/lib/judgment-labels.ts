// 判定結果(judgments.json)の表示ラベル。atlas.html と詳細ページで共用する。

export const CATEGORY_LABEL: Record<string, string> = {
  feature: '機能追加',
  bugfix: '不具合修正',
  investigation: '調査・質問',
  refactor: 'リファクタリング',
  docs: '文書',
  ops: '環境・運用',
  other: 'その他',
};

export function categoryLabel(c: string | null | undefined): string {
  if (!c) return '未分類';
  return CATEGORY_LABEL[c] ?? c;
}

const EFFECT_LABEL: Record<string, string> = {
  '-2': '明確に悪影響',
  '-1': 'やや悪影響',
  '0': '影響なし・未使用',
  '1': 'やや役立った',
  '2': '明確に役立った',
};

export function effectLabel(score: number | null | undefined): string {
  if (score == null) return '記録なし';
  const s = score > 0 ? `+${score}` : String(score);
  return `${s}(${EFFECT_LABEL[String(score)] ?? '範囲外'})`;
}

/** 確信度(0〜1)を「確信度 60%」に */
export function confidenceLabel(c: number | null | undefined): string {
  return c == null ? '確信度 不明' : `確信度 ${Math.round(c * 100)}%`;
}

export const BACKEND_LABEL: Record<string, string> = {
  external: '外部 LLM(取り込み)',
  'copilot-cli': 'copilot -p',
  opencode: 'opencode',
  anthropic: 'Anthropic API',
};

export function backendLabel(b: string | null | undefined): string {
  if (!b) return '不明';
  return BACKEND_LABEL[b] ?? b;
}
