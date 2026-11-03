<script lang="ts">
  // グループで絞り込んでいるときの見出し(本文の先頭)。名前・件数・説明と、「絞り込みを外す」。
  // 編集できるとき(atlas serve)は「編集」で名前と説明を 1 つの欄で直す。削除は編集欄の奥に置き、確認を 1 回挟む。
  // サイドバーのグループの一覧は切り替えだけにする(選ぶたびに操作の行が差し込まれて下の行がずれ、削除が改名と同じ重さで並んでいたため)
  import { untrack } from 'svelte';
  import { int } from '../../lib/format.ts';
  import type { ReportGroup } from '../../lib/types.ts';

  let {
    group,
    editable,
    onclear,
    onsave,
    ondelete,
  }: {
    group: ReportGroup & { present: number };
    editable: boolean;
    /** 絞り込みを外す(「すべて」に戻る) */
    onclear: () => void;
    /** 名前・説明の変わった分だけを送る(失敗は例外。理由を欄の下に出す) */
    onsave: (oldName: string, patch: { name?: string; note?: string }) => Promise<void>;
    ondelete: (name: string) => Promise<void>;
  } = $props();

  let mode = $state<'view' | 'edit' | 'delete'>('view');
  let name = $state('');
  let note = $state('');
  let error = $state('');
  let busy = $state(false);
  let nameEl = $state<HTMLInputElement | null>(null);
  let editBtn = $state<HTMLButtonElement | null>(null);
  let rootEl = $state<HTMLElement | null>(null);

  function begin(): void {
    name = group.name;
    note = group.note;
    error = '';
    mode = 'edit';
    requestAnimationFrame(() => nameEl?.select());
  }
  function leave(): void {
    mode = 'view';
    error = '';
    requestAnimationFrame(() => editBtn?.focus());
  }
  /** Esc は 1 段戻る(削除の確認 → 編集 → 表示)。外側の一覧は閉じない */
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || mode === 'view' || busy) return;
    e.stopPropagation();
    if (mode === 'delete') backToEdit();
    else leave();
  }
  async function run(action: () => Promise<void>, after: () => void): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
      after();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const n = name.trim();
    const t = note.trim();
    if (!n) {
      error = '名前を入れてください';
      nameEl?.focus();
      return;
    }
    const patch: { name?: string; note?: string } = {};
    if (n !== group.name) patch.name = n;
    if (t !== group.note) patch.note = t;
    if (!Object.keys(patch).length) {
      leave();
      return;
    }
    void run(() => onsave(group.name, patch), leave);
  }
  function backToEdit(): void {
    error = '';
    mode = 'edit';
    requestAnimationFrame(() => rootEl?.querySelector<HTMLButtonElement>('[data-testid="group-delete"]')?.focus());
  }
  function askDelete(): void {
    error = '';
    mode = 'delete';
    requestAnimationFrame(() => rootEl?.querySelector<HTMLButtonElement>('button[data-cancel]')?.focus());
  }
  // 外す・消すと見出しごと無くなるので、焦点は本文の先頭へ(押したボタンが消えて body に落ちないように)
  const focusMain = (): void => void requestAnimationFrame(() => document.getElementById('main')?.focus());
  function clear(): void {
    onclear();
    focusMain();
  }
  // 別のグループに移ったら、またはサーバが止まって編集できなくなったら、編集中の状態は捨てる。
  // 名前は文字列の derived で見る(group は一覧の追加・外しのたびに新しいオブジェクトになり、同じグループでも打ちかけの入力が消えるため)
  const groupName = $derived(group.name);
  $effect(() => {
    void groupName;
    // mode と rootEl は依存に入れない(入れると「編集」を押した直後にこの effect が走って表示に戻ってしまう)
    if (!editable) untrack(() => mode !== 'view' && rootEl?.contains(document.activeElement) && focusMain());
    mode = 'view';
    error = '';
  });
  const count = $derived(group.present === group.ids.length ? `${int(group.ids.length)} 件` : `${int(group.present)} / ${int(group.ids.length)} 件`);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Esc で 1 段戻すだけ。中の操作はどれもボタンと入力欄) -->
