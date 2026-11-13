<script lang="ts">
  import type { ModelRow } from '../../lib/aggregate.ts';
  import { effortLabel } from '../../lib/exec-labels.ts';
  import { compact, int, modelLabel } from '../../lib/format.ts';

  let { rows }: { rows: ModelRow[] } = $props();

  /** 表示する行。推論強度で分けたときは モデル × 強度 の行(強度の内訳が無いモデルは effort: null の 1 行) */
  interface Line {
    id: string;
    model: string;
    effort: string | null;
    sessions: number;
    requests: number;
    input: number;
    output: number;
    /** 強度別には数えていないので、分けた行は null */
    cacheRead: number | null;
  }
  let split = $state(false);
  const whole = (r: ModelRow): Line => ({ id: r.model, model: r.model, effort: null, sessions: r.sessions, requests: r.requests, input: r.input, output: r.output, cacheRead: r.cacheRead });
  const lines = $derived<Line[]>(
    split
      ? rows.flatMap((r) =>
          r.efforts.length === 0
            ? [whole(r)]
            : r.efforts.map((e) => ({ id: `${r.model} ${e.key}`, model: r.model, effort: e.key, sessions: e.sessions, requests: e.requests, input: e.input, output: e.output, cacheRead: null })),
        )
      : rows.map(whole),
  );
  /** 推論強度別のリクエスト数(「high 120・medium 30」)。内訳が無ければ — */
  const effortText = (r: ModelRow): string => (r.efforts.length === 0 ? '—' : r.efforts.map((e) => `${effortLabel(e.key)} ${int(e.requests)}`).join('・'));
  const byModel = $derived(new Map(rows.map((r) => [r.model, r])));
  const lineName = (l: Line): string => (split ? (l.effort == null ? `${modelLabel(l.model)}・強度の記録なし` : `${modelLabel(l.model)}・${effortLabel(l.effort)}`) : modelLabel(l.model));

  type Metric = 'output' | 'input' | 'requests' | 'sessions';
  const metrics: { key: Metric; label: string }[] = [
    { key: 'output', label: '出力トークン' },
    { key: 'input', label: '入力トークン' },
    { key: 'requests', label: 'リクエスト数' },
    { key: 'sessions', label: 'トークン記録のあるセッション数' },
  ];
  let metric = $state<Metric>('output');
  const label = $derived(metrics.find((x) => x.key === metric)!.label);
  const fmt = (v: number): string => int(v);
  const TOP_N = 12;
  const ranked = $derived([...lines].sort((a, b) => b[metric] - a[metric] || a.id.localeCompare(b.id)));
  const shown = $derived(ranked.slice(0, TOP_N).filter((r) => r[metric] > 0));
  const max = $derived(Math.max(1, ...shown.map((r) => r[metric])));
</script>

<section class="section" id="models" aria-labelledby="models-h">
  <div class="section-head">
    <h2 id="models-h">モデル別</h2>
    <div class="controls">
    <div class="seg" role="group" aria-label="表示する値">
      {#each metrics as x}
        <button type="button" aria-pressed={metric === x.key} onclick={() => (metric = x.key)}>{x.label}</button>
      {/each}
    </div>
    <div class="seg" role="group" aria-label="行の分け方">
      <button type="button" aria-pressed={!split} onclick={() => (split = false)}>モデルごと</button>
      <button type="button" aria-pressed={split} onclick={() => (split = true)}>推論強度で分ける</button>
    </div>
    </div>
  </div>
  {#if shown.length === 0}
    <p class="note">この値の記録があるモデルはありません。</p>
  {:else}
    <ol class="bars" aria-label="{split ? 'モデル × 推論強度' : 'モデル'}別の{label}(上位 {shown.length})">
      {#each shown as r (r.id)}
        <li
          title={split
            ? `${r.model}${r.effort == null ? '(推論強度の記録なし)' : `・推論強度 ${effortLabel(r.effort)}`}: ${label} ${fmt(r[metric])}・セッション ${r.sessions}`
            : `${r.model}: ${label} ${fmt(r[metric])}・トークン記録のあるセッション ${r.sessions}・推論強度別のリクエスト ${effortText(byModel.get(r.model)!)}`}
        >
          <span class="name">{lineName(r)}</span>
          <span class="track">
            <span class="bar" style="width:calc((100% - 5em) * {r[metric] / max})"></span>
            <span class="val">{compact(r[metric])}</span>
          </span>
        </li>
      {/each}
    </ol>
    <p class="note">
      トークンはモデル別の記録があるセッションだけの合計です。セッション数はそのモデルにトークンが記録されたセッションの数で、モデルの絞り込み(使ったモデルで数える)の件数とは一致しません。モデル別の内訳が無いトークン(出力だけの記録など)は「不明」に入ります。1 セッションで複数のモデルを使うことがあるため、合計は全体のセッション数と一致しません。{#if split}推論強度は、リクエストの記録にある強度、無ければその時点の設定です。どちらも無いものは「不明」、強度の記録を持たない古い集計から作ったセッションは「強度の記録なし」に入ります。1 セッションで強度を変えることがあるため、強度別のセッション数の合計はモデルのセッション数と一致しません。キャッシュ読取は強度別には数えていません。{/if}{#if ranked.length > TOP_N}上位 {TOP_N} {split ? '行' : 'モデル'}を表示(全 {ranked.length} {split ? '行' : 'モデル'}は表を参照)。{/if}
    </p>
    <details class="tableview">
      <summary>表で見る</summary>
      <div class="table-scroll">
        <table class="ledger">
          <thead>
            <tr>
              <th scope="col">モデル</th>
              {#if split}<th scope="col">推論強度</th>{/if}
              <th scope="col" class="num">{split ? 'セッション' : 'トークン記録のあるセッション'}</th>
              <th scope="col" class="num">リクエスト</th>
              <th scope="col" class="num">入力トークン</th>
              <th scope="col" class="num">出力トークン</th>
              <th scope="col" class="num">キャッシュ読取</th>
              {#if !split}<th scope="col">推論強度別のリクエスト</th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each ranked as r (r.id)}
              <tr>
                <th scope="row" title={r.model}>{modelLabel(r.model)}</th>
                {#if split}<td>{r.effort == null ? '強度の記録なし' : effortLabel(r.effort)}</td>{/if}
                <td class="num">{int(r.sessions)}</td>
                <td class="num req">{int(r.requests)}</td>
                <td class="num">{int(r.input)}</td>
                <td class="num">{int(r.output)}</td>
                <td class="num">{r.cacheRead == null ? '—' : int(r.cacheRead)}</td>
                {#if !split}<td class="efforts">{effortText(byModel.get(r.model)!)}</td>{/if}
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
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .efforts {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .val {
    font-size: 0.75rem;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .bars li {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
  }
</style>
