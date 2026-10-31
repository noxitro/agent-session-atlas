// セッション詳細ページ(out/sessions/<id>.html)。軽量な静的 HTML(スクリプトは配色の選択を読む数行だけ)。
// atlas.html と同じ base.css を埋め込み、同じ「様式」の見た目にする。
import type { ProjectSource, SessionRecord, TimelineEntry, TokenCounts, TokenSource } from '../../core/src/types.ts';
import type { Anonymizer } from './lib/anonymize.ts';
import { frictionTotal } from './lib/aggregate.ts';
import { dateTime, dec, duration, int, modelLabel, msLabel, percent, truncate } from './lib/format.ts';
import { EFFORT_ORDER, INITIATOR_ORDER, MODE_ORDER, quantilesOf, UNKNOWN_KEY } from './lib/exec.ts';
import { effortLabel, errorTypeLabel, initiatorLabel, modeLabel, subagentFailureLabel, TODO_STATUS_ORDER, todoStatusLabel } from './lib/exec-labels.ts';
import { GLOSSARY } from './lib/glossary.ts';
import { backendLabel, categoryLabel, confidenceLabel, effectLabel } from './lib/judgment-labels.ts';
import type { JudgmentSummary } from './lib/types.ts';

/** HTML エスケープ。外部参照の静的検査(http:// / fetch( の不在)を本文中の文字列で誤検出しないよう、:// と fetch( も実体参照にする */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/:\/\//g, ':&#47;&#47;')
    .replace(/fetch\(/g, 'fetch&#40;');
}

export const SOURCE_LABEL: Record<TokenSource, string> = {
  db: 'session-store.db の明細',
  events: 'events.jsonl の usage_record',
  'db+events': 'DB の明細 + usage_record で補完',
  shutdown: 'セッション終了時の累計(shutdown)',
  partial: '出力トークンのみ(入力は推計不可)',
  none: 'トークン記録なし',
};

export const PROJECT_SOURCE_LABEL: Record<ProjectSource, string> = {
  repository: '記録の repository',
  'git-remote': 'git の origin から',
  path: '作業フォルダのパス',
  home: 'ホームディレクトリ',
  temp: '一時フォルダ',
  'atlas-judge': 'atlas の判定実行',
  unknown: '手掛かりなし',
};

const LINES_SOURCE_LABEL = { shutdown: '終了時の累計(codeChanges)', tools: 'ツールごとの行数の合計', none: '記録なし' } as const;

const KIND_LABEL: Record<TimelineEntry['kind'], string> = {
  user: '依頼',
  tools: 'ツール',
  agent: 'エージェント',
  skill: 'skill',
  compaction: '文脈圧縮',
  abort: '中断',
  error: 'エラー',
  task_complete: '完了',
};

const missing = (text = '記録なし'): string => `<span class="missing-value">${esc(text)}</span>`;

/** 種別名のような短い識別子(quota / rate_limit など)だけが入る欄(エラー種別・サブエージェント失敗の理由)。
 *  実際には自由記述のメッセージが入っていることもあるので、伏せ字モードでは識別子の形のときだけ出す */
const IDENTIFIER_RE = /^[\w.:-]{1,64}$/;
function identifierOrHidden(text: string, anon: Anonymizer): string {
  if (!anon.enabled) return esc(truncate(text, 400));
  return IDENTIFIER_RE.test(text) ? esc(text) : missing('伏せ字モードのため本文を表示しません');
}
const n = (v: number | null | undefined): string => (v == null ? missing() : esc(int(v)));
const field = (k: string, v: string, note = ''): string =>
  `<div class="field"><span class="k">${esc(k)}</span><span class="v">${v}</span>${note ? `<span class="n">${note}</span>` : ''}</div>`;

