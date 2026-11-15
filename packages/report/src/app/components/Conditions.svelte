<script lang="ts">
  // 「課題 × 条件」の節: タスクタグの名前(課題__条件)で分けたセッションを、条件ごと(課題をまとめた行)と課題ごとに並べる。
  // 操作する部品は置かない(並べるだけ)。差や順位は出さず、割合と中央値の下に、割った数をいつも添える
  import { COMPARE_MIN_SESSIONS } from '../../lib/compare.ts';
  import { CONDITION_SEP, type ConditionCell, type ConditionTable, type Median, type UntilPass } from '../../lib/conditions.ts';
  import { dec, duration, int, percent } from '../../lib/format.ts';

  let { table }: { table: ConditionTable } = $props();

  const MIN = COMPARE_MIN_SESSIONS;
  const DASH = '—';
  /** 注記に並べる名前の数 */
  const NAMES = 3;

  const round = (v: number, digits: number): number => Math.round(v * 10 ** digits) / 10 ** digits;
  const runsText = (v: number): string => `${dec(round(v, 1))} 回`;
  const aiuText = (v: number): string => dec(round(v, 2));
  const msText = (v: number): string => duration(v, DASH);
  /** 通るまでの中央値(件数が足りなければ「—」、通ったセッションが半分以下なら「未達」) */
  const until = (u: UntilPass, f: (v: number) => string): string => (u.value == null ? DASH : u.value === 'unreached' ? '未達' : f(u.value));
  const med = (m: Median, f: (v: number) => string): string => (m.value == null ? DASH : f(m.value));

  /** データの列の数(見出しの行に使う) */
  const dataCols = $derived(1 + (table.hasTests ? 7 : 0) + 3);
  const partial = $derived(table.pooled.some((c) => c.tasks < table.tasks.length));
  const unmatchedNames = $derived(table.unmatched.slice(0, NAMES).join('、') + (table.unmatched.length > NAMES ? ' ほか' : ''));
</script>

