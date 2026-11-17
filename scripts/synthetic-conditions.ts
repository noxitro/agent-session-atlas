// 「課題 × 条件」の表を確かめる架空の fixture。値・名前・パスはすべて作ったもの。
//  - 課題 2 つ × 条件 3 つ × 3 回 = 18 セッション。タスクタグの名前は「課題__条件__番号」。
//    課題 × 条件の行は 3 件ずつ、条件ごと(課題をまとめた行)は 6 件ずつになる
//  - セッションの中では「リクエスト 1 回 → テストの実行 1 回」を繰り返す。テストの実行は、印つきの行(ATLAS_TEST_RESULT)を
//    出すシェルの呼び出しで、落ちた実行はツールの失敗として残る(終了コードが 0 でない実行と同じ形)
//  - 何回目で全部通るかは PLAN の表のとおり(null は最後まで通らない)。1 件だけ、通った後にもう一度走らせて落ちる
//  - 利用の確認: wiki の条件のセッションは、テストの後に llm-wiki の索引を読む(1 件だけ読まない)。素の条件の 1 件も読む(条件の漏れ)。
//    コード参照の条件のセッションは、テストの後に MCP サーバーのツールを呼ぶ。wiki を数えるには、設定の wikis に COND_WIKI を入れて集計する
//  - 端の場合: テストの印の無いセッション(課題・条件のタグはある)、条件が 1 つしか無い課題(ほかの条件は 0 件の行になる。
//    テストの印も無い)、課題と条件の違うタグが 2 つ付いたセッション、決まりに合わないタグ(区切りなし / 区切りはあるが形が違う)のセッション
//  - wiki の手入れ(タスクタグなし。表には入らない): vault のページを編集するだけのセッション(書き込みだけ)と、索引を読んでから編集するセッション
// 書き出す形は 2 つ: ~/.copilot の形(タスクタグは groups.json で渡す)と、送り先をまとめて集計する形(タスクタグは各セッションの atlas-session.json)。
// 単独で書くとき: node scripts/synthetic-conditions.ts <書き出すフォルダ>
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { lines, timeOf, type Ev, type Gap } from './synthetic-lib.ts';

export const COND_TASKS = ['zz-input', 'zz-render'] as const;
/** 名前の順(数字は数として比べる)に並ぶ。先頭に置きたい条件は、名前の頭に数字を付ける */
export const COND_CONDITIONS = ['0-plain', 'coderef', 'wiki'] as const;
export const COND_REPS = 3;
/** 条件が 1 つ(wiki)しか無く、テストの印も無い課題。番号の無い名前(課題__条件)で付ける */
export const COND_SOLO_TASK = 'zz-solo';
export const COND_PEOPLE = ['zz-user-a', 'zz-user-b'] as const;
export const COND_FOLDER = 'zz-condition-study';
const MODEL = 'claude-sonnet-5.5';
const START = Date.UTC(2026, 9, 6, 12);
const HOUR = 3600 * 1000;

type Task = (typeof COND_TASKS)[number];
type Condition = (typeof COND_CONDITIONS)[number];

/** 最初に全部通る実行の番号(課題・条件ごとに 3 回分。null は最後まで通らず、3 回走らせて終える) */
export const PLAN: Record<Condition, Record<Task, (number | null)[]>> = {
  '0-plain': { 'zz-render': [3, 4, null], 'zz-input': [2, null, 3] },
  wiki: { 'zz-render': [2, 2, 3], 'zz-input': [1, 2, 2] },
  coderef: { 'zz-render': [1, 2, 1], 'zz-input': [1, 1, 2] },
};
/** リクエスト 1 回の AI 使用量(AIU) */
export const AIU_PER_REQUEST: Record<Condition, number> = { '0-plain': 1, wiki: 1.5, coderef: 2 };
/** 通った後の、まとめのリクエストの AI 使用量(AIU)。「最初に全部通るまで」には入らない */
export const AIU_AFTER = 0.5;
/** 通った後にもう一度走らせて落ちるセッション(通った後に不合格) */
export const REGRESSED = { task: 'zz-render', condition: 'coderef', rep: 2 } as const;
/** 利用の確認: llm-wiki の vault の名前(設定の wikis に入れる)と、コード参照の MCP サーバー */
export const COND_WIKI = 'zz-wiki';
export const COND_MCP = 'zz-code';
/** wiki の条件なのに wiki を読まないセッションと、素の条件なのに wiki を読むセッション */
export const WIKI_MISSING = { task: 'zz-input', condition: 'wiki', rep: 2 } as const;
export const WIKI_LEAK = { task: 'zz-render', condition: '0-plain', rep: 1 } as const;
/** この fixture を集計するときの設定(wiki の参照を数える) */
export const conditionConfig = (): { wikis: string[] } => ({ wikis: [COND_WIKI] });

