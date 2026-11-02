// Phase 12: 改善点の別ページ(out/insights.html)。atlas.html の「改善点」の節に載せきれない全件(指示文の版、skill、止まっているセッション、
// スキル化の候補の全文)を、用語ページと同じ作法で置く。本文は atlas.html に埋め込まない。伏せ字版では依頼文と見出しを出さない。
import { esc } from './detail.ts';
import { dateTime, dec, duration, int } from './lib/format.ts';
import { THRESHOLDS, type Candidate, type InstructionFindings, type SkillStat, type StuckSession, type VersionMeta, type VersionStat } from './lib/insights.ts';
import { NAV_JS, renderRail, renderTop } from './page-nav.ts';

export const INSIGHTS_FILE = 'insights.html';
export const INSIGHTS_JSON = 'insights.json';

export interface InsightsPageOptions {
  css: string;
  generatedAt: string;
  anonymized: boolean;
  sessions: number;
  versions: VersionStat[];
  meta: Record<string, VersionMeta>;
  findings: InstructionFindings;
  skills: { stats: SkillStat[]; unused: string[] };
  stuck: StuckSession[];
  candidates: Candidate[];
  /** セッション名(詳細ページへのリンクの文言) */
  sessionName: (id: string) => string;
  /** 指示文の閲覧ページがあるとき(instructions.html#v-<hash> へ) */
  libraryHref: string | null;
}

const CSS = `
.ins{margin-top:28px}.ins:first-child{margin-top:0}
.ins .section-head p{max-width:none}
.cand{margin-top:14px;border:1px solid var(--rule-strong);background:var(--surface)}
.cand>summary{cursor:pointer;padding:6px 10px;font-size:.8125rem;color:var(--form);display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline}
.cand>summary b{color:var(--ink)}
.cand .body{margin:0;padding:8px 10px;border-top:1px solid var(--rule);font:.75rem/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto}
.cand .body:focus-visible{outline:2px solid var(--form);outline-offset:-2px}
.cand .cap{margin:0;padding:6px 10px 0;border-top:1px solid var(--rule);font-size:.6875rem;color:var(--form);letter-spacing:.04em}
.cand .uses{padding:6px 10px;border-top:1px solid var(--rule);font-size:.75rem;color:var(--ink-2)}
.cand .uses ul{display:inline;margin:0;padding:0;list-style:none}.cand .uses li{display:inline}.cand .uses li+li::before{content:' · ';color:var(--ink-3)}
.seq{font-family:var(--mono);font-size:.75rem}
.weak{color:var(--ink-3)}
.lead{font-size:.8125rem;color:var(--ink-2);margin:8px 0 0;max-width:80ch}
`;

const percent = (v: number): string => `${dec(v * 100)}%`;
const pct = (v: number | null, enough = true): string => (v == null || !enough ? '—' : percent(v));
const ms = (v: number | null): string => (v == null ? '—' : duration(v));

