<script lang="ts">
  import { untrack } from 'svelte';
  import { COMPARE_KIND_LABEL, COMPARE_KINDS, COMPARE_MIN_SESSIONS, COMPARE_MIN_TURNS, comparePhaseRows, compareRows, compareSide, defaultPeriods, inPeriod, type CompareKind, type CompareRow, type CompareSession } from '../../lib/compare.ts';
  import { PHASE_LABEL, PHASES, type Phase } from '../../../../core/src/turns.ts';
  import { dec, int, percent } from '../../lib/format.ts';
  import type { Option } from '../../lib/filter.ts';

  let {
    sessions,
    groups,
    projects,
    lastAt,
    retention,
  }: {
    /** 比べる母集団(空のセッションを含めるかの条件だけを掛けたもの。上の絞り込みには従わない) */
    sessions: CompareSession[];
    groups: { name: string; presentIds: string[] }[];
    projects: Option[];
    lastAt: string | null;
    /** AI の変更の残存を照合してあるか(無ければその行を出さない) */
    retention: boolean;
  } = $props();

  const usableGroups = $derived(groups.filter((g) => g.presentIds.length > 0));
  let kind = $state<CompareKind>('period');
  // 既定の期間は開いたときの最後の日から決める(選び直した期間を、集計の更新で上書きしない)
  const periods = untrack(() => defaultPeriods(lastAt));
  let periodA = $state({ ...periods.a });
  let periodB = $state({ ...periods.b });
  let tagA = $state('');
  let tagB = $state('');
  let projA = $state('');
  let projB = $state('');
  // 工程の既定は、実装と調査(依頼の多い 2 つ)
  let phaseA = $state<Phase>('implement');
  let phaseB = $state<Phase>('research');
  /**
   * 選んでいる値が選択肢に無ければ(まだ選んでいない・タグの名前を変えた / 消した・空のセッションの条件で選択肢から消えた)、
   * 選び直す。A は先頭、B は A と違う最初のもの。選択肢にあるうちは、選んだ値を変えない
   */
  function keep(cur: string, values: string[], avoid: string | null): string {
    if (values.includes(cur)) return cur;
    return values.find((v) => v !== avoid) ?? '';
  }
  $effect(() => {
    const tags = usableGroups.map((g) => g.name);
    const projs = projects.map((p) => p.value);
    const a = keep(tagA, tags, null);
    if (a !== tagA) tagA = a;
    const b = keep(tagB, tags, a);
    if (b !== tagB) tagB = b;
    const pa = keep(projA, projs, null);
    if (pa !== projA) projA = pa;
    const pb = keep(projB, projs, pa);
    if (pb !== projB) projB = pb;
  });

  function pick(side: 'a' | 'b'): CompareSession[] {
    if (kind === 'period') {
      const p = side === 'a' ? periodA : periodB;
      return sessions.filter((s) => inPeriod(s, p.from, p.to));
    }
    if (kind === 'tag') {
      const g = usableGroups.find((x) => x.name === (side === 'a' ? tagA : tagB));
      const ids = new Set(g?.presentIds ?? []);
      return sessions.filter((s) => ids.has(s.id));
    }
    const key = side === 'a' ? projA : projB;
    return key ? sessions.filter((s) => s.project === key) : [];
  }
  const a = $derived(compareSide(pick('a')));
  const b = $derived(compareSide(pick('b')));
  // 工程は依頼の単位で並べる(セッションの単位の行とは別の表になる)
  const rows = $derived((kind === 'phase' ? comparePhaseRows(sessions, phaseA, phaseB) : compareRows(a, b)).filter((r) => retention || !r.key.startsWith('retention')));
  const sideLabel = (side: 'a' | 'b'): string => {
    if (kind === 'period') {
      const p = side === 'a' ? periodA : periodB;
      return `${p.from || '最初'}〜${p.to || '最後'}`;
    }
    if (kind === 'tag') return (side === 'a' ? tagA : tagB) || '(未選択)';
    if (kind === 'phase') return PHASE_LABEL[side === 'a' ? phaseA : phaseB];
    const key = side === 'a' ? projA : projB;
    return projects.find((p) => p.value === key)?.label ?? '(未選択)';
  };

  function show(r: CompareRow, v: number | null): string {
    if (v == null) return '—';
    switch (r.unit) {
      case 'count':
        return int(v);
      case 'rate':
        return percent(v, 1);
      case 'mean':
        return dec(Math.round(v * 10) / 10);
      case 'minutes':
        return `${dec(Math.round(v / 6000) / 10)} 分`;
      case 'aiu':
        return dec(Math.round(v * 100) / 100);
    }
  }
  /** 差(B − A)。割合はポイント、件数は件数 */
  function diff(r: CompareRow): string {
    if (r.a == null || r.b == null || r.key === 'sessions' || r.key === 'turns' && kind === 'phase' || r.key === 'retention-measured' || r.key === 'retention-hunks') return '';
    const d = r.b - r.a;
    if (r.unit === 'rate') return `${d >= 0 ? '+' : '−'}${dec(Math.round(Math.abs(d) * 1000) / 10)} ポイント`;
    if (r.unit === 'minutes') return `${d >= 0 ? '+' : '−'}${dec(Math.round(Math.abs(d) / 6000) / 10)} 分`;
    return `${d >= 0 ? '+' : '−'}${dec(Math.round(Math.abs(d) * 100) / 100)}`;
  }
