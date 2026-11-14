// M365 Copilot の自動操作での判定(m365.ts)。画面の操作(m365-uia.ps1)は差し替えて、
// 未判定のファイルだけを送ること・返答を取り込むこと・止まったら残りを送らないことを確かめる。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCli, UsageError } from '../src/args.ts';
import { CHAT_REQUEST } from '../src/chat-parts.ts';
import { jobArgs, MAIN_TS, parseJobRequest } from '../src/jobs.ts';
import { cleanCopilotReply, M365_DEFAULT_MODEL, M365_SCRIPT, M365FatalError, runM365Judge, type M365Driver, type M365Request } from '../src/m365.ts';

const item = (sessionId: string) => ({
  sessionId,
  taskCategory: 'feature',
  taskSummary: '要約',
  humanEffort: { hours: 2, low: 1, high: 4, confidence: 0.5, rationale: '根拠' },
  aiOutcome: { completed: true, quality: 4, rework: 1, rationale: '成果' },
  instructionsEffect: { score: 1, evidence: 'e' },
  wikiEffect: { score: 0, evidence: '参照なし' },
  skillsAgentsEffect: { score: 0, evidence: '参照なし' },
});
const reply = (ids: string[]) => `判定しました。\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'm365', ranAt: null }, items: ids.map(item) })}\n\`\`\``;

