// atlas コマンドの引数解釈(純関数)
import { parseArgs } from 'node:util';

export const COMMANDS = ['snapshot', 'extract', 'metrics', 'build', 'export', 'all', 'bundle', 'judge', 'group', 'memo', 'serve', 'skill-draft'] as const;
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

export const GROUP_ACTIONS = ['list', 'add', 'remove'] as const;
export type GroupAction = (typeof GROUP_ACTIONS)[number];

export interface GroupCliOptions {
  action: GroupAction;
  /** add / remove の対象のグループ名 */
  name: string | null;
  /** add に渡したセッション id(先頭一致で解決する前の文字列) */
  ids: string[];
  /** add の --note */
  note: string | null;
}

export const MEMO_ACTIONS = ['list', 'show', 'set', 'remove'] as const;
export type MemoAction = (typeof MEMO_ACTIONS)[number];

export interface MemoCliOptions {
  action: MemoAction;
  /** show / set / remove の対象のセッション id(先頭一致で解決する前の文字列) */
  id: string | null;
  /** set の本文(コマンドラインの残りを空白でつないだもの) */
  text: string | null;
  /** set の --file */
  file: string | null;
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
  /** 名前付きグループ(atlas-notes/groups.json)で絞る */
  group: string | null;
  /** 特定のセッションだけ(id。先頭一致で解決する前の文字列。カンマ区切り・複数回指定を平らにしたもの) */
  sessions: string[] | null;
  /** atlas-notes/ の場所(既定はリポジトリ直下の atlas-notes/) */
  notesDir: string | null;
  anonymize: boolean;
  /** judgments.json の場所(既定は <out>/judgments.json があれば使う) */
  judgments: string | null;
  /** 評価バンドルの場所(既定は <out>/bundle) */
  bundle: string | null;
  /** bundle: 依頼の記録が無いセッションも含める */
  includeEmpty: boolean;
  /** bundle: 1 つの分割ファイル(parts/)に入れるパケットの数。未指定は null(既定 5) */
  perPart: number | null;
  /** extract: 一時フォルダとみなすフォルダ(指定すると既定の一時フォルダの判定を置き換える)。未指定は null */
  tempDirs: string[] | null;
  /** extract: 設定ファイルの場所。未指定は null(環境変数 ATLAS_CONFIG、無ければリポジトリ直下の atlas.config.json) */
  config: string | null;
  /** export: セッション記録にツールの結果を入れる条件 */
  toolOutput: 'fail' | 'all' | 'none';
  /** export: 本文 1 件の上限(文字)。null は既定 */
  maxChars: number | null;
  /** Phase 11 export: 全文記録(out/full/)と coverage.json も書く */
  full: boolean;
  /** Phase 11 snapshot: 既定で写さない大きなもの(rewind-snapshots、一覧に無いもの、logs/)も写す */
  snapshotAll: boolean;
  /** snapshot: 前回 --snapshot-all で写したが今回は写さないものを消す(既定は残す) */
  snapshotPrune: boolean;
  judge: JudgeCliOptions | null;
  groupCmd: GroupCliOptions | null;
  memoCmd: MemoCliOptions | null;
  /** serve: 固定するポート(null は空きポート) */
  port: number | null;
  /** serve: 起動後にブラウザを開く(--no-open で開かない) */
  open: boolean;
  /** skill-draft: 候補の番号(insights.json の順)と、使うバックエンド */
  skillDraft: { index: number; backend: BackendChoice; model: string | null; timeoutSec: number } | null;
  help: boolean;
}

