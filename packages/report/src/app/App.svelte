<script lang="ts">
  import { aggregate } from '../lib/aggregate.ts';
  import { applyFilter, decodeFilter, decodeView, emptyFilter, encodeFilter, filterOptions, inScope, isEmptyFilter, isStateHash, type FilterState } from '../lib/filter.ts';
  import { highlights } from '../lib/highlights.ts';
  import { date, dateTime, int } from '../lib/format.ts';
  import type { ReportData } from '../lib/types.ts';
  import FilterBar from './components/FilterBar.svelte';
  import Overview from './components/Overview.svelte';
  import JudgmentPanel from './components/JudgmentPanel.svelte';
  import ProjectTable from './components/ProjectTable.svelte';
  import UsageRanking from './components/UsageRanking.svelte';
  import Highlights from './components/Highlights.svelte';
  import ExecProfile from './components/ExecProfile.svelte';
  import MonthlyChart from './components/MonthlyChart.svelte';
  import ModelChart from './components/ModelChart.svelte';
  import SessionTable from './components/SessionTable.svelte';
  import Glossary from './components/Glossary.svelte';
  import { applyTheme, loadTheme, type ThemeChoice } from './theme.ts';

  let { data, error }: { data: ReportData | null; error: string | null } = $props();

  const sessions = $derived(data?.sessions ?? []);
  const emptyCount = $derived(sessions.filter((s) => s.empty).length);
  const judged = $derived(!!data?.judgments.available);

  function initialFilter(): FilterState {
    try {
      return location.hash.length > 1 ? decodeFilter(location.hash) : emptyFilter();
    } catch {
      return emptyFilter();
    }
  }

  let filter = $state<FilterState>(initialFilter());
  // 開いたときの表示の指定(#…&view=unused-skills)。絞り込みの $effect が URL を書き換える前に読んでおく
  const initialView = ((): string | null => {
    try {
      return decodeView(location.hash);
    } catch {
      return null;
    }
  })();
  // 空のセッションを含めるかどうかで母集団が変わる(選択肢の件数・「全 N セッション」もこの範囲で数える)
  const scoped = $derived(sessions.filter((s) => inScope(s, filter)));
  const options = $derived(filterOptions(scoped));
  const filtered = $derived(applyFilter(sessions, filter));
  const agg = $derived(aggregate(filtered));
  const all = $derived(aggregate(sessions));
  const points = $derived(highlights(filtered, agg.usage, { filter, anonymized: !!data?.anonymized, installed: data?.installed ?? null }));
  /** 利用ランキングの表示中の種類(要点欄の「未使用の skill」から skill に切り替える) */
  let usageTab = $state<'tools' | 'mcp' | 'skills' | 'agents' | 'hooks' | 'instructions'>('tools');

  /** URL ハッシュの表示の指定(view=…)に従ってその場所へ移る */
  function showView(view: string | null): void {
    if (view === 'unused-skills') {
      usageTab = 'skills';
      requestAnimationFrame(() => {
        const el = document.getElementById('unused-skills');
        el?.scrollIntoView({ block: 'start' });
        el?.focus({ preventScroll: true });
      });
    } else if (view === 'sessions') {
      requestAnimationFrame(() => document.getElementById('sessions')?.scrollIntoView({ block: 'start' }));
    }
  }

  // 要点欄などの #… リンク(絞り込みの状態)を押したときに絞り込みを切り替える。#overview のようなページ内リンクは無視
  $effect(() => {
    const onHash = (): void => {
      if (!isStateHash(location.hash)) return;
      filter = decodeFilter(location.hash);
      showView(decodeView(location.hash) ?? 'sessions');
    };
    window.addEventListener('hashchange', onHash);
    if (initialView) showView(initialView);
    return () => window.removeEventListener('hashchange', onHash);
  });

  $effect(() => {
    const h = encodeFilter(filter);
    try {
      history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
    } catch {
      /* file:// で履歴を書けない環境では URL に残さないだけ */
    }
  });

  let theme = $state<ThemeChoice>(loadTheme());
  function setTheme(t: ThemeChoice): void {
    theme = t;
    applyTheme(t);
  }

  function setFilter(patch: Partial<FilterState>): void {
    filter = { ...filter, ...patch };
  }
  function reset(): void {
    filter = emptyFilter();
  }

  const scopeNotes = $derived.by(() => {
    if (!data) return [];
    const s = data.scope;
    const notes: string[] = [];
    if (s.since) notes.push(`${s.since} 以降`);
    if (s.project) notes.push(`プロジェクト ${s.project}`);
    if (s.client) notes.push(`クライアント ${s.client}`);
    if (s.model) notes.push(`モデル ${s.model}`);
    if (s.branch) notes.push(`ブランチ ${s.branch}`);
    return notes;
  });
</script>

