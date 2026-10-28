<script lang="ts">
  import type { Bucket } from '../../lib/aggregate.ts';
  import { dec, duration, int } from '../../lib/format.ts';
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
</script>

<section class="section" id="projects" aria-labelledby="projects-h">
  <div class="section-head">
    <h2 id="projects-h">プロジェクト別</h2>
    <p>
      {int(rows.length)} プロジェクト。名前を押すとそのプロジェクトに絞り込みます。列見出しで並べ替え。repository の記録が無いものは git の origin(owner/repo)で束ね、ホームディレクトリ・一時フォルダ・atlas の判定実行はそれぞれ 1 つにまとめています。
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
                <button type="button" class="link" title={b.key} aria-pressed={current === b.key} onclick={() => onpick(current === b.key ? '' : b.key)}>{b.label}</button>
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
              <td class="num">{b.sessionsWithInstructions ? `${b.sessionsWithInstructions}/${b.sessions}` : 'なし'}</td>
              <td class="num">{b.sessionsWithWiki ? `${b.sessionsWithWiki}/${b.sessions}` : 'なし'}</td>
              <td class="num" title="compaction {b.frictionDetail.compactions}・中断 {b.frictionDetail.aborts}・エラー {b.frictionDetail.errors}・権限確認 {b.frictionDetail.permissionRequests}・ask_user {b.frictionDetail.askUser}・ツール失敗 {b.frictionDetail.toolFailures}・agent 失敗 {b.frictionDetail.subagentFailures}">{int(b.friction)}</td>
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
    min-width: 11em;
    max-width: 28em;
  }
  .link {
    display: inline-block;
    min-height: 24px;
    padding: 2px 0;
    font: inherit;
    background: none;
    border: 0;
    padding: 0;
    color: var(--form);
    cursor: pointer;
    text-align: left;
    overflow-wrap: anywhere;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  tr.current th,
  tr.current td {
    background: var(--select);
  }
  .part {
    display: block;
    font-size: 0.6875rem;
    color: var(--ink-3);
  }
  .more {
    margin: 8px 0 0;
  }
</style>
