/** 表示用のプロジェクト名: ホームディレクトリを ~ に短縮する */
export function shortProjectLabel(key: string): string {
  return key.replace(/^[A-Za-z]:\Users\[^\]+/i, '~').replace(/^\/(?:Users|home)\/[^/]+/, '~');
}
