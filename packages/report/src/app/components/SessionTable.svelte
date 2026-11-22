<script lang="ts">
  import { frictionTotal } from '../../lib/aggregate.ts';
  import { sessionTime, sessionUpdated } from '../../lib/filter.ts';
  import { date, dateTime, dec, duration, int, modelLabel, pathParts, sharedLeads, splitLead, truncate } from '../../lib/format.ts';
  import type { SessionSummary } from '../../lib/types.ts';
  import SortMark from './SortMark.svelte';
  import { restoredView, saveView } from '../view-restore.ts';
  import { categoryLabel, confidenceLabel } from '../../lib/judgment-labels.ts';
  import { excerptAround, ID_PREFIX_MIN, looksLikeId, searchIndex, searchSessions, searchTerms } from '../../lib/session-search.ts';
  import { LINK_SOURCE_LABEL } from '../../lib/tasks.ts';
  import type { TaskLinkView } from '../../lib/types.ts';

  let {
    sessions,
    allSessions = null,
    emptyRelaxed = null,
    emptyIncluded = false,
    judged,
    selected,
    idsActive,
    onselect,
    onapply,
    onclear,
    tasks = null,
  }: {
    sessions: SessionSummary[];
    /** 絞り込む前の全セッション(検索で、今の絞り込みの外にも合うものがあるかを数える。無ければ数えない) */
    allSessions?: SessionSummary[] | null;
    /** 今の絞り込みで、空のセッションも含めたときに出るセッション(検索に合った空のセッションが「空のセッションを含める」だけで出るかを決める) */
    emptyRelaxed?: SessionSummary[] | null;
    /** 空のセッションを含めているか */
    emptyIncluded?: boolean;
    judged: boolean;
    /** チェックしたセッション id(画面内だけ。保存しない) */
    selected: Set<string>;
    /** 「選んだセッションだけ集計」が効いているか(filter.ids) */
    idsActive: boolean;
    onselect: (ids: Set<string>) => void;
    /** 選んだものだけで集計する(filter.ids に入れる) */
    onapply: () => void;
    /** 選択を外す(集計中ならその条件も外す) */
    onclear: () => void;
    /** 管理ツールのタスクの紐づけ(セッション id → 紐づけ)とタスクの名前。タスクの記録が無ければ null */
    tasks?: { links: Record<string, TaskLinkView>; names: ReadonlyMap<string, string> } | null;
  } = $props();
  /** 一覧のタスクの 1 行(紐づいたタスクの名前・ID・紐づけの出所。理由は title)。紐づいていなければ null */
  function taskLine(id: string): { name: string; id: string; source: string; title: string } | null {
    const l = tasks?.links[id];
    if (!l?.taskId) return null;
    const name = tasks?.names.get(l.taskId) ?? l.taskId;
    return { name: name === l.taskId ? '' : name, id: l.taskId, source: LINK_SOURCE_LABEL[l.source], title: l.reason ? `紐づけの理由: ${l.reason}` : '' };
  }

  /** 変更行の欄の title(出所と、記録が欠けている理由) */
  function linesTitle(l: SessionSummary['lines']): string {
    const why = l.note === 'subagent-edits' ? 'サブエージェントの変更は数えられない' : l.note === 'empty-shutdown' ? '終了時の codeChanges が空' : '';
    const src = l.source === 'shutdown' ? '終了時の累計(codeChanges)' : l.source === 'tools' ? 'ツールごとの行数の合計' : '';
    return src && why ? `${src}(${why})` : src || why;
  }

  /** 依頼ごとの判定をどこかで使っているか(使っていなければ、依頼の欄に判定の済み・未判定を出さない) */
  const turnJudgeUsed = $derived((allSessions ?? sessions).some((s) => s.turnVerdicts?.length));
  /** 依頼ごとの判定の済んだ数(依頼ごとの記録がある依頼のうち。記録が無ければ null。詳細ページの「LLM 判定(依頼)」と同じ数え方) */
  function turnJudged(s: SessionSummary): { n: number; m: number } | null {
    const m = s.turnRows?.length ?? 0;
    if (!m) return null;
    const turns = new Set((s.turnVerdicts ?? []).map((v) => v[0]).filter((t) => t >= 1 && t <= m));
    return { n: turns.size, m };
  }

  type Key = 'time' | 'updated' | 'turns' | 'input' | 'output' | 'tools' | 'lines' | 'friction' | 'active' | 'human';
  const value: Record<Key, (s: SessionSummary) => number> = {
    time: (s) => sessionTime(s) ?? -Infinity,
    updated: (s) => sessionUpdated(s) ?? -Infinity,
    turns: (s) => s.turns,
    input: (s) => s.tokens.input ?? -1,
    output: (s) => s.tokens.output,
    tools: (s) => s.tools.total,
    lines: (s) => (s.lines.source === 'none' ? -1 : s.lines.added + s.lines.removed),
    friction: (s) => frictionTotal(s.friction),
    active: (s) => s.activeMs ?? -1,
    human: (s) => s.judgment?.hours ?? -1,
  };
  // 戻る / 進むで開かれたら、離れたときの並べ替えとページから始める(view-restore.ts)
  const back = restoredView()?.table;
  let sortKey = $state<Key>(back && back.sortKey in value ? (back.sortKey as Key) : 'time');
  let asc = $state(back?.asc === true);
  let page = $state(back && Number.isInteger(back.page) && back.page > 0 ? back.page : 0);
  /** 一覧の検索(セッション ID の先頭か題名の一部)。行を絞るだけで、上の集計は変えない */
  let query = $state(typeof back?.query === 'string' ? back.query : '');
  $effect(() => {
    const onHide = (): void => saveView({ table: { sortKey, asc, page, query } });
    addEventListener('pagehide', onHide);
    return () => removeEventListener('pagehide', onHide);
  });
  const PAGE = 50;

  // 題名をそろえる(NFKC など)のは、セッションの並びが変わったときだけ。打つたびには、そろえた形と比べるだけにする
  const index = $derived(searchIndex(sessions));
  const allIndex = $derived(allSessions ? searchIndex(allSessions) : null);
  const found = $derived(searchSessions(index, query));
  /** 一覧に出す行(検索していれば、合ったものだけ) */
  const rows = $derived(found ? found.rows : sessions);
  /** 空のセッションも含めたときに出るセッションの id(検索語によらないので、打つたびには作らない) */
  const relaxedIds = $derived(new Set((emptyRelaxed ?? []).map((s) => s.id)));
  /**
   * 検索に合ったが、今の絞り込みで外れているセッション。emptyOnly は「空のセッションを含める」だけで出るもの、
   * rest はほかの条件(期間・プロジェクトなど)でも外れているもの(restEmpty はそのうち空のセッション)
   */
  const outside = $derived.by(() => {
    if (!found || !allIndex) return null;
    const shown = new Set(found.rows.map((s) => s.id));
    const out = (searchSessions(allIndex, query)?.rows ?? []).filter((s) => !shown.has(s.id));
    const onlyEmpty = (s: SessionSummary): boolean => !emptyIncluded && s.empty && relaxedIds.has(s.id);
    const rest = out.filter((s) => !onlyEmpty(s));
    return { emptyOnly: out.length - rest.length, rest: rest.length, restEmpty: emptyIncluded ? 0 : rest.filter((s) => s.empty).length };
  });
  /** 検索の結果の一文(検索していなければ空) */
  const findText = $derived.by(() => {
    if (!found) return '';
    const parts = [found.rows.length ? `${int(found.rows.length)} 件が合います。` : '合うセッションはありません。'];
    // ID の探し方は、絞り込みの外も含めてどこにも合わなかったときだけ添える(ID 全体で外のセッションに当たったときに出すと紛らわしい)
    if (!found.rows.length && !outside?.emptyOnly && !outside?.rest && searchTerms(query).some(looksLikeId)) parts.push(`ID は先頭から ${ID_PREFIX_MIN} 文字以上で探します(途中の文字では探せません)。`);
    if (outside?.emptyOnly) parts.push(`空のセッション ${int(outside.emptyOnly)} 件は、「その他の条件」の「空のセッションを含める」で出ます。`);
    if (outside?.rest) {
      const empty = outside.restEmpty ? `。うち空のセッション ${int(outside.restEmpty)} 件は「空のセッションを含める」も要ります` : '';
      parts.push(`今の絞り込みで外れているセッションにも ${int(outside.rest)} 件合います(絞り込みを外すと出ます${empty})。`);
    }
    return parts.join('');
  });
  function onSearch(v: string): void {
    query = v;
    page = 0;
  }

  const sorted = $derived.by(() => {
    const f = value[sortKey];
    const dir = asc ? 1 : -1;
    // 日時の無いもの(-Infinity)どうしの差は NaN になるので、同じとみなす
    return [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return (x === y ? 0 : (x - y) * dir) || a.id.localeCompare(b.id);
    });
  });
  const pages = $derived(Math.max(1, Math.ceil(sorted.length / PAGE)));
  // 絞り込みで件数が減ったらページを戻す
  $effect(() => {
    if (page > pages - 1) page = pages - 1;
  });
  const visible = $derived(sorted.slice(page * PAGE, page * PAGE + PAGE));

  function sortBy(k: Key): void {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = false;
    }
    page = 0;
  }
  const st = (k: Key): 'asc' | 'desc' | 'none' => (sortKey === k ? (asc ? 'asc' : 'desc') : 'none');
  const ariaSort = (k: Key): 'ascending' | 'descending' | 'none' => (sortKey === k ? (asc ? 'ascending' : 'descending') : 'none');

  /** 推定人手工数の欄の title: 幅と、判定したモデル・日時 */
  function judgmentTitle(j: NonNullable<SessionSummary['judgment']>): string {
    const range = j.low != null && j.high != null ? `。幅 ${dec(j.low)}〜${dec(j.high)} 時間` : '';
    const by = [j.model, j.ranAt ? `${dateTime(j.ranAt)} に判定` : ''].filter(Boolean).join('・');
    return `LLM による推定${range}${by ? `(${by})` : ''}`;
  }
  const rawTitle = (s: SessionSummary): string => s.name || s.firstUserMessage || `(名前なし) ${s.id.slice(0, 8)}`;
  function title(s: SessionSummary): string {
    return truncate(rawTitle(s), 80);
  }

  /**
   * 書き出しが同じ行の見分け(一覧の全行で比べる。ページをめくっても変わらない)。
   * 共通の書き出しは先頭だけ残して「…」に縮め、違いが始まるところから見せる。題名がまったく同じ行には件数の印を付ける
   */
  const leads = $derived.by(() => {
    const m = new Map<string, { lead: string | null; rest: string; same: number }>();
    const texts = rows.map(rawTitle);
    sharedLeads(texts).forEach((x, i) => {
      if (x.cut === 0 && x.same < 2) return;
      m.set(rows[i].id, x.cut > 0 ? { ...splitLead(texts[i], x.cut, 70), same: x.same } : { lead: null, rest: title(rows[i]), same: x.same });
    });
    return m;
  });

  // --- 選択(チェック欄)。状態は親(App)が持ち、ここは表示と操作だけ ---
  const visibleChecked = $derived(visible.filter((s) => selected.has(s.id)).length);
  const allVisible = $derived(visible.length > 0 && visibleChecked === visible.length);
  function toggle(id: string, on: boolean): void {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onselect(next);
  }
  /** 見出し行のチェック: このページの行をまとめて選ぶ / 外す */
  function toggleVisible(on: boolean): void {
    const next = new Set(selected);
    for (const s of visible) if (on) next.add(s.id);
    else next.delete(s.id);
    onselect(next);
  }

