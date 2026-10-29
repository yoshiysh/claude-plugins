# 要求文書: develop:address-review

表記規約と用語は、develop plugin 全体の要求文書（PR-DEVELOPPLUGIN）に従う。本文書の要求の主語「address-review」は develop:address-review を指す。

## 背景と課題

claude-plugins の address-review は、PR の指摘を分類役と検証役で分類し、返信の直前に再照合して投稿を確かめるが、対象リポジトリを定数で持ち、返信を日本語に固定し、thread の resolve の経路を持たない。返信の後に CI が落ちると、「直した」という返信が誤ったまま残る。PR の無い対象への外のレビュー結果を分類して直す経路も無い。

## 想定する利用者と利用場面

| 利用者 | 利用場面 |
|---|---|
| 利用者 | PR に付いた指摘への対応を頼む。PR の無い差分やファイルに対する外のレビュー結果を渡して、分類と修正を頼む |
| 指摘した人 | PR の thread で返信を受け取り、退けた理由に納得するかを決める |

## どう使われるか

1. address-review は指摘を集め、目標を固定する。
2. 分類の run で指摘を分類し、分類を検証する。人の判断が要る指摘があれば、run の境界で止まる。
3. 直す変更のある指摘を develop:implement に渡し、修正を push する。
4. push した SHA の required checks が全て成功するのを待ってから返信し、返信を確かめる。
5. 条件を全て満たす thread だけを resolve し、resolve を確かめる。PR の無い外のレビュー結果は、分類から修正までで終わる。

## スコープとスコープ外

スコープ: 指摘の収集と分類・分類の検証、外のレビュー結果、develop:implement への修正の受け渡し、push、required checks の待ち、返信、条件つきの resolve。

スコープ外: 修正そのもの（develop:implement が持つ）と、PR のレビュー（develop:review が持つ）。

## 前提と依存

- 方針の版の導き方と、利用側の宣言の扱いは PR-DEVELOPPLUGIN-011〜015・080 に従う。
- 修正は develop:implement に依存する。
- 停止と再開の表と完了の条件の「模型の action」の列は、`tests/formal/develop/DevelopSkill.tla` の action の名前を、「模型の性質」の列は `tests/formal/develop/DevelopProps.tla` の性質の名前を指す。

## リスクと影響

| ID | 観点 | 判定 | 根拠 |
|---|---|---|---|
| RK-007 | 外部システム・第三者への提供・連携 | 該当 | address-review は gh で PR の指摘と required checks を読み、返信を投稿し、GraphQL の mutation で thread を resolve する |
| RK-008 | 不可逆な操作 | 該当 | address-review は PR の head に push し、返信を投稿し、thread を resolve する |

## 要求一覧

### 入口と目標

#### PR-DEVELOPADDRESSREVIEW-001 入口で受ける指摘
address-review は、PR のコメントの指摘と、利用者が渡す外のレビュー結果のどちらも、指摘の収集の入口で受けなければならない。

#### PR-DEVELOPADDRESSREVIEW-002 PR があるときの目標
対象が PR であるとき、address-review は、PR と、集めた指摘の集合を目標として状態に固定しなければならない。

#### PR-DEVELOPADDRESSREVIEW-003 PR が無いときの目標
PR が無いとき、address-review は、差分（base と head の完全な SHA）かファイルの集合（path と head の SHA）と、渡された指摘の集合を目標として状態に固定しなければならない。

#### PR-DEVELOPADDRESSREVIEW-004 PR が無いときの作業ツリー
PR が無い address-review の初回の起動で、渡された head の SHA が今の HEAD と同じでないか作業ツリーが clean でないならば、address-review は入口で拒否しなければならない（develop:implement が書き込む前の出発点を固定するため。develop:implement の段からの再開は PR-DEVELOPADDRESSREVIEW-055）。

#### PR-DEVELOPADDRESSREVIEW-005 名指された branch の方針の版
PR が無く、利用者が base の branch を名指したとき、address-review は、その branch の remote の先端を方針の版にしなければならない。

#### PR-DEVELOPADDRESSREVIEW-006 remote に無い branch
名指された branch が remote に無いならば、address-review は止まり、branch が remote に無いことを返さなければならない。

#### PR-DEVELOPADDRESSREVIEW-007 外のレビュー結果の形
address-review は、外のレビュー結果を、指摘の JSON の一覧（各要素は本文を持ち、path と行は省いてよい）か、全体を 1 件の指摘として扱うテキストとして受けなければならない。

