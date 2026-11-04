// 数値・日時の表示(日本語、桁区切り)。atlas.html と詳細ページで共用する。

const intFmt = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const decFmt = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });

/** 桁区切りの整数。null は「記録なし」 */
export function int(n: number | null | undefined, missing = '記録なし'): string {
  return n == null || Number.isNaN(n) ? missing : intFmt.format(n);
}

export function dec(n: number | null | undefined, missing = '記録なし'): string {
  return n == null || Number.isNaN(n) ? missing : decFmt.format(n);
}

/** 大きな数を 万 / 億 で短く(グラフの軸・ラベル用) */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return `${decFmt.format(Math.round((n / 1e8) * 10) / 10)}億`;
  if (a >= 1e4) return `${decFmt.format(Math.round((n / 1e4) * 10) / 10)}万`;
  return decFmt.format(Math.round(n * 100) / 100);
}

/** ミリ秒を「3時間12分」「45分」「30秒」に */
export function duration(ms: number | null | undefined, missing = '不明'): string {
  if (ms == null || Number.isNaN(ms)) return missing;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h}時間${m}分` : `${h}時間`;
  return `${decFmt.format(Math.round((h / 24) * 10) / 10)}日`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** ISO 文字列をローカル時刻の YYYY-MM-DD HH:mm に */
export function dateTime(iso: string | null | undefined, missing = '日時不明'): string {
  if (!iso) return missing;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return missing;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function date(iso: string | null | undefined, missing = '日時不明'): string {
  if (!iso) return missing;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return missing;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM を「2026年7月」に */
export function month(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${m[1]}年${Number(m[2])}月` : key;
}

export function percent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  const p = (part / whole) * 100;
  return `${p < 10 && p > 0 ? decFmt.format(Math.round(p * 10) / 10) : intFmt.format(Math.round(p))}%`;
}

/** 文字列を n 文字(コードポイント)で切る */
export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  const cps = [...s.replace(/\s+/g, ' ').trim()];
  return cps.length > n ? `${cps.slice(0, n).join('')}…` : cps.join('');
}

/**
 * パスを区切り(\ と /)の直後で分けた断片。表示では断片の間に <wbr> を入れ、狭い欄でも区切りの位置で折り返す
 * (「C:\work\my_projec / t」のように名前の途中で切れないように)。つなげると元の文字列に戻る
 */
export function pathParts(s: string): string[] {
  return s.split(/(?<=[\\/])/);
}

/**
 * 表示用のモデル名。「<UUID>/claude-haiku-5.5」のようなプレフィックス付きの ID は最後の「/」以降に短縮する
 * (集計キーは変えない。元の ID は title 属性で見せる)。'(unknown)' は「不明」
 */
export function modelLabel(id: string): string {
  if (id === '(unknown)') return '不明';
  const i = id.lastIndexOf('/');
  return i >= 0 && i < id.length - 1 ? id.slice(i + 1) : id;
}

/** 待ち時間・所要時間の表示(850ms / 1.2秒 / 3分)。null は「—」 */
export function msLabel(v: number | null | undefined, missing = '—'): string {
  if (v == null || Number.isNaN(v)) return missing;
  if (v < 1000) return `${intFmt.format(Math.round(v))}ms`;
  if (v < 60_000) return `${decFmt.format(Math.round(v / 100) / 10)}秒`;
  return duration(v, missing);
}

/** 共通の書き出しとみなす最短の長さ(文字)。これより短い一致は省かない */
const SHARED_LEAD_MIN = 20;
/** 省いたあとに残す書き出しの長さ(文字。何の依頼かの手掛かりとして先頭だけ残す) */
const SHARED_LEAD_KEEP = 10;
/** 区切りとみなす文字(空白・和文の句読点と閉じ括弧・パスの区切り)。英数の記号は `nox::io` のように語の中に出るので含めない */
const LEAD_BREAK = /[\s、。，．：；！？）」』/\\]/u;

/**
 * 一覧の題名を見分けるための情報。書き出しが他の行と SHARED_LEAD_MIN 字以上同じなら、違いが始まる位置(cut。
 * 直前の区切りまで最大 12 字戻す)を返し、表示では splitLead で先頭の手掛かりと「…」のあとに cut から先を出す。
 * same は同じ題名(空白の違いを除いてまったく同じ)の件数。まったく同じ題名どうしは縮めても見分けられないので、件数の印で知らせる
 */
export function sharedLeads(texts: readonly string[]): { cut: number; same: number }[] {
  const cps = texts.map((t) => [...t.replace(/\s+/g, ' ').trim()]);
  const keys = cps.map((c) => c.join(''));
  const count = new Map<string, number>();
  for (const k of keys) count.set(k, (count.get(k) ?? 0) + 1);
  // 違う題名どうしで比べる(まったく同じ題名どうしの一致は全文に及び、違いの位置が分からなくなる)
  const uniq = [...count.keys()].sort().map((k) => [...k]);
  const lcp = (a: string[], b: string[]): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const shared = new Map<string, number>();
  uniq.forEach((c, k) => shared.set(c.join(''), Math.max(k > 0 ? lcp(c, uniq[k - 1]) : 0, k < uniq.length - 1 ? lcp(c, uniq[k + 1]) : 0)));
  return cps.map((c, i) => {
    const same = count.get(keys[i]) ?? 1;
    const n = shared.get(keys[i]) ?? 0;
    if (n < SHARED_LEAD_MIN || n >= c.length) return { cut: 0, same };
    let cut = n;
    for (let k = n; k > n - 12 && k > SHARED_LEAD_KEEP; k--) {
      if (LEAD_BREAK.test(c[k - 1])) {
        cut = k;
        break;
      }
    }
    return { cut, same };
  });
}

/** sharedLeads の cut で題名を分ける。lead は先頭 SHARED_LEAD_KEEP 字まで(区切りがあればそこまで)に「…」を付けたもの、rest は cut から先を n 字で切ったもの */
export function splitLead(text: string, cut: number, n: number): { lead: string; rest: string } {
  const c = [...text.replace(/\s+/g, ' ').trim()];
  let keep = Math.min(SHARED_LEAD_KEEP, cut);
  for (let k = keep; k >= 4; k--) {
    if (LEAD_BREAK.test(c[k - 1] ?? '')) {
      keep = k;
      break;
    }
  }
  // 区切りまで戻れず句読点から始まるとき(「…ください」と「…ください。」の違い)は句読点を飛ばす
  let from = cut;
  while (from < c.length - 1 && LEAD_BREAK.test(c[from])) from++;
  return { lead: `${c.slice(0, keep).join('').trimEnd()}…`, rest: truncate(c.slice(from).join(''), n) };
}