/** 最後まで通らないセッションが走らせる回数 */
const UNREACHED_RUNS = 3;

/** 架空のセッション ID(00000000-0000-4000-8000-0000006NNNNN。ほかの fixture の番号と重ならない) */
export const condId = (n: number): string => `00000000-0000-4000-8000-${String(600_000 + n).padStart(12, '0')}`;
export const condTag = (task: string, condition: string, rep: number): string => `${task}__${condition}__${rep}`;

interface Plan {
  id: string;
  person: string;
  start: number;
  tags: string[];
  events: (Ev | Gap)[];
}

const usage = (aiu: number): Ev => ({
  type: 'session.usage_record',
  data: { usage: { model: MODEL, inputTokens: 8_000, outputTokens: 400, cacheReadTokens: 4_000, cacheWriteTokens: 0, reasoningTokens: 100, cost: 1, initiator: 'user', copilotUsage: { totalNanoAiu: aiu * 1e9 } } },
});

/** リクエスト 1 回とテストの実行 1 回(合わせて 1 分)。failing が 0 でなければ、ツールは失敗を返す */
function run(start: number, before: (Ev | Gap)[], call: string, aiu: number, failing: number): (Ev | Gap)[] {
  // 印の行の at は、この実行の完了の時刻(同じ at の行は 2 回目から数えないので、実行ごとに違う値にする)
  const head: (Ev | Gap)[] = [...before, usage(aiu), { type: 'tool.execution_start', data: { toolCallId: call, toolName: 'powershell', arguments: { command: '.\\run-tests.exe' } } }];
  const done: Ev = { type: 'tool.execution_complete', data: {} };
  const at = timeOf([...head, done], new Date(start).toISOString(), head.filter((e) => !('gapMs' in e)).length);
  const mark = (name: string, passed: boolean, n: number): string => `ATLAS_TEST_RESULT ${JSON.stringify({ v: 1, name, passed, counts: { assertFailures: n }, at })}`;
  const text = ['building...', mark('zz-test-a', failing === 0, failing), mark('zz-test-b', true, 0)].join('\n');
  done.data = failing === 0 ? { toolCallId: call, success: true, result: { content: text } } : { toolCallId: call, success: false, error: { code: 'failure', message: text } };
  return [...head.slice(before.length), done, { gapMs: 57_000 }];
}

/** テストの後の、条件に応じたツールの呼び出し(wiki の索引を読む / MCP サーバーのツール) */
const wikiRead = (n: number): Ev[] => [
  { type: 'tool.execution_start', data: { toolCallId: `call_wiki_${n}`, toolName: 'view', arguments: { path: `X:\\synthetic-notes\\${COND_WIKI}\\index.md` } } },
  { type: 'tool.execution_complete', data: { toolCallId: `call_wiki_${n}`, success: true, result: { content: '(合成の索引)' } } },
];
const mcpCall = (n: number): Ev[] => [
  { type: 'tool.execution_start', data: { toolCallId: `call_mcp_${n}`, toolName: `${COND_MCP}-find`, mcpServerName: COND_MCP, arguments: { query: 'zz' } } },
  { type: 'tool.execution_complete', data: { toolCallId: `call_mcp_${n}`, success: true, result: { content: '(合成の検索結果)' } } },
];

