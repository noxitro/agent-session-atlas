// Phase 11: 指示文(AGENTS.md 等の注入)と skill の本文の閲覧ページ。
// 重複なしで版ごと(contentHash)に out/library/<hash>.md に本文を置き、out/instructions.html に
// 見出しごとの版一覧(使われたセッション、初回と最終の利用日、前の版との差分)を出す。本文は atlas.html に埋め込まない。伏せ字版では作らない。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { charCount, contentHash, extractInstructionBlocks, type InstructionFile, type InstructionInjection } from '../../core/src/index.ts';
import { HOME_PROJECT, TEMP_PROJECT } from '../../core/src/project-keys.ts';
import { esc } from './detail.ts';
import { date, dateTime, int } from './lib/format.ts';
import { cleanHeading, seriesKey } from './lib/insights.ts';
import { detailFileName } from './lib/summarize.ts';
import { NAV_JS, renderRail, renderTop, type NavGroup } from './page-nav.ts';
import { redactSecrets } from './transcript.ts';

export const INSTRUCTIONS_FILE = 'instructions.html';
export const LIBRARY_DIR = 'library';
/** skill の節の id(詳細ページから instructions.html#s-… で飛ぶ)。英数字以外を置き換えたうえで短いハッシュを付け、日本語名どうしが重ならないようにする */
export const skillAnchor = (name: string): string => `s-${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${contentHash(name).slice(0, 6)}`;
export { cleanHeading };

export interface LibraryVersion {
  hash: string;
  body: string;
  chars: number;
  sessions: Set<string>;
  firstAt: string | null;
  lastAt: string | null;
  /** system.message に現れた回数(全セッションの合計) */
  injections: number;
  /** 出所のパス(imported_custom_instruction の source。分かったものだけ、重複なし) */
  sourcePaths: string[];
  /**
   * セッションごとの、その版を最初に読み込んだ日時。ページの使用期間・並行・最後に使われた版はこれで決める
   * (長く続くセッションは始めた時の版を最後まで注入し直すので、最後の注入の日時だと古い版が新しく見える)
   */
  firstBySession: Map<string, string | null>;
}

export interface LibraryGroup {
  kind: 'instruction' | 'skill';
  /** 指示文は先頭の見出し(無ければファイル種別)、skill は名前 */
  key: string;
  file: InstructionFile | 'skill';
  versions: LibraryVersion[];
}

const later = (a: string | null, b: string | null): string | null => (a && b ? (a > b ? a : b) : (a ?? b));
const earlier = (a: string | null, b: string | null): string | null => (a && b ? (a < b ? a : b) : (a ?? b));

export class LibraryCollector {
  private groups = new Map<string, LibraryGroup>();
  private sessions = new Set<string>();

  private version(kind: LibraryGroup['kind'], key: string, file: LibraryGroup['file'], hash: string, body: string, sessionId: string, at: string | null, sourcePath: string | null): void {
    const gk = `${kind}\u0000${key}`;
    let g = this.groups.get(gk);
    if (!g) this.groups.set(gk, (g = { kind, key, file, versions: [] }));
    // 同じ見出しでもファイルの種別が推定できなかった注入がある。分かったものを項目の種別にする
    if (g.file === 'unknown' && file !== 'unknown') g.file = file;
    let v = g.versions.find((x) => x.hash === hash);
    // 字数は CRLF を LF にしてから数える(ページに出す本文と合わせる。CR まで数えると本文より多く見える)
    if (!v) g.versions.push((v = { hash, body, chars: charCount(body.replace(/\r\n?/g, '\n')), sessions: new Set(), firstAt: null, lastAt: null, injections: 0, sourcePaths: [], firstBySession: new Map() }));
    if (sourcePath && !v.sourcePaths.includes(sourcePath)) v.sourcePaths.push(sourcePath);
    v.sessions.add(sessionId);
    this.sessions.add(sessionId);
    v.firstBySession.set(sessionId, v.firstBySession.has(sessionId) ? earlier(v.firstBySession.get(sessionId) ?? null, at) : at);
    v.injections++;
    v.firstAt = earlier(v.firstAt, at);
    v.lastAt = later(v.lastAt, at);
  }

