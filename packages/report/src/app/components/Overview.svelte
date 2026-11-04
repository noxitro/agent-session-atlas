<script lang="ts">
  import type { Aggregate } from '../../lib/aggregate.ts';
  import { date, dec, duration, int, percent } from '../../lib/format.ts';
  import { confidenceLabel } from '../../lib/judgment-labels.ts';

  let {
    agg,
    judged,
    anonymized,
    warnings,
    filtered,
    includeEmpty,
    emptyCount,
    emptyInFilter,
    part = 'cover',
  }: {
    agg: Aggregate;
    judged: boolean;
    anonymized: boolean;
    warnings: { unknownEventTypes: number; badLines: number; notes: string[] };
    filtered: boolean;
    /** 空のセッションを含めているか */
    includeEmpty: boolean;
    /** 全データ中の空のセッション数 */
    emptyCount: number;
    /** 今の絞り込み(空を含めるかを除く)に当てはまる空のセッション数 */
    emptyInFilter: number;
    /** 表紙(規模の 4 欄。要点の前に置く)か、集計明細(残りの 12 欄と入力トークン記録の内訳。要点の後に置く)か */
    part?: 'cover' | 'detail';
  } = $props();

  const o = $derived(agg.overall);
  const c = $derived(agg.coverage);
  // ツール全体の結果(失敗率の分母は結果の記録がある回数)
  const toolResults = $derived(
    agg.usage.tools.reduce((a, t) => ({ completed: a.completed + t.completed, failure: a.failure + t.failure, denied: a.denied + t.denied }), { completed: 0, failure: 0, denied: 0 }),
  );
  const segments = $derived([
    { key: 'detailed', label: 'リクエスト単位の明細あり', note: 'session-store.db / usage_record', n: c.detailed, color: 'var(--s1)' },
    { key: 'shutdown', label: '終了時の累計のみ', note: 'session.shutdown の modelMetrics', n: c.shutdown, color: 'var(--s2)' },
    { key: 'output', label: '出力のみ(入力は推計不可)', note: 'assistant.message の outputTokens', n: c.outputOnly, color: 'var(--s3)' },
    {
      key: 'none',
      label: '記録なし(欠測)',
      note: 'DB・usage_record・終了時の累計・outputTokens のいずれも無い。2026-09 以降は assistant.message に outputTokens が無いため、出力トークンも分からない',
      n: c.none,
      color: 'var(--missing)',
    },
    ...(c.empty > 0 ? [{ key: 'empty', label: '空のセッション', note: '依頼・ツール・応答が無い(開いただけ)', n: c.empty, color: 'var(--rule-strong)' }] : []),
  ]);
  const totalN = $derived(o.sessions);
  let hover = $state<string | null>(null);
</script>

