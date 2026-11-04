// 画面(Svelte)側: lib/scroll-focus.ts の SCROLLERS に、あふれているときだけ tabindex="0" を付ける(静的なページは page-nav.ts の NAV_JS)
import { SCROLLERS } from '../lib/scroll-focus.ts';

export function syncScrollFocus(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(SCROLLERS).forEach((el) => {
    const over = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    if (over && !el.hasAttribute('tabindex')) {
      el.tabIndex = 0;
      el.setAttribute('data-scroll-focus', '');
    } else if (!over && el.hasAttribute('data-scroll-focus')) {
      el.removeAttribute('tabindex');
      el.removeAttribute('data-scroll-focus');
    }
  });
}

/** 描画の変化(絞り込み・タブの切り替え・ページ送り)と幅の変化のたびに付け直す。戻り値で止める */
export function watchScrollFocus(root: HTMLElement): () => void {
  let queued = false;
  const run = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      syncScrollFocus(root);
    });
  };
  const mo = new MutationObserver(run);
  mo.observe(root, { childList: true, subtree: true });
  addEventListener('resize', run);
  syncScrollFocus(root);
  return () => {
    mo.disconnect();
    removeEventListener('resize', run);
  };
}
