// 画面とサーバの版のずれ(core の code-stamp.ts)。画面(atlas.html と静的ページの NAV_JS)が同じ文で知らせる。
// ページに埋め込んだ目印(<meta name="atlas-code">)と、サーバが heartbeat の応答で返す目印(x-atlas-code)を比べる。

export const STALE_MESSAGE =
  '画面とサーバの版が違います(atlas を更新した後に、サーバを起動し直していません)。atlas.bat の黒い窓を閉じてから、もう一度 atlas.bat を実行してください(それまでは使えない操作があります。閲覧はそのままできます)。';

/**
 * サーバがページと違う版か。ページに目印が無い・置き換えていない(__ のまま)ときは比べない(false)。
 * サーバが目印を返さないのは、目印を返すようになる前の(古い)サーバなので、違う版とみなす
 */
export function isStaleServer(pageCode: string | null | undefined, serverCode: string | null): boolean {
  if (!pageCode || pageCode.startsWith('__')) return false;
  return serverCode !== pageCode;
}
