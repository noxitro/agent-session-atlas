// cmd と、その中で動くプログラムの出力を文字にする(scripts/checkout-smoke.ts が *.bat の出力を読むのに使う)。
// bat は途中で chcp 65001 に切り替えるので、1 つの出力に cp932 の行(切り替える前や、読み違えたときの cmd の文言)と
// UTF-8 の行(中の node の出力)が混ざる。丸ごとどちらかで読むと、もう片方の行が化ける(化けた行は文言で見つけられず、失敗の報告も読めない)。
// そこで 1 行ずつ、UTF-8 として正しければ UTF-8、そうでなければ cp932 で読む。
// 行は 0x0A で分ける(cp932 の 2 バイト目は 0x40〜0xFC なので、文字の途中で切れない)
const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp932 = new TextDecoder('shift_jis');

export function decodeConsole(b: Uint8Array | null | undefined): string {
  if (b == null) return '';
  const lines: string[] = [];
  for (let start = 0; start <= b.length; ) {
    const nl = b.indexOf(0x0a, start);
    const line = b.subarray(start, nl < 0 ? b.length : nl);
    try {
      lines.push(utf8.decode(line));
    } catch {
      lines.push(cp932.decode(line));
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  return lines.join('\n');
}
