// チャットで判定する添付ファイル(bundle/parts/・turn-bundle/parts/)の一覧と、その中の判定済みの数。
// 画面の「チャットに貼って判定する」(serve の /api/judge/parts)と、M365 Copilot の自動操作(m365.ts)が使う。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBundleManifest, readTurnBundleManifest, readTurnJudgments } from '../../judge/src/index.ts';

/** 判定するもの(工数はセッションごと、turns は依頼ごと) */
export type ChatTarget = 'effort' | 'turns';

export interface ChatPart {
  /** 出力先からの相対パス(bundle/parts/part-001.md など) */
  path: string;
  name: string;
  /** 中のセッションの数(turns は依頼の数) */
  sessions: number;
  /** そのうち判定済みの数 */
  judged: number;
  bytes: number;
}

export interface ChatParts {
  exists: boolean;
  generatedAt?: string;
  unjudgedOnly?: boolean;
  count?: number;
  parts?: ChatPart[];
}

/** judgments.json にあるセッション id(無ければ空。読めなければ例外) */
export async function judgedSessionIds(outDir: string): Promise<Set<string>> {
  const judged = new Set<string>();
  const jp = join(outDir, 'judgments.json');
  if (existsSync(jp)) {
    try {
      const j = JSON.parse(await readFile(jp, 'utf8')) as { items?: { sessionId?: unknown }[] };
      for (const it of j.items ?? []) if (typeof it?.sessionId === 'string') judged.add(it.sessionId);
    } catch (e) {
      throw new Error(`judgments.json を読めません: ${(e as Error).message}`);
    }
  }
  return judged;
}

/** turn-judgments.json の判定済みの依頼(セッション ID#依頼番号) */
export async function judgedTurnKeys(outDir: string): Promise<Set<string>> {
  try {
    const j = await readTurnJudgments(join(outDir, 'turn-judgments.json'));
    return new Set((j?.items ?? []).map((i) => `${i.sessionId}#${i.turn}`));
  } catch (e) {
    throw new Error(`turn-judgments.json を読めません: ${(e as Error).message}`);
  }
}

/** 添付ファイルの一覧(manifest にあって、ファイルが残っているもの)。manifest が読めなければ例外 */
export async function listChatParts(outDir: string, target: ChatTarget): Promise<ChatParts> {
  if (target === 'turns') {
    const dir = join(outDir, 'turn-bundle');
    if (!existsSync(join(dir, 'manifest.json'))) return { exists: false };
    const m = await readTurnBundleManifest(dir);
    const judged = await judgedTurnKeys(outDir);
    const parts = m.parts
      .filter((p) => existsSync(join(dir, ...p.path.split('/'))))
      .map((p) => ({
        path: `turn-bundle/${p.path}`,
        name: p.path.split('/').pop()!,
        sessions: p.turns,
        judged: p.chunks.reduce((a, c) => a + c.turns.filter((t) => judged.has(`${c.sessionId}#${t}`)).length, 0),
        bytes: p.bytes,
      }));
    return { exists: true, generatedAt: m.generatedAt, unjudgedOnly: m.unjudgedOnly, count: m.count, parts };
  }
  const dir = join(outDir, 'bundle');
  if (!existsSync(join(dir, 'manifest.json'))) return { exists: false };
  const m = await readBundleManifest(dir);
  const judged = await judgedSessionIds(outDir);
  const parts = (m.parts ?? [])
    .filter((p) => existsSync(join(dir, ...p.path.split('/'))))
    .map((p) => ({ path: `bundle/${p.path}`, name: p.path.split('/').pop()!, sessions: p.sessions.length, judged: p.sessions.filter((id) => judged.has(id)).length, bytes: p.bytes }));
  return { exists: true, generatedAt: m.generatedAt, unjudgedOnly: m.scope?.unjudged === 'yes', count: m.count, parts };
}

/** 保存・添付するときの名前(相手のチャットが .md を添付として受け付けるか分からないので .txt にする。中身は同じ)。画面の ChatJudge と同じ */
export const chatSaveName = (target: ChatTarget, name: string): string => `${target === 'turns' ? 'turns-' : ''}${name.replace(/\.md$/, '.txt')}`;

/** チャットに添付ファイルと一緒に送る依頼文(画面の ChatJudge と同じ) */
export const CHAT_REQUEST = '添付したファイルの指示に従って判定し、JSON を返してください。';
