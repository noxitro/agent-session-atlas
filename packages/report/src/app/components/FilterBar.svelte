<script lang="ts">
  import { categoryLabel } from '../../lib/judgment-labels.ts';
  import { joinIds, NO_JUDGMENT, sameIds, splitIds, UNKNOWN, type FilterState, type Option } from '../../lib/filter.ts';
  import { int, modelLabel } from '../../lib/format.ts';
  import type { ReportGroup } from '../../lib/types.ts';

  let {
    filter,
    options,
    judged,
    emptyCount,
    lastDay,
    groups,
    editable,
    onchange,
    onrename,
    ondelete,
  }: {
    filter: FilterState;
    options: { project: Option[]; client: Option[]; model: Option[]; branch: Option[]; taskCategory: Option[] };
    judged: boolean;
    /** 名前付きグループ(atlas-notes/groups.json)。presentIds は ids のうち記録にあるもの、present はその件数 */
    groups: Group[];
    /** 空のセッション(依頼 0・ツール 0・応答 0)の件数 */
    emptyCount: number;
    /** 最終記録日(YYYY-MM-DD、ローカル)。期間の簡易指定の基準 */
    lastDay: string | null;
    /** atlas serve から開いていて、グループを書き換えられる */
    editable: boolean;
    onchange: (patch: Partial<FilterState>) => void;
    onrename: (oldName: string, name: string) => Promise<void>;
    ondelete: (name: string) => Promise<void>;
  } = $props();

  type Group = ReportGroup & { presentIds: string[]; present: number };
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
  const moreActive = $derived(filter.branch !== '' || filter.coverage !== '' || filter.taskCategory !== '' || filter.empty === '1');
  let moreOpen = $state(false);
  const showMore = $derived(moreOpen || moreActive);
  const moreCount = $derived([filter.branch !== '', filter.coverage !== '', filter.taskCategory !== '', filter.empty === '1'].filter(Boolean).length);

  // セッションの選択(filter.ids)。グループを選ぶと記録にある id だけが ids に入る(記録に無い id は件数で知らせるだけ。
  // 1 件も無いグループは元の ids をそのまま入れて 0 件にする = 「すべて」と区別する)。
  // ids がどのグループの記録にある id とも同じ集合ならそのグループ名、違えば「選んだ N 件」
  const SELECTED = '(selected)';
  const idsOf = (g: Group): string => joinIds(g.presentIds.length ? g.presentIds : g.ids);
  const currentGroup = $derived(filter.ids ? groups.find((g) => sameIds(filter.ids, idsOf(g))) ?? null : null);
  const selectedCount = $derived(splitIds(filter.ids).length);
  const groupLabel = (g: Group): string => `${g.name}(${int(g.ids.length)} 件${g.present !== g.ids.length ? `、うち記録にあるのは ${int(g.present)} 件` : ''})`;
  function pickGroup(v: string): void {
    if (v === '') onchange({ ids: '' });
    else if (v !== SELECTED) {
      const g = groups.find((x) => x.name === v);
      if (g) onchange({ ids: idsOf(g) });
    }
  }

  // 選択中のグループの「名前の変更」(インライン編集)と「削除」(確認は 1 回、インライン)。ダイアログは出さない
  let mode = $state<'none' | 'rename' | 'delete'>('none');
  let newName = $state('');
  let groupError = $state('');
  let busy = $state(false);
  let renameEl = $state<HTMLInputElement | null>(null);
  let toolsEl = $state<HTMLElement | null>(null);
  let groupSelectEl = $state<HTMLSelectElement | null>(null);
  function openRename(): void {
    newName = currentGroup?.name ?? '';
    groupError = '';
    mode = 'rename';
    requestAnimationFrame(() => renameEl?.select());
  }
  function openDelete(): void {
    groupError = '';
    mode = 'delete';
    // 初期フォーカスは「取消」(Enter の連打で消さない)。「削除する」は 1 つ右
    requestAnimationFrame(() => toolsEl?.querySelector<HTMLButtonElement>('button[data-cancel]')?.focus());
  }
  function cancel(): void {
    mode = 'none';
    groupError = '';
    requestAnimationFrame(() => toolsEl?.querySelector<HTMLButtonElement>('button')?.focus());
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    groupError = '';
    try {
      await action();
      mode = 'none';
      // 済んだら「グループ」の欄へ(削除で欄ごと消えたときは絞り込み行の先頭へ)
      requestAnimationFrame(() => (groupSelectEl ?? document.querySelector<HTMLElement>('.filterbar select'))?.focus());
    } catch (e) {
      groupError = (e as Error).message;
      requestAnimationFrame(() => (renameEl ?? toolsEl?.querySelector<HTMLButtonElement>('button'))?.focus());
    } finally {
      busy = false;
    }
  }
  function submitRename(e: SubmitEvent): void {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      groupError = '名前を入れてください';
      renameEl?.focus();
      return;
    }
    if (name === currentGroup?.name) {
      cancel();
      return;
    }
    void run(() => onrename(currentGroup!.name, name));
  }
  // 別のグループに切り替えたら編集中の状態は捨てる
  $effect(() => {
    void currentGroup?.name;
    mode = 'none';
    groupError = '';
  });
