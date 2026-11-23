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
    defaultModels,
    defaultPeriods,
    effortChoices,
    effortModels,
    effortSplit,
    inPeriod,
    modelChoices,
    modelEffortChoices,
    modelSplit,
    wikiSplit,
    type CompareKind,
    type CompareRow,
    type CompareSession,
  } from '../../lib/compare.ts';
  import { hasPersons, personPhasePaired, personSessionPaired, type PersonPairedRow } from '../../lib/compare-person.ts';
  import { effortLabel } from '../../lib/exec-labels.ts';
  import { wikiStateNote, type WikiState } from '../../lib/wiki.ts';
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
    wiki,
  }: {
    /** 比べる母集団(空のセッションを含めるかの条件だけを掛けたもの。上の絞り込みには従わない) */
    sessions: CompareSession[];
    projects: Option[];
    lastAt: string | null;
    /** AI の変更の残存を照合してあるか(無ければその行を出さない) */
    retention: boolean;
    /** llm-wiki の参照を数えた集計か(数えていなければ wiki の参照では比べられない) */
    wiki: WikiState;
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
  // 選択肢は全期間から作り(期間を変えても選んだ値が消えないように)、件数は選んだ期間の中で数える(モデルどうしと同じ)
  const models = $derived(effortModels(sessions));
  const choices = $derived(effortChoices(sessions, effModel));
  const effPool = $derived(sessions.filter((s) => inPeriod(s, effFrom, effTo)));
  const effModelCount = $derived(new Map(effortModels(effPool).map((m) => [m.model, m.sessions])));
  const effChoiceCount = $derived(new Map(effortChoices(effPool, effModel).map((c) => [c.effort, c.sessions])));
  // モデルどうし: A と B のモデル・強度(空はすべて)・期間(A と B に同じ期間)
  let modelA = $state('');
  let modelB = $state('');
  let modelEffort = $state('');
  let modelFrom = $state('');
  let modelTo = $state('');
  // 選択肢は全期間から作り(期間を変えても選んだ値が消えないように)、件数は選んだ期間の中で数える
  const mainModels = $derived(modelChoices(sessions));
  const modelPool = $derived(sessions.filter((s) => inPeriod(s, modelFrom, modelTo)));
  // 強度を 1 つ選んだときは、その強度と決まったセッションで数える(表の A・B の母集団と同じ)
  const modelCount = $derived(new Map(modelChoices(modelPool, modelEffort).map((c) => [c.model, c.sessions])));
  const modelEfforts = $derived(modelEffortChoices(sessions, modelA, modelB));
  const modelEffortCount = $derived(new Map(modelEffortChoices(modelPool, modelA, modelB).map((c) => [c.effort, c])));
  // wiki の参照: 期間(A と B に同じ期間)。数えていない集計では選べない(理由を出す)
  let wikiFrom = $state('');
  let wikiTo = $state('');
  const wikiNote = $derived(wikiStateNote(wiki));
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
    // モデルどうしの既定は、本体と決まったセッションの多い順の 2 つ
    const mm = mainModels.map((x) => x.model);
    const [dma, dmb] = defaultModels(mainModels);
    const ma = mm.includes(modelA) ? modelA : dma;
    if (ma !== modelA) modelA = ma;
    const mb = mm.includes(modelB) ? modelB : dmb;
    if (mb !== modelB) modelB = mb;
  });
  $effect(() => {
    // 選んでいた強度が、選び直したモデルの選択肢に無ければ「すべて」に戻す
    if (modelEffort && !modelEfforts.some((c) => c.effort === modelEffort)) modelEffort = '';
  });
  $effect(() => {
    // 数えていない集計に切り替わったら(集計の更新で)、wiki の参照から外す
    if (kind === 'wiki' && wikiNote) kind = 'period';
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
    if (kind === 'model') return side === 'a' ? mSplit.a : mSplit.b;
    if (kind === 'wiki') return side === 'a' ? wSplit.a : wSplit.b;
    const key = side === 'a' ? projA : projB;
    return key ? sessions.filter((s) => s.project === key) : [];
  }
  // 推論強度どうしの母集団と、表の下に出す件数・利用者 × 週の表(同じ分類から作る)
  const split = $derived(effortSplit(sessions, effModel, effA, effB, effFrom, effTo));
  const mSplit = $derived(modelSplit(sessions, modelA, modelB, modelEffort, modelFrom, modelTo));
  const wSplit = $derived(wikiSplit(sessions, wikiFrom, wikiTo));
  const listA = $derived(pick('a'));
  const listB = $derived(pick('b'));
  const a = $derived(compareSide(listA));
  const b = $derived(compareSide(listB));
  // テストの結果の記録が母集団のどこにも無ければ、テストの行を出さない(照合していないときに残存の行を出さないのと同じ)
  const hasTests = $derived(sessions.some((s) => s.tests != null));
  // 工程は依頼の単位で並べる(セッションの単位の行とは別の表になる)
  const shown = (key: string): boolean => (retention || !key.startsWith('retention')) && (hasTests || !key.startsWith('tests'));
  const rows = $derived((kind === 'phase' ? comparePhaseRows(sessions, phaseA, phaseB) : compareRows(a, b, { byTurnCount: kind === 'effort' })).filter((r) => shown(r.key)));
  // 人ごとの差(人の記録が 2 人以上あるときだけ)。行は上の表に出す行だけ
  const byPerson = $derived(hasPersons(sessions));
  const persons = $derived(byPerson ? (kind === 'phase' ? personPhasePaired(sessions, phaseA, phaseB) : personSessionPaired(listA, listB)) : null);
  const personRows = $derived(persons ? persons.rows.filter((r) => shown(r.key)) : []);
  const personRetention = $derived(persons && retention && persons.retention ? persons.retention : null);
  const countWord = $derived(kind === 'phase' ? '依頼' : 'セッション');
  const minCount = $derived(kind === 'phase' ? COMPARE_MIN_TURNS : COMPARE_MIN_SESSIONS);
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
    if (kind === 'model') {
      const m = side === 'a' ? modelA : modelB;
      return m ? `${modelLabel(m)}${modelEffort ? `(${effortLabel(modelEffort)})` : ''}` : '(未選択)';
    }
    if (kind === 'wiki') return side === 'a' ? 'wiki を参照した' : 'wiki を参照していない';
    const key = side === 'a' ? projA : projB;
    return projects.find((p) => p.value === key)?.label ?? '(未選択)';
  };

  function show(r: Pick<CompareRow, 'unit'>, v: number | null): string {
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
  function signed(r: Pick<CompareRow, 'unit'>, d: number): string {
    const x = Math.abs(d);
    const v = r.unit === 'rate' ? Math.round(x * 1000) / 10 : r.unit === 'days' ? Math.round(x * 10) / 10 : r.unit === 'minutes' ? Math.round(x / 6000) / 10 : Math.round(x * 100) / 100;
    // 丸めて 0 になったものに符号を付けない(「−0」と出さない)
    if (v === 0) return '0';
    return `${d >= 0 ? '+' : '−'}${dec(v)}`;
  }
  const unitWord = (r: Pick<CompareRow, 'unit'>): string => (r.unit === 'rate' ? ' ポイント' : r.unit === 'days' ? ' 日' : r.unit === 'minutes' ? ' 分' : '');
  /** 差(B − A)。割合はポイント、件数は件数 */
  function diff(r: CompareRow): string {
    if (r.a == null || r.b == null || r.key === 'sessions' || r.key === 'scored' || r.key === 'tests-scored' || r.key === 'turns' && kind === 'phase' || r.key === 'retention-measured' || r.key === 'retention-hunks') return '';
    return `${signed(r, r.b - r.a)}${unitWord(r)}`;
  }
  /** 差の幅(95%)。0 をまたぐかは文字でも書く(色や印だけにしない) */
  function width(r: Pick<CompareRow, 'unit' | 'ci'>): string {
    if (r.ci === undefined) return '';
    if (r.ci === null) return '—';
    const [lo, hi] = r.ci;
    const text = `${signed(r, lo)}〜${signed(r, hi)}${unitWord(r)}`;
    return lo < 0 && hi > 0 ? `${text}(0 をまたぐ)` : text;
  }
  /** 人ごとの差の平均(B − A) */
  const personMean = (r: PersonPairedRow): string => (r.mean == null ? '—' : `${signed(r, r.mean)}${unitWord(r)}`);
  /** 人を単位にした幅。2 人未満で出さないときは、使えた人の数を添える */
  function personWidth(r: PersonPairedRow): string {
    if (r.ci) return `${width(r)}${r.clipped ? '(端で切った)' : ''}`;
    return r.persons === 0 ? '—' : `—(使えた人が ${r.persons} 人)`;
  }
  /** 人ごとの表の 1 つの値: その人の差。値の出ない人は — */
  const personCell = (r: PersonPairedRow, i: number): string => {
    const d = r.diffs[i];
    return d == null ? '—' : `${signed(r, d)}${unitWord(r)}`;
  };
  const lagText = (d: number | null): string => (d == null ? '—' : `${dec(Math.round(d * 10) / 10)} 日`);
  /** 人ごとの表の値の下に添える A → B */
  function personAB(key: string, i: number): string {
    const g = persons?.groups[i];
    const row = g?.eligible ? g.rows.find((x) => x.key === key) : undefined;
    if (!row || row.a == null || row.b == null) return '';
    return `${show(row, row.a)} → ${show(row, row.b)}`;
  }
</script>

<section class="section" id="compare" aria-labelledby="compare-h">
  <div class="section-head">
    <h2 id="compare-h">比べる</h2>
    <p data-testid="compare-lead">2 つの条件(期間・プロジェクト・工程・推論強度・モデル・wiki の参照)を並べます。差は相関で、条件の違いが原因とは限りません。</p>
    <details class="notes" data-testid="compare-notes">
      <summary>数え方と注意</summary>
      <p>
      上の絞り込みには従わず、全セッション(空のセッションを含めるかの条件だけ)から選びます。セッションが {COMPARE_MIN_SESSIONS} 件未満の側の割合と、割る数(記録のあるセッション)が {COMPARE_MIN_SESSIONS} 件未満の平均は「—」です。工程は依頼(ターン)の単位で並べ、依頼が {COMPARE_MIN_TURNS} 件未満の割合と平均を「—」にします(AI の変更の残存の割合は、その工程に照合できたまとまりのあるセッションが {RETENTION_MIN_SESSIONS} 件未満なら「—」)。差の幅(95%)はセッションを互いに独立とみなした近似で、同じ人のセッションは結果が似るため、実際の幅はこれより広くなります{#if byPerson}(人の違いの影響を減らした比べ方は、表の下の「人ごとの差」){/if}。モデルどうしは、本体のモデルと推論強度の組が決まったセッション(本体のリクエストの {Math.round(MAIN_EFFORT_SHARE * 100)}% 以上が同じ組。推論強度どうしと同じ決め方)を、選んだモデルで分けます。wiki の参照は、llm-wiki を参照したセッション(改善点の llm-wiki の箱・絞り込みと同じ決め方。書き込みだけのセッションは参照していない側)と参照していないセッションを分けます。手戻りのないセッションの割合を依頼の数で分けた行は、推論強度を比べるときだけ出します。テストの結果の 2 行は、テストを実行したセッション(テストの結果の記録が 1 回以上あるもの。その数も並べます)を割る数にし、それが {COMPARE_MIN_SESSIONS} 件未満の側は「—」です(テストの記録のあるセッションが無いときと、工程どうしでは出しません)。テストを走らせるか・いつ走らせるかは条件で変わりうるので、テストを実行したセッションの数も見比べてください。最初の実行は、そのとき走らせたテストだけの結果です。
      </p>
    </details>
  </div>

  <div class="controls">
    <div class="seg" role="group" aria-label="比べる単位">
      {#each COMPARE_KINDS as k (k)}
        {@const off = k === 'wiki' && wikiNote != null}
        <button type="button" aria-pressed={kind === k} disabled={off} aria-describedby={off ? 'compare-wiki-off' : undefined} onclick={() => (kind = k)}>{COMPARE_KIND_LABEL[k]}</button>
      {/each}
    </div>
    {#if kind === 'model'}
      {#if mainModels.length === 0}
        <span class="muted">本体のモデルと推論強度が決まったセッションがありません(集計し直すと記録されます)</span>
      {:else}
        {#each ['a', 'b'] as const as side (side)}
          <fieldset class="side">
            <legend>{side === 'a' ? 'A' : 'B'}</legend>
            <label>
              <span class="sr-only">{side === 'a' ? 'A' : 'B'} のモデル</span>
              <select value={side === 'a' ? modelA : modelB} onchange={(e) => (side === 'a' ? (modelA = e.currentTarget.value) : (modelB = e.currentTarget.value))} data-testid={`compare-model-${side}`}>
                {#each mainModels as m (m.model)}<option value={m.model}>{modelLabel(m.model)}(期間内 {int(modelCount.get(m.model) ?? 0)})</option>{/each}
              </select>
            </label>
          </fieldset>
        {/each}
        <fieldset class="side">
          <legend>推論強度(A と B に同じ強度)</legend>
          <label>
            <span class="sr-only">モデルを比べる推論強度</span>
            <select value={modelEffort} onchange={(e) => (modelEffort = e.currentTarget.value)} data-testid="compare-model-effort">
              <option value="">すべて</option>
              {#each modelEfforts as c (c.effort)}<option value={c.effort}>{effortLabel(c.effort)}(期間内 A {int(modelEffortCount.get(c.effort)?.a ?? 0)}・B {int(modelEffortCount.get(c.effort)?.b ?? 0)})</option>{/each}
            </select>
          </label>
        </fieldset>
        <fieldset class="side">
          <legend>期間(A と B に同じ期間)</legend>
          <label><span class="sr-only">モデルを比べる期間の開始日</span><input type="date" value={modelFrom} max={modelTo || undefined} onchange={(e) => (modelFrom = e.currentTarget.value)} /></label>
          <span aria-hidden="true">〜</span>
          <label><span class="sr-only">モデルを比べる期間の終了日</span><input type="date" value={modelTo} min={modelFrom || undefined} onchange={(e) => (modelTo = e.currentTarget.value)} /></label>
        </fieldset>
      {/if}
    {:else if kind === 'wiki'}
      <fieldset class="side">
        <legend>期間(A と B に同じ期間)</legend>
        <label><span class="sr-only">wiki の参照で比べる期間の開始日</span><input type="date" value={wikiFrom} max={wikiTo || undefined} onchange={(e) => (wikiFrom = e.currentTarget.value)} /></label>
        <span aria-hidden="true">〜</span>
        <label><span class="sr-only">wiki の参照で比べる期間の終了日</span><input type="date" value={wikiTo} min={wikiFrom || undefined} onchange={(e) => (wikiTo = e.currentTarget.value)} /></label>
      </fieldset>
    {:else if kind === 'effort'}
      {#if models.length === 0}
        <span class="muted">本体の推論強度の記録があるセッションがありません(集計し直すと記録されます)</span>
      {:else}
        <fieldset class="side">
          <legend>モデル</legend>
          <label>
            <span class="sr-only">比べるモデル</span>
            <select value={effModel} onchange={(e) => (effModel = e.currentTarget.value)} data-testid="compare-effort-model">
              {#each models as m (m.model)}<option value={m.model}>{modelLabel(m.model)}(期間内 {int(effModelCount.get(m.model) ?? 0)})</option>{/each}
            </select>
          </label>
        </fieldset>
        {#each ['a', 'b'] as const as side (side)}
          <fieldset class="side">
            <legend>{side === 'a' ? 'A' : 'B'}</legend>
            <label>
              <span class="sr-only">{side === 'a' ? 'A' : 'B'} の推論強度</span>
              <select value={side === 'a' ? effA : effB} onchange={(e) => (side === 'a' ? (effA = e.currentTarget.value) : (effB = e.currentTarget.value))} data-testid={`compare-effort-${side}`}>
                {#each choices as c (c.effort)}<option value={c.effort}>{effortLabel(c.effort)}(期間内 {int(effChoiceCount.get(c.effort) ?? 0)})</option>{/each}
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
  {#if wikiNote}
    <p class="note" id="compare-wiki-off" data-testid="compare-wiki-off">「wiki の参照」は選べません。{wikiNote}</p>
  {/if}

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
  {#if kind === 'model' && modelA}
    <p class="note" data-testid="compare-model-excluded">
      {modelLabel(modelA)}{modelB !== modelA ? `・${modelLabel(modelB)}` : ''} のセッションのうち、本体が混在のセッション {int(mSplit.mixed)} 件・記録なし {int(mSplit.none)} 件は、A と B のどちらにも入れていません(本体のリクエストの {Math.round(MAIN_EFFORT_SHARE * 100)}% 以上が同じモデルと推論強度の組のセッションだけを数えます。強度を「すべて」にしても、同じモデルで強度が混ざったセッションは混在です。期間の中の件数)。強度を途中で変えたセッション(どの組も本体のリクエストの {Math.round(MAIN_EFFORT_SHARE * 100)}% に届かないもの)は、A と B のどちらにも入りません。いつも強度を混ぜて使ったモデルは、本体と決まったセッションが無いので、モデルの選択肢に出ません。{modelEffort ? `A と B のモデルで、本体の強度が ${effortLabel(modelEffort)} 以外と決まったセッションも入れていません。` : ''}
    </p>
  {/if}
  {#if persons}
    <div class="persons" data-testid="compare-person">
      <h3 id="compare-person-h">人ごとの差</h3>
      <p class="sides" data-testid="compare-person-sides">A: {sideLabel('a')} / B: {sideLabel('b')}{#if kind === 'wiki'}。差(B − A)は「wiki を参照していない − 参照した」です{/if}</p>
      <p class="note" data-testid="compare-person-lead">同じ人の中での差を平均したもので、人の違いの影響を減らします。差は相関で、条件の違いが原因とは限りません。</p>
      <details class="notes" data-testid="compare-person-notes">
        <summary>数え方と注意</summary>
        <p class="note">
        人の数が少ないと幅は広くなります。両方の側にそれぞれ {countWord} {minCount} 件以上ある人だけを使います(記録のある {int(persons.groups.length)} 人のうち {int(persons.eligible)} 人)。行ごとに、その人の A と B の値がどちらも出ているもの(上の表と同じ「—」の決まり)の差(B − A)を、人を単位にして平均します。差の幅(95%)は、人ごとの差の平均 ± t × 標準偏差 ÷ √人数(t は自由度 = 使えた人の数 − 1 の t 分布の値)で、使えた人が 2 人未満の行には出しません。割合の行の幅は、差のとりうる範囲(±100 ポイント)で切り、切ったときは「(端で切った)」と書きます。どの人も同じ重みで平均する(セッションの数によらない)ので、上の表の差とは一致しません。ツールの失敗・拒否の率は、その人のツール呼び出しが {minCount} 回未満の側を「—」にします{#if kind === 'phase'}(次の依頼で直し・差し戻しの割合も、次の依頼があった依頼が {minCount} 件未満の側は「—」){/if}。{#if persons.unassigned.a + persons.unassigned.b > 0}人の記録が無い{countWord}(A {int(persons.unassigned.a)} 件・B {int(persons.unassigned.b)} 件)は入れていません。{/if}
        </p>
      </details>
      {#if persons.eligible < 2}
        <p class="note" data-testid="compare-person-reason">
          両方の側にそれぞれ {countWord} {minCount} 件以上ある人が {int(persons.eligible)} 人なので、人を単位にした幅は出しません(2 人以上で出します)。
        </p>
      {/if}
      <div class="table-scroll">
        <table class="ledger" aria-labelledby="compare-person-h" data-testid="compare-person-table">
          <thead>
            <tr>
              <th scope="col">指標</th>
              <th scope="col" class="num">使えた人</th>
              <th scope="col" class="num">人ごとの差の平均(B − A)</th>
              <th scope="col" class="num">差の幅(95%。人を単位)</th>
              <th scope="col">数え方</th>
            </tr>
          </thead>
          <tbody>
            {#each personRows as r (r.key)}
              <tr data-key={r.key}>
                <th scope="row" class="lab">{r.label}</th>
                <td class="num">{int(r.persons)}</td>
                <td class="num">{personMean(r)}</td>
                <td class="num ci">{personWidth(r)}</td>
                <td class="how">{r.note}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if personRetention}
        <div class="table-scroll weeks">
          <table class="ledger" aria-labelledby="compare-person-ret-h" data-testid="compare-person-retention">
            <caption id="compare-person-ret-h" class="cap">AI の変更の残存(人ごと。ほかの行と混ぜずに別に出します。A: {sideLabel('a')} / B: {sideLabel('b')})</caption>
            <thead>
              <tr>
                <th scope="col">指標</th>
                <th scope="col" class="num">使えた人</th>
                <th scope="col" class="num">人ごとの差の平均(B − A)</th>
                <th scope="col" class="num">差の幅(95%。人を単位)</th>
                <th scope="col">数え方</th>
              </tr>
            </thead>
            <tbody>
              <tr data-key={personRetention.key}>
                <th scope="row" class="lab">{personRetention.label}</th>
                <td class="num">{int(personRetention.persons)}</td>
                <td class="num">{personMean(personRetention)}</td>
                <td class="num ci">{personWidth(personRetention)}</td>
                <td class="how">
                  {#if kind === 'phase'}単位はまとまり。人ごとに、その工程の依頼で AI が足したまとまり(照合できたセッションの、照合不可を除く)に対する残っている(そのまま + 直されて)割合を出し、その差を平均します。その工程にまとまりのある照合できたセッションが、その人の A と B のどちらも {RETENTION_MIN_SESSIONS} 件以上ある人だけを使います。{:else}単位はまとまり。人ごとに、照合できたまとまり(照合不可を除く)に対する残っている(そのまま + 直されて)割合を出し、その差を平均します。照合できたセッションがその人の A と B のどちらも {RETENTION_MIN_SESSIONS} 件以上ある人だけを使います。{/if}照合できたセッションの数と、セッションの終わりから比べた時点までの日数(中央値)は、下の人ごとの表に並べます(両側で大きく違うと、後から人が手を入れた時間が違うので比べにくい)。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      {/if}
      <details class="tableview" data-testid="compare-person-detail">
        <summary>人ごとの表({int(persons.groups.length)} 人)</summary>
        <div class="table-scroll">
          <table class="ledger" aria-labelledby="compare-person-groups-h" data-testid="compare-person-groups">
            <caption id="compare-person-groups-h" class="cap">人ごとの値(A: {sideLabel('a')} / B: {sideLabel('b')}。値はその人の差 B − A)</caption>
            <thead>
              <tr>
                <th scope="col">人</th>
                <th scope="col" class="num">A の{countWord}</th>
                <th scope="col" class="num">B の{countWord}</th>
                {#each personRows as r (r.key)}<th scope="col" class="num">{r.label}</th>{/each}
                {#if personRetention}
                  <th scope="col" class="num">照合できたセッション(A / B)</th>
                  <th scope="col" class="num">比べた時点まで(中央値。A / B)</th>
                  <th scope="col" class="num">{personRetention.label}</th>
                {/if}
              </tr>
            </thead>
            <tbody>
              {#each persons.groups as g, i (g.person)}
                <tr class:thin={!g.eligible}>
                  <th scope="row" class="nowrap">{g.person}{#if !g.eligible}<span class="mark">(件数が足りない)</span>{/if}</th>
                  <td class="num">{int(g.a)}</td>
                  <td class="num">{int(g.b)}</td>
                  {#each personRows as r (r.key)}
                    <td class="num">{personCell(r, i)}{#if personAB(r.key, i)}<span class="ab">{personAB(r.key, i)}</span>{/if}</td>
                  {/each}
                  {#if personRetention}
                    <td class="num">{int(g.measuredA)} / {int(g.measuredB)}</td>
                    <td class="num">{lagText(g.lagA)} / {lagText(g.lagB)}</td>
                    <td class="num">{personCell(personRetention, i)}{#if personAB(personRetention.key, i)}<span class="ab">{personAB(personRetention.key, i)}</span>{/if}</td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="note">値はその人の差(B − A)で、下に A → B を添えます。件数が足りない人は、平均に入れていません。</p>
      </details>
    </div>
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
  .persons {
    margin-top: 18px;
  }
  /* 説明の続き(数え方と注意)は畳む。最初の 2 文だけを見せる */
  .notes {
    /* 見出しの行(折り返す flex)の中では、行いっぱいに置いて見出しの横に入らないようにする */
    flex: 1 1 100%;
    margin: 4px 0 8px;
    max-width: 100%;
    min-width: 0;
  }
  .notes > summary {
    font-size: 0.8125rem;
    color: var(--form);
    min-height: 24px;
    cursor: pointer;
  }
  .notes > p {
    margin: 4px 0 0;
    overflow-wrap: anywhere;
  }
  .persons h3 {
    margin-bottom: 4px;
  }
  .sides {
    margin: 0 0 4px;
    font-size: 0.8125rem;
  }
  .ab {
    display: block;
    font-size: 0.75rem;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .thin td,
  .thin th {
    color: var(--ink-2);
  }
  .mark {
    margin-left: 4px;
    font-size: 0.75rem;
    font-weight: normal;
  }
  /* 無効の部品は DESIGN.md の button-disabled(淡墨の文字、地は紙の色) */
  .seg button:disabled,
  .seg button:disabled:hover {
    color: var(--ink-3);
    background: var(--surface);
    cursor: not-allowed;
  }
  .cap {
    caption-side: top;
    text-align: left;
    font-size: 0.8125rem;
    color: var(--ink-2);
    padding-bottom: 4px;
  }
</style>
