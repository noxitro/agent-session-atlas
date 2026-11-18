// 評価バンドルを 1 つの ZIP にまとめる(atlas bundle --zip)。無圧縮の ZIP を、末尾のレコードから読み直して確かめる
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BundleEntry } from '../src/bundle.ts';
import { dosTimeNow, writeBundleZip } from '../src/zip.ts';

const manifest = (sessions: Partial<BundleEntry>[]) => ({ files: { instructions: 'INSTRUCTIONS.md', schema: 'schema.json' }, sessions: sessions as BundleEntry[] });

describe('評価バンドルの ZIP', () => {
  let d: string;
  beforeEach(async () => {
    d = await mkdtemp(join(tmpdir(), 'atlas-zip-'));
  });
  afterEach(async () => {
    await rm(d, { recursive: true, force: true });
  });

  it('CRC-32 は標準の検査値に合う', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('無圧縮の ZIP を書き、parts/ は入れない。前の ZIP は入れ替え、作りかけは残さない', async () => {
    const b = join(d, 'bundle');
    await mkdir(join(b, 'sessions'), { recursive: true });
    await mkdir(join(b, 'parts'), { recursive: true });
    await writeFile(join(b, 'INSTRUCTIONS.md'), '指示');
    await writeFile(join(b, 'manifest.json'), '{}');
    await writeFile(join(b, 'schema.json'), '{"a":1}');
    await writeFile(join(b, 'sessions', 's1.md'), '123456789');
    await writeFile(join(b, 'parts', 'part-01.md'), '入れない');
    const zip = join(d, 'bundle.zip');
    await writeFile(zip, '前の ZIP');
    const s = await writeBundleZip(b, manifest([{ id: 's1', path: 'sessions/s1.md' }]), zip, 'bundle', { date: 0x5b6f, time: 0x6000 });
    const bytes = await readFile(zip);
    expect(s).toEqual({ files: 4, bytes: bytes.length });
    expect(existsSync(join(d, 'bundle.zip.tmp'))).toBe(false);

    // 末尾のレコードから中央ディレクトリをたどり、名前・CRC・中身を確かめる
    const end = bytes.length - 22;
    expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
    expect(bytes.readUInt16LE(end + 10)).toBe(4);
    let at = bytes.readUInt32LE(end + 16);
    expect(at + bytes.readUInt32LE(end + 12)).toBe(end);
    const seen: [string, Buffer][] = [];
    for (let i = 0; i < 4; i++) {
      expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
      expect(bytes.readUInt16LE(at + 10)).toBe(0); // 無圧縮
      expect(bytes.readUInt16LE(at + 8)).toBe(0x0800); // 名前は UTF-8
      expect([bytes.readUInt16LE(at + 12), bytes.readUInt16LE(at + 14)]).toEqual([0x6000, 0x5b6f]);
      const [crc, size, nameLen, local] = [bytes.readUInt32LE(at + 16), bytes.readUInt32LE(at + 24), bytes.readUInt16LE(at + 28), bytes.readUInt32LE(at + 42)];
      const name = bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8');
      expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
      expect(bytes.subarray(local + 30, local + 30 + nameLen).toString('utf8')).toBe(name);
      const data = bytes.subarray(local + 30 + nameLen, local + 30 + nameLen + size);
      expect(crc32(data)).toBe(crc);
      seen.push([name, data]);
      at += 46 + nameLen;
    }
    expect(at).toBe(end);
    expect(seen.map(([n]) => n)).toEqual(['bundle/INSTRUCTIONS.md', 'bundle/manifest.json', 'bundle/schema.json', 'bundle/sessions/s1.md']);
    expect(seen[0][1].toString('utf8')).toBe('指示');
    expect(seen[3][1].toString('utf8')).toBe('123456789');
  });

  it('ファイルが欠けていたら作らず、前の ZIP を残す', async () => {
    const b = join(d, 'bundle');
    await mkdir(b, { recursive: true });
    const zip = join(d, 'bundle.zip');
    await writeFile(zip, '前の ZIP');
    await expect(writeBundleZip(b, manifest([]), zip, 'bundle', dosTimeNow())).rejects.toThrow(/INSTRUCTIONS\.md/);
    expect(await readFile(zip, 'utf8')).toBe('前の ZIP');
    expect(existsSync(join(d, 'bundle.zip.tmp'))).toBe(false);
  });

  it('更新日時は MS-DOS の形式(1980 年より前は 1980 年にする)', () => {
    expect(dosTimeNow(new Date(2025, 10, 15, 12, 0, 1))).toEqual({ date: (45 << 9) | (11 << 5) | 15, time: 12 << 11 });
    expect(dosTimeNow(new Date(1970, 0, 1, 0, 0, 0)).date >> 9).toBe(0);
  });
});
