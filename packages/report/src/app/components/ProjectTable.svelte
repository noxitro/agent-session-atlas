<script lang="ts">
  import type { Bucket } from '../../lib/aggregate.ts';
  import { dec, duration, int, pathParts } from '../../lib/format.ts';
  import { confidenceLabel } from '../../lib/judgment-labels.ts';
  import SortMark from './SortMark.svelte';

  let {
    rows,
    judged,
    current,
    onpick,
  }: { rows: Bucket[]; judged: boolean; current: string; onpick: (project: string) => void } = $props();

  type Key = 'label' | 'sessions' | 'input' | 'output' | 'tools' | 'lines' | 'skills' | 'agents' | 'hooks' | 'instructions' | 'wiki' | 'friction' | 'active' | 'human';
  const value: Record<Key, (b: Bucket) => number | string> = {
    label: (b) => b.label,
    sessions: (b) => b.sessions,
    input: (b) => b.tokens.input,
    output: (b) => b.tokens.output,
    tools: (b) => b.tools,
    lines: (b) => (b.sessionsWithLines ? b.linesAdded + b.linesRemoved : -1),
    skills: (b) => b.skills,
    agents: (b) => b.agents,
    hooks: (b) => b.hooks,
    instructions: (b) => b.sessionsWithInstructions,
    wiki: (b) => b.sessionsWithWiki,
    friction: (b) => b.friction,
    active: (b) => b.activeMedianMs ?? -1,
    human: (b) => b.humanHours,
  };
  let sortKey = $state<Key>('output');
  let asc = $state(false);
  let expanded = $state(false);
  const LIMIT = 15;

  const sorted = $derived.by(() => {
    const f = value[sortKey];
    const dir = asc ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      const c = typeof x === 'string' ? x.localeCompare(y as string, 'ja') : x - (y as number);
      return c * dir || a.key.localeCompare(b.key);
    });
  });
  const visible = $derived(expanded ? sorted : sorted.slice(0, LIMIT));

  function sortBy(k: Key): void {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = k === 'label';
    }
  }
  const cols: { key: Key; label: string; title?: string }[] = [
    { key: 'sessions', label: 'セッション' },
    { key: 'input', label: '入力トークン', title: '記録のあるセッションだけの合計' },
    { key: 'output', label: '出力トークン' },
    { key: 'tools', label: 'ツール' },
    { key: 'lines', label: '変更行', title: '追加 / 削除の行数。記録のあるセッションだけの合計' },
    { key: 'skills', label: 'skill' },
    { key: 'agents', label: 'agent' },
    { key: 'hooks', label: 'hook' },
    { key: 'instructions', label: '指示', title: '指示ファイルが注入されたセッション数' },
    { key: 'wiki', label: 'wiki', title: 'llm-wiki を参照したセッション数' },
    { key: 'friction', label: '摩擦' },
    { key: 'active', label: '実働(中央値)' },
  ];
  const ariaSort = (k: Key): 'ascending' | 'descending' | 'none' => (sortKey === k ? (asc ? 'ascending' : 'descending') : 'none');

  /** そのプロジェクトだけに絞った状態の URL(新しいタブでも開ける)。クリックは親に任せて他の条件を保つ */
  const projectHref = (key: string): string => `#project=${encodeURIComponent(key)}`;
  function pick(e: MouseEvent, key: string): void {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onpick(current === key ? '' : key);
  }
  /** 摩擦の内訳のうち多い順 3 つ(title だけに持たせるとキーボード・タッチで読めない) */
  function frictionNote(b: Bucket): string {
    const d = b.frictionDetail;
    const items: [string, number][] = [
      ['ツール失敗', d.toolFailures],
      ['compaction', d.compactions],
      ['中断', d.aborts],
      ['エラー', d.errors],
      ['権限確認', d.permissionRequests],
      ['ask_user', d.askUser],
      ['agent 失敗', d.subagentFailures],
    ];
    return items
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, n]) => `${k} ${int(n)}`)
      .join('・');
  }
</script>

