// 何人かの集計する人が同じ設定のフォルダ(AtlasSettings)に同時に書いても、どの書き込みも消えないことを、別々の atlas のプロセスで確かめる。
// 書き手は、工数の判定(judge import → judgments.json)・依頼ごとの判定(turns import → turn-judgments.json)・
// タスクの紐づけ(tasks import → task-links.json)・タスクの状態(tasks sync → tasks.json)。どれも <ファイル>.lock の OS のロックの中で
// 読み直して、自分の分だけを足して書く(crates/atlas-report/src/tasks/mod.rs の with_file_lock)。
// 1 回ごとに、それぞれの書き手を何人も同時に動かし(どれも別のセッションの分を取り込む)、終わったら共有のファイルが
// 全員の分の和になっていること・JSON として読めること・一時ファイル(.tmp)が残っていないことを確かめる。
// 書いている間も、別の読み手(画面のサーバの代わり)がファイルを読み続け、書きかけを読まないこと・ファイルが消えないことを確かめる。
// 共有のフォルダ(UNC のパス)でも確かめるときは、環境変数 ATLAS_TEST_UNC_DIR に書き込める UNC のフォルダを指す(無ければ飛ばす)。
// 出力先(--out)は、集計する人の PC と同じく手元に置く
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT, cliCommand } from './fixture-home.ts';

const WORK = join(ROOT, 'out', 'e2e-concurrent-writes');
const XML = join(ROOT, 'e2e', 'fixtures', 'tasks', 'export-before.xml');
/** 1 回に同時に動かす、それぞれの取り込みの書き手の数 */
const WRITERS = 8;
/** 同時に動かす tasks sync の数 */
const SYNCS = 2;
/** 1 人が取り込むセッションの数(依頼ごとの判定は、1 セッションに依頼 2 つ) */
const PER_WRITER = 3;
const TURNS_PER_SESSION = 2;
const ROUNDS = 10;
/** 始める前に 1 人で入れておくセッションの数。ファイルが大きいほど、読み直してから書くまでが長くなり、ロックが無ければ重なる
 * (小さいファイルでは、手元のフォルダでロックを外しても重ならなかった) */
const SEED = 2000;
const CANDIDATES = ['DEMO-101', 'DEMO-102'];

const UNC_DIR = process.env.ATLAS_TEST_UNC_DIR ?? '';
const UNC_SKIP_REASON = 'ATLAS_TEST_UNC_DIR が無いので、共有のフォルダ(UNC のパス)では確かめません(書き込める \\\\<host>\\<share>\\<フォルダ> を指すと動きます)';

/** 回・書き手・番号から作る、架空のセッション ID */
function sessionId(round: number, writer: number, n: number): string {
  const hex = (v: number, w: number) => v.toString(16).padStart(w, '0');
  return `c0ffee00-0000-4000-8000-${hex(round, 4)}${hex(writer, 4)}${hex(n, 4)}`;
}

const effortReply = (ids: string[], summary: string): string =>
  '```json\n' +
  JSON.stringify({
    items: ids.map((id) => ({
      sessionId: id,
      taskCategory: 'feature',
      taskSummary: summary,
      humanEffort: { hours: 3, low: 2, high: 5, confidence: 0.5, rationale: '根拠' },
      aiOutcome: { completed: true, quality: 4, rework: 0, rationale: '成果' },
      instructionsEffect: { score: 0, evidence: '参照なし' },
      wikiEffect: { score: 0, evidence: '参照なし' },
      skillsAgentsEffect: { score: 0, evidence: '参照なし' },
    })),
  }) +
  '\n```\n';

const turnsReply = (ids: string[], note: string): string =>
  '```json\n' +
  JSON.stringify({
    items: ids.flatMap((id) =>
      Array.from({ length: TURNS_PER_SESSION }, (_, i) => ({ sessionId: id, turn: i + 1, kind: 'question', outcome: 'follow_up', mismatch: null, phase: '調査', confidence: 0.5, note })),
    ),
  }) +
  '\n```\n';

const linksReply = (ids: string[], reason: string): string =>
  '```json\n' + JSON.stringify({ links: ids.map((id, i) => ({ sessionId: id, taskIds: [CANDIDATES[i % CANDIDATES.length]], confidence: 0.8, reason })) }) + '\n```\n';

/** tasks import が読む束(<out>/task-bundle の manifest.json と candidates.json。版 2。crates/atlas-judge/src/task_link.rs の read_task_bundle_manifest) */
async function writeTaskBundle(out: string, ids: string[]): Promise<void> {
  const dir = join(out, 'task-bundle');
  await mkdir(dir, { recursive: true });
  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    scope: {},
    count: ids.length,
    perPart: 10,
    files: { instructions: 'INSTRUCTIONS.md', schema: 'schema.json' },
    sessions: ids.map((id) => ({ id, path: `sessions/${id}.md`, chars: 10 })),
    parts: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'candidates.json'), JSON.stringify({ version: 2, sessions: Object.fromEntries(ids.map((id) => [id, CANDIDATES])) }));
}

