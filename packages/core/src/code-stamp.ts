// 版の目印: 画面とサーバの動きを決めるファイルの中身から作る短いハッシュ。
// 集計はページを作るときの目印をページに埋め込み(<meta name="atlas-code">)、サーバは起動したときの目印を応答の x-atlas-code で返す。
// 画面は 2 つを比べ、違えば「画面とサーバの版が違います」と出す(atlas のコードが変わった後も、前から動いているサーバが前のコードのまま応えるため)。
// 材料は次の 3 つ。git pull で中身が変われば目印も変わる:
//  - 各パッケージの src/ の下(サーバと画面のソース)
//  - 各パッケージの直下の、画面の作り方と依存を決めるファイル(PACKAGE_FILES)
//  - リポジトリの直下の、依存と TypeScript の設定(ROOT_FILES)。package-lock.json が変われば、動いているサーバは前の依存を読み込んだまま
// 入れないもの: ビルドしたもの(dist)・node_modules・テスト・説明書・scripts/(サーバも画面も読まない)。
// エディタや OS が置く作業ファイル(JUNK)も入れず、改行は LF にそろえてから数える(コードは同じなのに目印だけ変わって、帯が出るのを避ける)。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/(この下の各パッケージの src を見る) */
export const PACKAGES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 各パッケージの直下で目印に入れるファイル(あれば)。画面のテンプレート、Vite と Svelte の設定(ensureTemplate が作り直しの判定に使うもの)、TypeScript の設定、依存 */
const PACKAGE_FILES = ['template.html', 'vite.config.ts', 'svelte.config.js', 'tsconfig.json', 'package.json'];
/** リポジトリの直下(packages/ の 1 つ上)で目印に入れるファイル(あれば) */
const ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json'];
/** エディタや OS が置く作業ファイル(名前が . で始まるもの、バックアップ、パッチの残り、スワップ)。src の下にあっても数えない */
const JUNK = /^\.|~$|\.(bak|orig|rej|swp|swo|tmp)$|^(thumbs\.db|desktop\.ini)$/i;

/** CRLF を LF にそろえる(バイト列のまま。チェックアウトの設定やエディタで改行だけが変わっても、同じ目印になるように) */
function normalizeEol(buf: Buffer): Buffer {
  return buf.includes('\r\n') ? Buffer.from(buf.toString('latin1').replaceAll('\r\n', '\n'), 'latin1') : buf;
}

/** root(packages/ にあたる場所)の下の各パッケージと、その 1 つ上(リポジトリの直下)から目印を作る。材料は先頭の説明のとおり */
export function computeCodeStamp(root: string): string {
  const files: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pkg = join(root, e.name);
    const src = join(pkg, 'src');
    if (existsSync(src)) {
      for (const f of readdirSync(src, { withFileTypes: true, recursive: true })) {
        if (!f.isFile()) continue;
        const path = join(f.parentPath, f.name);
        // 名前だけでなく、途中のフォルダが作業用(.cache など)でも数えない
        if (!relative(src, path).split(sep).some((part) => JUNK.test(part))) files.push(path);
      }
    }
    for (const name of PACKAGE_FILES) if (existsSync(join(pkg, name))) files.push(join(pkg, name));
  }
  const top = dirname(root);
  for (const name of ROOT_FILES) if (existsSync(join(top, name))) files.push(join(top, name));
  // リポジトリの直下のファイルは「../package.json」のような名前になる(パッケージの中のファイルと重ならない)
  const rel = files.map((f) => ({ f, key: relative(root, f).split(sep).join('/') })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const h = createHash('sha256');
  for (const { f, key } of rel) {
    h.update(key);
    h.update('\0');
    h.update(normalizeEol(readFileSync(f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

let cached: string | null = null;
/** このプロセスが動かしているコードの目印(最初に呼んだときの中身。同じプロセスの中では変わらない) */
export function codeStamp(): string {
  return (cached ??= computeCodeStamp(PACKAGES_ROOT));
}
