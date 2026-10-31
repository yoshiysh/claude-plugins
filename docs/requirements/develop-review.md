# 要求文書: develop:review

表記規約と用語は、develop plugin 全体の要求文書（PR-DEVELOPPLUGIN）に従う。本文書の要求の主語「review」は develop:review を指す。

## 背景と課題

claude-plugins の repo-review は、観点ごとの reviewer と 2 段の検証を持つが、観点・focus・担当を司令塔が方針文書を読んで自由に作っており、必ず当てるべき観点を落としても通る。欠けた資産を追加で見に行く経路が無く、起動数の上限で止まるとそれまでの結果が失われる。workflow:pr-review の PR への投稿と、dcf の contextual-code-review の「0 件」と「レビューできなかった」の区別も、develop:review が引き継ぐ必要がある。

## 想定する利用者と利用場面

| 利用者 | 利用場面 |
|---|---|
| 利用者 | PR・差分のレビューを直接頼む。path の範囲を今の内容で見る監査を頼む。名指した git の外のファイルや貼り付けた文書のレビューを頼む |
| develop:implement | 実装の後の未コミットの作業ツリーのレビューとして、pin の値を渡して呼ぶ |
| dcf のセッション | contextual-code-review の代わりに、スキル呼び出しで呼ぶ |

## どう使われるか

1. review は方針の版から方針文書を読み、対象の種類と観点の閉集合と必須の観点を作る。
2. 司令塔が閉集合から観点を選び、担当を付けて計画に渡す。review は計画を検査する。
3. review の run が、観点ごとの focus を書き、観点ごとの reviewer が見て、2 段で検証し、読まれていない資産だけを追加で見る。
4. review は結果の状態（success・degraded・failed）と確定した指摘を返す。対象が PR で利用者が直接呼んだときは、確定した指摘を PR に投稿して確かめる。
5. 起動数の上限で止まったときは、それまでの結果と順位つきの未着手を返し、次の run が未着手から続ける。

## スコープとスコープ外

スコープ: 観点の決め方、focus、観点ごとのレビューと 2 段の検証、資産台帳、起動数の上限と再開、PR への投稿、git の外の対象、返り値の契約。

スコープ外: 指摘の修正（develop:implement が持つ）と、PR の指摘への返信（develop:address-review が持つ）。

## 前提と依存

- 方針の版の導き方と、利用側の宣言の扱いは PR-DEVELOPPLUGIN-011〜015・080 に従う。
- 起動数の上限の値の検査は `docs/specifications/bp-run.md` の起動数の上限の規則に、項目の順位の決め方は `docs/specifications/bp-inspection.md` の review の項目の順位に従う。
- 停止と再開の表と完了の条件の「模型の action」の列は、`tests/formal/develop/DevelopSkill.tla` の action の名前を、「模型の性質」の列は `tests/formal/develop/DevelopProps.tla` の性質の名前を指す。

## リスクと影響

| ID | 観点 | 判定 | 根拠 |
|---|---|---|---|
| RK-003 | 外部システム・第三者への提供・連携 | 該当 | review は gh で PR を読み、PR に指摘を投稿する |
| RK-004 | 不可逆な操作 | 該当 | review は PR に inline comment を投稿する |

## 要求一覧

### 対象と目標

#### PR-DEVELOPREVIEW-001 目標の固定
review は、入口で計画の mode（diff・working_tree・audit・external のどれか）・対象・対象の版（mode ごとに次の表のもの）・除外を目標として固定し、後の段で書き換えてはならない。

| mode | 対象 | 目標として固定する対象の版 |
|---|---|---|
| diff | PR か差分 | 比較元の完全な SHA（baseRef）と比較先の完全な SHA（headSha）の組（方針の版 policyRef とは別に固定する） |
| working_tree | 未コミットの作業ツリー | 未コミットの作業ツリー |
| audit | path の範囲 | path の範囲の今の内容 |
| external | git の外の対象 | PR-DEVELOPREVIEW-055 の各ファイルの内容の SHA-256 |

#### PR-DEVELOPREVIEW-002 checkout していない PR
対象が PR であるとき、review は、利用者が PR の head を checkout していなくても、その head の内容をレビューしなければならない。

#### PR-DEVELOPREVIEW-003 渡された pin の値
呼び出し側が、呼び出し側の見ている対象と方針の版を指す pin の値を渡したとき、review はその値を解決し直してはならない。

### 観点