#### PR-DEVELOPADDRESSREVIEW-008 外の指摘の ID
address-review は、外のレビュー結果の指摘に、指摘の順序と本文だけから決まる ID を付けなければならない（同じ入力を渡した再実行で同じ ID になる）。

#### PR-DEVELOPADDRESSREVIEW-009 外の指摘の本文
司令塔は、外のレビュー結果の指摘の本文を分けたり書き換えたりしてはならない（分けると、分け方が検証を通らない生成になる）。

#### PR-DEVELOPADDRESSREVIEW-010 push できるかの確認
対象が PR であるとき、address-review は、指摘の収集の時点で PR の head に push できるかを確かめなければならない（他人の PR や fork の PR では push できないことがある）。

#### PR-DEVELOPADDRESSREVIEW-011 push できないとき
PR の head に push できず、直す変更のある fix（develop:implement に渡し、push が要る fix）があるならば、address-review は develop:implement に渡す前に止まり、push できるように権限を直して同じ next_args で再開することと、止める所を検証にして新しく呼ぶことを、人が決める次の手として返さなければならない。

#### PR-DEVELOPADDRESSREVIEW-047 push できず直す変更が無いとき
PR の head に push できず、止める所が指定なし・返信・resolve のどれかであり、直す変更のある fix が無いとき（直した commit を記録した fix・decline・out_of_scope だけのとき）、address-review は、PR-DEVELOPADDRESSREVIEW-011 で止まらず、push しない流れで PR-DEVELOPADDRESSREVIEW-027 の required checks の待ちへ進まなければならない（返信へ進むか返信せずに止まるかは PR-DEVELOPADDRESSREVIEW-029 の表、返信と resolve は PR-DEVELOPADDRESSREVIEW-021 の表のその止める所の行による）。

#### PR-DEVELOPADDRESSREVIEW-012 指摘より後の commit の一覧
対象が PR であるとき、address-review は、指摘の収集で、指摘ごとに、その指摘が付いた時より後の PR の commit（指摘より後の commit）を一覧にして分類役に渡さなければならない。

### 分類

#### PR-DEVELOPADDRESSREVIEW-013 分類の run
address-review は、分類役と分類の検証役を、読み取り専用の run で、分類役・検証役の順に動かさなければならない。

#### PR-DEVELOPADDRESSREVIEW-014 分類が食い違ったとき
分類役と分類の検証役の分類が食い違ったならば、address-review は、食い違わなかった指摘の分類を受け入れ、食い違った指摘を人の判断が要る指摘として、PR-DEVELOPADDRESSREVIEW-019 と同じく run の境界で止まらなければならない。

#### PR-DEVELOPADDRESSREVIEW-015 分類の run の書き込み
分類の run の中で書き込みを検出したならば、address-review は BLOCKED で止まらなければならない。

#### PR-DEVELOPADDRESSREVIEW-016 既に直った指摘の分類
今の PR の head で直っている指摘のうち、直したのが指摘より後の commit であるものを、address-review は退けずに fix と分類し、直した commit をその指摘の一覧から選んで記録しなければならない（退けると、直した問題を「問題ではない」と返信し、resolve の候補からも外れる）。

#### PR-DEVELOPADDRESSREVIEW-017 直した commit の照合
address-review は、記録した直した commit がその指摘の、指摘より後の commit の一覧にあり、その commit がその指摘の修正の対象のパスのどれかを変えていることを照らさなければならない。修正の対象のパスは、分類が fix の指摘ごとに分類で挙げる、直すのに変えるパスであり、指摘が付いた位置のパスではない。

#### PR-DEVELOPADDRESSREVIEW-053 直した commit の照合に合わないとき
PR-DEVELOPADDRESSREVIEW-017 の照合に合わないか照らせないならば、address-review は、合わなかった指摘のほかの分類を受け入れ、合わなかった指摘を人の判断が要る指摘として、PR-DEVELOPADDRESSREVIEW-019 と同じく run の境界で止まらなければならない。

#### PR-DEVELOPADDRESSREVIEW-018 既に直った指摘を修正に渡さない
address-review は、直した commit を記録した fix を develop:implement に渡してはならない（直す変更が無い）。

#### PR-DEVELOPADDRESSREVIEW-019 人の判断が要る指摘
分類が needs_decision か unverified の指摘を 1 件以上含むとき、address-review は run の境界で止まり、人の判断を次の run の入力として受け取らなければならない。

#### PR-DEVELOPADDRESSREVIEW-020 同じ状態での 2 回目の分類
address-review は、同じ状態に分類の run の結果を受け入れ直すことと、返信を組み立て直すことを拒否しなければならない。

