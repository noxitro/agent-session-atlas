// ツールの失敗(tool.execution_complete の success: false)を、error の種類と文の 1 行目から要因に分ける。
// 文そのものは残さない(パス・URL・秘密が入りうるため)。分類は決まった規則で、LLM は使わない。
// 規則は上から順に見て、最初に当たったものにする(「MCP error: Request timed out」は時間切れ、のように、
// 具体的な要因を先に、どのツールにも出る言い回しを後に置く)。どれにも当たらなければ other。

/** 要因(表示の順) */
export const FAILURE_CAUSES = [
  'timeout',
  'quota',
  'network',
  'permission',
  'no_match',
  'not_found',
  'exists',
  'invalid_input',
  'unavailable',
  'no_response',
  'tool_error',
  'other',
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];
/** 要因 → 失敗の回数(失敗の無かった要因は持たない) */
export type FailureCauses = Partial<Record<FailureCause, number>>;

/** 画面に出す名前 */
export const FAILURE_CAUSE_LABELS: Record<FailureCause, string> = {
  timeout: '時間切れ',
  quota: '上限・回数制限',
  network: '通信・取得の失敗',
  permission: 'アクセス権・禁止',
  no_match: '一致なし',
  not_found: '対象が見つからない',
  exists: '既にある',
  invalid_input: '引数・書式の誤り',
  unavailable: '道具が使えない',
  no_response: '応答なし',
  tool_error: 'ツール内部のエラー',
  other: 'その他',
};

/** 何に当たると、その要因とみなすか(画面の用語集でも同じ説明を使う) */
export const FAILURE_CAUSE_HINTS: Record<FailureCause, string> = {
  timeout: 'timed out・timeout・タイムアウト',
  quota: 'quota・rate limit・too many requests・exceeded your … limit',
  network: '取得の失敗(status code)・リダイレクト・DNS・接続の拒否や切断',
  permission: 'アクセスが拒否・permission denied・EACCES・not allowed・blocked・unauthorized・forbidden',
  no_match: 'no match・置換や差分の対象の行が見つからない',
  not_found: 'does not exist・not found・no such file・ENOENT・見つかりません',
  exists: 'already exists・既に存在',
  invalid_input: 'parse error・unrecognized・invalid・required・expected・validation・out of bounds・構文',
  unavailable: '… available が無い・not running・not connected・unavailable',
  no_response: 'no response(応答が返らなかった)',
  tool_error: 'exception・KeyError や TypeError などの例外・internal error・traceback・panic',
  other: '上のどれにも当たらないもの(文が無いものを含む)',
};

const RULES: [FailureCause, RegExp][] = [
  ['timeout', /timed?[ -]?out|timeout|タイムアウト|ETIMEDOUT/i],
  ['quota', /quota|rate[ _-]?limit|too many requests|exceeded your\b.*\blimit|使用量の上限/i],
  [
    'network',
    /failed to fetch|fetch failed|status code \d|redirect|transport-level|ホストは不明|unknown host|ENOTFOUND|EAI_AGAIN|getaddrinfo|\bDNS\b|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up|network error|could not retrieve/i,
  ],
  ['permission', /access (?:is )?denied|permission denied|EACCES|EPERM|アクセスが拒否|アクセス許可|not allowed|\bblocked\b|unauthori[sz]ed|forbidden/i],
  ['no_match', /no match|failed to find expected|did not match|does not match|no occurrences?|一致しません|一致する.*ありません/i],
  ['not_found', /does not exist|doesn't exist|not exist|not found|no such|ENOENT|could not find|cannot find|can't find|見つかりません|存在しません/i],
  ['exists', /already exists?|既に存在/i],
  [
    'invalid_input',
    /parse error|error parsing|unrecognized|invalid|\brequired\b|\bexpected\b|validation|out of (?:bounds|range)|must (?:specify|be|provide)|syntax|構文|不正な|JSON at position|unknown (?:option|flag|argument)|missing (?:argument|parameter)/i,
  ],
  ['unavailable', /\bavailable\b|not running|not connected|disconnected|not started|unavailable|not initiali[sz]ed/i],
  ['no_response', /no response|empty response|produced no output/i],
  ['tool_error', /exception|KeyError|TypeError|ValueError|AttributeError|ReferenceError|RangeError|internal (?:server )?error|traceback|panic|stack trace|-32603/i],
];

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/** 利用者・権限設定による拒否か(error.code が denied か rejected) */
export function isDeniedError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'denied' || code === 'rejected';
}

/** ツールの失敗の要因(拒否は呼ぶ前に isDeniedError で分ける)。文の空でない最初の行と、failure 以外の error.code を見る */
export function classifyToolFailure(error: unknown): FailureCause {
  const first = errorText(error).split(/\r?\n/).find((l) => l.trim()) ?? '';
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const text = typeof code === 'string' && code !== 'failure' ? `${code} ${first}` : first;
  if (!text.trim()) return 'other';
  for (const [cause, re] of RULES) if (re.test(text)) return cause;
  return 'other';
}

/** 要因の回数を足す(into に、from の分を) */
export function addCauses(into: FailureCauses, from: FailureCauses | undefined): FailureCauses {
  for (const [k, n] of Object.entries(from ?? {}) as [FailureCause, number][]) into[k] = (into[k] ?? 0) + n;
  return into;
}

/** 要因を回数の多い順に(同じ回数なら表示の順) */
export function sortedCauses(causes: FailureCauses | undefined): [FailureCause, number][] {
  return (Object.entries(causes ?? {}) as [FailureCause, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || FAILURE_CAUSES.indexOf(a[0]) - FAILURE_CAUSES.indexOf(b[0]));
}
