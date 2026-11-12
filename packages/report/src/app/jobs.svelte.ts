// Phase 14: 画面から動かす処理(集計し直す・工数を判定する)の状態。マストヘッドの操作(JobActions)と本文の上の帯(JobBand)が共有する。
// GET api/jobs/current を実行中は 1 秒ごと、それ以外は 5 秒ごとに読む(詳細ページや別のタブで始めた処理も帯に出す)。
import { jobsApi, type JobInfo, type JobRequest } from './api.ts';

export class JobStore {
  job = $state<JobInfo | null>(null);
  /** 開始・中止に失敗した理由(帯に role=alert で出す) */
  error = $state('');
  /** 経過時間の表示に使う今の時刻(実行中だけ 1 秒ごとに進める) */
  now = $state(Date.now());
  /** 「閉じる」で隠した処理の id */
  dismissed = $state<string | null>(null);
  /** この画面で動いているのを見た最後の処理の id(読み込む前に終わっていた処理と区別する) */
  live = $state<string | null>(null);
  busy = $state(false);
  readonly token: string;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #clock: ReturnType<typeof setInterval> | null = null;
  #polling = false;

  constructor(token: string) {
    this.token = token;
  }

  get running(): boolean {
    return this.job?.state === 'running';
  }

  #set(job: JobInfo | null): void {
    if (job?.state === 'running') this.live = job.id;
    this.job = job;
  }

  #schedule(ms: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = this.#polling ? setTimeout(() => void this.poll(), ms) : null;
  }

  async poll(): Promise<void> {
    if (!this.#polling) return;
    try {
      this.#set(await jobsApi.current(this.token));
    } catch {
      /* サーバが止まったことは heartbeat が知らせる(帯は前の状態のまま) */
    }
    this.now = Date.now();
    this.#syncClock();
    this.#schedule(this.running ? 1000 : 5000);
  }

  #syncClock(): void {
    if (this.running && !this.#clock) this.#clock = setInterval(() => (this.now = Date.now()), 1000);
    else if (!this.running && this.#clock) {
      clearInterval(this.#clock);
      this.#clock = null;
    }
  }

  startPolling(): void {
    if (this.#polling) return;
    this.#polling = true;
    void this.poll();
  }

  stopPolling(): void {
    this.#polling = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#clock) clearInterval(this.#clock);
    this.#clock = null;
  }

  async run(req: JobRequest): Promise<boolean> {
    this.error = '';
    this.busy = true;
    try {
      this.#set(await jobsApi.start(this.token, req));
      this.dismissed = null;
      this.now = Date.now();
      this.#syncClock();
      this.#schedule(1000);
      return true;
    } catch (e) {
      this.error = (e as Error).message;
      void this.poll();
      return false;
    } finally {
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    this.error = '';
    try {
      this.#set(await jobsApi.cancel(this.token));
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.#schedule(500);
  }
}
