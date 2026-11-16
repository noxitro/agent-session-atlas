// Phase 11: 全文記録(out/full/<id>.md)。上限なしで、events.jsonl の全イベントを時系列に書く。
// - 除くのは暗号化・不透明データ(encryptedContent / reasoningOpaque / reasoningBlocks の中の base64 らしい値)と base64 本体(binary_asset は assets/ に書き出してリンク)だけ。
//   除いた箇所には種別とサイズを書く。扱いは coverage.ts の表で決め、表に無いキーは「未分類」として末尾に出す(=欠損の有無の根拠)。
//   不透明データの判定(looksOpaque)は reasoningBlocks の配下だけに掛ける(ツールの引数やファイルの内容にある長い英数字列は除外しない)
// - hook の入力に入っているツールの結果がツールの結果と同一なら参照にする(容量の重複)
// - 秘密情報の形式検査(redactSecrets)を全ての文字列に掛け、件数を末尾に出す。伏せ字(--anonymize)とは併用しない
// - チェックポイントと plan.md(スナップショットのセッションフォルダ)、data.db の許可列(desktop)も節として出す
// - イベントは AsyncIterable で受け取り、出力は sink に逐次書く(セッション全体をメモリに載せない。backpressure は sink 側)
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { isUserTurn, loadStore, mergeUsage, parseEvents, renameReplacing, type CopilotEvent, type DbUsageRow, type SessionRecord } from '../../core/src/index.ts';
import { CoverageCounter, ruleFor, type CoverageEntry } from './coverage.ts';
import { dateTime, int } from './lib/format.ts';
import { redactSecrets, rel } from './transcript.ts';

export interface FullOptions {
  generatedAt: string;
  /** 画像などの書き出し先(out/full/assets/<id>)。Markdown からの相対パスは assetsHref */
  assetsDir: string;
  assetsHref: string;
  /** スナップショットのセッションフォルダ(plan.md / checkpoints/ など)。無ければ null */
  sessionDir: string | null;
  /** 全文記録から見たセッションフォルダへの相対パス(files/ へのリンク用) */
  sessionDirHref: string | null;
  /** 網羅の集計(全セッションで共有) */
  coverage: CoverageCounter;
  /** data.db の WAL の注意(sessions.json の desktop) */
  walNote: string | null;
}

export interface FullResult {
  events: number;
  secretHits: number;
  /** 書き出した画像などの数とバイト数 */
  assets: { files: number; bytes: number };
  /** このセッションで出た未分類のキー */
  unclassified: string[];
  /** 除外した箇所の数とバイト数 */
  excluded: { n: number; bytes: number };
}

/** 出力先。write は backpressure を守る(build は createWriteStream を包む) */
export interface FullSink {
  write(chunk: string): Promise<void> | void;
}

export function fullFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

export interface FileSink extends FullSink {
  /** 書き終えて <path>.tmp を <path> に rename する */
  finish(): Promise<void>;
  /** 途中で失敗したときに stream を壊して tmp を消す(壊れた記録を残さない) */
  abort(): Promise<void>;
}

/**
 * <path>.tmp に逐次書き、成功時に rename する sink。
 * stream の error は生成時に 1 回だけ受けて保持し、write のたびに検査する(write ごとに once('error') を積まない。
 * drain 待ちの間に error が起きても永久に待たない)
 */
export function createFileSink(path: string): FileSink {
  const tmp = `${path}.tmp`;
  const ws = createWriteStream(tmp, { encoding: 'utf8' });
  let error: Error | null = null;
  let errorWaiters: ((e: Error) => void)[] = [];
  ws.once('error', (e) => {
    error = e;
    for (const w of errorWaiters) w(e);
    errorWaiters = [];
  });
  const check = (): void => {
    if (error) throw error;
  };
  return {
    async write(chunk: string): Promise<void> {
      check();
      if (ws.write(chunk)) {
        check();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => {
          errorWaiters = errorWaiters.filter((w) => w !== onError);
          resolve();
        };
        const onError = (e: Error): void => {
          ws.off('drain', onDrain);
          reject(e);
        };
        if (error) {
          reject(error);
          return;
        }
        errorWaiters.push(onError);
        ws.once('drain', onDrain);
      });
    },
    async finish(): Promise<void> {
      check();
      await new Promise<void>((resolve, reject) => {
        if (error) {
          reject(error);
          return;
        }
        errorWaiters.push(reject);
        ws.end(() => resolve());
      });
      check();
      await renameReplacing(tmp, path);
    },
    async abort(): Promise<void> {
      // ファイルを開き終える前に消すと、消した後で tmp ができてしまう。閉じ終わるのを待ってから消す
      if (!ws.closed) {
        await new Promise<void>((resolve) => {
          ws.once('close', () => resolve());
          ws.destroy();
        });
      }
      await rm(tmp, { force: true }).catch(() => {});
    },
  };
}

