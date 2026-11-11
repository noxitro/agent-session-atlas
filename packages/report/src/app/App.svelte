<script lang="ts">
  import { aggregate } from '../lib/aggregate.ts';
  import { turnAggregate } from '../lib/turns.ts';
  import { verdictAggregate } from '../lib/verdicts.ts';
  import { applyFilter, currentGroupName, decodeFilter, decodeView, effectiveIds, emptyFilter, encodeFilter, filterOptions, groupIds, inScope, isEmptyFilter, isStateHash, joinIds, knownSelection, type FilterState } from '../lib/filter.ts';
  import GroupRail from './components/GroupRail.svelte';
  import GroupHead from './components/GroupHead.svelte';
  import { highlights } from '../lib/highlights.ts';
  import { date, dateTime, int } from '../lib/format.ts';
  import type { ReportData } from '../lib/types.ts';
  import FilterBar from './components/FilterBar.svelte';
  import Overview from './components/Overview.svelte';
  import JudgmentPanel from './components/JudgmentPanel.svelte';
  import ProjectTable from './components/ProjectTable.svelte';
  import UsageRanking from './components/UsageRanking.svelte';
  import Highlights from './components/Highlights.svelte';
  import Insights from './components/Insights.svelte';
  import ExecProfile from './components/ExecProfile.svelte';
  import TurnPhases from './components/TurnPhases.svelte';
  import MonthlyChart from './components/MonthlyChart.svelte';
  import ModelChart from './components/ModelChart.svelte';
  import SessionTable from './components/SessionTable.svelte';
  import { applyTheme, loadTheme, type ThemeChoice } from './theme.ts';
  import { watchScrollFocus } from './scroll-focus.ts';
  import { STALE_MESSAGE } from '../lib/code-check.ts';
  import { api, foldersApi, serveToken, startHeartbeat, type GroupExport, type UploadHandlers, type UploadSetting } from './api.ts';
  import { restoreDone, restoredView, saveView } from './view-restore.ts';
  import { JobStore } from './jobs.svelte.ts';
  import JobActions from './components/JobActions.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import OpenFolder from './components/OpenFolder.svelte';
  import JobBand from './components/JobBand.svelte';
  import type { MemoSummary } from '../lib/memo.ts';
  import type { ReportGroup } from '../lib/types.ts';

  let { data, error }: { data: ReportData | null; error: string | null } = $props();

  /** API から読んだメモ(編集モードではこちらを使う。ビルド後に書いたメモも一覧に出る) */
  let liveMemos = $state<Record<string, MemoSummary> | null>(null);
  const sessions = $derived.by(() => {
    const list = data?.sessions ?? [];
    const memos = liveMemos;
    return memos ? list.map((s) => ({ ...s, memo: memos[s.id] ?? null })) : list;
  });
  const memoCount = $derived(sessions.filter((s) => s.memo).length);
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
  // 集計に使う id は「group の名前が今のグループにあればその ids、無ければ ids」(effectiveIds。宣言は下だが評価は描画時)
  const filtered = $derived.by(() => applyFilter(sessions, { ...filter, ids: eff.ids }));
  const agg = $derived(aggregate(filtered));
  const turnAgg = $derived(turnAggregate(filtered));
  const verdictAgg = $derived(data?.turnJudgments?.available ? verdictAggregate(filtered, data.turnJudgments.phases) : null);
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
      // 戻る / 進むで # の無い URL(絞り込みの無い状態は # を書かない)に戻ったら、絞り込みも外す。
      // 以前は読み飛ばしていたので、要点のリンクで絞り込んでから「戻る」を押しても絞り込みが残っていた
      if (location.hash.length <= 1) {
        if (!isEmptyFilter(filter)) filter = emptyFilter();
        return;
      }
      if (!isStateHash(location.hash)) return;
      filter = decodeFilter(location.hash);
      showView(decodeView(location.hash) ?? 'sessions');
    };
    window.addEventListener('hashchange', onHash);
    if (initialView) showView(initialView);
    return () => window.removeEventListener('hashchange', onHash);
  });

  // あふれてスクロールする表の枠にキーボードで届くようにする(描画が変わるたびに付け直す)
  $effect(() => watchScrollFocus(document.body));

  // 伏せ字版にはメモが無いので、共有された #memo=1 で 0 件にしない
  $effect(() => {
    if (data?.anonymized && filter.memo) setFilter({ memo: '' });
  });

  $effect(() => {
    const h = encodeFilter(filter);
    try {
      // history.state(戻ったときの見た目。view-restore.ts)は消さずに URL だけ変える
      history.replaceState(history.state, '', h ? `#${h}` : location.pathname + location.search);
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

  // セッションの選択(一覧のチェック欄)。状態は画面内だけ(保存しない)。
  // filter.ids が変わったとき(「集計」、グループの選択、ハッシュから開いた、戻る)は選択を ids に揃える = 絞り込み中の一覧は全てチェック済みで出る
  let selected = $state<Set<string>>(new Set());
  const knownIds = $derived(new Set(sessions.map((s) => s.id)));
  // 依存は ids の文字列だけ(eff はグループの一覧が変わるたびに新しいオブジェクトになるが、文字列が同じなら走らない = 外したチェックが戻らない)
  const effIds = $derived.by(() => eff.ids);
  // 絞り込み(グループ・選んだ N 件)を外したときはチェックも外す。残すと、「すべて」に戻った後に次のグループを作ったり足したりしたとき、
  // 前のグループのセッションが(別のページにあって見えないまま)黙って混ざる
  let prevIds = '';
  $effect(() => {
    const ids = effIds;
    // 記録に無い id(共有された URL やグループの ids に混じるもの)は選択に入れない(件数を記録どおりにする)
    if (ids) selected = knownSelection(ids, knownIds);
    else if (prevIds) selected = new Set();
    prevIds = ids;
  });
  /** チェックしたものだけで集計する(他の条件と AND)。グループの選択は外れる(名前の一致で現在のグループになることはある) */
  function applySelection(): void {
    if (selected.size) setFilter({ ids: joinIds(selected), group: '' });
  }
  /** 選択を外す。選択で集計中ならその条件も外す(チェックが無いのに「選んだ N 件」で絞られたままにしない) */
  function clearSelection(): void {
    selected = new Set();
    if (filter.ids || filter.group) setFilter({ ids: '', group: '' });
  }
  // --- 編集モード(atlas serve から開いたとき)。画面と保存の境界は api.ts の小さな API だけ ---
  /** serve が meta に入れた token(file:// や共有用の 1 ファイルでは null) */
  const token = serveToken();
  /** http(s) で開かれ、token があり、GET api/state が成功し、伏せ字版でない */
  let editable = $state(false);
  /** API から読んだグループ(編集モードではこちらを使う。CLI で足したものも再読み込みで出る) */
  let liveGroups = $state<ReportGroup[] | null>(null);
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
    if (!data?.anonymized) {
      // 1 回だけ試す。失敗しても(古い serve、伏せ字版の 403 など)黙って閲覧専用にする
      api
        .state()
        .then((s) => {
          liveGroups = s.groups;
          liveMemos = s.memos ?? null; // 古い serve には無い(埋め込みの抜粋を残す)
          uploadSetting = s.upload ?? null; // 古い serve には無い(アップロードの操作を出さない)
          editable = true;
          // 古い serve には無い(失敗しても、埋め込みの source だけで出す)
          foldersApi
            .list(token)
            .then((l) => (liveSource = l.current))
            .catch(() => {});
        })
        .catch(() => {});
    }
    return stop;
  });
  // Phase 14: 画面からの操作(集計し直す・工数を判定する)。編集できるとき(serve から開いた通常版)だけ。サーバが止まったら読むのもやめる
  const jobStore = token ? new JobStore(token) : null;
  $effect(() => {
    if (!jobStore || !editable || serverDown) return;
    jobStore.startPolling();
    return () => jobStore.stopPolling();
  });
  /** 名前付きグループ(記録にある id とその件数つき) */
  const groupOptions = $derived.by(() =>
    (liveGroups ?? data?.groups ?? []).map((g) => {
      const presentIds = g.ids.filter((id) => knownIds.has(id));
      return { ...g, presentIds, present: presentIds.length };
    }),
  );
  /** group(名前)→ 今のグループの ids、無ければ ids(共有した相手にその名前が無くても壊れない) */
  const eff = $derived(effectiveIds(filter, groupOptions, knownIds));
  // 今の絞り込み(空を含めるかの条件を除く)に当てはまる空のセッション数。表紙の「除外」の件数に使う
  const emptyInFilter = $derived(applyFilter(sessions, { ...filter, empty: '1', ids: eff.ids }).filter((s) => s.empty).length);
  /** 現在のグループ名(名前で決まらないときは ids の一致。0 件のグループや同じ集合が複数あるときは決めない) */
  const currentName = $derived(currentGroupName(filter, groupOptions, knownIds));
  const currentGroup = $derived(currentName ? (groupOptions.find((g) => g.name === currentName) ?? null) : null);
  /** 一覧のチェックから集計しているときの件数(記録にある id だけ。グループで絞り込み中は 0) */
  const adhocCount = $derived(currentName ? 0 : knownSelection(eff.ids, knownIds).size);
  const groupKey = (name: string): string => (data?.anonymized ? '' : name);
  // #group=X だけが残ったとき(手で編集した hash、相手に無い名前): あればその ids を補い、無ければ(グループの一覧が揃ってから)捨てる
  $effect(() => {
    if (!filter.group || filter.ids) return;
    if (eff.group) setFilter({ ids: groupIds(eff.group, knownIds) });
    else if (liveGroups !== null || !token) setFilter({ group: '' });
  });
  /** グループを選ぶ(null で「すべて」)。名前と、その時点の ids の両方を hash に書く。伏せ字版では名前を出さない */
  function pickGroup(name: string | null): void {
    if (!name) {
      setFilter({ ids: '', group: '' });
      return;
    }
    const g = groupOptions.find((x) => x.name === name);
    if (g) setFilter({ ids: groupIds(g, knownIds), group: groupKey(name) });
  }
  const selectedKnown = (): string[] => sessions.filter((s) => selected.has(s.id)).map((s) => s.id);
  /** 選んだセッションで新しいグループを作り、そのグループで絞り込む(失敗は呼び元が入力欄の下に出す) */
  async function createGroup(name: string, note: string): Promise<void> {
    const r = await api.create(token!, { name, note, ids: selectedKnown() });
    liveGroups = r.groups;
    setFilter({ ids: groupIds(r.group, knownIds), group: groupKey(name) });
  }
  /** 名前と説明を 1 回で直す(本文の見出しの「編集」)。改名したら hash の名前も追従させる */
  async function saveGroup(oldName: string, patch: { name?: string; note?: string }): Promise<void> {
    const r = await api.update(token!, oldName, patch);
    liveGroups = r.groups;
    if (patch.name && filter.group === oldName) setFilter({ group: patch.name });
  }
  /** グループのアップロード先(atlas.config.json の uploadRoot)。serve が教えてくれたときだけ操作を出す */
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
          check: (name) => api.checkUpload(token!, name),
          run: (name, expect) => api.uploadGroup(token!, name, expect),
          progress: (name) => api.uploadProgress(token!, name),
          open: async (name) => void (await api.openUpload(token!, name)),
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
  function exportGroup(name: string): Promise<GroupExport> {
    return api.exportGroup(token!, name);
  }
  async function deleteGroup(name: string): Promise<void> {
    // currentName は groups から求めるので、一覧を差し替える前に覚える(後で見ると消したグループはもう無く、絞り込みが残る)
    // 通信中に別のグループへ移っていたら(ids が変わっていたら)移った先の絞り込みは残す
    const wasCurrent = currentName === name;
    const idsBefore = filter.ids;
    const r = await api.remove(token!, name);
    liveGroups = r.groups;
    if (wasCurrent && filter.ids === idsBefore) setFilter({ ids: '', group: '' });
  }
  /**
   * 選んだセッションを既存のグループに足す。差分(add)だけを送り、サーバが最新の ids に適用する(画面を開いたまま CLI で足した id が消えない)。
   * 件数とグループの一覧はサーバの応答から。絞り込みは変えない(現在のグループに足したときだけ ids を追従させる)
   */
  async function addToGroup(name: string): Promise<string> {
    const res = await api.update(token!, name, { add: selectedKnown() });
    liveGroups = res.groups;
    const msg = `${int(res.added)} 件を「${name}」に追加しました${res.dup ? `(既に入っていた ${int(res.dup)} 件を除く)` : ''}`;
    if (currentName === name) {
      setFilter({ ids: groupIds(res.group, knownIds), group: groupKey(name) });
      return msg;
    }
    // 足し終えたチェックは外す(続けて別のグループに足すときに前の分が混ざらないように)。選んだ N 件で集計中なら条件は残す
    if (!filter.ids) {
      selected = new Set();
      return `${msg}。チェックは外しました`;
    }
    return msg;
  }
  /** 選んだセッションを現在のグループから外す(差分 remove を送る。0 件になっても消さない) */
  async function removeFromGroup(): Promise<string> {
    const name = currentName;
    if (!name) throw new Error('タスクタグで絞り込んでいるときだけ外せます');
    const res = await api.update(token!, name, { remove: selectedKnown() });
    liveGroups = res.groups;
    setFilter({ ids: groupIds(res.group, knownIds), group: groupKey(name) });
    return `${int(res.removed)} 件を「${name}」から外しました${res.group.ids.length === 0 ? '(タスクタグは 0 件のまま残ります)' : ''}`;
  }
  // 狭い幅(768px 未満)では目次行の「グループ」から一覧を開く。外を押す / Esc で閉じ、焦点はボタンに戻す
  let groupsOpen = $state(false);
  let groupsBtn = $state<HTMLButtonElement | null>(null);
  let groupsPop = $state<HTMLElement | null>(null);
  function toggleGroups(): void {
    groupsOpen = !groupsOpen;
    if (groupsOpen) requestAnimationFrame(() => groupsPop?.focus());
  }
  function closeGroups(back = true): void {
    if (!groupsOpen) return;
    groupsOpen = false;
    if (back) groupsBtn?.focus();
  }
  $effect(() => {
    if (!groupsOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (groupsPop?.contains(t) || groupsBtn?.contains(t)) return;
      closeGroups(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeGroups();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  });

  /** 効いている絞り込みの条件の数(期間は開始・終了で 1 つ、セッションの選択は 1 つ) */
  const activeConditions = $derived.by(() => {
    let n = filter.from || filter.to ? 1 : 0;
    for (const k of ['project', 'client', 'model', 'branch', 'coverage', 'taskCategory', 'tool', 'ids', 'memo'] as const) if (filter[k]) n++;
    if (filter.empty === '1') n++;
    return n;
  });

  /** 目次の 1 項目。id はページ内の節、href は別ページ */
  type TocItem = { id: string; label: string; href?: undefined } | { href: string; label: string; id?: undefined };
  /** 節の目次。広い画面(768px 以上)では左のサイドバー、狭い画面では上部の固定した 1 行。群で区切る(別ページは href) */
  const tocGroups = $derived.by((): { title: string; items: TocItem[] }[] => [
    {
      title: '概況',
      items: [
        { id: 'overview', label: '全体' },
        { id: 'highlights', label: '要点' },
        { id: 'insights', label: '改善点' },
        { id: 'phases', label: '工程と詰まり' },
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
    { title: '付録', items: [...(data?.library ? [{ href: 'instructions.html', label: '指示文と skill' }] : []), { href: 'glossary.html', label: '用語の説明' }] },
  ]);

  /** 読んでいる節(目次の現在地の印)。見出しが画面上部 1/3(固定行の下)を越えた最後の節 */
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
  // 戻る / 進む・再読み込みで別のページから開かれたら、離れたときのスクロール位置に戻す(描いてから。ブラウザに任せると描く前の短いページで先頭になる)。
  // 離れるときに今の位置を履歴の項目に書く(view-restore.ts)
  $effect(() => {
    const y = restoredView()?.y;
    // scrollRestoration は 'auto' のままにする('manual' にすると、目次や要点のリンクで移ってからの「戻る」でブラウザが位置を戻さなくなる)
    // effect の時点で本文は描き終わっているので、その場で戻す。後から高さが変わる(タスクタグの見出しが出るなど)ときのため、
    // 少し後にもう一度だけ合わせる(その間に自分でスクロールしたら合わせない)
    if (y != null && y > 0) {
      const go = (): void => window.scrollTo({ top: y, behavior: 'instant' });
      go();
      let moved = false;
      const stop = (): void => void (moved = true);
      addEventListener('wheel', stop, { once: true, passive: true });
      addEventListener('keydown', stop, { once: true });
      addEventListener('touchstart', stop, { once: true, passive: true });
      setTimeout(() => {
        if (!moved && Math.abs(window.scrollY - y) > 1) go();
        removeEventListener('wheel', stop);
        removeEventListener('keydown', stop);
        removeEventListener('touchstart', stop);
      }, 300);
    }
    restoreDone();
    const onHide = (): void => saveView({ y: window.scrollY });
    addEventListener('pagehide', onHide);
    return () => removeEventListener('pagehide', onHide);
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
          GitHub Copilot のセッションログの集計(LLM は使っていません)。生成 <span class="nw">{dateTime(data.generatedAt)}</span>・記録期間 <span class="nw">{date(all.overall.firstAt)}〜{date(all.overall.lastAt)}</span>。
          {#if filter.empty === '1'}記録 {int(sessions.length)} 件すべてを集計対象にしています(うち空のセッション {int(emptyCount)} 件)。{:else}記録 {int(sessions.length)} 件のうち {int(scoped.length)} 件を集計対象にしています(空のセッション {int(emptyCount)} 件を除外)。{/if}
        </p>
      </div>
      <div class="mast-tools">
        {#if editable && jobStore}<JobActions jobs={jobStore} disabled={serverDown} /><SettingsDialog jobs={jobStore} disabled={serverDown} upload={uploadHandlers} send={projectSend} projects={settingsProjects} /><OpenFolder token={jobStore.token} disabled={serverDown} />{/if}
        {#if sourceLabel}<span class="tag" title={sourceLabel.path} data-testid="source-tag">対象: {sourceLabel.name}</span>{/if}
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
          <div class="toc-group groups-toggle" role="group" aria-label="タスクタグ">
            <ol>
              <li>
                <button type="button" class="toc-btn" bind:this={groupsBtn} aria-expanded={groupsOpen} aria-controls="group-pop" data-testid="groups-toggle" onclick={toggleGroups}>
                  タスクタグ<span class="cnt">{int(groupOptions.length)}</span>
                </button>
              </li>
            </ol>
          </div>
        </nav>
        <!-- サイドバー(768px 以上)の「グループ」の群。狭い幅では目次行の「グループ」から同じ中身を開く -->
        <div class="rail-groups" role="group" aria-label="タスクタグ">
          <span class="toc-title" aria-hidden="true">タスクタグ</span>
          <GroupRail groups={groupOptions} current={currentName} selectedCount={adhocCount} {editable} anonymized={data.anonymized} onpick={pickGroup} />
        </div>
        {#if groupsOpen}
          <div class="group-pop" id="group-pop" role="region" bind:this={groupsPop} tabindex="-1" aria-label="タスクタグ" data-testid="group-pop" onfocusout={(e) => { const t = e.relatedTarget as Node | null; if (t && !groupsPop?.contains(t) && !groupsBtn?.contains(t)) closeGroups(false); }}>
            <GroupRail groups={groupOptions} current={currentName} selectedCount={adhocCount} {editable} anonymized={data.anonymized} onpick={(n) => { pickGroup(n); closeGroups(); }} />
          </div>
        {/if}
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
      <FilterBar {filter} {options} {judged} {emptyCount} {memoCount} lastDay={all.overall.lastAt ? date(all.overall.lastAt) : null} onchange={setFilter} {editable} anonymized={data.anonymized} />

      <main class="wrap" id="main" tabindex="-1">
        {#if currentGroup}
          <GroupHead group={currentGroup} {editable} onclear={() => pickGroup(null)} onsave={saveGroup} ondelete={deleteGroup} onexport={exportGroup} upload={uploadHandlers} />
        {/if}
        <div class="empty" class:show={filtered.length === 0} role="status">
          {#if filtered.length === 0}
            <p>この条件に合うセッションはありません。</p>
            <button type="button" class="btn" onclick={reset}>絞り込みを解除</button>
          {/if}
        </div>

        <!-- 帳票の順: 表紙(規模の 4 欄)→ 摘要(要点)→ 明細 -->
        <Overview part="cover" {agg} {judged} anonymized={data.anonymized} warnings={data.warnings} filtered={!isEmptyFilter(filter)} includeEmpty={filter.empty === '1'} {emptyCount} {emptyInFilter} {editable} />
        <Highlights groups={points} />
        <Insights sessions={filtered} allSessions={data.sessions} installed={data.installed?.skills ?? null} disabled={data.installed?.disabled ?? []} meta={data.insights?.meta ?? {}} candidates={data.insights?.candidates ?? []} candidateTotal={data.insights?.candidateTotal ?? data.insights?.candidates.length ?? 0} computedOver={data.insights?.computedOver ?? sessions.length} anonymized={data.anonymized} hasPage={true} libraryHref={data.library ? 'instructions.html' : null} />
        <TurnPhases agg={turnAgg} verdicts={verdictAgg} verdictModel={data.turnJudgments?.model ?? null} verdictRanAt={data.turnJudgments?.ranAt ?? null} {editable} anonymized={data.anonymized} />
        <Overview part="detail" {agg} {judged} anonymized={data.anonymized} warnings={data.warnings} filtered={!isEmptyFilter(filter)} includeEmpty={filter.empty === '1'} {emptyCount} {emptyInFilter} />
        {#if judged}<JudgmentPanel {agg} meta={data.judgments} />{/if}
        <UsageRanking usage={agg.usage} installed={data.installed ?? null} bind:tab={usageTab} />
        <ExecProfile exec={agg.exec} sessions={filtered.length} />
        <ProjectTable rows={agg.byProject} {judged} current={filter.project} onpick={(p) => setFilter({ project: p })} send={editable && !serverDown ? projectSend : undefined} />
        <MonthlyChart months={agg.byMonth} lastAt={all.overall.lastAt} />
        <ModelChart rows={agg.byModel} />
        <SessionTable
          sessions={filtered}
          {judged}
          anonymized={data.anonymized}
          {selected}
          idsActive={eff.ids !== ''}
          {editable}
          groups={groupOptions}
          currentGroup={currentName}
          onselect={(s) => (selected = s)}
          onapply={applySelection}
          onclear={clearSelection}
          oncreate={createGroup}
          onadd={addToGroup}
          onremove={removeFromGroup}
        />
      </main>
      <footer class="wrap foot">
        <p>
          このレポートはローカルのログ(~/.copilot)を複製して集計したもので、LLM は使っていません。入力トークン・AI 使用量(AIU)・premium request・変更行数は記録が残っているセッションだけの合計です。
          {#if data.warnings.unknownEventTypes > 0 || data.warnings.badLines > 0}
            読み取り時の注意: 未知のイベント種別 {int(data.warnings.unknownEventTypes)} 件、読めなかった行 {int(data.warnings.badLines)} 行。
          {/if}
          {#if data.warnings.notes?.length}
            メモとタスクタグ(atlas-notes)の読み取りで無視した箇所 {int(data.warnings.notes.length)} 件(全体サマリの集計明細に理由)。
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
  /* グループの群: 狭い幅では目次行の「グループ」ボタンから開く一覧(.group-pop)、768px 以上ではサイドバーの群(.rail-groups) */
  .rail-groups {
    display: none;
  }
  .toc-btn {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0;
    font: inherit;
    white-space: nowrap;
    color: var(--ink-2);
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .toc-btn:hover {
    color: var(--form);
    text-decoration: underline;
  }
  .toc-btn[aria-expanded='true'] {
    color: var(--form);
    font-weight: 600;
    border-bottom-color: var(--form);
  }
  .toc-btn .cnt {
    margin-left: 6px;
    color: var(--ink-3);
    font-size: 0.75rem;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .group-pop {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    max-width: 36em;
    margin: 0 auto;
    padding: 6px 0 8px;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-top: 0;
    box-shadow: 0 1px 0 var(--rule-strong);
    z-index: 7;
  }
  .group-pop:focus-visible {
    outline: 2px solid var(--form);
    outline-offset: -2px;
  }
  /* 狭い幅では目次行の先頭に置く(右端に隠れて気づけないのを避ける) */
  .groups-toggle {
    order: -1;
    margin-left: 0;
    padding-left: 0;
    border-left: 0;
    margin-right: 10px;
    padding-right: 10px;
    border-right: 1px solid var(--rule);
  }
  @media (min-width: 768px) {
    .groups-toggle,
    .group-pop {
      display: none;
    }
    .rail-groups {
      display: block;
      margin-top: 14px;
    }
    .rail-groups .toc-title {
      display: block;
      font-size: 0.6875rem;
      color: var(--form);
      letter-spacing: 0.04em;
      padding-bottom: 2px;
      border-bottom: 1px solid var(--rule-strong);
    }
  }
</style>
