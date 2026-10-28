#!/usr/bin/env node
// atlas コマンドの入口: node packages/cli/src/main.ts <command> [options]
import { parseCli, USAGE, UsageError } from './args.ts';
import { run } from './commands.ts';

async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`atlas: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = (msg: string): void => {
    process.stdout.write(`${msg}\n`);
  };
  try {
    const r = await run(opts, log);
    if (r.build) log(`\nレポート: ${r.build.htmlPath}`);
    if (r.judge && r.judge.failed.length > 0) {
      process.stderr.write(`atlas: 判定に失敗したセッションが ${r.judge.failed.length} 件あります(judgments.json の failures に記録しました。もう一度 judge run すると再試行します)\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`atlas: 失敗しました: ${(e as Error).message}\n`);
    if (process.env.ATLAS_DEBUG) process.stderr.write(`${(e as Error).stack}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
