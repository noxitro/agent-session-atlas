// Phase 11: 指示文(AGENTS.md 等の注入)と skill の本文の閲覧ページ。
// 重複なしで版ごと(contentHash)に out/library/<hash>.md に本文を置き、out/instructions.html に
// 見出しごとの版一覧(使われたセッション、初回と最終の利用日、前の版との差分)を出す。本文は atlas.html に埋め込まない。伏せ字版では作らない。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { charCount, contentHash, extractInstructionBlocks, type InstructionFile } from '../../core/src/index.ts';
import { esc } from './detail.ts';
import { dateTime, int } from './lib/format.ts';
import { detailFileName } from './lib/summarize.ts';
import { NAV_JS, renderRail, renderTop, type NavGroup } from './page-nav.ts';
import { redactSecrets } from './transcript.ts';

export const INSTRUCTIONS_FILE = 'instructions.html';
export const LIBRARY_DIR = 'library';
/** skill の節の id(詳細ページから instructions.html#s-… で飛ぶ)。英数字以外を置き換えたうえで短いハッシュを付け、日本語名どうしが重ならないようにする */
export const skillAnchor = (name: string): string => `s-${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-${contentHash(name).slice(0, 6)}`;
/** 項目名: 先頭の # や HTML コメントの印を外し、長ければ省略記号を付ける */
export function cleanHeading(h: string, max = 60): string {
  const t = h.replace(/^#+\s*/, '').replace(/^<!--\s*|\s*-->$/g, '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface LibraryVersion {
  hash: string;
  body: string;
  chars: number;
  sessions: Set<string>;
  firstAt: string | null;
  lastAt: string | null;
  /** system.message に現れた回数(全セッションの合計) */
  injections: number;
  sourcePath: string | null;
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

  private version(kind: LibraryGroup['kind'], key: string, file: LibraryGroup['file'], hash: string, body: string, sessionId: string, at: string | null, sourcePath: string | null): void {
    const gk = `${kind}\u0000${key}`;
    let g = this.groups.get(gk);
    if (!g) this.groups.set(gk, (g = { kind, key, file, versions: [] }));
    let v = g.versions.find((x) => x.hash === hash);
    if (!v) g.versions.push((v = { hash, body, chars: charCount(body), sessions: new Set(), firstAt: null, lastAt: null, injections: 0, sourcePath }));
    v.sessions.add(sessionId);
    v.injections++;
    v.firstAt = earlier(v.firstAt, at);
    v.lastAt = later(v.lastAt, at);
  }

  /** system.message の本文から指示ブロックを取り出して版に束ねる */
  addSystemMessage(sessionId: string, content: string, at: string | null): void {
    for (const b of extractInstructionBlocks(content)) {
      // 項目は「見出し(無ければ本文の先頭行)+ 出所のパス」。同じ見出しでも出所が違えば別の項目(別リポジトリの同名ファイルを 1 つの系列にしない)
      const head = cleanHeading(b.heading) || `(見出しなし: ${b.file})`;
      const key = b.sourcePath ? `${head} — ${b.sourcePath}` : head;
      this.version('instruction', key, b.file, b.contentHash, b.body, sessionId, at, b.sourcePath ?? null);
    }
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
.ver>summary .tag{margin-left:auto}
.ver .cap{margin:0;padding:6px 10px 0;border-top:1px solid var(--rule);font-size:.6875rem;color:var(--form);letter-spacing:.04em}
.ver .body{margin:0;padding:6px 10px 10px;font:.75rem/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto}
.ver .body:focus-visible{outline:2px solid var(--form);outline-offset:-2px}
.ver .diff{background:var(--form-wash)}
.ver .diff .sign{display:inline-block;width:1.4em;color:var(--ink-3)}
.ver .diff .add .sign,.ver .diff .add{color:var(--form)}.ver .diff .del .sign,.ver .diff .del{color:var(--warn)}
.ver .links{padding:6px 10px;border-top:1px solid var(--rule);font-size:.75rem}
.ver .uses{padding:6px 10px;border-top:1px solid var(--rule);font-size:.75rem;color:var(--ink-2)}
.ver .uses ul{display:inline;margin:0;padding:0;list-style:none}
.ver .uses li{display:inline}
.ver .uses li+li::before{content:' · ';color:var(--ink-3)}
.lib-note{font-size:.8125rem;color:var(--ink-2);margin:8px 0 0;max-width:80ch}
`;

export interface InstructionsPageOptions {
  css: string;
  generatedAt: string;
  groups: LibraryGroup[];
  /** セッション名(詳細ページへのリンクの文言) */
  sessionName: (id: string) => string;
}

export function renderInstructionsHtml(o: InstructionsPageOptions): string {
  const inst = o.groups.filter((g) => g.kind === 'instruction');
  const skills = o.groups.filter((g) => g.kind === 'skill');
  const gid = (g: LibraryGroup, i: number): string => (g.kind === 'skill' ? skillAnchor(g.key) : `g-${i}`);
  const navGroups: NavGroup[] = [
    { title: '指示文', items: inst.map((g, i) => ({ href: `#${gid(g, i)}`, label: cleanHeading(g.key, 40), count: g.versions.length, countLabel: '版' })) },
    { title: 'skill', items: skills.map((g, i) => ({ href: `#${gid(g, inst.length + i)}`, label: cleanHeading(g.key, 40), count: g.versions.length, countLabel: '版' })) },
  ].filter((g) => g.items.length);
  const nav = { crumbHref: 'atlas.html', crumbLabel: '← レポートに戻る', tocLabel: '指示文と skill', groups: navGroups, links: [{ href: 'glossary.html', label: '用語の説明' }] };
  const sec = (g: LibraryGroup, i: number): string => {
    const total = new Set(g.versions.flatMap((v) => [...v.sessions])).size;
    // 版は初回日の順。最後に使われた版(最終が最新のもの)に印を付け、それを開いた状態にする(初回が最新の版とは限らない)
    const latest = g.versions.reduce((a, v) => ((v.lastAt ?? '') > (a.lastAt ?? '') ? v : a), g.versions[0]);
    const rows = g.versions
      .map((v, k) => {
        const prev = k > 0 ? g.versions[k - 1] : null;
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
        const uses = ids
          .slice(0, 50)
          .map((id) => `<li><a href="sessions/${esc(detailFileName(id))}">${esc(o.sessionName(id))}</a></li>`)
          .join('');
        const isLatest = v === latest;
        return `<details class="ver" id="v-${esc(v.hash)}"${isLatest ? ' open' : ''}><summary><b>版 ${k + 1}</b> <span>${esc(v.hash)}</span> <span>${esc(int(v.chars))} 字</span> <span>${esc(int(v.sessions.size))} セッション</span> <span>初回 ${esc(dateTime(v.firstAt))}</span> <span>最終 ${esc(dateTime(v.lastAt))}</span>${isLatest && g.versions.length > 1 ? ' <span class="tag">最後に使われた版</span>' : ''}</summary>${
          prev ? `<p class="cap">版 ${k} → 版 ${k + 1} の差分(初回日の順で 1 つ前の版との行の比較。並行して使われた版どうしのこともあります)</p><pre class="body diff" tabindex="0">${diff}</pre>` : ''
        }<p class="cap">版 ${k + 1} の本文</p><pre class="body" tabindex="0">${esc(body)}</pre><div class="links"><a href="${LIBRARY_DIR}/${esc(v.hash)}.md">本文 (.md) を開く</a>${v.sourcePath ? ` · 出所 <code>${esc(v.sourcePath)}</code>` : ''}</div><div class="uses">使われたセッション(${esc(int(ids.length))}): <ul>${uses}</ul>${ids.length > 50 ? ` …他 ${esc(int(ids.length - 50))} 件` : ''}</div></details>`;
      })
      .join('');
    return `<section class="section lib-group" id="${gid(g, i)}" aria-labelledby="h-${gid(g, i)}"><div class="section-head"><h2 id="h-${gid(g, i)}">${esc(cleanHeading(g.key, 120))}</h2><p>${esc(g.kind === 'skill' ? 'skill' : g.file === 'unknown' ? '指示文(ファイル不明: 注入の形から特定できなかった)' : g.file)} · 版 ${esc(int(g.versions.length))} · ${esc(int(total))} セッションで使用</p></div><div class="versions">${rows}</div></section>`;
  };
  const body = [...inst, ...skills].map((g, i) => sec(g, i)).join('');
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
<div class="title"><h1>指示文と skill</h1><p class="lib-note">セッションに注入された指示文(AGENTS.md / CLAUDE.md / copilot-instructions.md 等)と、呼ばれた skill の本文を、重複なしで版ごとに置いたものです。版は内容のハッシュで区別し、見出し(と出所のパス)が同じものを 1 つの項目にまとめています。版は初回の利用日の順で、差分は 1 つ前の版との行単位の比較です。開いた状態にしてあるのは最後に使われた版です。生成 ${esc(dateTime(o.generatedAt))}。${
    o.groups.length ? '' : '指示文も skill の本文も記録にありませんでした。'
  }</p></div>
${body}
</main>
<footer class="wrap page-foot"><p>本文は <code>${LIBRARY_DIR}/&lt;版&gt;.md</code> にも置いてあります。秘密情報の形式検査で伏せた箇所は <code>[伏せました: 種類]</code> です。</p></footer>
</div>
</div>
<script>${NAV_JS}</script>
</body>
</html>
`;
}
