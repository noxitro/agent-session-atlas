<script lang="ts">
  // 別のフォルダを開く: いつもの集計(この PC のセッション)とは別に、選んだフォルダを集計して別のタブで開く。
  // アップロード先(全員の分)・その下の人ごとのフォルダ(その人の分)・プロジェクトのフォルダのどれでも選べる。
  // 集計と表示は別のプロセス(atlas open)が行い、終わるとそのプロセスが新しいタブを開く。この画面は進み具合を出すだけ。
  import { tick } from 'svelte';
  import { foldersApi, type FolderCheck, type FolderEntry, type FolderList } from '../api.ts';
  import { dateTime } from '../../lib/format.ts';

  let { token, disabled }: { token: string; disabled: boolean } = $props();

  let dlg = $state<HTMLDialogElement | null>(null);
  let opener = $state<HTMLButtonElement | null>(null);
  let list = $state<FolderList | null>(null);
  let loadError = $state('');
  /** 実行中の操作(二度押しを防ぐ) */
  let busy = $state<string | null>(null);
  let error = $state('');
  let announce = $state('');
  /** いまの知らせが指しているフォルダと、そのときの状態(状態が変わったら、古い知らせを消す) */
  let said: { key: string; status: FolderEntry['status'] } | null = null;
  let pathInput = $state('');
  /** 調べたフォルダ(開く前に、何を読むかを確かめる) */
  let found = $state<Extract<FolderCheck, { ok: true }> | null>(null);
  /** この画面から開いたフォルダ(終わったときに知らせる) */
  let watching = $state<string[]>([]);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const POLL_MS = 1500;
  /** 開いているフォルダは、そのタブを閉じるとサーバが止まる。止まったことを一覧に出すために、ゆっくり読み直す */
  const WATCH_MS = 5000;
  const folders = $derived(list?.folders ?? []);
  const starting = $derived(folders.some((f) => f.status === 'starting'));
  const opened = $derived(folders.some((f) => f.status === 'open'));

  async function load(): Promise<void> {
    try {
      const next = await foldersApi.list(token);
      list = next;
      loadError = '';
      settle(next);
      // 知らせた後で状態が変わった(開いていたサーバが止まった、など)なら、合わなくなった知らせを消す
      const about = said;
      if (about && next.folders.find((x) => x.key === about.key)?.status !== about.status) say('');
    } catch (e) {
      loadError = (e as Error).message;
    }
  }
  function say(text: string, about?: FolderEntry): void {
    announce = text;
    said = about ? { key: about.key, status: about.status } : null;
  }
  /** この画面から開いたフォルダが、開いたか失敗したかを知らせる */
  function settle(next: FolderList): void {
    if (!watching.length) return;
    const rest: string[] = [];
    for (const key of watching) {
      const f = next.folders.find((x) => x.key === key);
      if (f?.status === 'starting') rest.push(key);
      else if (f?.status === 'open') say(`${f.name} を開きました。新しいタブが出ないときは「表示する」を押してください。`, f);
      else if (f?.status === 'failed') say(`${f.name} の集計に失敗しました。`, f);
    }
    watching = rest;
  }
  function stopPolling(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  /** 集計中のもの・開いているものがある間だけ、一覧を読み直す(集計中は進み具合を出すので短い間隔で) */
  function poll(): void {
    stopPolling();
    if (!dlg?.open || (!starting && !opened)) return;
    timer = setTimeout(
      async () => {
        await load();
        poll();
      },
      starting ? POLL_MS : WATCH_MS,
    );
  }
  $effect(() => {
    if (starting || opened) poll();
    return stopPolling;
  });
  /** 開いた先のタブから戻ってきたら、すぐ読み直す(裏のタブではタイマーが遅くなるので) */
  function refocus(): void {
    if (dlg?.open) void load().then(poll);
  }

  async function openDialog(): Promise<void> {
    error = '';
    say('');
    found = null;
    dlg?.showModal();
    await tick();
    dlg?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    await load();
    poll();
  }
  async function run(what: string, action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = what;
    error = '';
    try {
      await action();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = null;
    }
  }
  function show(c: FolderCheck | { path: null }): void {
    if (c.path === null) return;
    if (!c.ok) {
      found = null;
      pathInput = c.path;
      error = c.error;
      return;
    }
    found = c;
    pathInput = c.path;
  }
  /** 調べた結果が出たら「集計して開く」に焦点を移す(処理中はボタンを押せなくしているので、それが外れてから)。調べられなかったときは入力欄に戻す */
  async function focusGo(): Promise<void> {
    await tick();
    if (found) dlg?.querySelector<HTMLElement>('[data-folder-go]')?.focus();
    else if (error) dlg?.querySelector<HTMLElement>('[data-folder-path]')?.focus();
  }
  function pick(): void {
    void run('pick', async () => show(await foldersApi.pick(token))).then(focusGo);
  }
  function check(e: SubmitEvent): void {
    e.preventDefault();
    const p = pathInput.trim();
    if (!p) {
      error = 'フォルダのフルパスを入れてください';
      void focusGo();
      return;
    }
    found = null;
    void run('check', async () => show(await foldersApi.check(token, p))).then(focusGo);
  }
  /** 集計して開く。もう開いているなら、その場所を一覧に出す */
  function open(path: string, what: string): void {
    void run(what, async () => {
      const entry = await foldersApi.open(token, path);
      found = null;
      pathInput = '';
      if (entry.status === 'starting') {
        if (!watching.includes(entry.key)) watching = [...watching, entry.key];
        say(`${entry.name} を集計しています。`, entry);
      } else if (entry.status === 'open') say(`${entry.name} はもう開いています。一覧の「表示する」を押してください。`, entry);
      else if (entry.status === 'current') say(`${entry.name} はこの画面で表示しています。`, entry);
      else if (entry.status === 'failed') error = entry.error ?? '集計を始められませんでした';
      await load();
      poll();
      await tick();
      const row = dlg?.querySelector<HTMLElement>(`[data-folder-row="${entry.key}"]`);
      (row?.querySelector<HTMLElement>('a') ?? row)?.focus();
    });
  }
  function forget(f: FolderEntry): void {
    void run(`forget-${f.key}`, async () => {
      list = await foldersApi.forget(token, f.key);
      say(`${f.name} を一覧から外しました(集計の出力とメモは残しています)。`);
      await tick();
      dlg?.querySelector<HTMLElement>('[data-folder-path]')?.focus();
    });
  }
  function statusText(f: FolderEntry): string {
    if (f.status === 'current') return 'この画面で表示中';
    if (f.status === 'open') return '開いています';
    if (f.status === 'starting') return f.progress ? `集計しています… ${f.progress}` : '集計しています…';
    if (f.status === 'failed') return `失敗しました: ${f.error ?? '理由は分かりません'}`;
    return `前に開いた日時 ${dateTime(f.openedAt)}`;
  }
</script>

<svelte:window onfocus={refocus} />

<button type="button" class="btn open" {disabled} bind:this={opener} data-testid="folders-open" aria-haspopup="dialog" onclick={openDialog}>別のフォルダを開く…</button>

<dialog
  bind:this={dlg}
  class="folders-dialog"
  aria-labelledby="folders-h"
  data-testid="folders-dialog"
  onclose={() => {
    stopPolling();
    opener?.focus();
  }}
>
  <div class="head">
    <h2 id="folders-h">別のフォルダを開く</h2>
    <button type="button" class="btn close" data-autofocus data-testid="folders-close" onclick={() => dlg?.close()}>閉じる</button>
  </div>
  <p class="lead">
    この PC のセッションとは別に、選んだフォルダを集計して、新しいタブで開きます。アップロード先を選ぶと全員の分、その下の人のフォルダを選ぶとその人の分、プロジェクトのフォルダを選ぶとそのプロジェクトの分になります。集計の出力とメモは、フォルダごとに分けて置きます。
  </p>
  {#if loadError}
    <p class="err" role="alert">{loadError}</p>
  {:else if !list}
    <p class="note">読み込み中…</p>
  {:else}
    <fieldset class="body" disabled={disabled}>
      {#if list.current}
        <p class="cur" data-testid="folders-current">
          この画面: <b>{list.current.name}</b>(<code translate="no">{list.current.path}</code>)。
          {#if list.local.status === 'open' && list.local.url}
            <a href={list.local.url} target="_blank" rel="noopener" data-testid="folders-local">この PC のセッションを表示する</a>
          {:else}
            この PC のセッションは、atlas.bat を実行すると開きます。
          {/if}
        </p>
      {/if}

      <section class="sec" aria-labelledby="folders-pick-h">
        <h3 id="folders-pick-h">フォルダを選ぶ</h3>
        <form class="add" onsubmit={check}>
          {#if list.canPick}
            <button type="button" class="btn" disabled={!!busy} data-testid="folders-pick" onclick={pick}>{busy === 'pick' ? '選んでいます…' : 'エクスプローラーで選ぶ…'}</button>
          {/if}
          <label class="fld grow">
            <span class="k">{list.canPick ? 'または、フォルダのフルパス' : 'フォルダのフルパス'}</span>
            <input type="text" name="folder-path" bind:value={pathInput} spellcheck="false" autocomplete="off" placeholder="例: \\server\share\log…" data-folder-path data-testid="folders-path" />
          </label>
          <button type="submit" class="btn" disabled={!!busy} data-testid="folders-check">{busy === 'check' ? '調べています…' : '調べる'}</button>
        </form>
        {#if busy === 'pick'}<p class="note">フォルダを選ぶ画面を開きました。見えないときはタスクバーを確かめてください。</p>{/if}
        {#if error}<p class="err" role="alert" data-testid="folders-error">{error}</p>{/if}
        {#if found}
          {@const f = found}
          <div class="found" data-testid="folders-found">
            <p class="what"><b>{f.name}</b> <code translate="no">{f.path}</code></p>
            <p class="note">{f.summary}</p>
            <div class="actions">
              <button type="button" class="btn" disabled={!!busy} onclick={() => (found = null)}>やめる</button>
              <button type="button" class="btn primary" disabled={!!busy} data-folder-go data-testid="folders-go" onclick={() => open(f.path, 'open-found')}>{busy === 'open-found' ? '始めています…' : '集計して開く'}</button>
            </div>
          </div>
        {/if}
      </section>

      <section class="sec" aria-labelledby="folders-list-h">
        <h3 id="folders-list-h">開いたことのあるフォルダ</h3>
        <!-- 操作の結果(開いた・もう開いている・一覧から外した)。読み上げにも、目にも出す。空のときは高さを取らない -->
        <p class="status" role="status" data-testid="folders-status">{announce}</p>
        {#if folders.length}
          <ul class="items" data-testid="folders-list">
            {#each folders as f (f.key)}
              <li data-folder-row={f.key} data-status={f.status} tabindex="-1">
                <span class="what">
                  <b>{f.name}</b> <code translate="no">{f.path}</code>
                  <span class="meta" class:bad={f.status === 'failed'}>{statusText(f)}</span>
                </span>
                <span class="ops">
                  {#if f.status === 'open' && f.url}
                    <a href={f.url} target="_blank" rel="noopener" aria-label={`${f.name} を表示する(新しいタブ)`}>表示する</a>
                  {:else if f.status === 'idle' || f.status === 'failed'}
                    <button type="button" class="link" disabled={!!busy} aria-label={`${f.name} を集計して開く`} onclick={() => open(f.path, `open-${f.key}`)}>{busy === `open-${f.key}` ? '始めています…' : f.status === 'failed' ? 'もう一度開く' : '集計して開く'}</button>
                  {/if}
                  {#if f.status !== 'current' && f.status !== 'starting'}
                    <button type="button" class="link" disabled={!!busy} aria-label={`${f.name} を一覧から外す`} onclick={() => forget(f)}>一覧から外す</button>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
          {#if starting}<p class="note">集計が終わると、新しいタブで開きます。この画面を閉じても集計は続きます。</p>{/if}
        {:else}
          <p class="none">まだありません。上でフォルダを選ぶと、ここに並びます。</p>
        {/if}
      </section>
    </fieldset>
  {/if}
</dialog>

<style>
  .open {
    padding: 2px 10px;
  }
  .folders-dialog {
    width: min(44rem, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    overscroll-behavior: contain;
    padding: 16px 20px 18px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-top: 3px solid var(--form);
  }
  .folders-dialog::backdrop {
    background: rgba(14, 17, 16, 0.45);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
  }
  .head .close {
    flex: none;
    min-height: 32px;
  }
  .lead {
    margin: 10px 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .body {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .sec {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
  }
  .sec h3 {
    margin: 0;
    font-size: 0.9375rem;
  }
  .note,
  .none,
  .cur {
    margin: 4px 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .cur {
    margin-top: 10px;
  }
  .status {
    margin: 6px 0 0;
    font-size: 0.8125rem;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .status:empty {
    margin: 0;
  }
  .none {
    color: var(--ink-3);
  }
  .items {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  .items li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
    border-bottom: 1px solid var(--rule);
    font-size: 0.8125rem;
  }
  .what {
    min-width: 0;
    margin: 0;
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
  .meta {
    display: block;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .meta.bad {
    color: var(--warn);
  }
  .ops {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 2px 12px;
  }
  .ops a,
  .cur a {
    color: var(--form);
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px 10px;
    margin-top: 10px;
  }
  .found {
    margin-top: 10px;
    padding: 10px 12px;
    background: var(--form-wash);
    border: 1px solid var(--rule);
  }
  .fld {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
    display: block;
  }
  .fld.grow {
    flex: 1 1 16rem;
  }
  .fld .k {
    display: block;
    font-size: 0.6875rem;
    color: var(--form);
    margin-bottom: 2px;
  }
  .fld input {
    font: inherit;
    font-size: 0.875rem;
    width: 100%;
    height: 30px;
    padding: 3px 6px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
  }
  /* 既定の placeholder の色は、ダークの面の上で読みにくい */
  .fld input::placeholder {
    color: var(--ink-3);
    opacity: 1;
  }
  .err {
    margin: 8px 0 0;
    font-size: 0.8125rem;
    color: var(--warn);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .actions .btn,
  .add .btn {
    min-height: 30px;
  }
  .btn.primary {
    background: var(--form);
    color: var(--surface);
  }
  .btn.primary:hover {
    text-decoration: underline;
  }
  .btn.primary:disabled {
    background: var(--surface);
    color: var(--ink-3);
    text-decoration: none;
  }
  .link {
    font: inherit;
    font-size: 0.8125rem;
    color: var(--form);
    background: none;
    border: 0;
    padding: 2px 0;
    min-height: 24px;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:disabled {
    color: var(--ink-3);
    cursor: default;
  }
  /* 狭い幅では、パスの列が細くなりすぎないように、操作を下の段に回す */
  @media (max-width: 34rem) {
    .items li {
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
    }
    .ops {
      justify-content: flex-start;
    }
  }
</style>
