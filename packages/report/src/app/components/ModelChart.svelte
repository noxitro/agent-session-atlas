<script lang="ts">
  import type { ModelRow } from '../../lib/aggregate.ts';
  import { compact, int, modelLabel } from '../../lib/format.ts';

  let { rows }: { rows: ModelRow[] } = $props();

  type Metric = 'output' | 'input' | 'requests' | 'sessions';
  const metrics: { key: Metric; label: string }[] = [
    { key: 'output', label: '出力トークン' },
    { key: 'input', label: '入力トークン' },
    { key: 'requests', label: 'リクエスト数' },
    { key: 'sessions', label: '使用セッション数' },
  ];
  let metric = $state<Metric>('output');
  const label = $derived(metrics.find((x) => x.key === metric)!.label);
  const fmt = (v: number): string => int(v);
  const TOP_N = 12;
  const ranked = $derived([...rows].sort((a, b) => b[metric] - a[metric] || a.model.localeCompare(b.model)));
  const shown = $derived(ranked.slice(0, TOP_N).filter((r) => r[metric] > 0));
  const max = $derived(Math.max(1, ...shown.map((r) => r[metric])));
  const name = modelLabel;
</script>

<section class="section" id="models" aria-labelledby="models-h">
  <div class="section-head">
    <h2 id="models-h">モデル別</h2>
    <div class="seg" role="group" aria-label="表示する値">
      {#each metrics as x}
        <button type="button" aria-pressed={metric === x.key} onclick={() => (metric = x.key)}>{x.label}</button>
      {/each}
    </div>
  </div>
  {#if shown.length === 0}
    <p class="note">この値の記録があるモデルはありません。</p>
  {:else}
    <ol class="bars" aria-label="モデル別の{label}(上位 {shown.length})">
      {#each shown as r (r.model)}
        <li title="{r.model}: {label} {fmt(r[metric])}・使用セッション {r.sessions}">
          <span class="name">{name(r.model)}</span>
          <span class="track">
            <span class="bar" style="width:calc((100% - 5em) * {r[metric] / max})"></span>
            <span class="val">{compact(r[metric])}</span>
          </span>
        </li>
      {/each}
    </ol>
    <p class="note">
      トークンはモデル別の記録があるセッションだけの合計です。1 セッションで複数のモデルを使うことがあるため、使用セッション数の合計は全体のセッション数と一致しません。{#if ranked.length > TOP_N}上位 {TOP_N} モデルを表示(全 {ranked.length} モデルは表を参照)。{/if}
    </p>
    <details class="tableview">
      <summary>表で見る</summary>
      <div class="table-scroll">
        <table class="ledger">
          <thead>
            <tr>
              <th scope="col">モデル</th>
              <th scope="col" class="num">使用セッション</th>
              <th scope="col" class="num">リクエスト</th>
              <th scope="col" class="num">入力トークン</th>
              <th scope="col" class="num">出力トークン</th>
              <th scope="col" class="num">キャッシュ読取</th>
            </tr>
          </thead>
          <tbody>
            {#each ranked as r (r.model)}
              <tr>
                <th scope="row" title={r.model}>{name(r.model)}</th>
                <td class="num">{int(r.sessions)}</td>
                <td class="num">{int(r.requests)}</td>
                <td class="num">{int(r.input)}</td>
                <td class="num">{int(r.output)}</td>
                <td class="num">{int(r.cacheRead)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
  {/if}
</section>

<style>
  .bars {
    list-style: none;
    margin: 0;
    padding: 10px 12px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-top: 0;
    display: grid;
    gap: 6px;
  }
  .bars li {
    display: grid;
    grid-template-columns: minmax(8em, 15em) 1fr;
    gap: 12px;
    align-items: center;
    font-size: 0.8125rem;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-2);
  }
  .track {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .bar {
    display: block;
    height: 14px;
    min-width: 2px;
    background: var(--s1);
    border-radius: 0 4px 4px 0;
  }
  .val {
    font-size: 0.75rem;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .bars li {
      grid-template-columns: 1fr;
      gap: 2px;
    }
  }
</style>
