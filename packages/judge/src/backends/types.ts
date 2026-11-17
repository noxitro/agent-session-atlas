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

/** プロンプトを 1 回渡して返った本文(依頼ごとの判定など、セッションの判定以外に使う) */
export interface AskResult {
  /** assistant の本文(出現順) */
  texts: string[];
  usage: unknown | null;
  notes: string[];
}

export interface JudgeBackend {
  name: BackendName;
  model: string | null;
  judge(packet: JudgePacket): Promise<JudgeResult>;
  /** プロンプトをそのまま渡す(label は生の出力を残すときのファイル名)。copilot-cli だけが持つ */
  ask?(prompt: string, label: string): Promise<AskResult>;
}
