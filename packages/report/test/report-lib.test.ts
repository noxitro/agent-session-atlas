// report の画面の lib(ブラウザで動く TS)のうち、セッションの記録を作らずに確かめられるもの。
// 記録(sessions.json の形)から集計・絞り込み・伏せ字を確かめるテストは、記録を作る normalize が Rust(crates/atlas-core)に移ったので、
// Rust の lib の移植(crates/atlas-report/tests/lib_reports.rs)と、TS の lib との突き合わせ(scripts/parity-lib.ts)が受け持つ。
import { describe, expect, it } from 'vitest';
import { monthRange } from '../src/lib/aggregate.ts';
import { shortProjectLabel } from '../src/lib/anonymize.ts';
import { embedData, extractEmbedded, serializeForScript } from '../src/lib/embed.ts';
import { decodeFilter, emptyFilter, encodeFilter, groupIds, isEmptyFilter } from '../src/lib/filter.ts';
import { addIds, memberGroups, parseGroups, removeIds, resolveIdPrefixes, serializeGroups } from '../src/lib/groups.ts';
import { parseJudgments } from '../src/lib/judgments.ts';
import { niceTicks } from '../src/lib/scale.ts';
import { modelLabel, sharedLeads, splitLead } from '../src/lib/format.ts';
import { GLOSSARY, GLOSSARY_GROUPS, termsByGroup } from '../src/lib/glossary.ts';

