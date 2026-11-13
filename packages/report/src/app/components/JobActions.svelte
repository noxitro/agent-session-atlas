<script lang="ts">
  // Phase 14: マストヘッドの操作「集計し直す」「判定する…」(atlas serve から開いたときだけ)。
  // 判定は AI クレジットを消費するので、必ず確認ダイアログ(件数・バックエンド・費用)を通す。「やめる」では API を呼ばない。
  // ダイアログでは判定するもの(工数 = セッションごと / 依頼ごとの採用)と、判定の方法を選べる:
  // このツールから(copilot -p)か、チャットに貼る(M365 Copilot など。ChatJudge)。選んだものはこのブラウザに覚える。
  import { tick } from 'svelte';
  import { jobsApi, type JudgePreview, type JudgeTarget } from '../api.ts';
  import type { JobStore } from '../jobs.svelte.ts';
  import { int } from '../../lib/format.ts';
  import ChatJudge from './ChatJudge.svelte';

  let { jobs, disabled }: { jobs: JobStore; disabled: boolean } = $props();

  /** 件数の上限の最大(工数はセッション、依頼ごとの判定は依頼の数) */
  const LIMIT_MAX: Record<JudgeTarget, number> = { effort: 500, turns: 5000 };
  const LIMIT_DEFAULT: Record<JudgeTarget, number> = { effort: 10, turns: 60 };
  /** 依頼の判定で 1 回にまとめる依頼の数の上限(judge の DEFAULT_TURN_LIMITS.chunkTurns と同じ。判定の回数の目安に使う) */
  const TURN_CHUNK = 6;
  const TARGET_KEY = 'atlas.judge-target';
  let target = $state<JudgeTarget>(readTarget());
  function readTarget(): JudgeTarget {
    try {
      return localStorage.getItem(TARGET_KEY) === 'turns' ? 'turns' : 'effort';
    } catch {
      return 'effort';
    }
  }
  /** 判定するものごとの件数の上限と、チャットに貼りかけた返答(切り替えても失わない) */
  const limits: Record<JudgeTarget, number | null> = { ...LIMIT_DEFAULT };
  let replies = $state<Record<JudgeTarget, string>>({ effort: '', turns: '' });
  function setTarget(t: JudgeTarget): void {
    limits[target] = limit;
    target = t;
    limit = limits[t];
    runError = '';
    try {
      localStorage.setItem(TARGET_KEY, t);
    } catch {
      /* 覚えられなくても選んだものでは動く */
    }
    void loadPreview();
  }
  const unit = $derived(target === 'turns' ? '依頼' : 'セッション');
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
  /** 初期フォーカス: このツールからなら「やめる」(Enter の押し間違いで費用のかかる処理を始めない)、チャットなら表題の横の「閉じる」 */
  async function focusInitial(): Promise<void> {
    await tick();
    // 「閉じる」はチャットの手順の下にあるので、フォーカスで送らずに表題から見せる
    dlg?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    if (dlg) dlg.scrollTop = 0;
  }
  let preview = $state<JudgePreview | null>(null);
  let previewError = $state('');
  let runError = $state('');
  let limit = $state<number | null>(LIMIT_DEFAULT[readTarget()]);
  const off = $derived(disabled || jobs.running || jobs.busy);
  const limitOk = $derived(typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= LIMIT_MAX[target]);
  /** 実際に判定する件数(未判定のうち上限まで) */
  const count = $derived(preview && limitOk ? Math.min(preview.pending, limit as number) : 0);

  async function openJudge(): Promise<void> {
    preview = null;
    previewError = '';
    runError = '';
    open = true;
    dlg?.showModal();
    await focusInitial();
    await loadPreview();
  }
  async function loadPreview(): Promise<void> {
    preview = null;
    previewError = '';
    const t = target;
    try {
      const p = await jobsApi.judgePreview(jobs.token, t);
      if (t === target) preview = p;
    } catch (e) {
      if (t === target) previewError = (e as Error).message;
    }
  }
  async function runJudge(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!limitOk || count < 1 || jobs.busy) return;
    const req = target === 'turns' ? { kind: 'turn-judge' as const, limit: limit as number } : { kind: 'judge' as const, limit: limit as number };
    if (await jobs.run(req)) dlg?.close();
    else runError = jobs.error;
  }
</script>

