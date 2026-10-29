# develop の停止と再開の TLA+ 模型

develop plugin の 3 スキル（implement・review・address-review）の停止と再開を表す状態機械。合格の条件は利用者が固定したもの（模型の段の最後の版）に従う。

略記: IMPL-・REV-・ADDR-・PLUGIN- は `docs/requirements/develop-{implement,review,address-review,plugin}.md` の要求 ID（PR-DEVELOPIMPLEMENT-010 を IMPL-010 と書く）。文書を書き直すと行番号がずれるので、文書は ID で引く。sp は設計方針文書 sp-380c49d.md の行。決定は利用者の決定（決定 1〜11、D19、追加の決定 2・4）。

## module と変数

| module | 宣言する変数 | 役割 |
|---|---|---|
| `DevelopCommon` | なし | 定数と語彙 |
| `DevelopSkill` | `sk`・`inbox`・`args` | スキル。各 action と、Determinism が読む表 |
| `DevelopEnv` | `hist`・`inbox`・`bud`・`obs` | 環境・呼び出し側・人 |
| `DevelopProps` | `hist`・`inbox`・`bud`・`out` | 物差し |
| `Develop` | `sk`・`inbox`・`bud`・`hist` | 合成。`args <- hist.args`、`obs <- [st, stage, kind]` |
| `MC` | — | 検査の入口。`INSTANCE DevelopProps WITH out <- [st, stage, kind, res]` |

名前の解決で守る境界:
- どの module も `DevelopCommon` を `LOCAL INSTANCE` で取る。`DevelopCommon` に VARIABLE を足すと、その変数を持たない `DevelopProps` と `DevelopEnv` で、SANY が置き換えの欠けを報告する。
- `DevelopSkill` は `hist` を宣言しない。スキルが読める記録は `args`（呼び出しの引数）だけで、`hist` を読むことも書くことも SANY が拒否する。
- `DevelopProps` と `DevelopEnv` は `sk` を宣言しない。名指せば SANY が拒否する。
- `MC` は `DevelopProps` を名前なしの INSTANCE で取る。性質と同じ名前を `MC` で定義すると、SANY が二重の定義として拒否する。

SANY で守れない境界（信頼する行）:
- `MC` の射影 `out <- [...]` と、`Develop` の `obs <- [...]`・`args <- hist.args`。射影に `sk` の内部を足し、`DevelopProps` か `DevelopEnv` がそれを読む改変は、名前の解決では見つからない（第 3 版の検証の B1・B2b）。この 3 行はレビューで見る。
- `Develop` の `Frozen == UNCHANGED <<hist, bud>>`、`EnvInput` の `UNCHANGED sk`、各 action の `I_X == S!I_X(inbox) /\ Frozen` の名前の対応。書き換えると、スキルと環境が互いの変数を書かないこと、または coverage の名前が崩れる。

環境は `obs.kind`（スキルが返した停止の理由）を見て、人の入力を選ぶ。人は返された理由と次の手を読んで動くので、これは入力の手段の選び方であり、スキルの次の振る舞いの期待ではない。環境の記録 `hist` に期待の結果は無い。

## 性質

| 名前 | 合格の条件 1 の項目 | 置き場 | 内容 |
|---|---|---|---|
| TLC の deadlock 検査 | 行き止まりが無い | — | 終端は done と aborted だけ（`Terminated` の stutter）。正常版の検査では `-deadlock` を付けない |
| `NoDeadEnd` | 行き止まりが無い | `Develop` | どの停止にも、abort 以外に、人が出せてスキルが停止から出す入力がある（予算は見ない） |
| `Determinism` | 決定性 | `DevelopSkill` | スキルの全ての step（入力の無い step を含む）が、待っている入力に対する表のただ 1 つの応答である |
| `OutputOnInput` | 停止を出るのは記録された入力の後だけ | `DevelopProps` | `[][out' # out => (inbox # NoEv /\ inbox' = NoEv)]_pvars`。入力の無い step を含む全ての step で見る |
| `Termination` | 終わる | `DevelopProps` | `<>(done \/ aborted)`。下の予算の仮定のもとで |
| `ResumePosition` | 再開位置は sp:184 | `DevelopProps` | 停止から running へ出るとき（新しい呼び出しを除く）、未読のヒント（implement）か pin の崩れ（review）があれば plan、無ければ停止が記録した位置 |
| `ImplGoal`・`ReviewGoal`・`AddressGoal` | ゴールの述語は hist から読む | `DevelopProps` | 下の節 |
| `W_FixBeyond`・`W_PlanBeyond`・`W_DecideEffect`・`W_WaitBeyond`・`W_EditDone` | （効果の観測） | `DevelopProps` | 正常版で違反されるべき不変条件。修正の回の上限の引き上げ、作り直しの上限の引き上げ、abandon での人の判断、待ちの数え直しが効くこと。`W_EditDone` は、修正の回の上限の停止から、引き上げ無しで作業ツリーの手直しだけで done に届くこと（決定 4、追加の決定 4） |

