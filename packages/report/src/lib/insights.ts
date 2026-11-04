// Phase 12: 改善点の分析(LLM を呼ばない規則の集計)。
// - 指示文の版・skill・時間の使われ方は SessionSummary から求め、ブラウザで絞り込みに従って再計算する
// - スキル化の候補は依頼文とターンごとのツールの列(sessions.json の analysis)から build 時に求め、結果だけ埋め込む
// - 分かるのは相関まで。閾値は定数にして docs/PLAN.md に根拠を書く。閾値未満は件数を添えて「傾向」には出さない
import type { SessionAnalysis } from '../../../core/src/types.ts';
import type { SessionSummary } from './types.ts';

export const THRESHOLDS = {
  /** 率を出す最小のセッション数(5 件未満の率は 1 件で 20 ポイント動く) */
  MIN_SESSIONS: 5,
  /** 候補の最小の繰り返し(2 回は偶然でも起きる) */
  MIN_REPEAT: 3,
  /** 依頼文の 3-gram の Jaccard 類似度(言い回しの違いを許しつつ別の依頼を混ぜない) */
  SIMILARITY: 0.6,
  /** 版の前後で「悪化」とみなす差(ポイント。MIN_SESSIONS=5 での 1 件分 20 ポイントの半分) */
  WORSE_POINTS: 10,
  /** 「長いのに注入が少ない」: 文字数が全版の上位 25% で、注入セッション数がこれ未満 */
  RARE_SESSIONS: 3,
  /** 止まっている箇所(実データの分布の上位 10% 付近) */
  STUCK: { ttftMs: 20_000, consecutiveFailures: 3, extraEdits: 3, permissions: 10, compactions: 3 },
  /** 依頼文の正規化後の最小の長さ(これ未満は定型の相づち等として候補にしない) */
  MIN_REQUEST_CHARS: 20,
  /** ツールの並びの長さ */
  SEQ_MIN: 3,
  SEQ_MAX: 6,
  /** 並びに含まれる閲覧以外のツールの種類の下限(view→apply_patch→view のような汎用の手順は実データで上位を占めたので除く) */
  SEQ_MIN_WORK: 2,
} as const;

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** セッションのツール失敗(失敗 + 拒否)と呼び出し数 */
export function failures(s: SessionSummary): { failed: number; calls: number } {
  let failed = 0;
  for (const v of Object.values(s.tools.issues)) failed += v[0] + v[1];
  return { failed, calls: s.tools.total };
}
/** 同じファイルを 2 回以上編集したセッションか */
export const hasRework = (s: SessionSummary): boolean => s.analysis.filesReedited > 0;

// ---------- 指示文の版 ----------

export interface VersionStat {
  hash: string;
  chars: number;
  sessions: number;
  /** 注入回数 / セッション */
  injectionsPerSession: number;
  /** ツールの失敗率(失敗 + 拒否 / 呼び出し)。呼び出しが無ければ null */
  failureRate: number | null;
  /** 手戻り(同じファイルの再編集)のあったセッションの割合 */
  reworkRate: number;
  compactionsPerSession: number;
  outputPerSession: number;
  /** MIN_SESSIONS 以上あり、率を結論に使ってよいか */
  enough: boolean;
}

