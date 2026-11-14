// まとめたプロジェクトのキー(表示名を兼ねる)。node: に依存しないので、ブラウザ側(report)からも読める。

export const HOME_PROJECT = '(ホーム)';
export const TEMP_PROJECT = '(一時フォルダ)';
export const ATLAS_JUDGE_PROJECT = '(atlas の判定)';
export const GROUPED_PROJECTS: ReadonlySet<string> = new Set([HOME_PROJECT, TEMP_PROJECT, ATLAS_JUDGE_PROJECT]);
