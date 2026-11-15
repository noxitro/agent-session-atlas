// 推論強度どうしの比較(「比べる」の推論強度)を確かめる架空の fixture。値・名前・パスはすべて作ったもの。
// 送り先をまとめて集計する形(<root>/<利用者>/<フォルダ>/<セッション id>/{workspace.yaml,events.jsonl})で書くので、
// atlas all --home <root> で集計すると、セッションに利用者(person)が付く。
//  - 利用者 3 人 × 4 週 × 週 3 セッション。週ごとに medium と xhigh を入れ替える(人によって始まりが違う)
//  - 本体のリクエストは割り当ての強度、サブエージェントのリクエストは low(本体の強度の決め方がサブエージェントに引きずられないことを見る)
//  - 依頼の数(1〜6 件)・直しの依頼・中断を混ぜる(手戻りのないセッションの割合と、採点できないセッション)
//  - 本体の強度が半々のセッション(混在)と、リクエストの記録が無いセッション(記録なし)を 1 件ずつ
// 単独で書くとき: node scripts/synthetic-effort.ts <書き出すフォルダ>
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { lines, type Ev } from './synthetic-lib.ts';

export const EFFORT_MODEL = 'claude-sonnet-5.5';
export const EFFORT_PEOPLE = ['zz-user-a', 'zz-user-b', 'zz-user-c'] as const;
export const EFFORT_FOLDER = 'zz-effort-study';
/** 最初の週の月曜(UTC の日付。セッションは火〜木の 12:00Z に置くので、どの時間帯でもローカルの週が変わらない) */
const FIRST_MONDAY = Date.UTC(2026, 9, 5);
const DAY = 24 * 3600 * 1000;
export const EFFORT_WEEKS = 4;
const PER_WEEK = 3;

/** 架空のセッション ID(00000000-0000-4000-8000-0000005NNNNN。基本の fixture の番号と重ならない) */
const effortId = (n: number): string => `00000000-0000-4000-8000-${String(500_000 + n).padStart(12, '0')}`;

/** その人のその週の強度(人ごとに始まりをずらして入れ替える) */
export const assigned = (person: number, week: number): 'medium' | 'xhigh' => ((person + week) % 2 === 0 ? 'medium' : 'xhigh');

interface Plan {
  id: string;
  person: string;
  start: number;
  /** 本体の強度。mixed は medium と xhigh を半々、none はリクエストの記録なし */
  effort: 'medium' | 'xhigh' | 'mixed' | 'none';
  /** 依頼ごとの種類(task / fix)と中断 */
  turns: { fix: boolean; abort: boolean }[];
}

function plans(): Plan[] {
  const out: Plan[] = [];
  let n = 0;
  EFFORT_PEOPLE.forEach((person, p) => {
    for (let w = 0; w < EFFORT_WEEKS; w++) {
      const effort = assigned(p, w);
      for (let k = 0; k < PER_WEEK; k++) {
        n++;
        // 依頼の数は 1〜6 件。xhigh のほうが手戻りが少ない架空の傾向にする(決まった並びで、毎回同じ結果)
        const count = 1 + ((n * 5 + k) % 6);
        const rework = effort === 'medium' ? n % 3 !== 0 : n % 4 === 0;
        const turns = Array.from({ length: count }, (_, i) => ({ fix: rework && i === count - 1 && i > 0, abort: false }));
        if (rework && count >= 2 && n % 5 === 0) turns[0].abort = true;
        out.push({ id: effortId(n), person, start: FIRST_MONDAY + (w * 7 + 1 + k) * DAY + 12 * 3600 * 1000, effort, turns });
      }
    }
  });
  // 混在と記録なし(利用者 a の 2 週目)
  out.push({ id: effortId(++n), person: EFFORT_PEOPLE[0], start: FIRST_MONDAY + 9 * DAY + 14 * 3600 * 1000, effort: 'mixed', turns: [{ fix: false, abort: false }, { fix: false, abort: false }] });
  out.push({ id: effortId(++n), person: EFFORT_PEOPLE[0], start: FIRST_MONDAY + 10 * DAY + 14 * 3600 * 1000, effort: 'none', turns: [{ fix: false, abort: false }, { fix: false, abort: false }] });
  return out;
}

