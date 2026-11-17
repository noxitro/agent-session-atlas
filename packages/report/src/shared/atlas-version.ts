// atlas 自身の版の形と集計。アップロードしたフォルダに添え(atlas-index.json・atlas-session.json の atlas)、送り先から集計するときに、
// 古い版で送ったものが混ざっていないかを、送った人ごとに数える。
// 版の新旧は git のコミットの日時で決める(package.json の version は上げていないので使えない)。
// git で取得していないフォルダでも、コードの目印(実行ファイルを作ったときに決まる。crates/atlas-report/build.rs)で「同じコードか」は分かる。
// 画面(ブラウザ)からも読むので node: に依存しない。git から読むのは crates/atlas-core/src/atlas_build.rs
export interface AtlasBuild {
  /** git のコミット(全桁)。git で取得したフォルダでない・git を使えないときは null */
  commit: string | null;
  /** そのコミットの日時(ISO、UTC)。版の新旧はこれで決める。commit が null なら null */
  committedAt: string | null;
  /** git が管理しているファイルを手で変えていた(package-lock.json だけの変更は数えない。npm が書き換えるため)。分からなければ null */
  dirty: boolean | null;
  /** コードの目印(同じなら同じ実行ファイルのコード) */
  code: string;
}

/** git のコミット(SHA-1 か SHA-256 の全桁) */
export const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * 添えた記録の atlas を読む。共有フォルダに置かれたファイルなので、形が合うものだけを使い、合わなければ null。
 * コミットは 16 進の全桁、日時は読める日時の形、目印は 16 進だけを受け付ける
 */
export function parseAtlasBuild(v: unknown): AtlasBuild | null {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.code !== 'string' || !/^[0-9a-f]{8,64}$/.test(o.code)) return null;
  const commit = typeof o.commit === 'string' && COMMIT_RE.test(o.commit) ? o.commit : null;
  const t = commit && typeof o.committedAt === 'string' && o.committedAt.length <= 40 ? Date.parse(o.committedAt) : NaN;
  return { commit, committedAt: Number.isFinite(t) ? new Date(t).toISOString() : null, dirty: typeof o.dirty === 'boolean' ? o.dirty : null, code: o.code };
}

/** フォルダごとの、最後に送ったときの記録(送り先の atlas-index.json の uploadedAt と atlas。snapshot が manifest の uploads に入れる) */
export interface FolderUpload {
  uploadedAt: string | null;
  /** 版の記録が無い(この記録を書く前の版で送った)なら null */
  atlas: AtlasBuild | null;
  /**
   * 索引はあるが読めなかった(書きかけ・壊れている・形が違う)。送っている最中に集計すると、書きかけを読むことがある。
   * 読めなかったフォルダは黙って外さず、知らせる(外すと、ほかが最新なら「すべて最新」と出てしまう)
   */
  unreadable?: boolean;
}

/**
 * 送った人に対応を頼む理由。older: いちばん新しい版より古い版で送った / dirty: 手で変えた版で送った / unknown: 版の記録が無い /
 * undated: git で取得していないなどで新旧を決められない版で送った / unreadable: フォルダの索引を読めなかった
 */
export type SenderReason = 'older' | 'dirty' | 'unknown' | 'undated' | 'unreadable';

/** 理由を出す順 */
const REASONS: readonly SenderReason[] = ['older', 'dirty', 'unknown', 'undated', 'unreadable'];

/** 送った人に対応を頼む理由 1 つと、その数 */
export interface SenderProblem {
  reason: SenderReason;
  /** 当てはまるセッション */
  sessions: number;
  /** 最後に送ったときの版が当てはまるフォルダ */
  folders: number;
}

