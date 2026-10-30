# 要求文書: develop plugin 全体と利用側リポジトリとの契約

## 表記規約

本文書と、develop:review・develop:implement・develop:address-review の各要求文書の要求文は、次の語尾で区分する（JIS Z 8301 が定める助動詞対応に従う）。

| 区分 | 語尾 | 対応する英語 |
|---|---|---|
| 必須 | 〜しなければならない | shall / MUST |
| 推奨 | 〜することが望ましい | should / SHOULD |
| 許容 | 〜してもよい | may / MAY |
| 禁止 | 〜してはならない | shall not / MUST NOT |

## 用語

本文書の用語は、develop:review・develop:implement・develop:address-review の各要求文書でも同じ意味で使う。

| 用語 | 意味 |
|---|---|
| develop | 本文書と 3 つの要求文書の要求を満たす plugin。develop:implement・develop:review・develop:address-review の 3 スキルからなる |
| 利用側リポジトリ | develop を使うリポジトリ。claude-plugins・personal-knowledge-rag（以下 pk）・stock-valuation-dcf（以下 dcf）を含む |
| 利用者 | develop のスキルを呼ぶ人 |
| 司令塔 | スキルを読み、run を起動するセッション |
| 利用側の宣言 | 利用側リポジトリが develop の挙動を変えるために置く設定。宣言できる項目と形は構成案の「宣言する設定」の節が持つ |
| 方針文書 | 利用側リポジトリのレビューの方針を書いた文書。`REVIEW.md` と、その「読むもの」表が挙げる文書を指す |
| 方針の版 | 利用側の宣言と方針文書を読む commit（PR-DEVELOPPLUGIN-012・013・080） |
| 方針文書の束 | 方針の版から読めた方針文書（`REVIEW.md` と、その「読むもの」表から解決して読めた文書） |
| 設計方針文書 | `docs/design/skill-design-patterns.md` |
| 構成案 | `docs/design/develop-plugin.md` |
| 書き込ませない役 | 計画役・レビュー役・検証役・分類役のように、対象を書き換えない役 |
| 残る危険 | run を起動した host が止められず、各スキルが結果に書いて利用者に知らせる危険。host ごとの内容は PR-DEVELOPPLUGIN-028 が定める |
| 未着手 | 止まった時点でまだ処理していないもの。develop:review では起動していない項目（順位つき）を、develop:implement と develop:address-review ではまだ実行していない段を指す |
| develop の模型 | `tests/formal/develop/` の TLA+ の状態機械。3 スキルの停止・再開・完了を遷移（action）と性質で表す。各要求文書の「模型の action」の列は、その行の振る舞いを表す遷移の名前、「模型の性質」の列は完了の条件を表す性質の名前を挙げ、遷移の無い行は「模型の範囲の外」と書く。bp の判定の模型とは別のもの |
| 旧スキル | workflow:pr-review・workflow:pr-review-fix、pk の implement・review・address-review、dcf の contextual-code-review |
| next_args・BLOCKED・needs_input | 設計方針文書の「用語」と「停止・再開と人間の入力」の節が定める意味で使う |

## 背景と課題

claude-plugins・pk・dcf の 3 リポジトリが、実装・レビュー・レビュー指摘対応のスキルをそれぞれ持っている。claude-plugins の 3 スキル（repo-implement・repo-review・address-review）は、状態を run の外に持ち、写し間違いを止め、検証役を生成役と別の context に置く作りを持つが、主ブランチ・対象リポジトリ・方針文書の名前・check・除外を claude-plugins の値で直書きしているので、他のリポジトリでは使えない。workflow plugin の pr-review・pr-review-fix とも役目が重なっている。develop は、これらを claude-plugins が配布する 1 つの plugin にまとめ、利用側リポジトリが宣言で挙動を変えられるようにする。

## 想定する利用者と利用場面