#### PR-DEVELOPADDRESSREVIEW-048 人の判断を入れること
address-review は、人の判断が要る停止で止まった後に人の判断を入れることを、PR-DEVELOPADDRESSREVIEW-020 の拒否の対象にしてはならない（人の判断は分類の結果の受け入れとは別の記録である）。

#### PR-DEVELOPADDRESSREVIEW-061 人の判断の値
address-review は、人の判断として、指摘ごとに fix・decline・out_of_scope のどれかだけを受け付けなければならない。

#### PR-DEVELOPADDRESSREVIEW-064 fix の判断の修正の対象のパス
address-review は、fix の人の判断を、修正の対象のパス（PR-DEVELOPADDRESSREVIEW-017）を伴うときだけ受け付けなければならない。

#### PR-DEVELOPADDRESSREVIEW-062 人の判断を入れた指摘の扱い
address-review は、人の判断を入れた指摘を、分類の値を見る全ての要求（develop:implement への受け渡し、「直す変更」の有無、PR-DEVELOPADDRESSREVIEW-021・041・042 の表を含む）で、その判断の値を分類の値として扱わなければならない。

### 止める所

#### PR-DEVELOPADDRESSREVIEW-021 止める所の指定
address-review は、PR の有無・止める所の指定・直す変更の有無に応じて、次の表のとおりに進まなければならない。

> 条件の値: PR = あり / なし
> 条件の値: 止める所 = 指定なし / 分類 / 検証 / push / 返信 / resolve
> 条件の値: 直す変更 = ある / 無い

| 条件: PR | 条件: 止める所 | 条件: 直す変更 | 結果 | 結果: 行わない操作 |
|---|---|---|---|---|
| あり | 指定なし | * | resolve とその確認の後で完了する | なし |
| あり | 分類 | * | 分類と分類の検証の後で完了する | develop:implement の呼び出し・commit・push・required checks の待ち・返信・resolve |
| あり | 検証 | ある | develop:implement に commit を頼まずに修正を渡し、最終照合の後で完了する（変更は作業ツリーに残る） | commit・push・required checks の待ち・返信・resolve |
| あり | 検証 | 無い | 分類と分類の検証の後で完了する | commit・push・required checks の待ち・返信・resolve |
| あり | push | ある | develop:implement の修正の commit を PR の head に push した後で完了する | required checks の待ち・返信・resolve |
| あり | push | 無い | 分類と分類の検証の後で完了する | commit・push・required checks の待ち・返信・resolve |
| あり | 返信 | * | 返信とその確認の後で完了する | resolve |
| あり | resolve | * | resolve とその確認の後で完了する | なし |
| なし | 指定なし | ある | develop:implement に commit を頼まずに修正を渡し、修正の後で完了する | commit・push・required checks の待ち・返信・resolve |
| なし | 指定なし | 無い | 分類と分類の検証の後で完了する | commit・push・required checks の待ち・返信・resolve |
| なし | 分類 | * | 分類と分類の検証の後で完了する | develop:implement の呼び出し・commit・push・required checks の待ち・返信・resolve |
| なし | 検証 | ある | develop:implement に commit を頼まずに修正を渡し、最終照合の後で完了する | commit・push・required checks の待ち・返信・resolve |
| なし | 検証 | 無い | 分類と分類の検証の後で完了する | commit・push・required checks の待ち・返信・resolve |
| なし | push | * | 指定を拒否する | commit・push・required checks の待ち・返信・resolve |
| なし | 返信 | * | 指定を拒否する | commit・push・required checks の待ち・返信・resolve |
| なし | resolve | * | 指定を拒否する | commit・push・required checks の待ち・返信・resolve |

#### PR-DEVELOPADDRESSREVIEW-056 止める所が行わないとした操作
address-review は、止める所の指定のもとで、PR-DEVELOPADDRESSREVIEW-021 の表がその行の「行わない操作」に挙げた操作を行ってはならない。

### 修正と push

#### PR-DEVELOPADDRESSREVIEW-022 develop:implement への受け渡し
address-review は、直す変更のある fix を、PR の番号（PR があるとき）・名指された base の branch（PR が無く、指摘の収集で利用者が名指したとき）・指摘の収集で固定した方針の版の SHA と一緒に develop:implement に渡さなければならない（それぞれが始めた時点で主ブランチの先端を固定すると、間に主ブランチが進んだときに別の版で読む）。

