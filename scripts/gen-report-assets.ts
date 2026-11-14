// report のページに埋め込む JS と CSS の文字列(TS のテンプレートリテラル)を、Rust 版がそのまま使えるファイルに書き出す(Rust 移行。docs/rust-migration.md)。
//
//   node scripts/gen-report-assets.ts          … crates/atlas-report/assets/ に書く
//   node scripts/gen-report-assets.ts --check  … 書かずに比べ、TS 側と違うものがあれば終了コード 1(cargo test の drift のテストが使う)
//
// - export している定数(NAV_JS など。中で JSON.stringify などを使っているもの)は、モジュールを読み込んで値を取る。
// - export していない定数(DETAIL_CSS など)は、ソースから `const 名前 = `…`;` を取り出してテンプレートリテラルとして評価する
//   (${…} を含むものは扱えないので、含んでいたら止める)。TS のソースは書き換えない。
// - TS のサーバー側のコードを消す段(段 8)で、ここに書き出したファイルが元になる。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'report', 'src');
const OUT = join(ROOT, 'crates', 'atlas-report', 'assets');

/** ソースから、export していない `const NAME = `…`;` の値を取り出す */
function literal(file: string, name: string): string {
  const text = readFileSync(join(SRC, file), 'utf8');
  const head = new RegExp(`(?:^|\\n)(?:export )?const ${name} = \``).exec(text);
  if (!head) throw new Error(`${file} に const ${name} = \`…\` がありません`);
  let i = head.index + head[0].length;
  const start = i;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '$' && text[i + 1] === '{') throw new Error(`${file} の ${name} は \${…} を含むので取り出せません(export して値を読んでください)`);
    if (c === '`') break;
  }
  if (i >= text.length) throw new Error(`${file} の ${name} の終わりが見つかりません`);
  const body = text.slice(start, i);
  return new Function(`return \`${body}\`;`)() as string;
}

async function collect(): Promise<Record<string, string>> {
  const nav = await import('../packages/report/src/page-nav.ts');
  const memo = await import('../packages/report/src/memo-render.ts');
  const editor = await import('../packages/report/src/memo-editor.ts');
  const tools = await import('../packages/report/src/session-tools.ts');
  const viewer = await import('../packages/report/src/viewer.ts');
  return {
    'nav.js': nav.NAV_JS,
    'new-window-mark.html': nav.NEW_WINDOW_MARK,
    'theme-seg.html': literal('page-nav.ts', 'THEME_SEG'),
    'memo.css': memo.MEMO_CSS,
    'memo-editor.js': editor.MEMO_EDITOR_JS,
    'session-tools.js': tools.SESSION_TOOLS_JS,
    'view.css': viewer.VIEW_CSS,
    'viewer.js': literal('viewer.ts', 'VIEWER_JS'),
    'detail.css': literal('detail.ts', 'DETAIL_CSS'),
    'glossary.css': literal('glossary-page.ts', 'GLOSSARY_CSS'),
    'glossary-copy.js': literal('glossary-page.ts', 'COPY_JS'),
    'missing-legend.html': literal('glossary-page.ts', 'MISSING_LEGEND'),
    'insights.css': literal('insights-page.ts', 'CSS'),
    'library.css': literal('library.ts', 'LIB_CSS'),
    'library-filter.js': literal('library.ts', 'FILTER_JS'),
  };
}

const check = process.argv.includes('--check');
const assets = await collect();
let drift = 0;
if (!check) mkdirSync(OUT, { recursive: true });
for (const [name, value] of Object.entries(assets)) {
  const path = join(OUT, name);
  if (check) {
    const cur = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (cur !== value) {
      drift++;
      console.error(`${name}: TS の定数と違います(node scripts/gen-report-assets.ts で書き直してください)`);
    }
  } else writeFileSync(path, value);
}
if (check && drift) process.exit(1);
if (!check) console.log(`${Object.keys(assets).length} ファイル → ${OUT}`);
