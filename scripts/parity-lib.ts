// report の lib(packages/report/src/lib/*.ts)の TS 版と Rust 版(crates/atlas-report)を、同じ入力で動かして結果を突き合わせる
// (Rust 移行の段 4-1 の確認用。docs/rust-migration.md)。build の移植の前に、lib を直接比べるためのもの。
//
//   node scripts/parity-lib.ts <out> <dump> [--notes <dir>]            TS 版の結果を <dump> に書く
//   node scripts/parity-lib.ts <out> --compare [--notes <dir>] [--work <dir>] [--rs <exe>] [--max-diffs <n>]
//
// - <out> は atlas の出力先(sessions.json。あれば judgments.json・turn-judgments.json・vcs-retention.json も読む)。
//   --notes はメモと名前付きグループの置き場(groups.json を読む)。既定は <out> と同じ階層の atlas-notes。
// - 結果は lib の入口ごとに 1 つの JSON(summaries.json・aggregate-<条件>.json・insights-*.json・format.json など)。
//   build.ts と同じ呼び方(全セッションの要約、絞り込みの条件ごとの集計、改善点の候補)で呼ぶ。
// - --compare は TS 版を <work>/ts に、Rust 版(crates/atlas-report/examples/libdump.rs。既定は atlas-cli と一緒に cargo build --release で作って動かす。buildLibdump)を
//   <work>/rs に書き、ファイルごとに比べる(parity-common.ts の cmpJson。数値は相対 1e-9 まで同じとみなし、キーの順も見る)。
//   重い入口(要約・集計・候補)の所要時間を両方について出す。<work> の既定は out/parity-lib-dump。
// - 実データの結果には依頼文がそのまま入る。比べ終わったら <work> を消すこと(コミットしない)。
// - TS のサーバー側を消した後も、画面が使う TS の lib と、build が使う Rust の lib がずれていないかを見るために残す(npm run parity:lib)。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { SessionsFile } from '../packages/report/src/shared/types.ts';
import { aggregate, coverageBreakdown, monthRange, unusedSkills } from '../packages/report/src/lib/aggregate.ts';
import { embedData, extractEmbedded, serializeForScript } from '../packages/report/src/lib/embed.ts';
import { execAggregate, quantilesOf } from '../packages/report/src/lib/exec.ts';
import { effortLabel, errorTypeLabel, initiatorLabel, modeLabel, subagentFailureLabel, todoStatusLabel } from '../packages/report/src/lib/exec-labels.ts';
import { applyFilter, currentGroupName, decodeFilter, decodeView, effectiveIds, emptyFilter, encodeFilter, filterHref, filterOptions, groupIds, hasPeople, isStateHash, NO_JUDGMENT, UNKNOWN, type FilterState } from '../packages/report/src/lib/filter.ts';
import { compact, date, dateTime, dec, duration, int, modelLabel, month, msLabel, pathParts, percent, sharedLeads, splitLead, truncate } from '../packages/report/src/lib/format.ts';
import { GLOSSARY, GLOSSARY_GROUPS, termsByGroup } from '../packages/report/src/lib/glossary.ts';
import { memberGroups, parseGroups, safeDirName, serializeGroups } from '../packages/report/src/lib/groups.ts';
import { highlights } from '../packages/report/src/lib/highlights.ts';
import {
  cleanHeading,
  instructionFindings,
  instructionVersions,
  normalizeRequest,
  requestCandidates,
  seriesKey,
  skillCandidates,
  skillStats,
  stuckByProject,
  stuckSessions,
  toolSequenceCandidates,
  trigrams,
  jaccard,
  type VersionMeta,
} from '../packages/report/src/lib/insights.ts';
import { parseJudgments } from '../packages/report/src/lib/judgments.ts';
import { backendLabel, categoryLabel, confidenceLabel, effectLabel } from '../packages/report/src/lib/judgment-labels.ts';
import { isSafeFileName, isSafeMemoId, memoExcerpt, memoSummary } from '../packages/report/src/lib/memo.ts';
import { packSummary } from '../packages/report/src/lib/pack.ts';
import { shortProjectLabel } from '../packages/report/src/lib/project-label.ts';
import { aggregateRetention, retentionByPhase, retentionItem, UNKNOWN_PHASE, type TurnStart } from '../packages/report/src/lib/retention.ts';
import { detailFileName, summarize, testsSummary } from '../packages/report/src/lib/summarize.ts';
import { compareNames, conditionTable, parseConditionTag, type ConditionGroup, type ConditionSession } from '../packages/report/src/lib/conditions.ts';
import { turnAggregate } from '../packages/report/src/lib/turns.ts';
import { parseVerdicts, verdictAggregate, verdictTuples } from '../packages/report/src/lib/verdicts.ts';
import { REPORT_DATA_VERSION } from '../packages/report/src/lib/types.ts';
import { mainEffortOf } from '../packages/report/src/lib/main-effort.ts';
import { PHASES, sessionTurns } from '../packages/report/src/shared/turns.ts';
import type { SessionRecord, SessionTests } from '../packages/report/src/shared/types.ts';
import { cmpJson, firstTextDiff } from './parity-common.ts';

