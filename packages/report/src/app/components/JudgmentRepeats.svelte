<script lang="ts">
  // 概況の「判定のぶれ」の節。同じセッションを、入力が変わらないまま判定し直したときの工数の判定の一致。
  // 値はすべて集計のとき(Rust の judgment_repeats)に決めたもので、画面は出すだけ(数え直さない)。点数にせず、ほかの値とも混ぜない
  import { dec, int } from '../../lib/format.ts';
  import type { JudgmentRepeats } from '../../lib/types.ts';

  let { r }: { r: JudgmentRepeats } = $props();

  /** 割合(0〜1)を 1 桁の % に */
  const pct = (x: number): string => `${dec(Math.round(x * 1000) / 10)}%`;
  const times = (x: number): string => `${dec(Math.round(x * 100) / 100)} 倍`;
  const enough = $derived(r.pairs >= r.min);
  /** 比べなかったセッションの理由(0 のものは出さない) */
  const skipped = $derived(
    [
      [r.excluded.beforeEnd, '判定の後に記録が続いた'],
      [r.excluded.noEnd, '終わりが分からない'],
      [r.excluded.noRanAt, '判定の日時が分からない'],
      [r.excluded.noCurrent, '今の判定が無い'],
    ]
      .filter(([n]) => (n as number) > 0)
      .map(([n, label]) => `${label} ${int(n as number)}`)
      .join('・'),
  );
  /** 数えた組が下限に届かない値の欄の注記 */
  const few = (n: number): string => `${int(n)} 組。${int(r.min)} 組から出します`;
</script>

<section class="section" id="judgment-repeats" aria-labelledby="judgment-repeats-h" data-testid="judgment-repeats">
  <div class="section-head">
    <h2 id="judgment-repeats-h">判定のぶれ</h2>
    <p>
      同じセッションを、入力が変わらないまま判定し直したときの一致です(工数の判定の揺れの目安。点数ではなく、ほかの値とも混ぜません)。
      値は集計したときのもので、上の絞り込みは掛かりません。組ごとの値は <code>out/tables/judgment-repeats.csv</code> にあります。
    </p>
  </div>

  <div class="fields" style="--cols:4">
    <div class="field">
      <span class="k">判定し直した組</span>
      <span class="v" data-testid="repeats-pairs">{int(r.pairs)}</span>
      <span class="n" data-testid="repeats-models">モデルが同じ {int(r.sameModel)}・違う {int(r.differentModel)}{r.unknownModel ? `・分からない ${int(r.unknownModel)}` : ''}</span>
    </div>
    <div class="field">
      <span class="k">達成の一致</span>
      <span class="v" data-testid="repeats-completed">{r.completed.rate != null ? pct(r.completed.rate) : '—'}</span>
      <span class="n">{r.completed.rate != null ? `${int(r.completed.agree)} / ${int(r.completed.n)} 組で同じ` : few(r.completed.n)}</span>
    </div>
    <div class="field">
      <span class="k">推定人手工数の比(大きい方 ÷ 小さい方)</span>
      <span class="v" data-testid="repeats-hours">{r.hours.ratioMedian != null ? `中央値 ${times(r.hours.ratioMedian)}` : '—'}</span>
      <span class="n" data-testid="repeats-hours-note">
        {#if r.hours.ratioMedian != null && r.hours.ratioP75 != null}75 パーセンタイル {times(r.hours.ratioP75)}。{:else}{few(r.hours.ratioN)}。{/if}
        {#if r.hours.inside.rate != null}新しい判定が前の幅(low〜high)に入った {pct(r.hours.inside.rate)}({int(r.hours.inside.agree)} / {int(r.hours.inside.n)} 組)。{/if}
      </span>
    </div>
    <div class="field">
      <span class="k">成果の質・手戻りの差(中央値)</span>
      <span class="v" data-testid="repeats-quality">{r.quality.medianAbsDiff != null ? `質 ${dec(r.quality.medianAbsDiff)}・手戻り ${r.rework.medianAbsDiff != null ? dec(r.rework.medianAbsDiff) : '—'}` : '—'}</span>
      <span class="n">{r.quality.medianAbsDiff != null ? '差の絶対値(質は 1〜5、手戻りは 0〜5)' : few(r.quality.n)}</span>
    </div>
  </div>
  {#if !enough}
    <p class="note" data-testid="repeats-few">判定し直した組が {int(r.pairs)} 組で、下限の {int(r.min)} 組に届かないので、割合と中央値は出していません。「判定する…」の工数で、判定済みのセッションを判定し直すと増えます。</p>
  {/if}
  <ul class="defs" data-testid="repeats-defs">
    <li>組は、今の判定と、その前に同じセッションに付いていた判定です。どちらもセッションの終わりより後に判定したものだけを比べます(後から記録が続いたセッションは、入力が変わっているので比べません)。{#if skipped}履歴はあるが比べなかったセッション: {skipped}。{/if}</li>
    <li>達成の一致と、質・手戻りの差は、確信度に関わらずすべての組で数えます。推定人手工数は、合計と同じく確信度 30% 以下の推定を含む組を入れません{r.hours.lowConfidence ? `(今は ${int(r.hours.lowConfidence)} 組)` : ''}。{#if r.hours.oneZero}片方だけ 0 時間の {int(r.hours.oneZero)} 組は、比を出せないので比に入れていません。{/if}</li>
    <li>モデルの違う組も入っています。モデルや条件どうしの差を見るときは、その差がこのぶれより大きいかを確かめてください。依頼ごとの判定のぶれは、ここでは数えていません。</li>
  </ul>
</section>

<style>
  /* TaskPanel の注記の箇条と同じ見た目 */
  .defs {
    margin: 8px 0 0;
    padding-left: 1.2em;
    max-width: 75ch;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .defs li + li {
    margin-top: 2px;
  }
</style>
