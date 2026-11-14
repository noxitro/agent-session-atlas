// 判定まわり(bundle・judge・turns・skill-draft)を TS 版と Rust 版で同じ入力から動かし、書いたファイル・ログ・終了コードを突き合わせる
// (Rust 移行の段 6 の確認用。docs/rust-migration.md)。LLM は呼ばない(偽の copilot fixtures/fake-copilot.mjs を ATLAS_COPILOT_BIN で使う。
// ANTHROPIC_API_KEY は環境から外す)。
//
//   node scripts/parity-judge.ts --base <TS 版の out> [--work <dir>] [--rs <exe>] [--config <file>] [--real] [--only <名前,…>] [--max-diffs <n>]
//
// - --base は TS 版で作った out(sessions.json と snapshot/ があるもの)。架空の fixture なら
//   `node scripts/parity.ts --stages metrics --work out/parity-judge-fixture` の後の out/parity-judge-fixture/ts。
// - --real は実データ用: LLM を呼ばない bundle と turns bundle(それぞれ --unjudged あり・なし)だけを比べ、所要時間を出す
//   (judgments.json・turn-judgments.json は --base にあるものをそのまま使う)。
// - 場合ごとに --base を作業場所の ts/ と rs/ に写し(snapshot/ は写さずに共有する。読むだけなので)、同じ引数で両方を動かす。
//   前準備(先に bundle を作る、判定を置くなど)は TS 版で 1 回だけ作ってから両方へ写す。
// - 比べないもの: 実行のたびに変わる時刻(generatedAt・ranAt・at)、分割ファイルの境界の乱数、ログの所要時間と出力先のパス。
//   --concurrency 2 の場合は、終わる順が決まらないので、ログの行と judgments.json の items を並べ替えてから比べる。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cmpJson, firstTextDiff } from './parity-common.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS_CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const FAKE = join(ROOT, 'fixtures', 'fake-copilot.mjs');

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    work: { type: 'string' },
    rs: { type: 'string' },
    config: { type: 'string' },
    real: { type: 'boolean', default: false },
    only: { type: 'string' },
    'max-diffs': { type: 'string', default: '30' },
  },
});
if (!values.base) {
  console.error('--base <TS 版の out> を指定してください(使い方はこのファイルの先頭)');
  process.exit(2);
}
const base = resolve(values.base);
const exe = process.platform === 'win32' ? 'atlas.exe' : 'atlas';
const rsCli = values.rs ? resolve(values.rs) : [join(ROOT, 'target', 'release', exe), join(ROOT, 'target', 'debug', exe)].find((p) => existsSync(p));
if (!rsCli || !existsSync(rsCli)) {
  console.error('Rust 版の atlas が見つかりません(cargo build -p atlas-cli を先に実行してください。--rs で場所を指定できます)');
  process.exit(2);
}
const work = resolve(values.work ?? join(ROOT, 'out', 'parity-judge-work'));
const maxDiffs = Number(values['max-diffs']);
const only = values.only ? new Set(values.only.split(',')) : null;

/** 子プロセスの環境: 偽の copilot を使い、Anthropic のキーは渡さない */
function envFor(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ATLAS_COPILOT_BIN: FAKE, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ATLAS_JUDGE_RAW_DIR;
  delete env.FAKE_COPILOT_FAIL_ID;
  delete env.FAKE_COPILOT_DELAY_MS;
  if (values.config) env.ATLAS_CONFIG = resolve(values.config);
  return { ...env, ...extra };
}

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runCli(side: 'ts' | 'rs', args: string[], env: NodeJS.ProcessEnv): Ran {
  const t = performance.now();
  const [cmd, pre] = side === 'ts' ? [process.execPath, [TS_CLI]] : [rsCli!, []];
  const r = spawnSync(cmd, [...pre, ...args], { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 1 << 28, timeout: 1_200_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: performance.now() - t };
}

/** out を写す(snapshot/ は写さずに元の場所へのジャンクションで共有する。withSnapshot が偽なら snapshot/ を置かない) */
function copyOut(from: string, to: string, withSnapshot = true): void {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from)) {
    if (e === 'snapshot') {
      if (withSnapshot) symlinkSync(realpathSync(join(from, 'snapshot')), join(to, 'snapshot'), 'junction');
    } else cpSync(join(from, e), join(to, e), { recursive: true });
  }
}

