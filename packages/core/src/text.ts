// 自由記述の文を比べやすい形にそろえる(依頼文のまとまり・失敗の台帳の group で使う)。
// normalizeRequest はもと packages/report/src/lib/insights.ts にあり、失敗の台帳でも使うためここへ移した。
// insights.ts の normalizeRequest の名前でも使える。

/** 依頼文の正規化: 小文字、URL・パス・数字・16 進 id を印に、記号を落とし、空白を詰める */
export function normalizeRequest(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' <url> ')
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\s"'<>|]*|(?:^|[\s(])(?:\/[\w.-]+){2,}/g, ' <path> ')
    .replace(/\b[0-9a-f]{8,}\b/g, ' <id> ')
    .replace(/\d+/g, ' <n> ')
    .replace(/[^\p{L}\p{N}<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
