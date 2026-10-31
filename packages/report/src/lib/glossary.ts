// 共有読者向けの用語説明。out/glossary.html(別ページ)に載せ、atlas.html と詳細ページからリンクする。

export interface Term {
  id: string;
  term: string;
  body: string;
}

export const GLOSSARY: Term[] = [
  {
    id: 'nano-aiu',
    term: 'nano AIU',
    body: 'Copilot の AI クレジットの内部単位で、ログ(total_nano_aiu)に記録されます。画面では 10 億分の 1 にした AIU で表示します。リクエストごとにモデルとトークン量に応じた値が付くので、モデルをまたいだ消費量の比較に使えます。料金への換算方法は公開情報で確認できていないため、金額としては扱いません。',
  },
  {
    id: 'aiu',
    term: 'AI 使用量(AIU)',
    body: 'nano AIU を 10 億(10^9)で割った値で、桁区切りで表示します(例: nano AIU 2,500,000,000 → 2.5 AIU)。記録のあるセッションだけの合計で、金額には換算していません。',
  },
  {
    id: 'premium-request',
    term: 'premium request',
    body: 'GitHub Copilot の旧来の課金単位。ユーザーが起点のリクエスト 1 回にモデルごとの倍率(例: 1 倍、0.33 倍)を掛けた値の合計です。ログに記録のあるセッションだけの合計で、記録の無い古いセッションや新しい課金(AI クレジット)のセッションは含みません。',
  },
  {
    id: 'tokens',
    term: '入力 / 出力 / キャッシュ読取トークン',
    body: '入力はモデルに渡した文脈の量、出力はモデルが生成した量、キャッシュ読取は入力のうち前回の文脈を再利用できた量です。入力トークンは 2026 年 7 月以降のログか、セッション終了時の累計(shutdown)がある場合にだけ分かります。それ以外は「推計不可」として合計に含めていません。',
  },
  {
    id: 'compaction',
    term: 'compaction(文脈圧縮)',
    body: '会話が長くなりモデルの文脈上限に近づいたとき、Copilot がそれまでの経過を要約して文脈を詰め直す処理。回数が多いセッションは、長い作業か、文脈を食う操作が多かったことを示します。',
  },
  {
    id: 'skill',
    term: 'skill',
    body: '特定の作業手順をまとめた指示パッケージ。エージェントが必要なときに呼び出して手順を読み込みます(例: wiki-query)。',
  },
  {
    id: 'skill-trigger',
    term: 'skill を呼んだ側',
    body: '「利用者が呼んだ」は skill.invoked の trigger が user-invoked(利用者がスラッシュコマンドなどで指定)、「エージェントが呼んだ」は agent-invoked と、エージェントの skill ツール呼び出しです。trigger を記録しない古いログは「不明」です。',
  },
  {
    id: 'unused-skill',
    term: 'インストール済みで未使用の skill',
    body: 'スナップショット時に ~/.copilot/skills/ と installed-plugins/ のディレクトリ名だけを記録し(SKILL.md の中身は読みません)、絞り込んだセッションで一度も呼ばれなかったものを挙げます。settings.json の disabledSkills で無効にしたものには「無効」と付けます。',
  },
  {
    id: 'mcp',
    term: 'MCP サーバー',
    body: 'Model Context Protocol で外部の機能(GitHub の検索、IDE の診断など)をツールとして提供するサーバー。ツール名は「サーバー名-ツール名」で記録されるため、利用ランキングではサーバーごとに 1 行にまとめています。',
  },
  {
    id: 'tool-failure-rate',
    term: 'ツールの失敗率',
    body: '(失敗 + 拒否)÷ 結果の記録がある回数。失敗はツールがエラーを返したもの(error.code が failure など)、拒否は利用者や権限設定が実行を断ったもの(denied)です。中断などで結果の記録が無い呼び出しは分母に含めません。',
  },
  {
    id: 'lines',
    term: '変更行数',
    body: 'エージェントがファイルに加えた変更の行数(追加 / 削除)。セッション終了時の累計(session.shutdown の codeChanges)を優先し、無ければツールごとの行数(toolTelemetry)を合計します。どちらも無いセッションは「記録なし」で、合計には含めません。',
  },
  {
    id: 'project-merge',
    term: 'プロジェクトのまとめ方',
    body: 'ログの repository を使い、無ければ作業フォルダの git の設定(.git/config。worktree は共有の設定)の origin から「所有者/リポジトリ」を読んで束ねます。一時フォルダでの試行は「(一時フォルダ)」、ホームディレクトリそのもので開いたものは「(ホーム)」、このツール自身の工数判定の実行は「(atlas の判定)」に 1 つずつまとめます。',
  },
  {
    id: 'agent',
    term: 'agent(サブエージェント)',
    body: 'メインのエージェントが調査や実装の一部を任せるために起動する別のエージェント。独自の文脈とトークン消費を持ちます。',
  },
  {
    id: 'hook',
    term: 'hook',
    body: 'セッション開始やツール実行の前後など、決まった時点で自動実行されるスクリプト。件数はその実行回数です。',
  },
  {
    id: 'instructions',
    term: '指示ファイル',
    body: 'AGENTS.md / CLAUDE.md / copilot-instructions.md など、セッション開始時にエージェントへ自動で読み込まれる規約ファイル。リポジトリ単位のものとユーザー単位のものがあります。',
  },
  {
    id: 'llm-wiki',
    term: 'llm-wiki',
    body: '作者がエージェントと共同で維持している個人のナレッジ集(Markdown の vault)。索引(index.md)を読んでから個別ページを読む使い方を想定しており、その参照回数を数えています。',
  },
  {
    id: 'friction',
    term: '摩擦',
    body: '作業が滞った兆候の件数の合計: compaction、中断(abort)、エラー、権限の確認、ユーザーへの質問(ask_user)、ツール失敗、サブエージェント失敗。「エラー」はセッション全体のエラー(session.error。利用上限・通信エラーなど)で、個々のツール呼び出しの失敗は「ツール失敗」として別に数えます。少ないほど良いとは限らず、確認を求めるのは正しい振る舞いのこともあります。',
  },
  {
    id: 'highlights',
    term: '要点',
    body: '絞り込み後の集計から決まった規則で選んだ短い一覧(AI 使用量の大きいセッション、失敗率の高いツール、compaction の多いセッション、未使用の skill)。LLM は使っていません。各項目のリンクは根拠のセッションの詳細ページか、そのツールを使ったセッションへの絞り込みです。',
  },
  {
    id: 'mode',
    term: 'モード(interactive / plan / autopilot)',
    body: 'Copilot の動かし方。interactive は 1 回ずつ確認しながら、plan は先に計画を立てる、autopilot は確認なしで続けて進めます。依頼ごとに user.message の agentMode、無ければ直前の session.mode_changed で決めます。どちらの記録も無い依頼は既定の interactive とみなし、その件数を別に示します(実データでは最初のモード変更の変更前は全件 interactive)。',
  },
  {
    id: 'reasoning-effort',
    term: '推論強度(reasoningEffort)',
    body: 'モデルが答える前に考える量の設定(low / medium / high / xhigh / max など)。強いほど出力(推論)トークンと待ち時間が増える傾向があります。リクエストごとの記録を使い、無ければその時点のセッションの設定(session.start / model_change)で補います。',
  },
  {
    id: 'initiator',
    term: 'リクエストの起点(initiator)',
    body: 'API リクエストを誰が起こしたか。「利用者の依頼」は依頼を受けて最初に出るもの、「エージェント」はツールの結果を受けて続けるもの、「サブエージェント」は起動された別のエージェントのもの、「compaction」は文脈圧縮のためのもの。利用者の依頼の割合が小さいほど、1 回の依頼でエージェントが長く自走しています。',
  },
  {
    id: 'context-breakdown',
    term: '文脈の内訳(ツール定義)',
    body: 'モデルに渡す文脈を、system(指示など)・会話・ツール定義に分けたトークン数(session.shutdown / compaction_complete の記録)。ツール定義は使えるツール(MCP を含む)の説明で、毎リクエストの文脈に常に入る固定費です。ツールを増やすほど大きくなります。',
  },
  {
    id: 'latency',
    term: '待ち時間(最初のトークンまで / p90)',
    body: '「最初のトークンまで」はリクエストを送ってから応答が出始めるまで、「リクエスト全体」は応答が出終わるまでの時間(ミリ秒の記録)。中央値は真ん中の値、p90 は遅い方から 1 割の境目の値です。',
  },
  {
    id: 'tool-duration',
    term: 'ツールの所要時間',
    body: 'ツール呼び出しの開始から完了までの時間(tool.execution_start と complete を toolCallId で対応付け)。1 時間を超えるもの(放置や利用者の返答待ち)は外れ値として中央値・p90 から除き、件数だけ示します。ask_user や task(サブエージェント)は待ちを含むため長くなります。',
  },
  {
    id: 'permission-result',
    term: '権限の確認の結果',
    body: 'ツールの実行に利用者の許可が必要だったときの結果(permission.completed)。「承認」は approved と approved-for-location(その場所は以後も許可)、「拒否」は denied で始まるもの(承認の規則が無く利用者にも聞けなかった場合を含む)。',
  },
  {
    id: 'todo',
    term: 'todo',
    body: 'エージェントが作業の段取りとしてセッションの session.db に残す項目と、その状態(未着手 / 進行中 / 完了 / 保留)。スナップショットに session.db を複製して状態別の件数と依存関係の数だけを読みます(タイトルは読みません)。完了率は完了 ÷ 全件で、セッション終了時点の値です。',
  },
  {
    id: 'empty-session',
    term: '空のセッション',
    body: '依頼・ツール呼び出し・応答がどれも無いセッション(アプリで開いただけのものなど)。既定では集計・一覧・プロジェクト表・中央値のすべてから外し、件数だけ表示します。絞り込みの「空のセッションを含める」で含められます。',
  },
  {
    id: 'internal-tool',
    term: '内部ツール',
    body: 'エージェントが作業の途中経過を画面に出すためなどに呼ぶツール(report_intent)。作業としてのツール呼び出しには数えず、件数だけ別に表示します。',
  },
  {
    id: 'missing-tokens',
    term: 'トークン記録なし(欠測)',
    body: '依頼や応答があるのに、トークン量の記録(session-store.db、usage_record、終了時の累計、assistant.message の outputTokens)がどれも残っていないセッション。2026 年 9 月以降のログは assistant.message に outputTokens を書かなくなったため、他の記録が無いと出力トークンも分かりません。合計には 0 として足さず、件数を「入力トークン記録の内訳」に出します。',
  },
  {
    id: 'model-name',
    term: 'モデル名の表記',
    body: '同じモデルが記録の出所によって claude-haiku-5-5 / claude-haiku-5.5 / <ID>/claude-haiku-5-5 のように別の書き方で残るため、claude-haiku-5.5 の形にそろえて集計しています。',
  },
  {
    id: 'active-time',
    term: '所要時間 / 実働時間',
    body: '所要時間は最初と最後のイベントの差(壁時計)。実働時間は 5 分を超えてイベントが無かった区間を除いた時間で、放置していた時間を含みません。',
  },
  {
    id: 'human-effort',
    term: '推定人手工数',
    body: '同じタスクを人が手作業でやった場合の時間を LLM に推定させた値(judgments.json)。推定であり実測ではありません。判定をまだ回していないセッションは「未判定」です。幅(low〜high)と確信度(0〜100%)も LLM の自己申告で、確信度が低いものは参考程度に見てください。',
  },
  {
    id: 'human-vs-ai',
    term: '推定人手工数 ÷ AI の実働',
    body: '判定済みのセッションについて、推定人手工数の合計を AI の実働時間(5 分を超える空白を除いた時間)の合計で割った値。人が付き添った時間や確認の手間は AI の実働に含まれないため、削減量そのものではなく目安です。',
  },
];
