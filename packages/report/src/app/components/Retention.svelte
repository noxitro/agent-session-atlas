<script lang="ts">
  import { dateTime, int, percent } from '../../lib/format.ts';
  import { aggregateRetention, measuredOf, MODE_LABEL, REASON_LABEL, REASONS, retentionByPhase, STATUS_LABEL, STATUSES, UNKNOWN_PHASE, VCS_LABEL, type RetentionMeta } from '../../lib/retention.ts';
  import { PHASE_LABEL, PHASES } from '../../../../core/src/turns.ts';
  import type { SessionSummary } from '../../lib/types.ts';

  let { sessions, meta }: { sessions: SessionSummary[]; meta: RetentionMeta } = $props();

  const a = $derived(aggregateRetention(sessions));
  const hunksMeasured = $derived(measuredOf(a.hunks));
  const linesMeasured = $derived(measuredOf(a.lines));
  /** 状態の色。色だけにしない(凡例の言葉と、照合不可は斜線) */
  const COLORS = ['var(--s1)', 'var(--s3)', 'var(--s4)', 'var(--missing)'] as const;
  /** 状態の名前(設定の vcs.labels で差し替えたものがあればそれ) */
  const L = $derived({ ...STATUS_LABEL, ...(meta.labels ?? {}) });
  const segments = $derived(STATUSES.map((k, i) => ({ key: k, label: L[k], n: a.hunks[i], lines: a.lines[i], color: COLORS[i] })));
  const totalHunks = $derived(a.hunks.reduce((x, y) => x + y, 0));
  let hover = $state<string | null>(null);

  /** 送り先から集計したとき: 照合した日時と見方は送った側のもの(この PC で集計した日時ではない) */
  const senderText = $derived.by(() => {
    const s = meta.senders;
    if (!s) return null;
    const range = s.from && s.to ? (s.from === s.to ? dateTime(s.from) : `${dateTime(s.from)}〜${dateTime(s.to)}`) : '日時不明';
    const modes =
      (Object.entries(s.modes) as [keyof typeof MODE_LABEL, number][])
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${MODE_LABEL[k]} ${int(n)}`)
        .join('・') || '不明';
    return `${int(s.sessions)} セッション・照合 ${range}・比べる版: ${modes}`;
  });

  const reasons = $derived(REASONS.filter((k) => (a.unattributable[k] ?? 0) > 0).map((k) => ({ key: k, label: REASON_LABEL[k], n: a.unattributable[k] ?? 0 })));
  const vcsText = $derived(
    Object.entries(a.byVcs)
      .map(([k, n]) => `${VCS_LABEL[k as keyof typeof VCS_LABEL] ?? k} ${int(n ?? 0)}`)
      .join('・'),
  );

  /** 工程ごと(照合できたセッションのまとまりを、作った依頼の工程で分ける。まとまりのある工程だけ、PHASES の順、不明は最後) */
  const phaseRet = $derived(retentionByPhase(sessions));
  const phaseRows = $derived(
    [...PHASES.map((ph, i) => ({ key: ph as string, label: PHASE_LABEL[ph], t: phaseRet.byPhase.get(i) })), { key: 'unknown', label: '不明(最初の依頼より前など)', t: phaseRet.byPhase.get(UNKNOWN_PHASE) }].filter(
      (r): r is { key: string; label: string; t: [number, number, number, number] } => !!r.t && r.t.some((n) => n > 0),
    ),
  );

  /** プロジェクトごと(照合できたセッションがあるものだけ) */
  const rows = $derived.by(() => {
    const by = new Map<string, { key: string; label: string; list: SessionSummary[] }>();
    for (const s of sessions) {
      const g = by.get(s.project) ?? by.set(s.project, { key: s.project, label: s.projectLabel, list: [] }).get(s.project)!;
      g.list.push(s);
    }
    return [...by.values()]
      .map((g) => ({ key: g.key, label: g.label, agg: aggregateRetention(g.list) }))
      .filter((r) => r.agg.withAi > 0)
      .sort((x, y) => y.agg.measured - x.agg.measured || y.agg.withAi - x.agg.withAi || x.label.localeCompare(y.label));
  });
</script>

<section class="section" id="retention" aria-labelledby="retention-h">
  <div class="section-head">
    <h2 id="retention-h">AI の変更の残存(VCS)</h2>
    <p>
      AI が足した行が、その後の VCS のファイルに残っているかを数えます。{meta.note ?? ''}
      {#if meta.computedOn === 'sender'}
        送った側の PC で照合した結果です{senderText ? `(${senderText})` : '(添えられた結果はありません)'}。
      {:else}
        比べる版: {MODE_LABEL[meta.mode]}・照合 {dateTime(meta.generatedAt)}{meta.pathMap ? `・パスの読み替え ${int(meta.pathMap)} 件` : ''}
      {/if}
    </p>
  </div>

  {#if a.withAi === 0}
    <p class="note">
      この絞り込みには、AI の変更があったセッションがありません(表示中 {int(a.sessions)} セッション{a.notChecked ? `、うち照合していない ${int(a.notChecked)} 件` : ''})。
    </p>
  {:else}
    <div class="fields" style="--cols:4">
      <div class="field">
        <span class="k">照合できたセッション(分母)</span>
        <span class="v">{int(a.measured)}</span>
        <span class="n">AI の変更があった {int(a.withAi)} セッションのうち {percent(a.measured, a.withAi)}。{L.unattributable} {int(a.unattributableTotal)}</span>
      </div>
      {#each [0, 1, 2] as i (i)}
        <div class="field">
          <span class="k">{L[STATUSES[i]]}(まとまり)</span>
          <span class="v">{hunksMeasured ? percent(a.hunks[i], hunksMeasured) : '—'}</span>
          <span class="n">{int(a.hunks[i])} / {int(hunksMeasured)} まとまり・{int(a.lines[i])} / {int(linesMeasured)} 行</span>
        </div>
      {/each}
    </div>

    <div class="coverage">
      <div class="cov-head">
        <h3 id="ret-dist-h">まとまりの内訳(照合できたセッション)</h3>
        <p class="muted">割合の分母は、照合できたまとまり(「{L.unattributable}」を除いたもの)です。「{L.unattributable}」のまとまりは件数だけ出します。</p>
      </div>
      {#if totalHunks > 0}
        <div class="stack" role="img" aria-labelledby="ret-dist-h" aria-describedby="ret-legend">
          {#each segments as s (s.key)}
            {#if s.n > 0}
              <span
                class="piece"
                class:dim={hover && hover !== s.key}
                class:hatch={s.key === 'unattributable'}
                style="flex-grow:{s.n};background-color:{s.color}"
                title="{s.label}: {int(s.n)} まとまり"
              ></span>
            {/if}
          {/each}
        </div>
      {/if}
      <ul class="legend" id="ret-legend">
        {#each segments as s (s.key)}
          <li onpointerenter={() => (hover = s.key)} onpointerleave={() => (hover = null)}>
            <span class="sw" class:hatch={s.key === 'unattributable'} style="background-color:{s.color}" aria-hidden="true"></span>
            <span class="lab">{s.label}</span>
            <strong>{int(s.n)}</strong>
            <span class="muted">{s.key === 'unattributable' ? '(分母に入れない)' : `(${percent(s.n, hunksMeasured)})`}</span>
            <span class="src muted">{int(s.lines)} 行</span>
          </li>
        {/each}
      </ul>
    </div>

    <h3 class="sub-h" id="ret-scope-h">照合の範囲</h3>
    <div class="table-scroll">
      <table class="ledger" aria-labelledby="ret-scope-h">
        <thead>
          <tr><th scope="col">セッション</th><th scope="col" class="num">件数</th><th scope="col">補足</th></tr>
        </thead>
        <tbody>
          <tr><th scope="row">表示中</th><td class="num">{int(a.sessions)}</td><td></td></tr>
          <tr><th scope="row" class="ind">AI の変更なし</th><td class="num">{int(a.none)}</td><td>編集・作成で足した行が無い</td></tr>
          {#if a.notChecked}<tr><th scope="row" class="ind">照合していない</th><td class="num">{int(a.notChecked)}</td><td>照合した後に増えたセッションなど。atlas vcs で照合し直せます</td></tr>{/if}
          <tr><th scope="row" class="ind">AI の変更あり</th><td class="num">{int(a.withAi)}</td><td>ログの編集のイベントから取った</td></tr>
          <tr><th scope="row" class="ind2">照合できた(分母)</th><td class="num">{int(a.measured)}</td><td>開始時の基準: 記録 {int(a.baseline.observed)}・推定 {int(a.baseline.estimated)}{vcsText ? `。${vcsText}` : ''}{a.sender ? `。送った側の PC で照合 ${int(a.sender)}` : ''}{a.mapped ? `。パスを読み替え ${int(a.mapped)}` : ''}</td></tr>
          {#each reasons as r (r.key)}
            <tr><th scope="row" class="ind2">{L.unattributable}: {r.label}</th><td class="num">{int(r.n)}</td><td></td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="note">
      開始時の基準の「記録」はログに残った開始時の版(git のコミット)、「推定」は開始時刻から VCS の履歴で探した版(svn・p4 は常に推定)です。似た行とみなす下限は文字の 2 字組の重なり {Math.round(meta.similarity * 100)}% です。
    </p>

    {#if phaseRows.length > 0}
      <h3 class="sub-h" id="ret-phase-h">工程ごと(照合できたセッション)</h3>
      <div class="table-scroll">
        <table class="ledger" aria-labelledby="ret-phase-h">
          <thead>
            <tr>
              <th scope="col">工程</th>
              {#each STATUSES as k (k)}<th scope="col" class="num">{L[k]}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each phaseRows as r (r.key)}
              {@const m = measuredOf(r.t)}
              <tr>
                <th scope="row" class="proj">{r.label}</th>
                {#each [0, 1, 2] as i (i)}
                  <td class="num">{m ? `${int(r.t[i])}(${percent(r.t[i], m)})` : '—'}</td>
                {/each}
                <td class="num">{int(r.t[3])}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="note">まとまりを作った編集の時刻から、その時に進んでいた依頼の工程に分けています(工程の決め方は「工程と詰まり」と同じ)。括弧は、その工程の照合できたまとまりに対する割合です。{phaseRet.withoutPhases ? `依頼の記録が無く工程に分けられないセッション ${int(phaseRet.withoutPhases)} 件は入れていません。` : ''}</p>
    {/if}

    {#if rows.length > 0}
      <h3 class="sub-h" id="ret-proj-h">プロジェクトごと(AI の変更があったものだけ)</h3>
      <div class="table-scroll">
        <table class="ledger" aria-labelledby="ret-proj-h">
          <thead>
            <tr>
              <th scope="col">プロジェクト</th>
              <th scope="col" class="num">照合できた / AI の変更あり</th>
              {#each STATUSES as k (k)}<th scope="col" class="num">{L[k]}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as r (r.key)}
              {@const m = measuredOf(r.agg.hunks)}
              <tr>
                <th scope="row" class="proj" title={r.key}>{r.label}</th>
                <td class="num">{int(r.agg.measured)} / {int(r.agg.withAi)}</td>
                {#each [0, 1, 2] as i (i)}
                  <td class="num">{m ? `${int(r.agg.hunks[i])}(${percent(r.agg.hunks[i], m)})` : '—'}</td>
                {/each}
                <td class="num">{int(r.agg.hunks[3])}{r.agg.unattributableTotal ? `・${L.unattributable}のセッション ${int(r.agg.unattributableTotal)}` : ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="note">件数はまとまり(AI の 1 回の編集の、連続して足した行)の数で、括弧はそのプロジェクトの照合できたまとまりに対する割合です。</p>
    {/if}
  {/if}
</section>

<style>
  .sub-h {
    margin: 16px 0 6px;
    font-size: 0.9375rem;
  }
  .proj {
    font-weight: normal;
    min-width: 11em;
    max-width: 28em;
    overflow-wrap: anywhere;
  }
  .ind {
    font-weight: normal;
    padding-left: 1.5em;
  }
  .ind2 {
    font-weight: normal;
    padding-left: 3em;
  }
  .coverage {
    margin-top: 14px;
  }
  .cov-head h3 {
    margin: 0;
    font-size: 0.9375rem;
  }
  .cov-head p {
    margin: 2px 0 0;
    font-size: 0.8125rem;
  }
  .stack {
    display: flex;
    gap: 2px;
    height: 18px;
    margin-top: 10px;
    background: var(--surface);
  }
  .piece {
    display: block;
    min-width: 3px;
    flex-basis: 0;
    transition: opacity 150ms ease-out;
  }
  .piece.dim {
    opacity: 0.35;
  }
  /* 照合不可は色だけでなく斜線でも区別する */
  .hatch {
    background-image: repeating-linear-gradient(135deg, transparent 0 3px, var(--surface) 3px 4px);
  }
  .legend {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 6px 20px;
    font-size: 0.8125rem;
  }
  .legend li {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    align-items: baseline;
    gap: 0 6px;
  }
  .sw {
    width: 10px;
    height: 10px;
    flex: none;
    align-self: center;
  }
  .src {
    flex-basis: 100%;
    padding-left: 16px;
    font-size: 0.75rem;
  }
</style>
