// 共有読者向けの用語説明。out/glossary.html(別ページ)に載せ、atlas.html と詳細ページからリンクする。

export type GroupId = 'units' | 'time' | 'records' | 'mechanics' | 'effort' | 'insights';

export interface TermGroup {
  id: GroupId;
  title: string;
  /** 分類の 1 行の説明(目次と見出しの下) */
  lead: string;
}

/** 用語の分類。用語ページでは各分類が h2(id は g-<id>)になり、目次はこの 6 つだけを載せる。並びは読む順(消費 → 時間 → 記録 → 仕組み → 工数 → 改善点) */
export const GLOSSARY_GROUPS: TermGroup[] = [
  { id: 'units', title: '消費の単位', lead: 'AI 使用量・トークン・リクエストなど、「どれだけ使ったか」を数える単位。' },
  { id: 'time', title: '時間と待ち', lead: '所要時間・実働時間・待ち時間など、「どれだけ掛かったか」の測り方。' },
  { id: 'records', title: '記録の由来と欠測', lead: '数値がどの記録から来ているか、無いときに何と表示するか、どうまとめているか。' },
  { id: 'mechanics', title: '動かし方と拡張の仕組み', lead: 'モード・推論強度・compaction と、skill / MCP / agent / hook / 指示ファイル / llm-wiki。' },
  { id: 'effort', title: '工数と判定', lead: '推定人手工数・摩擦・権限の確認・todo・要点など、「うまく進んだか」を見る欄。' },
  { id: 'insights', title: '改善点の指標', lead: '改善点の節とページ(insights.html)で使う、LLM を呼ばない規則の指標と閾値。' },
];

export interface Term {
  id: string;
  group: GroupId;
  term: string;
  body: string;
}

/** 分類ごとの用語(GLOSSARY の並び順のまま) */
export function termsByGroup(group: GroupId): Term[] {
  return GLOSSARY.filter((t) => t.group === group);
}