| 利用者 | 利用場面 |
|---|---|
| 利用側リポジトリの持ち主 | 自分のリポジトリで実装・レビュー・指摘対応を頼む。利用側の宣言と方針文書を置く |
| 司令塔 | スキルを読み、各スキルが返す次の手に従って run を起動する |
| 呼び出し側のスキル | develop:implement は develop:review を、develop:address-review は develop:implement をスキル呼び出しで起動する |
| host（Claude Code の native Workflow・Codex runner） | develop の run を動かす |

## どう使われるか

1. 利用者が develop:implement・develop:review・develop:address-review のどれかを呼ぶ。
2. スキルは方針の版を導き、その版から利用側の宣言と方針文書を読む。
3. develop:implement は計画・実装・check・レビュー・修正を回し、検証を通った変更だけを commit・push する。develop:review は観点ごとに見て 2 段で検証し、確定した指摘を返す。develop:address-review は指摘を分類して develop:implement に修正を渡し、push・required checks の待ち・返信・thread の resolve まで進める。
4. 止まったスキルは理由と次の手を返し、利用者が入力を足すか原因を直してから、続きの run を起動する。
5. 移行では、利用側の宣言を先に入れ、develop を作って登録し、その後に旧スキルを消す。

## スコープとスコープ外

スコープ: develop の 3 スキルの振る舞い、利用側リポジトリとの契約、旧スキルからの置き換え。

スコープ外:

- bp（skill-creator-best-practices）の判定の模型を、run の並びと各 run の単位に改めること。develop の作成の完了がその改めに依存することだけを PR-DEVELOPPLUGIN-055 が定める。
- dcf の magi-issue-resolver と、magi を develop を呼ぶ形に組み直すかの判断。
- 構成案の「取り込まないもの」の表が挙げる仕組み（複数のレビューエンジンとその切り替え、direct モードの投稿の前の利用者の承認、既存の欠陥の Issue 化、run の中でのスキルの自己改善、見出しによる呼び出しの種類の判別）。
- 設計方針文書の「探索グラフ」の節。develop のどの run にも run の並びにも、試すものの集合が前の結果で変わる単位が無い。
- 前の指摘が直ったか（resolved・regressed）を run をまたいで追うこと。
- 手段の詳細（CLI の op の名前・ファイルの置き場・定数・schema の形・Workflow source の名前）。構成案が持つ。

## 前提と依存

- 原則の正本は設計方針文書、Workflow のスキルが備える性質の要求は `docs/requirements/bp-designed-skill.md`、手段の詳細は構成案である。本文書はこれらを節名で参照し、書き写さない。
- develop は GitHub（gh の読み出し・投稿・GraphQL の mutation・required checks の読み出し）と git に依存する。
- Codex では、native Workflow の代わりに workflow plugin の Codex runner に依存する。
- develop の作成の完了の判定は、bp の review に依存する。
- 3 スキルの停止と再開と完了の条件は、TLA+ の模型 `tests/formal/develop/` と、要求 ID（模型の `\* req:`）と action の名前（各要求文書の「模型の action」の列）で対応させ、`make test` がその対応を照らす。

## リスクと影響

| ID | 観点 | 判定 | 根拠 |
|---|---|---|---|
| RK-001 | 外部システム・第三者への提供・連携 | 該当 | develop は GitHub への投稿・resolve と required checks の読み出し、Codex runner、利用側の 3 リポジトリと連携する |
| RK-002 | 不可逆な操作 | 該当 | develop は PR への投稿・返信・thread の resolve・push と、旧スキルの廃止を行う |

## 要求一覧

欠番: PR-DEVELOPPLUGIN-016

### 構成と呼び出し

#### PR-DEVELOPPLUGIN-001 呼び出し名
develop は、3 スキルを develop:implement・develop:review・develop:address-review の名前で呼び出せるようにしなければならない。

#### PR-DEVELOPPLUGIN-002 3 スキルの版の一致
develop は、3 スキルを同じ版にそろえて配布しなければならない（develop:implement は develop:review の返り値を照合するので、版がずれると照合が壊れる）。

#### PR-DEVELOPPLUGIN-003 呼び出しの向き
3 スキルの間の呼び出しは、develop:address-review から develop:implement、develop:implement から develop:review の 2 つの向きに限らなければならない。