interface Run {
  args: string[];
  status: number | null;
  out: string;
}

function runAtlas(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(...cliCommand(args), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (status) => resolve({ args, status, out }));
  });
}

type Judgments = { items: { sessionId: string; taskSummary: string }[] };
type Turns = { items: { sessionId: string; turn: number; note: string }[] };
type Links = { links: Record<string, { taskIds: string[]; source: string; reason: string }> };
type TasksState = { tasks: Record<string, unknown> };

/** 書いている間に、共有のファイルを読み続ける(画面のサーバの代わり)。書きかけ・一度あったファイルが消えた・読めなかったを数える */
function startReader(files: string[]): { stop: () => Promise<{ reads: number; problems: string[] }> } {
  let running = true;
  let reads = 0;
  const problems: string[] = [];
  const seen = new Set<string>(files.filter((f) => existsSync(f)));
  const loop = (async () => {
    while (running) {
      for (const f of files) {
        try {
          const text = await readFile(f, 'utf8');
          reads++;
          seen.add(f);
          try {
            JSON.parse(text);
          } catch (e) {
            problems.push(`${f}: 書きかけを読みました(${(e as Error).message})`);
          }
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' && !seen.has(f)) continue;
          problems.push(`${f}: 読めません(${code ?? (e as Error).message})`);
        }
      }
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return { reads, problems };
    },
  };
}

/** got が want と同じ(消えた・違う・余分なものが無い)。違えば、数と例を出す */
function expectUnion(name: string, want: Map<string, string>, got: Map<string, string>): void {
  const lost = [...want.keys()].filter((k) => !got.has(k));
  const changed = [...want.keys()].filter((k) => got.has(k) && got.get(k) !== want.get(k));
  const extra = [...got.keys()].filter((k) => !want.has(k));
  const show = (xs: string[]) => `${xs.length} 件${xs.length ? `(例: ${xs.slice(0, 3).join(', ')})` : ''}`;
  expect({ lost: lost.length, changed: changed.length, extra: extra.length }, `${name}: 消えた ${show(lost)}・中身が違う ${show(changed)}・余分 ${show(extra)}`).toEqual({ lost: 0, changed: 0, extra: 0 });
}

/** root の下に AtlasSettings を作り、何回かに分けて同時に書く。outBase は手元の出力先の置き場 */
async function raceInto(root: string, outBase: string, label: string): Promise<void> {
  const settings = join(root, 'AtlasSettings');
  await mkdir(settings, { recursive: true });
  copyFileSync(XML, join(settings, 'export.xml'));
  await writeFile(join(settings, 'atlas.config.json'), JSON.stringify({ tasks: { file: 'export.xml' } }));
  const collector = join(outBase, 'collector');
  await mkdir(collector, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, TZ: 'UTC', ATLAS_REPO_ROOT: collector };
  const shared = {
    judgments: join(settings, 'judgments.json'),
    turns: join(settings, 'turn-judgments.json'),
    links: join(settings, 'task-links.json'),
    tasks: join(settings, 'tasks.json'),
  };
  const wantJudgments = new Map<string, string>();
  const wantTurns = new Map<string, string>();
  const wantLinks = new Map<string, string>();
  let taskIds: string[] | null = null;
  const timings: string[] = [];
  // 0 回目は下地(1 人で SEED 件を入れる)。1 回目からが同時に書く回
  for (let round = 0; round <= ROUNDS; round++) {
    const jobs: { args: string[]; expect: string }[] = [];
    const writers = round === 0 ? 1 : WRITERS;
    const perWriter = round === 0 ? SEED : PER_WRITER;
    for (let w = 1; w <= writers; w++) {
      const ids = Array.from({ length: perWriter }, (_, n) => sessionId(round, w, n + 1));
      const tag = `${round} 回目の ${w} 人目`;
      // 出力先は書き手ごとに分ける(同じ出力先では、atlas は 2 つ目の処理を断る)
      const out = (kind: string) => join(outBase, `r${round}-w${w}-${kind}`);
      for (const k of ['judge', 'turns', 'tasks']) await mkdir(out(k), { recursive: true });
      const effort = join(out('judge'), 'effort.md');
      const turns = join(out('turns'), 'turns.md');
      const links = join(out('tasks'), 'links.md');
      await writeFile(effort, effortReply(ids, tag));
      await writeFile(turns, turnsReply(ids, tag));
      await writeFile(links, linksReply(ids, tag));
      await writeTaskBundle(out('tasks'), ids);
      jobs.push({ args: ['judge', 'import', effort, '--out', out('judge'), '--settings', settings], expect: `judge import: ${perWriter} 件を取り込みました` });
      jobs.push({ args: ['turns', 'import', turns, '--out', out('turns'), '--settings', settings], expect: `turns import: ${perWriter * TURNS_PER_SESSION} 件を取り込みました` });
      jobs.push({ args: ['tasks', 'import', links, '--out', out('tasks'), '--settings', settings], expect: `tasks import: ${perWriter} セッションの紐づけを取り込みました(出所 LLM)→ ${shared.links}` });
      ids.forEach((id, i) => {
        wantJudgments.set(id, tag);
        for (let t = 1; t <= TURNS_PER_SESSION; t++) wantTurns.set(`${id}#${t}`, tag);
        wantLinks.set(id, `llm:${CANDIDATES[i % CANDIDATES.length]}`);
      });
    }
    for (let s = 1; s <= (round === 0 ? 0 : SYNCS); s++) {
      const out = join(outBase, `r${round}-sync${s}`);
      await mkdir(out, { recursive: true });
      jobs.push({ args: ['tasks', 'sync', '--out', out, '--settings', settings], expect: `tasks sync: ` });
    }
    const reader = startReader(Object.values(shared));
    const started = performance.now();
    const runs = await Promise.all(jobs.map((j) => runAtlas(j.args, env)));
    const ms = Math.round(performance.now() - started);
    const read = await reader.stop();
    timings.push(`${round === 0 ? '下地' : `${round} 回目`}: ${jobs.length} プロセス ${ms} ms(読み手 ${read.reads} 回)`);
    runs.forEach((r, i) => {
      expect(r.status, `${r.args.join(' ')}\n${r.out}`).toBe(0);
      expect(r.out, r.args.join(' ')).toContain(jobs[i].expect);
    });
    expect(read.problems, read.problems.slice(0, 5).join('\n')).toEqual([]);

    // 全員の分の和になっている(同じセッションは書いた人のもの)
    const j = JSON.parse(await readFile(shared.judgments, 'utf8')) as Judgments;
    expectUnion('judgments.json', wantJudgments, new Map(j.items.map((i) => [i.sessionId, i.taskSummary])));
    const t = JSON.parse(await readFile(shared.turns, 'utf8')) as Turns;
    expectUnion('turn-judgments.json', wantTurns, new Map(t.items.map((i) => [`${i.sessionId}#${i.turn}`, i.note])));
    const l = JSON.parse(await readFile(shared.links, 'utf8')) as Links;
    expectUnion('task-links.json', wantLinks, new Map(Object.entries(l.links).map(([id, e]) => [id, `${e.source}:${e.taskIds.join(',')}`])));
    // タスクの状態は、同時に sync しても XML のタスクのまま(回をまたいでも変わらない)
    if (round > 0) {
      const st = JSON.parse(await readFile(shared.tasks, 'utf8')) as TasksState;
      const ids = Object.keys(st.tasks).sort();
      expect(ids).toEqual(expect.arrayContaining(['DEMO-101', 'DEMO-104']));
      if (taskIds) expect(ids).toEqual(taskIds);
      taskIds = ids;
    }
    // 一時ファイルを残さない(ロックのファイルは残してよい)
    expect(readdirSync(settings).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  }
  console.log(`[${label}] 書き手 ${WRITERS} 人 × 3 種類 + tasks sync ${SYNCS} を ${ROUNDS} 回(下地 ${SEED} セッション): 工数 ${wantJudgments.size} 件・依頼 ${wantTurns.size} 件・紐づけ ${wantLinks.size} 件\n  ${timings.join('\n  ')}`);
}

describe('別々のプロセスが同じ設定のフォルダに同時に書いても、どの書き込みも消えない', () => {
  afterAll(async () => {
    await rm(WORK, { recursive: true, force: true });
  });

  it('手元のフォルダ', async () => {
    await rm(WORK, { recursive: true, force: true });
    await raceInto(join(WORK, 'local-share'), join(WORK, 'local-out'), '手元');
  }, 120_000);

  it.skipIf(!UNC_DIR)(`共有のフォルダ(UNC のパス)${UNC_DIR ? '' : `: ${UNC_SKIP_REASON}`}`, async () => {
    expect(UNC_DIR.startsWith('\\\\'), `ATLAS_TEST_UNC_DIR は \\\\ で始まる UNC のパスにしてください: ${UNC_DIR}`).toBe(true);
    const root = join(UNC_DIR, `atlas-e2e-concurrent-${process.pid}-${Date.now()}`);
    try {
      await raceInto(root, join(WORK, 'unc-out'), `UNC ${root}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
