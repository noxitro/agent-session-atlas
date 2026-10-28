<script lang="ts">
  import { DURATION_MIN_CALLS, type ExecAggregate } from '../../lib/exec.ts';
  import { effortLabel, errorTypeLabel, initiatorLabel, modeLabel, subagentFailureLabel, TODO_STATUS_ORDER, todoStatusLabel } from '../../lib/exec-labels.ts';
  import { compact, dec, int, modelLabel, msLabel, percent } from '../../lib/format.ts';

  let { exec, sessions }: { exec: ExecAggregate; sessions: number } = $props();

  const TOP = 10;
  const modeMax = $derived(Math.max(1, ...exec.modes.rows.map((r) => r.turns)));
  const initMax = $derived(Math.max(1, ...exec.initiators.rows.map((r) => r.requests)));
  const slowTools = $derived(exec.toolDurations.rows.filter((r) => r.n >= DURATION_MIN_CALLS).slice(0, TOP));
  const todoKeys = $derived([...TODO_STATUS_ORDER, ...Object.keys(exec.todos.byStatus).filter((k) => !TODO_STATUS_ORDER.includes(k)).sort()]);
  const pctOrDash = (x: number | null): string => (x == null ? '—' : percent(x, 1));
  const p = $derived(exec.friction.permissions);
  const permTotal = $derived(p.approved + p.denied + p.other);
</script>