#### PR-DEVELOPPLUGIN-004 実行環境がそろわないとき
native Workflow も Codex runner も使えないか、同じ plugin の兄弟スキルを呼べないならば、各スキルは run を起動する前に、呼び直しを要する拒否の停止（各スキルの停止の表）で止まり、使えない実行環境かスキルの名前と理由を返さなければならない。

#### PR-DEVELOPPLUGIN-005 Codex での実行
native Workflow が無い Codex で呼ばれたとき、各スキルは Codex runner で run を実行しなければならない。

#### PR-DEVELOPPLUGIN-006 段の選択
司令塔は、各スキルが状態から決めて返した次の手に従って、次に起動する run を選ばなければならない。

#### PR-DEVELOPPLUGIN-007 司令塔が作らないもの
司令塔は、次に起動する run を選ぶときに、各役が作る成果物の内容を自分で作ってはならない。

#### PR-DEVELOPPLUGIN-008 固有の値の直書き
各スキルは、特定のリポジトリに固有の値（主ブランチ・対象リポジトリ・方針文書の名前と置き場・check・除外と生成物の置き場）を直書きしてはならない。

#### PR-DEVELOPPLUGIN-009 今の 3 スキルから残すもの
develop は、claude-plugins の今の 3 スキル（repo-implement・repo-review・address-review）の役の分担・段・照合を、固有の値の直書きを利用側の宣言と導出に移すことと、一般化と設計方針への適合に要る段・op を足すことの外で変えてはならない。構成案の本文の節がそのために変えるとした段・照合・役の分担（focus を書く役への移し替え、人の回答を目標の文に足さない別の記録、push 済みで直った指摘を fix とする扱い）は、この 2 つに含む。

#### PR-DEVELOPPLUGIN-010 足す範囲
develop は、今の 3 スキルから残す挙動、構成案が足すとした段・op、設計方針文書の原則のうち本文書と 3 つの要求文書が当てたものの外に、新しい振る舞いを足してはならない。

### 利用側リポジトリとの契約

#### PR-DEVELOPPLUGIN-011 宣言の形が合わないとき
利用側の宣言の形が合わないならば、各スキルはその宣言を既定に置き換えずに止まり、合わない項目を返さなければならない（黙って既定に落とすと、書いた宣言が効かないまま run が進む）。

#### PR-DEVELOPPLUGIN-012 PR が対象のときの方針の版
スキルの初回の起動で、方針の版を渡されず、対象が PR であるとき、各スキルは、その PR の base の branch の remote の先端を方針の版にしなければならない（再開は版を導き直さず、PR-DEVELOPPLUGIN-035 に従う）。

#### PR-DEVELOPPLUGIN-013 PR が対象でないときの方針の版
スキルの初回の起動で、方針の版を渡されず、対象が PR でも git の外の対象（PR-DEVELOPREVIEW-056）でもなく、base の branch を名指されていない（名指されたときは PR-DEVELOPADDRESSREVIEW-005）とき、各スキルは、利用側リポジトリの既定ブランチの remote の先端を方針の版にしなければならない。

#### PR-DEVELOPPLUGIN-080 渡された方針の版
呼び出し側のスキルから方針の版を渡されたとき、各スキルは方針の版を導き直さず、渡された版を使わなければならない（develop:implement は使う前に PR-DEVELOPIMPLEMENT-005 で確かめる）。

#### PR-DEVELOPPLUGIN-014 方針の版が決まらないとき
方針の版を 1 つに決められないならば、各スキルは止まり、決められなかった理由を返さなければならない。

#### PR-DEVELOPPLUGIN-015 宣言と方針文書を読む版
各スキルは、利用側の宣言と方針文書を方針の版から読み、作業ツリーや PR の head から読んではならない（作業ツリーや PR の head から読むと、その PR が自分の必須の check や除外を緩められる）。

#### PR-DEVELOPPLUGIN-017 人が読む出力の言語
各スキルは、人が読む出力（develop:address-review の返信の本文、develop:review の PR への投稿の本文、3 スキルの報告）を、利用側の宣言が指定した言語で書かなければならない。

