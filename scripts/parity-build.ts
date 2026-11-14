// TS 版と Rust 版の atlas の build / export / all を同じ入力で動かし、出力・ログ・終了コードを突き合わせる(Rust 移行の段 4-2 の確認用)。
//
//   node scripts/parity-build.ts [--home <dir>] [--config <file>] [--work <dir>] [--rs <exe>] [--cases a,b,…]
//                                [--judgments <file>] [--turn-judgments <file>] [--notes <dir>] [--quiet] [--max-diffs <n>]
//
// - --home を省くと、e2e と同じ架空の fixture を使う(判定の見本を取り込み、依頼ごとの判定・メモ・タスクタグも架空のものを足す)。
// - 入力(snapshot・sessions.json・vcs-retention.json・metrics.json)は TS 版で 1 回だけ作り、ケースごとに TS 側・Rust 側へ写してから同じコマンドを動かす。
//   --judgments / --turn-judgments / --notes は、その写し(読むだけ。元のファイルは書き換えない)を入力に足す。
// - 出力は parity.ts と同じ比べ方(JSON は値、SQLite は中身、ほかはバイト)。生成日時は Rust 側の値を TS 側の値に読み替えて比べる。
// - ログは所要時間(N.N 秒)と出力先のパスを伏せて比べる。--quiet は差の本文の抜粋を出さない(実データで使う)。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { cmpJson, firstTextDiff } from './parity-common.ts';
import { dateTime } from '../packages/report/src/lib/format.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS_CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const IGNORE_KEYS = new Set(['generatedAt', 'builtAt', 'timingsMs']);
const IGNORE_FILES = [/\.lock$/, /\.serve\.json$/, /(^|[\\/])\.built\.json$/];
const IGNORE_PATHS: Record<string, readonly string[]> = {
  'snapshot/snapshot-manifest.json': ['$.createdAt'],
  'snapshot/snapshot-source.json': ['$.startedAt'],
  'snapshot/desktop.json': ['$.readAt'],
  'vcs-retention.json': ['$.sessions[*].evaluated.at'],
  'sessions.json': ['$.desktop.readAt'],
};
/** atlas.html の埋め込みデータ(値で比べる。metrics を build で作り直したときの generatedAt などを除くため) */
const DATA_RE = /(<script type="application\/json" id="atlas-data">)([\s\S]*?)(<\/script>)/;

