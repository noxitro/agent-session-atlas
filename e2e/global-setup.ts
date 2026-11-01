// E2E の前に fixture(.fixtures/)を架空の値だけで作り直す(vitest の globalSetup)。
// サンプルデータはリポジトリに置かないので、新しく clone した状態でも npm run e2e だけで動く。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFixtures } from '../scripts/synthetic-fixtures.ts';
import { FIXTURE_WIKIS, FIXTURES } from './fixture-home.ts';

export default async function setup(): Promise<void> {
  await writeFixtures();
  // リポジトリ直下の atlas.config.json(利用者の手元の設定)が E2E に効かないよう、fixture 用の設定を指す
  const config = join(FIXTURES, 'atlas.config.json');
  writeFileSync(config, JSON.stringify({ wikis: FIXTURE_WIKIS }));
  process.env.ATLAS_CONFIG = config;
}