  /** system.message の本文から指示ブロックを取り出して版に束ねる */
  addSystemMessage(sessionId: string, content: string, at: string | null): void {
    for (const b of extractInstructionBlocks(content)) {
      // 項目は整えた見出しだけで決める(seriesKey。改善点の「版 N」と揃える)。同じ本文がパス付きとパス無しの両方で注入されるので、
      // パスで分けると同じ版が 2 つの項目に載る。別リポジトリの同名ファイルは同じ項目に入るが、版ごとにプロジェクトと並行使用を示す
      this.version('instruction', seriesKey(b.heading, b.file), b.file, b.contentHash, b.body, sessionId, at, b.sourcePath ?? null);
    }
  }

  /** その skill の本文をもう集めたか(詳細ページは集めた後に書くので、そのセッションの分を含む。本文の無い呼び出しだけの skill は false) */
  hasSkill(name: string): boolean {
    return this.groups.has(`skill\u0000${name}`);
  }

  /** そのセッションの指示文か skill の本文をもう集めたか(詳細ページは集めた後に書く。false なら絞り込んだページが空になるのでリンクしない) */
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /** skill.invoked の本文 */
  addSkill(sessionId: string, name: string, content: string, hash: string, at: string | null, path: string | null): void {
    this.version('skill', name, 'skill', hash, content, sessionId, at, path);
  }

  result(): LibraryGroup[] {
    const gs = [...this.groups.values()];
    for (const g of gs) g.versions.sort((a, b) => (a.firstAt ?? '').localeCompare(b.firstAt ?? '') || a.hash.localeCompare(b.hash));
    return gs.sort((a, b) => (a.kind === b.kind ? b.versions.reduce((n, v) => n + v.sessions.size, 0) - a.versions.reduce((n, v) => n + v.sessions.size, 0) || a.key.localeCompare(b.key) : a.kind === 'instruction' ? -1 : 1));
  }
}