/** 送った人ごとのまとめ。人のフォルダの下に無いもの(プロジェクトのフォルダ 1 つなど)は、フォルダごと */
export interface SenderBuilds {
  /** 送った人のフォルダの名前(人のフォルダの下に無いものは、フォルダの名前) */
  name: string;
  /** 送り先から集計したセッション */
  sessions: number;
  /** 対応を頼む理由(REASONS の順)。空なら、いちばん新しい版で送っている */
  problems: SenderProblem[];
  /** 理由に当てはまる版の短い名前 */
  labels: string[];
  /** 理由に当てはまるフォルダ(送り先からの相対パス)。送り直してもらうのはこのフォルダ */
  folders: string[];
  /** それらのフォルダを最後に送った日時(古い順。分からないものは入らない) */
  uploadedAt: string[];
}

export interface AtlasBuildSummary {
  /** 送り先から集計したセッション */
  sessions: number;
  /** いちばん新しい版(送った側とこの PC のうち、コミットの日時で決める)。local = この PC の版。決められなければ null */
  latest: { commit: string; committedAt: string; local: boolean } | null;
  /** 集計したこの PC の版 */
  local: AtlasBuild | null;
  /** 人ごとにまとめたか(送り先をまとめて集計したとき)。false ならフォルダごと */
  byPeople: boolean;
  /**
   * 送った人ごと。対応を頼む人が先(当てはまるフォルダを送った日時の古い順。日時の分からないものは前)、その後にいちばん新しい版で送った人(名前の順)。
   * 原則、人ごとに見る(目的は、送り直しを頼む相手を決めること)
   */
  senders: SenderBuilds[];
}

const time = (at: string | null): number => (at ? Date.parse(at) : NaN);

/** 送った版から決まる理由(いちばん新しい版で、手で変えてもいなければ空)。版の記録が無ければ unknown */
function reasonsOf(b: AtlasBuild | null, latest: AtlasBuildSummary['latest']): SenderReason[] {
  if (!b) return ['unknown'];
  const out: SenderReason[] = [];
  if (!b.commit || !Number.isFinite(time(b.committedAt))) out.push('undated');
  else if (latest && b.commit !== latest.commit && time(b.committedAt) < time(latest.committedAt)) out.push('older');
  if (b.dirty) out.push('dirty');
  return out;
}

/**
 * 送り先から集計したセッションの、送った atlas の版を、送った人ごとに数える。uploadAtlas が undefined のセッション(この PC の記録)は数えない。
 * folder は、そのセッションを数えたフォルダ(人の名前が無いときにまとめる名前と、送った日時を引くのに使う)。
 * 送り先から集計したセッションが 1 件も無ければ null
 */
