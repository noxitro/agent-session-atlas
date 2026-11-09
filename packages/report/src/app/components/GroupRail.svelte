<script lang="ts">
  // グループの居場所: サイドバー(768px 以上)の「グループ」の群と、狭い幅で目次行から開く一覧の両方で同じ中身。
  // 「すべて」→ 各グループ(名前と件数、現在に印)。ここは切り替えだけ。名前・説明の編集と削除は本文の見出し(GroupHead)に置く
  import { int } from '../../lib/format.ts';
  import type { ReportGroup } from '../../lib/types.ts';

  type Group = ReportGroup & { presentIds: string[]; present: number };
  let {
    groups,
    current,
    selectedCount,
    editable,
    anonymized,
    onpick,
  }: {
    groups: Group[];
    /** 現在のグループ名(無ければ null) */
    current: string | null;
    /** グループでなく一覧のチェックから集計しているときの件数(0 なら無し) */
    selectedCount: number;
    editable: boolean;
    anonymized: boolean;
    /** null で「すべて」 */
    onpick: (name: string | null) => void;
  } = $props();

  const count = (g: Group): string => (g.present === g.ids.length ? int(g.ids.length) : `${int(g.present)} / ${int(g.ids.length)}`);
</script>

<div class="group-rail" data-testid="group-rail">
  {#if groups.length === 0 && selectedCount === 0}
    {#if editable}<p class="empty">グループはまだありません。一覧でセッションを選ぶと作れます。</p>{:else if !anonymized}<p class="empty">グループは atlas.bat から開くと作れます。</p>{/if}
  {:else}
    <ul class="list" role="list">
      <li><button type="button" class="row" aria-current={!current && selectedCount === 0 ? 'true' : undefined} onclick={() => onpick(null)}>すべて</button></li>
      {#if selectedCount > 0 && !current}
        <!-- 一覧のチェックで集計している状態の印(押して外す隠れた操作にはしない。外すのは「すべて」か一覧の「選択を解除」) -->
        <li><p class="row now" aria-current="true">選んだ {int(selectedCount)} 件<span class="lead">一覧のチェックで集計中</span></p></li>
      {/if}
      {#each groups as g (g.name)}
        <li>
          <button type="button" class="row" aria-current={current === g.name ? 'true' : undefined} onclick={() => onpick(g.name)}>
            <span class="name">{g.name}</span><span class="cnt" aria-hidden="true">{count(g)}</span><span class="sr-only">{g.present === g.ids.length ? `${int(g.ids.length)} 件` : `${int(g.ids.length)} 件のうち記録にあるのは ${int(g.present)} 件`}</span>
            {#if g.note}<span class="lead">{g.note}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .group-rail {
    font-size: 0.8125rem;
  }
  .empty {
    margin: 4px 0 0;
    padding: 4px 10px;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    /* 件数が多いときはこの群の中だけ縦に流す */
    max-height: 40vh;
    overflow-y: auto;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 6px;
    width: 100%;
    min-height: 30px;
    padding: 4px 10px;
    font: inherit;
    text-align: left;
    color: var(--ink-2);
    background: none;
    border: 0;
    border-bottom: 1px solid var(--rule);
    border-left: 3px solid transparent;
    cursor: pointer;
  }
  .row.now {
    margin: 0;
    cursor: default;
  }
  .row:not(.now):hover {
    background: var(--form-wash);
    color: var(--form);
  }
  .row[aria-current] {
    background: var(--form-wash);
    border-left-color: var(--form);
    color: var(--form);
    font-weight: 600;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .cnt {
    margin-left: auto;
    color: var(--ink-3);
    font-size: 0.75rem;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .lead {
    flex-basis: 100%;
    font-size: 0.75rem;
    color: var(--ink-3);
    font-weight: 400;
  }
  .row[aria-current] .lead {
    color: var(--ink-2);
  }
</style>
