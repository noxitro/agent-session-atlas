<script lang="ts">
  // 判定ダイアログの「チャットに貼る」(M365 Copilot など、ファイルの添付と貼り付けしかできない相手)。
  // 1. 未判定のセッションだけで添付ファイル(bundle/parts/)を作る(bundle のジョブ。LLM は呼ばない)
  // 2. 次のファイルを保存(またはコピー)して、依頼文と一緒にチャットへ渡す
  // 3. 返答をまるごと貼って取り込む(judgments.json。形が合わなければ何も書かず、どこが違うかを出す)
  // 4. レポートに反映する(export のジョブ)
  // どの手順も AI クレジットを使わない(判定するのはチャットの側)。
  // target が turns なら依頼ごとの判定(turn-bundle/・turn-judgments.json。件数は依頼の数)。
  import { tick } from 'svelte';
  import { chatJudgeApi, ChatImportError, jobsApi, type ChatPart, type ChatParts, type JudgeTarget } from '../api.ts';
  import type { JobStore } from '../jobs.svelte.ts';
  import { dateTime, int } from '../../lib/format.ts';

  // reply は親(JobActions)が判定するものごとに持つ(判定するものを切り替えても貼りかけの返答が消えないように)
  let { jobs, onclose, target = 'effort', reply = $bindable('') }: { jobs: JobStore; onclose: () => void; target?: JudgeTarget; reply?: string } = $props();
  /** 数える単位(工数はセッション、依頼ごとの判定は依頼) */
  const unit = $derived(target === 'turns' ? '依頼' : 'セッション');
  const bundleKind = $derived(target === 'turns' ? 'turn-bundle' : 'bundle');

  /** チャットに添付ファイルと一緒に送る依頼文 */
  const REQUEST = '添付したファイルの指示に従って判定し、JSON を返してください。';
  /** 取り込みの失敗で並べる項目の上限 */
  const PROBLEMS_MAX = 8;

  let info = $state<ChatParts | null>(null);
  let pending = $state<number | null>(null);
  /** 依頼ごとの記録が無いセッション(依頼の判定のとき。古い集計) */
  let withoutTurns = $state(0);
  let loadError = $state('');
  let importing = $state(false);
  let result = $state('');
  let importError = $state<{ message: string; problems: string[] } | null>(null);
  let imported = $state(0);
  let copied = $state('');
  let copyError = $state('');
  let resultEl = $state<HTMLParagraphElement | null>(null);

  const parts = $derived(info?.parts ?? []);
  const doneParts = $derived(parts.filter((p) => p.judged >= p.sessions).length);
  const next = $derived(parts.find((p) => p.judged < p.sessions) ?? null);
  const bundling = $derived(jobs.running && jobs.job?.kind === bundleKind);
  const off = $derived(jobs.running || jobs.busy);

  async function load(): Promise<void> {
    loadError = '';
    try {
      const [p, pre] = await Promise.all([chatJudgeApi.parts(jobs.token, target), jobsApi.judgePreview(jobs.token, target)]);
      info = p;
      pending = pre.pending;
      withoutTurns = pre.withoutTurns ?? 0;
    } catch (e) {
      loadError = (e as Error).message;
    }
  }
  void load();

  // 添付ファイルを作るジョブが終わったら一覧を読み直す(開いたときにもう終わっていたジョブでは読み直さない。null はまだ見ていない)
  let seen: string | null = null;
  $effect(() => {
    const j = jobs.job;
    const key = j && j.kind === bundleKind && j.state !== 'running' ? `${j.id}:${j.state}` : '';
    if (seen === null || seen === key) {
      seen = key;
      return;
    }
    seen = key;
    if (key) void load();
  });

  async function makeBundle(): Promise<void> {
    result = '';
    importError = null;
    await jobs.run({ kind: bundleKind });
  }

  async function copy(what: string, text: () => Promise<string> | string): Promise<void> {
    copied = '';
    copyError = '';
    try {
      await navigator.clipboard.writeText(await text());
      copied = what;
    } catch (e) {
      copyError = `コピーできませんでした(${(e as Error).message})。ファイルを保存して添付してください。`;
    }
  }
  const copyPart = (p: ChatPart): Promise<void> => copy(`${stem(p)} の本文`, () => chatJudgeApi.partText(jobs.token, p.name, target));
  /** 保存するときの名前(相手のチャットが .md を添付として受け付けるか分からないので、受け付けられやすい .txt にする。中身は同じ) */
  const saveName = (p: ChatPart): string => `${target === 'turns' ? 'turns-' : ''}${p.name.replace(/\.md$/, '.txt')}`;
  /** 画面に出す名前は保存する名前から拡張子を除いたもの(案内の名前とダウンロードフォルダの名前をそろえる) */
  const stem = (p: ChatPart): string => saveName(p).replace(/\.txt$/, '');
  const kb = (b: number): string => `${Math.max(1, Math.round(b / 1024))} KB`;
  const partState = (p: ChatPart): string => (p.judged >= p.sessions ? '済' : p.judged > 0 ? `${p.judged}/${p.sessions} 件済` : '未');

  async function importReply(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!reply.trim() || importing) return;
    importing = true;
    result = '';
    importError = null;
    try {
      const r = await chatJudgeApi.importText(jobs.token, reply, target);
      info = r.parts;
      imported += r.imported;
      if (pending != null) pending = Math.max(0, pending - (r.imported - r.overwritten));
      reply = '';
      const extra = [r.overwritten ? `判定し直し ${int(r.overwritten)} 件` : '', r.unknownIds.length ? `集計に無い${unit} ${int(r.unknownIds.length)} 件(レポートには出ません)` : ''].filter(Boolean).join('、');
      result = `${int(r.imported)} 件を取り込みました${extra ? `(${extra})` : ''}。`;
      // 送信ボタンが無効になって焦点が消えるので、結果の文へ移す(続けて Tab で次の手順へ進める)
      await tick();
      resultEl?.focus();
    } catch (err) {
      importError = { message: (err as Error).message, problems: err instanceof ChatImportError ? err.problems : [] };
    } finally {
      importing = false;
    }
  }

  /** 取り込めなかった理由を 1 行ずつ(チャットに貼って直してもらう) */
  const copyProblems = (): string => (importError?.problems ?? []).map((p) => `- ${p}`).join(String.fromCharCode(10));

  async function reflect(): Promise<void> {
    if (await jobs.run({ kind: 'export' })) onclose();
  }
