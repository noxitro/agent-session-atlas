// atlas コマンドの引数解釈(純関数)
import { parseArgs } from 'node:util';

export const COMMANDS = ['snapshot', 'extract', 'metrics', 'build', 'all', 'bundle', 'judge'] as const;
export type Command = (typeof COMMANDS)[number];

export const JUDGE_ACTIONS = ['run', 'import'] as const;
export type JudgeAction = (typeof JUDGE_ACTIONS)[number];

export const BACKEND_NAMES = ['copilot-cli', 'opencode', 'anthropic'] as const;
export type BackendChoice = (typeof BACKEND_NAMES)[number];

export interface JudgeCliOptions {
  action: JudgeAction;
  /** import するファイル */
  file: string | null;
  backend: BackendChoice;
  /** 判定に使うモデル(judge のときの --model) */
  model: string | null;
  limit: number | null;
  only: string[] | null;
  concurrency: number;
  force: boolean;
  /** copilot-cli に --allow-all-tools を付けるか */
  allowTools: boolean;
  /** 1 件あたりの制限時間(秒) */
  timeoutSec: number;
}

export interface CliOptions {
  command: Command;
  /** ~/.copilot の場所 */
  home: string | null;
  /** 出力先(既定はリポジトリ直下の out/) */
  out: string | null;
  since: string | null;
  project: string | null;
  client: string | null;
  /** 絞り込みのモデル(judge では判定に使うモデル) */
  model: string | null;
  branch: string | null;
  anonymize: boolean;
  /** judgments.json の場所(既定は <out>/judgments.json があれば使う) */
  judgments: string | null;
  /** 評価バンドルの場所(既定は <out>/bundle) */
  bundle: string | null;
  /** bundle: 依頼の記録が無いセッションも含める */
  includeEmpty: boolean;
  /** extract: 一時フォルダとみなすフォルダ(指定すると既定の一時フォルダの判定を置き換える)。未指定は null */
  tempDirs: string[] | null;
  judge: JudgeCliOptions | null;
  help: boolean;
}

export const USAGE = `使い方: atlas <コマンド> [オプション]

コマンド:
  snapshot   ~/.copilot の必要部分を <out>/snapshot へ複製する(元は書き換えない)
  extract    スナップショットから <out>/sessions.json を作る
  metrics    sessions.json から <out>/metrics.json を作る
  build      <out>/atlas.html と <out>/sessions/<id>.html を作る
  all        snapshot → extract → metrics → build を通しで実行する(コマンド省略時の既定)
  bundle     LLM に工数を判定させる評価バンドルを <out>/bundle に作る(LLM は呼ばない)
  judge run  バンドルの各セッションを LLM で判定し <out>/judgments.json に追記する(クレジットを消費します)
  judge import <ファイル>
             外部の LLM で作った判定(JSON か、JSON を含む Markdown)を検証して judgments.json に取り込む

オプション:
  --home <dir>       Copilot のデータの場所(既定: 環境変数 ATLAS_COPILOT_HOME、無ければ ~/.copilot)
  --out <dir>        出力先(既定: リポジトリ直下の out/)
  --since <date>     この日時以降に更新されたセッションだけ(例: 2026-07-01)
  --project <key>    プロジェクトで絞る(完全一致、無ければ部分一致)
  --client <name>    クライアントで絞る(例: github/cli, github/autopilot)
  --model <name>     そのモデルを使ったセッションだけ(judge run では判定に使うモデル)
  --branch <name>    ブランチで絞る
  --anonymize        プロジェクト名・パス・リポジトリ名・ブランチを伏せ字にして HTML を出す(共有用)
  --judgments <file> 判定結果 judgments.json の場所(既定: <out>/judgments.json)
  --bundle <dir>     評価バンドルの場所(既定: <out>/bundle)
  --include-empty    bundle: 依頼の記録が無いセッションもパケットにする
  --temp-dir <dir>   extract: このフォルダ配下を「(一時フォルダ)」にまとめる(複数指定可)。指定すると既定の判定
                     (%TEMP% と AppData\\Local\\Temp・/tmp のパターン)を使わない
  -h, --help         この説明を出す

judge run のオプション:
  --backend <name>   copilot-cli(既定、copilot -p)/ opencode / anthropic(従量課金、ANTHROPIC_API_KEY が必要)
  --limit <n>        未判定のものから最大 n 件だけ判定する
  --only <id,...>    指定したセッションだけ判定する
  --concurrency <n>  同時に判定する数(既定 1)
  --force            判定済みのセッションも判定し直す
  --no-allow-tools   copilot に --allow-all-tools を付けない(既定は付ける)
  --timeout <秒>     1 件あたりの制限時間(既定 600)
  copilot の実行ファイルは環境変数 ATLAS_COPILOT_BIN で差し替えられます(opencode は ATLAS_OPENCODE_BIN)。
`;