/** ケース: 順に動かすコマンドと引数(前のコマンドの出力が残った状態で次を動かすものもある) */
const CASES: Record<string, string[][]> = {
  build: [['build']],
  'build-anon': [['build', '--anonymize']],
  export: [['export']],
  'export-full': [['export', '--full']],
  'export-all': [['export', '--tool-output', 'all']],
  'export-none': [['export', '--tool-output', 'none', '--max-chars', '300']],
  'export-anon': [['export', '--anonymize']],
  'export-project': [['export', '--project', 'a', '--max-chars', '1000']],
  // 前の --full と閲覧ページが残ったまま build する(残っている旨のログ)、その後に伏せ字で消す
  stale: [['export', '--full'], ['build'], ['build', '--anonymize']],
  // 絞り込みの失敗(終了コードとエラーの文)
  'bad-group': [['build', '--group', 'no-such-group']],
  all: [['all']],
  'all-anon': [['all', '--anonymize']],
};

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    config: { type: 'string' },
    work: { type: 'string' },
    rs: { type: 'string' },
    cases: { type: 'string' },
    judgments: { type: 'string' },
    'turn-judgments': { type: 'string' },
    notes: { type: 'string' },
    quiet: { type: 'boolean', default: false },
    'max-diffs': { type: 'string', default: '20' },
  },
});
const maxDiffs = Number(values['max-diffs']);
const exe = process.platform === 'win32' ? 'atlas.exe' : 'atlas';
const rsCli = values.rs ?? [join(ROOT, 'target', 'release', exe), join(ROOT, 'target', 'debug', exe)].find((p) => existsSync(p));
if (!rsCli || !existsSync(rsCli)) {
  console.error('Rust 版の atlas が見つかりません(cargo build --release -p atlas-cli を先に実行してください)');
  process.exit(2);
}
const work = resolve(values.work ?? join(ROOT, 'out', 'parity-build'));
const base = join(work, 'base');
const baseNotes = join(work, 'base-notes');
const caseNames = (values.cases ?? Object.keys(CASES).join(',')).split(',').map((s) => s.trim());
for (const c of caseNames) if (!CASES[c]) throw new Error(`知らないケース: ${c}`);

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t = performance.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 1 << 28 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: performance.now() - t };
}
function must(label: string, r: ReturnType<typeof run>): void {
  if (r.status !== 0) {
    console.error(`[${label}] 失敗 (exit ${r.status})\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
    process.exit(1);
  }
}

async function fixtureHome(): Promise<string> {
  const { writeFixtures } = await import('./synthetic-fixtures.ts');
  const { buildFixtureHome, FIXTURE_WIKIS, FIXTURES } = await import('../e2e/fixture-home.ts');
  await writeFixtures();
  const config = join(FIXTURES, 'atlas.config.json');
  writeFileSync(config, JSON.stringify({ wikis: FIXTURE_WIKIS }));
  process.env.ATLAS_CONFIG = config;
  const { home } = await buildFixtureHome(join(work, 'home'), { phase11: true, phase12: true });
  return home;
}

/** 架空の入力に、判定の見本・依頼ごとの判定・メモ・タスクタグを足す(fixture のときだけ) */
async function addFixtureExtras(): Promise<void> {
  const { FIXTURES } = await import('../e2e/fixture-home.ts');
  must('ts judge import', run(process.execPath, [TS_CLI, 'judge', 'import', join(FIXTURES, 'judgments-sample.json'), '--out', base]));
  const file = JSON.parse(readFileSync(join(base, 'sessions.json'), 'utf8')) as { sessions: { id: string; analysis?: { turnStats?: unknown[] } }[] };
  const withTurns = file.sessions.filter((s) => (s.analysis?.turnStats?.length ?? 0) > 1).slice(0, 3);
  const items = withTurns.flatMap((s, i) => [
    { sessionId: s.id, turn: 1, kind: 'task', outcome: 'as_is', mismatch: null, phase: '実装', confidence: 0.8, note: `見本の判定 ${i} <b>&</b>` },
    { sessionId: s.id, turn: 2, kind: 'fix', outcome: 'rejected', mismatch: 'defect', phase: '調査', confidence: 0.5, note: '' },
  ]);
  writeFileSync(join(base, 'turn-judgments.json'), JSON.stringify({ schemaVersion: 1, phases: ['実装', '調査', 'テスト'], model: 'fixture', ranAt: '2026-11-01T00:00:00.000Z', items }, null, 2));
  const ids = file.sessions.map((s) => s.id);
  mkdirSync(join(baseNotes, 'memos', ids[0]), { recursive: true });
  // 1x1 の PNG
  writeFileSync(join(baseNotes, 'memos', ids[0], 'a.png'), Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
  writeFileSync(
    join(baseNotes, 'memos', `${ids[0]}.md`),
    '# メモ\n\n- [ ] やること **太字**\n- [x] 済み\n\n![図](./' + ids[0] + '/a.png) と ![外](https://example.test/a.png)\n\n| a | b |\n|---|:-:|\n| 1 | <b>2</b> |\n\n```js\nfetch("http://x.test")\n```\n\n> 引用 &amp; &#39;\n',
  );
  writeFileSync(join(baseNotes, 'memos', `${ids[1]}.md`), '﻿短いメモ\n2 行目 [リンク](https://example.test/x) [相対](x.md)');
  writeFileSync(join(baseNotes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'タグ1', note: 'メモ <x>', ids: ids.slice(0, 3) }, { name: 'empty', note: '', ids: [] }] }, null, 2));
}

let withSnapshot = false;
function listFiles(dir: string, b = dir, acc = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(b, p).split(sep).join('/');
    if (!withSnapshot && (rel === 'snapshot' || rel.startsWith('snapshot/'))) continue;
    if (e.isDirectory()) listFiles(p, b, acc);
    else if (!IGNORE_FILES.some((re) => re.test(rel))) acc.set(rel, p);
  }
  return acc;
}

function dumpSqlite(p: string): string {
  const db = new DatabaseSync(p, { readOnly: true, readBigInts: true });
  try {
    const val = (v: unknown): unknown => (v instanceof Uint8Array ? `x'${Buffer.from(v).toString('hex')}'` : typeof v === 'bigint' ? String(v) : v);
    const objs = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all() as { type: string; name: string }[];
    const lines: string[] = [JSON.stringify(objs, (_, v) => val(v))];
    for (const o of objs) {
      if (o.type !== 'table') continue;
      for (const row of db.prepare(`SELECT * FROM "${o.name.replace(/"/g, '""')}"`).all()) lines.push(`${o.name}\t${JSON.stringify(row, (_, v) => val(v))}`);
    }
    return lines.join('\n');
  } finally {
    db.close();
  }
}