function listFiles(dir: string, b = dir, acc = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(b, p).split(sep).join('/');
    if (rel === 'snapshot') continue;
    if (e.isDirectory()) listFiles(p, b, acc);
    else acc.set(rel, p);
  }
  return acc;
}

const IGNORE_KEYS = new Set(['generatedAt']);
/** 実行のたびに変わる値(ファイル名の正規表現 → JSON パス) */
const IGNORE_PATHS: [RegExp, string[]][] = [
  [/(^|\/)judgments\.json$/, ['$.judge.ranAt', '$.items[*].judge.ranAt', '$.failures[*].at']],
  [/(^|\/)turn-judgments\.json$/, ['$.judge.ranAt', '$.items[*].judge.ranAt', '$.failures[*].at']],
];

/** 文書の中の、実行のたびに変わるもの(分割ファイルの境界の乱数・生成時刻)を伏せる */
function maskText(s: string, generatedAt: string[]): string {
  let t = s.replace(/(PACKET_BEGIN|PACKET_END) [0-9a-f]{24}/g, '$1 <BOUNDARY>');
  for (const g of generatedAt) if (g) t = t.split(g).join('<GENERATED>');
  return t;
}

function generatedAts(dir: string): string[] {
  const out: string[] = [];
  for (const m of ['bundle/manifest.json', 'turn-bundle/manifest.json']) {
    const p = join(dir, ...m.split('/'));
    if (existsSync(p)) out.push(String((JSON.parse(readFileSync(p, 'utf8')) as { generatedAt?: string }).generatedAt ?? ''));
  }
  return out;
}

/** ログの所要時間・出力先のパスを伏せる */
function maskLog(s: string, dirs: string[], unordered: boolean): string {
  let t = s;
  for (const d of dirs) t = t.split(d).join('<OUT>');
  t = t.replace(/\d+\.\d 秒/g, 'N 秒').replace(/\r\n/g, '\n');
  // Node の実験的機能の警告(TS 版だけが出す)は比べない
  t = t
    .split('\n')
    .filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l))
    .join('\n');
  // 並列のときは何件目に終わったかが決まらないので、件数の表示も伏せる
  return unordered ? t.replace(/\[\d+\/(\d+)\]/g, '[k/$1]').split('\n').sort().join('\n') : t;
}

function sortItems(v: unknown): unknown {
  const o = v as { items?: { sessionId: string }[] };
  if (o && Array.isArray(o.items)) o.items.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return v;
}

function compareDirs(ts: string, rs: string, unordered: boolean): string[] {
  const a = listFiles(ts);
  const b = listFiles(rs);
  const diffs: string[] = [];
  const genTs = generatedAts(ts);
  const genRs = generatedAts(rs);
  const mapString = (s: string): string => s.split(rs).join(ts);
  for (const [rel, p] of a) {
    const q = b.get(rel);
    if (!q) {
      diffs.push(`${rel}: Rust 側にない`);
      continue;
    }
    const x = readFileSync(p);
    const y = readFileSync(q);
    if (x.equals(y)) continue;
    if (rel.endsWith('.json')) {
      const d: string[] = [];
      try {
        let va = JSON.parse(x.toString('utf8'));
        let vb = JSON.parse(y.toString('utf8'));
        if (unordered) [va, vb] = [sortItems(va), sortItems(vb)];
        const ignorePaths = IGNORE_PATHS.filter(([re]) => re.test(rel)).flatMap(([, ps]) => ps);
        cmpJson(va, vb, '$', d, { maxDiffs, ignoreKeys: IGNORE_KEYS, ignorePaths, mapString });
      } catch (e) {
        d.push(`JSON として読めない: ${(e as Error).message}`);
      }
      if (d.length) diffs.push(`${rel}:\n    ${d.join('\n    ')}`);
    } else {
      const ta = maskText(x.toString('utf8'), genTs);
      const tb = maskText(mapString(y.toString('utf8')), genRs);
      if (ta !== tb) diffs.push(`${rel}: ${firstTextDiff(ta, tb)}`);
    }
  }
  for (const rel of b.keys()) if (!a.has(rel)) diffs.push(`${rel}: Rust 側にだけある`);
  return diffs;
}

