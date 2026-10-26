# 要求文書: develop:implement

表記規約と用語は、develop plugin 全体の要求文書（PR-DEVELOPPLUGIN）に従う。本文書の要求の主語「implement」は develop:implement を指す。

## 背景と課題

claude-plugins の repo-implement は、計画・計画のレビュー・実装・check・レビュー・上限つきの修正・最終照合を回すが、check を Makefile に、方針を claude-plugins の主ブランチに固定している。人の回答を依頼の文に足して計画からやり直すので、何を頼まれ何を後から決めたかが区別できない。workflow:pr-review-fix の、計画だけを作って止める使い方と確定した指摘だけを直す使い方も、implement が引き継ぐ必要がある。

## 想定する利用者と利用場面

| 利用者 | 利用場面 |
|---|---|
| 利用者 | 変更の実装を頼む。計画だけを作って止め、確かめてから続けるよう頼む |
| develop:address-review | 分類と分類の検証を通った修正を、方針の版と、PR があるときは PR の番号を添えて渡す |

## どう使われるか

1. implement は入口で依頼の文を目標として固定する。
2. 計画の run で計画を作り、計画のレビューを通す。計画で止めるよう頼まれていれば、ここで止まる。
3. 開始時の check を流し、実装の run で変更し、変更の後の check を流す。
4. develop:review を呼び、確定した指摘を直す。修正の回には上限がある。
5. 最終照合を通った変更だけを、頼まれたときに commit する。push は利用側の宣言に従うが、develop:address-review から PR の修正として頼まれた commit は push せず、develop:address-review が push する。

## スコープとスコープ外

スコープ: 目標の固定、計画と計画のレビュー、実装・check・レビュー・上限つきの修正、計画で止めて再開、develop:review の呼び出しと返り値の照合、commit と push。

スコープ外: レビューそのもの（develop:review が持つ）、PR の指摘の分類と返信（develop:address-review が持つ）、仕様の ID ごとの結び付きの検査（develop の作成の完了の条件として PR-DEVELOPPLUGIN-073 が持つ）。

## 前提と依存

- 方針の版の導き方と、利用側の宣言の扱いは PR-DEVELOPPLUGIN-011〜015・080 に従う。
- 変更の後のレビューは develop:review に依存する。

## リスクと影響

| ID | 観点 | 判定 | 根拠 |
|---|---|---|---|
| RK-005 | 外部システム・第三者への提供・連携 | 該当 | implement は gh で PR の base の branch を読み、git の remote に push する |
| RK-006 | 不可逆な操作 | 該当 | implement は利用側の宣言に従って remote の branch に push する |

## 要求一覧

### 入口と目標

#### PR-DEVELOPIMPLEMENT-001 目標の固定
implement は、入口で、依頼の文から範囲と禁止事項を抜き出して指示語を固有名に置き換えた自己完結の文を、目標として状態に固定しなければならない。

#### PR-DEVELOPIMPLEMENT-036 依頼の文の保存
implement は、入口で依頼の文をそのまま状態に残さなければならない。

#### PR-DEVELOPIMPLEMENT-037 目標に足さないもの
implement は、依頼の文に無い目標と制約を目標に足してはならない。

#### PR-DEVELOPIMPLEMENT-038 依頼の文と目標を書き換えない
implement は、後の段で依頼の文と目標を書き換えてはならない。

#### PR-DEVELOPIMPLEMENT-002 人の回答の記録
途中で人が答えたとき、implement はその回答を目標の文に足さず、別の記録として状態に足さなければならない（目標の文に足すと、何を頼まれ何を後から決めたかが区別できなくなる）。

#### PR-DEVELOPIMPLEMENT-052 記録した回答を読ませる
人の回答を状態に記録したとき、implement は計画の run から続け、記録した回答を計画役に読ませなければならない。

#### PR-DEVELOPIMPLEMENT-003 渡された方針の版と照らす先
develop:address-review から方針の版の SHA を受け取ったとき、implement は、照らす先の branch を自分で導かなければならない（作業 branch の規約で同じ変更を免責しないため）。