<section class="section" id="projects" aria-labelledby="projects-h">
  <div class="section-head">
    <h2 id="projects-h">プロジェクト別</h2>
    <p>
      {int(rows.length)} プロジェクト。名前を押すとそのプロジェクトに絞り込みます(列見出しで並べ替え)。指示・wiki の列は「該当セッション数 / セッション数」。repository の記録が無いものは git の origin(owner/repo)で束ね、ホーム・一時フォルダ・atlas の判定実行はそれぞれ 1 つにまとめています。
    </p>
  </div>
  {#if rows.length === 0}
    <p class="note">該当するプロジェクトはありません。</p>
  {:else}
    <div class="table-scroll">
      <table class="ledger">
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort('label')}>
              <button type="button" class="sort" onclick={() => sortBy('label')}>プロジェクト<SortMark state={sortKey === 'label' ? (asc ? 'asc' : 'desc') : 'none'} /></button>
            </th>
            {#each cols as c}
              <th scope="col" class="num" aria-sort={ariaSort(c.key)} title={c.title}>
                <button type="button" class="sort" onclick={() => sortBy(c.key)}>{c.label}<SortMark state={sortKey === c.key ? (asc ? 'asc' : 'desc') : 'none'} /></button>
              </th>
            {/each}
            {#if judged}
              <th scope="col" class="num" aria-sort={ariaSort('human')}>
                <button type="button" class="sort" onclick={() => sortBy('human')}>推定人手工数<SortMark state={sortKey === 'human' ? (asc ? 'asc' : 'desc') : 'none'} /></button>
              </th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#each visible as b (b.key)}
            <tr class:current={current === b.key}>
              <th scope="row" class="proj">
                <a class="link" href={projectHref(b.key)} aria-current={current === b.key ? 'true' : undefined} onclick={(e) => pick(e, b.key)}>{#each pathParts(b.label) as seg, i (i)}{#if i}<wbr />{/if}{seg}{/each}</a>
                {#if current === b.key}<span class="part">絞り込み中(もう一度押すと解除)</span>{/if}
              </th>
              <td class="num">{int(b.sessions)}</td>
              <td class="num">
                {#if b.sessionsWithInput === 0}<span class="missing-value">記録なし</span>{:else}{int(b.tokens.input)}{#if b.sessionsWithInput < b.sessions}<span class="part" title="記録のあるセッション数 / 全セッション数">{b.sessionsWithInput}/{b.sessions}</span>{/if}{/if}
              </td>
              <td class="num">{int(b.tokens.output)}</td>
              <td class="num">{int(b.tools)}</td>
              <td class="num">
                {#if b.sessionsWithLines === 0}<span class="missing-value">記録なし</span>{:else}+{int(b.linesAdded)}<span class="part">−{int(b.linesRemoved)}{#if b.sessionsWithLines < b.sessions}・{b.sessionsWithLines}/{b.sessions}{/if}</span>{/if}
              </td>
              <td class="num">{int(b.skills)}</td>
              <td class="num">{int(b.agents)}{#if b.agentFailures}<span class="part" title="失敗">失敗{b.agentFailures}</span>{/if}</td>
              <td class="num">{int(b.hooks)}</td>
              <td class="num">{int(b.sessionsWithInstructions)}/{int(b.sessions)}</td>
              <td class="num">{int(b.sessionsWithWiki)}/{int(b.sessions)}</td>
              <td class="num">{int(b.friction)}{#if b.friction > 0}<span class="part">{frictionNote(b)}</span>{/if}</td>
              <td class="num">{duration(b.activeMedianMs, '—')}</td>
              {#if judged}
                <td class="num" title={b.judgedSessions ? `LLM による推定。判定済み ${b.judgedSessions} / ${b.sessions} セッション、幅 ${dec(b.humanLow)}〜${dec(b.humanHigh)} 時間` : ''}>
                  {#if b.judgedSessions}{dec(b.humanHours)} 時間<span class="part">{b.judgedSessions}/{b.sessions}・{confidenceLabel(b.judgedConfidence)}</span>{:else}<span class="missing-value">未判定</span>{/if}
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if rows.length > LIMIT}
      <p class="more">
        <button type="button" class="btn" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
          {expanded ? `上位 ${LIMIT} 件だけ表示` : `残り ${int(rows.length - LIMIT)} 件も表示`}
        </button>
      </p>
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
  .proj {
    font-weight: normal;
    min-width: 13em;
    max-width: 28em;
  }
  .link {
    display: inline-block;
    min-height: 24px;
    padding: 2px 0;
    color: var(--form);
    overflow-wrap: anywhere;
  }
  tr.current .link {
    font-weight: 600;
  }
  tr.current th,
  tr.current td {
    background: var(--select);
  }
  .part {
    display: block;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .more {
    margin: 8px 0 0;
  }
</style>
