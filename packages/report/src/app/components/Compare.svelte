<script lang="ts">
  import { untrack } from 'svelte';
  import {
    COMPARE_KIND_LABEL,
    COMPARE_KINDS,
    COMPARE_MIN_SESSIONS,
    COMPARE_MIN_TURNS,
    comparePhaseRows,
    compareRows,
    compareSide,
    defaultEfforts,
    defaultPeriods,
    effortChoices,
    effortModels,
    effortSplit,
    inPeriod,
    type CompareKind,
    type CompareRow,
    type CompareSession,
  } from '../../lib/compare.ts';
  import { effortLabel } from '../../lib/exec-labels.ts';
  import { MAIN_EFFORT_SHARE } from '../../lib/main-effort.ts';
  import { RETENTION_MIN_SESSIONS } from '../../lib/retention.ts';
  import { PHASE_LABEL, PHASES, type Phase } from '../../shared/turns.ts';
  import { dec, int, modelLabel, percent } from '../../lib/format.ts';
  import type { Option } from '../../lib/filter.ts';

  let {
    sessions,
    projects,
    lastAt,
    retention,
  }: {
    /** 比べる母集団(空のセッションを含めるかの条件だけを掛けたもの。上の絞り込みには従わない) */
    sessions: CompareSession[];
    projects: Option[];
    lastAt: string | null;
    /** AI の変更の残存を照合してあるか(無ければその行を出さない) */
    retention: boolean;
  } = $props();

  let kind = $state<CompareKind>('period');
  // 既定の期間は開いたときの最後の日から決める(選び直した期間を、集計の更新で上書きしない)
  const periods = untrack(() => defaultPeriods(lastAt));
  let periodA = $state({ ...periods.a });
  let periodB = $state({ ...periods.b });
  let projA = $state('');
  let projB = $state('');
  // 工程の既定は、実装と調査(依頼の多い 2 つ)
  let phaseA = $state<Phase>('implement');
  let phaseB = $state<Phase>('research');
  // 推論強度どうし: モデル・A と B の強度・期間(A と B に同じ期間を掛ける。空は限らない)
  let effModel = $state('');
  let effA = $state('');
  let effB = $state('');
  let effFrom = $state('');
  let effTo = $state('');
  const models = $derived(effortModels(sessions));
  const choices = $derived(effortChoices(sessions, effModel));
  /**
   * 選んでいる値が選択肢に無ければ(まだ選んでいない・空のセッションの条件で選択肢から消えた)、
   * 選び直す。A は先頭、B は A と違う最初のもの。選択肢にあるうちは、選んだ値を変えない
   */
  function keep(cur: string, values: string[], avoid: string | null): string {
    if (values.includes(cur)) return cur;
    return values.find((v) => v !== avoid) ?? '';
  }
  $effect(() => {
    const projs = projects.map((p) => p.value);
    const pa = keep(projA, projs, null);
    if (pa !== projA) projA = pa;
    const pb = keep(projB, projs, pa);
    if (pb !== projB) projB = pb;
    // モデルの既定はセッションのいちばん多いもの。強度の既定は medium と xhigh(無ければ多い順の 2 つ)
    const ms = models.map((m) => m.model);
    const m = ms.includes(effModel) ? effModel : (ms[0] ?? '');
    if (m !== effModel) effModel = m;
  });
  $effect(() => {
    const es = choices.map((c) => c.effort);
    const [da, db] = defaultEfforts(choices);
    const ea = es.includes(effA) ? effA : da;
    if (ea !== effA) effA = ea;
    const eb = es.includes(effB) ? effB : db;
    if (eb !== effB) effB = eb;
  });

  function pick(side: 'a' | 'b'): CompareSession[] {
    if (kind === 'period') {
      const p = side === 'a' ? periodA : periodB;
      return sessions.filter((s) => inPeriod(s, p.from, p.to));
    }
    if (kind === 'effort') return side === 'a' ? split.a : split.b;
    const key = side === 'a' ? projA : projB;
    return key ? sessions.filter((s) => s.project === key) : [];
  }
  // 推論強度どうしの母集団と、表の下に出す件数・利用者 × 週の表(同じ分類から作る)
  const split = $derived(effortSplit(sessions, effModel, effA, effB, effFrom, effTo));
  const a = $derived(compareSide(pick('a')));
  const b = $derived(compareSide(pick('b')));
  // 工程は依頼の単位で並べる(セッションの単位の行とは別の表になる)
  const rows = $derived((kind === 'phase' ? comparePhaseRows(sessions, phaseA, phaseB) : compareRows(a, b, { byTurnCount: kind === 'effort' })).filter((r) => retention || !r.key.startsWith('retention')));
  const sideLabel = (side: 'a' | 'b'): string => {
    if (kind === 'period') {
      const p = side === 'a' ? periodA : periodB;
      return `${p.from || '最初'}〜${p.to || '最後'}`;
    }
    if (kind === 'phase') return PHASE_LABEL[side === 'a' ? phaseA : phaseB];
    if (kind === 'effort') {
      const e = side === 'a' ? effA : effB;
      return e ? effortLabel(e) : '(未選択)';
    }
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
      case 'days':
        return `${dec(Math.round(v * 10) / 10)} 日`;
    }
  }
  /** 符号付きの差(割合はポイント、件数は件数) */
  function signed(r: CompareRow, d: number): string {
    const x = Math.abs(d);
    const v = r.unit === 'rate' ? Math.round(x * 1000) / 10 : r.unit === 'days' ? Math.round(x * 10) / 10 : r.unit === 'minutes' ? Math.round(x / 6000) / 10 : Math.round(x * 100) / 100;
    // 丸めて 0 になったものに符号を付けない(「−0」と出さない)
    if (v === 0) return '0';
    return `${d >= 0 ? '+' : '−'}${dec(v)}`;
  }
  const unitWord = (r: CompareRow): string => (r.unit === 'rate' ? ' ポイント' : r.unit === 'days' ? ' 日' : r.unit === 'minutes' ? ' 分' : '');
  /** 差(B − A)。割合はポイント、件数は件数 */
  function diff(r: CompareRow): string {
    if (r.a == null || r.b == null || r.key === 'sessions' || r.key === 'scored' || r.key === 'turns' && kind === 'phase' || r.key === 'retention-measured' || r.key === 'retention-hunks') return '';
    return `${signed(r, r.b - r.a)}${unitWord(r)}`;
  }
  /** 差の幅(95%)。0 をまたぐかは文字でも書く(色や印だけにしない) */
  function width(r: CompareRow): string {
    if (r.ci === undefined) return '';
    if (r.ci === null) return '—';
    const [lo, hi] = r.ci;
    const text = `${signed(r, lo)}〜${signed(r, hi)}${unitWord(r)}`;
    return lo < 0 && hi > 0 ? `${text}(0 をまたぐ)` : text;
  }