/** vcs-retention.json(atlas vcs の出力)。突き合わせに使う項目だけ */
interface VcsRetentionFile {
  schemaVersion: 1;
  generatedAt: string;
  computedOn: string;
  mode: string;
  similarity: unknown;
  pathMap: unknown;
  senders?: unknown;
  labels?: unknown;
  lagDays?: number;
  note?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any[];
}

/** vcs-retention.json を読む。無い・形が違えば null(Rust 版の vcs_step::read_vcs_retention と同じ) */
function readVcsRetention(path: string): VcsRetentionFile | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as VcsRetentionFile;
    return j && j.schemaVersion === 1 && Array.isArray(j.sessions) ? j : null;
  } catch {
    return null;
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    notes: { type: 'string' },
    compare: { type: 'boolean', default: false },
    work: { type: 'string' },
    rs: { type: 'string' },
    'max-diffs': { type: 'string', default: '30' },
  },
});

const inDir = resolve(positionals[0] ?? join(ROOT, 'out'));
const notesDir = resolve(values.notes ?? join(dirname(inDir), 'atlas-notes'));

/** 入口ごとの所要時間(ms) */
const timings: Record<string, number> = {};
function timed<T>(name: string, f: () => T): T {
  const t = performance.now();
  const r = f();
  timings[name] = (timings[name] ?? 0) + (performance.now() - t);
  return r;
}

/** build.ts の turnStarts と同じ */
function turnStarts(r: SessionRecord): TurnStart[] {
  const rows = sessionTurns(r);
  const out: TurnStart[] = rows.map((t) => ({ startedAt: t.startedAt, phase: PHASES.indexOf(t.phase) }));
  const last = rows[rows.length - 1];
  if (last && r.turns > rows.length) {
    const end = last.startedAt && last.ms != null ? new Date(Date.parse(last.startedAt) + last.ms).toISOString() : last.startedAt;
    out.push({ startedAt: end, phase: UNKNOWN_PHASE });
  }
  return out;
}