`Determinism` と `NoDeadEnd` はスキルの表を読むので、物差しの module に置けない。前者は表を持つ `DevelopSkill`、後者は表と環境の両方を見る `Develop` に置いた。

### ゴール

- `ImplGoal`（done のとき。IMPL-070）:
  - check の宣言がある（IMPL-010 の理由）。
  - nochange: review の返り値が無く、実装の run が変更を起こしていない（IMPL-044、決定 1）。
  - verified・committed: 変更の後の check が通り、その後に review の返り値があり、最後の返り値に確定（環境か人）も未決の未検証も無い（IMPL-057）。commit は頼まれたときだけ（IMPL-033）、push は宣言があるときだけ（IMPL-034）。
  - 未読のヒントが無い（IMPL-071、追加の決定 5。直す変更が無い完了と commit・push の後の完了を含む全ての完了）。
  - N11: 最後に受け入れた計画の後に、実装の run が返した（`planPending` が偽）。
  - N12（改訂）: 確定とした指摘は全て、その後の実装の run の入力に入ったか、修正の回の上限の停止で人が作業ツリーを直した後の check と review を通った（`unfed` が空。詳しくは「模型の側で決めたこと」）。
  - 実装の変更の後に開始時の check を流していない（IMPL-065・IMPL-059。B2b）。
  - 計画で止めた後の計画の受け入れは、ヒントか 043 の後だけ（IMPL-012・sp:184。J8）。
  - 修正の回の上限から未読のヒントで作り直した計画は、受け入れの後、実装の run の前に check と review を通った（IMPL-072。`skip072` が偽）。作り直しの計画の run が途中で止まって再開しても、この条件は残る。
- `ReviewGoal`（REV-074）: 同じ pin のもとで投稿は 1 回まで（REV-075・REV-076、追加の決定 4。J10）。done のときは、失敗の結果と記録が一致し、そうでなければ全項目を見て、部分なら degraded、投稿を頼まれたら投稿を確かめた（REV-030・REV-034・REV-047・REV-050、決定 3）。
- `AddressGoal`（ADDR-060・ADDR-063）: 021 の「行わない操作」をしない、実装は人か分類が fix としたときだけ、返信は CI の成功の後、resolve は返信の確認の後、head が動いた後に返信を確かめない（ADDR-021・ADDR-029・ADDR-036・ADDR-041、決定 5・6）。done のときは、加えて次を満たす。
  - PR が無いのに push・返信・resolve を頼まれた呼び出しは done にならない（ADDR-021 の拒否の行）。
  - PR が無いときは、作業ツリーがきれいだった（ADDR-004）。
  - fix の指摘があり commit を要するなら、commit して push した（ADDR-021・ADDR-055）。
  - 人の判断が fix で、止める所が classify でなければ、実装した（ADDR-020・ADDR-048。J7）。
  - CI を待つ呼び出しなら CI が成功し返信を確かめた。resolve まで頼んだなら resolve を確かめた。

## 環境の仮定

`Termination` とゴールの到達は、次の仮定のもとでだけ主張する。どれも要求文書の決定ではない。