function genOf(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'insights.json'), 'utf8')) as { generatedAt?: string }).generatedAt ?? null;
  } catch {
    return null;
  }
}

function compareTrees(outTs: string, outRs: string, notesTs: string, notesRs: string): { files: number; diffs: string[] } {
  const ts = listFiles(outTs);
  const rs = listFiles(outRs);
  const [ga, gb] = [genOf(outTs), genOf(outRs)];
  const swaps: [string, string][] = [[outRs, outTs], [notesRs, notesTs]];
  if (ga && gb && ga !== gb) swaps.push([gb, ga], [dateTime(gb), dateTime(ga)]);
  const map = (s: string): string => swaps.reduce((x, [f, t]) => x.split(f).join(t), s);
  const diffs: string[] = [];
  for (const [rel, p] of ts) {
    const q = rs.get(rel);
    if (!q) {
      diffs.push(`${rel}: Rust 側にない`);
      continue;
    }
    const a = readFileSync(p);
    const b = readFileSync(q);
    if (a.equals(b)) continue;
    if (rel.endsWith('.json')) {
      const d: string[] = [];
      try {
        cmpJson(JSON.parse(a.toString('utf8')), JSON.parse(b.toString('utf8')), '$', d, { maxDiffs, ignoreKeys: IGNORE_KEYS, ignorePaths: IGNORE_PATHS[rel], mapString: map });
      } catch (e) {
        d.push(`JSON として読めない: ${(e as Error).message}`);
      }
      if (d.length) diffs.push(`${rel}:\n    ${values.quiet ? `${d.length} 箇所` : d.join('\n    ')}`);
    } else if (rel.endsWith('.sqlite') || rel.endsWith('.db')) {
      const [da, db] = [dumpSqlite(p), dumpSqlite(q)];
      if (da !== db) diffs.push(`${rel}: SQLite の中身が違う${values.quiet ? '' : ` ${firstTextDiff(da, db)}`}`);
    } else {
      let ta = a.toString('utf8');
      let tb = map(b.toString('utf8'));
      const ma = DATA_RE.exec(ta);
      const mb = DATA_RE.exec(tb);
      if (ma && mb) {
        const d: string[] = [];
        cmpJson(JSON.parse(ma[2]), JSON.parse(mb[2]), '$', d, { maxDiffs, ignoreKeys: IGNORE_KEYS, mapString: map });
        if (d.length) diffs.push(`${rel} の埋め込みデータ:\n    ${values.quiet ? `${d.length} 箇所` : d.join('\n    ')}`);
        ta = ta.replace(DATA_RE, '$1$3');
        tb = tb.replace(DATA_RE, '$1$3');
      }
      if (ta !== tb) diffs.push(`${rel}: ${values.quiet ? '本文が違う' : firstTextDiff(ta, tb)}`);
    }
  }
  for (const rel of rs.keys()) if (!ts.has(rel)) diffs.push(`${rel}: Rust 側にだけある`);
  return { files: ts.size, diffs };
}

/** ログを比べられる形に(所要時間・出力先・Node の実験機能の警告を伏せる) */
function normLog(s: string, out: string, notes: string): string {
  return s
    .split(out)
    .join('<OUT>')
    .split(notes)
    .join('<NOTES>')
    .replace(/\d+\.\d 秒/g, 'N 秒')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<ISO>')
    .replace(/\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}/g, '<DATE>')
    .split(/\r?\n/)
    .filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l))
    .join('\n');
}