#### PR-DEVELOPPLUGIN-018 出力の言語の既定
利用側の宣言が出力の言語を指定していないとき、各スキルは人が読む出力を日本語で書かなければならない。

#### PR-DEVELOPPLUGIN-019 出力の言語が効かない範囲
各スキルは、agent への prompt・agent の内部の作業・状態の中の機械向けの値に、出力の言語を効かせてはならない。

#### PR-DEVELOPPLUGIN-020 出力の言語を決める出所
各スキルは、出力の言語を利用側の宣言だけから決め、方針文書の記述から決めてはならない（2 箇所から決めると食い違う）。

### 権限と残る危険

#### PR-DEVELOPPLUGIN-021 Codex runner での書き込みの権限
Codex runner で起動するとき、各スキルは、対象を書き換える役だけを置いた run だけを書き込める権限で起動し、他の run を読み取り専用で起動しなければならない（runner は同じ run の中の役ごとに書き込みの権限を分けられない）。

#### PR-DEVELOPPLUGIN-022 読み取り専用の run の中の書き込み
読み取り専用で起動した run の中で、各スキルは、状態の置き場を含めてどこにも書いてはならない。

#### PR-DEVELOPPLUGIN-023 状態を書く時点
各スキルは、run の結果を状態に書く処理を、その run が返った後にセッションの側で行わなければならない。

#### PR-DEVELOPPLUGIN-024 書き込みの事後の検出
各スキルは、書き込ませない役の run が返った後に、その run が読んだ対象の状態（作業ツリーと HEAD、利用者の作業ツリーに無い PR の head を読ませたときはその head の内容、git の外の対象では対象の各ファイルの内容の SHA-256）を run の前と照らし、その run の中で起きた書き込みを検出しなければならない（native Workflow は Bash 経由の書き込みを止められない）。

#### PR-DEVELOPPLUGIN-025 道具の制限と事後の検出
書き込ませない役の道具から Edit・Write を外せる場合も、各スキルは PR-DEVELOPPLUGIN-024 の検出を省いてはならない（道具の制限は Bash 経由の書き込みを止めない）。

#### PR-DEVELOPPLUGIN-026 書き込みを検出したとき
書き込ませない役の run の中で書き込みを検出したならば、各スキルはその run の結果を受け入れてはならない（受け入れなかった後の止まり方は、PR-DEVELOPIMPLEMENT-009・PR-DEVELOPREVIEW-034・PR-DEVELOPADDRESSREVIEW-015 がスキルごとに定める）。

#### PR-DEVELOPPLUGIN-027 検出した変化の報告
書き込ませない役の run の中で書き込みを検出したならば、各スキルは検出した変化を結果に書かなければならない。

#### PR-DEVELOPPLUGIN-028 残る危険の報告
各スキルは、構成案の権限の表の「残る危険」の列のうち、その run を起動した host の行の内容を、次の表のとおりに結果に毎回書かなければならない。

> 条件の値: host = native Workflow / Codex runner

| 条件: host | 結果 |
|---|---|
| native Workflow | 書き込ませない役の書き込み（Bash を経由したものを含む）を止められず、事後に検出するだけであることを書く |
| Codex runner | runner が agent ごとの道具の許可を持たず、同じ run の中の役を分けられないことを書く |

#### PR-DEVELOPPLUGIN-029 run の前にそろえる許可
各スキルは、run の前に利用者が許可しておく操作（node と git の実行、gh の読み出し、状態の置き場への書き込み、投稿と返信のための gh の POST、resolve のための GraphQL の mutation、git の外の対象の読み出し）を、使う操作の分だけ利用者に示さなければならない（許可が無いと、長い run の途中で確認が出て止まる）。

### 文脈の配達

#### PR-DEVELOPPLUGIN-030 前提の配達
各スキルは、各役が仕事に要る前提（方針の版の方針文書・対象・判定の基準）を、環境から自然に届くものとして扱わず、script か CLI から決定的に配らなければならない（配布先が変わると届く文脈が変わり、前提を知らない役がそれらしく間違える）。

