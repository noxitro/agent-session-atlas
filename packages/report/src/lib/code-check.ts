// 画面とサーバの版のずれ(core の code-stamp.ts)。画面(atlas.html と静的ページの NAV_JS)が同じ文で知らせる。
// ページに埋め込んだ目印(<meta name="atlas-code">)と、サーバが heartbeat の応答で返す目印(x-atlas-code)を比べる。
// どちらが前の版かは決めつけない。サーバが前のまま(atlas を更新した後に起動し直していない)のことも、ページが前のまま
// (前の版で作って残したページ、開いたままのタブ)のこともある。どちらも、サーバを止めて atlas.bat を実行し直せばそろう(ページを作り直し、サーバも起動し直す)。

export const STALE_MESSAGE =
  '画面とサーバの版が違います(この画面を作ったときと、サーバを起動したときとで、atlas のコードが違います)。atlas.bat の黒い窓を閉じてから、もう一度 atlas.bat を実行し、新しく開いた画面を使ってください(それまでは使えない操作があります。閲覧はそのままできます)。';

/**
 * サーバがページと違う版か。ページに目印が無い・置き換えていない(__ のまま)ときは比べない(false)。
 * サーバが目印を返さないのは、目印を返すようになる前の(古い)サーバなので、違う版とみなす
 */
export function isStaleServer(pageCode: string | null | undefined, serverCode: string | null): boolean {
  if (!pageCode || pageCode.startsWith('__')) return false;
  return serverCode !== pageCode;
}