#### PR-DEVELOPIMPLEMENT-004 照らす先の branch の導き方
implement は、PR の番号を渡されたらその PR の base の branch を、PR の無い形で指摘の収集が branch を名指していれば remote にあると確かめたその branch を、PR の番号も名指された branch も無ければ既定ブランチを、照らす先の branch にしなければならない。

#### PR-DEVELOPIMPLEMENT-053 名指された branch が remote に無いとき
名指された branch が remote に無いか、あるかを確かめられないならば、implement は既定ブランチを照らす先にせずに止まり、理由を返さなければならない。

#### PR-DEVELOPIMPLEMENT-005 渡された SHA の確認
渡された SHA が照らす先の branch の remote の先端の祖先（同じ commit を含む）でないか、祖先かを確かめられないならば、implement は受け取りを拒否して止まらなければならない。

### 計画

#### PR-DEVELOPIMPLEMENT-006 計画の run
implement は、計画役と計画のレビュー役を、計画が通るか作り直しの上限に達するまで繰り返す、読み取り専用の run で動かさなければならない。

#### PR-DEVELOPIMPLEMENT-007 計画が通らないとき
作り直しの上限に達しても計画が通らないならば、implement は、計画が通らなかったことと理由を返さなければならない。

#### PR-DEVELOPIMPLEMENT-008 計画の run が人の判断を求めたとき
計画の run が人の判断を要すると返したならば、implement は人の判断待ちで止まらなければならない。

#### PR-DEVELOPIMPLEMENT-009 計画の run の書き込み
計画の run の中で書き込みを検出したならば、implement は BLOCKED で止まらなければならない。

#### PR-DEVELOPIMPLEMENT-039 止まっている間のヒント
implement の run の実行中と、implement が完了以外の状態で止まっている間、implement は、人が CLI で状態にヒントを足せるようにしなければならない（設計方針文書の「停止・再開と人間の入力」の節のヒントの行）。

#### PR-DEVELOPIMPLEMENT-040 ヒントを読ませる
止まっていた間に人がヒントを足してから implement を再開したとき、implement は、再開した run を計画の run から始め、計画役にそのヒントを読ませなければならない（ヒントが足されていなければ、PR-DEVELOPPLUGIN-035 のとおり止まった所から続ける）。

#### PR-DEVELOPIMPLEMENT-065 ヒントで作り直したときの開始時の check
PR-DEVELOPIMPLEMENT-040 で計画の run から作り直したとき、状態に開始時の check の結果があるならば、implement は開始時の check を流し直さずに、変更の後の check をその結果と比べなければならない（変更を含む作業ツリーで流し直すと、変更が起こした失敗が開始時の結果に入る）。

#### PR-DEVELOPIMPLEMENT-067 ヒントで作り直したときに開始時の結果が無いとき
PR-DEVELOPIMPLEMENT-040 で計画の run から作り直したとき、状態に開始時の check の結果が無いならば（計画で止めた後の続き）、implement は作り直した計画の受け入れの後に開始時の check を流さなければならない。

#### PR-DEVELOPIMPLEMENT-066 ヒントで作り直した計画の後で止まる所
PR-DEVELOPIMPLEMENT-040 で作り直した計画の受け入れの後、再開の呼び出しが計画で止めることを頼んでいないならば、implement は計画で止まってはならない。

#### PR-DEVELOPIMPLEMENT-041 ヒントの足し方の提示
implement は、起動したときに、ヒントの足し方を利用者に示さなければならない。

#### PR-DEVELOPIMPLEMENT-042 完了した状態へのヒント
完了した状態にヒントを足そうとしたならば、implement はそのヒントを拒否しなければならない。

#### PR-DEVELOPIMPLEMENT-010 check の宣言が無いとき
利用側の宣言が check を宣言していないならば、implement は計画の受け入れで止まり、check の宣言の雛形と、宣言を方針の版に入れてから implement を新しく呼ぶこと（PR-DEVELOPPLUGIN-050）を次の手として返さなければならない（宣言は方針の版から読むので、止まった状態から続けても宣言は無いままになる。宣言が無いまま check を省くと、テストを流していない変更が最終照合を通る）。