function section(title: string, body: string, lead = ''): string {
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${lead ? `<p>${lead}</p>` : ''}</div>${body}</section>`;
}

function countTable(rows: [string, number][], keyLabel: string, valueLabel: string, empty: string): string {
  if (rows.length === 0) return `<p class="note">${esc(empty)}</p>`;
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return `<div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">${esc(keyLabel)}</th><th scope="col" class="num">${esc(valueLabel)}</th><th scope="col" class="barcol"><span class="sr-only">割合</span></th></tr></thead><tbody>${rows
    .map(
      ([k, v]) =>
        `<tr><th scope="row">${esc(k)}</th><td class="num">${esc(int(v))}</td><td class="barcol"><span class="bar" style="width:${((v / max) * 100).toFixed(1)}%"></span></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

/** ツール別の回数と結果(成功・失敗・拒否)。MCP ツールはサーバー名を添える */
function toolTable(r: SessionRecord): string {
  const rows = Object.entries(r.tools.byName).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (rows.length === 0) return `<p class="note">ツール呼び出しはありません。</p>`;
  const serverOf = new Map<string, string>();
  for (const [server, byTool] of Object.entries(r.tools.mcp ?? {})) for (const tool of Object.keys(byTool)) serverOf.set(tool, server);
  const max = Math.max(...rows.map((x) => x[1]), 1);
  return `<div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">ツール</th><th scope="col" class="num">回数</th><th scope="col" class="num">成功</th><th scope="col" class="num">失敗</th><th scope="col" class="num">拒否</th><th scope="col" class="barcol"><span class="sr-only">割合</span></th></tr></thead><tbody>${rows
    .map(([k, v]) => {
      const res = r.tools.results?.[k];
      const server = serverOf.get(k);
      return `<tr><th scope="row">${esc(k)}${server ? ` <span class="tag">MCP: ${esc(server)}</span>` : ''}</th><td class="num">${esc(int(v))}</td><td class="num">${res ? esc(int(res.success)) : missing('—')}</td><td class="num">${res ? esc(int(res.failure)) : missing('—')}</td><td class="num">${res ? esc(int(res.denied)) : missing('—')}</td><td class="barcol"><span class="bar" style="width:${((v / max) * 100).toFixed(1)}%"></span></td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

function tokenRow(label: string, t: TokenCounts): string {
  return `<tr><th scope="row">${esc(label)}</th><td class="num">${n(t.input)}</td><td class="num">${n(t.output)}</td><td class="num">${n(t.cacheRead)}</td><td class="num">${n(t.reasoning)}</td><td class="num">${n(t.requests)}</td></tr>`;
}

function tokenTable(rows: [string, TokenCounts][], keyLabel: string): string {
  return `<div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">${esc(keyLabel)}</th><th scope="col" class="num">入力</th><th scope="col" class="num">出力</th><th scope="col" class="num">キャッシュ読取</th><th scope="col" class="num">推論</th><th scope="col" class="num">リクエスト</th></tr></thead><tbody>${rows
    .map(([k, t]) => tokenRow(k, t))
    .join('')}</tbody></table></div>`;
}

function timelineRow(e: TimelineEntry, anon: Anonymizer): string {
  let label: string;
  if (e.kind === 'user') {
    const t = anon.freeText(e.label);
    label = t == null ? missing('伏せ字モードのため本文を表示しません') : esc(truncate(t, 400));
  } else if (e.kind === 'tools') {
    const tools = Object.entries(e.tools ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ×${v}`)
      .join('、');
    label = `${esc(int(e.count ?? 0))} 回: ${esc(tools)}`;
  } else if (e.kind === 'task_complete' || e.kind === 'abort') {
    // 要約・中断理由は自由記述(相対パスやファイル名を含みうる)。伏せ字モードでは出さない
    const t = anon.freeText(e.label);
    label = t == null ? missing('伏せ字モードのため本文を表示しません') : esc(truncate(t, 400));
  } else if (e.kind === 'error') {
    label = identifierOrHidden(e.label, anon);
  } else {
    label = esc(anon.scrub(truncate(e.label, 400)));
  }
  return `<tr class="k-${e.kind}"><td class="num">${esc(dateTime(e.at))}</td><td><span class="kind">${esc(KIND_LABEL[e.kind] ?? e.kind)}</span></td><td>${label}</td></tr>`;
}

