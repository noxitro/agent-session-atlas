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

  /** 効いている絞り込みの条件の数(期間は開始・終了で 1 つ) */
  const activeConditions = $derived.by(() => {
    let n = filter.from || filter.to ? 1 : 0;
    for (const k of ['project', 'client', 'model', 'branch', 'coverage', 'taskCategory', 'tool'] as const) if (filter[k]) n++;
    if (filter.empty === '1') n++;
    return n;
  });

  /** 目次の 1 項目。id はページ内の節、href は別ページ */
  type TocItem = { id: string; label: string; href?: undefined } | { href: string; label: string; id?: undefined };
  /** 節の目次。広い画面(1280px 以上)では左のサイドバー、狭い画面では上部の固定した 1 行。群で区切る(別ページは href) */
  const tocGroups = $derived.by((): { title: string; items: TocItem[] }[] => [
    {
      title: '概況',
      items: [
        { id: 'overview', label: '全体' },
        { id: 'highlights', label: '要点' },
        { id: 'detail', label: '集計明細' },
        ...(judged ? [{ id: 'judgments', label: 'AI 投入量 vs 推定人手工数' }] : []),
      ],
    },
    {
      title: '内訳',
      items: [
        { id: 'usage', label: '利用ランキング' },
        { id: 'exec', label: '実行の性質' },
        { id: 'projects', label: 'プロジェクト別' },
        { id: 'monthly', label: '月別推移' },
        { id: 'models', label: 'モデル別' },
      ],
    },
    { title: '一覧', items: [{ id: 'sessions', label: 'セッション一覧' }] },
    { title: '付録', items: [{ href: 'glossary.html', label: '用語の説明' }] },
  ]);

  /** 読んでいる節(目次の現在地の印)。見出しが画面上部 1/3(固定行の下)を越えた最後の節 */
  let current = $state('overview');
  /** 目次と件数の帯の高さ。狭い画面では上部に固定するので、ページ内リンクの飛び先をこの分だけ下げる(--topbar-h) */
  let railHeight = $state(0);
  let topbarPx = 0;
  let railEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const wide = matchMedia('(min-width: 1280px)');
    const h = railHeight;
    const apply = (): void => {
      topbarPx = wide.matches ? 0 : h;
      document.documentElement.style.setProperty('--topbar-h', `${topbarPx}px`);
    };
    apply();
    wide.addEventListener('change', apply);
    return () => wide.removeEventListener('change', apply);
  });
  $effect(() => {
    const ids = tocGroups.flatMap((g) => g.items).map((i) => i.id).filter((id): id is string => !!id);
    let tick = false;
    const mark = (): void => {
      tick = false;
      const line = topbarPx + Math.min(160, window.innerHeight / 3);
      let cur = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) cur = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) cur = ids[ids.length - 1];
      current = cur;
    };
    const onScroll = (): void => {
      if (!tick) {
        tick = true;
        requestAnimationFrame(mark);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    mark();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  });
  // 狭い画面の目次行は横に流れるので、現在地の項目が見える位置まで行をずらす(ページは動かさない)
  $effect(() => {
    void current;
    const a = railEl?.querySelector<HTMLElement>('.toc a[aria-current]');
    const ol = a?.closest<HTMLElement>('.toc');
    if (!a || !ol || ol.scrollWidth <= ol.clientWidth) return;
    const l = a.offsetLeft;
    const r = l + a.offsetWidth;
    if (l < ol.scrollLeft) ol.scrollLeft = l - 12;
    else if (r > ol.scrollLeft + ol.clientWidth) ol.scrollLeft = r - ol.clientWidth + 12;
  });
  // 詳細・用語ページの「← 戻る」が history.back() で絞り込みを保てるよう、このページから別ページへ移るときに印を残す(file:// では referrer が無い)
  $effect(() => {
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a || a.getAttribute('href')?.startsWith('#')) return;
      try {
        sessionStorage.setItem('atlas-return', '1');
      } catch {
        /* 保存できない環境では普通のリンクとして戻る */
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  });

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
          GitHub Copilot のセッションログの集計(LLM は使っていません)。生成 {dateTime(data.generatedAt)}・記録期間 {date(all.overall.firstAt)}〜{date(all.overall.lastAt)}。
          {#if filter.empty === '1'}記録 {int(sessions.length)} 件すべてを集計対象にしています(うち空のセッション {int(emptyCount)} 件)。{:else}記録 {int(sessions.length)} 件のうち {int(scoped.length)} 件を集計対象にしています(空のセッション {int(emptyCount)} 件を除外)。{/if}
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
  </header>

  <div class="shell">
    <div class="rail" bind:this={railEl} bind:offsetHeight={railHeight}>
      <div class="rail-in wrap">
        <nav class="toc" aria-label="ページ内の移動">
          {#each tocGroups as g (g.title)}
            <div class="toc-group" role="group" aria-label={g.title}>
              <span class="toc-title" aria-hidden="true">{g.title}</span>
              <ol>
                {#each g.items as it (it.label)}
                  <li><a href={it.href ?? `#${it.id}`} aria-current={it.id && current === it.id ? 'true' : undefined}>{it.label}</a></li>
                {/each}
              </ol>
            </div>
          {/each}
        </nav>
        <div class="status">
          <p class="count" aria-live="polite" aria-atomic="true">
            <span class="w">表示中</span> <strong data-testid="shown-count">{int(filtered.length)}</strong> / <span class="w">集計対象</span> {int(scoped.length)} <span class="w">セッション</span><span class="u" aria-hidden="true">件</span>
          </p>
          <p class="active" class:on={activeConditions > 0}>
            {#if activeConditions > 0}<span class="badge">{activeConditions}</span> <span class="w">条件で絞り込み中</span><span class="sr-only">条件で絞り込み中</span>{/if}
          </p>
          <button type="button" class="btn" disabled={isEmptyFilter(filter)} onclick={reset}>解除</button>
        </div>
      </div>
    </div>

    <div class="content">
      <FilterBar {filter} {options} {judged} {emptyCount} lastDay={all.overall.lastAt ? date(all.overall.lastAt) : null} onchange={setFilter} />

      <main class="wrap" id="main" tabindex="-1">
        <div class="empty" class:show={filtered.length === 0} role="status">
          {#if filtered.length === 0}
            <p>この条件に合うセッションはありません。</p>
            <button type="button" class="btn" onclick={reset}>絞り込みを解除</button>
          {/if}
        </div>

        <!-- 帳票の順: 表紙(規模の 4 欄)→ 摘要(要点)→ 明細 -->
        <Overview part="cover" {agg} {judged} anonymized={data.anonymized} warnings={data.warnings} filtered={!isEmptyFilter(filter)} includeEmpty={filter.empty === '1'} {emptyCount} />
        <Highlights groups={points} />
        <Overview part="detail" {agg} {judged} anonymized={data.anonymized} warnings={data.warnings} filtered={!isEmptyFilter(filter)} includeEmpty={filter.empty === '1'} {emptyCount} />
        {#if judged}<JudgmentPanel {agg} meta={data.judgments} />{/if}
        <UsageRanking usage={agg.usage} installed={data.installed ?? null} bind:tab={usageTab} />
        <ExecProfile exec={agg.exec} sessions={filtered.length} />
        <ProjectTable rows={agg.byProject} {judged} current={filter.project} onpick={(p) => setFilter({ project: p })} />
        <MonthlyChart months={agg.byMonth} />
        <ModelChart rows={agg.byModel} />
        <SessionTable sessions={filtered} {judged} anonymized={data.anonymized} />
      </main>
      <footer class="wrap foot">
        <p>
          このレポートはローカルのログ(~/.copilot)を複製して集計したもので、LLM は使っていません。入力トークン・AI 使用量(AIU)・premium request・変更行数は記録が残っているセッションだけの合計です。
          {#if data.warnings.unknownEventTypes > 0 || data.warnings.badLines > 0}
            読み取り時の注意: 未知のイベント種別 {int(data.warnings.unknownEventTypes)} 件、読めなかった行 {int(data.warnings.badLines)} 行。
          {/if}
        </p>
      </footer>
    </div>
  </div>
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
    max-width: 80ch;
  }
  .mast-tools {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  /* 件数と解除(目次の帯の中。帯そのものの見た目は base.css の .rail / .toc) */
  .status {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }
  .status p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    white-space: nowrap;
  }
  .status strong {
    font-size: 1.0625rem;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .status .active {
    display: none;
  }
  .status .active.on {
    display: block;
  }
  .status .badge {
    display: inline-block;
    padding: 0 5px;
    background: var(--form);
    color: var(--surface);
    font-size: 0.6875rem;
    line-height: 1.5;
  }
  .status .btn {
    padding: 2px 10px;
  }
  .status .u {
    display: none;
  }
  @media (max-width: 720px) {
    .status .w {
      display: none;
    }
    .status .u {
      display: inline;
    }
  }
  @media (min-width: 1280px) {
    /* マストヘッドの幅をサイドバー + 本文(.shell)に揃える */
    .mast-row {
      max-width: calc(1360px + 13em + 32px);
    }
    .status {
      display: block;
      margin: 20px 0 0;
      padding-top: 10px;
      border-top: 1px solid var(--rule-strong);
    }
    .status p {
      white-space: normal;
    }
    .status strong {
      display: block;
      font-size: 1.375rem;
      line-height: 1.25;
    }
    .status .active.on {
      margin-top: 6px;
    }
    .status .btn {
      margin-top: 10px;
      padding: 4px 12px;
    }
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
    display: none;
  }
  .empty.show {
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
    margin: 40px auto 32px;
    color: var(--ink-3);
    font-size: 0.75rem;
  }
  .foot p {
    max-width: 90ch;
    margin: 0;
  }
  .mast-tools .seg button {
    padding: 2px 8px;
  }
</style>