/** 偽の copilot が記録した引数(作業フォルダ・一時ファイル・境界の乱数を伏せる) */
function copilotCalls(log: string): string {
  if (!existsSync(log)) return '';
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const x = JSON.parse(l) as { argv: string[]; cwdEntries: string[]; sessionId: string };
      const argv = x.argv.map((a) => maskText(a, []).replace(/atlas-(judge|draft)-(cwd|usage)-[A-Za-z0-9]+/g, 'atlas-$1-$2-X').replace(/^.*[\\/](usage\.json)$/, '<TMP>/$1'));
      return JSON.stringify({ argv, cwdEntries: x.cwdEntries, sessionId: x.sessionId });
    })
    .sort()
    .join('\n');
}

interface Case {
  name: string;
  /** 前準備(TS 版で 1 回だけ動かし、ts/ と rs/ に写す)。out はその作業場所 */
  prep?: (out: string) => void;
  args: (out: string) => string[];
  env?: Record<string, string>;
  unordered?: boolean;
  /** スナップショットの無い out で動かす */
  noSnapshot?: boolean;
}

const IDS = (() => {
  const s = JSON.parse(readFileSync(join(base, 'sessions.json'), 'utf8')) as { sessions: { id: string; client: string | null; project: string; analysis?: { turnStats?: unknown[] } }[] };
  return s.sessions;
})();

function ts(out: string, args: string[], env: Record<string, string> = {}): void {
  const r = runCli('ts', [...args, '--out', out], envFor(env));
  if (r.status !== 0) throw new Error(`前準備 ${args.join(' ')} が失敗: ${r.stderr}\n${r.stdout}`);
}