export const USAGE = `使い方: atlas <コマンド> [オプション]

コマンド:
  snapshot   ~/.copilot の必要部分を <out>/snapshot へ複製する(元は書き換えない)
  extract    スナップショットから <out>/sessions.json を作る
  metrics    sessions.json から <out>/metrics.json を作る
  build      <out>/atlas.html と <out>/sessions/<id>.html を作る
  export     build に加えて、各セッションの記録(経過・消費)を <out>/sessions/<id>.md に書く(LLM での振り返り用。共有するなら --anonymize)
  all        snapshot → extract → metrics → export(セッション記録つき)を通しで実行する(コマンド省略時の既定)。
             --anonymize のときは記録を作らず build にする
  bundle     LLM に工数を判定させる評価バンドルを <out>/bundle に作る(LLM は呼ばない)。ZIP を渡せない相手用に、
             指示とパケット数件を 1 ファイルにまとめた <out>/bundle/parts/part-<番号>.md も書く
  judge run  バンドルの各セッションを LLM で判定し <out>/judgments.json に追記する(クレジットを消費します)
  judge import <ファイル>
             外部の LLM で作った判定(JSON か、JSON を含む Markdown)を検証して judgments.json に取り込む
  group list / group add <名前> <id...> [--note <一文>] / group remove <名前>
             名前付きグループ(<notes-dir>/groups.json)を一覧・追加(既存名なら id を追記)・削除する
  memo list / memo show <id> / memo set <id> <本文...> / memo set <id> --file <path> / memo remove <id>
             セッションごとのメモ(<notes-dir>/memos/<id>.md)を一覧・表示・保存・削除する(remove は画像を残す)
  serve      out/ を 127.0.0.1 だけに配信してブラウザで開く(画面からグループとメモを書け、集計し直す・工数の判定・
             記録と全文記録の表示ができる)。ブラウザを閉じると止まる(画面から動かした処理の実行中は終わるまで待つ)
  skill-draft <番号>
             改善点の「スキル化の候補」(out/insights.json の番号)から SKILL.md の下書きを LLM に作らせ、
             out/skill-drafts/ に書く(クレジットや従量課金を消費しうる。明示したときだけ動く。--backend は judge と同じ)

オプション:
  --home <dir>       Copilot のデータの場所(既定: 環境変数 ATLAS_COPILOT_HOME、無ければ ~/.copilot)
  --out <dir>        出力先(既定: リポジトリ直下の out/)
  --since <date>     この日時以降に更新されたセッションだけ(例: 2026-07-01)
  --project <key>    プロジェクトで絞る(完全一致、無ければ部分一致)
  --client <name>    クライアントで絞る(例: github/cli, github/autopilot)
  --model <name>     そのモデルを使ったセッションだけ(judge run では判定に使うモデル)
  --branch <name>    ブランチで絞る
  --group <名前>     名前付きグループ(<notes-dir>/groups.json)のセッションだけ(他の絞り込みと AND)
  --session <id,...> 特定のセッションだけ(カンマ区切り、複数回指定可。id は先頭一致で解決、曖昧ならエラー)
  --notes-dir <dir>  メモとグループの置き場(既定: リポジトリ直下の atlas-notes/)
  --file <path>      memo set: 本文をこのファイルから読む
  --anonymize        プロジェクト名・パス・リポジトリ名・ブランチを伏せ字にして HTML を出す(共有用。メモは出さない)
  --judgments <file> 判定結果 judgments.json の場所(既定: <out>/judgments.json)
  --bundle <dir>     評価バンドルの場所(既定: <out>/bundle)
  --include-empty    bundle: 依頼の記録が無いセッションもパケットにする
  --per-part <n>     bundle: parts/ の 1 ファイルに入れるパケットの数(既定 5)
  --temp-dir <dir>   extract: このフォルダ配下を「(一時フォルダ)」にまとめる(複数指定可)。指定すると既定の判定
                     (%TEMP% と AppData\\Local\\Temp・/tmp のパターン)を使わない
  --snapshot-all     snapshot: 既定で写さない大きなもの(rewind-snapshots、一覧に無い名前のもの、logs/)も写す
  --snapshot-prune   snapshot: 前回 --snapshot-all で写したが今回は写さないものを消す(既定は残して manifest に日時を出す)
  --config <file>    extract: 設定ファイル(wiki の vault の指定)の場所
                     (既定: 環境変数 ATLAS_CONFIG、無ければリポジトリ直下の atlas.config.json)
  -h, --help         この説明を出す

export のオプション:
  --tool-output <v>  ツールの結果を記録に入れる条件: fail(既定、失敗したときだけ)/ all / none
  --max-chars <n>    依頼・応答・要約 1 件の上限(文字、既定 20000)。超えた分は中略して字数を書く
  --full             解析用の全文記録(out/full/<id>.md、上限なし。暗号化データと base64 本体だけ除外)と
                     out/coverage.json(網羅の検査)も書く。--anonymize とは併用できない。共有しないこと

serve のオプション:
  --port <n>         ポートを固定する(既定は空きポートを自動で取る)
  --no-open          起動後にブラウザを開かない

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
        group: { type: 'string' },
        session: { type: 'string', multiple: true },
        'notes-dir': { type: 'string' },
        note: { type: 'string' },
        file: { type: 'string' },
        anonymize: { type: 'boolean', default: false },
        judgments: { type: 'string' },
        bundle: { type: 'string' },
        'include-empty': { type: 'boolean', default: false },
        'per-part': { type: 'string' },
        'temp-dir': { type: 'string', multiple: true },
        config: { type: 'string' },
        'tool-output': { type: 'string' },
        full: { type: 'boolean', default: false },
        'snapshot-all': { type: 'boolean', default: false },
        'snapshot-prune': { type: 'boolean', default: false },
        'max-chars': { type: 'string' },
        backend: { type: 'string' },
        limit: { type: 'string' },
        only: { type: 'string' },
        concurrency: { type: 'string' },
        force: { type: 'boolean', default: false },
        'allow-tools': { type: 'boolean', default: true },
        timeout: { type: 'string' },
        port: { type: 'string' },
        open: { type: 'boolean', default: true },
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
  }
  let skillDraft: CliOptions['skillDraft'] = null;
  if (cmd === 'skill-draft') {
    const n = positionals[1];
    if (!n) throw new UsageError('skill-draft には候補の番号(out/insights.json の順、1 から)を指定してください');
    const index = Number(n);
    if (!Number.isInteger(index) || index < 1) throw new UsageError(`候補の番号は 1 以上の整数です: ${n}`);
    if (positionals.length > 2) throw new UsageError(`余分な引数があります: ${positionals.slice(2).join(' ')}`);
    const backend = values.backend ?? 'copilot-cli';
    if (!(BACKEND_NAMES as readonly string[]).includes(backend)) throw new UsageError(`不明なバックエンドです: ${backend}(${BACKEND_NAMES.join(' / ')})`);
    skillDraft = { index, backend: backend as BackendChoice, model: values.model ?? null, timeoutSec: posInt(values.timeout, '--timeout', 1) ?? 600 };
  }
  let groupCmd: GroupCliOptions | null = null;
  if (cmd === 'group') {
    const action = positionals[1];
    if (!action) throw new UsageError('group の後に list / add / remove を指定してください');
    if (!(GROUP_ACTIONS as readonly string[]).includes(action)) throw new UsageError(`group の不明な操作です: ${action}(list / add / remove)`);
    const name = positionals[2] ?? null;
    const ids = positionals.slice(3).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    if (action === 'list' && positionals.length > 2) throw new UsageError(`余分な引数があります: ${positionals.slice(2).join(' ')}`);
    if (action !== 'list' && !name) throw new UsageError(`group ${action} にはグループ名を指定してください`);
    if (action === 'add' && ids.length === 0) throw new UsageError('group add にはセッション id を 1 つ以上指定してください');
    if (action === 'remove' && positionals.length > 3) throw new UsageError(`余分な引数があります: ${positionals.slice(3).join(' ')}`);
    if (values.note != null && action !== 'add') throw new UsageError('--note は group add でだけ使えます');
    groupCmd = { action: action as GroupAction, name, ids, note: values.note ?? null };
  } else if (values.note != null) throw new UsageError('--note は group add でだけ使えます');
  let memoCmd: MemoCliOptions | null = null;
  if (cmd === 'memo') {
    const action = positionals[1];
    if (!action) throw new UsageError('memo の後に list / show / set / remove を指定してください');
    if (!(MEMO_ACTIONS as readonly string[]).includes(action)) throw new UsageError(`memo の不明な操作です: ${action}(list / show / set / remove)`);
    const id = positionals[2] ?? null;
    const rest = positionals.slice(3);
    if (action === 'list' && positionals.length > 2) throw new UsageError(`余分な引数があります: ${positionals.slice(2).join(' ')}`);
    if (action !== 'list' && !id) throw new UsageError(`memo ${action} にはセッション id を指定してください`);
    if (action !== 'set' && rest.length) throw new UsageError(`余分な引数があります: ${rest.join(' ')}`);
    if (action === 'set' && rest.length === 0 && values.file == null) throw new UsageError('memo set には本文か --file を指定してください');
    if (action === 'set' && rest.length > 0 && values.file != null) throw new UsageError('memo set の本文と --file は同時に指定できません');
    memoCmd = { action: action as MemoAction, id, text: rest.length ? rest.join(' ') : null, file: values.file ?? null };
  }
  if (values.file != null && memoCmd?.action !== 'set') throw new UsageError('--file は memo set でだけ使えます');
  if (cmd !== 'judge' && cmd !== 'group' && cmd !== 'memo' && cmd !== 'skill-draft') {
    if (positionals.length > 1) throw new UsageError(`コマンドは 1 つだけ指定してください: ${positionals.join(' ')}`);
    for (const k of ['backend', 'limit', 'only', 'concurrency', 'timeout'] as const) if (values[k] != null) throw new UsageError(`--${k} は judge run でだけ使えます`);
    if (values.force) throw new UsageError('--force は judge run でだけ使えます');
  }
  const toolOutput = values['tool-output'] ?? 'fail';
  if (!['fail', 'all', 'none'].includes(toolOutput)) throw new UsageError(`--tool-output は fail / all / none のどれかです: ${toolOutput}`);
  if ((values['tool-output'] != null || values['max-chars'] != null) && cmd !== 'export') throw new UsageError('--tool-output と --max-chars は export でだけ使えます');
  if (values['per-part'] != null && cmd !== 'bundle') throw new UsageError('--per-part は bundle でだけ使えます');
  if (values.full && cmd !== 'export') throw new UsageError('--full は export でだけ使えます');
  if (values.full && values.anonymize) throw new UsageError('--full(解析用の全文記録)は --anonymize と併用できません');
  // 伏せ字に対応していないコマンドで黙って無視すると、伏せたつもりの評価バンドル(依頼文の全文・パス入り)を外部へ渡してしまう
  if (values.anonymize && !['build', 'export', 'all'].includes(cmd))
    throw new UsageError(`--anonymize は build / export / all でだけ使えます(${cmd} の出力は伏せ字になりません。評価バンドルを外部の LLM に渡すときは中身を確認してください)`);
  if ((values['snapshot-all'] || values['snapshot-prune']) && !['snapshot', 'all', 'export'].includes(cmd)) throw new UsageError('--snapshot-all と --snapshot-prune は snapshot / all / export で使えます');
  if (values.config != null && cmd !== 'extract' && cmd !== 'all') throw new UsageError('--config は extract と all でだけ使えます');
  if (values.since != null && Number.isNaN(Date.parse(values.since))) throw new UsageError(`--since の日時を解釈できません: ${values.since}`);
  if ((values.port != null || values.open === false) && cmd !== 'serve') throw new UsageError('--port と --no-open は serve でだけ使えます');
  const port = posInt(values.port, '--port', 0);
  if (port != null && port > 65535) throw new UsageError(`--port は 65535 以下です: ${port}`);
  const sessions = values.session ? values.session.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean) : null;
  if (values.session != null && (!sessions || sessions.length === 0)) throw new UsageError('--session にセッション id を指定してください');
  if (values.group != null && !values.group.trim()) throw new UsageError('--group にグループ名を指定してください');
  return {
    command: cmd as Command,
    home: values.home ?? null,
    out: values.out ?? null,
    since: values.since ?? null,
    project: values.project ?? null,
    client: values.client ?? null,
    model: values.model ?? null,
    branch: values.branch ?? null,
    group: values.group?.trim() ?? null,
    sessions,
    notesDir: values['notes-dir'] ?? null,
    anonymize: values.anonymize ?? false,
    judgments: values.judgments ?? null,
    bundle: values.bundle ?? null,
    includeEmpty: values['include-empty'] ?? false,
    perPart: posInt(values['per-part'], '--per-part', 1),
    tempDirs: values['temp-dir'] && values['temp-dir'].length ? values['temp-dir'] : null,
    config: values.config ?? null,
    toolOutput: toolOutput as 'fail' | 'all' | 'none',
    maxChars: posInt(values['max-chars'], '--max-chars', 200),
    full: values.full ?? false,
    snapshotAll: values['snapshot-all'] ?? false,
    snapshotPrune: values['snapshot-prune'] ?? false,
    judge,
    groupCmd,
    memoCmd,
    port,
    open: values.open ?? true,
    skillDraft,
    help: values.help ?? false,
  };
}
