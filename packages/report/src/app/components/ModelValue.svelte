<script lang="ts">
  import { effortLabel } from '../../lib/exec-labels.ts';
  import { dec, int, modelLabel, percent } from '../../lib/format.ts';
  import { aiu, effortFindings, keptShare, MIN_SESSIONS, mean, modelValue, ratio, type ValueRow } from '../../lib/model-value.ts';
  import { enoughMeasured, RETENTION_MIN_SESSIONS } from '../../lib/retention.ts';
  import type { SessionSummary } from '../../lib/types.ts';

  let { sessions }: { sessions: readonly SessionSummary[] } = $props();

  let split = $state(true);
  const rows = $derived(modelValue(sessions, split));
  const findings = $derived(effortFindings(modelValue(sessions, true), modelValue(sessions, false)));
  // 記録の無い効果の列は出さない
  const hasJudged = $derived(rows.some((r) => r.completed.weight > 0 || r.quality.weight > 0 || r.hours.weight > 0));
  const hasVerdicts = $derived(rows.some((r) => r.turns.judged > 0));
  const hasRetention = $derived(rows.some((r) => r.retention.withAi > 0));
  const effects = $derived((hasJudged ? 4 : 0) + (hasVerdicts ? 2 : 0) + (hasRetention ? 2 : 0) + 1);

  const perRequest = (r: ValueRow): number | null => (r.nanoAiu > 0 ? ratio(aiu(r.nanoAiu), r.requests) : null);
  const perSession = (r: ValueRow): number | null => (r.nanoAiu > 0 ? ratio(aiu(r.nanoAiu), r.weight) : null);
  const hoursPerAiu = (r: ValueRow): number | null => ratio(r.hours.sum, aiu(r.judgedNanoAiu));
  const pct = (part: number, whole: number): string => (whole > 0 ? percent(part, whole) : '—');
  const shareText = (x: number | null): string => (x == null ? '—' : percent(x, 1));
  const w = (x: number): string => dec(Math.round(x * 10) / 10);
  const effortName = (r: ValueRow): string => (r.effort == null ? '強度の記録なし' : effortLabel(r.effort));
</script>

