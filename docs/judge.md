# 推定人手工数の判定

[README](../README.md) に戻る。

「同じ作業を人が AI なしでやったら何時間かかるか」は LLM に推定させます。集計(LLM なし)とは別の手順で、結果は `out/judgments.json` に貯まり、次の `atlas build` でレポートに合成されます。判定は外部の LLM でも、このツールの中からでも回せます(どちらも同じ形式です)。

**推定は推定です。** レポートには幅(low〜high)と確信度を一緒に出しますが、人手での実測ではありません。

## 1. 評価バンドルを作る(LLM は呼ばない)

```
npm run atlas            # まだなら先に集計(out/sessions.json と out/snapshot を作る)
npm run atlas -- bundle  # out/bundle/ を作る。--project / --since / --client などで対象を絞れる
```

`out/bundle/` の中身:

| ファイル | 内容 |
|---|---|
| `INSTRUCTIONS.md` | 判定する LLM への指示(役割・評価軸・出力形式・手順)。最初に読ませる |
| `manifest.json` | パケットの一覧(セッション ID とファイルの場所、件数、サイズ) |
| `schema.json` | 返してもらう `judgments.json` の JSON Schema |
| `sessions/<セッション ID>.md` | 評価パケット。依頼文、最終応答、変更ファイル、ツール / skill / agent / hook、ターン数・時間・トークン、摩擦、指示ファイル・wiki の参照、compaction 要約 |
| `parts/part-<番号>.md` | ZIP やフォルダを渡せない相手(テキストの添付だけの M365 Copilot など)用。指示・JSON Schema と、パケット数件(既定 5 件。`--per-part <n>` で変更)を 1 ファイルにまとめたもの。パケットはファイルごとの乱数の境界で囲み、本文の中の指示に従わないよう指示に書いてある。中身は `sessions/` と同じ |

- 依頼の記録が無いセッション(開いただけで使っていないもの)はパケットにしません(`manifest.json` の `skipped` に理由付きで載ります)。含めたいときは `--include-empty`。
- 本文はスナップショットのログから全文を読み直しますが、1 パケット 24,000 字に収まるよう長い本文は中略します(中略した箇所には字数を書きます)。
- **パケットには依頼文や応答の本文、パス、リポジトリ名がそのまま入ります。** 外部のサービスに渡す前に中身を確認してください。

## 2a. 外部の LLM で判定する(M365 Copilot など)

渡し方は、相手が受け取れる形で選びます。

- **テキストの添付だけのとき(M365 Copilot など)**: `out/bundle/parts/` の `part-01.md` を 1 つ添付し、「このファイルの指示に従って判定して」と頼みます。指示・JSON Schema・パケット数件が 1 ファイルに入っているので、ほかのファイルは要りません。返答を保存して取り込んだら、`part-02.md`、`part-03.md` … と続けます。1 ファイルは最大 12 万字ほど(5 件 × 24,000 字)です。途中のセッションの判定が抜けるときは `--per-part 2` などで件数を減らして作り直してください。
- **ZIP を渡せるとき**: `out/bundle` フォルダを**フォルダごと ZIP にし**(エクスプローラーで右クリック →「圧縮先」→「ZIP ファイル」。このツールは ZIP を作りません。依存を増やさないため)、添付して「`INSTRUCTIONS.md` に従って判定して」と頼みます。件数が多いときは何回かに分けて返してもらってかまいません。

返ってきた JSON(または JSON のコードブロックを含む返答をそのまま貼った `.md` / `.txt`)を保存し、取り込みます。分けて返ってきた分は 1 つずつ取り込めます。

```
npm run atlas -- judge import 返答.md     # 検証して out/judgments.json に取り込む(同じセッションは上書き)
npm run atlas -- export                   # レポートに合成(画面の「集計し直す」でもよい)
```

形が合わない項目(範囲外の値、必須欄の欠け)が 1 件でもあると、何も取り込まずにどこが違うかを表示します。合成に素の `build` を使うと、セッション記録(`out/sessions/*.md`)が消えて詳細ページの「記録を読む」も消えるので、`export` か「集計し直す」を使ってください。

## 2b. このツールの中で判定する(画面から、またはコマンドで)