{#if !data}
  <main class="wrap error-page">
    <h1>Copilot Session Atlas</h1>
    <p role="alert" class="error-box">{error ?? 'データを読めませんでした。'}</p>
  </main>
{:else}
  <a class="skip" href="#main">本文へ移動</a>
  <header class="masthead">
    <div class="wrap mast-row">
      <div class="mast-title">
        <h1>Copilot Session Atlas</h1>
        <p class="mast-sub">
          GitHub Copilot のセッションログの集計。生成 {dateTime(data.generatedAt)}・記録期間 {date(all.overall.firstAt)}〜{date(all.overall.lastAt)}・全 {int(sessions.length)} セッション(うち空のセッション {int(emptyCount)} 件)
        </p>
      </div>
      <div class="mast-tools">
        {#if data.anonymized}<span class="tag">伏せ字モード</span>{/if}
        {#if scopeNotes.length}<span class="tag" title="atlas build の実行時に絞り込んだ条件">出力時の絞り込み: {scopeNotes.join('、')}</span>{/if}
        <div class="seg" role="group" aria-label="配色">
          {#each [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']] as [v, label]}
            <button type="button" aria-pressed={theme === v} onclick={() => setTheme(v as ThemeChoice)}>{label}</button>
          {/each}
        </div>
      </div>
    </div>
    <nav class="wrap toc" aria-label="ページ内の移動">
      <a href="#overview">全体</a>
      {#if judged}<a href="#judgments">AI 投入量 vs 推定人手工数</a>{/if}
      <a href="#highlights">要点</a>
      <a href="#usage">利用ランキング</a>
      <a href="#exec">実行の性質</a>
      <a href="#projects">プロジェクト別</a>
      <a href="#monthly">月別推移</a>
      <a href="#models">モデル別</a>
      <a href="#sessions">セッション一覧</a>
      <a href="#glossary">用語の説明</a>
    </nav>
  </header>

  <FilterBar
    {filter}
    {options}
    {judged}
    shown={filtered.length}
    total={scoped.length}
    {emptyCount}
    lastDay={all.overall.lastAt ? date(all.overall.lastAt) : null}
    onchange={setFilter}
    onreset={reset}
  />

  <main class="wrap" id="main" tabindex="-1">
    {#if filtered.length === 0}
      <div class="empty" role="status">
        <p>この条件に合うセッションはありません。</p>
        <button type="button" class="btn" onclick={reset}>絞り込みを解除</button>
      </div>
    {/if}

    <Overview {agg} {judged} anonymized={data.anonymized} warnings={data.warnings} filtered={!isEmptyFilter(filter)} includeEmpty={filter.empty === '1'} {emptyCount} />
    <Highlights groups={points} />
    {#if judged}<JudgmentPanel {agg} meta={data.judgments} />{/if}
    <UsageRanking usage={agg.usage} installed={data.installed ?? null} bind:tab={usageTab} />
    <ExecProfile exec={agg.exec} sessions={filtered.length} />
    <ProjectTable rows={agg.byProject} {judged} current={filter.project} onpick={(p) => setFilter({ project: p })} />
    <MonthlyChart months={agg.byMonth} />
    <ModelChart rows={agg.byModel} />
    <SessionTable sessions={filtered} {judged} anonymized={data.anonymized} />
    <Glossary />

    <footer class="foot">
      <p>
        このレポートはローカルのログ(~/.copilot)を複製して集計したもので、LLM は使っていません。入力トークン・AI 使用量(AIU)・premium request・変更行数は記録が残っているセッションだけの合計です。
        {#if data.warnings.unknownEventTypes > 0 || data.warnings.badLines > 0}
          読み取り時の注意: 未知のイベント種別 {int(data.warnings.unknownEventTypes)} 件、読めなかった行 {int(data.warnings.badLines)} 行。
        {/if}
      </p>
    </footer>
  </main>
{/if}

<style>
  .masthead {
    background: var(--surface);
    border-bottom: 1px solid var(--rule-strong);
  }
  .mast-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 12px 24px;
    flex-wrap: wrap;
    padding-top: 16px;
    padding-bottom: 10px;
  }
  .mast-sub {
    margin: 2px 0 0;
    color: var(--ink-2);
    font-size: 0.8125rem;
  }
  .mast-tools {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .toc {
    display: flex;
    gap: 4px 18px;
    flex-wrap: wrap;
    padding-bottom: 8px;
    font-size: 0.8125rem;
  }
  .toc a {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    text-decoration: none;
    color: var(--ink-2);
  }
  .toc a:hover {
    color: var(--form);
    text-decoration: underline;
  }
  .skip {
    position: absolute;
    left: 8px;
    top: -100px;
    z-index: 20;
    padding: 6px 12px;
    background: var(--form);
    color: var(--surface);
  }
  .skip:focus {
    top: 8px;
  }
  main:focus {
    outline: none;
  }
  .empty {
    margin-top: 20px;
    padding: 16px;
    background: var(--warn-wash);
    border: 1px solid var(--warn);
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
  }
  .empty p {
    margin: 0;
  }
  .error-page {
    padding-top: 40px;
  }
  .error-box {
    margin-top: 16px;
    padding: 12px 16px;
    border: 1px solid var(--warn);
    background: var(--warn-wash);
    max-width: 75ch;
  }
  .foot {
    margin: 40px 0 32px;
    color: var(--ink-3);
    font-size: 0.75rem;
    max-width: 90ch;
  }
  :global(.btn) {
    font: inherit;
    font-size: 0.8125rem;
    padding: 4px 12px;
    border: 1px solid var(--form);
    background: var(--surface);
    color: var(--form);
    cursor: pointer;
  }
  :global(.btn:hover) {
    background: var(--form-wash);
  }
  :global(.btn:disabled) {
    border-color: var(--rule);
    color: var(--ink-3);
    cursor: not-allowed;
    background: var(--surface);
  }
</style>
