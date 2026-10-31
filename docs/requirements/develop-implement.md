# 要求文書: develop:implement

表記規約と用語は、develop plugin 全体の要求文書（PR-DEVELOPPLUGIN）に従う。これに加えて本文書では、「確定した指摘」と「未検証の指摘」は PR-DEVELOPIMPLEMENT-063 の数え方で数えたものを、「この呼び出し」は next_args での再開を含めた 1 つの依頼の呼び出しを指す。本文書の要求の主語「implement」は develop:implement を指す。

## 背景と課題

claude-plugins の repo-implement は、計画・計画のレビュー・実装・check・レビュー・上限つきの修正・最終照合を回すが、check を Makefile に、方針を claude-plugins の主ブランチに固定している。人の回答を依頼の文に足して計画からやり直すので、何を頼まれ何を後から決めたかが区別できない。workflow:pr-review-fix の、計画だけを作って止める使い方と確定した指摘だけを直す使い方も、implement が引き継ぐ必要がある。

## 想定する利用者と利用場面

| 利用者 | 利用場面 |
|---|---|
| 利用者 | 変更の実装を頼む。計画だけを作って止め、確かめてから続けるよう頼む |
| develop:address-review | 分類と分類の検証を通った修正を、方針の版と、PR があるときは PR の番号を、PR が無く base の branch が名指されたときはその branch を添えて渡す |

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
- 停止と再開の表と完了の条件の「模型の action」の列は、`tests/formal/develop/DevelopSkill.tla` の action の名前を、「模型の性質」の列は `tests/formal/develop/DevelopProps.tla` の性質の名前を指す。

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
PR-DEVELOPIMPLEMENT-008 の人の判断待ちで止まった後に、計画の run が求めた判断への人の回答を状態に記録して再開したとき、implement は、再開した計画の run で記録した回答を計画役に読ませなければならない。

#### PR-DEVELOPIMPLEMENT-003 渡された方針の版と照らす先
develop:address-review から方針の版の SHA を受け取ったとき、implement は、照らす先の branch を自分で導かなければならない（作業 branch の規約で同じ変更を免責しないため）。

#### PR-DEVELOPIMPLEMENT-004 照らす先の branch の導き方
implement は、PR の番号を渡されたらその PR の base の branch を、PR の番号を渡されず develop:address-review から名指された base の branch を渡されたら remote にあると確かめたその branch を、PR の番号も名指された branch も渡されなければ既定ブランチを、照らす先の branch にしなければならない。

#### PR-DEVELOPIMPLEMENT-053 名指された branch が remote に無いとき
名指された branch が remote に無いか、あるかを確かめられないならば、implement は既定ブランチを照らす先にせずに止まり、理由を返さなければならない。

#### PR-DEVELOPIMPLEMENT-005 渡された SHA の確認
渡された SHA が照らす先の branch の remote の先端の祖先（同じ commit を含む）でないか、祖先かを確かめられないならば、implement は受け取りを拒否して止まらなければならない。

### 計画

#### PR-DEVELOPIMPLEMENT-006 計画の run
implement は、計画役と計画のレビュー役を、計画が通るか作り直しの上限に達するまで繰り返す、読み取り専用の run で動かさなければならない。

#### PR-DEVELOPIMPLEMENT-007 計画が通らないとき
作り直しの上限に達しても計画が通らないならば、implement は作り直しの上限の停止（PR-DEVELOPIMPLEMENT-068）で止まり、計画が通らなかったことと理由・next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-008 計画の run が人の判断を求めたとき
計画の run が人の判断を要すると返したならば、implement は人の判断待ちで止まらなければならない。

#### PR-DEVELOPIMPLEMENT-009 計画の run の書き込み
計画の run の中で書き込みを検出したならば、implement は BLOCKED で止まらなければならない。

#### PR-DEVELOPIMPLEMENT-039 止まっている間のヒント
PR-DEVELOPIMPLEMENT-042 が拒否する状態を除き、implement の run の実行中と、implement が止まっている間、implement は、人が CLI で状態にヒントを足せるようにしなければならない（設計方針文書の「停止・再開と人間の入力」の節のヒントの行）。

#### PR-DEVELOPIMPLEMENT-040 ヒントを読ませる
未読のヒントがある状態で計画の run を始めたとき、implement は、計画役にそのヒントを読ませなければならない。

#### PR-DEVELOPIMPLEMENT-065 ヒントで作り直したときの開始時の check
未読のヒントで計画の run から作り直したとき（PR-DEVELOPIMPLEMENT-069・071）、状態に開始時の check の結果があるならば、implement は開始時の check を流し直さずに、変更の後の check をその結果と比べなければならない（変更を含む作業ツリーで流し直すと、変更が起こした失敗が開始時の結果に入る）。

