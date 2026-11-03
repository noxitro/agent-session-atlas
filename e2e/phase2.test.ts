// Phase 2 E2E(docs/PLAN.md「Phase 2: cli + report」)
//  a. fixtures から `atlas all` で out/atlas.html を作り、5MB 未満で外部参照(http:// https:// fetch()が無い
//  g. `atlas export` で各セッションの記録(Markdown)ができ、詳細ページからリンクされる。素の build では作らない
//  h. 用語の説明は out/glossary.html の 1 枚だけで、atlas.html と詳細ページには本文を載せずリンクする
//  b. 埋め込み JSON のセッション数が fixtures の件数(DB ∪ ディレクトリ)と一致し、詳細ページが揃う
//  c. --anonymize で fixture の cwd / git_root / repository / branch の文字列が HTML に出ない
//  d. ATLAS_LIVE=1 のとき実データで HTML を作り、サイズとプロジェクト数をログに出して 5MB 未満
//  i. Phase 10: groups.json(--notes-dir)の --group / --session で件数が変わり、埋め込みデータにグループが入り、--anonymize で仮名になる。
//     壊れたファイルは警告して無視する。atlas group add / list / remove でファイルを作って直せる
//  j. Phase 10 第 2 段: atlas serve が out/ を配信し、API でグループを作成・改名・削除すると groups.json が書かれる。
//     build 時の HTML は token のプレースホルダのままで、改定後の外部参照の検査(相対パス api/ への fetch だけ許す)を通る
// ブラウザでのフィルタ操作はオーケストレータが組み込みブラウザで確認する(ここでは静的検証のみ。
// フィルタのロジックは packages/report/test の単体テストで検証している)。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { SessionsFile } from '../packages/core/src/index.ts';
import { buildReport, extractEmbedded, type ReportData } from '../packages/report/src/index.ts';
import { GLOSSARY, GLOSSARY_GROUPS } from '../packages/report/src/lib/glossary.ts';
import { computeMetrics, GROUPED_PROJECTS } from '../packages/core/src/index.ts';
import { buildFixtureHome, FIXTURES, readFixtureStore, ROOT } from './fixture-home.ts';

const LIVE = process.env.ATLAS_LIVE === '1';
const WORK = join(ROOT, 'out', 'e2e-phase2');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'main.ts');
const LIMIT = 5 * 1024 * 1024;

function atlas(args: string[]): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 600_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - t };
}

/**
 * 外部参照の静的検査。Phase 10 第 2 段から、同一オリジンの相対パス api/…(詳細ページは ../api/…)への fetch だけは許す
 * (atlas serve の API。file:// では token が無いので呼ばれない)。http(s) への参照は従来どおり禁止
 */
