// 網羅チェック(scripts/ui-audit.ts)の検査。
//  a. 陽性コントロール: わざと不備を入れたページで、検査の種類ごとに必ず見つかる(検査が黙って通らないことを確かめる)
//  b. 架空の fixture で atlas all した全ページ(atlas.html・改善点・指示文と skill・用語・全詳細ページ)に要修正の指摘が無い
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit, summarize } from '../scripts/ui-audit.ts';
import { buildFixtureHome, ROOT } from '../e2e/fixture-home.ts';

const WORK = join(ROOT, 'out', 'ui-audit');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');

const page = (body: string, head = ''): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title><style>body{margin:0;background:#fff;color:#111;font:16px sans-serif}${head}</style></head><body><h1>見出し</h1>${body}</body></html>`;

describe('網羅チェック', () => {
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    await rm(WORK, { recursive: true, force: true });
  });
  afterAll(async () => {
    await close?.();
  });

  it('a. わざと入れた不備を、種類ごとに見つける', async () => {
    const dir = join(WORK, 'positive');
    await mkdir(join(dir, 'sessions'), { recursive: true });
    // 指摘しないもの: 節の先頭へ戻るリンク(行き先がほかの中身も持つ)・ボタンの中の字の指のカーソル・リンクのホバー・title 付きの略語の下線
    await writeFile(
      join(dir, 'other.html'),
      page(
        '<p id="here">行き先</p><section id="sec"><h2>節</h2><p>本文</p><a href="#sec">節の先頭へ</a></section>' +
          '<button class="p">押す<span>中</span></button><a class="h" href="#here">リンク</a><abbr title="略語の説明">略語</abbr>',
        '.p{cursor:pointer;padding:8px}.h:hover{color:#000}',
      ),
    );
    await writeFile(
      join(dir, 'bad.html'),
      page(
        [
          '<p id="x">一</p><p id="x">二</p>',
          '<a href="#nowhere">ページ内の行き先なし</a>',
          '<a href="missing.html">無いファイル</a>',
          '<a href="other.html#nope">別ページの行き先なし</a>',
          '<a href="other.html#here">正しいリンク</a>',
          '<a href="#ids=a,b">絞り込みの状態(検査しない)</a>',
          '<p>合計 undefined 件、率 NaN%</p>',
          '<p>&amp;lt;b&amp;gt;</p>',
          '<p>&lt;!-- 見出し --&gt;</p>',
          '<pre>本文の引用の undefined と &lt;!-- は数えない</pre>',
          '<p class="faint">薄い文字</p>',
          '<div class="wide">はみ出す</div>',
          '<button></button>',
          '<img src="other.html">',
          '<input type="text">',
          '<h3>段の飛び</h3>',
          '<div class="scroll"><p class="tall">縦に長い</p></div>',
          '<dl><dt id="term"><a href="#term">用語</a></dt><dd>説明</dd></dl>',
          '<p class="ptr">押せそうな字<span>中の字(外側だけ数える)</span></p>',
          '<div class="hov">ホバーで変わる</div>',
          '<p class="ul">下線の字</p>',
          '<script>console.error("わざとのエラー")</script>',
        ].join(''),
        '.faint{color:#aaa}.wide{width:2000px}.scroll{height:40px;overflow:auto}.tall{height:400px}' +
          '.ptr{cursor:pointer}.hov:hover{background:#eee}.ul{text-decoration:underline}',
      ),
    );
    const r = await audit(dir, { layoutSessions: 0 });
    const kinds = (p: string): string[] => [...new Set(r.findings.filter((f) => f.page === p).map((f) => f.kind))].sort();
    expect(kinds('bad.html')).toEqual(
      [
        'id の重複',
        'ページ内リンクの行き先が無い',
        'リンク先のファイルが無い',
        '別ページのリンクの行き先が無い',
        '文言の漏れ: undefined',
        '文言の漏れ: NaN',
        '文言の漏れ: 二重に逃がした実体参照',
        '文言の漏れ: HTML コメントの印',
        'コントラスト不足',
        '横にはみ出している',
        '横にはみ出している(字幅の広いフォント)',
        '名前の無い操作要素',
        'alt の無い画像',
        'ラベルの無い入力欄',
        '見出しの段の飛び',
        'キーボードで届かないスクロール領域',
        '押す的が小さい(375px)', // 名前の無い空のボタン
        '実行時のエラー',
        '自分自身へのリンク(押しても同じ場所に留まる)',
        '指のカーソルが出るのに操作できない',
        'ホバーで見た目が変わるのに操作できない',
        '下線があるのにリンクでない',
      ].sort(),
    );
    // カーソルは子に引き継がれるが、指摘は外側の 1 つだけ
    expect(r.findings.filter((f) => f.page === 'bad.html' && f.kind === '指のカーソルが出るのに操作できない')).toHaveLength(1);
    // 正しいリンク・絞り込みの状態のハッシュ・pre の中は指摘しない
    expect(r.findings.some((f) => /other\.html#here|#ids=/.test(f.detail))).toBe(false);
    expect(kinds('other.html')).toEqual([]);
    // はみ出しは 375px でだけ起きる(1024 / 1440 は 2000px 未満なので両方出る)ことを、幅ごとに記録する
    expect(r.findings.filter((f) => f.page === 'bad.html' && f.kind === '横にはみ出している').map((f) => f.where)).toContain('375px ライト');
  });

  it('b. fixture の全ページに要修正の指摘が無い(全幅・両配色)', async () => {
    let home: string;
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    const out = join(WORK, 'out');
    const res = spawnSync(process.execPath, [CLI, 'all', '--home', home, '--out', out, '--notes-dir', join(WORK, 'notes')], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(res.status, res.stderr).toBe(0);
    const r = await audit(out, { layoutSessions: 6 });
    expect(r.pages).toBeGreaterThan(4);
    const errors = r.findings.filter((f) => f.severity === 'error');
    expect(errors, summarize({ pages: r.pages, findings: errors })).toEqual([]);
  });
});
