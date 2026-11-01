<script lang="ts">
  // グループの居場所: サイドバー(1280px 以上)の「グループ」の群と、狭い幅で目次行から開く一覧の両方で同じ中身。
  // 「すべて」→ 各グループ(名前と件数、現在に印)。現在のグループの行の下に、編集モードなら 改名 / 一文 / 削除(インライン、確認 1 回)。
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
    onrename,
    onnote,
    ondelete,
    uid = 'rail',
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
    onrename: (oldName: string, name: string) => Promise<void>;
    onnote: (name: string, note: string) => Promise<void>;
    ondelete: (name: string) => Promise<void>;
    /** 同じ画面に 2 つ置く(サイドバーと狭い幅の一覧)ので id の接頭辞を分ける */
    uid?: string;
  } = $props();

  let mode = $state<'none' | 'rename' | 'note' | 'delete'>('none');
  let text = $state('');
  let error = $state('');
  let busy = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);
  let toolsEl = $state<HTMLElement | null>(null);
  let rootEl = $state<HTMLElement | null>(null);
  /** 焦点の戻し先: 現在の行の操作、無ければこの一覧(自分のルート)の最初のボタン(document から探すと隠れた方の一覧に当たる) */
  const focusBack = (): void => void (toolsEl?.querySelector<HTMLButtonElement>('button') ?? rootEl?.querySelector<HTMLButtonElement>('button'))?.focus();
  const cur = $derived(current ? (groups.find((g) => g.name === current) ?? null) : null);

  function open(m: 'rename' | 'note' | 'delete'): void {
    if (!cur) return;
    text = m === 'rename' ? cur.name : m === 'note' ? cur.note : '';
    error = '';
    mode = m;
    requestAnimationFrame(() => {
      if (m === 'delete') toolsEl?.querySelector<HTMLButtonElement>('button[data-cancel]')?.focus();
      else inputEl?.select();
    });
  }
  function cancel(): void {
    mode = 'none';
    error = '';
    requestAnimationFrame(focusBack);
  }
  /** 入力欄の Esc は編集の取消(外側の一覧を閉じない) */
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && mode !== 'none') {
      e.stopPropagation();
      cancel();
    }
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
      mode = 'none';
      requestAnimationFrame(focusBack);
    } catch (e) {
      error = (e as Error).message;
      requestAnimationFrame(() => (inputEl ?? toolsEl?.querySelector<HTMLButtonElement>('button'))?.focus());
    } finally {
      busy = false;
    }
  }
  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (!cur) return;
    const v = text.trim();
    if (mode === 'rename') {
      if (!v) {
        error = '名前を入れてください';
        inputEl?.focus();
        return;
      }
      if (v === cur.name) {
        cancel();
        return;
      }
      void run(() => onrename(cur.name, v));
    } else if (mode === 'note') {
      if (v === cur.note) {
        cancel();
        return;
      }
      void run(() => onnote(cur.name, v));
    }
  }
  // 別のグループに移ったら編集中の状態は捨てる
  $effect(() => {
    void current;
    mode = 'none';
    error = '';
  });
  const count = (g: Group): string => (g.present === g.ids.length ? int(g.ids.length) : `${int(g.present)} / ${int(g.ids.length)}`);
</script>

<div class="group-rail" data-testid="group-rail" bind:this={rootEl}>
  {#if groups.length === 0 && selectedCount === 0}
    {#if editable}<p class="empty">グループはまだありません。一覧でセッションを選ぶと作れます。</p>{:else if !anonymized}<p class="empty">グループは atlas.bat から開くと作れます。</p>{/if}
  {:else}
    <ul class="list" role="list">
      <li><button type="button" class="row" aria-current={!current && selectedCount === 0 ? 'true' : undefined} onclick={() => onpick(null)}>すべて</button></li>
      {#if selectedCount > 0 && !current}
        <li><button type="button" class="row" aria-current="true" onclick={() => onpick(null)}>選んだ {int(selectedCount)} 件<span class="lead">一覧のチェックで集計中(押すと外す)</span></button></li>
      {/if}
      {#each groups as g (g.name)}
        <li>
          <button type="button" class="row" aria-current={current === g.name ? 'true' : undefined} onclick={() => onpick(current === g.name ? null : g.name)}>
            <span class="name">{g.name}</span><span class="cnt" aria-hidden="true">{count(g)}</span><span class="sr-only">{g.present === g.ids.length ? `${int(g.ids.length)} 件` : `${int(g.ids.length)} 件のうち記録にあるのは ${int(g.present)} 件`}</span>
            {#if g.note}<span class="lead">{g.note}</span>{/if}
          </button>
          {#if current === g.name && editable}
            <div class="tools" bind:this={toolsEl} data-testid="group-tools" aria-busy={busy}>
              {#if mode === 'none'}
                <button type="button" class="chip" onclick={() => open('rename')}>改名</button>
                <button type="button" class="chip" onclick={() => open('note')}>一文</button>
                <button type="button" class="chip" onclick={() => open('delete')}>削除</button>
              {:else if mode === 'delete'}
                <span class="confirm">「{g.name}」を削除しますか(セッションは消えません)。</span>
                <button type="button" class="btn" data-cancel onclick={cancel} disabled={busy}>取消</button>
                <button type="button" class="btn danger" data-confirm onclick={() => void run(() => ondelete(g.name))} aria-disabled={busy}>{busy ? '削除中…' : '削除する'}</button>
              {:else}
                <form class="inline-form" onsubmit={submit}>
                  <label class="fld"><span class="k">{mode === 'rename' ? '新しい名前' : '一文(空で消す)'}</span><input type="text" bind:this={inputEl} bind:value={text} onkeydown={onKey} maxlength={mode === 'rename' ? 100 : 200} readonly={busy} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${uid}-error` : undefined} /></label>
                  <span class="acts">
                    <button type="submit" class="btn" aria-disabled={busy}>{busy ? '保存中…' : '保存'}</button>
                    <button type="button" class="btn" onclick={cancel} disabled={busy}>取消</button>
                  </span>
                </form>
              {/if}
              {#if error}<span class="err" id="{uid}-error" role="alert">{error}</span>{/if}
            </div>
          {/if}
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
  .row:hover {
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
  /* 現在のグループの操作(改名 / 一文 / 削除)。行の下に小さく。編集中は入力欄に変わる */
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    padding: 6px 10px 8px 13px;
    border-bottom: 1px solid var(--rule);
    background: var(--surface);
  }
  .chip {
    font: inherit;
    font-size: 0.75rem;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--control);
    background: var(--surface);
    color: var(--ink-2);
    cursor: pointer;
  }
  .chip:hover {
    background: var(--form-wash);
  }
  .confirm {
    flex: 1 1 100%;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  .tools .btn {
    height: 26px;
    padding: 0 10px;
    font-size: 0.75rem;
  }
  .tools .btn.danger {
    border-color: var(--warn);
    color: var(--warn);
  }
  .tools .btn.danger:hover {
    background: var(--warn-wash);
  }
  .inline-form {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    width: 100%;
  }
  .fld {
    display: block;
    flex: 1 1 100%;
  }
  .fld .k {
    display: block;
    font-size: 0.6875rem;
    color: var(--form);
    margin-bottom: 2px;
  }
  .fld input {
    font: inherit;
    font-size: 0.8125rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 3px 6px;
    height: 28px;
    width: 100%;
  }
  .acts {
    display: flex;
    gap: 6px;
  }
  .err {
    flex: 1 1 100%;
    font-size: 0.75rem;
    color: var(--warn);
  }
</style>
