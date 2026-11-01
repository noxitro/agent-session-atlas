// 名前付きグループ(atlas-notes/groups.json)の形と読み取り(純関数)。
// ブラウザ側(絞り込み行の「グループ」)と Node 側(CLI の --group / atlas group)の両方から使うので、DOM や node: に依存しない。
// 壊れていてもエラーにせず、読めた分だけ返して理由を warnings に残す(build / export / judge を止めない)。

export const GROUPS_VERSION = 1;
/** 置き場の既定(リポジトリ直下)。--notes-dir で変えられる */
export const NOTES_DIR_NAME = 'atlas-notes';
export const GROUPS_FILE_NAME = 'groups.json';

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