/** 数の表示の確かめに使う値(Rust 側と同じ並び) */
const NUMBERS = [0, -0, 0.5, 1.005, 0.125, 2.5, -2.5, 1.45, 0.015, 8.345, 1234567.891, 1e21, 2 ** 70, 999.995, 1e-7, 12345, 99999, 1e8 + 5, -123456789, 59_499, 59_500, 3_599_000, 172_800_000, 86_399_999, 850, 1234, 125_000, 7_200_000, Infinity, -Infinity, NaN];
const MEMO_TEXTS = ['\n\n# 見出し\n本文', '- [ ] **やること** と [リンク](x)', '```\ncode\n```\n\nあと', '![図](a/b.png)', '   \n\n', 'session_id の調査、2*3、~/.copilot', '---\ntitle: x\n---\n\n本文', '---\n\n本文', '> 引用 `code` ~~消し~~ __強調__', '1. 番号付き\n2. 次', '***\n\n___\n本文\r\n次', `${'あ'.repeat(100)}\n![a](x/1.png) ![b](x/2.png)`];
/** テストの結果の要約を確かめる形(実行なし / 未達 / 1 回目で通る / 通った後に不合格で AI 使用量の記録なし / 番号が実行の数を外れている / 番号が 0 / 番号が負)。crates/atlas-report/examples/libdump.rs の TESTS_CASES と同じ中身 */
const TESTS_CASES = `[
  { "runs": [], "invalid": 1, "duplicates": 0, "dropped": 0, "firstPass": null },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": 1500000000, "failing": 1, "results": [] }, { "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 2000, "nanoAiu": 2500000000, "failing": 1, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": null },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1500, "nanoAiu": 2500000000, "failing": 0, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": 1 },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": null, "failing": 1, "results": [] }, { "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 60000.5, "nanoAiu": null, "failing": 0, "results": [] }, { "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 90000, "nanoAiu": null, "failing": 2, "results": [] }], "invalid": 0, "duplicates": 2, "dropped": 0, "firstPass": 2 },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": 1, "failing": 0, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": 5 },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": 1, "failing": 0, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": 0 },
  { "runs": [{ "at": null, "turn": 1, "tool": "powershell", "toolCallId": null, "activeMs": 1000, "nanoAiu": 1, "failing": 0, "results": [] }], "invalid": 0, "duplicates": 0, "dropped": 0, "firstPass": -1 }
]`;
/** 課題 × 条件の表を確かめる形(セッション・タスクタグ・名前の読み取り・並び)。crates/atlas-report/examples/libdump.rs の CONDITION_CASES と同じ中身 */
const CONDITION_CASES = `{"sessions":[{"id":"s01","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":1,"firstPass":1,"lastFailing":0,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s02","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":null},{"id":"s03","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":3,"lastFailing":0,"passActiveMs":180001.5,"passNanoAiu":4500000000.0,"lastNanoAiu":6000000000.0},"person":null},{"id":"s04","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":1,"lastFailing":1,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s05","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":null,"lastFailing":2,"passActiveMs":null,"passNanoAiu":null,"lastNanoAiu":7000000000.0},"person":null},{"id":"s06","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":null,"lastFailing":2,"passActiveMs":null,"passNanoAiu":null,"lastNanoAiu":null},"person":null},{"id":"s07","activeMs":null,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":null},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":null},{"id":"s08","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":4,"firstPass":4,"lastFailing":0,"passActiveMs":240002.0,"passNanoAiu":null,"lastNanoAiu":null},"person":null},{"id":"s09","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"person":null},{"id":"s10","activeMs":600000,"tools":{"total":0},"friction":{"toolFailures":0},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":1,"firstPass":1,"lastFailing":0,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s11","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":"zz-a"},{"id":"s12","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":3,"lastFailing":0,"passActiveMs":180001.5,"passNanoAiu":4500000000.0,"lastNanoAiu":6000000000.0},"person":"zz-b"},{"id":"s13","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":null,"lastFailing":2,"passActiveMs":null,"passNanoAiu":null,"lastNanoAiu":7000000000.0},"person":"zz-b"},{"id":"s14","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":1,"firstPass":1,"lastFailing":0,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s15","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":1,"firstPass":1,"lastFailing":0,"passActiveMs":60000.5,"passNanoAiu":1500000000.0,"lastNanoAiu":2000000000.0},"person":null},{"id":"s16","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":3,"firstPass":null,"lastFailing":2,"passActiveMs":null,"passNanoAiu":null,"lastNanoAiu":7000000000.0},"person":null},{"id":"s17","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":null},{"id":"s18","activeMs":600000,"tools":{"total":10},"friction":{"toolFailures":1},"tokens":{"nanoAiu":4000000000.0},"tests":{"runs":2,"firstPass":2,"lastFailing":0,"passActiveMs":120001.0,"passNanoAiu":3000000000.0,"lastNanoAiu":4000000000.0},"person":null}],"groups":[{"name":"t10__wiki__1","presentIds":["s01","s02","s03"]},{"name":"t10__wiki__2","presentIds":["s03","s04","s05","s06"]},{"name":"t2__wiki","presentIds":["s07","s08","s09"]},{"name":"t2__0-plain","presentIds":["s10","s14","s15","s16","s17"]},{"name":"zz-a / t2__coderef__1","tag":"t2__coderef__1","presentIds":["s11"]},{"name":"zz-b / t2__coderef__1","tag":"t2__coderef__1","presentIds":["s12","s13"]},{"name":"描画__wiki","presentIds":["s18"]},{"name":"描画__0-plain","presentIds":["s18"]},{"name":"zz-misc","presentIds":["s09"]},{"name":"x__y__v2","presentIds":["s09"]},{"name":"gone__wiki","presentIds":["not-in-records"]}],"names":["render__wiki","render__wiki__1"," 描画 __ wiki あり __ 007 ","Player-Weapon__code_ref__12","render","render__","__wiki","render____1","a__b__c__1","render__wiki__v2","render__wiki__１","a___b","a__b_",""],"order":["c10","c2","B","a","c1","0-plain","wiki","Wiki","描画","あ","ア","t10","t2","x_1","x-1","c01","c001","c1","c１０","v1.10","v1.9","v1.9a","Z","z"]}`;
const FILE_NAMES = ['メモ.md', 'a b.txt', 'x', '', '.x', '..', 'a/b', 'x.', 'x ', 'CON', 'nul.log', 'Com1', 'a:b', 'abc-1_2.x', 'あ'];

