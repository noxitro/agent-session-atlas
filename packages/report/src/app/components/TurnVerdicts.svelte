<script lang="ts">
  // 段階 2: 依頼ごとの LLM 判定の集計(「工程と詰まり」の中)。普段の工程別の採用と、合わなかった点 × 普段の工程。
  // 絞り込み後のセッションで集計し直す(lib/verdicts.ts)。判定は推定(次の依頼の文から LLM が決めたもの)。
  import { MISMATCH_LABEL, MISMATCHES } from '../../../../core/src/turns.ts';
  import { dateTime, int, percent } from '../../lib/format.ts';
  import { questionDecided, workDecided, type OutcomeCounts, type VerdictAggregate } from '../../lib/verdicts.ts';

  let { agg, model, ranAt }: { agg: VerdictAggregate | null; model: string | null; ranAt: string | null } = $props();

  const rows = $derived(agg ? agg.phases.map((name, i) => ({ name, c: agg.byPhase[i] })).filter((r) => r.c.judged > 0) : []);
  const pct = (part: number, whole: number): string => (whole > 0 ? percent(part, whole) : '—');
</script>

{#snippet outcomeCells(c: OutcomeCounts)}
  <td class="num">{int(c.judged)}</td>
  <td class="num">{int(c.byOutcome.as_is)}</td>
  <td class="num">{int(c.byOutcome.fix_content)}</td>
  <td class="num">{int(c.byOutcome.fix_style)}</td>
  <td class="num">{int(c.byOutcome.rejected)}</td>
  <td class="num strong">{pct(c.byOutcome.as_is, workDecided(c))}<span class="part"><span class="sr-only">、</span>{int(c.byOutcome.as_is)} / {int(workDecided(c))}</span></td>
  <td class="num">{int(c.byOutcome.helpful)}</td>
  <td class="num">{int(c.byOutcome.follow_up)}</td>
  <td class="num">{int(c.byOutcome.off_target)}</td>
  <td class="num">{pct(c.byOutcome.helpful, questionDecided(c))}</td>
  <td class="num">{int(c.byOutcome.unknown)}</td>
{/snippet}

<h3 class="sub" id="verdicts-h">採用(LLM の判定)</h3>
{#if !agg || agg.judged === 0}
  <p class="note" data-testid="verdicts-none">
    {#if agg}この条件の依頼はまだ判定していません。{:else}依頼ごとの採用はまだ判定していません。{/if}右上の「判定する…」で「依頼ごとの採用」を選ぶと、M365 Copilot に貼るか GitHub Copilot CLI で判定できます。
  </p>
{:else}
  <p class="note">
    {int(agg.judged)} 依頼({int(agg.sessions)} セッション)を、次の依頼の文と拒否・中断から LLM が判定したものです(推定)。{model || ranAt ? `最後の判定: ${model ? `モデル ${model}、` : ''}${ranAt ? dateTime(ranAt) : ''}。` : ''}採用率は、判定できた作業の依頼のうち「そのまま採用」の割合です。
  </p>
  <div class="table-scroll">
    <table class="ledger small" data-testid="verdict-table" aria-labelledby="verdicts-h">
      <thead>
        <tr>
          <th scope="col" rowspan="2">工程(普段)</th>
          <th scope="col" rowspan="2" class="num">判定</th>
          <th scope="colgroup" colspan="5" class="grp">作業の依頼</th>
          <th scope="colgroup" colspan="4" class="grp">質問の依頼</th>
          <th scope="col" rowspan="2" class="num">判定不能</th>
        </tr>
        <tr>
          <th scope="col" class="num">そのまま</th>
          <th scope="col" class="num">中身を修正</th>
          <th scope="col" class="num">体裁を修正</th>
          <th scope="col" class="num">不採用</th>
          <th scope="col" class="num">採用率</th>
          <th scope="col" class="num">役に立った</th>
          <th scope="col" class="num">追加で聞いた</th>
          <th scope="col" class="num">的外れ</th>
          <th scope="col" class="num">役に立った率</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.name)}
          <tr><th scope="row">{r.name}</th>{@render outcomeCells(r.c)}</tr>
        {/each}
      </tbody>
      <tfoot>
        <tr><th scope="row">合計</th>{@render outcomeCells(agg.total)}</tr>
      </tfoot>
    </table>
  </div>

  <h3 class="sub" id="mismatch-h">合わなかった点 × 工程(普段)</h3>
  <div class="table-scroll">
    <table class="ledger small" data-testid="mismatch-table" aria-labelledby="mismatch-h">
      <thead>
        <tr>
          <th scope="col">合わなかった点</th>
          {#each rows as r (r.name)}<th scope="col" class="num">{r.name}</th>{/each}
          <th scope="col" class="num">合計</th>
        </tr>
      </thead>
      <tbody>
        {#each MISMATCHES as m (m)}
          {#if agg.total.byMismatch[m] > 0}
            <tr>
              <th scope="row">{MISMATCH_LABEL[m]}</th>
              {#each rows as r (r.name)}<td class="num">{r.c.byMismatch[m] ? int(r.c.byMismatch[m]) : '—'}</td>{/each}
              <td class="num">{int(agg.total.byMismatch[m])}</td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
  {#if MISMATCHES.every((m) => agg.total.byMismatch[m] === 0)}<p class="note">修正・不採用・的外れと判定された依頼はありません。</p>{/if}
{/if}

<style>
  .sub {
    margin: 16px 0 6px;
    font-size: 0.875rem;
  }
  .part {
    display: block;
    font-size: 0.6875rem;
    font-weight: normal;
    color: var(--ink-3);
  }
  .strong {
    font-weight: 600;
  }
  .grp {
    text-align: center;
    font-size: 0.6875rem;
  }
  tfoot th,
  tfoot td {
    font-weight: 600;
  }
</style>
