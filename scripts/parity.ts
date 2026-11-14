// TS 版と Rust 版の atlas を同じ入力で 1 工程ずつ動かし、出力を突き合わせる(Rust 移行の確認用。docs/rust-migration.md)。
//
//   node scripts/parity.ts [--home <dir>] [--stages snapshot,extract,vcs,metrics,build] [--config <file>] [--work <dir>] [--rs <exe>] [--max-diffs <n>]
//
// - --home を省くと、e2e と同じ架空の fixture(Phase 11・12 の分も入れたもの)を作って使う。実データで比べるときは --home ~/.copilot。
// - 工程ごとに、TS 版の 1 つ前までの出力を Rust 側へ写してから同じ工程を両方で動かし、その工程で変わったファイルを比べる
//   (前の工程のずれが後ろの工程に持ち越されない)。snapshot/ は snapshot 工程の後は共有する(後ろの工程は読むだけ)。
// - JSON は値で比べる(キーの順も見る)。数値は相対 1e-9 まで同じとみなす。SQLite(.db・.sqlite)は中身(dumpSqlite)で、それ以外のファイルはバイト単位で比べる。
// - 実行のたびに変わる値(時刻・所要時間)は IGNORE_KEYS(どの深さでも)と IGNORE_PATHS(ファイルと場所を決めて。[*] は配列のどの添字にも当たる)で比べない。
// - Rust 版は既定で target/release/atlas(.exe)、無ければ target/debug/atlas(.exe)。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dateTime } from '../packages/report/src/lib/format.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS_CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const ALL_STAGES = ['snapshot', 'extract', 'vcs', 'metrics', 'build'] as const;
/**
 * 実行のたびに変わるので比べないキー(どの深さでも)。セッションの実データと同じ名前のもの(durationMs など)は入れない
 * (入れるとツールの所要時間などの本当の差を隠す)。そういうものは IGNORE_PATHS で場所を決める
 */
const IGNORE_KEYS = new Set(['generatedAt', 'builtAt', 'timingsMs']);
/**
 * ファイルごとの、実行のたびに変わるので比べない値(JSON のパス)。キーの名前がほかで実データに使われているもの
 * (セッションの createdAt など)は、どの深さでも比べないことにはせず、ここで場所を決める
 */
const IGNORE_PATHS: Record<string, readonly string[]> = {
  'snapshot/snapshot-manifest.json': ['$.createdAt'],
  'snapshot/snapshot-source.json': ['$.startedAt'],
  'snapshot/desktop.json': ['$.readAt'],
  // この PC で照合したときの照合した時刻(照合を始めた時刻)
  'vcs-retention.json': ['$.sessions[*].evaluated.at'],
};
/** IGNORE_PATHS に当たるか([*] は配列のどの添字にも当たる) */
const ignored = (ignore: readonly string[], path: string): boolean => ignore.includes(path) || ignore.includes(path.replace(/\[\d+\]/g, '[*]'));
/** 比べないファイル(実行の記録・ロックなど) */
const IGNORE_FILES = [/\.lock$/, /\.serve\.json$/, /(^|[\\/])\.built\.json$/];

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    stages: { type: 'string' },
    config: { type: 'string' },
    work: { type: 'string' },
    rs: { type: 'string' },
    'max-diffs': { type: 'string', default: '40' },
  },
});

const exe = process.platform === 'win32' ? 'atlas.exe' : 'atlas';
const rsCli = values.rs ?? [join(ROOT, 'target', 'release', exe), join(ROOT, 'target', 'debug', exe)].find((p) => existsSync(p));
if (!rsCli || !existsSync(rsCli)) {
  console.error('Rust 版の atlas が見つかりません(cargo build -p atlas-cli を先に実行してください。--rs で場所を指定できます)');
  process.exit(2);
}
const stages = (values.stages ?? ALL_STAGES.join(',')).split(',').map((s) => s.trim()) as (typeof ALL_STAGES)[number][];
for (const s of stages) if (!ALL_STAGES.includes(s)) throw new Error(`知らない工程: ${s}`);
const maxDiffs = Number(values['max-diffs']);
const work = resolve(values.work ?? join(ROOT, 'out', 'parity'));
const outTs = join(work, 'ts');
const outRs = join(work, 'rs');
const notesTs = join(work, 'notes-ts');
const notesRs = join(work, 'notes-rs');