function testedSession(id: string, start: number, cwd: string, firstPass: number | null, aiu: number, regress: boolean, after: Ev[] = []): (Ev | Gap)[] {
  const ev: (Ev | Gap)[] = [
    { type: 'session.start', data: { sessionId: id, version: 1, copilotVersion: '1.0.110', selectedModel: MODEL, context: { cwd } } },
    { type: 'user.message', data: { content: '合成の課題を実装して、テストが通るまで直して' } },
  ];
  const runs = firstPass ?? UNREACHED_RUNS;
  for (let k = 1; k <= runs; k++) ev.push(...run(start, ev, `call_synth_${k}`, aiu, firstPass === k ? 0 : 2));
  if (regress) ev.push(...run(start, ev, `call_synth_${runs + 1}`, aiu, 1));
  ev.push(...after);
  ev.push(usage(AIU_AFTER), { type: 'assistant.message', data: { messageId: 'm1', content: '合成の応答', model: MODEL } }, { type: 'assistant.turn_end', data: { turnId: 't1' } });
  return ev;
}

/** wiki の手入れのセッション(タスクタグなし): vault のページを編集する。read なら先に索引を読む(参照と書き込みの両方)、でなければ書き込みだけ */
function wikiWriteSession(id: string, cwd: string, read: boolean): Ev[] {
  const n = read ? 92 : 91;
  return [
    { type: 'session.start', data: { sessionId: id, version: 1, copilotVersion: '1.0.110', selectedModel: MODEL, context: { cwd } } },
    { type: 'user.message', data: { content: '合成の wiki のページを直して' } },
    ...(read ? wikiRead(n) : []),
    { type: 'tool.execution_start', data: { toolCallId: `call_wiki_edit_${n}`, toolName: 'edit', arguments: { path: `X:\\synthetic-notes\\${COND_WIKI}\\wiki\\zz-page.md`, old_str: '古い', new_str: '新しい' } } },
    { type: 'tool.execution_complete', data: { toolCallId: `call_wiki_edit_${n}`, success: true, result: { content: '(合成の編集)' } } },
    { type: 'assistant.message', data: { messageId: 'm1', content: '合成の応答', model: MODEL } },
    { type: 'assistant.turn_end', data: { turnId: 't1' } },
  ];
}

function plainSession(id: string, cwd: string): Ev[] {
  return [
    { type: 'session.start', data: { sessionId: id, version: 1, copilotVersion: '1.0.110', selectedModel: MODEL, context: { cwd } } },
    { type: 'user.message', data: { content: '合成の課題について説明して' } },
    { type: 'assistant.message', data: { messageId: 'm1', content: '合成の応答', model: MODEL } },
    { type: 'assistant.turn_end', data: { turnId: 't1' } },
  ];
}

export function conditionPlans(): Plan[] {
  const out: Plan[] = [];
  let n = 0;
  const next = (person: string, tags: string[], make: (id: string, start: number, cwd: string) => (Ev | Gap)[]): void => {
    n++;
    const id = condId(n);
    const start = START + n * HOUR;
    out.push({ id, person, start, tags, events: make(id, start, `X:\\synthetic-conditions\\${person}`) });
  };
  for (const task of COND_TASKS) {
    for (const condition of COND_CONDITIONS) {
      for (let rep = 1; rep <= COND_REPS; rep++) {
        // 1・2 回目は 1 人目、3 回目は 2 人目(送り先の形では、同じ課題・条件を 2 人が実行したことになる)
        const person = COND_PEOPLE[rep === COND_REPS ? 1 : 0];
        const regress = task === REGRESSED.task && condition === REGRESSED.condition && rep === REGRESSED.rep;
        const is = (x: { task: string; condition: string; rep: number }): boolean => task === x.task && condition === x.condition && rep === x.rep;
        const after = (condition === 'wiki' && !is(WIKI_MISSING)) || is(WIKI_LEAK) ? wikiRead(rep) : condition === 'coderef' ? mcpCall(rep) : [];
        next(person, [condTag(task, condition, rep)], (id, start, cwd) => testedSession(id, start, cwd, PLAN[condition][task][rep - 1], AIU_PER_REQUEST[condition], regress, after));
      }
    }
  }
  // テストの印の無いセッション(課題・条件のタグはある): 件数には入るが、テストの結果の分母には入らない
  next(COND_PEOPLE[0], [condTag('zz-input', 'coderef', 4)], (id, _start, cwd) => plainSession(id, cwd));
  // 条件が 1 つしか無い課題(番号の無い名前)。ほかの条件は 0 件の行になり、この行にはテストの記録が無い
  next(COND_PEOPLE[0], [`${COND_SOLO_TASK}__wiki`], (id, _start, cwd) => plainSession(id, cwd));
  // 条件の違うタグが 2 つ: どの行にも入らない
  next(COND_PEOPLE[0], [condTag('zz-render', 'wiki', 9), condTag('zz-render', 'coderef', 9)], (id, _start, cwd) => plainSession(id, cwd));
  // 決まりに合わないタグ: 区切りなし(普通のタスクタグ)と、区切りはあるが番号が数字でないもの
  next(COND_PEOPLE[1], ['zz-misc'], (id, _start, cwd) => plainSession(id, cwd));
  next(COND_PEOPLE[1], ['zz-a__b__x'], (id, _start, cwd) => plainSession(id, cwd));
  // wiki の手入れ(タスクタグなし。課題 × 条件の表には入らない): 書き込みだけのセッションと、索引を読んでから書き込むセッション
  next(COND_PEOPLE[1], [], (id, _start, cwd) => wikiWriteSession(id, cwd, false));
  next(COND_PEOPLE[1], [], (id, _start, cwd) => wikiWriteSession(id, cwd, true));
  return out;
}