{#if part === 'cover'}
<section class="section" id="overview" aria-labelledby="overview-h">
  <div class="section-head">
    <h2 id="overview-h">全体サマリ</h2>
    <p>{filtered ? '絞り込み後の値' : '全セッションの値'}。規模の 4 欄。トークンやツールなどの明細は要点の下の「集計明細」にあります。</p>
  </div>
  {#if !includeEmpty && emptyCount > 0}
    <p class="excluded" data-testid="empty-excluded">{#if filtered}この条件の空のセッション {int(emptyInFilter)} 件を除外(全体では {int(emptyCount)} 件。{:else}空のセッション {int(emptyCount)} 件を除外({/if}依頼・ツール呼び出し・応答がどれも無いもの。絞り込みの「その他の条件」の「空のセッションを含める」で含められます)</p>
  {/if}

  <div class="fields" style="--cols:4">
    <div class="field">
      <span class="k">セッション</span><span class="v">{int(o.sessions)}</span>
      <span class="n">依頼 {int(o.turns)} 回{#if o.autopilotContinuations > 0}・autopilot の自動継続 {int(o.autopilotContinuations)} 回は別{/if}{#if includeEmpty}・うち空 {int(o.emptySessions)}{/if}</span>
    </div>
    <div class="field">
      <span class="k">期間(開始日)</span><span class="v period">{o.firstAt ? `${date(o.firstAt)} 〜 ${date(o.lastAt)}` : '—'}</span>
    </div>
    <div class="field">
      <span class="k">実働時間の合計</span><span class="v">{duration(o.activeMs, '—')}</span><span class="n">中央値 {duration(o.activeMedianMs, '—')} / セッション</span>
    </div>
    <div class="field">
      <span class="k">推定人手工数</span>
      {#if judged && o.judgedSessions > 0}
        <span class="v">{dec(o.humanHours)} 時間</span><span class="n">LLM の推定。判定済み {int(o.judgedSessions)} セッション、幅 {dec(o.humanLow)}〜{dec(o.humanHigh)} 時間</span>
      {:else}
        <span class="v missing">未判定</span><span class="n">LLM による工数判定はまだ実行していません</span>
      {/if}
    </div>
  </div>
</section>
{:else}
<section class="section" id="detail" aria-labelledby="detail-h">
  <div class="section-head">
    <h2 id="detail-h">集計明細</h2>
    <p>{filtered ? '絞り込み後の値' : '全セッションの値'}。入力トークン・AI 使用量(AIU)・premium request・変更行数は記録のあるセッションだけの合計です。</p>
  </div>

  <div class="fields" style="--cols:4">
    <div class="field">
      <span class="k">入力トークン</span><span class="v">{int(o.tokens.input)}</span>
      <span class="n">記録あり {int(o.sessionsWithInput)} / {int(o.sessions)} セッション({percent(o.sessionsWithInput, o.sessions)})</span>
    </div>
    <div class="field">
      <span class="k">出力トークン</span><span class="v">{int(o.tokens.output)}</span>
      <span class="n">{#if c.none > 0}記録なし(欠測){int(c.none)} セッションは含まない{:else}記録のあるセッションの合計{/if}</span>
    </div>
    <div class="field">
      <span class="k">うち推論トークン</span><span class="v">{int(o.tokens.reasoning)}</span>
      <span class="n">出力トークンに対して {percent(o.tokens.reasoning, o.tokens.output)}</span>
    </div>
    <div class="field">
      <span class="k">キャッシュ読取トークン</span><span class="v">{int(o.tokens.cacheRead)}</span>
      <span class="n">入力に対して {percent(o.tokens.cacheRead, o.tokens.input)}</span>
    </div>

    <div class="field">
      <span class="k">AI 使用量(AIU)</span>
      {#if o.sessionsWithNanoAiu > 0}<span class="v">{dec(o.tokens.nanoAiu / 1e9)}</span>{:else}<span class="v missing">記録なし</span>{/if}
      <span class="n">記録あり {int(o.sessionsWithNanoAiu)} / {int(o.sessions)} セッション({percent(o.sessionsWithNanoAiu, o.sessions)})</span>
    </div>
    <div class="field">
      <span class="k">premium request</span>
      {#if o.sessionsWithPremium > 0}<span class="v">{dec(o.tokens.premiumRequests)}</span>{:else}<span class="v missing">記録なし</span>{/if}
      <span class="n">記録あり {int(o.sessionsWithPremium)} / {int(o.sessions)} セッション({percent(o.sessionsWithPremium, o.sessions)})</span>
    </div>
    <div class="field">
      <span class="k">API リクエスト</span><span class="v">{int(o.tokens.requests)}</span>
      <span class="n">終了時の累計とリクエスト単位の明細の合計(明細があるのは {int(c.detailed)} セッション)</span>
    </div>
    <div class="field">
      <span class="k">ツール呼び出し</span><span class="v">{int(o.tools)}</span>
      <span class="n">失敗率 {toolResults.completed ? percent(toolResults.failure + toolResults.denied, toolResults.completed) : '—'}(失敗 {int(toolResults.failure)}・拒否 {int(toolResults.denied)}){#if o.toolsInternal > 0}・内部ツール(report_intent){int(o.toolsInternal)} 回は除外{/if}</span>
    </div>

    <div class="field" data-testid="lines-field">
      <span class="k">変更行数</span>
      {#if o.sessionsWithLines > 0}<span class="v">+{int(o.linesAdded)} / −{int(o.linesRemoved)}</span>{:else}<span class="v missing">記録なし</span>{/if}
      <span class="n">追加 / 削除。記録あり {int(o.sessionsWithLines)} / {int(o.sessions)} セッション</span>
    </div>
    <div class="field">
      <span class="k">skill / agent / hook</span><span class="v">{int(o.skills)} / {int(o.agents)} / {int(o.hooks)}</span>
      <span class="n">呼び出し回数。agent の失敗 {int(o.agentFailures)}</span>
    </div>
    <div class="field">
      <span class="k">指示ファイル / llm-wiki</span><span class="v">{int(o.sessionsWithInstructions)} / {int(o.sessionsWithWiki)}</span>
      <span class="n">注入された / 参照したセッション数</span>
    </div>
    <div class="field">
      <span class="k">摩擦</span><span class="v">{int(o.friction)}</span>
      <span class="n">ツールの失敗・拒否 {int(o.frictionDetail.toolFailures)}・エラー(session.error){int(o.frictionDetail.errors)}・compaction {int(o.frictionDetail.compactions)}・中断 {int(o.frictionDetail.aborts)}・権限確認 {int(o.frictionDetail.permissionRequests)}・ask_user {int(o.frictionDetail.askUser)}・サブエージェントの失敗 {int(o.frictionDetail.subagentFailures)}(<a href="#exec">詳細は実行の性質</a>)</span>
    </div>
  </div>

  <div class="coverage">
    <div class="cov-head">
      <h3 id="cov-h">入力トークン記録の内訳</h3>
      <p class="muted">ログの形式が新しいほど細かく記録されています。記録の無いセッションの入力トークンは推計していません。</p>
    </div>
    {#if totalN > 0}
      <div class="stack" role="img" aria-labelledby="cov-h" aria-describedby="cov-legend">
        {#each segments as s (s.key)}
          {#if s.n > 0}
            <span
              class="piece"
              class:dim={hover && hover !== s.key}
              class:hatch={s.key === 'none'}
              style="flex-grow:{s.n};background-color:{s.color}"
              title="{s.label}: {int(s.n)} セッション({percent(s.n, totalN)})"
            ></span>
          {/if}
        {/each}
      </div>
    {/if}
    <ul class="legend" id="cov-legend">
      {#each segments as s (s.key)}
        <li onpointerenter={() => (hover = s.key)} onpointerleave={() => (hover = null)}>
          <span class="sw" class:hatch={s.key === 'none'} style="background-color:{s.color}" aria-hidden="true"></span>
          <span class="lab">{s.label}</span>
          <strong>{int(s.n)}</strong>
          <span class="muted">({percent(s.n, totalN)})</span>
          <span class="src muted">{s.note}</span>
        </li>
      {/each}
    </ul>
    <ul class="missing-legend" aria-label="欠測の語の使い分け">
      <li><b>記録なし</b><span>ログにその項目の記録が無い</span></li>
      <li><b>推計不可</b><span>出力トークンだけ記録があり、入力は求められない</span></li>
      <li><b>未判定</b><span>LLM による工数判定をまだ実行していない</span></li>
      <li><b>不明</b><span>記録はあるが分類できない(クライアント・モデルなど)</span></li>
      <li><b>—</b><span>該当なし(0 件、または求める元の値が無い)</span></li>
    </ul>
  </div>

  {#if anonymized}
    <p class="note">伏せ字モード: プロジェクト名・パス・ブランチは仮名(project-01 など)に置き換え、依頼本文・セッション名は表示していません。</p>
  {/if}
  {#if warnings.unknownEventTypes > 0}
    <p class="note">ログに未知のイベント種別が {int(warnings.unknownEventTypes)} 件ありました(集計からは除外し、件数だけ数えています)。</p>
  {/if}
  {#each warnings.notes as n (n)}
    <p class="note">メモとグループの読み取りの注意: {n}</p>
  {/each}
</section>
{/if}

<style>
  .period {
    font-size: 1.0625rem;
  }
  .excluded {
    margin: 0 0 8px;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .missing {
    color: var(--ink-3);
  }
  .field > .n a {
    color: inherit;
    text-decoration-color: var(--rule-strong);
  }
  .field > .n a:hover {
    color: var(--form);
  }
  .coverage {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-top: 0;
    padding: 10px 12px 12px;
  }
  .cov-head {
    display: flex;
    gap: 4px 16px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .cov-head p {
    margin: 0;
    font-size: 0.75rem;
  }
  .stack {
    display: flex;
    gap: 2px;
    height: 18px;
    margin-top: 10px;
    background: var(--surface);
  }
  .piece {
    display: block;
    min-width: 3px;
    flex-basis: 0;
    transition: opacity 150ms ease-out;
  }
  .piece.dim {
    opacity: 0.35;
  }
  /* 欠測は色だけでなく斜線でも区別する */
  .hatch {
    background-image: repeating-linear-gradient(135deg, transparent 0 3px, var(--surface) 3px 4px);
  }
  .legend {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 6px 20px;
    font-size: 0.8125rem;
  }
  /* 行の高さは一番長い凡例に揃うので、中身は上に詰める(詰めないと色の印が行の中ほどに下がる) */
  .legend li {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    align-items: baseline;
    gap: 0 6px;
  }
  .sw {
    width: 10px;
    height: 10px;
    flex: none;
    align-self: center;
  }
  .src {
    flex-basis: 100%;
    padding-left: 16px;
    font-size: 0.75rem;
  }
</style>