</script>

  {#snippet select(key: 'project' | 'client' | 'model' | 'branch', title: string, opts: Option[], show: (v: string) => string = label)}
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


    {@render select('project', 'プロジェクト', options.project)}
    {@render select('client', 'クライアント', options.client)}
    {@render select('model', 'モデル', options.model, modelLabel)}

    {#if groups.length > 0 || filter.ids}
      <!-- 欄と操作(名前の変更・削除)は 1 つの固まり(折り返しても離れない) -->
      <div class="group-field">
      <label class="sel">
        <span class="k">グループ</span>
        <select data-testid="group-select" bind:this={groupSelectEl} value={currentGroup?.name ?? (filter.ids ? SELECTED : '')} onchange={(e) => pickGroup(e.currentTarget.value)}>
          <option value="">すべて</option>
          {#if filter.ids && !currentGroup}<option value={SELECTED}>選んだ {int(selectedCount)} 件</option>{/if}
          {#each groups as g (g.name)}
            <option value={g.name}>{groupLabel(g)}</option>
          {/each}
        </select>
        {#if currentGroup}<span class="why">{int(currentGroup.ids.length)} 件{#if currentGroup.present !== currentGroup.ids.length}(うち記録にあるのは {int(currentGroup.present)} 件){/if}{#if currentGroup.note}。{currentGroup.note}{/if}</span>{/if}
      </label>
      {#if currentGroup && editable}
        <div class="group-tools" bind:this={toolsEl} data-testid="group-tools" aria-busy={busy}>
          {#if mode === 'none'}
            <button type="button" class="chip" onclick={openRename}>名前の変更</button>
            <button type="button" class="chip" onclick={openDelete}>削除</button>
          {:else if mode === 'rename'}
            <form class="inline-form" onsubmit={submitRename}>
              <label class="sel"><span class="k">新しい名前</span><input type="text" bind:this={renameEl} bind:value={newName} maxlength="100" readonly={busy} aria-invalid={groupError ? 'true' : undefined} aria-describedby={groupError ? 'group-error' : undefined} /></label>
              <button type="submit" class="btn" aria-disabled={busy}>{busy ? '保存中…' : '保存'}</button>
              <button type="button" class="btn" onclick={cancel} aria-disabled={busy}>取消</button>
            </form>
          {:else}
            <span class="confirm">「{currentGroup.name}」を削除しますか(セッションは消えません)。</span>
            <button type="button" class="btn" data-cancel onclick={cancel} aria-disabled={busy}>取消</button>
            <button type="button" class="btn danger" data-confirm onclick={() => void run(() => ondelete(currentGroup!.name))} aria-disabled={busy}>{busy ? '削除中…' : '削除する'}</button>
          {/if}
          {#if groupError}<span class="err" id="group-error" role="alert">{groupError}</span>{/if}
        </div>
      {/if}
      </div>
    {/if}

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
      {#if !judged}<span class="why" id="task-category-why">LLM の判定(judgments.json)がまだ無いため選べません</span>{/if}
    </label>

    <label class="check">
      <input type="checkbox" checked={filter.empty === '1'} onchange={(e) => onchange({ empty: e.currentTarget.checked ? '1' : '' })} />
      <span>空のセッションを含める({int(emptyCount)})<span class="why">依頼・ツール呼び出し・応答がどれも無い、開いただけのセッション</span></span>
    </label>
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
    cursor: pointer;
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
  /* グループの欄と操作(名前の変更・削除)は 1 つの固まり。操作は select の右に並び、編集中は入力欄に変わる */
  .group-field {
    display: flex;
    align-items: flex-end;
    gap: 6px 10px;
    flex-wrap: wrap;
    padding: 0 8px 0 0;
    border-right: 1px solid var(--rule);
  }
  .group-tools {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    flex-wrap: wrap;
    align-self: flex-end;
    padding-bottom: 1px;
  }
  .inline-form {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    flex-wrap: wrap;
  }
  .inline-form input[type='text'] {
    font: inherit;
    font-size: 0.8125rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 3px 6px;
    height: 30px;
    width: 14em;
  }
  .group-tools .btn {
    padding: 3px 10px;
    height: 30px;
  }
  .group-tools .btn.danger {
    border-color: var(--warn);
    color: var(--warn);
  }
  .group-tools .btn.danger:hover {
    background: var(--warn-wash);
  }
  .confirm {
    font-size: 0.8125rem;
    color: var(--ink-2);
    align-self: center;
  }
  .err {
    flex: 1 1 100%;
    font-size: 0.75rem;
    color: var(--warn);
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
