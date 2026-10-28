<script lang="ts">
  import { failureRate, unusedSkills, type UsageRanking } from '../../lib/aggregate.ts';
  import { compact, int, percent } from '../../lib/format.ts';

  type Tab = 'tools' | 'mcp' | 'skills' | 'agents' | 'hooks' | 'instructions';

  let {
    usage,
    installed,
    tab = $bindable('tools'),
  }: {
    usage: UsageRanking;
    /** インストール済みの skill(snapshot の記録。無ければ null) */
    installed: { skills: string[]; disabled: string[] } | null;
    /** 表示中の種類(要点欄のリンクから skill に切り替えられるよう親と共有する) */
    tab?: Tab;
  } = $props();

  const tabs: { key: Tab; label: string }[] = [
    { key: 'tools', label: 'ツール' },
    { key: 'mcp', label: 'MCP サーバー' },
    { key: 'skills', label: 'skill' },
    { key: 'agents', label: 'agent' },
    { key: 'hooks', label: 'hook' },
    { key: 'instructions', label: '指示ファイル' },
  ];
  type ToolOrder = 'calls' | 'rate';
  let toolOrder = $state<ToolOrder>('calls');

  const TOP_N = 10;
  /** 失敗率で並べるときの下限(結果のあった回数)。少ない回数の 100% が上位を占めないように */
  const RATE_MIN = 5;

  /** 1 行の表示: 名前・棒の値・棒の右の値・補足 */
  interface Row {
    key: string;
    name: string;
    tag?: string;
    value: number;
    valueText: string;
    note: string;
  }

  const pct = (part: number, whole: number): string => (whole > 0 ? percent(part, whole) : '—');
  const rateText = (r: { completed: number; failure: number; denied: number }): string => {
    const v = failureRate(r);
    return v == null ? '結果の記録なし' : `失敗率 ${pct(r.failure + r.denied, r.completed)}(失敗 ${int(r.failure)}・拒否 ${int(r.denied)} / ${int(r.completed)} 回)`;
  };
  /** MCP のツール名は「<サーバー>-<ツール>」なので、表示ではサーバー名の接頭辞を外す */
  const mcpToolLabel = (server: string, name: string): string => (name.startsWith(`${server}-`) ? name.slice(server.length + 1) : name);

  const rows = $derived.by((): Row[] => {
    switch (tab) {
      case 'tools': {
        const list =
          toolOrder === 'rate'
            ? usage.tools
                .filter((t) => t.completed >= RATE_MIN)
                .map((t) => ({ t, rate: failureRate(t) ?? 0 }))
                .filter((x) => x.rate > 0)
                .sort((a, b) => b.rate - a.rate || b.t.calls - a.t.calls || a.t.key.localeCompare(b.t.key))
                .map((x) => x.t)
            : usage.tools;
        return list.map((t) => ({
          key: t.key,
          name: t.label,
          tag: t.mcpServer ? 'MCP' : undefined,
          value: toolOrder === 'rate' ? (failureRate(t) ?? 0) : t.calls,
          valueText: toolOrder === 'rate' ? pct(t.failure + t.denied, t.completed) : compact(t.calls),
          note: toolOrder === 'rate' ? `${int(t.calls)} 回・失敗 ${int(t.failure)}・拒否 ${int(t.denied)}` : rateText(t),
        }));
      }
      case 'mcp':
        return usage.mcp.map((m) => ({
          key: m.server,
          name: m.server,
          value: m.calls,
          valueText: compact(m.calls),
          note: `ツール ${m.tools.length} 種(${m.tools
            .slice(0, 3)
            .map((t) => `${mcpToolLabel(m.server, t.name)} ${int(t.calls)}`)
            .join('・')}${m.tools.length > 3 ? '・…' : ''})・${rateText(m)}`,
        }));
      case 'skills':
        return usage.skills.map((s) => ({
          key: s.name,
          name: s.name,
          value: s.uses,
          valueText: compact(s.uses),
          note: `利用者が呼んだ ${int(s.user)}・エージェントが呼んだ ${int(s.agent)}${s.unknown ? `・不明 ${int(s.unknown)}` : ''}・${int(s.sessions)} セッション`,
        }));
      case 'agents':
        return usage.agents.map((a) => ({
          key: a.name,
          name: a.name,
          value: a.runs,
          valueText: compact(a.runs),
          note: `失敗 ${int(a.failed)}(${pct(a.failed, a.runs)})・トークン ${compact(a.tokens)}・${int(a.sessions)} セッション`,
        }));
      case 'hooks':
        return usage.hooks.map((h) => ({ key: h.name, name: h.name, value: h.count, valueText: compact(h.count), note: `${int(h.sessions)} セッション` }));
      case 'instructions':
        return usage.instructions.map((i) => ({
          key: i.name,
          name: i.name === 'unknown' ? '不明(特定できず)' : i.name,
          value: i.sessions,
          valueText: `${int(i.sessions)}`,
          note: 'セッションに注入',
        }));
    }
  });
  const shown = $derived(rows.slice(0, TOP_N));
  const max = $derived(Math.max(tab === 'tools' && toolOrder === 'rate' ? 0 : 1, ...shown.map((r) => r.value)) || 1);
  const tabLabel = $derived(tabs.find((t) => t.key === tab)!.label);
  const total = $derived(tab === 'tools' ? usage.tools.length : tab === 'mcp' ? usage.mcp.length : tab === 'skills' ? usage.skills.length : tab === 'agents' ? usage.agents.length : tab === 'hooks' ? usage.hooks.length : usage.instructions.length);

  const unused = $derived(installed ? unusedSkills(installed.skills, usage.skills.map((s) => s.name)) : []);
  const disabled = $derived(new Set((installed?.disabled ?? []).map((n) => n.toLowerCase())));
