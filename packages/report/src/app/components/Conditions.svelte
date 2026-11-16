<script lang="ts">
  // 「課題 × 条件」の節: タスクタグの名前(課題__条件)で分けたセッションを、条件ごと(課題をまとめた行)と課題ごとに並べる。
  // 表は並べるだけで、差や順位は出さず、割合と中央値の下に、割った数をいつも添える。
  // 操作する部品は「利用の確認」の、確かめるものの選択と「使うはず」の印だけ(画面の中だけで、保存しない)
  import { COMPARE_MIN_SESSIONS } from '../../lib/compare.ts';
  import { usageItems, usageMismatches, usageRows, WIKI_ITEM, type UsageKind, type UsageMismatch } from '../../lib/condition-usage.ts';
  import { CONDITION_SEP, type ConditionCell, type ConditionTable, type Median, type UntilPass } from '../../lib/conditions.ts';
  import { dec, duration, int, percent, truncate } from '../../lib/format.ts';

  /** wikiVaults: 参照を数えた llm-wiki の vault の数(0 なら数えていない。古い集計では undefined) */
  let { table, wikiVaults }: { table: ConditionTable; wikiVaults?: number } = $props();

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
  // ---- 利用の確認 ----
  const USAGE_KINDS: UsageKind[] = ['wiki', 'skill', 'mcp', 'tool'];
  const USAGE_KIND_LABEL: Record<UsageKind, string> = { wiki: 'llm-wiki', skill: 'skill', mcp: 'MCP サーバー', tool: 'ツール' };
  /** 食い違ったセッションの一覧に並べる数 */
  const LIST_MAX = 50;
  let item = $state(WIKI_ITEM);
  /** 確かめるもの → 使うはずの条件(画面の中だけ。保存しない) */
  let expectedBy = $state<Record<string, string[]>>({});
  const items = $derived(usageItems(table.members));
  // タスクタグを付け替えて選んでいたものが無くなったら、llm-wiki に戻す
  const current = $derived(items.some((i) => i.key === item) ? item : WIKI_ITEM);
  // 戻したことを選択にも残す(後でその項目が表に戻っても、黙って選び直さない)
  $effect(() => {
    if (current !== item) item = current;
  });
  const selected = $derived(items.find((i) => i.key === current) ?? items[0]);
  const expected = $derived(new Set((expectedBy[current] ?? []).filter((c) => table.conditions.includes(c))));
  const usage = $derived(usageRows(table, current));
  const mismatch = $derived(usageMismatches(table, current, expected));
  function toggle(condition: string, on: boolean): void {
    const next = new Set(expectedBy[current] ?? []);
    if (on) next.add(condition);
    else next.delete(condition);
    expectedBy = { ...expectedBy, [current]: [...next] };
  }

  /** 一覧のセッションの名前(セッション一覧と同じ決め方: 名前 → 最初の依頼 → id の先頭) */
  const sessionTitle = (s: { id: string; name?: string | null; firstUserMessage?: string | null }): string => truncate(s.name || s.firstUserMessage || `(名前なし) ${s.id.slice(0, 8)}`, 60);

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

