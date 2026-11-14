// 画面から動かした処理(ジョブ)のログから、失敗の理由を取り出す。
// atlas のコマンドは、失敗すると標準エラーに「atlas: 失敗しました: <理由>」を書いて終わる(crates/atlas-cli/src/main.rs)。
// 理由が複数行のこともあり、ATLAS_DEBUG のときはその後ろにスタックが続く。捕まえられなかった例外ではこの行が出ない。

const FAILED = 'atlas: 失敗しました: ';
/** 理由として出す文字数の上限(超えた分はログで読む) */
export const REASON_MAX = 600;

/**
 * ログの中の最後の「atlas: 失敗しました: 」から後ろを理由として返す(スタックは除く)。
 * その行が無ければ空(理由はログを読んでもらう)
 */
export function failureReason(log: readonly string[]): string {
  const i = log.findLastIndex((l) => l.startsWith(FAILED));
  if (i < 0) return '';
  const first = log[i].slice(FAILED.length);
  const lines = [first];
  for (const l of log.slice(i + 1)) {
    // ATLAS_DEBUG のときに続くスタック(「Error: <同じ文>」と「    at …」)は入れない
    if (/^\s+at \S/.test(l) || (/^\w*Error: /.test(l) && l.endsWith(first))) break;
    lines.push(l);
  }
  const text = lines.join('\n').trim();
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}
