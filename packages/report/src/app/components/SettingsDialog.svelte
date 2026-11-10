<script lang="ts">
  // マストヘッドの「設定…」(atlas serve から開いたときだけ)。setup.bat と同じ設定を画面から決める:
  // llm-wiki の vault・普段の工程名・アップロード先・upload-project.bat がまとめて送るプロジェクト。
  // どれも押した時点で atlas.config.json に書く(サーバが設定ファイルのロックの中で読んでから書く)。vault は「集計し直す」で反映される。
  import { tick } from 'svelte';
  import { settingsApi, type Settings, type UploadHandlers, type VaultInfo, type WikiSetting } from '../api.ts';
  import type { JobStore } from '../jobs.svelte.ts';
  import { int } from '../../lib/format.ts';

  let {
    jobs,
    disabled,
    upload,
    send,
    projects,
  }: {
    jobs: JobStore;
    /** サーバが止まったときは押せない */
    disabled: boolean;
    /** アップロード先(App の uploadSetting。プロジェクト別の表・タスクタグの見出しと共通) */
    upload?: UploadHandlers;
    /** まとめて送るプロジェクトの印(プロジェクト別の表と共通) */
    send?: { projects: string[]; toggle: (project: string, on: boolean) => Promise<void> };
    /** 集計のプロジェクト(絞り込みに関係なく全部) */
    projects: { key: string; label: string; sessions: number }[];
  } = $props();

  type Section = 'wiki' | 'phases' | 'root' | 'projects';
  let dlg = $state<HTMLDialogElement | null>(null);
  let opener = $state<HTMLButtonElement | null>(null);
  let settings = $state<Settings | null>(null);
  let loadError = $state('');
  /** 何をしているか(その間はほかの操作を押せない。ボタンの文言を「…中」にする) */
  let busy = $state<string | null>(null);
  let errors = $state<Record<Section, string>>({ wiki: '', phases: '', root: '', projects: '' });
  /** vault を変えた(集計し直すと反映される) */
  let needsRefresh = $state(false);
  /** 読み上げる知らせ(常に置いてある status に入れる。差し込んだ要素の role=status は読まれないことがあるため) */
  let announce = $state('');

  /** 「a / b, c」や改行で区切った入力を一覧にする(setup.bat と同じ区切り) */
  const list = (s: string): string[] =>
    s
      .split(/[,、/／\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  async function openSettings(): Promise<void> {
    settings = null;
    loadError = '';
    errors = { wiki: '', phases: '', root: '', projects: '' };
    found = null;
    vaultInput = '';
    rootInput = '';
    phasesSaved = false;
    projectFilter = '';
    announce = '';
    dlg?.showModal();
    await tick();
    dlg?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    try {
      settings = await settingsApi.get(jobs.token);
      phasesInput = (settings.phases ?? settings.defaultPhases).join(' / ');
    } catch (e) {
      loadError = (e as Error).message;
    }
  }
  /** 1 つずつ動かす(書いている間に別の操作で設定を書かない)。失敗したら理由をその欄に出す */
  async function run(section: Section, what: string, action: () => Promise<void>, onFail?: () => void): Promise<void> {
    if (busy) return;
    busy = what;
    errors[section] = '';
    try {
      await action();
    } catch (e) {
      errors[section] = (e as Error).message;
      onFail?.();
    } finally {
      busy = null;
    }
  }

  // --- llm-wiki の vault ---
  let vaultInput = $state('');
  /** 調べた vault(足す前に、ページのフォルダ・索引・skill を確かめる) */
  let found = $state<VaultInfo | null>(null);
  let pages = $state('');
  let index = $state('');
  let skillPick = $state<string[]>([]);
  let skillMore = $state('');
  function foundVault(v: VaultInfo): void {
    found = v;
    pages = v.pagesDir ?? '.';
    index = '';
    // skill は vault をまたいで数えるので、ほかの vault でもう数えている候補は選ばない(setup.bat と同じ)
    skillPick = (settings?.skillCandidates ?? []).filter((s) => !settings?.wikis.some((w) => w.skills?.includes(s)));
    skillMore = '';
    void tick().then(() => dlg?.querySelector<HTMLInputElement>('[data-vault-pages]')?.focus());
  }
  function pickVault(): void {
    void run('wiki', 'vault-pick', async () => {
      const v = await settingsApi.pickVault(jobs.token);
      if (v) foundVault(v);
    });
  }
  function describeVault(e: SubmitEvent): void {
    e.preventDefault();
    if (!vaultInput.trim()) {
      errors.wiki = 'vault のフォルダ名かパスを入力してください';
      return;
    }
    void run('wiki', 'vault-describe', async () => foundVault(await settingsApi.describeVault(jobs.token, vaultInput)));
  }
  function addVault(e: SubmitEvent): void {
    e.preventDefault();
    const v = found;
    if (!v) return;
    const spec: WikiSetting = { path: v.name, pages: list(pages), index: list(index), skills: [...skillPick, ...list(skillMore)] };
    void run('wiki', 'vault-add', async () => {
      settings = await settingsApi.addWiki(jobs.token, spec);
      found = null;
      vaultInput = '';
      needsRefresh = true;
      announce = `vault「${spec.path}」を足しました。反映するには集計し直します。`;
    });
  }
  function removeVault(i: number, path: string): void {
    void run('wiki', `vault-remove-${i}`, async () => {
      settings = await settingsApi.removeWiki(jobs.token, i, path);
      needsRefresh = true;
      announce = `vault「${path}」を外しました。反映するには集計し直します。`;
    });
  }
  /** vault の指定を 1 行で(ページ・索引・skill) */
  function wikiNote(w: WikiSetting): string {
    const parts = [`ページ: ${w.pages?.length ? w.pages.join('、') : 'vault 全体'}`, `索引: ${w.index?.length ? w.index.join('、') : 'index.md'}`];
    if (w.skills?.length) parts.push(`skill: ${w.skills.join('、')}`);
    return parts.join('・');
  }
  async function refresh(): Promise<void> {
    if (await jobs.run({ kind: 'refresh' })) {
      needsRefresh = false;
      dlg?.close();
    } else errors.wiki = jobs.error;
  }

  // --- 普段の工程名 ---
  let phasesInput = $state('');
  let phasesSaved = $state(false);
  function savePhases(e: SubmitEvent): void {
    e.preventDefault();
    const phases = list(phasesInput);
    phasesSaved = false;
    void run('phases', 'phases', async () => {
      settings = await settingsApi.setPhases(jobs.token, phases);
      phasesInput = (settings.phases ?? settings.defaultPhases).join(' / ');
      phasesSaved = true;
      announce = '普段の工程名を保存しました。';
    });
  }
  function resetPhases(): void {
    phasesSaved = false;
    void run('phases', 'phases-reset', async () => {
      settings = await settingsApi.setPhases(jobs.token, null);
      phasesInput = settings.defaultPhases.join(' / ');
      phasesSaved = true;
      announce = '普段の工程名を既定に戻しました。';
    });
  }

  // --- アップロード先(App の uploadSetting を通して書く。タスクタグの見出しと同じ) ---
  let rootInput = $state('');
  function pickRoot(): void {
    if (!upload) return;
    const u = upload;
    void run('root', 'root-pick', async () => {
      const r = await u.pick();
      if (r) announce = `アップロード先を ${r} にしました。`;
    });
  }
  function setRoot(e: SubmitEvent): void {
    e.preventDefault();
    if (!upload) return;
    const u = upload;
    const r = rootInput.trim();
    if (!r) {
      errors.root = 'フォルダのフルパスを入れてください';
      return;
    }
    void run('root', 'root-set', async () => {
      const saved = await u.setRoot(r);
      rootInput = '';
      announce = `アップロード先を ${saved} にしました。`;
    });
  }

  // --- まとめて送るプロジェクト(プロジェクト別の表の印と同じ) ---
  let projectFilter = $state('');
  const sendSet = $derived(new Set(send?.projects ?? []));
  const sortedProjects = $derived([...projects].sort((a, b) => a.label.localeCompare(b.label, 'ja')));
  const shownProjects = $derived(projectFilter.trim() ? sortedProjects.filter((p) => p.label.toLowerCase().includes(projectFilter.trim().toLowerCase())) : sortedProjects);
  /** 印はあるが、今の集計に無いもの(外せるように出す) */
  const missingMarked = $derived((send?.projects ?? []).filter((k) => !projects.some((p) => p.key === k)));
  function toggleProject(e: Event, key: string): void {
    if (!send) return;
    const s = send;
    const box = e.currentTarget as HTMLInputElement;
    const on = box.checked;
    void run(
      'projects',
      `project-${key}`,
      () => s.toggle(key, on),
      () => (box.checked = !on),
    );
  }
  function removeMissing(key: string): void {
    if (!send) return;
    const s = send;
    void run('projects', `project-${key}`, () => s.toggle(key, false));
  }
</script>

<button type="button" class="btn open" disabled={disabled} bind:this={opener} data-testid="settings-open" aria-haspopup="dialog" onclick={openSettings}>設定…</button>

<dialog bind:this={dlg} class="settings-dialog" aria-labelledby="settings-h" data-testid="settings-dialog" onclose={() => opener?.focus()}>
  <div class="head">
    <h2 id="settings-h">設定</h2>
    <button type="button" class="btn close" data-autofocus data-testid="settings-close" onclick={() => dlg?.close()}>閉じる</button>
  </div>
  <p class="lead">setup.bat と同じ設定を、ここでも決められます。どれも押した時点で設定ファイルに書きます{#if settings}(<code translate="no">{settings.configPath}</code>){/if}。</p>
  <p class="sr-only" role="status" data-testid="settings-status">{announce}</p>
  {#if loadError}
    <p class="err" role="alert">設定を読めませんでした: {loadError}</p>
  {:else if !settings}
    <p class="lead" role="status">設定を読んでいます…</p>
  {:else}
    {#if settings.error}<p class="err" role="alert" data-testid="settings-config-error">設定ファイルを読めないので、ここでは変えられません({settings.error})。setup.bat で作り直すか手で直してから、開き直してください。</p>{/if}
    <fieldset class="all" disabled={!!settings.error}>
      <section class="sec" aria-labelledby="set-wiki-h" data-testid="settings-wiki">
        <h3 id="set-wiki-h">llm-wiki の vault</h3>
        <p class="note">参照を数える wiki のフォルダです。変えたら「集計し直す」で反映されます。</p>
        {#if settings.wikis.length}
          <ul class="items">
            {#each settings.wikis as w, i (`${i}:${w.path}`)}
              <li>
                <span class="what"><code translate="no">{w.path}</code><span class="meta">{wikiNote(w)}</span></span>
                <button type="button" class="link" aria-label={`vault「${w.path}」を外す`} disabled={!!busy} onclick={() => removeVault(i, w.path)}>{busy === `vault-remove-${i}` ? '外しています…' : '外す'}</button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="none">まだありません(wiki の参照は数えません)。</p>
        {/if}
        {#if !found}
          <form class="add" onsubmit={describeVault} aria-label="vault を足す">
            {#if settings.canPick}<button type="button" class="btn" disabled={!!busy} data-testid="settings-vault-pick" onclick={pickVault}>{busy === 'vault-pick' ? '選んでいます…' : 'エクスプローラーで選ぶ…'}</button>{/if}
            <label class="fld grow"><span class="k">または、フォルダ名かパス</span><input type="text" bind:value={vaultInput} spellcheck="false" autocomplete="off" placeholder="my-notes" data-testid="settings-vault-input" /></label>
            <button type="submit" class="btn" disabled={!!busy}>{busy === 'vault-describe' ? '調べています…' : '調べる'}</button>
          </form>
          {#if busy === 'vault-pick'}<p class="note">フォルダを選ぶ画面を開きました。見えないときはタスクバーを確かめてください。</p>{/if}
        {:else}
          <form class="found" onsubmit={addVault} aria-label="足す vault の指定" data-testid="settings-vault-found">
            <p class="what-found">
              {#if found.dir}フォルダ名「<strong>{found.name}</strong>」で足します(フルパスより、エージェントの書き方の違いに強いため)。{:else}「<strong>{found.name}</strong>」で足します(フォルダが見つからないので、中は確かめていません)。{/if}
            </p>
            {#if found.dir && !found.hasIndex}
              <label class="fld"><span class="k">索引のファイル名(index.md がありません。vault からの相対。無ければ空)</span><input type="text" bind:value={index} spellcheck="false" autocomplete="off" /></label>
            {/if}
            <label class="fld"><span class="k">個別ページを置くフォルダ(vault からの相対。. は vault 全体。, で区切って複数)</span><input type="text" bind:value={pages} spellcheck="false" autocomplete="off" data-vault-pages /></label>
            {#if settings.skillCandidates.length}
              <fieldset class="fld">
                <legend class="k">wiki の skill として数えるもの(インストール済みの skill のうち、名前に wiki を含むもの)</legend>
                {#each settings.skillCandidates as s (s)}<label class="opt"><input type="checkbox" value={s} bind:group={skillPick} />{s}</label>{/each}
              </fieldset>
            {/if}
            <label class="fld"><span class="k">ほかに wiki の skill として数える名前(, で区切って。無ければ空)</span><input type="text" bind:value={skillMore} spellcheck="false" autocomplete="off" /></label>
            <div class="actions">
              <button type="button" class="btn" disabled={!!busy} onclick={() => (found = null)}>やめる</button>
              <button type="submit" class="btn primary" disabled={!!busy} data-testid="settings-vault-add">{busy === 'vault-add' ? '足しています…' : 'この vault を足す'}</button>
            </div>
          </form>
        {/if}
        {#if needsRefresh}
          <p class="refresh" data-testid="settings-refresh">
            vault を変えました。反映するには集計し直します。
            <button type="button" class="btn" disabled={jobs.running || jobs.busy} onclick={() => void refresh()}>集計し直す</button>
          </p>
        {/if}
        {#if errors.wiki}<p class="err" role="alert">{errors.wiki}</p>{/if}
      </section>

      <section class="sec" aria-labelledby="set-phases-h" data-testid="settings-phases">
        <h3 id="set-phases-h">普段の工程名</h3>
        <p class="note">「判定する…」で依頼ごとの採用を判定するとき、LLM に選ばせる工程です。{settings.phases ? '' : '今は既定のままです。'}</p>
        <form class="add" onsubmit={savePhases} aria-label="普段の工程名">
          <label class="fld grow"><span class="k">工程名(/ か , で区切って 2 つ以上)</span><input type="text" bind:value={phasesInput} autocomplete="off" data-testid="settings-phases-input" oninput={() => (phasesSaved = false)} /></label>
          <button type="submit" class="btn" disabled={!!busy}>{busy === 'phases' ? '保存しています…' : '保存'}</button>
          {#if settings.phases}<button type="button" class="link" disabled={!!busy} onclick={resetPhases}>既定に戻す</button>{/if}
        </form>
        {#if phasesSaved}<p class="ok" data-testid="settings-phases-saved">保存しました。</p>{/if}
        {#if errors.phases}<p class="err" role="alert">{errors.phases}</p>{/if}
      </section>

      {#if upload}
        <section class="sec" aria-labelledby="set-root-h" data-testid="settings-root">
          <h3 id="set-root-h">アップロード先</h3>
          <p class="note">タスクタグの「アップロード」と upload-project.bat が、この中にタスクタグ名・プロジェクト名のフォルダを作って写します。</p>
          <p class="cur" data-testid="settings-root-current">{#if upload.setting.root}<code translate="no">{upload.setting.root}</code>{:else}<span class="none">まだ決まっていません</span>{/if}</p>
          <form class="add" onsubmit={setRoot} aria-label="アップロード先を決める">
            {#if upload.setting.canPick}<button type="button" class="btn" disabled={!!busy} data-testid="settings-root-pick" onclick={pickRoot}>{busy === 'root-pick' ? '選んでいます…' : 'エクスプローラーで選ぶ…'}</button>{/if}
            <label class="fld grow"><span class="k">または、フォルダのフルパス</span><input type="text" bind:value={rootInput} spellcheck="false" autocomplete="off" placeholder={'E:\\dev\\atlas-logs'} /></label>
            <button type="submit" class="btn" disabled={!!busy}>{busy === 'root-set' ? '保存しています…' : '入力したパスにする'}</button>
          </form>
          {#if busy === 'root-pick'}<p class="note">フォルダを選ぶ画面を開きました。見えないときはタスクバーを確かめてください。</p>{/if}
          {#if errors.root}<p class="err" role="alert">{errors.root}</p>{/if}
        </section>
      {/if}

      {#if send}
        <section class="sec" aria-labelledby="set-projects-h" data-testid="settings-projects">
          <h3 id="set-projects-h">まとめて送るプロジェクト</h3>
          <p class="note">印を付けたプロジェクトを、upload-project.bat が番号を聞かずにまとめて送ります。今 {int(send.projects.length)} 件。「プロジェクト別」の表の「まとめて送る」と同じ設定です。</p>
          <label class="fld"><span class="k">プロジェクト名で絞り込む</span><input type="search" bind:value={projectFilter} autocomplete="off" data-testid="settings-projects-filter" /></label>
          <ul class="checks">
            {#each shownProjects as p (p.key)}
              <li><label class="opt"><input type="checkbox" checked={sendSet.has(p.key)} disabled={!!busy} onchange={(e) => toggleProject(e, p.key)} /><span class="pname">{p.label}</span><span class="meta">{int(p.sessions)} 件</span></label></li>
            {:else}
              <li class="none">当てはまるプロジェクトはありません。</li>
            {/each}
          </ul>
          {#if missingMarked.length}
            <p class="note">
              印はあるが、今の集計に無いもの:
              {#each missingMarked as k (k)}<span class="miss"><code translate="no">{k}</code> <button type="button" class="link" disabled={!!busy} onclick={() => removeMissing(k)}>外す</button></span>{/each}
            </p>
          {/if}
          {#if errors.projects}<p class="err" role="alert">{errors.projects}</p>{/if}
        </section>
      {/if}
    </fieldset>
  {/if}
</dialog>

<style>
  .open {
    padding: 2px 10px;
  }
  .settings-dialog {
    width: min(44rem, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 16px 20px 18px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-top: 3px solid var(--form);
  }
  .settings-dialog::backdrop {
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
  .settings-dialog h2 {
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
  .all {
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
    overflow-wrap: anywhere;
  }
  .meta {
    display: block;
    font-size: 0.75rem;
    color: var(--ink-3);
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
  .found .fld + .fld {
    margin-top: 8px;
  }
  .what-found {
    margin: 0 0 8px;
    font-size: 0.8125rem;
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
    padding: 0;
    font-size: 0.6875rem;
    color: var(--form);
    margin-bottom: 2px;
  }
  .fld input[type='text'],
  .fld input[type='search'] {
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
  .opt {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    margin-right: 14px;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .opt input {
    margin: 0;
    accent-color: var(--form);
  }
  .checks {
    list-style: none;
    margin: 8px 0 0;
    padding: 4px 8px;
    max-height: 16rem;
    overflow: auto;
    border: 1px solid var(--rule);
  }
  .checks .opt {
    display: flex;
    margin: 0;
  }
  .pname {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .checks .meta {
    display: inline;
  }
  .miss {
    margin-left: 8px;
  }
  .refresh {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 10px 0 0;
    padding: 8px 10px;
    font-size: 0.8125rem;
    background: var(--form-wash);
    border: 1px solid var(--rule);
  }
  .ok {
    margin: 6px 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .err {
    margin: 8px 0 0;
    font-size: 0.8125rem;
    color: var(--warn);
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
    background: var(--form);
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
</style>