1. 作業ツリーが変わっていない間の check は、前と同じ結果を返す。
2. 作業ツリーが変わっていない間の review は、前と同じ指摘を返す。
3. MaxRet 回の返り値の後、変わった作業ツリーの review は指摘 0 件を返す。修正の繰り返しは、スキルの上限（IMPL-021）と別に、この仮定で終わる。
4. 不利な入力（`Adverse`）・ヒント・引き上げ・停止中の人の入力（`HumanAtStop`。resume・answer・reinvoke・判断）は、それぞれの予算の回数までしか来ない。
5. 作業ツリーの手直し（`editWt`・`touchWt`）・pin の崩れ・他者の push は、不利な入力の予算を使う。このため `DevelopImplWide.cfg`（MaxFaults=0）では起きない。
6. head は、他者の push か `headStale` で動いたら、その呼び出しの間は動いたまま。動いた後の返信の段では、環境は `headStale` だけを返し、予算を使わない。
7. 人が作業ツリーを手直しできるのは、修正の回の上限（`editWt`）と計画で止めた後（`touchWt`）の停止だけ。blocked・limit_run・needs_input の停止中に作業ツリーを変えてから再開する振る舞いは、探索に入らない。
8. 最終照合はスキルが自分の記録で行う。環境の `finalFail` は「照らせない」の不利な入力。
9. 上限で止まった review を呼び直した後、環境は「未着手が減らないまま再び上限」（`reviewLimitSame`）を返せる。呼び直す前の 1 回目の上限では返さない。呼び直した後のこの結果は、1 回目の上限の帰結として、不利な入力の予算を使わない。

## 模型の側で決めたこと

| 何を | どう決めたか | 根拠 |
|---|---|---|
| D19 C の後の 029 の「なし／なし」 | 上限からヒントで再開して作り直した計画は、check と review の後、029 がなし／なしでも、最終照合でなく実装へ進む（`planned`） | D19 C と追加の決定 2（衝突 1）。字面どおりの版は mutant `N11_d19c_skips_impl` として落ちる |
| N12 の文言 | 確定とした指摘は全て、修正の回の入力に入ったか、上限の停止で人が作業ツリーを直した後の check と review を通った。修正の回の上限での `editWt` で `unfed` を空にし、その後の check と review は done の `ImplGoal` が読む（`editWt` で check の記録が消えるので、done には手直しの後の check と review が要る） | 合格の条件の改訂と追加の決定 2（衝突 2）。環境が上限を数え直す例外は消した |
| 修正の回の上限からの再開位置 | 停止は 029（decide）に記録する。引き上げだけの再開は、記録した返り値と人の判断のまま 029 から続ける。作業ツリーの手直し（`editWt`）は位置を check に移し、再開は check と review から続ける | 追加の決定 2（衝突 3）、PLUGIN-035・sp:184。055（IMPL-055）は「check と review の前に上限で止まらない」という禁止で、引き上げの後に check と review を流し直すことは求めていない |
| 043 と上限 | 043 は修正の回を 1 回使い、回が残っていなければ作り直さずに limit_fix で止まる。作り直した計画の受け入れの後は 065 のとおり実装へ進む | 決定 2（IMPL-043・IMPL-060） |
| abandon・needs_input とヒント | 止まっている間にヒントを足して resume すると、計画から作り直す | IMPL-040・PLUGIN-035（例外）。決定 11。052 の回答（IMPL-052）も計画から始めるので、どちらでも計画へ進む |
| check の失敗 | 029 の判定に「変更が起こした check の失敗」を足した。指摘が無くても check が落ちていれば修正の回へ進み、上限なら 021 で止まる（`NeedFix`） | 追加の決定 4（IMPL-029・IMPL-019・IMPL-021・IMPL-074） |
| 完了の前の未読のヒント | 最終照合の前だけでなく、直す変更が無い完了・commit の後の完了・push の後の完了の前にも、未読のヒントがあれば計画の run へ戻す（`I_FinalGate` の guard を広げた）。広げる前の模型では、計画の受け入れの後にヒントを足し、実装の run が直す変更が無いと返すと、未読のまま done になった（`ImplGoal` が落ちることを TLC で確かめてから直した） | 追加の決定 5（IMPL-071） |
| 「読むもの」表を読めない review の停止 | 停止の名前を `read_list` にし、resume を拒否する（`R_RefuseResume`）。続けるのは新しい呼び出し（`R_Reinvoke`）だけ | REV-073（再開は方針の版を導き直さないので、同じ表をまた読めずに止まる）・REV-072・REV-015 |
| 最終照合の BLOCKED | スキル自身の記録で照合が通らない場合の action（前の版の `I_FinalBlocked`）を外した。029 が check の失敗も修正の回へ回すので、最終照合へ進んだときは記録の上で必ず通り、この action は発火しなくなった。照合できない場合（`finalFail`）は `I_Blocked` で止まる | 追加の決定 4・IMPL-031・IMPL-057 |
| review の呼び直し | 上限で止まった review は呼び直す。呼び直した review が未着手を 1 件も減らさずに再び上限で止まったら、呼び直さずに BLOCKED で止まる（`I_ReviewStuck`） | 追加の決定 4（IMPL-024） |
| 上限から作り直す計画の run の途中の停止 | 上限から未読のヒントで作り直す計画の run が途中で止まり（トークン量の上限・BLOCKED・人の判断待ち）、再開しても、受け入れの後は 072 の check と review へ進む（`fromLimit` を再開で消さない） | IMPL-072・IMPL-069 |
| push | implement の引数に push の宣言を足し、宣言があるときだけ push する | IMPL-034 |
| ヒントの拒否 | 計画で止めた後に作業ツリーが変わった状態（新しく呼ぶしか続かない）へのヒントも拒否する | 決定 9（IMPL-042 と同じ扱い）。第 3 版の検証 F9 |
| 待ちの回数 | どの停止から再開しても 0 から数える | sp:185（0 から数える上限）。第 3 版の検証 F15 |
| head_moved の出口 | 新しく呼ぶ | ADDR-032 は止まることだけを決めている |
| reject_args・push_denied の後の新しい呼び出し | 止める所を none・verify にする | ADDR-021、決定 8 の b |
| 計画で止める依頼 | 1 回の呼び出しで 1 度だけ止める（`planStopUsed`） | IMPL-066 は作り直しの後に止まらないことだけを決めている |
| needs_input・mismatch の位置 | route | sp:184 から導いた |
| reinvoke を出す停止 | 次の手が新しい呼び出しの停止だけ（no_check・wt_changed・作業ツリーが変わった plan_stop・reject_args・refused・stale・head_moved・push_denied、head が動いた待ちの上限） | 状態が増えすぎるのを避けた。スキルはどの停止でも reinvoke を受け付ける |

