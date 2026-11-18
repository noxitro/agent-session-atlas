// 秘密情報らしい文字列(API キー・トークンなど)を伏せる。
// もとは packages/report/src/transcript.ts にあり、失敗の台帳(normalize.ts)でも使うためここへ移した。
// transcript.ts の SECRET_PATTERNS・redactSecrets の名前でも使える。

/**
 * API キー・トークンらしい形(種類名, 正規表現)。偽陽性はありうるので、伏せたうえで件数を出す。
 * 送り先のフォルダの検査(group-upload.ts の scanSecrets)も、この並びで数える
 */
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

/**
 * 形の決まらない秘密(伏せるときだけ使う。送り先の検査には数えない)。1 つめの組は残し、その後ろを伏せる。
 * - URL の認証情報: scheme://user:pass@ の user:pass
 * - 名前の付いた値: password=… / "api_key": "…" / GITHUB_TOKEN=… の値(既に伏せた [伏せました: …] は除く)
 */
const CONTEXT_PATTERNS: readonly [string, RegExp][] = [
  ['URL の認証情報', /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@'`<>]+:[^\s/@'`<>]+@/gi],
  ['名前の付いた秘密の値', /([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?[ \t]*[:=][ \t]*["']?)[^\s"'`&,;[\]{}()<>][^\s"'`&,;\]{}()<>]{2,}/gi],
];

/**
 * 秘密情報らしい文字列を [伏せました: 種類] に置き換え、件数を返す。
 * 上限で切る前の全文に掛けること(途中で切れた鍵は形に当たらず残る)
 */
export function redactSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const [label, re] of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      hits++;
      return `[伏せました: ${label}]`;
    });
  }
  for (const [label, re] of CONTEXT_PATTERNS) {
    out = out.replace(re, (_m, keep: string) => {
      hits++;
      return `${keep}[伏せました: ${label}]`;
    });
  }
  return { text: out, hits };
}