describe('aggregate', () => {
  it('monthRange は年をまたいで欠けなく並べる', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('filter', () => {
  it('URL ハッシュと往復でき、不正な値は捨てる', () => {
    const f = { ...emptyFilter(), project: 'a/b c', coverage: 'none' as const, from: '2026-01-01' };
    expect(decodeFilter(`#${encodeFilter(f)}`)).toEqual(f);
    expect(isEmptyFilter(decodeFilter('#coverage=bogus&unknown=1&project=%E0%A4'))).toBe(true);
    expect(encodeFilter(emptyFilter())).toBe('');
  });
});

describe('groups: 追加と除外(純関数)', () => {
  it('addIds は重複を足さず順序を保ち、removeIds は 0 件になっても消さない', () => {
    const g = { name: 'g', note: '', ids: ['a', 'b'] };
    const r = addIds(g, ['b', 'c', 'c', ' ', 'a']);
    expect(r).toEqual({ group: { name: 'g', note: '', ids: ['a', 'b', 'c'] }, added: 1, dup: 2 });
    expect(g.ids).toEqual(['a', 'b']);
    expect(addIds(g, [])).toEqual({ group: { name: 'g', note: '', ids: ['a', 'b'] }, added: 0, dup: 0 });
    const d = removeIds(g, ['a', 'zzz']);
    expect(d).toEqual({ group: { name: 'g', note: '', ids: ['b'] }, removed: 1 });
    expect(removeIds(d.group, ['b'])).toEqual({ group: { name: 'g', note: '', ids: [] }, removed: 1 });
    expect(removeIds({ ...g, ids: [] }, ['a'])).toEqual({ group: { name: 'g', note: '', ids: [] }, removed: 0 });
  });
});

describe('groups(atlas-notes/groups.json)', () => {
  it('正常な形を読み、重複した id を除く。書き出しはキーの順を固定して雛形になる', () => {
    const r = parseGroups({ version: 1, groups: [{ name: ' 調査 ', note: 'x', ids: ['a', 'b', 'a', ' '] }, { name: '空', ids: [] }] });
    expect(r.warnings).toEqual([]);
    expect(r.groups).toEqual([
      { name: '調査', note: 'x', ids: ['a', 'b'] },
      { name: '空', note: '', ids: [] },
    ]);
    expect(serializeGroups(r.groups)).toBe(`${JSON.stringify({ version: 1, groups: r.groups }, null, 2)}\n`);
  });

  it('壊れた形はエラーにせず、読めた分だけ返して理由を残す(全体 / 1 件 / 重複名)', () => {
    expect(parseGroups(null).groups).toEqual([]);
    expect(parseGroups(null).warnings[0]).toMatch(/オブジェクトではない/);
    expect(parseGroups({ version: 2, groups: [] }).warnings[0]).toMatch(/version/);
    expect(parseGroups({ version: 1, groups: {} }).warnings[0]).toMatch(/配列ではない/);
    const r = parseGroups({
      version: 1,
      groups: [{ name: 'ok', ids: ['a'] }, 'junk', { name: '', ids: [] }, { name: 'bad', ids: 'a' }, { name: 'ok', ids: ['b'] }, { name: 'n', ids: ['c'], note: 3 }],
    });
    expect(r.groups.map((g) => g.name)).toEqual(['ok', 'n']);
    expect(r.groups[0].ids).toEqual(['a']);
    expect(r.groups[1].note).toBe('');
    expect(r.warnings).toHaveLength(5);
    expect(r.warnings.find((w) => w.includes('重複'))).toMatch(/「ok」/);
    expect(r.warnings.find((w) => w.includes('note'))).toMatch(/\(n\)/);
  });

  it('id の先頭一致: 完全一致を優先し、1 つに決まれば採り、曖昧・未知はエラー', () => {
    const known = ['abc-1', 'abc-2', 'abd-1', 'abc'];
    expect(resolveIdPrefixes(known, ['abc'])).toEqual(['abc']);
    expect(resolveIdPrefixes(known, ['abd', 'abc-2', 'abd'])).toEqual(['abd-1', 'abc-2']);
    expect(() => resolveIdPrefixes(known, ['abc-'])).toThrow(/曖昧/);
    expect(() => resolveIdPrefixes(known, ['zzz'])).toThrow(/記録にありません/);
  });
});

describe('anonymize', () => {
  it('ホームディレクトリは ~ に短縮して表示する', () => {
    // Windows 形式(C:\Users\<name>)は実データの E2E(ATLAS_LIVE)で検証する。ここでは POSIX 形式で ~ 短縮を確かめる
    expect(shortProjectLabel('/home/me/.copilot/chats/c1')).toBe('~/.copilot/chats/c1');
    expect(shortProjectLabel('quokka/x')).toBe('quokka/x');
  });
});

describe('embed', () => {
  it('</script> や URL・fetch( を含む本文でも安全に埋め込み、往復できる', () => {
    const data = { t: '</script><!-- https://example.com fetch(x) \u2028 & >' };
    const tpl = '<script type="application/json" id="atlas-data">__ATLAS_DATA__</script>';
    const html = embedData(tpl, data);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('fetch(');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(extractEmbedded(html)).toEqual(data);
    expect(JSON.parse(serializeForScript(data))).toEqual(data);
    expect(() => embedData('<p></p>', data)).toThrow(/埋め込み位置/);
  });
});

describe('judgments', () => {
  it('必要な項目だけ拾い、形が違えばエラーにする', () => {
    const j = parseJudgments({
      schemaVersion: 1,
      judge: { backend: 'external', model: 'm', ranAt: '2026-10-28T00:00:00Z' },
      items: [{ sessionId: 'a', taskCategory: 'docs', taskSummary: 's', humanEffort: { hours: 1.5, low: 1, high: 2, confidence: 0.7 } }],
    });
    expect(j.backend).toBe('external');
    expect(j.bySession.get('a')).toEqual({
      taskCategory: 'docs',
      hours: 1.5,
      low: 1,
      high: 2,
      confidence: 0.7,
      taskSummary: 's',
      completed: null,
      quality: null,
      rework: null,
      effects: { instructions: null, wiki: null, skillsAgents: null },
      rationale: null,
      backend: 'external',
    });
    expect(() => parseJudgments({ schemaVersion: 1, items: [{ sessionId: 'x', humanEffort: {} }] })).toThrow(/hours/);
    expect(() => parseJudgments({ schemaVersion: 2, items: [] })).toThrow(/schemaVersion/);
    expect(() => parseJudgments({ schemaVersion: 1, items: [{}] })).toThrow(/sessionId/);
  });
});

describe('glossary', () => {
  it('全用語が 5 分類のどれかに入り、空の分類が無く、id が重複しない', () => {
    const groupIds = new Set(GLOSSARY_GROUPS.map((g) => g.id));
    for (const t of GLOSSARY) expect(groupIds.has(t.group), t.id).toBe(true);
    for (const g of GLOSSARY_GROUPS) expect(termsByGroup(g.id).length, g.id).toBeGreaterThan(0);
    expect(new Set(GLOSSARY.map((t) => t.id)).size).toBe(GLOSSARY.length);
    expect(GLOSSARY_GROUPS.reduce((n, g) => n + termsByGroup(g.id).length, 0)).toBe(GLOSSARY.length);
  });
});

describe('niceTicks', () => {
  it('きりのよい目盛りで最大値を覆う', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(95)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(1_234_567)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
  });
});

describe('modelLabel', () => {
  it('プレフィックス付きのモデル ID は最後の / 以降で表示する', () => {
    expect(modelLabel('11111111-2222-4333-8444-555555555555/claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(modelLabel('gpt-5.5')).toBe('gpt-5.5');
    expect(modelLabel('(unknown)')).toBe('不明');
    expect(modelLabel('odd/')).toBe('odd/');
  });
});

describe('一覧の題名の見分け(sharedLeads)', () => {
  it('20 字以上同じ書き出しは、直前の区切りから違いを見せる。まったく同じ題名は件数だけ', () => {
    const a = 'HARNESS.md の Phase 1 の節。実装役の報告: ビルド成功';
    const b = 'HARNESS.md の Phase 1 の節。実装役の報告は次のとおり';
    const r = sharedLeads([a, b, '短い依頼', 'OK と返して', 'OK と返して']);
    // 違いは「実装役の報告」の後から始まるが、直前の区切り(。)まで戻す
    expect([...a].slice(r[0].cut).join('')).toBe('実装役の報告: ビルド成功');
    expect([...b].slice(r[1].cut).join('')).toBe('実装役の報告は次のとおり');
    expect(r[2]).toEqual({ cut: 0, same: 1 });
    // 書き出しの一致が 20 字未満なら縮めない。まったく同じ題名は縮めず件数を返す
    expect(r[3]).toEqual({ cut: 0, same: 2 });
  });

  it('まったく同じ題名が複数あっても、別の題名との違いの位置で縮める', () => {
    const head = 'このフォルダは C++ のライブラリのソースです。';
    const r = sharedLeads([`${head}Reset を呼ぶ箇所`, `${head}Reset を呼ぶ箇所`, `${head}Read を呼ぶ箇所`]);
    expect([...`${head}Reset を呼ぶ箇所`].slice(r[0].cut).join('')).toBe('Reset を呼ぶ箇所');
    expect(r[0].same).toBe(2);
    expect(r[2]).toMatchObject({ same: 1 });
    expect(r[2].cut).toBe(r[0].cut);
  });

  it('違いの位置は英数の記号(:: や .)では切らず、和文の句読点か空白まで戻す。残す書き出しも区切りで切る', () => {
    const head = 'このフォルダは C++ のライブラリのソースです。';
    const a = `${head}\`lib::io::File::Read\` を呼ぶ箇所`;
    const b = `${head}\`lib::net::Socket::Open\` を呼ぶ箇所`;
    const [ra] = sharedLeads([a, b]);
    expect(splitLead(a, ra.cut, 70)).toEqual({ lead: 'このフォルダは…', rest: '`lib::io::File::Read` を呼ぶ箇所' });
  });

  it('空白の違いは同じとみなし、短い一致は縮めない', () => {
    const r = sharedLeads(['リポジトリの README を  更新して。章立ては変えない', 'リポジトリの README を 更新して。章立ては変える', 'リポジトリの別の話']);
    expect(r[0].cut).toBeGreaterThan(0);
    expect(r[2]).toEqual({ cut: 0, same: 1 });
  });
});

describe('memberGroups(送った人のタスクタグ)', () => {
  it('人ごとに分ける(同じ名前のタグでも別の人なら別のグループ)。名前は「人 / タグ」、人が無ければタグだけ。人・タグの順に並べる', () => {
    expect(
      memberGroups([
        { id: 's1', person: 'person-b', uploadTags: ['武器'] },
        { id: 's2', person: 'person-a', uploadTags: ['武器', 'UI'] },
        { id: 's3', person: 'person-a', uploadTags: ['武器'] },
        { id: 's4', person: null, uploadTags: ['共有'] },
        { id: 's5', person: 'person-a', uploadTags: [] },
        { id: 's6' },
      ]),
    ).toEqual([
      { name: '共有', note: '', ids: ['s4'] },
      { name: 'person-a / UI', note: '', ids: ['s2'] },
      { name: 'person-a / 武器', note: '', ids: ['s2', 's3'] },
      { name: 'person-b / 武器', note: '', ids: ['s1'] },
    ]);
    expect(memberGroups([])).toEqual([]);
  });

  it('人とタグの組で分ける。表示名が重なったら後のものに番号を付ける(名前はグループの鍵なので重ねない)', () => {
    const g = memberGroups([
      { id: 's1', person: 'a', uploadTags: ['b / c'] },
      { id: 's2', person: 'a / b', uploadTags: ['c'] },
      { id: 's3', person: 'a', uploadTags: ['b / c', 'b / c'] },
    ]);
    expect(g).toEqual([
      { name: 'a / b / c', note: '', ids: ['s1', 's3'] },
      { name: 'a / b / c (2)', note: '', ids: ['s2'] },
    ]);
    expect(new Set(g.map((x) => x.name)).size).toBe(g.length);
  });
});