#### PR-DEVELOPREVIEW-004 観点の閉集合
review は、観点を、方針文書の「観点」の箇条の名前と、対象に出た種類の既定の観点からなる閉集合から選ばせなければならない。

#### PR-DEVELOPREVIEW-005 方針文書が無いときの閉集合
方針文書が無いとき、review は既定の観点だけから閉集合を作らなければならない。

#### PR-DEVELOPREVIEW-006 「必ず当てる」観点
対象が 1 件以上あるとき、review は、方針文書の「観点」の箇条のうち文に「必ず当てる」を含むものを必須の観点にしなければならない（箇条が書く適用の条件は散文で、機械では判定できない）。

#### PR-DEVELOPREVIEW-007 必須の観点の出所
review は、必須の観点を方針の版の方針文書から読み、利用側の宣言に写してはならない。

#### PR-DEVELOPREVIEW-008 方針文書が無いときの必須の観点
方針文書が無いとき、review は、既定の観点の共通の観点と、対象に出た種類の既定の観点を全て必須にしなければならない。

#### PR-DEVELOPREVIEW-009 方針文書があるときの種類の必須
方針文書があり、対象に skill の種類のファイルが出たとき、review は既定の観点の skill の観点を必須の観点にしなければならない。

#### PR-DEVELOPREVIEW-068 方針文書があるときの他の種類
方針文書があるとき、review は、skill 以外の種類の既定の観点を必須の観点にしてはならない（他の種類は方針文書の観点に任せる）。

#### PR-DEVELOPREVIEW-010 計画の拒否
review は、必須の観点が欠けた計画、閉集合の外の観点を含む計画、担当の無い対象を含む計画、mode が PR-DEVELOPREVIEW-001 の 4 つの外である計画を拒否しなければならない（選ぶ余地は必須でない観点だけに残す）。

#### PR-DEVELOPREVIEW-011 skill の種類のファイルの割り当て
review は、skill の種類のファイル（`SKILL.md`、その隣の `agents/*.md`、先頭の文が `export const meta` の `.js`）を、置き場ではなくファイル名と内容で見分け、skill の観点に必ず割り当てなければならない。

#### PR-DEVELOPREVIEW-012 skill の観点が読む規則
review は、skill の観点が規則として読む文書を方針文書の「読むもの」表から決め、利用側の宣言に写してはならない（写すと表と 2 箇所になる）。

#### PR-DEVELOPREVIEW-013 「読むもの」表の参照の解決
review は、方針文書の「読むもの」表の参照を、Markdown のリンクで書いたものと、利用側の宣言が指定した基点のディレクトリからの名前で書いたもののどちらでも、読む文書として解決しなければならない。

#### PR-DEVELOPREVIEW-061 基点のディレクトリの宣言が無いとき
利用側の宣言が基点のディレクトリを指定していないとき、review は「読むもの」表のディレクトリの無い名前を、基点を推測して解決してはならない。

#### PR-DEVELOPREVIEW-062 基点が無くて解決できなかった名前
利用側の宣言が基点のディレクトリを指定していないとき、review は「読むもの」表のディレクトリの無い名前の文書を、読めなかった文書として結果に書かなければならない。

#### PR-DEVELOPREVIEW-014 方針文書が無いとき
方針文書が無いとき、review は既定の観点で見て、結果に方針文書が無いことを書かなければならない。

#### PR-DEVELOPREVIEW-015 「読むもの」表を読めないとき
方針文書があるのに「読むもの」表が無いか表そのものを解析できないならば（一部の行の参照だけを解析できないときは PR-DEVELOPREVIEW-063）、review は止まり、読めなかったことを返さなければならない。

#### PR-DEVELOPREVIEW-063 表が挙げる文書を読めないとき
「読むもの」表そのものは解析でき、一部の行の参照を解析できない（Markdown のリンクでも基点のディレクトリからの名前でもない）か、表が挙げる文書の一部か全てが方針の版に無いか読めないとき、review は止まらずに、解析できて読めた行の文書と、方針文書の「観点」の箇条と既定の観点から作った観点の閉集合で見なければならない。

#### PR-DEVELOPREVIEW-064 読めなかった文書の宣言
「読むもの」表の一部の行の参照を解析できないか、表が挙げる文書の一部か全てが方針の版に無いか読めないとき、review は読めなかった文書と、参照を解析できなかった行をその行の文面とともに、見ていないものとして結果に書かなければならない。

