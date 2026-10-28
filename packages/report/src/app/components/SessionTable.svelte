<script lang="ts">
  import { frictionTotal } from '../../lib/aggregate.ts';
  import { sessionTime } from '../../lib/filter.ts';
  import { dateTime, dec, duration, int, modelLabel, truncate } from '../../lib/format.ts';
  import type { SessionSummary } from '../../lib/types.ts';
  import SortMark from './SortMark.svelte';
  import { categoryLabel, confidenceLabel } from '../../lib/judgment-labels.ts';

  let { sessions, judged, anonymized }: { sessions: SessionSummary[]; judged: boolean; anonymized: boolean } = $props();

  type Key = 'time' | 'turns' | 'input' | 'output' | 'tools' | 'lines' | 'friction' | 'active' | 'human';
  const value: Record<Key, (s: SessionSummary) => number> = {
    time: (s) => sessionTime(s) ?? -Infinity,
    turns: (s) => s.turns,
    input: (s) => s.tokens.input ?? -1,
    output: (s) => s.tokens.output,
    tools: (s) => s.tools.total,
    lines: (s) => (s.lines.source === 'none' ? -1 : s.lines.added + s.lines.removed),
    friction: (s) => frictionTotal(s.friction),
    active: (s) => s.activeMs ?? -1,
    human: (s) => s.judgment?.hours ?? -1,
  };
  let sortKey = $state<Key>('time');
  let asc = $state(false);
  let page = $state(0);
  const PAGE = 50;

  const sorted = $derived.by(() => {
    const f = value[sortKey];
    const dir = asc ? 1 : -1;
    return [...sessions].sort((a, b) => (f(a) - f(b)) * dir || a.id.localeCompare(b.id));
  });
  const pages = $derived(Math.max(1, Math.ceil(sorted.length / PAGE)));
  // 絞り込みで件数が減ったらページを戻す
  $effect(() => {
    if (page > pages - 1) page = pages - 1;
  });
  const visible = $derived(sorted.slice(page * PAGE, page * PAGE + PAGE));

  function sortBy(k: Key): void {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = false;
    }
    page = 0;
  }
  const st = (k: Key): 'asc' | 'desc' | 'none' => (sortKey === k ? (asc ? 'asc' : 'desc') : 'none');
  const ariaSort = (k: Key): 'ascending' | 'descending' | 'none' => (sortKey === k ? (asc ? 'ascending' : 'descending') : 'none');

  function title(s: SessionSummary): string {
    if (anonymized) return `セッション ${s.id.slice(0, 8)}`;
    return truncate(s.name || s.firstUserMessage || `(名前なし) ${s.id.slice(0, 8)}`, 80);
  }
</script>

