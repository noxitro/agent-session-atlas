// report の画面の lib(ブラウザで動く TS)のうち、セッションの記録を作らずに確かめられるもの。
// 記録(sessions.json の形)から集計・絞り込みを確かめるテストは、記録を作る normalize が Rust(crates/atlas-core)に移ったので、
// Rust の lib の移植(crates/atlas-report/tests/lib_reports.rs)と、TS の lib との突き合わせ(scripts/parity-lib.ts)が受け持つ。
import { describe, expect, it } from 'vitest';
import { effortSkew, isLowConfidence, monthRange } from '../src/lib/aggregate.ts';
import { embedData, extractEmbedded, serializeForScript } from '../src/lib/embed.ts';
import { decodeFilter, decodeTab, DEFAULT_TAB, emptyFilter, encodeFilter, encodeState, filterHref, groupIds, isEmptyFilter, isStateHash, isTabId, TABS } from '../src/lib/filter.ts';
import { excerptAround, looksLikeId, searchIndex, searchSessions, searchTerms } from '../src/lib/session-search.ts';
import { addIds, memberGroups, parseGroups, removeIds, resolveIdPrefixes, serializeGroups } from '../src/lib/groups.ts';
import { sessionLabel } from '../src/lib/highlights.ts';
import { parseJudgments } from '../src/lib/judgments.ts';
import { embeddedJudgment, judgmentForSession } from '../src/lib/summarize.ts';
import { WIKI_JUDGED_PAGES_MAX, wikiPageIndex } from '../src/lib/wiki.ts';
import { shortProjectLabel } from '../src/lib/project-label.ts';
import { niceTicks } from '../src/lib/scale.ts';
import { modelLabel, sharedLeads, splitLead } from '../src/lib/format.ts';
import { GLOSSARY, GLOSSARY_GROUPS, termsByGroup } from '../src/lib/glossary.ts';
import type { SessionSummary } from '../src/lib/types.ts';