## 範囲

範囲の外にしたもの:
- スキルどうしの入れ子の実行。呼ばれた側は返り値だけを入力にした。
- implement の呼び出し側の区別（IMPL-049・IMPL-051。address-review から PR の修正として呼ばれたときは push しない）。模型の implement の引数には呼び出し側が無く、push は利用側の宣言（`pushDecl`）だけで決まる。address-review から呼ばれた implement は、push の宣言が無い呼び出しとしてしか表せない。宣言が push ありで address-review から呼ばれた場合の 051 は確かめていないので、`ImplGoal` と `I_CommitDone` の印から 051 を外した。ゴールから push の条件を外さないのは、利用側の宣言による push（IMPL-034）は模型で確かめられるため。
- run を起動する前の停止（plug 004・011・014、impl 053・005・054、addr 006）。
- push した SHA が head でないときの停止（addr 028）。
- 遅れた書き込みと relaunch（plug 039・036）。
- resolve の候補の条件の細部（addr 041・042）。
- 「打ち切ってよい範囲」の入力（sp:185）。
- BLOCKED の原因を直す人の入力（IMPL-032、sp:183）。BLOCKED からは resume しかない。
- 作業ツリーが変わっていないことを確かめられない枝（IMPL-014・IMPL-015）。
- 完了した状態へのヒント（IMPL-042）。環境は done と aborted に入力を出さない。
- 029 の「待った回数が数えられない」と、ADDR-020 の受け入れ直しの拒否。
- 指摘の中身。決定 11 の「確定とした指摘を計画役に渡す」は、N12 の「実装の run の入力に入った」として、渡したことだけを見る。

## 設定と定数

| 設定 | 対象 | Claims | MaxRet | MaxFaults | MaxHuman | MaxHints | MaxRaise |
|---|---|---|---|---|---|---|---|
| `Develop.cfg` | review・address-review | 1 件 | 1 | 3 | 3 | 0 | 0 |
| `DevelopImpl.cfg` | implement | 1 件 | 3 | 1 | 2 | 1 | 1 |
| `DevelopImplClaims.cfg` | implement | 2 件 | 2 | 1 | 2 | 0 | 0 |
| `DevelopImplWide.cfg` | implement | 1 件 | 2 | 0 | 3 | 2 | 2 |
| `mutants/Impl.cfg` | implement（mutant と witness にも使う） | 1 件 | 2 | 1 | 2 | 1 | 1 |

`FixLimit0`・`RebuildLimit0`・`WaitLimit` は 1、`Items` は 2。

## 実行

```bash
tests/formal/develop/run.sh            # normal → witness → mutants
tests/formal/develop/run.sh mutants N1 # 名前が正規表現に合う mutant だけ
```