async function dumpTs(outDir: string): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const write = (name: string, v: unknown): void => writeFileSync(join(outDir, `${name}.json`), JSON.stringify(v));

  const file = JSON.parse(readFileSync(join(inDir, 'sessions.json'), 'utf8')) as SessionsFile;
  const records = file.sessions;
  const jPath = join(inDir, 'judgments.json');
  const judgments = existsSync(jPath) ? parseJudgments(JSON.parse(readFileSync(jPath, 'utf8'))) : null;
  const vPath = join(inDir, 'turn-judgments.json');
  const verdicts = existsSync(vPath) ? parseVerdicts(JSON.parse(readFileSync(vPath, 'utf8'))) : null;
  const gPath = join(notesDir, 'groups.json');
  const groups = existsSync(gPath) ? parseGroups(JSON.parse(readFileSync(gPath, 'utf8')), 'groups.json') : { groups: [], warnings: [] };
  const rx = readVcsRetention(join(inDir, 'vcs-retention.json'));
  dumpWith(outDir, write, file, records, judgments, verdicts, groups, rx);
}

function dumpWith(
  outDir: string,
  write: (name: string, v: unknown) => void,
  file: SessionsFile,
  records: SessionRecord[],
  judgments: ReturnType<typeof parseJudgments> | null,
  verdicts: ReturnType<typeof parseVerdicts>,
  groups: ReturnType<typeof parseGroups>,
  rx: VcsRetentionFile | null,
): void {
  const installed = file.installed ? { skills: [...new Set([...file.installed.skills, ...file.installed.plugins.flatMap((p) => p.skills)])].sort(), disabled: [...(file.installed.disabledSkills ?? [])].sort() } : null;
  write('judgments', judgments ? { backend: judgments.backend, model: judgments.model, ranAt: judgments.ranAt, bySession: Object.fromEntries(judgments.bySession) } : null);

  // 要約(build.ts と同じ: summarize に判定・依頼ごとの判定・照合の結果を足す)
  const retentionById = new Map((rx?.sessions ?? []).map((r) => [r.sessionId, r]));
  const plain = timed('summarize', () =>
    records.map((r) => {
      const base = summarize(r, judgments?.bySession.get(r.id) ?? null);
      const vt = verdicts ? verdictTuples(verdicts.bySession.get(r.id), verdicts.phases) : [];
      const rt = retentionById.get(r.id);
      return { ...base, ...(vt.length ? { turnVerdicts: vt } : {}), ...(rt ? { retention: retentionItem(rt, turnStarts(r)) } : {}) };
    }),
  );
  write('summaries', plain);
  write('packed', timed('pack', () => plain.map(packSummary)));
  const tpl = '<!doctype html><script type="application/json" id="atlas-data">__ATLAS_DATA__</script>';
  const html = timed('embed', () => embedData(tpl, { version: REPORT_DATA_VERSION, sessions: plain.map(packSummary) }));
  write('embed', { html, extracted: extractEmbedded(html), script: serializeForScript({ t: '</script><!-- https://x fetch(1)   & >' }) });
  write('retention', {
    meta: rx ? { generatedAt: rx.generatedAt, computedOn: rx.computedOn, mode: rx.mode, similarity: rx.similarity, pathMap: rx.pathMap, sessions: rx.sessions.length, senders: rx.senders ?? null, ...(rx.labels ? { labels: rx.labels } : {}), ...(rx.lagDays ? { lagDays: rx.lagDays } : {}), ...(rx.note ? { note: rx.note } : {}) } : null,
    starts: records.filter((r) => retentionById.has(r.id)).map((r) => turnStarts(r)),
  });

  // 絞り込みの条件ごとの集計と要点欄
  const people = hasPeople(plain);
  const opts = filterOptions(plain);
  write('filter-options', opts);
  const dates = plain.map((s) => s.createdAt).filter((x): x is string => !!x).sort();
  const all = aggregate(plain);
  const mcpTool = all.usage.tools.find((t) => t.mcpServer);
  const g0 = groups.groups[0];
  const filters: Record<string, FilterState> = {
    all: emptyFilter(),
    withEmpty: { ...emptyFilter(), empty: '1' },
    project: { ...emptyFilter(), project: opts.project[0]?.value ?? '' },
    model: { ...emptyFilter(), model: opts.model[0]?.value ?? '' },
    unknownModel: { ...emptyFilter(), model: UNKNOWN },
    range: { ...emptyFilter(), from: (dates[Math.floor(dates.length / 4)] ?? '').slice(0, 10), to: (dates[Math.floor((dates.length * 3) / 4)] ?? '').slice(0, 10) },
    tool: { ...emptyFilter(), tool: all.usage.tools[0]?.key ?? '' },
    mcp: { ...emptyFilter(), tool: mcpTool?.key ?? 'mcp:none' },
    input: { ...emptyFilter(), coverage: 'input' },
    outputOnly: { ...emptyFilter(), coverage: 'output-only' },
    person: { ...emptyFilter(), person: UNKNOWN },
    unjudged: { ...emptyFilter(), taskCategory: NO_JUDGMENT },
    ids: { ...emptyFilter(), ids: [...plain.slice(0, 5).map((s) => s.id), 'zzz'].join(',') },
    group: { ...emptyFilter(), group: g0?.name ?? '', ids: g0 ? effectiveIds({ ids: '', group: g0.name }, groups.groups, new Set(plain.map((s) => s.id))).ids : '' },
  };
  const phases = verdicts?.phases ?? [];
  for (const [name, f] of Object.entries(filters)) {
    const xs = applyFilter(plain, f);
    const agg = timed('aggregate', () => aggregate(xs, people));
    write(`aggregate-${name}`, agg);
    write(`highlights-${name}`, timed('highlights', () => highlights(xs, agg.usage, { filter: f, installed })));
    write(`turns-${name}`, { turns: turnAggregate(xs), verdicts: verdictAggregate(xs, phases), retention: aggregateRetention(xs), byPhase: [...retentionByPhase(xs).byPhase], withoutPhases: retentionByPhase(xs).withoutPhases, coverage: coverageBreakdown(xs) });
    write(`filter-${name}`, { encoded: encodeFilter(f), href: filterHref(f, 'unused-skills'), decoded: decodeFilter(encodeFilter(f)), view: decodeView(filterHref(f, 'unused-skills')), state: isStateHash(filterHref(f)), ids: xs.map((s) => s.id) });
  }
  write('exec', execAggregate(plain));
  write('misc', {
    monthRange: monthRange('2025-11', '2026-02'),
    unused: installed ? unusedSkills(installed.skills, all.usage.skills.map((s) => s.name)) : null,
    quantiles: quantilesOf(plain.map((s) => s.activeMs ?? 0)),
  });

  // 改善点(build.ts と同じ)
  const insightMeta: Record<string, VersionMeta> = {};
  {
    const byHeading = new Map<string, { hash: string; heading: string; file: string; firstAt: string | null; lastAt: string | null }[]>();
    for (const r of records)
      for (const i of r.instructions) {
        const key = seriesKey(i.heading, i.file);
        const list = byHeading.get(key) ?? byHeading.set(key, []).get(key)!;
        const cur = list.find((x) => x.hash === i.contentHash);
        if (cur) {
          cur.firstAt = cur.firstAt && i.firstSeenAt ? (cur.firstAt < i.firstSeenAt ? cur.firstAt : i.firstSeenAt) : (cur.firstAt ?? i.firstSeenAt);
          cur.lastAt = cur.lastAt && i.firstSeenAt ? (cur.lastAt > i.firstSeenAt ? cur.lastAt : i.firstSeenAt) : (cur.lastAt ?? i.firstSeenAt);
        } else list.push({ hash: i.contentHash, heading: i.heading, file: i.file, firstAt: i.firstSeenAt, lastAt: i.firstSeenAt });
      }
    let n = 0;
    for (const list of byHeading.values()) {
      const series = `s${n++}`;
      list.sort((a, b) => (a.firstAt ?? '').localeCompare(b.firstAt ?? '') || a.hash.localeCompare(b.hash));
      list.forEach((v, order) => (insightMeta[v.hash] = { heading: v.heading, file: v.file, series, order, firstAt: v.firstAt, lastAt: v.lastAt }));
    }
  }
  write('insights-meta', insightMeta);
  const versions = instructionVersions(plain);
  write('insights-versions', versions);
  write('insights-findings', instructionFindings(versions, insightMeta, plain.length));
  write('insights-skills', skillStats(plain, installed?.skills ?? null));
  const stuck = stuckSessions(plain);
  write('insights-stuck', stuck);
  write('insights-stuck-projects', stuckByProject(stuck, plain));
  const sources = records.map((r) => ({ id: r.id, project: r.project, analysis: r.analysis ?? { requests: [], turnTools: [], turnActiveMs: [] } }));
  const cands = timed('skillCandidates', () => skillCandidates(sources));
  write('insights-candidates', cands);
  write('insights-candidates-embedded', cands.slice(0, 30).map((c) => ({ ...c, representative: c.representative?.slice(0, 300) ?? null, examples: c.examples.slice(0, 3).map((e) => e.slice(0, 300)) })));
  write('insights-requests', timed('requestCandidates', () => requestCandidates(sources)));
  write('insights-tools', timed('toolSequenceCandidates', () => toolSequenceCandidates(sources)));
  const reqs = records.flatMap((r) => r.analysis?.requests ?? []);
  write(
    'insights-normalize',
    reqs.map((t, i) => {
      const n = normalizeRequest(t);
      return [n, trigrams(n).size, i > 0 ? jaccard(trigrams(n), trigrams(normalizeRequest(reqs[i - 1]))) : null];
    }),
  );
  write('insights-headings', records.flatMap((r) => r.instructions.map((i) => [cleanHeading(i.heading), cleanHeading(i.heading, 20), seriesKey(i.heading, i.file)])));

  // 表示の書式
  const nums = [...NUMBERS, ...plain.flatMap((s) => [s.tokens.output, s.activeMs ?? 0, s.durationMs ?? 0, (s.tokens.nanoAiu ?? 0) / 1e9])];
  write('format-numbers', nums.map((n) => [int(n), dec(n), compact(n), duration(n), msLabel(n)]));
  write('format-percent', nums.slice(0, 40).map((n) => [percent(n, 7), percent(1, n), percent(n, 1000)]));
  write('format-dates', plain.flatMap((s) => [s.createdAt, s.updatedAt]).concat(['', 'x', '2026-11-01T00:00:00+09:00', null]).map((d) => [dateTime(d), date(d)]));
  write('format-months', [...all.byMonth.map((b) => b.key), '2026-1', 'x'].map(month));
  const titles = plain.map((s) => s.name || s.firstUserMessage || '');
  const leads = sharedLeads(titles);
  write('format-leads', { leads, split: titles.map((t, i) => splitLead(t, leads[i].cut, 70)) });
  write(
    'format-text',
    records.map((r) => [truncate(r.firstUserMessage, 48), r.cwd ? pathParts(r.cwd) : null, detailFileName(r.id), r.models.map(modelLabel), shortProjectLabel(r.project)]),
  );

  // 表示名・メモ・グループ・用語
  const keys = (m: Record<string, unknown>): string[] => Object.keys(m);
  const all2 = execAggregate(plain);
  // 本体の (モデル, 推論強度)。画面は要約から、Rust(sessions.csv)は sessions.json の記録から決める
  write(
    'main-effort',
    plain.map((s) => {
      const m = mainEffortOf(s.exec.mainModelEfforts);
      return [s.id, m.kind, m.kind === 'decided' ? m.model : '', m.kind === 'decided' ? m.effort : ''];
    }),
  );
  // テストの結果の要約(架空の fixture には印つきの行が無いので、決まった形を両側で同じに読む。Rust は examples/libdump.rs の TESTS_CASES)
  write('tests-summary', (JSON.parse(TESTS_CASES) as SessionTests[]).map(testsSummary));
  // 課題 × 条件の表(画面は TS、表(conditions.csv)は Rust で計算する。行・まとめた行・数え方を突き合わせる。lookalikes は画面だけ)
  {
    const c = JSON.parse(CONDITION_CASES) as { sessions: ConditionSession[]; groups: ConditionGroup[]; names: string[]; order: string[] };
    const t = conditionTable(c.sessions, c.groups);
    write('conditions', {
      names: c.names.map(parseConditionTag),
      order: [...c.order].sort(compareNames),
      table: {
        tasks: t.tasks,
        conditions: t.conditions,
        rows: t.rows,
        pooled: t.pooled,
        matchedTags: t.matchedTags,
        counted: t.counted,
        members: t.members.map((m) => [m.session.id, m.task, m.condition]),
        unmatched: t.unmatched,
        ambiguous: t.ambiguous,
        people: t.people,
        sharedRows: t.sharedRows,
        unevenTasks: t.unevenTasks,
        hasTests: t.hasTests,
      },
    });
  }
  write('labels', {
    modes: [...all2.modes.rows.map((r) => r.key), '(unknown)', 'x'].map(modeLabel),
    initiators: [...all2.initiators.rows.map((r) => r.key), '(unknown)', 'x'].map(initiatorLabel),
    efforts: [...all2.efforts.map((r) => r.key), '(unknown)'].map(effortLabel),
    subagent: [...all2.friction.subagentFailures.map((r) => r.name), 'quota', 'unknown', 'x'].map(subagentFailureLabel),
    errors: [...all2.friction.errorTypes.map((r) => r.name), '(unknown)'].map(errorTypeLabel),
    todos: [...keys(all2.todos.byStatus), 'pending', 'x'].map(todoStatusLabel),
    categories: [null, '', 'feature', 'docs', 'x', ...plain.map((s) => s.judgment?.taskCategory ?? null)].map(categoryLabel),
    effects: [null, -2, -1, 0, 1, 2, 3, 0.5].map(effectLabel),
    confidence: [null, 0, 0.555, 0.6, 1].map(confidenceLabel),
    backends: [null, '', 'external', 'copilot-cli', 'x'].map(backendLabel),
  });
  write('memo', {
    texts: [...MEMO_TEXTS, ...records.slice(0, 200).map((r) => r.firstUserMessage ?? '')].map((t) => [memoExcerpt(t), memoSummary(t, '2026-11-03T00:00:00.000Z')]),
    names: FILE_NAMES.map((n) => [isSafeFileName(n), isSafeMemoId(n)]),
  });
  const known = new Set(plain.map((s) => s.id));
  write('groups', {
    parsed: groups,
    serialized: serializeGroups(groups.groups),
    member: memberGroups(records),
    dirs: [...groups.groups.map((g) => g.name), 'a/b:c', 'nul.log', 'x. . ', '...'].map(safeDirName),
    effective: groups.groups.map((g) => [effectiveIds({ ids: '', group: g.name }, groups.groups, known), currentGroupName({ ids: groupIds(g, known), group: '' }, groups.groups, known), groupIds(g, known)]),
  });
  write('glossary', { groups: GLOSSARY_GROUPS, terms: GLOSSARY, counts: GLOSSARY_GROUPS.map((g) => termsByGroup(g.id).length) });
  writeFileSync(join(outDir, 'timings.txt'), JSON.stringify(timings));
}

