// 毎日自動で送る(schedule-upload.bat → upload-schedule.ts、タスクから upload-auto.ts)。
// タスク スケジューラと PowerShell は偽物に替えて、尋ね方・登録の中身・結果の残し方を確かめる(この PC にタスクは登録しない)
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAutoUpload, type AutoDeps } from '../src/upload-auto.ts';
import type { AutoStatusFile } from '../src/upload-auto-files.ts';
import {
  describeStatus,
  describeUpdate,
  MAX_TIMES,
  nodeOf,
  parseTime,
  parseTimes,
  psErrorText,
  QUERY_SCRIPT,
  REGISTER_SCRIPT,
  runSchedule,
  TASK_NAME,
  taskArguments,
  taskScheduler,
  updatesOf,
  type PsRunner,
  type Scheduler,
  type ScheduleIo,
  type TaskState,
} from '../src/upload-schedule.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlas-sched-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('送る時刻と、タスクの中身', () => {
  it('時刻は「18:00」「18」「1830」「18時30分」「8:5」(全角も可)を HH:MM にし、読めない・範囲の外は null', () => {
    expect(parseTime('18:00')).toBe('18:00');
    expect(parseTime('18')).toBe('18:00');
    expect(parseTime('1830')).toBe('18:30');
    expect(parseTime('18時30分')).toBe('18:30');
    expect(parseTime('18時')).toBe('18:00');
    expect(parseTime('8:5')).toBe('08:05');
    expect(parseTime('１７：４５')).toBe('17:45');
    expect(parseTime(' 9:00 ')).toBe('09:00');
    for (const bad of ['24:00', '18:60', '夕方', '', '18:00:00', '-1']) expect(parseTime(bad)).toBeNull();
  });

  it('1 日に何回か送る時刻は「,」「、」や空白で区切り、早い順・重なりなしにする。1 つでも読めない・上限より多い・空なら null', () => {
    expect(parseTimes('18:00')).toEqual(['18:00']);
    expect(parseTimes('12:00,18:00')).toEqual(['12:00', '18:00']);
    expect(parseTimes('18、12')).toEqual(['12:00', '18:00']);
    expect(parseTimes('１８：００，１２：００')).toEqual(['12:00', '18:00']);
    expect(parseTimes(' 18:00  9:30 18時 ')).toEqual(['09:30', '18:00']);
    expect(parseTimes('12:00,,18:00,')).toEqual(['12:00', '18:00']);
    expect(parseTimes('12:00,夕方')).toBeNull();
    expect(parseTimes('12:00,24:00')).toBeNull();
    expect(parseTimes(' , ')).toBeNull();
    const many = Array.from({ length: MAX_TIMES + 1 }, (_, i) => `${i + 1}:00`).join(',');
    expect(parseTimes(many)).toBeNull();
    expect(parseTimes(Array.from({ length: MAX_TIMES }, (_, i) => `${i + 1}:00`).join(','))).toHaveLength(MAX_TIMES);
  });

  it('タスクは窓を出さずに(conhost --headless)、今の node で upload-auto.ts を動かす。node のパスは引数から取り出せる', () => {
    const args = taskArguments('C:\\Program Files\\nodejs\\node.exe', 'E:\\atlas\\packages\\cli\\src\\upload-auto.ts');
    expect(args).toBe('--headless "C:\\Program Files\\nodejs\\node.exe" "E:\\atlas\\packages\\cli\\src\\upload-auto.ts"');
    expect(nodeOf(args)).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(nodeOf('ほかのもの')).toBeNull();
  });

  it('送る前に atlas を新しい版にするのが既定。しないときは --no-update を付ける(この版より前に登録したタスクは、する)', () => {
    const on = taskArguments('C:\\node\\node.exe', 'E:\\a\\upload-auto.ts');
    const off = taskArguments('C:\\node\\node.exe', 'E:\\a\\upload-auto.ts', false);
    expect(off).toBe(`${on} --no-update`);
    expect(updatesOf(on)).toBe(true);
    expect(updatesOf(off)).toBe(false);
    expect(nodeOf(off)).toBe('C:\\node\\node.exe');
    expect(updatesOf('--headless "C:\\node\\node.exe" "E:\\a\\upload-auto.ts"')).toBe(true);
  });

  it('登録のスクリプトは、PC が止まっていた回を次に動かし、電池でも動かし、ログオン中の自分のユーザーで動かす(値は環境変数で渡す)', () => {
    expect(REGISTER_SCRIPT).toContain('-StartWhenAvailable');
    expect(REGISTER_SCRIPT).toContain('-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries');
    expect(REGISTER_SCRIPT).toContain('-LogonType Interactive');
    expect(REGISTER_SCRIPT).toContain('-MultipleInstances IgnoreNew');
    expect(REGISTER_SCRIPT).toContain("-Execute 'conhost.exe' -Argument $env:ATLAS_TASK_ARGS");
    expect(REGISTER_SCRIPT).toContain('-Force');
    // 時刻ごとに毎日のトリガーを 1 つずつ作る
    expect(REGISTER_SCRIPT).toContain("$env:ATLAS_TASK_TIMES -split ','");
  });

  it('タスク スケジューラの操作は、名前・時刻・引数を環境変数で渡し、結果の JSON を読む。失敗したら PowerShell のエラーの文を添える', async () => {
    const calls: { script: string; env: Record<string, string> }[] = [];
    const replies: { code: number; stdout: string; stderr: string }[] = [
      { code: 0, stdout: '{"exists":true,"state":"Ready","times":["12:00","18:30"],"arguments":"--headless \\"n\\" \\"e\\"","lastRun":null,"lastResult":267011,"nextRun":"2026-11-12T18:30:00"}', stderr: '' },
      // トリガーの無いタスクは、PowerShell 5.1 だと times が null で届くことがある
      { code: 0, stdout: '{"exists":true,"state":"Ready","times":null,"arguments":"","lastRun":null,"lastResult":null,"nextRun":null}', stderr: '' },
      { code: 0, stdout: '{"exists":false}', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      {
        code: 1,
        stdout: '',
        stderr: '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Register-ScheduledTask : アクセスが拒否されました。_x000D__x000A_</S><S S="Error">発生場所 行:1</S></Objs>',
      },
    ];
    const run: PsRunner = async (script, env) => (calls.push({ script, env }), replies.shift()!);
    const s = taskScheduler(run, { node: 'C:\\node\\node.exe', entry: 'E:\\a\\upload-auto.ts', cwd: 'E:\\a' });
    expect(await s.query()).toMatchObject({ exists: true, times: ['12:00', '18:30'], nextRun: '2026-11-12T18:30:00' });
    expect(calls[0]).toEqual({ script: QUERY_SCRIPT, env: { ATLAS_TASK_NAME: TASK_NAME } });
    expect(await s.query()).toMatchObject({ exists: true, times: [] });
    expect(await s.query()).toEqual({ exists: false });
    await s.register(['07:05', '12:30']);
    expect(calls[3]!.script).toBe(REGISTER_SCRIPT);
    expect(calls[3]!.env).toMatchObject({ ATLAS_TASK_NAME: TASK_NAME, ATLAS_TASK_TIMES: '07:05,12:30', ATLAS_TASK_ARGS: '--headless "C:\\node\\node.exe" "E:\\a\\upload-auto.ts"', ATLAS_TASK_CWD: 'E:\\a' });
    expect(calls[3]!.env.ATLAS_TASK_DESCRIPTION).toContain('毎日 07:05・12:30 に、atlas を新しい版にしてから');
    await expect(s.unregister()).rejects.toThrow('タスクを消せませんでした(Register-ScheduledTask : アクセスが拒否されました。)');
  });

  it('PowerShell のエラー(CLIXML)から、エラーの文だけを取り出す。CLIXML でなければそのまま', () => {
    expect(psErrorText('#< CLIXML\n<Objs><Obj S="progress"><AV>準備しています</AV></Obj><S S="Error">失敗 &amp; 理由_x000D__x000A_</S></Objs>')).toBe('失敗 & 理由');
    expect(psErrorText('  ふつうの文\n')).toBe('ふつうの文');
  });

  it('前回の結果は 1 行で出す(送れた数・秘密らしい文字列の数・送れなかった理由・終わっていない)', () => {
    const base: AutoStatusFile = { startedAt: '2026-11-11T09:00:00.000Z', finishedAt: '2026-11-11T09:01:00.000Z', ok: true, error: null, sent: [{ name: 'a', sessions: 3 }, { name: 'b', sessions: 2 }], secrets: 0, root: 'X:\\logs' };
    expect(describeStatus(base)).toMatch(/^前回: 2026-11-11 \d\d:01 に 2 プロジェクト・5 セッションを送りました。$/);
    expect(describeStatus({ ...base, secrets: 4 })).toContain('(秘密らしい文字列 4 件を含む)');
    // 前に送ったときから変わっていないので送らなかったものも出す
    expect(describeStatus({ ...base, sent: [{ name: 'a', sessions: 1, unchanged: 7 }, { name: 'b', sessions: 0, unchanged: 3 }], secrets: 2 })).toMatch(
      /に 2 プロジェクト・1 セッションを送りました\(変わっていない 10 セッションはそのまま・秘密らしい文字列 2 件を含む\)。$/,
    );
    expect(describeStatus({ ...base, ok: false, error: '送り先が見つかりません' })).toMatch(/に送れませんでした: 送り先が見つかりません$/);
    expect(describeStatus({ ...base, finishedAt: null })).toContain('まだ終わっていません');
  });

  it('送る前の更新は、知らせることがあるときだけ 1 行で出す(最新だった・記録が無いときは出さない)', () => {
    const base: AutoStatusFile = { startedAt: '2026-11-11T09:00:00.000Z', finishedAt: '2026-11-11T09:01:00.000Z', ok: true, error: null, sent: [], secrets: 0, root: 'X:\\logs' };
    expect(describeUpdate(base)).toBeNull();
    expect(describeUpdate({ ...base, update: null })).toBeNull();
    expect(describeUpdate({ ...base, update: { outcome: 'latest', from: 'aaaaaaa', to: 'aaaaaaa', note: '最新です(aaaaaaa)' } })).toBeNull();
    expect(describeUpdate({ ...base, update: { outcome: 'updated', from: 'aaaaaaa', to: 'bbbbbbb', note: 'aaaaaaa から bbbbbbb に更新しました' } })).toBe('atlas の更新: aaaaaaa から bbbbbbb に更新しました。');
    expect(describeUpdate({ ...base, update: { outcome: 'skipped', from: 'aaaaaaa', to: null, note: 'atlas のファイルを手で変えているので、更新しません' } })).toBe(
      'atlas の更新: atlas のファイルを手で変えているので、更新しません。',
    );
    expect(describeUpdate({ ...base, update: { outcome: 'failed', from: 'aaaaaaa', to: null, note: '新しい版を取りに行けなかったので、今の版のまま送ります' } })).toBe('atlas の更新: 新しい版を取りに行けなかったので、今の版のまま送ります。');
  });
});

