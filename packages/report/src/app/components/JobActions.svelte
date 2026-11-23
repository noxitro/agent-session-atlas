<script lang="ts">
  // マストヘッドの操作「集計し直す」「判定する…」(atlas serve から開いたときだけ)。
  // 判定はこのツールの中では回さない。判定するのは外部の LLM で、ダイアログでは判定するもの(工数 = セッションごと / 依頼ごとの採用 /
  // 管理ツールのタスクへの紐づけ)と、渡し方(チャットに貼る / ZIP にまとめてエージェントに渡す)を選ぶ(ChatJudge)。
  // タスクへの紐づけは、タスクの設定か記録があって、読むだけの画面でないときだけ選べる。選んだものはこのブラウザに覚える。
  import { tick } from 'svelte';
  import type { JudgeTarget, JudgeVia } from '../api.ts';
  import type { JobStore } from '../jobs.svelte.ts';
  import ChatJudge from './ChatJudge.svelte';

  let {
    jobs,
    disabled,
    tasks = null,
  }: {
    jobs: JobStore;
    disabled: boolean;
    /** 管理ツールのタスク(GET api/tasks の答え)。タスクの設定も記録も無ければ null で、「タスクの紐づけ」を出さない。readOnly は読むだけの画面 */
    tasks?: { configured: boolean; readOnly: boolean } | null;
  } = $props();

  /** タスクの紐づけを選べるか(読むだけの画面の紐づけは送った人のものなので、ここでは頼まない) */
  const tasksOn = $derived(!!tasks && !tasks.readOnly);

  const TARGET_KEY = 'atlas.judge-target';
  const METHOD_KEY = 'atlas.judge-method';
  let target = $state<JudgeTarget>(readTarget());
  function readTarget(): JudgeTarget {
    try {
      const t = localStorage.getItem(TARGET_KEY);
      return t === 'turns' || t === 'tasks' ? t : 'effort';
    } catch {
      return 'effort';
    }
  }
  /** 選べない「タスクの紐づけ」を覚えていたら、工数の手順を出す(タスクが使えるようになれば戻る) */
  const shownTarget = $derived<JudgeTarget>(target === 'tasks' && !tasksOn ? 'effort' : target);
  let method = $state<JudgeVia>(readMethod());
  function readMethod(): JudgeVia {
    try {
      // 前の版で覚えた、このツールの中で判定する方法(tool)は、チャットに貼る手順にする
      return localStorage.getItem(METHOD_KEY) === 'zip' ? 'zip' : 'chat';
    } catch {
      return 'chat';
    }
  }
  /** 判定するものごとの、貼りかけの返答(切り替えても失わない) */
  let replies = $state<Record<JudgeTarget, string>>({ effort: '', turns: '', tasks: '' });
  function remember(key: string, v: string): void {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* 覚えられなくても選んだものでは動く */
    }
  }
  function setTarget(t: JudgeTarget): void {
    target = t;
    remember(TARGET_KEY, t);
  }
  function setMethod(m: JudgeVia): void {
    method = m;
    remember(METHOD_KEY, m);
  }
  let dlg = $state<HTMLDialogElement | null>(null);
  let opener = $state<HTMLButtonElement | null>(null);
  let open = $state(false);
  const off = $derived(disabled || jobs.running || jobs.busy);

  async function openJudge(): Promise<void> {
    open = true;
    dlg?.showModal();
    await tick();
    // 「閉じる」は手順の下にもあるので、フォーカスで送らずに表題から見せる
    dlg?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    if (dlg) dlg.scrollTop = 0;
  }
</script>

<div class="job-actions" role="group" aria-label="集計と判定">
  <button type="button" class="btn" disabled={off} data-testid="job-refresh" onclick={() => void jobs.run({ kind: 'refresh' })}>集計し直す</button>
  <button type="button" class="btn" disabled={off} bind:this={opener} data-testid="job-judge" aria-haspopup="dialog" onclick={openJudge}>判定する…</button>
</div>

<dialog
  bind:this={dlg}
  class="judge-dialog"
  aria-labelledby="judge-h"
  data-testid="judge-dialog"
  onclose={() => {
    open = false;
    opener?.focus();
  }}
>
  <div class="head">
    <h2 id="judge-h">LLM で判定する</h2>
    <!-- 手順の長いダイアログでは一番下の「閉じる」が画面の外になる(スマホには Esc が無い)ので、表題の横にも置く -->
    <button type="button" class="btn close" data-autofocus data-testid="judge-close" onclick={() => dlg?.close()}>閉じる</button>
  </div>
  <p class="lead" data-testid="judge-lead">判定するのは、あなたが使っている外部の LLM です。このツールは LLM を呼ばず、渡すファイルを作って、返ってきた答えを取り込みます。</p>
  <fieldset class="fld method" aria-describedby="judge-target-note">
    <legend class="k">判定するもの</legend>
    <label class="opt"><input type="radio" name="judge-target" value="effort" checked={shownTarget === 'effort'} onchange={() => setTarget('effort')} data-testid="judge-target-effort" />工数(セッションごとの推定人手工数と、成果の質・手戻り)</label>
    <label class="opt"><input type="radio" name="judge-target" value="turns" checked={shownTarget === 'turns'} onchange={() => setTarget('turns')} data-testid="judge-target-turns" />依頼ごとの採用(任意。どの依頼が直されたか・合わなかった点・工程まで見たいとき)</label>
    {#if tasksOn}
      <label class="opt"><input type="radio" name="judge-target" value="tasks" checked={shownTarget === 'tasks'} onchange={() => setTarget('tasks')} data-testid="judge-target-tasks" />タスクの紐づけ(機械で決まらなかったセッションが、管理ツールのどのタスクの作業か)</label>
    {/if}
    <p class="both" id="judge-target-note" data-testid="judge-target-note">どれも別の判定で、1 つだけでも使えます。迷ったら工数だけで足ります。</p>
  </fieldset>
  <fieldset class="fld method">
    <legend class="k">判定の方法</legend>
    <label class="opt"><input type="radio" name="judge-method" value="chat" checked={method === 'chat'} onchange={() => setMethod('chat')} data-testid="judge-method-chat" />チャットに貼って判定する(M365 Copilot など。ファイルの添付か貼り付けができる LLM なら使える)</label>
    <label class="opt"><input type="radio" name="judge-method" value="zip" checked={method === 'zip'} onchange={() => setMethod('zip')} data-testid="judge-method-zip" />ZIP にまとめてエージェントに渡す(フォルダを読める LLM 向け)</label>
  </fieldset>
  <!-- 判定するものを変えたら作り直す。方法(チャット・ZIP)を変えても、この画面で取り込んだ件数は残す(同じ束を使うため) -->
  {#if open}{#key shownTarget}<ChatJudge {jobs} target={shownTarget} via={method} bind:reply={replies[shownTarget]} onclose={() => dlg?.close()} />{/key}{/if}
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
    width: min(42rem, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    /* 手順の長い方法では中を縦に流す。端まで流しても、後ろのページは動かさない */
    overscroll-behavior: contain;
    padding: 16px 20px 18px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-top: 3px solid var(--form);
  }
  .method {
    margin-top: 10px;
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
  .both {
    margin: 2px 0 0;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
</style>