合否は次の 3 つで決める。
- 正常版の全ての設定が `Model checking completed. No error has been found.` を出す。
- 表の全ての action（MC の `ASSUME` が TLC の出力に並べる）が、どれかの設定で 1 回以上発火する。
- 全ての mutant が、`mutants/EXPECTED` の性質 1 つだけを検査する設定で落ちる。
  - 不変条件・action 性質・`Termination`: その違反。性質を 1 つに絞るので `-deadlock` を付ける。
  - `SANY`: 名前の解決の誤り。`deadlock`: TLC の deadlock。`NOTFIRED:<action>`: その action が発火しない。
  - witness: 正常版で届く witness に、mutant の版では届かない。witness の段は、正常版が全ての witness に届くことを確かめる。

## 壊し方の振り分け

対象は、第 3 版の検証で全ての段を通った 13 件と、第 3 版の mutant 48 件。改訂後の模型に移して当て直した（patch は今の module に合わせて作り直した）。

(a)（今の性質で落ちる）と (b)（文書のゴールに反するのに通ったので、ゴールの条件を足して落とす）は `mutants/` に残した。各 mutant が落ちる性質は `mutants/EXPECTED` が正本。

### (a) 今の性質で落ちる（48 件）

| 由来 | mutant |
|---|---|
| 第 3 版の検証の 13 件 | E1・E2・E4（`OutputOnInput`）、N11・N12（`ImplGoal`）、E5・C1（SANY）、B1 のスキルの半分（m05 と同じ） |
| 第 3 版の mutant | m01〜m08・m10・m12・m13、x1〜x5・x7〜x9、o1、r1・r2、f1、v02・v04〜v06・v11〜v15・v17・v18、s2・s3・a1 |
| witness を足して落としたもの | m11（abandon での判断が効かない）は `W_DecideEffect`。f4（上限で手直しの後の resume を拒む）と m09（手直しの後の review を飛ばして 029 へ進み、上限でまた止まる）は、追加の決定 4 の `W_EditDone` |

x5（resume で epoch が増える）は epoch を外したので、「resume を新しい呼び出しとして扱う」に移した。f1 と v04 は (c) の候補として全ての性質に当てたところ落ちた（f1 は `ImplGoal`、v04 は拒んだヒントを未読のまま残して進むので `ResumePosition`）。

この版までに足した mutant（61 件の外）: `N11_d19c_skips_impl`（D19 C を字面どおりにした版、`ImplGoal`）、`F1_resume_drops_from_limit`（文書との照合の F1。上限から作り直す計画の run が途中で止まって再開すると、072 の check と review を飛ばす。`ImplGoal` の IMPL-072 の条件）、`A036_stale_check_dropped`・`A032_reply_after_other_push`（下の (b)）。F1 は、条件を足した後に直す前の模型で `ImplGoal` が落ちることを TLC で確かめてから直した（経路: 043 で上限 → 引き上げ（未読のヒント）→ 計画の run で人の判断待ち → ヒントのまま resume → 計画の受け入れ → 実装 → done）。前の版で足した `n12_limit_one_round_early` は、N12 の例外（環境が上限を数え直す条件）の狭さを確かめるためのものだったので、例外を消したこの版で外した（この版では当てていない）。

### (b) ゴールの条件を足して落とした（8 件と、足した 2 件）

