// メモの Markdown を HTML にする(Node 側)。marked の renderer を差し替えて、出力する属性と文字は全てここで esc する。
// メモの本文は共有する HTML にも載るので、生の HTML は文字として出し、リンクは http(s) と mailto だけ、画像は呼び元が解決したものだけにする。
import { Marked, type Tokens } from 'marked';
import { esc } from './detail.ts';

/** 節の h2 の下に入るので見出しは 2 段下げる */
const HEADING_SHIFT = 2;
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

/** image は本文の画像の参照を data: URI にする。無い・大きすぎる・置き場の外なら null */
export function renderMemoHtml(text: string, image: (href: string) => string | null): string {
  const m = new Marked({ gfm: true, breaks: true, async: false });
  m.use({
    renderer: {
      html(t: Tokens.HTML | Tokens.Tag): string {
        return 'block' in t && t.block ? `<p>${esc(t.text)}</p>\n` : esc(t.text);
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
        const n = Math.min(t.depth + HEADING_SHIFT, 6);
        return `<h${n}>${this.parser.parseInline(t.tokens)}</h${n}>\n`;
      },
      link(t: Tokens.Link): string {
        const label = this.parser.parseInline(t.tokens);
        return SAFE_LINK.test(t.href) ? `<a href="${esc(t.href)}" rel="noreferrer noopener">${label}</a>` : label;
      },
      image(t: Tokens.Image): string {
        const alt = t.text || 'メモの画像';
        if (HAS_SCHEME.test(t.href)) {
          const label = `外部の画像(読み込みません): ${alt}`;
          return SAFE_LINK.test(t.href) ? `<a href="${esc(t.href)}" rel="noreferrer noopener">${esc(label)}</a>` : esc(label);
        }
        const src = image(t.href);
        return src ? `<img src="${src}" alt="${esc(alt)}">` : `<span class="missing-value">画像を表示できません: ${esc(t.href)}</span>`;
      },
    },
  });
  return m.parse(text) as string;
}
