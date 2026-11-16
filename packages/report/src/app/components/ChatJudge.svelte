<script lang="ts">
  // 判定ダイアログの「チャットに貼る」(M365 Copilot など、ファイルの添付と貼り付けしかできない相手)。
  // 1. 未判定のセッションだけで添付ファイル(bundle/parts/)を作る(bundle のジョブ。LLM は呼ばない)
  // 2. 次のファイルを保存(またはコピー)して、依頼文と一緒にチャットへ渡す
  // 3. 返答をまるごと貼って取り込む(judgments.json。形が合わなければ何も書かず、どこが違うかを出す)。
  //    返答をファイルに保存してあるとき(エージェントやローカルの LLM に書かせた JSON など)は、ファイルを選ぶと中身が欄に入る
  // 4. レポートに反映する(export のジョブ)
  // 2 と 3 は、サーバが Windows なら「M365 Copilot で自動で判定する」(m365 のジョブ)でまとめて行える(取り込めたらレポートにも反映する)
  // どの手順も AI クレジットを使わない(判定するのはチャットの側)。
  // target が turns なら依頼ごとの判定(turn-bundle/・turn-judgments.json。件数は依頼の数)。
  // via が zip なら「ZIP にまとめてエージェントに渡す」(工数の判定だけ。フォルダを読めるエージェントやローカルの LLM 向け)。
  // 手順 1 は束と ZIP を同じ回に作り(bundle-zip のジョブ)、手順 2 は ZIP の保存(展開したフォルダを読ませる)、手順 3・4 はチャットと同じ(結果を取り込む)。
  // ZIP の場所(出力先の中のフルパス)は出さない: 出力先でエージェントを開かせると、判定の保存先(judgments.json)やほかの記録に触れさせてしまう。
  import { onDestroy, tick } from 'svelte';
  import { chatJudgeApi, ChatImportError, jobsApi, type ChatPart, type ChatParts, type JudgeTarget, type JudgeVia } from '../api.ts';
  import type { JobStore } from '../jobs.svelte.ts';
  import { dateTime, int } from '../../lib/format.ts';
  import { failureReason } from '../../lib/job-log.ts';
  import JobLog from './JobLog.svelte';

  // reply は親(JobActions)が判定するものごとに持つ(判定するものを切り替えても貼りかけの返答が消えないように)
  let { jobs, onclose, target = 'effort', via = 'chat', reply = $bindable('') }: { jobs: JobStore; onclose: () => void; target?: JudgeTarget; via?: JudgeVia; reply?: string } = $props();
  /** ZIP にまとめて渡す流れか(工数の判定だけ) */
  const zipMode = $derived(via === 'zip' && target === 'effort');
  /** 数える単位(工数はセッション、依頼ごとの判定は依頼) */
  const unit = $derived(target === 'turns' ? '依頼' : 'セッション');
  const bundleKind = $derived(zipMode ? 'bundle-zip' : target === 'turns' ? 'turn-bundle' : 'bundle');
  const m365Kind = $derived(target === 'turns' ? 'turn-m365' : 'm365');
  /** 作るもの・渡す相手の呼び名 */
  const thing = $derived(zipMode ? 'ZIP' : '添付ファイル');
  const peer = $derived(zipMode ? 'エージェント' : 'チャット');

  /** チャットに添付ファイルと一緒に送る依頼文 */
  const REQUEST = '添付したファイルの指示に従って判定し、JSON を返してください。';
  /**
   * 展開したフォルダを読ませたエージェントへ送る依頼文。展開も書き込みも頼まない(注意の「シェルの実行・ファイルの変更を許可しない」と両立させる。
   * INSTRUCTIONS.md も JSON を返答で返す形を指示している)。ファイルに書かせる頼み方は、手順 2 の補足に書く
   */
  const REQUEST_ZIP = 'bundle フォルダの INSTRUCTIONS.md に従って判定し、JSON を返してください。';
  /** 返答が長くなるときに足す頼み方(書く先を展開したフォルダの中に限る) */
  const REQUEST_ZIP_FILE = '結果は bundle フォルダの中の judgments.json に書いてください。';
  const request = $derived(zipMode ? REQUEST_ZIP : REQUEST);
  /** 保存するときの ZIP の名前(展開すると bundle フォルダが 1 つできる) */
  const ZIP_NAME = 'bundle.zip';
  /** 取り込みの失敗で並べる項目の上限 */
  const PROBLEMS_MAX = 8;
  /** 返答のファイルとして読む大きさの上限(判定 1 件は数 KB。これを超えるのは選び間違い) */
  const REPLY_FILE_MAX = 5 * 1024 * 1024;

  let info = $state<ChatParts | null>(null);
  let pending = $state<number | null>(null);
  /** 依頼ごとの記録が無いセッション(依頼の判定のとき。古い集計) */
  let withoutTurns = $state(0);
  let loadError = $state('');
  let importing = $state(false);
  let result = $state('');
  let importError = $state<{ message: string; problems: string[] } | null>(null);
  let fileNote = $state('');
  let fileError = $state('');
  let imported = $state(0);
  let copied = $state('');
  let copyError = $state('');
  let resultEl = $state<HTMLParagraphElement | null>(null);

  const parts = $derived(info?.parts ?? []);
  const doneParts = $derived(parts.filter((p) => p.judged >= p.sessions).length);
  const next = $derived(parts.find((p) => p.judged < p.sessions) ?? null);
  const bundling = $derived(jobs.running && jobs.job?.kind === bundleKind);
  const automating = $derived(jobs.running && jobs.job?.kind === m365Kind);
  /** まだ判定し終えていないファイルの数 */
  const remaining = $derived(parts.length - doneParts);
  /** 依頼の判定で、セッションの最後の依頼だけのファイルの数(採用は判定不能。先頭のファイルの後ろに並ぶ) */
  const lastOnlyParts = $derived(parts.filter((p) => p.lastOnly).length);
  /** この画面で見た M365 Copilot の自動の判定(動いている間と、終わった後のログ) */
  const m365Job = $derived(jobs.job && jobs.job.kind === m365Kind && jobs.live === jobs.job.id ? jobs.job : null);
  const off = $derived(jobs.running || jobs.busy);
  /** 今の束をまとめた ZIP(前の束の ZIP はサーバが返さない) */
  const zip = $derived(zipMode ? (info?.zip ?? null) : null);
  /** ZIP の中のセッションの数と、そのうち取り込み済みの数(ZIP と添付ファイルは同じ束から作る) */
  const zipTotal = $derived(info?.count ?? 0);
  const zipJudged = $derived(Math.min(zipTotal, parts.reduce((n, p) => n + p.judged, 0)));
  /** いま使える添付ファイル(ZIP)があるか(作り直しに失敗しても、前に作ったものは残る) */
  const made = $derived(zipMode ? !!zip : !!info?.exists && parts.length > 0);
  /** いま使えるものを作った日時 */
  const madeAt = $derived(zipMode ? zip?.modifiedAt : info?.generatedAt);
  /** 手順 1 のボタンの文言 */
  const makeLabel = $derived.by(() => {
    if (bundling) return '作っています…';
    if (pending == null) return zipMode ? `未判定の${unit}で ZIP を作る` : `未判定の${unit}で作る`;
    if (pending === 0) return `未判定の${unit}はありません`;
    if (zipMode) return zip ? `作り直す(未判定 ${int(pending)} 件)` : `未判定 ${int(pending)} 件で ZIP を作る`;
    return info?.exists && parts.length ? `作り直す(未判定 ${int(pending)} 件。ファイルの番号が振り直されます)` : `未判定 ${int(pending)} 件で作る`;
  });
  /**
   * 添付ファイルを作る処理が失敗したか、止められたとき(本文の上の帯には出ないので、ここで見せる)。
   * この画面で動いているのを見た処理だけを出す。一度見て閉じたものと、その後に(コマンドなどで)作れたものは出さない
   */
  const ended = $derived.by(() => {
    const j = jobs.job;
    if (!j || j.kind !== bundleKind || (j.state !== 'failed' && j.state !== 'canceled')) return null;
    if (jobs.live !== j.id || jobs.dismissed === j.id) return null;
    if (j.endedAt && madeAt && Date.parse(madeAt) > Date.parse(j.endedAt)) return null;
    return j;
  });
  /** 処理が書いた理由(「atlas: 失敗しました: …」の後ろ)。書かずに終わったときは空で、ログを読んでもらう */
  const reason = $derived(ended?.state === 'failed' ? failureReason(ended.log) : '');
  // 見せた失敗は、閉じたら(判定するものを切り替えたときも)もう出さない
  let shownId: string | null = null;
  $effect(() => {
    if (ended) shownId = ended.id;
  });
  onDestroy(() => {
    if (shownId && jobs.job?.id === shownId) jobs.dismissed = shownId;
  });

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

  // 添付ファイルを作るジョブが終わったら一覧を読み直す(開いたときにもう終わっていたジョブでは読み直さない。null はまだ見ていない)。
  // 工数では bundle と bundle-zip のどちらも同じ束を作り直す(bundle は ZIP も消す)ので、もう一方の方法で始めたジョブでも読み直す
  let seen: string | null = null;
  $effect(() => {
    const j = jobs.job;
    const mine = j && (j.kind === bundleKind || j.kind === m365Kind || (target === 'effort' && (j.kind === 'bundle' || j.kind === 'bundle-zip')));
    const key = j && mine && j.state !== 'running' ? `${j.id}:${j.state}` : '';
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

  async function startM365(): Promise<void> {
    result = '';
    importError = null;
    await jobs.run({ kind: m365Kind });
  }

  async function copy(what: string, text: () => Promise<string> | string): Promise<void> {
    copied = '';
    copyError = '';
    try {
      await navigator.clipboard.writeText(await text());
      copied = what;
    } catch (e) {
      copyError = `コピーできませんでした(${(e as Error).message})。${zipMode ? '依頼文を選んで写してください。' : 'ファイルを保存して添付してください。'}`;
    }
  }
  const copyPart = (p: ChatPart): Promise<void> => copy(`${stem(p)} の本文`, () => chatJudgeApi.partText(jobs.token, p.name, target));
  /** 保存するときの名前(相手のチャットが .md を添付として受け付けるか分からないので、受け付けられやすい .txt にする。中身は同じ) */
  const saveName = (p: ChatPart): string => `${target === 'turns' ? 'turns-' : ''}${p.name.replace(/\.md$/, '.txt')}`;
  /** 画面に出す名前は保存する名前から拡張子を除いたもの(案内の名前とダウンロードフォルダの名前をそろえる) */
  const stem = (p: ChatPart): string => saveName(p).replace(/\.txt$/, '');
  /** 数と単位の間の空白(行の折り返しで「22」と「KB」が分かれないように、改行しない空白にする) */
  const NBSP = String.fromCharCode(0xa0);
  const kb = (b: number): string => `${Math.max(1, Math.round(b / 1024))}${NBSP}KB`;
  /** ZIP の大きさ(1 MB 以上は MB) */
  const size = (b: number): string => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}${NBSP}MB` : kb(b));
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
      fileNote = '';
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

  /** 選んだファイルの中身を返答の欄に入れる(取り込むのは「取り込む」を押したとき。中身を見てから取り込める) */
  async function loadReplyFile(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileNote = '';
    fileError = '';
    try {
      if (file.size > REPLY_FILE_MAX) throw new Error(`大きすぎます(${kb(file.size)}。上限 ${kb(REPLY_FILE_MAX)})`);
      const text = await file.text();
      if (!text.trim()) throw new Error('中身が空です');
      reply = text;
      result = '';
      importError = null;
      fileNote = `${file.name} を読み込みました(${kb(file.size)})。「取り込む」を押してください。`;
    } catch (err) {
      fileError = `${file.name} を読み込めませんでした: ${(err as Error).message}`;
    } finally {
      // 同じファイルを選び直しても読み直せるようにする
      input.value = '';
    }
  }

  /** 取り込めなかった理由を 1 行ずつ(チャットに貼って直してもらう) */
  const copyProblems = (): string => (importError?.problems ?? []).map((p) => `- ${p}`).join(String.fromCharCode(10));

  async function reflect(): Promise<void> {
    if (await jobs.run({ kind: 'export' })) onclose();
  }
</script>

<div class="chat" data-testid="chat-judge">
  {#if zipMode}
    <p class="lead">フォルダやファイルを読めるエージェント(自分で開いた GitHub Copilot CLI、ほかのコーディングエージェント、ローカルの LLM など)に ZIP の中身を読ませて判定し、結果をここに取り込みます。判定するのは渡した相手なので、このツールは AI クレジットを使いません(費用は相手の側で決まります)。</p>
    <div class="note" data-testid="chat-zip-caution">
      <p>ZIP には依頼文・最終応答・パス・リポジトリ名がそのまま入ります。渡してよい相手か確かめてから使ってください。</p>
      <p>中の記録には、ほかのセッションで出した依頼文(「このコマンドを実行して」のような文)もそのまま入っています。ツールを使えるエージェントには、<strong>シェルの実行・ファイルの変更・Web へのアクセスを許可せず</strong>、展開した bundle フォルダだけを読める状態で渡してください。このツールの出力先(out フォルダ)は開かせないでください。</p>
    </div>
  {:else}
    <p class="lead">ファイルの添付か貼り付けができるチャットの LLM(M365 Copilot など。相手は選びません)で判定し、結果をここに取り込みます。判定するのはチャットの側なので、このツールは AI クレジットを使いません。</p>
    <p class="note">添付ファイルには依頼文・最終応答・パス・リポジトリ名がそのまま入ります。渡してよい相手か確かめてから使ってください。</p>
  {/if}

  <ol class="steps">
    <li>
      <h3>{zipMode ? 'ZIP を作る' : '添付ファイルを作る'}</h3>
      <p class="state" data-testid="chat-bundle-state">
        {#if loadError}読み込めませんでした: {loadError}
        {:else if !info}読み込んでいます…
        {:else if zipMode}
          {#if zip}<strong>作成済み</strong>: {dateTime(zip.modifiedAt)}({info.unjudgedOnly ? '未判定だけ' : '全件'}、{int(zipTotal)} 件、{size(zip.bytes)})。取り込み済み <strong>{int(zipJudged)}</strong> / {int(zipTotal)} 件。{zipTotal > 0 && zipJudged >= zipTotal ? 'すべて取り込みました。' : '次の手順 2 へ進んでください。'}
          {:else}まだ作っていません。{/if}
        {:else if !info.exists || parts.length === 0}まだ作っていません。
        {:else}<strong>作成済み</strong>: {dateTime(info.generatedAt)}({info.unjudgedOnly ? '未判定だけ' : '全件'}、{int(parts.length)} ファイル)。取り込み済み <strong>{int(doneParts)}</strong> / {int(parts.length)} ファイル。次の手順 2 へ進んでください。{/if}
      </p>
      {#if made && info?.decidable && lastOnlyParts > 0}
        <p class="state" data-testid="chat-decidable">
          {#if info.decidable.turns > 0}
            採用を判定できる依頼(次の依頼がある依頼)は {int(info.decidable.turns)} 件で、先頭の <strong>{int(info.decidable.parts)}</strong> ファイルに入っています。その後ろの {int(lastOnlyParts)} ファイルはセッションの最後の依頼だけで、種類と工程だけが決まります(採用は判定不能)。採用率だけを見たいときは、先頭の {int(info.decidable.parts)} ファイルで止められます。
          {:else}
            どのファイルもセッションの最後の依頼だけです。種類と工程だけが決まります(採用は判定不能)。
          {/if}
        </p>
      {/if}
      <button type="button" class="btn" disabled={off || pending === 0} data-testid="chat-bundle" onclick={makeBundle}>{makeLabel}</button>
      {#if zipMode && parts.length > 0}
        <p class="hint" data-testid="chat-zip-side">「チャットに貼って判定する」の添付ファイルも、同じ未判定のセッションで作り直されます(ファイルの番号が振り直されます)。</p>
      {:else if !zipMode && info?.zip}
        <p class="hint" data-testid="chat-zip-stale">作り直すと、前に作った ZIP({ZIP_NAME})は中身が合わなくなるので消えます。</p>
      {/if}
      {#if target === 'turns' && withoutTurns > 0}<p class="state" data-testid="chat-without-turns">依頼ごとの記録が無いセッションが {int(withoutTurns)} 件あります(古い集計)。先に「集計し直す」を押すと、その依頼も入ります。</p>{/if}
      {#if jobs.error && !bundling}<p class="err" role="alert">{jobs.error}</p>{/if}
      {#if ended}
        <div class="err" role="alert" data-testid="chat-bundle-failed">
          {#if ended.state === 'failed'}
            <p><strong>{thing}を作れませんでした</strong>(終了コード {ended.exitCode ?? '—'})。{reason ? '' : '理由は下のログで確かめてください。'}</p>
            {#if reason}<p class="reason" data-testid="chat-bundle-reason">理由: {reason}</p>{/if}
            <p>原因を直してから、もう一度押してください。{made ? `前に作った${thing}は、そのまま使えます。` : ''}</p>
          {:else}
            <p><strong>{thing}の作成を止めました</strong>。{made ? `前に作った${thing}は、そのまま使えます。` : `使える${thing}はまだありません。もう一度作ってください。`}</p>
          {/if}
          {#if ended.log.length}<div class="log"><JobLog log={ended.log} /></div>{/if}
        </div>
      {/if}
    </li>

    <li>
      <h3>{peer}に渡す</h3>
      {#if zipMode}
        {#if zip}
          <p class="next" data-testid="chat-next"><strong translate="no">{ZIP_NAME}</strong>({int(zipTotal)} 件、{size(zip.bytes)})をダウンロードして展開し、できた bundle フォルダをエージェントに読ませて、下の依頼文を送ります。ZIP を受け取れる相手には、展開せずに添付してもかまいません。</p>
          <div class="acts">
            <a class="btn primary" href={zip.path} download={ZIP_NAME} data-testid="chat-zip-save">{ZIP_NAME} をダウンロード</a>
          </div>
          <p class="hint">ファイルはブラウザの保存先(ふつうは「ダウンロード」フォルダー)に入ります。そこで展開して、エージェントには bundle フォルダだけを開かせます。</p>
        {:else}
          <p class="next" data-testid="chat-next">先に ZIP を作ってください。</p>
        {/if}
      {:else if next}
        <p class="next" data-testid="chat-next">次は <strong>{stem(next)}</strong>({int(next.sessions)} 件、{kb(next.bytes)})。ダウンロードしたファイルをチャットに添付し、下の依頼文を送ります。添付できないときは本文をコピーして貼り付けます。</p>
        <div class="acts">
          <a class="btn primary" href={next.path} download={saveName(next)} data-testid="chat-save">{saveName(next)} をダウンロード</a>
          <button type="button" class="btn" onclick={() => void copyPart(next)}>本文をコピー</button>
        </div>
        <p class="hint">ファイルはブラウザの保存先(ふつうは「ダウンロード」フォルダー)に入ります。チャットの添付でそのファイルを選びます。</p>
        {#if next.lastOnly && info?.decidable?.turns}<p class="hint" data-testid="chat-next-last-only">このファイルから後ろは、セッションの最後の依頼だけです(種類と工程だけが決まります)。採用率だけを見たいときは、ここで止めて手順 4 へ進めます。</p>{/if}
      {:else if parts.length}
        <p class="next" data-testid="chat-next">すべてのファイルを取り込みました。</p>
      {:else}
        <p class="next" data-testid="chat-next">先に添付ファイルを作ってください。</p>
      {/if}
      <div class="request">
        <code data-testid="chat-request">{request}</code>
        <button type="button" class="btn" onclick={() => void copy('依頼文', () => request)}>依頼文をコピー</button>
      </div>
      <p class="copied" role="status">{copied ? `${copied}をコピーしました。` : ''}</p>
      {#if zipMode}<p class="hint" data-testid="chat-zip-file-hint">返答が長くなるときは、依頼文に「{REQUEST_ZIP_FILE}」と足し、手順 3 でそのファイルを選びます(このときだけ、bundle フォルダへの書き込みを許可します)。</p>{/if}
      {#if !zipMode && info?.canAutomate && (next || m365Job)}
        <div class="auto" data-testid="chat-m365">
          <h4>M365 Copilot で自動で判定する</h4>
          <p>開いている M365 Copilot のアプリを、このツールが操作します。残りの {int(remaining)} ファイルを 1 つずつ新しいチャットで送り(モデルは Think Deeper)、返答を取り込んで、レポートに反映します。手順 2〜4 を手でする代わりです。</p>
          <ul>
            <li>先に M365 Copilot のアプリを開いてサインインし、チャットの画面を出しておきます。</li>
            <li>終わるまで M365 Copilot の画面に触らないでください。1 ファイルに数分かかることがあります。</li>
            <li>添付したファイルは、手で添付したときと同じく OneDrive に入ります。</li>
          </ul>
          <button type="button" class="btn primary" disabled={off || !next} data-testid="chat-m365-start" onclick={() => void startM365()}>
            {automating ? '判定しています…' : `M365 Copilot で ${int(remaining)} ファイルを判定する`}
          </button>
          {#if m365Job && m365Job.state !== 'running'}
            <p class={m365Job.state === 'done' ? 'ok' : 'err'} role="status" data-testid="chat-m365-result">
              {m365Job.state === 'done' ? '終わりました。上の帯の「再読み込み」でレポートに出ます。' : m365Job.state === 'canceled' ? '止めました。取り込めた分は保存されています。' : '途中で止まったか、取り込めなかったファイルがあります(取り込めた分は保存されています)。理由は下のログで確かめてください。'}
            </p>
          {/if}
          {#if m365Job?.log.length}<div class="log"><JobLog log={m365Job.log} /></div>{/if}
        </div>
      {/if}
      {#if copyError}<p class="err" role="alert">{copyError}</p>{/if}
      {#if !zipMode && parts.length > 1}
        <details class="list">
          <summary>ファイルの一覧({int(parts.length)})</summary>
          <div class="table-scroll">
            <table>
              <thead><tr><th scope="col">ファイル</th><th scope="col" class="num">件数</th><th scope="col">状態</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead>
              <tbody>
                {#each parts as p (p.name)}
                  <tr class:done={p.judged >= p.sessions}>
                    <td>{stem(p)}{#if p.lastOnly}<span class="last-only">最後の依頼だけ</span>{/if}</td>
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
      <h3>{zipMode ? '結果を取り込む' : '返答を取り込む'}</h3>
      <!-- ファイルを選ぶ欄。ZIP の流れでは結果がファイルで返るので先に、チャットの流れでは貼り付けの欄の後に置く -->
      {#snippet fileField()}
        <label class="fld file" for="chat-reply-file">{zipMode ? 'エージェントに書かせた judgments.json か、返答を保存したファイル(.json / .md / .txt)を選ぶと、中身が下の欄に入ります' : '返答をファイルに保存してあるとき(.json / .md / .txt)は、選ぶと中身が上の欄に入ります'}</label>
        <input id="chat-reply-file" name="chat-reply-file" type="file" accept=".json,.md,.txt,application/json,text/plain,text/markdown" onchange={loadReplyFile} data-testid="chat-reply-file" />
        <p class="copied" role="status" data-testid="chat-reply-file-note">{fileNote}</p>
        {#if fileError}<p class="err" role="alert" data-testid="chat-reply-file-error">{fileError}</p>{/if}
      {/snippet}
      <form onsubmit={importReply} aria-busy={importing}>
        {#if zipMode}{@render fileField()}{/if}
        <label class="fld" for="chat-reply">
          {zipMode
            ? 'エージェントの返答は、ここにまるごと貼り付けてもかまいません(説明文が混じっていてもかまいません。JSON のコードブロックだけを読みます)。中身を確かめてから「取り込む」を押します'
            : 'チャットの返答をまるごと貼り付けます(説明文が混じっていてもかまいません。JSON のコードブロックだけを読みます)'}
        </label>
        <textarea id="chat-reply" name="chat-reply" rows="5" autocomplete="off" spellcheck="false" bind:value={reply} aria-invalid={importError ? 'true' : undefined} aria-describedby="chat-import-msg" data-testid="chat-reply"></textarea>
        {#if !zipMode}{@render fileField()}{/if}
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
            {#if zipMode}
              <p>中身は欄に残っています。{#if importError.problems.length}「直す点をコピー」でこの一覧を写してエージェントに渡し、「この点を直した JSON をもう一度返してください」と頼んでください。{:else}エージェントに、もう一度判定させてください。{/if}</p>
            {:else}
              <p>貼った返答は欄に残っています。{#if importError.problems.length}「直す点をコピー」でこの一覧を写してチャットに貼り、「この点を直した JSON をもう一度返してください」と頼むか、{:else}チャットに{/if}同じファイルをもう一度判定させてください。</p>
            {/if}
            {#if importError.problems.length}<button type="button" class="btn" onclick={() => void copy('直す点', () => copyProblems())}>直す点をコピー</button>{/if}
          </div>
        {/if}
      </div>
    </li>

    <li>
      <h3>レポートに反映する</h3>
      <p class="state">取り込んだ判定は、レポートを作り直すと表に出ます。{zipMode ? '途中までの結果でも取り込めます(残りは、次に作る ZIP に入ります)。' : '何ファイルか取り込んでからまとめて反映してかまいません。'}</p>
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
  .note p {
    margin: 0;
  }
  .note p + p {
    margin-top: 6px;
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
  .auto {
    margin-top: 12px;
    padding: 8px 10px;
    font-size: 0.8125rem;
    border: 1px solid var(--rule);
  }
  .auto h4 {
    margin: 0 0 4px;
    font-size: 0.8125rem;
  }
  .auto p,
  .auto ul {
    margin: 0 0 6px;
  }
  .auto ul {
    padding-left: 1.2em;
    color: var(--ink-2);
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
  .list .last-only {
    margin-left: 8px;
    font-size: 0.6875rem;
    color: var(--ink-2);
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
  .fld.file {
    margin-top: 8px;
  }
  /* ZIP の流れではファイルの欄が先頭(見出しのすぐ下)に来る */
  form > .fld.file:first-child {
    margin-top: 0;
  }
  input[type='file'] {
    max-width: 100%;
    min-height: 32px;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--ink);
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
  .err p {
    overflow-wrap: anywhere;
  }
  .err .reason {
    white-space: pre-wrap;
  }
  .log {
    margin: 4px 0 0;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
  }
</style>
