<script lang="ts">
  import { GLOSSARY } from '../../lib/glossary.ts';
</script>

<section class="section" id="glossary" aria-labelledby="glossary-h">
  <div class="section-head">
    <h2 id="glossary-h">用語の説明</h2>
    <p>このレポートを初めて読む人向け</p>
  </div>
  <dl class="glossary">
    {#each GLOSSARY as g (g.id)}
      <dt id="term-{g.id}">{g.term}</dt>
      <dd>{g.body}</dd>
    {/each}
  </dl>
</section>
