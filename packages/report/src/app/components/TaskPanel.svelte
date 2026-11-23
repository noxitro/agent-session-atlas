<script lang="ts">
  // 概況の「管理ツールのタスク」の節。値はすべて集計のとき(Rust の tasks::view)に決めたもので、画面は出すだけ(数え直さない)。
  // 上の絞り込みは掛からない(タスクの行を押すと、そのタスクのセッションに絞り込む)。
  // 2 つの工数(AI を使わなかった場合・使った場合)と AI の実働は、別の欄に並べるだけで 1 つの点数にしない
  import { dateTime, dec, int } from '../../lib/format.ts';
  import { NO_TASK, filterHref, emptyFilter } from '../../lib/filter.ts';
  import { hours, linkCounts, msHours, TASK_EXCLUDED_LABEL, taskIncludedNote, workHoursText } from '../../lib/tasks.ts';
  import type { TaskRow, TasksReport } from '../../lib/types.ts';
  import SortMark from './SortMark.svelte';

  let {
    tasks,
    current,
    noneCount,
    onpick,
  }: {
    tasks: TasksReport;
    /** 今のタスクの絞り込み(filter.task。無ければ '') */
    current: string;
    /** 集計対象のうち、どのタスクにも紐づいていないセッションの数 */
    noneCount: number;
    /** タスクで絞り込む('' で外す) */
    onpick: (task: string) => void;
  } = $props();

  const s = $derived(tasks.summary);
  const done = $derived(tasks.items.filter((t) => t.done).length);
  const missing = $derived(tasks.items.filter((t) => t.missing).length);
  const wh = $derived(workHoursText(tasks.workHours));
  const ratioText = (r: number): string => `${dec(Math.round(r * 100) / 100)} 倍`;

  type Key = 'name' | 'status' | 'start' | 'doneAt' | 'human' | 'work' | 'active' | 'sessions';
  const timeOf = (iso: string | null): number => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  const value: Record<Key, (t: TaskRow) => number | string> = {
    name: (t) => t.name || t.id,
    status: (t) => t.status,
    start: (t) => timeOf(t.start),
    doneAt: (t) => timeOf(t.doneAt),
    human: (t) => (t.judgedSessions > t.lowConfidenceSessions ? t.humanHours : -1),
    work: (t) => t.workMs ?? -1,
    active: (t) => t.aiActiveMs,
    sessions: (t) => t.sessions,
  };
  /** null は XML の順(並べ替えていない) */
  let sortKey = $state<Key | null>(null);
  let asc = $state(false);
  let showAll = $state(false);
  let expanded = $state(false);
  const LIMIT = 15;
  /** セッションの紐づいたタスクだけ(紐づいていないタスクは、押したときだけ出す。管理ツールのタスクは多いことがある) */
  const linked = $derived(tasks.items.filter((t) => t.sessions > 0));
  const unlinked = $derived(tasks.items.length - linked.length);
  const rows = $derived(showAll ? tasks.items : linked);
  const sorted = $derived.by(() => {
    if (!sortKey) return rows;
    const f = value[sortKey];
    const dir = asc ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      const c = typeof x === 'string' ? x.localeCompare(y as string, 'ja') : x === y ? 0 : x - (y as number);
      return c * dir || a.id.localeCompare(b.id);
    });
  });
  const visible = $derived(expanded ? sorted : sorted.slice(0, LIMIT));
  function sortBy(k: Key): void {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = k === 'name' || k === 'status';
    }
  }
  const st = (k: Key): 'asc' | 'desc' | 'none' => (sortKey === k ? (asc ? 'asc' : 'desc') : 'none');
  const ariaSort = (k: Key): 'ascending' | 'descending' | 'none' => (sortKey === k ? (asc ? 'ascending' : 'descending') : 'none');

  /** そのタスクだけに絞った URL(新しいタブでも開ける)。クリックは親に任せてほかの条件を保つ */
  const href = (id: string): string => filterHref({ ...emptyFilter(), task: id });
  function pick(e: MouseEvent, id: string): void {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onpick(current === id ? '' : id);
  }
