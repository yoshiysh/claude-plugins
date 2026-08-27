# docs/requirements 目次

この INDEX は自動生成される導出物である。本体を直したら再生成すること（手書きしない）。

## 文書一覧

| パス | 扱う関心事 | どういう要求が書かれているか |
|---|---|---|
| `docs/requirements/requester.md` | 生成の工程（依頼者とのやり取り） | 依頼者から見たシステムの振る舞いに関する要求文書。起動時の対象判定と実行基盤の確認、問いかけと「決まっていない」回答の扱い、保存前の提示と承認、根拠として読み取ってよい入力の範囲、中断時の扱いを定め、迷う判定の共通規則を 2 件にまとめている。 |
| `docs/requirements/consumer.md` | 生成物（引き渡す文書一式）の性質 | 後続作業者（実装・テスト設計を行う AI）へ引き渡す生成文書一式が備えるべき性質を、完成の判定条件と依頼文の 5 つの語（戻りなく・不具合なく・精度高く・迷いなく・ぶれない）の分解として 29 件の要求で置く。読み手が AI であることに由来する記述規律と、要求文書・仕様書の分量の決まり方も扱う。 |

## 要求一覧

| ID | 見出し | 所在文書 |
|---|---|---|
| PR-REQUESTER-037 | 判定に迷う場合に結論を定めない | `docs/requirements/requester.md` |
| PR-REQUESTER-040 | 判定に迷う場合に依頼者へ確認する | `docs/requirements/requester.md` |
| PR-REQUESTER-001 | 対象外の依頼で作成に入らない | `docs/requirements/requester.md` |
| PR-REQUESTER-003 | 作成する文書の種別を依頼文の語から判定する | `docs/requirements/requester.md` |
| PR-REQUESTER-038 | 種別の判定に用いる語を足さない | `docs/requirements/requester.md` |
| PR-REQUESTER-033 | 所在が示されなければ新規作成として扱う | `docs/requirements/requester.md` |
| PR-REQUESTER-005 | 着手を止める論点を尋ねる | `docs/requirements/requester.md` |
| PR-REQUESTER-007 | 同じ論点を繰り返し尋ねない | `docs/requirements/requester.md` |
| PR-REQUESTER-008 | 「分からない」と答える権利 | `docs/requirements/requester.md` |
| PR-REQUESTER-029 | 決まっていない旨の回答を着手不能から外す | `docs/requirements/requester.md` |
| PR-REQUESTER-009 | 未回答の事項を推測で埋めない | `docs/requirements/requester.md` |
| PR-REQUESTER-010 | 承認を得ずに保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-011 | 書き込む先を先に示す | `docs/requirements/requester.md` |
| PR-REQUESTER-012 | 書き込む内容を先に示す | `docs/requirements/requester.md` |
| PR-REQUESTER-013 | 承認の意思の有無を定型の語句で判定しない | `docs/requirements/requester.md` |
| PR-REQUESTER-014 | 未確定事項が残っている事実を明示せずに完了しない | `docs/requirements/requester.md` |
| PR-REQUESTER-015 | 着手を止める未確定事項の内容を依頼者へ示す | `docs/requirements/requester.md` |
| PR-REQUESTER-017 | 上書きであることを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-036 | 新規作成の同名衝突では保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-039 | 新規作成の同名衝突では差分を示して指示を求める | `docs/requirements/requester.md` |
| PR-REQUESTER-018 | 中間の生成物を対象リポジトリに残さない | `docs/requirements/requester.md` |
| PR-REQUESTER-031 | 中間の生成物を依頼者のホームディレクトリの配下に置く | `docs/requirements/requester.md` |
| PR-REQUESTER-020 | 依頼文・回答・所在を示された文書以外を要求の根拠にしない | `docs/requirements/requester.md` |
| PR-REQUESTER-021 | 対象リポジトリの実装を読み取らない | `docs/requirements/requester.md` |
| PR-REQUESTER-022 | 所在を示された既存文書は読み取る | `docs/requirements/requester.md` |
| PR-REQUESTER-032 | 所在を示されていない文書を走査で探し出さない | `docs/requirements/requester.md` |
| PR-REQUESTER-035 | 所在を示されていない文書を読み取らない | `docs/requirements/requester.md` |
| PR-REQUESTER-023 | 実行基盤が要件を満たすかを起動時に確認する | `docs/requirements/requester.md` |
| PR-REQUESTER-041 | 非対応の環境で作成に入らない | `docs/requirements/requester.md` |
| PR-REQUESTER-024 | 非対応の環境であることを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-034 | 上限を超えて実行を継続しない | `docs/requirements/requester.md` |
| PR-REQUESTER-025 | 未完成の文書を成果物として保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-026 | 中断したことを依頼者へ示す | `docs/requirements/requester.md` |
| PR-CONSUMER-001 | 追加の質問を要さない着手可能性 | `docs/requirements/consumer.md` |
| PR-CONSUMER-002 | 曖昧語の不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-003 | 平叙終止の不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-004 | 複合要求の不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-005 | 要求と仕様項目の紐付け | `docs/requirements/consumer.md` |
| PR-CONSUMER-006 | 要求と検証方法の紐付け | `docs/requirements/consumer.md` |
| PR-CONSUMER-007 | 着手を止める未確定事項の不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-008 | 未定義の振る舞いの不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-009 | 検討した観点の全件記載 | `docs/requirements/consumer.md` |
| PR-CONSUMER-010 | 対象範囲の明示 | `docs/requirements/consumer.md` |
| PR-CONSUMER-011 | 前提の明示 | `docs/requirements/consumer.md` |
| PR-CONSUMER-012 | 判断の委譲の禁止 | `docs/requirements/consumer.md` |
| PR-CONSUMER-013 | 継続できない事象の振る舞いの記述 | `docs/requirements/consumer.md` |
| PR-CONSUMER-015 | 数量の単位と境界の明示 | `docs/requirements/consumer.md` |
| PR-CONSUMER-017 | 境界を超えたときの振る舞いの記述 | `docs/requirements/consumer.md` |
| PR-CONSUMER-018 | 出所の特定可能性 | `docs/requirements/consumer.md` |
| PR-CONSUMER-019 | 用語の一意性 | `docs/requirements/consumer.md` |
| PR-CONSUMER-020 | 解釈が分かれる語の定義 | `docs/requirements/consumer.md` |
| PR-CONSUMER-021 | 記述の所在の特定 | `docs/requirements/consumer.md` |
| PR-CONSUMER-022 | 文書間の非矛盾 | `docs/requirements/consumer.md` |
| PR-CONSUMER-023 | 識別子の一意性 | `docs/requirements/consumer.md` |
| PR-CONSUMER-024 | 参照の解決 | `docs/requirements/consumer.md` |
| PR-CONSUMER-025 | 同一内容の二重記述の禁止 | `docs/requirements/consumer.md` |
| PR-CONSUMER-026 | 文書外の知識に依存しない記述 | `docs/requirements/consumer.md` |
| PR-CONSUMER-027 | 実在の人物を特定する表記の不記載 | `docs/requirements/consumer.md` |
| PR-CONSUMER-028 | 役割名による人物の記述 | `docs/requirements/consumer.md` |
| PR-CONSUMER-029 | 改稿の経緯の不記載 | `docs/requirements/consumer.md` |
| PR-CONSUMER-030 | 要求文書の分量 | `docs/requirements/consumer.md` |
| PR-CONSUMER-031 | 仕様書の分量 | `docs/requirements/consumer.md` |

