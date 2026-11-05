<script lang="ts">
  // Phase 14: 画面から動かした処理の帯(本文の上。atlas serve から開いたときだけ)。
  // 実行中(経過・止める・ログ)→ 完了(「新しい集計ができました」と「再読み込み」。自動では読み直さない: メモの入力中などを守る)/ 失敗 / 止めた。
  // この画面のデータより後に始まった処理だけを出す(再読み込みした後は出さない)。全文記録の作成(詳細ページから)は実行中だけ出す。
  import type { JobInfo } from '../api.ts';
  import type { JobStore } from '../jobs.svelte.ts';

  let { jobs, generatedAt }: { jobs: JobStore; generatedAt: string } = $props();

  const LABEL: Record<JobInfo['kind'], string> = { refresh: '集計し直し', judge: '工数の判定', full: '全文記録の作成', bundle: '添付ファイルの作成', export: 'レポートへの反映' };
  const job = $derived(jobs.job);
  const shown = $derived.by(() => {
    const j = job;
    if (!j || jobs.dismissed === j.id) return null;
    if (j.state === 'running') return j;
    // 全文記録の作成(詳細ページから)と添付ファイルの作成(判定ダイアログの中から)は、終わったことを始めた画面が示すので帯には出さない
    if (j.kind === 'full' || j.kind === 'bundle') return null;
    return Date.parse(j.startedAt) >= Date.parse(generatedAt) ? j : null;
  });
  function elapsed(j: JobInfo, now: number): string {
    const sec = Math.max(0, Math.round(((j.endedAt ? Date.parse(j.endedAt) : now) - Date.parse(j.startedAt)) / 1000));
    return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  }
  const tone = $derived(shown && (shown.state === 'failed' || shown.state === 'canceled') ? 'warn' : 'info');
  function dismiss(): void {
    if (shown) jobs.dismissed = shown.id;
  }
  /** 状態が変わったときだけ変わる読み上げの 1 文 */
  const announce = $derived.by(() => {
    const j = shown;
    if (!j) return '';
    if (j.state === 'running') return `${LABEL[j.kind]}を始めました。`;
    if (j.state === 'done') return '新しい集計ができました。再読み込みすると反映されます。';
    if (j.state === 'failed') return `${LABEL[j.kind]}に失敗しました。`;
    return `${LABEL[j.kind]}を止めました。`;
  });
  const target = (j: JobInfo): string => (j.kind === 'judge' ? `最大 ${j.target.limit} 件、${j.target.backend === 'opencode' ? 'opencode' : 'copilot -p'}` : '');
</script>

<!-- 読み上げは状態が変わったときの 1 文だけ(経過の秒は毎秒変わるので live 領域に入れない)。live 領域は常に置き、文だけ差し替える -->
<p class="sr-only" role="status" data-testid="job-announce">{announce}</p>
<div class="job-band" class:show={!!shown || !!jobs.error} class:stick={!!shown && (shown.state === 'running' || shown.state === 'done')} class:warn={tone === 'warn' || (!shown && !!jobs.error)} data-testid="job-band" data-state={shown?.state ?? ''}>
  {#if shown}
    <div class="wrap band-in">
      <p class="msg">
        {#if shown.state === 'running'}
          <strong>{LABEL[shown.kind]}をしています</strong>(経過 {elapsed(shown, jobs.now)}{target(shown) ? `、${target(shown)}` : ''})。{#if shown.kind === 'refresh'}終わるまで詳細ページと記録は開けないことがあります。{:else if shown.kind === 'judge'}画面を閉じても最後まで続きます。{/if}
        {:else if shown.state === 'done'}
          <strong>新しい集計ができました</strong>({LABEL[shown.kind]}、{elapsed(shown, jobs.now)})。再読み込みすると反映されます。
        {:else if shown.state === 'failed'}
          {#if shown.kind === 'judge'}
            <strong>判定に失敗したセッションがあるか、判定を実行できませんでした</strong>(終了コード {shown.exitCode ?? '—'})。判定できた分は保存されています。「再読み込み」で反映されていなければ「集計し直す」を押してください。理由は下のログにあります。
          {:else}
            <strong>{LABEL[shown.kind]}に失敗しました</strong>(終了コード {shown.exitCode ?? '—'})。下のログで理由を確かめてください。
          {/if}
        {:else if shown.kind === 'judge'}
          <strong>判定を止めました</strong>。判定できた分は保存されていて、次の「集計し直す」でレポートに出ます。
        {:else}
          <strong>{LABEL[shown.kind]}を止めました</strong>。レポートは作り直しの途中かもしれません。もう一度「集計し直す」を押してください。
        {/if}
      </p>
      <div class="acts">
        {#if shown.state === 'running'}
          <button type="button" class="btn" data-testid="job-cancel" onclick={() => void jobs.cancel()}>止める</button>
        {:else}
          {#if shown.state === 'done' || (shown.state === 'failed' && shown.kind === 'judge')}
            <button type="button" class="btn primary" data-testid="job-reload" onclick={() => location.reload()}>再読み込み</button>
          {/if}
          <button type="button" class="btn" onclick={dismiss}>閉じる</button>
        {/if}
      </div>
      {#if shown.state === 'running' && shown.log.length}
        <p class="last" title={shown.log[shown.log.length - 1]}>直近: {shown.log[shown.log.length - 1]}</p>
      {:else if (shown.state === 'failed' || shown.state === 'canceled') && shown.log.length}
        <details class="log">
          <summary>ログ(末尾 {shown.log.length} 行)</summary>
          <!-- 縦に流れる枠はキーボードでも送れるようにする(Tab で止まって矢印で送る) -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre tabindex="0" aria-label="処理のログ">{shown.log.join('\n')}</pre>
        </details>
      {/if}
    </div>
  {/if}
  {#if jobs.error}
    <p class="wrap err" role="alert">{jobs.error}</p>
  {/if}
</div>

<style>
  .job-band {
    display: none;
  }
  .job-band.show {
    display: block;
    background: var(--form-wash);
    border-bottom: 1px solid var(--form);
  }
  /* 実行中と完了(「再読み込み」)は、読み進めても見えるよう上に貼る。失敗・中止はログを開くので貼らない(本文を覆わない) */
  .job-band.stick {
    position: sticky;
    top: var(--topbar-h, 0px);
    z-index: 5;
  }
  .job-band.warn {
    background: var(--warn-wash);
    border-bottom-color: var(--warn);
  }
  .band-in {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    padding-top: 6px;
    padding-bottom: 6px;
  }
  .msg {
    flex: 1 1 32em;
    margin: 0;
    font-size: 0.8125rem;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .acts {
    display: flex;
    gap: 6px;
  }
  .acts .btn {
    padding: 2px 10px;
  }
  .btn.primary {
    background: var(--form);
    color: var(--surface);
  }
  .btn.primary:hover {
    text-decoration: underline;
  }
  .last {
    flex-basis: 100%;
    margin: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  .log {
    flex-basis: 100%;
    font-size: 0.75rem;
  }
  .log summary {
    cursor: pointer;
    color: var(--form);
    width: max-content;
  }
  .log pre {
    margin: 4px 0 2px;
    padding: 6px 8px;
    max-height: 14em;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .err {
    margin: 0;
    padding-top: 6px;
    padding-bottom: 6px;
    font-size: 0.8125rem;
    color: var(--ink);
  }
</style>