| mutant | 足した条件 | 根拠 |
|---|---|---|
| v03（check の宣言が無くても進む） | `ImplGoal`: done ならば check の宣言がある | IMPL-010（理由: 宣言が無いまま check を省くと、テストを流していない変更が最終照合を通る） |
| v07（PR が無く作業ツリーが汚れていても進む） | `AddressGoal`: 実装した、または done ならば、PR があるか作業ツリーがきれいだった | ADDR-004 |
| v08（PR が無いのに push・返信・resolve まで頼まれて進む） | `AddressGoal`: その呼び出しは done にならない | ADDR-021（拒否の行） |
| J10（検証 3。投稿の確認の食い違いを post に置き、再開で投稿し直す） | `ReviewGoal`: 同じ pin のもとで投稿は 1 回まで。pin が崩れた後に計画からやり直して投稿し直すのは許す（`rPosts` を `breakPin` で 0 に戻す） | REV-048（理由: 二重の投稿）・PLUGIN-035・REV-043 |
| B2b のスキルの半分（検証 3。開始時の check の結果を記録しない） | `ImplGoal`: done ならば、実装の変更の後に開始時の check を流していない（`baseAfterChange`） | IMPL-065・IMPL-059 の理由: 変更が起こした失敗が開始時の結果に入り、IMPL-057 の照合が見落とす |
| J7（検証 3。push_denied の停止を entry に置き、再開で分類し直す） | `AddressGoal`: done で、人の判断が fix で、止める所が classify でなければ、実装した | ADDR-020・ADDR-048・決定 6 |
| J8（検証 3。トークン量の上限の停止を plan に置く） | `ImplGoal`: done ならば、計画で止めた後の計画の受け入れは、ヒントか 043 の後だけ（`freePlan`） | IMPL-012・sp:184 の理由（計画で止めて承認を待つ使い方） |
| x6（第 3 版。修正の回が 0 で commit を頼まれていなければ、最終照合を飛ばして done） | `ImplGoal`: done では未読のヒントが無い（追加の決定 5 で全ての完了に広げた）。追加の決定 4 で check の失敗が修正の回へ進むようになり、前の版で x6 を落とした経路（check の失敗のまま done）が無くなったので足した | IMPL-071 |
| `A036_stale_check_dropped`（返信の直前の 036 の照らしを外す） | `AddressGoal`: head が動いた後に返信を確かめていない（`aStaleReply`） | ADDR-036・ADDR-050 |
| `A032_reply_after_other_push`（他者の push の後も待ちを続け、動いた head のまま返信する） | 同上 | ADDR-032・ADDR-036 |

J10 と J7 と、この版で足した 2 件は、`Develop.cfg` の MaxFaults と MaxHuman を 4 にした設定でも、それぞれの性質で落ちた。最後の 2 件は、条件を足す前の性質では全て通った（`AddressGoal` から `aStaleReply` の行を外した版で確かめた）。

### (c) ゴールが許す別の設計（4 件）

どれも、全ての性質と、そのスキルの全ての witness を通った（witness には正常版と同じく届いた）。v09・v10 は `Develop.cfg` の MaxFaults と MaxHuman を 4 にした設定でも通った。patch は残さない。

| 壊し方 | 中身 | 通る理由 | 正本 |
|---|---|---|---|
| J2（検証 3） | 最終照合の失敗を limit_run と返す | 停止の名前だけが違う。どちらも入力なしの resume で同じ位置へ戻り、最終照合でまた止まる。done の条件と行う操作は変わらない | IMPL-031・PLUGIN-040 |
| v09（第 3 版） | head が古い返信の停止を blocked と返す | 停止の名前だけが違う。head は動いたままなので、blocked からの resume は返信の直前の照らし直しでまた止まる。続けるには、stale と同じく新しい呼び出しが要る | ADDR-035・ADDR-036・ADDR-050 |
| v10（第 3 版） | 待ちの間に head が動いても、待ちを続ける | 032 を外しても、返信の直前の 036 が、動いた head を捕まえて止める。待つのは push した SHA の CI なので、CI の成功もゴールに反しない | ADDR-032・ADDR-035・ADDR-036 |
| v16（第 3 版） | needs_input への resume を拒むと、停止を blocked に変える | 次の resume で、回答なしに計画から続く。計画役がまた判断を求めるか自分で決める。ゴールの事実は変わらない | sp:183・IMPL-052 |

### 振り分けの外

- 第 3 版の構造の mutant s1（`obs` に kind を足す）は外した。この版では kind を設計として `obs` に入れている（環境は期待を記録しないので、kind を見ても表の写しにならない）。
- 第 3 版の検証の B1 と B2b のうち、射影の行を書き換える半分は、SANY で守れない境界（上の「SANY で守れない境界」）。スキルの半分は、B1 が (a)、B2b が (b)。

件数: 61 件のうち (a) 48、(b) 8、(c) 4、外したもの 1（s1）。

## 残る問題

1. SANY で守れない境界（`MC` の射影、`Develop` の `obs`・`args`・`Frozen`、action の名前の対応）は、レビューでしか守れない。
2. (c) の壊し方は、どの性質でも落ちない。停止の種類の名前・停止の位置・どの入力で停止を出るか（決定 5・8・10 など）は、ゴールか witness に表れない限り、この模型では確かめていない。
3. J8 の条件が効くのは、計画で止める依頼の経路だけ。計画で止めない呼び出しでは、トークン量の上限で計画からやり直しても、ゴールに反しない。また、計画で止めた後に一度ヒントか 043 があれば、以後の受け入れ直しは全て免除される（文書は受け入れごとに求める）。
4. implement の呼び出し側の区別（IMPL-051）は範囲の外（「範囲」）。
