// copilot -p を子プロセスで起動する判定バックエンド(既定)。
// - 空の作業ディレクトリで起動し、パケットと指示はプロンプト本文に埋め込む(--add-dir は使わない:
//   そのディレクトリの .github/skills / agents を信頼設定として読むため、他セッションの本文を含むバンドルが注入の入口になる)
// - --no-custom-instructions でユーザーの AGENTS.md 等を読ませない(判定がそれに引きずられないように)
// - 判定はツールを使わない作業なので、--allow-all-tools(非対話モードで必須)を付けても、シェル・ファイル書き込み・URL アクセスは
//   --deny-tool で拒否する(`copilot help permissions`: 拒否は --allow-all-tools より優先される)。パケット本文からの指示注入で
//   ツールが動くのを防ぐため
// - MCP のツールは shell / write / url のどれにも当たらない(`copilot help permissions` の kind は <mcp-server-name>(tool) で別)ので、
//   --allow-all-tools だけだと組み込みの github-mcp-server や利用者・プラグインの MCP サーバーが許可されてしまう。
//   そこで (1) --available-tools でモデルに見せるツールを view だけにし(作業ディレクトリは空で、copilot は既定でその外のパスを拒否する)、
//   (2) --disable-builtin-mcps で組み込みの MCP を止め、(3) `copilot mcp list --json` で得た各サーバーを
//   --disable-mcp-server と --deny-tool <サーバー名> で止める
// - 判定自体のトークン消費は --usage-output-file で受け取る
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJudgePrompt } from '../rubric.ts';
import { commandLineLength, MAX_COMMAND_LINE, resolveCommand, runProcess, tail, type ResolvedCommand } from './proc.ts';
import { itemFromTexts, parseAgentJsonl } from './output.ts';
import type { AskResult, JudgeBackend, JudgePacket, JudgeResult } from './types.ts';

export interface CopilotCliOptions {
  /** 実行ファイル(既定: 環境変数 ATLAS_COPILOT_BIN、無ければ PATH の copilot) */
  bin?: string | null;
  model?: string | null;
  /** --allow-all-tools を付けるか(既定 true。ヘルプでは非対話モードで必須とある) */
  allowTools?: boolean;
  timeoutMs?: number;
}

/** 判定では使わせないツールの種類(`copilot help permissions` の kind)。shell = シェル、write = ファイルの作成・変更、url = shell / web-fetch の URL アクセス */
export const JUDGE_DENIED_TOOL_KINDS = ['shell', 'write', 'url'] as const;

/** 判定でモデルに見せるツール(--available-tools)。空の作業ディレクトリの外は既定で読めないので、view が残っても読めるものは無い */
export const JUDGE_AVAILABLE_TOOLS = ['view'] as const;

/** mcpServers: `copilot mcp list --json` で得た MCP サーバー名(それぞれ止めて拒否する) */
export function copilotArgs(prompt: string, usageFile: string, o: CopilotCliOptions, mcpServers: readonly string[] = []): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--stream', 'off', '--no-ask-user', '-s', '--no-custom-instructions'];
  if (o.allowTools ?? true) args.push('--allow-all-tools');
  args.push(`--available-tools=${JUDGE_AVAILABLE_TOOLS.join(',')}`, '--disable-builtin-mcps');
  for (const kind of JUDGE_DENIED_TOOL_KINDS) args.push('--deny-tool', kind);
  for (const server of mcpServers) args.push('--disable-mcp-server', server, '--deny-tool', server);
  args.push('--usage-output-file', usageFile);
  if (o.model) args.push('--model', o.model);
  return args;
}

/**
 * 設定されている MCP サーバー名(利用者・ワークスペース・プラグイン・組み込み)。LLM は呼ばない。
 * 取れなかったときは空にして理由を返す(--available-tools と --disable-builtin-mcps の制限は残る)
 */