#### PR-DEVELOPIMPLEMENT-067 ヒントで作り直したときに開始時の結果が無いとき
未読のヒントで計画の run から作り直したとき（PR-DEVELOPIMPLEMENT-069・071）、状態に開始時の check の結果が無いならば（計画で止めた後の続き）、implement は作り直した計画の受け入れの後に開始時の check を流さなければならない。

#### PR-DEVELOPIMPLEMENT-066 ヒントで作り直した計画の後で止まる所
未読のヒントで作り直した計画の受け入れの後、再開の呼び出しが計画で止めることを頼んでいないならば、implement は計画で止まってはならない。

#### PR-DEVELOPIMPLEMENT-041 ヒントの足し方の提示
implement は、起動したときに、ヒントの足し方を利用者に示さなければならない。

#### PR-DEVELOPIMPLEMENT-042 ヒントを拒否する状態
完了した状態か、新しく呼ぶことでしか続かない状態（PR-DEVELOPIMPLEMENT-068 の表で記録する位置が「なし」の停止と、計画で止めた後に作業ツリーが計画の受け入れの時から変わった状態）にヒントを足そうとしたならば、implement はそのヒントを拒否しなければならない（足しても読まれないため）。

#### PR-DEVELOPIMPLEMENT-010 check の宣言が無いとき
利用側の宣言が check を宣言していないならば、implement は計画の受け入れで止まり、check の宣言の雛形と、宣言を方針の版に入れてから implement を新しく呼ぶこと（PR-DEVELOPPLUGIN-050）を次の手として返さなければならない（宣言は方針の版から読むので、止まった状態から続けても宣言は無いままになる。宣言が無いまま check を省くと、テストを流していない変更が最終照合を通る）。

#### PR-DEVELOPIMPLEMENT-011 check を推測しない
implement は、check の許可リストを推測で作ってはならない（推測すると、モデルの書いた文を shell に渡す経路ができる）。

#### PR-DEVELOPIMPLEMENT-012 計画で止める
計画で止めるよう頼まれたとき、implement は計画の受け入れの後で、承認された計画を状態に残して止まり、next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-013 計画で止めた後の続き
計画で止めた implement を、PR-DEVELOPIMPLEMENT-069 の表の記録した位置から続ける行で続けるとき、implement は状態に残した承認された計画を使わなければならない。

#### PR-DEVELOPIMPLEMENT-014 計画で止めた後に作業ツリーが変わったとき
計画で止めた implement を続けるときに、作業ツリーが計画の受け入れの時から変わっていたか、変わっていないことを確かめられないならば、implement は続けることを拒否し、理由を返して止まらなければならない（どの停止の名前で止まるかは PR-DEVELOPIMPLEMENT-069 の表）。

#### PR-DEVELOPIMPLEMENT-015 作業ツリーが変わった後に続けるとき
作業ツリーが変わった停止（PR-DEVELOPIMPLEMENT-068）の後に実装を続けるとき、implement は新しく呼ばれ、計画から作り直さなければならない。

### 実装と check

#### PR-DEVELOPIMPLEMENT-016 開始時の check
implement は、実装の前に（状態に開始時の check の結果があるとき（PR-DEVELOPIMPLEMENT-059・065・078）を除き）、check の許可リストのうち対象のパスの glob が無いものと glob が対象のパスに当たるものを、必須と宣言されているかに関わらず全て宣言の argv で流し、その結果を状態に記録しなければならない。

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
implement は、PR-DEVELOPIMPLEMENT-043 の作り直しを修正の回の 1 回に数え、修正の回の数を作り直しをまたいで初期値に戻さずに数え、修正の回が上限に達していれば作り直さずに PR-DEVELOPIMPLEMENT-021 のとおり止まらなければならない。

#### PR-DEVELOPIMPLEMENT-044 直す変更が無いとき
実装の run が直す変更が無いと返し、この呼び出しの実装の run が作業ツリーを一度も変更しておらず（PR-DEVELOPIMPLEMENT-078 で止まった呼び出しから引き継いだ変更も無く）、develop:review の返り値をまだ記録しておらず、未読のヒントが無いとき（あるときは PR-DEVELOPIMPLEMENT-071）、implement は最終照合も commit もせずに implement の結果を返して終わらなければならない。

#### PR-DEVELOPIMPLEMENT-073 直す変更が無いと返されても終わらないとき
実装の run が直す変更が無いと返したとき、この呼び出しの実装の run が作業ツリーを変更していた（PR-DEVELOPIMPLEMENT-078 で止まった呼び出しから変更を引き継いだときを含む）か、develop:review の返り値を記録しているならば、implement は終わらずに変更の後の check へ進まなければならない（check と develop:review を通っていない変更が完了として返るのを防ぐ）。

#### PR-DEVELOPIMPLEMENT-061 直す変更が無いときの結果
PR-DEVELOPIMPLEMENT-044 で終わるとき、implement は commit の SHA を結果に含めてはならない。

