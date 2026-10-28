// 判定バックエンドの共通の形
import type { BackendName, JudgmentItem } from '../schema.ts';

export interface JudgePacket {
  sessionId: string;
  /** 評価パケット(Markdown) */
  markdown: string;
}

export interface JudgeResult {
  /** 検証済みの項目(judge メタは run 側で付ける) */
  item: JudgmentItem;
  /** バックエンドが返した判定自体の使用量(形は問わない)。取れなければ null */
  usage: unknown | null;
  /** 補足(usage が取れなかった理由など) */
  notes: string[];
}

export interface JudgeBackend {
  name: BackendName;
  model: string | null;
  judge(packet: JudgePacket): Promise<JudgeResult>;
}