export function renderInsightsHtml(o: InsightsPageOptions): string {
  const anon = o.anonymized;
  const nav = {
    crumbHref: 'atlas.html',
    crumbLabel: '← レポートに戻る',
    tocLabel: '改善点の節',
    groups: [
      {
        items: [
          { href: '#i-instructions', label: '指示文の傾向', count: o.versions.length, countLabel: '版' },
          { href: '#i-skills', label: 'skill の傾向', count: o.skills.stats.length, countLabel: '件' },
          { href: '#i-stuck', label: '止まっている箇所', count: o.stuck.length, countLabel: 'セッション' },
          { href: '#i-candidates', label: 'スキル化の候補', count: o.candidates.length, countLabel: '件' },
        ],
      },
    ],
    links: [...(o.libraryHref ? [{ href: o.libraryHref, label: '指示文と skill' }] : []), { href: 'glossary.html', label: '用語の説明' }],
  };
  const sess = (id: string): string => `<a href="sessions/${esc(id.replace(/[^A-Za-z0-9._-]/g, '_'))}.html">${esc(o.sessionName(id))}</a>`;
  const vlabel = (v: VersionStat): string => {
    const m = o.meta[v.hash];
    const name = anon || !m ? esc(v.hash) : `${esc(m.heading.replace(/^#+\s*/, '').slice(0, 60) || '(見出しなし)')} <span class="weak">版 ${m.order + 1}</span>`;
    return o.libraryHref && !anon ? `<a href="${esc(o.libraryHref)}#v-${esc(v.hash)}">${name}</a>` : name;
  };

  // 指示文
  const vRows = o.versions
    .map(
      (v) =>
        `<tr><td>${vlabel(v)}</td><td class="num">${esc(int(v.chars))}</td><td class="num">${esc(int(v.sessions))}</td><td class="num">${esc(dec(v.injectionsPerSession))}</td><td class="num">${pct(v.failureRate, v.enough)}</td><td class="num">${pct(v.reworkRate, v.enough)}</td><td class="num">${esc(dec(v.compactionsPerSession))}</td><td class="num">${esc(int(Math.round(v.outputPerSession)))}</td></tr>`,
    )
    .join('');
  const findings = [
    ...o.findings.longRare.map((v) => `<li>長いのに注入が少ない: ${vlabel(v)}(${esc(int(v.chars))} 字、${esc(int(v.sessions))} セッション)</li>`),
    ...o.findings.worsened.map(
      (w) =>
        `<li>版を変えた前後で悪化: ${anon ? w.after.hash : esc(w.heading.replace(/^#+\s*/, '').slice(0, 60))}(${vlabel(w.before)} → ${vlabel(w.after)}。失敗率 ${w.failureDelta == null ? '—' : `${w.failureDelta >= 0 ? '+' : ''}${esc(dec(w.failureDelta))} pt`}、手戻り率 ${w.reworkDelta >= 0 ? '+' : ''}${esc(dec(w.reworkDelta))} pt)</li>`,
    ),
  ];
  const instructions = `<section class="section ins" id="i-instructions" aria-labelledby="h-i-instructions"><div class="section-head"><h2 id="h-i-instructions">指示文の傾向</h2><p>版(内容のハッシュ)ごとの、注入されたセッションでの傾向。指示文の効果は直接測れない(同じ版でも依頼が違う)ので、相関として読む。率は ${THRESHOLDS.MIN_SESSIONS} セッション以上のものだけ結論に使う。</p></div>${
    findings.length ? `<ul class="note">${findings.join('')}</ul>` : `<p class="note">挙げる傾向はありません(前後比較ができなかった見出し ${esc(int(o.findings.comparedInsufficient))})。</p>`
  }<div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">版</th><th scope="col" class="num">文字数</th><th scope="col" class="num">セッション</th><th scope="col" class="num">注入 / セッション</th><th scope="col" class="num">失敗率</th><th scope="col" class="num">手戻り率</th><th scope="col" class="num">compaction / セッション</th><th scope="col" class="num">出力トークン / セッション</th></tr></thead><tbody>${vRows || '<tr><td colspan="8">指示文の注入はありません。</td></tr>'}</tbody></table></div></section>`;

  // skill
  const sRows = o.skills.stats
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td><td class="num">${esc(int(s.calls))}</td><td class="num">${esc(int(s.byUser))} / ${esc(int(s.byAgent))}</td><td class="num">${s.chars == null ? '<span class="missing-value">記録なし</span>' : esc(int(s.chars))}</td><td class="num">${esc(int(s.sessions))}</td><td class="num">${pct(s.failureWith)}</td><td class="num">${pct(s.failureWithout)}</td><td class="num">${esc(int(Math.round(s.outputPerSession)))}</td></tr>`,
    )
    .join('');
  const skills = `<section class="section ins" id="i-skills" aria-labelledby="h-i-skills"><div class="section-head"><h2 id="h-i-skills">skill の傾向</h2><p>呼び出し回数(利用者 / エージェント)、本文の大きさ、呼んだセッションと呼ばなかったセッションの失敗率(どちらも ${THRESHOLDS.MIN_SESSIONS} セッション未満なら —)。</p></div><div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">skill</th><th scope="col" class="num">呼び出し</th><th scope="col" class="num">利用者 / エージェント</th><th scope="col" class="num">本文の字数</th><th scope="col" class="num">セッション</th><th scope="col" class="num">失敗率(呼んだ)</th><th scope="col" class="num">失敗率(呼ばない)</th><th scope="col" class="num">出力トークン / セッション</th></tr></thead><tbody>${sRows || '<tr><td colspan="8">skill の呼び出しはありません。</td></tr>'}</tbody></table></div>${
    o.skills.unused.length ? `<p class="note">インストール済みで未使用: ${esc(o.skills.unused.join('、'))}</p>` : ''
  }</section>`;

  // 止まっている箇所
  const stRows = o.stuck
    .map(
      (x) =>
        `<tr><td>${sess(x.id)}</td><td>${anon ? esc(x.project) : esc(x.projectLabel)}</td><td>${esc(x.reasons.join('、'))}</td><td class="num">${ms(x.ttftMedian)}</td><td class="num">${ms(x.durationMedian)}</td><td class="num">${esc(int(x.consecutiveFailures))}</td><td class="num">${esc(int(x.extraEdits))}</td><td class="num">${esc(int(x.permissions))}</td><td class="num">${esc(int(x.compactions))}</td></tr>`,
    )
    .join('');
  const T = THRESHOLDS.STUCK;
  const stuck = `<section class="section ins" id="i-stuck" aria-labelledby="h-i-stuck"><div class="section-head"><h2 id="h-i-stuck">止まっている箇所</h2><p>閾値(待ち時間の中央値 ${esc(duration(T.ttftMs))} 以上、失敗の連続 ${T.consecutiveFailures} 回以上、同じファイルの再編集 ${T.extraEdits} 回以上、権限確認 ${T.permissions} 回以上、compaction ${T.compactions} 回以上)を超えたセッション。理由の数の多い順。</p></div><div class="table-scroll"><table class="ledger"><thead><tr><th scope="col">セッション</th><th scope="col">プロジェクト</th><th scope="col">理由</th><th scope="col" class="num">TTFT 中央値</th><th scope="col" class="num">全体 中央値</th><th scope="col" class="num">失敗の連続</th><th scope="col" class="num">再編集</th><th scope="col" class="num">権限確認</th><th scope="col" class="num">compaction</th></tr></thead><tbody>${stRows || '<tr><td colspan="9">閾値を超えたセッションはありません。</td></tr>'}</tbody></table></div></section>`;

  // 候補
  const cands = o.candidates
    .map((c, i) => {
      const head = c.kind === 'tools' ? `<span class="seq">${esc(c.key)}</span>` : anon ? `依頼文の繰り返し(本文は伏せ字版では出しません)` : esc((c.representative ?? c.key).replace(/\s+/g, ' ').slice(0, 80));
      const body = anon
        ? ''
        : `${c.representative ? `<p class="cap">代表の依頼文</p><pre class="body" tabindex="0">${esc(c.representative)}</pre>` : ''}${c.examples.length ? `<p class="cap">他の例(${c.examples.length})</p><pre class="body" tabindex="0">${esc(c.examples.join('\n— — —\n'))}</pre>` : ''}`;
      return `<details class="cand" id="c-${i + 1}"${i < 3 ? ' open' : ''}><summary><b>${i + 1}.</b> ${head} <span>${c.kind === 'tools' ? 'ツールの並び' : '似た依頼文'}</span> <span>${esc(int(c.count))} 回</span> <span>${esc(int(c.sessions.length))} セッション</span> <span>所要 中央値 ${ms(c.medianMs)}</span> <span>スコア ${esc(dec(c.score))}</span></summary>${body}<div class="uses">関係セッション: <ul>${c.sessions
        .slice(0, 30)
        .map((id) => `<li>${sess(id)}</li>`)
        .join('')}</ul>${c.sessions.length > 30 ? ` …他 ${esc(int(c.sessions.length - 30))}` : ''}</div></details>`;
    })
    .join('');
  const candidates = `<section class="section ins" id="i-candidates" aria-labelledby="h-i-candidates"><div class="section-head"><h2 id="h-i-candidates">スキル化の候補</h2><p>似た依頼文の繰り返し(正規化した文の 3-gram の Jaccard 類似度 ${THRESHOLDS.SIMILARITY} 以上)と、同じツールの並びの繰り返し(本体のターンごとの列から長さ ${THRESHOLDS.SEQ_MIN}〜${THRESHOLDS.SEQ_MAX})。${THRESHOLDS.MIN_REPEAT} 回以上・2 セッション以上のもの。スコアは回数 × 1 回の所要の中央値(分、2 時間で頭打ち)。全セッション(絞り込み前)で計算。LLM は使っていない。下書きは <code>npm run atlas -- skill-draft &lt;番号&gt;</code>(クレジットを消費。明示したときだけ)。</p></div>${
    cands || '<p class="note">候補はありません(繰り返しが閾値に届かない)。</p>'
  }</section>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="atlas-token" content="__ATLAS_TOKEN__">
<meta name="theme-color" content="#f3f5f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1110" media="(prefers-color-scheme: dark)">
<title>改善点 | Copilot Session Atlas</title>
<script>try{var t=localStorage.getItem('atlas-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${o.css}${CSS}</style>
</head>
<body>
${renderTop(nav)}
<div class="shell">
${renderRail(nav)}
<div class="content">
<main class="wrap">
<div class="title"><h1>改善点(全件)</h1><p class="lead">LLM を呼ばない規則の集計。分かるのは相関までで、「傾向」として読む。${esc(int(o.sessions))} セッション(絞り込み前)で計算。生成 ${esc(dateTime(o.generatedAt))}。${anon ? '伏せ字版: 依頼文の本文と指示文の見出しは出さず、件数とスコアだけ。' : ''}</p></div>
${instructions}
${skills}
${stuck}
${candidates}
</main>
<footer class="wrap page-foot"><p>atlas.html の「改善点」の節は、絞り込みに従って同じ規則で再計算したもの(スキル化の候補だけは全セッションで計算)。</p></footer>
</div>
</div>
<script>${NAV_JS}</script>
</body>
</html>
`;
}
