#!/usr/bin/env node
// テスト用の「偽の copilot」。LLM は呼ばない。
// - 受け取った引数・作業ディレクトリ・環境変数 OPENCODE_CONFIG_CONTENT(偽の opencode としても使う)を
//   環境変数 FAKE_COPILOT_LOG のファイルに 1 行 JSON で追記する
// - プロンプト(-p の値)から sessionId を読み、その sessionId の固定の判定(このファイル内に持つ)を標準出力に流す
// - --usage-output-file があれば、そこに使用量の JSON を書く
// - 環境変数 FAKE_COPILOT_FAIL_ID のセッションは終了コード 3 で失敗する
// - 環境変数 FAKE_COPILOT_DELAY_MS があれば、その時間だけ待ってから応える(画面からの判定の実行中の状態を見るため)
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

// `copilot mcp list --json`(判定の前に MCP サーバー名を取る)には架空のサーバーを 1 つ返す。呼び出しの記録には入れない
if (argv[0] === 'mcp' && argv[1] === 'list') {
  process.stdout.write(`${JSON.stringify({ mcpServers: { 'fake-mcp': { type: 'http', source: 'user' } } })}\n`);
  process.exit(0);
}
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = valueOf('-p') ?? '';
const m = /sessionId は "([^"]+)"/.exec(prompt);
const sessionId = m ? m[1] : 'unknown';

if (process.env.FAKE_COPILOT_LOG) {
  const opencodeConfig = process.env.OPENCODE_CONFIG_CONTENT ?? null;
  appendFileSync(process.env.FAKE_COPILOT_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), sessionId, opencodeConfig })}\n`);
}

if (process.env.FAKE_COPILOT_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_COPILOT_DELAY_MS)));

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
// 依頼ごとの判定(段階 2)のプロンプトなら、指定された依頼番号ぶんの判定を返す。
// 偶数の依頼は「中身を修正して採用(要件の取り違え)」、奇数は「そのまま採用」。工程は一覧の「実装」(無ければ先頭)
const turnList = /items には依頼 ([\d, ]+) の/.exec(prompt);
let answer = judgment;
if (turnList) {
  const phaseLine = prompt.split('\n').find((l) => l.startsWith('- **phase**')) ?? '';
  const phases = [...phaseLine.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  const phase = phases.includes('実装') ? '実装' : (phases[0] ?? '実装');
  const items = turnList[1]
    .split(',')
    .map((s) => Number(s.trim()))
    .map((turn) =>
      turn % 2 === 0
        ? { sessionId, turn, kind: 'task', outcome: 'fix_content', mismatch: 'requirement', phase, confidence: 0.6, note: '偽 copilot(テスト用)' }
        : { sessionId, turn, kind: 'task', outcome: 'as_is', mismatch: null, phase, confidence: 0.8, note: '偽 copilot(テスト用)' },
    );
  answer = { items };
}
const events = [
  { type: 'session.start', data: { sessionId: 'fake', copilotVersion: '0.0.0-fake' } },
  { type: 'assistant.turn_start', data: { turnId: '0' } },
  { type: 'assistant.message', data: { messageId: 'm1', content: '判定します。' } },
  { type: 'assistant.message', data: { messageId: 'm2', content: '```json\n' + JSON.stringify(answer, null, 2) + '\n```' } },
  { type: 'assistant.turn_end', data: { turnId: '0' } },
];
process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
