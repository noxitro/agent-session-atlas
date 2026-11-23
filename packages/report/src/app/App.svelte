<script lang="ts">
  import { aggregate } from '../lib/aggregate.ts';
  import { turnAggregate } from '../lib/turns.ts';
  import { verdictAggregate } from '../lib/verdicts.ts';
  import { wikiReferenced, wikiState } from '../lib/wiki.ts';
  import { flushSync, tick, untrack } from 'svelte';
  import { applyFilter, decodeFilter, decodeTab, decodeView, DEFAULT_TAB, emptyFilter, encodeFilter, encodeState, filterHref, filterOptions, inScope, isEmptyFilter, isStateHash, isTabId, joinIds, knownSelection, taskOf, taskOptions, type FilterState, type TabId } from '../lib/filter.ts';
  import { highlights } from '../lib/highlights.ts';
  import { date, dateTime, int } from '../lib/format.ts';
  import { WIKI_PAGES_DATA_VERSION, type ReportData, type TasksReport } from '../lib/types.ts';
  import FilterBar from './components/FilterBar.svelte';
  import Overview from './components/Overview.svelte';
  import JudgmentPanel from './components/JudgmentPanel.svelte';
  import Retention from './components/Retention.svelte';
  import Compare from './components/Compare.svelte';
  import ProjectTable from './components/ProjectTable.svelte';
  import UsageRanking from './components/UsageRanking.svelte';
  import Highlights from './components/Highlights.svelte';
  import Insights from './components/Insights.svelte';
  import ExecProfile from './components/ExecProfile.svelte';
  import TurnPhases from './components/TurnPhases.svelte';
  import MonthlyChart from './components/MonthlyChart.svelte';
  import ModelChart from './components/ModelChart.svelte';
  import ModelValue from './components/ModelValue.svelte';
  import SessionTable from './components/SessionTable.svelte';
  import TaskPanel from './components/TaskPanel.svelte';
  import { applyTheme, loadTheme, type ThemeChoice } from './theme.ts';
  import { watchScrollFocus } from './scroll-focus.ts';
  import { STALE_MESSAGE } from '../lib/code-check.ts';
  import { api, foldersApi, serveToken, startHeartbeat, tasksApi, type TasksPayload, type UploadHandlers, type UploadSetting } from './api.ts';
  import { currentView, restoreDone, restoredView, saveView } from './view-restore.ts';
  import { JobStore } from './jobs.svelte.ts';
  import JobActions from './components/JobActions.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import OpenFolder from './components/OpenFolder.svelte';
  import JobBand from './components/JobBand.svelte';
  import type { MemoSummary } from '../lib/memo.ts';

  let { data, error }: { data: ReportData | null; error: string | null } = $props();

  /** API から読んだメモ(編集モードではこちらを使う。ビルド後に書いたメモも一覧に出る) */
  let liveMemos = $state<Record<string, MemoSummary> | null>(null);
  const sessions = $derived.by(() => {
    const list = data?.sessions ?? [];
    const memos = liveMemos;
    return memos ? list.map((s) => ({ ...s, memo: memos[s.id] ?? null })) : list;
  });
  /** llm-wiki の参照を数えた集計か。絞り込みで変わらないよう、絞り込み前の全セッションと vault の数で 1 度だけ決める(lib/wiki.ts) */
  const wiki = $derived(wikiState(data?.sessions ?? [], data?.wikiVaults));
  const memoCount = $derived(sessions.filter((s) => s.memo).length);
  const wikiCount = $derived(sessions.filter((s) => wikiReferenced(s.wiki)).length);
  const emptyCount = $derived(sessions.filter((s) => s.empty).length);
  const judged = $derived(!!data?.judgments.available);
  /**
   * 管理ツールのタスク。serve から開いた画面は API から読んだもの(詳細ページで直した紐づけも出る)、ほかは埋め込み。
   * 値はすべて集計(Rust)が決めたもので、ここでは数え直さない。紐づけは絞り込み(filter.task)と一覧の 1 行に使う
   */
  let liveTasks = $state<TasksPayload | null>(null);
  // 絞り込んだセッション(--task など)だけで作ったレポートは、絞り込まない API の値で置き換えない(埋め込みのまま)
  const tasks = $derived<TasksReport | null>(liveTasks && !data?.tasks?.scoped ? liveTasks.tasks : (data?.tasks ?? null));
  const taskMap = $derived(taskOf(tasks?.links));
  const taskNames = $derived(new Map((tasks?.items ?? []).map((t) => [t.id, t.name || t.id])));

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
  const filtered = $derived.by(() => applyFilter(sessions, filter, taskMap));
  /** タスクの絞り込みの選択肢(集計対象の範囲で数える) */
  const taskOpts = $derived(tasks ? taskOptions(scoped, taskMap, taskNames) : null);
  const agg = $derived(aggregate(filtered, options.person.length > 0));
  const turnAgg = $derived(turnAggregate(filtered));
  const verdictAgg = $derived(data?.turnJudgments?.available ? verdictAggregate(filtered, data.turnJudgments.phases) : null);
  const all = $derived(aggregate(sessions));
  // インストール済みの skill: 人に絞っていれば、その人が添えた記録(無ければ全員分)
  const installed = $derived((filter.person && data?.installedByPerson?.[filter.person]) || (data?.installed ?? null));
  const points = $derived(highlights(filtered, agg.usage, { filter, installed }));
  /** 利用ランキングの表示中の種類(要点欄の「未使用の skill」から skill に切り替える) */
  let usageTab = $state<'tools' | 'mcp' | 'causes' | 'skills' | 'agents' | 'hooks' | 'instructions'>('tools');

  /**
   * 本文のタブ(概況・内訳・一覧。目次の群と同じ)。どのタブの節も描いておき、ほかのタブは hidden で隠す
   * (ページ内リンクの行き先を getElementById で引ける。印刷では全部出す)。
   * 開いたときは URL の tab=…(無ければ概況)。ページ内リンク(#phases など)の行き先が別のタブにあれば、描いた後でそのタブに移る
   */
  let tab = $state<TabId>(
    ((): TabId => {
      try {
        return decodeTab(location.hash) ?? DEFAULT_TAB;
      } catch {
        return DEFAULT_TAB;
      }
    })(),
  );
  /** 要素が入っているタブ(タブの外の要素や null なら null) */
  function panelOf(el: Element | null): TabId | null {
    const v = el?.closest<HTMLElement>('[data-tab-panel]')?.dataset.tabPanel;
    return isTabId(v) ? v : null;
  }
  /** ページ内リンクのハッシュ(#phases)の行き先。空や、絞り込み・タブ・表示の指定(a=b を含む)なら null */
  function anchorTarget(hash: string): HTMLElement | null {
    const frag = hash.replace(/^#/, '');
    if (!frag || isStateHash(frag)) return null;
    let id = frag;
    try {
      id = decodeURIComponent(frag);
    } catch {
      /* そのまま */
    }
    return document.getElementById(id);
  }
  /** 表示の指定(view=…)の行き先と、タブを決めるのに使う節(未使用の skill は種類を切り替えてから描かれるので、利用ランキングの節で決める) */
  const VIEWS: Record<string, { target: string; section: string }> = {
    'unused-skills': { target: 'unused-skills', section: 'usage' },
    sessions: { target: 'sessions', section: 'sessions' },
  };
  /** 今の URL が指すタブ(戻る / 進むで移った先に合わせる) */
  function tabOfLocation(): TabId {
    const h = location.hash;
    if (h.length <= 1) return DEFAULT_TAB;
    // ページ内リンク: 行き先のタブ(#main のようにタブの外なら今のまま)
    if (!isStateHash(h)) return panelOf(anchorTarget(h)) ?? tab;
    const v = VIEWS[decodeView(h) ?? ''];
    return (v ? panelOf(document.getElementById(v.section)) : null) ?? decodeTab(h) ?? DEFAULT_TAB;
  }

  /** URL ハッシュの表示の指定(view=…)に従って、その場所のタブを出してから移る */
  function showView(view: string | null): void {
    const v = VIEWS[view ?? ''];
    if (!v) return;
    if (view === 'unused-skills') usageTab = 'skills';
    const p = panelOf(document.getElementById(v.section));
    if (p) tab = p;
    requestAnimationFrame(() => {
      const el = document.getElementById(v.target);
      el?.scrollIntoView({ block: 'start' });
      if (view === 'unused-skills') el?.focus({ preventScroll: true });
    });
  }

  /**
   * 今の URL が指す絞り込みとタブ。絞り込みは、# が空なら無し、絞り込み・タブ・表示の指定のハッシュならその中身、
   * ページ内リンク(#phases)なら null(今の絞り込みのまま。ページ内リンクの URL は絞り込みを持たない)
   */
  function stateOfLocation(): { filter: FilterState | null; tab: TabId } {
    const h = location.hash;
    if (h.length <= 1) return { filter: emptyFilter(), tab: DEFAULT_TAB };
    if (!isStateHash(h)) return { filter: null, tab: tabOfLocation() };
    return { filter: decodeFilter(h), tab: tabOfLocation() };
  }

  /** 今の絞り込みとタブを URL に書く(履歴には積まない。history.state(戻ったときの見た目。view-restore.ts)は消さずに URL だけ変える) */
  function writeStateUrl(): void {
    const h = encodeState(filter, tab);
    try {
      history.replaceState(history.state, '', h ? `#${h}` : location.pathname + location.search);
    } catch {
      /* file:// で履歴を書けない環境では URL に残さないだけ */
    }
  }

  /** 今のスクロール位置を今の履歴の項目に書く(戻る / 進むでタブが変わったときに、その位置へ戻すため。スクロール中は止まってから書く) */
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveScroll(): void {
    clearTimeout(saveTimer);
    saveView({ y: window.scrollY });
  }
  /**
   * 戻る / 進むで描き直して位置を戻している間(この時刻まで)は、スクロールの位置を書かない(この時刻を過ぎてから 1 回だけ書く)。
   * 描き直しの途中の位置(上の節の高さが変わってブラウザがずらした位置)を、移った先の項目に残さないため
   */
  let settleUntil = 0;

  // 要点欄などの #… リンク(絞り込みの状態)を押したときに絞り込みを切り替える。
  // #overview のようなページ内リンクは、行き先が隠れたタブにあるときだけそのタブに移る
  $effect(() => {
    const onHash = (): void => {
      const h = location.hash;
      // 戻る / 進むで # の無い URL(絞り込みの無い状態は # を書かない)に戻ったら、絞り込みも外す(タブは概況)。
      // 以前は読み飛ばしていたので、要点のリンクで絞り込んでから「戻る」を押しても絞り込みが残っていた
      if (h.length <= 1) {
        if (!isEmptyFilter(filter)) filter = emptyFilter();
        tab = DEFAULT_TAB;
        return;
      }
      if (!isStateHash(h)) {
        // ふつうは押したとき(下の click)か popstate で移り終えている。popstate を出さないブラウザや、URL を手で書き換えたときのため
        const el = anchorTarget(h);
        const p = panelOf(el);
        if (el && p && p !== tab) {
          tab = p;
          void tick().then(() => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
        }
        return;
      }
      // 戻る / 進むでは popstate で同じ絞り込みにしてある。同じなら置き換えない(描き直すと、戻した位置が上の節の高さの変化でずれる)
      const f = decodeFilter(h);
      if (encodeFilter(f) !== encodeFilter(filter)) filter = f;
      // 表示の指定があればその場所(のタブ)へ。無ければ tab=… のタブ(戻る / 進むで移った先。位置はブラウザと popstate が戻す)
      const view = decodeView(h);
      if (view) {
        showView(view);
        // 表示の指定は 1 回だけ効かせるもので、URL には残さない(絞り込みとタブだけにする)。絞り込みが変わらなければ上の
        // 書き換えの effect は動かないので、ここで書き換える。残すと、戻る / 進むでこの項目に来るたびにその場所へ飛び直す
        writeStateUrl();
      } else tab = decodeTab(h) ?? DEFAULT_TAB;
    };
    // 戻る / 進む: 移った先の絞り込みとタブを両方ここで当てて描き直してから(flushSync)、位置を戻す。
    // popstate → ブラウザが位置を戻す → hashchange の順に来るので、絞り込みを hashchange まで待つと、
    // 戻した後で上の節の高さが変わり(絞り込みを外すと要点などが伸びる)、ブラウザのスクロールの固定(scroll anchoring)で位置がずれる。
    // その項目に残した位置(saveScroll)があれば自分でも戻す。ブラウザが覚えた位置は、別のタブの節へのリンクを押したとき、
    // タブを切り替えた後(ページの長さが変わった後)の位置になっていることがあるので、ブラウザが戻した後(次の描画の前)にもう一度合わせる
    const onPop = (): void => {
      clearTimeout(saveTimer); // 前の項目の位置を、移った先の項目に書かない
      const next = stateOfLocation();
      const tabChanged = next.tab !== tab;
      const filterChanged = next.filter != null && encodeFilter(next.filter) !== encodeFilter(filter);
      if (!tabChanged && !filterChanged) return;
      settleUntil = performance.now() + 500;
      if (filterChanged) filter = next.filter!;
      tab = next.tab;
      flushSync();
      const y = currentView()?.y;
      if (y == null && !tabChanged) return; // 絞り込みだけが変わり、残した位置も無い: 描き終えた後でブラウザが戻す位置のまま
      const go = (): void => {
        if (y != null) window.scrollTo({ top: y, behavior: 'instant' });
        else anchorTarget(location.hash)?.scrollIntoView({ block: 'start', behavior: 'instant' });
      };
      go();
      requestAnimationFrame(go);
    };
    const onScroll = (): void => {
      clearTimeout(saveTimer);
      // 戻している間のスクロールは、戻し終えた後(その時刻の 0.2 秒後)の位置を 1 回だけ書く。
      // 途中の位置は書かず、その間に自分でスクロールして止めた位置も落とさない
      const wait = Math.max(0, settleUntil - performance.now());
      saveTimer = setTimeout(saveScroll, wait + 200);
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onPop);
    window.addEventListener('scroll', onScroll, { passive: true });
    if (initialView) showView(initialView);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('scroll', onScroll);
      clearTimeout(saveTimer);
    };
  });

  /** タブへのリンク(今の絞り込みはそのまま。概況は tab を書かない) */
  const tabHref = (t: TabId): string => filterHref(filter, null, t);
  let tabsEl = $state<HTMLElement | null>(null);
  /**
   * タブを開く(タブの帯・サイドバーの群の題・狭い幅の目次の行)。履歴に積むので「戻る」で前のタブに戻る。
   * 新しいタブで開くなどの修飾つきの押し方はブラウザに任せる(リンクの href がそのタブの URL)
   */
  function openTab(e: MouseEvent, t: TabId): void {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (t !== tab) {
      saveScroll(); // 今の項目に今の位置を残してから積む(戻ったときにその位置へ)
      const h = encodeState(filter, t);
      try {
        history.pushState(null, '', h ? `#${h}` : location.pathname + location.search);
      } catch {
        /* file:// で履歴を書けない環境では、タブだけ切り替える */
      }
      tab = t;
      flushSync();
    }
    // ページがタブの帯より下までスクロールしていれば、帯が上端に来る位置へ(ページの先頭までは戻さない)
    const top = tabsEl?.getBoundingClientRect().top;
    if (top != null && top < topbarPx) window.scrollTo({ top: window.scrollY + top - topbarPx, behavior: 'instant' });
  }

  // タブを切り替えて、焦点のあった要素が隠れたタブに入ったら(戻る / 進む・ページ内リンクで切り替えたとき)、焦点を今のタブの帯のリンクへ移す。
  // そのままだと焦点が body に落ち、キーボードで続けて操作できない。スクロールはさせない
  let lastFocus: Element | null = null;
  $effect(() => {
    const onFocus = (e: FocusEvent): void => void (lastFocus = e.target as Element | null);
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  });
  $effect(() => {
    void tab;
    untrack(() => {
      const inHidden = (el: Element | null): boolean => !!el?.isConnected && !!el.closest('[data-tab-panel]')?.hasAttribute('hidden');
      const now = document.activeElement;
      // ブラウザが隠れた要素から焦点を外すのは次の描画のとき(それまでは隠れた要素のまま)。外れた後なら body
      const lost = inHidden(now) || ((!now || now === document.body) && inHidden(lastFocus));
      if (lost) tabsEl?.querySelector<HTMLElement>('a[aria-current="page"]')?.focus({ preventScroll: true });
    });
  });

  // あふれてスクロールする表の枠にキーボードで届くようにする(描画が変わるたびに付け直す)
  $effect(() => watchScrollFocus(document.body));

  // 開いたとき: ページ内リンクのハッシュ(詳細ページからの atlas.html#phases、#exec-modes-h など)の行き先が別のタブにあれば、そのタブを出してから行き先へ移る。
  // 戻る / 進む・再読み込みで別のページから開かれたら、離れたときのスクロール位置に戻す(描いてから。ブラウザに任せると描く前の短いページで先頭になる)。
  // 離れるときに今の位置を履歴の項目に書く(view-restore.ts)。
  // URL を書き換える effect(下)より先に置く(ここで決めたタブを、その effect が書く URL に残すため)
  $effect(() =>
    untrack(() => {
      const y = restoredView()?.y;
      const target = anchorTarget(location.hash);
      const p = panelOf(target);
      const moved = !!p && p !== tab;
      if (p && moved) tab = p;
      // scrollRestoration は 'auto' のままにする('manual' にすると、目次や要点のリンクで移ってからの「戻る」でブラウザが位置を戻さなくなる)
      // 本文を描き終えてから戻す。後から高さが変わる(サーバから読んだ帯が出るなど)ときのため、
      // 少し後にもう一度だけ合わせる(その間に自分でスクロールしたら合わせない)。1px のずれでも合わせる
      // (ブラウザが戻す位置や、端数の高さの要素によるずれが、ちょうど 1px のことがある)
      const restore = y != null && y > 0;
      const go = (): void => {
        if (restore) window.scrollTo({ top: y, behavior: 'instant' });
        else target?.scrollIntoView({ block: 'start', behavior: 'instant' });
      };
      const start = (): void => {
        if (!restore && !target) return;
        const before = (): number => (restore ? window.scrollY : (target?.getBoundingClientRect().top ?? 0));
        go();
        const at = before();
        let userMoved = false;
        const stop = (): void => void (userMoved = true);
        addEventListener('wheel', stop, { once: true, passive: true });
        addEventListener('keydown', stop, { once: true });
        addEventListener('touchstart', stop, { once: true, passive: true });
        setTimeout(() => {
          if (!userMoved && (restore ? Math.abs(window.scrollY - y) >= 1 : Math.abs(before() - at) >= 1)) go();
          removeEventListener('wheel', stop);
          removeEventListener('keydown', stop);
          removeEventListener('touchstart', stop);
        }, 300);
      };
      // 描き終えてから(タブを替えたときの hidden と、狭い幅の目次の行の高さ --topbar-h が入ってから)移る
      void tick().then(start);
      restoreDone();
      const onHide = (): void => saveView({ y: window.scrollY });
      addEventListener('pagehide', onHide);
      return () => removeEventListener('pagehide', onHide);
    }),
  );

  // 絞り込みを変えたら URL を書き換える(履歴には積まない)。今のタブの指定は残す(タブを変えたときは、ここでは書かない)
  $effect(() => {
    void encodeFilter(filter);
    untrack(writeStateUrl);
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

  // セッションの選択(一覧のチェック欄)。状態は画面内だけ(保存しない)。
  // filter.ids が変わったとき(「集計」、ハッシュから開いた、戻る)は選択を ids に揃える = 絞り込み中の一覧は全てチェック済みで出る
  let selected = $state<Set<string>>(new Set());
  const knownIds = $derived(new Set(sessions.map((s) => s.id)));
  // 依存は ids の文字列だけ(文字列が同じなら走らない = 外したチェックが戻らない)
  const filterIds = $derived.by(() => filter.ids);
  // 選んだ N 件の絞り込みを外したときはチェックも外す(残すと、別のページにあって見えないセッションが次の集計に黙って混ざる)
  let prevIds = '';
  $effect(() => {
    const ids = filterIds;
    // 記録に無い id(共有された URL に混じるもの)は選択に入れない(件数を記録どおりにする)
    if (ids) selected = knownSelection(ids, knownIds);
    else if (prevIds) selected = new Set();
    prevIds = ids;
  });
  /** チェックしたものだけで集計する(他の条件と AND) */
  function applySelection(): void {
    if (selected.size) setFilter({ ids: joinIds(selected) });
  }
  /** 選択を外す。選択で集計中ならその条件も外す(チェックが無いのに「選んだ N 件」で絞られたままにしない) */
  function clearSelection(): void {
    selected = new Set();
    if (filter.ids) setFilter({ ids: '' });
  }
  // --- 編集モード(atlas serve から開いたとき)。画面と保存の境界は api.ts の小さな API だけ ---
  /** serve が meta に入れた token(file:// や共有用の 1 ファイルでは null) */
  const token = serveToken();
  /** http(s) で開かれ、token があり、GET api/state が成功した */
  let editable = $state(false);
  /** 別のフォルダを開いた画面(サーバが読むだけと答えた)。集計し直す・判定は使えるが、メモ・アップロード先は書き換えない */
  let readOnly = $state(false);
  /** アップロード先・まとめて送る印を書き換えられるか */
  const canEdit = $derived(editable && !readOnly);
  /** heartbeat が失敗した(サーバが止まった)。閲覧はそのまま、編集だけ無効 */
  let serverDown = $state(false);
  /** サーバがこの画面と違う版(atlas を更新した後も、前から動いているサーバが応えている)。閲覧と編集はそのまま、帯で知らせる */
  let serverStale = $state(false);
  /** 「別のフォルダを開く」で開いた画面なら、そのフォルダ(サーバに聞く。~/.copilot の形のフォルダは埋め込みの source に出ないため) */
  let liveSource = $state<{ name: string; path: string } | null>(null);
  /** この画面が集計しているフォルダ(この PC のセッションなら null) */
  const sourceLabel = $derived(liveSource ?? (data?.source ? { name: data.source.name, path: data.source.path } : null));
  $effect(() => {
    if (sourceLabel) document.title = `${sourceLabel.name} | Copilot Session Atlas`;
  });
  $effect(() => {
    if (!token) return;
    const stop = startHeartbeat(
      token,
      () => {
        serverDown = true;
        editable = false;
      },
      { onStale: () => (serverStale = true) },
    );
    // 1 回だけ試す。失敗しても(古い serve など)黙って閲覧専用にする
    api
      .state()
      .then((s) => {
        liveMemos = s.memos ?? null; // 古い serve には無い(埋め込みの抜粋を残す)
        uploadSetting = s.upload ?? null; // 古い serve には無い(アップロードの操作を出さない)
        readOnly = s.readOnly === true;
        editable = true;
        // 古い serve には無い(失敗しても、埋め込みのタスクだけで出す)
        tasksApi
          .get(token)
          .then((t) => (liveTasks = t))
          .catch(() => {});
        // 古い serve には無い(失敗しても、埋め込みの source だけで出す)
        foldersApi
          .list(token)
          .then((l) => (liveSource = l.current))
          .catch(() => {});
      })
      .catch(() => {});
    return stop;
  });
  // 画面からの操作(集計し直す・判定の添付ファイルを作る)。編集できるとき(serve から開いた画面)だけ。サーバが止まったら読むのもやめる
  const jobStore = token ? new JobStore(token) : null;
  $effect(() => {
    if (!jobStore || !editable || serverDown) return;
    jobStore.startPolling();
    return () => jobStore.stopPolling();
  });
  // 今の絞り込み(空を含めるかの条件を除く)に当てはまる空のセッション数。表紙の「除外」の件数に使う
  /** 今の絞り込みで、空のセッションも含めたときに出るセッション */
  const emptyRelaxed = $derived(applyFilter(sessions, { ...filter, empty: '1' }, taskMap));
  const emptyInFilter = $derived(emptyRelaxed.filter((s) => s.empty).length);
  /** アップロード先(atlas.config.json の uploadRoot)。serve が教えてくれたときだけ設定に出す */
  let uploadSetting = $state<UploadSetting | null>(null);
  const uploadHandlers = $derived<UploadHandlers | undefined>(
    uploadSetting
      ? {
          setting: uploadSetting,
          pick: async () => {
            const r = await api.pickUploadRoot(token!);
            if (r.root && uploadSetting) uploadSetting = { ...uploadSetting, root: r.root, error: null };
            return r.root;
          },
          setRoot: async (root) => {
            const r = await api.setUploadRoot(token!, root);
            if (uploadSetting) uploadSetting = { ...uploadSetting, root: r.root, error: null };
            return r.root;
          },
        }
      : undefined,
  );
  /** upload-project.bat がまとめて送るプロジェクトの印(プロジェクト別の表)。serve が教えてくれたときだけ出す */
  let sendIssued = 0;
  const projectSend = $derived(
    uploadSetting?.projects
      ? {
          projects: uploadSetting.projects,
          error: uploadSetting.error,
          toggle: async (project: string, on: boolean) => {
            const seq = ++sendIssued;
            const r = await api.setUploadProject(token!, project, on);
            if (!uploadSetting) return;
            // 最後に出した要求の答えなら、サーバの一覧(ほかで書き換えた分も入る)をそのまま使う。
            // 先に出した要求の答えが後から届いたときは、その印だけを反映する(新しい一覧を古い一覧で上書きしない)
            const cur = uploadSetting.projects ?? [];
            const projects = seq === sendIssued ? r.projects : on ? (cur.includes(project) ? cur : [...cur, project]) : cur.filter((x) => x !== project);
            uploadSetting = { ...uploadSetting, projects };
          },
        }
      : undefined,
  );
  /**
   * 画面の設定の「まとめて送るプロジェクト」に出す、集計のプロジェクト(絞り込みに関係なく全部)。
   * 空のセッションだけのプロジェクトは出さない(upload-project.bat は空のセッションを送らないので、印を付けても何も送られない)
   */
  const settingsProjects = $derived(aggregate(sessions.filter((x) => !x.empty)).byProject.map((b) => ({ key: b.key, label: b.label, sessions: b.sessions })));

  /** 効いている絞り込みの条件の数(期間は開始・終了で 1 つ、セッションの選択は 1 つ) */
  const activeConditions = $derived.by(() => {
    let n = filter.from || filter.to ? 1 : 0;
    for (const k of ['project', 'person', 'client', 'model', 'branch', 'coverage', 'taskCategory', 'tool', 'ids', 'memo', 'wiki', 'task'] as const) if (filter[k]) n++;
    if (filter.empty === '1') n++;
    return n;
  });

  /** 目次の 1 項目。id はページ内の節、href は別ページ */
  type TocItem = { id: string; label: string; href?: undefined } | { href: string; label: string; id?: undefined };
  /**
   * 節の目次。広い画面(768px 以上)では左のサイドバー、狭い画面では上部の固定した 1 行。群で区切る(別ページは href)。
   * tab のある群は本文のタブ(群の題がそのタブへのリンク)。節の並びは本文の並びと同じにする
   */
  const tocGroups = $derived.by((): { title: string; tab: TabId | null; items: TocItem[] }[] => [
    {
      title: '概況',
      tab: 'overview',
      items: [
        { id: 'overview', label: '全体' },
        { id: 'highlights', label: '要点' },
        { id: 'insights', label: '改善点' },
        ...(wiki === 'counted' ? [{ id: 'insights-wiki', label: 'llm-wiki' }] : []),
        { id: 'phases', label: '工程と詰まり' },
        { id: 'detail', label: '集計明細' },
        ...(judged ? [{ id: 'judgments', label: 'AI 投入量 vs 推定人手工数' }] : []),
        ...(tasks ? [{ id: 'tasks', label: '管理ツールのタスク' }] : []),
        ...(data?.retention ? [{ id: 'retention', label: 'AI の変更の残存' }] : []),
        { id: 'compare', label: '比べる' },
      ],
    },
    {
      title: '内訳',
      tab: 'breakdown',
      items: [
        { id: 'usage', label: '利用ランキング' },
        { id: 'exec', label: '実行の性質' },
        ...(options.person.length > 0 ? [{ id: 'people', label: '人別' }] : []),
        { id: 'projects', label: 'プロジェクト別' },
        { id: 'monthly', label: '月別推移' },
        { id: 'models', label: 'モデル別' },
        { id: 'model-value', label: 'モデルと推論強度の効果' },
      ],
    },
    { title: '一覧', tab: 'list', items: [{ id: 'sessions', label: 'セッション一覧' }] },
    { title: '付録', tab: null, items: [...(data?.failures ? [{ href: 'failures.html', label: '失敗の台帳の集計' }] : []), ...(data?.library ? [{ href: 'instructions.html', label: '指示文と skill' }] : []), { href: 'glossary.html', label: '用語の説明' }] },
  ]);
  /** タブ(目次の群のうち tab のあるもの) */
  const tabGroups = $derived(tocGroups.filter((g): g is { title: string; tab: TabId; items: TocItem[] } => g.tab != null));

  /** 読んでいる節(目次の現在地の印)。今のタブの節のうち、見出しが画面上部 1/3(固定行の下)を越えた最後の節 */
  let current = $state('overview');
  /** 目次と件数の帯の高さ。狭い画面では上部に固定するので、ページ内リンクの飛び先をこの分だけ下げる(--topbar-h) */
  let railHeight = $state(0);
  let topbarPx = 0;
  let railEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const wide = matchMedia('(min-width: 768px)');
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
    const ids = (tocGroups.find((g) => g.tab === tab)?.items ?? []).map((i) => i.id).filter((id): id is string => !!id);
    if (!ids.length) return;
    let queued = false;
    const mark = (): void => {
      queued = false;
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
      if (!queued) {
        queued = true;
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
    void tab;
    // 節の現在地(aria-current="true")。タブのリンク(aria-current="page")は行の先頭にある
    const a = railEl?.querySelector<HTMLElement>('.toc a[aria-current="true"]');
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
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (!href.startsWith('#')) {
        try {
          sessionStorage.setItem('atlas-return', '1');
        } catch {
          /* 保存できない環境では普通のリンクとして戻る */
        }
        return;
      }
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      // ページ内リンク: 移る前の位置を今の履歴の項目に残す(戻るでタブが変わるときに使う)。
      // 行き先が隠れたタブにあれば先にそのタブを出す(そのあとブラウザがいつもどおり行き先へスクロールし、履歴にも積む)
      saveScroll();
      const el = anchorTarget(href);
      const p = panelOf(el);
      if (el && !p) {
        // どのタブにも入っていない行き先(「本文へ移動」の #main など): URL を書き換えない(書くと tab=… が消え、再読み込みで概況に戻る)。
        // ブラウザのページ内移動と同じく、そこへスクロールして、焦点を受けられる要素なら焦点も移す
        e.preventDefault();
        el.scrollIntoView({ block: 'start' });
        if (el.hasAttribute('tabindex') || el.tabIndex >= 0) el.focus({ preventScroll: true });
        return;
      }
      if (el && p && p !== tab) {
        tab = p;
        flushSync();
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
    <div class="wrap mast-row" class:wide={tab === 'list'}>
      <div class="mast-title">
        <h1>Copilot Session Atlas</h1>
        <p class="mast-sub">
          GitHub Copilot のセッションログの集計(LLM は使っていません)。生成 <span class="nw">{dateTime(data.generatedAt)}</span>・記録期間 <span class="nw">{date(all.overall.firstAt)}〜{date(all.overall.lastAt)}</span>。
          {#if filter.empty === '1'}記録 {int(sessions.length)} 件すべてを集計対象にしています(うち空のセッション {int(emptyCount)} 件)。{:else}記録 {int(sessions.length)} 件のうち {int(scoped.length)} 件を集計対象にしています(空のセッション {int(emptyCount)} 件を除外)。{/if}
        </p>
      </div>
      <div class="mast-tools">
        {#if editable && jobStore}<JobActions jobs={jobStore} disabled={serverDown} tasks={liveTasks?.tasks ? { configured: liveTasks.tasks.configured, readOnly: liveTasks.readOnly } : null} /><SettingsDialog jobs={jobStore} disabled={serverDown} upload={uploadHandlers} send={canEdit ? projectSend : undefined} projects={settingsProjects} /><OpenFolder token={jobStore.token} disabled={serverDown} />{/if}
        {#if sourceLabel}<span class="tag" title={sourceLabel.path} data-testid="source-tag">対象: {sourceLabel.name}</span>{/if}
        {#if readOnly}<span class="tag" title="メモは、送った人が付けたものを出します。この画面では書き換えません(集計し直す・判定はできます)" data-testid="readonly-tag">読むだけ</span>{/if}
        {#if data.atlasBuilds}<span class={data.atlasBuilds.ok ? 'tag' : 'tag warn'} title={[data.atlasBuilds.headline, ...data.atlasBuilds.lines].join('\n')} data-testid="atlas-builds-tag">送った atlas: {data.atlasBuilds.short}</span>{/if}
        {#if scopeNotes.length}<span class="tag" title="atlas build の実行時に絞り込んだ条件">出力時の絞り込み: {scopeNotes.join('、')}</span>{/if}
        <div class="seg" role="group" aria-label="配色">
          {#each [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']] as [v, label]}
            <button type="button" aria-pressed={theme === v} onclick={() => setTheme(v as ThemeChoice)}>{label}</button>
          {/each}
        </div>
      </div>
    </div>
  </header>

  <!-- 一覧タブは横に長い表なので、幅の上限を外して画面の幅まで使う -->
  <div class="shell" class:wide={tab === 'list'}>
    <div class="rail" bind:this={railEl} bind:offsetHeight={railHeight}>
      <div class="rail-in wrap">
        <nav class="toc" aria-label="ページ内の移動">
          <!-- 狭い幅の行の先頭のタブ。広い幅では、タブは下の群の題に出す -->
          <div class="toc-group toc-tabs" role="group" aria-label="タブ">
            <ol>
              {#each tabGroups as g (g.tab)}
                <li><a href={tabHref(g.tab)} aria-current={tab === g.tab ? 'page' : undefined} onclick={(e) => openTab(e, g.tab)}>{g.title}</a></li>
              {/each}
            </ol>
          </div>
          {#each tocGroups as g (g.title)}
            <!-- 狭い幅では今のタブの節だけを並べる(広い幅ではどのタブの節も出し、押すとそのタブに移る) -->
            <div class="toc-group" class:off={g.tab != null && g.tab !== tab} role="group" aria-label={g.title}>
              {#if g.tab}
                {@const t = g.tab}
                <a class="toc-tab" href={tabHref(t)} aria-current={tab === t ? 'page' : undefined} onclick={(e) => openTab(e, t)} data-testid="toc-tab-{t}">{g.title}</a>
              {:else}
                <span class="toc-title" aria-hidden="true">{g.title}</span>
              {/if}
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
            {#if activeConditions > 0}<span class="badge">{activeConditions}</span> <span class="w">条件で絞り込み中</span><span class="u" aria-hidden="true">条件</span><span class="sr-only">条件で絞り込み中</span>{/if}
          </p>
          <button type="button" class="btn" disabled={isEmptyFilter(filter)} onclick={reset}>解除</button>
        </div>
      </div>
    </div>

    <div class="content">
      {#if serverDown}
        <div class="down-band" role="alert">サーバが止まっています。atlas.bat を実行し直してください(閲覧はそのままできます)。</div>
      {:else if serverStale}
        <div class="down-band stale-band" role="alert">{STALE_MESSAGE}</div>
      {/if}
      {#if editable && jobStore}<JobBand jobs={jobStore} generatedAt={data.generatedAt} />{/if}
      <FilterBar {filter} {options} {judged} {emptyCount} {memoCount} {wikiCount} wikiCounted={wiki === 'counted'} lastDay={all.overall.lastAt ? date(all.overall.lastAt) : null} onchange={setFilter} {editable} tasks={taskOpts ? { options: taskOpts.tasks, none: taskOpts.none } : null} />

      <main class="wrap" id="main" tabindex="-1">
        <div class="empty" class:show={filtered.length === 0} role="status">
          {#if filtered.length === 0}
            <p>この条件に合うセッションはありません。</p>
            <button type="button" class="btn" onclick={reset}>絞り込みを解除</button>
          {/if}
        </div>

        <!-- 本文のタブ(目次の群と同じ)。押すと履歴に積む。隠れたタブも描いておく(印刷では全部出す) -->
        <nav class="tabs" aria-label="レポートのタブ" bind:this={tabsEl} data-testid="report-tabs">
          <ul>
            {#each tabGroups as g (g.tab)}
              <li><a href={tabHref(g.tab)} aria-current={tab === g.tab ? 'page' : undefined} onclick={(e) => openTab(e, g.tab)} data-testid="tab-{g.tab}">{g.title}</a></li>
            {/each}
          </ul>
        </nav>

        <div class="tab-panel" data-tab-panel="overview" hidden={tab !== 'overview'}>
          <!-- 帳票の順: 表紙(規模の 4 欄)→ 摘要(要点)→ 明細 -->
          <Overview part="cover" {agg} {judged} warnings={data.warnings} filtered={!isEmptyFilter(filter)} includeEmpty={filter.empty === '1'} {emptyCount} {emptyInFilter} {editable} {tasks} />
          <Highlights groups={points} />
          <Insights sessions={filtered} allSessions={data.sessions} installed={installed?.skills ?? null} disabled={installed?.disabled ?? []} meta={data.insights?.meta ?? {}} candidates={data.insights?.candidates ?? []} candidateTotal={data.insights?.candidateTotal ?? data.insights?.candidates.length ?? 0} computedOver={data.insights?.computedOver ?? sessions.length} hasPage={true} libraryHref={data.library ? 'instructions.html' : null} {wiki} wikiPagesRecorded={(data.version ?? 0) >= WIKI_PAGES_DATA_VERSION} wikiPageNames={data.wikiPageNames ?? []} />
          <TurnPhases agg={turnAgg} verdicts={verdictAgg} verdictModel={data.turnJudgments?.model ?? null} verdictRanAt={data.turnJudgments?.ranAt ?? null} {editable} />
          <Overview part="detail" {agg} {judged} warnings={data.warnings} filtered={!isEmptyFilter(filter)} includeEmpty={filter.empty === '1'} {emptyCount} {emptyInFilter} {wiki} />
          {#if judged}<JudgmentPanel {agg} meta={data.judgments} />{/if}
          {#if tasks}<TaskPanel {tasks} current={filter.task} noneCount={taskOpts?.none ?? 0} onpick={(t) => setFilter({ task: t })} />{/if}
          {#if data.retention}<Retention sessions={filtered} meta={data.retention} />{/if}
          <Compare sessions={scoped} projects={options.project} lastAt={all.overall.lastAt} retention={!!data.retention} />
        </div>
        <div class="tab-panel" data-tab-panel="breakdown" hidden={tab !== 'breakdown'}>
          <UsageRanking usage={agg.usage} {installed} failuresPage={data.failures === true} bind:tab={usageTab} />
          <ExecProfile exec={agg.exec} sessions={filtered.length} />
          <!-- 人別は、送り先(<人>/<プロジェクト>)をまとめて集計したレポートだけ -->
          {#if options.person.length > 0}<ProjectTable kind="person" rows={agg.byPerson} {judged} {wiki} current={filter.person} onpick={(p) => setFilter({ person: p })} />{/if}
          <ProjectTable rows={agg.byProject} {judged} {wiki} current={filter.project} onpick={(p) => setFilter({ project: p })} send={canEdit && !serverDown ? projectSend : undefined} />
          <MonthlyChart months={agg.byMonth} lastAt={all.overall.lastAt} />
          <ModelChart rows={agg.byModel} />
          <ModelValue sessions={filtered} />
        </div>
        <div class="tab-panel" data-tab-panel="list" hidden={tab !== 'list'}>
          <SessionTable
            sessions={filtered}
            allSessions={sessions}
            {emptyRelaxed}
            emptyIncluded={filter.empty === '1'}
            {judged}
            {selected}
            idsActive={filter.ids !== ''}
            onselect={(s) => (selected = s)}
            onapply={applySelection}
            onclear={clearSelection}
            tasks={tasks ? { links: tasks.links, names: taskNames } : null}
          />
        </div>
      </main>
      <footer class="wrap foot">
        <p>
          このレポートはローカルのログ(~/.copilot)を複製して集計したもので、LLM は使っていません。入力トークン・AI 使用量(AIU)・premium request・変更行数は記録が残っているセッションだけの合計です。
          {#if data.warnings.unknownEventTypes > 0 || data.warnings.badLines > 0}
            読み取り時の注意: 未知のイベント種別 {int(data.warnings.unknownEventTypes)} 件、読めなかった行 {int(data.warnings.badLines)} 行。
          {/if}
          {#if data.warnings.notes?.length}
            集計の注意 {int(data.warnings.notes.length)} 件(全体サマリの集計明細に理由)。
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
    max-width: 100ch;
  }
  .mast-sub .nw {
    white-space: nowrap;
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
  @media (min-width: 768px) {
    /* マストヘッドの幅をサイドバー + 本文(.shell)に揃える */
    .mast-row {
      max-width: calc(1360px + 13em + 32px);
    }
    .mast-row.wide {
      max-width: none;
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
  /* 本文のタブの帯(本文の上端。どの幅でも出す)。今のタブは緑の字と緑の 2px の線(目次の今いる項目と同じ印)と aria-current="page" */
  .tabs {
    margin-top: 20px;
    border-bottom: 1px solid var(--rule-strong);
  }
  .tabs ul {
    display: flex;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tabs a {
    display: inline-flex;
    align-items: center;
    min-height: 40px;
    padding: 0 18px;
    margin-bottom: -1px;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--ink-2);
    text-decoration: none;
    border-bottom: 2px solid transparent;
  }
  .tabs a:hover {
    color: var(--form);
    background: var(--form-wash);
  }
  .tabs a[aria-current='page'] {
    color: var(--form);
    background: var(--surface);
    border-bottom-color: var(--form);
  }
  @media (max-width: 720px) {
    .tabs a {
      flex: 1 1 0;
      justify-content: center;
      padding: 0 8px;
    }
    .tabs li {
      display: flex;
      flex: 1 1 0;
    }
  }
  /* 印刷ではどのタブの節も出す(タブの帯は要らない) */
  @media print {
    .tabs {
      display: none;
    }
    .tab-panel[hidden] {
      display: block;
    }
  }

  /* 目次のタブ。狭い幅の行では先頭に並べ(.toc-tabs)、今のタブ以外の群の節は隠す。広い幅では群の題(.toc-tab)がタブへのリンク */
  .toc .toc-tabs a {
    min-width: 0;
    min-height: 28px;
    padding: 0 10px;
    font-weight: 600;
    color: var(--ink-2);
    border: 1px solid var(--control);
    border-bottom: 1px solid var(--control);
  }
  .toc .toc-tabs li + li a {
    margin-left: -1px;
  }
  .toc .toc-tabs ol {
    gap: 0;
  }
  .toc .toc-tabs a:hover {
    color: var(--form);
    background: var(--form-wash);
    text-decoration: none;
  }
  .toc .toc-tabs a[aria-current='page'] {
    color: var(--surface);
    background: var(--form);
    border-color: var(--form);
  }
  .toc .toc-group.off {
    display: none;
  }
  .toc .toc-tab {
    display: none;
  }
  @media (min-width: 768px) {
    .toc .toc-tabs {
      display: none;
    }
    .toc .toc-tabs + .toc-group {
      margin-top: 0;
    }
    .toc .toc-group.off {
      display: block;
    }
    /* 群の題(base.css の .toc-title と同じ大きさ・色)を、押せる高さのリンクにする。今のタブは緑の地に紙の色の字 */
    .toc .toc-tab {
      display: flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--form);
      background: none;
      border: 0;
      border-bottom: 1px solid var(--rule-strong);
      text-decoration: none;
    }
    .toc .toc-tab:hover {
      background: var(--form-wash);
      text-decoration: underline;
    }
    .toc .toc-tab[aria-current='page'] {
      color: var(--surface);
      background: var(--form);
      border-bottom-color: var(--form);
      text-decoration: none;
    }
  }
</style>
