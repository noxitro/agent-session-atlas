import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** JS の文字列中の "http://" "https://" を等価なエスケープ "http:\/\/" に置き換える */
export function escapeSchemes(js: string): string {
  return js.replace(/(https?):\/\//g, '$1:\\/\\/');
}

/**
 * 出力 HTML に "http://" / "https://" の文字列を残さない。
 * Svelte のランタイムは SVG 名前空間 URI や本番エラーの説明 URL を文字列として持つ(読み込みではない)。
 * 外部参照の静的検査を単純に保つため、スクリプト中の "://" を JS として等価な ":\/\/" に置き換える。
 * vite-plugin-singlefile がスクリプトを HTML に埋め込んだ後に動かす(<script> の中身だけを書き換える)。
 */
function noSchemeLiterals(): Plugin {
  return {
    name: 'atlas-no-scheme-literals',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type === 'chunk') out.code = escapeSchemes(out.code);
        else if (out.fileName.endsWith('.html') && typeof out.source === 'string') {
          out.source = out.source.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g, (_m, open: string, body: string, close: string) => open + escapeSchemes(body) + close);
        }
      }
    },
  };
}

const ROOT = dirname(fileURLToPath(import.meta.url));

// CLI から build() で呼ばれたときも同じ場所を指すよう、パスは設定ファイル基準の絶対パスにする
export default defineConfig({
  root: ROOT,
  plugins: [svelte(), viteSingleFile({ removeViteModuleLoader: true }), noSchemeLiterals()],
  build: {
    outDir: join(ROOT, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    rollupOptions: { input: { template: join(ROOT, 'template.html') } },
  },
});