export function summarizeAtlasBuilds(
  sessions: readonly { person?: string | null; folder?: string | null; uploadAtlas?: AtlasBuild | null }[],
  local: AtlasBuild | null,
  folders?: Readonly<Record<string, FolderUpload>>,
): AtlasBuildSummary | null {
  const sent = sessions.filter((s) => s.uploadAtlas !== undefined);
  if (!sent.length) return null;
  // 送った版(同じコミット、git が無ければ同じ目印をまとめる)。新しい順で、日時の無いものは後ろ
  const seen = new Map<string, AtlasBuild>();
  for (const s of sent) if (s.uploadAtlas && !seen.has(s.uploadAtlas.commit ?? `code:${s.uploadAtlas.code}`)) seen.set(s.uploadAtlas.commit ?? `code:${s.uploadAtlas.code}`, s.uploadAtlas);
  const order = (x: number): number => (Number.isFinite(x) ? x : -Infinity);
  const builds = [...seen.values()].sort((a, b) => order(time(b.committedAt)) - order(time(a.committedAt)) || (a.commit ?? a.code).localeCompare(b.commit ?? b.code));
  // いちばん新しい版は、送った側の版(セッションとフォルダの記録)とこの PC の版のうち、コミットの日時がいちばん後のもの(同じ日時なら送った側を先に見る)
  let latest: AtlasBuildSummary['latest'] = null;
  const folderBuilds = Object.values(folders ?? {}).flatMap((f) => (f.atlas ? [{ commit: f.atlas.commit, committedAt: f.atlas.committedAt, local: false }] : []));
  for (const c of [...builds.map((g) => ({ commit: g.commit, committedAt: g.committedAt, local: false })), ...folderBuilds, ...(local ? [{ commit: local.commit, committedAt: local.committedAt, local: true }] : [])]) {
    if (!c.commit || !c.committedAt || !Number.isFinite(time(c.committedAt))) continue;
    if (!latest || time(c.committedAt) > time(latest.committedAt)) latest = { commit: c.commit, committedAt: c.committedAt, local: c.local };
  }
  // 送った人ごと。人の名前が無いセッション(人のフォルダの下に無い)は、フォルダの名前でまとめる
  const byPeople = sent.some((s) => !!s.person) || Object.keys(folders ?? {}).some((k) => k.includes('/'));
  interface Acc {
    sessions: number;
    counts: Map<SenderReason, { sessions: number; folders: number }>;
    labels: Set<string>;
    folders: Set<string>;
  }
  const acc = new Map<string, Acc>();
  const of = (name: string): Acc => {
    let a = acc.get(name);
    if (!a) acc.set(name, (a = { sessions: 0, counts: new Map(), labels: new Set(), folders: new Set() }));
    return a;
  };
  /** 理由に当てはまったセッションかフォルダを 1 つ数える */
  const hit = (a: Acc, reasons: readonly SenderReason[], kind: 'sessions' | 'folders', build: AtlasBuild | null, folder: string | null): void => {
    for (const r of reasons) {
      let c = a.counts.get(r);
      if (!c) a.counts.set(r, (c = { sessions: 0, folders: 0 }));
      c[kind]++;
    }
    if (build) a.labels.add(buildLabel(build));
    if (folder != null) a.folders.add(folder);
  };
  for (const s of sent) {
    const a = of(s.person || (s.folder != null ? folderOwner(s.folder) : '(フォルダ不明)'));
    a.sessions++;
    const reasons = reasonsOf(s.uploadAtlas ?? null, latest);
    if (reasons.length) hit(a, reasons, 'sessions', s.uploadAtlas ?? null, s.folder ?? null);
  }
  // フォルダの記録(最後に送ったときの版)。セッションを数えなかったフォルダの人も、送った人に数える。
  // 索引を読めなかったフォルダは、黙って外さずに理由にする
  for (const [folder, u] of Object.entries(folders ?? {})) {
    const a = of(folderOwner(folder));
    const reasons: SenderReason[] = u.unreadable ? ['unreadable'] : reasonsOf(u.atlas, latest);
    if (reasons.length) hit(a, reasons, 'folders', u.unreadable ? null : u.atlas, folder);
  }
  // 対応を頼む人を先に(当てはまるフォルダを送った日時の古い順。日時の分からないフォルダがあれば前)。その後に、いちばん新しい版で送った人
  const keyed = [...acc].map(([name, a]) => {
    const at = [...a.folders].map((k) => {
      const u = folders?.[k];
      return u && !u.unreadable && u.uploadedAt != null && Number.isFinite(time(u.uploadedAt)) ? u.uploadedAt : null;
    });
    const first = !at.length || at.includes(null) ? -Infinity : Math.min(...at.map((x) => time(x)));
    const problems = REASONS.flatMap((reason) => {
      const c = a.counts.get(reason);
      return c ? [{ reason, ...c }] : [];
    });
    const sender: SenderBuilds = { name, sessions: a.sessions, problems, labels: [...a.labels], folders: [...a.folders], uploadedAt: at.filter((x) => x != null).sort() };
    return { first, sender };
  });
  keyed.sort((a, b) => Number(!a.sender.problems.length) - Number(!b.sender.problems.length) || (a.sender.problems.length && a.first !== b.first ? a.first - b.first : 0) || a.sender.name.localeCompare(b.sender.name));
  return { sessions: sent.length, latest, local, byPeople, senders: keyed.map((x) => x.sender) };
}