function externalRefs(html: string): string[] {
  const found: string[] = [];
  for (const needle of ['http://', 'https://']) if (html.includes(needle)) found.push(needle);
  for (const m of html.matchAll(/fetch\(/g)) if (!/^fetch\(\s*["'`](?:\.\.\/)?api\//.test(html.slice(m.index, m.index + 40))) found.push(`fetch( at ${m.index}`);
  // 念のため構造的にも: 外部の src / href / @import / url() が無い
  if (/<link\b/i.test(html)) found.push('<link>');
  if (/\bsrc=["'](?!data:)[^"']+["']/i.test(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, ''))) found.push('src=');
  // `new URL(` は JS の URL の組み立て(Svelte の実行時が src の比較に使う)で、読み込みではないので除く
  if (/@import|(?<!new )url\((?!["']?data:)/i.test(html)) found.push('@import/url()');
  return found;
}

async function readAllHtml(out: string): Promise<{ path: string; html: string }[]> {
  const files = [join(out, 'atlas.html'), ...(await readdir(join(out, 'sessions'))).map((f) => join(out, 'sessions', f))];
  return Promise.all(files.map(async (path) => ({ path, html: await readFile(path, 'utf8') })));
}

/** fixture の workspace.yaml と session-store から、伏せるべき固有の文字列を集める */
async function fixtureSecrets(): Promise<string[]> {
  const out = new Set<string>();
  const state = join(FIXTURES, 'copilot-home', 'session-state');
  for (const d of readdirSync(state)) {
    const p = join(state, d, 'workspace.yaml');
    if (!existsSync(p)) continue;
    const w = parseYaml(await readFile(p, 'utf8')) as Record<string, unknown>;
    for (const k of ['cwd', 'git_root', 'repository', 'branch']) if (typeof w[k] === 'string') out.add(w[k] as string);
  }
  const store = await readFixtureStore();
  for (const r of store.sessions) for (const k of ['cwd', 'repository', 'branch']) if (typeof r[k] === 'string') out.add(r[k] as string);
  return [...out];
}

/** HTML の中での現れ方(生の文字列、JSON 埋め込み、HTML エスケープ)をすべて調べる */
function appearances(html: string, s: string): boolean {
  const forms = new Set([s, JSON.stringify(s).slice(1, -1), JSON.stringify(s).slice(1, -1).replace(/\//g, '\\/'), s.replace(/'/g, '&#39;')]);
  return [...forms].some((f) => html.includes(f));
}

describe('Phase 2 E2E: fixtures', () => {
  let close: () => Promise<void>;
  let home: string;
  let all: ReturnType<typeof atlas>;
  let data: ReportData;
  let html: string;
  const out = join(WORK, 'out');
  const outAnon = join(WORK, 'out-anon');

  beforeAll(async () => {
    ({ home, close } = await buildFixtureHome(join(WORK, 'home')));
    all = atlas(['all', '--home', home, '--out', out]);
    if (all.status !== 0) throw new Error(`atlas all が失敗: ${all.stderr}\n${all.stdout}`);
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    data = extractEmbedded<ReportData>(html);
  });
  afterAll(async () => close?.());

  it('--config: 別の名前・形式の vault として数え直せる。空なら数えず、壊れた設定は失敗する', async () => {
    const outCfg = join(WORK, 'out-config');
    await mkdir(outCfg, { recursive: true });
    const config = join(outCfg, 'atlas.config.json');
    const wikiOf = async (): Promise<unknown> => {
      const r = atlas(['all', '--home', home, '--out', outCfg, '--config', config]);
      expect(r.status, r.stderr).toBe(0);
      const s = JSON.parse(await readFile(join(outCfg, 'sessions.json'), 'utf8')) as { sessions: { id: string; wiki: unknown }[] };
      return s.sessions.find((x) => x.id.endsWith('004'))!.wiki;
    };
    await writeFile(config, JSON.stringify({ wikis: [{ path: 'synthetic-home/synthetic-wiki', index: ['log.md'], pages: ['wiki/topics'], skills: [] }] }));
    expect(await wikiOf()).toEqual({ indexReads: 1, pageReads: ['wiki/topics/synthetic-page-a.md', 'wiki/topics/synthetic-page-b.md'], skillCalls: [], writes: 0, otherCalls: 1 });
    await writeFile(config, JSON.stringify({ wikis: [] }));
    expect(await wikiOf()).toEqual({ indexReads: 0, pageReads: [], skillCalls: [], writes: 0, otherCalls: 0 });
    await writeFile(config, JSON.stringify({ wikis: [{ path: 'x', typo: 1 }] }));
    const bad = atlas(['all', '--home', home, '--out', outCfg, '--config', config]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('不明な項目です: typo');
  });

  it('g. atlas export: セッション記録(Markdown)が各セッションにでき、詳細ページからリンクされる。素の build では作らず、リンクも消える', async () => {
    // all(atlas.bat)も記録を作る。どの bat で作ったかで経過が見えたり消えたりしないように
    expect(all.stdout).toMatch(/export: セッション記録 \d+ 件/);
    expect((await readdir(join(out, 'sessions'))).filter((f) => f.endsWith('.md')).length).toBe(data.sessions.length);
    expect(await readFile(join(out, 'sessions', `${data.sessions[0].id}.html`), 'utf8')).toContain(`href="${data.sessions[0].id}.md"`);
    const outExp = join(WORK, 'out-export');
    // export は build を含む(snapshot と sessions.json は out/ のものを使うため、--out は同じにして export → build の順で確かめる)
    const r = atlas(['export', '--home', home, '--out', out, '--tool-output', 'none']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/export: セッション記録 \d+ 件/);
    const mds = (await readdir(join(out, 'sessions'))).filter((f) => f.endsWith('.md'));
    expect(mds.length).toBe(data.sessions.length);
    for (const s of data.sessions) {
      const md = await readFile(join(out, 'sessions', `${s.id}.md`), 'utf8');
      expect(md).toContain('# セッション記録');
      expect(md).toContain('## 経過');
      expect(md).toContain('## 分析の観点');
      const page = await readFile(join(out, 'sessions', `${s.id}.html`), 'utf8');
      expect(page).toContain(`href="${s.id}.md"`);
    }
    // 003: 本体とサブエージェント(explore)の役 × モデルの表、ツール行、依頼ごとの消費
    const md3 = await readFile(join(out, 'sessions', '00000000-0000-4000-8000-000000000003.md'), 'utf8');
    expect(md3).toMatch(/\| 本体 \| gpt-5\.5 \| 2 \|/);
    expect(md3).toMatch(/\| explore \| gpt-5\.6-terra \| 2 \|/);
    expect(md3).toContain('[agent:explore] ✔ `powershell`');
    expect(md3).toMatch(/_依頼 1 の本体の消費: リクエスト 2、/);
    // --tool-output none なので結果の囲みは無い
    expect(md3).not.toMatch(/\n```\n/);
    // 伏せ字版: 固有の文字列が出ない
    const ra = atlas(['export', '--home', home, '--out', outExp, '--anonymize']);
    // outExp には sessions.json が無いので失敗する(export は build と同じ前提)
    expect(ra.status).not.toBe(0);
    const ra2 = atlas(['export', '--home', home, '--out', out, '--anonymize']);
    expect(ra2.status, ra2.stderr).toBe(0);
    const secrets = await fixtureSecrets();
    for (const f of mds) {
      const md = await readFile(join(out, 'sessions', f), 'utf8');
      for (const sec of secrets) if (sec.length >= 3) expect({ f, sec, leaked: md.includes(sec) }).toEqual({ f, sec, leaked: false });
      expect(md).toContain('伏せ字モード');
    }
    // 素の build に戻すと .md は消え、リンクも無い
    const rb = atlas(['build', '--home', home, '--out', out]);
    expect(rb.status, rb.stderr).toBe(0);
    expect((await readdir(join(out, 'sessions'))).some((f) => f.endsWith('.md'))).toBe(false);
    const page = await readFile(join(out, 'sessions', `${data.sessions[0].id}.html`), 'utf8');
    expect(page).not.toContain('セッション記録(Markdown)');
  });

  it('h. 用語の説明は glossary.html の 1 枚だけ。atlas.html と詳細ページは本文を持たずリンクする', async () => {
    const g = await readFile(join(out, 'glossary.html'), 'utf8');
    expect(externalRefs(g)).toEqual([]);
    expect(g.match(/<dt id="/g)?.length).toBe(GLOSSARY.length);
    for (const t of GLOSSARY) expect(g).toContain(`id="${t.id}"`);
    // 分類ごとの見出し(h2、id は g-<分類>)があり、目次は分類だけを載せる(用語 1 つずつは載せない)
    for (const grp of GLOSSARY_GROUPS) expect(g).toContain(`<section class="section group" id="g-${grp.id}"`);
    const toc = g.match(/<nav class="toc"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect(toc.match(/<a href="#g-/g)?.length).toBe(GLOSSARY_GROUPS.length);
    expect(toc).not.toContain(`href="#${GLOSSARY[0].id}"`);
    // 本文の一文はトップページと詳細ページに無い(埋め込み JSON を除いた HTML 本文で見る)
    const sample = GLOSSARY[0].body.slice(0, 40);
    expect(html.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, '')).not.toContain(sample);
    // 目次(サイドバー / 上部の固定行)は Svelte がデータから描くので、リンク先の文字列が埋め込みスクリプトに入っていることを見る
    // 引用符は minifier 次第(Vite 8 はテンプレートリテラルで出す)なので 3 種とも受ける
    expect(html).toMatch(/href:\s*["'`]glossary\.html["'`]/);
    const page = await readFile(join(out, 'sessions', `${data.sessions[0].id}.html`), 'utf8');
    expect(page).not.toContain(sample);
    expect(page).toContain('href="../glossary.html"');
  });

  it('a. atlas.html は 5MB 未満で、外部参照(http:// https:// fetch( / link / src / url())を含まない', async () => {
    console.log(`[fixtures] atlas all ${all.ms.toFixed(0)}ms, atlas.html ${html.length} bytes\n${all.stdout}`);
    expect(Buffer.byteLength(html)).toBeLessThan(LIMIT);
    expect(externalRefs(html)).toEqual([]);
    // 詳細ページも外部参照なし
    for (const f of await readAllHtml(out)) expect({ path: f.path, refs: externalRefs(f.html) }).toEqual({ path: f.path, refs: [] });
  });

  it('b. 埋め込み JSON のセッション数が fixtures の件数(DB ∪ ディレクトリ)と一致し、詳細ページが揃う', async () => {
    const store = await readFixtureStore();
    const ids = new Set([...store.sessions.map((r) => r.id as string), ...readdirSync(join(home, 'session-state'))]);
    expect(data.sessions.length).toBe(ids.size);
    expect(new Set(data.sessions.map((s) => s.id))).toEqual(ids);
    // Phase 5: metrics は空のセッション(006 / 007 / 010)を除いた集計
    const empties = data.sessions.filter((s) => s.empty).length;
    expect(empties).toBe(3);
    expect(data.metrics.emptySessions).toBe(empties);
    expect(data.metrics.overall.sessions).toBe(ids.size - empties);
    expect(data.totalSessionsInSource).toBe(ids.size);
    expect(data.anonymized).toBe(false);
    expect(data.judgments.available).toBe(false);
    // 要約だけ: 生イベント・timeline は埋め込まない。1 セッションあたり数 KB 以内
    for (const s of data.sessions) {
      expect(s).not.toHaveProperty('timeline');
      expect(s).not.toHaveProperty('events');
      expect(JSON.stringify(s).length).toBeLessThan(8 * 1024);
    }
    // 詳細ページ: 一覧からの相対リンク先が存在する
    for (const s of data.sessions) expect(existsSync(join(out, s.href))).toBe(true);
    expect((await readdir(join(out, 'sessions'))).filter((f) => f.endsWith('.html')).length).toBe(ids.size);
    // 入力トークン記録の有無が欠測込みで入っている
    expect(data.sessions.filter((s) => s.coverage === 'input').length).toBe(data.metrics.overall.sessionsWithInputTokens);
  });

  it('c. --anonymize で fixture の cwd / git_root / repository / branch の文字列が HTML に出ない', async () => {
    // 同じ out/ に通常版の記録がある状態から作り直す(伏せ字版で生の記録が残らないこと)
    expect(atlas(['all', '--home', home, '--out', outAnon]).status).toBe(0);
    expect((await readdir(join(outAnon, 'sessions'))).some((f) => f.endsWith('.md'))).toBe(true);
    const r = atlas(['all', '--home', home, '--out', outAnon, '--anonymize']);
    expect(r.status, r.stderr).toBe(0);
    // 伏せ字版の all は記録(自由記述を機械的に伏せるだけで HTML より弱い)を作らない
    expect(r.stdout).toContain('伏せ字版なのでセッション記録(.md)は作りません');
    expect((await readdir(join(outAnon, 'sessions'))).some((f) => f.endsWith('.md'))).toBe(false);
    const secrets = await fixtureSecrets();
    expect(secrets.length).toBeGreaterThan(5);
    // 伏せ字なしの HTML には実際に出ている(検査が空振りしていないことの確認)
    const plainFiles = await readAllHtml(out);
    expect(secrets.filter((s) => plainFiles.some((f) => appearances(f.html, s))).length).toBeGreaterThan(0);

    const files = await readAllHtml(outAnon);
    for (const f of files) {
      const leaked = secrets.filter((s) => appearances(f.html, s));
      expect({ path: f.path, leaked }).toEqual({ path: f.path, leaked: [] });
    }
    const anon = extractEmbedded<ReportData>(files[0].html);
    expect(anon.anonymized).toBe(true);
    expect(anon.sessions.length).toBe(data.sessions.length);
    // Phase 6: まとめたプロジェクト((一時フォルダ)・(atlas の判定) など)は固有名を含まないのでそのまま出る
    const anonKey = (k: string): boolean => /^project-\d+$/.test(k) || GROUPED_PROJECTS.has(k);
    expect(anon.sessions.every((s) => anonKey(s.project) && s.name === null && s.firstUserMessage === null)).toBe(true);
    expect(Object.keys(anon.metrics.byProject).every(anonKey)).toBe(true);
    expect(externalRefs(files[0].html)).toEqual([]);
  });

  it('CLI フィルタ(--client)で埋め込まれるセッションが絞られる', async () => {
    const r = atlas(['build', '--out', out, '--client', 'github/cli']);
    expect(r.status, r.stderr).toBe(0);
    const d = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    const expected = data.sessions.filter((s) => s.client === 'github/cli').length;
    expect(expected).toBeGreaterThan(0);
    expect(d.sessions.length).toBe(expected);
    // Phase 5: metrics は空を除く
    expect(d.metrics.overall.sessions).toBe(data.sessions.filter((s) => s.client === 'github/cli' && !s.empty).length);
    expect(d.scope.client).toBe('github/cli');
    expect((await readdir(join(out, 'sessions'))).length).toBe(expected);
  });

  it('i. Phase 10: groups.json の --group / --session で絞れ、埋め込みデータにグループが入り、伏せ字では仮名になる。壊れたファイルは警告して無視する', async () => {
    const notes = join(WORK, 'notes');
    const notes2 = join(WORK, 'notes2');
    await rm(notes, { recursive: true, force: true });
    await rm(notes2, { recursive: true, force: true });
    await mkdir(notes, { recursive: true });
    const ids = data.sessions.filter((s) => !s.empty).map((s) => s.id).sort();
    const g1 = ids.slice(0, 3);
    const ghost = '99999999-0000-4000-8000-000000000000';
    const groupsJson = { version: 1, groups: [{ name: '甲の調べ', note: '甲の覚え書き', ids: [...g1, ghost] }, { name: '乙の一件', ids: [ids[3]] }] };
    await writeFile(join(notes, 'groups.json'), JSON.stringify(groupsJson));
    const read = async (dir = out): Promise<ReportData> => extractEmbedded<ReportData>(await readFile(join(dir, 'atlas.html'), 'utf8'));

    // --group: 名前で絞れ、記録に無い id は件数だけ知らせる。埋め込みデータにはグループ全部(記録に無い id も)が入る
    const r = atlas(['build', '--out', out, '--notes-dir', notes, '--group', '甲の調べ']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/build: 絞り込み group=甲の調べ\(3 \/ 4 件が記録にある\) → 3 \/ \d+ セッション/);
    let d = await read();
    expect(d.sessions.map((s) => s.id).sort()).toEqual(g1);
    expect((await readdir(join(out, 'sessions'))).length).toBe(3);
    expect(d.groups).toEqual([{ name: '甲の調べ', note: '甲の覚え書き', ids: [...g1, ghost] }, { name: '乙の一件', note: '', ids: [ids[3]] }]);
    expect(d.warnings.notes).toEqual([]);
    expect(d.version).toBe(8);
    // 他の条件と AND
    const client = data.sessions.find((s) => g1.includes(s.id))!.client!;
    const r1 = atlas(['build', '--out', out, '--notes-dir', notes, '--group', '甲の調べ', '--client', client]);
    expect(r1.status, r1.stderr).toBe(0);
    expect((await read()).sessions.every((s) => g1.includes(s.id) && s.client === client)).toBe(true);
    // 無い名前はエラー(黙って 0 件にしない)
    const nope = atlas(['build', '--out', out, '--notes-dir', notes, '--group', 'nope']);
    expect(nope.status).toBe(1);
    expect(nope.stderr).toMatch(/「nope」.*あるのは: 甲の調べ, 乙の一件/);

    // --session: 完全一致と先頭一致。曖昧ならエラー。bundle にも効く
    const r2 = atlas(['build', '--out', out, '--notes-dir', notes, '--session', `${ids[0]},${ids[1]}`]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(r2.stdout).toMatch(/session=2 件/);
    expect((await read()).sessions.map((s) => s.id).sort()).toEqual([ids[0], ids[1]]);
    const id99 = data.sessions.find((s) => s.id.endsWith('099'))!.id;
    const r3 = atlas(['build', '--out', out, '--session', id99.slice(0, -1)]);
    expect(r3.status, r3.stderr).toBe(0);
    expect((await read()).sessions.map((s) => s.id)).toEqual([id99]);
    const amb = atlas(['build', '--out', out, '--session', ids[0].slice(0, -1)]);
    expect(amb.status).toBe(1);
    expect(amb.stderr).toMatch(/曖昧/);
    const rb = atlas(['bundle', '--out', out, '--notes-dir', notes, '--group', '乙の一件', '--include-empty']);
    expect(rb.status, rb.stderr).toBe(0);
    expect(rb.stdout).toMatch(/bundle: 絞り込み group=乙の一件\(1 \/ 1 件が記録にある\) → 1 \/ \d+ セッション/);
    expect(rb.stdout).toMatch(/パケット 1 件/);

    // --anonymize: グループ名と note は出さず「グループ 1, 2」、ids はそのまま
    const ra = atlas(['build', '--out', outAnon, '--notes-dir', notes, '--anonymize']);
    expect(ra.status, ra.stderr).toBe(0);
    const anonHtml = await readFile(join(outAnon, 'atlas.html'), 'utf8');
    const da = extractEmbedded<ReportData>(anonHtml);
    expect(da.groups).toEqual([{ name: 'グループ 1', note: '', ids: [...g1, ghost] }, { name: 'グループ 2', note: '', ids: [ids[3]] }]);
    expect(anonHtml).not.toContain('甲の調べ');
    expect(anonHtml).not.toContain('甲の覚え書き');

    // 壊れたファイル: build は成功し、警告が標準出力と埋め込みデータ(warnings.notes)に出る。1 件だけ壊れていればその 1 件を飛ばす
    await writeFile(join(notes, 'groups.json'), '{ "version": 1, "groups": [ oops');
    const broken = atlas(['build', '--out', out, '--notes-dir', notes]);
    expect(broken.status, broken.stderr).toBe(0);
    expect(broken.stdout).toMatch(/build: 注意 .*groups\.json: JSON として読めないため無視しました/);
    d = await read();
    expect(d.groups).toEqual([]);
    expect(d.warnings.notes).toHaveLength(1);
    expect(d.warnings.notes[0]).toMatch(/JSON として読めない/);
    expect(d.warnings.notes[0]).toContain(notes); // 通常版は場所が分かるよう絶対パスを含む
    // 伏せ字版では警告文の絶対パスも <path> にする(ホームのパスを共有用 HTML に残さない)
    const brokenAnon = atlas(['build', '--out', outAnon, '--notes-dir', notes, '--anonymize']);
    expect(brokenAnon.status, brokenAnon.stderr).toBe(0);
    const dan = extractEmbedded<ReportData>(await readFile(join(outAnon, 'atlas.html'), 'utf8'));
    expect(dan.warnings.notes).toHaveLength(1);
    expect(dan.warnings.notes[0]).not.toContain(notes);
    expect(dan.warnings.notes[0]).toContain('<path>');
    await writeFile(join(notes, 'groups.json'), JSON.stringify({ version: 1, groups: [{ name: 'ok', ids: [ids[0]] }, { name: 'ok', ids: [] }, { name: 'x', ids: 'bad' }] }));
    const partial = atlas(['build', '--out', out, '--notes-dir', notes]);
    expect(partial.status, partial.stderr).toBe(0);
    d = await read();
    expect(d.groups.map((g) => g.name)).toEqual(['ok']);
    expect(d.warnings.notes).toHaveLength(2);
    // 壊れたファイルは group add / remove で上書きしない
    const noWrite = atlas(['group', 'add', 'ok', ids[1], '--out', out, '--notes-dir', notes]);
    expect(noWrite.status).toBe(1);
    expect(noWrite.stderr).toMatch(/書き換えません/);

    // atlas group add / list / remove: 無いファイルを作り、id は先頭一致で解決し、既存名には追記(重複は除く)
    const g = (...a: string[]) => atlas(['group', ...a, '--out', out, '--notes-dir', notes2]);
    expect(g('list').stdout).toMatch(/まだありません/);
    const add = g('add', '甲の調べ', ids[0], id99.slice(0, -1), '--note', '最初の 2 件');
    expect(add.status, add.stderr).toBe(0);
    expect(add.stdout).toMatch(/「甲の調べ」を作りました\(2 件\)/);
    const add2 = g('add', '甲の調べ', ids[0], ids[1]);
    expect(add2.status, add2.stderr).toBe(0);
    expect(add2.stdout).toMatch(/1 件を追記しました\(重複 1 件を除く、計 3 件\)/);
    expect(g('add', 'ambig', ids[0].slice(0, -1)).stderr).toMatch(/曖昧/);
    expect(g('add', 'unknown', 'zzz').stderr).toMatch(/記録にありません/);
    expect(JSON.parse(await readFile(join(notes2, 'groups.json'), 'utf8'))).toEqual({ version: 1, groups: [{ name: '甲の調べ', note: '最初の 2 件', ids: [ids[0], id99, ids[1]] }] });
    const list = g('list');
    expect(list.stdout).toMatch(/1 グループ/);
    expect(list.stdout).toMatch(/甲の調べ: 3 件 — 最初の 2 件/);
    expect(g('remove', 'nope').stderr).toMatch(/「nope」.*あるのは: 甲の調べ/);
    expect(g('remove', '甲の調べ').stdout).toMatch(/削除しました/);
    expect(JSON.parse(await readFile(join(notes2, 'groups.json'), 'utf8'))).toEqual({ version: 1, groups: [] });

    // 後片付け: out/ を絞り込み無しに戻す(後のテストは out/ の全件を前提にする)
    // --notes-dir を渡し、リポジトリ直下の atlas-notes/(利用者の手元のデータ)を読まない
    const back = atlas(['build', '--out', out, '--notes-dir', notes2]);
    expect(back.status, back.stderr).toBe(0);
    expect((await read()).groups).toEqual([]);
  });

  it('j. Phase 10 第 2 段: atlas serve の API でグループを作成・改名・削除でき、groups.json に書かれる。静的 HTML は token のプレースホルダのまま', async () => {
    // build 時の HTML: 3 画面とも token のプレースホルダ付きの meta を持ち、fetch は相対パス api/ だけ(externalRefs は a. で全ページを見ている)
    expect(html).toContain('<meta name="atlas-token" content="__ATLAS_TOKEN__"');
    expect(await readFile(join(out, 'glossary.html'), 'utf8')).toContain('content="__ATLAS_TOKEN__"');
    expect(await readFile(join(out, 'sessions', `${data.sessions[0].id}.html`), 'utf8')).toContain('content="__ATLAS_TOKEN__"');
    expect(html).toMatch(/fetch\(["'`]api\/heartbeat["'`]/);

    const notes = join(WORK, 'notes-serve');
    await rm(notes, { recursive: true, force: true });
    const child = spawn(process.execPath, [CLI, 'serve', '--out', out, '--notes-dir', notes, '--no-open'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    const url = await new Promise<string>((ok, ng) => {
      const t = setTimeout(() => ng(new Error(`serve が起動しない: ${stdout}\n${stderr}`)), 30_000);
      const tick = (): void => {
        const m = /serve: (http:\/\/127\.0\.0\.1:\d+\/atlas\.html)/.exec(stdout);
        if (m) {
          clearTimeout(t);
          ok(m[1]);
        } else setTimeout(tick, 50);
      };
      tick();
    });
    const base = url.replace(/\/atlas\.html$/, '');
    try {
      // 配信された atlas.html には token が入り、.serve.json がある
      const served = await (await fetch(url)).text();
      const token = /<meta name="atlas-token" content="([^"]+)"/.exec(served)![1];
      expect(token).not.toBe('__ATLAS_TOKEN__');
      expect(JSON.parse(await readFile(join(out, '.serve.json'), 'utf8'))).toMatchObject({ pid: child.pid });
      const jf = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
        const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', 'x-atlas-token': token, ...(init.headers ?? {}) } });
        const t = await r.text();
        return { status: r.status, body: t ? JSON.parse(t) : null };
      };
      expect((await jf('/api/state')).body).toMatchObject({ groups: [], exists: false });
      const ids = data.sessions.slice(0, 2).map((s) => s.id);
      const c = await jf('/api/groups', { method: 'POST', body: JSON.stringify({ name: '画面から', note: 'serve 経由', ids }) });
      expect(c.status).toBe(201);
      expect(JSON.parse(await readFile(join(notes, 'groups.json'), 'utf8'))).toEqual({ version: 1, groups: [{ name: '画面から', note: 'serve 経由', ids }] });
      expect((await jf('/api/state')).body.groups).toEqual([{ name: '画面から', note: 'serve 経由', ids }]);
      expect((await jf('/api/groups/' + encodeURIComponent('画面から'), { method: 'PUT', body: JSON.stringify({ name: '改名' }) })).status).toBe(200);
      // 第 3 段: 追加(ids の PUT)が groups.json に反映され、外して 0 件になっても残る
      const more = data.sessions.slice(2, 4).map((s) => s.id);
      const add = await jf('/api/groups/' + encodeURIComponent('改名'), { method: 'PUT', body: JSON.stringify({ ids: [...ids, ...more, ids[0]] }) });
      expect(add.status).toBe(200);
      expect(JSON.parse(await readFile(join(notes, 'groups.json'), 'utf8')).groups[0]).toEqual({ name: '改名', note: 'serve 経由', ids: [...ids, ...more] });
      const empty = await jf('/api/groups/' + encodeURIComponent('改名'), { method: 'PUT', body: JSON.stringify({ ids: [] }) });
      expect(empty.status).toBe(200);
      expect(JSON.parse(await readFile(join(notes, 'groups.json'), 'utf8')).groups).toEqual([{ name: '改名', note: 'serve 経由', ids: [] }]);
      expect((await jf('/api/state')).body.groups).toHaveLength(1);
      expect((await jf('/api/groups/' + encodeURIComponent('改名'), { method: 'DELETE' })).status).toBe(200);
      expect(JSON.parse(await readFile(join(notes, 'groups.json'), 'utf8'))).toEqual({ version: 1, groups: [] });
      // CLI の --group も同じファイルを読む(無い名前はエラー)
      expect(atlas(['build', '--out', out, '--notes-dir', notes, '--group', '改名']).status).toBe(1);
      // 二重起動: 既に動いていればブラウザを開くだけで終わる
      const again = atlas(['serve', '--out', out, '--notes-dir', notes, '--no-open']);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/既に動いているサーバがあります/);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    await rm(join(out, '.serve.json'), { force: true });
    // out/ を元に戻す(最後の build は --group でエラーになったので out は変わっていない)
  });

  it('judgments.json があれば推定工数が埋め込まれる(Phase 3 の口)', async () => {
    const sid = data.sessions[0].id;
    const jpath = join(WORK, 'judgments.json');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(
        jpath,
        JSON.stringify({ schemaVersion: 1, judge: { backend: 'external', model: 'test', ranAt: '2026-10-28T00:00:00Z' }, items: [{ sessionId: sid, taskCategory: 'docs', humanEffort: { hours: 1.5, low: 1, high: 2, confidence: 0.5 } }] }),
      ),
    );
    const r = atlas(['build', '--out', out, '--judgments', jpath]);
    expect(r.status, r.stderr).toBe(0);
    const d = extractEmbedded<ReportData>(await readFile(join(out, 'atlas.html'), 'utf8'));
    expect(d.judgments).toMatchObject({ available: true, backend: 'external', items: 1 });
    expect(d.sessions.find((s) => s.id === sid)?.judgment).toMatchObject({ taskCategory: 'docs', hours: 1.5 });
    expect(d.sessions.filter((s) => s.judgment).length).toBe(1);
    // 形の壊れた judgments は黙って無視せずに失敗する
    await import('node:fs/promises').then((fs) => fs.writeFile(jpath, JSON.stringify({ schemaVersion: 9, items: [] })));
    const bad = atlas(['build', '--out', out, '--judgments', jpath]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/schemaVersion/);
  });
});

describe.skipIf(!LIVE)('Phase 2 E2E: 実データ(ATLAS_LIVE=1)', () => {
  const src = process.env.ATLAS_COPILOT_HOME ?? join(homedir(), '.copilot');
  const out = join(ROOT, 'out', 'live');
  let r: ReturnType<typeof atlas>;
  let html: string;
  let data: ReportData;

  beforeAll(async () => {
    r = atlas(['all', '--home', src, '--out', out]);
    if (r.status !== 0) throw new Error(`atlas all が失敗: ${r.stderr}\n${r.stdout}`);
    html = await readFile(join(out, 'atlas.html'), 'utf8');
    data = extractEmbedded<ReportData>(html);
  });

  it('d. 実データの atlas.html が 5MB 未満で、プロジェクト別の集計が入る', async () => {
    const bytes = Buffer.byteLength(html);
    const projects = Object.keys(data.metrics.byProject).length;
    const details = (await readdir(join(out, 'sessions'))).filter((f) => f.endsWith('.html')).length;
    console.log(
      `[live] atlas all ${r.ms.toFixed(0)}ms, atlas.html ${(bytes / 1024 / 1024).toFixed(2)}MB, sessions=${data.sessions.length}, projects=${projects}, detailPages=${details}\n${r.stdout}`,
    );
    expect(bytes).toBeLessThan(LIMIT);
    expect(projects).toBeGreaterThan(1);
    expect(details).toBe(data.sessions.length);
    expect(externalRefs(html)).toEqual([]);
  });

  it('実データの伏せ字版に cwd / リポジトリ名 / ブランチが出ない', async () => {
    const s = JSON.parse(await readFile(join(out, 'sessions.json'), 'utf8')) as SessionsFile;
    const anonOut = join(ROOT, 'out', 'e2e-phase2-live-anon');
    await buildReport({
      sessions: s.sessions,
      metrics: computeMetrics(s.sessions),
      totalSessionsInSource: s.sessions.length,
      warnings: { unknownEventTypes: 0, badLines: 0 },
      judgments: null,
      outDir: anonOut,
      anonymize: true,
    });
    // 一般的な語と衝突しない程度に長い固有名だけを調べる(短いブランチ名 main 等は仮名の文脈では区別できない)
    const secrets = [...new Set(s.sessions.flatMap((x) => [x.cwd, x.gitRoot, x.repository, x.branch && x.branch.length >= 8 ? x.branch : null]))].filter(
      (v): v is string => !!v && v.length >= 8,
    );
    const anonHtml = await readFile(join(anonOut, 'atlas.html'), 'utf8');
    const leaked = secrets.filter((x) => appearances(anonHtml, x));
    console.log(`[live-anon] secrets=${secrets.length} leakedInIndex=${leaked.length}`);
    expect(leaked).toEqual([]);
    // 詳細ページは件数が多いので先頭 100 件を検査
    const pages = (await readdir(join(anonOut, 'sessions'))).slice(0, 100);
    for (const p of pages) {
      const h = await readFile(join(anonOut, 'sessions', p), 'utf8');
      const l = secrets.filter((x) => appearances(h, x));
      expect({ p, l }).toEqual({ p, l: [] });
    }
  });
});