#### PR-DEVELOPPLUGIN-031 配れなかった前提の宣言
配れなかった前提か読めなかった文脈があるならば、各スキルはそれを結果に「見ていない」ものとして書かなければならない。

### 停止と再開

#### PR-DEVELOPPLUGIN-032 止まるときに返すもの
各スキルは、止まるたびに（拒否で止まるときを含む）、止まった理由と次の手を返さなければならない。

#### PR-DEVELOPPLUGIN-033 GitHub・git・check・状態の失敗
gh の読み出し・投稿・GraphQL の mutation、git の remote の読み出し、check の実行（check を実行できなかったこと。check が失敗の結果を返したことは含まない）、状態の書き込みが失敗したか結果が出ないならば、各スキルは BLOCKED で止まり、失敗した操作と理由と次の手を返さなければならない（required checks の結果がまだ出ないときは除き、PR-DEVELOPADDRESSREVIEW-029 の待ち方に従う）。

#### PR-DEVELOPPLUGIN-034 失敗で止まるときの状態への記録
PR-DEVELOPPLUGIN-033 で止まるとき、状態に書けるならば、各スキルは止まった理由と未着手を状態に書かなければならない。

#### PR-DEVELOPPLUGIN-035 再開の仕方
止まったスキルを続けるとき、各スキルは next_args で新しい run を起動し、状態にある受理済みの結果と再開をまたいで残す値（PR-DEVELOPPLUGIN-041）をそのまま使い、そのスキルの停止と再開の表（PR-DEVELOPIMPLEMENT-069・PR-DEVELOPREVIEW-073・PR-DEVELOPADDRESSREVIEW-059）のとおりに続けるか再開を拒否しなければならない（再開を受け付けるか、どこから続けるかを、この表の外で決めると、同じ停止に 2 つの続け方が生まれるため）。

#### PR-DEVELOPPLUGIN-036 relaunch の禁止
各スキルは、止まった run を relaunch で続けてはならない。

#### PR-DEVELOPPLUGIN-037 run の中で人の入力を待たない
各スキルは、人の判断が要るところを run の境界にし、run の中で人の入力を待ってはならない（run の中では入力を待ってから続けられない）。

#### PR-DEVELOPPLUGIN-038 人の判断で止まるときに返すもの
人の判断が要るところで止まるとき、各スキルは、何を決めればよいか・ここまでの検証の結果・影響の範囲・残った未着手・next_args を返さなければならない（理由だけでは、人がその場で判断できない）。

#### PR-DEVELOPPLUGIN-039 前の run の遅れた書き込み
各スキルは、前の run の遅れた書き込みが、新しい run の読んだ後の状態を変えないようにしなければならない。

#### PR-DEVELOPPLUGIN-040 pipeline の外の agent の失敗
run の中で pipeline の外の agent（状態を読み書きする agent を含み、PR-DEVELOPREVIEW-030 が結果の状態 failed で返す develop:review の運搬役を除く）が失敗したならば、各スキルは BLOCKED と理由を返して止まらなければならない（理由が残らないまま run が終わるのを防ぐ）。

#### PR-DEVELOPPLUGIN-041 再開をまたいで残す値
各スキルは、再開をまたいで残す値（固定した目標・未着手・再開をまたいで引き継ぐ回数（修正の回の数・計画の作り直しの数・待ちの上限からの再開の回数・pin ごとの投稿の回数））を run の外の状態に持ち、run ごとに数える回数（トークン量・起動数・required checks を待った回数）を再開した run では 0 から数えなければならない（再開は新しい run の起動なので、script の変数は残らない）。

#### PR-DEVELOPPLUGIN-042 写し間違いの検出
各スキルは、セッションと run の間で受け渡す状態と返り値の写し間違いを検出し、写し間違えたものを受け付けてはならない。

### 取得した内容の記録

#### PR-DEVELOPPLUGIN-075 取得した内容の記録
各スキルは、gh・git・check で取得した内容を、取得の条件と対象の版とともに記録し、状態から ID で指さなければならない（設計方針文書の「証拠記録の保存と照会」の節）。

