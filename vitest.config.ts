import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/test/**/*.test.ts'] } },
      // 実データ(ATLAS_LIVE=1)は数百 MB を読むので時間に余裕を持たせる。
      // phase1 と phase2 の実データ検査はどちらも out/live に書くので、ファイル単位でも並列にしない
      // fixture は git に入れず、globalSetup が scripts/synthetic-fixtures.ts で毎回 .fixtures/ に作る(架空の値だけ)
      {
        test: {
          name: 'e2e',
          include: ['e2e/**/*.test.ts'],
          globalSetup: ['e2e/global-setup.ts'],
          testTimeout: 600_000,
          hookTimeout: 600_000,
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
