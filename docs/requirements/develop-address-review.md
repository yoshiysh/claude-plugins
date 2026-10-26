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
PR の head に push できず、直す変更のある fix（develop:implement に渡し、push が要る fix）があるならば、address-review はその fix を人の判断待ちにして止まらなければならない。

#### PR-DEVELOPADDRESSREVIEW-047 push できず直す変更が無いとき
PR の head に push できず、直す変更のある fix が無いとき（直した commit を記録した fix・decline・out_of_scope だけのとき）、address-review は止まらずに、push しない流れで返信へ進まなければならない。

#### PR-DEVELOPADDRESSREVIEW-012 指摘より後の commit の一覧
対象が PR であるとき、address-review は、指摘の収集で、指摘ごとに、その指摘が付いた時より後の PR の commit（指摘より後の commit）を一覧にして分類役に渡さなければならない。

### 分類

#### PR-DEVELOPADDRESSREVIEW-013 分類の run
address-review は、分類役と分類の検証役を、読み取り専用の run で、分類役・検証役の順に動かさなければならない。

#### PR-DEVELOPADDRESSREVIEW-014 分類が食い違ったとき
分類役と分類の検証役の分類が食い違ったならば、address-review は止まり、食い違った指摘を返さなければならない。

#### PR-DEVELOPADDRESSREVIEW-015 分類の run の書き込み
分類の run の中で書き込みを検出したならば、address-review は BLOCKED で止まらなければならない。

#### PR-DEVELOPADDRESSREVIEW-016 既に直った指摘の分類
今の PR の head で直っている指摘のうち、直したのが指摘より後の commit であるものを、address-review は退けずに fix と分類し、直した commit をその指摘の一覧から選んで記録しなければならない（退けると、直した問題を「問題ではない」と返信し、resolve の候補からも外れる）。

#### PR-DEVELOPADDRESSREVIEW-017 直した commit の照合
address-review は、記録した直した commit がその指摘の、指摘より後の commit の一覧にあり、その commit がその指摘の修正の対象のパスのどれかを変えていることを照らさなければならない。修正の対象のパスは、分類が fix の指摘ごとに分類で挙げる、直すのに変えるパスであり、指摘が付いた位置のパスではない。

#### PR-DEVELOPADDRESSREVIEW-053 直した commit の照合に合わないとき
PR-DEVELOPADDRESSREVIEW-017 の照合に合わないか照らせないならば、address-review は分類の結果を受け入れずに止まり、合わなかった指摘を返さなければならない。

#### PR-DEVELOPADDRESSREVIEW-018 既に直った指摘を修正に渡さない
address-review は、直した commit を記録した fix を develop:implement に渡してはならない（直す変更が無い）。

#### PR-DEVELOPADDRESSREVIEW-019 人の判断が要る指摘
分類が needs_decision か unverified の指摘を 1 件以上含むとき、address-review は run の境界で止まり、人の判断を次の run の入力として受け取らなければならない。

#### PR-DEVELOPADDRESSREVIEW-020 同じ状態での 2 回目の分類
address-review は、同じ状態に分類の run の結果を受け入れ直すことと、返信を組み立て直すことを拒否しなければならない。

#### PR-DEVELOPADDRESSREVIEW-048 人の判断を入れること
address-review は、人の判断待ちで止まった後に人の判断を入れることを、PR-DEVELOPADDRESSREVIEW-020 の拒否の対象にしてはならない（人の判断は分類の結果の受け入れとは別の記録である）。

### 止める所

#### PR-DEVELOPADDRESSREVIEW-021 止める所の指定
address-review は、PR の有無・止める所の指定・直す変更の有無に応じて、次の表のとおりに進まなければならない。

> 条件の値: PR = あり / なし
> 条件の値: 止める所 = 指定なし / 分類 / 検証 / 返信 / resolve
> 条件の値: 直す変更 = ある / 無い

| 条件: PR | 条件: 止める所 | 条件: 直す変更 | 結果 |
|---|---|---|---|
| あり | 指定なし | * | resolve とその確認まで進む |
| あり | 分類 | * | 分類と分類の検証の後で止まる |
| あり | 検証 | ある | develop:implement の最終照合の後で止まり、push と返信をしない |
| あり | 検証 | 無い | 分類と分類の検証の後で止まる |
| あり | 返信 | * | 返信とその確認の後で止まり、resolve しない |
| あり | resolve | * | resolve とその確認まで進む |
| なし | 指定なし | ある | develop:implement による修正まで進む |
| なし | 指定なし | 無い | 分類と分類の検証の後で止まる |
| なし | 分類 | * | 分類と分類の検証の後で止まる |
| なし | 検証 | ある | develop:implement の最終照合の後で止まる |
| なし | 検証 | 無い | 分類と分類の検証の後で止まる |
| なし | 返信 | * | 指定を拒否する |
| なし | resolve | * | 指定を拒否する |

