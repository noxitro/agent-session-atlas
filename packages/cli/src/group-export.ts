// グループの書き出し: そのグループのセッションだけを、表計算ソフトや別の分析に持ち出せる形で 1 つのフォルダにまとめる。
//   <out>/groups/<グループ名>/turns.csv     依頼(ターン)ごとの表
//                             sessions.csv  セッションごとの表
//                             vcs-hunks.csv AI の変更のまとまりごとの、VCS の照合の結果(照合してあるときだけ)
//                             atlas.sqlite  上の表と同じ中身の SQLite
//                             metrics.json  集計(atlas metrics と同じ形)
//                             README.md     何をいつ書き出したか・列の読み方
//                             records/      セッション記録(.md。out/sessions/ にあるものだけ写す)
// いつものレポート(atlas.html・metrics.json)は書き換えない。atlas group export と、atlas serve の画面の「書き出す」が使う。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeMetrics, removeTree, VCS_RETENTION_FILE, type SessionRecord, type SessionsFile } from '../../core/src/index.ts';
import { loadGroups, safeDirName, transcriptFileName } from '../../report/src/index.ts';
import { buildTables, SQLITE_FILE, writeSqlite } from './tables.ts';

export interface GroupExportPaths {
  out: string;
  sessions: string;
  judgments: string;
  groups: string;
  /** 段階 2 の依頼ごとの判定(turn-judgments.json)。省略時は out/ の直下 */
  turnJudgments?: string;
}

export interface GroupExportResult {
  name: string;
  dir: string;
  sessions: number;
  turns: number;
  records: number;
  /** グループの id のうち、集計に無かったもの */
  missing: number;
}

/** フォルダ名に使えない文字を _ にする(画面と共通なので report の lib/groups.ts に置いてある) */
export { safeDirName };

export async function exportGroup(p: GroupExportPaths, name: string, log: (m: string) => void = () => {}): Promise<GroupExportResult> {
  const loaded = await loadGroups(p.groups);
  const g = loaded.groups.find((x) => x.name === name);
  if (!g) throw new Error(`グループ「${name}」はありません${loaded.groups.length ? `(あるのは: ${loaded.groups.map((x) => x.name).join(', ')})` : ''}`);
  if (!existsSync(p.sessions)) throw new Error(`${p.sessions} がありません。先に集計してください(atlas.bat か atlas all)`);
  const file = JSON.parse(await readFile(p.sessions, 'utf8')) as SessionsFile;
  const ids = new Set(g.ids);
  const sessions: SessionRecord[] = file.sessions.filter((s) => ids.has(s.id));
  // 別のグループと同じフォルダ名になるとき(「a/b」と「a_b」、大文字小文字だけ違う名前)は、名前の短いハッシュを足して分ける
  const safe = safeDirName(name);
  const clash = loaded.groups.some((x) => x.name !== name && safeDirName(x.name).toLowerCase() === safe.toLowerCase());
  const dir = join(p.out, 'groups', clash ? `${safe}-${createHash('sha1').update(name).digest('hex').slice(0, 6)}` : safe);
  // 前回の書き出しを消してから書く(グループから外したセッションの記録を残さない)
  await removeTree(dir);
  await mkdir(join(dir, 'records'), { recursive: true });
  // 判定のファイルが壊れていても、判定の列を付けずに書き出す(集計の表と同じ扱い)
  const t = await buildTables(sessions, { judgments: p.judgments, turnJudgments: p.turnJudgments ?? join(p.out, 'turn-judgments.json'), vcsRetention: join(p.out, VCS_RETENTION_FILE) });
  for (const w of t.warnings) log(`group export: 注意 ${w}`);
  await writeFile(join(dir, 'turns.csv'), t.turns);
  await writeFile(join(dir, 'sessions.csv'), t.sessions);
  if (t.vcsHunks != null) await writeFile(join(dir, 'vcs-hunks.csv'), t.vcsHunks);
  try {
    await writeSqlite(join(dir, SQLITE_FILE), t.data);
  } catch (e) {
    log(`group export: 注意 ${SQLITE_FILE} を書けませんでした(${(e as Error).message})`);
  }
  const m = computeMetrics(sessions, { installed: file.installed });
  await writeFile(join(dir, 'metrics.json'), `${JSON.stringify(m, null, 2)}\n`);
  let records = 0;
  for (const s of sessions) {
    const md = join(p.out, 'sessions', transcriptFileName(s.id));
    if (!existsSync(md)) continue;
    await copyFile(md, join(dir, 'records', transcriptFileName(s.id)));
    records++;
  }
  const turnCount = m.turns?.turns ?? 0;
  const generatedAt = new Date().toISOString();
  await writeFile(
    join(dir, 'README.md'),
    [
      `# グループ「${name}」の書き出し`,
      '',
      `- 書き出した日時: ${generatedAt}`,
      `- セッション: ${sessions.length} 件(グループの ${g.ids.length} 件のうち集計にあったもの${g.ids.length - sessions.length ? `。無かった ${g.ids.length - sessions.length} 件は入っていません` : ''})`,
      `- 依頼(ターン): ${turnCount} 件`,
      `- セッション記録: ${records} 件(records/。atlas.bat か export で作った記録があるものだけ)`,
      g.note ? `- グループの説明: ${g.note}` : '',
      '',
      '## ファイル',
      '',
      '| ファイル | 中身 |',
      '|---|---|',
      '| turns.csv | 依頼ごとの表。工程・依頼の種類・詰まり(ツールの失敗・拒否・中断・エラー・再編集・文脈圧縮)・使用量。依頼ごとの LLM 判定があれば「判定:」の列(扱い・合わなかった点・普段の工程・確信度・理由) |',
      '| sessions.csv | セッションごとの表。規模・使用量・摩擦・推定人手工数(判定済みのものだけ)。VCS の照合をしてあれば、AI の変更が作業後の差分に残っているかの列 |',
      ...(t.vcsHunks != null ? ['| vcs-hunks.csv | AI の変更のまとまりごとの、VCS の照合の結果(未変更で残存・変更後に残存・終了時の差分で未確認・帰属・照合不能)。未確認と照合不能は不採用の意味ではありません |'] : []),
      `| ${SQLITE_FILE} | 上の表と同じ中身の SQLite(表 turns・sessions${t.vcsHunks != null ? '・vcs_hunks' : ''}。列名は CSV の見出し) |`,
      '| metrics.json | 集計(atlas metrics と同じ形。turns に工程別・依頼の種類別の集計) |',
      '| records/ | セッション記録(Markdown) |',
      '',
      'CSV は UTF-8(BOM 付き)なので、Excel でそのまま開けます。工程はその依頼で使ったツール、依頼の種類は依頼文の語からの推定です(LLM は使っていません)。',
      '依頼文や記録には、パス・リポジトリ名・依頼の本文がそのまま入ります。共有する前に中身を確かめてください。',
      '',
    ]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n'),
  );
  log(`group export: 「${name}」 ${sessions.length} セッション・${turnCount} 依頼・記録 ${records} 件 → ${dir}`);
  return { name, dir, sessions: sessions.length, turns: turnCount, records, missing: g.ids.length - sessions.length };
}