#### PR-DEVELOPREVIEW-016 対象の種類の分類
review は、対象の種類（skill・code・document・specification・prd）を、決まった規則と利用側の宣言で決め、LLM に分類させてはならない。

#### PR-DEVELOPREVIEW-017 specification と prd の宣言が無いとき
利用側の宣言が specification と prd の対象を指定していないとき、review はそれらの対象を document として扱わなければならない。

#### PR-DEVELOPREVIEW-059 除外の宣言が無いとき
利用側の宣言が除外を指定していないとき、review はどの対象も除外してはならない。

#### PR-DEVELOPREVIEW-060 生成物の宣言が無いとき
利用側の宣言が生成物を指定していないとき、review はどの対象も生成物として扱ってはならない。

#### PR-DEVELOPREVIEW-018 重大度の語彙
review は、指摘の重大度を CRITICAL・HIGH・MEDIUM・LOW のどれかで書かなければならない。

### focus

#### PR-DEVELOPREVIEW-019 focus を書く役
review は、選ばれた観点ごとにその差分で何を見るか（focus）を、review の run の最初の段に置いた 1 体の役に書かせなければならない（司令塔が focus を書くと、司令塔が内容を作らないという役の分担に反する）。

#### PR-DEVELOPREVIEW-020 focus の引用
focus を書く役は、方針文書の束の節と対象の path・行を引いて focus を書かなければならない。

#### PR-DEVELOPREVIEW-065 方針文書が無いときの束の節
方針文書が無いリポジトリと git の外の対象では、review は既定の観点の節を、その run の方針文書の束の節にしなければならない（規則として読むのは既定の観点の節だけなので、focus が引く節と PR-DEVELOPREVIEW-022 の照合の先がそこになる）。

#### PR-DEVELOPREVIEW-021 focus を書く役が変えないもの
focus を書く役は、観点を足したり外したりしてはならない。

#### PR-DEVELOPREVIEW-022 合わない focus
引いた節が方針文書の束に無いか、引いた path が対象に無い focus を受け取ったならば、review はその観点の focus を空にし、そのことを限界として結果に書かなければならない。

#### PR-DEVELOPREVIEW-023 focus を省かない
差分が小さく見えるときも、review は focus を書く役を省いてはならない。

### 検証と資産台帳

#### PR-DEVELOPREVIEW-024 指摘の確定
review は、観点ごとの reviewer が挙げた指摘のうち、生成と別の context の検証（1 段目と、1 段目で決着しなかった主張にだけ当てる 2 段目）を通ったものだけを確定しなければならない。

#### PR-DEVELOPREVIEW-025 確定に要る票
review は、有効な票の無い主張と、確かめられない主張を確定してはならない（自己申告の confidence は使わない）。

#### PR-DEVELOPREVIEW-026 資産
review は、対象ファイルを、path と内容の SHA-256 で識別する資産として持たなければならない。

#### PR-DEVELOPREVIEW-027 「見た」の記録
review は、資産を「見た」ことを、信用できる reviewer が読み終えた範囲からだけ記録しなければならない。

#### PR-DEVELOPREVIEW-028 読まれていない資産の追加の起動
信用できる reviewer が誰も読み終えていない資産が残っているとき、review は、その資産だけを渡して reviewer を追加で起動しなければならない（全体を回し直すと、見終えた資産にも費用を払い直す）。

#### PR-DEVELOPREVIEW-029 追加の起動を止める回
review は、新しく見た資産が無くなった回で、reviewer の追加の起動を止めなければならない。

### 返り値の契約

#### PR-DEVELOPREVIEW-030 結果の状態
review の run が完了して返り値を状態に記録したとき（上限で止まったとき（PR-DEVELOPREVIEW-066）は含まない）、review は、run の返り値が持つ理由に応じて、次の表で結果の状態を 1 つ決めて返さなければならない（呼び出し側が 1 つの値で「0 件」と「レビューできなかった」を分けられるようにする）。

> 条件の値: 理由 = 無い / 見られなかった範囲・検証が終わらなかった主張・読んではならない対象の読み出しだけ / pin の変化・運搬役の失敗・CLI の拒否のどれかを含む

| 条件: 理由 | 結果 |
|---|---|
| 無い | success |
| 見られなかった範囲・検証が終わらなかった主張・読んではならない対象の読み出しだけ | degraded（検証を通った指摘は有効。run が最後まで進んでも、読まれていない資産か空にした focus が残れば、見られなかった範囲に当たる） |
| pin の変化・運搬役の失敗・CLI の拒否のどれかを含む | failed（指摘は空） |