#### PR-DEVELOPIMPLEMENT-011 check を推測しない
implement は、check の許可リストを推測で作ってはならない（推測すると、モデルの書いた文を shell に渡す経路ができる）。

#### PR-DEVELOPIMPLEMENT-012 計画で止める
計画で止めるよう頼まれたとき、implement は計画の受け入れの後で、承認された計画を状態に残して止まり、next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-013 計画で止めた後の続き
計画で止めた implement を next_args で続けるとき、止まっていた間にヒントが足されておらず、作業ツリーが計画の受け入れの時から変わっていなければ、implement は開始時の check から続けなければならない（ヒントが足されていたときは PR-DEVELOPIMPLEMENT-040・066・067）。

#### PR-DEVELOPIMPLEMENT-014 計画で止めた後に作業ツリーが変わったとき
計画で止めた implement を続けるときに、作業ツリーが計画の受け入れの時から変わっていたか、変わっていないことを確かめられないならば、implement は続けることを拒否し、理由を返して止まらなければならない。

#### PR-DEVELOPIMPLEMENT-015 作業ツリーが変わった後に続けるとき
作業ツリーが計画の受け入れの時から変わっていたために PR-DEVELOPIMPLEMENT-014 で止まった後に実装を続けるとき、implement は新しく呼ばれ、計画から作り直さなければならない（変わっていないことを確かめられずに止まったときは、原因を直した後に PR-DEVELOPPLUGIN-035 のとおり続ける）。

### 実装と check

#### PR-DEVELOPIMPLEMENT-016 開始時の check
implement は、実装の前に、check の許可リストのうち対象のパスの glob が無いものと glob が対象のパスに当たるものを、必須と宣言されているかに関わらず全て宣言の argv で流し、その結果を状態に記録しなければならない。

#### PR-DEVELOPIMPLEMENT-017 宣言の外の check
implement は、宣言された argv の外のコマンドを check として流してはならない。

#### PR-DEVELOPIMPLEMENT-018 書き込める run の役
implement は、作業ツリーを書き換える run に実装役だけを置かなければならない（書き込める run に計画役やレビュー役を置くと、Codex runner では書き込みを止められず、native Workflow ではどの役の段の書き込みかを切り分けられない）。

#### PR-DEVELOPIMPLEMENT-043 確定した指摘が計画の外を指すとき
実装の run が、確定した指摘が承認した計画の外を指すと返したとき、implement は人の判断を待たずに、計画の run から作り直して続けなければならない。

#### PR-DEVELOPIMPLEMENT-058 作り直すときの作業ツリー
PR-DEVELOPIMPLEMENT-043 で計画の run から作り直すとき、implement は作業ツリーの変更を捨てずに残したまま次の計画を作らなければならない。

#### PR-DEVELOPIMPLEMENT-059 作り直した後の check の比べる先
PR-DEVELOPIMPLEMENT-043 で作り直した後、implement は開始時の check を流し直さず、変更の後の check を最初の開始時の結果と比べ続けなければならない（変更を含む作業ツリーで流し直すと、変更が起こした失敗が開始時の結果に入る）。

#### PR-DEVELOPIMPLEMENT-060 作り直しと修正の回の数
implement は、PR-DEVELOPIMPLEMENT-043 の作り直しをまたいで修正の回の数を初期値に戻さずに数え続け、上限に達したら PR-DEVELOPIMPLEMENT-021 のとおり止まらなければならない。

#### PR-DEVELOPIMPLEMENT-044 直す変更が無いとき
実装の run が直す変更が無いと返したとき、implement は最終照合も commit もせずに implement の結果を返して終わらなければならない。

#### PR-DEVELOPIMPLEMENT-061 直す変更が無いときの結果
PR-DEVELOPIMPLEMENT-044 で終わるとき、implement は commit の SHA を結果に含めてはならない（最後の develop:review の確定した指摘と修正の回数は PR-DEVELOPIMPLEMENT-035 のとおり書く）。

