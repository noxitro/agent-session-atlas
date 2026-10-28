<script lang="ts">
  import type { Bucket } from '../../lib/aggregate.ts';
  import { compact, dec, int, month, percent } from '../../lib/format.ts';
  import { niceTicks } from '../../lib/scale.ts';

  let { months }: { months: Bucket[] } = $props();

  type Metric = 'sessions' | 'output' | 'input' | 'aiu' | 'premium';
  const metrics: { key: Metric; label: string; get: (b: Bucket) => number; partial?: (b: Bucket) => string }[] = [
    { key: 'sessions', label: 'セッション数', get: (b) => b.sessions },
    { key: 'output', label: '出力トークン', get: (b) => b.tokens.output },
    {
      key: 'input',
      label: '入力トークン',
      get: (b) => b.tokens.input,
      partial: (b) => `入力の記録あり ${b.sessionsWithInput}/${b.sessions} セッション`,
    },
    {
      key: 'aiu',
      label: 'AI 使用量(AIU)',
      get: (b) => b.tokens.nanoAiu / 1e9,
      partial: (b) => `AIU の記録あり ${b.sessionsWithNanoAiu}/${b.sessions} セッション`,
    },
    {
      key: 'premium',
      label: 'premium request',
      get: (b) => b.tokens.premiumRequests,
      partial: (b) => `premium request の記録あり ${b.sessionsWithPremium}/${b.sessions} セッション`,
    },
  ];
  let metric = $state<Metric>('sessions');
  const m = $derived(metrics.find((x) => x.key === metric)!);
  const fmt = (v: number): string => (metric === 'aiu' || metric === 'premium' ? dec(v) : int(v));

  let width = $state(800);
  const H = 220;
  const AXIS = 30;
  const LEFT = 52;
  const RIGHT = 8;
  const TOP = 14;

  const data = $derived(months.filter((b) => b.key !== '(unknown)'));
  const values = $derived(data.map((b) => m.get(b)));
  const ticks = $derived(niceTicks(Math.max(0, ...values)));
  const max = $derived(ticks[ticks.length - 1] || 1);
  const plotW = $derived(Math.max(100, width - LEFT - RIGHT));
  const band = $derived(data.length ? plotW / data.length : plotW);
  const barW = $derived(Math.max(4, Math.min(24, band * 0.6)));
  const y = (v: number): number => TOP + (H - TOP) * (1 - v / max);
  // 月が多いとラベルが重なるので間引く
  const labelEvery = $derived(Math.max(1, Math.ceil(56 / band)));

  let active = $state<number | null>(null);
  const tip = $derived(active != null && data[active] ? data[active] : null);

  /** データ端を 4px 角丸、基線側は四角にした縦棒のパス */
  function barPath(x: number, top: number, w: number, bottom: number): string {
    const h = bottom - top;
    if (h <= 0) return '';
    const r = Math.min(4, w / 2, h);
    return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
  }
</script>