#### PR-DEVELOPREVIEW-031 除外した指摘の返却
review は、反証された指摘・形の合わない指摘・信用できない reviewer の指摘を、空でも必ず返さなければならない。

#### PR-DEVELOPREVIEW-032 確定した指摘の返却
review は、確定した指摘の一覧を返さなければならない。

#### PR-DEVELOPREVIEW-069 未検証の指摘の返却
review は、検証が終わらなかった主張（未検証の指摘）の一覧を、確定した指摘と分けて返さなければならない（develop:implement が止まるかを PR-DEVELOPIMPLEMENT-028 で決めるため）。

#### PR-DEVELOPREVIEW-033 見ていないものの宣言
review は、coverage と、読まれないまま残った資産の一覧と、見なかったもの（除外・生成物・未読）を結果に載せなければならない（見ていない箇所が「問題なし」と読まれるのを防ぐ）。

#### PR-DEVELOPREVIEW-034 書き込みを検出したとき
review の run の中で書き込みを検出したならば、review は結果の状態を failed にし、指摘を空で返さなければならない。

#### PR-DEVELOPREVIEW-074 完了の条件
review は、次の条件を全て満たすときにだけ、結果の状態を返して完了しなければならない。

- 同じ pin のもとでの投稿の回数が PR-DEVELOPREVIEW-075 を満たしている（模型: `ReviewPostsOnce`）。
- 結果の状態が failed であるのは、PR-DEVELOPREVIEW-030 の表の failed の行か PR-DEVELOPREVIEW-034 に当たったときで、そのときに限る（模型: `ReviewFailedIff`）。
- failed でないときは、全ての項目の結果を記録しており、結果の状態が PR-DEVELOPREVIEW-030 の表の success か degraded の行と一致している（模型: `ReviewAllItems`）。
- PR-DEVELOPREVIEW-047 で投稿するときは、PR-DEVELOPREVIEW-050 の確認を通っている（模型: `ReviewPostConfirmed`）。

| 完了の種類 | 模型の action | 模型の性質 |
|---|---|---|
| failed | `R_Failed` | `ReviewGoal` |
| 投稿しない success・degraded | `R_FinishDone` | `ReviewGoal` |
| 投稿した success・degraded | `R_PostConfirmed` | `ReviewGoal` |

### 起動数の上限と再開

#### PR-DEVELOPREVIEW-035 起動数の上限を受け取る経路
review は、起動数の上限を Codex runner で起動されたときにだけ受け取り、native Workflow で起動されたときは受け取ってはならない（Codex runner で起動するときに上限を渡すことは PR-DEVELOPREVIEW-071）。

#### PR-DEVELOPREVIEW-071 Codex runner で起動するときの上限
Codex runner で review を起動するとき、その呼び出しは、runner の agent の総数の上限と一緒に、起動数の上限を review に渡さなければならない（渡さないと、review は枠を取っておかずに起動を続け、runner の総数の上限に当たった run が返り値ごと結果を失う）。

#### PR-DEVELOPREVIEW-036 上限を渡されないとき
起動数の上限を渡されないとき、review は固定の起動数の上限を置かず、観点の数を決め打ちしてはならない。

#### PR-DEVELOPREVIEW-070 1 回の呼び出しに収まらない項目
起動する項目の件数が runtime の 1 回の呼び出しの件数の上限を超えるとき、review は呼び出しを分けて全ての項目を起動し、項目を切り捨ててはならない（切り捨てた項目が「見た」と読まれる）。

#### PR-DEVELOPREVIEW-037 上限を渡されたときの枠の取り置き
起動数の上限を渡されたとき、review は、項目を起動する前に残りの枠を数え、その項目の後に要る役（PR-DEVELOPREVIEW-038 が数える役のうち、その項目の後に起動するもの）の枠を先に取っておかなければならない。

#### PR-DEVELOPREVIEW-038 起動数に数えるもの
起動数の上限を渡されたとき、review は、その run が起動する全ての agent（focus を書く役・最初の回の観点ごとの reviewer・2 段の検証の役・追加で起動する reviewer・運搬役）を起動数に数えなければならない。

#### PR-DEVELOPREVIEW-066 上限で止まったときの返り値
起動数の上限かトークン量の上限で止まったとき、review は結果の状態（success・degraded・failed）を決めず、上限で止まったこと・それまでの結果・未着手・next_args を返さなければならない（呼び出し側は、結果の状態を持つ返り値だけを最終の結果にする）。