{#snippet count(n: number)}
  {#if n === 0}<span class="zero">0</span>{:else}{int(n)}{/if}
{/snippet}

{#snippet part(text: string)}
  <span class="part"><span class="sr-only">、</span>{text}</span>
{/snippet}

{#snippet uneven()}
  {#if table.unevenTasks > 0}条件によってセッションの数が違う課題が {int(table.unevenTasks)} 件あります。{/if}
{/snippet}

<!-- 表に入れなかったものと、名前のまとめ方の注記(該当するものがあるときだけ) -->
{#snippet excluded()}
  {#if table.unmatched.length > 0 || table.ambiguous > 0 || table.sharedRows > 0 || table.lookalikes.length > 0}
    <p class="note names" data-testid="conditions-excluded">
      {#if table.unmatched.length > 0 || table.ambiguous > 0}
        この表に入れていないもの: {#if table.unmatched.length > 0}名前の決まりに合わないタスクタグ {int(table.unmatched.length)} 個(<span translate="no">{unmatchedNames}</span>){/if}{#if table.unmatched.length > 0 && table.ambiguous > 0}・{/if}{#if table.ambiguous > 0}複数の課題や条件のタグが付いたセッション {int(table.ambiguous)} 件{/if}。
      {/if}
      {#if table.sharedRows > 0}送った人が違っても、課題と条件の名前が同じなら同じ行にまとめています({int(table.people)} 人のセッション)。人ごとには、「比べる」でタスクタグを選ぶと並べられます。{/if}
      {#if table.lookalikes.length > 0}大文字と小文字、全角と半角だけが違う名前があります({table.lookalikes.map(([a, b]) => `${a} と ${b}`).join('、')})。別の課題・条件として数えています。{/if}
    </p>
  {/if}
{/snippet}

{#snippet head(pooled: boolean)}
  <!-- 見出しの 1 段目(列のまとまり)と同じ区切り -->
  <colgroup><col /></colgroup>
  {#if pooled}<colgroup><col /></colgroup>{/if}
  <colgroup span={table.hasTests ? 2 : 1}></colgroup>
  {#if table.hasTests}
    <colgroup span="3"></colgroup>
    <colgroup span="3"></colgroup>
  {/if}
  <colgroup span="3"></colgroup>
  <thead>
    <tr>
      <th scope="col" rowspan="2">条件</th>
      {#if pooled}<th scope="col" rowspan="2" class="num" title="この条件のセッションがある課題の数 / 表にある課題の数">課題</th>{/if}
      <th scope="colgroup" colspan={table.hasTests ? 2 : 1} class="grp">セッション</th>
      {#if table.hasTests}
        <th scope="colgroup" colspan="3" class="grp">テストの結果(記録があるセッション)</th>
        <th scope="colgroup" colspan="3" class="grp">最初に全部通るまで(中央値)</th>
      {/if}
      <th scope="colgroup" colspan="3" class="grp">セッション全体</th>
    </tr>
    <tr>
      <th scope="col" class="num" title="この課題・条件のタスクタグが付いたセッションの数(同じセッションは 1 回)">件数</th>
      {#if table.hasTests}
        <th scope="col" class="num" title="テストの結果の行が 1 回も読めなかったセッション。未達にも、テストの結果の分母にも入れない">テストの記録なし</th>
        <th scope="col" class="num" title="最後の実行の後に、通っていないテストが無いセッション ÷ テストの記録があるセッション">最後に全部通った</th>
        <th scope="col" class="num" title="一度は全部通ったが、最後の実行の後に通っていないテストがあるセッションの数">通った後に不合格</th>
        <th scope="col" class="num" title="テストの実行が 1 回以上あり、一度も全部通らなかったセッションの数">未達</th>
        <th scope="col" class="num" title="最初に全部通った実行が何回目か。未達のセッションを最後に並べた中央値">テストの実行</th>
        <th scope="col" class="num" title="最初に全部通った実行までの実働。未達のセッションを最後に並べた中央値">実働</th>
        <th scope="col" class="num" title="最初に全部通った実行までの AI 使用量。リクエストごとの記録があるセッションだけ。未達のセッションを最後に並べた中央値">AIU</th>
      {/if}
      <th scope="col" class="num" title="セッションの実働の中央値(記録があるセッション)">実働(中央値)</th>
      <th scope="col" class="num" title="セッションの AI 使用量の中央値(記録があるセッション)">AIU(中央値)</th>
      <th scope="col" class="num" title="失敗・拒否 ÷ ツール呼び出し。「比べる」と同じ数え方">ツールの失敗・拒否</th>
    </tr>
  </thead>
{/snippet}

{#snippet cells(c: ConditionCell)}
  <td class="num">{@render count(c.sessions)}</td>
  {#if c.sessions === 0}
    <!-- その課題に無い条件: 件数だけ 0 で、ほかは値が無い -->
    {#each { length: dataCols - 1 } as _, i (i)}<td class="num"><span class="dash">{DASH}</span></td>{/each}
  {:else}
    {#if table.hasTests}
      <td class="num">{@render count(c.sessions - c.withTests)}</td>
      {#if c.withTests === 0}
        <!-- テストの記録が無い行: 0 と書かない -->
        {#each { length: 6 } as _, i (i)}<td class="num"><span class="dash">{DASH}</span></td>{/each}
      {:else}
        <td class="num">
          {#if c.passRate == null}<span class="dash">{DASH}</span>{:else}{percent(c.passed, c.withTests)}{/if}
          {@render part(`${int(c.passed)} / ${int(c.withTests)} 件`)}
        </td>
        <td class="num">{@render count(c.regressed)}</td>
        <td class="num">{@render count(c.unreached)}</td>
        <td class="num">{until(c.runsToPass, runsText)}{@render part(`${int(c.runsToPass.n)} 件`)}</td>
        <td class="num">{until(c.activeToPass, msText)}{@render part(`${int(c.activeToPass.n)} 件`)}</td>
        <td class="num">{until(c.aiuToPass, aiuText)}{@render part(`${int(c.aiuToPass.n)} 件`)}</td>
      {/if}
    {/if}
    <td class="num">{med(c.active, msText)}{@render part(`${int(c.active.n)} 件`)}</td>
    <td class="num">{med(c.aiu, aiuText)}{@render part(`${int(c.aiu.n)} 件`)}</td>
    <td class="num">
      {#if c.failureRate == null}<span class="dash">{DASH}</span>{:else}{percent(c.toolFailures, c.tools)}{/if}
      {#if c.tools > 0}{@render part(`${int(c.toolFailures)} / ${int(c.tools)} 回`)}{/if}
    </td>
  {/if}
{/snippet}

<section class="section" id="conditions" aria-labelledby="conditions-h">
  <div class="section-head">
    <h2 id="conditions-h">課題 × 条件</h2>
    <p>同じ課題を条件を変えて実行したセッションを、タスクタグの名前(課題{CONDITION_SEP}条件)で分けて並べます。割合と中央値は、もとになるセッションが {MIN} 件未満なら「—」で、件数はいつも出します。</p>
  </div>
  {#if table.rows.length === 0}
    <p class="note" data-testid="conditions-empty">名前の決まりに合うタスクタグはありますが、表に入るセッションがありません。</p>
    {@render excluded()}
  {:else}
    {#if table.tasks.length > 1}
      <h3 class="sub-h" id="conditions-pooled-h">条件ごと(課題をまとめた行)</h3>
      <div class="table-scroll">
        <table class="ledger" aria-labelledby="conditions-pooled-h" data-testid="conditions-pooled">
          {@render head(true)}
          <tbody>
            {#each table.pooled as c (c.condition)}
              <tr data-condition={c.condition}>
                <th scope="row" class="cond" translate="no">{c.condition}</th>
                <td class="num">{int(c.tasks)} / {int(table.tasks.length)}{#if c.tasks < table.tasks.length}<span class="mark" aria-hidden="true">※</span><span class="sr-only">(セッションの無い課題がある)</span>{/if}</td>
                {@render cells(c)}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="note" data-testid="conditions-pooled-note">
        その条件のセッションを、すべての課題から集めた行です。課題やセッションの数が条件でそろっていないと、課題の難しさの違いが条件の差に混ざるので、下の「課題ごと」の行と合わせて読んでください。{#if partial}※ は、セッションの無い課題がある条件です。{/if}{@render uneven()}
      </p>
    {/if}

    <h3 class="sub-h" id="conditions-task-h">課題ごと</h3>
    <div class="table-scroll">
      <table class="ledger" aria-labelledby="conditions-task-h" data-testid="conditions-table">
        {@render head(false)}
        {#each table.tasks as task, i (task)}
          <tbody data-task={task}>
            <tr class="task-row">
              <th scope="rowgroup" colspan={dataCols + 1} class="task"><span class="k">課題</span><span translate="no">{task}</span></th>
            </tr>
            {#each table.rows[i] as c (c.condition)}
              <tr data-task={task} data-condition={c.condition}>
                <th scope="row" class="cond" translate="no">{c.condition}</th>
                {@render cells(c)}
              </tr>
            {/each}
          </tbody>
        {/each}
      </table>
    </div>
    <p class="note" data-testid="conditions-note">
      {#if table.hasTests}
        「最初に全部通るまで」の中央値は、テストの記録があるセッション全部で取ります。一度も全部通らなかった(未達の)セッションは、どの値よりも後ろに並べるので、全部通ったことのあるセッションが半分以下の行は「未達」と出ます。
      {:else}
        テストの記録があるセッションが無いので、テストの結果の列は出していません。テストの実行ファイルが印つきの行(ATLAS_TEST_RESULT)を標準出力に書くと、次の集計から出ます。
      {/if}
      <!-- 課題をまとめた表が無い(課題が 1 つ)ときは、件数の偏りをここで知らせる -->
      {#if table.tasks.length <= 1}{@render uneven()}{/if}
      差は相関で、条件の違いが原因とは限りません。上の絞り込みには従わず、全セッション(空のセッションを含めるかの条件だけ)から数えます(<a href="glossary.html#conditions">用語の説明</a>)。
    </p>
    {@render excluded()}
    <details class="how" id="conditions-how">
      <summary>表の読み方</summary>
      <ul>
        <li><strong>件数</strong>: この課題・条件のタスクタグが付いたセッションの数です。同じセッションは 1 回だけ数えます。課題か条件の違うタグが 2 つ以上付いたセッションは、どの条件の結果か決められないので、どの行にも入れません。</li>
        {#if table.hasTests}
          <li><strong>テストの記録なし</strong>: テストの結果の行が 1 回も読めなかったセッションです。未達には数えず、テストの結果の分母にも入れません。</li>
          <li><strong>最後に全部通った</strong>: テストの記録があるセッションのうち、最後の実行の後に通っていないテストが無いものの割合です。下の小さい字は、その件数 / テストの記録があるセッションです。</li>
          <li><strong>通った後に不合格</strong>: 一度は全部通りましたが、最後の実行の後に通っていないテストがあるセッションの数です。<strong>未達</strong>: テストの実行が 1 回以上あり、一度も全部通らなかったセッションの数です。</li>
          <li><strong>最初に全部通るまで</strong>: 最初に全部通った実行が何回目かと、そこまでの実働と AIU の累計です。AIU は、そこまでの量が分かるセッション(リクエストごとの記録があるもの)だけで取ります。下の小さい字は、中央値を取ったセッションの数です。テストをこまめに走らせるほど、実行の数は増えます。</li>
        {/if}
        <li><strong>セッション全体</strong>: 実働と AIU は、記録があるセッションの中央値です(「比べる」の節は平均なので、値は一致しません)。通った後の作業も、途中で終えたセッションも入ります。ツールの失敗・拒否は、失敗・拒否 ÷ ツール呼び出しで、セッションが {MIN} 件未満なら「—」です。テストが落ちてツールが失敗を返した実行も入るので、テストの結果と別々の証拠にはなりません。</li>
        <li><strong>名前の決まり</strong>: タスクタグの名前を「課題{CONDITION_SEP}条件」か「課題{CONDITION_SEP}条件{CONDITION_SEP}番号」にします(区切りは半角の _ を 2 つ、番号は半角の数字だけ)。番号が違っても、課題と条件が同じなら同じ行です。並びは名前の順(数字は数として比べます)なので、先頭に置きたい条件は、名前の頭に数字を付けてください(例 0-plain)。</li>
      </ul>
    </details>
  {/if}
</section>

<style>
  .sub-h {
    margin: 16px 0 6px;
    font-size: 0.9375rem;
  }
  th.grp {
    text-align: center;
  }
  /* 条件の名前の列。数値の列に押されて 1〜2 文字ずつ折り返さないよう幅を確保する(表は横にスクロールする) */
  .cond {
    font-weight: normal;
    min-width: 7em;
    max-width: 16em;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  /* 課題の見出しの行: 濃い罫と太字で区切る(地の色は変えない) */
  .task {
    font-weight: 600;
    border-top-color: var(--rule-strong);
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .task .k {
    margin-right: 0.75em;
    font-size: 0.75rem;
    font-weight: normal;
    color: var(--form);
  }
  /* 値の下の、割った数。件数の少ない行ではここが主な情報なので、補足より 1 段濃くする */
  .part {
    display: block;
    font-size: 0.75rem;
    font-weight: normal;
    color: var(--ink-2);
  }
  .zero,
  .dash {
    color: var(--ink-3);
  }
  .mark {
    margin-left: 2px;
    font-size: 0.75rem;
  }
  /* タスクタグの名前が入る注記: 区切りの無い長い名前でも、狭い幅ではみ出さない */
  .names {
    overflow-wrap: anywhere;
  }
  .how {
    margin-top: 12px;
    font-size: 0.8125rem;
  }
  .how summary {
    color: var(--form);
    min-height: 24px;
  }
  .how ul {
    margin: 6px 0 0;
    padding-left: 1.2em;
    color: var(--ink-2);
  }
</style>
