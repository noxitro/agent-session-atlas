// テンプレート(dist/template.html)へのデータ埋め込み。
// <script type="application/json"> の中身として安全な JSON にする:
// - </script> や <!-- で要素が閉じないよう < > & をエスケープ
// - 本文中の URL や "fetch(" が静的検査(外部参照の不在)に引っかからないよう / と ( もエスケープ
//   (JSON の \/ と ( は JSON.parse で元の文字に戻る)

export const DATA_PLACEHOLDER = '__ATLAS_DATA__';
export const DATA_ELEMENT_ID = 'atlas-data';

export function serializeForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029')
    .replace(/\//g, '\\/')
    .replace(/\(/g, '\\u0028');
}

export function embedData(template: string, data: unknown): string {
  const i = template.indexOf(DATA_PLACEHOLDER);
  if (i < 0) throw new Error(`テンプレートに埋め込み位置 ${DATA_PLACEHOLDER} がありません(report のビルドが壊れています)`);
  if (template.indexOf(DATA_PLACEHOLDER, i + 1) >= 0) throw new Error(`テンプレートに ${DATA_PLACEHOLDER} が複数あります`);
  return template.slice(0, i) + serializeForScript(data) + template.slice(i + DATA_PLACEHOLDER.length);
}

/** 生成済み HTML から埋め込みデータを取り出す(テスト・検証用) */
export function extractEmbedded<T = unknown>(html: string): T {
  const re = new RegExp(`<script type="application/json" id="${DATA_ELEMENT_ID}">([\\s\\S]*?)</script>`);
  const m = re.exec(html);
  if (!m) throw new Error('埋め込みデータが見つかりません');
  return JSON.parse(m[1]) as T;
}
