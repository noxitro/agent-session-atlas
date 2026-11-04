<script lang="ts">
  // Phase 12: 改善点(LLM を呼ばない規則の集計)。カードは計算の対象で 2 つの群に分け、1 枚のカードに対象を混ぜない。
  // 絞り込みに従う群: 指示文の傾向・skill の傾向・止まっている箇所(sessions で再計算)。
  // 全記録の群: 「長いのに注入が少ない」(全体での希少さの話なので allSessions)と、スキル化の候補
  // (依頼文の本文が要るので build 時に全セッションで計算して埋め込んだもの。全件は insights.html)
  import { shortProjectLabel } from '../../lib/anonymize.ts';
  import { date, dec, duration, int } from '../../lib/format.ts';
  import { cleanHeading, instructionFindings, instructionVersions, skillStats, stuckByProject, stuckSessions, THRESHOLDS, type Candidate, type VersionMeta } from '../../lib/insights.ts';
  import type { SessionSummary } from '../../lib/types.ts';

  let {
    sessions,
    allSessions,
    installed,
    disabled = [],
    meta,
    candidates,
    candidateTotal,
    computedOver,
    anonymized,
    hasPage,
    libraryHref,
  }: {
    sessions: SessionSummary[];
    /** 絞り込み前の全セッション */
    allSessions: SessionSummary[];
    installed: string[] | null;
    /** 設定で無効にしてある skill(settings.json の disabledSkills。今の設定) */
    disabled?: string[];
    /** 指示文の版の見出し等(伏せ字版では空) */
    meta: Record<string, VersionMeta>;
    /** 上位 30 件(埋め込み) */
    candidates: Candidate[];
    /** 候補の全件数 */
    candidateTotal: number;
    computedOver: number;
    anonymized: boolean;
    /** insights.html を作ったか(export / build どちらでも作る) */
    hasPage: boolean;
    libraryHref: string | null;
  } = $props();

  const versions = $derived(instructionVersions(sessions));
  const findings = $derived(instructionFindings(versions, meta, sessions.length));
  const allFindings = $derived(instructionFindings(instructionVersions(allSessions), meta, allSessions.length));
  const longRare = $derived(allFindings.longRare);
  const longRareChars = $derived(allFindings.longChars);
  const skills = $derived(skillStats(sessions, installed));
  const disabledSet = $derived(new Set(disabled.map((n) => n.toLowerCase())));
  /** 呼んだときの失敗率が出せる skill があるか(無ければ失敗率の列を出さない) */
  const skillRates = $derived(skills.stats.some((s) => s.failureWith != null));
  const stuck = $derived(stuckSessions(sessions));
  const byProject = $derived(stuckByProject(stuck, sessions));
  const TOP = 5;
  // 率は小数 1 桁にそろえる(2.41% と 2.4% が並ぶと別の値に見える)
  const pct = (v: number | null): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const vname = (hash: string): string => {
    const m = meta[hash];
    return m && !anonymized ? `${cleanHeading(m.heading, 40) || '(見出しなし)'} 版 ${m.order + 1}` : hash;
  };
  const vhref = (hash: string): string | null => (libraryHref && !anonymized ? `${libraryHref}#v-${hash}` : null);
  const sessionLabel = (id: string): string => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return id.slice(0, 8);
    return anonymized ? `セッション ${id.slice(0, 8)}` : (s.name || s.firstUserMessage || id.slice(0, 8)).replace(/\s+/g, ' ').slice(0, 50);
  };
</script>