async function fixtureHome(): Promise<string> {
  const { writeFixtures } = await import('./synthetic-fixtures.ts');
  const { buildFixtureHome, FIXTURE_WIKIS, FIXTURES } = await import('../e2e/fixture-home.ts');
  await writeFixtures();
  const config = join(FIXTURES, 'atlas.config.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(config, JSON.stringify({ wikis: FIXTURE_WIKIS }));
  process.env.ATLAS_CONFIG = config;
  const { home } = await buildFixtureHome(join(work, 'home'), { phase11: true, phase12: true });
  return home;
}

function run(label: string, cmd: string, args: string[]): { ms: number } {
  const t = performance.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: process.env, maxBuffer: 1 << 28 });
  const ms = performance.now() - t;
  if (r.status !== 0) {
    console.error(`[${label}] 失敗 (exit ${r.status})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
    process.exit(1);
  }
  return { ms };
}

/** snapshot 工程を比べている間だけ snapshot/ も見る */
let withSnapshot = false;

function listFiles(dir: string, base = dir, acc = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(base, p).split(sep).join('/');
    if (!withSnapshot && (rel === 'snapshot' || rel.startsWith('snapshot/'))) continue;
    if (e.isDirectory()) listFiles(p, base, acc);
    else if (!IGNORE_FILES.some((re) => re.test(rel))) acc.set(rel, p);
  }
  return acc;
}

function fileSig(p: string): string {
  const s = statSync(p);
  return `${s.size}:${s.mtimeMs}`;
}

type Diff = string;

/** Rust 側の出力先のパスを TS 側のものに読み替える(sessions.json の source.snapshotDir など、出力先の場所が値に入るものを比べるため) */
const sameDir = (v: unknown): unknown => (typeof v === 'string' ? v.split(outRs).join(outTs).split(notesRs).join(notesTs) : v);

function cmpJson(a: unknown, b: unknown, path: string, out: Diff[], ignore: readonly string[] = []): void {
  if (out.length >= maxDiffs || ignored(ignore, path)) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return;
    const d = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);
    if (d > 1e-9) out.push(`${path}: ${a} ≠ ${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== sameDir(b)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 200)} ≠ ${JSON.stringify(b)?.slice(0, 200)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: 配列とオブジェクトが違う`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: 長さ ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) cmpJson(a[i], b[i], `${path}[${i}]`, out, ignore);
    return;
  }
  const kept = (k: string): boolean => !IGNORE_KEYS.has(k) && !ignored(ignore, `${path}.${k}`);
  const ka = Object.keys(a as object).filter(kept);
  const kb = Object.keys(b as object).filter(kept);
  const missing = ka.filter((k) => !kb.includes(k));
  const extra = kb.filter((k) => !ka.includes(k));
  if (missing.length) out.push(`${path}: Rust に無いキー ${missing.join(', ')}`);
  if (extra.length) out.push(`${path}: Rust にだけあるキー ${extra.join(', ')}`);
  if (!missing.length && !extra.length && ka.join('\0') !== kb.join('\0')) out.push(`${path}: キーの順が違う TS[${ka.join(',')}] Rust[${kb.join(',')}]`);
  for (const k of ka) if (kb.includes(k)) cmpJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out, ignore);
}

/**
 * SQLite の中身(表・索引の定義と、表ごとの全行)を文字列にする。ファイルのバイト列は、書いた SQLite の版(ヘッダーの 96〜99 バイト目)や
 * ページの置き方で変わるので、中身で比べる(TS 版は node:sqlite、Rust 版は rusqlite が同梱する SQLite で、版が違う)
 */
function dumpSqlite(p: string): string {
  const db = new DatabaseSync(p, { readOnly: true, readBigInts: true });
  try {
    const val = (v: unknown): unknown => (v instanceof Uint8Array ? `x'${Buffer.from(v).toString('hex')}'` : typeof v === 'bigint' ? String(v) : v);
    const objs = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as { type: string; name: string }[];
    const lines: string[] = [JSON.stringify(objs, (_, v) => val(v))];
    for (const pragma of ['user_version', 'application_id', 'page_size', 'encoding']) lines.push(JSON.stringify(db.prepare(`PRAGMA ${pragma}`).get(), (_, v) => val(v)));
    for (const o of objs) {
      if (o.type !== 'table') continue;
      for (const row of db.prepare(`SELECT * FROM "${o.name.replace(/"/g, '""')}"`).all()) lines.push(`${o.name}\t${JSON.stringify(row, (_, v) => val(v))}`);
    }
    return lines.join('\n');
  } finally {
    db.close();
  }
}

function firstTextDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const line = a.slice(0, i).split('\n').length;
  const ctx = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 60), i + 100));
  return `${line} 行目付近(文字 ${i})\n      TS:   ${ctx(a)}\n      Rust: ${ctx(b)}`;
}

/**
 * build の生成日時(insights.json の generatedAt)は実行のたびに変わる。ページ・記録(.html・.md)の本文に書く生成日時は、
 * Rust 側の値(ISO と画面の「YYYY-MM-DD HH:mm」)を TS 側の値に読み替えて比べる
 */
function generatedSwaps(): [string, string][] {
  const gen = (dir: string): string | null => {
    try {
      return (JSON.parse(readFileSync(join(dir, 'insights.json'), 'utf8')) as { generatedAt?: string }).generatedAt ?? null;
    } catch {
      return null;
    }
  };
  const [a, b] = [gen(outTs), gen(outRs)];
  return a && b && a !== b ? [[b, a], [dateTime(b), dateTime(a)]] : [];
}