#### PR-DEVELOPIMPLEMENT-019 変更の後の check
implement は、変更の後に開始時と同じ集合の check（PR-DEVELOPIMPLEMENT-016）を流し、開始時の結果と check の中の個々の失敗で比べて、変更が新しく起こした失敗だけを直す対象にしなければならない（開始時から落ちていた check の中で変更が新しく起こした失敗も、直す対象に入る）。

#### PR-DEVELOPIMPLEMENT-020 テストのケースの基準
implement は、条件ごとのケース計画を、利用側の宣言が指定したテストの設計の基準で作り、宣言が無いときだけ plugin の既定の基準で作らなければならない。

#### PR-DEVELOPIMPLEMENT-054 指定された基準を読めないとき
利用側の宣言が指定したテストの設計の基準の path か節が方針の版に無いか読めないならば、implement は plugin の既定の基準に落とさずに止まり、読めなかった基準と理由を返さなければならない。

#### PR-DEVELOPIMPLEMENT-021 修正の回の上限に達したとき
修正の回の上限に達しても、変更が起こした check の失敗か確定した指摘が残るならば、implement は修正の回の上限の停止（PR-DEVELOPIMPLEMENT-068）で止まり、残った check の失敗・確定した指摘・修正の回数・next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-022 上限で止まったときの変更
修正の回の上限で止まるとき、implement は作業ツリーの変更と状態を捨ててはならない（上限の引き上げか作業ツリーの手直しの後に、PR-DEVELOPIMPLEMENT-069 のとおり続けられるようにするため）。

#### PR-DEVELOPIMPLEMENT-055 手直しの後の再開
修正の回の上限で止まった implement を、人が作業ツリーを直した後に next_args で続けるとき、再開した run は、今の作業ツリーで変更の後の check と develop:review を流す前に、修正の回の上限で止まってはならない（人の手直しが効く前に前の run と同じ理由で止めないため）。

#### PR-DEVELOPIMPLEMENT-072 上限から作り直した計画
修正の回の上限で止まった implement を、未読のヒントがある状態で再開して計画の run から作り直したとき、implement は、作り直した計画の受け入れの後、実装の run の前に、今の作業ツリーで変更の後の check と develop:review を流して PR-DEVELOPIMPLEMENT-029 の判定へ進まなければならない。

### develop:review の呼び出し

#### PR-DEVELOPIMPLEMENT-023 review の呼び出し
implement は、変更の後のレビューに develop:review を、未コミットの作業ツリーのレビュー（計画の mode が working_tree）としてスキル呼び出しで起動し、呼び出し側であることと、implement の見ている対象と方針の版を指す pin の値と、develop:review の 1 回の run の上限（Codex runner では PR-DEVELOPREVIEW-071 の runner の agent の総数の上限と起動数の上限、native Workflow で implement の起動か再開の入力に PR-DEVELOPPLUGIN-043 のトークン量の上限が渡されているときはそのトークン量の上限）を渡さなければならない（develop:review が値を解決し直さずに、implement と同じ対象と方針の版を見るため）。

#### PR-DEVELOPIMPLEMENT-024 review が上限で止まったとき
develop:review が起動数の上限かトークン量の上限で止まって next_args を返したとき、PR-DEVELOPIMPLEMENT-075 に当たるときを除き、implement はその返り値を最終の結果として記録せず、同じ next_args で develop:review を呼び直さなければならない（確定した指摘が 0 件でも、この返り値は 0 件の完了ではない）。

#### PR-DEVELOPIMPLEMENT-075 呼び直しが進まないとき
PR-DEVELOPIMPLEMENT-024 で呼び直した develop:review が、未着手の項目を 1 件も減らさずに再び上限で止まったならば、implement は呼び直さずに BLOCKED で止まり、減らなかった未着手と next_args と、develop:review の 1 回の run が止まった上限（起動数の上限なら PR-DEVELOPREVIEW-071 で develop:review に渡す runner の agent の総数の上限と起動数の上限、トークン量の上限なら PR-DEVELOPPLUGIN-043 で native Workflow の run の入力として渡すトークン量の上限）を BLOCKED の原因を直す手順として上げて渡してから同じ next_args で implement を再開するという次の手を返さなければならない（1 項目を終える前に同じ上限に当たるので、同じ値で呼び直しても未着手が減らないため。PR-DEVELOPIMPLEMENT-069 の表では BLOCKED の足された入力が「なし」の行にあたる）。この停止から再開した implement は、渡された上限の値を受け取り、記録していた develop:review の next_args と一緒にその上げた上限を PR-DEVELOPIMPLEMENT-023 のとおり develop:review に渡して呼び直さなければならない（develop:review の next_args は上限の値を持たないので、再開のときに受け取って渡さないと上げた値が develop:review の run に届かない）。

#### PR-DEVELOPIMPLEMENT-025 記録する review の返り値
implement は、develop:review が返した結果の状態に応じて、次の表のとおりに扱わなければならない。

> 条件の値: 結果の状態 = success / degraded / failed