const fixtureCases = (): Case[] => {
  const sample = join(ROOT, '.fixtures', 'judgments-sample.json');
  const firstWithTurns = IDS.find((s) => (s.analysis?.turnStats?.length ?? 0) > 2)!;
  const putSample = (out: string): void => {
    cpSync(sample, join(out, 'judgments.json'));
  };
  const files = join(work, 'inputs');
  mkdirSync(files, { recursive: true });
  const item = (id: string, p: Record<string, unknown> = {}) => ({
    sessionId: id,
    taskCategory: 'feature',
    taskSummary: '要約',
    humanEffort: { hours: 2, low: 1, high: 4, confidence: 0.5, rationale: '根拠' },
    aiOutcome: { completed: true, quality: 4, rework: 1, rationale: '成果' },
    instructionsEffect: { score: 1, evidence: 'e' },
    wikiEffect: { score: 0, evidence: '参照なし' },
    skillsAgentsEffect: { score: 0, evidence: '参照なし' },
    ...p,
  });
  writeFileSync(join(files, 'broken.json'), '{ "items": [ ');
  writeFileSync(join(files, 'bad-schema.json'), JSON.stringify([item(IDS[0].id), item(IDS[1].id, { taskCategory: 'nope', humanEffort: { hours: 5, low: 6, high: 7, confidence: 1.5, rationale: '' } }), 3, [1, 2], { sessionId: 'z' }]));
  writeFileSync(
    join(files, 'reply.md'),
    `﻿判定しました。\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'm365', ranAt: '2026-10-01T00:00:00Z' }, items: [item(IDS[0].id), item(IDS[1].id), item('not-in-sessions')] }, null, 2)}\n\`\`\`\n\n追加:\n\`\`\`json\n${JSON.stringify(item(IDS[1].id, { taskSummary: '後' }))}\n\`\`\`\n`,
  );
  writeFileSync(join(files, 'no-json.md'), '説明だけで JSON はありません');
  const turnItem = (sid: string, turn: number, p: Record<string, unknown> = {}) => ({ sessionId: sid, turn, kind: 'task', outcome: 'as_is', mismatch: null, phase: '実装', confidence: 0.8, note: ' 理由 ', ...p });
  writeFileSync(
    join(files, 'turns-reply.md'),
    `判定しました\n\`\`\`json\n${JSON.stringify({ judge: { model: 'm365' }, items: [turnItem(firstWithTurns.id, 1), turnItem(firstWithTurns.id, 2, { outcome: 'fix_content', mismatch: 'requirement' }), turnItem(firstWithTurns.id, 99), turnItem('nope', 1)] })}\n\`\`\`\n`,
  );
  writeFileSync(join(files, 'turns-bad.md'), `\`\`\`json\n${JSON.stringify([turnItem(firstWithTurns.id, 1, { outcome: 'rejected' }), turnItem(firstWithTurns.id, 2, { phase: '開発' }), 'x'])}\n\`\`\``);
  const byokConfig = join(files, 'byok.config.json');
  writeFileSync(byokConfig, JSON.stringify({ judgeModel: 'anthropic/claude-sonnet-5-5', phases: ['調べる', '作る', '確かめる'] }));
  const bundled = (out: string): void => ts(out, ['bundle']);
  const turnsBundled = (out: string): void => ts(out, ['turns', 'bundle']);
  const failId = IDS.find((s) => s.client === 'github/cli' && s.id.endsWith('5'))?.id ?? IDS[0].id;
  return [
    { name: 'bundle', args: () => ['bundle'] },
    { name: 'bundle --unjudged', prep: putSample, args: () => ['bundle', '--unjudged'] },
    { name: 'bundle --include-empty', args: () => ['bundle', '--include-empty'] },
    { name: 'bundle --per-part 2', args: () => ['bundle', '--per-part', '2'] },
    { name: 'bundle --project zz --client github/cli', args: () => ['bundle', '--project', 'zz', '--client', 'github/cli'] },
    { name: 'bundle --session(曖昧な先頭)', args: () => ['bundle', '--session', `${IDS[0].id.slice(0, 35)},${IDS[4].id}`] },
    { name: 'bundle --session', args: () => ['bundle', '--session', `${IDS[0].id},${IDS[4].id}`, '--session', IDS[14].id] },
    { name: 'bundle --since', args: () => ['bundle', '--since', '2026-10-01'] },
    { name: 'bundle(スナップショットなし)', noSnapshot: true, args: () => ['bundle'] },
    { name: 'judge import sample', args: () => ['judge', 'import', sample] },
    { name: 'judge import (既存に上書き)', prep: putSample, args: () => ['judge', 'import', join(files, 'reply.md')] },
    { name: 'judge import 壊れた JSON', args: () => ['judge', 'import', join(files, 'broken.json')] },
    { name: 'judge import 形の合わない判定', prep: putSample, args: () => ['judge', 'import', join(files, 'bad-schema.json')] },
    { name: 'judge import JSON なし', args: () => ['judge', 'import', join(files, 'no-json.md')] },
    { name: 'judge import ファイルなし', args: () => ['judge', 'import', join(files, 'missing.json')] },
    { name: 'judge run --limit 3', prep: bundled, args: () => ['judge', 'run', '--limit', '3'] },
    { name: 'judge run --only', prep: bundled, args: () => ['judge', 'run', '--only', `${IDS[4].id},${IDS[0].id}`] },
    { name: 'judge run --only 不明な ID', prep: bundled, args: () => ['judge', 'run', '--only', 'nope'] },
    { name: 'judge run --concurrency 2', prep: bundled, args: () => ['judge', 'run', '--concurrency', '2'], unordered: true },
    {
      name: 'judge run --force(判定済みあり)',
      prep: (out) => {
        bundled(out);
        putSample(out);
      },
      args: () => ['judge', 'run', '--force', '--limit', '4', '--no-allow-tools', '--model', 'gpt-x'],
    },
    { name: 'judge run 失敗あり', prep: bundled, args: () => ['judge', 'run', '--limit', '6'], env: { FAKE_COPILOT_FAIL_ID: failId } },
    { name: 'judge run BYOK の設定', prep: bundled, args: () => ['judge', 'run', '--limit', '2'], env: { ATLAS_CONFIG: byokConfig } },
    { name: 'judge run anthropic(キーなし)', prep: bundled, args: () => ['judge', 'run', '--backend', 'anthropic'] },
    { name: 'judge run バンドルなし', args: () => ['judge', 'run'] },
    { name: 'turns bundle', args: () => ['turns', 'bundle'] },
    { name: 'turns bundle(設定の工程名)', args: () => ['turns', 'bundle'], env: { ATLAS_CONFIG: byokConfig } },
    {
      name: 'turns bundle --unjudged',
      prep: (out) => ts(out, ['turns', 'import', join(files, 'turns-reply.md')]),
      args: () => ['turns', 'bundle', '--unjudged'],
    },
    { name: 'turns bundle --unjudged(判定なし)', args: () => ['turns', 'bundle', '--unjudged'] },
    { name: 'turns run --limit 10', prep: turnsBundled, args: () => ['turns', 'run', '--limit', '10'] },
    { name: 'turns run 全部', prep: turnsBundled, args: () => ['turns', 'run'] },
    { name: 'turns run(一部判定済み)', prep: (out) => (turnsBundled(out), ts(out, ['turns', 'import', join(files, 'turns-reply.md')])), args: () => ['turns', 'run', '--model', 'm'] },
    { name: 'turns import', prep: turnsBundled, args: () => ['turns', 'import', join(files, 'turns-reply.md')] },
    { name: 'turns import 形の合わない返答', prep: turnsBundled, args: () => ['turns', 'import', join(files, 'turns-bad.md')] },
    { name: 'turns import ファイルなし', args: () => ['turns', 'import', join(files, 'missing.md')] },
    { name: 'skill-draft 1', prep: (out) => ts(out, ['build']), args: () => ['skill-draft', '1'] },
    { name: 'skill-draft 99', prep: (out) => ts(out, ['build']), args: () => ['skill-draft', '99'] },
    { name: 'skill-draft insights なし', args: () => ['skill-draft', '1'] },
  ];
};

