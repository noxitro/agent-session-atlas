// 版の目印の埋め込み(build.ts の embedCodeStamp): テンプレートの位置を目印に置き換え、位置が無ければ止める
import { describe, expect, it } from 'vitest';
import { CODE_PLACEHOLDER, embedCodeStamp } from '../src/build.ts';

describe('版の目印の埋め込み', () => {
  it('テンプレートの位置を目印に置き換える($ を含む値もそのまま入れる)', () => {
    const tpl = `<meta name="atlas-code" content="${CODE_PLACEHOLDER}"><script>__ATLAS_DATA__</script>`;
    expect(embedCodeStamp(tpl, '0123456789abcdef')).toBe('<meta name="atlas-code" content="0123456789abcdef"><script>__ATLAS_DATA__</script>');
    expect(embedCodeStamp(tpl, "$&$'")).toContain(`content="$&$'"`);
  });

  it('位置が無いテンプレート(目印の meta を足す前に作った dist など)では、黙って進まずに止める', () => {
    expect(() => embedCodeStamp('<script>__ATLAS_DATA__</script>', '0123456789abcdef')).toThrow(/版の目印の位置 __ATLAS_CODE__ がありません.*packages\/report\/dist を消してから/);
  });
});