#### PR-DEVELOPADDRESSREVIEW-023 直す変更が無いとき
分類の結果に直す変更が 1 件も無いとき、address-review は develop:implement を呼ばず、push もしてはならない。

#### PR-DEVELOPADDRESSREVIEW-024 develop:implement が止まったとき
develop:implement が止まったならば、address-review は完了ではない停止として止まり、どの指摘についても（decline・out_of_scope・直した commit を記録した fix を含む）push・返信・resolve をせずに、develop:implement が止まった理由と、develop:implement の段から続けるための next_args を返さなければならない（止まった run で他の指摘に返信すると、再開の後に直した指摘の返信を組めない）。

#### PR-DEVELOPADDRESSREVIEW-066 develop:implement が止まったときに返す人が決めること
PR-DEVELOPADDRESSREVIEW-024 で止まるとき、address-review は、develop:implement が返した人が決めること（PR-DEVELOPIMPLEMENT-062・PR-DEVELOPPLUGIN-038）と、それを develop:implement の状態に足すことを、次の手として返さなければならない。

#### PR-DEVELOPADDRESSREVIEW-055 develop:implement の段からの再開
PR-DEVELOPADDRESSREVIEW-024 の next_args で再開した run は、入口の作業ツリーの検査と、分類の受け入れ・返信の組み立てを繰り返さず、状態にある分類の結果をそのまま使わなければならない（その後は止まらなかったときと同じく push・待ち・返信・resolve へ進む）。

#### PR-DEVELOPADDRESSREVIEW-049 commit の依頼
対象が PR で止める所が検証でないとき、address-review は、develop:implement に修正を渡すときに commit も頼まなければならない。

#### PR-DEVELOPADDRESSREVIEW-025 push
対象が PR であるとき、address-review は、develop:implement が commit した修正を、利用側の宣言の commit の後の設定に関わらず push しなければならない（返信は push 済みの SHA を指す）。

#### PR-DEVELOPADDRESSREVIEW-054 develop:implement が直す変更は無いと返したとき
対象が PR で止める所が指定なし・返信・resolve のどれかであり、develop:implement が直す変更は無いと返して commit しなかったとき、address-review はその fix の指摘について push せず、PR-DEVELOPADDRESSREVIEW-027・029 の待ちの後に、直す変更が無かったことを返信しなければならない（その thread は PR-DEVELOPADDRESSREVIEW-041 の候補にならない）。

#### PR-DEVELOPADDRESSREVIEW-057 push で止めるときに直す変更が無いと返されたとき
対象が PR で止める所が push であり、develop:implement が直す変更は無いと返して commit しなかったとき、address-review は required checks を待たずに止まらなければならない（返信と resolve は PR-DEVELOPADDRESSREVIEW-056 により行わない）。

#### PR-DEVELOPADDRESSREVIEW-052 push が拒まれたとき
push が拒まれたならば、address-review は返信も resolve もせずに止まり、拒まれた理由を返さなければならない。

#### PR-DEVELOPADDRESSREVIEW-026 PR が無いときに行わないこと
PR が無いとき、address-review は、返信・push・required checks の待ち・resolve を行ってはならない。

### required checks の待ち

#### PR-DEVELOPADDRESSREVIEW-027 待つ SHA
address-review は、push したときは push した SHA の、push しなかったとき（分類の結果に直す変更が無く develop:implement を呼ばなかったとき（PR-DEVELOPADDRESSREVIEW-023）と、develop:implement が直す変更は無いと返したとき（PR-DEVELOPADDRESSREVIEW-054））は今の PR の head の required checks を、返信の前に待たなければならない。

#### PR-DEVELOPADDRESSREVIEW-028 push した SHA と PR の head
required checks を読む前に、address-review は push した SHA が PR の head であることを確かめ、違えば止まらなければならない。

#### PR-DEVELOPADDRESSREVIEW-029 required checks の状態による進み方
address-review は、required checks の状態に応じて、次の表のとおりに進まなければならない（結果が出る前に返信すると、CI が落ちたときに誤った返信が残る）。

> 条件の値: required checks = 全て成功 / 失敗が 1 件以上 / 失敗が無く実行中が残る / 1 件も無い / 読めない
> 条件の値: 待った回数 = 上限未満 / 上限に達した / 数えられない
> 条件の値: develop:implement = 呼んで push した / 呼んで直す変更は無いと返された / 呼んでいない

