// Phase 6: 利用の内訳(ツールの成否・MCP・skill の trigger・行数)、インストール済みの記録、プロジェクトの統合
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeMetrics, unusedInstalledSkills } from '../src/metrics.ts';
import { normalizeSession } from '../src/normalize.ts';
import { ATLAS_JUDGE_PROJECT, gitConfigPath, HOME_PROJECT, originUrlFromConfig, ownerRepoFromUrl, ProjectResolver, TEMP_PROJECT } from '../src/project.ts';
import { readInventory } from '../src/snapshot.ts';
import type { CopilotEvent, InstalledInventory } from '../src/types.ts';

let n = 0;
const ev = (type: string, data: unknown, extra: Partial<CopilotEvent> = {}): CopilotEvent => ({
  type,
  data,
  timestamp: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 1000).toISOString(),
  id: `e${n++}`,
  ...extra,
});

describe('normalizeSession(Phase 6 の内訳)', () => {
  it('ツール別の成功・失敗・拒否、MCP サーバー別の呼び出し、skill の trigger を数える', async () => {
    const r = await normalizeSession({
      id: 's',
      events: [
        ev('user.message', { content: 'x' }),
        ev('tool.execution_start', { toolCallId: 'a', toolName: 'srv-search', mcpServerName: 'srv', arguments: {} }),
        ev('tool.execution_complete', { toolCallId: 'a', success: false, error: { code: 'failure' } }),
        ev('tool.execution_start', { toolCallId: 'b', toolName: 'srv-search', mcpServerName: 'srv', arguments: {} }),
        ev('tool.execution_complete', { toolCallId: 'b', success: true }),
        ev('tool.execution_start', { toolCallId: 'c', toolName: 'view', arguments: {} }),
        ev('tool.execution_complete', { toolCallId: 'c', success: false, error: { code: 'denied' } }),
        // 対応する start が無い complete はツール別に数えない(摩擦のツール失敗には数える)
        ev('tool.execution_complete', { toolCallId: 'zzz', success: false }),
        ev('tool.execution_start', { toolCallId: 'd', toolName: 'skill', arguments: { skill: 'k1' } }),
        ev('skill.invoked', { name: 'k1', trigger: 'user-invoked' }),
        ev('skill.invoked', { name: 'k2', trigger: 'agent-invoked' }),
        ev('skill.invoked_ref', { name: 'k3' }),
        ev('tool.execution_start', { toolCallId: 'e', toolName: 'skill', arguments: { skill: 'k4' } }),
      ],
    });
    expect(r.tools.mcp).toEqual({ srv: { 'srv-search': 2 } });
    expect(r.tools.results).toEqual({ 'srv-search': { success: 1, failure: 1, denied: 0 }, view: { success: 0, failure: 0, denied: 1 } });
    expect(r.friction.toolFailures).toBe(3);
    // ツール + イベントの組は event の trigger で上書き、ツールだけはモデルが呼んだもの(agent)、trigger の無いイベントは不明
    expect(r.skills.map((s) => [s.name, s.via, s.trigger])).toEqual([
      ['k1', 'both', 'user'],
      ['k2', 'event', 'agent'],
      ['k3', 'event', null],
      ['k4', 'tool', 'agent'],
    ]);
  });

  it('行数は codeChanges を持つ最後の shutdown を優先し、無ければ toolTelemetry の合計、どちらも無ければ none', async () => {
    const tools = [
      ev('tool.execution_start', { toolCallId: 'a', toolName: 'edit', arguments: { path: 'X:\\p\\a.ts' } }),
      ev('tool.execution_complete', { toolCallId: 'a', success: true, toolTelemetry: { metrics: { linesAdded: 5, linesRemoved: 2 } } }),
      ev('tool.execution_start', { toolCallId: 'b', toolName: 'edit', arguments: { path: 'X:\\p\\b.ts' } }),
      ev('tool.execution_complete', { toolCallId: 'b', success: true, toolTelemetry: { metrics: { linesAdded: 1 } } }),
    ];
    const withShutdown = await normalizeSession({
      id: 's1',
      events: [
        ...tools,
        ev('session.shutdown', { codeChanges: { linesAdded: 3, linesRemoved: 0, filesModified: [] } }),
        ev('session.resume', {}),
        ev('session.shutdown', { codeChanges: { linesAdded: 9, linesRemoved: 4, filesModified: [] } }),
        // 最後の shutdown に codeChanges が無いときは、その前の累計を使う
        ev('session.shutdown', { shutdownType: 'routine' }),
      ],
    });
    expect(withShutdown.lines).toEqual({ added: 9, removed: 4, source: 'shutdown' });
    const toolsOnly = await normalizeSession({ id: 's2', events: tools });
    expect(toolsOnly.lines).toEqual({ added: 6, removed: 2, source: 'tools' });
    const none = await normalizeSession({ id: 's3', events: [ev('user.message', { content: 'x' })] });
    expect(none.lines).toEqual({ added: 0, removed: 0, source: 'none' });
  });

  it('途中で削除したファイルが shutdown の filesModified に残っても「削除」のまま(要約は既にあるパスを上書きしない)', async () => {
    const r = await normalizeSession({
      id: 's',
      workspace: { cwd: 'X:\\p' },
      events: [
        ev('tool.execution_start', { toolCallId: 'a', toolName: 'edit', arguments: { path: 'a.ts' } }),
        ev('tool.execution_complete', { toolCallId: 'a', success: true, fileEdits: [{ path: 'X:\\p\\gone.txt', kind: 'delete' }] }),
        ev('session.shutdown', { codeChanges: { linesAdded: 1, linesRemoved: 1, filesModified: ['X:\\p\\gone.txt', 'X:\\p\\a.ts', 'X:\\p\\only-summary.ts'] } }),
      ],
    });
    expect(r.files).toEqual({ changed: ['X:\\p\\a.ts', 'X:\\p\\only-summary.ts'], created: [], deleted: ['X:\\p\\gone.txt'], sessionState: 0 });
  });
});