function judgmentSection(j: JudgmentSummary, activeMs: number | null): string {
  const ratio = j.hours != null && activeMs != null && activeMs > 0 ? j.hours / (activeMs / 3_600_000) : null;
  const fields = `<div class="fields" style="--cols:4">${[
    field('タスク分類', esc(categoryLabel(j.taskCategory))),
    field(
      '推定人手工数',
      j.hours != null ? `${esc(dec(j.hours))} 時間` : missing(),
      `${j.low != null && j.high != null ? `幅 ${esc(dec(j.low))}〜${esc(dec(j.high))} 時間、` : ''}${esc(confidenceLabel(j.confidence))}`,
    ),
    field('AI の実働時間', esc(duration(activeMs)), ratio != null ? `推定人手工数はその ${esc(dec(Math.round(ratio * 10) / 10))} 倍` : ''),
    field(
      'AI の成果',
      j.completed == null ? missing() : j.completed ? '達成' : '未達成',
      `質 ${j.quality == null ? '—' : esc(j.quality)} / 5・手戻り ${j.rework == null ? '—' : esc(j.rework)} / 5`,
    ),
    field('指示ファイルの効果', esc(effectLabel(j.effects.instructions))),
    field('llm-wiki の効果', esc(effectLabel(j.effects.wiki))),
    field('skill・agent の効果', esc(effectLabel(j.effects.skillsAgents))),
    field('判定', esc(backendLabel(j.backend))),
  ].join('')}</div>`;
  const summary = j.taskSummary ? `<h3>タスクの要約</h3><blockquote class="msg">${esc(j.taskSummary)}</blockquote>` : '';
  const rationale = j.rationale ? `<h3>工数推定の根拠</h3><blockquote class="msg">${esc(j.rationale)}</blockquote>` : '';
  return section('LLM による判定(推定)', `${fields}${summary}${rationale}`, '人が AI なしで同じ成果を出す場合の工数を LLM に推定させた値です。実測ではありません。');
}