/** 版の短い名前(コミットの先頭 7 桁、git が無ければ目印) */
export const buildLabel = (b: { commit: string | null; code: string }): string => (b.commit ? b.commit.slice(0, 7) : `目印 ${b.code.slice(0, 8)}`);

const day = (at: string | null): string => (at ? at.slice(0, 10) : '日時不明');

/** 理由の言葉(「人」「フォルダ」「セッション」が続く形) */
const REASON_PHRASE: Record<SenderReason, string> = {
  older: '古い atlas で送った',
  dirty: '書き換えた atlas で送った',
  unknown: '版の記録が無い',
  undated: '版の新旧が分からない',
  unreadable: '送った記録を読めない',
};
/** 理由ごとの、頼むこと */
const REASON_ACTION: Record<SenderReason, string> = {
  older: 'atlas.bat を開いてもらう(開くと最新になります)。そのあと、そのフォルダを送り直してもらう',
  dirty: 'atlas のフォルダで書き換えたファイルを元に戻してもらう(書き換えたファイルは git status で分かります)。そのあと、atlas.bat を開いて、そのフォルダを送り直してもらう',
  unknown: '版を記録する前の古い atlas で送ったか、atlas を使わずに置いたものです。atlas.bat を開いて、そのフォルダを送り直してもらう',
  undated: 'git で取得していない atlas で送ったものです。git で取得した atlas から、そのフォルダを送り直してもらう',
  unreadable: '送っている最中だったのかもしれません。集計し直すと読めることがあります',
};
/** 対応を頼む人の内訳に出す人数の上限(それより多ければ「ほか N 人」。フォルダごとの全部は sessions.json の source.uploads にある) */
const SENDERS_MAX = 20;
/** いちばん新しい版で送った人の名前を出す数の上限 */
const OK_NAMES_MAX = 5;
/** 対応を頼む人の 1 行に出す、フォルダと版の数の上限 */
const LINE_ITEMS_MAX = 3;

/**
 * フォルダの持ち主(送り先をまとめて集計したときの、人のフォルダの名前)。<人>/<プロジェクト> なら <人>、
 * 人のフォルダの下に無いもの(プロジェクトのフォルダ 1 つ、'.')はフォルダの名前そのもの
 */
export const folderOwner = (folder: string): string => (folder === '.' ? '(このフォルダ)' : folder.includes('/') ? folder.slice(0, folder.indexOf('/')) : folder);

/** 上限までを「、」でつなぐ(超えた分は「 ほか」) */
const someOf = (xs: readonly string[]): string => `${xs.slice(0, LINE_ITEMS_MAX).join('、')}${xs.length > LINE_ITEMS_MAX ? ' ほか' : ''}`;

/** 対応を頼む人の 1 行(名前: 理由と数。当てはまるフォルダ。使った版。そのフォルダを送った日) */
function senderLine(x: SenderBuilds): string {
  const problems = x.problems.map((p) => `${REASON_PHRASE[p.reason]}(${p.sessions > 0 ? `${p.sessions} セッション` : `${p.folders} フォルダ`})`);
  // フォルダは、人のフォルダの下の名前で出す(名前と同じフォルダ・送り先そのものは、行の頭の名前で分かるので出さない)
  const names = x.folders.filter((f) => f !== '.' && f !== x.name).map((f) => (f.startsWith(`${x.name}/`) ? f.slice(x.name.length + 1) : f));
  const folders = names.length ? `。フォルダは ${someOf(names)}` : '';
  const labels = x.labels.length ? `。使った atlas は ${someOf(x.labels)}` : '';
  const [a, b] = [x.uploadedAt[0], x.uploadedAt[x.uploadedAt.length - 1]];
  const dates = a == null || b == null ? '' : day(a) !== day(b) ? `。送ったのは ${day(a)}〜${day(b)}` : `。送ったのは ${day(a)}`;
  return `  ${x.name}: ${problems.join('、')}${folders}${labels}${dates}`;
}

