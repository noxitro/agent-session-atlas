// ライト/ダークの切り替え(自動 = OS の設定に従う)。選択は localStorage に保存(使えなければ保存しないだけ)
export type ThemeChoice = 'auto' | 'light' | 'dark';
const KEY = 'atlas-theme';

export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(t: ThemeChoice): void {
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;
  try {
    if (t === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* 保存できない環境(プライベートウィンドウ等)では今回の表示にだけ反映する */
  }
}