/** 決まった並び(order)→ 残りは名前順、(unknown) は最後 */
function ordered(keys: string[], order: string[]): string[] {
  const rank = (k: string): number => (k === UNKNOWN_KEY ? order.length + 1 : order.includes(k) ? order.indexOf(k) : order.length);
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Phase 7: 実行の性質(モード・推論強度・起点・文脈・待ち時間・ツールの所要時間・摩擦の詳細・todo) */
function execSection(r: SessionRecord, anon: Anonymizer): string {
  const e = r.exec;
  if (!e) return '';
  const modes = ordered(Object.keys(e.modes.byMode), MODE_ORDER);
  const modeText = modes.map((k) => `${modeLabel(k)} ${int(e.modes.byMode[k])}`).join('・');
  const effKeys = ordered(Object.keys(e.efforts), EFFORT_ORDER);
  const effText = effKeys.map((k) => `${effortLabel(k)} ${int(e.efforts[k].requests)} 回`).join('・');
  const initKeys = ordered(Object.keys(e.initiators), INITIATOR_ORDER);
  const initTotal = initKeys.reduce((a, k) => a + e.initiators[k], 0);
  const initText = initKeys.map((k) => `${initiatorLabel(k)} ${int(e.initiators[k])}(${percent(e.initiators[k], initTotal)})`).join('・');
  const c = e.context;
  const ctxSum = c.systemTokens != null && c.conversationTokens != null && c.toolDefinitionsTokens != null ? c.systemTokens + c.conversationTokens + c.toolDefinitionsTokens : null;
  const ctxNote = [
    c.systemTokens != null ? `system ${int(c.systemTokens)}` : '',
    c.conversationTokens != null ? `会話 ${int(c.conversationTokens)}` : '',
    c.availableToolCount != null ? `使えるツール ${int(c.availableToolCount)} 個` : '',
    c.source ? `出所: ${c.source === 'shutdown' ? '終了時' : c.source === 'compaction' ? 'compaction' : 'usage_record の toolTokenCount'}` : '',
  ]
    .filter(Boolean)
    .join('・');
  const fields = `<div class="fields" style="--cols:4">${[
    field('モード別の依頼', modeText ? esc(modeText) : missing(), e.modes.inferred ? `うち ${esc(int(e.modes.inferred))} 回は記録が無く既定の interactive とみなした` : ''),
    field('推論強度', effText ? `<span class="small">${esc(effText)}</span>` : missing()),
    field('リクエストの起点', initText ? `<span class="small">${esc(initText)}</span>` : missing(), '明細のあるリクエストだけ'),
    field(
      'ツール定義のトークン',
      c.toolDefinitionsTokens == null ? missing() : esc(int(c.toolDefinitionsTokens)),
      `${ctxSum ? `文脈の ${esc(percent(c.toolDefinitionsTokens ?? 0, ctxSum))}・` : ''}${esc(ctxNote)}`,
    ),
  ].join('')}</div>`;

  const lat = Object.entries(e.latency).sort(
    (a, b) => b[1].ttft.length + b[1].duration.length - (a[1].ttft.length + a[1].duration.length) || a[0].localeCompare(b[0]),
  );
  const latTable = lat.length
    ? `<h3>モデル別の待ち時間</h3><div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">モデル</th><th scope="col" class="num">件数</th><th scope="col" class="num">最初のトークンまで(中央値)</th><th scope="col" class="num">同(p90)</th><th scope="col" class="num">全体(中央値)</th><th scope="col" class="num">全体(p90)</th></tr></thead><tbody>${lat
        .map(([m, l]) => {
          const t = quantilesOf(l.ttft);
          const d = quantilesOf(l.duration);
          return `<tr><th scope="row" title="${esc(m)}">${esc(modelLabel(m))}</th><td class="num">${esc(int(Math.max(t.n, d.n)))}</td><td class="num">${esc(msLabel(t.median))}</td><td class="num">${esc(msLabel(t.p90))}</td><td class="num">${esc(msLabel(d.median))}</td><td class="num">${esc(msLabel(d.p90))}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : '';

  const durTools = [...new Set([...Object.keys(r.tools.durations ?? {}), ...Object.keys(r.tools.durationOutliers ?? {})])]
    .map((k) => ({ k, q: quantilesOf(r.tools.durations?.[k] ?? []), out: r.tools.durationOutliers?.[k] ?? 0 }))
    .sort((a, b) => (b.q.p90 ?? -1) - (a.q.p90 ?? -1) || a.k.localeCompare(b.k));
  const outTotal = durTools.reduce((a, x) => a + x.out, 0);
  const durTable = durTools.length
    ? `<h3>ツールの所要時間</h3><div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">ツール</th><th scope="col" class="num">回数</th><th scope="col" class="num">中央値</th><th scope="col" class="num">p90</th><th scope="col" class="num">外れ値(1 時間超)</th></tr></thead><tbody>${durTools
        .map(
          (x) =>
            `<tr><th scope="row">${esc(x.k)}</th><td class="num">${esc(int(x.q.n))}</td><td class="num">${esc(msLabel(x.q.median))}</td><td class="num">${esc(msLabel(x.q.p90))}</td><td class="num">${x.out ? esc(int(x.out)) : '—'}</td></tr>`,
        )
        .join('')}</tbody></table></div>${outTotal ? `<p class="note">1 時間を超えた ${esc(int(outTotal))} 回は外れ値として中央値・p90 から除いています。</p>` : ''}`
    : '';

  const f = r.frictionDetail;
  const kv = (m: Record<string, number>, label: (k: string) => string = (k) => k): string =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => `${label(k)} ${int(n)}`)
      .join('・');
  const fd = f
    ? `<h3>摩擦の詳細</h3><div class="fields" style="--cols:4">${[
        field(
          '権限の確認の結果',
          Object.keys(f.permissions).length ? `<span class="small">${esc(kv(f.permissions))}</span>` : missing('なし'),
          `確認 ${esc(int(r.friction.permissionRequests))} 回`,
        ),
        field('エラーの種別', Object.keys(f.errorTypes).length ? `<span class="small">${esc(kv(f.errorTypes, errorTypeLabel))}</span>` : missing('なし')),
        field(
          'サブエージェント失敗の理由',
          Object.keys(f.subagentFailures).length ? `<span class="small">${esc(kv(f.subagentFailures, subagentFailureLabel))}</span>` : missing('なし'),
        ),
        field(
          'compaction 自体のトークン',
          f.compaction.recorded
            ? `<span class="small">入力 ${esc(int(f.compaction.input))}・出力 ${esc(int(f.compaction.output))}</span>`
            : missing(r.friction.compactions ? '記録なし' : 'なし'),
          f.compaction.recorded
            ? `${f.compaction.nanoAiu ? `${esc(dec(f.compaction.nanoAiu / 1e9))} AIU・` : ''}減ったトークン ${esc(int(f.compaction.tokensRemoved))}`
            : '',
        ),
      ].join('')}</div>`
    : '';

  const td = r.todos;
  const todoKeys = td
    ? [...TODO_STATUS_ORDER, ...Object.keys(td.byStatus).filter((k) => !TODO_STATUS_ORDER.includes(k)).sort()].filter((k) => td.byStatus[k])
    : [];
  const todo = td
    ? `<h3>todo</h3><p class="note">${
        td.total
          ? esc(
              `${int(td.total)} 件(完了率 ${percent(td.byStatus.done ?? 0, td.total)}): ${todoKeys.map((k) => `${todoStatusLabel(k)} ${int(td.byStatus[k])}`).join('・')}・依存関係 ${int(td.deps)} 件`,
            )
          : 'session.db はありますが todo はありません。'
      }</p>`
    : '';

  // 失敗したサブエージェントの理由(本文は短く。伏せ字モードでは種別のような識別子のときだけ出す)
  const failed = r.agents.filter((a) => a.status === 'failed' && a.error);
  const reasons = failed.length
    ? `<h3>失敗したサブエージェント</h3><ul class="note">${failed.map((a) => `<li>${esc(a.name)}: ${anon.enabled ? identifierOrHidden(a.error ?? '', anon) : esc(truncate(a.error ?? '', 160))}</li>`).join('')}</ul>`
    : '';

  return section(
    '実行の性質',
    `${fields}${latTable}${durTable}${fd}${reasons}${todo}`,
    'モード・推論強度・リクエストの起点・文脈の内訳・待ち時間・ツールの所要時間・摩擦の詳細・todo',
  );
}