</script>

<section class="section" id="compare" aria-labelledby="compare-h">
  <div class="section-head">
    <h2 id="compare-h">比べる</h2>
    <p>
      2 つの条件(タスクタグ・期間・プロジェクト・工程)を並べます。上の絞り込みには従わず、全セッション(空のセッションを含めるかの条件だけ)から選びます。セッションが {COMPARE_MIN_SESSIONS} 件未満の側の割合と、割る数(記録のあるセッション)が {COMPARE_MIN_SESSIONS} 件未満の平均は「—」です。工程は依頼(ターン)の単位で並べ、依頼かまとまりが {COMPARE_MIN_TURNS} 件未満の割合と平均を「—」にします。差は相関で、条件の違いが原因とは限りません。
    </p>
  </div>

  <div class="controls">
    <div class="seg" role="group" aria-label="比べる単位">
      {#each COMPARE_KINDS as k (k)}
        <button type="button" aria-pressed={kind === k} onclick={() => (kind = k)}>{COMPARE_KIND_LABEL[k]}</button>
      {/each}
    </div>
    {#each ['a', 'b'] as const as side (side)}
      <fieldset class="side">
        <legend>{side === 'a' ? 'A' : 'B'}</legend>
        {#if kind === 'period'}
          {@const p = side === 'a' ? periodA : periodB}
          <label><span class="sr-only">{side === 'a' ? 'A' : 'B'} の開始日</span><input type="date" value={p.from} max={p.to || undefined} onchange={(e) => (side === 'a' ? (periodA = { ...periodA, from: e.currentTarget.value }) : (periodB = { ...periodB, from: e.currentTarget.value }))} /></label>
          <span aria-hidden="true">〜</span>
          <label><span class="sr-only">{side === 'a' ? 'A' : 'B'} の終了日</span><input type="date" value={p.to} min={p.from || undefined} onchange={(e) => (side === 'a' ? (periodA = { ...periodA, to: e.currentTarget.value }) : (periodB = { ...periodB, to: e.currentTarget.value }))} /></label>
        {:else if kind === 'tag'}
          {#if usableGroups.length === 0}
            <span class="muted">タスクタグがありません(セッション一覧で選んで作れます)</span>
          {:else}
            <label>
              <span class="sr-only">{side === 'a' ? 'A' : 'B'} のタスクタグ</span>
              <select value={side === 'a' ? tagA : tagB} onchange={(e) => (side === 'a' ? (tagA = e.currentTarget.value) : (tagB = e.currentTarget.value))}>
                {#each usableGroups as g (g.name)}<option value={g.name}>{g.name}({int(g.presentIds.length)})</option>{/each}
              </select>
            </label>
          {/if}
        {:else if kind === 'phase'}
          <label>
            <span class="sr-only">{side === 'a' ? 'A' : 'B'} の工程</span>
            <select value={side === 'a' ? phaseA : phaseB} onchange={(e) => (side === 'a' ? (phaseA = e.currentTarget.value as Phase) : (phaseB = e.currentTarget.value as Phase))}>
              {#each PHASES as ph (ph)}<option value={ph}>{PHASE_LABEL[ph]}</option>{/each}
            </select>
          </label>
        {:else}
          <label>
            <span class="sr-only">{side === 'a' ? 'A' : 'B'} のプロジェクト</span>
            <select value={side === 'a' ? projA : projB} onchange={(e) => (side === 'a' ? (projA = e.currentTarget.value) : (projB = e.currentTarget.value))}>
              {#each projects as o (o.value)}<option value={o.value}>{o.label}({int(o.count)})</option>{/each}
            </select>
          </label>
        {/if}
      </fieldset>
    {/each}
  </div>

  <div class="table-scroll">
    <table class="ledger" aria-labelledby="compare-h">
      <thead>
        <tr>
          <th scope="col">指標</th>
          <th scope="col" class="num">A: <span class="sidename">{sideLabel('a')}</span></th>
          <th scope="col" class="num">B: <span class="sidename">{sideLabel('b')}</span></th>
          <th scope="col" class="num">差(B − A)</th>
          <th scope="col">数え方</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.key)}
          <tr>
            <th scope="row" class="lab">{r.label}</th>
            <td class="num">{show(r, r.a)}</td>
            <td class="num">{show(r, r.b)}</td>
            <td class="num">{diff(r)}</td>
            <td class="how">{r.note}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    margin: 4px 0 10px;
  }
  .side {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 2px 8px 4px;
    border: 1px solid var(--rule);
  }
  .side legend {
    font-size: 0.75rem;
    color: var(--form);
    padding: 0 4px;
  }
  input[type='date'],
  select {
    font: inherit;
    font-size: 0.8125rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 3px 6px;
    height: 30px;
    max-width: 16em;
  }
  input[type='date'] {
    max-width: 10em;
  }
  select:hover,
  input[type='date']:hover {
    border-color: var(--form);
  }
  .lab {
    font-weight: normal;
    min-width: 12em;
  }
  .sidename {
    font-weight: normal;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .how {
    min-width: 14em;
    white-space: normal;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
</style>
