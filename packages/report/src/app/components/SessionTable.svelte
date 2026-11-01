<script lang="ts">
  import { frictionTotal } from '../../lib/aggregate.ts';
  import { sessionTime } from '../../lib/filter.ts';
  import { dateTime, dec, duration, int, modelLabel, truncate } from '../../lib/format.ts';
  import { groupSnippet } from '../../lib/groups.ts';
  import type { SessionSummary } from '../../lib/types.ts';
  import SortMark from './SortMark.svelte';
  import { categoryLabel, confidenceLabel } from '../../lib/judgment-labels.ts';

  let {
    sessions,
    judged,
    anonymized,
    selected,
    idsActive,
    onselect,
    onapply,
    onclear,
  }: {
    sessions: SessionSummary[];
    judged: boolean;
    anonymized: boolean;
    /** チェックしたセッション id(画面内だけ。保存しない) */
    selected: Set<string>;
    /** 「選んだセッションだけ集計」が効いているか(filter.ids) */
    idsActive: boolean;
    onselect: (ids: Set<string>) => void;
    /** 選んだものだけで集計する(filter.ids に入れる) */
    onapply: () => void;
    /** 選択を外す(集計中ならその条件も外す) */
    onclear: () => void;
  } = $props();

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

  // --- 選択(チェック欄)。状態は親(App)が持ち、ここは表示と操作だけ ---
  const visibleChecked = $derived(visible.filter((s) => selected.has(s.id)).length);
  const allVisible = $derived(visible.length > 0 && visibleChecked === visible.length);
  function toggle(id: string, on: boolean): void {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onselect(next);
  }
  /** 見出し行のチェック: このページの行をまとめて選ぶ / 外す */
  function toggleVisible(on: boolean): void {
    const next = new Set(selected);
    for (const s of visible) if (on) next.add(s.id);
    else next.delete(s.id);
    onselect(next);
  }

  // --- 「グループとして保存」: HTML からファイルは書けないので、groups.json に貼る JSON 片を渡す ---
  let saveOpen = $state(false);
  let saveNote = $state('');
  let snippetEl = $state<HTMLTextAreaElement | null>(null);
  let saveBtn = $state<HTMLButtonElement | null>(null);
  const selectedIds = $derived(sessions.filter((s) => selected.has(s.id)).map((s) => s.id).concat([...selected].filter((id) => !sessions.some((s) => s.id === id))));
  /** 貼る JSON(開いている間にチェックを変えても今の選択に追従する) */
  const snippet = $derived(groupSnippet(selectedIds));
  /** コマンドの例(省略せず全 id。README の起動方法と同じ npm run atlas -- の形) */
  const exampleCmd = $derived(`npm run atlas -- group add <名前> ${selectedIds.join(' ')}`);
  async function save(): Promise<void> {
    saveOpen = true;
    try {
      if (!navigator.clipboard) throw new Error('clipboard API なし');
      await navigator.clipboard.writeText(snippet);
      saveNote = `${int(selectedIds.length)} 件の id をクリップボードにコピーしました。下の欄にも同じものを出しています。`;
    } catch {
      saveNote = 'この環境ではクリップボードに書けないため、下の欄から選んでコピーしてください。';
    }
    requestAnimationFrame(() => snippetEl?.focus());
  }
  function closeSave(): void {
    saveOpen = false;
    requestAnimationFrame(() => saveBtn?.focus());
  }
</script>