describe('M365 Copilot の自動操作での判定', () => {
  let dir: string;
  let out: string;
  const paths = () => ({ out, sessions: join(out, 'sessions.json'), judgments: join(out, 'judgments.json'), turnJudgments: join(out, 'turn-judgments.json'), turnBundle: join(out, 'turn-bundle') });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-m365-test-'));
    out = join(dir, 'out');
    await mkdir(join(out, 'bundle', 'parts'), { recursive: true });
    for (const [n, ids] of [['part-01.md', ['s1', 's2']], ['part-02.md', ['s3']], ['part-03.md', ['s4']]] as const) await writeFile(join(out, 'bundle', 'parts', n), `# 指示\nパケット ${ids.join(' ')}`);
    await writeFile(
      join(out, 'bundle', 'manifest.json'),
      JSON.stringify({
        version: 1,
        generatedAt: '2026-11-12T00:00:00.000Z',
        scope: { unjudged: 'yes' },
        count: 4,
        sessions: [],
        parts: [
          { path: 'parts/part-01.md', sessions: ['s1', 's2'], bytes: 30 },
          { path: 'parts/part-02.md', sessions: ['s3'], bytes: 20 },
          { path: 'parts/part-03.md', sessions: ['s4'], bytes: 20 },
        ],
      }),
    );
    await writeFile(join(out, 'sessions.json'), JSON.stringify({ version: 12, sessions: ['s1', 's2', 's3', 's4'].map((id) => ({ id })) }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 渡されたファイルの中のセッションを判定した返答を書く(part-02 は形の合わない返答) */
  const recorder = (calls: M365Request[], bad = new Set<string>()): M365Driver => async (req) => {
    calls.push(req);
    const text = await readFile(req.attach, 'utf8');
    const ids = text.split('\n')[1].replace('パケット ', '').split(' ');
    req.onProgress('送りました');
    await writeFile(req.outFile, bad.has(basename(req.attach)) ? 'すみません、判定できません。' : reply(ids));
  };

  it('未判定のファイルだけを .txt の名前で送り、返答を取り込む。形の合わない返答は残して次へ進む', async () => {
    const calls: M365Request[] = [];
    const logs: string[] = [];
    const s = await runM365Judge(paths(), { target: 'effort', model: M365_DEFAULT_MODEL, limit: null, timeoutSec: 60 }, (m) => logs.push(m), recorder(calls, new Set(['part-02.txt'])), 'win32');
    expect(calls.map((c) => basename(c.attach))).toEqual(['part-01.txt', 'part-02.txt', 'part-03.txt']);
    expect(calls[0]).toMatchObject({ prompt: CHAT_REQUEST, model: 'Think Deeper', timeoutSec: 60 });
    expect(s).toMatchObject({ attempted: 3, succeeded: 2, imported: 3, stopped: false });
    expect(s.failed.map((f) => f.name)).toEqual(['part-02.txt']);
    const j = JSON.parse(await readFile(join(out, 'judgments.json'), 'utf8')) as { items: { sessionId: string }[] };
    expect(j.items.map((i) => i.sessionId).sort()).toEqual(['s1', 's2', 's4']);
    // 返答は残す(取り込めなかったものを読んで直せるように)。添付に使った一時のファイルは消す
    expect(await readFile(join(out, 'bundle', 'replies', 'part-02.md'), 'utf8')).toContain('判定できません');
    expect(existsSync(calls[0].attach)).toBe(false);
    expect(logs.some((l) => l.includes('送りました'))).toBe(true);
    expect(logs.some((l) => l.includes('OneDrive'))).toBe(true);

    // 2 回目は、まだ判定できていない part-02 だけを送る
    const again: M365Request[] = [];
    const s2 = await runM365Judge(paths(), { target: 'effort', model: 'Auto', limit: null, timeoutSec: 60 }, () => {}, recorder(again), 'win32');
    expect(again.map((c) => basename(c.attach))).toEqual(['part-02.txt']);
    expect(s2).toMatchObject({ attempted: 1, succeeded: 1, imported: 1, failed: [] });
    const none: M365Request[] = [];
    expect(await runM365Judge(paths(), { target: 'effort', model: 'Auto', limit: null, timeoutSec: 60 }, () => {}, recorder(none), 'win32')).toMatchObject({ attempted: 0 });
    expect(none).toEqual([]);
  });

  const noPause = async () => {};

  it('画面が見つからないときはやり直さず、残りのファイルも送らない。--limit で送る数を絞れる。Windows 以外と、添付ファイルが無いときは止まる', async () => {
    const calls: string[] = [];
    const broken: M365Driver = async (req) => {
      calls.push(basename(req.attach));
      throw new M365FatalError('M365 Copilot の画面が見つかりません');
    };
    const s = await runM365Judge(paths(), { target: 'effort', model: 'Think Deeper', limit: null, timeoutSec: 60 }, () => {}, broken, 'win32', noPause);
    expect(calls).toEqual(['part-01.txt']);
    expect(s).toMatchObject({ attempted: 1, succeeded: 0, stopped: true, failed: [{ name: 'part-01.txt', reason: 'M365 Copilot の画面が見つかりません' }] });

    const limited: M365Request[] = [];
    expect(await runM365Judge(paths(), { target: 'effort', model: 'Think Deeper', limit: 1, timeoutSec: 60 }, () => {}, recorder(limited), 'win32')).toMatchObject({ attempted: 1, succeeded: 1 });

    await expect(runM365Judge(paths(), { target: 'effort', model: 'Think Deeper', limit: null, timeoutSec: 60 }, () => {}, recorder([]), 'linux')).rejects.toThrow(/Windows でだけ/);
    await expect(runM365Judge(paths(), { target: 'turns', model: 'Think Deeper', limit: null, timeoutSec: 60 }, () => {}, recorder([]), 'win32')).rejects.toThrow(/添付ファイルがまだありません/);
  });

  it('画面の操作が途中で崩れたら、同じファイルを既定で 2 回までやり直す。やり直しても崩れたら残りを送らない', async () => {
    // part-01 は 1 回目だけ崩れる → やり直しで通り、次へ進む
    const calls: string[] = [];
    const logs: string[] = [];
    const ok = recorder([]);
    const flaky: M365Driver = async (req) => {
      calls.push(basename(req.attach));
      if (calls.length === 1) throw new Error('添付した part-01.txt が 120 秒たっても見つかりません');
      await ok(req);
    };
    const s = await runM365Judge(paths(), { target: 'effort', model: 'Think Deeper', limit: null, timeoutSec: 60 }, (m) => logs.push(m), flaky, 'win32', noPause);
    expect(calls).toEqual(['part-01.txt', 'part-01.txt', 'part-02.txt', 'part-03.txt']);
    expect(s).toMatchObject({ attempted: 3, succeeded: 3, imported: 4, failed: [], stopped: false });
    expect(logs.some((l) => l.includes('やり直します(2/3 回目)'))).toBe(true);

    // 毎回崩れる → 3 回送って止まる。retries: 0 ならやり直さない
    await rm(join(out, 'judgments.json'), { force: true });
    const always: string[] = [];
    const broken: M365Driver = async (req) => {
      always.push(basename(req.attach));
      throw new Error('送ってから 180 秒たっても返答が始まりません');
    };
    expect(await runM365Judge(paths(), { target: 'effort', model: 'Think Deeper', limit: null, timeoutSec: 60 }, () => {}, broken, 'win32', noPause)).toMatchObject({ attempted: 1, stopped: true, failed: [{ name: 'part-01.txt' }] });
    expect(always).toEqual(['part-01.txt', 'part-01.txt', 'part-01.txt']);
    always.length = 0;
    await runM365Judge(paths(), { target: 'effort', model: 'Think Deeper', limit: null, timeoutSec: 60, retries: 0 }, () => {}, broken, 'win32', noPause);
    expect(always).toEqual(['part-01.txt']);
  });

  it('画面から読んだ返答(行番号とボタンの名前が混じり、囲みが無い)を、取り込める ```json に直す', () => {
    // M365 Copilot の画面を UI Automation で読んだときの形(行番号の行に行頭の空白が付き、本文は次の行。数字だけの本文の行もある)
    const raw = ['￼', '判定しました。', 'JSON', 'コードをコピー', 'その他のオプション', '￼', '1', '{', '2  ', '"items": [', '3    ', '7,', '4    ', '8', '5  ', ']', '6', '}', '応答のコピー', '気に入った点がある', '不満な点がある', '￼', 'その他のオプション'].join('\n');
    const md = cleanCopilotReply(raw);
    expect(md).toContain('判定しました。');
    expect(md).toContain('```json\n{\n  "items": [\n    7,\n    8\n  ]\n}\n```');
    expect(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(md)![1])).toEqual({ items: [7, 8] });
    expect(md).not.toContain('￼');
    // ノーブレークスペースだけの行(画面のコードに混じる)は、JSON として読めるように普通の空白にする
    const nbsp = cleanCopilotReply(['コードをコピー', '1', '[', '2  ', '7,', '3', ' ', '4  ', '8', '5', ']'].join('\n'));
    expect(JSON.parse(/```\n([\s\S]*?)\n```/.exec(nbsp)![1])).toEqual([7, 8]);
    // コードブロックの無い返答はそのまま
    expect(cleanCopilotReply('すみません、判定できません。')).toBe('すみません、判定できません。\n');
  });

  it('CLI とジョブ: judge m365 / turns m365 と、画面から始める m365 / turn-m365', () => {
    expect(parseCli(['judge', 'm365']).judge).toMatchObject({ action: 'm365', model: null, limit: null, timeoutSec: 900 });
    expect(parseCli(['judge', 'm365', '--model', 'Auto', '--limit', '2', '--timeout', '60']).judge).toMatchObject({ action: 'm365', model: 'Auto', limit: 2, timeoutSec: 60 });
    expect(parseCli(['turns', 'm365', '--limit', '3']).turns).toMatchObject({ action: 'm365', limit: 3, timeoutSec: 900 });
    for (const bad of [['judge', 'm365', '--only', 's1'], ['judge', 'm365', '--force'], ['judge', 'm365', '--backend', 'anthropic'], ['turns', 'm365', '--backend', 'anthropic']]) expect(() => parseCli(bad), bad.join(' ')).toThrow(UsageError);
    expect(parseJobRequest({ kind: 'm365' }, () => true)).toEqual({ kind: 'm365' });
    expect(parseJobRequest({ kind: 'turn-m365' }, () => true)).toEqual({ kind: 'turn-m365' });
    expect(() => parseJobRequest({ kind: 'm365', limit: 3 }, () => true)).toThrow(/使えない項目/);
    const p = { outDir: 'o', notesDir: 'n' };
    expect(jobArgs({ kind: 'm365' }, p)).toEqual([MAIN_TS, 'judge', 'm365', '--out', 'o', '--notes-dir', 'n']);
    expect(jobArgs({ kind: 'turn-m365' }, p)).toEqual([MAIN_TS, 'turns', 'm365', '--out', 'o', '--notes-dir', 'n']);
  });

  it('依頼文は画面の「チャットに渡す」と同じ。画面を操作するスクリプトは BOM 付きで、Windows PowerShell で読める', async () => {
    const ui = await readFile(new URL('../../report/src/app/components/ChatJudge.svelte', import.meta.url), 'utf8');
    expect(ui).toContain(`const REQUEST = '${CHAT_REQUEST}';`);
    const script = await readFile(M365_SCRIPT);
    expect([...script.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    if (process.platform !== 'win32') return;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${M365_SCRIPT.replace(/'/g, "''")}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }`], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