| 条件: 結果の状態 | 結果 |
|---|---|
| success | 完了した返り値（completed）として記録する |
| degraded | レビューが未完了で返った返り値（review_incomplete）として記録し、検証を通った指摘を確定した指摘として扱う |
| failed | 記録せず、最終照合へ進まず、commit も push もせずに BLOCKED で止まり、failed の理由と next_args を返す |

#### PR-DEVELOPIMPLEMENT-077 review が結果の状態を返さずに止まったとき
develop:review が上限以外の停止（結果の状態を返さない停止）を返したとき、implement は、その停止が「読むもの」表を読めない停止（PR-DEVELOPREVIEW-015）ならば呼び直しを要する拒否の停止で、それ以外ならば BLOCKED で止まり、develop:review が返した理由を返さなければならない（「読むもの」表は方針の版から読むので、同じ版で呼び直しても同じ停止に戻るため）。次の手は、develop:review が返した次の手を写さずに implement の続け方として返し、呼び直しを要する拒否の停止では、方針文書を直して方針の版に入れてから PR-DEVELOPIMPLEMENT-078 のとおり開始点を引き継いで implement を新しく呼ぶこととし、BLOCKED では、原因を直した後に next_args で再開することとしなければならない（develop:review の次の手は develop:review を新しく呼ぶことで、implement の続け方ではない）。

#### PR-DEVELOPIMPLEMENT-045 review が failed のときの変更
develop:review の failed で止まるとき、implement は作業ツリーの変更を捨ててはならない（原因を直した後に next_args で再開できるようにする）。

#### PR-DEVELOPIMPLEMENT-026 review の返り値の照合
implement は、develop:review の返り値を develop:review の返り値の形に照らし、合わない返り値を受け付けてはならない。

#### PR-DEVELOPIMPLEMENT-056 返り値が形に合わないとき
develop:review の返り値が形に合わないならば、implement は develop:review を呼び直さずに BLOCKED で止まり、合わなかった理由と next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-027 直す対象にする指摘
implement は、記録した develop:review の返り値の指摘のうち、確定した指摘だけを修正の対象に入れなければならない（未検証の指摘は入れない。修正の対象の全体は PR-DEVELOPIMPLEMENT-074）。

#### PR-DEVELOPIMPLEMENT-028 未検証の指摘が残るとき
記録した develop:review の返り値に未検証の指摘が残るならば、implement は abandon を返して止まらなければならない。

#### PR-DEVELOPIMPLEMENT-046 abandon で止まるときの変更
abandon で止まるとき、implement は作業ツリーの変更と状態を捨ててはならない（人が入力を足した後に next_args で再開できるようにする）。

#### PR-DEVELOPIMPLEMENT-047 abandon で止まるときに返すもの
abandon で止まるとき、implement は、残った変更・最後の develop:review の確定した指摘と未検証の指摘・next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-062 abandon で止まるときに人が決めること
abandon で止まるとき、implement は、未検証の指摘ごとに人が決めること（確定とするか退けるか）を返さなければならない。

#### PR-DEVELOPIMPLEMENT-063 確定した指摘と未検証の指摘の数え方
implement は、develop:review の返り値ごとに、その返り値を記録してから次の develop:review の返り値を記録するまでに人が状態に足した PR-DEVELOPIMPLEMENT-062 の判断だけに応じて、その返り値の確定した指摘と未検証の指摘を次の表のとおりに数えなければならない（後の返り値が同じ主張をまた未検証の指摘として返したときは、前の判断を当てず、後の返り値の新しい未検証の指摘として数える）。

| 数えるもの | 数え方 |
|---|---|
| 確定した指摘 | その返り値で PR-DEVELOPREVIEW-032 が返した一覧に、その返り値で PR-DEVELOPREVIEW-069 が返した一覧のうち人が確定とした指摘を足したもの |
| 未検証の指摘 | その返り値で PR-DEVELOPREVIEW-069 が返した一覧から、人が確定とした指摘と退けた指摘を除いたもの |

#### PR-DEVELOPIMPLEMENT-064 同じ返り値で判断を足された指摘を理由に再び止まらない
implement は、develop:review の返り値ごとに、人が状態に足した判断で PR-DEVELOPIMPLEMENT-063 の表のとおりに未検証の指摘から除いた指摘を理由に、その返り値で再び abandon で止まってはならない。

#### PR-DEVELOPIMPLEMENT-048 abandon で止まるときの commit と push
abandon で止まるとき、implement は commit と push をしてはならない。

#### PR-DEVELOPIMPLEMENT-029 記録した review の返り値による進み方
implement は、記録した develop:review の返り値と、最後に流した変更の後の check の結果に応じて、completed と review_incomplete のどちらでも次の表のとおりに進まなければならない。

