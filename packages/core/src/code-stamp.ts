// 版の目印: atlas のソース(packages/*/src と report の template.html)の中身から作る短いハッシュ。
// 集計はページを作るときの目印をページに埋め込み(<meta name="atlas-code">)、サーバは起動したときの目印を応答の x-atlas-code で返す。
// 画面は 2 つを比べ、違えば「画面とサーバの版が違います」と出す(atlas を更新した後も、前から動いているサーバが古いコードのまま応えるため)。
// git pull で中身が変われば目印も変わる。ビルドしたもの(dist)・node_modules・テスト・説明書は入れない。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/(この下の各パッケージの src を見る) */
export const PACKAGES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** root(packages/ にあたる場所)の下の各パッケージの src/ 以下のファイルと template.html から目印を作る */
export function computeCodeStamp(root: string): string {
  const files: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const src = join(root, e.name, 'src');
    if (existsSync(src)) {
      for (const f of readdirSync(src, { withFileTypes: true, recursive: true })) if (f.isFile()) files.push(join(f.parentPath, f.name));
    }
    const tpl = join(root, e.name, 'template.html');
    if (existsSync(tpl)) files.push(tpl);
  }
  const rel = files.map((f) => ({ f, key: relative(root, f).split(sep).join('/') })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const h = createHash('sha256');
  for (const { f, key } of rel) {
    h.update(key);
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

let cached: string | null = null;
/** このプロセスが動かしているコードの目印(最初に呼んだときの中身。同じプロセスの中では変わらない) */
export function codeStamp(): string {
  return (cached ??= computeCodeStamp(PACKAGES_ROOT));
}
