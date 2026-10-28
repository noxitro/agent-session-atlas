#!/usr/bin/env node
// atlas-judge.bat / npm run atlas:judge の入口: bundle → judge run → build を通しで実行する。
//   node packages/cli/src/judge-flow.ts [judge run のオプション]
// 判定に失敗したセッションがあってもレポートは作り直す(判定済みの分は反映する)。終了コードは 1 にする。
import { parseCli, USAGE, UsageError } from './args.ts';
import { run } from './commands.ts';

async function main(argv: string[]): Promise<number> {
  let judgeOpts;
  try {
    judgeOpts = parseCli(['judge', 'run', ...argv]);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`atlas-judge: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (judgeOpts.help) {
    process.stdout.write(`使い方: atlas-judge [judge run のオプション]\nbundle → judge run → build を順に実行します。\n\n${USAGE}`);
    return 0;
  }
  const log = (msg: string): void => {
    process.stdout.write(`${msg}\n`);
  };
  // 判定の --model は判定モデルなので、bundle / build の絞り込みには使わない
  const common = { ...judgeOpts, model: null, judge: null };
  try {
    await run({ ...common, command: 'bundle' }, log);
    let failed = 0;
    try {
      const r = await run(judgeOpts, log);
      failed = r.judge?.failed.length ?? 0;
    } catch (e) {
      process.stderr.write(`atlas-judge: 判定を実行できませんでした: ${(e as Error).message}\n`);
      return 1;
    }
    const b = await run({ ...common, command: 'build' }, log);
    if (b.build) log(`\nレポート: ${b.build.htmlPath}`);
    if (failed > 0) {
      process.stderr.write(`atlas-judge: 判定に失敗したセッションが ${failed} 件あります(judgments.json の failures に記録しました。もう一度実行すると再試行します)\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`atlas-judge: 失敗しました: ${(e as Error).message}\n`);
    if (process.env.ATLAS_DEBUG) process.stderr.write(`${(e as Error).stack}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