> 条件の値: 未検証の指摘 = あり / なし
> 条件の値: 直す対象 = あり / なし
> 条件の値: 修正の回 = 上限未満 / 上限に達した
> 条件の値: PR-DEVELOPIMPLEMENT-072 で作り直した計画 = 実装の run がまだ返っていない / それ以外

| 条件: 未検証の指摘 | 条件: 直す対象 | 条件: 修正の回 | 条件: PR-DEVELOPIMPLEMENT-072 で作り直した計画 | 結果 |
|---|---|---|---|---|
| あり | * | * | * | abandon を返して止まる（PR-DEVELOPIMPLEMENT-028） |
| なし | あり | 上限未満 | * | 直す対象（PR-DEVELOPIMPLEMENT-074）を修正の対象にして、修正の回へ進む |
| なし | あり | 上限に達した | * | 修正の回の上限の停止で止まる（PR-DEVELOPIMPLEMENT-021） |
| なし | なし | * | 実装の run がまだ返っていない | 作り直した計画の実装の run へ進む |
| なし | なし | * | それ以外 | 最終照合へ進む |

#### PR-DEVELOPIMPLEMENT-074 直す対象の数え方
implement は、PR-DEVELOPIMPLEMENT-029 の表の「直す対象」を、確定した指摘と、最後に流した変更の後の check の結果を PR-DEVELOPIMPLEMENT-019 のとおり開始時の結果と比べて見つけた変更が起こした失敗とを合わせて数えなければならない。

#### PR-DEVELOPIMPLEMENT-030 見られなかった範囲の報告
develop:review がレビューの未完了を返したとき、implement は、develop:review が見られなかった範囲と理由を implement の結果に書かなければならない。

### 最終照合と永続化

#### PR-DEVELOPIMPLEMENT-071 完了の前の未読のヒント
最終照合の前、PR-DEVELOPIMPLEMENT-044 で終わる前、commit か push を終えて完了する前のどれかで未読のヒントがあるならば、implement は完了せずに計画の run へ戻らなければならない（run の実行中に足したヒントを読まないまま完了するのを防ぐ）。

| 時点 | 模型の action |
|---|---|
| 最終照合の前・044 で終わる前・commit か push を終えて完了する前 | `I_FinalGate` |

#### PR-DEVELOPIMPLEMENT-057 最終照合で照らすもの
implement は、最終照合で、変更の後の check に変更が起こした失敗が無いことと、記録した develop:review の返り値に確定した指摘と未検証の指摘が残っていないことを照らさなければならない。

#### PR-DEVELOPIMPLEMENT-031 最終照合が通らないとき
最終照合が通らないか照らせないならば、implement は BLOCKED で止まり、通らなかった照合と理由・next_args を返さなければならない。

#### PR-DEVELOPIMPLEMENT-032 最終照合が通らないときの変更
最終照合が通らずに止まるとき、implement は作業ツリーの変更を捨ててはならない（原因を直した後に再開できるようにする）。

#### PR-DEVELOPIMPLEMENT-033 commit する条件
implement は、commit を頼まれたときにだけ commit しなければならない。commit の対象とする未コミットの変更から、呼び出しの前からの変更（開始時に固定した変更のあったパス・内容・index）を除外しなければならない。commit を頼まれていても、commit の段で commit する未コミットの変更が作業ツリーに無いとき（この呼び出しで commit した後に PR-DEVELOPIMPLEMENT-071 で計画の run へ戻るか PR-DEVELOPIMPLEMENT-078 で開始時の HEAD より後に作った未 push の commit を記録と一致して引き継ぎ、その後に追加の未コミットの変更が無いときと、実装の run の未コミットの変更を修正の回で全て戻したときを含む）は、implement は空の commit を作らずに完了し、この呼び出しで作った commit（PR-DEVELOPIMPLEMENT-078 で記録と一致して引き継いだ未 push の commit を含む。PR-DEVELOPIMPLEMENT-034・049 でも同じ）が 1 つも無いとき（未コミットの変更を全て戻し、引き継いだ未 push の commit も無いとき）は作った commit が無いことを結果に書かなければならない（返す SHA は PR-DEVELOPIMPLEMENT-049 のとおり、この呼び出しで作った commit と PR-DEVELOPIMPLEMENT-078 で記録と一致して引き継いだ未 push の commit のもので、1 つ以上あればその SHA を全て返し、1 つも無ければ返さない）。

#### PR-DEVELOPIMPLEMENT-034 commit の後の push
develop:address-review から PR の修正として commit を頼まれたとき（PR-DEVELOPIMPLEMENT-051）を除き、commit の後に push するかは、implement は利用側の宣言に従い、宣言があればこの呼び出しで作った commit（PR-DEVELOPIMPLEMENT-078 で記録と一致して引き継いだ未 push の commit を含む）に限定して push し、宣言が無ければ push してはならない。