#### PR-DEVELOPREVIEW-039 枠に収まらない項目
枠を取っておけない項目があるとき、review はその項目を起動せず、それまでの結果と順位つきの未着手を run の返り値に入れて、上限に届く前に止まらなければならない（上限で run が失敗すると返り値が無く、それまでの結果が失われる）。

#### PR-DEVELOPREVIEW-040 未着手の順位
review は、未着手の順位を観点の順に、同じ観点の中では担当の順に付けなければならない。

#### PR-DEVELOPREVIEW-041 止まった run の結果の記録
起動数の上限かトークン量の上限で止まった run が返ったとき、review は、その run の返り値を run の外で状態に書き、同じ返り値を何度書いても状態が変わらないようにしなければならない。

#### PR-DEVELOPREVIEW-042 未着手からの再開
起動数の上限かトークン量の上限で止まった review を、pin が崩れていないまま続けるとき、review は結果のある項目を処理し直してはならない。

#### PR-DEVELOPREVIEW-043 再開の前の pin の確認
review は、再開の前に pin が崩れていないかを確かめなければならない（崩れていたときの続け方は PR-DEVELOPREVIEW-073 の表）。

#### PR-DEVELOPREVIEW-072 停止の名前と記録する位置
review は、止まるとき、次の表の停止の名前を止まった理由として返し、記録する位置の列の段（計画・項目の起動・投稿・投稿の確認のどれか。「止まった段」はその停止が起きた段。「なし」は新しく呼ぶしか続かない停止）を再開する位置として状態に記録しなければならない。

| 停止 | 止まる条件を定める要求 | 記録する位置 | 模型の kind | 模型の action |
|---|---|---|---|---|
| 呼び直しを要する拒否 | PR-DEVELOPPLUGIN-004・011・014 | なし | なし（模型の範囲の外） | 模型の範囲の外 |
| 「読むもの」表を読めない | PR-DEVELOPREVIEW-015 | なし | `read_list` | `R_ReadListBad` |
| 起動数かトークン量の上限 | PR-DEVELOPREVIEW-039・066、PR-DEVELOPPLUGIN-045 | 項目の起動の、未着手の項目 | `limit_run` | `R_LimitStop` |
| BLOCKED | PR-DEVELOPREVIEW-051・067、PR-DEVELOPPLUGIN-033・040 | 止まった段の、結果を記録していない項目 | `blocked` | `R_PostFail`・`R_PostMismatch` |

#### PR-DEVELOPREVIEW-073 停止からの再開
止まった review を next_args で続けるとき、review は、人の入力を待たずに、停止と pin に応じて次の表のとおりに続けるか再開を拒否しなければならない。

> 条件の値: 停止 = 呼び直しを要する拒否 / 「読むもの」表を読めない / 起動数かトークン量の上限 / BLOCKED
> 条件の値: pin = 崩れていない / 崩れた

| 条件: 停止 | 条件: pin | 結果 | 模型の kind | 模型の action |
|---|---|---|---|---|
| 呼び直しを要する拒否 | * | 再開を拒否し、新しく呼ぶことを次の手として返す | なし（模型の範囲の外） | 模型の範囲の外 |
| 「読むもの」表を読めない | * | 再開を拒否し、方針文書を直して方針の版に入れてから新しく呼ぶことを次の手として返す（再開は方針の版を導き直さないので、同じ表をまた読めずに止まるため） | `read_list` | `R_RefuseResume` |
| 起動数かトークン量の上限 | 崩れていない | 記録した位置から続ける | `limit_run` | `R_Resume` |
| BLOCKED | 崩れていない | 原因を直した後に、記録した位置から続ける（投稿の確認から続けるときは投稿し直さない） | `blocked` | `R_Resume`（原因を直す入力は模型の範囲の外） |
| 上記以外 | 崩れた | 未着手と記録した位置を使わずに、計画からやり直す | `limit_run`・`blocked` | `R_Resume` |

#### PR-DEVELOPREVIEW-077 止まっている間に起きること
review は、止まっている間に起きたことと足された再開でない入力を、次の表のとおりに扱わなければならない。