<section class="section" id="insights" aria-labelledby="insights-h">
  <div class="section-head">
    <h2 id="insights-h">改善点</h2>
    <p>
      LLM を呼ばない規則の集計。分かるのは相関までで、「傾向」として読んでください。指示文の効果は直接測れません(同じ版でも依頼が違う)。率は {THRESHOLDS.MIN_SESSIONS} セッション以上のものだけ。{#if hasPage}全件は <a href="insights.html">改善点のページ</a>。{/if}
    </p>
  </div>
  <p class="group" id="insights-g-filtered">絞り込みに従う: 上の絞り込みの {int(sessions.length)} セッションで計算します。</p>
  <div class="grid" role="group" aria-labelledby="insights-g-filtered">
    <div class="box" data-testid="insights-instructions">
      <h3>指示文の傾向</h3>
      <p class="basis">
        版を変えた前後の比較: {int(findings.compared)} 組を判定、悪化 {int(findings.worsened.length)}{#if findings.comparedInsufficient}。{int(findings.comparedInsufficient)} 組はどちらかが {THRESHOLDS.MIN_SESSIONS} セッション未満で判定できません{/if}。
      </p>
      {#if findings.worsened.length}
        <ol>
          {#each findings.worsened.slice(0, TOP) as w (w.after.hash)}
            <li>
              版を変えた前後で悪化: {#if vhref(w.after.hash)}<a href={vhref(w.after.hash)}>{vname(w.after.hash)}</a>{:else}{vname(w.after.hash)}{/if}(失敗率 {w.failureDelta == null ? '—' : `${w.failureDelta >= 0 ? '+' : ''}${dec(w.failureDelta)} pt`}、手戻り率 {w.reworkDelta >= 0 ? '+' : ''}{dec(w.reworkDelta)} pt、{int(w.before.sessions)} → {int(w.after.sessions)} セッション)
            </li>
          {/each}
        </ol>
      {/if}
      {#if versions.length}
        <div class="table-scroll">
          <table class="ledger small">
            <caption class="cap">注入されたセッションの多い版(上位 {Math.min(TOP, versions.length)} / 全 {int(versions.length)} 版)</caption>
            <thead><tr><th scope="col">版</th><th scope="col" class="num">字数</th><th scope="col" class="num">セッション</th><th scope="col" class="num">失敗率</th><th scope="col" class="num">手戻り率</th></tr></thead>
            <tbody>
              {#each versions.slice(0, TOP) as v (v.hash)}
                <tr><td>{#if vhref(v.hash)}<a href={vhref(v.hash)}>{vname(v.hash)}</a>{:else}{vname(v.hash)}{/if}</td><td class="num">{int(v.chars)}</td><td class="num">{int(v.sessions)}</td><td class="num">{v.enough ? pct(v.failureRate) : '—'}</td><td class="num">{v.enough ? pct(v.reworkRate) : '—'}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="basis">失敗率: ツールの失敗・拒否 / 呼び出し。手戻り率: 同じファイルを 2 回以上編集したセッションの割合。— は {THRESHOLDS.MIN_SESSIONS} セッション未満。</p>
      {/if}
    </div>

    <div class="box" data-testid="insights-skills">
      <h3>skill の傾向</h3>
      {#if skills.stats.length === 0}
        <p class="basis">skill の呼び出しはありません。</p>
      {:else}
        <div class="table-scroll">
          <table class="ledger small">
            <caption class="cap">呼び出しの多い skill(上位 {Math.min(TOP, skills.stats.length)} / 全 {int(skills.stats.length)} 件)</caption>
            <thead><tr><th scope="col">skill</th><th scope="col" class="num">呼び出し</th><th scope="col" class="num">字数</th>{#if skillRates}<th scope="col" class="num">失敗率(呼んだ / 呼ばない)</th>{/if}</tr></thead>
            <tbody>
              {#each skills.stats.slice(0, TOP) as s (s.name)}
                <tr><td>{s.name}</td><td class="num">{int(s.calls)}</td><td class="num">{s.chars == null ? '記録なし' : int(s.chars)}</td>{#if skillRates}<td class="num">{pct(s.failureWith)} / {pct(s.failureWithout)}</td>{/if}</tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if !skillRates}<p class="basis">{THRESHOLDS.MIN_SESSIONS} セッション以上で呼ばれた skill が無いので、呼んだときと呼ばないときの失敗率は比べられません。</p>{/if}
      {/if}
      {#if skills.unused.length}<p class="basis">インストール済みで未使用: {skills.unused.map((n) => (disabledSet.has(n.toLowerCase()) ? `${n}(無効)` : n)).join('、')}</p>{/if}
    </div>

    <div class="box" data-testid="insights-stuck">
      <h3>止まっている箇所</h3>
      {#if stuck.length === 0}
        <p class="basis">閾値を超えたセッションはありません。</p>
      {:else}
        <p class="basis">{int(stuck.length)} セッションが閾値(最初のトークンまでの待ちの中央値 {duration(THRESHOLDS.STUCK.ttftMs)} 以上、ツールの失敗の連続 {THRESHOLDS.STUCK.consecutiveFailures} 回以上、余分な編集(同じファイルの 2 回目以降の編集の全ファイルの合計){THRESHOLDS.STUCK.extraEdits} 回以上、権限確認 {THRESHOLDS.STUCK.permissions} 件以上、compaction {THRESHOLDS.STUCK.compactions} 回以上)を超えています。理由の多い順に上位 {Math.min(TOP, stuck.length)} 件。</p>
        <ol>
          {#each stuck.slice(0, TOP) as x (x.id)}
            <li><a href={x.href}>{sessionLabel(x.id)}</a>: {x.reasons.join('、')}{#if x.reasons.includes('待ち時間') && x.ttftMedian != null}(待ちの中央値 {duration(x.ttftMedian)}){/if}</li>
          {/each}
        </ol>
        {#if byProject.length}
          <p class="basis">プロジェクト別(該当 / 全セッション。{THRESHOLDS.MIN_SESSIONS} セッション以上のもの): {byProject.slice(0, TOP).map((p) => `${anonymized ? p.project : shortProjectLabel(p.projectLabel)} ${int(p.stuck)} / ${int(p.total)}`).join('、')}</p>
        {/if}
      {/if}
    </div>

  </div>

  <p class="group" id="insights-g-all">全記録で計算: 絞り込みに関係なく、すべての記録で計算します。絞り込んでも変わりません。</p>
  <div class="grid" role="group" aria-labelledby="insights-g-all">
    <div class="box" data-testid="insights-long-rare">
      <h3>長いのに注入が少ない指示文</h3>
      <p class="basis">全 {int(allSessions.length)} セッションで計算。字数が全版の上位 25%({int(longRareChars)} 字以上)で、注入されたのが {THRESHOLDS.RARE_SESSIONS} セッション未満の版。読み込まれる場面が少ないのに長い指示文は、分けるか短くする候補です。{#if longRare.length}上位 {Math.min(TOP, longRare.length)} / 全 {int(longRare.length)} 版。{/if}</p>
      {#if longRare.length === 0}
        <p class="basis">該当する版はありません。</p>
      {:else}
        <ol>
          {#each longRare.slice(0, TOP) as v (v.hash)}
            <li>{#if vhref(v.hash)}<a href={vhref(v.hash)}>{vname(v.hash)}</a>{:else}{vname(v.hash)}{/if}({int(v.chars)} 字、{int(v.sessions)} セッション{#if meta[v.hash]?.lastAt}、最後に読み込んだのは {date(meta[v.hash].lastAt ?? null)}{/if})</li>
          {/each}
        </ol>
      {/if}
    </div>

    <div class="box" data-testid="insights-candidates">
      <h3>スキル化の候補</h3>
      <p class="basis">全記録({int(computedOver)} 件、空のセッションを含む)で計算。似た依頼文の繰り返しと同じツールの並びの繰り返し({THRESHOLDS.MIN_REPEAT} 回以上)。スコアは回数 × 実働の中央値(分。1 分未満は 1 分、2 時間で頭打ち)。実働はターンの中で 5 分を超えて出来事が無かった区間(返答待ちや放置)を除いた時間です。上位 {Math.min(TOP, candidates.length)} / 全 {int(candidateTotal)} 件。</p>
      {#if candidates.length === 0}
        <p class="basis">候補はありません。</p>
      {:else}
        <ol>
          {#each candidates.slice(0, TOP) as c, i (c.key)}
            <li>
              {#if c.kind === 'tools'}<span class="seq">{c.key}</span>{:else if anonymized}依頼文の繰り返し{:else}{clip((c.representative ?? c.key).replace(/\s+/g, ' '), 70)}{/if}
              <span class="meta">{int(c.count)} 回 · {int(c.sessions.length)} セッション · スコア {dec(c.score)}</span>
              {#if hasPage}<a class="go" href="insights.html#c-{i + 1}" aria-label="候補 {i + 1} を詳しく">詳しく →</a>{/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
</section>

<style>
  .group {
    margin: 14px 0 6px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--ink-2);
  }
  .group:first-of-type {
    margin-top: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr));
    border-top: 1px solid var(--rule-strong);
    border-left: 1px solid var(--rule);
  }
  .box {
    padding: 10px 12px 12px;
    border-right: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    background: var(--surface);
    min-width: 0;
  }
  .box h3 {
    margin: 0 0 4px;
    font-size: 0.875rem;
    color: var(--form);
  }
  .basis {
    margin: 0 0 6px;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  ol {
    margin: 0;
    padding-left: 1.4em;
    font-size: 0.8125rem;
  }
  li {
    margin: 4px 0;
    overflow-wrap: anywhere;
  }
  .meta {
    color: var(--ink-3);
    font-size: 0.75rem;
    margin-left: 6px;
  }
  .seq {
    font-family: var(--mono);
    font-size: 0.75rem;
  }
  .go {
    margin-left: 6px;
    white-space: nowrap;
  }
  table.small {
    margin-top: 6px;
    font-size: 0.75rem;
  }
  caption.cap {
    caption-side: top;
    text-align: left;
    padding: 0 0 2px;
    color: var(--ink-2);
  }
</style>