| 条件: required checks | 条件: 待った回数 | 条件: develop:implement | 結果 |
|---|---|---|---|
| 全て成功 | 上限未満 | * | 返信へ進む |
| 全て成功 | 上限に達した | * | 返信へ進む |
| 失敗が 1 件以上 | 上限未満 | * | 待たずに、返信せずに止まり、失敗した check の名前を返す |
| 失敗が 1 件以上 | 上限に達した | * | 待たずに、返信せずに止まり、失敗した check の名前を返す |
| 失敗が無く実行中が残る | 上限未満 | * | 待ってから読み直す |
| 失敗が無く実行中が残る | 上限に達した | * | 返信せずに止まり、next_args を返す |
| 1 件も無い | 上限未満 | 呼んで push した | 待たずに返信へ進み、required checks が無かったことと、代わりの根拠が develop:implement の最終照合であることを報告に書く |
| 1 件も無い | 上限に達した | 呼んで push した | 待たずに返信へ進み、required checks が無かったことと、代わりの根拠が develop:implement の最終照合であることを報告に書く |
| 1 件も無い | 上限未満 | 呼んで直す変更は無いと返された | 待たずに返信へ進み、required checks が無かったことを報告に書く |
| 1 件も無い | 上限に達した | 呼んで直す変更は無いと返された | 待たずに返信へ進み、required checks が無かったことを報告に書く |
| 1 件も無い | 上限未満 | 呼んでいない | 待たずに返信へ進み、required checks が無かったことと、代わりの根拠が分類の検証（分類の検証役と CLI の照合。直した commit を記録した fix では PR-DEVELOPADDRESSREVIEW-017 の照合を含む）であることを報告に書く |
| 1 件も無い | 上限に達した | 呼んでいない | 待たずに返信へ進み、required checks が無かったことと、代わりの根拠が分類の検証（分類の検証役と CLI の照合。直した commit を記録した fix では PR-DEVELOPADDRESSREVIEW-017 の照合を含む）であることを報告に書く |
| 読めない | * | * | BLOCKED で止まる（PR-DEVELOPPLUGIN-033） |
| 上記以外 | * | * | BLOCKED で止まる（待った回数が数えられないとき。PR-DEVELOPPLUGIN-033） |

#### PR-DEVELOPADDRESSREVIEW-030 CI の失敗を直さない
required checks が失敗したとき、address-review はその失敗を直してはならない（CI の失敗は指摘ではない）。

#### PR-DEVELOPADDRESSREVIEW-031 待ちの上限からの再開
待つ回数の上限で止まった address-review を next_args で続けるとき、address-review は、分類の受け入れと返信の組み立てを繰り返してはならない（待った回数の数え方は PR-DEVELOPPLUGIN-041）。

#### PR-DEVELOPADDRESSREVIEW-032 再開の前に head が動いていたとき
待ちの上限からの再開の前に、PR の head が待っていた SHA（push したときは push した SHA、push しなかったときは待ち始めた時の PR の head）から動いていたならば、address-review は止まらなければならない（続け方は PR-DEVELOPADDRESSREVIEW-059）。

#### PR-DEVELOPADDRESSREVIEW-033 待ちの再開の回数
address-review は、待ちの上限からの再開の回数を制限してはならない。

#### PR-DEVELOPADDRESSREVIEW-034 待ちの再開の回数の記録
address-review は、待ちの上限からの再開の回数を状態に残さなければならない。

### 返信

#### PR-DEVELOPADDRESSREVIEW-035 返信の直前の再照合
address-review は、返信の直前に、PR の head と指摘の thread を指摘の収集の時と照らし直さなければならない。

#### PR-DEVELOPADDRESSREVIEW-036 head が他の人の push で動いたとき
返信の直前の照らし直しで PR の head が他の人の push で動いていたならば、address-review はその run のどの指摘にも返信せずに止まらなければならない（続け方は PR-DEVELOPADDRESSREVIEW-059）。

#### PR-DEVELOPADDRESSREVIEW-050 thread の議論が変わっていたとき
返信の直前の照らし直しで、どれか 1 つの指摘の thread の議論が収集の時から変わっていたならば（指摘の本文の書き換え・新しいコメント・既に resolve されたことを含む）、address-review はその run のどの指摘にも返信せずに止まらなければならない（head が動いたときと同じ扱い）。

#### PR-DEVELOPADDRESSREVIEW-051 返信を止めた指摘の報告
PR-DEVELOPADDRESSREVIEW-050 で返信を止めたとき、address-review は議論が変わった指摘を、返信を止めた指摘として報告に書かなければならない。