<section class="group-head" aria-labelledby="group-head-h" data-testid="group-head" aria-busy={busy} bind:this={rootEl} onkeydown={onKey}>
  {#if mode === 'view'}
    <div class="line">
      <div class="what">
        <p class="k">グループで絞り込み中</p>
        <h2 id="group-head-h"><span class="name">{group.name}</span><span class="cnt" aria-hidden="true" title={group.present === group.ids.length ? undefined : '記録にあるのは左の件数だけ'}>{count}</span><span class="sr-only">{group.present === group.ids.length ? `${int(group.ids.length)} 件` : `${int(group.ids.length)} 件のうち記録にあるのは ${int(group.present)} 件`}</span></h2>
        {#if group.note}<p class="desc">{group.note}</p>{:else if editable}<p class="desc none">説明はまだありません</p>{/if}
      </div>
      <div class="acts">
        {#if editable}<button type="button" class="btn" bind:this={editBtn} data-testid="group-edit" onclick={begin}>編集</button>{/if}
        <button type="button" class="btn" onclick={clear}>絞り込みを外す</button>
      </div>
    </div>
  {:else if mode === 'edit'}
    <form class="edit" aria-label="グループの編集" onsubmit={submit}>
      <p class="k">グループの編集</p>
      <h2 id="group-head-h" class="sr-only">グループ「{group.name}」の編集</h2>
      <div class="inputs">
        <label class="fld"><span class="k">名前</span><input type="text" bind:this={nameEl} bind:value={name} maxlength="100" readonly={busy} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'group-head-error' : undefined} /></label>
        <label class="fld wide"><span class="k">説明(任意)</span><input type="text" bind:value={note} maxlength="200" readonly={busy} placeholder="何のグループか" /></label>
      </div>
      <div class="edit-acts">
        <button type="submit" class="btn" aria-disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        <button type="button" class="btn" onclick={leave} disabled={busy}>取消</button>
        <!-- 取り消せない操作は保存と離して右端に、文字だけの弱い見た目で置く -->
        <button type="button" class="link danger" data-testid="group-delete" onclick={askDelete} disabled={busy}>このグループを削除…</button>
      </div>
    </form>
  {:else}
    <div class="confirm" role="group" aria-labelledby="group-head-h">
      <h2 id="group-head-h" class="q">グループ「{group.name}」を削除しますか</h2>
      <p class="desc">グループだけが消え、セッションと記録はそのまま残ります。</p>
      <div class="edit-acts">
        <button type="button" class="btn" data-cancel onclick={backToEdit} disabled={busy}>やめる</button>
        <button type="button" class="btn danger" data-confirm onclick={() => void run(() => ondelete(group.name), focusMain)} aria-disabled={busy}>{busy ? '削除中…' : '削除する'}</button>
      </div>
    </div>
  {/if}
  {#if error}<p class="err" id="group-head-error" role="alert">{error}</p>{/if}
</section>

<style>
  .group-head {
    margin-top: 16px;
    padding: 10px 14px 12px;
    background: var(--surface);
    /* 節の見出し(.section-head)と同じ 2px の罫を上に。様式の欄の作法に合わせ、片側だけの太い縁取りにはしない */
    border: 1px solid var(--rule);
    border-top: 2px solid var(--form);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px 24px;
  }
  .what {
    min-width: 0;
  }
  .k {
    display: block;
    margin: 0 0 2px;
    font-size: 0.6875rem;
    color: var(--form);
  }
  h2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 10px;
    margin: 0;
    font-size: 1.125rem;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .cnt {
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }
  .desc {
    margin: 4px 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    max-width: 75ch;
  }
  .desc.none {
    color: var(--ink-3);
  }
  .acts,
  .edit-acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }
  .edit-acts {
    margin-top: 10px;
  }
  /* base.css の .fields(様式の罫つきの欄)と名前がぶつからないよう別名にする */
  .inputs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .fld {
    display: block;
    flex: 1 1 14em;
    max-width: 22em;
  }
  .fld.wide {
    flex: 3 1 20em;
    max-width: 40em;
  }
  .fld input {
    font: inherit;
    font-size: 0.875rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 3px 6px;
    height: 30px;
    width: 100%;
  }
  .link {
    margin-left: auto;
    padding: 4px 0;
    font: inherit;
    font-size: 0.8125rem;
    background: none;
    border: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  .link.danger {
    color: var(--warn);
  }
  .link:disabled {
    color: var(--ink-3);
    cursor: default;
  }
  .q {
    font-size: 1rem;
  }
  .btn.danger {
    border-color: var(--warn);
    color: var(--warn);
  }
  .btn.danger:hover {
    background: var(--warn-wash);
  }
  .err {
    margin: 6px 0 0;
    font-size: 0.75rem;
    color: var(--warn);
  }
</style>
