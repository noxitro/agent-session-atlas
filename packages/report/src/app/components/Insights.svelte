<script lang="ts">
  // Phase 12: 改善点(LLM を呼ばない規則の集計)。カードは計算の対象で 2 つの群に分け、1 枚のカードに対象を混ぜない。
  // 絞り込みに従う群: 指示文の傾向・skill の傾向・llm-wiki の利用(件数だけ。画面だけで insights.html には無い)・止まっている箇所(sessions で再計算)・
  // llm-wiki のページごとの参照率と役立った率(画面だけ。役立ったかの列だけは、判定を回したときの LLM の見立て)。
  // 全記録の群: 「長いのに注入が少ない」(全体での希少さの話なので allSessions)と、スキル化の候補
  // (依頼文の本文が要るので build 時に全セッションで計算して埋め込んだもの。全件は insights.html)
  import { date, dec, duration, int } from '../../lib/format.ts';
  import { cleanHeading, instructionFindings, instructionVersions, skillStats, stuckByProject, stuckSessions, SKILL_RATE_CAUSE, THRESHOLDS, type Candidate, type VersionMeta } from '../../lib/insights.ts';
  import type { SessionSummary } from '../../lib/types.ts';
  import { WIKI_JUDGED_PAGES_MAX, WIKI_PAGES_OLD_DATA, shortPageNames, sortWikiPageRows, wikiPageTable, wikiStateNote, wikiUsageSummary, type WikiPageRow, type WikiPageSortKey, type WikiPageVerdictValue, type WikiState } from '../../lib/wiki.ts';
  import SortMark from './SortMark.svelte';


  let {
    sessions,
    allSessions,
    installed,
    disabled = [],
    meta,
    candidates,
    candidateTotal,
    computedOver,
    hasPage,
    libraryHref,
    wiki = 'counted',
    wikiPagesRecorded = true,
    wikiPageNames = [],
  }: {
    sessions: SessionSummary[];
    /** 絞り込み前の全セッション */
    allSessions: SessionSummary[];
    installed: string[] | null;
    /** 設定で無効にしてある skill(settings.json の disabledSkills。今の設定) */
    disabled?: string[];
    /** 指示文の版の見出し等 */
    meta: Record<string, VersionMeta>;
    /** 上位 30 件(埋め込み) */
    candidates: Candidate[];
    /** 候補の全件数 */
    candidateTotal: number;
    computedOver: number;
    /** insights.html を作ったか(export / build どちらでも作る) */
    hasPage: boolean;
    libraryHref: string | null;
    /** llm-wiki の参照を数えた集計か(App.svelte が絞り込み前の全セッションで決める) */
    wiki?: WikiState;
    /** 埋め込みに読んだページの名前があるか(埋め込みの版 18 以降。App.svelte が ReportData.version で決める) */
    wikiPagesRecorded?: boolean;
    /** 読んだページの名前の辞書(ReportData.wikiPageNames。要約の wiki.pages はこの番号) */
    wikiPageNames?: string[];
  } = $props();

  const versions = $derived(instructionVersions(sessions));
  const findings = $derived(instructionFindings(versions, meta, sessions.length));
  const allFindings = $derived(instructionFindings(instructionVersions(allSessions), meta, allSessions.length));
  const longRare = $derived(allFindings.longRare);
  const longRareChars = $derived(allFindings.longChars);
  const skills = $derived(skillStats(sessions, installed));
  const disabledSet = $derived(new Set(disabled.map((n) => n.toLowerCase())));
  /** 呼んだときの失敗率が出せる skill があるか(無ければ失敗率の列を出さない) */
  const skillRates = $derived(skills.stats.some((s) => s.failureWith != null));
  // llm-wiki の利用: 絞り込み後のセッションの件数だけ(率は出さない)
  const wikiNote = $derived(wikiStateNote(wiki));
  const wikiUse = $derived(wikiUsageSummary(sessions));
  // llm-wiki のページごと: 参照率(ログ)と役立った率(LLM の見立て)を別の列で並べる。率の閾値は改善点の他の率と同じ MIN_SESSIONS
  const wikiPages = $derived(wikiPageTable(sessions, wikiPageNames, THRESHOLDS.MIN_SESSIONS));
  /** 箱の中に並べる行の数(残りは「全件を表で見る」) */
  const PAGE_ROWS = 10;
  /** ページの行を開いたときに並べるセッションの数(残りは件数だけ) */
  const READERS_MAX = 50;
  /** 数の列(参照率・役立った率は、どのページも — なら列ごと出さず、理由を注に書く) */
  const PAGE_COLS: { key: Exclude<WikiPageSortKey, 'page'>; label: string; rate: boolean }[] = [
    { key: 'sessions', label: '読んだセッション', rate: false },
    { key: 'share', label: '参照率', rate: true },
    { key: 'yes', label: '役立った', rate: false },
    { key: 'no', label: '役立たなかった', rate: false },
    { key: 'unknown', label: '分からない', rate: false },
    { key: 'unjudged', label: '未判定', rate: false },
    { key: 'helpfulRate', label: '役立った率', rate: true },
  ];
  const showShare = $derived(wikiPages.rows.some((r) => r.share != null));
  const showHelpful = $derived(wikiPages.rows.some((r) => r.helpfulRate != null));
  const pageCols = $derived(PAGE_COLS.filter((c) => (c.key !== 'share' || showShare) && (c.key !== 'helpfulRate' || showHelpful)));
  /** 表に出すページの名前(共通のフォルダと .md を除く。元のパスは title と、行を開いた中に出す) */
  const pageNames = $derived(shortPageNames(wikiPages.rows.map((r) => r.page)));
  const pageNamesNote = $derived.by(() => {
    const parts = [pageNames.prefix ? `${pageNames.prefix} からの相対` : '', pageNames.dropMd ? '.md を省いて' : ''].filter(Boolean);
    return parts.length ? `ページは ${parts.join('、')}出しています(元の名前は、名前に重ねると出ます)。` : 'ページは読んだときの名前です。';
  });
  // 並べ替え(上位の表と全件の表で共通)。並べている列を出さなくなったら、読んだセッションの多い順に戻す
  let pageSort = $state<WikiPageSortKey>('sessions');
  let pageAsc = $state(false);
  const sortKey = $derived<WikiPageSortKey>(pageSort === 'page' || pageCols.some((c) => c.key === pageSort) ? pageSort : 'sessions');
  const sortAsc = $derived(sortKey === pageSort ? pageAsc : false);
  const sortedPages = $derived(sortWikiPageRows(wikiPages.rows, sortKey, sortAsc));
  const sortLabel = $derived.by(() => {
    if (sortKey === 'page') return sortAsc ? 'ページの名前の順' : 'ページの名前の逆順';
    const c = PAGE_COLS.find((x) => x.key === sortKey)!;
    return `${c.label}の${c.rate ? (sortAsc ? '低い' : '高い') : sortAsc ? '少ない' : '多い'}順`;
  });
  function sortPages(k: WikiPageSortKey): void {
    pageAsc = sortKey === k ? !sortAsc : k === 'page';
    pageSort = k;
  }
  const pageMark = (k: WikiPageSortKey): 'asc' | 'desc' | 'none' => (sortKey === k ? (sortAsc ? 'asc' : 'desc') : 'none');
  const pageAria = (k: WikiPageSortKey): 'ascending' | 'descending' | 'none' => (sortKey === k ? (sortAsc ? 'ascending' : 'descending') : 'none');
  /** 開いているページの行(表の testid とページの名前) */
  let openPages = $state<Record<string, boolean>>({});
  const VERDICT_LABEL: Record<WikiPageVerdictValue | 'none', string> = { yes: '役立った', no: '役立たなかった', unknown: '分からない', none: '未判定' };
  /** ページを読んだセッション(新しい順) */
  const readersOf = (r: WikiPageRow): { s: SessionSummary; verdict: WikiPageVerdictValue | null }[] =>
    r.readers
      .map((x) => ({ s: sessions[x.index]!, verdict: x.verdict }))
      .filter((x) => x.s)
      .sort((a, b) => (b.s.updatedAt ?? b.s.createdAt ?? '').localeCompare(a.s.updatedAt ?? a.s.createdAt ?? ''));
  const labelOf = (s: SessionSummary): string => (s.name || s.firstUserMessage || s.id.slice(0, 8)).replace(/\s+/g, ' ').slice(0, 60);
  const stuck = $derived(stuckSessions(sessions));
  const byProject = $derived(stuckByProject(stuck, sessions));
  const TOP = 5;
  // 率は小数 1 桁にそろえる(2.41% と 2.4% が並ぶと別の値に見える)
  const pct = (v: number | null): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const vname = (hash: string): string => {
    const m = meta[hash];
    return m ? `${cleanHeading(m.heading, 40) || '(見出しなし)'} 版 ${m.order + 1}` : hash;
  };
  const vhref = (hash: string): string | null => (libraryHref ? `${libraryHref}#v-${hash}` : null);
  const sessionLabel = (id: string): string => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return id.slice(0, 8);
    return (s.name || s.firstUserMessage || id.slice(0, 8)).replace(/\s+/g, ' ').slice(0, 50);
  };
