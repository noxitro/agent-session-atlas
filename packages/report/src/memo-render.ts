// Markdown を HTML にする(Node 側)。marked の renderer を差し替えて、出力する属性と文字は全てここで esc する。
// メモの本文は共有する HTML にも載るので、生の HTML は文字として出し、リンクは http(s) と mailto だけ、画像は呼び元が解決したものだけにする。
// Phase 14: 同じ規則で、atlas serve がセッション記録・全文記録(.md)を画面に描く(viewer.ts)。見出しの段・相対リンクの扱い・見出しの id だけを呼び元が選ぶ。
import { Marked, type Tokens } from 'marked';
import { esc } from './detail.ts';

/** 節の h2 の下に入るので見出しは 2 段下げる(メモの既定) */
const MEMO_HEADING_SHIFT = 2;
const SAFE_LINK = /^(https?:|mailto:)/i;
const HAS_SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** メモの本文の見た目(メモのあるページにだけ入れる。編集の script も同じものを入れる) */
export const MEMO_CSS = `
.memo-body{padding:10px 12px;background:var(--surface);border:1px solid var(--rule);overflow-wrap:anywhere;font-size:.875rem;line-height:1.7}
.memo-body>:first-child{margin-top:0}
.memo-body>:last-child{margin-bottom:0}
.memo-body h3,.memo-body h4,.memo-body h5,.memo-body h6{margin:12px 0 4px;font-size:.875rem;line-height:1.5}
.memo-body h3{font-size:1rem}
.memo-body img{display:block;max-width:100%;height:auto;margin:8px 0;border:1px solid var(--rule)}
.memo-body pre{overflow:auto;padding:8px 10px;border:1px solid var(--rule);font-family:var(--mono);font-size:.8125rem}
.memo-body code{font-family:var(--mono)}
.memo-body blockquote{margin:8px 0;padding-left:10px;border-left:2px solid var(--rule-strong);color:var(--ink-2)}
.memo-body table{border-collapse:collapse}
.memo-body th,.memo-body td{border:1px solid var(--rule);padding:3px 8px}
`;

export interface SafeMarkdownOptions {
  /** 本文の画像の参照(スキームの無いもの)を src にする。無い・大きすぎる・置き場の外なら null */
  image: (href: string) => string | null;
  /** 見出しを何段下げるか(既定 2: メモは節の h2 の下に入る) */
  headingShift?: number;
  /** 下げた後の見出しの最小の段(既定 1)。ページの h1 を表題に取っておくときは 2 */
  headingMin?: number;
  /** スキームの無いリンク(相対パス)を href にする。null なら文字だけ(既定は全て文字だけ) */
  relativeLink?: (href: string) => string | null;
  /** この段(下げた後)の見出しに id(h-1, h-2, …)を付け、目次用に返す */
  headingIdLevel?: number;
  /**
   * 生の HTML のうち、属性の無いこの名前のタグ(<small> と </small> の形そのもの)だけはタグとして残す(記録の表示で、atlas 自身が書く small / details / summary)。
   * 他は全て文字のまま。esc した後で `&lt;small&gt;` の形だけを戻すので、属性やイベントは入りようがない
   */
  allowTags?: readonly string[];
}

export interface SafeMarkdown {
  html: string;
  /** headingIdLevel の見出し(id と本文の文字) */
  headings: { id: string; text: string }[];
}

/** 見出しの文字(目次用): inline の印を落とした素の文字 */
function plainText(tokens: Tokens.Generic[] | undefined, fallback: string): string {
  if (!tokens) return fallback;
  return tokens.map((t) => ('tokens' in t && t.tokens ? plainText(t.tokens as Tokens.Generic[], String(t.text ?? '')) : String(t.text ?? t.raw ?? ''))).join('');
}

export function renderSafeMarkdown(text: string, o: SafeMarkdownOptions): SafeMarkdown {
  const shift = o.headingShift ?? MEMO_HEADING_SHIFT;
  const headings: SafeMarkdown['headings'] = [];
  const m = new Marked({ gfm: true, breaks: true, async: false });
  m.use({
    renderer: {
      html(t: Tokens.HTML | Tokens.Tag): string {
        let s = esc(t.text);
        for (const tag of o.allowTags ?? []) s = s.replaceAll(`&lt;${tag}&gt;`, `<${tag}>`).replaceAll(`&lt;/${tag}&gt;`, `</${tag}>`);
        if (!('block' in t && t.block)) return s;
        // details の開始・終了の塊は段落で包まない(<p><details> は入れ子として成り立たない)
        return /^\s*<\/?details>/.test(s) ? `${s}\n` : `<p>${s}</p>\n`;
      },
      text(t: Tokens.Text | Tokens.Escape): string {
        return 'tokens' in t && t.tokens ? this.parser.parseInline(t.tokens) : esc(t.text);
      },
      codespan(t: Tokens.Codespan): string {
        return `<code>${esc(t.text)}</code>`;
      },
      code(t: Tokens.Code): string {
        return `<pre><code>${esc(t.text)}</code></pre>\n`;
      },
      heading(t: Tokens.Heading): string {
        const n = Math.min(Math.max(t.depth + shift, o.headingMin ?? 1), 6);
        let id = '';
        if (o.headingIdLevel === n) {
          const hid = `h-${headings.length + 1}`;
          headings.push({ id: hid, text: plainText(t.tokens as Tokens.Generic[], t.text).trim() });
          id = ` id="${hid}"`;
        }
        return `<h${n}${id}>${this.parser.parseInline(t.tokens)}</h${n}>\n`;
      },
      link(t: Tokens.Link): string {
        const label = this.parser.parseInline(t.tokens);
        if (SAFE_LINK.test(t.href)) return `<a href="${esc(t.href)}" rel="noreferrer noopener">${label}</a>`;
        if (!HAS_SCHEME.test(t.href) && o.relativeLink) {
          const href = o.relativeLink(t.href);
          if (href) return `<a href="${esc(href)}">${label}</a>`;
        }
        return label;
      },
      image(t: Tokens.Image): string {
        const alt = t.text || 'メモの画像';
        if (HAS_SCHEME.test(t.href)) {
          const label = `外部の画像(読み込みません): ${alt}`;
          return SAFE_LINK.test(t.href) ? `<a href="${esc(t.href)}" rel="noreferrer noopener">${esc(label)}</a>` : esc(label);
        }
        const src = o.image(t.href);
        return src ? `<img src="${esc(src)}" alt="${esc(alt)}">` : `<span class="missing-value">画像を表示できません: ${esc(t.href)}</span>`;
      },
    },
  });
  return { html: m.parse(text) as string, headings };
}

/** メモの本文(見出しは h3 から)。image は本文の画像の参照を data: URI にする。無い・大きすぎる・置き場の外なら null */
export function renderMemoHtml(text: string, image: (href: string) => string | null): string {
  return renderSafeMarkdown(text, { image }).html;
}