export const GLOSSARY: Term[] = [
  {
    id: 'nano-aiu',
    group: 'units',
    term: 'nano AIU',
    body: 'Copilot の AI クレジットの内部単位で、ログ(total_nano_aiu)に記録されます。画面では 10 億分の 1 にした AIU で表示します。リクエストごとにモデルとトークン量に応じた値が付くので、モデルをまたいだ消費量の比較に使えます。料金への換算方法は公開情報で確認できていないため、金額としては扱いません。',
  },
  {
    id: 'aiu',
    group: 'units',
    term: 'AI 使用量(AIU)',
    body: 'nano AIU を 10 億(10^9)で割った値で、桁区切りで表示します(例: nano AIU 2,500,000,000 → 2.5 AIU)。記録のあるセッションだけの合計で、金額には換算していません。',
  },
  {
    id: 'premium-request',
    group: 'units',
    term: 'premium request',
    body: 'GitHub Copilot の旧来の課金単位。ユーザーが起点のリクエスト 1 回にモデルごとの倍率(例: 1 倍、0.33 倍)を掛けた値の合計です。ログに記録のあるセッションだけの合計で、記録の無い古いセッションや新しい課金(AI クレジット)のセッションは含みません。',
  },
  {
    id: 'tokens',
    group: 'units',
    term: '入力 / 出力 / キャッシュ読取トークン',
    body: '入力はモデルに渡した文脈の量、出力はモデルが生成した量、キャッシュ読取は入力のうち前回の文脈を再利用できた量です。入力トークンは 2026 年 7 月以降のログか、セッション終了時の累計(shutdown)がある場合にだけ分かります。それ以外は「推計不可」として合計に含めていません。',
  },
  {
    id: 'compaction',
    group: 'mechanics',
    term: 'compaction(文脈圧縮)',
    body: '会話が長くなりモデルの文脈上限に近づいたとき、Copilot がそれまでの経過を要約して文脈を詰め直す処理。回数が多いセッションは、長い作業か、文脈を食う操作が多かったことを示します。',
  },
  {
    id: 'skill',
    group: 'mechanics',
    term: 'skill',
    body: '特定の作業手順をまとめた指示パッケージ。エージェントが必要なときに呼び出して手順を読み込みます(例: wiki-query)。',
  },
  {
    id: 'skill-trigger',
    group: 'mechanics',
    term: 'skill を呼んだ側',
    body: '「利用者が呼んだ」は skill.invoked の trigger が user-invoked(利用者がスラッシュコマンドなどで指定)、「エージェントが呼んだ」は agent-invoked と、エージェントの skill ツール呼び出しです。trigger を記録しない古いログは「不明」です。',
  },
  {
    id: 'unused-skill',
    group: 'mechanics',
    term: 'インストール済みで未使用の skill',
    body: 'スナップショット時に ~/.copilot/skills/ と installed-plugins/ のディレクトリ名だけを記録し(SKILL.md の中身は読みません)、絞り込んだセッションで一度も呼ばれなかったものを挙げます。settings.json の disabledSkills で無効にしたものには「無効」と付けます。',
  },
  {
    id: 'mcp',
    group: 'mechanics',
    term: 'MCP サーバー',
    body: 'Model Context Protocol で外部の機能(GitHub の検索、IDE の診断など)をツールとして提供するサーバー。ツール名は「サーバー名-ツール名」で記録されるため、利用ランキングではサーバーごとに 1 行にまとめています。',
  },
  {
    id: 'tool-failure-rate',
    group: 'effort',
    term: 'ツールの失敗率',
    body: '(失敗 + 拒否)÷ 結果の記録がある回数。失敗はツールがエラーを返したもの(error.code が failure など)、拒否は利用者や権限設定が実行を断ったもの(denied)です。中断などで結果の記録が無い呼び出しは分母に含めません。',
  },
  {
    id: 'lines',
    group: 'records',
    term: '変更行数',
    body: 'エージェントがファイルに加えた変更の行数(追加 / 削除)。セッション終了時の累計(session.shutdown の codeChanges)を優先し、無ければツールごとの行数(toolTelemetry)を合計します。どちらも無いセッションは「記録なし」で、合計には含めません。終了時の codeChanges が 0 行・0 件なのにファイルの変更があるときは、ツールごとの行数で数えます。サブエージェントが行った編集は行数が残らないため「記録なし(サブエージェントの変更は数えられない)」です。',
  },
  {
    id: 'project-merge',
    group: 'records',
    term: 'プロジェクトのまとめ方',
    body: 'ログの repository を使い、無ければ作業フォルダの git の設定(.git/config。worktree は共有の設定)の origin から「所有者/リポジトリ」を読んで束ねます。一時フォルダでの試行は「(一時フォルダ)」、ホームディレクトリそのもので開いたものは「(ホーム)」、このツール自身の工数判定の実行は「(atlas の判定)」に 1 つずつまとめます。',
  },
  {
    id: 'agent',
    group: 'mechanics',
    term: 'agent(サブエージェント)',
    body: 'メインのエージェントが調査や実装の一部を任せるために起動する別のエージェント。独自の文脈とトークン消費を持ちます。',
  },
  {
    id: 'hook',
    group: 'mechanics',
    term: 'hook',
    body: 'セッション開始やツール実行の前後など、決まった時点で自動実行されるスクリプト。件数はその実行回数です。',
  },
  {
    id: 'instructions',
    group: 'mechanics',
    term: '指示ファイル',
    body: 'AGENTS.md / CLAUDE.md / copilot-instructions.md など、セッション開始時にエージェントへ自動で読み込まれる規約ファイル。リポジトリ単位のものとユーザー単位のものがあります。',
  },
  {
    id: 'llm-wiki',
    group: 'mechanics',
    term: 'llm-wiki',
    body: 'エージェントと共同で維持する個人のナレッジ集(vault)。索引を読んでから個別ページを読む使い方を想定しており、その参照回数を数えています。対象の vault と形式は atlas.config.json で指定します。指定が無ければ集計しないので、件数は 0 になります。',
  },
  {
    id: 'friction',
    group: 'effort',
    term: '摩擦',
    body: '作業が滞った兆候の件数の合計: compaction、中断(abort)、エラー、権限の確認、ユーザーへの質問(ask_user)、ツール失敗、サブエージェント失敗。「エラー」はセッション全体のエラー(session.error。利用上限・通信エラーなど)で、個々のツール呼び出しの失敗は「ツール失敗」として別に数えます。少ないほど良いとは限らず、確認を求めるのは正しい振る舞いのこともあります。サブエージェントの失敗で session.error と subagent.failed が対になって記録されたときは「agent 失敗」だけに数え、続けて記録された中断(2 秒以内)は 1 回の中断として数えます。',
  },
  {
    id: 'highlights',
    group: 'effort',
    term: '要点',
    body: '絞り込み後の集計から決まった規則で選んだ短い一覧(AI 使用量の大きいセッション、失敗率の高いツール、compaction の多いセッション、未使用の skill)。LLM は使っていません。各項目のリンクは根拠のセッションの詳細ページか、そのツールを使ったセッションへの絞り込みです。',
  },
  {
    id: 'mode',
    group: 'mechanics',
    term: 'モード(interactive / plan / autopilot)',
    body: 'Copilot の動かし方。interactive は 1 回ずつ確認しながら、plan は先に計画を立てる、autopilot は確認なしで続けて進めます。依頼ごとに user.message の agentMode、無ければ直前の session.mode_changed で決めます。どちらの記録も無い依頼は既定の interactive とみなし、その件数を別に示します(実データでは最初のモード変更の変更前は全件 interactive)。',
  },
  {
    id: 'reasoning-effort',
    group: 'mechanics',
    term: '推論強度(reasoningEffort)',
    body: 'モデルが答える前に考える量の設定(low / medium / high / xhigh / max など)。強いほど出力(推論)トークンと待ち時間が増える傾向があります。リクエストごとの記録を使い、無ければその時点のセッションの設定(session.start / model_change)で補います。',
  },
  {
    id: 'initiator',
    group: 'units',
    term: 'リクエストの起点(initiator)',
    body: 'API リクエストを誰が起こしたか。「利用者の依頼」は依頼を受けて最初に出るもの、「エージェント」はツールの結果を受けて続けるもの、「サブエージェント」は起動された別のエージェントのもの、「compaction」は文脈圧縮のためのもの。利用者の依頼の割合が小さいほど、1 回の依頼でエージェントが長く自走しています。',
  },
  {
    id: 'context-breakdown',
    group: 'units',
    term: '文脈の内訳(ツール定義)',
    body: 'モデルに渡す文脈を、system(指示など)・会話・ツール定義に分けたトークン数(session.shutdown / compaction_complete の記録)。ツール定義は使えるツール(MCP を含む)の説明で、毎リクエストの文脈に常に入る固定費です。ツールを増やすほど大きくなります。system・会話がともに 0 の空の終了記録では、ツール定義の割合は出しません。',
  },
  {
    id: 'latency',
    group: 'time',
    term: '待ち時間(最初のトークンまで / p90)',
    body: '「最初のトークンまで」はリクエストを送ってから応答が出始めるまで、「リクエスト全体」は応答が出終わるまでの時間(ミリ秒の記録)。中央値は真ん中の値、p90 は遅い方から 1 割の境目の値です。',
  },
  {
    id: 'tool-duration',
    group: 'time',
    term: 'ツールの所要時間',
    body: 'ツール呼び出しの開始から完了までの時間(tool.execution_start と complete を toolCallId で対応付け)。1 時間を超えるもの(放置や利用者の返答待ち)は外れ値として中央値・p90 から除き、件数だけ示します。ask_user や task(サブエージェント)は待ちを含むため長くなります。',
  },
  {
    id: 'permission-result',
    group: 'effort',
    term: '権限の確認の結果',
    body: 'ツールの実行に利用者の許可が必要だったときの結果(permission.completed)。「承認」は approved と approved-for-location(その場所は以後も許可)、「拒否」は denied で始まるもの(承認の規則が無く利用者にも聞けなかった場合を含む)。',
  },
  {
    id: 'todo',
    group: 'effort',
    term: 'todo',
    body: 'エージェントが作業の段取りとしてセッションの session.db に残す項目と、その状態(未着手 / 進行中 / 完了 / 保留)。スナップショットに session.db を複製して状態別の件数と依存関係の数だけを読みます(タイトルは読みません)。完了率は完了 ÷ 全件で、セッション終了時点の値です。',
  },
  {
    id: 'empty-session',
    group: 'records',
    term: '空のセッション',
    body: '依頼・ツール呼び出し・応答がどれも無いセッション(アプリで開いただけのものなど)。既定では集計・一覧・プロジェクト表・中央値のすべてから外し、件数だけ表示します。絞り込みの「空のセッションを含める」で含められます。',
  },
  {
    id: 'internal-tool',
    group: 'records',
    term: '内部ツール',
    body: 'エージェントが作業の途中経過を画面に出すためなどに呼ぶツール(report_intent)。作業としてのツール呼び出しには数えず、件数だけ別に表示します。',
  },
  {
    id: 'missing-tokens',
    group: 'records',
    term: 'トークン記録なし(欠測)',
    body: '依頼や応答があるのに、トークン量の記録(session-store.db、usage_record、終了時の累計、assistant.message の outputTokens)がどれも残っていないセッション。2026 年 9 月以降のログは assistant.message に outputTokens を書かなくなったため、他の記録が無いと出力トークンも分かりません。合計には 0 として足さず、件数を「入力トークン記録の内訳」に出します。',
  },
  {
    id: 'model-name',
    group: 'records',
    term: 'モデル名の表記',
    body: '同じモデルが記録の出所によって claude-haiku-5-5 / claude-haiku-5.5 / <ID>/claude-haiku-5-5 のように別の書き方で残るため、claude-haiku-5.5 の形にそろえて集計しています。',
  },
  {
    id: 'active-time',
    group: 'time',
    term: '所要時間 / 実働時間',
    body: '所要時間は最初と最後のイベントの差(壁時計)。実働時間は 5 分を超えてイベントが無かった区間を除いた時間で、放置していた時間を含みません。',
  },
  {
    id: 'human-effort',
    group: 'effort',
    term: '推定人手工数',
    body: '同じタスクを人が手作業でやった場合の時間を LLM に推定させた値(judgments.json)。推定であり実測ではありません。判定をまだ回していないセッションは「未判定」です。幅(low〜high)と確信度(0〜100%)も LLM の自己申告で、確信度が低いものは参考程度に見てください。',
  },
  {
    id: 'human-vs-ai',
    group: 'effort',
    term: '推定人手工数 ÷ AI の実働',
    body: '判定済みのセッションについて、推定人手工数の合計を AI の実働時間(5 分を超える空白を除いた時間)の合計で割った値。人が付き添った時間や確認の手間は AI の実働に含まれないため、削減量そのものではなく目安です。',
  },
  {
    id: 'reasoning-tokens',
    group: 'units',
    term: '推論トークン',
    body: '出力トークンのうち、モデルが答える前の推論(思考)に使った分として記録されたもの(reasoning_tokens)。記録のあるリクエストだけの合計で、集計明細では出力トークンに対する割合を添えます。',
  },
  {
    id: 'session-source',
    group: 'records',
    term: '出所(db / dir)',
    body: 'セッションの記録がどこにあったか。db は session-store.db(リクエスト単位の消費の表など)に行があること、dir は session-state/<セッション ID>/ のフォルダ(events.jsonl など)があること。db + dir は両方あるもので、最も多くの欄が埋まります。',
  },
  {
    id: 'autopilot-continuation',
    group: 'mechanics',
    term: '自動継続(autopilot)',
    body: 'autopilot のモードで、利用者の依頼なしにエージェントが自分で次のターンを続けたもの(user.message の isAutopilotContinuation)。依頼の回数には数えず、別に件数を示します。',
  },
  {
    id: 'model-change',
    group: 'effort',
    term: 'モデル変更',
    body: 'セッションの途中で利用者や本体のエージェントが使うモデルを切り替えた回数(session.model_change)。サブエージェントの起動に伴う切り替え(source: agent)は含めず、別に件数を添えます。摩擦の合計には含めません。',
  },
  {
    id: 'available-skills',
    group: 'mechanics',
    term: '使えた skill',
    body: 'そのセッションのシステムメッセージに一覧(<available_skills>)として載っていた skill。呼んだかどうかに関係なく、エージェントが選べた候補です。Copilot CLI 1.0.77 より前の版や copilot -p では一覧が記録に残らないため、呼んだ skill だけを示します。',
  },
  {
    id: 'injections',
    group: 'mechanics',
    term: '注入回数',
    body: '指示ファイルの本文がシステムメッセージに入れられた回数。セッションの始めのほか、compaction の後などに入れ直されるため、1 セッションで 2 回以上になることがあります。',
  },
  {
    id: 'instruction-version',
    group: 'mechanics',
    term: '版(指示文・skill)',
    body: '指示ファイルや skill の本文を内容のハッシュで区別したもの。見出しが同じものを 1 つの項目にまとめ、「版 N」は最初に使われた日時の順の通し番号です。別のリポジトリの同じ見出しのファイルも同じ項目に入るため、番号が大きい版が今の版とは限りません。',
  },
  {
    id: 'latest-version',
    group: 'mechanics',
    term: '最後に使われた版 / 並行して使用',
    body: '「最後に使われた版」は、その項目でいちばん最近にセッションが読み込んだ版。「並行して使用」は、使われた期間が他の版と重なっていること(別のリポジトリ・別のブランチで違う版が同時に使われていたなど)を示します。期間は、各セッションでその版を最初に読み込んだ日時から求めます。',
  },
  {
    id: 'rework-rate',
    group: 'insights',
    term: '手戻り率',
    body: '同じファイルを 2 回以上編集したセッションの割合。改善点の「指示文の傾向」で、版ごとに比べるのに使います。',
  },
  {
    id: 'extra-edits',
    group: 'insights',
    term: '余分な編集',
    body: '同じファイルの 2 回目以降の編集を、全ファイルで合計した回数(2 つのファイルを 2 回ずつ直すと 2)。1 つのファイルを何回直したかではありません。改善点の「止まっている箇所」の理由の 1 つです。',
  },
  {
    id: 'consecutive-failures',
    group: 'insights',
    term: '失敗の連続',
    body: 'ツールの失敗・拒否が途切れずに続いた最長の回数。改善点の「止まっている箇所」の理由の 1 つです。',
  },
  {
    id: 'ttft',
    group: 'time',
    term: 'TTFT(最初のトークンまでの待ち)',
    body: 'Time To First Token。リクエストを送ってから応答が出始めるまでの時間で、「待ち時間(最初のトークンまで)」と同じものです。改善点の「止まっている箇所」では、セッション内の中央値が閾値以上なら「待ち時間」を理由にします。リクエスト単位の記録が無いセッションでは判定できません。',
  },
  {
    id: 'skill-candidate',
    group: 'insights',
    term: 'スキル化の候補 / スコア / ツールの並び',
    body: '似た依頼文の繰り返しと、ターンの中で同じ順に呼ばれたツールの並びの繰り返しを、skill にまとめる候補として挙げたもの。スコアは回数 × 1 回の実働の中央値(分。1 分未満は 1 分、2 時間で頭打ち)で、実働はターンの中で 5 分を超えて出来事が無かった区間(返答待ちや放置)を除いた時間です。セッションの実働時間と同じ数え方です。',
  },
  {
    id: 'long-rare',
    group: 'insights',
    term: '長いのに注入が少ない / 版の前後で悪化',
    body: '「長いのに注入が少ない」は、字数が全版の上位 25% で、注入されたセッションが 3 未満の今の版。「版の前後で悪化」は、同じ項目の版を変えた前後で失敗率か手戻り率が 10 ポイント以上上がったもの(前後とも 5 セッション以上のときだけ判定)。どちらも相関で、指示文が原因とは限りません。',
  },
  {
    id: 'api-requests',
    group: 'units',
    term: 'API リクエスト',
    body: 'モデルへの要求の回数。リクエスト単位の明細(session-store.db / usage_record)があればその件数、無ければ終了時の累計(session.shutdown)の件数で、どちらも無ければ「記録なし」です。',
  },
  {
    id: 'no-result',
    group: 'records',
    term: '結果なし(ツール内訳)/ 終了(shutdown)/(本文なし)',
    body: '「結果なし」は、ツール呼び出しの開始はあるが成功・失敗・拒否の記録が無いもの(中断など)。時系列の「終了(shutdown)」は所要時間の終わりになった session.shutdown で、最後の行より後にあるときだけ出します。「(本文なし)」は本文が空のまま送られた依頼です。',
  },
  {
    id: 'compaction-removed',
    group: 'mechanics',
    term: 'compaction で減ったトークン',
    body: 'compaction の記録の tokensRemoved の合計。この値を記録しない版のログでは 0 ではなく「記録なし」と出します。compaction 自体に使ったトークンは、新旧どちらの記録の形(input / inputTokens)も読みます。',
  },
];
