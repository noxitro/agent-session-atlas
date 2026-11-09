// ブラウザの「戻る」「進む」で atlas.html に戻ったとき、離れたときの見た目(スクロール位置・セッション一覧のページと並べ替え)に戻す。
// 絞り込みは URL の # に残るので戻るが、スクロール位置はブラウザが戻そうとする時点ではまだ画面を描いておらず(ページが短い)、
// 一覧のページと並べ替えはどこにも残していなかったため、詳細ページから戻ると先頭・1 ページ目に戻っていた。
// 離れるとき(pagehide)にその履歴の項目(history.state)へ書き、戻る / 進むで開かれたときだけ読む(普通に開き直したときは使わない)。
const KEY = 'atlasView';

export interface ViewState {
  /** 離れたときの縦のスクロール位置 */
  y?: number;
  /** セッション一覧の並べ替えとページ */
  table?: { sortKey: string; asc: boolean; page: number };
}

function navType(): string | null {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav?.type ?? null;
  } catch {
    return null;
  }
}

function readState(): ViewState | null {
  try {
    const s = (history.state as Record<string, unknown> | null)?.[KEY];
    return s && typeof s === 'object' ? (s as ViewState) : null;
  } catch {
    return null;
  }
}

/** 戻る / 進むで開かれたときの、離れたときの見た目(読み込みの最初に 1 回だけ読む。以後は null) */
// 再読み込み(reload)も同じ: ブラウザが戻すスクロール位置は、描く前のページの短さで先頭に切り詰められる
const initial: ViewState | null = navType() === 'back_forward' || navType() === 'reload' ? readState() : null;
let used = false;

export function restoredView(): ViewState | null {
  return used ? null : initial;
}

/** 戻す処理を済ませた(後から描き直しても、もう一度は戻さない) */
export function restoreDone(): void {
  used = true;
}

/** 離れるときの見た目を、今の履歴の項目に足す(ほかの値は残す) */
export function saveView(part: ViewState): void {
  try {
    const cur = (history.state as Record<string, unknown> | null) ?? {};
    const prev = (cur[KEY] as ViewState | undefined) ?? {};
    history.replaceState({ ...cur, [KEY]: { ...prev, ...part } }, '');
  } catch {
    /* file:// などで履歴を書けない環境では戻さないだけ */
  }
}
