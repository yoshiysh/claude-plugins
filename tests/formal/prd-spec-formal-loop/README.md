# prd-spec 形式検査ループのモデル

prd-spec の段 5・8 の形式検査ループ（formal-modeler → doc_check formal-check → `state.formal` → 改稿・試行・やり直し・完成ゲート）を
手で抽象化した TLA+ モデル。formal-methods スキルの手順で作った。保証の範囲はこの README の「抽象化と有限範囲」と「形式化しなかった性質」が正であり、
そこに無い範囲は未検証として扱う。

- モデル: `FormalLoop.tla`、設定: `FormalLoop.cfg`（変異・目撃の一覧は `check.test.mjs` の `MUTANTS`・`WITNESSES` が正本）
- 実行: `make test`（`check.test.mjs` が本物の TLC を起動する。jar は `doc_check.mjs formal-tools` から取り、`fault` があるか sha256 が違えば落ちる）
- 単発で回す: `java -cp <jar> tlc2.TLC -workers auto -config FormalLoop.cfg FormalLoop`

## 性質

| # | 要求 | 不変条件 | 種類 |
|---|---|---|---|
| 1 | 完成ゲート: 最後の監査の版の検査で破れが残るか、改稿の後に検査し直していないまま done にならない | `GateSound` | 独立した仕様（ghost `stale`・`lastV` は実装の `state.formal` を読まない） |
| 1 | 完成ゲート: 改稿を経ずに消えた違反は、全て done の `formal.unconfirmed` に載る | `CompleteSound` | 半ば写し（下記） |
| 2 | 正直な改稿: modeler が忠実なら（どの試行も性質を弱めず違反を隠さない。モデルの欠陥で 1 度誤り rework で直す試行を含む）、改稿で違反が消えて done に届いても `unconfirmed` は空。ただし同じ巡の試行で破れた違反を後の試行で性質から外した run（ghost `droppedSeen`）は除く（下記） | `HonestDone` | 独立した仕様 |
| 2 | 正直な run は行き止まらない: 忠実な試行（改稿した項目だけを外す試行を含む）は、モデルの欠陥が無ければ doc_check の欠陥を受けない | `HonestNoDefect` | 独立した仕様（ghost `revG` は改稿の出自を touched と前の巡の違反から作り、実装の `formal.tried` を読まない） |
| 3 | やり直し: next_args で段 5・8 をやり直しても、止まった試行の違反が消えた事実は `unconfirmed` に載る | `CompleteSound`（やり直しを含む経路） | 半ば写し |
| 4 | 行き止まり: 続けられる止まり方は必ず next_args を持つ | `NoDeadEnd` | 独立した仕様（下記） |
| 5 | 弱め: 違反が見えている性質を弱めた試行は、touched に関係なく `redefined` に載る | `RedefRecorded` | 写し（回帰検出器） |
| 6 | 段 8 の形式検査の違反は、パスが残っていれば段 9 の gate で終端にせず段 7 へ戻す | `ReportNeverBlocks` | 独立した仕様 |
| 1・3 | 持ち越した問いで段 4 へ戻り初稿を書き直しても、それまでに消えた違反は done の `unconfirmed` に載る | `CompleteSound`（`DeferredGate` → `Redraft` を含む経路） | 半ば写し |

「open・tried が残ったまま」は「最後の監査の版の検査でまだ破れている」と読む。done の時点でも `open` は前の巡の違反を持ったままで
（`prd-spec.js:2876` は `tried` だけを書き換える）、それ自体は破れではない。

`HonestDone` が `droppedSeen` を除くのは、保守的に報告する設計の帰結である。改稿した項目の違反がこの巡の試行でまた破れ、後の試行で modeler
が正当にその項目を外すと、その違反は消えた tried の違反として `unconfirmed` に載る（外したのが正当かは機械で確かめられないため）。
正直な run でもこの経路の done は `unconfirmed` を持つ（目撃 `WitnessHonestDrop`）。行き止まりにならないことは `HonestNoDefect` が受ける。