function compare(before: Map<string, string>): { files: number; diffs: string[] } {
  const ts = listFiles(outTs);
  const rs = listFiles(outRs);
  const diffs: string[] = [];
  const swaps = generatedSwaps();
  let files = 0;
  for (const [rel, p] of ts) {
    // この工程で変わっていないファイルは比べない
    if (before.get(rel) === fileSig(p)) continue;
    files++;
    const q = rs.get(rel);
    if (!q) {
      diffs.push(`${rel}: Rust 側にない`);
      continue;
    }
    const a = readFileSync(p);
    const b = readFileSync(q);
    if (a.equals(b)) continue;
    if (rel.endsWith('.json')) {
      const d: Diff[] = [];
      try {
        cmpJson(JSON.parse(a.toString('utf8')), JSON.parse(b.toString('utf8')), '$', d, IGNORE_PATHS[rel]);
      } catch (e) {
        d.push(`JSON として読めない: ${(e as Error).message}`);
      }
      if (d.length) diffs.push(`${rel}:\n    ${d.join('\n    ')}`);
    } else if (rel.endsWith('.sqlite') || rel.endsWith('.db')) {
      let da: string;
      let db: string;
      try {
        [da, db] = [dumpSqlite(p), dumpSqlite(q)];
      } catch (e) {
        diffs.push(`${rel}: SQLite として読めない: ${(e as Error).message}`);
        continue;
      }
      if (da !== db) diffs.push(`${rel}: SQLite の中身が違う ${firstTextDiff(da, db)}`);
    } else {
      let tb = sameDir(b.toString('utf8')) as string;
      for (const [from, to] of swaps) tb = tb.split(from).join(to);
      const ta = a.toString('utf8');
      if (ta !== tb) diffs.push(`${rel}: ${firstTextDiff(ta, tb)}`);
    }
  }
  for (const rel of rs.keys()) if (!ts.has(rel)) diffs.push(`${rel}: Rust 側にだけある`);
  return { files, diffs };
}

function syncRsFromTs(): void {
  rmSync(outRs, { recursive: true, force: true });
  rmSync(notesRs, { recursive: true, force: true });
  mkdirSync(outRs, { recursive: true });
  for (const e of existsSync(outTs) ? readdirSync(outTs) : []) {
    if (e === 'snapshot') {
      // 後ろの工程は読むだけなので写さず共有する(実データは数百 MB ある)
      symlinkSync(join(outTs, 'snapshot'), join(outRs, 'snapshot'), 'junction');
    } else cpSync(join(outTs, e), join(outRs, e), { recursive: true });
  }
  if (existsSync(notesTs)) cpSync(notesTs, notesRs, { recursive: true });
}

const home = values.home ? resolve(values.home) : null;
rmSync(outTs, { recursive: true, force: true });
rmSync(outRs, { recursive: true, force: true });
rmSync(notesTs, { recursive: true, force: true });
rmSync(notesRs, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const h = home ?? (await fixtureHome());
const common = (out: string, notes: string): string[] => ['--home', h, '--out', out, '--notes-dir', notes, ...(values.config ? ['--config', values.config] : [])];
const configStages = new Set(['extract', 'vcs']);

let failed = 0;
// 指定した最初の工程より前の工程は TS 版だけで動かして入力を作る
const first = ALL_STAGES.indexOf(stages[0]);
for (const s of ALL_STAGES.slice(0, first)) {
  const args = configStages.has(s) || !values.config ? common(outTs, notesTs) : common(outTs, notesTs).slice(0, 6);
  run(`ts ${s}`, process.execPath, [TS_CLI, s, ...args]);
}
for (const s of stages) {
  const opt = (out: string, notes: string): string[] => (configStages.has(s) ? common(out, notes) : common(out, notes).slice(0, 6));
  if (s === 'snapshot') {
    rmSync(outRs, { recursive: true, force: true });
    mkdirSync(outRs, { recursive: true });
  } else syncRsFromTs();
  withSnapshot = s === 'snapshot';
  const before = new Map([...listFiles(outTs)].map(([rel, p]) => [rel, fileSig(p)]));
  const ts = run(`ts ${s}`, process.execPath, [TS_CLI, s, ...opt(outTs, notesTs)]);
  const rs = run(`rs ${s}`, rsCli, [s, ...opt(outRs, notesRs)]);
  const { files, diffs } = compare(before);
  const head = `${s}: TS ${(ts.ms / 1000).toFixed(1)} 秒 / Rust ${(rs.ms / 1000).toFixed(1)} 秒、比べたファイル ${files}`;
  if (diffs.length === 0) console.log(`✓ ${head}、差なし`);
  else {
    failed++;
    console.log(`✗ ${head}、差のあるファイル ${diffs.length}\n  ${diffs.slice(0, maxDiffs).join('\n  ')}`);
  }
}
process.exit(failed ? 1 : 0);
