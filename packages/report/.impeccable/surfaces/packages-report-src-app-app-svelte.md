---
version: 1
slug: "packages-report-src-app-app-svelte"
primary_target: "packages/report/src/app/App.svelte"
related_targets: ["packages/report/src/detail.ts"]
---

# Surface brief: atlas レポート(out/atlas.html と out/sessions/<id>.html)

- モード: Operate(ダッシュボード)。主読者は作者本人、二次読者は共有相手(文脈なし)。PC ブラウザ主、モバイルは崩れなければよい。
- 仕事: 全体 → 絞り込み → 根拠のセッション、の順に辿る。欠測(入力トークン記録なし)を隠さない。
- 制約: file:// 単一 HTML、外部参照なし、システムフォント、ライト/ダーク、色だけに頼らない、キーボードでフィルタ操作。
- 進め方の注記: サブエージェント(非対話)で実行したため、方向決定の問い合わせは行わず、concept-seed の割り当てに従って自分で決めた。

## Direction contract

THESIS: 申告書・検針票のような「様式」。全数値が罫線で仕切られた記入欄に収まり、欄の左上に小さな項目名が刷られている。カード並べの SaaS ダッシュボードを拒む。
OWN-WORLD: 白地に様式の緑インク(罫線・項目名)、本文は墨。角丸なし、1px の罫だけで区切る。グラフ系列は dataviz 既定パレット。
STORY: 読者は全体の記入欄で規模と欠測を掴み、フィルタ行で絞り、プロジェクト表から根拠のセッション詳細へ降りる。
FIRST VIEWPORT: 上端に表題と生成日時、その下に 1 行のフィルタ行と「表示中 N / 全 M」、続いて全体サマリの記入欄グリッド(4 列)と入力トークン記録の内訳帯。
FORM: 官公庁の帳票(自分の候補リスト 5 番目)。seed key 9216d271。挑戦者 japanese-high-density-web は competitive: 名前付きグリッド領域と罫の一貫した体系を借りた。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
