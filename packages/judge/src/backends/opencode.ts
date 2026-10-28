// opencode run を子プロセスで起動する判定バックエンド(実走未確認の薄い実装)。
// copilot-cli と同じく空の作業ディレクトリで起動し、パケットはメッセージ本文に埋め込む。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJudgePrompt } from '../rubric.ts';
import { commandLineLength, MAX_COMMAND_LINE, resolveCommand, runProcess, tail, type ResolvedCommand } from './proc.ts';
import { itemFromTexts, parseAgentJsonl } from './output.ts';
import type { JudgeBackend, JudgePacket, JudgeResult } from './types.ts';

export interface OpencodeOptions {
  /** 実行ファイル(既定: 環境変数 ATLAS_OPENCODE_BIN、無ければ PATH の opencode) */
  bin?: string | null;
  /** provider/model 形式。省略時は opencode の既定 */
  model?: string | null;
  timeoutMs?: number;
}

export function opencodeArgs(prompt: string, o: OpencodeOptions): string[] {
  const args = ['run', '--format', 'json'];
  if (o.model) args.push('--model', o.model);
  args.push(prompt);
  return args;
}

export function opencodeBackend(o: OpencodeOptions = {}): JudgeBackend {
  let cmd: ResolvedCommand | null = null;
  const bin = o.bin ?? process.env.ATLAS_OPENCODE_BIN ?? 'opencode';
  return {
    name: 'opencode',
    model: o.model ?? null,
    async judge(packet: JudgePacket): Promise<JudgeResult> {
      cmd ??= resolveCommand(bin);
      const args = opencodeArgs(buildJudgePrompt(packet.markdown, packet.sessionId), o);
      const len = commandLineLength(cmd, args);
      if (process.platform === 'win32' && len > MAX_COMMAND_LINE) throw new Error(`プロンプトが長すぎてコマンドラインに収まりません(${len} 字)`);
      const work = await mkdtemp(join(tmpdir(), 'atlas-judge-cwd-'));
      try {
        const r = await runProcess(cmd, args, { cwd: work, timeoutMs: o.timeoutMs ?? 600_000 });
        if (r.timedOut) throw new Error('opencode が時間内に終わりませんでした');
        if (r.code !== 0) throw new Error(`opencode が終了コード ${r.code} で失敗しました: ${tail(r.stderr || r.stdout)}`);
        const out = parseAgentJsonl(r.stdout);
        const item = itemFromTexts(out.texts, packet.sessionId);
        return { item, usage: out.usage, notes: out.usage ? [] : ['opencode の出力にトークン数がありませんでした'] };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}
