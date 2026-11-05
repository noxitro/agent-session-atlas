#!/usr/bin/env node
// npm run atlas:judge と、atlas serve の画面の「工数を判定する」(jobs.ts が子プロセスで起動する)の入口:
// bundle → judge run → export(伏せ字版は build)を通しで実行する。
//   node packages/cli/src/judge-flow.ts [judge run のオプション]
// --turns のときは依頼ごとの判定(段階 2): turns bundle --unjudged → turns run(GitHub Copilot CLI)→ export。
//   node packages/cli/src/judge-flow.ts --turns [--limit <n>] [--model <名前>]
// 判定に失敗したセッションがあってもレポートは作り直す(判定済みの分は反映する)。終了コードは 1 にする。
import { parseCli, USAGE, UsageError } from './args.ts';
import { resolvePaths, run } from './commands.ts';
import { acquireOutLock } from './jobs.ts';

/** 依頼ごとの判定の通し(--turns) */
async function turnsFlow(argv: string[]): Promise<number> {
  let o;
  try {
    o = parseCli(['turns', 'run', ...argv.filter((a) => a !== '--turns')]);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`atlas:judge --turns: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  const log = (msg: string): void => {
    process.stdout.write(`${msg}\n`);
  };
  const common = { ...o, model: null, turns: null, judge: null };
  let release = (): void => {};
  try {
    release = acquireOutLock(resolvePaths(o).out, 'turns', 'cli');
    await run({ ...common, command: 'turns', turns: { ...o.turns!, action: 'bundle', unjudged: true } }, log);
    let failed: string | null = null;
    try {
      await run(o, log);
    } catch (e) {
      failed = (e as Error).message;
    }
    const b = await run({ ...common, command: 'export' }, log);
    if (b.build) log(`\nレポート: ${b.build.htmlPath}`);
    if (failed) {
      process.stderr.write(`atlas:judge --turns: ${failed}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`atlas:judge --turns: 失敗しました: ${(e as Error).message}\n`);
    return 1;
  } finally {
    release();
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--turns')) return turnsFlow(argv);
  let judgeOpts;
  // --anonymize は最後に作り直すレポートだけに効く(judge run 自体は伏せ字に対応しないので、judge run の解析には渡さない)
  const anonymize = argv.includes('--anonymize');
  try {
    judgeOpts = parseCli(['judge', 'run', ...argv.filter((a) => a !== '--anonymize')]);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`atlas:judge: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (judgeOpts.help) {
    process.stdout.write(`使い方: npm run atlas:judge -- [judge run のオプション]\nbundle → judge run → export(伏せ字版は build)を順に実行します。\n\n${USAGE}`);
    return 0;
  }
  const log = (msg: string): void => {
    process.stdout.write(`${msg}\n`);
  };
  // 判定の --model は判定モデルなので、bundle / build の絞り込みには使わない
  const common = { ...judgeOpts, model: null, judge: null };
  let release = (): void => {};
  try {
    // bundle → judge run → export の間ずっと印を持つ(切れ目に画面の判定や atlas.bat の all が入らないように。中の run は同じプロセスなので止まらない)
    release = acquireOutLock(resolvePaths(judgeOpts).out, 'judge', 'cli');
    await run({ ...common, command: 'bundle' }, log);
    let failed = 0;
    try {
      const r = await run(judgeOpts, log);
      failed = r.judge?.failed.length ?? 0;
    } catch (e) {
      process.stderr.write(`atlas:judge: 判定を実行できませんでした: ${(e as Error).message}\n`);
      return 1;
    }
    // 直前の all が作ったセッション記録を消さないよう、伏せ字版でなければ export で作り直す
    const b = await run({ ...common, anonymize, command: anonymize ? 'build' : 'export' }, log);
    if (b.build) log(`\nレポート: ${b.build.htmlPath}`);
    if (failed > 0) {
      process.stderr.write(`atlas:judge: 判定に失敗したセッションが ${failed} 件あります(judgments.json の failures に記録しました。もう一度実行すると再試行します)\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`atlas:judge: 失敗しました: ${(e as Error).message}\n`);
    if (process.env.ATLAS_DEBUG) process.stderr.write(`${(e as Error).stack}\n`);
    return 1;
  } finally {
    release();
  }
}

process.exitCode = await main(process.argv.slice(2));
