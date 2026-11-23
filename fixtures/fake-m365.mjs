#!/usr/bin/env node
// テスト用の「偽の M365 Copilot の画面の操作」。atlas の環境変数 ATLAS_M365_FAKE_DRIVER にこのファイルを指すと、
// m365-uia.ps1(Windows PowerShell)の代わりに node で同じ引数のまま動く。LLM も M365 Copilot の画面も使わない。
// - 引数は m365-uia.ps1 と同じ(-Attach <添付するファイル> -OutFile <返答を書く先> など)
// - 環境変数 FAKE_M365_PID_FILE があれば、自分の pid を書く(画面の「止める」で、ジョブの子の子まで止まるかを確かめる)
// - 環境変数 FAKE_M365_DELAY_MS があれば、その時間だけ待ってから応える
// - 添付がタスクの紐づけのファイルなら、パケットごとに候補の先頭のタスクを選んだ返答を書く。
//   そのほかの添付には返答を書かない(取り込めずに、そのファイルは失敗になる)
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (process.env.FAKE_M365_PID_FILE) writeFileSync(process.env.FAKE_M365_PID_FILE, String(process.pid));
process.stdout.write('progress: 偽の画面の操作を始めました\n');
if (process.env.FAKE_M365_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_M365_DELAY_MS)));

const attach = valueOf('-Attach');
const outFile = valueOf('-OutFile');
const text = attach ? readFileSync(attach, 'utf8') : '';
if (outFile && text.startsWith('# 管理ツールのタスクへの紐づけの指示')) {
  // パケットは「<<<PACKET_BEGIN 境界」から「PACKET_END 境界>>>」まで(指示の中の説明の行は字下げしてあるので数えない)
  const packets = [...text.matchAll(/^<<<PACKET_BEGIN (\S+)\n([\s\S]*?)\nPACKET_END \1>>>$/gm)].map((m) => m[2]);
  const links = packets.flatMap((p) => {
    const id = /^- セッション ID: (\S+)$/m.exec(p)?.[1];
    const task = /^- id: (.+?) \| 名前: /m.exec(p)?.[1];
    return id && task ? [{ sessionId: id, taskIds: [task], confidence: 0.6, reason: '偽の M365 Copilot(テスト用): 候補の先頭' }] : [];
  });
  writeFileSync(outFile, `決めました。\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, links })}\n\`\`\`\n`);
}
process.stdout.write('progress: 返答を書きました\n');