describe('aggregate', () => {
  it('monthRange は年をまたいで欠けなく並べる', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('推定人手工数の合計が上位 5% のセッションに偏っている(半分以上)ときだけ偏りを知らせる', () => {
    // 偏りは判定済み 5 件以上で見る(少ないと 1 件が半分を超えるのは珍しくない)。上位は 5%(1 件に満たなければ 1 件)
    expect(effortSkew([100, 1, 1, 1])).toBeNull();
    expect(effortSkew([100, 1, 1, 1, 1])).toEqual({ sessions: 1, hours: 100, share: 100 / 104 });
    expect(effortSkew([2, 2, 2, 2, 2])).toBeNull();
    expect(effortSkew([5, 1, 1, 1, 1, 1])).toEqual({ sessions: 1, hours: 5, share: 0.5 });
    expect(effortSkew([4.9, 1, 1, 1, 1, 1])).toBeNull();
    expect(effortSkew([0, 0, 0, 0, 0])).toBeNull();
    // 60 件なら上位 3 件。大きい 2 件だけで合計のほとんどになる
    const many = [2500, 1200, ...Array.from({ length: 58 }, () => 2)];
    expect(effortSkew(many)).toMatchObject({ sessions: 3, hours: 3702 });
    expect(effortSkew(many)!.share).toBeCloseTo(3702 / 3816);
  });

  it('確信度の低い推定は 0.3 以下。確信度の記録が無い古い判定は、低いとはみなさない', () => {
    expect(isLowConfidence({ confidence: 0.3 })).toBe(true);
    expect(isLowConfidence({ confidence: 0.31 })).toBe(false);
    expect(isLowConfidence({ confidence: null })).toBe(false);
    expect(isLowConfidence(null)).toBe(false);
  });
});

describe('filter', () => {
  it('URL ハッシュと往復でき、不正な値は捨てる', () => {
    const f = { ...emptyFilter(), project: 'a/b c', coverage: 'none' as const, from: '2026-01-01' };
    expect(decodeFilter(`#${encodeFilter(f)}`)).toEqual(f);
    expect(isEmptyFilter(decodeFilter('#coverage=bogus&unknown=1&project=%E0%A4'))).toBe(true);
    expect(encodeFilter(emptyFilter())).toBe('');
  });

  it('タブの指定(tab=…)は絞り込みとは別の部分で、概況(既定)は書かない', () => {
    const f = { ...emptyFilter(), project: 'a/b', tool: 'grep' };
    // 絞り込みの後ろに付け、表示の指定(view)はその後ろ
    expect(encodeState(f, 'breakdown')).toBe('project=a%2Fb&tool=grep&tab=breakdown');
    expect(encodeState(f, 'overview')).toBe('project=a%2Fb&tool=grep');
    expect(encodeState(f)).toBe(encodeFilter(f));
    expect(encodeState(emptyFilter(), 'list')).toBe('tab=list');
    expect(encodeState(emptyFilter(), DEFAULT_TAB)).toBe('');
    expect(filterHref(f, 'sessions', 'list')).toBe('#project=a%2Fb&tool=grep&tab=list&view=sessions');
    expect(filterHref(emptyFilter(), null, 'overview')).toBe('#');
    // 第 3 引数を渡さなければ、これまでと同じ(Rust の filter_href と同じ形)
    expect(filterHref(f, 'unused-skills')).toBe('#project=a%2Fb&tool=grep&view=unused-skills');
    // 読み戻し: 知らない値・無いときは null(呼び元が概況にする)
    expect(decodeTab('#project=x&tab=breakdown')).toBe('breakdown');
    expect(decodeTab('tab=list&view=sessions')).toBe('list');
    expect(decodeTab('#tab=bogus')).toBeNull();
    expect(decodeTab('#tab=%E0%A4')).toBeNull();
    expect(decodeTab('#project=x')).toBeNull();
    expect(decodeTab('#phases')).toBeNull();
    expect(TABS.every((t) => decodeTab(`#${encodeState(emptyFilter(), t)}`) === (t === DEFAULT_TAB ? null : t))).toBe(true);
    // 絞り込みには入らない(条件の数・「解除」の対象にならない)
    const withTab = decodeFilter('#project=a%2Fb&tab=breakdown&view=sessions');
    expect(withTab).toEqual({ ...emptyFilter(), project: 'a/b' });
    expect(Object.keys(withTab)).not.toContain('tab');
    expect(isEmptyFilter(decodeFilter('#tab=list'))).toBe(true);
    // タブだけのハッシュも状態のハッシュ(ページ内リンクの #phases とは区別する)
    expect(isStateHash('#tab=list')).toBe(true);
    expect(isStateHash('#phases')).toBe(false);
    expect(isTabId('breakdown')).toBe(true);
    expect(isTabId('tab')).toBe(false);
    expect(isTabId(undefined)).toBe(false);
  });
});

describe('session-search(セッション一覧の検索)', () => {
  const s = (id: string, name: string | null, firstUserMessage: string | null) => ({ id, name, firstUserMessage });
  const list = [
    s('3f2a9c10-aaaa-4bbb-8ccc-000000000001', 'ログイン画面の修正', null),
    s('3f2b0000-aaaa-4bbb-8ccc-000000000002', null, 'README を Ｅｎｇｌｉｓｈ に訳す'),
    s('add00000-aaaa-4bbb-8ccc-000000000003', null, null),
    s('99990000-aaaa-4bbb-8ccc-000000000004', '11 月の調査', '数字を含む題名'),
    s('cafe0000-aaaa-4bbb-8ccc-000000000005', null, null),
    s('12340000-aaaa-4bbb-8ccc-000000000006', 'cafe の検索', '1234 件の記録を調べる'),
  ];
  const ids = (q: string): string[] | null => searchSessions(list, q)?.rows.map((x) => x.id.slice(0, 4)) ?? null;

  it('空の検索語は絞らない(null)', () => {
    expect(searchSessions(list, '')).toBeNull();
    expect(searchSessions(list, '  　 ')).toBeNull();
    expect(searchTerms(' a  A ｂ ')).toEqual(['a', 'b']);
  });
  it('ID は先頭 4 文字以上で当たり、当たった行を byId に入れる。大文字・全角でもよい', () => {
    expect(ids('3f2a')).toEqual(['3f2a']);
    expect(ids('3F2')).toEqual([]); // 3 文字は ID の先頭として比べない
    expect(ids('３Ｆ２Ｂ')).toEqual(['3f2b']);
    expect([...(searchSessions(list, '3f2a9c10')?.byId ?? [])]).toEqual(['3f2a9c10-aaaa-4bbb-8ccc-000000000001']);
  });
  it('ID の途中の文字だけでは当たらない(16 進の語や数字で、題名に無い行が偶然出ないように)', () => {
    expect(ids('add')).toEqual([]);
    expect(ids('aaaa')).toEqual([]);
    expect(ids('11')).toEqual(['9999']); // 題名の「11 月」だけに当たる
  });
  it('貼ったパスや URL の中に ID が丸ごと入っていれば当たる。パスに空白があっても、引用符で囲まれていても', () => {
    expect(ids('out\\sessions\\add00000-aaaa-4bbb-8ccc-000000000003.md')).toEqual(['add0']);
    expect(ids('D:\\共有 フォルダ\\copilot logs\\add00000-aaaa-4bbb-8ccc-000000000003\\events.jsonl')).toEqual(['add0']);
    expect(ids('"D:\\OneDrive - 会社名\\atlas\\out\\sessions\\3F2A9C10-AAAA-4BBB-8CCC-000000000001.html"')).toEqual(['3f2a']);
    expect(searchSessions(list, 'file:///d:/x%20y/add00000-aaaa-4bbb-8ccc-000000000003.html')?.byId.has(list[2].id)).toBe(true);
  });
  it('題名は名前と最初の依頼の両方を見る。全角半角・大文字小文字をそろえ、空白で区切った語はすべて含む行だけ', () => {
    expect(ids('ログイン')).toEqual(['3f2a']);
    expect(ids('english')).toEqual(['3f2b']);
    expect(ids('readme 訳す')).toEqual(['3f2b']);
    expect(ids('readme 修正')).toEqual([]);
    expect(searchSessions(list, 'ログイン')?.byId.size).toBe(0);
    // ID の語と題名の語を混ぜてもよい(どちらかに当たれば、その語は合う)
    expect(ids('9999 調査')).toEqual(['9999']);
  });
  it('題名にある語は、ID の先頭にもたまたま当たっても ID で当たった行にしない(題名を先に見る)', () => {
    const r = searchSessions(list, 'cafe');
    expect(r?.rows.map((x) => x.id.slice(0, 4))).toEqual(['cafe', '1234']);
    expect([...(r?.byId ?? [])]).toEqual([list[4].id]); // 題名に無い行だけ ID で当たった
    // 最初の依頼にある語も同じ(ID の行ではなく、その辺りの文を出す)
    const n = searchSessions(list, '1234');
    expect(n?.byId.size).toBe(0);
    expect([...(n?.viaFirst ?? [])]).toEqual([[list[5].id, '1234']]);
  });
  it('searchIndex で下ごしらえしたものを渡しても同じ結果', () => {
    const index = searchIndex(list);
    for (const q of ['3f2a', 'english', 'readme 訳す', 'cafe', '9999 調査', 'add00000-aaaa-4bbb-8ccc-000000000003', '']) {
      expect(searchSessions(index, q)).toEqual(searchSessions(list, q));
    }
  });
  it('名前に無く最初の依頼にだけあった語は viaFirst に残す(行にその辺りの文を出す)。名前の無い行は最初の依頼が題名なので残さない', () => {
    expect([...(searchSessions(list, '数字')?.viaFirst ?? [])]).toEqual([[list[3].id, '数字']]);
    expect(searchSessions(list, '調査')?.viaFirst.size).toBe(0);
    expect(searchSessions(list, 'english')?.viaFirst.size).toBe(0);
  });
  it('excerptAround は語の辺りを切り出し、切ったところに「…」を付ける。looksLikeId は ID の一部らしい 16 進の語', () => {
    const long = `${'あ'.repeat(40)}目当ての語${'い'.repeat(40)}`;
    const e = excerptAround(long, '目当て', 30);
    expect(e.startsWith('…') && e.endsWith('…') && e.includes('目当ての語')).toBe(true);
    expect([...e.replace(/…/g, '')].length).toBe(30);
    expect(excerptAround('短い  ＡＢＣ 文', 'abc')).toBe('短い ABC 文');
    expect(excerptAround('見つからない', 'zzz')).toBe('見つからない');
    expect([looksLikeId('3f2a'), looksLikeId('3f2a-9c'), looksLikeId('readme'), looksLikeId('調査')]).toEqual([true, true, false, false]);
    // a〜f だけの英単語は、ID を探したつもりとは限らないので添えない(8 文字以上なら ID らしい)。数字を含めば ID の一部らしい
    expect(['add', 'face', 'cafe', 'deadbeef', '000', '3f2', '11'].map(looksLikeId)).toEqual([false, false, false, true, true, true, true]);
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

describe('shortProjectLabel', () => {
  it('ホームディレクトリは ~ に短縮して表示する', () => {
    expect(shortProjectLabel('/home/me/.copilot/chats/c1')).toBe('~/.copilot/chats/c1');
    expect(shortProjectLabel('quokka/x')).toBe('quokka/x');
    // Windows 形式。区切りは文字コードから作り、ホームの親フォルダの名前は分けて組み立てる
    // (Rust の project_label.rs のテストと同じ入力と期待値)
    const sep = String.fromCharCode(92);
    const win = ['C:', 'Users', 'someone', 'proj'].join(sep);
    expect(shortProjectLabel(win)).toBe(`~${sep}proj`);
    expect(shortProjectLabel(win.replace('Users', 'USERS'))).toBe(`~${sep}proj`);
    // ホームの外のドライブ付きのパスはそのまま
    const other = ['D:', 'work', 'proj'].join(sep);
    expect(shortProjectLabel(other)).toBe(other);
  });
});

describe('sessionLabel(要点欄での呼び名)', () => {
  it('セッション名、無ければ最初の依頼。どちらも無ければ「プロジェクト・日付(id の先頭 8 文字)」', () => {
    // 時刻は時差の指定なし(その PC の時刻)にして、どの時間帯で走らせても同じ日付になるようにする
    const bare = { id: '0123456789abcdef', name: null, firstUserMessage: null, projectLabel: 'quokka/c', createdAt: '2026-10-03T12:00:00' } as unknown as SessionSummary;
    expect(sessionLabel(bare)).toBe('quokka/c・2026-10-03(01234567)');
    expect(sessionLabel({ ...bare, firstUserMessage: 'b' })).toBe('b');
    expect(sessionLabel({ ...bare, name: 'session A', firstUserMessage: 'a' })).toBe('session A');
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
  it('項目ごとの判定の日時とモデルは項目の judge から読む。judge の無い古い項目は、モデルだけファイル全体のもの(crates/atlas-report/src/judgments.rs と同じ)', () => {
    const j = parseJudgments({
      schemaVersion: 1,
      judge: { backend: 'copilot-cli', model: 'file-model', ranAt: '2026-11-15T00:00:00Z' },
      items: [
        { sessionId: 'a', humanEffort: { hours: 1 }, judge: { backend: 'external', model: 'm365', ranAt: '2026-11-14T01:02:03Z' } },
        { sessionId: 'b', humanEffort: { hours: 1 }, judge: { backend: 'copilot-cli', model: null, ranAt: '2026-11-13T00:00:00Z' } },
        { sessionId: 'c', humanEffort: { hours: 1 } },
      ],
    });
    const mr = (id: string) => [j.bySession.get(id)?.model ?? null, j.bySession.get(id)?.ranAt ?? null];
    expect(mr('a')).toEqual(['m365', '2026-11-14T01:02:03Z']);
    expect(mr('b')).toEqual([null, '2026-11-13T00:00:00Z']);
    expect(mr('c')).toEqual(['file-model', null]);
  });
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
      // 項目に judge が無いので、モデルはファイル全体のもの(日時は付けない)
      model: 'm',
    });
    expect(() => parseJudgments({ schemaVersion: 1, items: [{ sessionId: 'x', humanEffort: {} }] })).toThrow(/hours/);
    expect(() => parseJudgments({ schemaVersion: 3, items: [] })).toThrow(/schemaVersion/);
    expect(() => parseJudgments({ schemaVersion: 1, items: [{}] })).toThrow(/sessionId/);
  });

  it('版 2 の llm-wiki のページごとの判定を読む。壊れていても項目は捨てず、ページを未判定にする', () => {
    const parse = (wikiPages: unknown) => parseJudgments({ schemaVersion: 2, items: [{ sessionId: 'a', humanEffort: { hours: 1 }, wikiPages }] }).bySession.get('a')!;
    const j = parse([
      { page: ' wiki/a.md ', helpful: 'yes', reason: '使った' },
      { page: 'wiki/b.md', helpful: 'maybe' },
      { page: 'wiki/c.md', helpful: 'no' },
      { page: 'wiki/a.md', helpful: 'no' },
      'wiki/d.md',
    ]);
    expect(j.wikiPageVerdicts).toEqual([
      ['wiki/a.md', 'yes', '使った'],
      ['wiki/c.md', 'no', ''],
    ]);
    // 配列でない・無い(版 1 の判定を含む): ページは未判定。ほかの判定は読む
    expect(parse({ page: 'x' }).wikiPageVerdicts).toBeUndefined();
    expect(parse('壊れた').hours).toBe(1);
    expect('wikiPageVerdicts' in parseJudgments({ schemaVersion: 1, items: [{ sessionId: 'a', humanEffort: { hours: 1 } }] }).bySession.get('a')!).toBe(false);
    // パケットに載せたページ(読んだ順の先頭から上限まで)に無い名前は捨てる。判定の無いものはそのまま
    const reads = ['wiki/a.md', 'wiki/a.md', ...Array.from({ length: WIKI_JUDGED_PAGES_MAX }, (_, i) => `wiki/x${i}.md`), 'wiki/c.md'];
    expect(judgmentForSession(j, reads).wikiPageVerdicts).toEqual([['wiki/a.md', 'yes', '使った']]);
    expect(judgmentForSession(parse(undefined), reads).wikiPageVerdicts).toBeUndefined();
  });

  it('埋め込む判定: 見立てはページの辞書の番号にし、見立ての理由と根拠は落とす。パケットに無いページは捨てる', () => {
    const ix = wikiPageIndex([{ wiki: { pageReads: ['wiki/b.md', 'wiki/b.md'] } }, { wiki: { pageReads: ['wiki/a.md', 'wiki/b.md'] } }]);
    expect(ix.names).toEqual(['wiki/b.md', 'wiki/a.md']);
    const j = parseJudgments({
      schemaVersion: 2,
      items: [{ sessionId: 's2', humanEffort: { hours: 1, rationale: '根拠' }, wikiPages: [{ page: 'wiki/a.md', helpful: 'no', reason: '使っていない' }, { page: 'wiki/z.md', helpful: 'yes' }] }],
    }).bySession.get('s2')!;
    const e = embeddedJudgment(j, ['wiki/a.md', 'wiki/b.md'], ix);
    expect(e.wikiPages).toEqual([[1, 'no']]);
    expect('wikiPageVerdicts' in e).toBe(false);
    expect(e.rationale).toBeNull();
    // 判定の無い(版 1 の)ものは wikiPages を持たない
    expect('wikiPages' in embeddedJudgment(parseJudgments({ schemaVersion: 1, items: [{ sessionId: 'x', humanEffort: { hours: 1 } }] }).bySession.get('x')!, [], ix)).toBe(false);
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