#### PR-DEVELOPPLUGIN-076 記録を根拠として読む
取得した役と別の役か再開した run が取得した内容を根拠にするとき、各スキルは、PR-DEVELOPPLUGIN-075 で記録した内容を読ませなければならない。

### つまずきの記録と改善

#### PR-DEVELOPPLUGIN-077 停止の理由の記録
各スキルは、停止の理由・却下・工程の欠けの記録を、run ごとの状態の置き場の外にも、別の依頼の run の記録と合わせて集められる形で残さなければならない（同じ依頼の再開の間だけ残す形では足りない）。

#### PR-DEVELOPPLUGIN-078 繰り返すつまずきの行き先
develop は、PR-DEVELOPPLUGIN-077 で集めた繰り返すつまずきを、bp の update による設計と prompt の直しに回す経路を持たなければならない。

#### PR-DEVELOPPLUGIN-079 run の中でのスキルの書き換え
各スキルは、run の中で develop のスキルを書き換えてはならない。

### 費用と記録

#### PR-DEVELOPPLUGIN-043 トークン量の上限を受け取る経路
各スキルは、トークン量の上限を、native Workflow で起動するときにだけ run の入力として受け取らなければならない（Codex runner は消費量を run の中に読めない）。

#### PR-DEVELOPPLUGIN-044 トークン量の既定の上限
トークン量の上限を渡されないとき、各スキルは既定のトークン量の上限を置いてはならない（既定を置くと、上限を渡さなかった run まで途中で止まる）。

#### PR-DEVELOPPLUGIN-045 トークン量の上限に達したとき
トークン量の上限に達したならば、各スキルは、各スキルの停止の表で止まる条件を定める要求に PR-DEVELOPPLUGIN-045 を挙げた行の停止で止まらなければならない（トークン量は PR-DEVELOPPLUGIN-041 のとおり run ごとに数えるので、上限を変えなくても再開した run は続けられる）。

#### PR-DEVELOPPLUGIN-046 起動した agent の記録
各スキルは、実際に起動した agent のモデルと起動数を結果に記録しなければならない（役ごとのモデル指定が効いたかを記録で確かめるため）。

#### PR-DEVELOPPLUGIN-071 役ごとのモデルと effort の根拠
各スキルは、役ごとのモデルと effort の根拠を、設計方針文書の「モデル・effort・prompt」の節と eval の記録に置かなければならない。

#### PR-DEVELOPPLUGIN-085 役ごとのモデルと effort の指定
各スキルは、run の中で起動する agent のモデルと effort を、役ごとに明示して指定しなければならない（指定しないと、他に割り当てが無ければセッションのモデルを継承する）。

### 形の判定

#### PR-DEVELOPPLUGIN-047 形の判定の記録
各スキルは、設計方針文書の「形の判定」の図を、run の並びと各 run のそれぞれに軽い形から順に当て、重い形を選んだ単位ではそれを強いた条件を設計の説明に書かなければならない。

### 永続化と投稿の順序

#### PR-DEVELOPPLUGIN-048 検証の後の永続化と投稿
各スキルは、commit・push・PR への投稿・返信・thread の resolve を、その操作の前に置かれた検証（develop:implement の最終照合、develop:review の 2 段の検証、変更を伴わない返信では develop:address-review の分類の検証）を通った後にだけ行わなければならない。

#### PR-DEVELOPPLUGIN-049 投稿・返信・resolve の取り消し
develop は、行った PR への投稿・返信・thread の resolve を取り消す操作を行ってはならない。

#### PR-DEVELOPPLUGIN-074 履歴を書き換える push
develop は、履歴を書き換える push をしてはならない（他の人が branch に積んだ commit を失わせないため）。

### 移行と旧スキルの廃止

#### PR-DEVELOPPLUGIN-050 利用側の宣言を先に入れる
初めて develop を使う利用側リポジトリは、利用側の宣言を足す変更を develop:implement の外で方針の版に入れてから、develop を使い始めなければならない（宣言は方針の版から読むので、merge されるまで効かない）。