#### PR-DEVELOPADDRESSREVIEW-037 返信の宛先
address-review は、返信を、指摘したコメントへの返信として、指摘した人の login を GitHub の API から取って書かなければならない。

#### PR-DEVELOPADDRESSREVIEW-038 既に直った指摘への返信
直した commit を記録した fix に返信するとき、address-review はその commit の SHA を返信に引かなければならない。

#### PR-DEVELOPADDRESSREVIEW-039 返信の確認
返信を投稿したとき、address-review は返信が投稿されたことを確かめなければならない。

#### PR-DEVELOPADDRESSREVIEW-040 返信の確認が食い違うとき
返信の確認が食い違うか確かめられないならば、address-review は止まり、食い違いを返さなければならない。

### resolve

#### PR-DEVELOPADDRESSREVIEW-041 resolve の候補の条件
address-review は、次の条件を全て満たす thread だけを resolve の候補にしなければならない。

- 分類が fix で、修正の commit（直した commit を記録した fix ではその commit）がその指摘の修正の対象のパス（PR-DEVELOPADDRESSREVIEW-017）のどれかを変えている
- 修正の commit が今の PR の head の祖先（同じ commit を含む）である
- その head の required checks が待ちで全て成功している（required checks が 1 件も無いときは、この条件を満たしたものとして扱い、PR-DEVELOPADDRESSREVIEW-029 の報告を書く。他の条件は全て満たさなければならない）
- その thread への返信が確かめられている
- thread の議論が返信の直前の照らし直しの時から変わっておらず、まだ resolve されていない

#### PR-DEVELOPADDRESSREVIEW-042 分類による resolve の扱い
address-review は、指摘の出所・分類・resolve の候補の条件に応じて、次の表のとおりに resolve しなければならない（decline・out_of_scope を閉じると、退ける理由に納得するかを決める指摘した人の議論を一方的に終わらせる）。

> 条件の値: 出所 = review の thread / issue_comment・review の本文 / 外のレビュー結果
> 条件の値: 分類 = fix / decline / out_of_scope / needs_decision / unverified
> 条件の値: 候補の条件 = 全て満たす / 満たさないか判定できない

| 条件: 出所 | 条件: 分類 | 条件: 候補の条件 | 結果 |
|---|---|---|---|
| issue_comment・review の本文 | * | * | thread が無いので resolve の対象にしない |
| 外のレビュー結果 | * | * | thread が無いので resolve の対象にしない |
| review の thread | fix | 全て満たす | resolve する |
| review の thread | fix | 満たさないか判定できない | resolve しない |
| review の thread | decline | * | resolve しない（返信は PR-DEVELOPADDRESSREVIEW-029 に従う） |
| review の thread | out_of_scope | * | resolve しない（返信は PR-DEVELOPADDRESSREVIEW-029 に従う） |
| review の thread | needs_decision | * | 返信も resolve もしない |
| review の thread | unverified | * | 返信も resolve もしない |

#### PR-DEVELOPADDRESSREVIEW-043 resolve の確認
thread を resolve したとき、address-review は、その thread が resolve されたことを確かめなければならない。

#### PR-DEVELOPADDRESSREVIEW-044 resolve の確認が食い違うとき
resolve の確認が食い違うか確かめられないならば、address-review は止まり、食い違いを返さなければならない。

#### PR-DEVELOPADDRESSREVIEW-045 resolve の候補の全数の検査
address-review の検査は、分類と resolve の候補の各条件の成否の全ての組み合わせを列挙し、全ての条件を満たす組だけが候補になることを確かめなければならない（標本のテストでは、外れた組み合わせに条件の重なりが残る）。

#### PR-DEVELOPADDRESSREVIEW-046 address-review の結果
address-review は、分類・修正・返信・resolve の各結果を結果に書かなければならない。

### 停止と再開

#### PR-DEVELOPADDRESSREVIEW-058 停止の名前と記録する位置
address-review は、止まるとき、次の表の停止の名前を止まった理由として返し、記録する位置の列の段（分類の run・止める所への振り分け・develop:implement の呼び出し・push・required checks の待ち・返信・返信の確認・resolve・resolve の確認のどれか。「止まった段」はその停止が起きた段。「なし」は新しく呼ぶしか続かない停止で、次の手は止まる条件を定める要求が定める）を再開する位置として状態に記録しなければならない。

