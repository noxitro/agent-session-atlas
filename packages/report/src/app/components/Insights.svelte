<script lang="ts">
  // Phase 12: 改善点(LLM を呼ばない規則の集計)。指示文・skill・時間の使われ方は絞り込みに従って再計算する。
  // ただし「長いのに注入が少ない」は全体での希少さの話なので allSessions で計算する。
  // スキル化の候補は build 時に全セッションで計算したもの(埋め込み)を出す。全件は insights.html
  import { shortProjectLabel } from '../../lib/anonymize.ts';
  import { dec, duration, int } from '../../lib/format.ts';
  import { instructionFindings, instructionVersions, skillStats, stuckByProject, stuckSessions, THRESHOLDS, type Candidate, type VersionMeta } from '../../lib/insights.ts';
  import type { SessionSummary } from '../../lib/types.ts';

  let {
    sessions,
    allSessions,
    installed,
    meta,
    candidates,
    computedOver,
    anonymized,
    hasPage,
    libraryHref,
  }: {
    sessions: SessionSummary[];
    /** 絞り込み前の全セッション */
    allSessions: SessionSummary[];
    installed: string[] | null;
    /** 指示文の版の見出し等(伏せ字版では空) */
    meta: Record<string, VersionMeta>;
    candidates: Candidate[];
    computedOver: number;
    anonymized: boolean;
    /** insights.html を作ったか(export / build どちらでも作る) */
    hasPage: boolean;
    libraryHref: string | null;
  } = $props();

  const versions = $derived(instructionVersions(sessions));
  const findings = $derived(instructionFindings(versions, meta, sessions.length));
  const longRare = $derived(instructionFindings(instructionVersions(allSessions), meta, allSessions.length).longRare);
  const skills = $derived(skillStats(sessions, installed));
  const stuck = $derived(stuckSessions(sessions));
  const byProject = $derived(stuckByProject(stuck, sessions));
  const TOP = 5;
  const pct = (v: number | null): string => (v == null ? '—' : `${dec(v * 100)}%`);
  const vname = (hash: string): string => {
    const m = meta[hash];
    return m && !anonymized ? `${m.heading.replace(/^#+\s*/, '').slice(0, 40)} 版 ${m.order + 1}` : hash;
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
  <div class="grid">
    <div class="box" data-testid="insights-instructions">
      <h3>指示文の傾向</h3>
      {#if longRare.length === 0 && findings.worsened.length === 0}
        <p class="basis">挙げる傾向はありません(版 {int(versions.length)}、前後比較ができなかった見出し {int(findings.comparedInsufficient)})。</p>
      {:else}
        <ol>
          {#each longRare.slice(0, TOP) as v (v.hash)}
            <li>長いのに注入が少ない(全セッション基準): {#if vhref(v.hash)}<a href={vhref(v.hash)}>{vname(v.hash)}</a>{:else}{vname(v.hash)}{/if}({int(v.chars)} 字、{int(v.sessions)} セッション)</li>
          {/each}
          {#each findings.worsened.slice(0, TOP) as w (w.after.hash)}
            <li>
              版を変えた前後で悪化: {#if vhref(w.after.hash)}<a href={vhref(w.after.hash)}>{vname(w.after.hash)}</a>{:else}{vname(w.after.hash)}{/if}(失敗率 {w.failureDelta == null ? '—' : `${w.failureDelta >= 0 ? '+' : ''}${dec(w.failureDelta)} pt`}、手戻り率 {w.reworkDelta >= 0 ? '+' : ''}{dec(w.reworkDelta)} pt、{int(w.before.sessions)} → {int(w.after.sessions)} セッション)
            </li>
          {/each}
        </ol>
      {/if}
      {#if versions.length}
        <table class="ledger small">
          <thead><tr><th scope="col">版</th><th scope="col" class="num">字数</th><th scope="col" class="num">セッション</th><th scope="col" class="num">失敗率</th><th scope="col" class="num">手戻り率</th></tr></thead>
          <tbody>
            {#each versions.slice(0, TOP) as v (v.hash)}
              <tr><td>{#if vhref(v.hash)}<a href={vhref(v.hash)}>{vname(v.hash)}</a>{:else}{vname(v.hash)}{/if}</td><td class="num">{int(v.chars)}</td><td class="num">{int(v.sessions)}</td><td class="num">{v.enough ? pct(v.failureRate) : '—'}</td><td class="num">{v.enough ? pct(v.reworkRate) : '—'}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <div class="box" data-testid="insights-skills">
      <h3>skill の傾向</h3>
      {#if skills.stats.length === 0}
        <p class="basis">skill の呼び出しはありません。</p>
      {:else}
        <table class="ledger small">
          <thead><tr><th scope="col">skill</th><th scope="col" class="num">呼び出し</th><th scope="col" class="num">字数</th><th scope="col" class="num">失敗率(呼んだ / 呼ばない)</th></tr></thead>
          <tbody>
            {#each skills.stats.slice(0, TOP) as s (s.name)}
              <tr><td>{s.name}</td><td class="num">{int(s.calls)}</td><td class="num">{s.chars == null ? '—' : int(s.chars)}</td><td class="num">{pct(s.failureWith)} / {pct(s.failureWithout)}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#if skills.unused.length}<p class="basis">インストール済みで未使用: {skills.unused.join('、')}</p>{/if}
    </div>

    <div class="box" data-testid="insights-stuck">
      <h3>止まっている箇所</h3>
      {#if stuck.length === 0}
        <p class="basis">閾値を超えたセッションはありません。</p>
      {:else}
        <p class="basis">{int(stuck.length)} セッションが閾値(待ち {duration(THRESHOLDS.STUCK.ttftMs)} 以上、失敗の連続 {THRESHOLDS.STUCK.consecutiveFailures} 回以上、再編集 {THRESHOLDS.STUCK.extraEdits} 回以上、権限確認 {THRESHOLDS.STUCK.permissions} 件以上、compaction {THRESHOLDS.STUCK.compactions} 回以上)を超えています。</p>
        <ol>
          {#each stuck.slice(0, TOP) as x (x.id)}
            <li><a href={x.href}>{sessionLabel(x.id)}</a>: {x.reasons.join('、')}{#if x.ttftMedian != null}(TTFT 中央値 {duration(x.ttftMedian)}){/if}</li>
          {/each}
        </ol>
        {#if byProject.length}
          <p class="basis">プロジェクト別({THRESHOLDS.MIN_SESSIONS} セッション以上のもの): {byProject.slice(0, TOP).map((p) => `${anonymized ? p.project : shortProjectLabel(p.projectLabel)} ${int(p.stuck)} / ${int(p.total)}`).join('、')}</p>
        {/if}
      {/if}
    </div>

    <div class="box" data-testid="insights-candidates">
      <h3>スキル化の候補</h3>
      <p class="basis">全セッション({int(computedOver)} 件、絞り込み前)で計算。似た依頼文の繰り返しと同じツールの並びの繰り返し({THRESHOLDS.MIN_REPEAT} 回以上)。スコアは回数 × 所要の中央値(分、2 時間で頭打ち)。</p>
      {#if candidates.length === 0}
        <p class="basis">候補はありません。</p>
      {:else}
        <ol>
          {#each candidates.slice(0, TOP) as c, i (c.key)}
            <li>
              {#if c.kind === 'tools'}<span class="seq">{c.key}</span>{:else if anonymized}依頼文の繰り返し{:else}{(c.representative ?? c.key).replace(/\s+/g, ' ').slice(0, 70)}{/if}
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
</style>