/**
 * 集計した版を、CLI のログと画面の見出しに出す言葉にする。送った人ごとに、対応が要るかと、頼むことを出す。
 * ok = 対応が要る人がいない。short は画面の見出しのタグ、headline は 1 行、lines は人ごとの内訳と頼むこと
 */
export function describeAtlasBuilds(s: AtlasBuildSummary): { ok: boolean; short: string; headline: string; lines: string[] } {
  // 数える単位(人ごとにまとめたときは人、そうでなければフォルダ)
  const unit = s.byPeople ? '人' : 'フォルダ';
  const count = (n: number): string => (s.byPeople ? `${n} 人` : `${n} 件`);
  const flagged = s.senders.filter((x) => x.problems.length);
  const fine = s.senders.filter((x) => !x.problems.length);
  const ok = !flagged.length;
  const reasons = REASONS.filter((r) => flagged.some((x) => x.problems.some((p) => p.reason === r)));
  // 理由ごとの数は、人ごとにまとめたときは人の数。そうでなければ送った人は 1 人なので、セッションの数と、セッションの無いフォルダの数
  const parts = reasons.map((r) => {
    const hit = flagged.flatMap((x) => x.problems.filter((p) => p.reason === r));
    if (s.byPeople) return `${REASON_PHRASE[r]}人 ${hit.length} 人`;
    const sessions = hit.reduce((n, p) => n + p.sessions, 0);
    const folders = hit.filter((p) => p.sessions === 0).reduce((n, p) => n + p.folders, 0);
    if (sessions > 0) return `${REASON_PHRASE[r]}セッション ${sessions} 件${folders > 0 ? `とフォルダ ${folders} 件` : ''}`;
    return `${REASON_PHRASE[r]}フォルダ ${folders} 件`;
  });
  // 画面のタグは、人ごとにまとめたときは対応が要る人の数だけ(理由ごとの内訳は見出しの 1 行に出す)
  const short = ok ? 'すべて最新' : s.byPeople ? `対応が要る人 ${flagged.length} 人` : parts.join('・');
  const headline = ok
    ? `送った atlas: すべて最新${s.latest ? `(${s.latest.commit.slice(0, 7)})` : ''}`
    : s.byPeople
      ? `送った atlas: ${s.senders.length} 人のうち ${short}(${parts.join('・')})`
      : `送った atlas: ${s.sessions} セッションのうち ${short}`;
  const lines: string[] = [];
  if (s.latest) lines.push(`最新の atlas: ${s.latest.commit.slice(0, 7)}(${day(s.latest.committedAt)} のコミット${s.latest.local ? '。この PC の atlas' : ''})`);
  if (!ok) {
    lines.push(`対応が要る${unit}(${count(flagged.length)}):`);
    lines.push(...flagged.slice(0, SENDERS_MAX).map(senderLine));
    if (flagged.length > SENDERS_MAX) lines.push(`  ほか ${count(flagged.length - SENDERS_MAX)}`);
    lines.push('頼むこと:');
    lines.push(...reasons.map((r) => `  ${REASON_PHRASE[r]} → ${REASON_ACTION[r]}`));
  }
  if (fine.length) lines.push(`最新の atlas で送った${unit}(${count(fine.length)}): ${fine.slice(0, OK_NAMES_MAX).map((x) => x.name).join('、')}${fine.length > OK_NAMES_MAX ? ` ほか ${count(fine.length - OK_NAMES_MAX)}` : ''}`);
  if (s.local && !(s.latest?.local && s.latest.commit === s.local.commit)) lines.push(`この PC の atlas: ${buildLabel(s.local)}(${day(s.local.committedAt)})${s.local.dirty ? '。ファイルを書き換えています' : ''}`);
  return { ok, short, headline, lines };
}