### 修正と push

#### PR-DEVELOPADDRESSREVIEW-022 develop:implement への受け渡し
address-review は、直す変更のある fix を、PR の番号（PR があるとき）と、指摘の収集で固定した方針の版の SHA と一緒に develop:implement に渡さなければならない（それぞれが始めた時点で主ブランチの先端を固定すると、間に主ブランチが進んだときに別の版で読む）。

#### PR-DEVELOPADDRESSREVIEW-023 直す変更が無いとき
分類の結果に直す変更が 1 件も無いとき、address-review は develop:implement を呼ばず、push もしてはならない。

#### PR-DEVELOPADDRESSREVIEW-024 develop:implement が止まったとき
develop:implement が止まったならば、address-review は完了ではない停止として止まり、どの指摘についても（decline・out_of_scope・直した commit を記録した fix を含む）push・返信・resolve をせずに、develop:implement が止まった理由と、develop:implement の段から続けるための next_args を返さなければならない（止まった run で他の指摘に返信すると、再開の後に直した指摘の返信を組めない）。

#### PR-DEVELOPADDRESSREVIEW-055 develop:implement の段からの再開
PR-DEVELOPADDRESSREVIEW-024 の next_args で再開した run は、入口の作業ツリーの検査と、分類の受け入れ・返信の組み立てを繰り返さず、状態にある分類の結果をそのまま使って develop:implement の段から続けなければならない（その後は止まらなかったときと同じく push・待ち・返信・resolve へ進む）。

#### PR-DEVELOPADDRESSREVIEW-049 commit の依頼
対象が PR であるとき、address-review は、develop:implement に修正を渡すときに commit も頼まなければならない。

#### PR-DEVELOPADDRESSREVIEW-025 push
対象が PR であるとき、address-review は、develop:implement が commit した修正を、利用側の宣言の commit の後の設定に関わらず push しなければならない（返信は push 済みの SHA を指す）。

#### PR-DEVELOPADDRESSREVIEW-054 develop:implement が直す変更は無いと返したとき
対象が PR で、develop:implement が直す変更は無いと返して commit しなかったとき、address-review はその fix の指摘について push せず、PR-DEVELOPADDRESSREVIEW-027・029 の待ちの後に、直す変更が無かったことを返信しなければならない（その thread は PR-DEVELOPADDRESSREVIEW-041 の候補にならない）。

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
待つ回数の上限で止まった address-review を next_args で続けるとき、address-review は同じ状態から required checks の待ちだけを流し直し、分類の受け入れと返信の組み立てを繰り返してはならない。

#### PR-DEVELOPADDRESSREVIEW-032 再開の前に head が動いていたとき
待ちの上限からの再開の前に、PR の head が待っていた SHA（push したときは push した SHA、push しなかったときは待ち始めた時の PR の head）から動いていたならば、address-review は止まらなければならない。

#### PR-DEVELOPADDRESSREVIEW-033 待ちの再開の回数
address-review は、待ちの上限からの再開の回数を制限してはならない。

#### PR-DEVELOPADDRESSREVIEW-034 待ちの再開の回数の記録
address-review は、待ちの上限からの再開の回数を状態に残さなければならない。

### 返信

#### PR-DEVELOPADDRESSREVIEW-035 返信の直前の再照合
address-review は、返信の直前に、PR の head と指摘の thread を指摘の収集の時と照らし直さなければならない。

#### PR-DEVELOPADDRESSREVIEW-036 head が他の人の push で動いたとき
返信の直前の照らし直しで PR の head が他の人の push で動いていたならば、address-review は返信を止め、その指摘を次の run で扱わなければならない。

#### PR-DEVELOPADDRESSREVIEW-050 thread の議論が変わっていたとき
返信の直前の照らし直しで、どれか 1 つの指摘の thread の議論が収集の時から変わっていたならば（指摘の本文の書き換え・新しいコメント・既に resolve されたことを含む）、address-review はその run のどの指摘にも返信せずに止まり、返信しなかった指摘を次の run で扱わなければならない（head が動いたときと同じ扱い）。

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