const usage = (effort: string, nanoAiu: number, initiator: string, agentId?: string): Ev => ({
  type: 'session.usage_record',
  data: {
    usage: {
      model: EFFORT_MODEL,
      inputTokens: 8_000,
      outputTokens: effort === 'xhigh' ? 900 : 300,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 0,
      reasoningTokens: effort === 'xhigh' ? 600 : 100,
      cost: initiator === 'user' ? 1 : 0,
      initiator,
      reasoningEffort: effort,
      copilotUsage: { totalNanoAiu: nanoAiu },
    },
  },
  ...(agentId ? { agentId } : {}),
});

function events(p: Plan): Ev[] {
  const startEffort = p.effort === 'mixed' || p.effort === 'none' ? 'medium' : p.effort;
  const ev: Ev[] = [{ type: 'session.start', data: { sessionId: p.id, version: 1, copilotVersion: '1.0.110', selectedModel: EFFORT_MODEL, reasoningEffort: startEffort, context: { cwd: `X:\\synthetic-effort\\${p.person}` } } }];
  p.turns.forEach((t, i) => {
    ev.push({ type: 'user.message', data: { content: t.fix ? `違う、合成の部分 ${i + 1} を直して` : `合成の作業 ${i + 1} を進めて` } });
    ev.push({ type: 'assistant.turn_start', data: { turnId: `t${i + 1}` } });
    if (p.effort !== 'none') {
      // 本体のリクエスト 2 件(混在は medium と xhigh を 1 件ずつ)と、サブエージェントの 1 件(low)
      const e1 = p.effort === 'mixed' ? 'medium' : p.effort;
      const e2 = p.effort === 'mixed' ? 'xhigh' : p.effort;
      const aiu = (e: string): number => (e === 'xhigh' ? 900_000_000 : 400_000_000);
      ev.push(usage(e1, aiu(e1), 'user'));
      ev.push(usage(e2, aiu(e2), 'agent'));
      ev.push(usage('low', 100_000_000, 'sub-agent', `agent-synth-effort-${i + 1}`));
    }
    ev.push({ type: 'assistant.message', data: { messageId: `m${i + 1}`, content: `合成の応答 ${i + 1}`, model: EFFORT_MODEL } });
    if (t.abort) ev.push({ type: 'abort', data: { reason: 'user_initiated' } });
    ev.push({ type: 'assistant.turn_end', data: { turnId: `t${i + 1}` } });
  });
  return ev;
}

/** root の下に、送り先をまとめて集計する形で書く(前の中身は消す)。書いたセッションの数を返す */
export async function writeEffortStudy(root: string): Promise<number> {
  await rm(root, { recursive: true, force: true });
  const list = plans();
  for (const p of list) {
    const d = join(root, p.person, EFFORT_FOLDER, p.id);
    await mkdir(d, { recursive: true });
    const start = new Date(p.start).toISOString();
    const ev = events(p);
    const end = new Date(p.start + ev.length * 1000).toISOString();
    await writeFile(join(d, 'workspace.yaml'), `id: ${p.id}\ncwd: "X:\\\\synthetic-effort\\\\${p.person}"\nname: "合成: 推論強度の比較 ${p.id.slice(-3)}"\nuser_named: false\ncreated_at: ${start}\nupdated_at: ${end}\n`);
    await writeFile(join(d, 'events.jsonl'), lines(ev, start).join('\n') + '\n');
  }
  return list.length;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('使い方: node scripts/synthetic-effort.ts <書き出すフォルダ>');
    process.exit(2);
  }
  const n = await writeEffortStudy(resolve(dir));
  console.log(`synthetic-effort: ${n} セッションを ${resolve(dir)} に書きました`);
}