<section class="section" id="monthly" aria-labelledby="monthly-h">
  <div class="section-head">
    <h2 id="monthly-h">月別推移</h2>
    <div class="seg" role="group" aria-label="表示する値">
      {#each metrics as x}
        <button type="button" aria-pressed={metric === x.key} onclick={() => (metric = x.key)}>{x.label}</button>
      {/each}
    </div>
  </div>

  {#if data.length === 0}
    <p class="note">日時の分かるセッションがありません。</p>
  {:else}
    <div class="chart" bind:clientWidth={width}>
      <svg width={width} height={H + AXIS} role="img" aria-label="月別の{m.label}(開始月、UTC)。詳細は下の表を参照">
        {#each ticks as t}
          <line x1={LEFT} x2={LEFT + plotW} y1={y(t)} y2={y(t)} class={t === 0 ? 'base' : 'grid'} />
          <text x={LEFT - 6} y={y(t)} dy="0.32em" text-anchor="end" class="tick">{compact(t)}</text>
        {/each}
        {#each data as b, i (b.key)}
          {@const v = values[i]}
          {@const x = LEFT + band * i + (band - barW) / 2}
          <g
            class="col"
            class:active={active === i}
            role="button"
            tabindex="0"
            aria-label="{month(b.key)}: {m.label} {fmt(v)}{m.partial ? `(${m.partial(b)})` : ''}"
            onpointerenter={() => (active = i)}
            onpointerleave={() => (active = null)}
            onfocus={() => (active = i)}
            onblur={() => (active = null)}
          >
            <rect class="hit" x={LEFT + band * i} y={TOP} width={band} height={H - TOP} />
            <path d={barPath(x, y(v), barW, y(0))} class="bar" />
          </g>
          {#if i % labelEvery === 0}
            <text x={LEFT + band * i + band / 2} y={H + 18} text-anchor="middle" class="tick">{b.key}</text>
          {/if}
        {/each}
        {#if values.length}
          {@const last = values.length - 1}
          <text x={LEFT + band * last + band / 2} y={y(values[last]) - 6} text-anchor="middle" class="endlabel">{compact(values[last])}</text>
        {/if}
      </svg>
      {#if tip && active != null}
        <div class="tip" style="left:{Math.min(width - 200, Math.max(0, LEFT + band * active + band / 2 - 100))}px">
          <strong>{fmt(m.get(tip))}</strong>
          <span>{month(tip.key)}・{m.label}</span>
          {#if m.partial}<span class="muted">{m.partial(tip)}</span>{/if}
          <span class="muted">セッション {int(tip.sessions)}・出力 {compact(tip.tokens.output)}</span>
        </div>
      {/if}
    </div>
    {#if m.partial}
      <p class="note">{m.label}は記録のあるセッションだけの合計です。記録が始まる前の月は実際より少なく見えます(月ごとの記録率は表を参照)。</p>
    {/if}
    <details class="tableview">
      <summary>表で見る</summary>
      <div class="table-scroll">
        <table class="ledger">
          <thead>
            <tr>
              <th scope="col">月(UTC)</th>
              <th scope="col" class="num">セッション</th>
              <th scope="col" class="num">依頼</th>
              <th scope="col" class="num">入力トークン</th>
              <th scope="col" class="num">入力の記録率</th>
              <th scope="col" class="num">出力トークン</th>
              <th scope="col" class="num">AIU</th>
              <th scope="col" class="num">premium request</th>
              <th scope="col" class="num">変更行(+/−)</th>
              <th scope="col" class="num">ツール</th>
              <th scope="col" class="num">摩擦</th>
            </tr>
          </thead>
          <tbody>
            {#each months as b (b.key)}
              <tr>
                <th scope="row">{b.key === '(unknown)' ? '日時不明' : month(b.key)}</th>
                <td class="num">{int(b.sessions)}</td>
                <td class="num">{int(b.turns)}</td>
                <td class="num">{b.sessionsWithInput ? int(b.tokens.input) : '記録なし'}</td>
                <td class="num">{percent(b.sessionsWithInput, b.sessions)}</td>
                <td class="num">{int(b.tokens.output)}</td>
                <td class="num">{b.sessionsWithNanoAiu ? dec(b.tokens.nanoAiu / 1e9) : '記録なし'}</td>
                <td class="num">{b.sessionsWithPremium ? dec(b.tokens.premiumRequests) : '記録なし'}</td>
                <td class="num">{b.sessionsWithLines ? `+${int(b.linesAdded)} / −${int(b.linesRemoved)}` : '記録なし'}</td>
                <td class="num">{int(b.tools)}</td>
                <td class="num">{int(b.friction)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
  {/if}
</section>

<style>
  .chart {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-top: 0;
    padding: 8px 0 0;
    min-height: 250px;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .grid {
    stroke: var(--grid);
    stroke-width: 1;
  }
  .base {
    stroke: var(--axis);
    stroke-width: 1;
  }
  .tick {
    fill: var(--ink-3);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .endlabel {
    fill: var(--ink-2);
    font-size: 11px;
    font-weight: 600;
  }
  .bar {
    fill: var(--s1);
    transition: opacity 150ms ease-out;
  }
  .hit {
    fill: transparent;
  }
  .col {
    cursor: default;
    /* フォーカス表示は下の .col:focus-visible .hit(帯の枠線)が担うので、g 要素の既定の枠は消す */
    outline: none;
  }
  .col.active .hit {
    fill: var(--select);
  }
  .col:focus-visible .hit {
    stroke: var(--form);
    stroke-width: 2;
  }
  .tip {
    position: absolute;
    top: 4px;
    width: 200px;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    padding: 6px 10px;
    font-size: 0.75rem;
    display: flex;
    flex-direction: column;
    pointer-events: none;
  }
  .tip strong {
    font-size: 1rem;
  }
</style>