</script>

<div class="chat" data-testid="chat-judge">
  <p class="lead">ファイルの添付と貼り付けしかできないチャット(M365 Copilot など)で判定し、結果をここに取り込みます。判定するのはチャットの側なので、このツールは AI クレジットを使いません。</p>
  <p class="note">添付ファイルには依頼文・最終応答・パス・リポジトリ名がそのまま入ります(伏せ字になりません)。渡してよい相手か確かめてから使ってください。</p>

  <ol class="steps">
    <li>
      <h3>添付ファイルを作る</h3>
      <p class="state" data-testid="chat-bundle-state">
        {#if loadError}読み込めませんでした: {loadError}
        {:else if !info}読み込んでいます…
        {:else if !info.exists || parts.length === 0}まだ作っていません。
        {:else}<strong>作成済み</strong>: {dateTime(info.generatedAt)}({info.unjudgedOnly ? '未判定だけ' : '全件'}、{int(parts.length)} ファイル)。取り込み済み <strong>{int(doneParts)}</strong> / {int(parts.length)} ファイル。次の手順 2 へ進んでください。{/if}
      </p>
      <button type="button" class="btn" disabled={off || pending === 0} data-testid="chat-bundle" onclick={makeBundle}>
        {bundling
          ? '作っています…'
          : pending == null
            ? `未判定の${unit}で作る`
            : pending === 0
              ? `未判定の${unit}はありません`
              : info?.exists && parts.length
                ? `作り直す(未判定 ${int(pending)} 件。ファイルの番号が振り直されます)`
                : `未判定 ${int(pending)} 件で作る`}
      </button>
      {#if target === 'turns' && withoutTurns > 0}<p class="state" data-testid="chat-without-turns">依頼ごとの記録が無いセッションが {int(withoutTurns)} 件あります(古い集計)。先に「集計し直す」を押すと、その依頼も入ります。</p>{/if}
      {#if jobs.error && !bundling}<p class="err" role="alert">{jobs.error}</p>{/if}
    </li>

    <li>
      <h3>チャットに渡す</h3>
      {#if next}
        <p class="next" data-testid="chat-next">次は <strong>{stem(next)}</strong>({int(next.sessions)} 件、{kb(next.bytes)})。ダウンロードしたファイルをチャットに添付し、下の依頼文を送ります。添付できないときは本文をコピーして貼り付けます。</p>
        <div class="acts">
          <a class="btn primary" href={next.path} download={saveName(next)} data-testid="chat-save">{saveName(next)} をダウンロード</a>
          <button type="button" class="btn" onclick={() => void copyPart(next)}>本文をコピー</button>
        </div>
        <p class="hint">ファイルはブラウザの保存先(ふつうは「ダウンロード」フォルダー)に入ります。チャットの添付でそのファイルを選びます。</p>
      {:else if parts.length}
        <p class="next" data-testid="chat-next">すべてのファイルを取り込みました。</p>
      {:else}
        <p class="next" data-testid="chat-next">先に添付ファイルを作ってください。</p>
      {/if}
      <div class="request">
        <code>{REQUEST}</code>
        <button type="button" class="btn" onclick={() => void copy('依頼文', () => REQUEST)}>依頼文をコピー</button>
      </div>
      <p class="copied" role="status">{copied ? `${copied}をコピーしました。` : ''}</p>
      {#if copyError}<p class="err" role="alert">{copyError}</p>{/if}
      {#if parts.length > 1}
        <details class="list">
          <summary>ファイルの一覧({int(parts.length)})</summary>
          <div class="table-scroll">
            <table>
              <thead><tr><th scope="col">ファイル</th><th scope="col" class="num">件数</th><th scope="col">状態</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead>
              <tbody>
                {#each parts as p (p.name)}
                  <tr class:done={p.judged >= p.sessions}>
                    <td>{stem(p)}</td>
                    <td class="num">{int(p.sessions)}</td>
                    <td>{partState(p)}</td>
                    <td class="row-acts"><a href={p.path} download={saveName(p)}>ダウンロード</a><button type="button" class="link" onclick={() => void copyPart(p)}>コピー</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </details>
      {/if}
    </li>

    <li>
      <h3>返答を取り込む</h3>
      <form onsubmit={importReply} aria-busy={importing}>
        <label class="fld" for="chat-reply">チャットの返答をまるごと貼り付けます(説明文が混じっていてもかまいません。JSON のコードブロックだけを読みます)</label>
        <textarea id="chat-reply" name="chat-reply" rows="5" autocomplete="off" spellcheck="false" bind:value={reply} aria-invalid={importError ? 'true' : undefined} aria-describedby="chat-import-msg" data-testid="chat-reply"></textarea>
        <div class="acts">
          <button type="submit" class="btn" disabled={!reply.trim() || importing || jobs.running} data-testid="chat-import">{importing ? '取り込んでいます…' : '取り込む'}</button>
        </div>
      </form>
      <div id="chat-import-msg">
        {#if result}<p class="ok" role="status" tabindex="-1" bind:this={resultEl} data-testid="chat-import-result">{result}</p>{/if}
        {#if importError}
          <div class="err" role="alert" data-testid="chat-import-error">
            <p>{importError.message}</p>
            {#if importError.problems.length}
              <ul>
                {#each importError.problems.slice(0, PROBLEMS_MAX) as pr, i (i)}<li>{pr}</li>{/each}
              </ul>
              {#if importError.problems.length > PROBLEMS_MAX}<p>ほか {int(importError.problems.length - PROBLEMS_MAX)} 件。</p>{/if}
            {/if}
            <p>貼った返答は欄に残っています。{#if importError.problems.length}「直す点をコピー」でこの一覧を写してチャットに貼り、「この点を直した JSON をもう一度返してください」と頼むか、{:else}チャットに{/if}同じファイルをもう一度判定させてください。</p>
            {#if importError.problems.length}<button type="button" class="btn" onclick={() => void copy('直す点', () => copyProblems())}>直す点をコピー</button>{/if}
          </div>
        {/if}
      </div>
    </li>

    <li>
      <h3>レポートに反映する</h3>
      <p class="state">取り込んだ判定は、レポートを作り直すと表に出ます。何ファイルか取り込んでからまとめて反映してかまいません。</p>
      <button type="button" class={imported > 0 ? 'btn primary' : 'btn'} disabled={off} data-testid="chat-reflect" onclick={reflect}>レポートに反映する{imported > 0 ? `(この画面で ${int(imported)} 件)` : ''}</button>
    </li>
  </ol>

  <div class="footer">
    <button type="button" class="btn" data-testid="chat-close" onclick={onclose}>閉じる</button>
  </div>
</div>

<style>
  .lead {
    margin: 10px 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .note {
    margin: 8px 0 0;
    padding: 8px 10px;
    font-size: 0.8125rem;
    background: var(--warn-wash);
    border: 1px solid var(--warn);
  }
  .steps {
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
  }
  .steps > li {
    counter-increment: step;
    padding: 10px 0 12px;
    border-top: 1px solid var(--rule);
  }
  .steps h3 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 6px;
    font-size: 0.875rem;
  }
  .steps h3::before {
    content: counter(step);
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 1.5em;
    height: 1.5em;
    font-size: 0.75rem;
    color: var(--surface);
    background: var(--form);
    border-radius: 50%;
    font-variant-numeric: tabular-nums;
  }
  .state,
  .next {
    margin: 0 0 8px;
    font-size: 0.8125rem;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
  }
  .btn {
    min-height: 32px;
  }
  a.btn {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }
  .btn.primary {
    background: var(--form);
    color: var(--surface);
  }
  .btn.primary:hover {
    background: var(--form);
    text-decoration: underline;
  }
  .btn.primary:disabled {
    background: var(--surface);
    color: var(--ink-3);
    text-decoration: none;
  }
  .request {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin-top: 10px;
    padding: 6px 8px;
    background: var(--form-wash);
    border: 1px solid var(--rule);
  }
  .request code {
    flex: 1 1 16em;
    min-width: 0;
    font-family: var(--font);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
  .hint {
    margin: 6px 0 0;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  .ok:focus {
    outline: none;
  }
  .ok:focus-visible {
    outline: 2px solid var(--form);
    outline-offset: 2px;
  }
  .copied {
    margin: 4px 0 0;
    min-height: 1.2em;
    font-size: 0.75rem;
    color: var(--form);
  }
  .list {
    margin-top: 6px;
    font-size: 0.8125rem;
  }
  .list summary {
    cursor: pointer;
    color: var(--form);
    min-height: 24px;
  }
  .list .table-scroll {
    max-height: 14rem;
    overflow-y: auto;
    margin-top: 4px;
    border: 1px solid var(--rule);
  }
  .list table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .list th,
  .list td {
    padding: 3px 8px;
    text-align: left;
    border-bottom: 1px solid var(--rule);
  }
  .list th {
    position: sticky;
    top: 0;
    font-size: 0.6875rem;
    font-weight: normal;
    color: var(--form);
    background: var(--surface);
  }
  .list .num {
    text-align: right;
  }
  .list tr.done td {
    color: var(--ink-3);
  }
  .row-acts {
    white-space: nowrap;
  }
  .row-acts a,
  .row-acts .link {
    display: inline-block;
    min-height: 32px;
    line-height: 26px;
    padding: 2px 4px;
    font: inherit;
    color: var(--form);
    background: none;
    border: 0;
    cursor: pointer;
    text-decoration: underline;
  }
  .fld {
    display: block;
    margin-bottom: 4px;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    min-height: 6.5em;
    padding: 6px 8px;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    resize: vertical;
  }
  textarea[aria-invalid='true'] {
    border-color: var(--warn);
  }
  .ok {
    margin: 8px 0 0;
    font-size: 0.8125rem;
    color: var(--form);
  }
  .err {
    margin: 8px 0 0;
    font-size: 0.8125rem;
    color: var(--warn);
  }
  .err p,
  .err ul {
    margin: 4px 0 0;
  }
  .err ul {
    padding-left: 1.2em;
    overflow-wrap: anywhere;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
  }
</style>