`HonestNoDefect` は「パスが残っていれば続けられる」の安全性による近似である。正直な試行が偽の欠陥を受けなければ、rework の切れは本物の
モデルの欠陥だけから起きる。進行性（いつか done に届く）は検査していない（公平性を置かない。下記）。到達は目撃 `WitnessHonestDrop` で
1 本だけ確かめた。

`CompleteSound` の ghost `lost` は「観測された違反が、その文書の改稿を挟まずに後の確定した検査で消えた」を数える。改稿を文書の単位で数える点
（同じ文書の別の項目の改稿でも消えてよいとする）は実装の規則（`prd-spec.js:2866-2868` のコメント）の写しで、独立した仕様ではない。
`RedefRecorded` の ghost `live`（前の巡の確定した違反とこの巡の試行の違反）は doc_check に渡る prior の窓の写しで、touched を読まない点だけが独立している。

`NoDeadEnd` の「続けられる」は止まった原因で決め、next_args の有無では決めない（有無で決めると恒真になる）。分類の正本は
`plugins/workflow/skills/prd-spec/references/workflow-io.md` の stop_reason の表で、モデルの `cls` は次のとおり。

- 続けられる（`resumable`）: agent の無応答・`rerunStage`（`AgentFail`、試行の stdout が届かない `lose`）、段 5・8 の `formal_unchecked`（`Attempt` の rework 切れ）、`needs_answers`（`NeedsAnswers`、持ち越した問いの `DeferredGate`）
- 設計上の終端（`terminal`）: `formalGate`（段 7・9）、`finalHold`（段 8 の pass 上限）

## 対応表

実装の行は作業ツリーの今の版のもの。テストは `plugins/workflow/skills/prd-spec/tests/` の下。