export function instructionVersions(sessions: SessionSummary[]): VersionStat[] {
  const by = new Map<string, { chars: number; ids: Set<string>; injections: number; failed: number; calls: number; rework: number; compactions: number; output: number }>();
  for (const s of sessions) {
    const f = failures(s);
    for (const [hash, chars, injections] of s.instructionVersions) {
      let v = by.get(hash);
      if (!v) by.set(hash, (v = { chars, ids: new Set(), injections: 0, failed: 0, calls: 0, rework: 0, compactions: 0, output: 0 }));
      if (v.ids.has(s.id)) continue;
      v.ids.add(s.id);
      v.injections += injections;
      v.failed += f.failed;
      v.calls += f.calls;
      if (hasRework(s)) v.rework++;
      v.compactions += s.friction.compactions;
      v.output += s.tokens.output;
    }
  }
  return [...by.entries()]
    .map(([hash, v]) => {
      const n = v.ids.size;
      return {
        hash,
        chars: v.chars,
        sessions: n,
        injectionsPerSession: v.injections / n,
        failureRate: rate(v.failed, v.calls),
        reworkRate: v.rework / n,
        compactionsPerSession: v.compactions / n,
        outputPerSession: v.output / n,
        enough: n >= THRESHOLDS.MIN_SESSIONS,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || b.chars - a.chars);
}

/** 指示文の見出しの表示名: 先頭の # や HTML コメントの印を外し、Markdown のリンクは文言だけにし、長ければ省略記号を付ける */
export function cleanHeading(h: string, max = 60): string {
  const raw = h.replace(/^#+\s*/, '').replace(/^<!--\s*|\s*-->$/g, '').trim();
  // 見出しは記録の時点で 80 字に切られている(core の firstHeading)。切られたものには省略記号を付ける(既に付いていれば足さない)
  const cut = (h.trim().length >= 80 || raw.length >= 79) && !raw.endsWith('…');
  // [文言](URL) は文言だけ。80 字で切れて閉じていないリンク([文言](http…)も同じ
  const t = raw.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*$/, '$1') + (cut ? '…' : '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 版の系列(1 つの項目にまとめる指示文)の鍵。整えた見出しだけで決め、ファイルの種別や出所のパスは見ない
 * (同じ本文がパス付きとパス無しの両方で注入されるため)。指示文のページと改善点で同じ番号を振るよう、両方でこれを使う
 */
export function seriesKey(heading: string, file: string): string {
  return cleanHeading(heading, Infinity) || `(見出しなし: ${file})`;
}

export interface VersionMeta {
  heading: string;
  file: string;
  /** 系列の識別子(伏せ字版でも見出しを漏らさない不透明な値)。同じ系列の版どうしで前後を比べる */
  series: string;
  /** 同じ系列の中での順(初回の利用日の順)。指示文のページの「版 N」と同じ */
  order: number;
  firstAt: string | null;
  /** その版を読み込んだセッションのうち、最後に読み込んだ日時(セッションごとの初回の注入の最大)。系列の「今の版」を決める */
  lastAt?: string | null;
}

export interface InstructionFindings {
  /** 長いのに注入されたセッションが少ない版 */
  longRare: VersionStat[];
  /** 版を変えた前後で悪化(失敗率か手戻り率が WORSE_POINTS 以上上がった) */
  worsened: { heading: string; before: VersionStat; after: VersionStat; failureDelta: number | null; reworkDelta: number }[];
  /** 前後比較ができなかった組(どちらかが MIN_SESSIONS 未満)の数 */
  comparedInsufficient: number;
  /** 前後比較を判定できた組の数 */
  compared: number;
  /** 長いのに注入が少ないとみなした字数(全版の上位 25% の下限) */
  longChars: number;
}

/**
 * totalSessions は stats の集計元のセッション数。「注入が少ない」は十分な母集団に対する希少さなので、
 * MIN_SESSIONS 未満では longRare を出さない。
 */
export function instructionFindings(stats: VersionStat[], meta: Record<string, VersionMeta>, totalSessions: number): InstructionFindings {
  const chars = stats.map((v) => v.chars).sort((a, b) => a - b);
  const q75 = chars.length ? chars[Math.min(chars.length - 1, Math.floor(chars.length * 0.75))] : 0;
  // 同じ系列の版が並ぶと冗長なので、系列ごとに今の版だけ挙げる。今の版は最後に読み込まれた版(指示文のページの「最後に使われた版」と同じ)。
  // 番号(order)が最大の版とは限らない(別のリポジトリで並行して使われる)。lastAt が無い古いデータは order で決める
  const newer = (a: VersionMeta | undefined, b: VersionMeta | undefined): boolean => {
    const la = a?.lastAt ?? null;
    const lb = b?.lastAt ?? null;
    return la != null && lb != null && la !== lb ? la > lb : (a?.order ?? 0) > (b?.order ?? 0);
  };
  const latestOfHeading = new Map<string, VersionStat>();
  for (const v of stats) {
    const m = meta[v.hash];
    const k = m ? m.series : v.hash;
    const cur = latestOfHeading.get(k);
    if (!cur || newer(m, meta[cur.hash])) latestOfHeading.set(k, v);
  }
  const longRare = [...latestOfHeading.values()].filter((v) => totalSessions >= THRESHOLDS.MIN_SESSIONS && chars.length >= 4 && v.chars >= q75 && v.chars > 0 && v.sessions < THRESHOLDS.RARE_SESSIONS).sort((a, b) => b.chars - a.chars);
  const byHeading = new Map<string, VersionStat[]>();
  for (const v of stats) {
    const m = meta[v.hash];
    if (!m) continue;
    (byHeading.get(m.series) ?? byHeading.set(m.series, []).get(m.series)!).push(v);
  }
  const worsened: InstructionFindings['worsened'] = [];
  let comparedInsufficient = 0;
  let compared = 0;
  for (const vs of byHeading.values()) {
    if (vs.length < 2) continue;
    vs.sort((a, b) => meta[a.hash].order - meta[b.hash].order);
    for (let i = 1; i < vs.length; i++) {
      const before = vs[i - 1];
      const after = vs[i];
      if (!before.enough || !after.enough) {
        comparedInsufficient++;
        continue;
      }
      compared++;
      const failureDelta = before.failureRate != null && after.failureRate != null ? (after.failureRate - before.failureRate) * 100 : null;
      const reworkDelta = (after.reworkRate - before.reworkRate) * 100;
      if ((failureDelta != null && failureDelta >= THRESHOLDS.WORSE_POINTS) || reworkDelta >= THRESHOLDS.WORSE_POINTS) worsened.push({ heading: meta[after.hash].heading, before, after, failureDelta, reworkDelta });
    }
  }
  return { longRare, worsened, comparedInsufficient, compared, longChars: q75 };
}

// ---------- skill ----------

export interface SkillStat {
  name: string;
  calls: number;
  byUser: number;
  byAgent: number;
  chars: number | null;
  sessions: number;
  /** 呼んだセッションの失敗率 / 呼ばなかったセッションの失敗率(どちらも MIN_SESSIONS 未満なら null) */
  failureWith: number | null;
  failureWithout: number | null;
  outputPerSession: number;
  enough: boolean;
}

export function skillStats(sessions: SessionSummary[], installed: string[] | null): { stats: SkillStat[]; unused: string[] } {
  const names = new Set<string>();
  for (const s of sessions) for (const n of Object.keys(s.skills)) names.add(n);
  const stats: SkillStat[] = [];
  for (const name of names) {
    const withS = sessions.filter((s) => name in s.skills);
    const without = sessions.filter((s) => !(name in s.skills));
    const f = (xs: SessionSummary[]): number | null => {
      if (xs.length < THRESHOLDS.MIN_SESSIONS) return null;
      const t = xs.reduce((a, s) => {
        const x = failures(s);
        return { failed: a.failed + x.failed, calls: a.calls + x.calls };
      }, { failed: 0, calls: 0 });
      return rate(t.failed, t.calls);
    };
    let calls = 0;
    let byUser = 0;
    let byAgent = 0;
    let chars: number | null = null;
    for (const s of withS) {
      const t = s.skills[name];
      calls += t[0] + t[1] + t[2];
      byUser += t[0];
      byAgent += t[1];
      const c = s.skillChars[name];
      if (c != null) chars = Math.max(chars ?? 0, c);
    }
    stats.push({
      name,
      calls,
      byUser,
      byAgent,
      chars,
      sessions: withS.length,
      failureWith: f(withS),
      failureWithout: f(without),
      outputPerSession: withS.length ? sum(withS.map((s) => s.tokens.output)) / withS.length : 0,
      enough: withS.length >= THRESHOLDS.MIN_SESSIONS,
    });
  }
  stats.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const unused = installed ? installed.filter((n) => !names.has(n)).sort() : [];
  return { stats, unused };
}

// ---------- 時間の使われ方 ----------

export interface StuckSession {
  id: string;
  href: string;
  project: string;
  projectLabel: string;
  ttftMedian: number | null;
  durationMedian: number | null;
  consecutiveFailures: number;
  extraEdits: number;
  permissions: number;
  compactions: number;
  /** 閾値を超えた理由(無ければ止まっていない) */
  reasons: string[];
}

export function latencyMedians(s: SessionSummary): { ttft: number | null; duration: number | null } {
  const ttft: number[] = [];
  const dur: number[] = [];
  for (const [t, d] of Object.values(s.exec.latency)) {
    ttft.push(...t);
    dur.push(...d);
  }
  return { ttft: median(ttft), duration: median(dur) };
}

export function stuckSessions(sessions: SessionSummary[]): StuckSession[] {
  const T = THRESHOLDS.STUCK;
  const out: StuckSession[] = [];
  for (const s of sessions) {
    const l = latencyMedians(s);
    const reasons: string[] = [];
    if (l.ttft != null && l.ttft >= T.ttftMs) reasons.push('待ち時間');
    if (s.analysis.maxConsecutiveFailures >= T.consecutiveFailures) reasons.push('失敗の連続');
    // extraEdits は全ファイルの「同じファイルの 2 回目以降の編集」の合計(1 つのファイルを 3 回直したという意味ではない)
    if (s.analysis.extraEdits >= T.extraEdits) reasons.push('余分な編集の多さ');
    if (s.friction.permissionRequests >= T.permissions) reasons.push('権限確認の多さ');
    if (s.friction.compactions >= T.compactions) reasons.push('compaction');
    out.push({
      id: s.id,
      href: s.href,
      project: s.project,
      projectLabel: s.projectLabel,
      ttftMedian: l.ttft,
      durationMedian: l.duration,
      consecutiveFailures: s.analysis.maxConsecutiveFailures,
      extraEdits: s.analysis.extraEdits,
      permissions: s.friction.permissionRequests,
      compactions: s.friction.compactions,
      reasons,
    });
  }
  // 理由の数の多い順。同数なら閾値に効いた量の大きい順(待ち時間の記録は新しいログにしか無いので、それで並べると記録の有無で順位が決まる)
  return out.filter((x) => x.reasons.length).sort((a, b) => b.reasons.length - a.reasons.length || b.extraEdits - a.extraEdits || b.consecutiveFailures - a.consecutiveFailures || (b.ttftMedian ?? 0) - (a.ttftMedian ?? 0));
}

export function stuckByProject(stuck: StuckSession[], sessions: SessionSummary[]): { project: string; projectLabel: string; stuck: number; total: number; reasons: Record<string, number> }[] {
  const total = new Map<string, { label: string; n: number }>();
  for (const s of sessions) {
    const t = total.get(s.project) ?? { label: s.projectLabel, n: 0 };
    t.n++;
    total.set(s.project, t);
  }
  const by = new Map<string, { stuck: number; reasons: Record<string, number> }>();
  for (const x of stuck) {
    const b = by.get(x.project) ?? { stuck: 0, reasons: {} };
    b.stuck++;
    for (const r of x.reasons) b.reasons[r] = (b.reasons[r] ?? 0) + 1;
    by.set(x.project, b);
  }
  // 総数が MIN_SESSIONS 未満のプロジェクトは 1 / 1 のような率が結論に見えるので出さない
  return [...by.entries()]
    .map(([project, b]) => ({ project, projectLabel: total.get(project)?.label ?? project, stuck: b.stuck, total: total.get(project)?.n ?? 0, reasons: b.reasons }))
    .filter((p) => p.total >= THRESHOLDS.MIN_SESSIONS)
    .sort((a, b) => b.stuck - a.stuck || b.stuck / Math.max(1, b.total) - a.stuck / Math.max(1, a.total));
}

// ---------- スキル化の候補(build 時) ----------

/** 依頼文の正規化: 小文字、URL・パス・数字・16 進 id を印に、記号を落とし、空白を詰める */
export function normalizeRequest(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' <url> ')
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\s"'<>|]*|(?:^|[\s(])(?:\/[\w.-]+){2,}/g, ' <path> ')
    .replace(/\b[0-9a-f]{8,}\b/g, ' <id> ')
    .replace(/\d+/g, ' <n> ')
    .replace(/[^\p{L}\p{N}<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.replace(/\s+/g, ' ');
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 定型の相づち・コマンドなど、スキル化の対象にしない依頼文 */
export const TRIVIAL_REQUEST = /^(?:ok|okay|yes|no|y|n|reply ok|続けて|続行|はい|いいえ|次へ|go on|continue|done|thanks|ありがとう|了解|承知|\/\w+)\s*$/i;
/** 動作確認の定型文(「Reply with exactly: OK」など)。実データで上位に来たので除く */
export const PROBE_REQUEST = /^(?:reply with|respond with|say (?:ok|hello)|answer with)(?:\s|$)/i;

export interface Candidate {
  kind: 'request' | 'tools';
  /** 並びの場合はツール名を → で繋いだもの。依頼文の場合は代表文の正規化形 */
  key: string;
  count: number;
  sessions: string[];
  /** 1 回あたりの実働の中央値(ms。ターンの中の 5 分を超える空白を除く)。分からなければ null */
  medianMs: number | null;
  /** 回数 × 実働の中央値(分)。実働が無ければ回数 × 1 */
  score: number;
  /** 代表の依頼文(原文の先頭 300 字)。伏せ字版では null */
  representative: string | null;
  /** 代表以外の例(最大 3)。伏せ字版では空 */
  examples: string[];
  /** 並びの場合のツール名 */
  tools: string[] | null;
}

export interface CandidateSource {
  id: string;
  project: string;
  analysis: Pick<SessionAnalysis, 'requests' | 'turnTools' | 'turnActiveMs'>;
}

/** スコアに使う実働の上限(2 時間。autopilot で何時間も続いた 1 回で順位が決まらないように) */
export const SCORE_MS_CAP = 2 * 3_600_000;
const scoreOf = (count: number, medianMs: number | null): number => count * (medianMs != null ? Math.max(1, Math.min(medianMs, SCORE_MS_CAP) / 60_000) : 1);

/** 閲覧だけのツール(これだけの並びは探索であって、skill 化の対象にしない) */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set(['view', 'rg', 'grep', 'glob', 'ls', 'read', 'read_file', 'list_dir', 'find']);
/** 周期 1〜2 の繰り返し(a → b → a → b)は往復の探索なので並びとして数えない */
export function isPeriodic(seq: string[], maxPeriod = 3): boolean {
  for (let p = 1; p <= maxPeriod; p++) {
    // 周期 p の繰り返しの途中で切れたもの(a b c a b)も周期的とみなす
    if (seq.length <= p) continue;
    let ok = true;
    for (let i = p; i < seq.length; i++) if (seq[i] !== seq[i - p]) ok = false;
    if (ok) return true;
  }
  return false;
}

/** 連続する同じツールを 1 つに潰す(view → view → view は「view を続けた」だけで、並びとしては 1 歩) */
export function collapseRuns(tools: string[]): string[] {
  const out: string[] = [];
  for (const t of tools) if (out[out.length - 1] !== t) out.push(t);
  return out;
}

export function requestCandidates(sources: CandidateSource[], anonymized: boolean): Candidate[] {
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
    // 代表は他の全員との類似度の和が最大のもの
    const rep = c.members.map((m) => ({ m, s: sum(c.members.map((o) => jaccard(m.grams, o.grams))) })).sort((a, b) => b.s - a.s)[0].m;
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
  // 伏せ字版では key(正規化した依頼文)も出さない(埋め込みデータと insights.json に残るため)
  return anonymized ? out.map((c, i) => ({ ...c, key: `request-${i + 1}` })) : out;
}

export function toolSequenceCandidates(sources: CandidateSource[], anonymized: boolean): Candidate[] {
  type Occ = { id: string; turn: number; start: number; ms: number | null; request: string };
  const turns: { id: string; tools: string[]; ms: number | null; request: string }[] = [];
  for (const s of sources) s.analysis.turnTools.forEach((tools, i) => turns.push({ id: s.id, tools: collapseRuns(tools), ms: s.analysis.turnActiveMs?.[i] ?? null, request: s.analysis.requests[i] ?? '' }));
  const covered = new Set<string>(); // `${turnIndex}:${pos}`
  const out: Candidate[] = [];
  for (let L = THRESHOLDS.SEQ_MAX; L >= THRESHOLDS.SEQ_MIN; L--) {
    const occ = new Map<string, Occ[]>();
    turns.forEach((t, ti) => {
      for (let i = 0; i + L <= t.tools.length; i++) {
        let free = true;
        for (let k = 0; k < L; k++) if (covered.has(`${ti}:${i + k}`)) free = false;
        if (!free) continue;
        const seq = t.tools.slice(i, i + L);
        // 2 種類以上のツールを含むものだけ(view と rg の往復のような閲覧だけの並びも 2 種類だが、skill 化の対象になりうるので残す)
        if (new Set(seq).size < 2) continue;
        if (new Set(seq.filter((x) => !EXPLORE_TOOLS.has(x))).size < THRESHOLDS.SEQ_MIN_WORK || isPeriodic(seq)) continue;
        const key = seq.join(' → ');
        (occ.get(key) ?? occ.set(key, []).get(key)!).push({ id: t.id, turn: ti, start: i, ms: t.ms, request: t.request });
      }
    });
    const accepted = [...occ.entries()].filter(([, xs]) => xs.length >= THRESHOLDS.MIN_REPEAT && new Set(xs.map((x) => x.id)).size >= 2).sort((a, b) => b[1].length - a[1].length);
    for (const [key, xs] of accepted) {
      // 既に受け入れた並びと重なる出現は数えない(同じターンの同じ位置)
      const fresh = xs.filter((x) => {
        for (let k = 0; k < L; k++) if (covered.has(`${x.turn}:${x.start + k}`)) return false;
        return true;
      });
      const sessions = [...new Set(fresh.map((x) => x.id))];
      if (fresh.length < THRESHOLDS.MIN_REPEAT || sessions.length < 2) continue;
      for (const x of fresh) for (let k = 0; k < L; k++) covered.add(`${x.turn}:${x.start + k}`);
      const medianMs = median(fresh.map((x) => x.ms).filter((x): x is number => x != null));
      const reqs = [...new Set(fresh.map((x) => x.request).filter((r) => r && !TRIVIAL_REQUEST.test(r.trim()) && !PROBE_REQUEST.test(r.trim())))];
      out.push({
        kind: 'tools',
        key,
        count: fresh.length,
        sessions,
        medianMs,
        score: scoreOf(fresh.length, medianMs),
        representative: anonymized ? null : (reqs[0] ?? null),
        examples: anonymized ? [] : reqs.slice(1, 4),
        tools: key.split(' → '),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.count - a.count);
}

export function skillCandidates(sources: CandidateSource[], anonymized: boolean): Candidate[] {
  // atlas 自身の判定セッションは定型の繰り返しなので除く
  const src = sources.filter((s) => s.project !== '(atlas の判定)');
  return [...requestCandidates(src, anonymized), ...toolSequenceCandidates(src, anonymized)].sort((a, b) => b.score - a.score || b.count - a.count);
}
