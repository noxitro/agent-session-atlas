// 失敗の台帳の集計のページ(out/failures.html)と、同じ中身の機械可読版(out/failures.json)。
// 改善点のページ(insights-page.ts)と同じ作法(共通の頭・目次・table.ledger)で置く。集計は failure-stats.ts。
import { MAX_ROWS } from '../../core/src/failure-ledger.ts';
import { FAILURE_CAUSE_LABELS, type FailureCause } from '../../core/src/tool-failure.ts';
import { esc } from './detail.ts';
import { FAILURE_THRESHOLDS as T, type AgentStat, type Count, type FailureStats, type GroupStat, type SessionUnitStat, type UnitStat } from './failure-stats.ts';
import { dateTime, int as intText, truncate } from './lib/format.ts';
import { cleanHeading, type VersionMeta } from './lib/insights.ts';
import { codeMeta, NAV_JS, renderRail, renderTop, type NavItem, type NavLink, type PageNavOptions } from './page-nav.ts';

export const FAILURES_FILE = 'failures.html';
export const FAILURES_JSON = 'failures.json';

const CSS = `.ins{margin-top:28px}.ins:first-child{margin-top:0}
.ins .section-head p{max-width:none}
.weak{color:var(--ink-3)}
.lead{font-size:.8125rem;color:var(--ink-2);margin:8px 0 0;max-width:80ch}
/* 行の見出し(1 列目の名前)は太くせず、長い名前は折り返す */
.ledger tbody th{font-weight:400;text-align:left}
.ledger th.name{white-space:normal;overflow-wrap:anywhere;min-width:9em;max-width:20em}
/* 長い文の入る欄(要因・エラー文・例)は折り返して読ませる。内訳は 1 つずつ行を分ける */
.ledger td.txt{white-space:normal;overflow-wrap:anywhere;min-width:9em;max-width:28em}
/* そろえたエラー文は記号を落とした形なので、等幅で文と見分ける */
.ledger .gl{display:block;font-family:var(--mono);font-size:.75rem}
.ledger .ex{display:block;color:var(--ink-3)}
`;

/** 表に載せる「そろえたエラー文」(group)と、例のエラー文の長さ(字数。全文は sessions.json と failures.csv にある) */
const GROUP_CHARS = 80;
const EXAMPLE_CHARS = 200;

export interface FailuresPageOptions {
  css: string;
  generatedAt: string;
  stats: FailureStats;
  /** 指示文の版の見出しと順(build.ts の insightMeta) */
  meta: Record<string, VersionMeta>;
  /** セッション名(詳細ページへのリンクの文言) */
  sessionName: (id: string) => string;
  /** 指示文の閲覧ページがあるとき(instructions.html#v-<hash> へ) */
  libraryHref: string | null;
}

/** failures.json の中身(閾値と集計) */
export function failuresJson(stats: FailureStats, generatedAt: string): Record<string, unknown> {
  return {
    version: 1,
    generatedAt,
    thresholds: { minCalls: T.MIN_CALLS, minSessions: T.MIN_SESSIONS, minRepeat: T.MIN_REPEAT, topRows: T.TOP_ROWS, maxRowsPerSession: MAX_ROWS },
    ...stats,
  };
}

const missing = (text: string): string => `<span class="missing-value">${esc(text)}</span>`;
const int = (v: number): string => esc(intText(v));
// 率は小数 1 桁にそろえる(改善点のページと同じ)。出せないときは「—」
const pct = (v: number | null): string => (v == null ? missing('—') : `${(v * 100).toFixed(1)}%`);
const field = (k: string, v: string, note: string): string => `<div class="field"><span class="k">${esc(k)}</span><span class="v">${v}</span>${note ? `<span class="n">${note}</span>` : ''}</div>`;
/** そろえたエラー文(エラー文の 1 行目を正規化したもの)。空は、エラー文が無かったもの */
const groupLabel = (g: string): string => (g === '' ? missing('(エラー文なし)') : g.length > GROUP_CHARS ? esc(`${g.slice(0, GROUP_CHARS - 1)}…`) : esc(g));
/** 内訳(名前 ×回数)を「・」でつなぐ。無ければ「—」。名前と回数の間では折り返さない */
const counts = (list: Count[], label: (key: string) => string): string => (list.length ? list.map((c) => `${label(c.key)} ×${int(c.n)}`).join('・') : missing('—'));
const causes = (list: Count[]): string => counts(list, (c) => esc(FAILURE_CAUSE_LABELS[c as FailureCause] ?? c));
/** そろえたエラー文の内訳は 1 つずつ行を分ける(長い文が並ぶため) */
const groupsCell = (list: Count[]): string => (list.length ? list.map((c) => `<span class="gl">${groupLabel(c.key)} ×${int(c.n)}</span>`).join('') : missing('—'));
/** 呼び直しの 2 つの欄(回数と、うち成功) */
const retryCells = (n: number, ok: number): string => `<td class="num">${int(n)}</td><td class="num">${int(ok)}</td>`;
/** 表に載せなかった行の断り */
const more = (total: number, unit: string): string =>
  total > T.TOP_ROWS ? `<p class="note">多い順に ${int(T.TOP_ROWS)} ${unit}を載せています(全 ${int(total)} ${unit})。全件は <a href="${FAILURES_JSON}">${FAILURES_JSON}</a> で確かめられます。</p>` : '';