| 起きたこと | 扱い | 模型の action |
|---|---|---|
| pin が崩れる | 止まったまま、再開の前の確認（PR-DEVELOPREVIEW-043）で見つける | `R_BreakPin` |
| 新しい呼び出し | 止まった状態を引き継がずに、計画から新しい依頼として始める | `R_Reinvoke` |
| 打ち切り | 再開せずに終わる | `H_Abort` |

#### PR-DEVELOPREVIEW-044 再開した run の権限
再開した review の run も、読み取り専用で起動しなければならない。

#### PR-DEVELOPREVIEW-045 同時に走る agent の数
review は、eval で決め直すまで、同時に走る agent の数を設計方針文書の「体数と同時実行」の節の初期値に合わせなければならない（初期値を広げるのは、eval や試走の実測で決めた基準を満たしたときである）。

#### PR-DEVELOPREVIEW-046 LLM に渡す前の統合
review は、同じ資産・行範囲・カテゴリの指摘を、LLM に渡す前に決定的な照合で 1 つにまとめなければならない（重複した指摘に LLM の費用を払い続けるのを防ぐ）。

### PR への投稿

#### PR-DEVELOPREVIEW-047 投稿する条件
対象が PR で、呼び出し側であること（caller）を渡されずに呼ばれ、投稿しないとの指定が無いとき、review は確定した指摘を PR に投稿しなければならない。

#### PR-DEVELOPREVIEW-048 呼び出し側があるとき
呼び出し側であること（caller）を渡されて呼ばれたとき、review は PR に投稿してはならない（投稿するかは呼び出し側の流れが持ち、委譲先が投稿すると二重の投稿になる）。

#### PR-DEVELOPREVIEW-049 行を解決できない指摘
PR の行を解決できない指摘は、review は投稿せず、投稿の候補として返さなければならない。

#### PR-DEVELOPREVIEW-050 投稿の確認
PR に投稿したとき、review は、投稿したコメントが確定した指摘の位置と一致するかを確かめなければならない。

#### PR-DEVELOPREVIEW-051 投稿の確認が食い違うとき
投稿の確認が食い違うか確かめられないならば、review は止まり、食い違いを返さなければならない。

#### PR-DEVELOPREVIEW-052 gh で投稿できない環境
投稿の前に gh が無いか gh の認証が通っていないと分かったとき、review は投稿の代わりに、確定した指摘を Codex のコードコメントの形で返さなければならない。

#### PR-DEVELOPREVIEW-067 投稿が拒まれたか失敗したとき
gh で投稿を試みて拒まれたか失敗したならば（権限が無く拒まれたときを含む）、review は BLOCKED で止まり、失敗した操作と理由と次の手を返さなければならない。

#### PR-DEVELOPREVIEW-075 同じ pin のもとでの投稿の回数
review は、完了の前と止まった後を含むどの時点でも、同じ pin のもとで確定した指摘を PR に 2 回以上投稿してはならない（投稿は取り消さないので（PR-DEVELOPPLUGIN-049）、二重の投稿が残るため）。

#### PR-DEVELOPREVIEW-076 pin が崩れた後の投稿
pin が崩れて計画からやり直した review は、前の pin のもとで投稿したことを理由に、新しい pin のもとでの PR-DEVELOPREVIEW-047 の投稿を省いてはならない（PR-DEVELOPREVIEW-075 の回数は pin ごとに数える）。

### git の外の対象

#### PR-DEVELOPREVIEW-053 git の外の対象を見る条件
review は、貼り付けた文書と repo の外のファイルを、利用者がそれを名指してレビューを頼んだときにだけ見なければならない。

#### PR-DEVELOPREVIEW-054 貼り付けた本文の扱い
貼り付けた本文をレビューするとき、review はその本文を逐語で状態に写し、手を加えてはならない。

#### PR-DEVELOPREVIEW-055 git の外の対象の目標
git の外の対象をレビューするとき、review は、対象のファイルと内容の SHA-256 を目標として固定しなければならない。

#### PR-DEVELOPREVIEW-056 git の外の対象の観点
git の外の対象をレビューするとき、review は既定の観点だけで見なければならない。

#### PR-DEVELOPREVIEW-057 git の外の対象の資産台帳
git の外の対象をレビューするとき、review は、ファイルと内容の SHA-256 を資産とする資産台帳を作らなければならない。

#### PR-DEVELOPREVIEW-058 git の外の対象で見なかったもの
git の外の対象をレビューするとき、review は、見なかったもの（方針文書、除外と生成物の判定、PR への投稿）を結果に必ず書かなければならない。
