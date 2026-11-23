<script lang="ts">
  import type { Bucket } from '../../lib/aggregate.ts';
  import { dateTime, dec, duration, int, pathParts, percent } from '../../lib/format.ts';
  import { confidenceLabel } from '../../lib/judgment-labels.ts';
  import { COMPARE_MIN_TURNS } from '../../lib/compare.ts';
  import { bucketVerdictView } from '../../lib/verdicts.ts';
  import { MISMATCH_LABEL } from '../../shared/turns.ts';
  import { wikiStateShortNote, type WikiState } from '../../lib/wiki.ts';
  import SortMark from './SortMark.svelte';

  let {
    rows,
    judged,
    current,
    onpick,
    send,
    kind = 'project',
    wiki = 'counted',
    verdicts = false,
  }: {
    rows: Bucket[];
    judged: boolean;
    /** llm-wiki の参照を数えた集計か(数えていなければ、wiki の列を出さずに理由を出す) */
    wiki?: WikiState;
    current: string;
    onpick: (project: string) => void;
    /** 何ごとの表か。person は、送り先をまとめて集計したときの人ごと(見出し・説明・絞り込みの先が変わる。まとめて送る印は出さない) */
    kind?: 'project' | 'person';
    /** 依頼ごとの判定(turn-judgments.json)があるか。人ごとの表にだけ、判定の列を出す(プロジェクトごとの表は列が多いので出さない) */
    verdicts?: boolean;
    /** upload-project.bat がまとめて送るプロジェクトの印(atlas serve から開いたときだけ)。projects は設定の一覧、error は設定ファイルを読めない理由、toggle は足す・外す */
    send?: { projects: string[]; error: string | null; toggle: (project: string, on: boolean) => Promise<void> };
  } = $props();

  type Key = 'label' | 'updated' | 'sessions' | 'input' | 'output' | 'tools' | 'lines' | 'skills' | 'agents' | 'hooks' | 'instructions' | 'wiki' | 'friction' | 'active' | 'human' | 'vjudged' | 'vadopt' | 'vfix' | 'vmismatch';
  /** 人ごとの表の、依頼ごとの判定の列(割合は判定できた作業の依頼が COMPARE_MIN_TURNS 件に届かなければ —) */
  const showVerdicts = $derived(kind === 'person' && verdicts);
  const vv = (b: Bucket) => bucketVerdictView(b.turnVerdicts, COMPARE_MIN_TURNS);
  /** 最終更新の時刻(日時の無いものは、新しい順で最後に来るように -Infinity) */
  const updatedMs = (b: Bucket): number => {
    const t = b.updatedAt ? Date.parse(b.updatedAt) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  const value: Record<Key, (b: Bucket) => number | string> = {
    label: (b) => b.label,
    updated: updatedMs,
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
    vjudged: (b) => b.turnVerdicts.judged,
    vadopt: (b) => vv(b).adoptRate ?? -1,
    vfix: (b) => vv(b).fixRate ?? -1,
    vmismatch: (b) => {
      const m = vv(b).topMismatch;
      return m ? MISMATCH_LABEL[m.key] : '￿';
    },
  };
  let sortKey = $state<Key>('output');
  let asc = $state(false);
  let expanded = $state(false);
  const LIMIT = 15;

  /** 書いている途中のプロジェクト(その印は押せないようにする) */
  let saving = $state<Set<string>>(new Set());
  let sendError = $state<string | null>(null);
  const sendSet = $derived(new Set(send?.projects ?? []));
  /** 印はあるが、行に無いもの(絞り込みの外か、今の集計に無いもの。折りたたんで見えないだけの行は数えない) */
  const sendHidden = $derived(send ? send.projects.filter((x) => !rows.some((b) => b.key === x)).length : 0);
  async function toggleSend(e: Event, key: string): Promise<void> {
    if (!send) return;
    const box = e.currentTarget as HTMLInputElement;
    const on = box.checked;
    saving = new Set([...saving, key]);
    sendError = null;
    try {
      await send.toggle(key, on);
    } catch (err) {
      // 書けなければ印を元に戻す(設定の一覧は変わっていないので、表示だけ戻す)
      box.checked = !on;
      sendError = `「${key}」の印を${on ? '付けられ' : '外せ'}ませんでした: ${(err as Error).message}`;
    } finally {
      const next = new Set(saving);
      next.delete(key);
      saving = next;
    }
  }

  const sorted = $derived.by(() => {
    const f = value[sortKey];
    const dir = asc ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      // 日時の無いもの(-Infinity)どうしの差は NaN になるので、同じとみなす
      const c = typeof x === 'string' ? x.localeCompare(y as string, 'ja') : x === y ? 0 : x - (y as number);
      return c * dir || a.key.localeCompare(b.key);
    });
  });
  const visible = $derived(expanded ? sorted : sorted.slice(0, LIMIT));

  function sortBy(k: Key): void {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = k === 'label' || k === 'vmismatch';
    }
  }
  /** wiki の参照を数えていない集計の短い断り(このときは wiki の列を出さず、並べ替えの対象にもしない。理由の全文は集計明細) */
  const wikiNote = $derived(wikiStateShortNote(wiki));
  const cols: { key: Key; label: string; title?: string }[] = $derived([
    { key: 'updated', label: '最終更新', title: 'いちばん後に更新されたセッションの日時' },
    { key: 'sessions', label: 'セッション' },
    { key: 'input', label: '入力トークン', title: '記録のあるセッションだけの合計' },
    { key: 'output', label: '出力トークン' },
    { key: 'tools', label: 'ツール' },
    { key: 'lines', label: '変更行', title: '追加 / 削除の行数。記録のあるセッションだけの合計' },
    { key: 'skills', label: 'skill' },
    { key: 'agents', label: 'agent' },
    { key: 'hooks', label: 'hook' },
    { key: 'instructions', label: '指示', title: '指示ファイルが注入されたセッション数' },
    ...(wikiNote ? [] : [{ key: 'wiki' as const, label: 'wiki', title: 'llm-wiki を参照したセッション数(書き込みだけのセッションは入れない)' }]),
    { key: 'friction', label: '摩擦' },
    { key: 'active', label: '実働(中央値)' },
    ...(showVerdicts
      ? [
          { key: 'vjudged' as const, label: '判定した依頼', title: '依頼ごとの判定(LLM の推定)をした依頼の数(判定不能を含む)' },
          { key: 'vadopt' as const, label: '採用率', title: `判定できた作業の依頼のうち「そのまま採用」の割合。判定できた作業の依頼が ${COMPARE_MIN_TURNS} 件未満なら —` },
          { key: 'vfix' as const, label: '直しの割合', title: `判定できた作業の依頼のうち、中身か体裁を直させた割合。判定できた作業の依頼が ${COMPARE_MIN_TURNS} 件未満なら —` },
          { key: 'vmismatch' as const, label: '合わなかった点(最多)', title: `直し・不採用・的外れの理由のいちばん多いもの。判定した依頼が ${COMPARE_MIN_TURNS} 件未満なら —` },
        ]
      : []),
  ]);
  const ariaSort = (k: Key): 'ascending' | 'descending' | 'none' => (sortKey === k ? (asc ? 'ascending' : 'descending') : 'none');

  /** 見出しの id・呼び名・絞り込みのキー(プロジェクトごとと人ごとで変わるところ) */
  const t = $derived(
    kind === 'person'
      ? { id: 'people', heading: '人別', noun: '人', param: 'person' }
      : { id: 'projects', heading: 'プロジェクト別', noun: 'プロジェクト', param: 'project' },
  );
  /** そのプロジェクト(人)だけに絞った状態の URL(新しいタブでも開ける)。クリックは親に任せて他の条件を保つ */
  const projectHref = (key: string): string => `#${t.param}=${encodeURIComponent(key)}`;
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

