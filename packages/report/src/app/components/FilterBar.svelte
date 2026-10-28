<script lang="ts">
  import { categoryLabel } from '../../lib/judgment-labels.ts';
  import { isEmptyFilter, NO_JUDGMENT, UNKNOWN, type FilterState, type Option } from '../../lib/filter.ts';
  import { int, modelLabel } from '../../lib/format.ts';

  let {
    filter,
    options,
    judged,
    shown,
    total,
    emptyCount,
    lastDay,
    onchange,
    onreset,
  }: {
    filter: FilterState;
    options: { project: Option[]; client: Option[]; model: Option[]; branch: Option[]; taskCategory: Option[] };
    judged: boolean;
    shown: number;
    total: number;
    /** 空のセッション(依頼 0・ツール 0・応答 0)の件数 */
    emptyCount: number;
    /** 最終記録日(YYYY-MM-DD、ローカル)。期間の簡易指定の基準 */
    lastDay: string | null;
    onchange: (patch: Partial<FilterState>) => void;
    onreset: () => void;
  } = $props();

  const label = (v: string): string => (v === UNKNOWN ? '不明' : v === NO_JUDGMENT ? '未判定' : categoryLabel(v));
  /** ツールの絞り込みの表示名(mcp:<サーバー> は「MCP <サーバー>」) */
  const toolLabel = (t: string): string => (t.startsWith('mcp:') ? `MCP ${t.slice(4)}` : t);

  // 固定表示のフィルタ行の高さを CSS 変数に出す(ページ内リンクの飛び先が隠れないよう scroll-margin-top に使う)
  let barHeight = $state(0);
  $effect(() => {
    document.documentElement.style.setProperty('--filterbar-h', `${barHeight}px`);
  });

  function shift(day: string, days: number): string {
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(y, m - 1, d - days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  const presets = [30, 90];
  const activePreset = $derived(
    lastDay && filter.to === '' ? presets.find((n) => filter.from === shift(lastDay, n - 1)) ?? null : null,
  );
</script>

<div class="filterbar" role="search" aria-label="セッションの絞り込み" bind:offsetHeight={barHeight}>
  <div class="wrap row">
    <fieldset class="period">
      <legend>期間</legend>
      <div class="period-inputs">
        <label><span class="sr-only">開始日</span><input type="date" value={filter.from} max={filter.to || undefined} onchange={(e) => onchange({ from: e.currentTarget.value })} /></label>
        <span aria-hidden="true">〜</span>
        <label><span class="sr-only">終了日</span><input type="date" value={filter.to} min={filter.from || undefined} onchange={(e) => onchange({ to: e.currentTarget.value })} /></label>
        {#if lastDay}
          {#each presets as n}
            <button
              type="button"
              class="chip"
              aria-pressed={activePreset === n}
              title="最終記録日({lastDay})から遡って {n} 日"
              onclick={() => onchange({ from: shift(lastDay, n - 1), to: '' })}>直近 {n} 日</button
            >
          {/each}
        {/if}
      </div>
    </fieldset>

    {#snippet select(key: 'project' | 'client' | 'model' | 'branch', title: string, opts: Option[], show: (v: string) => string = label)}
      <label class="sel">
        <span class="k">{title}</span>
        <select value={filter[key]} onchange={(e) => onchange({ [key]: e.currentTarget.value })}>
          <option value="">すべて({opts.length})</option>
          {#each opts as o}
            <option value={o.value} title={o.value}>{show(o.label)}({int(o.count)})</option>
          {/each}
        </select>
      </label>
    {/snippet}

    {@render select('project', 'プロジェクト', options.project)}
    {@render select('client', 'クライアント', options.client)}
    {@render select('model', 'モデル', options.model, modelLabel)}
    {@render select('branch', 'ブランチ', options.branch)}

    <label class="sel">
      <span class="k">入力トークン記録</span>
      <select value={filter.coverage} onchange={(e) => onchange({ coverage: e.currentTarget.value as FilterState['coverage'] })}>
        <option value="">すべて</option>
        <option value="input">あり</option>
        <option value="output-only">出力のみ(入力は推計不可)</option>
        <option value="none">記録なし</option>
      </select>
    </label>

    <label class="sel" title={judged ? '' : 'LLM による判定(judgments.json)がまだ無いため選べません'}>
      <span class="k">タスク分類</span>
      <select value={filter.taskCategory} disabled={!judged} onchange={(e) => onchange({ taskCategory: e.currentTarget.value })}>
        <option value="">{judged ? 'すべて' : '未判定'}</option>
        {#if judged}
          {#each options.taskCategory as o}
            <option value={o.value}>{label(o.label)}({int(o.count)})</option>
          {/each}
        {/if}
      </select>
    </label>

    <label class="check" title="依頼・ツール呼び出し・応答がどれも無い(開いただけの)セッション。既定では集計から外します">
      <input type="checkbox" checked={filter.empty === '1'} onchange={(e) => onchange({ empty: e.currentTarget.checked ? '1' : '' })} />
      <span>空のセッションを含める({int(emptyCount)})</span>
    </label>

    {#if filter.tool}
      <div class="sel">
        <span class="k">ツール</span>
        <button
          type="button"
          class="chip on"
          data-testid="tool-filter"
          aria-label="ツール {toolLabel(filter.tool)} の絞り込みを外す"
          onclick={() => onchange({ tool: '' })}>{toolLabel(filter.tool)} を使った <span aria-hidden="true">×</span></button
        >
      </div>
    {/if}

    <div class="count">
      <p aria-live="polite" aria-atomic="true">
        表示中 <strong data-testid="shown-count">{int(shown)}</strong> / 全 {int(total)} セッション
      </p>
      <button type="button" class="btn" disabled={isEmptyFilter(filter)} onclick={onreset}>解除</button>
    </div>
  </div>
</div>

<style>
  .filterbar {
    background: var(--surface);
    border-bottom: 1px solid var(--rule-strong);
    z-index: 5;
  }
  @media (min-width: 900px) {
    .filterbar {
      position: sticky;
      top: 0;
    }
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px 14px;
    padding-top: 8px;
    padding-bottom: 10px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  legend,
  .k {
    display: block;
    font-size: 0.6875rem;
    color: var(--form);
    padding: 0;
    margin-bottom: 2px;
  }
  .period-inputs {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .sel {
    display: block;
    min-width: 0;
  }
  input[type='date'],
  select {
    font: inherit;
    font-size: 0.8125rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-radius: 0;
    padding: 3px 6px;
    height: 30px;
    max-width: 15em;
  }
  select:hover,
  input[type='date']:hover {
    border-color: var(--form);
  }
  select:disabled {
    color: var(--ink-3);
    border-color: var(--rule);
    cursor: not-allowed;
  }
  .chip {
    font: inherit;
    font-size: 0.75rem;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--rule-strong);
    background: var(--surface);
    color: var(--ink-2);
    cursor: pointer;
  }
  .chip:hover {
    background: var(--form-wash);
  }
  .chip[aria-pressed='true'],
  .chip.on {
    background: var(--form);
    border-color: var(--form);
    color: var(--surface);
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    font-size: 0.8125rem;
    color: var(--ink-2);
    cursor: pointer;
  }
  .check input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--form);
  }
  .count {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .count p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .count strong {
    font-size: 1.0625rem;
    color: var(--ink);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .sel,
    select {
      flex: 1 1 40%;
      max-width: none;
      width: 100%;
    }
    .count {
      margin-left: 0;
      width: 100%;
      justify-content: space-between;
    }
  }
</style>
