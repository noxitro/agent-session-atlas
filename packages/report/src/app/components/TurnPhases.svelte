<script lang="ts">
  // 依頼(ターン)単位の分析の段階 1: 工程別の詰まりと、依頼の種類 × 工程。絞り込み後のセッションで集計し直す(lib/turns.ts)。
  // 工程はその依頼で使ったツール、依頼の種類は依頼文の語からの推定(LLM なし。規則は core/src/turns.ts)。
  import { PHASE_LABEL, PHASES, REQUEST_KIND_LABEL, REQUEST_KINDS, type Phase } from '../../../../core/src/turns.ts';
  import type { TurnBucket } from '../../../../core/src/turns.ts';
  import { dec, duration, int, percent } from '../../lib/format.ts';
  import type { TurnAggregate } from '../../lib/turns.ts';

  let { agg }: { agg: TurnAggregate } = $props();

  const PHASE_NOTE: Record<Phase, string> = {
    research: 'ファイルを読む・検索する・Web を調べる(編集なし)',
    plan: '計画・todo・利用者への確認だけ',
    implement: 'ファイルの編集・作成がある',
    verify: 'テスト・ビルド・型検査の実行(編集なし)',
    ops: 'git のコミット・push、PR などの操作(編集なし)',
    answer: 'ツールを使わずに答えた',
  };
  const aiu = (b: TurnBucket): string => (b.nanoAiu > 0 ? dec(b.nanoAiu / 1e9) : '—');
  const rows = $derived(PHASES.map((p) => ({ key: p, label: PHASE_LABEL[p], note: PHASE_NOTE[p], b: agg.byPhase[p] })).filter((r) => r.b.turns > 0));
</script>