| 不変条件・変異 | 実装の箇所 | その箇所を動かす既存テスト |
|---|---|---|
| `GateSound` | `prd-spec.js:3041`（段 7 の gate）、`prd-spec.js:3257`（段 9 の gate）、`prd-spec.js:3149`（段 8 の `audit.fm`） | `test_prd_stages.py:5230` 形式検査の指摘が残る間はdoneにならない、`:5285` 段7は…段9へ進まない、`:5306` 段9から再開しても…、`:5277` 裁定済みの再出でも… |
| 変異 `no_formal_gate`（段 7 と段 9 の `fm === 0` を両方外す） | `prd-spec.js:3041`・`:3257` | 同上 |
| `ReportNeverBlocks` | `prd-spec.js:3149` 以降（段 8 が形式検査の違反を blocking に数え、`:3187` で段 9 へ進まず段 6 へ戻す） | `test_prd_stages.py:5230` |
| 変異 `fm_not_blocking`（段 8 で形式検査の違反を blocking に数えない） | `prd-spec.js:3149` 以降 | `test_prd_stages.py:5230` |
| `CompleteSound` | `prd-spec.js:2869-2874`（vanished と unconfirmed）、`prd-spec.js:2642`（段 4） | `test_prd_stages.py:5338`、`:5347`、`:5353`、`:5378`、`:5416` |
| 変異 `any_doc`（どれかの文書に diff があれば消えてよいとする） | `prd-spec.js:2816`・`:2871` の `revisedDoc` | `test_prd_stages.py:5428`（別の文書だけを改稿して…） |
| 変異 `open_not_counted`（前の巡の違反の消失を数えない） | `prd-spec.js:2871` の `formalOf('open')` | `test_prd_stages.py:5378` |
| 変異 `tried_not_counted`（この巡の試行の違反の消失を数えない） | `prd-spec.js:2871` の `formalOf('tried')` | `test_prd_stages.py:5347`、`:5353`、`:5396` |
| 変異 `rerun_entry_formal`（やり直しの state を段の入口の formal で上書き） | `prd-spec.js:1005-1010`（`withFormal`・`rerunArgs`） | `test_prd_stages.py:5460` 同じ段の再実行は…、`:5385` 段8の再実行は…（q3） |
| 変異 `reset_on_rerun`（同じ巡のやり直しでも tried を open に確定させる） | `prd-spec.js:2811` の `state.formal.at !== round` | `test_prd_stages.py:5385` |
| 変異 `redraft_clears`（段 4 で `state.formal` を全て捨てる。直す前の実装） | `prd-spec.js:2642` | `test_prd_stages.py:5416`（持ち越した問いで初稿を書き直しても…） |
| `HonestDone` | `prd-spec.js:2816`・`:2869-2872`（文書の単位の判定） | `test_prd_stages.py:5364` 性質の項目の片方か別の項目を直して…（q1） |
| 変異 `item_level`（改稿を項目の単位で数える） | `prd-spec.js:2871` の `revisedDoc` を `revisedOf` 相当にする | `test_prd_stages.py:5364` |
| `HonestNoDefect` | `prd-spec.js:2819`（`revisedOf`: 前の巡の違反 ∩ 改稿した項目）、`doc_check.mjs:4712`（`violated_dropped`） | `test_prd_stages.py:5396`（改稿した前の巡の違反は同じ巡の試行で破れても --revised のまま）、`:5407`（この巡に初めて破れた違反は --violated）、`test_doc_check_formal.py:488` |
| 変異 `tried_strict`（改稿した項目でもこの巡の試行で破れたら `--violated` に落とす。直す前の実装） | `prd-spec.js:2819` | `test_prd_stages.py:5396` |
| `RedefRecorded` | `doc_check.mjs:4746`（`prior = [...strict, ...revised]`）、`doc_check.mjs:4817-4819`、`prd-spec.js:2819`（`--revised`）、`prd-spec.js:2842` | `test_doc_check_formal.py:497`（a9）、`:460` |
| 変異 `prior_strict_only`（`--revised` で渡した違反を prior から外す） | `doc_check.mjs:4746` | `test_doc_check_formal.py:497` |
| `NoDeadEnd` | `prd-spec.js:968-991`（`finish`）、`:1010-1011`（`blocked`）、`:2241-2249`（`needs_answers` と持ち越した問いの `from: 3a`）、`:2879`（`formalStop`） | `test_prd_stages.py:5639` 上限を超えてもnext_argsを返し…（q2）、`:6281`、`:5460` |
| 変異 `omit_big`（大きい next_args を省く） | `prd-spec.js:968-991`（`finish`）。5 巡目の改稿で取り除いた「8000 字を超えた next_args を外す」分岐の戻しで、今の版には無い | `test_prd_stages.py:5639` |

変異は全て `check.test.mjs` が TLC で走らせ、狙った不変条件の名前で反例が出ることと、反例が初期状態から出ることを確かめる。

### 生き残る変異（等価変異）

- 段 9 だけ・段 7 だけの gate を外す変異は `GateSound` を破らない（もう片方が同じ条件で止める）。`no_formal_gate` は両方を外して初めて殺せる。
- `fm_not_blocking` は `GateSound` については等価（段 9 の gate が止める）だが、止まり方を変える（パスが残っていても段 9 で終端の blocked
  になる）。等価ではないので `ReportNeverBlocks` を足して殺した。

### 目撃

- `WitnessFixDone`: 違反 → 改稿 → 解消 → done（忠実な modeler で、`unconfirmed` が空のまま）
- `WitnessBlockedViol`: 試行の違反を持ったまま blocked で止まる
- `WitnessHonestDrop`: 忠実な modeler が、この巡の試行で破れた改稿済みの項目を後の試行で外し、done に届く（N1 の経路。直す前の実装では
  全数探索で到達しなかった）
- `WitnessRedraftDone`: 持ち越した問いで段 4 から書き直した run が、`unconfirmed` を持ったまま done に届く（B1 の経路）

どれも到達の否定を不変条件にし、反例が出ることで到達を確かめる。

## 抽象化と有限範囲

