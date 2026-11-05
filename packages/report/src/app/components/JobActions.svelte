<script lang="ts">
  // Phase 14: マストヘッドの操作「集計し直す」「工数を判定する…」(atlas serve から開いたときだけ)。
  // 判定は AI クレジットを消費するので、必ず確認ダイアログ(件数・バックエンド・費用)を通す。「やめる」では API を呼ばない。
  // ダイアログでは判定の方法を選べる: このツールから(copilot -p / opencode)か、チャットに貼る(M365 Copilot など。ChatJudge)。選んだ方法はこのブラウザに覚える。
  import { tick } from 'svelte';
  import { jobsApi, type JobBackend } from '../api.ts';
  import type { JobStore } from '../jobs.svelte.ts';
  import { int } from '../../lib/format.ts';
  import ChatJudge from './ChatJudge.svelte';

  let { jobs, disabled }: { jobs: JobStore; disabled: boolean } = $props();

  const LIMIT_MAX = 500;
  let dlg = $state<HTMLDialogElement | null>(null);
  let opener = $state<HTMLButtonElement | null>(null);
  let open = $state(false);
  const METHOD_KEY = 'atlas.judge-method';
  type Method = 'tool' | 'chat';
  let method = $state<Method>(readMethod());
  function readMethod(): Method {
    try {
      return localStorage.getItem(METHOD_KEY) === 'chat' ? 'chat' : 'tool';
    } catch {
      return 'tool';
    }
  }
  function setMethod(m: Method): void {
    method = m;
    try {
      localStorage.setItem(METHOD_KEY, m);
    } catch {
      /* 覚えられなくても選んだ方法では動く */
    }
  }
  /** 初期フォーカス: このツールからなら「やめる」(Enter の押し間違いで費用のかかる処理を始めない)、チャットなら「閉じる」 */
  async function focusInitial(): Promise<void> {
    await tick();
    // 「閉じる」はチャットの手順の下にあるので、フォーカスで送らずに表題から見せる
    dlg?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    if (dlg) dlg.scrollTop = 0;
  }
  let preview = $state<{ eligible: number; judged: number; pending: number } | null>(null);
  let previewError = $state('');
  let runError = $state('');
  let limit = $state<number | null>(10);
  let backend = $state<JobBackend>('copilot-cli');
  const off = $derived(disabled || jobs.running || jobs.busy);
  const limitOk = $derived(typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= LIMIT_MAX);
  /** 実際に判定する件数(未判定のうち上限まで) */
  const count = $derived(preview && limitOk ? Math.min(preview.pending, limit as number) : 0);

  async function openJudge(): Promise<void> {
    preview = null;
    previewError = '';
    runError = '';
    open = true;
    dlg?.showModal();
    await focusInitial();
    try {
      preview = await jobsApi.judgePreview(jobs.token);
    } catch (e) {
      previewError = (e as Error).message;
    }
  }
  async function runJudge(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!limitOk || count < 1 || jobs.busy) return;
    if (await jobs.run({ kind: 'judge', limit: limit as number, backend })) dlg?.close();
    else runError = jobs.error;
  }
</script>

<div class="job-actions" role="group" aria-label="集計と判定">
  <button type="button" class="btn" disabled={off} data-testid="job-refresh" onclick={() => void jobs.run({ kind: 'refresh' })}>集計し直す</button>
  <button type="button" class="btn" disabled={off} bind:this={opener} data-testid="job-judge" aria-haspopup="dialog" onclick={openJudge}>工数を判定する…</button>
</div>

<dialog
  bind:this={dlg}
  class="judge-dialog"
  class:wide={method === 'chat'}
  aria-labelledby="judge-h"
  aria-describedby={method === 'tool' ? 'judge-cost' : undefined}
  data-testid="judge-dialog"
  onclose={() => {
    open = false;
    opener?.focus();
  }}
