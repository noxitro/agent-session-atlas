<script lang="ts">
  import type { HighlightGroup } from '../../lib/highlights.ts';

  let { groups }: { groups: HighlightGroup[] } = $props();
</script>

<section class="section" id="highlights" aria-labelledby="highlights-h">
  <div class="section-head">
    <h2 id="highlights-h">要点</h2>
    <p>絞り込み後の集計から機械的に選んだ項目(LLM は使っていません)。各項目のリンクから根拠のセッションか絞り込みに移れます。</p>
  </div>
  {#if groups.length === 0}
    <p class="note" data-testid="highlights-empty">この条件で挙げる項目はありません。</p>
  {:else}
    <div class="groups" data-testid="highlights">
      {#each groups as g (g.kind)}
        <div class="group" data-kind={g.kind}>
          <h3>{g.title}</h3>
          <p class="basis">{g.basis}</p>
          <ol>
            {#each g.items as it, i (i)}
              <li>
                <span class="text" id="hl-{g.kind}-{i}">{it.text}</span>
                <!-- 同じ文言のリンクが並ぶので、どの項目の根拠かを項目の本文で補う -->
                <a class="go" href={it.href} aria-describedby="hl-{g.kind}-{i}">{it.linkLabel}<span class="arrow" aria-hidden="true"> →</span></a>
              </li>
            {/each}
          </ol>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
    border-top: 1px solid var(--rule-strong);
    border-left: 1px solid var(--rule);
    background: var(--surface);
  }
  .group {
    border-right: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    padding: 8px 12px 10px;
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--form);
  }
  .basis {
    margin: 2px 0 0;
    font-size: 0.6875rem;
    color: var(--ink-3);
  }
  ol {
    margin: 6px 0 0;
    padding-left: 1.4em;
    display: grid;
    gap: 4px;
    font-size: 0.8125rem;
  }
  li {
    overflow-wrap: anywhere;
  }
  .text {
    margin-right: 8px;
  }
  .go {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    font-size: 0.75rem;
    white-space: nowrap;
  }
</style>