</script>

<section class="section" id="sessions" aria-labelledby="sessions-h">
  <div class="section-head">
    <h2 id="sessions-h">セッション一覧</h2>
    <p>
      {#if found}{int(found.rows.length)} / {int(sessions.length)} セッション(検索で絞っています)。{:else}{int(sessions.length)} セッション。{/if}名前を押すと詳細(時系列・ツール内訳・指示ファイル・摩擦)を開きます。表は横にスクロールできます。
      {#if !judged}推定人手工数は未判定です(LLM による判定を実行すると表示されます)。{/if}
    </p>
  </div>

  <!-- 一覧の検索: 行を絞るだけ(上の集計と、選んだセッションは変えない) -->
  <div class="find-bar" role="search" aria-label="セッション一覧の検索">
    <label class="fld find">
      <span class="k">セッションを探す</span>
      <input
        type="search"
        value={query}
        oninput={(e) => onSearch(e.currentTarget.value)}
        onkeydown={(e) => {
          // IME の変換を取り消す Esc では消さない。ほかの Esc の処理にも渡さない
          if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229 && query) {
            e.preventDefault();
            e.stopPropagation();
            onSearch('');
          }
        }}
        spellcheck="false"
        autocomplete="off"
        placeholder="セッション ID か題名の一部"
        aria-describedby="session-find-hint session-find-result"
        data-testid="session-search"
      />
    </label>
    <!-- live 領域は常に置いておき、文だけ差し替える(後から挿入すると読み上げられない) -->
    <p class="find-result" id="session-find-result" role="status" data-testid="session-search-result">{findText}</p>
    <p class="find-hint" id="session-find-hint">ID は先頭 {ID_PREFIX_MIN} 文字以上か ID 全体(ID を含むパスを貼ってもよい)。題名は、セッション名と最初の依頼の先頭 160 字から探します。上の集計は変えません。</p>
  </div>

  <!-- 選択の操作列: チェックした件数と、その件数だけで集計 / 解除 -->
  <div class="select-bar" role="group" aria-label="セッションの選択">
    <p class="sel-count">
      <span aria-live="polite" aria-atomic="true"><strong data-testid="selected-count">{int(selected.size)}</strong> 件を選択中</span>{#if idsActive}<span class="tag on">この選択で集計中</span>{/if}
      {#if selected.size === 0}<span class="why">左端の欄にチェックを付けると、そのセッションだけで集計し直せます。</span>{/if}
    </p>
    <div class="sel-actions">
      <button type="button" class="btn" data-testid="apply-selection" disabled={selected.size === 0} onclick={onapply}>選んだ {int(selected.size)} 件だけ集計</button>
      <!-- 選択で集計中は 0 件でも押せる(記録に無い id だけを選んだ URL で開いたときに条件を外す手段を残す) -->
      <button type="button" class="btn" disabled={selected.size === 0 && !idsActive} onclick={onclear}>選択を解除</button>
    </div>
  </div>

  {#if rows.length > 0}
    <div class="table-scroll">
      <table class="ledger">
        <thead>
          <tr>
            {#snippet head(k: Key, label: string, num = true)}
              <th scope="col" class:num aria-sort={ariaSort(k)}>
                <button type="button" class="sort" onclick={() => sortBy(k)}>{label}<SortMark state={st(k)} /></button>
              </th>
            {/snippet}
            <th scope="col" class="chk">
              <label>
                <input
                  type="checkbox"
                  aria-label="このページの {int(visible.length)} 件を選択"
                  checked={allVisible}
                  indeterminate={visibleChecked > 0 && !allVisible}
                  onchange={(e) => toggleVisible(e.currentTarget.checked)}
                />
              </label>
            </th>
            {@render head('time', '開始', false)}
            {@render head('updated', '最終更新', false)}
            <th scope="col">プロジェクト</th>
            <th scope="col">セッション</th>
            <th scope="col">クライアント</th>
            <th scope="col">モデル</th>
            {@render head('turns', '依頼')}
            {@render head('input', '入力トークン')}
            {@render head('output', '出力トークン')}
            {@render head('tools', 'ツール')}
            {@render head('lines', '変更行')}
            {@render head('friction', '摩擦')}
            {@render head('active', '実働')}
            {@render head('human', '推定人手工数')}
          </tr>
        </thead>
        <tbody>
          {#each visible as s (s.id)}
            <tr class:picked={selected.has(s.id)}>
              <td class="chk"><label><input type="checkbox" aria-label="{title(s)} を選択" checked={selected.has(s.id)} onchange={(e) => toggle(s.id, e.currentTarget.checked)} /></label></td>
              <td class="num when">{dateTime(s.createdAt ?? s.updatedAt)}</td>
              <td class="num when">{dateTime(s.updatedAt ?? s.createdAt)}</td>
              <td class="proj" title={s.project}>{#each pathParts(s.projectLabel) as seg, i (i)}{#if i}<wbr />{/if}{seg}{/each}{#if s.branch}<span class="sub">{s.branch}</span>{/if}</td>
              <td class="name"><a href={s.href} title={title(s)}>{#if leads.get(s.id)?.lead}<span class="lead" title="ほかの行と同じ書き出し(縮めて表示)">{leads.get(s.id)?.lead}</span>{leads.get(s.id)?.rest}{:else}{title(s)}{/if}</a>{#if (leads.get(s.id)?.same ?? 1) > 1}<span class="tag" title="一覧の中に題名がまったく同じセッションが {leads.get(s.id)?.same} 件あります。開始時刻やプロジェクトで見分けてください">同じ題名 ×{leads.get(s.id)?.same}</span>{/if}{#if s.empty}<span class="tag" title="依頼・ツール呼び出し・応答がどれも無いセッション">空</span>{/if}{#if found?.byId.has(s.id)}<span class="sub sid" data-testid="session-id">ID {s.id}</span>{/if}{#if found?.viaFirst.has(s.id) && s.firstUserMessage}<span class="sub" data-testid="session-first-hit">最初の依頼: {excerptAround(s.firstUserMessage, found.viaFirst.get(s.id) ?? '')}</span>{/if}{#if s.memo}<span class="sub" data-testid="memo-excerpt">メモ: {s.memo.excerpt || '(本文なし)'}</span>{/if}{#if taskLine(s.id)}{@const tl = taskLine(s.id)!}<span class="sub" title={tl.title || undefined} data-testid="session-task">タスク: {tl.name ? `${tl.name} · ` : ''}<span translate="no">{tl.id}</span>(紐づけ: {tl.source})</span>{/if}</td>
              <td class="nowrap">{s.client ?? '不明'}</td>
              <td class="models" title={s.models.join('、')}>{s.models.length ? s.models.map(modelLabel).join('、') : '不明'}</td>
              <td class="num">
                {int(s.turns)}{#if turnJudgeUsed}{@const tj = turnJudged(s)}{#if tj}<span class="sub" class:tj-done={tj.n > 0} title="依頼ごとの LLM 判定(採用): 判定済み {int(tj.n)} / {int(tj.m)} 依頼" data-testid="turn-judge-state">{tj.n === 0 ? '未判定' : tj.n === tj.m ? '✓ 判定済み' : `判定 ${int(tj.n)} / ${int(tj.m)}`}</span>{/if}{/if}
              </td>
              <td class="num">
                {#if s.tokens.input == null}<span class="missing-value">{s.coverage === 'output-only' ? '推計不可' : '記録なし'}</span>{:else}{int(s.tokens.input)}{/if}
              </td>
              <td class="num">{#if s.coverage === 'none'}<span class="missing-value">記録なし</span>{:else}{int(s.tokens.output)}{/if}</td>
              <td class="num">{int(s.tools.total)}</td>
              <td class="num" title={linesTitle(s.lines)}>
                <!-- 記録が無いときは「—」(該当なし・0 件)ではなく記録なし。詳細ページと同じ -->
                {#if s.lines.source === 'none'}<span class="missing-value">記録なし</span>{:else}+{int(s.lines.added)}<span class="sub">−{int(s.lines.removed)}</span>{/if}
              </td>
              <td class="num">{int(frictionTotal(s.friction))}</td>
              <td class="num">{duration(s.activeMs, '—')}</td>
              <td class="num">
                {#if s.judgment?.hours != null}<span title={judgmentTitle(s.judgment)}>{dec(s.judgment.hours)} 時間</span><span class="sub">{categoryLabel(s.judgment.taskCategory)}・{confidenceLabel(s.judgment.confidence)}</span>{#if s.judgment.ranAt}<span class="sub" data-testid="judged-at">判定 {date(s.judgment.ranAt)}</span>{/if}{:else}<span class="missing-value">未判定</span>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if pages > 1}
      <nav class="pager" aria-label="セッション一覧のページ">
        <button type="button" class="btn" disabled={page === 0} onclick={() => (page = 0)}>先頭</button>
        <button type="button" class="btn" disabled={page === 0} onclick={() => (page -= 1)}>前へ</button>
        <span>{page + 1} / {pages} ページ({int(page * PAGE + 1)}〜{int(Math.min(sorted.length, page * PAGE + PAGE))} 件目)</span>
        <button type="button" class="btn" disabled={page >= pages - 1} onclick={() => (page += 1)}>次へ</button>
        <button type="button" class="btn" disabled={page >= pages - 1} onclick={() => (page = pages - 1)}>末尾</button>
      </nav>
    {/if}
  {/if}
</section>

<style>
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
  .when,
  .nowrap {
    white-space: nowrap;
  }
  .proj {
    min-width: 12em;
    max-width: 20em;
    overflow-wrap: anywhere;
    font-size: 0.75rem;
  }
  /* 題名(多くは依頼文の先頭)は 2 行で切る。全文は title とセッションの詳細で読める。行の高さを揃えて一覧を見渡せるようにする。
     空白の無い長い語(`FAnimInstanceProxy::Initialize(...)` などの識別子やパス)も欄の中で折り返す(折り返せないと右端で省略記号なしに切れる)。
     anywhere ではなく break-word にする: 欄の最小幅の計算に長い語の幅が残り、欄が 18em まで縮んで題名の見える量が減ることがない */
  .name a {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: break-word;
    min-height: 24px;
    padding: 2px 0;
  }
  .name .lead {
    color: var(--ink-3);
  }
  .name {
    min-width: 18em;
    max-width: 32em;
  }
  .models {
    max-width: 14em;
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    display: block;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  /* ID は長い 16 進の並びなので、欄の幅で折り返す */
  /* 依頼ごとの判定が済んだ(一部でも)ものは、未判定(淡墨)より 1 段濃くする。済み・未判定は文字でも分かる */
  .sub.tj-done {
    color: var(--ink-2);
  }
  .sub.sid {
    font-family: var(--mono, ui-monospace, monospace);
    overflow-wrap: anywhere;
  }
  /* 一覧の検索(見出しの直下、選択の操作列の上) */
  .find-bar {
    display: flex;
    align-items: flex-end;
    gap: 4px 16px;
    flex-wrap: wrap;
    padding-top: 4px;
  }
  /* 狭い画面では欄が縮む(26em のままだと 320px の幅で横にはみ出す) */
  .fld.find {
    flex: 0 1 26em;
    min-width: 0;
  }
  .fld.find input {
    width: 100%;
  }
  .find-hint {
    flex: 1 0 100%;
    margin: 0;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .find-result {
    margin: 0;
    flex: 1 1 16em;
    min-height: 1.25rem;
    font-size: 0.8125rem;
    color: var(--ink-2);
    align-self: center;
  }
  .pager {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 8px;
    font-size: 0.8125rem;
  }

  /* 選択の操作列(表の見出しの直下、1 行。狭い画面では折り返す) */
  .select-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    flex-wrap: wrap;
    padding: 8px 0;
    border-bottom: 1px solid var(--rule);
    font-size: 0.8125rem;
  }
  .sel-count {
    margin: 0;
    color: var(--ink-2);
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sel-count strong {
    font-size: 1.0625rem;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .sel-count .tag.on {
    border-color: var(--form);
    color: var(--form);
    background: var(--form-wash);
  }
  .sel-count .why {
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .sel-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .sel-actions .btn {
    padding: 3px 10px;
  }
  /* チェック欄(表の左端。行全体をクリックの的にはしない: 名前はリンクで、誤って開くのを避ける) */
  .chk {
    width: 28px;
    padding: 0 2px 0 4px;
    text-align: center;
    vertical-align: top;
  }
  /* 押せる範囲は label で 28 × 28px 以上(印そのものは 16px のまま) */
  .chk label {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 32px;
  }
  .chk input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--form);
  }
  tr.picked td {
    background: var(--form-wash);
  }

  .fld {
    display: block;
  }
  .fld .k {
    display: block;
    font-size: 0.6875rem;
    color: var(--form);
    margin-bottom: 2px;
  }
  .fld input {
    font: inherit;
    font-size: 0.8125rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 3px 6px;
    height: 30px;
    width: 16em;
    max-width: 100%;
  }
</style>
