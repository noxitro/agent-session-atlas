// 中身があふれてスクロールする枠(表の横スクロール・長いメッセージ)にキーボードで届くよう、あふれているときだけ tabindex="0" を付ける
// (WCAG 2.1.1。あふれていない枠に付けると Tab の止まり先が無駄に増えるので外す)。静的なページは page-nav.ts の NAV_JS が同じことをする
export const SCROLLERS = '.table-scroll, blockquote.msg';
