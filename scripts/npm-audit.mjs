// npm の依存の既知の脆弱性を npm audit で調べ、npm-audit-ignore.json に書いた advisory を除いて判定する。
// 使い方: node scripts/npm-audit.mjs [--omit=dev] [--audit-level=<low|moderate|high|critical>](既定は devDependencies も含めて high 以上)
// 終了コード: 0 = 止める advisory が無い、1 = ある、2 = 調べられなかった(npm audit の失敗・除外の書き方の誤り・引数の誤り)。
// node: の標準モジュールだけを使う(CI は npm ci をせずに動かす。npm audit も package-lock.json だけを読む)。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const GHSA = /\/(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})\/?$/;

/** 調べられなかったとき(終了コード 2)に投げる */
export class AuditError extends Error {}

/** npm-audit-ignore.json の中身を確かめて返す。形が違えば AuditError */
export function parseIgnoreList(json) {
  if (!Array.isArray(json)) throw new AuditError('npm-audit-ignore.json は配列で書きます');
  const seen = new Set();
  return json.map((e, i) => {
    const at = `npm-audit-ignore.json の ${i + 1} 件目`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new AuditError(`${at}がオブジェクトではありません`);
    const extra = Object.keys(e).filter((k) => !['id', 'package', 'reason', 'removeWhen'].includes(k));
    if (extra.length > 0) throw new AuditError(`${at}に知らない項目があります: ${extra.join(', ')}`);
    for (const k of ['id', 'package', 'reason', 'removeWhen']) {
      if (typeof e[k] !== 'string' || e[k].trim() === '') throw new AuditError(`${at}の ${k} が空か、文字列ではありません`);
    }
    if (!/^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/.test(e.id)) throw new AuditError(`${at}の id が GHSA-xxxx-xxxx-xxxx の形ではありません: ${e.id}`);
    const key = `${e.id} ${e.package}`;
    if (seen.has(key)) throw new AuditError(`${at}は前の行と同じです: ${key}`);
    seen.add(key);
    return { id: e.id, package: e.package, reason: e.reason, removeWhen: e.removeWhen };
  });
}

/** npm audit --json(auditReportVersion 2)から advisory を集める(同じ GHSA とパッケージは 1 つにまとめる) */
export function collectAdvisories(audit) {
  if (audit === null || typeof audit !== 'object') throw new AuditError('npm audit の出力が JSON のオブジェクトではありません');
  if (audit.error) {
    const { code, summary, detail } = audit.error;
    throw new AuditError(`npm audit が失敗しました: ${[code, summary, detail].filter(Boolean).join(' / ')}`);
  }
  if (audit.auditReportVersion !== 2 || audit.vulnerabilities === null || typeof audit.vulnerabilities !== 'object') {
    throw new AuditError(`npm audit の出力の形を読めません(auditReportVersion: ${audit.auditReportVersion})`);
  }
  const found = new Map();
  for (const v of Object.values(audit.vulnerabilities)) {
    // via の文字列は「この依存を通して入る」という印で、advisory そのものはオブジェクトの方に載る
    for (const via of v?.via ?? []) {
      if (via === null || typeof via !== 'object') continue;
      const id = GHSA.exec(String(via.url ?? ''))?.[1];
      if (!id) throw new AuditError(`advisory の url から GHSA の番号を読めません: ${via.url} (${via.name})`);
      if (!LEVELS.includes(via.severity)) throw new AuditError(`advisory の重大度を読めません: ${via.severity} (${id})`);
      const key = `${id} ${via.name}`;
      if (!found.has(key)) found.set(key, { id, package: via.name, severity: via.severity, title: via.title, url: via.url, range: via.range });
    }
  }
  return [...found.values()];
}

/**
 * 判定する。failing = level 以上で除外に無い advisory、ignoredHits = level 以上で除外に当たった advisory(と除外の理由)、
 * staleIgnores = npm audit が出した advisory のどれにも当たらない除外の行(外してよい。level より低いものに当たる行は残す)
 */