<!-- 食い違ったセッションの一覧(多ければ先頭だけ) -->
{#snippet mismatches(title: string, list: UsageMismatch[], kind: string)}
  <h4 class="sub-h4" id="conditions-usage-{kind}-h">{title} {int(list.length)} 件</h4>
  {#if list.length === 0}
    <p class="note" data-testid="conditions-usage-{kind}">ありません。</p>
  {:else}
    <div class="table-scroll">
      <table class="ledger" aria-labelledby="conditions-usage-{kind}-h" data-testid="conditions-usage-{kind}">
        <thead>
          <tr>
            <th scope="col">セッション</th>
            <th scope="col">課題</th>
            <th scope="col">条件</th>
            <th scope="col" class="num">{current === WIKI_ITEM ? '参照' : '呼び出し'}</th>
          </tr>
        </thead>
        <tbody>
          {#each list.slice(0, LIST_MAX) as m (m.member.session.id)}
            <tr data-session={m.member.session.id}>
              <th scope="row" class="sess">{#if m.member.session.href}<a href={m.member.session.href}>{sessionTitle(m.member.session)}</a>{:else}{sessionTitle(m.member.session)}{/if}</th>
              <td class="cond" translate="no">{m.member.task}</td>
              <td class="cond" translate="no">{m.member.condition}</td>
              <td class="num">{@render count(m.count)} 回</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if list.length > LIST_MAX}<p class="note">ほかに {int(list.length - LIST_MAX)} 件あります(先頭の {int(LIST_MAX)} 件だけを並べています)。</p>{/if}
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

    <h3 class="sub-h" id="conditions-usage-h">利用の確認</h3>
    <p class="note">条件が実際に効いたかを確かめます。確かめるもの(llm-wiki の参照・skill・MCP サーバー・ツール)を選び、それを使うはずの条件にチェックを付けると、使うはずの条件で使わなかったセッションと、ほかの条件で使ったセッションを下に並べます。チェックは画面の中だけのもので、保存しません。</p>
    <div class="usage-ctl">
      <label>
        <span class="k">確かめるもの</span>
        <select value={current} onchange={(e) => (item = e.currentTarget.value)} data-testid="conditions-usage-item">
          {#each USAGE_KINDS as k (k)}
            {#if items.some((i) => i.kind === k)}
              <optgroup label={USAGE_KIND_LABEL[k]}>
                {#each items.filter((i) => i.kind === k) as i (i.key)}<option value={i.key}>{i.kind === 'wiki' ? 'llm-wiki の参照' : i.name}({int(i.sessions)})</option>{/each}
              </optgroup>
            {/if}
          {/each}
        </select>
      </label>
    </div>
    {#if current === WIKI_ITEM && wikiVaults === 0}
      <p class="note caution" data-testid="conditions-usage-wiki-off">この集計では llm-wiki の vault を指定していないので、wiki の参照は数えていません(どのセッションも 0 です)。設定の wikis で vault を指定して集計し直すと数えます。</p>
    {:else if current === WIKI_ITEM && wikiVaults === undefined && selected.sessions === 0}
      <p class="note">この集計には、llm-wiki の vault を指定していたかの記録がありません(集計し直すと記録されます)。指定していなければ、wiki の参照はどのセッションも 0 です。</p>
    {/if}
    <div class="table-scroll">
      <table class="ledger" aria-labelledby="conditions-usage-h" data-testid="conditions-usage">
        <thead>
          <tr>
            <th scope="col">条件</th>
            <th scope="col" class="chk">使うはず</th>
            <th scope="col" class="num">件数</th>
            <th scope="col" class="num">使った</th>
            <th scope="col" class="num">使わなかった</th>
            <th scope="col" class="num" title="使った ÷ 件数。件数が {MIN} 件未満なら —">使った割合</th>
          </tr>
        </thead>
        <tbody>
          {#each usage as r (r.condition)}
            <tr data-condition={r.condition}>
              <th scope="row" class="cond" translate="no">{r.condition}</th>
              <td class="chk"><label><input type="checkbox" aria-label="{r.condition} で使うはず" checked={expected.has(r.condition)} onchange={(e) => toggle(r.condition, e.currentTarget.checked)} /></label></td>
              <td class="num">{@render count(r.sessions)}</td>
              <td class="num">{@render count(r.used)}</td>
              <td class="num">{@render count(r.sessions - r.used)}</td>
              <td class="num">{#if r.share == null}<span class="dash">{DASH}</span>{:else}{percent(r.used, r.sessions)}{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if expected.size === 0}
      <p class="note" data-testid="conditions-usage-hint">使うはずの条件にチェックを付けると、食い違ったセッションを下に並べます。</p>
    {:else}
      {@render mismatches('使うはずの条件で使わなかったセッション', mismatch.missing, 'missing')}
      {@render mismatches('ほかの条件で使ったセッション', mismatch.leaked, 'leaked')}
    {/if}

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
        <li><strong>利用の確認</strong>: llm-wiki は参照(索引・個別ページを読んだ回数、wiki の skill の呼び出し、vault の検索・一覧などそのほかの呼び出し。書き込みだけのセッションは使わなかったに入ります)、skill は呼び出し、MCP サーバーはそのサーバーのツールの呼び出し、ツールは呼び出しを数えます。llm-wiki の参照は、集計した PC の設定で vault を指定したときだけ数えます。選べるのは、この表のセッションで使われたものだけです(llm-wiki はいつも選べます)。</li>
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
  .sub-h4 {
    margin: 14px 0 6px;
    font-size: 0.875rem;
  }
  .usage-ctl {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    margin: 8px 0;
  }
  .usage-ctl label {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    max-width: 100%;
  }
  .usage-ctl .k {
    font-size: 0.75rem;
    color: var(--form);
  }
  .usage-ctl select {
    font: inherit;
    font-size: 0.8125rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 3px 6px;
    height: 30px;
    max-width: 100%;
  }
  .usage-ctl select:hover {
    border-color: var(--form);
  }
  /* 注意の一文(集計の設定で数えていないもの)。色だけでなく、文で書く */
  .caution {
    padding: 6px 10px;
    border: 1px solid var(--warn);
    background: var(--warn-wash);
    color: var(--ink);
  }
  /* 押せる範囲は label で 28 × 28px 以上(印そのものは 16px のまま。セッション一覧のチェック欄と同じ) */
  .chk {
    width: 28px;
    text-align: center;
  }
  .chk label {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 28px;
  }
  .chk input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--form);
  }
  .sess {
    font-weight: normal;
    min-width: 12em;
    max-width: 28em;
    white-space: normal;
    overflow-wrap: anywhere;
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