describe('computeMetrics(Phase 6)', () => {
  it('MCP・ツールの結果・skill の trigger・agent の失敗とトークン・行数・未使用の skill を集計する', async () => {
    const a = await normalizeSession({
      id: 'a',
      workspace: { repository: 'o/a', created_at: '2026-10-01T00:00:00Z' },
      events: [
        ev('user.message', { content: 'x' }),
        ev('tool.execution_start', { toolCallId: 't', toolName: 'srv-x', mcpServerName: 'srv', arguments: {} }),
        ev('tool.execution_complete', { toolCallId: 't', success: true }),
        ev('skill.invoked', { name: 'Wiki-Query', trigger: 'user-invoked' }),
        ev('subagent.started', { toolCallId: 's1', agentName: 'explore' }),
        ev('subagent.completed', { toolCallId: 's1', agentName: 'explore', totalTokens: 100 }),
        ev('subagent.started', { toolCallId: 's2', agentName: 'explore' }),
        ev('subagent.failed', { toolCallId: 's2', agentName: 'explore' }),
        ev('session.shutdown', { codeChanges: { linesAdded: 10, linesRemoved: 3, filesModified: [] } }),
      ],
    });
    const b = await normalizeSession({ id: 'b', workspace: { repository: 'o/a', created_at: '2026-10-02T00:00:00Z' }, events: [ev('user.message', { content: 'y' })] });
    const inv: InstalledInventory = {
      skills: ['wiki-query', 'impeccable'],
      plugins: [{ marketplace: 'm', name: 'p', skills: ['plug-skill', 'impeccable'] }],
      disabledSkills: ['impeccable'],
      warnings: [],
    };
    const m = computeMetrics([a, b], { installed: inv });
    expect(m.overall.tools.mcp).toEqual({ srv: 1 });
    expect(m.overall.tools.results).toEqual({ 'srv-x': { success: 1, failure: 0, denied: 0 } });
    expect(m.overall.skills.byTrigger).toEqual({ user: 1, agent: 0, unknown: 0 });
    expect(m.overall.agents.byNameDetail).toEqual({ explore: { runs: 2, failed: 1, tokens: 100 } });
    expect(m.overall.lines).toEqual({ added: 10, removed: 3, sessionsWithRecord: 1, bySource: { shutdown: 1, tools: 0, none: 1 } });
    // 名前は大文字小文字を区別せずに突き合わせ、プラグインの skill も含める(重複は 1 つ)
    expect(m.installedSkills).toEqual({ installed: ['impeccable', 'plug-skill', 'wiki-query'], disabled: ['impeccable'], unused: ['impeccable', 'plug-skill'] });
    expect(unusedInstalledSkills(inv, [])).toEqual(['impeccable', 'plug-skill', 'wiki-query']);
    expect(computeMetrics([a]).installedSkills).toBeNull();
  });
});

