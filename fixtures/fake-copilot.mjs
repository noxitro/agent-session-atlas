#!/usr/bin/env node
// テスト用の「偽の copilot」。LLM は呼ばない。
// - 受け取った引数・作業ディレクトリを環境変数 FAKE_COPILOT_LOG のファイルに 1 行 JSON で追記する
// - プロンプト(-p の値)から sessionId を読み、その sessionId の固定の判定(このファイル内に持つ)を標準出力に流す
// - --usage-output-file があれば、そこに使用量の JSON を書く
// - 環境変数 FAKE_COPILOT_FAIL_ID のセッションは終了コード 3 で失敗する
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = valueOf('-p') ?? '';
const m = /sessionId は "([^"]+)"/.exec(prompt);
const sessionId = m ? m[1] : 'unknown';

if (process.env.FAKE_COPILOT_LOG) {
  appendFileSync(process.env.FAKE_COPILOT_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), sessionId })}\n`);
}

if (process.env.FAKE_COPILOT_FAIL_ID && process.env.FAKE_COPILOT_FAIL_ID === sessionId) {
  process.stderr.write(`fake copilot: 意図的な失敗 (${sessionId})\n`);
  process.exit(3);
}

const usageFile = valueOf('--usage-output-file');
if (usageFile) writeFileSync(usageFile, JSON.stringify({ premiumRequests: 1, tokens: { input: 1000 + prompt.length, output: 200 } }));

// copilot -p --output-format json と同じ形の JSONL(値はすべてテスト用の架空のもの)
const judgment = {
  sessionId,
  taskCategory: 'feature',
  taskSummary: '偽 copilot による判定(テスト用)',
  humanEffort: { hours: 2.5, low: 1.5, high: 4, confidence: 0.5, rationale: 'テスト用の固定値' },
  aiOutcome: { completed: true, quality: 4, rework: 1, rationale: 'テスト用' },
  instructionsEffect: { score: 1, evidence: 'テスト用' },
  wikiEffect: { score: 0, evidence: '参照なし' },
  skillsAgentsEffect: { score: 0, evidence: '参照なし' },
};
const events = [
  { type: 'session.start', data: { sessionId: 'fake', copilotVersion: '0.0.0-fake' } },
  { type: 'assistant.turn_start', data: { turnId: '0' } },
  { type: 'assistant.message', data: { messageId: 'm1', content: '判定します。' } },
  { type: 'assistant.message', data: { messageId: 'm2', content: '```json\n' + JSON.stringify(judgment, null, 2) + '\n```' } },
  { type: 'assistant.turn_end', data: { turnId: '0' } },
];
process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
