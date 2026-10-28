// E2E の前に fixture(.fixtures/)を架空の値だけで作り直す(vitest の globalSetup)。
// サンプルデータはリポジトリに置かないので、新しく clone した状態でも npm run e2e だけで動く。
import { writeFixtures } from '../scripts/synthetic-fixtures.ts';

export default async function setup(): Promise<void> {
  await writeFixtures();
}