<section class="section" id="sessions" aria-labelledby="sessions-h">
  <div class="section-head">
    <h2 id="sessions-h">セッション一覧</h2>
    <p>
      {int(sessions.length)} セッション。名前を押すと詳細(時系列・ツール内訳・指示ファイル・摩擦)を開きます。表は横にスクロールできます。
      {#if !judged}推定人手工数は未判定です(LLM による判定を実行すると表示されます)。{/if}
    </p>
  </div>

  <!-- 選択の操作列: チェックした件数と、その件数だけで集計 / 解除 / グループとして保存 -->
  <div class="select-bar" role="group" aria-label="セッションの選択">
    <p class="sel-count">
      <span aria-live="polite" aria-atomic="true"><strong data-testid="selected-count">{int(selected.size)}</strong> 件を選択中</span>{#if idsActive}<span class="tag on">この選択で集計中</span>{/if}
      {#if selected.size === 0}<span class="why">左端の欄にチェックを付けると、そのセッションだけで集計し直したり、名前付きグループとして保存できます。</span>{/if}
    </p>
    <div class="sel-actions">
      <button type="button" class="btn" data-testid="apply-selection" disabled={selected.size === 0} onclick={onapply}>選んだ {int(selected.size)} 件だけ集計</button>
      <!-- 選択で集計中は 0 件でも押せる(記録に無い id だけのグループを選んだときに条件を外す手段を残す) -->
      <button type="button" class="btn" disabled={selected.size === 0 && !idsActive} onclick={onclear}>選択を解除</button>
      <button type="button" class="btn" data-testid="save-group" bind:this={saveBtn} disabled={selected.size === 0} onclick={save}>グループとして保存</button>
    </div>
  </div>
  {#if saveOpen}
    <div class="save-box" id="group-snippet" role="region" aria-label="グループの保存">
      <p class="save-note" role="status">{saveNote}</p>
      <label class="snippet-field">
        <span class="k">groups.json に貼る JSON({int(selectedIds.length)} 件。チェックを変えると追従します)</span>
        <textarea class="snippet" readonly rows={Math.min(16, selectedIds.length + 6)} bind:this={snippetEl} onfocus={(e) => e.currentTarget.select()}>{snippet}</textarea>
      </label>
      <p class="save-how">
        <code>atlas-notes/groups.json</code> の <code>"groups"</code> の配列に貼り(既にグループがあれば、前の要素の後ろに <code>,</code> を付けて続けます)、<code>"name"</code> に名前を入れてください。ファイルが無ければ
        <code>{'{ "version": 1, "groups": [ … ] }'}</code> の形で作ります。コマンドなら、このリポジトリで <code>{exampleCmd}</code> を実行します(既にある名前なら id を追記します)。保存したグループは次の
        <code>npm run atlas -- build</code> で絞り込み行の「グループ」に出ます。
      </p>
      <button type="button" class="btn" onclick={closeSave}>閉じる</button>
    </div>
  {/if}

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
            <th scope="col" class="chk">
              <label>
                <input
                  type="checkbox"
                  aria-label="このページの {int(visible.length)} 件を選択"
                  checked={allVisible}
                  indeterminate={visibleChecked > 0 && !allVisible}
                  onchange={(e) => toggleVisible(e.currentTarget.checked)}
                />
              </label>
            </th>
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
            <tr class:picked={selected.has(s.id)}>
              <td class="chk"><label><input type="checkbox" aria-label="{title(s)} を選択" checked={selected.has(s.id)} onchange={(e) => toggle(s.id, e.currentTarget.checked)} /></label></td>
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    display: block;
    font-size: 0.75rem;
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

  /* 選択の操作列(表の見出しの直下、1 行。狭い画面では折り返す) */
  .select-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    flex-wrap: wrap;
    padding: 8px 0;
    border-bottom: 1px solid var(--rule);
    font-size: 0.8125rem;
  }
  .sel-count {
    margin: 0;
    color: var(--ink-2);
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sel-count strong {
    font-size: 1.0625rem;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .sel-count .tag.on {
    border-color: var(--form);
    color: var(--form);
    background: var(--form-wash);
  }
  .sel-count .why {
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .sel-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .sel-actions .btn {
    padding: 3px 10px;
  }
  /* チェック欄(表の左端。行全体をクリックの的にはしない: 名前はリンクで、誤って開くのを避ける) */
  .chk {
    width: 28px;
    padding: 0 2px 0 4px;
    text-align: center;
    vertical-align: top;
  }
  /* 押せる範囲は label で 28 × 28px 以上(印そのものは 16px のまま) */
  .chk label {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 32px;
    cursor: pointer;
  }
  .chk input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--form);
    cursor: pointer;
  }
  tr.picked td {
    background: var(--form-wash);
  }

  /* グループとして保存: 貼る JSON と手順 */
  .save-box {
    margin-top: 8px;
    padding: 10px 12px;
    border: 1px solid var(--form);
    background: var(--surface);
    display: grid;
    gap: 8px;
    justify-items: start;
  }
  .save-note {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--ink);
  }
  .snippet-field {
    display: block;
    width: 100%;
    max-width: 64ch;
  }
  .snippet-field .k {
    display: block;
    font-size: 0.6875rem;
    color: var(--form);
    margin-bottom: 2px;
  }
  .snippet {
    width: 100%;
    font: 0.75rem/1.5 ui-monospace, Consolas, 'Courier New', monospace;
    color: var(--ink);
    background: var(--form-wash);
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 6px 8px;
    resize: vertical;
  }
  .save-how {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    max-width: 90ch;
  }
  .save-how code {
    font-size: 0.75rem;
    background: var(--form-wash);
    padding: 0 3px;
  }
</style>
