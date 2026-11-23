#!/usr/bin/env node
// テスト用の「偽の copilot」(atlas skill-draft が呼ぶ copilot -p の代わり)。LLM は呼ばない。
// 判定はこのツールの中では回さない(外部の LLM に頼む)ので、ここが受けるのは SKILL.md の下書きの依頼だけ。
// - 受け取った引数・作業ディレクトリを、環境変数 FAKE_COPILOT_LOG のファイルに 1 行 JSON で追記する
// - --usage-output-file があれば、そこに使用量の JSON を書く
// - 環境変数 FAKE_COPILOT_FAIL があれば終了コード 3 で失敗する
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

// `copilot mcp list --json`(呼ぶ前に MCP サーバー名を取る)には架空のサーバーを 1 つ返す。呼び出しの記録には入れない
if (argv[0] === 'mcp' && argv[1] === 'list') {
  process.stdout.write(`${JSON.stringify({ mcpServers: { 'fake-mcp': { type: 'http', source: 'user' } } })}\n`);
  process.exit(0);
}
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = valueOf('-p') ?? '';

if (process.env.FAKE_COPILOT_LOG) {
  appendFileSync(process.env.FAKE_COPILOT_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()) })}\n`);
}

if (process.env.FAKE_COPILOT_FAIL) {
  process.stderr.write('fake copilot: 意図的な失敗\n');
  process.exit(3);
}

const usageFile = valueOf('--usage-output-file');
if (usageFile) writeFileSync(usageFile, JSON.stringify({ premiumRequests: 1, tokens: { input: 1000 + prompt.length, output: 200 } }));

// copilot -p --output-format json と同じ形の JSONL(値はすべてテスト用の架空のもの)
const draft = [
  '---',
  'name: fake-skill',
  'description: 偽 copilot が書いた下書き(テスト用)',
  '---',
  '',
  '## 目的',
  '繰り返しの作業をまとめる(テスト用の固定の本文)。',
  '',
  '## 手順',
  '1. 入力を確かめる',
  '2. 作業する',
].join('\n');
const events = [
  { type: 'session.start', data: { sessionId: 'fake', copilotVersion: '0.0.0-fake' } },
  { type: 'assistant.turn_start', data: { turnId: '0' } },
  { type: 'assistant.message', data: { messageId: 'm1', content: draft } },
  { type: 'assistant.turn_end', data: { turnId: '0' } },
];
process.stdout.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