describe('readInventory', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atlas-inv-'));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('skills/ とプラグインのディレクトリ名、settings.json の disabledSkills だけを記録する', async () => {
    const home = join(dir, 'ok');
    await mkdir(join(home, 'skills', 'alpha'), { recursive: true });
    await mkdir(join(home, 'skills', 'beta'), { recursive: true });
    await writeFile(join(home, 'skills', 'README.txt'), 'not a skill');
    await mkdir(join(home, 'installed-plugins', 'market', 'plug', 'skills', 'gamma'), { recursive: true });
    await mkdir(join(home, 'installed-plugins', 'market', 'bare'), { recursive: true });
    await writeFile(join(home, 'settings.json'), JSON.stringify({ model: 'x', disabledSkills: ['beta', 3], secret: 'do-not-copy' }));
    const inv = await readInventory(home);
    expect(inv).toEqual({
      skills: ['alpha', 'beta'],
      plugins: [
        { marketplace: 'market', name: 'bare', skills: [] },
        { marketplace: 'market', name: 'plug', skills: ['gamma'] },
      ],
      disabledSkills: ['beta'],
      warnings: [],
    });
    expect(JSON.stringify(inv)).not.toContain('do-not-copy');
  });

  it('settings.json が壊れていれば disabledSkills は null にして理由を残す(黙って空にしない)', async () => {
    const home = join(dir, 'broken');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'settings.json'), '{ not json');
    const inv = await readInventory(home);
    expect(inv.disabledSkills).toBeNull();
    expect(inv.warnings.join()).toContain('settings.json');
    expect(inv.skills).toEqual([]);
  });
});

