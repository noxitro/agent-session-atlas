// Anthropic Messages API を fetch で直接呼ぶ判定バックエンド(従量課金。明示指定したときだけ使う)。
// 依存を増やさないため SDK を使わず raw HTTP で実装している。
import { buildJudgePrompt } from '../rubric.ts';
import { itemFromTexts } from './output.ts';
import type { JudgeBackend, JudgePacket, JudgeResult } from './types.ts';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_API_VERSION = '2026-10-21';

export interface AnthropicOptions {
  model?: string | null;
  apiKey?: string | null;
  /** テスト用に差し替え可能 */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

interface MessagesResponse {
  content?: { type?: string; text?: unknown }[];
  stop_reason?: string;
  stop_details?: { category?: string | null } | null;
  usage?: unknown;
  error?: { message?: string };
}

export function anthropicBackend(o: AnthropicOptions = {}): JudgeBackend {
  const apiKey = o.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) throw new Error('anthropic バックエンドには環境変数 ANTHROPIC_API_KEY が必要です(従量課金です)');
  const model = o.model ?? ANTHROPIC_DEFAULT_MODEL;
  const f = o.fetchImpl ?? fetch;
  const url = `${o.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`;
  return {
    name: 'anthropic',
    model,
    async judge(packet: JudgePacket): Promise<JudgeResult> {
      const res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
        body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: 'user', content: buildJudgePrompt(packet.markdown, packet.sessionId) }] }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 600_000),
      });
      const text = await res.text();
      let body: MessagesResponse;
      try {
        body = JSON.parse(text) as MessagesResponse;
      } catch {
        throw new Error(`Anthropic API の応答が JSON ではありません(HTTP ${res.status}): ${text.slice(0, 300)}`);
      }
      if (!res.ok) throw new Error(`Anthropic API がエラーを返しました(HTTP ${res.status}): ${body.error?.message ?? text.slice(0, 300)}`);
      if (body.stop_reason === 'refusal') throw new Error(`Anthropic API が判定を拒否しました(${body.stop_details?.category ?? '理由不明'})`);
      const texts = (body.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
      const item = itemFromTexts(texts.length ? [texts.join('\n')] : [], packet.sessionId);
      const notes = body.stop_reason === 'max_tokens' ? ['応答が max_tokens で打ち切られました'] : [];
      return { item, usage: body.usage ?? null, notes };
    },
  };
}