#### PR-DEVELOPIMPLEMENT-049 address-review から PR の修正を受けたとき
develop:address-review から PR の修正として commit を頼まれたとき、implement は最終照合を通った修正を PR-DEVELOPIMPLEMENT-033 のとおり commit して、この呼び出しで作った commit（PR-DEVELOPIMPLEMENT-078 で記録と一致して引き継いだ未 push の commit を含む）の SHA を全て返さなければならない（PR-DEVELOPIMPLEMENT-071 で計画の run へ戻った前後に作った commit と PR-DEVELOPIMPLEMENT-078 で記録と一致して引き継いだ未 push の commit を含み、PR-DEVELOPIMPLEMENT-033 でそのどちらの commit も 1 つも無いときは SHA を返さない）。

#### PR-DEVELOPIMPLEMENT-051 address-review の PR の修正を push しない
develop:address-review から PR の修正として commit を頼まれたとき、implement はその commit を push してはならない（push は develop:address-review が行う）。

#### PR-DEVELOPIMPLEMENT-050 push が拒まれたとき
push が拒まれたならば、implement は止まり、拒まれた理由を返さなければならない。

#### PR-DEVELOPIMPLEMENT-035 implement の結果
implement は、最後の develop:review の結果と修正の回数を結果に書かなければならない。

### 停止と再開

#### PR-DEVELOPIMPLEMENT-068 停止の名前と記録する位置
implement は、止まるとき、次の表の停止の名前を止まった理由として返し、記録する位置の列の段（計画の run・開始時の check・実装の run・変更の後の check・develop:review の呼び出し・PR-DEVELOPIMPLEMENT-029 の判定・最終照合・commit・push のどれか。「止まった段」はその停止が起きた段。「なし」は新しく呼ぶしか続かない停止で、次の手は止まる条件を定める要求が定める）を再開する位置として状態に記録しなければならない。

| 停止 | 止まる条件を定める要求 | 記録する位置 | 模型の kind | 模型の action |
|---|---|---|---|---|
| 呼び直しを要する拒否 | PR-DEVELOPIMPLEMENT-005・053・054・077（「読むもの」表を読めないとき）、PR-DEVELOPPLUGIN-004・011・014 | なし | なし（模型の範囲の外） | 模型の範囲の外 |
| check の宣言が無い | PR-DEVELOPIMPLEMENT-010 | なし | `no_check` | `I_PlanOkNoCheck` |
| 計画で止めた | PR-DEVELOPIMPLEMENT-012 | 開始時の check | `plan_stop` | `I_PlanOkStop` |
| 作業ツリーが変わった | PR-DEVELOPIMPLEMENT-014（変わっていたとき） | なし | `wt_changed` | `I_ResumeWtChanged` |
| 作り直しの上限 | PR-DEVELOPIMPLEMENT-007 | 計画の run | `limit_plan` | `I_PlanRejectLimit` |
| 人の判断待ち | PR-DEVELOPIMPLEMENT-008 | 計画の run | `needs_input` | `I_PlanHuman` |
| abandon | PR-DEVELOPIMPLEMENT-028 | PR-DEVELOPIMPLEMENT-029 の判定 | `abandon` | `I_DecideAbandon` |
| 修正の回の上限 | PR-DEVELOPIMPLEMENT-021・060 | PR-DEVELOPIMPLEMENT-029 の判定 | `limit_fix` | `I_DecideLimit`・`I_OutOfPlanLimit` |
| トークン量の上限 | PR-DEVELOPPLUGIN-045 | 止まった段の、結果を記録していない項目 | `limit_run` | `I_Token` |
| BLOCKED | PR-DEVELOPIMPLEMENT-009・025・031・050・056・075・077（ほかの停止のとき）、PR-DEVELOPPLUGIN-033・040 | 止まった段の、結果を記録していない項目 | `blocked` | `I_Blocked`・`I_ReviewStuck` |

#### PR-DEVELOPIMPLEMENT-069 停止からの再開
止まった implement を next_args で続けるとき、implement は、停止・未読のヒント・足された入力・作業ツリーの照合に応じて、次の表のとおりに続けるか再開を拒否しなければならない。足された入力の値は、なし・回答（PR-DEVELOPIMPLEMENT-052 の人の回答）・判断（PR-DEVELOPIMPLEMENT-062 の人の判断）・引き上げ（implement の作り直しの上限か修正の回の上限の値を人が上げる入力。PR-DEVELOPIMPLEMENT-075 で develop:review の 1 回の run の上限を上げて渡すことは BLOCKED の原因を直す手順にあたり、この表の足された入力は「なし」になる）のどれかとする。作業ツリーの照合は、計画で止めた停止では計画の受け入れの時の作業ツリーと、修正の回の上限の停止では止まった時の作業ツリーと、CLI が今の作業ツリーを照らした結果とし、ほかの停止では照らさない（表の `*`）。

