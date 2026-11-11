<script lang="ts" module>
  /** タスクタグごとに、出した(またはこの画面で写し終えた)直近の結果の時刻。同じ結果を何度も出さない */
  const seenUpload = new Map<string, number>();
</script>

<script lang="ts">
  // グループで絞り込んでいるときの見出し(本文の先頭)。名前・件数・説明と、「絞り込みを外す」。
  // 編集できるとき(atlas serve)は「編集」で名前と説明を 1 つの欄で直す。削除は編集欄の奥に置き、確認を 1 回挟む。
  // サイドバーのグループの一覧は切り替えだけにする(選ぶたびに操作の行が差し込まれて下の行がずれ、削除が改名と同じ重さで並んでいたため)
  // アップロード(serve のとき): グループのセッションの生ログを、決めておいた基底フォルダの <グループ名>\<セッション id>\ に写す。
  // 先は見出しの下に 1 行で見せ、「場所を変える…」で同じ見出しの中に記入欄を開く(エクスプローラーで選ぶ / パスを入力)。
  // 写す前にサーバが大きさと秘密らしい文字列を調べ、毎回確認を出す(送り先・件数・大きさ。秘密らしい文字列があれば警告)。写している間は進み具合(バイト数)を出す。
  import { untrack } from 'svelte';
  import { int } from '../../lib/format.ts';
  import { safeDirName } from '../../lib/groups.ts';
  import type { ReportGroup } from '../../lib/types.ts';
  import type { GroupExport, GroupUpload, UploadCheck, UploadHandlers, UploadPoll, UploadProgress } from '../api.ts';

  let {
    group,
    editable,
    onclear,
    onsave,
    ondelete,
    onexport,
    upload,
  }: {
    group: ReportGroup & { present: number };
    editable: boolean;
    /** 絞り込みを外す(「すべて」に戻る) */
    onclear: () => void;
    /** 名前・説明の変わった分だけを送る(失敗は例外。理由を欄の下に出す) */
    onsave: (oldName: string, patch: { name?: string; note?: string }) => Promise<void>;
    ondelete: (name: string) => Promise<void>;
    /** そのグループの表(CSV)・集計・記録をフォルダに書き出す(atlas serve のときだけ) */
    onexport?: (name: string) => Promise<GroupExport>;
    /** グループのセッションをアップロード先へ写す(atlas serve のときだけ) */
    upload?: UploadHandlers;
  } = $props();
  let exported = $state<GroupExport | null>(null);
  let uploaded = $state<GroupUpload | null>(null);
  /** 何をしているか(ボタンの文言を「…中」にする) */
  let task = $state<'export' | 'check' | 'upload' | 'open' | 'pick' | 'root' | null>(null);
  /** 写す前の点検の結果(確認を出しているとき) */
  let checked = $state<UploadCheck | null>(null);
  /** 写している途中の進み具合 */
  let progress = $state<UploadProgress | null>(null);
  /** アップロード先を決めた後に、そのままアップロードする(先が未定のまま「アップロード」を押したとき) */
  let uploadAfterRoot = $state(false);
  let rootInput = $state('');
  let rootInputEl = $state<HTMLInputElement | null>(null);
  let uploadBtn = $state<HTMLButtonElement | null>(null);
  /** パスの区切り(設定のパスに合わせる。Windows は \) */
  const sep = (root: string): string => (root.includes('\\') || /^[A-Za-z]:/.test(root) ? '\\' : '/');
  /** このグループのアップロード先(<基底>\<グループ名>)。基底が未定なら null */
  const destDir = $derived(upload?.setting.root ? `${upload.setting.root.replace(/[\\/]+$/, '')}${sep(upload.setting.root)}${safeDirName(group.name)}` : null);
  const when = (iso: string): string => {
    const d = new Date(iso);
    const p = (n: number): string => String(n).padStart(2, '0');
    return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  /** アップロードの結果の文(読み上げにも使う) */
  const uploadedText = $derived(
    uploaded
      ? `アップロードしました(${int(uploaded.uploaded)} セッション${uploaded.memos ? `・メモ ${int(uploaded.memos)} 件` : ''}${uploaded.replaced ? `。うち ${int(uploaded.replaced)} 件は前に写したものを置き換え` : ''})。タスクタグの説明とセッションの一覧は README.md にあります。` +
          (uploaded.snapshotAt ? `写したのは前回の集計(${when(uploaded.snapshotAt)})の時点のログです。` : '') +
          (uploaded.missing.length ? `前回の集計に無いセッション ${int(uploaded.missing.length)} 件は写していません。` : '') +
          // 黒い窓(upload-project.bat)と同じ知らせ: 残ったフォルダは次に送っても消えないので、手で消してもらう
          (uploaded.leftovers?.length
            ? `置き換えた前のフォルダを ${int(uploaded.leftovers.length)} 件消せませんでした(送り先で開かれているなど)。閉じてから手で消してください: ${uploaded.leftovers.slice(0, 3).join('、')}${uploaded.leftovers.length > 3 ? ` ほか ${int(uploaded.leftovers.length - 3)} 件` : ''}`
            : '')
      : '',
  );
  /** 確認に「大きいもの」を出す目安(serve の UPLOAD_CONFIRM_BYTES と同じ) */
  const CONFIRM_BYTES = 100 * 1024 * 1024;
  /** 確認から送り先を選び直す(決めたら点検し直して、また確かめる) */
  function changeRootFromConfirm(): void {
    checked = null;
    beginRoot(true);
  }
  const size = (b: number): string => (b < 1024 * 1024 ? `${int(Math.ceil(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`);
  function doUpload(): void {
    if (!upload || busy) return;
    if (!upload.setting.root) {
      // 先が未定なら記入欄を開き、決めたらそのまま写す
      beginRoot(true);
      return;
    }
    exported = null;
    uploaded = null;
    doneElsewhere = null;
    task = 'check';
    const name = group.name;
    let c: UploadCheck | null = null;
    void run(
      async () => {
        c = await upload.check(name);
      },
      () => {
        // 確かめている間に別のタグへ切り替えた(または見出しが消えた)なら、前のタグの確認は出さない
        if (!c || !alive || group.name !== name) return;
        // 写す前に毎回、送り先と件数・大きさを見せて確かめる。秘密らしい文字列があれば焦点は「やめる」、無ければ「写す」
        checked = c;
        mode = 'confirm';
        const warn = c.secrets.count > 0;
        requestAnimationFrame(() => rootEl?.querySelector<HTMLButtonElement>(warn ? 'button[data-cancel]' : 'button[data-confirm]')?.focus());
      },
    );
  }
  /** 確認をやめて見出しに戻る(何も写さない) */
  function leaveConfirm(): void {
    checked = null;
    mode = 'view';
    error = '';
    requestAnimationFrame(() => uploadBtn?.focus());
  }
  /** 写しているタスクタグの名前(写している途中に別のタスクタグへ切り替えても、進み具合と結果はこの名前の見出しにだけ出す) */
  let uploadName = $state<string | null>(null);
  /** 進み具合を尋ねるタイマー(見出しが消えるときに止める) */
  const timers = new Set<ReturnType<typeof setInterval>>();
  const stopTimer = (h: ReturnType<typeof setInterval>): void => {
    clearInterval(h);
    timers.delete(h);
  };
  /** 見出しが出ているか(「すべて」へ外すと消える。消えた見出しは結果を出していないので、出したことにしない) */
  let alive = true;
  $effect(() => () => {
    alive = false;
    for (const h of timers) clearInterval(h);
    timers.clear();
  });
  /** 別のタスクタグを見ている間に終わったアップロードの知らせ(結果の中身は、写したタグを開くと出す) */
  let doneElsewhere = $state<{ ok: boolean; text: string } | null>(null);
  /** 写したタグを今見ていなければ、今の見出しに終わったことだけを知らせる(成功なら写した件数、失敗なら理由) */
  function noteElsewhere(name: string, o: { ok: true; result: GroupUpload | null } | { ok: false; error: string }): void {
    if (!alive || group.name === name) return;
    const more = `詳しくは「${name}」を開くと出ます。`;
    doneElsewhere = o.ok
      ? { ok: true, text: `「${name}」のアップロードが終わりました${o.result ? `(${int(o.result.uploaded)} セッション)` : ''}。${more}` }
      : { ok: false, text: `「${name}」をアップロードできませんでした(${o.error})。` };
  }
  const isProgress = (p: UploadPoll): p is UploadProgress => !!p && 'sessions' in p;
  /**
   * 進み具合の欄に出すもの(1 つだけ)。ほかのタグを写している > このタグを写している > ほかのタグで終わった の順。
   * 写し始めるときに前の知らせを消すので、このタグで写している間に古い知らせが残ることはないが、並び順でも進み具合を先にする
   */
  const uploadStatus = $derived.by((): { kind: 'elsewhere'; name: string } | { kind: 'own' } | { kind: 'done'; ok: boolean; text: string } | null => {
    if (uploadName && uploadName !== group.name) return { kind: 'elsewhere', name: uploadName };
    if (task === 'upload') return { kind: 'own' };
    if (doneElsewhere) return { kind: 'done', ...doneElsewhere };
    return null;
  });
  /** 写し終わった(または失敗した)。写していたタスクタグを今も見ているときだけ結果を出す */
  function finishUpload(name: string): void {
    progress = null;
    uploadName = null;
    task = null;
    busy = false;
    // 見出しが消えた後(「すべて」へ外した)は group を読まない(親が null にしている)
    if (!alive) return;
    if (group.name === name) requestAnimationFrame(() => uploadBtn?.focus());
    // ほかのタグを見ている間に終わった: 写している間は尋ねなかった、今のタグの直近の結果・続いているアップロードを尋ねる
    // (編集などの欄を開いているときは尋ねない。結果が欄の誤りとして出て、閉じると消えてしまうため)
    else if (editable && mode === 'view') resumeUpload(group.name);
  }
  function showLast(name: string, p: Exclude<UploadPoll, UploadProgress | null>): void {
    // 見出しを表示しているときだけ出す(編集などの欄では欄の誤りになり、閉じると消えてしまう。出さなければ、次に開いたときに出す)
    if (!alive || group.name !== name || mode !== 'view') return;
    // 同じ結果は 1 回だけ出す(タグを開き直すたびに同じ失敗を出さない)。この画面で写し終えたものは、その場で出したので出さない
    if (p.at <= (seenUpload.get(name) ?? 0)) return;
    seenUpload.set(name, p.at);
    if (p.ok && p.result) uploaded = p.result;
    else if (!p.ok) error = `アップロードできませんでした(${p.error ?? '理由は分かりません'})`;
  }
  function copy(): void {
    if (!upload || busy) return;
    const u = upload;
    const name = group.name;
    const expect = checked?.fingerprint;
    checked = null;
    mode = 'view';
    error = '';
    doneElsewhere = null;
    busy = true;
    task = 'upload';
    progress = null;
    uploadName = name;
    // 写している間、サーバに進み具合を尋ねる(写し終わるまで返事が来ないため)
    const timer = setInterval(() => {
      void u.progress(name).then(
        (p) => {
          if (isProgress(p) && uploadName === name) progress = p;
        },
        () => {},
      );
    }, 500);
    timers.add(timer);
    // 結果を出したのは、写したタグの見出しが出ていたときだけ。別のタグへ切り替えていた・「すべて」へ外していたなら、
    // 戻ったときにサーバの直近の結果から出す(ここで出したことにすると、成功も失敗の理由も出ないままになる)
    let shown = false;
    void u.run(name, expect).then(
      (r) => {
        if (alive && group.name === name) {
          uploaded = r;
          shown = true;
        } else noteElsewhere(name, { ok: true, result: r });
      },
      (e) => {
        if (alive && group.name === name) {
          error = (e as Error).message;
          shown = true;
        } else noteElsewhere(name, { ok: false, error: (e as Error).message });
      },
    ).finally(() => {
      stopTimer(timer);
      // この画面で結果を出したときだけ、戻ったときの「直近の結果」としては出さない
      if (shown) seenUpload.set(name, Date.now());
      finishUpload(name);
    });
  }
  function openUploaded(): void {
    if (!upload || busy) return;
    task = 'open';
    void run(() => upload.open(group.name), () => {});
  }
  function beginRoot(thenUpload: boolean): void {
    uploadAfterRoot = thenUpload;
    rootInput = upload?.setting.root ?? '';
    error = '';
    mode = 'root';
    // エクスプローラーで選べるならそのボタン、選べなければ入力欄へ
    requestAnimationFrame(() => (upload?.setting.canPick ? rootEl?.querySelector<HTMLButtonElement>('[data-pick]')?.focus() : rootInputEl?.focus()));
  }
  /** 先が決まったら見出しに戻り、未定のまま「アップロード」を押していたらそのまま写す */
  function rootDecided(): void {
    const next = uploadAfterRoot;
    uploadAfterRoot = false;
    mode = 'view';
    if (next) requestAnimationFrame(() => doUpload());
    requestAnimationFrame(() => uploadBtn?.focus());
  }
  function pickRoot(): void {
    if (!upload || busy) return;
    task = 'pick';
    let chosen: string | null = null;
    void run(
      async () => {
        chosen = await upload.pick();
      },
      () => {
        if (chosen) rootDecided();
      },
    );
  }
  function submitRoot(e: SubmitEvent): void {
    e.preventDefault();
    if (!upload || busy) return;
    const r = rootInput.trim();
    if (!r) {
      error = 'フォルダのフルパスを入れてください';
      rootInputEl?.focus();
      return;
    }
    task = 'root';
    void run(async () => void (await upload.setRoot(r)), rootDecided);
  }
  let pathCopied = $state(false);
  /** 書き出しの結果の文(読み上げ用の live 領域は常に置き、文だけ差し替える) */
  const exportedText = $derived(
    exported
      ? `書き出しました(${int(exported.sessions)} セッション・${int(exported.turns)} 依頼・記録(.md) ${int(exported.records)} 件${exported.missing ? `。タスクタグのうち集計に無いセッション ${int(exported.missing)} 件は入っていません` : ''})。`
      : '',
  );
  function doExport(): void {
    // 書き出し中に押しても前の結果を消さない(aria-disabled は押せてしまうため)
    if (!onexport || busy) return;
    exported = null;
    uploaded = null;
    pathCopied = false;
    task = 'export';
    const name = group.name;
    void run(async () => {
      const r = await onexport(name);
      if (alive && group.name === name) exported = r;
    }, () => {});
  }
  async function copyPath(): Promise<void> {
    if (!exported) return;
    try {
      await navigator.clipboard.writeText(exported.dir);
      pathCopied = true;
    } catch (e) {
      error = `コピーできませんでした(${(e as Error).message})`;
    }
  }

  let mode = $state<'view' | 'edit' | 'delete' | 'root' | 'confirm'>('view');
  let name = $state('');
  let note = $state('');
  let error = $state('');
  let busy = $state(false);
  let nameEl = $state<HTMLInputElement | null>(null);
  let editBtn = $state<HTMLButtonElement | null>(null);
  let rootEl = $state<HTMLElement | null>(null);

  function begin(): void {
    name = group.name;
    note = group.note;
    error = '';
    mode = 'edit';
    requestAnimationFrame(() => nameEl?.select());
  }
  function leave(): void {
    mode = 'view';
    error = '';
    requestAnimationFrame(() => editBtn?.focus());
  }
  /** Esc は 1 段戻る(削除の確認 → 編集 → 表示)。外側の一覧は閉じない */
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || mode === 'view' || busy) return;
    e.stopPropagation();
    if (mode === 'delete') backToEdit();
    else if (mode === 'root') leaveRoot();
    else if (mode === 'confirm') leaveConfirm();
    else leave();
  }
  async function run(action: () => Promise<void>, after: () => void): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
      after();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
      task = null;
    }
  }
  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const n = name.trim();
    const t = note.trim();
    if (!n) {
      error = '名前を入れてください';
      nameEl?.focus();
      return;
    }
    const patch: { name?: string; note?: string } = {};
    if (n !== group.name) patch.name = n;
    if (t !== group.note) patch.note = t;
    if (!Object.keys(patch).length) {
      leave();
      return;
    }
    void run(() => onsave(group.name, patch), leave);
  }
  /** アップロード先の記入欄を閉じる(何も変えない) */
  function leaveRoot(): void {
    uploadAfterRoot = false;
    mode = 'view';
    error = '';
    requestAnimationFrame(() => uploadBtn?.focus());
  }
  function backToEdit(): void {
    error = '';
    mode = 'edit';
    requestAnimationFrame(() => rootEl?.querySelector<HTMLButtonElement>('[data-testid="group-delete"]')?.focus());
  }
  function askDelete(): void {
    error = '';
    mode = 'delete';
    requestAnimationFrame(() => rootEl?.querySelector<HTMLButtonElement>('button[data-cancel]')?.focus());
  }
  // 外す・消すと見出しごと無くなるので、焦点は本文の先頭へ(押したボタンが消えて body に落ちないように)
  const focusMain = (): void => void requestAnimationFrame(() => document.getElementById('main')?.focus());
  function clear(): void {
    onclear();
    focusMain();
  }
  // 別のグループに移ったら、またはサーバが止まって編集できなくなったら、編集中の状態は捨てる。
  // 名前は文字列の derived で見る(group は一覧の追加・外しのたびに新しいオブジェクトになり、同じグループでも打ちかけの入力が消えるため)
  const groupName = $derived(group.name);
  $effect(() => {
    void groupName;
    exported = null;
    uploaded = null;
    checked = null;
    doneElsewhere = null;
    // mode と rootEl は依存に入れない(入れると「編集」を押した直後にこの effect が走って表示に戻ってしまう)
    if (!editable) untrack(() => mode !== 'view' && rootEl?.contains(document.activeElement) && focusMain());
    mode = 'view';
    error = '';
    // 写している途中に別のページへ移って戻った(または開き直した)ときは、サーバで続いている進み具合を出し、終わるまで待つ
    // upload は依存に入れない(先を選び直すたびに作り直され、結果の表示や記入欄が消えてしまう)
    if (editable) untrack(() => upload && resumeUpload(groupName));
  });
  /**
   * 戻ったとき(別のページへ移って戻った・開き直した)に、写している途中なら進み具合を出して終わりを待ち、
   * 終わっていれば直近の結果(成功なら写した件数、失敗なら理由。サーバが 10 分覚えている)を出す。この画面から始めたものは copy() が出す
   */
  function resumeUpload(name: string): void {
    const u = upload;
    if (!u || busy) return;
    void u.progress(name).then((p) => {
      if (!alive || !p || busy || name !== group.name) return;
      if (!isProgress(p)) {
        showLast(name, p);
        return;
      }
      busy = true;
      task = 'upload';
      uploadName = name;
      progress = p;
      // 問い合わせは 0.5 秒ごとに出すので、遅い答えが重なると「終わった」を 2 回受け取る。2 回目は捨てる
      // (その間にこの見出しで写し始めていると、写している状態を消してしまうため)
      let ended = false;
      const timer = setInterval(() => {
        void u.progress(name).then(
          (q) => {
            if (ended) return;
            if (isProgress(q)) {
              if (uploadName === name) progress = q;
              return;
            }
            ended = true;
            stopTimer(timer);
            finishUpload(name);
            if (q) {
              showLast(name, q);
              noteElsewhere(name, q.ok ? { ok: true, result: q.result } : { ok: false, error: q.error ?? '理由は分かりません' });
            }
          },
          () => {
            if (ended) return;
            ended = true;
            stopTimer(timer);
            finishUpload(name);
          },
        );
      }, 500);
      timers.add(timer);
    }, () => {});
  }
  const count = $derived(group.present === group.ids.length ? `${int(group.ids.length)} 件` : `${int(group.present)} / ${int(group.ids.length)} 件`);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Esc で 1 段戻すだけ。中の操作はどれもボタンと入力欄) -->