export interface DetailOptions {
  anon: Anonymizer;
  css: string;
  judgment: JudgmentSummary | null;
  generatedAt: string;
}

const DETAIL_CSS = `
.top{background:var(--surface);border-bottom:1px solid var(--rule-strong)}
.top .wrap{display:flex;gap:16px;align-items:center;justify-content:space-between;padding-top:10px;padding-bottom:10px;flex-wrap:wrap}
.crumb{font-size:.8125rem}
.title{padding:20px 0 4px}
.title h1{overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:6px 8px;margin-top:8px}
section h3{margin:14px 0 6px}
.field .small{font-size:.875rem;font-weight:600;line-height:1.4}
.id{font-family:var(--mono);font-size:.75rem;color:var(--ink-3)}
.barcol{width:40%;min-width:80px}
.bar{display:block;height:10px;background:var(--s1);border-radius:0 3px 3px 0;min-width:2px}
.kind{font-size:.75rem;color:var(--form);white-space:nowrap}
tr.k-user td{background:var(--form-wash)}
tr.k-error td,tr.k-abort td{background:var(--warn-wash)}
blockquote.msg{margin:8px 0 0;padding:10px 12px;background:var(--surface);border:1px solid var(--rule);white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8125rem;max-height:24em;overflow:auto}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}
.three ul{overflow-wrap:anywhere}
@media (max-width:720px){.two,.three{grid-template-columns:1fr}}
footer{margin:40px 0 32px;color:var(--ink-3);font-size:.75rem}
`;

