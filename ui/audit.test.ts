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
          '<button class="p">押す<span>中</span></button><a class="h" href="#here">リンク</a><abbr title="略語の説明">略語</abbr>' +
          '<div role="treeitem" tabindex="0" class="p2">木の項目(操作を受ける役割)</div>' +
          '<label>名前<input type="text" name="n"></label><label>期間<select name="s"><option>すべて</option></select></label><button class="p" disabled>使えない</button>' +
          '<label class="off"><input type="checkbox" disabled>使えない印のラベル</label><button class="busy">書き込み中</button>' +
          // 別の操作を示すカーソル(拡大・幅を変える)、部品の付いていないラベル、一覧の項目(矢印が普通)も指摘しない
          '<button class="zoom">拡大</button><button class="resize">幅</button><label class="cap">見出しだけのラベル</label>' +
          '<ul role="listbox" aria-label="一覧"><li role="option" aria-selected="false">項目</li></ul>',
        '.p{cursor:pointer;padding:8px}.h:hover{color:#000}.p2{cursor:pointer}button:disabled{cursor:default}input,select{min-height:28px;min-width:28px}' +
          '.off{cursor:default}.off input{width:28px;height:28px}.busy{cursor:progress;padding:8px}' +
          '.zoom{cursor:zoom-in;padding:8px}.resize{cursor:col-resize;padding:8px}',
      ),
    );
    // 押せそうで押せない要素の、見落としやすい形(ファイル名付きの自分へのリンク・見出しの中の自分へのリンク・display: contents の親の指のカーソル・
    // 包んだ要素の下線・カンマや入れ子のあるホバーのセレクタ・閉じた details の中・狭い幅でだけ付く指のカーソル)
    await writeFile(
      join(dir, 'clickable.html'),
      page(
        [
          '<dl><dt id="t2"><a href="clickable.html#t2">ファイル名付き</a></dt><dd>説明</dd></dl>',
          '<h2 id="hx"><a href="#hx">見出し</a> <small>補足</small></h2>',
          '<div class="contents"><span>子の一</span><span>子の二</span></div>',
          '<p class="wrap-ul"><span>包んだ下線</span></p>',
          '<div class="tile">タイル</div><div class="row">行</div>',
          '<details><summary>開く</summary><span class="ptr-in">開いた中</span></details>',
          '<p class="narrow-ptr">狭い幅だけ</p>',
          '<span role="button" tabindex="0" class="arrow">押せるのに矢印</span>',
          '<button class="help">押せるのに疑問符</button>',
        ].join(''),
        '.contents{display:contents;cursor:pointer}.wrap-ul{text-decoration:underline}:is(.card, .tile):hover{background:#eee}' +
          '.row:is(:hover, :focus-within){background:#eee}.ptr-in{cursor:pointer}@media (max-width: 500px){.narrow-ptr{cursor:pointer}}' +
          '.help{cursor:help;padding:8px}',
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
        '操作できるのに指のカーソルが出ない', // 指のカーソルを付けていない空のボタン
      ].sort(),
    );
    // カーソルは子に引き継がれるが、指摘は外側の 1 つだけ
    expect(r.findings.filter((f) => f.page === 'bad.html' && f.kind === '指のカーソルが出るのに操作できない')).toHaveLength(1);
    // 見落としやすい形も、どの要素かまで当てる
    const on = (kind: string): string[] => r.findings.filter((f) => f.page === 'clickable.html' && f.kind === kind).map((f) => `${f.detail}${f.where ? ` @${f.where}` : ''}`);
    expect(on('自分自身へのリンク(押しても同じ場所に留まる)')).toEqual(['a 「ファイル名付き」', 'a 「見出し」']);
    const ptr = on('指のカーソルが出るのに操作できない');
    expect(ptr).toHaveLength(3);
    expect(ptr[0]).toBe('div.contents 「子の一子の二」');
    expect(ptr[1]).toBe('span.ptr-in 「開いた中」 @開閉要素を開いた状態');
    expect(ptr[2]).toMatch(/^p\.narrow-ptr 「狭い幅だけ」 @375px ライト$/);
    expect(on('下線があるのにリンクでない')).toEqual(['p.wrap-ul 「包んだ下線」']);
    // 逆向き: 押せるのに矢印や疑問符のまま(指のカーソルを付けていない summary も)。字を打つ欄・選ぶ欄とそのラベル、使えないボタン、
    // 中の印が使えないラベル、待ちを示すカーソル(progress)は指摘しない(other.html)
    expect(on('操作できるのに指のカーソルが出ない')).toEqual(['summary 「開く」(auto)','span.arrow 「押せるのに矢印」(auto)', 'button.help 「押せるのに疑問符」(help)']);
    expect(on('ホバーで見た目が変わるのに操作できない')).toEqual([':is(.card, .tile):hover → div.tile 「タイル」', '.row:is(:hover, :focus-within) → div.row 「行」']);
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
