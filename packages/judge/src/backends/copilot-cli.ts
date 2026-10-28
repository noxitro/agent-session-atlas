// copilot -p を子プロセスで起動する判定バックエンド(既定)。
// - 空の作業ディレクトリで起動し、パケットと指示はプロンプト本文に埋め込む(--add-dir は使わない:
//   そのディレクトリの .github/skills / agents を信頼設定として読むため、他セッションの本文を含むバンドルが注入の入口になる)
// - --no-custom-instructions でユーザーの AGENTS.md 等を読ませない(判定がそれに引きずられないように)
// - 判定自体のトークン消費は --usage-output-file で受け取る
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJudgePrompt } from '../rubric.ts';
import { commandLineLength, MAX_COMMAND_LINE, resolveCommand, runProcess, tail, type ResolvedCommand } from './proc.ts';
import { itemFromTexts, parseAgentJsonl } from './output.ts';
import type { JudgeBackend, JudgePacket, JudgeResult } from './types.ts';

export interface CopilotCliOptions {
  /** 実行ファイル(既定: 環境変数 ATLAS_COPILOT_BIN、無ければ PATH の copilot) */
  bin?: string | null;
  model?: string | null;
  /** --allow-all-tools を付けるか(既定 true。ヘルプでは非対話モードで必須とある) */
  allowTools?: boolean;
  timeoutMs?: number;
}

export function copilotArgs(prompt: string, usageFile: string, o: CopilotCliOptions): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--stream', 'off', '--no-ask-user', '-s', '--no-custom-instructions'];
  if (o.allowTools ?? true) args.push('--allow-all-tools');
  args.push('--usage-output-file', usageFile);
  if (o.model) args.push('--model', o.model);
  return args;
}

export function copilotCliBackend(o: CopilotCliOptions = {}): JudgeBackend {
  let cmd: ResolvedCommand | null = null;
  const bin = o.bin ?? process.env.ATLAS_COPILOT_BIN ?? 'copilot';
  const timeoutMs = o.timeoutMs ?? 600_000;
  return {
    name: 'copilot-cli',
    model: o.model ?? null,
    async judge(packet: JudgePacket): Promise<JudgeResult> {
      cmd ??= resolveCommand(bin);
      const prompt = buildJudgePrompt(packet.markdown, packet.sessionId);
      const work = await mkdtemp(join(tmpdir(), 'atlas-judge-cwd-'));
      const usageDir = await mkdtemp(join(tmpdir(), 'atlas-judge-usage-'));
      const usageFile = join(usageDir, 'usage.json');
      try {
        const args = copilotArgs(prompt, usageFile, o);
        const len = commandLineLength(cmd, args);
        if (process.platform === 'win32' && len > MAX_COMMAND_LINE)
          throw new Error(`プロンプトが長すぎてコマンドラインに収まりません(${len} 字 > ${MAX_COMMAND_LINE})。atlas bundle を小さい上限で作り直してください。`);
        const r = await runProcess(cmd, args, { cwd: work, timeoutMs });
        // ATLAS_JUDGE_RAW_DIR を指定すると、出力の形を確かめるために生の stdout / stderr / usage を残す
        const rawDir = process.env.ATLAS_JUDGE_RAW_DIR;
        if (rawDir) {
          await mkdir(rawDir, { recursive: true });
          await writeFile(join(rawDir, `${packet.sessionId}.stdout.jsonl`), r.stdout, 'utf8');
          await writeFile(join(rawDir, `${packet.sessionId}.stderr.txt`), r.stderr, 'utf8');
          await writeFile(join(rawDir, `${packet.sessionId}.usage.json`), await readFile(usageFile, 'utf8').catch((e: Error) => `(読めません: ${e.message})`), 'utf8');
        }
        if (r.timedOut) throw new Error(`copilot が ${Math.round(timeoutMs / 1000)} 秒以内に終わりませんでした`);
        const out = parseAgentJsonl(r.stdout);
        if (r.code !== 0) {
          // session.error(quota 超過など)があればその本文を出し、無ければ出力の末尾を出す
          const err = out.errors.length ? out.errors.join(' / ') : tail(r.stderr || r.stdout);
          throw new Error(`copilot が終了コード ${r.code} で失敗しました: ${err}`);
        }
        const item = itemFromTexts(out.texts, packet.sessionId);
        const notes: string[] = [];
        let usage: unknown = null;
        try {
          usage = JSON.parse(await readFile(usageFile, 'utf8'));
        } catch (e) {
          notes.push(`usage-output-file を読めませんでした(${(e as Error).message})`);
        }
        return { item, usage, notes };
      } finally {
        await rm(work, { recursive: true, force: true });
        await rm(usageDir, { recursive: true, force: true });
      }
    },
  };
}
