// atlas 自身の版の形と集計。アップロードしたフォルダに添え(atlas-index.json・atlas-session.json の atlas)、送り先から集計するときに、
// 古い版で送ったものが混ざっていないかを数える。
// 版の新旧は git のコミットの日時で決める(package.json の version は上げていないので使えない)。
// git で取得していないフォルダでも、コードの目印(code-stamp.ts)で「同じコードか」は分かる。
// 画面(ブラウザ)からも読むので node: に依存しない。git から読むのは atlas-build.ts
export interface AtlasBuild {
  /** git のコミット(全桁)。git で取得したフォルダでない・git を使えないときは null */
  commit: string | null;
  /** そのコミットの日時(ISO、UTC)。版の新旧はこれで決める。commit が null なら null */
  committedAt: string | null;
  /** git が管理しているファイルを手で変えていた(package-lock.json だけの変更は数えない。npm が書き換えるため)。分からなければ null */
  dirty: boolean | null;
  /** コードの目印(code-stamp.ts。同じなら同じコード) */
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

/** 最後に送ったときの版が、いちばん新しい版でないフォルダ */
export interface StaleFolder {
  /** 送り先からの相対パス(/ 区切り。直下にセッションが並ぶ形は '.') */
  folder: string;
  uploadedAt: string | null;
  /** older: いちばん新しい版より古い版 / unknown: 版の記録なし / undated: 新旧を決められない版 / unreadable: 索引を読めなかった */
  reason: 'older' | 'unknown' | 'undated' | 'unreadable';
  /** 送った版の短い名前(記録が無ければ null) */
  label: string | null;
}

/** 版ごとのまとまり(同じコミット、git が無ければ同じ目印) */
export interface AtlasBuildGroup {
  commit: string | null;
  committedAt: string | null;
  /** そのまとまりのコードの目印(手で変えた版は目印が分かれるので、最初に見たもの) */
  code: string;
  /** 手で変えた版で送ったセッションの数 */
  dirty: number;
  sessions: number;
  /** 送った人のフォルダの名前(送り先をまとめて集計したときだけ。名前の順) */
  persons: string[];
}

export interface AtlasBuildSummary {
  /** 送り先から集計したセッション */
  sessions: number;
  /** 版の記録が無いセッション(この記録を書く前の版で送ったもの) */
  unknown: number;
  unknownPersons: string[];
  /** 記録はあるが、git で取得していないなどで新旧を決められないセッション */
  undated: number;
  /** いちばん新しい版(送った側とこの PC のうち、コミットの日時で決める)。local = この PC の版。決められなければ null */
  latest: { commit: string; committedAt: string; local: boolean } | null;
  /** latest より古い版で送ったセッション */
  older: number;
  olderPersons: string[];
  /** 手で変えた版で送ったセッション */
  dirty: number;
  /** 版ごと(新しい順。日時の無いものは後ろ) */
  builds: AtlasBuildGroup[];
  /** 集計したこの PC の版 */
  local: AtlasBuild | null;
  /**
   * 最後に送ったときの版が、いちばん新しい版でないフォルダ(最後に送った日時の古い順)。フォルダごとの記録を渡したときだけある。
   * セッションの数だけでは、その人がいつ・どの版で最後に送ったかが分からないため(送り直しを頼む相手を決めるのに使う)
   */
  folders?: StaleFolder[];
}

const time = (at: string | null): number => (at ? Date.parse(at) : NaN);

/**
 * 送り先から集計したセッションの、送った atlas の版を数える。uploadAtlas が undefined のセッション(この PC の記録)は数えない。
 * 送り先から集計したセッションが 1 件も無ければ null
 */
export function summarizeAtlasBuilds(
  sessions: readonly { person?: string | null; uploadAtlas?: AtlasBuild | null }[],
  local: AtlasBuild | null,
  folders?: Readonly<Record<string, FolderUpload>>,
): AtlasBuildSummary | null {
  const sent = sessions.filter((s) => s.uploadAtlas !== undefined);
  if (!sent.length) return null;
  const groups = new Map<string, AtlasBuildGroup & { people: Set<string> }>();
  const unknownPeople = new Set<string>();
  let unknown = 0;
  let dirty = 0;
  for (const s of sent) {
    const b = s.uploadAtlas;
    if (!b) {
      unknown++;
      if (s.person) unknownPeople.add(s.person);
      continue;
    }
    const key = b.commit ?? `code:${b.code}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { commit: b.commit, committedAt: b.committedAt, code: b.code, dirty: 0, sessions: 0, persons: [], people: new Set() }));
    g.sessions++;
    if (b.dirty) {
      g.dirty++;
      dirty++;
    }
    if (s.person) g.people.add(s.person);
  }
  const order = (x: number): number => (Number.isFinite(x) ? x : -Infinity);
  const builds = [...groups.values()]
    .map(({ people, ...g }) => ({ ...g, persons: [...people].sort() }))
    .sort((a, b) => order(time(b.committedAt)) - order(time(a.committedAt)) || (a.commit ?? a.code).localeCompare(b.commit ?? b.code));
  // いちばん新しい版は、送った側の版(セッションとフォルダの記録)とこの PC の版のうち、コミットの日時がいちばん後のもの(同じ日時なら送った側を先に見る)
  let latest: AtlasBuildSummary['latest'] = null;
  const folderBuilds = Object.values(folders ?? {}).flatMap((f) => (f.atlas ? [{ commit: f.atlas.commit, committedAt: f.atlas.committedAt, local: false }] : []));
  for (const c of [...builds.map((g) => ({ commit: g.commit, committedAt: g.committedAt, local: false })), ...folderBuilds, ...(local ? [{ commit: local.commit, committedAt: local.committedAt, local: true }] : [])]) {
    if (!c.commit || !c.committedAt || !Number.isFinite(time(c.committedAt))) continue;
    if (!latest || time(c.committedAt) > time(latest.committedAt)) latest = { commit: c.commit, committedAt: c.committedAt, local: c.local };
  }
  let older = 0;
  let undated = 0;
  const olderPeople = new Set<string>();
  for (const g of builds) {
    if (!g.commit || !Number.isFinite(time(g.committedAt))) {
      undated += g.sessions;
      continue;
    }
    if (latest && g.commit !== latest.commit && time(g.committedAt) < time(latest.committedAt)) {
      older += g.sessions;
      for (const p of g.persons) olderPeople.add(p);
    }
  }
  const summary: AtlasBuildSummary = { sessions: sent.length, unknown, unknownPersons: [...unknownPeople].sort(), undated, latest, older, olderPersons: [...olderPeople].sort(), dirty, builds, local };
  if (folders) summary.folders = staleFolders(folders, latest);
  return summary;
}

/** 最後に送ったときの版が、いちばん新しい版(latest)でないフォルダ。最後に送った日時の古い順(日時の分からないものは前) */
export function staleFolders(folders: Readonly<Record<string, FolderUpload>>, latest: AtlasBuildSummary['latest']): StaleFolder[] {
  const out: StaleFolder[] = [];
  for (const [folder, f] of Object.entries(folders)) {
    const b = f.atlas;
    if (f.unreadable) out.push({ folder, uploadedAt: null, reason: 'unreadable', label: null });
    else if (!b) out.push({ folder, uploadedAt: f.uploadedAt, reason: 'unknown', label: null });
    else if (!b.commit || !Number.isFinite(time(b.committedAt))) out.push({ folder, uploadedAt: f.uploadedAt, reason: 'undated', label: buildLabel(b) });
    else if (latest && b.commit !== latest.commit && time(b.committedAt) < time(latest.committedAt)) out.push({ folder, uploadedAt: f.uploadedAt, reason: 'older', label: buildLabel(b) });
  }
  const at = (x: StaleFolder): number => (Number.isFinite(time(x.uploadedAt)) ? time(x.uploadedAt) : -Infinity);
  return out.sort((a, b) => at(a) - at(b) || a.folder.localeCompare(b.folder));
}

/** 版の短い名前(コミットの先頭 7 桁、git が無ければ目印) */
export const buildLabel = (b: { commit: string | null; code: string }): string => (b.commit ? b.commit.slice(0, 7) : `目印 ${b.code.slice(0, 8)}`);

const day = (at: string | null): string => (at ? at.slice(0, 10) : '日時不明');
const whose = (persons: readonly string[]): string => (persons.length ? `(${persons.slice(0, 5).join('、')}${persons.length > 5 ? ` ほか ${persons.length - 5} 人` : ''})` : '');

/** 最新でないフォルダの理由ごとの、見出しのタグの言葉 */
const STALE_SHORT: Record<StaleFolder['reason'], string> = {
  older: '古い版で最後に送ったフォルダ',
  unknown: '版の記録が無いフォルダ',
  undated: '新旧を決められない版で最後に送ったフォルダ',
  unreadable: '索引を読めないフォルダ',
};
const STALE_WHY: Record<StaleFolder['reason'], string> = { older: '古い版', unknown: '版の記録なし', undated: '新旧を決められない版', unreadable: '索引を読めない' };
/** 人ごとのまとめに出す人数の上限(それより多ければ「ほか N 人」。フォルダごとの全部は sessions.json の source.uploads にある) */
const STALE_PEOPLE_MAX = 20;

/**
 * フォルダの持ち主(送り先をまとめて集計したときの、人のフォルダの名前)。<人>/<プロジェクト> なら <人>、
 * 人のフォルダの下に無いもの(プロジェクトのフォルダ 1 つ、'.')はフォルダの名前そのもの
 */
export const folderOwner = (folder: string): string => (folder === '.' ? '(このフォルダ)' : folder.includes('/') ? folder.slice(0, folder.indexOf('/')) : folder);

/**
 * 最新でないフォルダを、人(フォルダの持ち主)ごとにまとめた行にする。1 人が多くのフォルダを古い版で送っていても、
 * ほかの人が埋もれないように(目的は、送り直しを頼む相手を決めること)
 */
function staleByOwner(stale: readonly StaleFolder[]): string[] {
  const by = new Map<string, StaleFolder[]>();
  for (const f of stale) by.set(folderOwner(f.folder), [...(by.get(folderOwner(f.folder)) ?? []), f]);
  const order = (xs: StaleFolder[]): number => Math.min(...xs.map((f) => (Number.isFinite(time(f.uploadedAt)) ? time(f.uploadedAt) : -Infinity)));
  const people = [...by].sort((a, b) => order(a[1]) - order(b[1]) || a[0].localeCompare(b[0]));
  const lines = people.slice(0, STALE_PEOPLE_MAX).map(([owner, xs]) => {
    const counts = (['older', 'unknown', 'undated', 'unreadable'] as const).map((r) => [r, xs.filter((f) => f.reason === r).length] as const).filter(([, n]) => n > 0);
    const dates = xs.map((f) => f.uploadedAt).filter((x): x is string => x != null).sort();
    const labels = [...new Set(xs.map((f) => f.label).filter((x): x is string => x != null))];
    return `  ${owner}: ${xs.length} フォルダ(${counts.map(([r, n]) => `${STALE_WHY[r]} ${n}`).join('・')}${labels.length ? `。版 ${labels.slice(0, 3).join('、')}${labels.length > 3 ? ' ほか' : ''}` : ''}${dates.length ? `。いちばん前に送ったのは ${day(dates[0]!)}` : ''})`;
  });
  if (people.length > STALE_PEOPLE_MAX) lines.push(`  ほか ${people.length - STALE_PEOPLE_MAX} 人`);
  return lines;
}

/**
 * 伏せ字版に出すために、人の名前とフォルダの名前(人とプロジェクトの名前を含む)を消す。フォルダは「フォルダ 1」のように番号にする
 * (どれだけのフォルダが最新でないかは残す)
 */
export function anonymizeAtlasBuilds(s: AtlasBuildSummary): AtlasBuildSummary {
  return {
    ...s,
    unknownPersons: [],
    olderPersons: [],
    builds: s.builds.map((g) => ({ ...g, persons: [] })),
    ...(s.folders ? { folders: s.folders.map((f, i) => ({ ...f, folder: `フォルダ ${i + 1}` })) } : {}),
  };
}

/**
 * 集計した版を、CLI のログと画面の見出しに出す言葉にする。
 * ok = すべていちばん新しい版で、手で変えた版も記録の無いものも無い。short は画面の見出しのタグ、headline は 1 行、lines は版ごとの内訳
 */
export function describeAtlasBuilds(s: AtlasBuildSummary): { ok: boolean; short: string; headline: string; lines: string[] } {
  const stale = s.folders ?? [];
  const ok = s.older === 0 && s.unknown === 0 && s.undated === 0 && s.dirty === 0 && stale.length === 0;
  const parts = [
    s.older ? `古い版 ${s.older} 件` : '',
    s.unknown ? `版の記録なし ${s.unknown} 件` : '',
    s.undated ? `新旧を決められない版 ${s.undated} 件` : '',
    s.dirty ? `手で変えた版 ${s.dirty} 件` : '',
    // フォルダは理由ごとに分ける(新旧を決められないだけのものを「古い」と数えないように)
    ...(['older', 'unknown', 'undated', 'unreadable'] as const).map((r) => {
      const n = stale.filter((f) => f.reason === r).length;
      return n ? `${STALE_SHORT[r]} ${n} 件` : '';
    }),
  ].filter(Boolean);
  const short = ok ? 'すべて最新' : parts.join('・');
  const headline = ok ? `送った atlas の版: すべて最新${s.latest ? `(${s.latest.commit.slice(0, 7)})` : ''}` : `送った atlas の版: ${s.sessions} 件のうち ${short}`;
  const lines: string[] = [];
  if (s.latest) lines.push(`いちばん新しい版: ${s.latest.commit.slice(0, 7)}(${day(s.latest.committedAt)} のコミット${s.latest.local ? '。この PC の版' : ''})`);
  for (const g of s.builds) {
    const old = s.latest && g.commit && g.commit !== s.latest.commit && time(g.committedAt) < time(s.latest.committedAt);
    lines.push(`${buildLabel(g)}(${day(g.committedAt)})${old ? ' 古い版' : ''}: ${g.sessions} 件${g.dirty ? `(うち手で変えた版 ${g.dirty} 件)` : ''}${whose(g.persons)}`);
  }
  if (s.unknown) lines.push(`版の記録なし(この記録を書く前の版で送ったもの): ${s.unknown} 件${whose(s.unknownPersons)}`);
  if (stale.length) {
    lines.push(`最後に送ったときの版が最新でないフォルダ ${stale.length} 件(人ごと。フォルダごとの全部は sessions.json の source.uploads):`);
    lines.push(...staleByOwner(stale));
    if (stale.some((f) => f.reason === 'unreadable')) lines.push('索引を読めなかったフォルダは、送っている最中だったのかもしれません。集計し直すと読めることがあります');
  }
  if (s.local && !(s.latest?.local && s.latest.commit === s.local.commit)) lines.push(`この PC の版: ${buildLabel(s.local)}(${day(s.local.committedAt)})${s.local.dirty ? '。手で変えた版' : ''}`);
  return { ok, short, headline, lines };
}
