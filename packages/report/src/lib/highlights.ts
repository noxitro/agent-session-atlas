// Phase 7: 要点欄。絞り込んだ集計から機械的に短い一覧を作る(LLM は使わない)。
// 各項目は根拠のリンクを持つ: セッション詳細ページ(sessions/<id>.html)か、絞り込み状態の URL(#...)。
import { failureRate, unusedSkills, type UsageRanking } from './aggregate.ts';
import { filterHref, type FilterState } from './filter.ts';
import { date, dec, int, percent, truncate } from './format.ts';
import type { SessionSummary } from './types.ts';

export type HighlightKind = 'cost' | 'tool-failure' | 'compaction' | 'unused-skill';

export interface HighlightItem {
  /** 項目の本文(何がどれだけか) */
  text: string;
  /** 根拠へのリンク(詳細ページの相対パスか #... の絞り込み) */
  href: string;
  /** リンクの文言 */
  linkLabel: string;
}

export interface HighlightGroup {
  kind: HighlightKind;
  title: string;
  /** 並べ方・条件の説明 */
  basis: string;
  items: HighlightItem[];
}

/** 各グループの最大件数 */
export const HIGHLIGHT_TOP = 3;
/** 失敗率の高いツールに挙げる下限(結果の記録がある回数) */
export const HIGHLIGHT_RATE_MIN = 5;

/** 一覧での呼び名(伏せ字モードでは本文を使わない) */
export function sessionLabel(s: SessionSummary, anonymized: boolean): string {
  if (anonymized || (!s.name && !s.firstUserMessage)) return `${s.projectLabel}・${date(s.createdAt)}(${s.id.slice(0, 8)})`;
  return truncate(s.name || s.firstUserMessage || '', 48);
}

export function highlights(
  sessions: SessionSummary[],
  usage: UsageRanking,
  opts: { filter: FilterState; anonymized: boolean; installed: { skills: string[]; disabled: string[] } | null },
): HighlightGroup[] {
  const out: HighlightGroup[] = [];
  const label = (s: SessionSummary): string => sessionLabel(s, opts.anonymized);

  // 1. コストの大きいセッション: AIU、無ければ出力トークン
  const aiuTotal = sessions.reduce((a, s) => a + (s.tokens.nanoAiu ?? 0), 0);
  if (aiuTotal > 0) {
    const top = sessions
      .filter((s) => (s.tokens.nanoAiu ?? 0) > 0)
      .sort((a, b) => (b.tokens.nanoAiu ?? 0) - (a.tokens.nanoAiu ?? 0) || a.id.localeCompare(b.id))
      .slice(0, HIGHLIGHT_TOP);
    out.push({
      kind: 'cost',
      title: 'AI 使用量(AIU)の大きいセッション',
      basis: `AIU の記録があるセッションを多い順に上位 ${HIGHLIGHT_TOP} 件`,
      items: top.map((s) => ({
        text: `${label(s)}: ${dec((s.tokens.nanoAiu ?? 0) / 1e9)} AIU(この条件の合計の ${percent(s.tokens.nanoAiu ?? 0, aiuTotal)})`,
        href: s.href,
        linkLabel: 'セッションの詳細',
      })),
    });
  } else {
    const outTotal = sessions.reduce((a, s) => a + s.tokens.output, 0);
    const top = sessions
      .filter((s) => s.tokens.output > 0)
      .sort((a, b) => b.tokens.output - a.tokens.output || a.id.localeCompare(b.id))
      .slice(0, HIGHLIGHT_TOP);
    if (top.length)
      out.push({
        kind: 'cost',
        title: '出力トークンの多いセッション',
        basis: `この条件に AIU の記録が無いため、出力トークンの多い順に上位 ${HIGHLIGHT_TOP} 件`,
        items: top.map((s) => ({
          text: `${label(s)}: 出力 ${int(s.tokens.output)} トークン(この条件の合計の ${percent(s.tokens.output, outTotal)})`,
          href: s.href,
          linkLabel: 'セッションの詳細',
        })),
      });
  }

  // 2. 失敗率の高いツール(結果の記録が下限以上)。リンクはそのツールを呼んだセッションへの絞り込み
  const rates = usage.tools
    .filter((t) => t.completed >= HIGHLIGHT_RATE_MIN && (failureRate(t) ?? 0) > 0)
    .sort((a, b) => (failureRate(b) ?? 0) - (failureRate(a) ?? 0) || b.calls - a.calls || a.key.localeCompare(b.key))
    .slice(0, HIGHLIGHT_TOP);
  if (rates.length)
    out.push({
      kind: 'tool-failure',
      title: '失敗率の高いツール',
      basis: `結果の記録が ${HIGHLIGHT_RATE_MIN} 回以上で失敗・拒否のあったツールを失敗率の高い順に`,
      items: rates.map((t) => ({
        text: `${t.mcpServer ? `MCP ${t.label}` : t.label}: 失敗率 ${percent(t.failure + t.denied, t.completed)}(失敗 ${int(t.failure)}・拒否 ${int(t.denied)} / ${int(t.completed)} 回、${int(t.sessions)} セッション)`,
        href: filterHref({ ...opts.filter, tool: t.key }),
        linkLabel: 'このツールを使ったセッションに絞り込む',
      })),
    });

  // 3. compaction の多いセッション
  const comp = sessions
    .filter((s) => s.friction.compactions > 0)
    .sort((a, b) => b.friction.compactions - a.friction.compactions || b.tokens.output - a.tokens.output || a.id.localeCompare(b.id))
    .slice(0, HIGHLIGHT_TOP);
  if (comp.length)
    out.push({
      kind: 'compaction',
      title: 'compaction(文脈圧縮)の多いセッション',
      basis: `compaction の回数が多い順に上位 ${HIGHLIGHT_TOP} 件`,
      items: comp.map((s) => ({
        text: `${label(s)}: compaction ${int(s.friction.compactions)} 回${s.frictionDetail.compaction[4] > 0 ? `(減ったトークン ${int(s.frictionDetail.compaction[4])})` : ''}`,
        href: s.href,
        linkLabel: 'セッションの詳細',
      })),
    });

  // 4. インストール済みで未使用の skill(根拠は「この条件のセッション」なので、絞り込みを保ったまま未使用一覧へ)
  if (opts.installed && opts.installed.skills.length > 0) {
    const unused = unusedSkills(
      opts.installed.skills,
      usage.skills.map((s) => s.name),
    );
    if (unused.length)
      out.push({
        kind: 'unused-skill',
        title: 'インストール済みで未使用の skill',
        basis: 'この条件のセッションで一度も呼ばれなかったもの',
        items: [
          {
            text: `${int(unused.length)} / ${int(opts.installed.skills.length)} 件: ${unused.slice(0, 6).join('、')}${unused.length > 6 ? ` ほか ${int(unused.length - 6)} 件` : ''}`,
            href: filterHref(opts.filter, 'unused-skills'),
            linkLabel: '未使用の skill の一覧',
          },
        ],
      });
  }
  return out;
}