- 文書は 2 つ（`d1` は項目 `a`・`b`、`d2` は項目 `c`）、性質は文書ごとに 1 つ。`d1` の忠実な違反は項目 `a` に出て、改稿は `b` に入れられる（q1 の形）。
  文書を 2 つにしたのは、別の文書の改稿で違反が消える経路（変異 `any_doc`）を殺すため。
- token は `doc:item` に丸めた。性質の名前・closure digest は持たず、定義は「強い／弱い」の 2 値で、弱い定義は違反を出さない。
  したがって性質ごとの `redefined` の区別（同じ文書の別の性質）は確かめていない。
- 文書の中身は「違反を許すか」（`bad`）の 1 ビットに丸めた。改稿は touched した文書の `bad` を任意に変える（直す・直さない・壊す）。
- modeler の 1 試行は、文書ごとの定義（強・弱）・違反を隠すか・形の欠陥（TLC を回さない）・モデルの欠陥 0/1・照合役の「導けない」を非決定に選ぶ。
  欠陥の件数は 0〜1 に丸め、rework の停滞は「件数が前の試行より減らない」で写した。
- `tree_digest` の不一致、modeler が skill を呼べない、TLC が無いは、どれも `formal_unchecked` で段からやり直す止まり方なので `AgentFail` にまとめた。
- 段 6 と段 7 は 1 つの段 7 にまとめ、改稿（`Revise`）・改稿の対象なし（`NoTargets`）・問い（`NeedsAnswers`）・持ち越した問いの最初の
  ゲート（`DeferredGate`）・失敗だけを残した。段 8 の形式検査以外の blocking は非決定の 1 ビット。段 1〜3b は持たない。持ち越した問い
  （`state.deferred`、`prd-spec.js:2241-2249`）は初期状態の非決定の 1 ビットにし、最初のゲートで 3a から段 4 へ戻る経路を `DeferredGate`
  → `Resume` → `Redraft`（段 4 の書き直し。`bad` を任意に選び直す）で写した。3a の反映は写していない。
- 段 4 で捨てるのは `at`・`open`・`tried`（書き直した初稿の項目は別物で、持ち越すと直した文書の違反が消えたと数え `HonestDone` が破れる。
  `open`・`tried` を残す版は 10 状態の反例で破れた）。`unconfirmed`・`redefined` は run の事実として持ち越す（捨てると `CompleteSound`・
  `RedefRecorded` が破れる）。実装は `dropped` も持ち越すが、モデルは `dropped` を持たない。
- modeler が性質から外す（`drop`）のは `d1` の、writer が改稿した項目だけに丸めた（改稿していない項目を外すのは隠すのと同じ効き目で、
  `hide` が受ける）。`d2` にも許すと状態数が倍になる。doc_check の `violated_dropped` は「strict で渡した違反の項目を外した」で写した。
- `HonestDone` の範囲の外にもう 1 つ経路がある。formal-trace-check が導けないとした偽の違反を、modeler が正直にモデルを直して消すと、
  その違反は消えた tried の違反として `unconfirmed` に載る（`v5-model/C.tla`）。モデルの `und` は件数に足すだけで、偽の違反と本物の
  違反を区別しないので、この経路の `unconfirmed` は保守的な報告として範囲の外に置いた。
- 有限範囲: `Passes`（`MAX_AUDIT_PASSES` の代わり）、`ReworkLimit`（`MAX_CHECK_REWORK` の代わり）、`MaxStops`（やり直しの回数）。
  値は `FormalLoop.cfg` が正で、どれも実装の上限より小さい。`Passes` は 1 にした（2 では基の探索が 143〜180 秒かかり、make test に載せる
  には長い。1 でも段 8 から段 7 へ戻る経路は通り、`ReportNeverBlocks` を殺す反例は作れる）。性質はどれも「1 回の改稿・1 回のやり直し・
  1 回の再試行」で反例が作れる形をしていて、殺した変異の反例は全て 11 状態以内に収まる。2 パス以上が要る反例と、上限を実装の値にした
  ときの全数探索は実測していない（未検証）。