export async function copilotMcpServers(cmd: ResolvedCommand, cwd: string): Promise<{ servers: string[]; note: string | null }> {
  try {
    const r = await runProcess(cmd, ['mcp', 'list', '--json'], { cwd, timeoutMs: 60_000 });
    if (r.timedOut || r.code !== 0) throw new Error(r.timedOut ? '時間切れ' : `終了コード ${r.code}: ${tail(r.stderr || r.stdout, 200)}`);
    const servers = (JSON.parse(r.stdout) as { mcpServers?: unknown }).mcpServers;
    return { servers: servers && typeof servers === 'object' ? Object.keys(servers) : [], note: null };
  } catch (e) {
    return { servers: [], note: `MCP サーバーの一覧(copilot mcp list --json)を取れなかったため、サーバーごとの拒否は付けていません(${(e as Error).message})` };
  }
}

export function copilotCliBackend(o: CopilotCliOptions = {}): JudgeBackend {
  let cmd: ResolvedCommand | null = null;
  let mcp: Promise<{ servers: string[]; note: string | null }> | null = null;
  const bin = o.bin ?? process.env.ATLAS_COPILOT_BIN ?? 'copilot';
  const timeoutMs = o.timeoutMs ?? 600_000;
  /** プロンプトを 1 回渡して、本文と使用量を受け取る(判定の検証は呼ぶ側) */
  async function ask(prompt: string, label: string): Promise<AskResult> {
      cmd ??= resolveCommand(bin);
      const work = await mkdtemp(join(tmpdir(), 'atlas-judge-cwd-'));
      const usageDir = await mkdtemp(join(tmpdir(), 'atlas-judge-usage-'));
      const usageFile = join(usageDir, 'usage.json');
      try {
        mcp ??= copilotMcpServers(cmd, work);
        const { servers, note: mcpNote } = await mcp;
        const args = copilotArgs(prompt, usageFile, o, servers);
        const len = commandLineLength(cmd, args);
        if (process.platform === 'win32' && len > MAX_COMMAND_LINE)
          throw new Error(`プロンプトが長すぎてコマンドラインに収まりません(${len} 字 > ${MAX_COMMAND_LINE})。atlas bundle を小さい上限で作り直してください。`);
        const r = await runProcess(cmd, args, { cwd: work, timeoutMs });
        // ATLAS_JUDGE_RAW_DIR を指定すると、出力の形を確かめるために生の stdout / stderr / usage を残す
        const rawDir = process.env.ATLAS_JUDGE_RAW_DIR;
        if (rawDir) {
          await mkdir(rawDir, { recursive: true });
          await writeFile(join(rawDir, `${label}.stdout.jsonl`), r.stdout, 'utf8');
          await writeFile(join(rawDir, `${label}.stderr.txt`), r.stderr, 'utf8');
          await writeFile(join(rawDir, `${label}.usage.json`), await readFile(usageFile, 'utf8').catch((e: Error) => `(読めません: ${e.message})`), 'utf8');
        }
        if (r.timedOut) throw new Error(`copilot が ${Math.round(timeoutMs / 1000)} 秒以内に終わりませんでした`);
        const out = parseAgentJsonl(r.stdout);
        if (r.code !== 0) {
          // session.error(quota 超過など)があればその本文を出し、無ければ出力の末尾を出す
          const err = out.errors.length ? out.errors.join(' / ') : tail(r.stderr || r.stdout);
          throw new Error(`copilot が終了コード ${r.code} で失敗しました: ${err}`);
        }
        const notes: string[] = mcpNote ? [mcpNote] : [];
        let usage: unknown = null;
        try {
          usage = JSON.parse(await readFile(usageFile, 'utf8'));
        } catch (e) {
          notes.push(`usage-output-file を読めませんでした(${(e as Error).message})`);
        }
        return { texts: out.texts, usage, notes };
      } finally {
        await rm(work, { recursive: true, force: true });
        await rm(usageDir, { recursive: true, force: true });
      }
  }
  return {
    name: 'copilot-cli',
    model: o.model ?? null,
    ask,
    async judge(packet: JudgePacket): Promise<JudgeResult> {
      const r = await ask(buildJudgePrompt(packet.markdown, packet.sessionId), packet.sessionId);
      return { item: itemFromTexts(r.texts, packet.sessionId), usage: r.usage, notes: r.notes };
    },
  };
}
