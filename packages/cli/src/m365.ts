// M365 Copilot のアプリを UI Automation で操作して判定する(atlas judge m365 / atlas turns m365 と、画面の「M365 Copilot で自動で判定する」)。
// 添付ファイル(bundle/parts/・turn-bundle/parts/)のうち未判定のものを 1 つずつ、新しいチャットで送り、返答を取り込む。
// 画面の操作は m365-uia.ps1(Windows PowerShell)が 1 ファイルごとに行う。判定するのは M365 Copilot なので、このツールは AI クレジットを使わない。
// 返答は <bundle>/replies/<名前>.md に残す(形が合わずに取り込めなかったとき、読んで確かめられるように)。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionsFile } from '../../core/src/index.ts';
import { importJudgmentsText, importTurnJudgmentsText, JudgmentValidationError, turnImportPhases } from '../../judge/src/index.ts';
import { CHAT_REQUEST, chatSaveName, listChatParts, type ChatTarget } from './chat-parts.ts';
import { phaseNames } from './config.ts';

/** M365 Copilot のモデル選択の既定(推論に時間をかけるもの。判定はパケットを読み比べる重い作業なので) */
export const M365_DEFAULT_MODEL = 'Think Deeper';
/** 1 ファイルの返答を待つ既定の秒数(Think Deeper は数分かかることがある) */
export const M365_DEFAULT_TIMEOUT_SEC = 900;
export const M365_SCRIPT = fileURLToPath(new URL('./m365-uia.ps1', import.meta.url));

export interface M365Request {
  /** 添付するファイル(名前がそのままチャットに出る) */
  attach: string;
  prompt: string;
  model: string;
  timeoutSec: number;
  /** 返答の文字を書くファイル */
  outFile: string;
  /** 進み具合(m365-uia.ps1 の progress 行) */
  onProgress: (msg: string) => void;
}
/** 画面を操作して 1 ファイルを判定させ、返答を outFile に書く。失敗は例外(理由はそのまま利用者に出す) */
export type M365Driver = (req: M365Request) => Promise<void>;

/** やり直しても同じ失敗(M365 Copilot の画面が無いなど)。残りのファイルを送らずに止まる */
export class M365FatalError extends Error {}

/** m365-uia.ps1 を Windows PowerShell で動かす */
export const powershellDriver: M365Driver = (req) =>
  new Promise((resolvePromise, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', M365_SCRIPT, '-Attach', req.attach, '-Prompt', req.prompt, '-Model', req.model, '-TimeoutSec', String(req.timeoutSec), '-OutFile', req.outFile];
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    let stderr = '';
    let buf = '';
    const onLine = (line: string): void => {
      const t = line.trim();
      if (t.startsWith('progress: ')) req.onProgress(t.slice('progress: '.length));
      else if (t.startsWith('error: ')) error = t.slice('error: '.length);
      else if (t) stderr += `${t}\n`;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) onLine(l);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    // 画面の操作が止まったまま戻らないときのため、待つ秒数に余裕を足して止める
    const timer = setTimeout(() => child.kill(), (req.timeoutSec + 180) * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Windows PowerShell を起動できません: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf) onLine(buf);
      if (code === 0) return resolvePromise();
      const message = error || stderr.trim().split('\n').slice(-3).join(' / ') || `画面の操作が終了コード ${code} で止まりました`;
      // 終了コード 3 は画面が見つからないとき(やり直しても同じ)
      reject(code === 3 ? new M365FatalError(message) : new Error(message));
    });
  });

export interface M365Paths {
  out: string;
  sessions: string;
  judgments: string;
  turnJudgments: string;
  turnBundle: string;
}

export interface M365Options {
  target: ChatTarget;
  /** モデル選択の名前(先頭が合うものを選ぶ。Auto / Quick Response / Think Deeper) */
  model: string;
  /** 送るファイルの数の上限(null は全部) */
  limit: number | null;
  timeoutSec: number;
  /** 画面の操作が途中で崩れたとき、同じファイルを新しいチャットでやり直す回数(既定 2) */
  retries?: number;
}

