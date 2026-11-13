<script lang="ts">
  import { frictionTotal } from '../../lib/aggregate.ts';
  import { sessionTime } from '../../lib/filter.ts';
  import { dateTime, dec, duration, int, modelLabel, pathParts, sharedLeads, splitLead, truncate } from '../../lib/format.ts';
  import type { ReportGroup, SessionSummary } from '../../lib/types.ts';
  import SortMark from './SortMark.svelte';
  import { restoredView, saveView } from '../view-restore.ts';
  import { categoryLabel, confidenceLabel } from '../../lib/judgment-labels.ts';

  let {
    sessions,
    judged,
    anonymized,
    selected,
    idsActive,
    editable,
    readOnly = false,
    groups,
    currentGroup,
    onselect,
    onapply,
    onclear,
    oncreate,
    onadd,
    onremove,
  }: {
    sessions: SessionSummary[];
    judged: boolean;
    anonymized: boolean;
    /** チェックしたセッション id(画面内だけ。保存しない) */
    selected: Set<string>;
    /** 「選んだセッションだけ集計」が効いているか(filter.ids) */
    idsActive: boolean;
    onselect: (ids: Set<string>) => void;
    /** 選んだものだけで集計する(filter.ids に入れる) */
    onapply: () => void;
    /** 選択を外す(集計中ならその条件も外す) */
    onclear: () => void;
    /** atlas serve から開いていて、グループを作れる */
    editable: boolean;
    /** 読むだけの画面(タスクタグは送った人が付けたもの。ここでは付けられない) */
    readOnly?: boolean;
    /** 選んだセッションでグループを作る(失敗は例外。理由を入力欄の下に出す) */
    oncreate: (name: string, note: string) => Promise<void>;
    /** 既存のグループ(「グループに追加」の一覧) */
    groups: (ReportGroup & { present: number })[];
    /** 現在のグループ名(グループで絞り込み中。「このグループから外す」が出る) */
    currentGroup: string | null;
    /** 選んだセッションを既存のグループに足す。結果の一文を返す */
    onadd: (name: string) => Promise<string>;
    /** 選んだセッションを現在のグループから外す。結果の一文を返す */
    onremove: () => Promise<string>;
  } = $props();

  /** 変更行の欄の title(出所と、記録が欠けている理由) */
  function linesTitle(l: SessionSummary['lines']): string {
    const why = l.note === 'subagent-edits' ? 'サブエージェントの変更は数えられない' : l.note === 'empty-shutdown' ? '終了時の codeChanges が空' : '';
    const src = l.source === 'shutdown' ? '終了時の累計(codeChanges)' : l.source === 'tools' ? 'ツールごとの行数の合計' : '';
    return src && why ? `${src}(${why})` : src || why;
  }

  type Key = 'time' | 'turns' | 'input' | 'output' | 'tools' | 'lines' | 'friction' | 'active' | 'human';
  const value: Record<Key, (s: SessionSummary) => number> = {
    time: (s) => sessionTime(s) ?? -Infinity,
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
  $effect(() => {
    const onHide = (): void => saveView({ table: { sortKey, asc, page } });
    addEventListener('pagehide', onHide);
    return () => removeEventListener('pagehide', onHide);
  });
  const PAGE = 50;

  const sorted = $derived.by(() => {
    const f = value[sortKey];
    const dir = asc ? 1 : -1;
    return [...sessions].sort((a, b) => (f(a) - f(b)) * dir || a.id.localeCompare(b.id));
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

  const rawTitle = (s: SessionSummary): string => s.name || s.firstUserMessage || `(名前なし) ${s.id.slice(0, 8)}`;
  function title(s: SessionSummary): string {
    if (anonymized) return `セッション ${s.id.slice(0, 8)}`;
    return truncate(rawTitle(s), 80);
  }

  /**
   * 書き出しが同じ行の見分け(一覧の全行で比べる。ページをめくっても変わらない)。
   * 共通の書き出しは先頭だけ残して「…」に縮め、違いが始まるところから見せる。題名がまったく同じ行には件数の印を付ける
   */
  const leads = $derived.by(() => {
    const m = new Map<string, { lead: string | null; rest: string; same: number }>();
    if (anonymized) return m;
    const texts = sessions.map(rawTitle);
    sharedLeads(texts).forEach((x, i) => {
      if (x.cut === 0 && x.same < 2) return;
      m.set(sessions[i].id, x.cut > 0 ? { ...splitLead(texts[i], x.cut, 70), same: x.same } : { lead: null, rest: title(sessions[i]), same: x.same });
    });
    return m;
  });

  /** セッション id → 入っているグループの名前(行の下に「グループ: …」と出す。伏せ字版では出さない) */
  const groupsOf = $derived.by(() => {
    const m = new Map<string, string[]>();
    if (anonymized) return m;
    for (const g of groups) for (const id of g.ids) m.set(id, [...(m.get(id) ?? []), g.name]);
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

  // --- 「グループを作成」: 名前と説明の入力欄をインラインで開き、作成を押すと API で保存される(ダイアログは出さない) ---
  let createOpen = $state(false);
  let newName = $state('');
  let newNote = $state('');
  let createError = $state('');
  let busy = $state(false);
  let nameEl = $state<HTMLInputElement | null>(null);
  let createBtn = $state<HTMLButtonElement | null>(null);
  function openCreate(): void {
    createError = '';
    createOpen = true;
    requestAnimationFrame(() => nameEl?.focus());
  }
  function cancelCreate(): void {
    createOpen = false;
    createError = '';
    requestAnimationFrame(() => createBtn?.focus());
  }
  async function submitCreate(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const name = newName.trim();
    if (!name) {
      // 空でも送れる(無効にしない)。理由を入力欄の下に出して戻す
      createError = '名前を入れてください';
      nameEl?.focus();
      return;
    }
    busy = true;
    createError = '';
    try {
      await oncreate(name, newNote.trim());
      createOpen = false;
      newName = '';
      newNote = '';
      requestAnimationFrame(() => createBtn?.focus());
    } catch (err) {
      createError = (err as Error).message;
      requestAnimationFrame(() => nameEl?.focus());
    } finally {
      busy = false;
    }
  }
  // サーバが止まったら(editable が外れたら)開いていた入力欄も閉じる
  $effect(() => {
    if (!editable) {
      createOpen = false;
      menuOpen = false;
    }
  });

  // --- 「グループに追加 ▾」: 既存グループの一覧(末尾に「新しいグループ…」)。1 回で追加し、絞り込みは変えず結果を短く出す ---
  let menuOpen = $state(false);
  let menuBtn = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLElement | null>(null);
  let status = $state('');
  let statusError = $state(false);
  let working = $state(false);
  function toggleMenu(): void {
    menuOpen = !menuOpen;
    if (menuOpen) requestAnimationFrame(() => menuEl?.querySelector<HTMLButtonElement>('button')?.focus());
  }
  function closeMenu(back = true): void {
    if (!menuOpen) return;
    menuOpen = false;
    if (back) menuBtn?.focus();
  }
  $effect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (menuEl?.contains(t) || menuBtn?.contains(t)) return;
      closeMenu(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu();
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menuEl) {
        const items = [...menuEl.querySelectorAll<HTMLButtonElement>('button')];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const n = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[n]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  });
  async function report(action: () => Promise<string>): Promise<void> {
    if (working) return;
    working = true;
    status = '';
    try {
      status = await action();
      statusError = false;
    } catch (e) {
      status = (e as Error).message;
      statusError = true;
    } finally {
      working = false;
    }
  }
  function pickAdd(name: string): void {
    closeMenu();
    void report(() => onadd(name));
  }
  function pickNew(): void {
    closeMenu(false);
    openCreate();
  }
</script>

<section class="section" id="sessions" aria-labelledby="sessions-h">
  <div class="section-head">
    <h2 id="sessions-h">セッション一覧</h2>
    <p>
      {int(sessions.length)} セッション。名前を押すと詳細(時系列・ツール内訳・指示ファイル・摩擦)を開きます。表は横にスクロールできます。
      {#if !judged}推定人手工数は未判定です(LLM による判定を実行すると表示されます)。{/if}
    </p>
  </div>

  <!-- 選択の操作列: チェックした件数と、その件数だけで集計 / 解除 / グループとして保存 -->
  <div class="select-bar" role="group" aria-label="セッションの選択">
    <p class="sel-count">
      <span aria-live="polite" aria-atomic="true"><strong data-testid="selected-count">{int(selected.size)}</strong> 件を選択中</span>{#if idsActive}<span class="tag on">この選択で集計中</span>{/if}
      {#if selected.size === 0}<span class="why">{editable ? '左端の欄にチェックを付けると、そのセッションだけで集計し直したり、タスクタグを付けられます。' : '左端の欄にチェックを付けると、そのセッションだけで集計し直せます。'}</span>{/if}
    </p>
    <div class="sel-actions">
      <button type="button" class="btn" data-testid="apply-selection" disabled={selected.size === 0} onclick={onapply}>選んだ {int(selected.size)} 件だけ集計</button>
      <!-- 選択で集計中は 0 件でも押せる(記録に無い id だけのグループを選んだときに条件を外す手段を残す) -->
      <button type="button" class="btn" disabled={selected.size === 0 && !idsActive} onclick={onclear}>選択を解除</button>
      {#if editable}
        <span class="menu-wrap">
          <button type="button" class="btn" data-testid="add-to-group" bind:this={menuBtn} disabled={selected.size === 0 || createOpen} aria-expanded={menuOpen} aria-controls="add-menu" onclick={toggleMenu}>タスクタグを付ける <span aria-hidden="true">▾</span></button>
          {#if menuOpen}
            <div class="menu" id="add-menu" bind:this={menuEl} role="group" aria-label="付けるタスクタグ" data-testid="add-menu" onfocusout={(e) => { const t = e.relatedTarget as Node | null; if (t && !menuEl?.contains(t) && !menuBtn?.contains(t)) closeMenu(false); }}>
              {#each groups as g (g.name)}
                <button type="button" class="item" onclick={() => pickAdd(g.name)}>{g.name}<span class="cnt" aria-hidden="true">{g.present === g.ids.length ? int(g.ids.length) : `${int(g.present)} / ${int(g.ids.length)}`}</span><span class="sr-only">{int(g.present)} 件</span></button>
              {/each}
              <button type="button" class="item new" data-testid="create-group" onclick={pickNew}>新しいタスクタグ…</button>
            </div>
          {/if}
        </span>
        {#if currentGroup}
          <button type="button" class="btn" data-testid="remove-from-group" disabled={selected.size === 0} onclick={() => void report(onremove)}>このタスクタグを外す</button>
        {/if}
      {:else if readOnly}
        <span class="how" data-testid="readonly-how">読むだけの画面です。タスクタグは送った人が付けたものを出し、ここでは付けられません</span>
      {:else if !anonymized}
        <span class="how">このファイルは閲覧用です。タスクタグは atlas.bat から開いたときに付けられます</span>
      {/if}
    </div>
  </div>
  {#if editable}
    <!-- live 領域は常に置いておき、文だけ差し替える(後から挿入すると読み上げられない)。高さも確保して表を押し下げない -->
    <p class="status-line" class:bad={statusError} role="status" data-testid="group-status">{status}</p>
  {/if}
  {#if createOpen && editable}
    <form class="create-box" data-testid="create-form" aria-label="タスクタグの作成" aria-busy={busy} onsubmit={submitCreate}>
      <p class="create-lead">選んだ {int(selected.size)} 件にタスクタグを付けます(atlas-notes/groups.json に保存され、左の「タスクタグ」(狭い画面では目次の行の「タスクタグ」)から選べます)。</p>
      <div class="create-row">
        <label class="fld"><span class="k">名前</span><input type="text" bind:this={nameEl} bind:value={newName} maxlength="100" readonly={busy} aria-invalid={createError ? 'true' : undefined} aria-describedby={createError ? 'create-error' : undefined} placeholder="例: 11 月の調査" /></label>
        <label class="fld wide"><span class="k">説明(任意)</span><input type="text" bind:value={newNote} maxlength="200" readonly={busy} placeholder="何のタスクか" /></label>
        <button type="submit" class="btn" aria-disabled={busy}>{busy ? '作成中…' : '作成'}</button>
        <button type="button" class="btn" onclick={cancelCreate} aria-disabled={busy}>取消</button>
      </div>
      {#if createError}<p class="err" id="create-error" role="alert">{createError}</p>{/if}
    </form>
  {/if}

  {#if sessions.length > 0}
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
              <td class="proj" title={s.project}>{#each pathParts(s.projectLabel) as seg, i (i)}{#if i}<wbr />{/if}{seg}{/each}{#if s.branch}<span class="sub">{s.branch}</span>{/if}</td>
              <td class="name"><a href={s.href} title={title(s)}>{#if leads.get(s.id)?.lead}<span class="lead" title="ほかの行と同じ書き出し(縮めて表示)">{leads.get(s.id)?.lead}</span>{leads.get(s.id)?.rest}{:else}{title(s)}{/if}</a>{#if (leads.get(s.id)?.same ?? 1) > 1}<span class="tag" title="一覧の中に題名がまったく同じセッションが {leads.get(s.id)?.same} 件あります。開始時刻やプロジェクトで見分けてください">同じ題名 ×{leads.get(s.id)?.same}</span>{/if}{#if s.empty}<span class="tag" title="依頼・ツール呼び出し・応答がどれも無いセッション">空</span>{/if}{#if s.memo}<span class="sub" data-testid="memo-excerpt">メモ: {s.memo.excerpt || '(本文なし)'}</span>{/if}{#if groupsOf.has(s.id)}<span class="sub in-groups" data-testid="session-groups">タスクタグ: {groupsOf.get(s.id)?.join('、')}</span>{/if}</td>
              <td class="nowrap">{s.client ?? '不明'}</td>
              <td class="models" title={s.models.join('、')}>{s.models.length ? s.models.map(modelLabel).join('、') : '不明'}</td>
              <td class="num">{int(s.turns)}</td>
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
                {#if s.judgment?.hours != null}<span title={s.judgment.low != null && s.judgment.high != null ? `LLM による推定。幅 ${dec(s.judgment.low)}〜${dec(s.judgment.high)} 時間` : 'LLM による推定'}>{dec(s.judgment.hours)} 時間</span><span class="sub">{categoryLabel(s.judgment.taskCategory)}・{confidenceLabel(s.judgment.confidence)}</span>{:else}<span class="missing-value">未判定</span>{/if}
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
    cursor: pointer;
  }
  .chk input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--form);
    cursor: pointer;
  }
  tr.picked td {
    background: var(--form-wash);
  }

  .how {
    font-size: 0.75rem;
    color: var(--ink-3);
    align-self: center;
  }
  /* 「グループに追加 ▾」の一覧(ボタンの下に開く。外を押す / Esc で閉じる) */
  .menu-wrap {
    position: relative;
    display: inline-block;
  }
  /* ボタンは操作列の右端にあるので、メニューは右端を揃えて左へ開く(左揃えだと画面の右にはみ出してページが横に流れる) */
  .menu {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 5;
    min-width: 16em;
    max-width: 28em;
    max-height: 40vh;
    overflow-y: auto;
    margin-top: 2px;
    background: var(--surface);
    border: 1px solid var(--form);
    display: flex;
    flex-direction: column;
  }
  .item {
    display: flex;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    min-height: 30px;
    padding: 4px 10px;
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    color: var(--ink);
    background: none;
    border: 0;
    border-bottom: 1px solid var(--rule);
    cursor: pointer;
  }
  .item:hover {
    background: var(--form-wash);
  }
  .item .cnt {
    margin-left: auto;
    color: var(--ink-3);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .item.new {
    color: var(--form);
    border-bottom: 0;
  }
  .status-line {
    margin: 4px 0 0;
    min-height: 1.25rem;
    font-size: 0.8125rem;
    color: var(--form);
  }
  .status-line.bad {
    color: var(--warn);
  }

  /* グループを作成: 名前と説明をインラインで(帳票の記入欄と同じ 1px の枠) */
  .create-box {
    margin-top: 8px;
    padding: 10px 12px;
    border: 1px solid var(--form);
    background: var(--surface);
  }
  .create-lead {
    margin: 0 0 8px;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .create-row {
    display: flex;
    align-items: flex-end;
    gap: 6px 12px;
    flex-wrap: wrap;
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
  .fld.wide input {
    width: 28em;
  }
  .create-row .btn {
    height: 30px;
    padding: 3px 12px;
  }
  .err {
    margin: 6px 0 0;
    font-size: 0.75rem;
    color: var(--warn);
  }
</style>
