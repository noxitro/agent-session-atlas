import { describe, expect, it } from 'vitest';
import { charCount, extractInstructionBlocks, fileFromPath, InstructionCollector, resolveInstructions } from '../src/instructions.ts';
import type { SessionRecord } from '../src/types.ts';

const wrap = (s: string): string => `<custom_instruction>\n${s}\n</custom_instruction>`;

describe('extractInstructionBlocks', () => {
  it('imported_custom_instruction の source でファイルを決め、外側の @import は CLAUDE.md の stub とみなす', () => {
    const body = '@AGENTS.md\n\n<imported_custom_instruction source="E:\\repo\\AGENTS.md">\n# Repo rules\nabc\n</imported_custom_instruction>';
    const blocks = extractInstructionBlocks(`head\n${wrap(body)}\ntail`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ file: 'AGENTS.md', method: 'imported-source', chars: charCount('# Repo rules\nabc'), sourcePath: 'E:\\repo\\AGENTS.md' });
    expect(blocks[1]).toMatchObject({ file: 'CLAUDE.md', method: 'import-stub' });
  });

  it('見出しのキーワードと applyTo 前置文で判定し、決まらないものは unknown', () => {
    const content = [
      wrap('# Copilot Instructions\n本文'),
      wrap('# Claude project instructions\nx'),
      wrap('This instruction applies to files matching the pattern: **/*.ts\n\nuse strict'),
      wrap('# 共通の指示\n𠮷野家'),
    ].join('\n\n');
    const b = extractInstructionBlocks(content);
    expect(b.map((x) => [x.file, x.method])).toEqual([
      ['copilot-instructions.md', 'heading-keyword'],
      ['CLAUDE.md', 'heading-keyword'],
      ['.github/instructions', 'apply-to'],
      ['unknown', 'unresolved'],
    ]);
    // サロゲートペア(𠮷)は 1 字
    expect(b[3].chars).toBe('# 共通の指示\n'.length + 3);
  });

  it('fileFromPath', () => {
    expect(fileFromPath('C:\\r\\.github\\instructions\\ts.instructions.md')).toBe('.github/instructions');
    expect(fileFromPath('/x/.github/copilot-instructions.md')).toBe('copilot-instructions.md');
    expect(fileFromPath('x/CLAUDE.md')).toBe('CLAUDE.md');
    expect(fileFromPath('x/README.md')).toBe('unknown');
  });
});

describe('InstructionCollector / resolveInstructions', () => {
  const session = (project: string, contents: string[]): SessionRecord => {
    const c = new InstructionCollector();
    for (const x of contents) c.add(x, '2026-01-01T00:00:00Z');
    return { project, instructions: c.result() } as unknown as SessionRecord;
  };

  it('同じ内容は 1 件にまとめて回数を数える', () => {
    const s = session('p', [wrap('# A\nx'), wrap('# A\nx'), wrap('# B\ny')]);
    expect(s.instructions.map((i) => i.injections)).toEqual([2, 1]);
  });

  it('見出しの学習と、3 プロジェクト以上の同一内容をユーザー単位とみなす', () => {
    const imported = wrap('<imported_custom_instruction source="C:\\r\\AGENTS.md">\n# Engine\nv1\n</imported_custom_instruction>');
    const s1 = session('r', [imported]);
    const s2 = session('r', [wrap('# Engine\nv2 changed')]);
    const global = wrap('# My global rules\nsame');
    const g = ['a', 'b', 'c'].map((p) => session(p, [global]));
    const lone = session('z', [wrap('# Lonely\nq')]);
    resolveInstructions([s1, s2, ...g, lone]);
    expect(s2.instructions[0]).toMatchObject({ file: 'AGENTS.md', method: 'learned-heading', scope: 'repo' });
    for (const s of g) expect(s.instructions[0]).toMatchObject({ file: 'copilot-instructions.md', method: 'cross-project', scope: 'user' });
    expect(lone.instructions[0]).toMatchObject({ file: 'unknown', method: 'unresolved' });
  });
});