describe('登録の対話(runSchedule)', () => {
  /** 偽のタスク スケジューラ(登録・動かす・消すを記録する) */
  const fakeScheduler = (state: TaskState, onStart?: () => Promise<void>) => {
    const log: string[] = [];
    const s: Scheduler = {
      query: async () => state,
      register: async (t, update = true) => void log.push(`register ${t.join(',')}${update ? '' : ' no-update'}`),
      start: async () => {
        log.push('start');
        await onStart?.();
      },
      unregister: async () => void log.push('unregister'),
    };
    return { s, log };
  };
  const fakeIo = (answers: string[]) => {
    const printed: string[] = [];
    const asked: string[] = [];
    const io: ScheduleIo = { ask: async (q) => (asked.push(q), answers.shift() ?? ''), print: (l) => printed.push(l) };
    return { io, printed, asked, text: () => printed.join('\n') };
  };
  const ready = async () => ({ uploadRoot: dir, uploadProjects: ['owner/app', 'X:\\work\\tool'] });
  const registered: TaskState = { exists: true, state: 'Ready', times: ['18:00'], arguments: '--headless "C:\\node\\node.exe" "E:\\a\\upload-auto.ts"', lastRun: null, lastResult: null, nextRun: '2026-11-12T18:00:00' };

  it('登録していなくて、送り先か印が無ければ、先に決めることを出して何も登録しない(尋ねない)', async () => {
    const f = fakeIo([]);
    const { s, log } = fakeScheduler({ exists: false });
    await runSchedule(f.io, { scheduler: s, config: async () => ({ uploadRoot: null, uploadProjects: null }), outDir: dir });
    expect(log).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(f.text()).toContain('送り先を決めてください');
    expect(f.text()).toContain('送るプロジェクトに印を付けてください');
    expect(f.text()).toContain('何も登録していません');
  });

  it('登録していなければ、決まり(確認を出さずに送る・秘密らしい文字列があっても送る)を見せて時刻を尋ね、登録する。読めない時刻は入れ直せる', async () => {
    const f = fakeIo(['夕方', '17:30', '']);
    const { s, log } = fakeScheduler({ exists: false });
    await runSchedule(f.io, { scheduler: s, config: ready, outDir: dir });
    expect(log).toEqual(['register 17:30']);
    const text = f.text();
    expect(text).toContain('送る前の確認(送り先・大きさ・秘密らしい文字列)は出しません。秘密らしい文字列があっても送り');
    expect(text).toContain('次に PC を使い始めたときに送ります');
    expect(text).toContain('画面で印を付けた 2 プロジェクト(owner/app、X:\\work\\tool)');
    expect(text).toContain('「夕方」は時刻として読めません');
    expect(text).toContain('登録しました。毎日 17:30 に送ります。');
  });

  it('時刻を入れずに Enter なら 18:00、n ならやめる(何も登録しない)', async () => {
    const a = fakeScheduler({ exists: false });
    await runSchedule(fakeIo(['', '']).io, { scheduler: a.s, config: ready, outDir: dir });
    expect(a.log).toEqual(['register 18:00']);
    const b = fakeScheduler({ exists: false });
    const f = fakeIo(['n']);
    await runSchedule(f.io, { scheduler: b.s, config: ready, outDir: dir });
    expect(b.log).toEqual([]);
    expect(f.text()).toContain('やめました(何も登録していません)。');
  });

  it('登録した後に y なら今すぐ 1 回動かし、終わるのを待って結果を出す', async () => {
    const f = fakeIo(['', 'y']);
    const { s, log } = fakeScheduler({ exists: false }, async () => {
      // タスクが動いて結果を書いたことにする
      const st: AutoStatusFile = { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, error: null, sent: [{ name: 'owner/app', sessions: 2 }], secrets: 0, root: dir };
      await writeFile(join(dir, 'auto-upload.json'), JSON.stringify(st));
    });
    await runSchedule(f.io, { scheduler: s, config: ready, outDir: dir, pollMs: 1 });
    expect(log).toEqual(['register 18:00', 'start']);
    expect(f.text()).toMatch(/に 1 プロジェクト・2 セッションを送りました。/);
  });

  it('試しに動かしても終わらなければ、待つのをやめて結果の見方を出す(前の回の結果を今回のものと取り違えない)', async () => {
    const old: AutoStatusFile = { startedAt: '2026-11-10T09:00:00.000Z', finishedAt: '2026-11-10T09:01:00.000Z', ok: true, error: null, sent: [], secrets: 0, root: dir };
    await writeFile(join(dir, 'auto-upload.json'), JSON.stringify(old));
    const f = fakeIo(['s']);
    const { s } = fakeScheduler(registered);
    await runSchedule(f.io, { scheduler: s, config: ready, outDir: dir, pollMs: 1, waitMs: 20 });
    expect(f.text()).toContain('まだ終わっていません。結果は、もう一度 schedule-upload.bat を開くと見られます');
  });

  it('登録してあれば、時刻・次の回・前回の結果を見せる。t で時刻を変え(Enter なら今の時刻のまま)、d で登録を消す', async () => {
    const st: AutoStatusFile = { startedAt: '2026-11-11T09:00:00.000Z', finishedAt: '2026-11-11T09:02:00.000Z', ok: false, error: '覚えている送り先が見つかりません', sent: [], secrets: 0, root: null };
    await writeFile(join(dir, 'auto-upload.json'), JSON.stringify(st));
    const a = fakeScheduler(registered);
    const f = fakeIo(['t', '']);
    await runSchedule(f.io, { scheduler: a.s, config: ready, outDir: dir, exists: (p) => p === dir || p.endsWith('node.exe') });
    expect(a.log).toEqual(['register 18:00']);
    expect(f.text()).toMatch(/毎日 18:00 に送ります\(次: 2026-11-12 18:00\)。/);
    expect(f.text()).toContain('に送れませんでした: 覚えている送り先が見つかりません');
    expect(f.text()).toContain('登録し直しました。毎日 18:00 に送ります。');
    const b = fakeScheduler(registered);
    const g = fakeIo(['d']);
    await runSchedule(g.io, { scheduler: b.s, config: ready, outDir: dir });
    expect(b.log).toEqual(['unregister']);
    expect(g.text()).toContain('登録を消しました');
    // Enter だけなら何もしない
    const c = fakeScheduler(registered);
    await runSchedule(fakeIo(['']).io, { scheduler: c.s, config: ready, outDir: dir });
    expect(c.log).toEqual([]);
  });

  it('1 日に何回か送る時刻を「,」で区切って登録でき、登録してあれば全部の時刻を見せる。t で Enter なら今の時刻を全部そのまま残す', async () => {
    const a = fakeScheduler({ exists: false });
    const f = fakeIo(['18:00,12:00,夕方', '18:00,12:00', '']);
    await runSchedule(f.io, { scheduler: a.s, config: ready, outDir: dir });
    expect(a.log).toEqual(['register 12:00,18:00']);
    expect(f.asked[0]).toContain('12:00,18:00 のように「,」で区切る');
    expect(f.text()).toContain(`18:00 や 12:00,18:00 の形で入れ直してください(1 日に ${MAX_TIMES} 回まで)`);
    expect(f.text()).toContain('登録しました。毎日 12:00・18:00 に送ります。');

    const twice: TaskState = { ...registered, times: ['12:00', '18:00'], nextRun: '2026-11-12T12:00:00' };
    const b = fakeScheduler(twice);
    const g = fakeIo(['t', '']);
    await runSchedule(g.io, { scheduler: b.s, config: ready, outDir: dir, exists: () => true });
    expect(g.text()).toMatch(/毎日 12:00・18:00 に送ります\(次: 2026-11-12 12:00\)。/);
    expect(g.asked[1]).toContain('Enter だけなら 12:00・18:00');
    expect(b.log).toEqual(['register 12:00,18:00']);
    expect(g.text()).toContain('登録し直しました。毎日 12:00・18:00 に送ります。');

    // 1 日 1 回に戻す
    const c = fakeScheduler(twice);
    await runSchedule(fakeIo(['t', '17:30']).io, { scheduler: c.s, config: ready, outDir: dir, exists: () => true });
    expect(c.log).toEqual(['register 17:30']);

    // トリガーが無くなったタスク(タスク スケジューラで消した)は時刻不明と出し、t の Enter は 18:00
    const d = fakeScheduler({ ...registered, times: [] });
    const h = fakeIo(['t', '']);
    await runSchedule(h.io, { scheduler: d.s, config: ready, outDir: dir, exists: () => true });
    expect(h.text()).toContain('毎日 (時刻不明) に送ります');
    expect(d.log).toEqual(['register 18:00']);
  });

  it('自動更新: 登録の決まりで知らせ、登録してあれば様子と前回の更新を見せる。u で切り替え、t は今の設定のまま登録し直す', async () => {
    const a = fakeScheduler({ exists: false });
    const f = fakeIo(['', '']);
    await runSchedule(f.io, { scheduler: a.s, config: ready, outDir: dir });
    expect(f.text()).toContain('送る前に、atlas を新しい版にします(git pull。依存が変わっていれば npm install も)');
    expect(a.log).toEqual(['register 18:00']);

    const st: AutoStatusFile = {
      startedAt: '2026-11-11T09:00:00.000Z',
      finishedAt: '2026-11-11T09:02:00.000Z',
      ok: true,
      error: null,
      sent: [{ name: 'a', sessions: 1 }],
      secrets: 0,
      root: dir,
      update: { outcome: 'updated', from: 'aaaaaaa', to: 'bbbbbbb', note: 'aaaaaaa から bbbbbbb に更新しました' },
    };
    await writeFile(join(dir, 'auto-upload.json'), JSON.stringify(st));
    const b = fakeScheduler(registered);
    const g = fakeIo(['u']);
    await runSchedule(g.io, { scheduler: b.s, config: ready, outDir: dir, exists: () => true });
    expect(g.text()).toContain('atlas の自動更新: 送る前に、atlas を新しい版にします');
    expect(g.text()).toContain('atlas の更新: aaaaaaa から bbbbbbb に更新しました。');
    expect(g.asked[0]).toContain('u = atlas の自動更新をやめる');
    expect(b.log).toEqual(['register 18:00 no-update']);
    expect(g.text()).toContain('これからは、送る前に atlas を新しい版にしません');

    const off: TaskState = { ...registered, arguments: `${registered.arguments} --no-update` };
    const c = fakeScheduler(off);
    const h = fakeIo(['u']);
    await runSchedule(h.io, { scheduler: c.s, config: ready, outDir: dir, exists: () => true });
    expect(h.text()).toContain('atlas の自動更新: しません');
    expect(h.asked[0]).toContain('u = atlas の自動更新をする');
    expect(c.log).toEqual(['register 18:00']);

    // t で時刻を変えても、自動更新の設定はそのまま
    const d = fakeScheduler(off);
    await runSchedule(fakeIo(['t', '17:30']).io, { scheduler: d.s, config: ready, outDir: dir, exists: () => true });
    expect(d.log).toEqual(['register 17:30 no-update']);
  });

  it('登録したときの Node.js が無くなっていたり、タスクが無効になっていたりしたら、登録し直すよう知らせる', async () => {
    const f = fakeIo(['']);
    const { s } = fakeScheduler({ ...registered, state: 'Disabled' });
    await runSchedule(f.io, { scheduler: s, config: ready, outDir: dir, exists: (p) => p === dir });
    expect(f.text()).toContain('登録したときの Node.js が見つかりません(C:\\node\\node.exe)。t で登録し直してください。');
    expect(f.text()).toContain('「無効」になっています');
    expect(f.text()).toContain('まだ 1 回も動いていません。');
  });
});