## 関連する仕様文書

| requirements 文書 | 対応する specifications 文書 |
|---|---|
| `docs/requirements/requester.md` | `docs/specifications/flow.md` / `docs/specifications/elicitation.md` / `docs/specifications/authoring.md` / `docs/specifications/verification.md` |
| `docs/requirements/consumer.md` | `docs/specifications/flow.md` / `docs/specifications/elicitation.md` / `docs/specifications/authoring.md` / `docs/specifications/verification.md` |

## 未解決（着手を止める未確定事項）

| ID | 内容 | 所在 | 提示状況 |
|---|---|---|---|
| TBD-RREQUESTER-016 | 中間の生成物を置くフォルダの名前となる案件名が、何によって決まるかが決まっていない（PR-REQUESTER-031 に関係する） | requirements/requester | **未提示** |
| TBD-RCONSUMER-003 | 状態を持つ対象とみなす範囲と、その対象の振る舞いが定義されていると判定する条件 | requirements/consumer | **未提示** |
| TBD-RCONSUMER-007 | 引き渡す文書に、実施した検査と実施していない検査の区別を載せるかどうか。載せる場合の対象とする検査の集合と、未実施の検査を指摘 0 件の検査と区別する表記 | requirements/consumer | **未提示** |
| TBD-RCONSUMER-008 | 生成文書の記述が文書外の知識に依存していると判定する境界 | requirements/consumer | **未提示** |
| TBD-RCONSUMER-010 | 仕様書が「実装が一意に決まる水準」に達したと判定する基準 | requirements/consumer | **未提示** |
| TBD-SFLOW-010 | 所在を示された既存文書が 1 件以上あるときのモード、モードごとに変わる振る舞い、およびその既存文書の種別を判定する必要があるかが決まっていない | specifications/flow | **未提示** |
| TBD-SFLOW-012 | 中間の生成物を置く作業用のディレクトリ（案件名フォルダの親）の名前と位置が決まっていない | specifications/flow | 提示済み（未決定） |
| TBD-SFLOW-016 | 起動時の 2 つの非着手の判定（実行基盤の不足・対象外の依頼）を評価する順序と、両方が同時に成立したときに依頼者へ示す内容が決まっていない | specifications/flow | **未提示** |
| TBD-SFLOW-018 | 中間の生成物を実行の終了後に残すか消すかが決まっていない | specifications/flow | **未提示** |
| TBD-SFLOW-019 | 実行基盤が要件を満たさないと判定したときに依頼者へ示す内容の内訳が決まっていない | specifications/flow | **未提示** |
| TBD-SFLOW-020 | 決めないと決めたへ付け替えた未確定事項について、後から依頼者が決めた内容を反映する経路を設けるかが決まっていない | specifications/flow | **未提示** |
| TBD-SFLOW-021 | 書き込む先と同じパスのファイルが既に存在するときに依頼者が示しうる指示の集合と、それぞれの指示を受けたあとにシステムが行うことが決まっていない | specifications/flow | **未提示** |
| TBD-SFLOW-022 | 保存の承認を拒否されたことによる文書の作り直しを、作り直しの実施回数に数えるかが決まっていない | specifications/flow | **未提示** |
| TBD-SFLOW-023 | 応答を待つ時間の上限による打ち切りを、やり直しの起動条件に含めるかが決まっていない | specifications/flow | **未提示** |
| TBD-SFLOW-024 | 初稿と未確定事項を示す中断点において、進行可能に区分した未確定事項と決めないと決めたに区分した未確定事項を依頼者へ示すかどうかが決まっていない | specifications/flow | **未提示** |
| TBD-SELICITATION-003 | 問いを出していない事項の論点に対応づけられる回答を受け取ったときの扱い、およびどの事項の論点にも対応づけられない回答を受け取ったときの、確定させないこと以外の扱いが決まっていない | specifications/elicitation | **未提示** |
| TBD-SELICITATION-005 | 観点の判定と分割案について、依頼者の承認を要するかが決まっていない | specifications/elicitation | **未提示** |
| TBD-SELICITATION-006 | 分割案の分割の軸をどう定めるか。依頼者が既存文書の所在を示したときに、その既存文書の分割単位の名前を引き継ぐか分割し直すかを含む | specifications/elicitation | **未提示** |
| TBD-SELICITATION-012 | 依頼文から事項を起こす規則と、事項の識別子の付け方。論点が変わって起こし直した事項が元の識別子を引き継ぐかを含む | specifications/elicitation | **未提示** |
| TBD-SELICITATION-014 | 該当と判定した観点から、この案件で要求を書くべき事柄のまとまりを導くかどうか、および導く場合のその規則が決まっていない | specifications/elicitation | **未提示** |
| TBD-SELICITATION-015 | 依頼者がファイルではなくディレクトリを所在として示したときの扱いが決まっていない | specifications/elicitation | **未提示** |
| TBD-SELICITATION-017 | 判定が付かないことの確認に対して依頼者が返した回答の扱いが決まっていない | specifications/elicitation | **未提示** |
| TBD-SELICITATION-018 | 分割単位の名前の衝突を依頼者へ示したあとに、分割案をどう扱うかが決まっていない | specifications/elicitation | **未提示** |
| TBD-SELICITATION-019 | 確定した事項の論点に対応づけられ、その事項の確定した値と異なる回答を依頼者から受け取ったときに、どちらの値を採るかが決まっていない。この論点を扱う要求が要求文書に無い | specifications/elicitation | **未提示** |
| TBD-SAUTHORING-001 | 機械検査が参照する語の集合の値。曖昧語の一覧、境界の包含を示す語の一覧、およびいずれの一覧にも属さない語を検出したときの扱いが決まっていない | specifications/authoring | 提示済み（未決定） |
| TBD-SAUTHORING-002 | 1 件の要求文または仕様項目が 2 つ以上の動作を含むと判定する規則 | specifications/authoring | **未提示** |
| TBD-SAUTHORING-004 | 実装の対象外とする要求をトレーサビリティ表にどう残すか。全要求の紐付けの母集団に含めるかどうかを含む | specifications/authoring | **未提示** |
| TBD-SAUTHORING-005 | リスク・影響の ID の連番の振り方と、ある観点がその生成文書の関心事に関わると判定する規則 | specifications/authoring | 提示済み（未決定） |
| TBD-SAUTHORING-006 | 根拠の記述の分量の上限と下限、および上限を超えたときの扱い | specifications/authoring | **未提示** |
| TBD-SAUTHORING-007 | 条件節のパターンの集合の値と、望ましくない事象に対応するパターンの書式、2 つ以上の条件を重ねてよい組み合わせ、および処理を継続できる事象と望ましくない事象とでパターンを書き分けるかどうか | specifications/authoring | **未提示** |
| TBD-SAUTHORING-009 | 根拠の併記を置く位置と、機械が根拠の記述を同定する目印 | specifications/authoring | **未提示** |
| TBD-SAUTHORING-011 | リスクと影響・状態とイベント以外に条件付き章を設けるかどうか、設ける場合のそれぞれの設置条件と中身、およびその章に置く記述が ID を持つ項目であるかどうか | specifications/authoring | **未提示** |
| TBD-SAUTHORING-012 | 状態 × イベント表について、発生しない組み合わせ以外の行に、振る舞いが定義されているかどうかを何と書くか | specifications/authoring | **未提示** |
| TBD-SAUTHORING-013 | ID の連番を数える単位が、領域コードだけであるか、領域コードと種別の組であるか | specifications/authoring | **未提示** |
| TBD-SAUTHORING-014 | 未確定事項（TBD 一覧）の章の書式。3 つの区分をそれぞれ節として立てるか 1 つの表の中で区分を示すか、および 4 つの情報を表のどの列として並べるかを含む | specifications/authoring | **未提示** |
| TBD-SAUTHORING-015 | 生成文書を書き出す先のディレクトリの位置と名前、および生成文書のファイル名の作り方 | specifications/authoring | **未提示** |
| TBD-SAUTHORING-016 | 要求文書の常設章の集合。4 つの内容をどの名前の章に分けて置くか、およびその 4 つのほかに常設章を置くかどうかを含む | specifications/authoring | **未提示** |
| TBD-SAUTHORING-017 | 状態とイベントの条件付き章を、状態遷移を持つ対象を扱う要求文書にも置くかどうか。置く場合に、要求文書が状態遷移図の各遷移へどの ID を付けるか | specifications/authoring | **未提示** |
| TBD-SAUTHORING-018 | 該当と判定された観点が 0 件で、未判定の観点が残る場合に、リスクと影響の章を置くかどうか、および未判定の観点を後続作業者へ伝える置き場 | specifications/authoring | **未提示** |
| TBD-SAUTHORING-019 | 仕様書の常設章の集合。6 つの内容をどの名前の章に分けて置くか、およびその 6 つのほかに常設章を置くかどうかを含む | specifications/authoring | **未提示** |
| TBD-SAUTHORING-020 | INDEX が持つ節の集合と各節の名称・中身。所在と関心事、ID の一覧をどの名前の節に分けて置くか、および検査の結果を INDEX に置くかどうかを含む | specifications/authoring | **未提示** |
| TBD-SAUTHORING-021 | 状態 × イベント表の列の構成と、行に付ける振る舞いの種別の分類体系 | specifications/authoring | **未提示** |
| TBD-SVERIFICATION-006 | 同じ指摘が解消されないまま再び返ったときの振る舞いと、そのときの遷移先の状態が決まっていない。同じ指摘であると判定する条件も決まっていない | specifications/verification | **未提示** |
| TBD-SVERIFICATION-007 | 指摘の重大度の区分と、どの区分の指摘が改稿を必須にするかが決まっていない（SP-VERIFICATION-031 に関係する） | specifications/verification | **未提示** |
| TBD-SVERIFICATION-009 | 検査 1 回の結果が満たすべき形式が決まっていない（SP-VERIFICATION-039 に関係する） | specifications/verification | **未提示** |
| TBD-SVERIFICATION-010 | 検査記録および残った指摘の保持先、検査記録が保持する項目の集合、検査を識別するキー、および実施できた検査の件数を数える分母となる検査の集合が決まっていない（SP-VERIFICATION-003・SP-VERIFICATION-023・SP-VERIFICATION-035・SP-VERIFICATION-041 に関係する） | specifications/verification | **未提示** |
| TBD-SVERIFICATION-012 | 同一性を判定できずに依頼者へ確認を求めたとき、その検査がその回に何を返すか、応答を待つ間に反復を止めるか、確認を挟んだ回を往復の回数に数えるかが決まっていない（SP-VERIFICATION-045 に関係する） | specifications/verification | **未提示** |
| TBD-SVERIFICATION-013 | 検査記録を引き渡す文書へ書き出す形式（置き場となる章、検査ごとの行の列構成、未実施を指摘 0 件と区別して表す値）が決まっていない（SP-VERIFICATION-005 に関係する。書き出す対象の範囲は docs/requirements/consumer.md の TBD-RCONSUMER-007 が扱う） | specifications/verification | **未提示** |
| TBD-SVERIFICATION-016 | 2 回目の検査の検査記録を 1 回目の記録とどう併存させるか、および反復の終了時に引き渡す検査記録が全ての回の分であるか最後に実施した回の分であるかが決まっていない（SP-VERIFICATION-003・SP-VERIFICATION-005 に関係する） | specifications/verification | **未提示** |
| TBD-EX-0pjc8rx | 確定情報を尋ねる中断点を何回まで繰り返せるかが、どこを開いても決まらないため実装に着手できない。SP-FLOW-014 の「1 件以上ある間」は回答後に論点が残る／新たに出た場合の再度の中断を含意するが、状態遷移図には「確定情報の回答待ち」から「情報収集中」へ戻る遷移が無く、唯一の出口が「文書生成中」になっている。さらに docs/specifications/elicitation.md は L52 で「聞き返しの周回の上限」を本文書へ委譲しているのに、本文書が定める上限は初稿以降の「作り直しの実施回数 2 回」（SP-FLOW-024）だけで、初稿前の聞き返しの上限は無い。回答後にまだ着手できない論点が残るとき、無限に尋ね続けるのか 1 回で打ち切って文書生成へ入るのかが決まらない。（想定される解消: 初稿前の聞き返しについて (a) 中断点は 1 回だけで、回答後は残る論点を TBD にして必ず文書生成へ入る、(b) 上限回数を定めて繰り返す（回数を明示）、(c) 着手できない論点が 0 件になるまで繰り返す（上限なし）のいずれかを決め、(b)(c) を採るなら「確定情報の回答待ち」→「情報収集中」の遷移を状態遷移図に追加する。） | specifications/flow | **未提示** |
| TBD-EX-1vzvqta | 1 回の実行で複数のファイルを保存する（SP-FLOW-025 は「書き込む先のファイルのパス」を、トレーサビリティ表は「書き込む先の全パス」を対象にしている）にもかかわらず、ここで禁じられる「保存」が衝突した当該ファイルだけなのか、その実行の全ファイルなのかが書かれていない。前者なら他のファイルはディスクに書かれ、後者なら 1 件も書かれない。どちらを実装するかでディスク上の結果が変わるため、着手できない。TBD-SFLOW-021 が扱うのは「指示を受けたあとにシステムが行うこと」であり、指示を求める時点での保存の範囲はそこに含まれていない。（想定される解消: (a) 衝突したファイルのみ保存を行わず、衝突していないファイルは書き込む、(b) 1 件でも衝突があれば全ファイルの保存を行わない、のいずれかを決めて SP-FLOW-030 に明記する。あわせて、承認（SP-FLOW-027）を全ファイル一括で求めるのかファイルごとに求めるのかも明記する。） | specifications/flow | **未提示** |
| TBD-EX-1uxquq8 | ここで手が止まる。「文書の作成に着手できない原因である」の判定基準の所在がどこにも指定されていないから。用語定義の表に無く、機能仕様のどの項目にも無く、TBD としても起票されていない。さらに『本文書が扱わない範囲』の表は flow.md が持つものを列挙しているが、そこにもこの判定は挙がっていない。SP-ELICITATION-017（問いを作る義務）・SP-ELICITATION-036（問いを作ってはならない条件）・SP-ELICITATION-041（保留を原因として扱わない）の 3 項目がすべてこの判定に依存しているため、判定基準が無いと未確定の事項のうちどれを問うのかが実装者ごとに変わる。（想定される解消: 「ある未確定の事項が文書の作成に着手できない原因であるか」をどう判定するかを決め、(a) 本文書の機能仕様に仕様項目として定義する、(b) 『本文書が扱わない範囲』の表に行を足して flow.md（未確定事項の区分の付け替えと完成の判定）へ明示的に委譲する、(c) TBD として起票する、のいずれかにする。決め方の候補: 生成文書の必須の章・必須の記述のうち、その事項の値が定まらないと 1 文も書けないものが存在するか、で判定する。） | specifications/elicitation | **未提示** |
| TBD-EX-0whajof | ここで手が止まる。表は確定の事項が E2（決まっていない旨の回答）を受けたときの遷移を定義済み（✅）として SP-ELICITATION-029 を挙げているが、SP-ELICITATION-029 の本文は「未確定の事項の論点に対応づけられる決まっていない旨の回答を受け取ったとき」と前提を未確定に限定しており、確定の事項には適用できないから。参照先の仕様項目を開いても前提が一致せず、確定した値を捨てて保留へ落とすのか、確定を維持するのかが決まらない。TBD-SELICITATION-019 は「確定した値と異なる回答」を扱うが、決まっていない旨の回答が『値』に当たるかは書かれておらず、この穴は塞がらない。（想定される解消: 次のいずれかに決める — (a) SP-ELICITATION-029 の前提を「未確定または確定の事項」へ広げ、確定値を破棄して保留とすることを明記する、(b) 確定の事項に対する決まっていない旨の回答を TBD-SELICITATION-019 の範囲に含めると明記し、表のセルを ❌ 未定義（TBD-SELICITATION-019）へ改める、(c) 確定の事項は E2 で状態を変えないと定める仕様項目を新設する。あわせて状態遷移図の「確定 → 保留」の有無も揃えること（現在の図にはこの遷移が無く、表とも食い違っている）。） | specifications/elicitation | **未提示** |
| TBD-EX-1vbdgve | ここで手が止まる。確定の事項には 2 系統ある（外部インタフェース章が「依頼者の回答によって確定した事項と、入力から値が定まったことによって確定した事項（SP-ELICITATION-049）の双方が含まれる」と明記している）のに、根拠として挙がる SP-ELICITATION-025 の前提は「既に回答を得た事項の論点の中身が変わったとき」であり、SP-ELICITATION-049 で確定した事項（回答を得ていない）は対象外だから。依頼文だけで確定した事項の論点が後から変わったとき、未確定へ起こし直すのか確定のまま入力を読み直して値を更新するのかが決まらない。SEX-003 と同じ形だが、直す先の項目も決めるべき論点も別である。（想定される解消: SP-ELICITATION-025 の前提を「既に回答を得た事項」から「確定または保留の事項」（＝入力から値が定まって確定した事項を含む）へ広げるか、SP-ELICITATION-049 で確定した事項の論点が変化したときの扱いを別の仕様項目として定める。前者を採るなら、起こし直しの後に再び入力から値が定まる場合に問いを作るのか（SP-ELICITATION-018 との関係）も併せて決めること。） | specifications/elicitation | **未提示** |
| TBD-EX-0lznv81 | ここで手が止まる。直積のセル（状態, イベント）のうちどれが「主フローの遷移に当たる」のかを決める入力が無いため、除外集合を計算できない。状態遷移図の遷移に付けることを求めているのは SP-AUTHORING-069 の仕様項目 ID だけで、遷移を SP-AUTHORING-070 が宣言するイベント集合のどの要素と対応づけるかはどこにも書かれていない。docs/requirements/consumer.md の TBD-RCONSUMER-003 は「直積の軸に載せるイベントの決め方」（=軸の決定）を扱うのであって、遷移とイベントの対応（=セルの除外）は扱っていない。（想定される解消: SP-AUTHORING-069 を拡張し、状態遷移図の各遷移に、その遷移を起こすイベント名（SP-AUTHORING-070 が宣言する集合の要素）を仕様項目 ID と併せて書くことを求める。あるいは SP-AUTHORING-071 を「表は直積の全組み合わせから起こし、主フローに当たる行はその旨を示す」に改め、除外ではなく標示で扱う。） | specifications/authoring | **未提示** |

## 検査結果

- ID の重複: 0 件
- 実現する仕様項目が無い要求: 0 件
