<script lang="ts">
  import type { Aggregate, Bucket } from '../../lib/aggregate.ts';
  import { dateTime, dec, duration, int } from '../../lib/format.ts';
  import { backendLabel, confidenceLabel } from '../../lib/judgment-labels.ts';
  import type { ReportData } from '../../lib/types.ts';

  let { agg, meta }: { agg: Aggregate; meta: ReportData['judgments'] } = $props();

  const o = $derived(agg.overall);
  const rows = $derived([...agg.byProject].filter((b) => b.judgedSessions > 0).sort((a, b) => b.humanHours - a.humanHours || a.key.localeCompare(b.key)));
  const unjudgedProjects = $derived(agg.byProject.length - rows.length);

  /** 推定人手工数 ÷ AI の実働時間(実働が分かる判定済みセッションだけで比べる) */
  function ratio(b: Bucket): number | null {
    const ai = b.judgedAi;
    if (ai.activeKnown === 0 || ai.activeMs <= 0) return null;
    return b.humanHours / (ai.activeMs / 3_600_000);
  }
  const fmtRatio = (r: number | null): string => (r == null ? '—' : `${dec(Math.round(r * 10) / 10)} 倍`);
  const range = (b: Bucket): string => `${dec(b.humanLow)}〜${dec(b.humanHigh)} 時間`;
</script>

<section class="section" id="judgments" aria-labelledby="judgments-h">
  <div class="section-head">
    <h2 id="judgments-h">AI 投入量 vs 推定人手工数</h2>
    <p>
      推定人手工数は、同じ成果を人が AI なしで出す場合の時間を LLM に推定させた値です(<strong>推定であり実測ではありません</strong>)。
      判定: {backendLabel(meta.backend)}{meta.model ? `・${meta.model}` : ''}{meta.ranAt ? `・${dateTime(meta.ranAt)}` : ''}
    </p>
  </div>

  {#if o.judgedSessions === 0}
    <p class="note">この絞り込みには判定済みのセッションがありません(判定済み {int(meta.items)} セッション)。</p>
  {:else}
    <div class="fields" style="--cols:4">
      <div class="field">
        <span class="k">推定人手工数(判定済みの合計)</span>
        <span class="v">{dec(o.humanHours)} 時間</span>
        <span class="n">幅 {range(o)}・平均{confidenceLabel(o.judgedConfidence)}</span>
      </div>
      <div class="field">
        <span class="k">AI の実働時間(同じセッション)</span>
        <span class="v">{duration(o.judgedAi.activeMs, '—')}</span>
        <span class="n">実働の記録あり {int(o.judgedAi.activeKnown)} / {int(o.judgedSessions)} セッション</span>
      </div>
      <div class="field">
        <span class="k">推定人手工数 ÷ AI の実働</span>
        <span class="v">{fmtRatio(ratio(o))}</span>
        <span class="n">1 を超えるほど、人手より短い時間で済んだと推定される</span>
      </div>
      <div class="field">
        <span class="k">AI に投入したトークン(同じセッション)</span>
        <span class="v">出力 {int(o.judgedAi.output)}</span>
        <span class="n">入力 {o.judgedAi.inputKnown ? int(o.judgedAi.input) : '記録なし'}(記録あり {int(o.judgedAi.inputKnown)} セッション)</span>
      </div>
    </div>
    <p class="note">判定済み {int(o.judgedSessions)} / {int(o.sessions)} セッション。未判定のセッションは両側の比較から除いています。</p>

    <h3 class="sub-h" id="judgments-proj-h">プロジェクトごとの比較(判定済みセッションのみ)</h3>
    <div class="table-scroll">
      <table class="ledger" aria-labelledby="judgments-proj-h">
        <thead>
          <tr>
            <th scope="col">プロジェクト</th>
            <th scope="col" class="num">判定済み</th>
            <th scope="col" class="num">AI の実働</th>
            <th scope="col" class="num">出力トークン</th>
            <th scope="col" class="num">推定人手工数</th>
            <th scope="col" class="num">人手 ÷ AI 実働</th>
            <th scope="col" class="num">平均確信度</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as b (b.key)}
            <tr>
              <th scope="row" class="proj" title={b.key}>{b.label}</th>
              <td class="num">{int(b.judgedSessions)} / {int(b.sessions)}</td>
              <td class="num">{duration(b.judgedAi.activeMs, '—')}</td>
              <td class="num">{int(b.judgedAi.output)}</td>
              <td class="num">{dec(b.humanHours)} 時間<span class="part">{range(b)}</span></td>
              <td class="num">{fmtRatio(ratio(b))}</td>
              <td class="num">{b.judgedConfidence == null ? '—' : `${Math.round(b.judgedConfidence * 100)}%`}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if unjudgedProjects > 0}
      <p class="note">判定済みのセッションが無いプロジェクト {int(unjudgedProjects)} 件は表に出していません。</p>
    {/if}
  {/if}
</section>

<style>
  .sub-h {
    margin: 16px 0 6px;
    font-size: 0.9375rem;
  }
  .proj {
    font-weight: normal;
    min-width: 11em;
    max-width: 28em;
    overflow-wrap: anywhere;
  }
  .part {
    display: block;
    font-size: 0.6875rem;
    color: var(--ink-3);
  }
</style>