export interface M365Summary {
  /** 送ったファイル */
  attempted: number;
  /** 取り込めたファイル */
  succeeded: number;
  /** 取り込んだ判定の数(セッション、turns は依頼) */
  imported: number;
  failed: { name: string; reason: string }[];
  /** 画面の操作が止まり、残りのファイルを送らなかった */
  stopped: boolean;
}

export async function runM365Judge(p: M365Paths, o: M365Options, log: (msg: string) => void, driver: M365Driver = powershellDriver, platform: NodeJS.Platform = process.platform, pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<M365Summary> {
  if (platform !== 'win32') throw new Error('M365 Copilot の自動操作は Windows でだけ使えます(ほかの OS では、添付ファイルを手で渡してください)');
  const label = o.target === 'turns' ? '依頼' : 'セッション';
  const info = await listChatParts(p.out, o.target);
  if (!info.exists || !info.parts?.length) throw new Error(`添付ファイルがまだありません。先に「添付ファイルを作る」(atlas ${o.target === 'turns' ? 'turns bundle' : 'bundle'} --unjudged)を実行してください`);
  const pending = info.parts.filter((x) => x.judged < x.sessions);
  const todo = o.limit == null ? pending : pending.slice(0, o.limit);
  const summary: M365Summary = { attempted: 0, succeeded: 0, imported: 0, failed: [], stopped: false };
  if (!todo.length) {
    log(`m365: 未判定の添付ファイルはありません(${info.parts.length} ファイルとも判定済み)`);
    return summary;
  }
  log(`m365: 未判定の添付ファイル ${pending.length} 個のうち ${todo.length} 個を、M365 Copilot(${o.model})で 1 つずつ判定します。終わるまで M365 Copilot の画面に触らないでください`);
  log('m365: 添付したファイルは、M365 Copilot の決まりどおり OneDrive に入ります');
  const known = existsSync(p.sessions) ? (JSON.parse(await readFile(p.sessions, 'utf8')) as SessionsFile).sessions : [];
  const knownIds = new Set(known.map((s) => s.id));
  const turnsBySession = new Map(known.map((s) => [s.id, s.analysis?.turnStats?.length ?? 0]));
  const phases = o.target === 'turns' ? await turnImportPhases(p.turnBundle, await phaseNames()) : [];
  const repliesDir = join(p.out, o.target === 'turns' ? 'turn-bundle' : 'bundle', 'replies');
  await mkdir(repliesDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'atlas-m365-'));
  try {
    for (const [i, part] of todo.entries()) {
      const name = chatSaveName(o.target, part.name);
      const attach = join(work, name);
      const reply = join(repliesDir, `${name.replace(/\.txt$/, '')}.md`);
      await copyFile(join(p.out, ...part.path.split('/')), attach);
      await rm(reply, { force: true });
      log(`m365: [${i + 1}/${todo.length}] ${name}(${label} ${part.sessions - part.judged} 件が未判定)を送ります`);
      summary.attempted++;
      // 利用者がほかのアプリで作業していると、画面の操作が途中で崩れることがある。新しいチャットからやり直す(画面が無いときはやり直さない)
      const tries = 1 + Math.max(0, o.retries ?? 2);
      let failure: Error | null = null;
      for (let t = 1; t <= tries; t++) {
        if (t > 1) {
          log(`m365:   ${name} をやり直します(${t}/${tries} 回目)`);
          await pause(5000);
          await rm(reply, { force: true });
        }
        try {
          await driver({ attach, prompt: CHAT_REQUEST, model: o.model, timeoutSec: o.timeoutSec, outFile: reply, onProgress: (m) => log(`m365:   ${m}`) });
          failure = null;
          break;
        } catch (e) {
          failure = e as Error;
          if (e instanceof M365FatalError) break;
          if (t < tries) log(`m365:   画面の操作が崩れました: ${failure.message}`);
        }
      }
      if (failure) {
        // 画面の状態が分からないので、残りは送らない
        summary.failed.push({ name, reason: failure.message });
        summary.stopped = todo.length > i + 1;
        log(`m365: ${name} で画面の操作が止まりました: ${failure.message}`);
        break;
      }
      // 画面から読んだ文字はコードブロックの囲みが無く、行番号とボタンの名前が混じる。組み立て直したものを残して取り込む(読んだままの文字も残す)
      const raw = existsSync(reply) ? await readFile(reply, 'utf8') : '';
      const text = cleanCopilotReply(raw);
      await writeFile(reply.replace(/\.md$/, '.raw.txt'), raw);
      await writeFile(reply, text);
      try {
        const r =
          o.target === 'turns'
            ? await importTurnJudgmentsText(text, p.turnJudgments, { phases, turnsBySession })
            : await importJudgmentsText(text, p.judgments, { knownIds, label: name });
        summary.succeeded++;
        summary.imported += r.imported;
        log(`m365: ${name} の返答から ${r.imported} 件を取り込みました(既存の上書き ${r.overwritten} 件)`);
      } catch (e) {
        const problems = e instanceof JudgmentValidationError ? e.problems.slice(0, 5) : [];
        summary.failed.push({ name, reason: (e as Error).message });
        log(`m365: ${name} の返答を取り込めませんでした(何も書いていません): ${(e as Error).message}${problems.length ? `\n${problems.map((x) => `m365:   - ${x}`).join('\n')}` : ''}`);
        log(`m365:   返答は ${reply} にあります(直して atlas ${o.target === 'turns' ? 'turns' : 'judge'} import で取り込めます)`);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  log(`m365: 完了 送った ${summary.attempted} / 取り込めた ${summary.succeeded} / 取り込んだ${label} ${summary.imported} 件${summary.stopped ? '(途中で止まったので、残りは送っていません)' : ''}`);
  return summary;
}

/** コードブロックの上に出るボタン(この行の後ろから行番号つきの本文が始まる) */
const CODE_TOOLBAR = new Set(['コードをコピー', 'Copy code', 'Copy']);
/** コードブロックの上下に出る、本文ではない行(言語名の後ろのボタン・返答の下のボタン・画像などの置き換え文字) */
const UI_LINES = new Set(['その他のオプション', 'More options', '応答のコピー', 'Copy response', '気に入った点がある', '不満な点がある', 'Like', 'Dislike', '\uFFFC', '']);

/**
 * M365 Copilot の画面から UI Automation で読んだ返答を、取り込める Markdown に直す。
 * 画面のコードブロックは「行番号(と行頭の空白)」の行と「その行の本文」の行が交互に並び、```json の囲みが無い。
 * 「コードをコピー」のボタンの後ろの、1 から続く行番号の並びを見つけ、本文の行を元の字下げでつなぎ直して ```json で囲む。
 * 行番号は 1 つずつ増えるものだけを行番号とみなす(本文に数字だけの行があっても崩さない)。それ以外の行はそのまま残す
 */
export function cleanCopilotReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!CODE_TOOLBAR.has(t)) {
      if (t !== '\uFFFC') out.push(lines[i]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && UI_LINES.has(lines[j].trim())) j++;
    if (lines[j]?.trim() !== '1') {
      i++;
      continue;
    }
    // 直前の言語名(JSON など)の行は囲みの言語にする
    const lang = out.length && /^[A-Za-z][\w+#-]{0,15}$/.test(out[out.length - 1].trim()) ? out.pop()!.trim().toLowerCase() : '';
    const code: string[] = [];
    let n = 1;
    let k = j;
    /** 本文の行の終わり: 次の行番号か、本文ではないボタンの行 */
    const ends = (line: string): boolean => {
      const s = line.trim();
      return s === String(n + 1) || CODE_TOOLBAR.has(s) || (s !== '' && UI_LINES.has(s));
    };
    while (k < lines.length && lines[k].trim() === String(n)) {
      // 行番号の後ろの空白は、その行の字下げ
      const indent = lines[k].slice(lines[k].indexOf(String(n)) + String(n).length);
      k++;
      const body: string[] = [];
      while (k < lines.length && !ends(lines[k])) body.push(lines[k++]);
      // 画面のコードには、ノーブレークスペース(U+00A0)だけの行が混じることがある。JSON の空白として読めないので普通の空白にする
      code.push((indent + body.join('')).replace(/ /g, ' '));
      n++;
    }
    out.push(`\`\`\`${lang}`, ...code, '```');
    i = k;
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