export function decide(audit, ignoreJson, level = 'high') {
  if (!LEVELS.includes(level) || level === 'info') throw new AuditError(`--audit-level は low・moderate・high・critical のどれかです: ${level}`);
  const ignores = parseIgnoreList(ignoreJson);
  const min = LEVELS.indexOf(level);
  const failing = [];
  const ignoredHits = [];
  const used = new Set();
  for (const a of collectAdvisories(audit)) {
    const ig = ignores.find((e) => e.id === a.id && e.package === a.package);
    if (ig) used.add(ig);
    if (LEVELS.indexOf(a.severity) < min) continue;
    if (ig) ignoredHits.push({ ...a, reason: ig.reason, removeWhen: ig.removeWhen });
    else failing.push(a);
  }
  return { failing, ignoredHits, staleIgnores: ignores.filter((e) => !used.has(e)) };
}

function parseArgs(argv) {
  const opts = { omitDev: false, level: 'high' };
  for (const a of argv) {
    if (a === '--omit=dev') opts.omitDev = true;
    else if (a.startsWith('--audit-level=')) opts.level = a.slice('--audit-level='.length);
    else throw new AuditError(`知らない引数です: ${a}(使えるのは --omit=dev と --audit-level=<low|moderate|high|critical>)`);
  }
  return opts;
}

function runNpmAudit(root, omitDev) {
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])];
  // Windows の npm は npm.cmd で、.cmd はシェルを通さないと起動できない。シェルには 1 本の文字列で渡す
  // (引数の配列とシェルを一緒に渡すと Node が DEP0190 の警告を出す。引数はここで決めた固定のものだけ)
  const win = process.platform === 'win32';
  const opts = { cwd: root, encoding: 'utf8', shell: win, maxBuffer: 64 * 1024 * 1024 };
  const r = win ? spawnSync(`npm ${args.join(' ')}`, opts) : spawnSync('npm', args, opts);
  if (r.error) throw new AuditError(`npm audit を起動できません: ${r.error.message}`);
  // 脆弱性があると npm audit は 0 以外で終わるので、終了コードではなく出力で判断する
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new AuditError(`npm audit の出力が JSON ではありません(終了コード ${r.status})\n${(r.stderr || r.stdout || '').trim()}`);
  }
  return json;
}

function main() {
  const root = join(import.meta.dirname, '..');
  const inActions = Boolean(process.env.GITHUB_ACTIONS);
  // Actions の注記(::warning:: / ::error::)は 1 行で書く
  const warn = (msg) => inActions && console.log(`::warning title=npm audit::${msg.replace(/\r?\n/g, ' ')}`);
  try {
    const opts = parseArgs(process.argv.slice(2));
    let ignoreJson;
    try {
      ignoreJson = JSON.parse(readFileSync(join(root, 'npm-audit-ignore.json'), 'utf8'));
    } catch (e) {
      throw new AuditError(`npm-audit-ignore.json を読めません: ${e.message}`);
    }
    const audit = runNpmAudit(root, opts.omitDev);
    const { failing, ignoredHits, staleIgnores } = decide(audit, ignoreJson, opts.level);
    const scope = opts.omitDev ? 'dependencies だけ' : 'devDependencies も含む';
    console.log(`npm audit(${scope}、${opts.level} 以上): 止めるもの ${failing.length} 件、除外したもの ${ignoredHits.length} 件`);
    for (const a of ignoredHits) {
      const msg = `除外しました: ${a.id} ${a.package}(${a.severity})${a.title} 理由: ${a.reason} 外す時: ${a.removeWhen}`;
      console.log(`  ${msg}`);
      warn(msg);
    }
    // --omit=dev では devDependencies の advisory が出ないので、除外が当たらなくても外してよいとは言えない
    if (!opts.omitDev) {
      for (const e of staleIgnores) {
        const msg = `npm-audit-ignore.json の ${e.id} ${e.package} はもう当たりません。外してください(外す時: ${e.removeWhen})`;
        console.log(`  ${msg}`);
        warn(msg);
      }
    }
    for (const a of failing) {
      console.log(`  止めます: ${a.id} ${a.package}(${a.severity})${a.title}\n    ${a.url}`);
      if (inActions) console.log(`::error title=npm audit::${a.id} ${a.package}(${a.severity})${a.title} ${a.url}`);
    }
    if (failing.length > 0) {
      console.log('直し方は docs/development.md の「依存の検査」にあります。');
      process.exit(1);
    }
  } catch (e) {
    // 思わぬ失敗も 1(止める advisory がある)と区別して 2 で終える
    console.error(e instanceof AuditError ? e.message : (e?.stack ?? String(e)));
    if (inActions) console.log(`::error title=npm audit::${String(e?.message ?? e).replace(/\r?\n/g, ' ')}`);
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
