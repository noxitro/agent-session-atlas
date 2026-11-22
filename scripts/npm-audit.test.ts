// scripts/npm-audit.mjs の判定(npm audit の JSON と npm-audit-ignore.json から、止めるもの・除外したもの・外してよい除外を出す)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditError, decide, parseIgnoreList } from './npm-audit.mjs';

const advisory = (name: string, id: string, severity: string) => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} の架空の脆弱性`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: '<=1.0.0',
});

// npm audit --json(auditReportVersion 2)の形。via の文字列は依存を通して入る印で、advisory はオブジェクトの方
const report = (...vias: ReturnType<typeof advisory>[]) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    ...Object.fromEntries(vias.map((v) => [v.name, { name: v.name, severity: v.severity, via: [v] }])),
    'uses-them': { name: 'uses-them', severity: 'high', via: vias.map((v) => v.name) },
  },
  metadata: {},
});

const HIGH = advisory('alpha', 'GHSA-2222-3333-4444', 'high');
const MOD = advisory('beta', 'GHSA-5555-6666-7777', 'moderate');
const ignore = (id: string, pkg: string) => ({ id, package: pkg, reason: '届く経路が無い', removeWhen: '修正版が出たら' });

describe('decide', () => {
  it('除外に無い high は止める', () => {
    const r = decide(report(HIGH), []);
    expect(r.failing.map((a) => [a.id, a.package, a.severity])).toEqual([['GHSA-2222-3333-4444', 'alpha', 'high']]);
    expect(r.ignoredHits).toEqual([]);
  });

  it('除外に書いた advisory は止めず、除外したものとして出す', () => {
    const r = decide(report(HIGH), [ignore('GHSA-2222-3333-4444', 'alpha')]);
    expect(r.failing).toEqual([]);
    expect(r.ignoredHits.map((a) => [a.id, a.reason])).toEqual([['GHSA-2222-3333-4444', '届く経路が無い']]);
    expect(r.staleIgnores).toEqual([]);
  });

  it('同じ GHSA でもパッケージが違えば除外しない', () => {
    expect(decide(report(HIGH), [ignore('GHSA-2222-3333-4444', 'other')]).failing).toHaveLength(1);
  });

  it('もう当たらない除外は外してよいものとして出す(止めない)', () => {
    const r = decide(report(), [ignore('GHSA-2222-3333-4444', 'alpha')]);
    expect(r.failing).toEqual([]);
    expect(r.staleIgnores.map((e) => e.id)).toEqual(['GHSA-2222-3333-4444']);
  });

  it('level より低いものは数えない(下げた level では止める)', () => {
    expect(decide(report(MOD), []).failing).toEqual([]);
    expect(decide(report(MOD), [], 'moderate').failing.map((a) => a.package)).toEqual(['beta']);
  });

  it('level より低い advisory に当たる除外は、除外したものにもしないが、外してよいものにもしない', () => {
    const r = decide(report(MOD), [ignore('GHSA-5555-6666-7777', 'beta')]);
    expect(r.ignoredHits).toEqual([]);
    expect(r.staleIgnores).toEqual([]);
  });

  it('npm audit の失敗(error の JSON)は通さない', () => {
    const err = { error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.', detail: '' } };
    expect(() => decide(err, [])).toThrow(AuditError);
    expect(() => decide(err, [])).toThrow(/ENOLOCK/);
  });

  it('読めない形の出力は通さない', () => {
    expect(() => decide({ auditReportVersion: 1, advisories: {} }, [])).toThrow(AuditError);
    expect(() => decide(null, [])).toThrow(AuditError);
    expect(() => decide(report({ ...HIGH, url: 'https://example.invalid/x' }), [])).toThrow(/GHSA/);
  });

  it('知らない level は通さない', () => {
    expect(() => decide(report(), [], 'severe')).toThrow(AuditError);
  });
});

describe('parseIgnoreList', () => {
  it.each([
    ['配列でない', {}],
    ['reason が無い', [{ id: 'GHSA-2222-3333-4444', package: 'alpha', removeWhen: '修正版が出たら' }]],
    ['removeWhen が空', [{ ...ignore('GHSA-2222-3333-4444', 'alpha'), removeWhen: '  ' }]],
    ['package が無い', [{ id: 'GHSA-2222-3333-4444', reason: 'x', removeWhen: 'y' }]],
    ['id の形が違う', [ignore('CVE-2026-0001', 'alpha')]],
    ['知らない項目', [{ ...ignore('GHSA-2222-3333-4444', 'alpha'), note: 'x' }]],
    ['重複', [ignore('GHSA-2222-3333-4444', 'alpha'), ignore('GHSA-2222-3333-4444', 'alpha')]],
  ])('%s は誤りとして止める', (_, json) => {
    expect(() => parseIgnoreList(json)).toThrow(AuditError);
  });

  it('リポジトリの npm-audit-ignore.json は正しい形', () => {
    const json = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'npm-audit-ignore.json'), 'utf8'));
    expect(parseIgnoreList(json).length).toBeGreaterThanOrEqual(0);
  });
});