function copyInputs(dst: string, notes: string): void {
  rmSync(dst, { recursive: true, force: true });
  rmSync(notes, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(base)) {
    if (e === 'snapshot') symlinkSync(join(base, 'snapshot'), join(dst, 'snapshot'), 'junction');
    else cpSync(join(base, e), join(dst, e), { recursive: true });
  }
  if (existsSync(baseNotes)) cpSync(baseNotes, notes, { recursive: true });
  else mkdirSync(notes, { recursive: true });
}

// ---------- 入力を作る ----------
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const home = values.home ? resolve(values.home) : await fixtureHome();
const cfg = values.config ? ['--config', resolve(values.config)] : [];
for (const s of ['snapshot', 'extract', 'vcs', 'metrics'])
  must(`ts ${s}`, run(process.execPath, [TS_CLI, s, '--home', home, '--out', base, '--notes-dir', baseNotes, ...(s === 'extract' || s === 'vcs' ? cfg : [])]));
if (!values.home) await addFixtureExtras();
mkdirSync(baseNotes, { recursive: true });
if (values.judgments) cpSync(resolve(values.judgments), join(base, 'judgments.json'));
if (values['turn-judgments']) cpSync(resolve(values['turn-judgments']), join(base, 'turn-judgments.json'));
if (values.notes) cpSync(resolve(values.notes), baseNotes, { recursive: true });

// ---------- ケースごとに比べる ----------
let failed = 0;
for (const name of caseNames) {
  const steps = CASES[name];
  const args = steps[0];
  const outTs = join(work, `${name}-ts`);
  const outRs = join(work, `${name}-rs`);
  const notesTs = join(work, `${name}-notes-ts`);
  const notesRs = join(work, `${name}-notes-rs`);
  copyInputs(outTs, notesTs);
  copyInputs(outRs, notesRs);
  // all は snapshot から作り直すので、共有の snapshot を写さない
  if (args[0] === 'all') {
    rmSync(join(outTs, 'snapshot'), { recursive: true, force: true });
    rmSync(join(outRs, 'snapshot'), { recursive: true, force: true });
  }
  const common = (out: string, notes: string): string[] => ['--home', home, '--out', out, '--notes-dir', notes, ...(args[0] === 'all' ? cfg : [])];
  const ts = { status: 0 as number | null, stdout: '', stderr: '', ms: 0 };
  const rs = { status: 0 as number | null, stdout: '', stderr: '', ms: 0 };
  for (const step of steps) {
    const a = run(process.execPath, [TS_CLI, ...step, ...common(outTs, notesTs)]);
    const b = run(rsCli, [...step, ...common(outRs, notesRs)]);
    for (const [acc, r] of [[ts, a], [rs, b]] as const) {
      acc.stdout += `$ ${step.join(' ')}
${r.stdout}`;
      acc.stderr += r.stderr;
      acc.ms += r.ms;
      acc.status = acc.status || r.status;
    }
  }
  withSnapshot = false;
  const { files, diffs } = compareTrees(outTs, outRs, notesTs, notesRs);
  const logA = normLog(ts.stdout, outTs, notesTs);
  const logB = normLog(rs.stdout, outRs, notesRs);
  const errA = normLog(ts.stderr, outTs, notesTs);
  const errB = normLog(rs.stderr, outRs, notesRs);
  if (ts.status !== rs.status) diffs.push(`終了コード: TS ${ts.status} / Rust ${rs.status}`);
  if (logA !== logB) diffs.push(`標準出力のログ: ${firstTextDiff(logA, logB)}`);
  if (errA !== errB) diffs.push(`標準エラー: ${firstTextDiff(errA, errB)}`);
  const head = `${name}(${steps.map((x) => `atlas ${x.join(' ')}`).join(' → ')}): TS ${(ts.ms / 1000).toFixed(1)} 秒 / Rust ${(rs.ms / 1000).toFixed(1)} 秒、終了コード ${ts.status}、比べたファイル ${files}`;
  if (!diffs.length) console.log(`✓ ${head}、差なし`);
  else {
    failed++;
    console.log(`✗ ${head}、差 ${diffs.length}\n  ${diffs.slice(0, maxDiffs).join('\n  ')}`);
  }
}
process.exit(failed ? 1 : 0);