<section class="section" id={t.id} aria-labelledby="{t.id}-h">
  <div class="section-head">
    <h2 id="{t.id}-h">{t.heading}</h2>
    {#if kind === 'person'}
      <p>
        {int(rows.length)} 人。送り先のフォルダ(<code>&lt;人&gt;/&lt;プロジェクト&gt;</code>)の、人のフォルダの名前ごとの内訳です。名前を押すとその人に絞り込みます(列見出しで並べ替え)。列の読み方は下の「プロジェクト別」と同じです。人のフォルダの下に無いセッションは「不明」にまとめています。{#if showVerdicts}<span data-testid="people-verdict-note">判定した依頼・採用率・直しの割合・合わなかった点(最多)は、依頼ごとの判定(LLM の推定)から数えたもので、採用率と直しの割合は判定できた作業の依頼に対する割合です(判定できた作業の依頼が {COMPARE_MIN_TURNS} 件未満なら「—」。合わなかった点は判定した依頼が {COMPARE_MIN_TURNS} 件未満なら「—」)。推定人手工数とは別の列で、1 つの点数にしません。</span>{/if}
      </p>
    {:else}
      <p>
        {int(rows.length)} プロジェクト。名前を押すとそのプロジェクトに絞り込みます(列見出しで並べ替え)。{wikiNote ? '指示の列' : '指示・wiki の列'}は「該当セッション数 / セッション数」、入力トークン・変更行の下の小さい分数は「記録のあるセッション数 / セッション数」(合計はその記録のあるセッションだけのもの)。リポジトリ名の記録が無いものは git のリモート(owner/repo)で束ね、ホーム・一時フォルダ・atlas の判定実行はそれぞれ 1 つにまとめています。
      </p>
    {/if}
  </div>
  {#if wikiNote}<p class="wiki-off" data-testid="{t.id}-wiki-off">{wikiNote}</p>{/if}
  {#if send}
    {#if send.error}
      <!-- 読めない設定では今の印が分からないので、印を 0 件と見せずに理由を出し、押せないようにする -->
      <p class="send-error" role="alert" data-testid="project-send-config-error">
        設定ファイルを読めないので、<code>upload-project.bat</code> でまとめて送る印を出せません({send.error})。<code>setup.bat</code> で作り直すか手で直してから、画面を開き直してください。
      </p>
    {:else}
      <p class="send-note">
        「まとめて送る」に印を付けたプロジェクトは、<code>upload-project.bat</code> が番号を聞かずにまとめて送ります(送る前に確かめます)。今 {int(send.projects.length)} 件{#if sendHidden}(うち {int(sendHidden)} 件は、絞り込みの外か、今の集計に無いもの){/if}。印は <code>atlas.config.json</code> に残ります。
      </p>
    {/if}
    {#if sendError}<p class="send-error" role="alert">{sendError}</p>{/if}
  {/if}
  {#if rows.length === 0}
    <p class="note">該当する{t.noun}はありません。</p>
  {:else}
    <div class="table-scroll">
      <table class="ledger">
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort('label')}>
              <button type="button" class="sort" onclick={() => sortBy('label')}>{t.noun}<SortMark state={sortKey === 'label' ? (asc ? 'asc' : 'desc') : 'none'} /></button>
            </th>
            {#if send}<th scope="col" class="send" title="upload-project.bat がまとめて送るプロジェクト">まとめて送る</th>{/if}
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
              {#if send}
                <td class="send">
                  <input type="checkbox" checked={sendSet.has(b.key)} disabled={saving.has(b.key) || !!send.error} aria-label={`「${b.label}」を upload-project.bat でまとめて送る`} onchange={(e) => toggleSend(e, b.key)} />
                </td>
              {/if}
              <td class="num when">{dateTime(b.updatedAt, '—')}</td>
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
              {#if !wikiNote}<td class="num">{int(b.sessionsWithWiki)}/{int(b.sessions)}</td>{/if}
              <td class="num">{int(b.friction)}{#if b.friction > 0}<span class="part">{frictionNote(b)}</span>{/if}</td>
              <td class="num">{duration(b.activeMedianMs, '—')}</td>
              {#if showVerdicts}
                {@const v = vv(b)}
                <td class="num" data-testid="person-verdict-judged">{int(v.judged)}</td>
                <td class="num" data-testid="person-verdict-adopt">{v.adoptRate == null ? '—' : percent(v.adoptRate, 1)}{#if b.turnVerdicts.workDecided}<span class="part">{int(b.turnVerdicts.asIs)} / {int(b.turnVerdicts.workDecided)}</span>{/if}</td>
                <td class="num" data-testid="person-verdict-fix">{v.fixRate == null ? '—' : percent(v.fixRate, 1)}{#if b.turnVerdicts.workDecided}<span class="part">{int(b.turnVerdicts.fix)} / {int(b.turnVerdicts.workDecided)}</span>{/if}</td>
                <td class="mismatch" data-testid="person-verdict-mismatch">{#if v.topMismatch}{MISMATCH_LABEL[v.topMismatch.key]}<span class="part">{int(v.topMismatch.count)} 件</span>{:else}—{/if}</td>
              {/if}
              {#if judged}
                <td class="num" title={b.judgedSessions ? `LLM による推定。判定済み ${b.judgedSessions} / ${b.sessions} セッション${b.humanSessions ? `、幅 ${dec(b.humanLow)}〜${dec(b.humanHigh)} 時間` : ''}${b.humanUncertain.sessions ? `。確信度の低い推定 ${b.humanUncertain.sessions} セッション(計 ${dec(b.humanUncertain.hours)} 時間)は入れていません` : ''}` : ''}>
                  {#if b.humanSessions}{dec(b.humanHours)} 時間<span class="part">{b.judgedSessions}/{b.sessions}・{confidenceLabel(b.judgedConfidence)}</span>{:else if b.judgedSessions}—<span class="part">{b.judgedSessions}/{b.sessions}・確信度の低い推定のみ</span>{:else}<span class="missing-value">未判定</span>{/if}
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
  .when {
    white-space: nowrap;
  }
  .mismatch {
    white-space: nowrap;
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
  .send-note {
    margin: 0 0 8px;
    color: var(--ink-2);
  }
  /* 節の説明文(.section-head p)と同じ大きさ */
  .wiki-off {
    margin: 0 0 8px;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .send-error {
    margin: 0 0 8px;
    color: var(--warn);
  }
  th.send,
  td.send {
    text-align: center;
    white-space: nowrap;
  }
  td.send input {
    width: 20px;
    height: 20px;
    margin: 2px;
  }
  /* 書き込み中は押せない(共通の「使えない状態は矢印」より、待っていることを示す) */
  td.send input:disabled {
    cursor: progress;
  }
</style>
