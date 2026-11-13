<script lang="ts">
  import { categoryLabel } from '../../lib/judgment-labels.ts';
  import { NO_JUDGMENT, UNKNOWN, type FilterState, type Option } from '../../lib/filter.ts';
  import { int, modelLabel } from '../../lib/format.ts';
  import { judgeHint } from '../../lib/hints.ts';

  let {
    filter,
    options,
    judged,
    emptyCount,
    memoCount,
    lastDay,
    onchange,
    editable = false,
    anonymized = false,
  }: {
    filter: FilterState;
    options: { project: Option[]; person: Option[]; client: Option[]; model: Option[]; branch: Option[]; taskCategory: Option[] };
    judged: boolean;
    /** 空のセッション(依頼 0・ツール 0・応答 0)の件数 */
    emptyCount: number;
    /** メモのあるセッションの件数(0 件なら絞り込みを出さない) */
    memoCount: number;
    /** 最終記録日(YYYY-MM-DD、ローカル)。期間の簡易指定の基準 */
    lastDay: string | null;
    onchange: (patch: Partial<FilterState>) => void;
    /** serve から開き、判定のボタンがある(案内の文を分ける) */
    editable?: boolean;
    anonymized?: boolean;
  } = $props();

  const label = (v: string): string => (v === UNKNOWN ? '不明' : v === NO_JUDGMENT ? '未判定' : categoryLabel(v));
  /** ツールの絞り込みの表示名(mcp:<サーバー> は「MCP <サーバー>」) */
  const toolLabel = (t: string): string => (t.startsWith('mcp:') ? `MCP ${t.slice(4)}` : t);

  function shift(day: string, days: number): string {
    const [y, m, d] = day.split('-').map(Number);
    const dt = new Date(y, m - 1, d - days);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  const presets = [30, 90];
  const activePreset = $derived(
    lastDay && filter.to === '' ? presets.find((n) => filter.from === shift(lastDay, n - 1)) ?? null : null,
  );

  // 使う頻度の低い条件(ブランチ・入力トークン記録・タスク分類・空のセッション)は 2 行目に畳む。
  // どれかが効いているときは畳めない(効いている条件を隠さない)
  const moreActive = $derived(filter.branch !== '' || filter.coverage !== '' || filter.taskCategory !== '' || filter.empty === '1' || filter.memo === '1');
  let moreOpen = $state(false);
  const showMore = $derived(moreOpen || moreActive);
  const moreCount = $derived([filter.branch !== '', filter.coverage !== '', filter.taskCategory !== '', filter.empty === '1', filter.memo === '1'].filter(Boolean).length);

</script>

  {#snippet select(key: 'project' | 'person' | 'client' | 'model' | 'branch', title: string, opts: Option[], show: (v: string) => string = label)}
    <label class="sel">
      <span class="k">{title}</span>
      <select value={filter[key]} onchange={(e) => onchange({ [key]: e.currentTarget.value })}>
        <option value="">すべて({opts.length})</option>
        {#each opts as o (o.value)}
          <option value={o.value}>{show(o.label)}({int(o.count)})</option>
        {/each}
      </select>
    </label>
  {/snippet}

<!-- 絞り込み行は通常の流れに置く(固定するのは目次と「表示中の件数」の帯だけ。件数と解除はそちらにある) -->
<div class="filterbar" role="search" aria-label="セッションの絞り込み">
  <div class="wrap row">
    <fieldset class="period">
      <legend>期間</legend>
      <div class="period-inputs">
        <label><span class="sr-only">開始日</span><input type="date" value={filter.from} max={filter.to || undefined} onchange={(e) => onchange({ from: e.currentTarget.value })} /></label>
        <span aria-hidden="true">〜</span>
        <label><span class="sr-only">終了日</span><input type="date" value={filter.to} min={filter.from || undefined} onchange={(e) => onchange({ to: e.currentTarget.value })} /></label>
        {#if lastDay}
          <span class="presets" role="group" aria-label="期間の簡易指定">
            {#each presets as n (n)}
              <button
                type="button"
                class="chip"
                aria-pressed={activePreset === n}
                title="最終記録日({lastDay})から遡って {n} 日"
                onclick={() => (activePreset === n ? onchange({ from: '', to: '' }) : onchange({ from: shift(lastDay, n - 1), to: '' }))}>直近 {n} 日</button
              >
            {/each}
          </span>
        {/if}
      </div>
    </fieldset>


    <!-- 人は、送り先(<人>/<プロジェクト>)をまとめて集計したレポートだけ。効いている条件は、選択肢が無くても外せるように出す -->
    {#if options.person.length > 0 || filter.person !== ''}{@render select('person', '人', options.person)}{/if}
    {@render select('project', 'プロジェクト', options.project)}
    {@render select('client', 'クライアント', options.client)}
    {@render select('model', 'モデル', options.model, modelLabel)}


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

    <button
      type="button"
      class="chip more-toggle"
      aria-expanded={showMore}
      aria-controls="filter-more"
      disabled={moreActive}
      title={moreActive ? '効いている条件があるため閉じられません(解除で外せます)' : ''}
      onclick={() => (moreOpen = !moreOpen)}
    >
      {showMore ? 'その他の条件を閉じる' : 'その他の条件'}{#if moreCount > 0}<span class="badge" aria-label="{moreCount} 件が有効">{moreCount}</span>{/if}
    </button>
  </div>

  <div class="wrap row more" id="filter-more" hidden={!showMore}>
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

    <label class="sel">
      <span class="k">タスク分類</span>
      <select value={filter.taskCategory} disabled={!judged} aria-describedby={judged ? undefined : 'task-category-why'} onchange={(e) => onchange({ taskCategory: e.currentTarget.value })}>
        <option value="">{judged ? 'すべて' : '未判定'}</option>
        {#if judged}
          {#each options.taskCategory as o (o.value)}
            <option value={o.value}>{label(o.label)}({int(o.count)})</option>
          {/each}
        {/if}
      </select>
      {#if !judged}<span class="why" id="task-category-why">工数の判定をまだ実行していないため選べません。{judgeHint('工数', { editable, anonymized })}</span>{/if}
    </label>

    <label class="check">
      <input type="checkbox" checked={filter.empty === '1'} onchange={(e) => onchange({ empty: e.currentTarget.checked ? '1' : '' })} />
      <span>空のセッションを含める({int(emptyCount)})<span class="why">依頼・ツール呼び出し・応答がどれも無い、開いただけのセッション</span></span>
    </label>

    {#if memoCount > 0 || filter.memo === '1'}
      <label class="check">
        <input type="checkbox" data-testid="memo-filter" checked={filter.memo === '1'} onchange={(e) => onchange({ memo: e.currentTarget.checked ? '1' : '' })} />
        <span>メモのあるセッションだけ({int(memoCount)})</span>
      </label>
    {/if}
  </div>
</div>

<style>
  .filterbar {
    background: var(--surface);
    border-bottom: 1px solid var(--rule-strong);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 6px 12px;
    padding-top: 6px;
    padding-bottom: 8px;
  }
  .row.more {
    border-top: 1px dashed var(--rule);
    padding-top: 6px;
    align-items: flex-start;
  }
  .row.more[hidden] {
    display: none;
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
  .presets {
    display: inline-flex;
    gap: 4px;
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
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 3px 6px;
    height: 30px;
    max-width: 13em;
  }
  input[type='date'] {
    max-width: 10em;
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
    border: 1px solid var(--control);
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
  .chip:disabled {
    cursor: default;
    color: var(--ink-3);
    border-color: var(--rule);
  }
  .chip:disabled:hover {
    background: var(--surface);
  }
  .badge {
    display: inline-block;
    margin-left: 6px;
    padding: 0 5px;
    background: var(--form);
    color: var(--surface);
    font-size: 0.6875rem;
    line-height: 1.5;
  }
  .check {
    display: inline-flex;
    align-items: flex-start;
    gap: 6px;
    padding-top: 15px;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .check input {
    width: 16px;
    height: 16px;
    margin: 2px 0 0;
    accent-color: var(--form);
  }
  .why {
    display: block;
    font-size: 0.6875rem;
    color: var(--ink-3);
    max-width: 32em;
  }
  @media (max-width: 720px) {
    .sel,
    select {
      flex: 1 1 40%;
      max-width: none;
      width: 100%;
    }
    .more-toggle {
      flex: 1 1 100%;
    }
  }
</style>
