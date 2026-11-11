<script lang="ts">
  // 画面から動かした処理のログ(末尾)。本文の上の帯(JobBand)と、判定ダイアログの「チャットに貼る」(ChatJudge)が使う。
  // 見出しの色は、置く側が --job-log-summary で決める(既定はまわりの文字の色)。
  let { log }: { log: string[] } = $props();
</script>

<details class="log">
  <summary>ログ(末尾 {log.length} 行)</summary>
  <!-- 縦に流れる枠はキーボードでも送れるようにする(Tab で止まって矢印で送る) -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre tabindex="0" aria-label="処理のログ">{log.join('\n')}</pre>
</details>

<style>
  .log {
    font-size: 0.75rem;
  }
  .log summary {
    cursor: pointer;
    color: var(--job-log-summary, inherit);
    width: max-content;
  }
  .log pre {
    margin: 4px 0 2px;
    padding: 6px 8px;
    max-height: 14em;
    overflow: auto;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