<section class="group-head" aria-labelledby="group-head-h" data-testid="group-head" aria-busy={busy} bind:this={rootEl} onkeydown={onKey}>
  {#if mode === 'view'}
    <div class="line">
      <div class="what">
        <p class="k">タスクタグで絞り込み中</p>
        <h2 id="group-head-h"><span class="name">{group.name}</span><span class="cnt" aria-hidden="true" title={group.present === group.ids.length ? undefined : '記録にあるのは左の件数だけ'}>{count}</span><span class="sr-only">{group.present === group.ids.length ? `${int(group.ids.length)} 件` : `${int(group.ids.length)} 件のうち記録にあるのは ${int(group.present)} 件`}</span></h2>
        {#if group.note}<p class="desc">{group.note}</p>{:else if editable}<p class="desc none">説明はまだありません</p>{/if}
      </div>
      <div class="acts">
        {#if editable && upload}<button type="button" class="btn primary" bind:this={uploadBtn} data-testid="group-upload" title="このタスクタグのセッションの生ログを、アップロード先のタスクタグ名のフォルダへ写します(同じセッションは置き換え)" onclick={doUpload} aria-disabled={busy}>{task === 'check' ? '確かめています…' : task === 'upload' ? 'アップロード中…' : 'アップロード'}</button>{/if}
        {#if editable && onexport}<button type="button" class="btn" data-testid="group-export" title="このタスクタグの表(CSV)・集計・記録を 1 つのフォルダに書き出します" onclick={doExport} aria-disabled={busy}>{task === 'export' ? '書き出し中…' : '表と記録を書き出す'}</button>{/if}
        {#if editable}<button type="button" class="btn" bind:this={editBtn} data-testid="group-edit" onclick={begin}>編集</button>{/if}
        <button type="button" class="btn" onclick={clear}>絞り込みを外す</button>
      </div>
    </div>
    {#if editable && upload}
      <p class="dest" data-testid="group-upload-dest">
        <span class="k">アップロード先</span>
        {#if upload.setting.error}<span class="bad">設定ファイルを読めません({upload.setting.error})</span>
        {:else if destDir}<code translate="no">{destDir}{sep(destDir)}</code>
        {:else}<span class="none">まだ決まっていません</span>{/if}
        <button type="button" class="link" data-testid="group-upload-root" onclick={() => beginRoot(false)} disabled={busy}>{destDir ? '場所を変える…' : '場所を決める…'}</button>
      </p>
      {#if uploadStatus?.kind === 'elsewhere'}
        <p class="progress" data-testid="group-upload-elsewhere">「{uploadStatus.name}」をアップロードしています。終わるまで、ほかのタスクタグは写せません。</p>
      {:else if uploadStatus?.kind === 'done'}
        <!-- 読み上げは下の常に置いてある status が受け持つ(差し込んだ要素の role=status は読まれないことがあるため) -->
        <p class="progress" class:bad={!uploadStatus.ok} data-testid="group-upload-elsewhere-done">{uploadStatus.text}</p>
      {:else if uploadStatus?.kind === 'own'}
        <div class="progress" data-testid="group-upload-progress">
          {#if progress && progress.bytes}
            <progress max={progress.bytes} value={progress.copied} aria-label="写した量"></progress>
            <p>写しています: {int(progress.done)} / {int(progress.sessions)} セッション({size(progress.copied)} / {size(progress.bytes)})</p>
          {:else}
            <progress aria-label="写した量"></progress>
            <p>写しています…</p>
          {/if}
        </div>
      {/if}
    {/if}
  {:else if mode === 'confirm' && checked}
    <div class="confirm" role="group" aria-labelledby="group-head-h" data-testid="group-upload-confirm">
      <h2 id="group-head-h" class="q">「{group.name}」を写す前に確かめてください</h2>
      <p class="desc" data-testid="group-upload-confirm-dest">送り先: <code translate="no">{checked.dir}{sep(checked.dir)}</code> <button type="button" class="link" onclick={changeRootFromConfirm}>送り先を変える…</button></p>
      <p class="desc">{int(checked.sessions)} セッション・合計 {size(checked.bytes)}({int(checked.files)} ファイル){checked.replace ? `。うち ${int(checked.replace)} 件は前に写したものを置き換えます` : ''}。</p>
      {#if checked.largest.length && checked.bytes > CONFIRM_BYTES}
        <p class="desc">大きいもの: {#each checked.largest.slice(0, 3) as x, i (x.id + x.path)}{i ? '、' : ''}<code translate="no">{x.id.slice(0, 8)}…/{x.path}</code> {size(x.bytes)}{/each}</p>
      {/if}
      {#if checked.secrets.count}
        <div class="warn" data-testid="group-upload-secrets">
          <p><strong>秘密らしい文字列が {int(checked.secrets.count)} 件あります</strong>({checked.secrets.kinds.map((k) => `${k.label} ${int(k.count)}`).join('・')})。偽陽性もありえます。生ログはそのまま写るので、写した先で見られる人を確かめてください。本物の鍵なら、写すかどうかに関わらず作り直してください。</p>
          <ul>
            {#each checked.secrets.files as f (f.id + f.path)}<li><code translate="no">{f.id.slice(0, 8)}…/{f.path}</code> {int(f.count)} 件</li>{/each}
          </ul>
          {#if checked.secrets.skipped}<p class="note">バイナリのファイル {int(checked.secrets.skipped)} 件(session.db など)は中身を調べていません。</p>{/if}
        </div>
      {/if}
      <div class="edit-acts">
        <button type="button" class="btn" data-cancel onclick={leaveConfirm}>やめる</button>
        <button type="button" class={checked.secrets.count ? 'btn danger' : 'btn primary'} data-confirm onclick={copy}>{checked.secrets.count ? 'それでも写す' : '写す'}</button>
      </div>
    </div>
  {:else if mode === 'root' && upload}
    <form class="edit root" aria-label="アップロード先" onsubmit={submitRoot}>
      <p class="k">アップロード先(すべてのタスクタグで共通)</p>
      <h2 id="group-head-h" class="sr-only">アップロード先を決める</h2>
      <p class="desc">選んだフォルダの中に「{safeDirName(group.name)}」のフォルダを作り、セッションごとのフォルダ(名前はセッション ID)を写します。同じセッションは置き換え、ほかのフォルダには触れません。</p>
      <div class="inputs">
        <label class="fld wide"><span class="k">フォルダ(フルパス)</span><input type="text" bind:this={rootInputEl} bind:value={rootInput} readonly={busy} placeholder={'E:\\dev\\atlas-logs'} spellcheck="false" autocomplete="off" aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'group-head-error' : undefined} /></label>
      </div>
      <div class="edit-acts">
        {#if upload.setting.canPick}<button type="button" class="btn primary" data-pick onclick={pickRoot} aria-disabled={busy}>{task === 'pick' ? '選んでいます…' : 'エクスプローラーで選ぶ…'}</button>{/if}
        <button type="submit" class="btn" aria-disabled={busy}>{task === 'root' ? '保存中…' : '入力したパスにする'}</button>
        <button type="button" class="btn" onclick={leaveRoot} disabled={busy}>取消</button>
      </div>
      {#if task === 'pick'}<p class="desc">フォルダを選ぶ画面を開きました。見えないときはタスクバーを確かめてください。</p>{/if}
    </form>
  {:else if mode === 'edit'}
    <form class="edit" aria-label="タスクタグの編集" onsubmit={submit}>
      <p class="k">タスクタグの編集</p>
      <h2 id="group-head-h" class="sr-only">タスクタグ「{group.name}」の編集</h2>
      <div class="inputs">
        <label class="fld"><span class="k">名前</span><input type="text" bind:this={nameEl} bind:value={name} maxlength="100" readonly={busy} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'group-head-error' : undefined} /></label>
        <label class="fld wide"><span class="k">説明(任意)</span><input type="text" bind:value={note} maxlength="200" readonly={busy} placeholder="何のタスクか" /></label>
      </div>
      <div class="edit-acts">
        <button type="submit" class="btn" aria-disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        <button type="button" class="btn" onclick={leave} disabled={busy}>取消</button>
        <!-- 取り消せない操作は保存と離して右端に、文字だけの弱い見た目で置く -->
        <button type="button" class="link danger" data-testid="group-delete" onclick={askDelete} disabled={busy}>このタスクタグを削除…</button>
      </div>
    </form>
  {:else}
    <div class="confirm" role="group" aria-labelledby="group-head-h">
      <h2 id="group-head-h" class="q">タスクタグ「{group.name}」を削除しますか</h2>
      <p class="desc">タスクタグだけが消え、セッションと記録はそのまま残ります。</p>
      <div class="edit-acts">
        <button type="button" class="btn" data-cancel onclick={backToEdit} disabled={busy}>やめる</button>
        <button type="button" class="btn danger" data-confirm onclick={() => void run(() => ondelete(group.name), focusMain)} aria-disabled={busy}>{busy ? '削除中…' : '削除する'}</button>
      </div>
    </div>
  {/if}
  <p class="sr-only" role="status">{mode === 'view' ? exportedText || uploadedText : ''}</p>
  <p class="sr-only" role="status" data-testid="group-upload-elsewhere-status">{doneElsewhere?.text ?? ''}</p>
  {#if uploaded && mode === 'view'}
    <div class="exported" data-testid="group-uploaded">
      <p>{uploadedText}</p>
      <p class="path"><code translate="no">{uploaded.dir}</code> <button type="button" class="link" data-testid="group-upload-open" onclick={openUploaded} disabled={busy}>エクスプローラーで開く</button></p>
    </div>
  {/if}
  {#if exported && mode === 'view'}
    <div class="exported" data-testid="group-exported">
      <p>{exportedText}依頼ごとの表は turns.csv、セッションごとの表は sessions.csv です(Excel で開けます)。</p>
      <p class="path"><code translate="no">{exported.dir}</code> <button type="button" class="link" onclick={() => void copyPath()}>{pathCopied ? '場所をコピーしました' : '場所をコピー'}</button></p>
    </div>
  {/if}
  {#if error}<p class="err" id="group-head-error" role="alert">{error}</p>{/if}
</section>

<style>
  .exported {
    margin-top: 10px;
    padding: 8px 10px;
    font-size: 0.8125rem;
    background: var(--form-wash);
    border: 1px solid var(--rule);
  }
  .exported p {
    margin: 0;
  }
  .progress {
    margin-top: 8px;
    font-size: 0.8125rem;
  }
  .progress progress {
    display: block;
    width: 100%;
    max-width: 32em;
    height: 8px;
    accent-color: var(--form);
  }
  .progress p {
    margin: 4px 0 0;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }
  .confirm code {
    font-family: var(--mono);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .warn {
    margin: 8px 0;
    padding: 8px 10px;
    font-size: 0.8125rem;
    border: 1px solid var(--warn);
  }
  .warn p {
    margin: 0;
  }
  .warn ul {
    margin: 6px 0 0;
    padding-left: 1.4em;
  }
  .warn code {
    font-family: var(--mono);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .warn .note {
    margin-top: 6px;
    color: var(--ink-2);
  }
  .dest {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 10px;
    margin: 8px 0 0;
    padding-top: 6px;
    border-top: 1px solid var(--rule);
    font-size: 0.8125rem;
  }
  .dest .k {
    display: inline;
    margin: 0;
  }
  .dest code {
    font-family: var(--mono);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .dest .none {
    color: var(--ink-3);
  }
  .dest .bad,
  .progress.bad {
    color: var(--warn);
  }
  .dest .link {
    margin-left: 0;
  }
  .btn.primary {
    background: var(--form);
    color: var(--surface);
  }
  .btn.primary:hover {
    text-decoration: underline;
  }
  .exported .path {
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
  .exported code {
    font-family: var(--mono);
    font-size: 0.75rem;
  }
  .group-head {
    margin-top: 16px;
    padding: 10px 14px 12px;
    background: var(--surface);
    /* 節の見出し(.section-head)と同じ 2px の罫を上に。様式の欄の作法に合わせ、片側だけの太い縁取りにはしない */
    border: 1px solid var(--rule);
    border-top: 2px solid var(--form);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px 24px;
  }
  .what {
    min-width: 0;
  }
  .k {
    display: block;
    margin: 0 0 2px;
    font-size: 0.6875rem;
    color: var(--form);
  }
  h2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 10px;
    margin: 0;
    font-size: 1.125rem;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .cnt {
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }
  .desc {
    margin: 4px 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    max-width: 75ch;
  }
  .desc.none {
    color: var(--ink-3);
  }
  .acts,
  .edit-acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }
  .edit-acts {
    margin-top: 10px;
  }
  /* base.css の .fields(様式の罫つきの欄)と名前がぶつからないよう別名にする */
  .inputs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .fld {
    display: block;
    flex: 1 1 14em;
    max-width: 22em;
  }
  .fld.wide {
    flex: 3 1 20em;
    max-width: 40em;
  }
  .fld input {
    font: inherit;
    font-size: 0.875rem;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--control);
    border-radius: 0;
    padding: 3px 6px;
    height: 30px;
    width: 100%;
  }
  .link {
    margin-left: auto;
    padding: 4px 0;
    font: inherit;
    font-size: 0.8125rem;
    background: none;
    border: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  .link.danger {
    color: var(--warn);
  }
  .link:disabled {
    color: var(--ink-3);
    cursor: default;
  }
  .q {
    font-size: 1rem;
  }
  .btn.danger {
    border-color: var(--warn);
    color: var(--warn);
  }
  .btn.danger:hover {
    background: var(--warn-wash);
  }
  .err {
    margin: 6px 0 0;
    font-size: 0.75rem;
    color: var(--warn);
  }
</style>
