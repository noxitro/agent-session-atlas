// Markdown の描画(メモと、serve の記録の表示)を TS 版(marked)と Rust 版(comrak + 自前の HTML)で突き合わせる(Rust 移行の確認用)。
//
//   node scripts/parity-markdown.ts [--dir <フォルダ>]... [--quiet] [--rs <mddump>]
//
// - 既定は組み込みの例(TS のテストの入力と、marked と CommonMark で扱いの分かれやすい形)。--dir を付けると、その下の .md を全部足す
//   (out/sessions/*.md はセッション記録、out/full/*.md は全文記録、それ以外はメモとして描く)。
// - --quiet: 差のあった件数と場所だけを出し、本文の抜粋を出さない(実データで使う)。--shape: 差の場所の形(タグと記号。文字は伏せる)だけを出す。
// - Rust 側は crates/atlas-report/examples/mddump.rs(cargo build --release -p atlas-report --example mddump)。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { renderMemoHtml } from '../packages/report/src/memo-render.ts';
import { renderViewDocument } from '../packages/report/src/viewer.ts';
import { firstTextDiff } from './parity-common.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { dir: { type: 'string', multiple: true }, quiet: { type: 'boolean', default: false }, shape: { type: 'boolean', default: false }, rs: { type: 'string' } } });
const exe = process.platform === 'win32' ? 'mddump.exe' : 'mddump';
const rs = values.rs ?? [join(ROOT, 'target', 'release', 'examples', exe), join(ROOT, 'target', 'debug', 'examples', exe)].find((p) => existsSync(p));
if (!rs) {
  console.error('mddump がありません(cargo build --release -p atlas-report --example mddump)');
  process.exit(2);
}

type Mode = 'memo' | 'transcript' | 'full';
interface Case {
  mode: Mode;
  /** 本文。--dir のファイルは path から読む(全文記録は合わせて GB 単位になるので、まとめて持たない) */
  text?: string;
  path?: string;
  size: number;
  id?: string;
  label: string;
}

const BUILTIN: string[] = [
  '<script>alert(1)</script>\n\n本文 <img src=x onerror=alert(2)> と <b>太字</b>',
  '[a](https://example.test/x)',
  '[m](mailto:a@example.test)',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](data:text/html,<b>)',
  '見る http://example.test/a と `https://example.test/b` と foo://bar\n\n```\nfetch("http://example.test")\n```',
  '# a',
  '###### a',
  '![図](https://example.test/a.png)',
  '![図](javascript:alert(1))',
  '![図](//example.test/a.png)',
  '![a](x/y.png)',
  '- [ ] 未\n- [x] 済',
  '| a |\n|---|\n| 1 |',
  '1 行目\n2 行目',
  '- a\n- b\n\n- c',
  '- a\n  - b\n- c',
  '1. a\n2. b',
  '3. a\n4. b',
  '| a | b |\n|:-|-:|\n| 1 | 2 |',
  'a  \nb',
  '`a<b>` and ``x ` y``',
  '```js\nx < 1 & 2\n```',
  '    indented <code>',
  '> quote\n> two',
  '***\n\n---',
  '**b** *i* ~~d~~ ~e~',
  'http://example.test/a. and www.x.test and a@b.test',
  '<div>\nhi\n</div>\n\npara',
  'inline <b>x</b> html',
  '<details>\n<summary>s</summary>\n\nbody\n\n</details>',
  '&amp; &#39; &#x27; &quot; &copy; a\\*b \\<x\\>',
  'AT&T と &#12354; &nbsp;x',
  '[l&amp;](https://a.test/?a=1&amp;b=2)',
  '[a](https://x.test "title")',
  'Setext\n===',
  '# h1 #',
  'line\n\n\n\nline2',
  '- a\n\n  b\n- c',
  '- [ ] task\n\n  more',
  "it's \"q\"",
  '**太字**の後と「**かぎ**」と**「かぎ」**です',
  'http://x.test/aです。と https://x.test/b)',
  '- item\n  continued\n- next',
  '> - a\n> - b',
  '1) a\n2) b',
  '```\nunclosed',
  '```\nx\n\n```',
  'a\n- b',
  '<small>x</small> と </small>',
  '| a | b |\n|---|---|\n| 1 \\| 2 | 3 |',
  '| a |\n|---|',
  '- `code`\n- **b**',
  '* a\n+ b',
  '[ref]\n\n[ref]: https://x.test',
  '<https://x.test/auto>',
  '_under_ and __bold__ and snake_case_word',
  'a\n\n---\nb',
  'text\n---',
  '~~~\ntilde\n~~~',
  '  - indented list\n  - two',
  '- a\n\n\n- b',
  '> quote\n\n> again',
  'trailing spaces   \nnext',
  '\ttab start',
  'Line with <!-- comment --> inside',
  '<!-- block comment -->',
  '![](x.png)',
  '[![img](a.png)](https://x.test)',
  '  lead para\n  second line\n\tthird',
  'a\n   b  \n c',
  '- item\n\n  <small>x</small>\n\n  <small>top</small>',
  '> q\n>   indented',
  '```\n&#39; & x\n```\n\n`&#39; &`',
];

