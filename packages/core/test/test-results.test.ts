// テストの実行ファイルが書いた印つきの 1 行 JSON(test-results.ts)。値はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { MAX_TEST_NAME, MAX_TEST_RESULTS, parseTestLine, TestCollector, type CompleteInfo } from '../src/test-results.ts';

const info = (turn: number | null): CompleteInfo => ({
  at: '2026-11-16T00:00:01.000Z',
  turn,
  tool: 'powershell',
  toolCallId: 'c1',
  subagent: false,
  atMs: turn != null ? turn * 1000 : null,
  activeMs: (turn ?? 0) * 500,
});

describe('parseTestLine: 印の行を読む', () => {
  it('行頭(前の空白は可)の印と 1 行の JSON を読む。名前と件数の名前は前後の空白を落とし、数でない件数は捨てる', () => {
    const r = parseTestLine(
      '  ATLAS_TEST_RESULT {"name":" 描画\\t","passed":false,"counts":{"assertFailures":2,"diffRate":0.125,"bad":"x","":1},"at":"2026-11-16T10:00:00+09:00","extra":{"x":1}}',
    );
    expect(r?.kind).toBe('result');
    if (r?.kind !== 'result') return;
    expect(r.result).toEqual({ name: '描画', passed: false, counts: { assertFailures: 2, diffRate: 0.125 }, at: '2026-11-16T01:00:00.000Z' });
    expect(Object.keys(r.result)).toEqual(['name', 'passed', 'counts', 'at']);
    expect(r.key).not.toBeNull();
    // at の無い行は重ねて数えない鍵を持たず、キーも無い
    const plain = parseTestLine('ATLAS_TEST_RESULT {"passed":true}');
    expect(plain).toEqual({ kind: 'result', result: { name: null, passed: true, counts: {} }, key: null });
    expect(parseTestLine('ATLAS_TEST_RESULT {"passed":true}\r')?.kind).toBe('result');
  });

  it('印はあるが読めない行は invalid、行頭に印が無い行と別の語は印の行にしない', () => {
    for (const l of ['ATLAS_TEST_RESULT', 'ATLAS_TEST_RESULT {', 'ATLAS_TEST_RESULT {"passed":"yes"}', 'ATLAS_TEST_RESULT [true]', 'ATLAS_TEST_RESULT {"name":"a"}']) {
      expect(parseTestLine(l), l).toEqual({ kind: 'invalid' });
    }
    for (const l of ['print("ATLAS_TEST_RESULT {\\"passed\\":true}")', '12: ATLAS_TEST_RESULT {"passed":true}', 'ATLAS_TEST_RESULTS {"passed":true}', 'ok']) {
      expect(parseTestLine(l), l).toBeNull();
    }
  });

  it('書式の崩れた時刻は捨てる。長い名前は切る。__proto__ も件数の名前として持つ', () => {
    const r = parseTestLine(`ATLAS_TEST_RESULT {"name":"${'あ'.repeat(300)}","passed":true,"at":"きのう","counts":{"__proto__":3}}`);
    if (r?.kind !== 'result') throw new Error('読めない');
    expect('at' in r.result).toBe(false);
    expect(r.result.name!.length).toBe(MAX_TEST_NAME);
    expect(Object.hasOwn(r.result.counts, '__proto__')).toBe(true);
    expect(JSON.stringify(r.result.counts)).toBe('{"__proto__":3}');
  });
});