| 停止 | 止まる条件を定める要求 | 記録する位置 | 模型の kind | 模型の action |
|---|---|---|---|---|
| 呼び直しを要する拒否 | PR-DEVELOPADDRESSREVIEW-006、PR-DEVELOPPLUGIN-004・011・014 | なし | なし（模型の範囲の外） | 模型の範囲の外 |
| 止める所の指定を拒否した | PR-DEVELOPADDRESSREVIEW-021（拒否の行。止める所を指定し直して新しく呼ぶ） | なし | `reject_args` | `A_RejectArgs` |
| 作業ツリーが clean でない | PR-DEVELOPADDRESSREVIEW-004（作業ツリーを clean にして同じ引数で新しく呼ぶ） | なし | `refused` | `A_EntryDirty` |
| 人の判断が要る | PR-DEVELOPADDRESSREVIEW-019・014・053 | 止める所への振り分け | `needs_input`・`mismatch` | `A_NeedsDecision`・`A_ClassifyMismatch` |
| トークン量か待つ回数の上限 | PR-DEVELOPPLUGIN-045、PR-DEVELOPADDRESSREVIEW-029（実行中が残る行） | 止まった段の、結果を記録していない項目 | `limit_run` | `A_ClassifyToken`・`A_CiWaitLimit` |
| push できない | PR-DEVELOPADDRESSREVIEW-011 | 止める所への振り分け | `push_denied` | `A_RoutePushDenied` |
| develop:implement が止まった | PR-DEVELOPADDRESSREVIEW-024 | develop:implement の呼び出し | `impl_stopped` | `A_ImplStopped` |
| push した SHA が head でない | PR-DEVELOPADDRESSREVIEW-028 | なし | なし（模型の範囲の外） | 模型の範囲の外 |
| head が動いた | PR-DEVELOPADDRESSREVIEW-032 | なし | `head_moved` | `A_ResumeHeadMoved` |
| 返信の直前に head か議論が動いた | PR-DEVELOPADDRESSREVIEW-036・050（新しく呼んで指摘の収集から始める） | なし | `stale` | `A_ReplyStale` |
| BLOCKED | PR-DEVELOPADDRESSREVIEW-015・029（失敗・読めない・数えられない行）・040・044・052、PR-DEVELOPPLUGIN-033・040 | 止まった段の、結果を記録していない項目 | `blocked` | `A_ClassifyBlocked`・`A_PushRejected`・`A_CiStop`・`A_CheckMismatch` |

#### PR-DEVELOPADDRESSREVIEW-059 停止からの再開
止まった address-review を next_args で続けるとき、address-review は、停止・足された入力・PR の head・develop:implement の停止に応じて、次の表のとおりに続けるか再開を拒否しなければならない。足された入力の値は、なしか、人の判断（PR-DEVELOPADDRESSREVIEW-061）とする。PR の head は、required checks の待ちで止まった上限の停止でだけ待っていた SHA と照らす。develop:implement の停止は、develop:implement が止まった停止でだけ、develop:implement の停止の表（PR-DEVELOPIMPLEMENT-068）の記録する位置があるかで分ける。develop:implement の再開に要る入力（PR-DEVELOPIMPLEMENT-069）は、人が develop:implement の状態に足し、address-review は入力を足されずに再開する。

> 条件の値: 停止 = 呼び直しを要する拒否 / 止める所の指定を拒否した / 作業ツリーが clean でない / 人の判断が要る / トークン量か待つ回数の上限 / push できない / develop:implement が止まった / push した SHA が head でない / head が動いた / 返信の直前に head か議論が動いた / BLOCKED
> 条件の値: 足された入力 = なし / 人の判断
> 条件の値: PR の head = 照らさない / 待っていた SHA のまま / 動いた
> 条件の値: develop:implement の停止 = 位置がある / 位置がなし