const cases: Case[] = BUILTIN.flatMap((text, i) => [
  { mode: 'memo' as const, text, size: text.length, label: `builtin#${i} memo` },
  { mode: 'transcript' as const, text: `# 題\n\n## 節\n\n${text}`, size: text.length, label: `builtin#${i} view` },
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}
for (const d of values.dir ?? []) {
  const base = resolve(d);
  for (const p of walk(base)) {
    const rel = relative(base, p).split(sep).join('/');
    const parent = basename(dirname(p));
    const mode: Mode = parent === 'sessions' ? 'transcript' : parent === 'full' ? 'full' : 'memo';
    // メモは memo-io と同じく先頭の BOM を外して描く
    cases.push({ mode, path: p, size: statSync(p).size, id: basename(p, '.md'), label: `${basename(base)}/${rel}` });
  }
}

/** 本文(メモは memo-io と同じく先頭の BOM を外す) */
const textOf = (c: Case): string => {
  if (c.text != null) return c.text;
  const raw = readFileSync(c.path!, 'utf8');
  return c.mode === 'memo' ? raw.replace(/^\uFEFF/, '') : raw;
};

const tmp = mkdtempSync(join(tmpdir(), 'atlas-md-'));
try {
  const input = join(tmp, 'cases.json');
  const output = join(tmp, 'out.json');
  let diffs = 0;
  let tsMs = 0;
  let rsMs = 0;
  // 64MB ずつ Rust 側に渡す
  for (let start = 0; start < cases.length; ) {
    let end = start;
    let size = 0;
    while (end < cases.length && (end === start || size + cases[end].size < 64 * 1024 * 1024)) size += cases[end++].size;
    const batch = cases.slice(start, end);
    const texts = batch.map(textOf);
    writeFileSync(input, JSON.stringify(batch.map(({ mode, id }, k) => ({ mode, text: texts[k], id }))));
    const t0 = performance.now();
    const ts = batch.map((c, k) => {
      if (c.mode === 'memo') return { html: renderMemoHtml(texts[k], () => null) };
      const d = renderViewDocument(texts[k], { kind: c.mode, id: c.id ?? 's', fullDir: null });
      return { html: d.html, headings: d.headings, title: d.title };
    });
    tsMs += performance.now() - t0;
    const t1 = performance.now();
    const r = spawnSync(rs, [input, output], { encoding: 'utf8' });
    rsMs += performance.now() - t1;
    if (r.status !== 0) {
      console.error(r.stderr);
      process.exit(1);
    }
    const got = JSON.parse(readFileSync(output, 'utf8')) as { html: string; headings?: unknown; title?: unknown }[];
    batch.forEach((c, i) => {
      const a = ts[i];
      const b = got[i];
      const same = a.html === b.html && JSON.stringify(a.headings ?? null) === JSON.stringify(b.headings ?? null) && (a as { title?: unknown }).title === b.title;
      if (same) return;
      diffs++;
      if (values.shape) {
        // 本文を出さずに、差のある場所の形(記号と HTML のタグ)だけを出す: 英数字は a、それ以外の文字は あ
        let k = 0;
        while (k < a.html.length && a.html[k] === b.html[k]) k++;
        const mask = (x: string): string => x.slice(Math.max(0, k - 80), k + 80).replace(/<[^>]*>|[A-Za-z0-9]|[^\x00-\x7f]/g, (m) => (m.startsWith('<') ? m.replace(/"[^"]*"/g, '"…"') : /[A-Za-z0-9]/.test(m) ? 'a' : 'あ'));
        console.log(`✗ ${c.mode}\n  TS:   ${JSON.stringify(mask(a.html))}\n  Rust: ${JSON.stringify(mask(b.html))}`);
      } else if (values.quiet) console.log(`✗ ${c.label}(${c.mode})`);
      else console.log(`✗ ${c.label}(${c.mode})\n  input: ${JSON.stringify(texts[i]).slice(0, 300)}\n  ${a.html === b.html ? `見出し/表題が違う TS ${JSON.stringify([a.headings, (a as { title?: unknown }).title]).slice(0, 300)} Rust ${JSON.stringify([b.headings, b.title]).slice(0, 300)}` : firstTextDiff(a.html, b.html)}`);
    });
    start = end;
  }
  console.log(`${diffs ? '✗' : '✓'} markdown: ${cases.length} 件、差 ${diffs} 件(TS ${(tsMs / 1000).toFixed(2)} 秒 / Rust ${(rsMs / 1000).toFixed(2)} 秒)`);
  process.exit(diffs ? 1 : 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