describe('TestCollector: 呼び出しごとに集める', () => {
  it('同じ呼び出しの 2 か所からは 1 回だけ。at のある行は重ねない。失敗したツールはエラーの文から読む', () => {
    const c = new TestCollector();
    const a = 'ATLAS_TEST_RESULT {"name":"a","passed":false,"at":"2026-11-16T00:00:00Z"}';
    const b = 'ATLAS_TEST_RESULT {"name":"b","passed":true}';
    const text = `building...\n${a}\n${b}\nATLAS_TEST_RESULT oops\n`;
    // detailedContent と content の両方に同じ行があっても 1 回だけ
    c.addComplete({ content: text, detailedContent: text }, undefined, info(1));
    // 後から同じ出力を読んだ: at のある a は重ねない、at の無い b は数える
    c.addComplete({ content: `${a}\n${b}` }, undefined, info(2));
    c.addComplete(undefined, { code: 'failure', message: 'exit 1\nATLAS_TEST_RESULT {"name":"c","passed":false}' }, info(null));
    // 印の無い結果は数えない
    c.addComplete('ok', undefined, info(3));
    const s = c.finish(() => null)!;
    expect(s.runs.map((r) => [r.turn, r.results.map((x) => x.name)])).toEqual([
      [1, ['a', 'b']],
      [2, ['b']],
      [null, ['c']],
    ]);
    expect([s.invalid, s.duplicates, s.dropped]).toEqual([1, 1, 0]);
    expect(s.runs[0].tool).toBe('powershell');
    // キーの順(sessions.json の形)
    expect(Object.keys(s)).toEqual(['runs', 'invalid', 'duplicates', 'dropped', 'firstPass']);
    expect(Object.keys(s.runs[0])).toEqual(['at', 'turn', 'tool', 'toolCallId', 'activeMs', 'nanoAiu', 'failing', 'results']);
    expect(new TestCollector().finish(() => null)).toBeNull();
  });

  it('推移: 名前ごとのいちばん新しい結果で、まだ通っていない数と最初に全部通った実行を決める', () => {
    const line = (name: string, passed: boolean) => `ATLAS_TEST_RESULT {"name":"${name}","passed":${passed}}`;
    const c = new TestCollector();
    // 1: a・b とも落ちる → 2: a だけ走らせ直して通る(b は落ちたまま)→ 3: b だけ通る(全部通った)→ 4: a がまた落ちる
    c.addComplete(`${line('a', false)}\n${line('b', false)}`, undefined, info(1));
    c.addComplete(line('a', true), undefined, info(2));
    c.addComplete(line('b', true), undefined, info(3));
    c.addComplete(line('a', false), undefined, info(null));
    // 時刻 t までの累計は t(時刻の無い実行は null)
    const s = c.finish((t) => t)!;
    expect(s.runs.map((r) => r.failing)).toEqual([2, 1, 0, 1]);
    expect(s.firstPass).toBe(3);
    expect(s.runs.map((r) => r.nanoAiu)).toEqual([1000, 2000, 3000, null]);
    expect(s.runs.map((r) => r.activeMs)).toEqual([500, 1000, 1500, 0]);
    // 一度も通らなければ null。読めない行だけのセッションは実行が無い
    const never = new TestCollector();
    never.addComplete(line('a', false), undefined, info(1));
    expect(never.finish(() => null)!.firstPass).toBeNull();
    const broken = new TestCollector();
    broken.addComplete('ATLAS_TEST_RESULT x', undefined, info(1));
    const b = broken.finish(() => null)!;
    expect([b.runs.length, b.invalid, b.firstPass]).toEqual([0, 1, null]);
    // 名前の無い結果は 1 つのテスト
    const unnamed = new TestCollector();
    unnamed.addComplete('ATLAS_TEST_RESULT {"passed":false}\nATLAS_TEST_RESULT {"passed":true}', undefined, info(1));
    expect(unnamed.finish(() => null)!.firstPass).toBe(1);
  });

  it(`1 セッションで持つ結果は ${MAX_TEST_RESULTS} 件まで(超えた分は数だけ)`, () => {
    const c = new TestCollector();
    c.addComplete(Array.from({ length: MAX_TEST_RESULTS + 3 }, () => 'ATLAS_TEST_RESULT {"passed":true}').join('\n'), undefined, info(1));
    const s = c.finish(() => null)!;
    expect(s.runs[0].results.length).toBe(MAX_TEST_RESULTS);
    expect(s.dropped).toBe(3);
  });
});
