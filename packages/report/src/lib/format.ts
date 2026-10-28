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