>
  <h2 id="judge-h">工数を判定する</h2>
  <fieldset class="fld method">
    <legend class="k">判定の方法</legend>
    <label class="opt"><input type="radio" name="judge-method" value="tool" checked={method === 'tool'} onchange={() => setMethod('tool')} data-testid="judge-method-tool" />このツールから(copilot -p / opencode)</label>
    <label class="opt"><input type="radio" name="judge-method" value="chat" checked={method === 'chat'} onchange={() => setMethod('chat')} data-testid="judge-method-chat" />チャットに貼る(M365 Copilot など)</label>
  </fieldset>
  {#if method === 'chat'}
    {#if open}<ChatJudge {jobs} onclose={() => dlg?.close()} />{/if}
  {:else}
    <form onsubmit={runJudge} aria-busy={jobs.busy}>
      <p class="lead">未判定のセッションを LLM に判定させ、推定人手工数をレポートに足します。評価バンドルを作り直し、判定し、記録つきでレポートを作り直します。</p>
      <div class="row">
        <label class="fld"><span class="k">件数の上限</span><input type="number" name="judge-limit" autocomplete="off" min="1" max={LIMIT_MAX} step="1" inputmode="numeric" bind:value={limit} aria-invalid={limitOk ? undefined : 'true'} aria-describedby="judge-count" data-testid="judge-limit" /></label>
        <fieldset class="fld">
          <legend class="k">バックエンド</legend>
          <label class="opt"><input type="radio" name="judge-backend" value="copilot-cli" bind:group={backend} />copilot -p(既定)</label>
          <label class="opt"><input type="radio" name="judge-backend" value="opencode" bind:group={backend} />opencode</label>
        </fieldset>
      </div>
      <p class="count" id="judge-count" role="status" data-testid="judge-count">
        {#if !limitOk}件数の上限は 1〜{LIMIT_MAX} の整数で指定してください。
        {:else if previewError}未判定の件数を数えられませんでした: {previewError}
        {:else if !preview}未判定の件数を数えています…
        {:else if preview.pending === 0}未判定のセッションはありません(判定済み {int(preview.judged)} 件)。
        {:else}未判定 {int(preview.pending)} 件のうち <strong>{int(count)} 件</strong>を判定します(判定済み {int(preview.judged)} 件は判定し直しません)。{/if}
      </p>
      <p class="cost" id="judge-cost">
        <strong>AI クレジットを消費します。</strong>
        {#if backend === 'copilot-cli'}GitHub Copilot の AI クレジットを、1 件につき 1 回以上の copilot -p の分だけ使います。{:else}opencode の既定のモデルで判定します。そのモデルの提供元のクレジットや利用料を、1 件につき 1 回以上使います。{/if}
        従量課金の Anthropic API は画面からは使えません(CLI の --backend anthropic)。
      </p>
      {#if runError}<p class="err" role="alert">{runError}</p>{/if}
      <div class="actions">
        <button type="button" class="btn" data-autofocus data-testid="judge-cancel" onclick={() => dlg?.close()}>やめる</button>
        <button type="submit" class="btn primary" disabled={count < 1 || jobs.busy} data-testid="judge-run">{jobs.busy ? '開始しています…' : count > 0 ? `${int(count)} 件を判定する` : '判定する'}</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  .job-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .job-actions .btn {
    padding: 2px 10px;
  }
  .judge-dialog {
    width: min(36rem, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 16px 20px 18px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-top: 3px solid var(--form);
  }
  .judge-dialog.wide {
    width: min(42rem, calc(100vw - 32px));
  }
  .method {
    margin-top: 10px;
  }
  .judge-dialog::backdrop {
    background: rgba(14, 17, 16, 0.45);
  }
  .judge-dialog h2 {
    font-size: 1.0625rem;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
  }
  .lead {
    margin: 10px 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .row {
    display: flex;
    gap: 10px 24px;
    flex-wrap: wrap;
    align-items: flex-start;
    margin-top: 12px;
  }
  .fld {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .fld .k {
    display: block;
    padding: 0;
    font-size: 0.6875rem;
    color: var(--form);
    margin-bottom: 2px;
  }
  .fld input[type='number'] {
    font: inherit;
    font-size: 0.875rem;
    width: 7em;
    height: 30px;
    padding: 3px 6px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    font-variant-numeric: tabular-nums;
  }
  .fld input[aria-invalid='true'] {
    border-color: var(--warn);
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
  .count {
    margin: 12px 0 0;
    padding: 8px 10px;
    font-size: 0.8125rem;
    background: var(--form-wash);
    border: 1px solid var(--rule);
  }
  .cost {
    margin: 8px 0 0;
    padding: 8px 10px;
    font-size: 0.8125rem;
    background: var(--warn-wash);
    border: 1px solid var(--warn);
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
    margin-top: 16px;
  }
  .actions .btn {
    min-height: 32px;
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
</style>