const workspace = (p: Plan): string => {
  const count = p.events.filter((e) => !('gapMs' in e)).length;
  const end = timeOf(p.events, new Date(p.start).toISOString(), count - 1);
  return `id: ${p.id}\ncwd: "X:\\\\synthetic-conditions\\\\${p.person}"\nname: "合成: 課題と条件 ${p.id.slice(-3)}"\nuser_named: false\ncreated_at: ${new Date(p.start).toISOString()}\nupdated_at: ${end}\n`;
};

/** タスクタグの名前 → セッションの id(groups.json の中身にする) */
export function conditionGroups(): { version: 1; groups: { name: string; note: string; ids: string[] }[] } {
  const by = new Map<string, string[]>();
  for (const p of conditionPlans()) for (const t of p.tags) by.set(t, [...(by.get(t) ?? []), p.id]);
  return { version: 1, groups: [...by].map(([name, ids]) => ({ name, note: '', ids })) };
}

/** root の下に ~/.copilot の形(session-state/<id>/)で書く(前の中身は消す)。タスクタグは conditionGroups() を groups.json に書いて渡す */
export async function writeConditionStudy(root: string): Promise<number> {
  await rm(root, { recursive: true, force: true });
  const list = conditionPlans();
  for (const p of list) {
    const d = join(root, 'session-state', p.id);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'workspace.yaml'), workspace(p));
    await writeFile(join(d, 'events.jsonl'), lines(p.events, new Date(p.start).toISOString()).join('\n') + '\n');
  }
  return list.length;
}

/** root の下に、送り先をまとめて集計する形(<人>/<フォルダ>/<id>/。タスクタグは atlas-session.json)で書く(前の中身は消す) */
export async function writeConditionUpload(root: string): Promise<number> {
  await rm(root, { recursive: true, force: true });
  const list = conditionPlans();
  for (const p of list) {
    const d = join(root, p.person, COND_FOLDER, p.id);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'workspace.yaml'), workspace(p));
    await writeFile(join(d, 'events.jsonl'), lines(p.events, new Date(p.start).toISOString()).join('\n') + '\n');
    await writeFile(join(d, 'atlas-session.json'), JSON.stringify({ version: 1, id: p.id, tags: p.tags }) + '\n');
  }
  return list.length;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('使い方: node scripts/synthetic-conditions.ts <書き出すフォルダ>');
    process.exit(2);
  }
  const root = resolve(dir);
  const n = await writeConditionStudy(join(root, 'copilot-home'));
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes', 'groups.json'), JSON.stringify(conditionGroups(), null, 2) + '\n');
  await writeFile(join(root, 'atlas.config.json'), JSON.stringify(conditionConfig(), null, 2) + '\n');
  await writeConditionUpload(join(root, 'upload'));
  console.log(`synthetic-conditions: ${n} セッションを ${root} に書きました(copilot-home・notes/groups.json・atlas.config.json と、送り先の形の upload)`);
}
