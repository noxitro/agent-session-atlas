// ナレッジ vault(llm-wiki)参照の分類。どの vault をどの形式で数えるかは WikiSpec で指定する
import type { WikiUsage } from './types.ts';

/** 参照を数える vault 1 つの指定。path 以外は省略すると DEFAULT_WIKI と同じ */
export interface WikiSpec {
  /** vault のフォルダ名か、その末尾を含むパス(例: my-notes、D:/notes/my-notes) */
  path: string;
  /** 索引のファイル(vault からの相対パス) */
  index?: string[];
  /** 個別ページを置くフォルダ(vault からの相対パス)。'.' は vault 全体 */
  pages?: string[];
  /** 個別ページの拡張子 */
  extensions?: string[];
  /** wiki の skill 名 */
  skills?: string[];
}

/** 設定が無いときに数える vault(llm-wiki の標準の形式) */
export const DEFAULT_WIKI: Required<WikiSpec> = {
  path: 'global-llm-wiki',
  index: ['index.md'],
  pages: ['wiki'],
  extensions: ['.md'],
  skills: ['wiki-ingest', 'wiki-query', 'wiki-lint'],
};

const WRITE_TOOLS = new Set(['edit', 'create', 'apply_patch', 'write', 'str_replace_editor']);
/** パスの名前に使われる文字。vault 名の前後がこれだと別のフォルダとみなす(my-notes-app を my-notes に数えない) */
const NAME_CHAR = '[\\p{L}\\p{N}_-]';

interface CompiledWiki {
  label: string;
  /** vault の位置 */
  marker: RegExp;
  index: RegExp | null;
  page: RegExp | null;
}

export function emptyWiki(): WikiUsage {
  return { indexReads: 0, pageReads: [], skillCalls: [], writes: 0, otherCalls: 0 };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 区切りを / にそろえて連続もまとめる */
const normPath = (s: string): string => s.replace(/[\\/]+/g, '/');
const trimPath = (s: string): string => normPath(s).replace(/^(\.\/)+/, '').replace(/\/$/, '');

/** ツール引数の文字列値だけをつなぐ(JSON にすると改行が \n のまま残り、パスの区切りと見分けられない) */
function argText(args: unknown): string {
  if (typeof args === 'string') return args;
  if (Array.isArray(args)) return args.map(argText).join('\n');
  if (args && typeof args === 'object') return Object.values(args).map(argText).join('\n');
  return '';
}

function compile(spec: WikiSpec): CompiledWiki {
  const path = trimPath(spec.path);
  const vault = `(?<!${NAME_CHAR}|\\.)${escapeRe(path)}(?!${NAME_CHAR}|\\.[\\p{L}\\p{N}])`;
  const index = (spec.index ?? DEFAULT_WIKI.index).map((f) => escapeRe(trimPath(f)));
  const dirs = (spec.pages ?? DEFAULT_WIKI.pages).map(trimPath);
  const exts = (spec.extensions ?? DEFAULT_WIKI.extensions).map((e) => escapeRe(e.replace(/^\./, '')));
  const prefix = dirs.some((d) => d === '' || d === '.') ? '' : `(?:${dirs.map((d) => `${escapeRe(d)}/`).join('|')})`;
  return {
    label: path.split('/').pop() ?? path,
    marker: new RegExp(vault, 'iu'),
    index: index.length ? new RegExp(`${vault}/(?:${index.join('|')})(?!${NAME_CHAR}|\\.)`, 'iu') : null,
    page: dirs.length && exts.length ? new RegExp(`${vault}/(${prefix}[^"'\`*?<>|:\\n]+?\\.(?:${exts.join('|')}))(?!${NAME_CHAR})`, 'giu') : null,
  };
}

/** 指定の vault に対してツール呼び出しと skill を分類する */
export class WikiClassifier {
  private readonly wikis: CompiledWiki[];
  private readonly skills: Set<string>;

  constructor(specs: WikiSpec[] = [DEFAULT_WIKI]) {
    this.wikis = specs.map(compile);
    this.skills = new Set(specs.flatMap((s) => s.skills ?? DEFAULT_WIKI.skills));
  }

  /** 名前か、skill のファイルの場所から wiki の skill か判定する */
  isSkill(name: string, path?: unknown): boolean {
    return this.skills.has(name) || this.find(normPath(String(path ?? ''))) != null;
  }

  private find(text: string): CompiledWiki | undefined {
    return this.wikis.find((w) => w.marker.test(text));
  }

  /**
   * ツール呼び出し 1 件を分類して w に加える。対象でなければ false。
   * - skill: 引数に vault を含むか、skill 名が指定のもの
   * - 書き込み系ツール: writes
   * - 索引を含む: indexReads
   * - ページのフォルダ配下: pageReads(vault からの相対パス。vault が複数なら先頭に vault 名)
   * - それ以外(log.md、glob 等): otherCalls
   */
  classify(w: WikiUsage, toolName: string, args: unknown): boolean {
    const text = normPath(argText(args));
    const vault = this.find(text);
    if (toolName === 'skill') {
      const skill = typeof (args as any)?.skill === 'string' ? (args as any).skill : '';
      if (!vault && !this.skills.has(skill)) return false;
      w.skillCalls.push(skill || '(unknown)');
      return true;
    }
    if (!vault) return false;
    if (WRITE_TOOLS.has(toolName)) {
      w.writes++;
      return true;
    }
    if (vault.index?.test(text)) {
      w.indexReads++;
      return true;
    }
    const pages = vault.page ? [...text.matchAll(vault.page)].map((m) => m[1]!) : [];
    if (pages.length > 0) {
      for (const p of new Set(pages)) w.pageReads.push(this.wikis.length > 1 ? `${vault.label}/${p}` : p);
      return true;
    }
    w.otherCalls++;
    return true;
  }
}
