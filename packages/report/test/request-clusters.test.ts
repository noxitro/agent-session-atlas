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
function naiveRequestCandidates(sources: CandidateSource[]): Candidate[] {
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
      representative: rep.text,
      examples: c.members.filter((m) => m !== rep).slice(0, 3).map((m) => m.text),
      tools: null,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.count - a.count);
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
  it('索引で数えても、1 件ずつ全部のまとまりと比べたときと同じ候補になる', () => {
    for (const seed of [1, 42, 12345, 987654]) {
      const src = sources(300, seed);
      const got = requestCandidates(src);
      expect(got.length).toBeGreaterThan(3);
      expect(got).toEqual(naiveRequestCandidates(src));
    }
  });

  it('同じ依頼を何度も実行したとき(同じ文がまとまりの大半を占める)も、代表は全員を比べたときと同じ', () => {
    // 3 つの文を、ずらした順で何度も繰り返す(どれも同じ回数なら和が同じ人が出る)
    const reps = ['run the synthetic benchmark task alpha and report the totals', 'run the synthetic benchmark task alpha and report all totals', 'run the synthetic benchmark task alpha then report the totals'];
    for (const seed of [7, 2024, 99999]) {
      const src = sources(120, seed);
      src.forEach((x, i) => {
        x.analysis.requests.push(reps[(i + seed) % reps.length]!);
        x.analysis.turnActiveMs!.push(i * 1000);
      });
      const got = requestCandidates(src);
      expect(got.some((c) => c.count >= 100)).toBe(true);
      expect(got).toEqual(naiveRequestCandidates(src));
    }
  });

  it('接頭辞で絞っても、類似度がしきい値の前後になる組み合わせが多いとき(短い文・少ない文字の種類・長さのばらつき)に全員を比べたときと同じ', () => {
    for (const seed of [3, 77, 4242, 31337, 600613]) {
      let x = seed >>> 0;
      const rnd = (n: number): number => {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x % n;
      };
      const alphabet = [...'abcdefg'];
      const bases = Array.from({ length: 6 }, () => Array.from({ length: 20 + rnd(40) }, () => alphabet[rnd(alphabet.length)]!).join(''));
      const src: CandidateSource[] = Array.from({ length: 200 }, (_, i) => ({
        id: `s${i % 40}`,
        project: 'p',
        analysis: {
          requests: Array.from({ length: 2 }, () => {
            const c = [...bases[rnd(bases.length)]!];
            // 数文字を置き換え・足し・削り、類似度をしきい値の前後に散らす
            for (let k = rnd(8); k > 0; k--) {
              const op = rnd(3);
              if (op === 0) c[rnd(c.length)] = alphabet[rnd(alphabet.length)]!;
              else if (op === 1) c.push(alphabet[rnd(alphabet.length)]!);
              else if (c.length > 21) c.pop();
            }
            return c.join('');
          }),
          turnTools: [],
          turnActiveMs: [i, null],
        },
      }));
      const got = requestCandidates(src);
      expect(got.length).toBeGreaterThan(0);
      expect(got).toEqual(naiveRequestCandidates(src));
    }
  });

  it('類似度がちょうどしきい値(組の数の比も 0.6)の依頼は、同じまとまりに入る(絞り込みで落とさない)', () => {
    // 違う字だけを並べた n 字の文は、3 文字の組が n - 2 個。先頭 32 字は組 30 個で、52 字の組 50 個に含まれる → 30 / 50 = 0.6
    const long = Array.from({ length: 52 }, (_, i) => String.fromCodePoint(0x4e00 + i * 7)).join('');
    const short = [...long].slice(0, 32).join('');
    expect(jaccard(trigrams(normalizeRequest(long)), trigrams(normalizeRequest(short)))).toBe(0.6);
    for (const [first, second] of [
      [long, short],
      [short, long],
    ] as const) {
      const src: CandidateSource[] = [first, second, second].map((r, i) => ({ id: `s${i}`, project: 'p', analysis: { requests: [r], turnTools: [], turnActiveMs: [1000] } }));
      const got = requestCandidates(src);
      expect(got.map((c) => c.count)).toEqual([3]);
      expect(got).toEqual(naiveRequestCandidates(src));
    }
  });
});