function compareDirs(ts: string, rs: string, maxDiffs: number): string[] {
  const diffs: string[] = [];
  const names = readdirSync(ts).filter((n) => n.endsWith('.json'));
  for (const n of readdirSync(rs)) if (n.endsWith('.json') && !names.includes(n)) diffs.push(`${n}: Rust 側にだけある`);
  for (const n of names) {
    const q = join(rs, n);
    if (!existsSync(q)) {
      diffs.push(`${n}: Rust 側にない`);
      continue;
    }
    const a = readFileSync(join(ts, n), 'utf8');
    const b = readFileSync(q, 'utf8');
    if (a === b) continue;
    const d: string[] = [];
    try {
      cmpJson(JSON.parse(a), JSON.parse(b), '$', d, { maxDiffs });
    } catch (e) {
      d.push(`JSON として読めない: ${(e as Error).message}`);
    }
    if (!d.length && a !== b) d.push(`値は同じだが書き方が違う ${firstTextDiff(a, b)}`);
    if (d.length) diffs.push(`${n}:\n    ${d.join('\n    ')}`);
  }
  return diffs;
}

/**
 * Rust 版(examples/libdump)を release で作り、実行ファイルのパスを返す。
 * atlas-cli と同じ cargo build で作る(-p atlas-cli も付ける)。cargo は選んだパッケージだけから依存の features を決めるので、
 * -p atlas-report だけで作ると、atlas-cli が有効にする features(Windows は windows-sys の一部、Linux は libc の default など)が外れ、
 * atlas-core・atlas-report から release で作り直すことになる。atlas-cli と一緒に作れば features がそろい、npm run build:atlas の
 * 結果をそのまま使える(作るのは例だけ)。環境変数(ATLAS_REQUIRE_TEMPLATE など)も build:atlas と同じにしておくこと
 * (atlas-report の build.rs は ATLAS_REQUIRE_TEMPLATE が変わると作り直す)。
 */