- 公平性は置かない（進行性の性質を持たない）。止まった後の再開は環境の行動で、起きるとは仮定しない。行き止まりの無さは `NoDeadEnd`
  （止まり方ごとの next_args）と `HonestNoDefect`（偽の欠陥が無い）の安全性で近似し、done への到達は目撃でだけ見た。

## 形式化しなかった性質

- modeler が忠実か（モデルが文書を正しく写すか）。意味の妥当性で、機械の整合では決まらない。モデルでは非決定の選択として外から与えた。
- `formal-trace-check` の「導けない」の判定の正しさ。agent の申告で、モデルでは非決定の 1 ビット。
- `--revised` で渡した項目を性質から外したときの `dropped` の記録、`--violated` の項目を外したときの `violated_dropped` 欠陥。項目と性質の対応を
  持たない抽象化なので外した。`test_doc_check_formal.py:487`・`:534` と `test_prd_stages.py` の「改稿の後に性質から外した項目は…」が見ている。
- next_args の字数の上限、`resumable` の値。`NoDeadEnd` は next_args の有無だけを見る。

## 宣言する穴（実装の破れではない）

`StdoutLoss = TRUE` にすると `CompleteSound` が破れ（8 状態の反例）、`RedefRecorded` も破れる（6 状態の反例。届かなかった試行の
`redefined` も `state.formal` に載らない。`v5-model/B.tla`）。

1. 段 8 の試行で doc_check が違反を判定し、試行の番号を進める。
2. flow-check の stdout が workflow に届かない（`prd-spec.js:2836` の round の照合で `rerunStage`）。`setFormal('tried')`（`:2841`）・`setFormal('redefined')`（`:2842`）より前なので、違反も定義の変更も `state.formal` に載らない。
3. next_args で段 8 をやり直す。最初の試行には番号の照合が無い（`:2839` は `attempt !== null` のときだけ）ので、飛んだ番号に気づかない。
4. modeler が違反を隠すモデルを書くと、違反は消え、`unconfirmed` は空のまま done になる。

基盤の失敗（stdout が届かない）と忠実でない modeler が重なって初めて起きるので、正直な run の破れではない。再現は
`FormalLoop.cfg` の `StdoutLoss = FALSE` を `TRUE` にし、`INVARIANTS CompleteSound`（または `RedefRecorded`）で TLC を回す。test には入れていない
（実装を直しても手で写したモデルは赤のままなので、緑の期待にすると何も見張らない）。

## formal-methods の手順の辿り方

- step 1・2: 性質は brief の 5 件を走査元にし、上の「形式化しなかった性質」に外したものを理由つきで置いた。6 巡目に、検証役が見つけた
  段 4 の経路（B1）・正直な run の行き止まり（N1）・等価でなかった `fm_not_blocking` から `ReportNeverBlocks`・`HonestNoDefect` と
  `CompleteSound` の経路（`DeferredGate`・`Redraft`）を足した。直す前の実装を写したモデル（`redraft_clears`・`tried_strict` を常に真にした版）で
  `CompleteSound`（11 状態）と `HonestNoDefect`（7 状態）の反例を出してから実装を直し、二つを変異として残した。
- step 3・4: 上の「抽象化と有限範囲」。
- step 5: 対応表は上のとおり。節のハッシュ照合による固定はしていない。対象は文書の節ではなく `prd-spec.js`・`doc_check.mjs` の関数で、
  行番号もハッシュも 1 行の編集でずれる。代わりに各変異を実装の 1 箇所の戻しにして対応表で名指しし、実装の変更は `test_prd_stages.py` 側の既存テストが受ける。
- step 6・7: `check.test.mjs`（基・変異・目撃）。生き残る変異は上の「生き残る変異」に記録した。
- step 8: この README。
- スキルの「未定」: 実行形態は単独の手順として回した（このモデルは skill の create・update の外の対象）。合成の契約の書式は、doc_check を
  「prior と定義から redefined を返す」関数として 1 行に写し、それ以外の doc_check の判定は非決定の選択にした。取り込み候補は採らなかった。