describe('プロジェクトの統合', () => {
  it('remote の URL から owner/repo を取り出す(https・scp 形式・ssh、ローカルは null)', () => {
    expect(ownerRepoFromUrl('https://github.com/acme/widget.git')).toBe('acme/widget');
    expect(ownerRepoFromUrl('https://github.com/acme/widget')).toBe('acme/widget');
    expect(ownerRepoFromUrl('git@github.com:acme/widget.git')).toBe('acme/widget');
    expect(ownerRepoFromUrl('ssh://git@example.com:2222/acme/widget.git')).toBe('acme/widget');
    expect(ownerRepoFromUrl('https://gitlab.example.com/group/sub/widget.git')).toBe('sub/widget');
    expect(ownerRepoFromUrl('X:\\repos\\widget')).toBeNull();
    expect(ownerRepoFromUrl('../widget')).toBeNull();
    expect(ownerRepoFromUrl('file:///srv/git/widget.git')).toBeNull();
  });

  it('.git/config の [remote "origin"] だけを読む', () => {
    const cfg = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/up/x.git\n[remote "origin"]\n\turl = git@github.com:me/x.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
    expect(originUrlFromConfig(cfg)).toBe('git@github.com:me/x.git');
    expect(originUrlFromConfig('[remote "upstream"]\n\turl = https://github.com/up/x.git\n')).toBeNull();
  });

  describe('git の設定を辿る', () => {
    let root: string;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'atlas-git-'));
      // 通常のリポジトリ
      await mkdir(join(root, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
      await writeFile(join(root, 'main', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/main.git\n');
      // worktree: .git ファイル → gitdir → commondir(../..)→ 共有の config
      await mkdir(join(root, 'wt'), { recursive: true });
      await writeFile(join(root, 'wt', '.git'), `gitdir: ${join(root, 'main', '.git', 'worktrees', 'wt')}\n`);
      await writeFile(join(root, 'main', '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
      // submodule 形式: gitdir に config がある(commondir 無し)。相対パス
      await mkdir(join(root, 'mods', 'sub'), { recursive: true });
      await writeFile(join(root, 'mods', 'sub', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/sub.git\n');
      await mkdir(join(root, 'subwt'), { recursive: true });
      await writeFile(join(root, 'subwt', '.git'), 'gitdir: ../mods/sub\n');
      // remote の無いリポジトリ
      await mkdir(join(root, 'local', '.git'), { recursive: true });
      await writeFile(join(root, 'local', '.git', 'config'), '[core]\n\tbare = false\n');
    });
    afterAll(async () => rm(root, { recursive: true, force: true }));

    it('worktree と submodule 形式の .git ファイルも共有の config まで辿る', () => {
      expect(gitConfigPath(join(root, 'main'))).toBe(join(root, 'main', '.git', 'config'));
      expect(gitConfigPath(join(root, 'wt'))).toBe(resolve(root, 'main', '.git', 'config'));
      expect(gitConfigPath(join(root, 'subwt'))).toBe(resolve(root, 'mods', 'sub', 'config'));
      expect(gitConfigPath(join(root, 'nothing'))).toBeNull();
      const r = new ProjectResolver({ homes: [], temps: [] });
      expect(r.remoteOf(join(root, 'main'))).toBe('acme/main');
      expect(r.remoteOf(join(root, 'wt'))).toBe('acme/main');
      expect(r.remoteOf(join(root, 'subwt'))).toBe('acme/sub');
      expect(r.remoteOf(join(root, 'local'))).toBeNull();
    });
  });

  describe('resolve の優先順', () => {
    // 一時フォルダの外に作業ツリーを置く(一時フォルダ配下は git より先に (一時フォルダ) になるため)
    const work = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'out', 'unit-phase6-project');
    beforeAll(async () => {
      await rm(work, { recursive: true, force: true });
      await mkdir(join(work, 'repo', '.git'), { recursive: true });
      await mkdir(join(work, 'repo', 'sub', 'deep'), { recursive: true });
      await writeFile(join(work, 'repo', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n');
    });
    afterAll(async () => rm(work, { recursive: true, force: true }));

    const r = new ProjectResolver({ homes: ['/home/someone'], temps: ['/scratch/tmp'] });
    // git の origin を読む確認用: 一時フォルダは temps に挙げたものだけ(リポジトリ自体を %TEMP% 配下に置いても work が一時フォルダ扱いにならない)
    const rGit = new ProjectResolver({ homes: ['/home/someone'], temps: ['/scratch/tmp'], tempPatterns: false });
    const s = (cwd: string | null, gitRoot: string | null = null, repository: string | null = null) => ({ cwd, gitRoot, repository });

    it('atlas の判定 > repository > 一時フォルダ > git の origin > ホーム > パス', () => {
      // judge の作業フォルダは repository があっても判定扱い(この形のフォルダはツール自身が作る)
      expect(r.resolve(s('/scratch/tmp/atlas-judge-cwd-AbC123', null, 'x/y'))).toEqual({ project: ATLAS_JUDGE_PROJECT, source: 'atlas-judge' });
      expect(r.resolve(s('X:\\home\\someone\\AppData\\Local\\Temp\\atlas-judge-cwd-Zz9'))).toEqual({ project: ATLAS_JUDGE_PROJECT, source: 'atlas-judge' });
      expect(r.resolve(s('/scratch/tmp/x', null, 'acme/r'))).toEqual({ project: 'acme/r', source: 'repository' });
      expect(r.resolve(s('/scratch/tmp/claude/x/scratchpad/probe', '/scratch/tmp/claude/x/scratchpad/probe'))).toEqual({ project: TEMP_PROJECT, source: 'temp' });
      expect(r.resolve(s('X:\\home\\someone\\AppData\\Local\\Temp'))).toEqual({ project: TEMP_PROJECT, source: 'temp' });
      expect(r.resolve(s('/tmp/probe'))).toEqual({ project: TEMP_PROJECT, source: 'temp' });
      expect(rGit.resolve(s(join(work, 'repo'), join(work, 'repo')))).toEqual({ project: 'acme/repo', source: 'git-remote' });
      // gitRoot の記録が無いときは cwd から上へ探す
      expect(rGit.resolve(s(join(work, 'repo', 'sub', 'deep')))).toEqual({ project: 'acme/repo', source: 'git-remote' });
      // tempPatterns: false なら既定のパターン(AppData\Local\Temp・/tmp)は一時フォルダにしない
      expect(rGit.resolve(s('/tmp/probe')).source).toBe('path');
      expect(rGit.resolve(s('/scratch/tmp/x')).source).toBe('temp');
      expect(r.resolve(s('/home/someone'))).toEqual({ project: HOME_PROJECT, source: 'home' });
      expect(r.resolve(s('/home/other/'))).toEqual({ project: HOME_PROJECT, source: 'home' });
      // ホームの下のフォルダはまとめない
      expect(r.resolve(s('/home/someone/notes')).source).toBe('path');
      expect(r.resolve(s('X:\\proj\\a', 'X:\\proj\\a'))).toEqual({ project: 'X:\\proj\\a', source: 'path' });
      expect(r.resolve(s(null))).toEqual({ project: '(unknown)', source: 'unknown' });
    });

    it('readGit: false なら git の設定を読まない', () => {
      const noGit = new ProjectResolver({ homes: [], temps: [], tempPatterns: false, readGit: false });
      expect(noGit.resolve(s(join(work, 'repo'), join(work, 'repo'))).source).toBe('path');
    });
  });
});