<section class="section" id="model-value" aria-labelledby="model-value-h">
  <div class="section-head">
    <h2 id="model-value-h">モデルと推論強度の効果</h2>
    <div class="seg" role="group" aria-label="行の分け方">
      <button type="button" aria-pressed={!split} onclick={() => (split = false)}>モデルごと</button>
      <button type="button" aria-pressed={split} onclick={() => (split = true)}>推論強度で分ける</button>
    </div>
  </div>
  {#if rows.length === 0}
    <p class="note">モデル別のリクエストの記録があるセッションがありません。</p>
  {:else}
    {#if findings.length > 0}
      <ul class="findings" data-testid="model-value-findings">
        {#each findings as f (f)}<li>{f}</li>{/each}
      </ul>
    {/if}
    <div class="table-scroll">
      <table class="ledger" data-testid="model-value-table">
        <thead>
          <tr>
            <th scope="col" rowspan="2">モデル</th>
            {#if split}<th scope="col" rowspan="2">推論強度</th>{/if}
            <th scope="colgroup" colspan="4" class="grp">使った量とコスト</th>
            <th scope="colgroup" colspan={effects} class="grp">効果</th>
          </tr>
          <tr>
            <th scope="col" class="num" title="このモデル{split ? '・強度' : ''}を使ったセッションの数(括弧はリクエストの割合で按分した数)">セッション</th>
            <th scope="col" class="num">リクエスト</th>
            <th scope="col" class="num" title="1 リクエストあたりの AIU">AIU / リクエスト</th>
            <th scope="col" class="num" title="按分した 1 セッションあたりの AIU">AIU / セッション</th>
            {#if hasJudged}
              <th scope="col" class="num" title="セッションの判定で、依頼を達成したとされた割合">達成率</th>
              <th scope="col" class="num" title="セッションの判定の成果の質(1〜5)の平均">品質</th>
              <th scope="col" class="num" title="セッションの判定の手戻りの多さ(0〜5)の平均。小さいほど良い">手戻り</th>
              <th scope="col" class="num" title="推定人手工数(時間)÷ AIU。1 AIU で何時間分の作業をしたか。確信度の低い推定は入れていません">人手工数 / AIU</th>
            {/if}
            {#if hasVerdicts}
              <th scope="col" class="num" title="依頼の判定で、そのまま・修正して採用、または役に立ったとされた割合(判定不能を除く)">依頼の採用率</th>
              <th scope="col" class="num" title="依頼の判定で、手を入れずに使えた(そのまま採用・役に立った)割合">そのまま</th>
            {/if}
            {#if hasRetention}
              <th scope="col" class="num" title="AI の変更があったセッションのうち、VCS と照合できたセッションの数(残っている割合の分母になるセッション)">照合できた / AI の変更あり</th>
              <th scope="col" class="num" title="照合できたまとまり(照合不可を除く)のうち、残っている(そのまま + 直されて)割合。まとまりの単位で、「比べる」と同じ数え方。照合できたセッションが {RETENTION_MIN_SESSIONS} 件未満なら —">残っている割合</th>
            {/if}
            <th scope="col" class="num" title="ツールの呼び出しのうち失敗した割合。小さいほど良い">ツール失敗率</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.key)}
            <tr class:thin={r.sessions < MIN_SESSIONS}>
              <th scope="row" title={r.model}>{modelLabel(r.model)}</th>
              {#if split}<td>{effortName(r)}</td>{/if}
              <td class="num" title="按分したセッション {w(r.weight)}{r.sessions < MIN_SESSIONS ? `。${MIN_SESSIONS} 件未満なので、ばらつきが大きい` : ''}">{int(r.sessions)}{#if r.sessions < MIN_SESSIONS}<span class="mark" aria-label="件数が少ない">※</span>{/if}</td>
              <td class="num req">{int(r.requests)}</td>
              <td class="num">{dec(perRequest(r), '—')}</td>
              <td class="num">{dec(perSession(r), '—')}</td>
              {#if hasJudged}
                <td class="num" title="判定のあるセッション {w(r.completed.weight)}(按分)">{pct(r.completed.sum, r.completed.weight)}</td>
                <td class="num" title="判定のあるセッション {w(r.quality.weight)}(按分)">{dec(mean(r.quality), '—')}</td>
                <td class="num" title="判定のあるセッション {w(r.rework.weight)}(按分)">{dec(mean(r.rework), '—')}</td>
                <td class="num" title="推定人手工数 {w(r.hours.sum)} 時間(按分)÷ {dec(aiu(r.judgedNanoAiu))} AIU">{dec(hoursPerAiu(r), '—')}</td>
              {/if}
              {#if hasVerdicts}
                <td class="num" title="判定した依頼 {w(r.turns.judged)}・そのセッション {w(r.turns.weight)}(按分)">{pct(r.turns.adopted, r.turns.judged)}</td>
                <td class="num">{pct(r.turns.asIs, r.turns.judged)}</td>
              {/if}
              {#if hasRetention}
                <td class="num" title="照合できたセッション {int(r.retention.sessions)} / AI の変更があったセッション {int(r.retention.withAi)}">{r.retention.withAi > 0 ? `${int(r.retention.sessions)} / ${int(r.retention.withAi)}` : '—'}</td>
                <td class="num" title="照合できたまとまり {w(r.retention.measured)}・そのセッション {w(r.retention.weight)}(按分){enoughMeasured(r.retention.sessions) ? '' : `。照合できたセッションが ${RETENTION_MIN_SESSIONS} 件未満なので出しません`}">{shareText(keptShare(r))}</td>
              {/if}
              <td class="num" title="ツールの呼び出し {w(r.tools.calls)}(按分)">{pct(r.tools.failures, r.tools.calls)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="note">
      推論強度はリクエストごとに決まりますが、効果の記録(セッションの判定・依頼の判定・AI の変更の残存・ツールの失敗)はセッションごとにしかありません。そこで、セッションの効果を、そのセッションのリクエストに占めるモデル{split ? ' × 推論強度' : ''}の割合で按分して数えています(1 セッションの重みの合計は 1)。コスト(リクエスト・AIU)は按分せず、そのモデル{split ? ' × 推論強度' : ''}のリクエストの実数です。{#if hasRetention}AI の変更の残存は、照合できたまとまり(照合不可を除く)のうち残っている(そのまま + 直されて)割合で、「比べる」と同じ数え方です。照合できたセッションが {RETENTION_MIN_SESSIONS} 件未満の行は割合を出しません。{/if}難しい作業ほど強い推論強度や上位のモデルを選びやすいので、差がそのまま強度やモデルの効果とは限りません。※ はセッションが {MIN_SESSIONS} 件未満の行です。表の上の読み取りは、セッションが {MIN_SESSIONS} 件以上の強度どうしで、効果はその記録があるセッションが按分して {MIN_SESSIONS} 件分以上あるものだけを並べます(「比べる」で割合と平均を出す件数と同じ)。按分した値は、セッションを単位にした差の幅(95%)を出せないので、読み取りは値を並べるだけで、差があるとは言えません。「比べる」の推論強度(本体の推論強度が決まったセッションだけを並べます)で差の幅が出るのは、手戻りのないセッションの割合やテストの結果の割合など、セッションを単位にした割合と平均の行だけです(達成率・品質・依頼の採用率の行は無く、ツールの失敗率と AI の変更の残存の割合には幅を出しません)。{#if !hasJudged}セッションの判定(atlas judge)をすると、達成率・品質・手戻り・人手工数あたりのコストも出ます。{/if}{#if !hasVerdicts}依頼の判定をすると、依頼の採用率も出ます。{/if}
    </p>
  {/if}
</section>

<style>
  th.grp {
    text-align: center;
  }
  .thin td,
  .thin th {
    color: var(--ink-2);
  }
  .mark {
    margin-left: 2px;
    font-size: 0.75rem;
  }
  .findings {
    margin: 0;
    padding: 10px 12px 10px 28px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-top: 0;
    font-size: 0.8125rem;
    display: grid;
    gap: 4px;
  }
</style>