const section = (id: string, title: string, lead: string, body: string): string =>
  `<section class="section ins" id="${id}" aria-labelledby="h-${id}"><div class="section-head"><h2 id="h-${id}">${esc(title)}</h2><p>${lead}</p></div>${body}</section>`;
const table = (head: [string, boolean][], rows: string): string =>
  `<div class="table-scroll"><table class="ledger"><thead><tr>${head.map(([label, num]) => `<th scope="col"${num ? ' class="num"' : ''}>${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
/** 行の見出し(1 列目。名前は折り返す) */
const rowHead = (html: string): string => `<th scope="row" class="name">${html}</th>`;

const GROUP_NOTE = '「そろえた形」は、エラー文の 1 行目のパス・URL・数字・引用した部分を印に置き換え、記号を落としたものです(同じ文の失敗をまとめるため。<a href="glossary.html#failure-group">用語の説明</a>)。';

const unitRows = (units: UnitStat[]): string =>
  units
    .slice(0, T.TOP_ROWS)
    .map(
      (u) =>
        `<tr>${rowHead(esc(u.key))}<td class="num">${int(u.completed)}</td><td class="num">${int(u.failures)}</td><td class="num">${int(u.denied)}</td><td class="num">${pct(u.rate)}</td><td class="num">${int(u.sessions)}</td><td class="txt">${causes(u.causes)}</td><td class="txt">${groupsCell(u.groups)}</td>${retryCells(u.retries, u.retriesOk)}</tr>`,
    )
    .join('');
const UNIT_HEAD: [string, boolean][] = [
  ['呼び出し', true],
  ['失敗', true],
  ['拒否', true],
  ['失敗率', true],
  ['セッション', true],
  ['主な要因', false],
  ['主なエラー文(そろえた形)', false],
  ['呼び直し', true],
  ['うち成功', true],
];

export function renderFailuresHtml(o: FailuresPageOptions): string {
  const s = o.stats;
  const c = s.coverage;
  const any = c.withLedger > 0;
  const links: NavLink[] = [...(o.libraryHref ? [{ href: o.libraryHref, label: '指示文と skill' }] : []), { href: 'insights.html', label: '改善点' }, { href: 'glossary.html', label: '用語の説明' }];
  const item = (href: string, label: string, count: number, unit: string): NavItem => ({ href, label, count, countLabel: unit, showCountLabel: true });
  const plain = (href: string, label: string): NavItem => ({ href, label });
  // 台帳のあるセッションが無いときは「対象」だけ(ほかの節は出さない)
  const items = any
    ? [
        plain('#f-overview', '対象'),
        plain('#f-next', '失敗の後'),
        item('#f-groups', '繰り返している失敗', s.groupsTotal, '件'),
        item('#f-tools', 'ツール', s.toolsTotal, '件'),
        item('#f-mcp', 'MCP サーバー', s.mcpTotal, '件'),
        item('#f-agents', 'エージェント', s.agentsTotal, '件'),
        item('#f-skills', 'skill', s.skillsTotal, '件'),
        item('#f-instructions', '指示文の版', s.instructionsTotal, '版'),
      ]
    : [plain('#f-overview', '対象')];
  const nav: PageNavOptions = { crumbHref: 'atlas.html', crumbLabel: '← レポートに戻る', tocLabel: '失敗の台帳の集計の節', groups: [{ items }], links };
  const sess = (id: string): string => `<a href="sessions/${esc(id.replace(/[^A-Za-z0-9._-]/g, '_'))}.html">${esc(o.sessionName(id))}</a>`;

  // 対象
  const allFailed = c.failures + c.denied;
  const overall = c.completed >= T.MIN_CALLS && c.completed > 0 ? allFailed / c.completed : null;
  const overview = section(
    'f-overview',
    '対象',
    '空でないセッションのうち、失敗の台帳(失敗と拒否を 1 件ずつ残した記録)のあるものを集計しています。台帳の無い記録は以前の版で集計したもので、失敗が 0 件という意味ではありません(集計し直すと付きます。<a href="glossary.html#failure-ledger">用語の説明</a>)。',
    `<div class="fields" style="--cols:3">${[
      field('台帳のあるセッション', int(c.withLedger), `空でないセッション ${int(c.sessions)} 件のうち`),
      field('失敗', int(c.failures), `結果の記録がある呼び出し ${int(c.completed)} 回のうち`),
      field('拒否', int(c.denied), '利用者・権限設定による拒否'),
      field('失敗率', pct(overall), `(失敗 + 拒否) ÷ 結果の記録がある呼び出し。— は ${T.MIN_CALLS} 回未満`),
      field('台帳の無いセッション', int(c.withoutLedger), c.withoutLedger > 0 ? `失敗・拒否 ${int(c.withoutLedgerFailures)} 件の中身は、この集計に入っていません` : ''),
      field('台帳に残していない失敗・拒否', int(c.dropped), `1 セッション ${int(MAX_ROWS)} 行の上限を超えた分(回数には入り、内訳には入りません)`),
    ].join('')}</div>`,
  );

  // 失敗の後
  const n = s.next;
  const next = section(
    'f-next',
    '失敗の後',
    '台帳の行ごとに、同じエージェントが失敗の後に最初に呼んだツールを見ています。並行して動いていた呼び出しと、同じ応答でまとめて要求された呼び出しは数えません。',
    n.rows === 0
      ? '<p class="note">台帳の行がありません。</p>'
      : `<div class="fields" style="--cols:4">${[
          field('同じ引数で呼び直した', int(n.retries), `うち成功 ${int(n.retriesOk)}`),
          field('別の呼び出しで続けた', int(n.movedOn), `次の呼び出しが成功 ${int(n.movedOnOk)}`),
          field('利用者の次の依頼', int(n.user), '次のツールより先に依頼が来た'),
          field('続きなし', int(n.end), '同じエージェントの呼び出しがその後に無い'),
        ].join('')}</div><p class="note">呼び直し: 失敗の後に、同じツールを同じ引数で呼んだもの。下の表の「呼び直し」「うち成功」も同じ数え方です(<a href="glossary.html#failure-next">用語の説明</a>)。</p>`,
  );

  // 繰り返している失敗
  const gRows = s.groups
    .slice(0, T.TOP_ROWS)
    .map((g: GroupStat) => {
      const ex = g.example.trim() === '' ? missing('—') : esc(truncate(g.example, EXAMPLE_CHARS));
      const ids = g.exampleSessions.map((id) => sess(id)).join('、');
      const cause = g.denied === g.n ? '拒否' : g.denied > 0 ? `${causes(g.causes)}・拒否 ×${int(g.denied)}` : causes(g.causes);
      return `<tr><th scope="row" class="name"><span class="gl">${groupLabel(g.group)}</span></th><td class="num">${int(g.n)}</td><td class="num">${int(g.sessions)}</td><td class="txt">${counts(g.tools, esc)}</td><td class="txt">${cause}</td>${retryCells(g.retries, g.retriesOk)}<td class="txt">${ex}<span class="ex">${ids}</span></td></tr>`;
    })
    .join('');
  const groups = section(
    'f-groups',
    '繰り返している失敗',
    `同じエラー文で ${T.MIN_REPEAT} 回以上失敗しているものを、多い順に載せています。繰り返している所を探すための表で、原因までは分かりません。`,
    gRows === ''
      ? `<p class="note">${T.MIN_REPEAT} 回以上繰り返した失敗はありません。</p>`
      : `${table(
          [
            ['エラー文(そろえた形)', false],
            ['回数', true],
            ['セッション', true],
            ['ツール', false],
            ['要因', false],
            ['呼び直し', true],
            ['うち成功', true],
            ['例', false],
          ],
          gRows,
        )}<p class="note">${GROUP_NOTE}例は、最初に出たエラー文と、出たセッション(${T.EXAMPLE_SESSIONS} 件まで)です。</p>${more(s.groupsTotal, '件')}`,
  );

  // ツール・MCP
  const unitNote = `<p class="note">失敗率: (失敗 + 拒否) ÷ 呼び出し(結果の記録があるもの)。— は呼び出しが ${T.MIN_CALLS} 回未満。セッション: 失敗か拒否のあったセッションの数。主な要因は失敗だけ(拒否は入りません)。${GROUP_NOTE}</p>`;
  const unitSection = (id: string, title: string, first: string, lead: string, units: UnitStat[], total: number, empty: string): string =>
    section(id, title, lead, units.length === 0 ? `<p class="note">${empty}</p>` : `${table([[first, false], ...UNIT_HEAD], unitRows(units))}${unitNote}${more(total, '件')}`);
  const tools = unitSection('f-tools', 'ツール', 'ツール', '失敗か拒否のあったツールです。回数は記録の結果(成功・失敗・拒否)から、要因・エラー文・呼び直しは台帳の行から数えています。', s.tools, s.toolsTotal, '失敗か拒否のあったツールはありません。');
  const mcp = unitSection('f-mcp', 'MCP サーバー', 'サーバー', '失敗か拒否のあった MCP サーバーです。そのサーバーのツールの結果を足しています。', s.mcp, s.mcpTotal, '失敗か拒否のあった MCP サーバーはありません。');

  // エージェント
  const opt = (v: number | null): string => (v == null ? missing('—') : int(v));
  const aRows = s.agents
    .slice(0, T.TOP_ROWS)
    .map(
      (a: AgentStat) =>
        `<tr>${rowHead(a.main ? '本体' : esc(a.name))}<td class="num">${opt(a.runs)}</td><td class="num">${opt(a.runsWithFailures)}</td><td class="num">${int(a.failures)}</td><td class="num">${int(a.denied)}</td><td class="num">${int(a.sessions)}</td><td class="txt">${causes(a.causes)}</td><td class="txt">${groupsCell(a.groups)}</td>${retryCells(a.retries, a.retriesOk)}</tr>`,
    )
    .join('');
  const agents = section(
    'f-agents',
    'エージェント',
    '失敗か拒否のあったエージェント(本体と、サブエージェントの名前ごと)です。結果の記録がある呼び出しの数はエージェントごとには分からないので、率は出していません。',
    aRows === ''
      ? '<p class="note">失敗か拒否のあったエージェントはありません。</p>'
      : `${table(
          [
            ['エージェント', false],
            ['起動', true],
            ['失敗・拒否のあった起動', true],
            ['失敗', true],
            ['拒否', true],
            ['セッション', true],
            ['主な要因', false],
            ['主なエラー文(そろえた形)', false],
            ['呼び直し', true],
            ['うち成功', true],
          ],
          aRows,
        )}<p class="note">台帳の行から数えているので、行数の上限で残していない分は入りません。起動: そのサブエージェントを起動した回数(本体は —)。${GROUP_NOTE}</p>${more(s.agentsTotal, '件')}`,
  );

  // skill・指示文の版(セッションの単位)
  const sessionRows = (units: SessionUnitStat[], label: (key: string) => string, after: boolean): string =>
    units
      .slice(0, T.TOP_ROWS)
      .map(
        (u) =>
          `<tr>${rowHead(label(u.key))}<td class="num">${int(u.sessions)}</td><td class="num">${int(u.completed)}</td><td class="num">${int(u.failed)}</td><td class="num">${pct(u.rate)}</td><td class="num">${int(u.otherSessions)}</td><td class="num">${pct(u.otherRate)}</td>${after ? `<td class="num">${u.rowsAfter == null ? missing('—') : int(u.rowsAfter)}</td>` : ''}<td class="txt">${groupsCell(u.groups)}</td></tr>`,
      )
      .join('');
  const perSessionNote = `失敗率: セッション内の失敗・拒否 ÷ 呼び出し(結果の記録があるもの)。${T.MIN_SESSIONS} セッション以上・呼び出し ${T.MIN_CALLS} 回以上のときだけ出し、片方が出せないときは両方 — にします。1 つのセッションの失敗は、そこで使ったものすべてに数えます。`;
  const skRows = sessionRows(s.skills, (k) => esc(k), true);
  const skills = section(
    'f-skills',
    'skill(呼んだセッションの単位)',
    'その skill を呼んだセッションの失敗と拒否を数えています。失敗を skill に結び付ける記録は無いので、分かるのは相関までです。',
    skRows === ''
      ? '<p class="note">skill を呼んだセッションに、失敗か拒否はありません。</p>'
      : `${table(
          [
            ['skill', false],
            ['呼んだセッション', true],
            ['呼び出し', true],
            ['セッション内の失敗・拒否', true],
            ['失敗率', true],
            ['それ以外のセッション', true],
            ['失敗率(それ以外)', true],
            ['呼んだ後の失敗・拒否', true],
            ['主なエラー文(そろえた形)', false],
          ],
          skRows,
        )}<p class="note">${perSessionNote}呼んだ後の失敗・拒否: そのセッションで最初に呼んだ時刻より後の、台帳の行の数。主なエラー文もその行から数えています。${GROUP_NOTE}</p>${more(s.skillsTotal, '件')}`,
  );
  const vlabel = (hash: string): string => {
    const m = o.meta[hash];
    const name = m ? `${esc(cleanHeading(m.heading, 60) || '(見出しなし)')} <span class="weak">版 ${m.order + 1}</span>` : esc(hash);
    return o.libraryHref ? `<a href="${esc(o.libraryHref)}#v-${esc(hash)}">${name}</a>` : name;
  };
  const inRows = sessionRows(s.instructions, vlabel, false);
  const instructions = section(
    'f-instructions',
    '指示文の版(読み込んだセッションの単位)',
    'その版(内容のハッシュ)を読み込んだセッションの失敗と拒否を数えています。失敗を指示文に結び付ける記録は無いので、分かるのは相関までです。',
    inRows === ''
      ? '<p class="note">指示文を読み込んだセッションに、失敗か拒否はありません。</p>'
      : `${table(
          [
            ['版', false],
            ['読み込んだセッション', true],
            ['呼び出し', true],
            ['セッション内の失敗・拒否', true],
            ['失敗率', true],
            ['それ以外のセッション', true],
            ['失敗率(それ以外)', true],
            ['主なエラー文(そろえた形)', false],
          ],
          inRows,
        )}<p class="note">${perSessionNote}主なエラー文は、そのセッションの台帳の行から数えています。${GROUP_NOTE}</p>${more(s.instructionsTotal, '版')}`,
  );

  const body = any
    ? `${overview}\n${next}\n${groups}\n${tools}\n${mcp}\n${agents}\n${skills}\n${instructions}`
    : `${overview}\n<p class="note">失敗の台帳のあるセッションがありません。atlas.bat で集計し直すと、失敗と拒否が 1 件ずつ記録されます。</p>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="atlas-token" content="__ATLAS_TOKEN__">
${codeMeta()}
<meta name="theme-color" content="#f3f5f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1110" media="(prefers-color-scheme: dark)">
<title>失敗の台帳の集計 | Copilot Session Atlas</title>
<script>try{var t=localStorage.getItem('atlas-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${o.css}${CSS}</style>
</head>
<body>
${renderTop(nav)}
<div class="shell">
${renderRail(nav)}
<div class="content">
<main class="wrap">
<div class="title"><h1>失敗の台帳の集計</h1><p class="lead">ツールの失敗と拒否を 1 件ずつ残した記録(失敗の台帳)を、ツール・MCP サーバー・エージェント・skill・指示文の版ごとに数えています。LLM は使わず、決まった規則で集計しています。レポートに入れた記録のうち、失敗の台帳のあるセッション ${int(c.withLedger)} 件で計算しています(レポートの画面の絞り込みは掛かりません)。生成 ${esc(dateTime(o.generatedAt))}。</p></div>
${body}
</main>
<footer class="wrap page-foot"><p>1 件ごとの中身は、セッションの詳細ページの「失敗と拒否(1 件ごと)」と、<code>out/tables/failures.csv</code>(SQLite の <code>failures</code> 表)にあります。このページと同じ集計は <a href="${FAILURES_JSON}">${FAILURES_JSON}</a> に書いています。</p></footer>
</div>
</div>
<script>${NAV_JS}</script>
</body>
</html>
`;
}