#### PR-DEVELOPPLUGIN-051 claude-plugins の宣言を入れるときに壊さないもの
claude-plugins の利用側の宣言と、生成物の書き先を出力する tool の option を main に入れるとき、その tool の今ある引数（`--check` と `--root`）での動き（出力を含む）を変えてはならない。

#### PR-DEVELOPPLUGIN-081 develop が無い間の宣言
claude-plugins の利用側の宣言は、develop が無い間、どのスキルからも読まれてはならない。

#### PR-DEVELOPPLUGIN-052 tool の option の出力
生成物の書き先を出力する tool の option の出力は、今の生成物の判定の結果と一致しなければならない。

#### PR-DEVELOPPLUGIN-053 登録のときに壊れてよいもの
develop を plugin として登録するとき、既存の plugin とその利用者で壊れてよいのは、claude-plugins で repo-implement・repo-review の名前を使う依頼と、workflow の 2 スキルを廃止するまでの workflow:pr-review と develop:review、workflow:pr-review-fix と develop:implement・develop:address-review の発火の取り合いに限らなければならない。

#### PR-DEVELOPPLUGIN-054 bp review による作成の完了
develop の作成は、bp の review（scope full）の確定が 0 件で、かつ棄却の理由に「専用と宣言している」を挙げるものが 0 件のときにだけ、完了としなければならない（develop は汎用と宣言するので、専用の直書きは直さなければ確定に変わる）。

#### PR-DEVELOPPLUGIN-055 判定の模型を改めた bp での review
PR-DEVELOPPLUGIN-054 の bp の review は、判定の単位を run の並びと各 run に改めた bp で行わなければならない（改める前の bp は、1 つのスキルに 1 つの形しか付けない）。

#### PR-DEVELOPPLUGIN-056 作成の完了の検査
develop の作成の完了には、登録の後に `make test` と `verify_install.py --plugin develop` が通ることを含めなければならない。

#### PR-DEVELOPPLUGIN-057 作成の完了の試走
develop の作成の完了には、claude-plugins の PR で develop:address-review を required checks の待ちと resolve まで 1 周、PR の無い差分で外のレビュー結果の形を 1 周、develop:review を起動数の上限つき（Codex runner）と上限なし（native Workflow）で 1 回ずつ流すことを含めなければならない。

#### PR-DEVELOPPLUGIN-082 試走を完了に数える条件
PR-DEVELOPPLUGIN-057 の試走は、develop:address-review が required checks の待ちを経て resolve まで届き、外のレビュー結果の形が修正まで届き、develop:review の 2 回がどちらも、next_args での再開を含めたその回の最後の run で結果の状態 success か degraded を返したときだけ、完了に数えなければならない。

#### PR-DEVELOPPLUGIN-083 evals の測定
develop の作成の完了には、evals を測り、with_skill と baseline を比べることを含めなければならない。

#### PR-DEVELOPPLUGIN-073 仕様の ID の網羅の検査
develop の仕様に ID があるとき、develop の作成の完了には、仕様の ID ごとにテストと検証の結果との結び付きを数え、結び付かない ID の一覧を決定的に返す検査が 0 件で通ることを含めなければならない。

#### PR-DEVELOPPLUGIN-058 汎用の description
3 スキルの description は、特定のリポジトリの専用と読める記述を含んではならない。

#### PR-DEVELOPPLUGIN-059 発火の評価の取り直し
3 スキルの発火の評価（trigger evals）は develop の description で取り直し、workflow の 2 スキルが残る間はその 2 スキルとの取り合いを負例に入れなければならない。

#### PR-DEVELOPPLUGIN-060 workflow の 2 スキルの廃止
workflow:pr-review と workflow:pr-review-fix は、develop に吸収して廃止しなければならない。

#### PR-DEVELOPPLUGIN-084 workflow の 2 スキルの廃止の検査
workflow の 2 スキルの廃止の完了には、廃止の後に `make test` と `verify_install.py --plugin workflow` が通ることを含めなければならない。

#### PR-DEVELOPPLUGIN-061 workflow の 2 スキルを消す時点
workflow:pr-review と workflow:pr-review-fix は、pk と dcf の置き換えが完了する（PR-DEVELOPPLUGIN-069・070）まで消してはならない。

