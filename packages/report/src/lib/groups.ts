// 名前付きグループ(atlas-notes/groups.json)の形と読み取り(純関数)。
// ブラウザ側(絞り込み行の「グループ」)と Node 側(CLI の --group / atlas group)の両方から使うので、DOM や node: に依存しない。
// 壊れていてもエラーにせず、読めた分だけ返して理由を warnings に残す(build / export / judge を止めない)。

export const GROUPS_VERSION = 1;
/** 置き場の既定(リポジトリ直下)。--notes-dir で変えられる */
export const NOTES_DIR_NAME = 'atlas-notes';
export const GROUPS_FILE_NAME = 'groups.json';

/** 送った人のタスクタグのグループ名の、人とタグの区切り */
export const MEMBER_TAG_SEP = ' / ';

/**
 * 送り先から集計したセッションの、送った人が付けていたタスクタグ(uploadTags)をグループにする。
 * 人ごとに分ける(同じ名前のタグでも、別の人のものは別のグループ)。名前は「<人> / <タグ>」、人のフォルダが無ければタグだけ。
 * 並びは人の名前、タグの名前の順。タグの無いセッションは入らない
 */
export function memberGroups(sessions: readonly { id: string; person?: string | null; uploadTags?: readonly string[] }[]): SessionGroup[] {
  // 人とタグの組で分ける(名前をつないだ文字列で分けると、「a」の「b / c」と「a / b」の「c」が 1 つになる)
  const byKey = new Map<string, { person: string; tag: string; ids: Set<string> }>();
  for (const s of sessions) {
    for (const tag of s.uploadTags ?? []) {
      const person = s.person ?? '';
      const key = JSON.stringify([person, tag]);
      let g = byKey.get(key);
      if (!g) byKey.set(key, (g = { person, tag, ids: new Set() }));
      g.ids.add(s.id);
    }
  }
  // 並びは実行する PC のロケールによらず同じにする(build とサーバで同じ並びになるように)
  const order = new Intl.Collator('ja');
  const sorted = [...byKey.values()].sort((a, b) => order.compare(a.person, b.person) || order.compare(a.tag, b.tag));
  // 表示名が重なったら(人の名前やタグに「 / 」が入っているとき)、後のものに番号を付けて分ける(名前はグループの鍵なので重ねない)
  const used = new Set<string>();
  return sorted.map((g) => {
    const base = g.person ? `${g.person}${MEMBER_TAG_SEP}${g.tag}` : g.tag;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
    used.add(name);
    return { name, note: '', ids: [...g.ids] };
  });
}

/**
 * グループ名をフォルダ名にする(書き出し out/groups/<名前>/ とアップロード <基底>/<名前>/)。
 * フォルダ名に使えない文字は _ にし、Windows の予約名・末尾の点と空白も避ける。画面がアップロード先を見せるのにも使う
 */
export function safeDirName(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  // 拡張子が付いても予約名(nul.log など)。memo.ts の RESERVED_NAME と同じ
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = `_${s}`;
  return s || 'group';
}

export interface SessionGroup {
  /** 一意な名前 */
  name: string;
  /** 任意の一文('' も可) */
  note: string;
  /** セッション id(重複なし、順序はファイルのまま) */
  ids: string[];
}

export interface GroupsFile {
  version: typeof GROUPS_VERSION;
  groups: SessionGroup[];
}

export interface ParsedGroups {
  groups: SessionGroup[];
  /** 無視した理由(1 件ごと。表示用の日本語) */
  warnings: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 重複を除いて順序を保つ */
export function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].map((s) => s.trim()).filter(Boolean))];
}

/**
 * groups.json の中身(JSON.parse 済み)を検証する。
 * ファイル全体の形が違えば groups は空で警告 1 件。1 件だけ形が違えばその 1 件を飛ばして警告。重複名は後の方を無視して警告。
 */
export function parseGroups(raw: unknown, source = GROUPS_FILE_NAME): ParsedGroups {
  const warnings: string[] = [];
  if (!isRecord(raw)) return { groups: [], warnings: [`${source}: 全体がオブジェクトではないため無視しました`] };
  if (raw.version !== GROUPS_VERSION) return { groups: [], warnings: [`${source}: version が ${GROUPS_VERSION} ではない(${JSON.stringify(raw.version)})ため無視しました`] };
  if (!Array.isArray(raw.groups)) return { groups: [], warnings: [`${source}: groups が配列ではないため無視しました`] };
  const groups: SessionGroup[] = [];
  const seen = new Set<string>();
  raw.groups.forEach((g: unknown, i: number) => {
    const at = `${source} の groups[${i}]`;
    if (!isRecord(g)) {
      warnings.push(`${at}: オブジェクトではないため無視しました`);
      return;
    }
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    if (!name) {
      warnings.push(`${at}: name が空か文字列ではないため無視しました`);
      return;
    }
    if (seen.has(name)) {
      warnings.push(`${at}: 名前「${name}」が重複しているため後の方を無視しました`);
      return;
    }
    if (!Array.isArray(g.ids) || !g.ids.every((x: unknown) => typeof x === 'string')) {
      warnings.push(`${at}(${name}): ids が文字列の配列ではないため無視しました`);
      return;
    }
    if (g.note != null && typeof g.note !== 'string') warnings.push(`${at}(${name}): note が文字列ではないため空にしました`);
    seen.add(name);
    groups.push({ name, note: typeof g.note === 'string' ? g.note : '', ids: uniqueIds(g.ids as string[]) });
  });
  return { groups, warnings };
}

/** 書き出す形(キーの順を固定し、空の note も書いて雛形になるようにする) */
export function serializeGroups(groups: SessionGroup[]): string {
  const file: GroupsFile = { version: GROUPS_VERSION, groups: groups.map((g) => ({ name: g.name, note: g.note, ids: [...g.ids] })) };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** グループに id を足す(重複は足さない、順序は元のまま + 足した順)。added は実際に増えた数、dup は既に入っていた数 */
export function addIds(group: SessionGroup, ids: Iterable<string>): { group: SessionGroup; added: number; dup: number } {
  const have = new Set(group.ids);
  const next = [...group.ids];
  let added = 0;
  let dup = 0;
  for (const id of uniqueIds(ids)) {
    if (have.has(id)) dup++;
    else {
      have.add(id);
      next.push(id);
      added++;
    }
  }
  return { group: { ...group, ids: next }, added, dup };
}

/** グループから id を外す(0 件になっても消さない)。removed は実際に減った数 */
export function removeIds(group: SessionGroup, ids: Iterable<string>): { group: SessionGroup; removed: number } {
  const drop = new Set(uniqueIds(ids));
  const next = group.ids.filter((id) => !drop.has(id));
  return { group: { ...group, ids: next }, removed: group.ids.length - next.length };
}

/**
 * 先頭一致で id を解決する。完全一致があればそれ、無ければ先頭一致が 1 つだけならそれ。
 * 複数に当たれば曖昧、どれにも当たらなければ未知としてエラーにする(黙って無視しない)。
 */
export function resolveIdPrefixes(known: Iterable<string>, prefixes: string[]): string[] {
  const all = [...known];
  const out: string[] = [];
  for (const p of uniqueIds(prefixes)) {
    if (all.includes(p)) {
      out.push(p);
      continue;
    }
    const hits = all.filter((id) => id.startsWith(p));
    if (hits.length === 1) out.push(hits[0]);
    else if (hits.length === 0) throw new Error(`セッション ${p} は記録にありません`);
    else throw new Error(`セッション ${p} は曖昧です(${hits.length} 件に一致: ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ' …' : ''})`);
  }
  return uniqueIds(out);
}