<div class="job-actions" role="group" aria-label="集計と判定">
  <button type="button" class="btn" disabled={off} data-testid="job-refresh" onclick={() => void jobs.run({ kind: 'refresh' })}>集計し直す</button>
  <button type="button" class="btn" disabled={off} bind:this={opener} data-testid="job-judge" aria-haspopup="dialog" onclick={openJudge}>判定する…</button>
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
  <div class="head">
    <h2 id="judge-h">LLM で判定する</h2>
    <!-- 手順の長いチャット側では一番下の「閉じる」が画面の外になる(スマホには Esc が無い)ので、表題の横にも置く -->
    <button type="button" class="btn close" data-autofocus={method === 'chat' ? '' : undefined} data-testid="judge-close" onclick={() => dlg?.close()}>閉じる</button>
  </div>
  <fieldset class="fld method">
    <legend class="k">判定するもの</legend>
    <label class="opt"><input type="radio" name="judge-target" value="effort" checked={target === 'effort'} onchange={() => setTarget('effort')} data-testid="judge-target-effort" />工数(セッションごとの推定人手工数)</label>
    <label class="opt"><input type="radio" name="judge-target" value="turns" checked={target === 'turns'} onchange={() => setTarget('turns')} data-testid="judge-target-turns" />依頼ごとの採用(そのまま・修正・不採用、合わなかった点、工程)</label>
  </fieldset>
  <fieldset class="fld method">
    <legend class="k">判定の方法</legend>
    <label class="opt"><input type="radio" name="judge-method" value="tool" checked={method === 'tool'} onchange={() => setMethod('tool')} data-testid="judge-method-tool" />このツールが判定する(GitHub Copilot CLI を手元で動かす)</label>
    <label class="opt"><input type="radio" name="judge-method" value="chat" checked={method === 'chat'} onchange={() => setMethod('chat')} data-testid="judge-method-chat" />チャットに貼って判定する(M365 Copilot など。添付と貼り付けだけで使える)</label>
  </fieldset>
  {#if method === 'chat'}
    {#if open}{#key target}<ChatJudge {jobs} {target} bind:reply={replies[target]} onclose={() => dlg?.close()} />{/key}{/if}
  {:else}
    <form onsubmit={runJudge} aria-busy={jobs.busy}>
      <p class="lead">
        {#if target === 'turns'}未判定の依頼を LLM に判定させ、採用されたか・合わなかった点・工程をレポートに足します。依頼数件をまとめて 1 回で判定します。判定用のファイルを作り直す → 判定する → レポートを作り直す、の順に自動で進みます。
        {:else}未判定のセッションを LLM に判定させ、推定人手工数をレポートに足します。判定用のファイルを作り直す → 判定する → レポートを作り直す、の順に自動で進みます。{/if}
      </p>
      <div class="row">
        <label class="fld"><span class="k">件数({unit})の上限</span><input type="number" name="judge-limit" autocomplete="off" min="1" max={LIMIT_MAX[target]} step="1" inputmode="numeric" bind:value={limit} aria-invalid={limitOk ? undefined : 'true'} aria-describedby="judge-count" data-testid="judge-limit" /></label>
        <p class="fld only">判定に使うもの: GitHub Copilot CLI(copilot -p)</p>
      </div>
      {#if preview}
        <p class="model" data-testid="judge-model">
          モデル: {#if preview.model}<code>{preview.model}</code>{#if preview.byok}(自分の API キー・BYOK){/if}{:else}Copilot の既定のモデル{/if}<span class="src">(atlas.config.json の judgeModel{preview.model ? '' : 'が未設定'})</span>
        </p>
      {/if}
      <p class="count" id="judge-count" role="status" data-testid="judge-count">
        {#if !limitOk}件数の上限は 1〜{int(LIMIT_MAX[target])} の整数で指定してください。
        {:else if previewError}未判定の件数を数えられませんでした: {previewError}
        {:else if !preview}未判定の件数を数えています…
        {:else if preview.pending === 0}未判定の{unit}はありません(判定済み {int(preview.judged)} 件)。
        {:else}未判定の{unit} {int(preview.pending)} 件のうち <strong>{int(count)} 件</strong>を判定します({#if target === 'turns'}約 {int(Math.ceil(count / TURN_CHUNK))} 回以上の判定。{/if}判定済み {int(preview.judged)} 件は判定し直しません)。{/if}
        {#if target === 'turns' && preview?.withoutTurns}<br />依頼ごとの記録が無いセッションが {int(preview.withoutTurns)} 件あります(古い集計)。先に「集計し直す」を押すと、その依頼も判定できます。{/if}
      </p>
      <p class="cost" id="judge-cost">
        {#if preview?.byok}<strong>API の利用料がかかります。</strong>
          自分の API キーのモデル(BYOK)で判定するので、GitHub Copilot の AI クレジットは使いません。そのモデルの提供元(例: Anthropic)の API の従量課金を、{#if target === 'turns'}続いた依頼 {TURN_CHUNK} 件まで(長い依頼はもっと少なく)ごとに 1 回{:else}1 件につき 1 回以上{/if}の判定の分だけ使います。
        {:else}<strong>AI クレジットを消費します。</strong>
          {#if target === 'turns'}GitHub Copilot の AI クレジットを、続いた依頼 {TURN_CHUNK} 件まで(長い依頼はもっと少なく)ごとに 1 回の判定の分だけ使います。{:else}GitHub Copilot の AI クレジットを、1 件につき 1 回以上の判定の分だけ使います。{/if}
          自分の API キーのモデル(BYOK)で判定するには、atlas.config.json に <code>"judgeModel": "anthropic/claude-sonnet-5-5"</code> のように書きます。
        {/if}
        {#if preview?.modelError}<br />設定ファイルを読めませんでした: {preview.modelError}{/if}
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
  .only {
    min-height: 30px;
    display: flex;
    align-items: center;
    font-size: 0.8125rem;
  }
  .judge-dialog::backdrop {
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
  .judge-dialog h2 {
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
  }
  .opt input {
    margin: 0;
    accent-color: var(--form);
  }
  .model {
    margin: 8px 0 0;
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
  .model code,
  .cost code {
    font-family: var(--mono);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
  .model .src {
    color: var(--ink-3);
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