export function renderDetailHtml(r: SessionRecord, o: DetailOptions): string {
  const { anon } = o;
  const t = r.tokens;
  const lines = r.lines ?? { added: 0, removed: 0, source: 'none' as const };
  const name = anon.freeText(r.name);
  const title = name ? truncate(name, 120) : anon.enabled ? 'セッション(伏せ字)' : '(名前なし)';
  const project = anon.projectLabel(r.project);
  const branch = anon.branch(r.branch);

  const meta = [
    `<span class="tag" title="${esc(PROJECT_SOURCE_LABEL[r.projectSource ?? 'path'])}">プロジェクト: ${esc(project)}</span>`,
    `<span class="tag">クライアント: ${esc(r.client ?? '不明')}</span>`,
    branch ? `<span class="tag">ブランチ: ${esc(branch)}</span>` : '',
    r.copilotVersion ? `<span class="tag">Copilot ${esc(r.copilotVersion)}</span>` : '',
    `<span class="tag">出所: ${esc(r.sources.join(' + '))}</span>`,
    t.input == null ? `<span class="tag warn">入力トークン記録なし</span>` : '',
    r.empty ? `<span class="tag">空のセッション(依頼・ツール・応答なし)</span>` : '',
  ].join('');

  const overview = `<div class="fields" style="--cols:4">${[
    field('開始', esc(dateTime(r.createdAt))),
    field('所要時間', esc(duration(r.durationMs)), `実働 ${esc(duration(r.activeMs))}`),
    field(
      '依頼(ターン)',
      esc(int(r.turns)),
      `応答 ${esc(int(r.assistantMessages))} 件${r.autopilotContinuations ? `・autopilot の自動継続 ${esc(int(r.autopilotContinuations))} 回(依頼に含めない)` : ''}`,
    ),
    field('モデル', r.models.length ? `<span class="small" title="${esc(r.models.join('、'))}">${esc(r.models.map(modelLabel).join('、'))}</span>` : missing('不明')),
    field('入力トークン', t.input == null ? missing('推計不可') : esc(int(t.input)), esc(SOURCE_LABEL[t.source])),
    field('出力トークン', esc(int(t.output)), t.reasoning != null ? `うち推論 ${esc(int(t.reasoning))}` : ''),
    field('キャッシュ読取', n(t.cacheRead), t.cacheWrite != null ? `書込 ${esc(int(t.cacheWrite))}` : ''),
    field('AI 使用量(AIU)', t.nanoAiu == null ? missing() : esc(dec(t.nanoAiu / 1e9)), t.nanoAiu != null ? `nano AIU ${esc(int(t.nanoAiu))}` : ''),
    field('ツール呼び出し', esc(int(r.tools.total)), r.tools.internal?.total ? `内部ツール ${esc(int(r.tools.internal.total))} 回は除外` : ''),
    field(
      '変更行数',
      lines.source === 'none' ? missing() : `+${esc(int(lines.added))} / −${esc(int(lines.removed))}`,
      esc(lines.source === 'none' ? 'codeChanges もツールの行数も無い' : LINES_SOURCE_LABEL[lines.source]),
    ),
    field('skill / agent / hook', `${esc(int(r.skills.length))} / ${esc(int(r.agents.length))} / ${esc(int(r.hooks.total))}`),
    field('摩擦', esc(int(frictionTotal(r.friction)))),
    field(
      '推定人手工数',
      o.judgment?.hours != null ? `${esc(dec(o.judgment.hours))} 時間` : missing('未判定'),
      o.judgment?.hours != null
        ? `${o.judgment.low != null && o.judgment.high != null ? `幅 ${esc(dec(o.judgment.low))}〜${esc(dec(o.judgment.high))} 時間、` : ''}${esc(confidenceLabel(o.judgment.confidence))}、LLM による推定`
        : '判定(judge)を回すと表示されます',
    ),
  ].join('')}</div>`;

  const parts: string[] = [];
  parts.push(section('概要', overview));
  if (o.judgment) parts.push(judgmentSection(o.judgment, r.activeMs));

  const first = anon.freeText(r.firstUserMessage);
  const last = anon.freeText(r.lastAssistantMessage);
  if (first || last) {
    parts.push(
      section(
        '最初の依頼と最後の応答',
        `<div class="two"><div><h3>最初の依頼</h3>${first ? `<blockquote class="msg">${esc(first)}</blockquote>` : `<p class="note">${missing()}</p>`}</div><div><h3>最後の応答</h3>${last ? `<blockquote class="msg">${esc(last)}</blockquote>` : `<p class="note">${missing()}</p>`}</div></div>`,
      ),
    );
  }

  const models = Object.entries(t.byModel);
  const agentsTok = Object.entries(t.byAgent);
  parts.push(
    section(
      'トークン内訳',
      `${models.length ? tokenTable(models.map(([k, v]) => [modelLabel(k), v]), 'モデル') : `<p class="note">モデル別の記録はありません。</p>`}${agentsTok.length > 1 ? `<h3 style="margin-top:16px">エージェント別</h3>${tokenTable(agentsTok, 'エージェント(main は親)')}` : ''}`,
      esc(SOURCE_LABEL[t.source]),
    ),
  );

  const internal = Object.entries(r.tools.internal?.byName ?? {});
  parts.push(
    section(
      'ツール内訳',
      toolTable(r) +
        (internal.length
          ? `<p class="note">内部ツール(作業としては数えないもの): ${esc(internal.map(([k, v]) => `${k} ×${v}`).join('、'))}</p>`
          : ''),
    ),
  );

  const skills = r.skills.length
    ? `<table class="ledger"><thead><tr><th scope="col">skill</th><th scope="col">時刻</th><th scope="col">呼んだ側</th><th scope="col">記録の形</th></tr></thead><tbody>${r.skills
        .map(
          (s) =>
            `<tr><td>${esc(s.name)}</td><td class="num">${esc(dateTime(s.at))}</td><td>${esc(s.trigger === 'user' ? '利用者' : s.trigger === 'agent' ? 'エージェント' : '不明')}</td><td>${esc(s.via === 'both' ? 'ツール + イベント' : s.via === 'tool' ? 'ツール' : 'イベント')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p class="note">skill の呼び出しはありません。</p>`;
  const agents = r.agents.length
    ? `<div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">agent</th><th scope="col">状態</th><th scope="col">開始</th><th scope="col" class="num">トークン</th><th scope="col" class="num">ツール</th></tr></thead><tbody>${r.agents
        .map(
          (a) =>
            `<tr><td>${esc(a.name)}</td><td>${a.status === 'failed' ? '<span class="tag warn">失敗</span>' : a.status === 'running' ? '未完了' : '完了'}</td><td class="num">${esc(dateTime(a.startedAt))}</td><td class="num">${n(a.totalTokens)}</td><td class="num">${n(a.totalToolCalls)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : `<p class="note">サブエージェントの起動はありません。</p>`;
  const hooks = countTable(
    Object.entries(r.hooks.byType).sort((a, b) => b[1] - a[1]),
    'hook の種類',
    '実行回数',
    'hook の実行はありません。',
  );
  parts.push(execSection(r, anon));

  parts.push(section('skills / agents / hooks', `<div class="two"><div><h3>skills</h3>${skills}</div><div><h3>agents</h3>${agents}</div></div><h3 style="margin-top:16px">hooks</h3>${hooks}`));

  const inst = r.instructions.length
    ? `<div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">ファイル</th><th scope="col">範囲</th><th scope="col" class="num">文字数</th><th scope="col" class="num">注入回数</th><th scope="col">初出</th>${anon.enabled ? '' : '<th scope="col">先頭の見出し</th>'}</tr></thead><tbody>${r.instructions
        .map(
          (i) =>
            `<tr><td>${esc(i.file === 'unknown' ? '不明(特定できず)' : i.file)}</td><td>${esc(i.scope === 'repo' ? 'リポジトリ' : i.scope === 'user' ? 'ユーザー' : '不明')}</td><td class="num">${esc(int(i.chars))}</td><td class="num">${esc(int(i.injections))}</td><td class="num">${esc(dateTime(i.firstSeenAt))}</td>${anon.enabled ? '' : `<td>${esc(truncate(i.heading, 80))}</td>`}</tr>`,
        )
        .join('')}</tbody></table></div>`
    : `<p class="note">指示ファイルの注入は見つかりませんでした。</p>`;
  parts.push(section('指示ファイル', inst));

  const w = r.wiki;
  const wikiUsed = w.indexReads + w.pageReads.length + w.skillCalls.length + w.writes + w.otherCalls > 0;
  const pages = !anon.enabled && w.pageReads.length ? `<ul class="note">${w.pageReads.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
  parts.push(
    section(
      'llm-wiki の参照',
      wikiUsed
        ? `<div class="fields" style="--cols:5">${[
            field('索引(index.md)', esc(int(w.indexReads))),
            field('個別ページ', esc(int(w.pageReads.length))),
            field('wiki skill', esc(int(w.skillCalls.length)), esc(w.skillCalls.join('、'))),
            field('書き込み', esc(int(w.writes))),
            field('その他', esc(int(w.otherCalls))),
          ].join('')}</div>${pages}`
        : `<p class="note">llm-wiki の参照はありません。</p>`,
    ),
  );

  const f = r.friction;
  parts.push(
    section(
      '摩擦',
      `<div class="fields" style="--cols:5">${[
        field('compaction', esc(int(f.compactions))),
        field('中断(abort)', esc(int(f.aborts))),
        field('エラー', esc(int(f.errors)), 'session.error(ツール失敗は別)'),
        field('権限の確認', esc(int(f.permissionRequests))),
        field('ask_user', esc(int(f.askUser))),
        field('ツール失敗', esc(int(f.toolFailures))),
        field('agent 失敗', esc(int(f.subagentFailures))),
        field('モデル変更', esc(int(f.modelChanges)), '摩擦の合計には含めない'),
        field('モード変更', esc(int(f.modeChanges)), '摩擦の合計には含めない'),
      ].join('')}</div>`,
    ),
  );

  const changed = r.files.changed;
  const created = r.files.created;
  const deleted = r.files.deleted ?? [];
  const sessionState = r.files.sessionState ?? 0;
  const fileList = (xs: string[]): string =>
    anon.enabled ? `<p class="note">${esc(int(xs.length))} 件(伏せ字モードのためパスは表示しません)</p>` : xs.length ? `<ul class="note">${xs.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : `<p class="note">なし</p>`;
  parts.push(
    section(
      '変更したファイル',
      `<div class="three"><div><h3>変更 ${esc(int(changed.length))} 件</h3>${fileList(changed)}</div><div><h3>作成 ${esc(int(created.length))} 件</h3>${fileList(created)}</div><div><h3>削除 ${esc(int(deleted.length))} 件</h3>${fileList(deleted)}</div></div>${
        sessionState ? `<p class="note">Copilot のセッション用ファイル(~/.copilot/session-state/ 配下の plan.md など)${esc(int(sessionState))} 件は一覧から外しています。</p>` : ''
      }`,
      'パスは作業フォルダ基準の絶対パスにそろえ、同じファイルは 1 回だけ載せています(Windows は大文字小文字を区別しない)',
    ),
  );

  parts.push(
    section(
      '時系列',
      r.timeline.length
        ? `<div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">時刻</th><th scope="col">種類</th><th scope="col">内容</th></tr></thead><tbody>${r.timeline.map((e) => timelineRow(e, anon)).join('')}</tbody></table></div>`
        : `<p class="note">イベントログ(events.jsonl)が無いため時系列はありません。</p>`,
      '依頼の区切り・ツール群・エージェント・文脈圧縮などを粗くまとめたもの',
    ),
  );

  const unknown = Object.entries(r.unknownEventTypes);
  parts.push(
    section(
      'ログの状態',
      `<p class="note">イベント ${esc(int(r.events.total))} 件、読めなかった行 ${esc(int(r.events.badLines))} 行。${unknown.length ? `未知のイベント種別: ${esc(unknown.map(([k, v]) => `${k} ×${v}`).join('、'))}` : '未知のイベント種別はありません。'}</p>`,
    ),
  );

  parts.push(
    section(
      '用語',
      `<dl class="glossary">${GLOSSARY.map((g) => `<dt id="${esc(g.id)}">${esc(g.term)}</dt><dd>${esc(g.body)}</dd>`).join('')}</dl>`,
    ),
  );

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3f5f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1110" media="(prefers-color-scheme: dark)">
<title>${esc(truncate(title, 60))} | Copilot Session Atlas</title>
<script>try{var t=localStorage.getItem('atlas-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${o.css}${DETAIL_CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="crumb" href="../atlas.html">← セッション一覧に戻る</a><span class="id">${esc(r.id)}</span></div></header>
<main class="wrap">
<div class="title"><h1>${esc(title)}</h1><div class="meta">${meta}</div></div>
${parts.join('\n')}
<footer>Copilot Session Atlas が ${esc(dateTime(o.generatedAt))} に生成。${anon.enabled ? '伏せ字モード(プロジェクト・パス・ブランチ・本文を伏せています)。' : ''}</footer>
</main>
</body>
</html>
`;
}