</script>

<section class="section" id="compare" aria-labelledby="compare-h">
  <div class="section-head">
    <h2 id="compare-h">比べる</h2>
    <p>
      2 つの条件(期間・プロジェクト・工程・推論強度)を並べます。上の絞り込みには従わず、全セッション(空のセッションを含めるかの条件だけ)から選びます。セッションが {COMPARE_MIN_SESSIONS} 件未満の側の割合と、割る数(記録のあるセッション)が {COMPARE_MIN_SESSIONS} 件未満の平均は「—」です。工程は依頼(ターン)の単位で並べ、依頼が {COMPARE_MIN_TURNS} 件未満の割合と平均を「—」にします(AI の変更の残存の割合は、その工程に照合できたまとまりのあるセッションが {RETENTION_MIN_SESSIONS} 件未満なら「—」)。差は相関で、条件の違いが原因とは限りません。差の幅(95%)はセッションを互いに独立とみなした近似で、同じ人のセッションは結果が似るため、実際の幅はこれより広くなります。手戻りのないセッションの割合を依頼の数で分けた行は、推論強度を比べるときだけ出します。
    </p>
  </div>

  <div class="controls">
    <div class="seg" role="group" aria-label="比べる単位">
      {#each COMPARE_KINDS as k (k)}
        <button type="button" aria-pressed={kind === k} onclick={() => (kind = k)}>{COMPARE_KIND_LABEL[k]}</button>
      {/each}
    </div>
    {#if kind === 'effort'}
      {#if models.length === 0}
        <span class="muted">本体の推論強度の記録があるセッションがありません(集計し直すと記録されます)</span>
      {:else}
        <fieldset class="side">
          <legend>モデル</legend>
          <label>
            <span class="sr-only">比べるモデル</span>
            <select value={effModel} onchange={(e) => (effModel = e.currentTarget.value)} data-testid="compare-effort-model">
              {#each models as m (m.model)}<option value={m.model}>{modelLabel(m.model)}({int(m.sessions)})</option>{/each}
            </select>
          </label>
        </fieldset>
        {#each ['a', 'b'] as const as side (side)}
          <fieldset class="side">
            <legend>{side === 'a' ? 'A' : 'B'}</legend>
            <label>
              <span class="sr-only">{side === 'a' ? 'A' : 'B'} の推論強度</span>
              <select value={side === 'a' ? effA : effB} onchange={(e) => (side === 'a' ? (effA = e.currentTarget.value) : (effB = e.currentTarget.value))} data-testid={`compare-effort-${side}`}>
                {#each choices as c (c.effort)}<option value={c.effort}>{effortLabel(c.effort)}({int(c.sessions)})</option>{/each}
              </select>
            </label>
          </fieldset>
        {/each}
        <fieldset class="side">
          <legend>期間(A と B に同じ期間)</legend>
          <label><span class="sr-only">推論強度を比べる期間の開始日</span><input type="date" value={effFrom} max={effTo || undefined} onchange={(e) => (effFrom = e.currentTarget.value)} /></label>
          <span aria-hidden="true">〜</span>
          <label><span class="sr-only">推論強度を比べる期間の終了日</span><input type="date" value={effTo} min={effFrom || undefined} onchange={(e) => (effTo = e.currentTarget.value)} /></label>
        </fieldset>
      {/if}
    {:else}
      {#each ['a', 'b'] as const as side (side)}
        <fieldset class="side">
          <legend>{side === 'a' ? 'A' : 'B'}</legend>
          {#if kind === 'period'}
            {@const p = side === 'a' ? periodA : periodB}
            <label><span class="sr-only">{side === 'a' ? 'A' : 'B'} の開始日</span><input type="date" value={p.from} max={p.to || undefined} onchange={(e) => (side === 'a' ? (periodA = { ...periodA, from: e.currentTarget.value }) : (periodB = { ...periodB, from: e.currentTarget.value }))} /></label>
            <span aria-hidden="true">〜</span>
            <label><span class="sr-only">{side === 'a' ? 'A' : 'B'} の終了日</span><input type="date" value={p.to} min={p.from || undefined} onchange={(e) => (side === 'a' ? (periodA = { ...periodA, to: e.currentTarget.value }) : (periodB = { ...periodB, to: e.currentTarget.value }))} /></label>
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
    {/if}
  </div>

  <div class="table-scroll">
    <table class="ledger" aria-labelledby="compare-h" data-testid="compare-table">
      <thead>
        <tr>
          <th scope="col">指標</th>
          <th scope="col" class="num">A: <span class="sidename">{sideLabel('a')}</span></th>
          <th scope="col" class="num">B: <span class="sidename">{sideLabel('b')}</span></th>
          <th scope="col" class="num">差(B − A)</th>
          <th scope="col" class="num">差の幅(95%)</th>
          <th scope="col">数え方</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.key)}
          <tr data-key={r.key}>
            <th scope="row" class="lab">{r.label}</th>
            <td class="num">{show(r, r.a)}</td>
            <td class="num">{show(r, r.b)}</td>
            <td class="num">{diff(r)}</td>
            <td class="num ci">{width(r)}</td>
            <td class="how">{r.note}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if kind === 'effort' && effModel}
    <p class="note" data-testid="compare-effort-excluded">
      {modelLabel(effModel)} の本体の推論強度が混在のセッション {int(split.mixed)} 件・記録なし {int(split.none)} 件は、A と B のどちらにも入れていません(本体のリクエストの {Math.round(MAIN_EFFORT_SHARE * 100)}% 以上が同じ強度のセッションだけを数えます。期間の中の件数)。
    </p>
    {#if split.weeks.length > 0}
      <div class="table-scroll weeks">
        <table class="ledger" aria-labelledby="compare-weeks-h" data-testid="compare-effort-weeks">
          <caption id="compare-weeks-h" class="cap">{split.byPerson ? '利用者 × 週' : '週'}ごとのセッション数({modelLabel(effModel)}。週は月曜から)</caption>
          <thead>
            <tr>
              {#if split.byPerson}<th scope="col">利用者</th>{/if}
              <th scope="col">週</th>
              <th scope="col" class="num">A: {effA ? effortLabel(effA) : '(未選択)'}</th>
              <th scope="col" class="num">B: {effB ? effortLabel(effB) : '(未選択)'}</th>
              <th scope="col" class="num">混在</th>
              <th scope="col" class="num">記録なし</th>
            </tr>
          </thead>
          <tbody>
            {#each split.weeks as w (`${w.person ?? ''}\u0000${w.week}`)}
              <tr>
                {#if split.byPerson}<td class="nowrap">{w.person ?? '(記録なし)'}</td>{/if}
                <td class="nowrap">{w.week}〜</td>
                <td class="num">{int(w.a)}</td>
                <td class="num">{int(w.b)}</td>
                <td class="num">{int(w.mixed)}</td>
                <td class="num">{int(w.none)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
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
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 2px 8px 4px;
    border: 1px solid var(--rule);
    min-width: 0;
    max-width: 100%;
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
    /* 短い名前(medium など)が語の途中で割れないよう、最小の幅を持たせる。長い名前はこれまでどおり途中で折り返す */
    display: inline-block;
    min-width: 4em;
    font-weight: normal;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .ci {
    white-space: normal;
    min-width: 9em;
  }
  .how {
    min-width: 14em;
    white-space: normal;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  .nowrap {
    white-space: nowrap;
  }
  .weeks {
    margin-top: 10px;
  }
  .cap {
    caption-side: top;
    text-align: left;
    font-size: 0.8125rem;
    color: var(--ink-2);
    padding-bottom: 4px;
  }
</style>