<section class="section" id="sessions" aria-labelledby="sessions-h">
  <div class="section-head">
    <h2 id="sessions-h">セッション一覧</h2>
    <p>
      {int(sessions.length)} セッション。名前を押すと詳細(時系列・ツール内訳・指示ファイル・摩擦)を開きます。
      {#if !judged}推定人手工数は未判定です(LLM による判定を実行すると表示されます)。{/if}
    </p>
  </div>
  {#if sessions.length > 0}
    <div class="table-scroll">
      <table class="ledger">
        <thead>
          <tr>
            {#snippet head(k: Key, label: string, num = true)}
              <th scope="col" class:num aria-sort={ariaSort(k)}>
                <button type="button" class="sort" onclick={() => sortBy(k)}>{label}<SortMark state={st(k)} /></button>
              </th>
            {/snippet}
            {@render head('time', '開始', false)}
            <th scope="col">プロジェクト</th>
            <th scope="col">セッション</th>
            <th scope="col">クライアント</th>
            <th scope="col">モデル</th>
            {@render head('turns', '依頼')}
            {@render head('input', '入力トークン')}
            {@render head('output', '出力トークン')}
            {@render head('tools', 'ツール')}
            {@render head('lines', '変更行')}
            {@render head('friction', '摩擦')}
            {@render head('active', '実働')}
            {@render head('human', '推定人手工数')}
          </tr>
        </thead>
        <tbody>
          {#each visible as s (s.id)}
            <tr>
              <td class="num when">{dateTime(s.createdAt ?? s.updatedAt)}</td>
              <td class="proj" title={s.project}>{s.projectLabel}{#if s.branch}<span class="sub">{s.branch}</span>{/if}</td>
              <td class="name"><a href={s.href}>{title(s)}</a>{#if s.empty}<span class="tag" title="依頼・ツール呼び出し・応答がどれも無いセッション">空</span>{/if}</td>
              <td class="nowrap">{s.client ?? '不明'}</td>
              <td class="models" title={s.models.join('、')}>{s.models.length ? s.models.map(modelLabel).join('、') : '不明'}</td>
              <td class="num">{int(s.turns)}</td>
              <td class="num">
                {#if s.tokens.input == null}<span class="missing-value">{s.coverage === 'output-only' ? '推計不可' : '記録なし'}</span>{:else}{int(s.tokens.input)}{/if}
              </td>
              <td class="num">{#if s.coverage === 'none'}<span class="missing-value">記録なし</span>{:else}{int(s.tokens.output)}{/if}</td>
              <td class="num">{int(s.tools.total)}</td>
              <td class="num" title={s.lines.source === 'shutdown' ? '終了時の累計(codeChanges)' : s.lines.source === 'tools' ? 'ツールごとの行数の合計' : ''}>
                {#if s.lines.source === 'none'}<span class="missing-value">—</span>{:else}+{int(s.lines.added)}<span class="sub">−{int(s.lines.removed)}</span>{/if}
              </td>
              <td class="num">{int(frictionTotal(s.friction))}</td>
              <td class="num">{duration(s.activeMs, '—')}</td>
              <td class="num">
                {#if s.judgment?.hours != null}<span title={s.judgment.low != null && s.judgment.high != null ? `LLM による推定。幅 ${dec(s.judgment.low)}〜${dec(s.judgment.high)} 時間` : 'LLM による推定'}>{dec(s.judgment.hours)} 時間</span><span class="sub">{categoryLabel(s.judgment.taskCategory)}・{confidenceLabel(s.judgment.confidence)}</span>{:else}<span class="missing-value">未判定</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if pages > 1}
      <nav class="pager" aria-label="セッション一覧のページ">
        <button type="button" class="btn" disabled={page === 0} onclick={() => (page = 0)}>先頭</button>
        <button type="button" class="btn" disabled={page === 0} onclick={() => (page -= 1)}>前へ</button>
        <span>{page + 1} / {pages} ページ({int(page * PAGE + 1)}〜{int(Math.min(sorted.length, page * PAGE + PAGE))} 件目)</span>
        <button type="button" class="btn" disabled={page >= pages - 1} onclick={() => (page += 1)}>次へ</button>
        <button type="button" class="btn" disabled={page >= pages - 1} onclick={() => (page = pages - 1)}>末尾</button>
      </nav>
    {/if}
  {/if}
</section>

<style>
  .sort {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .sort:hover {
    text-decoration: underline;
  }
  .when,
  .nowrap {
    white-space: nowrap;
  }
  .proj {
    min-width: 12em;
    max-width: 20em;
    overflow-wrap: anywhere;
    font-size: 0.75rem;
  }
  .name a {
    display: inline-block;
    min-height: 24px;
    padding: 2px 0;
  }
  .name {
    min-width: 14em;
    max-width: 32em;
  }
  .models {
    max-width: 14em;
    font-size: 0.75rem;
  }
  .sub {
    display: block;
    font-size: 0.6875rem;
    color: var(--ink-3);
  }
  .pager {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 8px;
    font-size: 0.8125rem;
  }
</style>