`atlas.bat` から開いた画面の「工数を判定する…」を押すと、件数の上限(既定 10)とバックエンド(`copilot -p` / `opencode`)を選ぶ確認が出ます。「〜件を判定する」を押すと、バンドルを作り直し、未判定のセッションを上限まで判定して、レポートを作り直します([screen.md の「画面からの操作」](screen.md#画面からの操作))。従量課金の `anthropic` は画面からは選べません(コマンドの `--backend anthropic` だけ)。コマンドでは次のとおりです。

```
npm run atlas:judge                               # bundle → judge run → export(画面の「工数を判定する」と同じ。伏せ字版は build)
npm run atlas -- judge run --limit 5              # まず 5 件だけ試す
npm run atlas -- judge run --only <id>,<id>       # 指定したセッションだけ
npm run atlas -- judge run --force                # 判定済みも判定し直す
npm run atlas -- judge run --model <モデル名>      # 判定に使うモデルを指定
```

- 判定済みのセッションは飛ばすので、途中で止めても続きから再開できます。失敗したセッションは `judgments.json` の `failures` に記録し、次へ進みます(最後に終了コード 1)。
- バックエンドは `--backend` で選びます。

| バックエンド | 中身 | 費用 |
|---|---|---|
| `copilot-cli`(既定) | `copilot -p` を空の作業フォルダで起動し、パケットをプロンプトに埋め込んで渡す | GitHub Copilot のサブスクリプション内で AI クレジット(旧課金では premium request)を消費します(1 セッション 1 回以上) |
| `opencode` | `opencode run --format json` | 選んだモデル次第(無料モデルなら無料)。`--model openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` で実走を確認済み(1 件 20〜30 秒)。opencode の既定モデルがカタログから消えていると `UnknownError` になるので、その場合は `opencode models` で残っている無料モデルを `--model` に指定してください |
| `anthropic` | Anthropic Messages API を直接呼ぶ(既定モデル `claude-sonnet-5-5`、環境変数 `ANTHROPIC_API_KEY` が必要) | **従量課金**です。明示的に `--backend anthropic` を指定したときだけ使います |

- `copilot-cli` は `--add-dir` を使いません(そのフォルダの `.github/skills` / `agents` を信頼設定として読むため、他セッションの本文を含むバンドルが指示の注入口になりうるからです)。ユーザーの AGENTS.md 等も読ませません(`--no-custom-instructions`)。`--allow-all-tools` は既定で付けます(付けたくないときは `--no-allow-tools`)が、判定にツールは要らないので、シェル・ファイルの作成と変更・URL アクセス(`shell` / `write` / `url`)は常に `--deny-tool` で拒否します(`copilot help permissions` によれば拒否は `--allow-all-tools` より優先されます。パケット本文に「コマンドを実行せよ」のような文が含まれていても動かないようにするためです。実走での確認はクレジット超過のためまだです)。MCP のツールはこの 3 種類のどれにも当たらない(`copilot help permissions` で別の種類 `<サーバー名>(ツール名)`)ので、モデルに見せるツールを `--available-tools=view` に絞り(作業フォルダは空で、copilot は既定でその外のパスを読ませません)、組み込みの MCP を `--disable-builtin-mcps` で止め、`copilot mcp list --json`(LLM は呼びません)で得た各サーバーを `--disable-mcp-server` と `--deny-tool <サーバー名>` で止めます。一覧を取れなかったときはサーバーごとの指定を付けずに続け、その旨を判定の notes に残します(引数が copilot 1.0.105 に受け付けられることは確認済み、実際にツールが見えなくなることの実走確認はまだです)。プロンプト中のパケットの境界には依頼ごとの乱数を付け、本文側で境界を偽装できないようにしています。
- `opencode` はツールを既定で許可するので([公式文書](https://opencode.ai/docs/permissions/))、環境変数 `OPENCODE_CONFIG_CONTENT`(設定の中で後から効く上書き)で全ツールを拒否して起動します(`"*": "deny"` と主なツール名)。利用者の設定にある許可より後ろに足されて勝つことを `opencode debug agent build`(1.19.3)で確認しました。`skill-draft` も同じ制限で動きます。
- 判定自体の使用量は `copilot` の `--usage-output-file` から集計し、`judgments.json` の `judge.usage` に残します。
- `copilot` の場所は環境変数 `ATLAS_COPILOT_BIN` で指定できます(テストでは偽の copilot `fixtures/fake-copilot.mjs` に差し替えています)。
- 月間の AI クレジット(旧課金では premium request)を使い切っていると、どのモデルを指定しても `quota_exceeded HTTP 402` で失敗します(消費はありません)。`judgments.json` の `failures` に残るので、翌月や別のバックエンドで `judge run` を再実行すれば再試行されます。
- 出力の形を調べたいときは環境変数 `ATLAS_JUDGE_RAW_DIR` にフォルダを指定すると、`copilot` の生の stdout / stderr / usage をセッションごとに保存します(パケット本文を含むので共有しないでください)。