#### PR-DEVELOPPLUGIN-062 dcf の contextual-code-review の置き換え
dcf の contextual-code-review は、develop:review で置き換えなければならない。

#### PR-DEVELOPPLUGIN-063 dcf への約束の範囲
develop が dcf に約束するのは、セッションから develop:review をスキル呼び出しで呼べることと、develop:review の返り値の契約（PR-DEVELOPREVIEW-030・031・032）に限らなければならない。

#### PR-DEVELOPPLUGIN-064 旧スキルを消す順序
旧スキルを消す前に、置き換え先の develop が作られて登録され、利用側の宣言が方針の版に入っていなければならない。

#### PR-DEVELOPPLUGIN-065 元の機能の行き先
旧スキルを消すとき、旧スキルの元の機能は、旧スキルごとに次の行き先で担われていなければならない。

- workflow:pr-review と workflow:pr-review-fix: 構成案の「pr-review・pr-review-fix の機能の行き先」の表が挙げる develop の行き先
- pk の 3 スキルと dcf の contextual-code-review: 構成案の「3 リポジトリから取り込む仕組み」の表が出所を pk か dcf の contextual-code-review とする仕組みの、その表の develop の置き場

#### PR-DEVELOPPLUGIN-066 workflow の 2 スキルの廃止で失うもの
workflow:pr-review と workflow:pr-review-fix の廃止で失うものは、spec と prd の自動の見分け、自己申告の confidence の欄、重大度の元の語彙（blocker・major・minor・nit）、git の外の対象での方針文書による観点と投稿、前の指摘が直ったか（resolved）の判定、check を宣言していないリポジトリでの修正（宣言が方針の版に入るまで）に限らなければならない。

#### PR-DEVELOPPLUGIN-072 pk・dcf の旧スキルの廃止で失うもの
pk の 3 スキルと dcf の contextual-code-review の廃止で失うものは、pk の address-review の decline の根拠を返信した thread の resolve、dcf の contextual-code-review の direct モードの投稿の前の利用者の承認、magi の重いレンズから contextual-code-review の分が抜けて Fable だけが残ることに限らなければならない。

#### PR-DEVELOPPLUGIN-067 旧名の参照
旧スキルを消す作業の中で旧名の参照を直し、次の数え方で、旧名の参照を grep で 0 件にしなければならない。

- workflow の 2 スキル: 構成案が除外とした箇所を除いて数える
- pk の 3 スキルと dcf の contextual-code-review: 旧スキルの置き場の path と contextual-code-review の名前を語にして数え、pk の 3 スキルの名前（implement・review・address-review）だけの語は数えない（develop の呼び出し名とディレクトリ名と同じ）。構成案の除外は当てない

#### PR-DEVELOPPLUGIN-068 旧名を呼ぶ利用者への案内
旧スキルを消した後、旧名を呼ぶ利用者への呼び出しの行き先の案内は残さなくてもよい（旧名を呼ぶと not found になることは受け入れる）。

#### PR-DEVELOPPLUGIN-069 pk・dcf の置き換えの完了
pk と dcf の置き換えは、各リポジトリで develop:review を 1 回流し、方針文書の「読むもの」表が挙げる文書に読めなかったものが無いときにだけ、完了としなければならない。

#### PR-DEVELOPPLUGIN-070 dcf の金融ロジックの観点
dcf の置き換えは、dcf が「金融ロジックで必ず見ること」を置いた形に応じて、次の表の条件を満たすときにだけ、完了としなければならない。

> 条件の値: 置いた形 = 必ず当てる観点 / 「読むもの」表の行 / 確かめられない

| 条件: 置いた形 | 結果 |
|---|---|
| 必ず当てる観点 | develop:review を 1 回流して、その観点が必須の観点として立つときに完了とする |
| 「読むもの」表の行 | develop:review を 1 回流して、その文書が方針文書の束に入り（「読むもの」表の行として解決されて読まれ）、読めなかった文書が無いときに完了とする |
| 確かめられない | 完了としない |
