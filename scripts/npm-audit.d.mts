// scripts/npm-audit.mjs の型(scripts/npm-audit.test.ts が tsc で読むため。中身は .mjs と合わせる)
export declare const LEVELS: string[];
export declare class AuditError extends Error {}
export interface IgnoreEntry {
  id: string;
  package: string;
  reason: string;
  removeWhen: string;
}
export interface Advisory {
  id: string;
  package: string;
  severity: string;
  title: string;
  url: string;
  range: string;
}
export declare function parseIgnoreList(json: unknown): IgnoreEntry[];
export declare function collectAdvisories(audit: unknown): Advisory[];
export declare function decide(
  audit: unknown,
  ignoreJson: unknown,
  level?: string,
): {
  failing: Advisory[];
  ignoredHits: (Advisory & { reason: string; removeWhen: string })[];
  staleIgnores: IgnoreEntry[];
};
