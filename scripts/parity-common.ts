// 突き合わせのスクリプト(parity.ts・parity-lib.ts)が共用する、JSON の値の比べ方。
// - 数値は相対 1e-9 まで同じとみなす。キーの順も見る(TS がオブジェクトを組み立てた順と同じかを確かめるため)
// - ignoreKeys はどの深さでも比べないキー、ignorePaths は場所を決めて比べない値([*] は配列のどの添字にも当たる)

export interface CmpOptions {
  /** 差をここまで集めたら止める */
  maxDiffs: number;
  /** どの深さでも比べないキー */
  ignoreKeys?: ReadonlySet<string>;
  /** 比べない値の JSON パス */
  ignorePaths?: readonly string[];
  /** Rust 側の文字列を比べる前に読み替える(出力先のパスなど) */
  mapString?: (s: string) => string;
}

/** ignorePaths に当たるか([*] は配列のどの添字にも当たる) */
export const ignoredPath = (ignore: readonly string[], path: string): boolean => ignore.includes(path) || ignore.includes(path.replace(/\[\d+\]/g, '[*]'));

/** a(TS)と b(Rust)を比べ、差を out に足す */
export function cmpJson(a: unknown, b: unknown, path: string, out: string[], o: CmpOptions): void {
  const ignore = o.ignorePaths ?? [];
  if (out.length >= o.maxDiffs || ignoredPath(ignore, path)) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return;
    const d = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);
    if (d > 1e-9) out.push(`${path}: ${a} ≠ ${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    const bb = typeof b === 'string' && o.mapString ? o.mapString(b) : b;
    if (a !== bb) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 200)} ≠ ${JSON.stringify(b)?.slice(0, 200)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: 配列とオブジェクトが違う`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: 長さ ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) cmpJson(a[i], b[i], `${path}[${i}]`, out, o);
    return;
  }
  const kept = (k: string): boolean => !o.ignoreKeys?.has(k) && !ignoredPath(ignore, `${path}.${k}`);
  const ka = Object.keys(a as object).filter(kept);
  const kb = Object.keys(b as object).filter(kept);
  const missing = ka.filter((k) => !kb.includes(k));
  const extra = kb.filter((k) => !ka.includes(k));
  if (missing.length) out.push(`${path}: Rust に無いキー ${missing.join(', ')}`);
  if (extra.length) out.push(`${path}: Rust にだけあるキー ${extra.join(', ')}`);
  if (!missing.length && !extra.length && ka.join('\0') !== kb.join('\0')) out.push(`${path}: キーの順が違う TS[${ka.join(',')}] Rust[${kb.join(',')}]`);
  for (const k of ka) if (kb.includes(k)) cmpJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out, o);
}

/** 2 つの文字列の最初に違う場所(前後の文脈つき) */
export function firstTextDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const line = a.slice(0, i).split('\n').length;
  const ctx = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 60), i + 100));
  return `${line} 行目付近(文字 ${i})\n      TS:   ${ctx(a)}\n      Rust: ${ctx(b)}`;
}