function buildLibdump(): string {
  const r = spawnSync('cargo', ['build', '--release', '--locked', '-p', 'atlas-cli', '-p', 'atlas-report', '--example', 'libdump', '--message-format=json-render-diagnostics'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`parity-lib: libdump のビルドに失敗しました(${r.error ? `cargo を起動できません: ${r.error.message}` : `終了コード ${r.status}`})`);
    process.exit(1);
  }
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    const m = JSON.parse(line) as { reason?: string; target?: { name?: string; kind?: string[] }; executable?: string | null };
    if (m.reason === 'compiler-artifact' && m.target?.name === 'libdump' && m.target.kind?.includes('example') && m.executable) return m.executable;
  }
  console.error('parity-lib: cargo build の出力に libdump の実行ファイルがありません');
  process.exit(1);
}

if (!values.compare) {
  const dump = positionals[1];
  if (!dump) {
    console.error('使い方: node scripts/parity-lib.ts <out> <dump> [--notes <dir>] / node scripts/parity-lib.ts <out> --compare');
    process.exit(2);
  }
  await dumpTs(resolve(dump));
} else {
  const work = resolve(values.work ?? join(ROOT, 'out', 'parity-lib-dump'));
  const tsDir = join(work, 'ts');
  const rsDir = join(work, 'rs');
  // TS 版は別のプロセスで動かす(所要時間を同じ条件で測るため)
  const t0 = performance.now();
  const ts = spawnSync(process.execPath, [fileURLToPath(import.meta.url), inDir, tsDir, '--notes', notesDir], { stdio: 'inherit' });
  const tsMs = performance.now() - t0;
  if (ts.status !== 0) process.exit(1);
  rmSync(rsDir, { recursive: true, force: true });
  const exe = values.rs ?? buildLibdump();
  const t1 = performance.now();
  const rs = spawnSync(exe, [inDir, rsDir, notesDir], { stdio: 'inherit' });
  const rsMs = performance.now() - t1;
  if (rs.status !== 0) process.exit(1);
  const tt = JSON.parse(readFileSync(join(tsDir, 'timings.txt'), 'utf8')) as Record<string, number>;
  const rt = JSON.parse(readFileSync(join(rsDir, 'timings.txt'), 'utf8')) as Record<string, number>;
  console.log(`全体: TS ${(tsMs / 1000).toFixed(1)} 秒 / Rust ${(rsMs / 1000).toFixed(1)} 秒(どちらも起動と読み込みを含む。Rust のビルドは含まない)`);
  for (const k of Object.keys(tt)) console.log(`  ${k}: TS ${tt[k].toFixed(0)} ms / Rust ${(rt[k] ?? NaN).toFixed(0)} ms`);
  const diffs = compareDirs(tsDir, rsDir, Number(values['max-diffs']));
  const n = readdirSync(tsDir).filter((x) => x.endsWith('.json')).length;
  if (!diffs.length) console.log(`✓ ${n} ファイル、差なし`);
  else console.log(`✗ ${n} ファイルのうち差のあるもの ${diffs.length}\n  ${diffs.join('\n  ')}`);
  process.exit(diffs.length ? 1 : 0);
}