describe('自動で送る本体(runAutoUpload)', () => {
  const deps = (o: Partial<AutoDeps> = {}) => {
    const lines: string[] = [];
    const notes: string[] = [];
    const d: AutoDeps = {
      outDir: dir,
      log: (l) => lines.push(l),
      aggregate: async () => true,
      upload: async (summary) => {
        summary.sent.push({ name: 'owner/app', sessions: 2 });
        summary.secrets = 1;
        summary.root = 'X:\\logs';
        return true;
      },
      busy: () => null,
      notify: async (title, body) => void notes.push(`${title}|${body}`),
      sleep: async () => {},
      ...o,
    };
    return { d, lines, notes };
  };
  const status = async () => JSON.parse(await readFile(join(dir, 'auto-upload.json'), 'utf8')) as AutoStatusFile;

  it('集計し直してから送り、送ったものを結果のファイルに残す(送れたときは知らせない)', async () => {
    const { d, notes } = deps({ update: { outcome: 'updated', from: 'aaaaaaa', to: 'bbbbbbb', note: 'aaaaaaa から bbbbbbb に更新しました' } });
    expect(await runAutoUpload(d)).toBe(true);
    expect(await status()).toMatchObject({ ok: true, error: null, sent: [{ name: 'owner/app', sessions: 2 }], secrets: 1, root: 'X:\\logs', update: { outcome: 'updated', to: 'bbbbbbb' } });
    expect((await status()).finishedAt).not.toBeNull();
    expect(notes).toEqual([]);
  });

  it('画面で集計し直している間は、終わるのを待ってから始める。待っても終わらなければ送らずに知らせる', async () => {
    let n = 0;
    const a = deps({ busy: () => (n++ < 2 ? 'refresh' : null) });
    expect(await runAutoUpload(a.d)).toBe(true);
    expect(a.lines.filter((l) => l.includes('終わるのを待ちます'))).toHaveLength(2);
    const b = deps({ busy: () => 'refresh', busyWaitMs: -1 });
    expect(await runAutoUpload(b.d)).toBe(false);
    expect((await status()).error).toContain('別の処理(refresh)が出力先で動き続けているので、送りませんでした');
    expect(b.notes).toHaveLength(1);
  });

  it('集計か送るのに失敗したら、理由を結果のファイルと記録に残し、Windows の通知で知らせる。通知に失敗しても止まらない', async () => {
    const a = deps({ aggregate: async () => false });
    expect(await runAutoUpload(a.d)).toBe(false);
    expect(await status()).toMatchObject({ ok: false, error: '集計に失敗しました(理由は記録に書きました)' });
    expect(a.notes[0]).toMatch(/^agent-session-atlas: 自動で送れませんでした\|集計に失敗しました.*\nschedule-upload\.bat を開くと/);
    const b = deps({
      upload: async () => {
        throw new Error('覚えている送り先が見つかりません: X:\\gone');
      },
      notify: async () => {
        throw new Error('通知の失敗');
      },
    });
    expect(await runAutoUpload(b.d)).toBe(false);
    expect((await status()).error).toBe('覚えている送り先が見つかりません: X:\\gone');
    expect(b.lines).toContain('通知を出せませんでした: 通知の失敗');
  });

  it('途中で送り終えなかったとき(false)も失敗として残す。送れた分は結果に残る', async () => {
    const { d } = deps({
      upload: async (summary) => {
        summary.sent.push({ name: 'a', sessions: 1 });
        return false;
      },
    });
    expect(await runAutoUpload(d)).toBe(false);
    expect(await status()).toMatchObject({ ok: false, sent: [{ name: 'a', sessions: 1 }] });
  });
});
