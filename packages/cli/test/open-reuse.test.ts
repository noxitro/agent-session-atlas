// atlas open: 前に集計したときから何も変わっていなければ、作り直さずにそのときのレポートを使う(open-reuse.ts)
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_MANIFEST, SNAPSHOT_SOURCE } from '../../core/src/index.ts';
import { canReuse, clearBuilt, inputsKey, outputsOf, readBuilt, writeBuilt, type ReusePaths } from '../src/open-reuse.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function setup(): { p: ReusePaths; config: string; built: string; session: string } {
  dir = mkdtempSync(join(tmpdir(), 'atlas-open-reuse-'));
  const out = join(dir, 'out');
  const snapshot = join(out, 'snapshot');
  const session = join(snapshot, 'session-state', 's1');
  mkdirSync(join(session, 'files'), { recursive: true });
  writeFileSync(join(session, 'events.jsonl'), '{"type":"x"}\n');
  writeFileSync(join(session, 'files', 'a.txt'), 'a');
  writeFileSync(
    join(snapshot, SNAPSHOT_MANIFEST),
    JSON.stringify({ createdAt: '2026-11-01T00:00:00.000Z', sourceRoot: 'X:\\logs', sessions: { dirs: 1, copiedFiles: 2, reusedFiles: 0, dbCopied: 1, dbReused: 0 } }),
  );
  writeFileSync(join(snapshot, SNAPSHOT_SOURCE), JSON.stringify({ sourceRoot: 'X:\\logs', startedAt: '2026-11-01T00:00:00.000Z' }));
  for (const f of ['atlas.html', 'sessions.json', 'metrics.json']) writeFileSync(join(out, f), f);
  const config = join(dir, 'atlas.config.json');
  writeFileSync(config, '{}');
  const p: ReusePaths = { out, snapshot, judgments: join(out, 'judgments.json'), turnJudgments: join(out, 'turn-judgments.json'), groups: join(dir, 'notes', 'groups.json') };
  return { p, config, built: join(dir, 'built.json'), session };
}

const OPTS = { since: null, project: null };

describe('open-reuse: 入力の印', () => {
  it('何も変わらなければ同じ。集計のたびに変わるもの(manifest の作った日時・始めたときの印)では変わらない', () => {
    const { p, config } = setup();
    const key = inputsKey(p, OPTS, config);
    expect(inputsKey(p, OPTS, config)).toBe(key);
    // 1 回目は「写した数」、2 回目からは「前の複製を使った数」に入る(元は同じ)
    writeFileSync(
      join(p.snapshot, SNAPSHOT_MANIFEST),
      JSON.stringify({ createdAt: '2026-11-12T00:00:00.000Z', sourceRoot: 'X:\\logs', sessions: { dirs: 1, copiedFiles: 0, reusedFiles: 2, dbCopied: 0, dbReused: 1 } }),
    );
    writeFileSync(join(p.snapshot, SNAPSHOT_SOURCE), JSON.stringify({ sourceRoot: 'X:\\logs', startedAt: '2026-11-12T00:00:00.000Z' }));
    expect(inputsKey(p, OPTS, config)).toBe(key);
  });

  it('写した複製・manifest・オプション・設定・判定・タスクタグのどれかが変われば変わる', () => {
    const { p, config, session } = setup();
    const keys = new Set<string>([inputsKey(p, OPTS, config)]);
    const changed = (what: string): void => {
      const k = inputsKey(p, OPTS, config);
      expect(keys.has(k), what).toBe(false);
      keys.add(k);
    };
    appendFileSync(join(session, 'events.jsonl'), '{"type":"y"}\n');
    changed('ファイルの大きさ');
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(session, 'events.jsonl'), past, past);
    changed('ファイルの更新日時');
    writeFileSync(join(session, 'files', 'b.txt'), 'b');
    changed('ファイルが増えた');
    rmSync(join(session, 'files', 'a.txt'));
    changed('ファイルが減った');
    writeFileSync(join(p.snapshot, SNAPSHOT_MANIFEST), JSON.stringify({ createdAt: '2026-11-01T00:00:00.000Z', sourceRoot: 'X:\\logs', sessions: { dirs: 2 } }));
    changed('manifest の中身');
    writeFileSync(config, '{"wikis":[]}');
    changed('設定ファイル');
    writeFileSync(p.judgments, '{}');
    changed('判定');
    writeFileSync(p.turnJudgments, '{}');
    changed('依頼ごとの判定');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(p.groups, '{}');
    changed('タスクタグ');
    expect(keys.has(inputsKey(p, { ...OPTS, since: '2026-11-01' }, config))).toBe(false);
    // 設定ファイルが無いときも止まらない(中身が空として数える)
    expect(typeof inputsKey(p, OPTS, join(dir, 'no-such.json'))).toBe('string');
  });
});

describe('open-reuse: 使い回せるか', () => {
  it('入力の印が同じで、出力がそのときのままなら使い回す。印が違う・出力が書き換わった・無い・印が無いときは作り直す', () => {
    const { p, config, built } = setup();
    const key = inputsKey(p, OPTS, config);
    expect(canReuse(readBuilt(built), key, p.out)).toBe(false); // 初めて
    writeBuilt(built, key, p.out);
    const prev = readBuilt(built);
    expect(prev).toMatchObject({ version: 1, key, outputs: outputsOf(p.out) });
    expect(canReuse(prev, key, p.out)).toBe(true);
    expect(canReuse(prev, `${key}x`, p.out)).toBe(false);
    // 別の処理(画面の「集計し直す」・判定・手で実行した export)がレポートを書き換えた
    appendFileSync(join(p.out, 'atlas.html'), '<!-- rebuilt -->');
    expect(canReuse(prev, key, p.out)).toBe(false);
    writeBuilt(built, key, p.out);
    expect(canReuse(readBuilt(built), key, p.out)).toBe(true);
    rmSync(join(p.out, 'metrics.json'));
    expect(outputsOf(p.out)).toBeNull();
    expect(canReuse(readBuilt(built), key, p.out)).toBe(false);
  });

  it('出力が揃っていなければ印を書かない。壊れた印・消した印は、無いものとして扱う', () => {
    const { p, config, built } = setup();
    const key = inputsKey(p, OPTS, config);
    rmSync(join(p.out, 'atlas.html'));
    writeBuilt(built, key, p.out);
    expect(readBuilt(built)).toBeNull();
    writeFileSync(built, '{"version":1,"key":');
    expect(readBuilt(built)).toBeNull();
    writeFileSync(built, JSON.stringify({ version: 2, key, outputs: {}, builtAt: 'x' }));
    expect(readBuilt(built)).toBeNull();
    clearBuilt(built);
    clearBuilt(built); // 無くても止まらない
    expect(readBuilt(built)).toBeNull();
  });
});
