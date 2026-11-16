// ツールの失敗の要因(決まった規則で、文の 1 行目から分ける)。文はすべて架空のもの
import { describe, expect, it } from 'vitest';
import { normalizeSession } from '../src/normalize.ts';
import { addCauses, classifyToolFailure, FAILURE_CAUSE_HINTS, FAILURE_CAUSE_LABELS, FAILURE_CAUSES, isDeniedError, sortedCauses } from '../src/tool-failure.ts';
import type { CopilotEvent } from '../src/types.ts';

const fail = (message: string, code = 'failure') => ({ code, message });

describe('classifyToolFailure', () => {
  it.each([
    ['MCP server "zz": McpError: MCP error -32001: Request timed out', 'timeout'],
    ['LSP server for X:\\zz\\a.sln: Request "hover" timed out after 30000ms.', 'timeout'],
    ['timeout', 'timeout'],
    ["CAPIError: 429 Sorry, you've exceeded your 5 hour session limits.", 'quota'],
    ['402 You have exceeded your monthly quota', 'quota'],
    ['Error: Failed to fetch https://example.invalid/a - status code 404', 'network'],
    ['WebFetchRedirectError: web_fetch refused to follow redirect 301 from https://a.invalid to https://b.invalid', 'network'],
    ['WebFetchBlockedUrlError: Error: そのようなホストは不明です。 (os error 11001)', 'network'],
    ['web_fetch could not retrieve this URL: a transport-level failure (DNS, connection refused)', 'network'],
    ['rg: X:\\zz\\secret: アクセスが拒否されました。 (os error 5)', 'permission'],
    ['Blocked SQL statement: "DROP" is not allowed for security reasons.', 'permission'],
    ['Failed to apply patch: Error: Failed to find expected lines in X:\\zz\\a.ts:', 'no_match'],
    ['No match found', 'no_match'],
    ['Path does not exist', 'not_found'],
    ['Search paths do not exist: zz/src', 'not_found'],
    ['rg: zz\\docs: 指定されたファイルが見つかりません。 (os error 2)', 'not_found'],
    ['Failed to apply patch: Error: Failed to read file to update zz/a.ts: Error: ENOENT: no such file', 'not_found'],
    ['Tool "zz_tool" does not exist.', 'not_found'],
    ['Path already exists', 'exists'],
    ['rg: regex parse error:', 'invalid_input'],
    ['rg: unrecognized file type: zz', 'invalid_input'],
    ['"path": Required', 'invalid_input'],
    ['view_range out of bounds', 'invalid_input'],
    ['rg: a;b: IO error for operation on a;b: ファイル名、ディレクトリ名、またはボリューム ラベルの構文が間違っています。 (os error 123)', 'invalid_input'],
    ['Expected "," or "}" after property value in JSON at position 12 (line 1 column 13)', 'invalid_input'],
    ['No LSP clients available', 'unavailable'],
    ['Agent completed but produced no response.', 'no_response'],
    ['MCP server "zz": KeyError: "name"', 'tool_error'],
    ['MCP server "zz": {"isError":true,"code":"zz"}', 'other'],
    ['', 'other'],
  ])('%s → %s', (message, cause) => {
    expect(classifyToolFailure(fail(message))).toBe(cause);
  });

  it('見るのは空でない最初の行だけ。文字列の error と、failure 以外の error.code も読む', () => {
    expect(classifyToolFailure(fail('\n\nPath does not exist\nRequest timed out'))).toBe('not_found');
    expect(classifyToolFailure('Request timed out')).toBe('timeout');
    expect(classifyToolFailure({ code: 'timeout' })).toBe('timeout');
    expect(classifyToolFailure(null)).toBe('other');
    expect(classifyToolFailure({ code: 'failure' })).toBe('other');
  });

  it('拒否は error.code の denied と rejected', () => {
    expect(isDeniedError({ code: 'denied' })).toBe(true);
    expect(isDeniedError({ code: 'rejected', message: 'The user rejected this tool call.' })).toBe(true);
    expect(isDeniedError({ code: 'failure' })).toBe(false);
    expect(isDeniedError(undefined)).toBe(false);
  });

  it('要因ごとに名前と説明がある。足し合わせと並べ替え(多い順、同じなら表示の順)', () => {
    for (const c of FAILURE_CAUSES) {
      expect(FAILURE_CAUSE_LABELS[c]).toBeTruthy();
      expect(FAILURE_CAUSE_HINTS[c]).toBeTruthy();
    }
    expect(addCauses({ timeout: 1 }, { timeout: 2, other: 1 })).toEqual({ timeout: 3, other: 1 });
    expect(sortedCauses({ other: 2, timeout: 2, not_found: 5, quota: 0 })).toEqual([
      ['not_found', 5],
      ['timeout', 2],
      ['other', 2],
    ]);
  });
});

describe('normalizeSession の失敗の要因', () => {
  let n = 0;
  const ev = (type: string, data: unknown): CopilotEvent => ({ type, data, id: `e${n++}`, timestamp: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 1000).toISOString() });
  const call = (id: string, toolName: string, error: unknown, extra: Record<string, unknown> = {}): CopilotEvent[] => [
    ev('tool.execution_start', { toolCallId: id, toolName, arguments: {}, ...extra }),
    ev('tool.execution_complete', error === null ? { toolCallId: id, success: true } : { toolCallId: id, success: false, error }),
  ];

  it('ツールごとに、失敗を要因別に数える。文は残さない。rejected は拒否に数える', async () => {
    const r = await normalizeSession({
      id: 'zz-cause',
      workspace: { cwd: 'X:\\zz', created_at: '2026-10-01T00:00:00Z' },
      events: [
        ev('user.message', { content: 'a' }),
        ...call('1', 'zz-srv-find', fail('MCP server "zz-srv": McpError: MCP error -32001: Request timed out'), { mcpServerName: 'zz-srv' }),
        ...call('2', 'zz-srv-find', fail('MCP server "zz-srv": McpError: MCP error -32001: Request timed out'), { mcpServerName: 'zz-srv' }),
        ...call('3', 'zz-srv-find', null, { mcpServerName: 'zz-srv' }),
        ...call('4', 'view', fail('Path does not exist')),
        ...call('5', 'view', fail('view_range out of bounds')),
        ...call('6', 'powershell', { code: 'rejected', message: 'The user rejected this tool call.' }),
      ],
    });
    expect(r.tools.results).toEqual({
      'zz-srv-find': { success: 1, failure: 2, denied: 0, causes: { timeout: 2 } },
      view: { success: 0, failure: 2, denied: 0, causes: { not_found: 1, invalid_input: 1 } },
      powershell: { success: 0, failure: 0, denied: 1 },
    });
    expect(JSON.stringify(r.tools)).not.toContain('Path does not exist');
    expect(r.analysis.turnStats?.[0]).toMatchObject({ toolFailures: 4, denied: 1 });
  });
});