#### PR-DEVELOPIMPLEMENT-019 変更の後の check
implement は、変更の後に開始時と同じ集合の check（PR-DEVELOPIMPLEMENT-016）を流し、開始時の結果と check の中の個々の失敗で比べて、変更が新しく起こした失敗だけを直す対象にしなければならない（開始時から落ちていた check の中で変更が新しく起こした失敗も、直す対象に入る）。

#### PR-DEVELOPIMPLEMENT-020 テストのケースの基準
implement は、条件ごとのケース計画を、利用側の宣言が指定したテストの設計の基準で作り、宣言が無いときだけ plugin の既定の基準で作らなければならない。

#### PR-DEVELOPIMPLEMENT-054 指定された基準を読めないとき
利用側の宣言が指定したテストの設計の基準の path か節が方針の版に無いか読めないならば、implement は plugin の既定の基準に落とさずに止まり、読めなかった基準と理由を返さなければならない。

#### PR-DEVELOPIMPLEMENT-021 修正の回の上限に達したとき
修正の回の上限に達しても、変更が起こした check の失敗か確定した指摘が残るならば、implement は反復の上限で止まり、残った check の失敗・確定した指摘・修正の回数・next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-022 上限で止まったときの変更
修正の回の上限で止まるとき、implement は作業ツリーの変更と状態を捨ててはならない（人が入力を足すか原因を直した後に、next_args で続けられるようにする）。

#### PR-DEVELOPIMPLEMENT-055 上限で止まった後の再開
修正の回の上限で止まった implement を、人が入力を足した後に next_args で続けるとき、再開した run は、今の作業ツリーで変更の後の check と develop:review を流す前に、修正の回の上限で止まってはならない（人の入力が効く前に前の run と同じ理由で止めないため。修正の回の数は初期値に戻さない）。

### develop:review の呼び出し

#### PR-DEVELOPIMPLEMENT-023 review の呼び出し
implement は、変更の後のレビューに develop:review をスキル呼び出しで起動し、呼び出し側であることと、implement の見ている対象と方針の版を指す pin の値を渡さなければならない（develop:review が値を解決し直さずに、implement と同じ対象と方針の版を見るため）。

#### PR-DEVELOPIMPLEMENT-024 review が上限で止まったとき
develop:review が起動数の上限かトークン量の上限で止まって next_args を返したとき、implement はその返り値を最終の結果として記録せず、同じ next_args で develop:review を呼び直さなければならない（確定した指摘が 0 件でも、この返り値は 0 件の完了ではない）。

#### PR-DEVELOPIMPLEMENT-025 記録する review の返り値
implement は、develop:review が返した結果の状態に応じて、次の表のとおりに扱わなければならない。

> 条件の値: 結果の状態 = success / degraded / failed

| 条件: 結果の状態 | 結果 |
|---|---|
| success | 完了した返り値（completed）として記録する |
| degraded | レビューが未完了で返った返り値（review_incomplete）として記録し、検証を通った指摘を確定した指摘として扱う |
| failed | 記録せず、最終照合へ進まず、commit も push もせずに BLOCKED で止まり、failed の理由と next_args を返す |

#### PR-DEVELOPIMPLEMENT-045 review が failed のときの変更
develop:review の failed で止まるとき、implement は作業ツリーの変更を捨ててはならない（原因を直した後に next_args で再開できるようにする）。

#### PR-DEVELOPIMPLEMENT-026 review の返り値の照合
implement は、develop:review の返り値を develop:review の返り値の形に照らし、合わない返り値を受け付けてはならない。

#### PR-DEVELOPIMPLEMENT-056 返り値が形に合わないとき
develop:review の返り値が形に合わないならば、implement は develop:review を呼び直さずに BLOCKED で止まり、合わなかった理由と next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-027 直す対象にする指摘
implement は、develop:review の確定した指摘だけを修正の対象にしなければならない。

#### PR-DEVELOPIMPLEMENT-028 未検証の指摘が残るとき
develop:review の返り値に未検証の指摘（PR-DEVELOPREVIEW-069 が返す、検証が終わらなかった主張）が残るならば、implement は abandon を返して止まらなければならない。