export class UsageError extends Error {}

function posInt(v: string | undefined, name: string, min: number): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`${name} には ${min} 以上の整数を指定してください: ${v}`);
  return n;
}

export function parseCli(argv: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        home: { type: 'string' },
        out: { type: 'string' },
        since: { type: 'string' },
        project: { type: 'string' },
        client: { type: 'string' },
        model: { type: 'string' },
        branch: { type: 'string' },
        anonymize: { type: 'boolean', default: false },
        judgments: { type: 'string' },
        bundle: { type: 'string' },
        'include-empty': { type: 'boolean', default: false },
        'temp-dir': { type: 'string', multiple: true },
        backend: { type: 'string' },
        limit: { type: 'string' },
        only: { type: 'string' },
        concurrency: { type: 'string' },
        force: { type: 'boolean', default: false },
        'allow-tools': { type: 'boolean', default: true },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const cmd = positionals[0] ?? 'all';
  if (!(COMMANDS as readonly string[]).includes(cmd)) throw new UsageError(`不明なコマンドです: ${cmd}`);

  let judge: JudgeCliOptions | null = null;
  if (cmd === 'judge') {
    const action = positionals[1];
    if (!action) throw new UsageError('judge の後に run か import を指定してください');
    if (!(JUDGE_ACTIONS as readonly string[]).includes(action)) throw new UsageError(`judge の不明な操作です: ${action}(run / import)`);
    const file = positionals[2] ?? null;
    if (action === 'import' && !file) throw new UsageError('judge import には取り込むファイルを指定してください');
    const maxPos = action === 'import' ? 3 : 2;
    if (positionals.length > maxPos) throw new UsageError(`余分な引数があります: ${positionals.slice(maxPos).join(' ')}`);
    const backend = values.backend ?? 'copilot-cli';
    if (!(BACKEND_NAMES as readonly string[]).includes(backend)) throw new UsageError(`不明なバックエンドです: ${backend}(${BACKEND_NAMES.join(' / ')})`);
    const only = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (values.only != null && (!only || only.length === 0)) throw new UsageError('--only にセッション ID を指定してください');
    judge = {
      action: action as JudgeAction,
      file,
      backend: backend as BackendChoice,
      model: values.model ?? null,
      limit: posInt(values.limit, '--limit', 0),
      only,
      concurrency: posInt(values.concurrency, '--concurrency', 1) ?? 1,
      force: values.force ?? false,
      allowTools: values['allow-tools'] ?? true,
      timeoutSec: posInt(values.timeout, '--timeout', 1) ?? 600,
    };
  } else {
    if (positionals.length > 1) throw new UsageError(`コマンドは 1 つだけ指定してください: ${positionals.join(' ')}`);
    for (const k of ['backend', 'limit', 'only', 'concurrency', 'timeout'] as const) if (values[k] != null) throw new UsageError(`--${k} は judge run でだけ使えます`);
    if (values.force) throw new UsageError('--force は judge run でだけ使えます');
  }
  if (values.since != null && Number.isNaN(Date.parse(values.since))) throw new UsageError(`--since の日時を解釈できません: ${values.since}`);
  return {
    command: cmd as Command,
    home: values.home ?? null,
    out: values.out ?? null,
    since: values.since ?? null,
    project: values.project ?? null,
    client: values.client ?? null,
    model: values.model ?? null,
    branch: values.branch ?? null,
    anonymize: values.anonymize ?? false,
    judgments: values.judgments ?? null,
    bundle: values.bundle ?? null,
    includeEmpty: values['include-empty'] ?? false,
    tempDirs: values['temp-dir'] && values['temp-dir'].length ? values['temp-dir'] : null,
    judge,
    help: values.help ?? false,
  };
}
