// atlas serve の API(画面と保存の境界)。http(s) で開かれ、serve が meta に token を入れたときだけ使える。
// file:// で開いたときは token がプレースホルダのままなので何も呼ばない(console にエラーを出さない)。
// fetch の宛先は同一オリジンの相対パス 'api/…' だけ(E2E の外部参照の検査はこの形だけを許す)。
import type { ReportGroup } from '../lib/types.ts';

export interface ApiState {
  version: number;
  groups: ReportGroup[];
  notesDir: string;
  groupsPath: string;
  exists: boolean;
  warnings: string[];
}

/** serve が差し込んだ token。http(s) 以外・無し・プレースホルダ(__ で始まる)なら null */
export function serveToken(): string | null {
  if (!/^https?:$/.test(location.protocol)) return null;
  const t = document.querySelector<HTMLMetaElement>('meta[name="atlas-token"]')?.content ?? '';
  return t && !t.startsWith('__') ? t : null;
}

async function parse<T>(r: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = r.status === 204 ? null : await r.json();
  } catch {
    /* 本文が JSON でなければ状態コードだけで判断 */
  }
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `サーバの応答 ${r.status}`);
  return body as T;
}

const headers = (token: string): Record<string, string> => ({ 'content-type': 'application/json', 'x-atlas-token': token });
/** 接続できない(サーバが止まった等)ときの TypeError を日本語の理由にする */
const connect = <T>(p: Promise<Response>, parseBody: (r: Response) => Promise<T>): Promise<T> =>
  p.then(parseBody, () => {
    throw new Error('サーバに接続できません(atlas.bat を実行し直してください)');
  });

export const api = {
  state(): Promise<ApiState> {
    return connect(fetch('api/state', { cache: 'no-store' }), (r) => parse<ApiState>(r));
  },
  create(token: string, g: ReportGroup): Promise<{ group: ReportGroup; groups: ReportGroup[] }> {
    return connect(fetch('api/groups', { method: 'POST', headers: headers(token), body: JSON.stringify(g) }), (r) => parse(r));
  },
  update(token: string, name: string, patch: Partial<ReportGroup>): Promise<{ group: ReportGroup; groups: ReportGroup[] }> {
    return connect(fetch('api/groups/' + encodeURIComponent(name), { method: 'PUT', headers: headers(token), body: JSON.stringify(patch) }), (r) => parse(r));
  },
  remove(token: string, name: string): Promise<{ groups: ReportGroup[] }> {
    return connect(fetch('api/groups/' + encodeURIComponent(name), { method: 'DELETE', headers: headers(token) }), (r) => parse(r));
  },
};

/** 3 秒ごとに heartbeat を送る。失敗したら onDown を 1 回呼んで止める。戻り値で止められる */
export function startHeartbeat(token: string, onDown: () => void, intervalMs = 3000): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const beat = (): void => {
    fetch('api/heartbeat', { method: 'POST', headers: headers(token), keepalive: true })
      .then((r) => {
        if (!r.ok) {
          stop();
          onDown();
        }
      })
      .catch(() => {
        stop();
        onDown();
      });
  };
  timer = setInterval(beat, intervalMs);
  beat();
  return stop;
}