</script>

<section class="section" id="usage" aria-labelledby="usage-h">
  <div class="section-head">
    <h2 id="usage-h">利用ランキング</h2>
    <div class="seg" role="group" aria-label="ランキングの種類">
      {#each tabs as t}
        <button type="button" aria-pressed={tab === t.key} onclick={() => (tab = t.key)}>{t.label}</button>
      {/each}
    </div>
  </div>
  <p class="lead">
    {#if tab === 'tools'}
      絞り込み後のツール呼び出しの多い順。MCP ツールはサーバーごとに 1 行にまとめています(「MCP」の印)。失敗率は(失敗 + 拒否)÷ 結果の記録がある回数です。
    {:else if tab === 'mcp'}
      MCP サーバー(tool.execution_start の mcpServerName)ごとの呼び出し数と、よく使ったツール。
    {:else if tab === 'skills'}
      skill の呼び出し回数。「利用者が呼んだ」は skill.invoked の trigger が user-invoked のもの、「エージェントが呼んだ」は agent-invoked と skill ツールの呼び出しです。
    {:else if tab === 'agents'}
      サブエージェントの起動回数・失敗・使ったトークン(subagent.completed の totalTokens の和)。
    {:else if tab === 'hooks'}
      hook の種類(hookType)ごとの実行回数。
    {:else}
      指示ファイルが注入されたセッション数(ファイル別)。「(user)」はユーザー単位の指示ファイルです。
    {/if}
  </p>

  {#if tab === 'tools'}
    <div class="order">
      <span class="muted" id="tool-order-l">並べ方</span>
      <div class="seg" role="group" aria-labelledby="tool-order-l">
        <button type="button" aria-pressed={toolOrder === 'calls'} onclick={() => (toolOrder = 'calls')}>呼び出し回数</button>
        <button type="button" aria-pressed={toolOrder === 'rate'} onclick={() => (toolOrder = 'rate')}>失敗率({RATE_MIN} 回以上)</button>
      </div>
    </div>
  {/if}

  {#if shown.length === 0}
    <p class="note" data-testid="usage-empty">
      {tab === 'tools' && toolOrder === 'rate' ? `失敗・拒否のあったツール(結果の記録が ${RATE_MIN} 回以上)はありません。` : `この条件で${tabLabel}の記録はありません。`}
    </p>
  {:else}
    <ol class="bars" aria-label="{tabLabel}のランキング(上位 {shown.length} 件)" data-testid="usage-{tab}">
      {#each shown as r (r.key)}
        <li title="{r.name}: {r.valueText}・{r.note}">
          <span class="name">{#if r.tag}<span class="mark">{r.tag}</span>{/if}{r.name}</span>
          <span class="track">
            <span class="bar" class:rate={tab === 'tools' && toolOrder === 'rate'} style="width:calc((100% - 5em) * {r.value / max})"></span>
            <span class="val">{r.valueText}</span>
          </span>
          <span class="sub">{r.note}</span>
        </li>
      {/each}
    </ol>
  {/if}

  {#if total > 0}
    <details class="tableview">
      <summary>全件を表で見る({int(total)} 件)</summary>
      <div class="table-scroll">
        {#if tab === 'tools'}
          <table class="ledger">
            <thead>
              <tr>
                <th scope="col">ツール</th>
                <th scope="col" class="num">呼び出し</th>
                <th scope="col" class="num">成功</th>
                <th scope="col" class="num">失敗</th>
                <th scope="col" class="num">拒否</th>
                <th scope="col" class="num">結果なし</th>
                <th scope="col" class="num">失敗率</th>
                <th scope="col" class="num">セッション</th>
              </tr>
            </thead>
            <tbody>
              {#each usage.tools as t (t.key)}
                <tr>
                  <th scope="row">{#if t.mcpServer}<span class="mark">MCP</span>{/if}{t.label}</th>
                  <td class="num">{int(t.calls)}</td>
                  <td class="num">{int(t.success)}</td>
                  <td class="num">{int(t.failure)}</td>
                  <td class="num">{int(t.denied)}</td>
                  <td class="num">{int(t.calls - t.completed)}</td>
                  <td class="num">{pct(t.failure + t.denied, t.completed)}</td>
                  <td class="num">{int(t.sessions)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === 'mcp'}
          <table class="ledger">
            <thead>
              <tr>
                <th scope="col">MCP サーバー</th>
                <th scope="col" class="num">呼び出し</th>
                <th scope="col" class="num">失敗率</th>
                <th scope="col" class="num">セッション</th>
                <th scope="col">ツール(回数)</th>
              </tr>
            </thead>
            <tbody>
              {#each usage.mcp as m (m.server)}
                <tr>
                  <th scope="row">{m.server}</th>
                  <td class="num">{int(m.calls)}</td>
                  <td class="num">{pct(m.failure + m.denied, m.completed)}</td>
                  <td class="num">{int(m.sessions)}</td>
                  <td>{m.tools.map((t) => `${mcpToolLabel(m.server, t.name)} ${int(t.calls)}`).join('、')}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === 'skills'}
          <table class="ledger">
            <thead>
              <tr>
                <th scope="col">skill</th>
                <th scope="col" class="num">回数</th>
                <th scope="col" class="num">利用者が呼んだ</th>
                <th scope="col" class="num">エージェントが呼んだ</th>
                <th scope="col" class="num">不明</th>
                <th scope="col" class="num">セッション</th>
              </tr>
            </thead>
            <tbody>
              {#each usage.skills as s (s.name)}
                <tr>
                  <th scope="row">{s.name}</th>
                  <td class="num">{int(s.uses)}</td>
                  <td class="num">{int(s.user)}</td>
                  <td class="num">{int(s.agent)}</td>
                  <td class="num">{int(s.unknown)}</td>
                  <td class="num">{int(s.sessions)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === 'agents'}
          <table class="ledger">
            <thead>
              <tr>
                <th scope="col">agent</th>
                <th scope="col" class="num">回数</th>
                <th scope="col" class="num">失敗</th>
                <th scope="col" class="num">トークン</th>
                <th scope="col" class="num">セッション</th>
              </tr>
            </thead>
            <tbody>
              {#each usage.agents as a (a.name)}
                <tr>
                  <th scope="row">{a.name}</th>
                  <td class="num">{int(a.runs)}</td>
                  <td class="num">{int(a.failed)}</td>
                  <td class="num">{int(a.tokens)}</td>
                  <td class="num">{int(a.sessions)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          {@const list = tab === 'hooks' ? usage.hooks : usage.instructions}
          <table class="ledger">
            <thead>
              <tr>
                <th scope="col">{tab === 'hooks' ? 'hook の種類' : '指示ファイル'}</th>
                {#if tab === 'hooks'}<th scope="col" class="num">実行回数</th>{/if}
                <th scope="col" class="num">セッション</th>
              </tr>
            </thead>
            <tbody>
              {#each list as h (h.name)}
                <tr>
                  <th scope="row">{h.name === 'unknown' ? '不明(特定できず)' : h.name}</th>
                  {#if tab === 'hooks'}<td class="num">{int(h.count)}</td>{/if}
                  <td class="num">{int(h.sessions)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </details>
  {/if}

  {#if tab === 'skills'}
    <div class="unused" id="unused-skills" tabindex="-1" data-testid="unused-skills">
      <h3>インストール済みで未使用の skill</h3>
      {#if !installed}
        <p class="note">インストール済みの記録がありません(スナップショットを取り直すと記録されます)。</p>
      {:else if installed.skills.length === 0}
        <p class="note">~/.copilot/skills/ とプラグインに skill がありません。</p>
      {:else if unused.length === 0}
        <p class="note">インストール済みの {int(installed.skills.length)} 件はすべて、この条件のセッションで使われています。</p>
      {:else}
        <p class="note">
          インストール済み {int(installed.skills.length)} 件のうち、この条件のセッションで一度も呼ばれなかったもの {int(unused.length)} 件(~/.copilot/skills/ とプラグインのディレクトリ名。settings.json で無効にしたものには「無効」と付けています)。
        </p>
        <ul class="names">
          {#each unused as n (n)}
            <li><span class="tag">{n}{#if disabled.has(n.toLowerCase())}<span class="off">無効</span>{/if}</span></li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .lead {
    margin: 0;
    padding: 8px 12px 0;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-top: 0;
    border-bottom: 0;
    font-size: 0.75rem;
    color: var(--ink-2);
  }
  .order {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    padding: 8px 12px 0;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-top: 0;
    border-bottom: 0;
    font-size: 0.75rem;
  }
  .bars {
    list-style: none;
    margin: 0;
    padding: 10px 12px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-top: 0;
    display: grid;
    gap: 8px;
  }
  .bars li {
    display: grid;
    grid-template-columns: minmax(8em, 15em) 1fr;
    gap: 0 12px;
    align-items: center;
    font-size: 0.8125rem;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink-2);
  }
  .mark {
    display: inline-block;
    margin-right: 6px;
    padding: 0 4px;
    border: 1px solid var(--rule-strong);
    font-size: 0.6875rem;
    line-height: 1.4;
    color: var(--form);
    vertical-align: 1px;
  }
  .track {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .bar {
    display: block;
    height: 14px;
    min-width: 2px;
    background: var(--s1);
    border-radius: 0 4px 4px 0;
  }
  .bar.rate {
    background: var(--s2);
  }
  .val {
    font-size: 0.75rem;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .sub {
    grid-column: 2;
    font-size: 0.6875rem;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .unused {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-top: 0;
    padding: 10px 12px 12px;
  }
  .unused {
    /* 要点欄のリンクで飛んできたとき、固定表示のフィルタ行の下に隠れないように */
    scroll-margin-top: calc(var(--filterbar-h, 0px) + 12px);
  }
  .unused:focus {
    outline: none;
  }
  .unused:focus-visible {
    outline: 2px solid var(--form);
    outline-offset: -2px;
  }
  .unused .note {
    margin: 4px 0 0;
  }
  .names {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .off {
    margin-left: 6px;
    font-size: 0.6875rem;
    color: var(--ink-3);
  }
  @media (max-width: 720px) {
    .bars li {
      grid-template-columns: 1fr;
      gap: 2px;
    }
    .sub {
      grid-column: 1;
    }
  }
</style>