</script>

<section class="section" id="insights" aria-labelledby="insights-h">
  <div class="section-head">
    <h2 id="insights-h">改善点</h2>
    <p>
      LLM を呼ばない規則の集計(llm-wiki のページの「役立った」の列だけは、判定を回したときの LLM の見立て)。分かるのは相関までで、「傾向」として読んでください。指示文の効果は直接測れません(同じ版でも依頼が違う)。率は {THRESHOLDS.MIN_SESSIONS} セッション以上のものだけ。{#if hasPage}全件は <a href="insights.html">改善点のページ</a>。{/if}
    </p>
  </div>
  <p class="group" id="insights-g-filtered">絞り込みに従う: 上の絞り込みの {int(sessions.length)} セッションで計算します。</p>
  <div class="grid" role="group" aria-labelledby="insights-g-filtered">
    <div class="box" data-testid="insights-instructions">
      <h3>指示文の傾向</h3>
      <p class="basis">
        版を変えた前後の比較: {int(findings.compared)} 組を判定、悪化 {int(findings.worsened.length)}{#if findings.comparedInsufficient}。{int(findings.comparedInsufficient)} 組はどちらかが {THRESHOLDS.MIN_SESSIONS} セッション未満で判定できません{/if}。
      </p>
      {#if findings.worsened.length}
        <ol>
          {#each findings.worsened.slice(0, TOP) as w (w.after.hash)}
            <li>
              版を変えた前後で悪化: {#if vhref(w.after.hash)}<a href={vhref(w.after.hash)}>{vname(w.after.hash)}</a>{:else}{vname(w.after.hash)}{/if}(失敗率 {w.failureDelta == null ? '—' : `${w.failureDelta >= 0 ? '+' : ''}${dec(w.failureDelta)} pt`}、手戻り率 {w.reworkDelta >= 0 ? '+' : ''}{dec(w.reworkDelta)} pt、{int(w.before.sessions)} → {int(w.after.sessions)} セッション)
            </li>
          {/each}
        </ol>
      {/if}
      {#if versions.length}
        <div class="table-scroll">
          <table class="ledger small">
            <caption class="cap">注入されたセッションの多い版(上位 {Math.min(TOP, versions.length)} / 全 {int(versions.length)} 版)</caption>
            <thead><tr><th scope="col">版</th><th scope="col" class="num">字数</th><th scope="col" class="num">セッション</th><th scope="col" class="num">失敗率</th><th scope="col" class="num">手戻り率</th></tr></thead>
            <tbody>
              {#each versions.slice(0, TOP) as v (v.hash)}
                <tr><td>{#if vhref(v.hash)}<a href={vhref(v.hash)}>{vname(v.hash)}</a>{:else}{vname(v.hash)}{/if}</td><td class="num">{int(v.chars)}</td><td class="num">{int(v.sessions)}</td><td class="num">{v.enough ? pct(v.failureRate) : '—'}</td><td class="num">{v.enough ? pct(v.reworkRate) : '—'}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="basis">失敗率: ツールの失敗・拒否 / 呼び出し。手戻り率: 同じファイルを 2 回以上編集したセッションの割合。— は {THRESHOLDS.MIN_SESSIONS} セッション未満。</p>
      {/if}
    </div>

    <div class="box" data-testid="insights-skills">
      <h3>skill の傾向</h3>
      {#if skills.stats.length === 0}
        <p class="basis">skill の呼び出しはありません。</p>
      {:else}
        <div class="table-scroll">
          <table class="ledger small">
            <caption class="cap">呼び出しの多い skill(上位 {Math.min(TOP, skills.stats.length)} / 全 {int(skills.stats.length)} 件)</caption>
            <thead><tr><th scope="col">skill</th><th scope="col" class="num">呼び出し</th><th scope="col" class="num">字数</th>{#if skillRates}<th scope="col" class="num">失敗率(呼んだ / 呼ばない)</th>{/if}</tr></thead>
            <tbody>
              {#each skills.stats.slice(0, TOP) as s (s.name)}
                <tr><td>{s.name}</td><td class="num">{int(s.calls)}</td><td class="num">{s.chars == null ? '記録なし' : int(s.chars)}</td>{#if skillRates}<td class="num">{pct(s.failureWith)} / {pct(s.failureWithout)}</td>{/if}</tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if skillRates}
          <p class="basis">失敗率: ツールの失敗・拒否 / 呼び出し(その skill を呼んだセッション / 呼ばなかったセッション)。— は {THRESHOLDS.MIN_SESSIONS} セッション未満。{SKILL_RATE_CAUSE}</p>
        {:else}
          <p class="basis">{THRESHOLDS.MIN_SESSIONS} セッション以上で呼ばれた skill が無いので、呼んだときと呼ばないときの失敗率は比べられません。</p>
        {/if}
      {/if}
      {#if skills.unused.length}<p class="basis">インストール済みで未使用: {skills.unused.map((n) => (disabledSet.has(n.toLowerCase()) ? `${n}(無効)` : n)).join('、')}</p>{/if}
    </div>

    <div class="box" data-testid="insights-stuck">
      <h3>止まっている箇所</h3>
      {#if stuck.length === 0}
        <p class="basis">閾値を超えたセッションはありません。</p>
      {:else}
        <p class="basis">{int(stuck.length)} セッションが閾値(最初のトークンまでの待ちの中央値 {duration(THRESHOLDS.STUCK.ttftMs)} 以上、ツールの失敗の連続 {THRESHOLDS.STUCK.consecutiveFailures} 回以上、余分な編集(同じファイルの 2 回目以降の編集の全ファイルの合計){THRESHOLDS.STUCK.extraEdits} 回以上、権限確認 {THRESHOLDS.STUCK.permissions} 件以上、compaction {THRESHOLDS.STUCK.compactions} 回以上)を超えています。理由の多い順に上位 {Math.min(TOP, stuck.length)} 件。</p>
        <ol>
          {#each stuck.slice(0, TOP) as x (x.id)}
            <li><a href={x.href}>{sessionLabel(x.id)}</a>: {x.reasons.join('、')}{#if x.reasons.includes('待ち時間') && x.ttftMedian != null}(待ちの中央値 {duration(x.ttftMedian)}){/if}</li>
          {/each}
        </ol>
        {#if byProject.length}
          <p class="basis">プロジェクト別(該当 / 全セッション。{THRESHOLDS.MIN_SESSIONS} セッション以上のもの): {byProject.slice(0, TOP).map((p) => `${p.projectLabel} ${int(p.stuck)} / ${int(p.total)}`).join('、')}</p>
        {/if}
      {/if}
    </div>

    <!-- llm-wiki の 2 つの箱は並べる(目次の「llm-wiki」の飛び先) -->
    <div class="box anchor" id="insights-wiki" data-testid="insights-wiki">
      <h3>llm-wiki の利用</h3>
      {#if wikiNote}
        <p class="basis" data-testid="insights-wiki-off">{wikiNote}</p>
      {:else}
        <div class="table-scroll">
          <table class="ledger small" data-testid="insights-wiki-counts">
            <caption class="cap">セッションの数</caption>
            <thead><tr><th scope="col" class="num">参照した</th><th scope="col" class="num">うち書き込みもあり</th><th scope="col" class="num">書き込みだけ</th><th scope="col" class="num">参照なし</th></tr></thead>
            <tbody><tr><td class="num">{int(wikiUse.referenced)}</td><td class="num">{int(wikiUse.referencedWithWrites)}</td><td class="num">{int(wikiUse.writeOnly)}</td><td class="num">{int(wikiUse.none)}</td></tr></tbody>
          </table>
        </div>
        <div class="table-scroll">
          <table class="ledger small" data-testid="insights-wiki-breakdown">
            <caption class="cap">参照の内訳(回。個別ページは読んだページの延べ)</caption>
            <thead><tr><th scope="col" class="num">索引</th><th scope="col" class="num">個別ページ</th><th scope="col" class="num">wiki の skill</th><th scope="col" class="num">検索・一覧など</th></tr></thead>
            <tbody><tr><td class="num">{int(wikiUse.indexReads)}</td><td class="num">{int(wikiUse.pageReads)}</td><td class="num">{int(wikiUse.skillCalls)}</td><td class="num">{int(wikiUse.otherCalls)}</td></tr></tbody>
          </table>
        </div>
        <p class="basis" data-testid="insights-wiki-why">率は並べていません。参照するかどうかは作業の中身で決まるので、差が出ても wiki が原因とは分かりません。引数に vault の場所が出ない読みは数えないので、「参照なし」にも参照したセッションが混ざります。数え方は<a href="glossary.html#llm-wiki">用語の説明</a>。参照したセッションだけを見るときは、絞り込みの「その他の条件」の「wiki を参照したセッションだけ」。</p>
      {/if}
    </div>

    <div class="box wide" data-testid="insights-wiki-pages">
      <h3>llm-wiki のページごとの参照率と役立った率</h3>
      {#if wikiNote}
        <p class="basis" data-testid="insights-wiki-pages-off">{wikiNote}</p>
      {:else if !wikiPagesRecorded}
        <p class="basis" data-testid="insights-wiki-pages-old">{WIKI_PAGES_OLD_DATA}</p>
      {:else if wikiPages.rows.length === 0}
        <p class="basis" data-testid="insights-wiki-pages-empty">この条件で、llm-wiki のページを読んだセッションはありません(wiki を参照したセッション {int(wikiPages.referenced)} 件)。</p>
      {:else}
        {@render pageTable(sortedPages.slice(0, PAGE_ROWS), `${sortLabel}(上位 ${Math.min(PAGE_ROWS, sortedPages.length)} / 全 ${int(sortedPages.length)} ページ)。${showShare ? '参照率の分母は ' : ''}wiki を参照したセッション ${int(wikiPages.referenced)} 件`, 'insights-wiki-pages-table')}
        {#if sortedPages.length > PAGE_ROWS}
          <details class="tableview">
            <summary>全件を表で見る({int(sortedPages.length)} ページ)</summary>
            {@render pageTable(sortedPages, `全 ${int(sortedPages.length)} ページ(${sortLabel})`, 'insights-wiki-pages-all')}
          </details>
        {/if}
        <p class="basis" data-testid="insights-wiki-pages-names">
          {pageNamesNote}ページの名前を押すと、そのページを読んだセッションの一覧と、それぞれの役立ったかの見立てが開きます。列の見出しを押すと並べ替えます。
        </p>
        <p class="basis" data-testid="insights-wiki-pages-why">
          参照率 = そのページを読んだセッション ÷ wiki を参照したセッション。ログで分かるのは「読んだ」ことまでで、回答の中で引用したかは見ていません。引数に vault の場所が出ない読み(相対パスなど)は数えません。
        </p>
        <p class="basis" data-testid="insights-wiki-pages-llm">
          役立ったかは LLM の見立てで、判定役は読んだページの名前と、ログにあれば抜粋を見たうえで答えています。測った値ではありません。役立った率 = 役立った ÷(役立った + 役立たなかった)で、分からない・未判定は分母に入れません。未判定は、判定していないセッション・前の版の判定・判定に載せなかったページ(1 セッション {WIKI_JUDGED_PAGES_MAX} ページまで)です。
        </p>
        {#if !showShare}
          <p class="basis" data-testid="insights-wiki-pages-no-share">参照率の列は出していません。wiki を参照したセッションが {int(wikiPages.referenced)} 件で、{THRESHOLDS.MIN_SESSIONS} セッションに届きません。</p>
        {/if}
        {#if !showHelpful}
          <p class="basis" data-testid="insights-wiki-pages-no-helpful">役立った率の列は出していません。役立った + 役立たなかったが {THRESHOLDS.MIN_SESSIONS} セッションに届くページがありません(判定を回すと増えます)。</p>
        {/if}
        <p class="basis">{#if showShare || showHelpful}— は分母が {THRESHOLDS.MIN_SESSIONS} セッション未満。{/if}参照率(ログ)と役立った率(LLM の見立て)は別の数で、1 つの点数にはまとめていません。</p>
      {/if}
    </div>

  </div>

  {#snippet pageTable(rows: WikiPageRow[], caption: string, testid: string)}
    <div class="table-scroll">
      <table class="ledger small" data-testid={testid}>
        <caption class="cap">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort={pageAria('page')}><button type="button" class="sort" onclick={() => sortPages('page')}>ページ<SortMark state={pageMark('page')} /></button></th>
            {#each pageCols as c (c.key)}
              <th scope="col" class="num" aria-sort={pageAria(c.key)}><button type="button" class="sort" onclick={() => sortPages(c.key)}>{c.label}<SortMark state={pageMark(c.key)} /></button></th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as r, i (r.page)}
            {@const key = `${testid}:${r.page}`}
            {@const rid = `${testid}-r-${i}`}
            <tr>
              <th scope="row" class="page">
                <button type="button" class="open" aria-expanded={!!openPages[key]} aria-controls={openPages[key] ? rid : undefined} title={r.page} onclick={() => (openPages[key] = !openPages[key])}>{pageNames.short.get(r.page) ?? r.page}</button>
              </th>
              {#each pageCols as c (c.key)}
                <td class="num">{c.rate ? pct(r[c.key]) : int(r[c.key] ?? 0)}</td>
              {/each}
            </tr>
            {#if openPages[key]}
              {@const list = readersOf(r)}
              <tr class="readers" id={rid} data-testid="insights-wiki-pages-readers">
                <td colspan={pageCols.length + 1}>
                  <p class="basis"><span class="path">{r.page}</span> を読んだセッション {int(list.length)} 件(新しい順)。右は、役立ったかの LLM の見立て。</p>
                  <ul>
                    {#each list.slice(0, READERS_MAX) as x (x.s.id)}
                      <li><a href={x.s.href}>{labelOf(x.s)}</a> <span class="meta">{date(x.s.updatedAt ?? x.s.createdAt)} · {VERDICT_LABEL[x.verdict ?? 'none']}</span></li>
                    {/each}
                  </ul>
                  {#if list.length > READERS_MAX}<p class="basis">ほか {int(list.length - READERS_MAX)} セッション(絞り込みで狭めると全部出ます)</p>{/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/snippet}

  <p class="group" id="insights-g-all">全記録で計算: 絞り込みに関係なく、すべての記録で計算します。絞り込んでも変わりません。</p>
  <div class="grid" role="group" aria-labelledby="insights-g-all">
    <div class="box" data-testid="insights-long-rare">
      <h3>長いのに注入が少ない指示文</h3>
      <p class="basis">全 {int(allSessions.length)} セッションで計算。字数が全版の上位 25%({int(longRareChars)} 字以上)で、注入されたのが {THRESHOLDS.RARE_SESSIONS} セッション未満の版。読み込まれる場面が少ないのに長い指示文は、分けるか短くする候補です。{#if longRare.length}上位 {Math.min(TOP, longRare.length)} / 全 {int(longRare.length)} 版。{/if}</p>
      {#if longRare.length === 0}
        <p class="basis">該当する版はありません。</p>
      {:else}
        <ol>
          {#each longRare.slice(0, TOP) as v (v.hash)}
            <li>{#if vhref(v.hash)}<a href={vhref(v.hash)}>{vname(v.hash)}</a>{:else}{vname(v.hash)}{/if}({int(v.chars)} 字、{int(v.sessions)} セッション{#if meta[v.hash]?.lastAt}、最後に読み込んだのは {date(meta[v.hash].lastAt ?? null)}{/if})</li>
          {/each}
        </ol>
      {/if}
    </div>

    <div class="box" data-testid="insights-candidates">
      <h3>スキル化の候補</h3>
      <p class="basis">全記録({int(computedOver)} 件、空のセッションを含む)で計算。似た依頼文の繰り返しと同じツールの並びの繰り返し({THRESHOLDS.MIN_REPEAT} 回以上)。スコアは回数 × 実働の中央値(分。1 分未満は 1 分、2 時間で頭打ち)。実働はターンの中で 5 分を超えて出来事が無かった区間(返答待ちや放置)を除いた時間です。上位 {Math.min(TOP, candidates.length)} / 全 {int(candidateTotal)} 件。</p>
      {#if candidates.length === 0}
        <p class="basis">候補はありません。</p>
      {:else}
        <ol>
          {#each candidates.slice(0, TOP) as c, i (c.key)}
            <li>
              {#if c.kind === 'tools'}<span class="seq">{c.key}</span>{:else}{clip((c.representative ?? c.key).replace(/\s+/g, ' '), 70)}{/if}
              <span class="meta">{int(c.count)} 回 · {int(c.sessions.length)} セッション · スコア {dec(c.score)}</span>
              {#if hasPage}<a class="go" href="insights.html#c-{i + 1}" aria-label="候補 {i + 1} を詳しく">詳しく →</a>{/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
</section>

<style>
  .group {
    margin: 14px 0 6px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--ink-2);
  }
  .group:first-of-type {
    margin-top: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr));
    border-top: 1px solid var(--rule-strong);
    border-left: 1px solid var(--rule);
  }
  .box {
    padding: 10px 12px 12px;
    border-right: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    background: var(--surface);
    min-width: 0;
  }
  /* llm-wiki のページごとの表: 列が多いので、どの幅でも 1 行を使う */
  .box.wide {
    grid-column: 1 / -1;
  }
  /* 目次の「llm-wiki」から飛んだとき、箱の上端に余白を空ける */
  .anchor {
    scroll-margin-top: 12px;
  }
  /* 狭い幅でも名前を 1 字ずつに折らない(表は .table-scroll で横に流す) */
  th.page {
    min-width: 12em;
    font-weight: 400;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .sort {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .sort:hover {
    text-decoration: underline;
  }
  /* ページの名前: 押すと読んだセッションの一覧を開く(開閉は ▸ / ▾ と aria-expanded) */
  .open {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    min-height: 24px;
    padding: 2px 0;
    font: inherit;
    color: var(--form);
    text-align: left;
    background: none;
    border: 0;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .open::before {
    content: '▸';
    flex: none;
    color: var(--ink-3);
  }
  .open[aria-expanded='true']::before {
    content: '▾';
  }
  .open:hover {
    text-decoration: underline;
  }
  tr.readers > td {
    padding: 6px 10px 8px 22px;
    text-align: left;
    background: var(--page);
  }
  tr.readers ul {
    margin: 0;
    padding-left: 1.2em;
    font-size: 0.75rem;
  }
  tr.readers li {
    margin: 2px 0;
  }
  tr.readers li a {
    display: inline-block;
    min-height: 24px;
    padding: 2px 0;
  }
  .path {
    font-family: var(--mono);
    overflow-wrap: anywhere;
  }
  .box h3 {
    margin: 0 0 4px;
    font-size: 0.875rem;
    color: var(--form);
  }
  .basis {
    margin: 0 0 6px;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  ol {
    margin: 0;
    padding-left: 1.4em;
    font-size: 0.8125rem;
  }
  li {
    margin: 4px 0;
    overflow-wrap: anywhere;
  }
  .meta {
    color: var(--ink-3);
    font-size: 0.75rem;
    margin-left: 6px;
  }
  .seq {
    font-family: var(--mono);
    font-size: 0.75rem;
  }
  .go {
    margin-left: 6px;
    white-space: nowrap;
  }
  table.small {
    margin-top: 6px;
    font-size: 0.75rem;
  }
  caption.cap {
    caption-side: top;
    text-align: left;
    padding: 0 0 2px;
    color: var(--ink-2);
  }
</style>