</script>

<section class="section" id="tasks" aria-labelledby="tasks-h" data-testid="tasks-panel">
  <div class="section-head">
    <h2 id="tasks-h">管理ツールのタスク</h2>
    <p>
      管理ツールのタスクごとに、紐づいたセッションの工数を並べます。値は集計したときのもので、上の絞り込みは掛かりません(タスクの名前を押すと、そのタスクのセッションに絞り込みます)。2 つの工数は推定と時刻から出したもので、実際に人が作業した時間でも、良し悪しの評価でもありません。
      {#if tasks.origin === 'sender'}送った人がセッションごとに添えた記録から数えています。{:else if tasks.file}書き出し: <span class="nw" data-testid="tasks-file">{tasks.file}</span>(更新 {dateTime(tasks.observedAt)})。{/if}
      表は <code>out/tables/tasks.csv</code> にもあります。
    </p>
  </div>

  {#each tasks.warnings as w, i (i)}
    <p class="task-warn" role="alert" data-testid="tasks-warning">{w}</p>
  {/each}

  {#if tasks.items.length === 0}
    <p class="note" data-testid="tasks-empty">
      {#if tasks.origin === 'sender'}送った人の記録に、紐づいたタスクはありません。{:else}タスクがありません。設定の <code>tasks.file</code> の XML と、読み方(<code>tasks.item</code> など)を確かめてください。{/if}
    </p>
  {:else}
    <div class="fields task-fields" style="--cols:3">
      <div class="field">
        <span class="k">タスクの数</span>
        <span class="v" data-testid="tasks-count">{int(tasks.items.length)}</span>
        <span class="n">完了 {int(done)}・未完了 {int(tasks.items.length - done)}{missing ? `(うち最後の書き出しに無いもの ${int(missing)})` : ''}。セッションが紐づいたもの {int(s.tasks)}</span>
      </div>
      <div class="field">
        <span class="k">比べられる完了タスク</span>
        <span class="v" data-testid="tasks-included">{int(s.included)}</span>
        <span class="n">{taskIncludedNote(s)}</span>
      </div>
      <div class="field">
        <span class="k">AI を使わなかった場合 ÷ AI を使った場合</span>
        {#if s.ratio != null}
          <span class="v" data-testid="tasks-ratio">{ratioText(s.ratio)}</span>
          <span class="n">比べられる完了タスク {int(s.included)} 件の合計どうしの比(推定)</span>
        {:else}
          <span class="v" data-testid="tasks-ratio">—</span>
          <span class="n" data-testid="tasks-ratio-why">比べられる完了タスクが {int(s.ratioMin)} 件から出します(今 {int(s.included)} 件)</span>
        {/if}
      </div>
    </div>
    <!-- 2 つの工数と AI の実働は、別の欄に並べるだけ(狭い幅でも 2 つの工数が隣り合うよう、数の欄とは別の組にする) -->
    <div class="fields task-fields efforts" style="--cols:3">
      <div class="field">
        <span class="k">AI を使わなかった場合の工数(推定人手工数)</span>
        <span class="v" data-testid="tasks-human">{s.included ? hours(s.humanHours) : '—'}</span>
        <span class="n">比べられる完了タスクの合計。LLM の推定</span>
      </div>
      <div class="field">
        <span class="k">AI を使った場合の工数(開始〜完了、稼働時間帯)</span>
        <span class="v" data-testid="tasks-work">{s.included ? msHours(s.workMs) : '—'}</span>
        <span class="n">比べられる完了タスクの合計。稼働時間帯 {wh}・祝日は区別しない</span>
      </div>
      <div class="field">
        <span class="k">AI の実働</span>
        <span class="v" data-testid="tasks-active">{s.included ? msHours(s.aiActiveMs) : '—'}</span>
        <span class="n">比べられる完了タスクの合計。紐づいたタスクすべてでは {msHours(s.aiActiveMsAll)}</span>
      </div>
    </div>

    <ul class="defs" data-testid="tasks-defs">
      <li><strong>AI を使わなかった場合の工数</strong>: 紐づいたセッションの推定人手工数(LLM の推定)の合計。確信度が 30% 以下の推定は入れません。</li>
      <li><strong>AI を使った場合の工数</strong>: 紐づいた最初のセッションの開始から、完了を確認した時刻までのうち、稼働時間帯({wh}、この PC の時刻)に入る時間。祝日は区別しません(平日の祝日も稼働時間帯に入ります)。完了を確認した時刻は、XML で完了と分かった時刻(書き出しのファイルの更新時刻)で、書き出しの間隔の分だけ遅れます。</li>
      <li><strong>AI の実働</strong>: 紐づいたセッションの実働時間(5 分を超えて記録の無い間を除いた時間)の合計。</li>
      <li data-testid="tasks-split">
        複数のタスクに紐づくセッションの実働時間と推定人手工数は、タスクの数で等分して数えます(2 つなら半分ずつ。タスクの値を足すと、セッションの値を重ねずに全体の値になります)。タスクの一覧に無いタスクと、完了を確認した後に始めたセッションのタスクには数えず、残りのタスクで分けます。セッションの数は等分せず、紐づいたタスクごとに 1 つずつ数えます。{#if s.sharedSessions > 0}今は {int(s.sharedSessions)} セッションを複数のタスクに分けて数えています。{/if}<a href="glossary.html#task-split">等分とは</a>
      </li>
      <li>数え方は<a href="glossary.html#task-comparable">用語の説明</a>にあります。</li>
    </ul>

    <h3 class="sub-h" id="tasks-table-h">タスクごと</h3>
    {#if rows.length === 0}
      <p class="note">セッションが紐づいたタスクはありません。</p>
    {:else}
      <div class="table-scroll">
        <table class="ledger" aria-labelledby="tasks-table-h" data-testid="tasks-table">
          <thead>
            <tr>
              {#snippet head(k: Key, label: string, num = true)}
                <th scope="col" class:num aria-sort={ariaSort(k)}>
                  <button type="button" class="sort" onclick={() => sortBy(k)}>{label}<SortMark state={st(k)} /></button>
                </th>
              {/snippet}
              {@render head('name', 'タスク', false)}
              {@render head('status', '状態', false)}
              {@render head('start', '開始', false)}
              {@render head('doneAt', '完了を確認', false)}
              {@render head('human', 'AI を使わなかった場合')}
              {@render head('work', 'AI を使った場合')}
              {@render head('active', 'AI の実働')}
              {@render head('sessions', 'セッション')}
              <th scope="col">紐づけの出所</th>
              <th scope="col">比べない理由</th>
            </tr>
          </thead>
          <tbody>
            {#each visible as t (t.id)}
              <tr class:current={current === t.id} data-task={t.id}>
                <th scope="row" class="name">
                  {#if t.sessions > 0}
                    <a class="link" href={href(t.id)} aria-current={current === t.id ? 'true' : undefined} onclick={(e) => pick(e, t.id)} data-testid="task-pick">{t.name || t.id}</a>
                  {:else}
                    <span class="plain">{t.name || t.id}</span>
                  {/if}
                  <span class="part id" translate="no">{t.id}</span>
                  {#if current === t.id}<span class="part">絞り込み中(もう一度押すと解除)。<a href={filterHref({ ...emptyFilter(), task: t.id }, null, 'list')}>セッション一覧へ</a></span>{/if}
                </th>
                <td class="status"><span translate="no">{t.status || '—'}</span><span class="part">{t.done ? '完了' : '未完了'}</span>{#if t.missing}<span class="tag" title="最後に読んだ XML に無かったタスク。最後に読んだ値のまま出しています">書き出しに無い</span>{/if}</td>
                <td class="num when">{dateTime(t.start, '—')}</td>
                <td class="num when">{dateTime(t.doneAt, '—')}</td>
                <td class="num">
                  <!-- 確信度の低い推定だけなら、合計に入れる推定が無い(0 時間とは書かない) -->
                  {#if t.sessions === 0}—{:else if t.judgedSessions === 0}<span class="missing-value">未判定</span>{:else if t.judgedSessions === t.lowConfidenceSessions}—{:else}{hours(t.humanHours)}{/if}
                  {#if t.sessions > 0}<span class="part">判定 {int(t.judgedSessions)} / {int(t.sessions)}{t.lowConfidenceSessions ? `・確度が低い ${int(t.lowConfidenceSessions)}` : ''}</span>{/if}
                </td>
                <td class="num">{#if t.workMs != null}{msHours(t.workMs)}{:else if t.sessions === 0}—{:else}—<span class="part">{t.excluded ? TASK_EXCLUDED_LABEL[t.excluded] : '未完了'}</span>{/if}</td>
                <td class="num">{t.sessions ? msHours(t.aiActiveMs) : '—'}</td>
                <td class="num">{int(t.sessions)}{#if t.sharedSessions > 0}<span class="part" title="ほかのタスクにも紐づいているセッション。実働と推定人手工数はタスクの数で等分しています" data-testid="task-shared">共有 {int(t.sharedSessions)}</span>{/if}</td>
                <td class="src">{linkCounts(t.links) || '—'}</td>
                <td class="why">{t.excluded ? TASK_EXCLUDED_LABEL[t.excluded] : t.comparable ? '比べる' : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <div class="more">
      {#if sorted.length > LIMIT}
        <button type="button" class="btn" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>{expanded ? `上位 ${LIMIT} 件だけ表示` : `残り ${int(sorted.length - LIMIT)} 件も表示`}</button>
      {/if}
      {#if unlinked > 0}
        <button type="button" class="btn" onclick={() => (showAll = !showAll)} data-testid="tasks-show-all">{showAll ? 'セッションの紐づいたタスクだけ表示' : `セッションの紐づいていないタスク ${int(unlinked)} 件も表示`}</button>
      {/if}
    </div>
  {/if}
  {#if noneCount > 0 || current === NO_TASK}
    <p class="note" data-testid="tasks-none">
      どのタスクにも紐づいていないセッション: {int(noneCount)} 件。
      <a href={href(NO_TASK)} aria-current={current === NO_TASK ? 'true' : undefined} onclick={(e) => pick(e, NO_TASK)} data-testid="task-pick-none">{current === NO_TASK ? 'この絞り込みを外す' : 'そのセッションだけにする'}</a>
    </p>
  {/if}
</section>

<style>
  .nw {
    overflow-wrap: anywhere;
  }
  /* 数の欄の組のすぐ下に続ける(罫を二重にしない) */
  .fields.efforts {
    border-top: 0;
  }
  /* 狭い幅(2 列)では 3 つ目の欄を横に伸ばす(空欄を残さない。要点の枠と同じ考え方) */
  @media (max-width: 720px) {
    .task-fields .field:last-child:nth-child(odd) {
      grid-column: 1 / -1;
    }
  }
  .task-warn {
    margin: 0 0 8px;
    padding: 6px 10px;
    max-width: 75ch;
    font-size: 0.8125rem;
    color: var(--ink);
    background: var(--warn-wash);
    border: 1px solid var(--warn);
    overflow-wrap: anywhere;
  }
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
  .sub-h {
    margin: 16px 0 6px;
    font-size: 0.9375rem;
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
  .name {
    font-weight: normal;
    min-width: 13em;
    max-width: 28em;
    overflow-wrap: anywhere;
  }
  .link {
    display: inline-block;
    min-height: 24px;
    padding: 2px 0;
    color: var(--form);
  }
  .plain {
    display: inline-block;
    padding: 2px 0;
  }
  .part {
    display: block;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .part.id {
    font-family: var(--mono, ui-monospace, monospace);
  }
  tr.current .link {
    font-weight: 600;
  }
  tr.current th,
  tr.current td {
    background: var(--select);
  }
  .when {
    white-space: nowrap;
  }
  .status {
    min-width: 7em;
  }
  .status .tag {
    margin-top: 2px;
  }
  .src,
  .why {
    white-space: nowrap;
    font-size: 0.75rem;
  }
  .more {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 8px 0 0;
  }
  .more:empty {
    display: none;
  }
</style>