<section class="section" id="phases" aria-labelledby="phases-h">
  <div class="section-head">
    <h2 id="phases-h">工程と詰まり</h2>
    <p>
      依頼(ターン)ごとに、AI が主にしたこと(工程)と、その間のつまずきを数えたものです。工程はその依頼で使ったツール、依頼の種類は依頼文の語からの推定です(LLM は使っていません)。{int(agg.turns)} 依頼・{int(agg.sessions)} セッション。
    </p>
  </div>
  {#if agg.sessionsWithoutTurns > 0}
    <p class="note" data-testid="phases-missing">依頼があるのに依頼ごとの記録が無いセッションが {int(agg.sessionsWithoutTurns)} 件あります(古い集計か、ログが DB だけのもの)。「集計し直す」で入ります。</p>
  {/if}
  {#if agg.turns === 0}
    <p class="note">依頼ごとの記録がありません。</p>
  {:else}
    <h3 class="sub">工程別</h3>
    <div class="table-scroll">
      <table class="ledger small" data-testid="phase-table">
        <thead>
          <tr>
            <th scope="col">工程</th>
            <th scope="col" class="num">依頼</th>
            <th scope="col" class="num">実働</th>
            <th scope="col" class="num">AIU</th>
            <th scope="col" class="num" title="ツールの失敗・拒否・中断・エラー・同じファイルの再編集・文脈圧縮のどれかがあった依頼">詰まりのあった依頼</th>
            <th scope="col" class="num">ツールの失敗</th>
            <th scope="col" class="num" title="権限の確認で断った操作">拒否</th>
            <th scope="col" class="num">中断</th>
            <th scope="col" class="num" title="括弧内は利用上限・速度制限によるもの">エラー</th>
            <th scope="col" class="num" title="同じセッションで前に編集したファイルをもう一度編集した回数">再編集</th>
            <th scope="col" class="num">文脈圧縮</th>
            <th scope="col" class="num" title="次の依頼が「直して」「戻して」などだった依頼 / 次の依頼があった依頼">次の依頼で直し・差し戻し</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.key)}
            <tr>
              <th scope="row"><span class="name">{r.label}</span><span class="part">{r.note}</span></th>
              <td class="num">{int(r.b.turns)}<span class="part">{percent(r.b.turns, agg.turns)}</span></td>
              <td class="num">{duration(r.b.activeMs, '—')}</td>
              <td class="num">{aiu(r.b)}</td>
              <td class="num">{int(r.b.stuck)}<span class="part">{percent(r.b.stuck, r.b.turns)}</span></td>
              <td class="num">{int(r.b.toolFailures)}</td>
              <td class="num">{int(r.b.denied)}</td>
              <td class="num">{int(r.b.aborts)}</td>
              <td class="num">{int(r.b.errors)}{#if r.b.externalErrors}<span class="part">({int(r.b.externalErrors)})</span>{/if}</td>
              <td class="num">{int(r.b.reEdits)}</td>
              <td class="num">{int(r.b.compactions)}</td>
              <td class="num">{int(r.b.followedByFix)} / {int(r.b.withNext)}<span class="part">{percent(r.b.followedByFix, r.b.withNext)}</span></td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">合計</th>
            <td class="num">{int(agg.total.turns)}</td>
            <td class="num">{duration(agg.total.activeMs, '—')}</td>
            <td class="num">{aiu(agg.total)}</td>
            <td class="num">{int(agg.total.stuck)}<span class="part">{percent(agg.total.stuck, agg.total.turns)}</span></td>
            <td class="num">{int(agg.total.toolFailures)}</td>
            <td class="num">{int(agg.total.denied)}</td>
            <td class="num">{int(agg.total.aborts)}</td>
            <td class="num">{int(agg.total.errors)}{#if agg.total.externalErrors}<span class="part">({int(agg.total.externalErrors)})</span>{/if}</td>
            <td class="num">{int(agg.total.reEdits)}</td>
            <td class="num">{int(agg.total.compactions)}</td>
            <td class="num">{int(agg.total.followedByFix)} / {int(agg.total.withNext)}<span class="part">{percent(agg.total.followedByFix, agg.total.withNext)}</span></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <h3 class="sub">依頼の種類 × 工程(どこで聞いているか)</h3>
    <div class="table-scroll">
      <table class="ledger small" data-testid="kind-table">
        <thead>
          <tr>
            <th scope="col">依頼の種類</th>
            {#each rows as r (r.key)}<th scope="col" class="num">{r.label}</th>{/each}
            <th scope="col" class="num">合計</th>
            <th scope="col" class="num" title="次の依頼が「直して」「戻して」などだった依頼 / 次の依頼があった依頼">次の依頼で直し・差し戻し</th>
          </tr>
        </thead>
        <tbody>
          {#each REQUEST_KINDS as k (k)}
            {#if agg.byKind[k].turns > 0}
              <tr>
                <th scope="row">{REQUEST_KIND_LABEL[k]}</th>
                {#each rows as r (r.key)}<td class="num">{agg.byPhase[r.key].kinds[k] ? int(agg.byPhase[r.key].kinds[k]) : '—'}</td>{/each}
                <td class="num">{int(agg.byKind[k].turns)}<span class="part">{percent(agg.byKind[k].turns, agg.turns)}</span></td>
                <td class="num">{int(agg.byKind[k].followedByFix)} / {int(agg.byKind[k].withNext)}<span class="part">{percent(agg.byKind[k].followedByFix, agg.byKind[k].withNext)}</span></td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
    <details class="how">
      <summary>工程と依頼の種類の決め方</summary>
      <ul>
        <li>工程は、その依頼から次の依頼までに使ったツール(サブエージェントの分を含む)で決めます。編集があれば実装、無くてテスト・ビルドを実行していれば検証、git の書き込みなどがあれば運用、計画・確認だけなら計画、ツールが無ければ回答のみ、それ以外は調査です。</li>
        <li>依頼の種類は、依頼文の語で分けた粗い推定です(「?」「教えて」なら質問、「直して」「違う」なら修正、「戻して」なら差し戻し、「進めて」「はい」など短い返事なら続行、それ以外は作業)。言い回しの違う修正は「作業」に入ることがあります。</li>
        <li>「次の依頼で直し・差し戻し」は、AI の成果が受け入れられなかった兆しです。採用されたかどうかの判定ではありません。</li>
        <li>1 セッションの先頭 200 依頼までを数えます。</li>
      </ul>
    </details>
  {/if}
</section>

<style>
  .sub {
    margin: 16px 0 6px;
    font-size: 0.875rem;
  }
  .name {
    display: block;
    font-weight: 600;
  }
  /* 件数の下の小さい補足(割合・内訳) */
  .part {
    display: block;
    font-size: 0.6875rem;
    font-weight: normal;
    color: var(--ink-3);
  }
  th .part {
    color: var(--ink-2);
  }
  .how {
    margin-top: 12px;
    font-size: 0.8125rem;
  }
  .how summary {
    cursor: pointer;
    color: var(--form);
    min-height: 24px;
  }
  .how ul {
    margin: 6px 0 0;
    padding-left: 1.2em;
    color: var(--ink-2);
  }
  tfoot th,
  tfoot td {
    font-weight: 600;
  }
</style>
