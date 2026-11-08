// 操作への案内の文。ボタンがあるのは atlas serve で開いた通常版だけなので、開き方で文を分ける
// (surface brief の EDIT MODE: 編集できないときは操作の代わりに 1 行の案内、伏せ字版では何も出さない)。
export interface HintContext {
  /** serve から開き、操作できる */
  editable: boolean;
  anonymized: boolean;
}

export type JudgeTarget = '工数' | '依頼ごとの採用';

/** 判定の案内(文末の「。」まで。伏せ字版では空) */
export function judgeHint(target: JudgeTarget, c: HintContext): string {
  if (c.anonymized) return '';
  if (c.editable) return `右上の「判定する…」で「${target}」を選ぶと実行できます。`;
  return `atlas.bat で開いた画面の「判定する…」から実行できます(この共有用のファイルからは実行できません)。`;
}

/** 集計し直しの案内(文末の「。」まで。伏せ字版では空) */
export function refreshHint(c: HintContext): string {
  if (c.anonymized) return '';
  if (c.editable) return '右上の「集計し直す」で入ります。';
  return 'atlas.bat で集計し直すと入ります。';
}