const ms = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

function fence(text: string, lang = ''): string {
  const runs = text.match(/`{3,}/g) ?? [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  const f = '`'.repeat(n);
  return `${f}${lang}\n${text.replace(/\s+$/, '')}\n${f}`;
}

/** base64 らしい(復号できない)文字列か。reasoningBlocks の配下にだけ掛ける */
export function looksOpaque(s: string): boolean {
  return s.length >= 100 && /^[A-Za-z0-9+/=_-]+$/.test(s);
}

const extOf = (mime: string): string => {
  const m: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf', 'text/plain': '.txt' };
  return m[mime] ?? '.bin';
};

/** テスト用: 文字列に集めて返す */
export async function renderFull(r: SessionRecord, events: Iterable<CopilotEvent> | AsyncIterable<CopilotEvent>, dbUsage: DbUsageRow[], o: FullOptions): Promise<FullResult & { markdown: string }> {
  const parts: string[] = [];
  const res = await renderFullTo(r, events, dbUsage, o, { write: (c) => void parts.push(c) });
  return { ...res, markdown: parts.join('') };
}

export async function renderFullTo(r: SessionRecord, events: Iterable<CopilotEvent> | AsyncIterable<CopilotEvent>, dbUsage: DbUsageRow[], o: FullOptions, sink: FullSink): Promise<FullResult> {
  let secretHits = 0;
  const excluded = { n: 0, bytes: 0 };
  const assets = { files: 0, bytes: 0 };
  const unclassified = new Set<string>();
  // 逐次書き出し(行を溜めて 64KB ごとに sink へ)
  let buf: string[] = [];
  let bufBytes = 0;
  const flush = async (): Promise<void> => {
    if (!buf.length) return;
    const chunk = buf.join('\n') + '\n';
    buf = [];
    bufBytes = 0;
    await sink.write(chunk);
  };
  const L = {
    push: (...lines: string[]): void => {
      for (const l of lines) {
        buf.push(l);
        bufBytes += l.length + 1;
      }
    },
  };
  const maybeFlush = async (): Promise<void> => {
    if (bufBytes >= 64 * 1024) await flush();
  };

  /** 文字列の整形: 秘密情報を伏せる(上限なし) */
  const text = (s: string): string => {
    const red = redactSecrets(s);
    secretHits += red.hits;
    return red.text;
  };
  const omit = (what: string, bytes: number): string => {
    excluded.n++;
    excluded.bytes += bytes;
    return `_(除外: ${what}、${int(bytes)} バイト)_`;
  };
  /**
   * 値を「書ける形」に(JSON で出すとき用)。秘密情報を伏せる。
   * opaque = true のとき(reasoningBlocks の配下だけ)は base64 らしい文字列を印に置き換え、coverage にも「一部除外」として数える
   */
  const sanitize = (v: unknown, path: string, opaque: boolean, cov?: { type: string; key: string }): unknown => {
    if (typeof v === 'string') {
      if (opaque && looksOpaque(v)) {
        excluded.n++;
        excluded.bytes += v.length;
        if (cov) o.coverage.addExcluded(cov.type, cov.key, v.length);
        return `<除外: 不透明データ ${v.length} 文字 (${path})>`;
      }
      return text(v);
    }
    if (Array.isArray(v)) return v.map((x, i) => sanitize(x, `${path}[${i}]`, opaque, cov));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, sanitize(x, `${path}.${k}`, opaque, cov)]));
    return v;
  };
  const json = (v: unknown, path: string, opaque = false, cov?: { type: string; key: string }): string => fence(JSON.stringify(sanitize(v, path, opaque, cov), null, 1), 'json');
  const hashOf = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);
  /** 文字列ならそのまま囲みに、それ以外(配列・オブジェクト・数値)は JSON の囲みに(黙って落とさない) */
  const block = (label: string, v: unknown, path: string, lang = ''): void => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string') {
      if (v.trim()) L.push(label ? `${label}:` : '', '', fence(text(v), lang), '');
    } else L.push(label ? `${label}:` : '', '', json(v, path), '');
  };

  const startMs = ms(r.createdAt) ?? null;
  const usageRecords: CopilotEvent[] = [];

  // ---------- 見出し・概要 ----------
  L.push(`# 全文記録: ${text(r.name ?? r.id)}`, '');
  L.push(`生成 ${dateTime(o.generatedAt)} · agent-session-atlas \`atlas export --full\` · セッション ID \`${r.id}\` · イベント ${int(r.events.total)} 件(extract 時)`);
  L.push('');
  L.push('> **解析用の完全出力。** 原本の文字列をそのまま含みます(秘密情報の形式検査で伏せた箇所を除く)。共有しないでください。共有には伏せ字版(`--anonymize`)を使います。', '');
  L.push('## 概要', '');
  L.push('| 項目 | 値 |', '|---|---|');
  const meta: [string, string][] = [
    ['プロジェクト', r.project],
    ['クライアント', r.client ?? '不明'],
    ['リポジトリ / ブランチ', `${r.repository ?? '—'} / ${r.branch ?? '—'}`],
    ['作業フォルダ', r.cwd ?? '—'],
    ['git ルート', r.gitRoot ?? '—'],
    ['Copilot', r.copilotVersion ?? '不明'],
    ['開始 / 更新', `${dateTime(r.createdAt)} / ${dateTime(r.updatedAt)}`],
    ['依頼 / 応答', `${int(r.turns)} / ${int(r.assistantMessages)}`],
    ['モデル', r.models.join('、') || '不明'],
    ['記録の出所', r.sources.join(' + ')],
  ];
  for (const [k, v] of meta) L.push(`| ${k} | ${text(v).replace(/\|/g, '\\|')} |`);
  L.push('');

  // ---------- data.db ----------
  if (r.desktop) {
    const d = r.desktop;
    L.push('## デスクトップアプリの記録(data.db、許可リストの列だけ)', '');
    if (o.walNote) L.push(`> ${o.walNote}`, '');
    if (d.session) {
      L.push('| 列 | 値 |', '|---|---|');
      for (const [k, v] of Object.entries(d.session)) if (v != null && v !== '') L.push(`| ${k} | ${text(String(v)).replace(/\|/g, '\\|')} |`);
      L.push('');
    }
    if (d.workspace) L.push(`workspace: ${json(d.workspace, 'desktop.workspace')}`, '');
    if (d.project) L.push(`project: ${json(d.project, 'desktop.project')}`, '');
    if (d.contextUsage.length) {
      const xs = d.contextUsage.map((x) => Number(x.current_tokens ?? 0));
      L.push(`context usage: ${int(d.contextUsage.length)} 点(最小 ${int(Math.min(...xs))} / 最大 ${int(Math.max(...xs))} トークン、上限 ${int(Number(d.contextUsage[0].token_limit ?? 0))})`, '');
      L.push(json(d.contextUsage, 'desktop.contextUsage'), '');
    }
    if (d.checkpoints.length) L.push(`checkpoints(git のコミット): ${json(d.checkpoints, 'desktop.checkpoints')}`, '');
    if (d.activity.length) L.push(`activity: ${json(d.activity, 'desktop.activity')}`, '');
  }
  await flush();

  // ---------- 経過 ----------
  L.push('## 経過(全イベント)', '');
  L.push('時刻は開始からの相対(+時:分:秒)。各イベントは種別・id・親 id・agentId を 1 行に、本文と引数・結果は囲みに書きます。除外した箇所は「除外: 種別、バイト数」。', '');

  const toolNames = new Map<string, string>();
  const resultHashes = new Map<string, string>(); // hash(result text) → toolCallId
  const agentName = new Map<string, string>();
  let turnNo = 0;
  let eventCount = 0;
  let firstMs: number | null = null;
  const head = (e: CopilotEvent, label: string): void => {
    const ids = [e.id ? `id ${String(e.id).slice(0, 8)}` : null, e.parentId ? `parent ${String(e.parentId).slice(0, 8)}` : null, e.agentId ? `agent ${String(e.agentId).slice(0, 8)}${agentName.get(String(e.agentId)) ? ` (${agentName.get(String(e.agentId))})` : ''}` : null].filter(Boolean);
    L.push(`- ${rel(startMs ?? firstMs, ms(e.timestamp))} **${e.type}** ${label}${ids.length ? ` <small>${ids.join(' · ')}</small>` : ''}`);
  };
  /** 残りのキー(特別扱いしなかったもの)を扱いに従って出す */
  const rest = (e: CopilotEvent, used: Set<string>): void => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const fullKeys: Record<string, unknown> = {};
    const refs: string[] = [];
    for (const [k, v] of Object.entries(d)) {
      if (used.has(k) || v === undefined) continue;
      const rule = ruleFor(e.type, k);
      const bytes = JSON.stringify(v ?? null).length;
      if (!rule) {
        unclassified.add(`${e.type}|${k}`);
        fullKeys[k] = v; // 未分類でも落とさず全文に出す(欠損を作らない)
      } else if (rule.treatment === 'excluded') L.push(`  ${omit(`${k}: ${rule.reason ?? ''}`, bytes)}`);
      else if (rule.treatment === 'ref') refs.push(`${k}=${typeof v === 'string' ? text(v).slice(0, 40) : Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' ? '{…}' : String(v)}`);
      else fullKeys[k] = v;
    }
    if (refs.length) L.push(`  <small>${refs.join(' · ')}</small>`);
    if (Object.keys(fullKeys).length) L.push('', json(fullKeys, e.type), '');
  };
  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  const resultTexts = (v: unknown): { text: string | null; detailed: string | null; extra: Record<string, unknown> | null } => {
    if (typeof v === 'string') return { text: v, detailed: null, extra: null };
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r0 = v as Record<string, unknown>;
      const text = typeof r0.content === 'string' ? r0.content : null;
      const detailed = typeof r0.detailedContent === 'string' ? r0.detailedContent : null;
      const extra = Object.fromEntries(Object.entries(r0).filter(([k, x]) => !((k === 'content' && text != null) || (k === 'detailedContent' && detailed != null)) && x !== undefined));
      return { text, detailed, extra: Object.keys(extra).length ? extra : null };
    }
    return { text: null, detailed: null, extra: null };
  };

  for await (const e of events) {
    eventCount++;
    o.coverage.add(e as { type: string; data?: unknown } & Record<string, unknown>);
    if (e.type === 'session.usage_record') usageRecords.push(e);
    if (firstMs == null) firstMs = ms(e.timestamp);
    const d = (e.data ?? {}) as Record<string, unknown>;
    const used = new Set<string>();
    switch (e.type) {
      case 'user.message': {
        if (!e.agentId && isUserTurn(d)) {
          turnNo++;
          L.push('', `### 依頼 ${turnNo}(${rel(startMs ?? firstMs, ms(e.timestamp))})`, '');
        }
        head(e, typeof d.agentMode === 'string' ? `モード ${d.agentMode}` : '');
        if (d.content !== undefined) {
          used.add('content');
          block('', d.content, 'content');
        }
        if (d.transformedContent !== undefined) {
          used.add('transformedContent');
          if (d.transformedContent !== d.content) block('transformedContent(添付等を展開した版)', d.transformedContent, 'transformedContent');
          else L.push('  <small>transformedContent は content と同じ</small>');
        }
        if (Array.isArray(d.supportedNativeDocumentMimeTypes)) {
          used.add('supportedNativeDocumentMimeTypes');
          L.push(`  <small>supportedNativeDocumentMimeTypes: ${d.supportedNativeDocumentMimeTypes.length} 種</small>`);
        }
        rest(e, used);
        break;
      }
      case 'assistant.message': {
        const model = typeof d.model === 'string' ? d.model : '';
        head(e, `${model ? `モデル ${model} ` : ''}${d.outputTokens != null ? `出力 ${int(Number(d.outputTokens))} トークン` : ''}`);
        if (d.content !== undefined) {
          used.add('content');
          block('', d.content, 'content');
        }
        if (d.reasoningText !== undefined) {
          used.add('reasoningText');
          block('reasoningText', d.reasoningText, 'reasoningText');
        }
        if (d.reasoningBlocks !== undefined) {
          used.add('reasoningBlocks');
          const n = Array.isArray(d.reasoningBlocks) ? d.reasoningBlocks.length : null;
          if (n !== 0) L.push(`reasoningBlocks${n != null ? `(${n} 件。不透明な値は除外の印)` : ''}:`, '', json(d.reasoningBlocks, 'reasoningBlocks', true, { type: e.type, key: 'reasoningBlocks' }), '');
        }
        if (d.toolRequests !== undefined) {
          used.add('toolRequests');
          if (Array.isArray(d.toolRequests)) {
            if (d.toolRequests.length) L.push(`toolRequests(${d.toolRequests.length} 件):`, '', json(d.toolRequests, 'toolRequests'), '');
            for (const t of d.toolRequests as { toolCallId?: string; name?: string }[]) if (t && t.toolCallId && t.name) toolNames.set(t.toolCallId, t.name);
          } else block('toolRequests', d.toolRequests, 'toolRequests');
        }
        if (d.encryptedContent !== undefined) {
          used.add('encryptedContent');
          L.push(`  ${omit('encryptedContent: 暗号化された本文', JSON.stringify(d.encryptedContent).length)}`);
        }
        if (d.reasoningOpaque !== undefined) {
          used.add('reasoningOpaque');
          L.push(`  ${omit('reasoningOpaque: 不透明な推論データ', JSON.stringify(d.reasoningOpaque).length)}`);
        }
        rest(e, used);
        break;
      }
      case 'tool.execution_start': {
        const name = str(d.toolName);
        const call = typeof d.toolCallId === 'string' ? d.toolCallId : '';
        if (call) toolNames.set(call, name);
        head(e, `\`${name}\`${typeof d.mcpServerName === 'string' && d.mcpServerName ? ` (MCP ${d.mcpServerName})` : ''}${call ? ` call ${call.slice(0, 8)}` : ''}`);
        used.add('toolName');
        if (d.arguments !== undefined) {
          used.add('arguments');
          L.push('', json(d.arguments, 'arguments'), '');
        }
        rest(e, used);
        break;
      }
      case 'tool.execution_complete': {
        const call = typeof d.toolCallId === 'string' ? d.toolCallId : '';
        const name = toolNames.get(call) ?? str(d.toolName);
        head(e, `\`${name}\` ${d.success === false ? '✖ 失敗' : '✔'}${call ? ` call ${call.slice(0, 8)}` : ''}`);
        if (d.result !== undefined && d.result !== null) {
          used.add('result');
          const rt = resultTexts(d.result);
          if (rt.text != null || rt.detailed != null) {
            // content と detailedContent は両方出す(同じなら 1 回だけ書いて同一と記す)
            if (rt.text != null && rt.detailed != null && rt.text === rt.detailed) {
              resultHashes.set(hashOf(rt.text), call || name);
              L.push('result(content と detailedContent は同一):', '', fence(text(rt.text)), '');
            } else {
              if (rt.text != null) {
                resultHashes.set(hashOf(rt.text), call || name);
                L.push(rt.detailed != null ? 'result.content:' : 'result:', '', fence(text(rt.text)), '');
              }
              if (rt.detailed != null) {
                resultHashes.set(hashOf(rt.detailed), call || name);
                L.push('result.detailedContent:', '', fence(text(rt.detailed)), '');
              }
            }
            if (rt.extra) L.push('result(他の項目):', '', json(rt.extra, 'result'), '');
          } else block('result', d.result, 'result');
        }
        if (d.error !== undefined && d.error !== null) {
          used.add('error');
          block('error', d.error, 'error');
        }
        rest(e, used);
        break;
      }
      case 'hook.start': {
        head(e, `${str(d.hookType)}${typeof d.hookInvocationId === 'string' ? ` ${d.hookInvocationId.slice(0, 8)}` : ''}`);
        if (d.input !== undefined) {
          used.add('input');
          if (d.input && typeof d.input === 'object' && !Array.isArray(d.input)) {
            const inp = { ...(d.input as Record<string, unknown>) };
            const tr = inp.toolResult;
            if (tr && typeof tr === 'object' && !Array.isArray(tr)) {
              const t = { ...(tr as Record<string, unknown>) };
              for (const k of ['textResultForLlm', 'sessionLog']) {
                const v = t[k];
                if (typeof v === 'string' && resultHashes.has(hashOf(v))) t[k] = `<ツールの結果と同一: call ${resultHashes.get(hashOf(v))} (${v.length} 文字)>`;
              }
              inp.toolResult = t;
            }
            L.push('input:', '', json(inp, 'hook.input'), '');
          } else block('input', d.input, 'hook.input');
        }
        rest(e, used);
        break;
      }
      case 'hook.end':
        head(e, `${str(d.hookType)} ${d.success === false ? '✖' : '✔'}`);
        rest(e, used);
        break;
      case 'system.message': {
        head(e, `role ${str(d.role)}`);
        if (d.content !== undefined) {
          used.add('content');
          block('', d.content, 'content');
        }
        rest(e, used);
        break;
      }
      case 'skill.invoked': {
        head(e, `\`${str(d.name)}\`${typeof d.trigger === 'string' ? ` (${d.trigger})` : ''}`);
        if (d.content !== undefined) {
          used.add('content');
          block('本文', d.content, 'content', 'markdown');
        }
        rest(e, used);
        break;
      }
      case 'session.binary_asset': {
        head(e, `${str(d.mimeType)} ${d.byteLength != null ? `${int(Number(d.byteLength))} バイト` : ''}`);
        if (typeof d.data === 'string') {
          used.add('data');
          const id = typeof d.assetId === 'string' && d.assetId ? d.assetId.replace(/[^A-Za-z0-9._-]/g, '_') : `asset-${assets.files + 1}`;
          const file = `${id}${extOf(str(d.mimeType))}`;
          try {
            await mkdir(o.assetsDir, { recursive: true });
            const buf = Buffer.from(d.data, 'base64');
            await writeFile(join(o.assetsDir, file), buf);
            assets.files++;
            assets.bytes += buf.length;
            L.push(`  ${omit('data: base64 の本体(ファイルに書き出した)', d.data.length)} → [${file}](${o.assetsHref}/${file})`);
          } catch (err) {
            L.push(`  ${omit(`data: base64 の本体(書き出せなかった: ${(err as Error).message})`, d.data.length)}`);
          }
        }
        rest(e, used);
        break;
      }
      case 'session.compaction_complete': {
        head(e, `${d.success === false ? '失敗' : '完了'}${d.checkpointNumber != null ? `、チェックポイント ${String(d.checkpointNumber)}(下の節)` : ''}`);
        if (d.summaryContent !== undefined) {
          used.add('summaryContent');
          block('要約', d.summaryContent, 'summaryContent');
        }
        rest(e, used);
        break;
      }
      case 'subagent.started':
        if (e.agentId && typeof d.agentName === 'string') agentName.set(String(e.agentId), d.agentName);
        head(e, `\`${str(d.agentName)}\``);
        rest(e, used);
        break;
      default:
        head(e, '');
        rest(e, used);
        break;
    }
    await maybeFlush();
  }
  L.push('');

  // ---------- 明細の件数 ----------
  const usage = mergeUsage(dbUsage, usageRecords).items;
  L.push('## 明細', '');
  L.push(`- リクエスト単位の明細: ${int(usage.length)} 件(session-store.db と usage_record)`, `- イベント: ${int(eventCount)} 件`, '');

  // ---------- セッションフォルダの付随物 ----------
  if (o.sessionDir && existsSync(o.sessionDir)) {
    const plan = join(o.sessionDir, 'plan.md');
    if (existsSync(plan)) L.push('## plan.md', '', fence(text(await readFile(plan, 'utf8')), 'markdown'), '');
    const cps = join(o.sessionDir, 'checkpoints');
    if (existsSync(cps)) {
      const names = (await readdir(cps)).filter((f) => f.toLowerCase().endsWith('.md')).sort();
      if (names.length) {
        L.push('## チェックポイント(checkpoints/)', '');
        for (const f of names) L.push(`### ${f}`, '', fence(text(await readFile(join(cps, f), 'utf8')), 'markdown'), '');
      }
    }
    for (const sub of ['files', 'rewind-file-snapshots', 'policies']) {
      const dir = join(o.sessionDir, sub);
      if (!existsSync(dir)) continue;
      const ents = (await readdir(dir, { withFileTypes: true, recursive: true })).filter((x) => x.isFile());
      if (!ents.length) continue;
      L.push(`## ${sub}/(${int(ents.length)} ファイル)`, '');
      for (const x of ents) {
        const p = join(x.parentPath, x.name);
        const relp = p.slice(o.sessionDir.length + 1).replace(/\\/g, '/');
        const size = (await stat(p)).size;
        const link = o.sessionDirHref ? `[${relp}](${o.sessionDirHref}/${relp.split('/').map(encodeURIComponent).join('/')})` : `\`${relp}\``;
        L.push(`- ${link}(${int(size)} バイト)`);
        if (sub === 'policies' && extname(x.name) === '.json' && size < 64 * 1024) L.push('', fence(text(await readFile(p, 'utf8')), 'json'), '');
      }
      L.push('');
    }
  }

  // ---------- 検査 ----------
  for (const e of o.coverage.unclassified()) unclassified.add(`${e.type}|${e.key}`);
  const uc = [...unclassified].sort();
  L.push('## 検査', '');
  L.push(`- 秘密情報の形式検査: ${secretHits ? `${int(secretHits)} 件を伏せました(\`[伏せました: 種類]\`)` : '該当なし'}`);
  L.push(`- 除外した箇所: ${int(excluded.n)}(${int(excluded.bytes)} バイト。暗号化・不透明データと base64 本体だけ)`);
  L.push(`- 書き出した画像など: ${int(assets.files)} ファイル(${int(assets.bytes)} バイト)`);
  L.push(`- 未分類のキー(扱いの表に無く、そのまま全文に出したもの): ${uc.length ? uc.map((k) => `\`${k}\``).join('、') : '無し'}`);
  L.push('');
  await flush();

  return { events: eventCount, secretHits, assets, unclassified: uc, excluded };
}

export interface FullRecordInput {
  record: SessionRecord;
  /** out/snapshot(session-state/<id>/ と session-store.db) */
  snapshotDir: string;
  /** out/(書くのは out/full/<id>.md と out/full/assets/<id>/ だけ) */
  outDir: string;
  /** sessions.json の desktop.wal.note */
  walNote?: string | null;
  /** 止める(イベントの間で確かめ、tmp を消して例外にする) */
  signal?: AbortSignal;
  generatedAt?: string;
}

/**
 * Phase 14: 1 件だけ全文記録を書く(atlas serve の「全文を作って読む」)。
 * export --full と同じ renderFullTo / createFileSink を使うが、atlas.html・詳細ページ・coverage.json・他のセッションの全文は触らない
 * (網羅の集計はこの 1 件の中だけで数えて捨てる。coverage.json は全件の export --full だけが書く)
 */
export async function writeFullRecord(o: FullRecordInput): Promise<FullResult & { path: string; bytes: number }> {
  const r = o.record;
  const fullDir = join(o.outDir, 'full');
  const folder = r.id.replace(/[^A-Za-z0-9._-]/g, '_');
  const sessionDir = join(o.snapshotDir, 'session-state', r.id);
  const eventsPath = join(sessionDir, 'events.jsonl');
  const store = await loadStore(join(o.snapshotDir, 'session-store.db'));
  await mkdir(fullDir, { recursive: true });
  const path = join(fullDir, fullFileName(r.id));
  const signal = o.signal;
  const source: AsyncIterable<CopilotEvent> | CopilotEvent[] = existsSync(eventsPath) ? parseEvents(eventsPath) : [];
  async function* guarded(): AsyncGenerator<CopilotEvent> {
    for await (const e of source) {
      if (signal?.aborted) throw new Error('取り消しました');
      yield e;
    }
  }
  if (signal?.aborted) throw new Error('取り消しました');
  const sink = createFileSink(path);
  let res: FullResult;
  try {
    res = await renderFullTo(
      r,
      guarded(),
      store.usage.get(r.id) ?? [],
      {
        generatedAt: o.generatedAt ?? new Date().toISOString(),
        assetsDir: join(fullDir, 'assets', folder),
        assetsHref: `assets/${folder}`,
        sessionDir: existsSync(sessionDir) ? sessionDir : null,
        sessionDirHref: existsSync(sessionDir) ? `../snapshot/session-state/${encodeURIComponent(r.id)}` : null,
        coverage: new CoverageCounter(),
        walNote: o.walNote ?? null,
      },
      sink,
    );
    if (signal?.aborted) throw new Error('取り消しました');
    await sink.finish();
  } catch (e) {
    await sink.abort();
    throw e;
  }
  return { ...res, path, bytes: (await stat(path)).size };
}

export type { CoverageEntry };