| 条件: 停止 | 条件: 足された入力 | 条件: PR の head | 条件: develop:implement の停止 | 結果 | 模型の kind | 模型の action |
|---|---|---|---|---|---|---|
| 人の判断が要る | 人の判断 | * | * | 記録した位置から、PR-DEVELOPADDRESSREVIEW-062 のとおり判断の値で振り分けて続ける | `needs_input`・`mismatch` | `A_Decide` |
| トークン量か待つ回数の上限 | なし | 照らさない | * | 記録した位置から続ける | `limit_run` | `A_Resume` |
| トークン量か待つ回数の上限 | なし | 待っていた SHA のまま | * | 記録した位置から続ける | `limit_run` | `A_Resume` |
| トークン量か待つ回数の上限 | なし | 動いた | * | 再開を拒否し、head が動いた停止で止まる | `limit_run` | `A_PushByOther`・`A_ResumeHeadMoved` |
| push できない | なし | * | * | 記録した位置から、PR-DEVELOPADDRESSREVIEW-010 の確認をやり直して続ける | `push_denied` | `A_Resume` |
| develop:implement が止まった | なし | * | 位置がある | 記録した位置から、develop:implement を next_args で再開して続ける | `impl_stopped` | `A_Resume`（develop:implement の状態への入力と入れ子の再開は模型の範囲の外） |
| develop:implement が止まった | なし | * | 位置がなし | 再開を拒否し、address-review を新しく呼ぶことを次の手として返す | `impl_stopped` | 模型の範囲の外 |
| BLOCKED | なし | * | * | 原因を直した後に（required checks の失敗では、同じ head で流し直すか読めるようにした後に）、記録した位置から続ける（返信の確認か resolve の確認から続けるときは投稿し直さない） | `blocked` | `A_Resume`（原因を直す入力は模型の範囲の外） |
| 上記以外 | * | * | * | 再開を拒否し、止まったまま、その停止をこの表のどの行で出られるか（記録する位置が「なし」の停止では新しく呼ぶこと）を次の手として返す | `needs_input`・`mismatch`・`refused`・`reject_args`・`stale`・`head_moved` | `A_RefuseResume`（模型は入力の無い再開だけを表す。合わない停止に人の判断を足した組み合わせは模型の範囲の外） |

#### PR-DEVELOPADDRESSREVIEW-065 止まっている間のほかの入力
address-review は、止まっている間に足された、再開ではない入力を、次の表のとおりに扱わなければならない。

| 入力 | 扱い | 模型の action |
|---|---|---|
| 新しい呼び出し | 止まった状態を引き継がずに、指摘の収集から新しい依頼として始める | `A_Reinvoke` |
| 打ち切り | 再開せずに終わる | `H_Abort` |

### 完了の条件

#### PR-DEVELOPADDRESSREVIEW-063 どの時点でも守る条件
address-review は、完了の前と止まった後を含むどの時点でも、次の条件を全て満たさなければならない。

- PR-DEVELOPADDRESSREVIEW-056 の行わない操作を行っていない（模型: `AddrNoForbidden`）。
- develop:implement に渡したのは、分類か人の判断（PR-DEVELOPADDRESSREVIEW-062）が fix の指摘だけで、PR があるか、入口で作業ツリーが clean だったときだけである（模型: `AddrImplOnlyFix`）。
- 返信したのは、PR-DEVELOPADDRESSREVIEW-029 の表で返信へ進んだ後だけである（模型: `AddrReplyAfterChecks`）。
- resolve したのは、その thread への返信を確かめた後だけである（模型: `AddrResolveAfterReply`）。
- PR の head が他の人の push で動いた後に、返信を投稿していない（模型: `AddrNoStaleReply`）。

#### PR-DEVELOPADDRESSREVIEW-060 完了の条件
address-review は、PR-DEVELOPADDRESSREVIEW-063 の条件に加えて次の条件を全て満たすときにだけ、完了しなければならない。

- 全ての指摘の分類を受け入れており、人の判断が要る指摘には人の判断を入れている（模型: `AddrClassified`）。
- PR が無いときは、止める所が push・返信・resolve でなく、入口で作業ツリーが clean だった（模型: `AddrNoPr`）。
- 分類か人の判断が fix で直す変更のある指摘があり、止める所が分類でなければ、develop:implement に修正を渡した（模型: `AddrImplOnFix`）。
- 修正の commit を頼んだとき（PR-DEVELOPADDRESSREVIEW-049）は、develop:implement が直す変更は無いと返したときを除き、commit を push した（模型: `AddrCommitPushed`）。
- PR があり止める所が指定なし・返信・resolve のときは、required checks の待ちで返信へ進み、返信を確かめた（模型: `AddrReplyConfirmed`）。
- PR があり止める所が指定なし・resolve のときは、PR-DEVELOPADDRESSREVIEW-043 の確認を通った（模型: `AddrResolveConfirmed`）。

| 完了の種類 | 模型の action | 模型の性質 |
|---|---|---|
| 分類と分類の検証の後で完了 | `A_RouteClassifyOnly`・`A_RouteNoFixStop` | `AddressGoal` |
| 修正か push の後で完了 | `A_ImplVerified`・`A_ImplNoChangeStop`・`A_PushOkDone` | `AddressGoal` |
| 返信か resolve の確認の後で完了 | `A_ReplyConfirmedDone`・`A_ResolveConfirmed` | `AddressGoal` |
