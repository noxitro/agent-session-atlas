// エージェント CLI の出力(JSONL)から最終的な assistant 本文を取り出し、判定 JSON を検証する。
// copilot -p --output-format json の行の形は版によって違いうるので、
// 既知の形を広く受け、どれにも当たらなければ出力全体を本文として扱う。
import { itemsFromCandidates, itemProblems, jsonCandidates, validateJudgmentItem, type JudgmentItem } from '../schema.ts';

export interface AgentOutput {
  /** assistant の本文(出現順) */
  texts: string[];
  lines: number;
  jsonLines: number;
  /** session.error 等のエラー本文(出現順) */
  errors: string[];
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseAgentJsonl(stdout: string): AgentOutput {
  const texts: string[] = [];
  const deltas = new Map<string, string>();
  const errors: string[] = [];
  let lines = 0;
  let jsonLines = 0;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    lines++;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(e)) continue;
    jsonLines++;
    const d = isObj(e.data) ? e.data : {};
    if (e.type === 'assistant.message' && !d.parentToolCallId && typeof d.content === 'string' && d.content.trim()) {
      // Copilot のセッションイベント形式
      texts.push(d.content);
    } else if (e.type === 'assistant.message_delta' && typeof d.deltaContent === 'string') {
      const k = String(d.messageId ?? '');
      deltas.set(k, (deltas.get(k) ?? '') + d.deltaContent);
    } else if (e.type === 'session.error') {
      // Copilot: {type:"session.error", data:{errorType:"quota", errorCode:"quota_exceeded", statusCode:402, message:"…"}}
      const parts = [d.errorCode ?? d.errorType, d.statusCode != null ? `HTTP ${d.statusCode}` : null, d.message].filter((x) => x != null && x !== '');
      errors.push(parts.join(' '));
    } else if (e.type === 'result' && typeof e.result === 'string') {
      // 汎用: {type:"result", result:"…"}
      texts.push(e.result);
    } else if (e.role === 'assistant' && typeof e.content === 'string') {
      texts.push(e.content);
    }
  }
  if (texts.length === 0) for (const v of deltas.values()) if (v.trim()) texts.push(v);
  if (texts.length === 0 && jsonLines === 0 && stdout.trim()) texts.push(stdout);
  return { texts, lines, jsonLines, errors };
}

/**
 * 本文の候補(後ろから)から判定項目を 1 つ取り出して検証する。
 * sessionId が無ければパケットの ID を補い、違う ID ならエラーにする。
 */
export function itemFromTexts(texts: string[], sessionId: string): JudgmentItem {
  const problems: string[] = [];
  for (let i = texts.length - 1; i >= 0; i--) {
    const items = itemsFromCandidates(jsonCandidates(texts[i]));
    for (const raw of items) {
      if (!isObj(raw)) continue;
      const it: Record<string, unknown> = { ...raw };
      if (it.sessionId == null || it.sessionId === '') it.sessionId = sessionId;
      if (it.sessionId !== sessionId) {
        problems.push(`sessionId が違います(期待 ${sessionId}、出力 ${String(it.sessionId)})`);
        continue;
      }
      delete it.judge;
      const p = itemProblems(it);
      if (p.length) {
        problems.push(...p);
        continue;
      }
      return validateJudgmentItem(it);
    }
  }
  if (texts.length === 0) throw new Error('応答に assistant の本文がありません');
  if (problems.length === 0) throw new Error(`応答から JSON を取り出せません(本文の末尾: ${texts[texts.length - 1].slice(-300)})`);
  throw new Error(`応答の JSON がスキーマに合いません: ${problems.slice(0, 8).join(' / ')}`);
}