> 条件の値: 停止 = 呼び直しを要する拒否 / check の宣言が無い / 計画で止めた / 作業ツリーが変わった / 作り直しの上限 / 人の判断待ち / abandon / 修正の回の上限 / トークン量の上限 / BLOCKED
> 条件の値: 未読のヒント = あり / なし
> 条件の値: 足された入力 = なし / 回答 / 判断 / 引き上げ
> 条件の値: 作業ツリー = 変わっていない / 変わった / 確かめられない

| 条件: 停止 | 条件: 未読のヒント | 条件: 足された入力 | 条件: 作業ツリー | 結果 | 模型の kind | 模型の action |
|---|---|---|---|---|---|---|
| 計画で止めた | * | なし | 変わった | 再開を拒否し、作業ツリーが変わった停止で止まる | `plan_stop` | `I_TouchWt`・`I_ResumeWtChanged` |
| 計画で止めた | * | なし | 確かめられない | 再開を拒否し、計画で止めた停止のまま、確かめられなかった理由を返す | `plan_stop` | 模型の範囲の外 |
| 計画で止めた | あり | なし | 変わっていない | 計画の run から作り直す | `plan_stop` | `I_Resume` |
| 計画で止めた | なし | なし | 変わっていない | 記録した位置から続ける | `plan_stop` | `I_Resume` |
| 作り直しの上限 | * | 引き上げ | * | 引き上げた上限で、計画の run から作り直す | `limit_plan` | `I_RaisePlan` |
| 人の判断待ち | * | 回答 | * | 計画の run から作り直す | `needs_input` | `I_Answer` |
| 人の判断待ち | あり | なし | * | 計画の run から作り直す | `needs_input` | `I_Resume` |
| abandon | あり | なし | * | 計画の run から作り直す | `abandon` | `I_Resume` |
| abandon | あり | 判断 | * | 計画の run から作り直し、人が確定とした指摘を直す対象として計画役に渡す | `abandon` | `I_Decide` |
| abandon | なし | 判断 | * | 記録した返り値を PR-DEVELOPIMPLEMENT-063 の数え方で数え直し、記録した位置から続ける（計画の run から作り直すと、人が確定とした指摘を直す場面が無くなるため） | `abandon` | `I_Decide` |
| 修正の回の上限 | あり | 引き上げ | * | 引き上げた上限で、計画の run から作り直す（受け入れの後は PR-DEVELOPIMPLEMENT-072） | `limit_fix` | `I_RaiseFix` |
| 修正の回の上限 | なし | 引き上げ | 変わっていない | 引き上げた上限で、記録した返り値と人の判断のまま記録した位置から続ける | `limit_fix` | `I_RaiseFix` |
| 修正の回の上限 | なし | 引き上げ | 変わった | 引き上げた上限で、変更の後の check から続け、その後に develop:review を流す | `limit_fix` | `I_EditWt`・`I_RaiseFix` |
| 修正の回の上限 | なし | 引き上げ | 確かめられない | 再開を拒否し、確かめられなかった理由を返す（続ける位置が PR-DEVELOPIMPLEMENT-029 の判定か変更の後の check かが決まらないため） | `limit_fix` | 模型の範囲の外 |
| 修正の回の上限 | あり | なし | 変わった | 計画の run から作り直す（受け入れの後は PR-DEVELOPIMPLEMENT-072） | `limit_fix` | `I_EditWt`・`I_Resume` |
| 修正の回の上限 | なし | なし | 変わった | 変更の後の check から続け、その後に develop:review を流す | `limit_fix` | `I_EditWt`・`I_Resume` |
| トークン量の上限 | あり | なし | * | 計画の run から作り直す | `limit_run` | `I_Resume` |
| トークン量の上限 | なし | なし | * | 記録した位置から続ける | `limit_run` | `I_Resume` |
| BLOCKED | あり | なし | * | 計画の run から作り直す | `blocked` | `I_Resume` |
| BLOCKED | なし | なし | * | 原因を直した後に（PR-DEVELOPIMPLEMENT-075 では develop:review の 1 回の run の上限を上げて渡して）、記録した位置から続ける | `blocked` | `I_Resume`（原因を直す入力は模型の範囲の外） |
| 上記以外 | * | * | * | 再開を拒否し、止まったまま、その停止をこの表のどの行で出られるか（記録する位置が「なし」の停止では、PR-DEVELOPIMPLEMENT-068 の表でその停止の止まる条件を定める要求が定める次の手）を次の手として返す。足されたヒントは、再開した run が読む | `no_check`・`wt_changed`・`limit_plan`・`needs_input`・`abandon`・`limit_fix` | `I_RefuseResume`（模型は入力の無い再開だけを表す。回答・判断・引き上げを合わない停止に足した組み合わせは模型の範囲の外） |

#### PR-DEVELOPIMPLEMENT-076 止まっている間のほかの入力
implement は、止まっている間に足された、再開ではない入力を、次の表のとおりに扱わなければならない。