const realCases = (): Case[] => [
  { name: 'bundle --unjudged', args: () => ['bundle', '--unjudged'] },
  { name: 'turns bundle --unjudged', args: () => ['turns', 'bundle', '--unjudged'] },
  { name: 'bundle', args: () => ['bundle'] },
  { name: 'turns bundle', args: () => ['turns', 'bundle'] },
];

const cases = (values.real ? realCases() : fixtureCases()).filter((c) => !only || only.has(c.name));
let failed = 0;
for (const c of cases) {
  const dir = join(work, 'case');
  const prepared = join(dir, 'prepared');
  copyOut(base, prepared, !c.noSnapshot);
  if (c.prep) c.prep(prepared);
  const outTs = join(dir, 'ts');
  const outRs = join(dir, 'rs');
  copyOut(prepared, outTs);
  copyOut(prepared, outRs);
  const logTs = join(dir, 'copilot-ts.log');
  const logRs = join(dir, 'copilot-rs.log');
  rmSync(logTs, { force: true });
  rmSync(logRs, { force: true });
  const rt = runCli('ts', [...c.args(outTs), '--out', outTs], envFor({ ...c.env, FAKE_COPILOT_LOG: logTs }));
  const rr = runCli('rs', [...c.args(outRs), '--out', outRs], envFor({ ...c.env, FAKE_COPILOT_LOG: logRs }));
  const diffs: string[] = [];
  if (rt.status !== rr.status) diffs.push(`終了コード TS ${rt.status} ≠ Rust ${rr.status}`);
  for (const [k, a, b] of [
    ['stdout', rt.stdout, rr.stdout],
    ['stderr', rt.stderr, rr.stderr],
  ] as const) {
    const ma = maskLog(a, [outTs, outRs, prepared], !!c.unordered);
    const mb = maskLog(b, [outTs, outRs, prepared], !!c.unordered);
    if (ma !== mb) diffs.push(`${k}: ${firstTextDiff(ma, mb)}`);
  }
  const ca = copilotCalls(logTs);
  const cb = copilotCalls(logRs);
  if (ca !== cb) diffs.push(`copilot の引数: ${firstTextDiff(ca, cb)}`);
  diffs.push(...compareDirs(outTs, outRs, !!c.unordered));
  const head = `${c.name}: TS ${(rt.ms / 1000).toFixed(2)} 秒 / Rust ${(rr.ms / 1000).toFixed(2)} 秒、終了コード ${rt.status}、copilot 呼び出し ${ca ? ca.split('\n').length : 0} 回`;
  if (diffs.length === 0) console.log(`✓ ${head}、差なし`);
  else {
    failed++;
    console.log(`✗ ${head}\n  ${diffs.slice(0, maxDiffs).join('\n  ')}`);
  }
}
rmSync(join(work, 'case'), { recursive: true, force: true });
console.log(failed ? `差のあった場合 ${failed} / ${cases.length}` : `全 ${cases.length} 件で差なし`);
process.exit(failed ? 1 : 0);