/** 行単位の差分(LCS)。+ / - / 空白 の接頭辞で返す。長いときは変化の無い行を省く */
export function lineDiff(a: string, b: string, context = 2): string[] {
  const x = a.replace(/\r\n/g, '\n').split('\n');
  const y = b.replace(/\r\n/g, '\n').split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000) return [`(差分の計算を省略: ${n} 行 → ${m} 行)`];
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push(` ${x[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(`-${x[i++]}`);
    else ops.push(`+${y[j++]}`);
  }
  while (i < n) ops.push(`-${x[i++]}`);
  while (j < m) ops.push(`+${y[j++]}`);
  // 変化の無い行は前後 context 行だけ残す
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o[0] === ' ') return;
    for (let d = -context; d <= context; d++) if (ops[k + d] !== undefined) keep[k + d] = true;
  });
  const out: string[] = [];
  let gap = 0;
  ops.forEach((o, k) => {
    if (keep[k]) {
      if (gap) out.push(`… (${gap} 行同じ)`);
      gap = 0;
      out.push(o);
    } else gap++;
  });
  if (gap) out.push(`… (${gap} 行同じ)`);
  return out;
}

export async function writeLibrary(dir: string, groups: LibraryGroup[]): Promise<{ files: number; bytes: number; secretHits: number }> {
  await mkdir(dir, { recursive: true });
  let files = 0;
  let bytes = 0;
  let secretHits = 0;
  for (const g of groups)
    for (const v of g.versions) {
      const red = redactSecrets(v.body);
      secretHits += red.hits;
      const head = `<!-- ${g.kind === 'skill' ? 'skill' : '指示文'}: ${g.key.replace(/-->/g, '')} / 版 ${v.hash} / ${int(v.sessions.size)} セッション / 初回 ${v.firstAt ?? '—'} / 最終 ${v.lastAt ?? '—'} -->\n`;
      const md = head + red.text + (red.text.endsWith('\n') ? '' : '\n');
      await writeFile(join(dir, `${v.hash}.md`), md);
      files++;
      bytes += Buffer.byteLength(md);
    }
  return { files, bytes, secretHits };
}

const LIB_CSS = `
.lib-group{margin-top:28px}.lib-group:first-child{margin-top:0}
.lib-group .section-head p{max-width:none}
.versions{margin-top:10px}
.ver{margin-top:14px;border:1px solid var(--rule-strong);background:var(--surface)}
.ver>summary{cursor:pointer;padding:6px 10px;font-size:.8125rem;color:var(--form);display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline}
.ver>summary b{color:var(--ink)}
.ver>summary .tag.latest{border-color:var(--form);color:var(--form)}
.ver>summary .hash{margin-left:auto;font:.6875rem var(--mono);color:var(--ink-3)}
.lib-group .section-head .latest{flex-basis:100%;margin:4px 0 0;max-width:none}
.ver .cap{margin:0;padding:6px 10px 0;border-top:1px solid var(--rule);font-size:.6875rem;color:var(--form);letter-spacing:.04em}
.ver .body{margin:0;padding:6px 10px 10px;font:.75rem/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto}
.ver .body:focus-visible{outline:2px solid var(--form);outline-offset:-2px}
.ver .diff{background:var(--form-wash)}
.ver .diff .sign{display:inline-block;width:1.4em;color:var(--ink-3)}
.ver .diff .add .sign,.ver .diff .add{color:var(--form)}.ver .diff .del .sign,.ver .diff .del{color:var(--warn)}
.ver .links{padding:6px 10px;border-top:1px solid var(--rule);font-size:.75rem;overflow-wrap:anywhere}
.ver .uses{padding:6px 10px;border-top:1px solid var(--rule);font-size:.75rem;color:var(--ink-2)}
.ver .uses ul{display:inline;margin:0;padding:0;list-style:none}
.ver .uses li{display:inline}
.ver .uses li+li::before{content:' · ';color:var(--ink-3)}
.lib-note{font-size:.8125rem;color:var(--ink-2);margin:8px 0 0;max-width:80ch}
.lib-filter{margin-top:14px;padding:8px 12px;border:1px solid var(--rule);border-top:2px solid var(--form);background:var(--surface);font-size:.8125rem;color:var(--ink-2)}
.lib-filter b{color:var(--ink)}
.lib-filter a{margin-left:10px}
.lib-group[hidden],.ver[hidden],.in-session[hidden],.rail li[hidden],.toc li[hidden]{display:none}
`;

/**
 * #session=<id> で開いたとき、そのセッションで使われた版だけを残す(詳細ページの「このセッションの指示文と skill」から来る)。
 * 版の data-sessions に使ったセッションの id を空白区切りで持たせ、項目と目次も空になったものを隠す。#session= が外れたら元に戻す。
 * 絞り込みが変わったときだけ開閉を戻す(目次の移動で、開いた版を閉じない)。#v-… へ移ったら(隠れた版を指すこともある)その版を開いて見せる。
 * 1 件も無いセッションは名前の表に載らないので、戻る先は detailFileName と同じ規則で作る
 */
const FILTER_JS = `(function(){var d=document,box=d.getElementById('lib-filter'),names={},cur=null;try{names=JSON.parse(d.getElementById('lib-sessions').textContent)}catch(e){}
function el(t,c,x){var e=d.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function filter(){var m=/^#session=([^&]+)/.exec(location.hash),id='';if(m){try{id=decodeURIComponent(m[1])}catch(e){}}if(id===cur)return;cur=id;var ni=0,ns=0;
d.querySelectorAll('.lib-group').forEach(function(sec){var used=[];sec.querySelectorAll('.ver').forEach(function(v){var on=!id||(' '+v.getAttribute('data-sessions')+' ').indexOf(' '+id+' ')>=0;v.hidden=!on;v.open=id?on:v.hasAttribute('data-latest');if(id&&on)used.push(v.getAttribute('data-n'))});
var any=used.length>0,line=sec.querySelector('.in-session');if(line){line.hidden=!id||!any;line.textContent=id&&any?'このセッションで使った版: 版 '+used.join('・'):''}
sec.hidden=!!id&&!any;if(id&&any){if(sec.getAttribute('data-kind')==='skill')ns++;else ni++}
d.querySelectorAll('a[href="#'+sec.id+'"]').forEach(function(a){var li=a.closest('li');if(li)li.hidden=sec.hidden})});
box.textContent='';box.hidden=!id;if(!id)return;var s=names[id];
box.appendChild(d.createTextNode('セッション「'));box.appendChild(el('b',null,s?s[0]:id.slice(0,8)));
box.appendChild(d.createTextNode(ni+ns?'」で使われた指示文 '+ni+' 件・skill '+ns+' 件だけを表示しています(skill は本文が記録に残った呼び出しだけ。使えただけの skill は詳細ページの表にあります)。':'」には、注入された指示文も、本文が記録に残った skill の呼び出しもないため、表示するものがありません(使えただけの skill は詳細ページの表にあります)。'));
var all=el('a',null,'すべて表示');all.href='#';all.addEventListener('click',function(e){e.preventDefault();history.replaceState(null,'',location.pathname+location.search);apply()});box.appendChild(all);
var back=el('a',null,'セッションの詳細に戻る');back.href='sessions/'+(s?s[1]:id.replace(/[^A-Za-z0-9._-]/g,'_')+'.html');box.appendChild(back)}
function jump(){var h=location.hash;if(h.indexOf('#v-')!==0)return;var t=d.getElementById(h.slice(1));if(!t)return;t.open=true;t.scrollIntoView()}
function apply(){filter();jump()}
addEventListener('hashchange',apply);apply()})()`;

export interface InstructionsPageOptions {
  css: string;
  generatedAt: string;
  groups: LibraryGroup[];
  /** セッション名(詳細ページへのリンクの文言) */
  sessionName: (id: string) => string;
  /** セッションのプロジェクト名。版ごとに使ったプロジェクトを示し、並行して使われた版を見分けるのに使う */
  sessionProject?: (id: string) => string | null;
  /** 指示文の版(内容のハッシュ)の、全セッションを見て特定したファイルと範囲(詳細ページの表と同じもの)。抜き出した時点では不明なことが多い */
  resolveInstruction?: (hash: string) => { file: InstructionFile; scope: InstructionInjection['scope'] } | null;
}

/** 差分の元を探すときに「同じプロジェクト」と数えない仮のまとまり(無関係な作業の寄せ集め) */
const NOT_A_PROJECT: ReadonlySet<string> = new Set([HOME_PROJECT, TEMP_PROJECT]);

/** プロジェクトの短い名前(パスの最後の部分。長い名前は 24 字で切る)。全体は title に出す */
function shortName(p: string): string {
  const s = p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}
/** プロジェクト名を最大 max 件並べ、残りは「他 N」 */
const projectList = (names: readonly string[], max: number): string => `${names.slice(0, max).map(shortName).join('・')}${names.length > max ? ` 他 ${int(names.length - max)}` : ''}`;

interface UsePeriod {
  from: string | null;
  to: string | null;
}
/** 版の使用期間: 各セッションでその版を最初に読み込んだ日時の、最も早いものと最も遅いもの(長いセッションの読み込み直しで延ばさない) */
function usePeriod(v: LibraryVersion): UsePeriod {
  let from: string | null = null;
  let to: string | null = null;
  for (const at of v.firstBySession.values()) {
    from = earlier(from, at);
    to = later(to, at);
  }
  return { from, to };
}
/** 使われた期間が重なる(並行して使われた)か */
function overlaps(a: UsePeriod, b: UsePeriod): boolean {
  return !!(a.from && a.to && b.from && b.to && a.from <= b.to && b.from <= a.to);
}

export function renderInstructionsHtml(o: InstructionsPageOptions): string {
  const inst = o.groups.filter((g) => g.kind === 'instruction');
  const skills = o.groups.filter((g) => g.kind === 'skill');
  const gid = (g: LibraryGroup, i: number): string => (g.kind === 'skill' ? skillAnchor(g.key) : `g-${i}`);
  const navGroups: NavGroup[] = [
    // 数字だけだと「版 N」の番号に読めるので、単位を見せる(「8 つの版」)
    { title: '指示文', items: inst.map((g, i) => ({ href: `#${gid(g, i)}`, label: cleanHeading(g.key, 40), count: g.versions.length, countLabel: 'つの版', showCountLabel: true })) },
    { title: 'skill', items: skills.map((g, i) => ({ href: `#${gid(g, inst.length + i)}`, label: cleanHeading(g.key, 40), count: g.versions.length, countLabel: 'つの版', showCountLabel: true })) },
  ].filter((g) => g.items.length);
  const nav = { crumbHref: 'atlas.html', crumbLabel: '← レポートに戻る', tocLabel: '指示文と skill', groups: navGroups, links: [{ href: 'glossary.html', label: '用語の説明' }] };
  const projectOf = (id: string): string | null => o.sessionProject?.(id) || null;
  const sec = (g: LibraryGroup, i: number): string => {
    // 1 つのセッションが複数の版を使うと、版ごとのセッション数の合計が項目の数より多くなる。その差を見出しに書き添える
    const usesBySession = new Map<string, number>();
    for (const v of g.versions) for (const id of v.sessions) usesBySession.set(id, (usesBySession.get(id) ?? 0) + 1);
    const total = usesBySession.size;
    const multi = [...usesBySession.values()].filter((n) => n > 1).length;
    // 期間・並行・最後の版は、各セッションでその版を最初に読み込んだ日時で決める(長いセッションが始めた時の版を読み込み直し続けるため)
    const per = g.versions.map(usePeriod);
    // 版は初回日の順の通し番号(改善点の「版 N」と同じ)。番号が大きいほど新しいとは限らない(別のリポジトリで並行して使われる)ので、
    // 最後に使われた版(期間の終わりが最新のもの)に印を付けて開いた状態にし、プロジェクトごとの最後の版を項目の見出しに出す
    const latestK = per.reduce((a, p, k) => ((p.to ?? '') > (per[a].to ?? '') ? k : a), 0);
    const latest = g.versions[latestK];
    // ファイルの種別と範囲は、全セッションを見て特定したもの(詳細ページの表と同じ)を優先し、無ければ抜き出した時点の推定
    const resolved = g.kind === 'instruction' ? g.versions.map((v) => o.resolveInstruction?.(v.hash) ?? null) : [];
    const fileVotes = new Map<string, number>();
    for (const r of resolved) if (r && r.file !== 'unknown') fileVotes.set(r.file, (fileVotes.get(r.file) ?? 0) + 1);
    const file = [...fileVotes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? g.file;
    const scopes = new Set(resolved.flatMap((r) => (r && r.scope !== 'unknown' ? [r.scope] : [])));
    // ユーザー単位の 1 ファイルなら、プロジェクトごとに分けても意味が無い(全体の最後の版だけ出す)
    const userOnly = scopes.size === 1 && scopes.has('user');
    const scopeLabel = scopes.size === 2 ? 'リポジトリとユーザー' : userOnly ? 'ユーザー' : scopes.has('repo') ? 'リポジトリ' : '';
    const kindLabel = g.kind === 'skill' ? 'skill' : file === 'unknown' ? '指示文(ファイル不明: どのファイルから入ったか特定できなかったもの)' : `${file}${scopeLabel ? `(${scopeLabel})` : ''}`;
    // 版ごとの、使ったプロジェクトとセッション数(多い順)
    const projects = g.versions.map((v) => {
      const m = new Map<string, number>();
      for (const id of v.sessions) {
        const p = projectOf(id);
        if (p) m.set(p, (m.get(p) ?? 0) + 1);
      }
      return new Map([...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    });
    // プロジェクトごとの最後の版(そのプロジェクトのセッションで最も遅く読み込み始めた版)
    const lastByProject = new Map<string, { k: number; at: string }>();
    g.versions.forEach((v, k) => {
      for (const [id, at] of v.firstBySession) {
        const p = projectOf(id);
        if (!p || !at) continue;
        const cur = lastByProject.get(p);
        if (!cur || at > cur.at) lastByProject.set(p, { k, at });
      }
    });
    // 最後の版ごとにプロジェクトを束ねる(全プロジェクトが同じ版なら 1 行で済む)。最後に使われた時期の新しい順
    const byLast = new Map<number, { names: string[]; at: string }>();
    for (const [p, l] of lastByProject) {
      const cur = byLast.get(l.k) ?? byLast.set(l.k, { names: [], at: l.at }).get(l.k)!;
      cur.names.push(p);
      if (l.at > cur.at) cur.at = l.at;
    }
    const verLink = (k: number): string => `<a href="#v-${esc(g.versions[k].hash)}">版 ${k + 1}</a>`;
    const latestLine =
      g.versions.length < 2
        ? ''
        : byLast.size > 1 && !userOnly
          ? `<p class="latest">プロジェクトごとの最後の版: ${[...byLast]
              .sort((a, b) => b[1].at.localeCompare(a[1].at))
              .map(([k, x]) => `${verLink(k)} は <span title="${esc(x.names.join('\n'))}">${esc(projectList(x.names, 3))}</span>`)
              .join('、')}</p>`
          : `<p class="latest">最後に使われた版: ${verLink(latestK)}(${esc(dateTime(per[latestK].to))}${!userOnly && lastByProject.size > 1 ? `。使った ${esc(int(lastByProject.size))} プロジェクトのすべてで、この版が最後` : ''})</p>`;
    // #session= で絞り込んだときだけ、そのセッションで使った版の番号を JS が入れる(見出しの件数や並行の印は項目全体のまま)
    const inSession = g.versions.length > 1 ? '<p class="latest in-session" hidden></p>' : '';
    const rows = g.versions
      .map((v, k) => {
        // 差分の元: 同じプロジェクトで前に使われた版(初回日の順で直前のもの)。無ければ初回日の順で 1 つ前の版
        // ホームと一時フォルダは無関係な作業の寄せ集めなので、同じプロジェクトに数えない
        let base = -1;
        let shared: string[] = [];
        for (let j = k - 1; j >= 0 && base < 0; j--) {
          shared = [...projects[k].keys()].filter((p) => !NOT_A_PROJECT.has(p) && projects[j].has(p));
          if (shared.length) base = j;
        }
        const sameProject = base >= 0;
        if (!sameProject && k > 0) base = k - 1;
        const prev = base >= 0 ? g.versions[base] : null;
        const parallel = g.versions.map((_w, j) => (j !== k && overlaps(per[k], per[j]) ? j + 1 : 0)).filter((n) => n > 0);
        const names = [...projects[k].keys()];
        const body = redactSecrets(v.body).text;
        const diff = prev
          ? lineDiff(redactSecrets(prev.body).text, body)
              .map((l) => {
                const sign = l[0];
                const rest = l.slice(1);
                if (sign === '+') return `<span class="add"><span class="sign">+</span>${esc(rest)}</span>`;
                if (sign === '-') return `<span class="del"><span class="sign">−</span>${esc(rest)}</span>`;
                if (sign === ' ') return `<span class="sign"> </span>${esc(rest)}`;
                return esc(l);
              })
              .join('\n')
          : '';
        const ids = [...v.sessions].sort();
        // 一覧は新しい順(そのセッションでこの版を最初に読み込んだ日時)。同じ名前のセッションが多いので日付を添える
        const at = (id: string): string => v.firstBySession.get(id) ?? '';
        const uses = [...ids]
          .sort((a, b) => at(b).localeCompare(at(a)) || a.localeCompare(b))
          .slice(0, 50)
          .map((id) => `<li>${esc(date(v.firstBySession.get(id)))} <a href="sessions/${esc(detailFileName(id))}">${esc(o.sessionName(id))}</a></li>`)
          .join('');
        const isLatest = v === latest;
        for (const id of ids) seen.add(id);
        // 同じ分に丸まる日時は 1 つだけ出す(生の ISO 文字列で比べると「X 〜 X」になる)
        const from = dateTime(per[k].from);
        const to = dateTime(per[k].to);
        const period = from === to ? from : `${from} 〜 ${to}`;
        const cap = !prev
          ? ''
          : sameProject
            ? `版 ${base + 1} → 版 ${k + 1} の差分(${projectList(shared, 2)} で前に使われた版 ${base + 1} との行の比較)`
            : `版 ${base + 1} → 版 ${k + 1} の差分(初回日の順で 1 つ前の版との行の比較${names.length && projects[base].size ? '。同じプロジェクトで前に使われた版が無いので、別のプロジェクトの版と比べています' : ''})`;
        return `<details class="ver" id="v-${esc(v.hash)}" data-n="${k + 1}" data-sessions="${esc(ids.join(' '))}"${isLatest ? ' open data-latest' : ''}><summary><b>版 ${k + 1}</b>${
          isLatest && g.versions.length > 1 ? ' <span class="tag latest">最後に使われた版</span>' : ''
        }${parallel.length ? ` <span class="tag">版 ${parallel.join('・')} と並行して使用</span>` : ''} <span>使用 ${esc(period)}</span> <span>${esc(int(v.sessions.size))} セッション</span> <span>${esc(int(v.chars))} 字</span>${
          names.length ? ` <span title="${esc(names.join('\n'))}">${esc(projectList(names, 3))}</span>` : ''
        } <span class="hash" title="内容のハッシュ">${esc(v.hash)}</span></summary>${
          prev ? `<p class="cap"${sameProject ? ` title="${esc(shared.join('\n'))}"` : ''}>${esc(cap)}</p><pre class="body diff" tabindex="0">${diff}</pre>` : ''
        }<p class="cap">版 ${k + 1} の本文</p><pre class="body" tabindex="0">${esc(body)}</pre><div class="links"><a href="${LIBRARY_DIR}/${esc(v.hash)}.md">本文 (.md) を開く</a>${
          v.sourcePaths.length ? ` · 出所 ${v.sourcePaths.map((sp) => `<code>${esc(sp)}</code>`).join('、')}` : ''
        }</div><div class="uses">使われたセッション(${esc(int(ids.length))}): <ul>${uses}</ul>${ids.length > 50 ? ` …他 ${esc(int(ids.length - 50))} 件` : ''}</div></details>`;
      })
      .join('');
    return `<section class="section lib-group" data-kind="${g.kind}" id="${gid(g, i)}" aria-labelledby="h-${gid(g, i)}"><div class="section-head"><h2 id="h-${gid(g, i)}">${esc(cleanHeading(g.key, 120))}</h2><p>${esc(kindLabel)} · ${esc(int(g.versions.length))} つの版 · ${esc(int(total))} セッションで使用${multi ? `(うち ${esc(int(multi))} セッションは 2 つ以上の版を使用)` : ''}</p>${latestLine}${inSession}</div><div class="versions">${rows}</div></section>`;
  };
  const seen = new Set<string>();
  const body = [...inst, ...skills].map((g, i) => sec(g, i)).join('');
  // #session= の絞り込みで出す名前と詳細ページ(</script> で閉じないよう < を逃がす)
  const sessionsJson = JSON.stringify(Object.fromEntries([...seen].sort().map((id) => [id, [o.sessionName(id), detailFileName(id)]]))).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="atlas-token" content="__ATLAS_TOKEN__">
<meta name="theme-color" content="#f3f5f3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1110" media="(prefers-color-scheme: dark)">
<title>指示文と skill | Copilot Session Atlas</title>
<script>try{var t=localStorage.getItem('atlas-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${o.css}${LIB_CSS}</style>
</head>
<body>
${renderTop(nav)}
<div class="shell">
${renderRail(nav)}
<div class="content">
<main class="wrap">
<div class="title"><h1>指示文と skill</h1><p class="lib-note">セッションに注入された指示文(AGENTS.md / CLAUDE.md / copilot-instructions.md 等)と、呼ばれた skill の本文を、重複なしで版ごとに置いたものです。版は内容のハッシュで区別し、見出しが同じものを 1 つの項目にまとめています。「版 N」は初回の利用日の順の通し番号で、別のリポジトリの同じ見出しのファイルも同じ項目に入るため、番号が大きい版が今の版とは限りません。最後に使われた版に印を付けて開いた状態にし、使われた期間が重なる版には「並行して使用」と付けています(期間は、各セッションでその版を最初に読み込んだ日時)。差分は、同じプロジェクトで前に使われた版との行単位の比較です。生成 ${esc(dateTime(o.generatedAt))}。${
    o.groups.length ? '' : '指示文も skill の本文も記録にありませんでした。'
  }</p><div class="lib-filter" id="lib-filter" role="status" data-testid="lib-filter" hidden></div></div>
${body}
</main>
<footer class="wrap page-foot"><p>本文は <code>${LIBRARY_DIR}/&lt;版&gt;.md</code> にも置いてあります。秘密情報の形式検査で伏せた箇所は <code>[伏せました: 種類]</code> です。</p></footer>
</div>
</div>
<script type="application/json" id="lib-sessions">${sessionsJson}</script>
<script>${NAV_JS}</script>
<script>${FILTER_JS}</script>
</body>
</html>
`;
}
