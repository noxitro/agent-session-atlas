// 似た依頼のまとめ方(requestCandidates)を、3 文字の組の索引で数える形にしても、1 件ずつ全部のまとまりと比べていたときと
// 同じ結果になること。架空の依頼文をたくさん作り、前のやり方(下の naiveRequestCandidates。変える前の requestCandidates の写し)と比べる
import { describe, expect, it } from 'vitest';
import {
  jaccard,
  median,
  normalizeRequest,
  PROBE_REQUEST,
  requestCandidates,
  SCORE_MS_CAP,
  THRESHOLDS,
  trigrams,
  TRIVIAL_REQUEST,
  type Candidate,
  type CandidateSource,
} from '../src/lib/insights.ts';

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const scoreOf = (count: number, medianMs: number | null): number => count * (medianMs != null ? Math.max(1, Math.min(medianMs, SCORE_MS_CAP) / 60_000) : 1);

/** 変える前の requestCandidates(先に作ったまとまりから順に、代表との類似度がしきい値以上の最初のまとまりに入れる) */
function naiveRequestCandidates(sources: CandidateSource[], anonymized: boolean): Candidate[] {
  type Item = { id: string; text: string; norm: string; grams: Set<string>; ms: number | null };
  const items: Item[] = [];
  for (const s of sources) {
    s.analysis.requests.forEach((text, i) => {
      if (!text || TRIVIAL_REQUEST.test(text.trim()) || PROBE_REQUEST.test(text.trim())) return;
      const norm = normalizeRequest(text);
      if (norm.length < THRESHOLDS.MIN_REQUEST_CHARS) return;
      items.push({ id: s.id, text, norm, grams: trigrams(norm), ms: s.analysis.turnActiveMs?.[i] ?? null });
    });
  }
  const clusters: { rep: Item; members: Item[] }[] = [];
  for (const it of items) {
    const c = clusters.find((x) => jaccard(x.rep.grams, it.grams) >= THRESHOLDS.SIMILARITY);
    if (c) c.members.push(it);
    else clusters.push({ rep: it, members: [it] });
  }
  const out: Candidate[] = [];
  for (const c of clusters) {
    const sessions = [...new Set(c.members.map((m) => m.id))];
    if (c.members.length < THRESHOLDS.MIN_REPEAT || sessions.length < 2) continue;
    const rep = c.members.map((m) => ({ m, s: sum(c.members.map((o) => jaccard(m.grams, o.grams))) })).sort((a, b) => b.s - a.s)[0]!.m;
    const medianMs = median(c.members.map((m) => m.ms).filter((x): x is number => x != null));
    out.push({
      kind: 'request',
      key: rep.norm,
      count: c.members.length,
      sessions,
      medianMs,
      score: scoreOf(c.members.length, medianMs),
      representative: anonymized ? null : rep.text,
      examples: anonymized ? [] : c.members.filter((m) => m !== rep).slice(0, 3).map((m) => m.text),
      tools: null,
    });
  }
  out.sort((a, b) => b.score - a.score || b.count - a.count);
  return anonymized ? out.map((c, i) => ({ ...c, key: `request-${i + 1}` })) : out;
}

/** 決まった種から作る、似たもの(0〜1 語の差し替え)と似ていないものが混ざった依頼文 */
function sources(n: number, seed0: number): CandidateSource[] {
  // mulberry32(決まった種から、毎回同じ並びの乱数を作る)
  let seed = seed0 >>> 0;
  const rnd = (k: number): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * k);
  };
  const words = ['テスト', 'を', '直して', 'ビルド', 'エラー', 'の', '原因', '調べて', 'README', 'に', '追記', 'して', 'レビュー', 'お願い', 'します', 'ログ', '確認', '設定', '画面', '追加', 'src/app.ts', '12', 'fix'];
  const make = (): string => Array.from({ length: 12 + rnd(8) }, () => words[rnd(words.length)]).join(' ');
  const bases = Array.from({ length: 15 }, make);
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i % 50}`,
    project: 'p',
    analysis: {
      requests: Array.from({ length: 3 }, () => {
        if (rnd(4) === 0) return make();
        const b = bases[rnd(bases.length)]!.split(' ');
        for (let k = rnd(2); k > 0; k--) b[rnd(b.length)] = words[rnd(words.length)]!;
        return b.join(' ');
      }),
      turnTools: [],
      turnActiveMs: Array.from({ length: 3 }, () => (rnd(3) === 0 ? null : rnd(600_000))),
    },
  }));
}

describe('requestCandidates: 似た依頼のまとめ方', () => {
  it('索引で数えても、1 件ずつ全部のまとまりと比べたときと同じ候補になる(伏せ字版も)', () => {
    for (const seed of [1, 42, 12345, 987654]) {
      const src = sources(300, seed);
      const got = requestCandidates(src, false);
      expect(got.length).toBeGreaterThan(3);
      expect(got).toEqual(naiveRequestCandidates(src, false));
      expect(requestCandidates(src, true)).toEqual(naiveRequestCandidates(src, true));
    }
  });
});