#### PR-DEVELOPIMPLEMENT-046 abandon で止まるときの変更
abandon で止まるとき、implement は作業ツリーの変更と状態を捨ててはならない（人が入力を足した後に next_args で再開できるようにする）。

#### PR-DEVELOPIMPLEMENT-047 abandon で止まるときに返すもの
abandon で止まるとき、implement は、残った変更・最後の develop:review の確定した指摘と未検証の指摘・next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-062 abandon で止まるときに人が決めること
abandon で止まるとき、implement は、未検証の指摘ごとに人が決めること（確定とするか退けるか）を返さなければならない。

#### PR-DEVELOPIMPLEMENT-063 人の判断を足した後の再開
人が未検証の指摘の判断を状態に足してから next_args で再開したとき、implement は、確定とした指摘を直す対象にし、退けた指摘を直す対象から外さなければならない。

#### PR-DEVELOPIMPLEMENT-064 判断を足された指摘で再び止まらない
PR-DEVELOPIMPLEMENT-063 で再開した run は、人の判断を足された指摘を理由に、再び abandon で止まってはならない。

#### PR-DEVELOPIMPLEMENT-048 abandon で止まるときの commit と push
abandon で止まるとき、implement は commit と push をしてはならない。

#### PR-DEVELOPIMPLEMENT-029 記録した review の返り値による進み方
implement は、記録した develop:review の返り値に応じて、completed と review_incomplete のどちらでも次の表のとおりに進まなければならない。

> 条件の値: 未検証の指摘 = あり / なし
> 条件の値: 確定した指摘 = あり / なし
> 条件の値: 修正の回 = 上限未満 / 上限に達した

| 条件: 未検証の指摘 | 条件: 確定した指摘 | 条件: 修正の回 | 結果 |
|---|---|---|---|
| あり | * | * | abandon を返して止まる（PR-DEVELOPIMPLEMENT-028） |
| なし | あり | 上限未満 | 確定した指摘を修正の対象にして修正の回へ進む |
| なし | あり | 上限に達した | 反復の上限で止まる（PR-DEVELOPIMPLEMENT-021） |
| なし | なし | * | 最終照合へ進む |

#### PR-DEVELOPIMPLEMENT-030 見られなかった範囲の報告
develop:review がレビューの未完了を返したとき、implement は、develop:review が見られなかった範囲と理由を implement の結果に書かなければならない。

### 最終照合と永続化

#### PR-DEVELOPIMPLEMENT-057 最終照合で照らすもの
implement は、最終照合で、変更の後の check に変更が起こした失敗が無いことと、記録した develop:review の返り値に確定した指摘と未検証の指摘が残っていないことを照らさなければならない。

#### PR-DEVELOPIMPLEMENT-031 最終照合が通らないとき
最終照合が通らないか照らせないならば、implement は BLOCKED で止まり、通らなかった照合と理由・next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-032 最終照合が通らないときの変更
最終照合が通らずに止まるとき、implement は作業ツリーの変更を捨ててはならない（原因を直した後に再開できるようにする）。

#### PR-DEVELOPIMPLEMENT-033 commit する条件
implement は、commit を頼まれたときにだけ commit しなければならない。

#### PR-DEVELOPIMPLEMENT-034 commit の後の push
commit の後に push するかは、implement は利用側の宣言に従い、宣言が無ければ push してはならない（PR-DEVELOPIMPLEMENT-049 の場合を除く）。

#### PR-DEVELOPIMPLEMENT-049 address-review から PR の修正を受けたとき
develop:address-review から PR の修正として commit を頼まれたとき、implement は最終照合を通った修正を commit して、その SHA を返さなければならない。

#### PR-DEVELOPIMPLEMENT-051 address-review の PR の修正を push しない
develop:address-review から PR の修正として commit を頼まれたとき、implement はその commit を push してはならない（push は develop:address-review が行う）。

#### PR-DEVELOPIMPLEMENT-050 push が拒まれたとき
push が拒まれたならば、implement は止まり、拒まれた理由を返さなければならない。

#### PR-DEVELOPIMPLEMENT-035 implement の結果
implement は、最後の develop:review の結果と修正の回数を結果に書かなければならない。
