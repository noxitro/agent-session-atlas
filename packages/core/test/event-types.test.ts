import { describe, expect, it } from 'vitest';
import { INTENTIONAL_UNKNOWN_TYPES } from '../../../scripts/synthetic-base.ts';
import { buildFixtures } from '../../../scripts/synthetic-fixtures.ts';
import { KNOWN_EVENT_TYPES } from '../src/event-types.ts';

/** 生成器が作る全セッションのイベント種別(壊れた行は飛ばす) */
function generatedTypes(): Set<string> {
  const out = new Set<string>();
  for (const s of buildFixtures().sessions) {
    for (const l of s.events) {
      try {
        out.add((JSON.parse(l) as { type: string }).type);
      } catch {
        // 099 の壊れた行
      }
    }
  }
  return out;
}

describe('KNOWN_EVENT_TYPES', () => {
  it('種別名の形(小文字・. 区切り)で、重複なく並んでいる', () => {
    const list = [...KNOWN_EVENT_TYPES];
    expect(list).toEqual([...list].sort());
    for (const t of list) expect(t).toMatch(/^[a-z_]+(\.[a-z_]+)*$/);
  });

  it('合成 fixture が使う種別は、意図した未知種別(099)を除いてすべて既知', () => {
    const types = generatedTypes();
    const unknown = [...types].filter((t) => !KNOWN_EVENT_TYPES.has(t)).sort();
    expect(unknown).toEqual([...INTENTIONAL_UNKNOWN_TYPES].sort());
    // 意図した未知種別が既知に入ってしまうと、未知種別の検査が空振りする
    for (const t of INTENTIONAL_UNKNOWN_TYPES) expect(KNOWN_EVENT_TYPES.has(t)).toBe(false);
    // 主な種別を合成 fixture が実際に使っている(生成器から消えると E2E の検査が空振りする)
    for (const t of ['session.shutdown', 'session.usage_record', 'session.compaction_complete', 'hook.start', 'skill.invoked', 'subagent.started', 'system.message', 'abort', 'permission.completed'])
      expect(types.has(t)).toBe(true);
  });
});