| 入力 | 扱い | 模型の action |
|---|---|---|
| ヒントの追記 | PR-DEVELOPIMPLEMENT-039・042 のとおりに扱う | `I_HintStopped`・`I_HintRefused` |
| 新しい呼び出し | 止まった状態を引き継がずに、入口から新しい依頼として始める（実装の run が作業ツリーを変えた後の停止からは、PR-DEVELOPIMPLEMENT-078 のとおり止まった呼び出しの開始点を引き継ぐ） | `I_Reinvoke` |
| 打ち切り | 再開せずに終わる | `H_Abort` |

#### PR-DEVELOPIMPLEMENT-078 実装の後の停止から新しく呼ぶとき
implement は、呼び出しの開始点（開始時の HEAD・開始時に変更のあったパスとその内容・index・PR-DEVELOPIMPLEMENT-016 の開始時の check の結果）を状態に記録し、実装の run が作業ツリーを変えた後に止まるときは、どの停止でも（次の手が新しく呼ぶことである停止に限らず、PR-DEVELOPIMPLEMENT-076 で新しく呼ぶときにも使えるように）、その呼び出しが作成した未 push commit の SHA 一覧を状態に記録し、新しく呼ぶときにその開始点を引き継ぐ指定を返さなければならない。その指定を渡されて新しく呼ばれた implement は、作業ツリーと HEAD を戻さず変更も退避せずに、止まった呼び出しの開始点（開始時の HEAD・開始時に変更のあったパスとその内容・index・開始時の check の結果）と開始点より後に作業ツリーを変えたことと止まった呼び出しが作成した未 push の commit を自分の状態に引き継ぎ、引き継いだ開始時に変更のあったパスとその内容・index を呼び出しの前からの変更として今回の commit から除外し、引き継ぐ未 push commit は記録された SHA 一覧と実際の未 push commit 一覧が一致するときに限定して不一致があれば引き継ぎを拒否して止まり、一致した未 push の commit をこの呼び出しで作った commit に含めて扱い（PR-DEVELOPIMPLEMENT-033・034・049）、開始時の check（PR-DEVELOPIMPLEMENT-016）を流し直さずに、変更の後の check（PR-DEVELOPIMPLEMENT-019）を引き継いだ開始時の check の結果と比べなければならない（作業ツリーや HEAD を戻すと、呼び出しの前からあった変更や作った commit を失うか PR-DEVELOPPLUGIN-074 が禁じる履歴を書き換える push になり、開始点を引き継がずに開始時の check を流し直すと、止まった呼び出しの変更が起こした失敗を開始時から落ちていた失敗と数える）。

### 完了の条件

#### PR-DEVELOPIMPLEMENT-070 完了の条件
implement は、次の条件を全て満たすときにだけ完了しなければならない。

- 利用側の宣言が check を宣言している（PR-DEVELOPIMPLEMENT-010）（模型: `ImplCheckDecl`）。
- 直す変更が無いとして完了するときは、PR-DEVELOPIMPLEMENT-044 の条件を満たしている（模型: `ImplNoChange`）。
- それ以外で完了するときは、変更の後の check の後に記録した develop:review の返り値で PR-DEVELOPIMPLEMENT-057 の最終照合を通り、commit を PR-DEVELOPIMPLEMENT-033 のとおりに、push を PR-DEVELOPIMPLEMENT-034・051 のとおりに行っている（模型: `ImplVerified`。PR-DEVELOPIMPLEMENT-033 のうち実装の run の変更を修正の回で全て戻して commit しない場合と、PR-DEVELOPIMPLEMENT-051 は模型の範囲の外で、模型では一度変更した後は commit の依頼があれば常に commit する）。
- 完了する時に未読のヒントが無い（PR-DEVELOPIMPLEMENT-071）（模型: `ImplNoUnread`）。
- 最後に受け入れた計画の後に、実装の run が返っている（模型: `ImplPlanImplemented`）。
- PR-DEVELOPIMPLEMENT-072 で作り直した計画は、受け入れの後、実装の run の前に、変更の後の check と develop:review を流している（模型: `ImplRebuiltChecked`）。
- 確定した指摘は全て、その後の実装の run に修正の対象として渡ったか、修正の回の上限で止まった後に人が作業ツリーを直してから流した変更の後の check と develop:review を通っている（模型: `ImplConfirmedFed`）。
- 実装の run が作業ツリーを変更した後に、開始時の check を流していない（模型: `ImplNoBaselineAfterChange`）。
- 計画で止めた後に計画を受け入れ直したのは、未読のヒントで計画の run から作り直したときか、PR-DEVELOPIMPLEMENT-043 で作り直したときだけである（模型: `ImplPlanReaccept`。模型の条件は、一度の免除を以後の受け入れにも当てる点でこの条件より弱い）。

| 完了の種類 | 模型の action | 模型の性質 |
|---|---|---|
| 直す変更が無い | `I_NoChangeEnd` | `ImplGoal` |
| 最終照合を通った | `I_FinalDone`・`I_CommitDone`・`I_PushOk` | `ImplGoal` |
