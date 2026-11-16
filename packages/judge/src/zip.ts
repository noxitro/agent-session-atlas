// 評価バンドルを 1 つの ZIP にまとめる(atlas bundle --zip)。
// フォルダやファイルを読めるエージェント(GitHub Copilot CLI、ローカルの LLM など)に 1 ファイルで渡すためのもの。
// 圧縮はしない(無圧縮の ZIP は CRC-32 だけで書ける。CRC-32 は node:zlib のものを使い、依存を増やさない)。ZIP64 は書かないので、
// ファイルが 65,535 個、全体が 4 GB を超えるときは作らずに止める。
// 入れるのは INSTRUCTIONS.md・manifest.json・schema.json・sessions/ だけ(parts/ は sessions/ と同じ中身なので入れない)。
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import type { BundleManifest } from './bundle.ts';

/** ZIP に書く更新日時(MS-DOS の形式) */
export interface DosTime {
  date: number;
  time: number;
}

/** 今の日時(ローカル時刻。MS-DOS の形式は 1980〜2107 年だけを表せる) */
export function dosTimeNow(n: Date = new Date()): DosTime {
  const year = Math.min(Math.max(n.getFullYear(), 1980), 2107) - 1980;
  return { date: (year << 9) | ((n.getMonth() + 1) << 5) | n.getDate(), time: (n.getHours() << 11) | (n.getMinutes() << 5) | Math.floor(n.getSeconds() / 2) };
}

export interface ZipSummary {
  files: number;
  bytes: number;
}

const U32_MAX = 0xffff_ffff;
const U16_MAX = 0xffff;

/**
 * ローカルヘッダと中央ディレクトリで同じ並びの部分(展開に要るバージョン 〜 拡張フィールドの長さの手前。24 バイト)。
 * ファイル名は UTF-8(汎用フラグの bit 11)
 */
function common(stamp: DosTime, crc: number, size: number, nameLen: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt16LE(20, 0);
  b.writeUInt16LE(0x0800, 2);
  b.writeUInt16LE(0, 4); // 無圧縮
  b.writeUInt16LE(stamp.time, 6);
  b.writeUInt16LE(stamp.date, 8);
  b.writeUInt32LE(crc, 10);
  b.writeUInt32LE(size, 14);
  b.writeUInt32LE(size, 18);
  return Buffer.concat([b, u16(nameLen)]);
}

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
};

const TOO_BIG = 'ZIP が 4 GB を超えます。--since や --unjudged で対象を絞ってください';

/**
 * bundleDir の中身を zipPath に書く。ZIP の中では root フォルダの下に置く(展開するとフォルダが 1 つできる)。
 * 作りかけは別の名前に書いてから入れ替えるので、途中で失敗しても前の ZIP は残る
 */
export async function writeBundleZip(bundleDir: string, manifest: Pick<BundleManifest, 'files' | 'sessions'>, zipPath: string, root: string, stamp: DosTime = dosTimeNow()): Promise<ZipSummary> {
  const names = [manifest.files.instructions, 'manifest.json', manifest.files.schema, ...manifest.sessions.map((e) => e.path)];
  if (names.length > U16_MAX) throw new Error(`ZIP に入れるファイルが多すぎます(${names.length} 個。上限 65,535 個)。--since や --unjudged で対象を絞ってください`);

  const tmp = `${zipPath}.tmp`;
  let bytes: number;
  try {
    let fh;
    try {
      fh = await open(tmp, 'w');
    } catch (e) {
      throw new Error(`${tmp} を作れません: ${(e as Error).message}`);
    }
    try {
      let offset = 0;
      const central: { name: Buffer; crc: number; size: number; offset: number }[] = [];
      for (const rel of names) {
        const p = join(bundleDir, ...rel.split('/'));
        let data: Buffer;
        try {
          data = await readFile(p);
        } catch (e) {
          throw new Error(`${p} を読めません: ${(e as Error).message}`);
        }
        const name = Buffer.from(`${root}/${rel}`, 'utf8');
        const next = offset + 30 + name.length + data.length;
        if (next > U32_MAX) throw new Error(TOO_BIG);
        const crc = crc32(data);
        await fh.write(Buffer.concat([u32(0x0403_4b50), common(stamp, crc, data.length, name.length), u16(0) /* 拡張フィールドの長さ */, name]));
        await fh.write(data);
        central.push({ name, crc, size: data.length, offset });
        offset = next;
      }
      const cdStart = offset;
      for (const c of central) {
        // 作成したバージョン、共通の部分、拡張フィールド・コメントの長さ・ディスク番号・内部属性(各 2 バイト)と外部属性(4 バイト)
        await fh.write(Buffer.concat([u32(0x0201_4b50), u16(20), common(stamp, c.crc, c.size, c.name.length), Buffer.alloc(12), u32(c.offset), c.name]));
        offset += 46 + c.name.length;
      }
      if (offset > U32_MAX) throw new Error(TOO_BIG);
      // 終わりのレコード: ディスク番号(4 バイト)、このディスクと全体のファイルの数、中央ディレクトリの大きさと場所、コメントの長さ
      await fh.write(Buffer.concat([u32(0x0605_4b50), Buffer.alloc(4), u16(central.length), u16(central.length), u32(offset - cdStart), u32(cdStart), u16(0)]));
      await fh.sync();
      bytes = offset + 22;
    } finally {
      await fh.close();
    }
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  try {
    await rename(tmp, zipPath);
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`${zipPath} に書けません: ${(e as Error).message}`);
  }
  return { files: names.length, bytes };
}