<section class="section" id="exec" aria-labelledby="exec-h">
  <div class="section-head">
    <h2 id="exec-h">実行の性質</h2>
    <p>絞り込み後 {int(sessions)} セッションの、どう動かしたか(モード・推論強度・起点)と、どこで時間と文脈を使ったか。値は記録のあるものだけの集計です。</p>
  </div>

  <div class="panels">
    <div class="panel" data-testid="exec-modes">
      <h3>モード別の依頼</h3>
      {#if exec.modes.total === 0}
        <p class="note">依頼の記録がありません。</p>
      {:else}
        <ol class="bars" aria-label="モード別の依頼の回数">
          {#each exec.modes.rows as r (r.key)}
            <li>
              <span class="name">{modeLabel(r.key)}</span>
              <span class="track"><span class="bar" style="width:calc((100% - 6.5em) * {r.turns / modeMax})"></span><span class="val">{int(r.turns)}({percent(r.turns, exec.modes.total)})</span></span>
            </li>
          {/each}
        </ol>
        <p class="foot">
          依頼(ユーザーのターン)ごとのモード。user.message の agentMode、無ければ直前の mode_changed で決めています。{#if exec.modes.inferred > 0}モードの記録が無い {int(exec.modes.inferred)} 回は既定の interactive とみなしました(対話に含む)。{/if}
        </p>
      {/if}
    </div>

    <div class="panel" data-testid="exec-efforts">
      <h3>推論強度別</h3>
      {#if exec.efforts.length === 0}
        <p class="note">リクエストの記録がありません。</p>
      {:else}
        <div class="table-scroll">
          <table class="ledger">
            <thead>
              <tr><th scope="col">推論強度</th><th scope="col" class="num">リクエスト</th><th scope="col" class="num">入力</th><th scope="col" class="num">出力</th><th scope="col" class="num">AIU</th></tr>
            </thead>
            <tbody>
              {#each exec.efforts as r (r.key)}
                <tr>
                  <th scope="row">{effortLabel(r.key)}</th>
                  <td class="num">{int(r.requests)}</td>
                  <td class="num">{compact(r.input)}</td>
                  <td class="num">{compact(r.output)}</td>
                  <td class="num">{dec(r.nanoAiu / 1e9)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="foot">リクエストの reasoningEffort、無ければその時点の設定(session.start / model_change)。終了時の累計しか無いセッションは、設定が 1 種類ならその強度に、それ以外は「不明」に入れています。</p>
      {/if}
    </div>

    <div class="panel" data-testid="exec-initiators">
      <h3>リクエストの起点</h3>
      {#if exec.initiators.total === 0}
        <p class="note">リクエスト単位の記録がありません。</p>
      {:else}
        <ol class="bars" aria-label="起点別のリクエスト数">
          {#each exec.initiators.rows as r (r.key)}
            <li>
              <span class="name">{initiatorLabel(r.key)}</span>
              <span class="track"><span class="bar" class:dim={r.key === '(unknown)'} style="width:calc((100% - 6.5em) * {r.requests / initMax})"></span><span class="val">{int(r.requests)}({percent(r.requests, exec.initiators.total)})</span></span>
            </li>
          {/each}
        </ol>
        <p class="foot">API リクエスト {int(exec.initiators.total)} 回を、誰が起こしたか(initiator)で分けたもの。リクエスト単位の明細(session-store.db / usage_record)があるセッションだけです。</p>
      {/if}
    </div>

    <div class="panel" data-testid="exec-context">
      <h3>文脈の内訳(ツール定義)</h3>
      {#if exec.context.sessions === 0}
        <p class="note">文脈の内訳の記録がありません。</p>
      {:else}
        <dl class="kv">
          <div><dt>ツール定義の平均</dt><dd>{int(exec.context.toolDefAvg)} トークン</dd></div>
          <div><dt>中央値</dt><dd>{int(exec.context.toolDefMedian)} トークン</dd></div>
          <div><dt>文脈に占める割合</dt><dd>{pctOrDash(exec.context.shareAvg)}</dd></div>
          <div><dt>使えるツールの数</dt><dd>{exec.context.availableToolsAvg == null ? '—' : `平均 ${dec(exec.context.availableToolsAvg)}`}</dd></div>
        </dl>
        <div class="table-scroll">
          <table class="ledger">
            <caption class="sr-only">プロジェクト別のツール定義のトークン</caption>
            <thead>
              <tr><th scope="col">プロジェクト</th><th scope="col" class="num">ツール定義(平均)</th><th scope="col" class="num">割合</th><th scope="col" class="num">セッション</th></tr>
            </thead>
            <tbody>
              {#each exec.context.byProject.slice(0, 8) as r (r.key)}
                <tr><th scope="row" title={r.key}>{r.label}</th><td class="num">{int(r.toolDefAvg)}</td><td class="num">{pctOrDash(r.shareAvg)}</td><td class="num">{int(r.sessions)}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if exec.context.byProject.length > 8}
          <details class="tableview">
            <summary>全 {int(exec.context.byProject.length)} プロジェクトを表で見る</summary>
            <div class="table-scroll">
              <table class="ledger">
                <thead><tr><th scope="col">プロジェクト</th><th scope="col" class="num">ツール定義(平均)</th><th scope="col" class="num">割合</th><th scope="col" class="num">セッション</th></tr></thead>
                <tbody>
                  {#each exec.context.byProject as r (r.key)}
                    <tr><th scope="row" title={r.key}>{r.label}</th><td class="num">{int(r.toolDefAvg)}</td><td class="num">{pctOrDash(r.shareAvg)}</td><td class="num">{int(r.sessions)}</td></tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </details>
        {/if}
        <p class="foot">
          ツール定義は毎リクエストの文脈に入る固定費です。セッションの最後の値(終了時か compaction の toolDefinitionsTokens、無ければ usage_record の toolTokenCount)。記録あり {int(exec.context.sessions)} / {int(sessions)} セッション、割合は system・会話・ツール定義が揃った {int(exec.context.shareSessions)} セッションの平均。
        </p>
      {/if}
    </div>

    <div class="panel" data-testid="exec-latency">
      <h3>モデル別の待ち時間</h3>
      {#if exec.latency.length === 0}
        <p class="note">待ち時間の記録がありません。</p>
      {:else}
        <div class="table-scroll">
          <table class="ledger">
            <thead>
              <tr>
                <th scope="col" rowspan="2">モデル</th>
                <th scope="colgroup" colspan="3" class="grp">最初のトークンまで</th>
                <th scope="colgroup" colspan="2" class="grp">リクエスト全体</th>
              </tr>
              <tr><th scope="col" class="num">件数</th><th scope="col" class="num">中央値</th><th scope="col" class="num">p90</th><th scope="col" class="num">中央値</th><th scope="col" class="num">p90</th></tr>
            </thead>
            <tbody>
              {#each exec.latency.slice(0, TOP) as r (r.model)}
                <tr>
                  <th scope="row" title={r.model}>{modelLabel(r.model)}</th>
                  <td class="num">{int(r.ttft.n)}</td>
                  <td class="num">{msLabel(r.ttft.median)}</td>
                  <td class="num">{msLabel(r.ttft.p90)}</td>
                  <td class="num">{msLabel(r.duration.median)}</td>
                  <td class="num">{msLabel(r.duration.p90)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="foot">session-store.db の time_to_first_token_ms / duration_ms と usage_record の同じ値(リクエスト単位)。p90 は遅い方から 1 割の境目です。{#if exec.latency.length > TOP}リクエストの多い {TOP} モデルを表示。{/if}</p>
      {/if}
    </div>

    <div class="panel" data-testid="exec-tool-durations">
      <h3>ツールの所要時間</h3>
      {#if exec.toolDurations.measured === 0 && exec.toolDurations.outliers === 0}
        <p class="note">ツールの開始と完了が対応する記録がありません。</p>
      {:else}
        {#if slowTools.length === 0}
          <p class="note">{DURATION_MIN_CALLS} 回以上記録のあるツールはありません。</p>
        {:else}
          <div class="table-scroll">
            <table class="ledger">
              <thead><tr><th scope="col">ツール</th><th scope="col" class="num">回数</th><th scope="col" class="num">中央値</th><th scope="col" class="num">p90</th><th scope="col" class="num">外れ値</th></tr></thead>
              <tbody>
                {#each slowTools as r (r.tool)}
                  <tr><th scope="row">{r.tool}</th><td class="num">{int(r.n)}</td><td class="num">{msLabel(r.median)}</td><td class="num">{msLabel(r.p90)}</td><td class="num">{r.outliers ? int(r.outliers) : '—'}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <details class="tableview">
          <summary>全 {int(exec.toolDurations.rows.length)} ツールを表で見る</summary>
          <div class="table-scroll">
            <table class="ledger">
              <thead><tr><th scope="col">ツール</th><th scope="col" class="num">回数</th><th scope="col" class="num">中央値</th><th scope="col" class="num">p90</th><th scope="col" class="num">外れ値</th></tr></thead>
              <tbody>
                {#each exec.toolDurations.rows as r (r.tool)}
                  <tr><th scope="row">{r.tool}</th><td class="num">{int(r.n)}</td><td class="num">{msLabel(r.median)}</td><td class="num">{msLabel(r.p90)}</td><td class="num">{r.outliers ? int(r.outliers) : '—'}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        </details>
        <p class="foot">
          開始から完了まで(toolCallId で対応)。{DURATION_MIN_CALLS} 回以上のツールを p90 の長い順に。1 時間を超えたもの {int(exec.toolDurations.outliers)} 回は外れ値(放置や待ち)として中央値・p90 から除いています。ask_user や task は利用者・サブエージェントの待ちを含みます。
        </p>
      {/if}
    </div>

    <div class="panel" data-testid="exec-friction">
      <h3>摩擦の詳細</h3>
      <dl class="kv">
        <div>
          <dt>権限の確認の結果</dt>
          <dd>{permTotal ? `承認 ${int(p.approved)}・拒否 ${int(p.denied)}${p.other ? `・その他 ${int(p.other)}` : ''}` : '記録なし'}</dd>
        </div>
        <div>
          <dt>エラーの種別</dt>
          <dd>{exec.friction.errorTypes.length ? exec.friction.errorTypes.map((x) => `${errorTypeLabel(x.name)} ${int(x.count)}`).join('・') : 'なし'}</dd>
        </div>
        <div>
          <dt>サブエージェント失敗の理由</dt>
          <dd>{exec.friction.subagentFailures.length ? exec.friction.subagentFailures.map((x) => `${subagentFailureLabel(x.name)} ${int(x.count)}`).join('・') : 'なし'}</dd>
        </div>
        <div>
          <dt>compaction 自体のトークン</dt>
          <dd>
            {#if exec.friction.compaction.recorded > 0}
              入力 {compact(exec.friction.compaction.input)}・出力 {compact(exec.friction.compaction.output)}{exec.friction.compaction.nanoAiu ? `・${dec(exec.friction.compaction.nanoAiu / 1e9)} AIU` : ''}(記録 {int(exec.friction.compaction.recorded)} / {int(exec.friction.compaction.compactions)} 回)
            {:else}
              {exec.friction.compaction.compactions ? `記録なし(compaction ${int(exec.friction.compaction.compactions)} 回)` : 'compaction なし'}
            {/if}
          </dd>
        </div>
        {#if exec.friction.compaction.tokensRemoved > 0}
          <div><dt>compaction で減ったトークン</dt><dd>{int(exec.friction.compaction.tokensRemoved)}</dd></div>
        {/if}
      </dl>
      <p class="foot">権限の確認は permission.completed の結果、エラーは session.error の errorType、サブエージェントの失敗は subagent.failed の error を分類したもの。</p>
    </div>

    <div class="panel" data-testid="exec-todos">
      <h3>todo</h3>
      {#if exec.todos.sessionsWithDb === 0}
        <p class="note">session.db(todo の記録)のあるセッションがありません。</p>
      {:else if exec.todos.total === 0}
        <p class="note">session.db のある {int(exec.todos.sessionsWithDb)} セッションに todo はありません。</p>
      {:else}
        <dl class="kv">
          <div><dt>完了率</dt><dd>{pctOrDash(exec.todos.completionRate)}({int(exec.todos.byStatus.done ?? 0)} / {int(exec.todos.total)} 件)</dd></div>
          <div><dt>状態別</dt><dd>{todoKeys.filter((k) => exec.todos.byStatus[k]).map((k) => `${todoStatusLabel(k)} ${int(exec.todos.byStatus[k])}`).join('・')}</dd></div>
          <div><dt>依存関係</dt><dd>{int(exec.todos.deps)} 件</dd></div>
          <div><dt>todo のあるセッション</dt><dd>{int(exec.todos.sessionsWithTodos)} / {int(sessions)}</dd></div>
        </dl>
        <p class="foot">エージェントが session.db に残した todo の状態(セッション終了時点)。タイトルは読んでいません。</p>
      {/if}
    </div>
  </div>
</section>

<style>
  .panels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr));
    border-top: 1px solid var(--rule-strong);
    border-left: 1px solid var(--rule);
    background: var(--surface);
  }
  .panel {
    border-right: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    padding: 8px 12px 12px;
    min-width: 0;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 0.8125rem;
    color: var(--form);
  }
  .foot {
    margin: 6px 0 0;
    font-size: 0.6875rem;
    color: var(--ink-3);
  }
  .bars {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .bars li {
    display: grid;
    grid-template-columns: minmax(7em, 11em) 1fr;
    gap: 0 10px;
    align-items: center;
    font-size: 0.8125rem;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-2);
  }
  .track {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .bar {
    display: block;
    height: 12px;
    min-width: 2px;
    background: var(--s1);
    border-radius: 0 3px 3px 0;
  }
  .bar.dim {
    background: var(--missing);
  }
  .val {
    font-size: 0.75rem;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .kv {
    margin: 0 0 8px;
    display: grid;
    gap: 4px;
    font-size: 0.8125rem;
  }
  .kv div {
    display: grid;
    grid-template-columns: minmax(9em, 13em) 1fr;
    gap: 8px;
  }
  .kv dt {
    color: var(--ink-3);
    font-size: 0.75rem;
  }
  .kv dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums;
  }
  th.grp {
    text-align: center;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .kv div {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }
</style>
