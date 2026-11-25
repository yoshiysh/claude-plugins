# prd-spec.js の入出力と再実行（workflow-io）

**目次**: [1. args](#1-args) · [2. model と effort の既定](#2-model-と-effort-の既定) · [3. 返り値と再実行](#3-返り値と再実行) · [4. 段と起動の条件](#4-段と起動の条件) · [5. 本流から外れた状態](#5-本流から外れた状態) · [6. doc_check の CLI](#6-doc_check-の-cli)

`workflows/prd-spec.js` は段の順序・起動の条件・上限・返り値の検査だけを持つ Workflow script である。ファイルを読めない
ので、分岐に使う値（件数・ID・digest）はすべて agent の返り値から受け取り、`next_args.state` に載せて
返す。本体（flow・台帳・文書）は W にだけ置き、state には flow.json の内容の sha256（`flow_digest`）のような digest を載せる。各 agent が読み書きするファイルの形は `schemas/agent-contracts.md` を正とする。

## 1. args

| args | 意味 |
|---|---|
| `workspace` | W の絶対パス（S0 で作ったもの） |
| `skillDir` | このスキルの絶対パス。agent が Read する役割ファイルと、契約の節を出す doc_check のパスはここでしか決まらない |
| `entry` | `new` / `existing` / `expand`。既存文書の監査と改訂は `existing`（SKILL.md の S0 の表） |
| `existing_docs` | `existing`・`expand` のとき必須。`new` でも、保存先にある他の文書を固定の文書として置くときに渡す（SKILL.md の S0 の 4）。`[{ key: "<kind>/<topic>", source: "<元のパス>", fixed: true \| false }]`。本文は W に置いてある。`next_args` には、`source` を書き換えてよい文書の分だけ写す（保存の段が改訂した文書をそこに書き戻す。固定の文書は保存しないので写さず、字数を空ける）。`key` が文書のキーの形（`prd-spec.js` の `DOC_KEY`）でないか `fixed` が真偽値でなければ、run は agent を起動する前に止まる（`key` は段 1 の入口の reset のコマンド文に入る） |
| `from` | 始める段（省略時 `1`）。`1` / `2` / `3` / `3a` / `3b` / `4` / `5` / `6` / `3a'` / `7` / `8` / `9` |
| `state` | `from` が `1` 以外のとき要る。前の run の `next_args` ごと渡す（§3） |
| `role_opts` | 任意。役割ごとの `{ model, effort }` の上書き（§2） |
| `formal` | 任意。`false` だけを受け付ける。付ける条件は SKILL.md「## 中継」の最初の呼び出しの項にだけ書く。`false` なら段 5・8 で形式検証を依頼せず、`skipped` に `formal_unavailable` を足し、返り値に `formal_off` を持つ。`next_args` に写り、途中で変えない（`state_hash` に数えるので、変えた `next_args` は agent を起動する前に止まる） |
| `gates_answered` | 任意。`{ <ゲート（`g1`〜`g<MAX_GATES>`）>: [<そのゲートの needs_answers の question_ids>] }`。形が違えば agent を起動する前に止まる。いつ何を足すかは SKILL.md「## 中継」の「呼び直し」が正。ゲートを越える条件は prd-spec.js の `needsAnswers`。`next_args` には載らず、`state_hash` にも数えない |

args は JSON の値（オブジェクト）で渡す。JSON を文字列にした args を受けると、run は agent を起動する前に止まる（呼び出し側の誤りを黙って救わない）。

**司令塔が args に打ち直すのは ID・件数・digest に限る。** 本文や本体の JSON は W に置き、args にはそのパスか
digest を載せる。司令塔は args と `next_args` を打ち直して渡すので、本体を載せると、打ち直す量と写し間違いの機会が
その大きさに比例して増え、写し間違いがそのまま次の段の入力になる（実測: 2026-09-27 の試走で、next_args の 61〜85% が
prd-spec.js のどこからも読まれない `state.flow` だった）。依頼文を args に入れず `W/input.md` に置くのも、この規則の 1 つの例である。
script が本体の中身を確かめる必要があるときは、本体を運ばずに、生成者と別の agent がそれぞれ実行した doc_check の
stdout の digest を突き合わせる（flow は `doc_check flow` の `content_sha256`）。

## 2. model と effort の既定

省略するとセッションの設定（xhigh など）を継承し、全呼び出しが最重量で走って利用上限に達した実測がある。
だから全役に既定を置く。`args.role_opts` で上書きでき、未知の役割名・model・effort は run を止める（黙って
既定に落ちると、指定したつもりの配分が効かない）。役ごとの既定の値とその理由は `prd-spec.js` の `ROLE_OPTS` が正で、`role_opts` の
キーもそこの役割名である（表に写すと、値を直したときに片方だけが古くなる）。この文書の intake・flow-framer・resolver は planner の仕事の名前（intake は仕分け、flow-framer は流れ、resolver は裁定）、verifier は plan reviewer の呼び出しで、呼び出しの種類と役の対応は `prd-spec.js` の `ROLE_OF`・`JOB` が正である（planner の呼び出しは、プロンプトの「仕事:」の行で agents/planner.md の節を指す。`planner:<…>` の起動は複数の仕事を続けて行う）。`model` は `haiku`・`sonnet`・`opus`・`fable`・
`claude-` で始まる完全な model ID・`inherit`（その役の model を外し、セッションの model を継承させる）、`effort` は `low`・`medium`・`high`・
`xhigh`・`max` を受ける（Workflow の `agent()` が受ける値。`prd-spec.js` の `MODELS`・`MODEL_ID`・`EFFORTS`）。

## 3. 返り値と再実行

```json
{
  "status": "done | needs_answers | needs_formal | blocked",
  "questions_path": "needs_answers と、stop_reason が upstream_gap の blocked のとき W/questions.md（司令塔が doc_check questions で導出してから見せる）",
  "questions_json_path": "needs_answers と、stop_reason が upstream_gap の blocked のとき W/questions.json（選択式で出すための同じ問い）",
  "gate": "needs_answers のときそのゲート（開いた順に g1・g2・…。MAX_GATES まで）",
  "answers_path": "needs_answers のとき W/answers/<gate>.md",
  "question_ids": ["RS-004"],
  "report_path": "done（段 5 の low_only で飛ばしたときを含む）と、stop_reason が pass_limit か no_progress の blocked のとき W/report.md（司令塔が doc_check report --findings \"<unreflected>\" で導出してから見せる）",
  "unreflected": ["report_path を返すとき、本文に反映していない指摘の ID の全件（blocking によらない。route が decision で blocking でない指摘を含み、退けた指摘と既裁定の再出は含まない）。report.md の「本文に反映していない指摘」の節の材料"],
  "remaining_blocking": ["stop_reason が pass_limit か no_progress の blocked のとき、本文に反映されていない blocking の指摘の ID（hold の文案にしたものを含む）"],
  "carried_blocking": ["stop_reason が pass_limit か no_progress の blocked のとき、remaining_blocking のうち最後のパスの監査が出したのではなく前のパスから持ち越した ID"],
  "doc_blocking": "stop_reason が pass_limit か no_progress の blocked のとき、残った doc_check の blocking の件数",
  "formal_request": "needs_formal のとき { rid, request_path, request_digest, cwd, units, goals }。request_path（W/fm/<rid>/request.json）は formal-method の依頼、cwd（<W>.formal）は formal-method の start の cwd。司令塔の手順は SKILL.md「## 中継」",
  "formal_off": "args.formal が false の run だけ true。true なら、司令塔が doc_check report に --formal-off <理由>（最初の呼び出しで formal-off に渡した理由）を付ける（SKILL.md「## 保存と事後報告」）",
  "next_args": "needs_answers と、needs_formal と、やり直せる blocked のとき。次の run の args（渡し方は下の 1 つ目の項）",
  "tree_digest": "最後の監査が見た木の digest（done のとき）",
  "open_tbd": ["開いている TBD の ID"],
  "holds": ["本文に反映した保持規則の resolution の ID（writer に渡したもの）"],
  "hold_drafts": ["文案だけで本文に無い保持規則の resolution の ID（輪を出た後に resolver が作ったものなど。remaining_blocking の指摘と対になる）"],
  "missed": ["渡したのに裁定されなかった論点（finding:… / tbd:…）"],
  "integrity": ["sha256 の照合で食い違った事実"],
  "notices": ["照合ではない所見（監査の時点で W に所有表に無いファイルがあった、など）"],
  "undeclared": { "requirements/auth": ["writer が申告せずに変えた項目キー（監査の範囲に足したもの）"] },
  "stop_reason": "改稿と監査の輪を収束せずに出た blocked のとき `pass_limit`（MAX_AUDIT_PASSES に達した。延長のパスの後に残ったときと、延長の段 6 が問いを出さなかったときも）か `no_progress`（進展なし）、token の目標（Workflow の budget.total）に達して agent を起動できずに止まった blocked のとき `budget`（next_args が付く。目標を上げてから渡す）、仕様書だけを書く run（定義は schemas/agent-contracts.md「## 現物と既存実装の扱い」）で要求の論点の問いが出た blocked のとき `upstream_gap`（固定の要求文書の抜けなので、聞いて仕様書に書かない。最初のゲートの前に出た問いは持ち越して初稿と監査を続け、初稿の監査の裁定（段 6）で止まる。最初のゲートの後は、要求の論点の問いが出た段（3a・3b・3a'・段 6。延長の段 6 を含む）の終わりで、聞ける回数と next_args の字数の上限によらず止まる。question_ids に、それまでの段で出た要求の論点がまとめて載り、仕様の論点の件数は reason に載る（§4 のゲートの行）。要求文書を直すと固定の文書が変わるので next_args は付かない）。それ以外は null（値の集合は prd-spec.js の STOP_REASONS）",
  "passes": "改稿と監査のパスの数（監査は網羅の r1 と範囲の再監査の r2 の 2 回で、改稿のパスは 1。prd-spec.js の MAX_AUDIT_PASSES）。§4 の段 8 の延長があれば 2",
  "item_routes": { "requirements/auth#PR-AUTH-003": "再発で裁定に回した項目の経路（decision）" },
  "skipped": [{ "step": "起動しなかった agent の label（verifier:3a'v など）", "fact": "外した事実の符号: `unchanged`（候補の選択だけの回答）、`low_only`（監査 r1 の指摘が blocking を含まず、段 6〜8 を飛ばした。step は飛ばした 2 巡目の最初の writer reviewer）、`no_formal_target`（段 5・8 の formal-request の送る単位が 0。step は formal-method:<rid>）、`formal_unavailable`（args.formal が false。step は formal-method）（値の集合は prd-spec.js の SKIP_FACTS）", "ids": ["根拠の ID（unchanged は候補の選択で当たった回答、low_only は残した指摘。形式検証の 2 つは空）"] }],
  "reason": "blocked のときの理由。needs_answers でも、gates_answered の問いが今の問いと違ったときと、回答のファイルの検査に落ちたときはその理由",
  "resumable": "resumeFromRunId で呼び直して進むか。needs_formal は false（next_args で呼び直し、入口の flow-check が取り込みを照らす）。needs_answers は回答のファイルの検査（flow-check の doc_check answers）に落ちたときのほか true、blocked は next_args があり、結果を返さずに終わった agent があるか stop_reason が budget のときだけ true（完了した agent は resume で保存された結果を返すので、それ以外の blocked は同じ所で同じ理由を返す）"
}
```

- **`next_args` は完成形で、司令塔は変えずに渡す。** SKILL.md とこの文書で「`next_args` を渡す」と書いたところは、すべてこの規則による。
  回答は `answers_path` に逐語で書き、`next_args` には入れない。変えてよいのは run のデータではない環境の欄の
  `skillDir`（plugin の更新で版のパスが変わる）と `role_opts`（レート制限などで役の配分を変える）だけである（`prd-spec.js` の `ENV_ARGS`）。
  `state_hash` はそれ以外の欄すべての hash で、合わなければ（打ち直しでどれかの値が変わった）run は agent を起動する前に止まる。
  最上位の欄の空の配列・オブジェクトは、欄が無いのと同じに扱う。`state` は plain JSON で、Map・Set を含まない（runtime の境界を越えると中身が失われる）。
- **呼び直しは resume か `next_args`**（使い分けは SKILL.md「## 中継」の「呼び直し」が正）。`next_args` の経路では、状態は W のファイルと
  `state` にあり、prd-spec.js は段の境界ならどこからでも始められる。どの段から始めるかは `next_args.from` が決める。`from` ごとに要る `state` の値が無ければ run は最初に止まる（`prd-spec.js` の `REQUIRES`）。
  resume（本家の Workflow の `resumeFromRunId`）はセッションを跨がないので、ゲートで回答を待つ間にセッションが閉じても `next_args` で続けられる。
- **`blocked` の `next_args`**: agent の返り値が無かった（Workflow の `agent()` の null。利用者がその agent を止めたか、runtime が出し直した後も
  API エラーだった。script からはどちらか区別できないので、どちらでも出し直さない: 利用者の停止を覆し、API エラーは runtime が既に出し直している）とき、
  `agent()` が予算以外の例外で終わったとき（runtime の側の失敗。script が作ったプロンプト・schema・opts の誤りは `agent()` の前に止め、§5 の
  script の欠陥として扱う。`reason` に例外の文が載る。改稿の輪を出た後の `resolver:final` だけは、返り値が無いときと同じく止め直さない）、
  返した doc_check の stdout が差し戻しの後も不合格だったときは、その段からの `next_args` が付く。返り値の無い agent は「指摘 0 件」にしない。
  セッション上限なら解除してから呼び直す（SKILL.md「## 中継」の「呼び直し」。以下も同じ）。token の目標（`budget.total`）に達したときは `stop_reason: budget` で止まり、段の途中ならその段から、段の境界なら
  次の段からの `next_args` が付く（目標を上げてから呼び直す）。
  `next_args.state` はその段に入った時点の state（段 1 は空。下の段 1 の項）で、段の途中で足した値（候補の選択で当たった回答・形の検査に落ちた問い・
  integrity の行）を持ち越さない。ただし入口（`enterFromDisk`）で W の flow.json の版を採ったときは、その版と integrity の 1 行を段に入った時点の state に
  入れる（入れないと、再実行が古い版を運び、入口が同じ食い違いを数え直す。入口の検証の合否は入れない: restore が台帳ごと戻す）。持ち越すと、再実行が止まらなかった run と違う状態から始まる。W の台帳も、再実行の入口の
  restore（次の項）で段に入った時点に戻る。`state.tx` に戻す token（`restore`）・その段の何回目の再実行か（`try`）・止まった run が
  最後に照合を通した flow の版（`flow`。段に入った時点の版と同じなら無い）が付く。
  監査の基準の digest が合わない・改稿と監査の輪を収束せずに出た（`stop_reason`）・その段に flow を書く生成者がいないのに flow.json が
  生成者の検査した版から変わっていた・段の入口の flow に不合格の要素があった（3b（prd-spec.js の `REFLECT_STAGE`）の入口だけは、3a が渡した検証の裁定を持つ不合格の要素を受け入れる。§4 の 3a の行）・段の出口の不変条件に反した（§5）、
  のように、同じ段をやり直しても変わらないときは付かない。段の入口の不合格は、その前の段が不合格の要素を持って出られない（§5。3a から 3b へ渡すものだけが例外）ので、
  所有表の外の書き込みである。司令塔は `reason` の要素と `W/verifications.json` を依頼者に示し、W を戻すか S0 からやり直すかを決めてもらう。
- **段の書き込みは token ごとの取引にする。** script は段に入るたびに token（`prd-spec.js` の `txToken`。`t<段の通し番号>` と、同じ段の再実行の
  `r<回数>`。state から決まり、nonce を含まない。nonce にするとプロンプトが run ごとに変わり、キャッシュが効かない）を決め、台帳を書く役の
  プロンプトに載せる。doc_check の put・del は token ごとに、その台帳の最初の書き込みの前に控えを取る（契約の所有表の `tx/<token>/*`）。
  新しい token の最初の書き込みはそれより前の token の控えを消すので、段を出た後の run は済んだ段より前へ戻せない。後の token の控えが
  あれば、前の token（止まった run の遅れた書き込み・打ち間違い）の put・del は何も書かずに止まる（通すと、今の段の再実行が戻す控えを消す）。
  blocked の `next_args` で同じ段からやり直す run だけが
  （`state.tx.restore` があり、`state.tx.stage` が `from` と同じとき）、入口の flow-check（`<from>-entry`）で `doc_check flow` の前に
  `doc_check restore --token <state.tx.restore>` を実行させ、止まった run の台帳の書き込みを取り消す（token の下で作られた台帳は消す。
  answers・plan.json・checks は戻さない）。文書の本文は writer が Edit で書き、doc_check を通らないので、段 4・7 の writer はどれも最初のコマンド
  （Write・Edit・put より前）で `doc_check backup --doc <全単位の文書のキー> --token <段の token>` を実行して本文の控えを取り、stdout を返し、
  入口の restore が台帳と一緒に本文を戻す。戻さないと、止まった run が途中まで書いた本文が再実行の入力になり、`expand` では S0 が置いた既存文書の
  原文が W から失われる。全文書を各 writer が控えるのは、同じ token・同じファイルの 2 回目の控えは何もしないので、どの文書も最初に書いた writer の
  控えが段の入口の本文になるからである（単位の文書だけだと、並列の別の writer が先に書いた文書や単位の外の書き込みが戻らない）。script は
  返った stdout の控えの digest（`digests`・`entry_digest`・`tree_digest`）を段の入口の本文と照らし（最初の段 4: existing_docs に無い文書が無く
  `entry_digest` が `state.entry_digest` と同じ。段 7 と、最初のゲートの後に書き直す段 4: `tree_digest` が `state.audit.digest` と同じ）、
  違えば `integrity` に 1 行足して段を進める（控えが要るのは同じ段の再実行だけ）。段 4・7 の同じ段の再実行の入口では、restore の stdout の
  戻した後の文書の digest を同じく照らす。欄が無ければ同じ段から、違えば戻らない本文の上で検証も改稿も回さずに止まる（最初の段 4 で新しく
  生まれた文書だけが違えば段 1 の reset が消すので段 1 から、それ以外は `next_args` を付けない。reset は既存の文書の本文を残すので S0 から）。restore の stdout が
  返らなければ、同じ token を戻させる `next_args` で止める（restore は何度流しても同じ結果になる）。戻す控えが後の段の token（通し番号が大きい。
  打ち間違えた token か古い `next_args`）の最初の書き込みで消えていれば、restore は何も変えずに stdout の `pruned_by` にその token を挙げ、
  run は `next_args` を付けずに止まる（W を段の入口に戻せないので、同じ `next_args` では同じ所で止まる。S0 からやり直す）。restore の前の
  flow.json が、止まった run が最後に照合を通した版（`state.tx.flow`。flow を書く役のいる settle を持つ段だけに付く）と違えば
  `integrity` に 1 行足す。needs_answers の `next_args`・次の段の run には `restore` が付かないので restore しない。
- **段 1 から始める run は、W を S0 の直後に戻してから始める。** 新しい run も、段 1 からの再実行も、入口の flow-check（`1-entry`）に
  `doc_check reset --keep <existing_docs の全部のキー> --fixed <existing_docs の fixed のキー>` を実行させ、その stdout（残した文書と固定の文書の
  キーが args と一致し、固定の文書ごとの `fixed_sha256` があるもの）を受け取るまで planner を起動しない。`fixed_sha256` は先頭 12 桁だけを、固定の文書のキーの辞書順の配列にして
  `state.fixed_sha` に入り（キーと全桁の組で持つと、固定の文書の数だけ next_args の字数を使う）、段 5・8 の監査の snapshot（`--fixed`）が返す値の先頭 12 桁と照合する。違えば固定の文書を誰かが書き換えたので（固定の文書の書き手はいない）、`integrity` に
  1 行足して `next_args` を付けずに止まる（どの段からやり直しても W の本文は戻らない。本文を S0 で置いた元の文書から `doc_check place` で置き直して段 1 から）。
  `state.fixed_sha` の形（配列・長さが固定の文書の数・空でない文字列）が合わない `next_args` は、agent を起動する前に止まる。reset は S0 が書いたもの（依頼文・先例の一覧・`existing_docs` の文書）と
  所有表の外のファイル・`tmp/` を残して段の書き込みと `--keep` に無い文書を消し（消すものの正本は doc_check の `wsReset`）、固定の文書の
  meta を書き直す。S0 が place で置いた `<kind>-<topic>.tbd.json`（保存した文書の開いている TBD）は、その文書の meta の `tbd` に写し、文書のキーごとの ID を stdout の
  `carried_tbd` に出す。prd-spec.js はそれをすべて `open_tbd` に入れ（writer の返り値だけから数えると、writer を起動しない文書の TBD が保存の
  INDEX から消える）、固定でない文書のものは `new_tbd` にも入れて段 6 の裁定に回す（回さないと閉じる経路が無い）。`--keep` に無い文書を消すのは、S0 が置くのは `existing_docs` の文書だけで、それ以外は前のランの writer の文書だからである
  （同じ W で S0 からやり直すと、meta の無いまま INDEX に載り、同じ topic の単位の writer に前の草稿が渡る）。put はキー単位で足すので、戻さずに始めると前のランや止まった段 1 の
  要素と欄（仕分けが付けた D- の kind・quote、止まった planner が足した O-）が再実行の書き込みの後にも残り、前のランの後の段の token の
  控えは新しい run の t1 の書き込みを拒む。answers も消すのは、段 1 が回答を読まず、新しい run は RS- を振り直すので、残った回答の ID が
  別の問いを指すからである。段 1 への `next_args` は `state` を持たない（止まった run の state を運ぶと、戻した W と食い違う）。
- **再実行は、戻す token と別の token で書く。** 再実行の書く token は `try` で変わり、戻す token（前の回の書く token）と一致しない。
  resume は元の run の args で呼び直すので、restore が入口のプロンプトに載るのは、元の run が `next_args` による同じ段の再実行だったときだけで、
  その入口の flow-check は完了していれば保存された結果を返し、restore を実行しない。入口の flow-check が結果を返さずに終わっていて live で
  走り直しても、その run 自身の書き込みは戻らない: 戻す token の控えは、最初の restore が消したか、その run の最初の書き込みが消している
  （実物の doc_check は `tests/test_ledger.py` が押さえる）。一方、プロンプトが変わって入口の agent が live で走り直すと、段を出た後まで進んだ run では
  restore が後の段の token の `pruned_by` で止まり、段 1 の入口の reset は W を S0 の直後に戻す。
- **段 3 以降から始める run は、最初に W を読み直す**（`prd-spec.js` の `enterFromDisk`）。`from` が 3a・3a' の入口は flow の後に `answers` も
  実行し、回答を当てる段はその stdout を使う（入口が `answers_check` を返さなかったか、入口の後に回答待ちの問いが変わってゲートか ID が合わなければ `<ゲート>-answers` を単独で起動する）。W の台帳は、同じ段の再実行では restore で
  `next_args.state` と同じ段の入口の版に戻り、needs_answers の再開では前の run が段を出たときのまま（answers だけが増える）なので、
  W を state に写し直すことはしない。違いうるのは所有表の外の書き込みだけで、flow-check（`<from>-entry`）の `doc_check flow --rulings` の
  stdout で flow.json の版が `state.flow_digest` と違えば、止めずに `integrity` に 1 行足してその版を使い、今の版に合否の無い要素と resolution を
  段の本体と同じ経路（§4 の共通の行の `<段>v-left` と変換。label は `<from>v-entry`・`<from>-entry-convert`）で検証させる。版の食い違いで
  止めないのは、要素の合否が (id, digest) で付くので書き換えた要素は検証を通っていない要素に戻り、ここで検証されるからである。それでも
  不合格の要素が残れば、`next_args` を付けずに blocked にする（段の本体に直す役が来るとは限らない）。段の途中の版の食い違い（verifier・
  flow-check・flow を書かない resolver の後）は止める。flow-check の食い違いは、flow を書ける resolver の cycle で verifier を外した後（`unchanged`）なら
  段からやり直せる blocked にし（外す前の verifier の照合と同じ）、それ以外は所有表の外の書き込みとして `next_args` を付けない。
- **段 5・8 から始める run の入口は、形式検証の取り込みも照らす**（`prd-spec.js` の `formalEntry`）。`state.formal` が取り込む前（`{ rid, fnv }`）か、
  取り込んだ後（`{ rid, ok: 1 }`）でもその段の回と同じ回の依頼なら、入口の flow-check（`<from>-entry`）が flow の後に `formal-status --rid <rid>` も
  実行する（取り込んだ後の再実行も照らし直すのは、差し戻しの writer の後に止まった run を、restore で戻した本文の上で差し戻しからやり直すため）。
  照合は次の順で、落ちれば blocked にする: stdout が checksum に合わない（取り直しも合わなければ同じ段の `next_args`）、`rid` か `fnv`
  （取り込む前だけ）が `state.formal` と違うか `units_digest_ok` が偽（`next_args` を付けない）、`outcome` が null（同じ段の `next_args`。
  理由は「formal-import を実行してから呼び直す」）、`tree_digest_now` が `tree_digest_request` と違う（`next_args` を付けない）。
  通れば `state.formal` を `{ rid, ok: 1 }` にし（段に入った時点の state にも入れる）、`notices` に outcome と判定の件数の 1 行を足す。
  `next_args` の state には sha256 の全体を載せず、`fnv`（`request.json` のバイト列の 8 字）と `rid` と段ごとの依頼の回数（`formal_by`）だけを載せる
  （全体は `W/fm/<rid>/units.json` にあり、formal-status が照らす）。
- `integrity` の行は、段の入口の flow.json が `next_args` の版と違った、再実行の入口の restore が照合の前に止まった flow.json の書き込みを取り消した、writer が読んだ resolutions.json と台帳の最新が違った、verifier が検証した版と resolver が
  書き終えた版が違った、verifier が `doc_check flow` で検査した flow.json の `content_sha256` が生成者の検査した版と違った、verifier が返した F- の合否が `doc_check flow` の stdout（verifications.json）に無かった、flow-check が検査した flow.json の `content_sha256` が検証を通った版と違った、flow-check（問いへの変換の後は `<段>-convertv` の verifier）の前に応答した resolver が返した `doc_check flow` の stdout が flow-check の stdout と違った（契約 §flow-check。変換の後は verifier の put で変わる合否の欄を除いて比べる）、writer の backup の控えが段の入口の本文と違った、のような食い違いである。事後報告に添える。段の途中の flow の版と F- の合否の食い違いだけは run を blocked にし（違う flow や記録されていない合否を見た検証を台帳に入れないため）、それ以外は run を止めない（script は flow-check の stdout しか判断に使わないので、止めても守る判断が無い）。
- **doc_check の stdout の写しが checksum に合わなければ、流し直してよいコマンドだけを取り直す**（`prd-spec.js` の `recopy`）。agent は stdout を
  返り値に手で写すので、壊れた JSON や、一覧の要素を 1 件落とした正しい JSON が返る（実測: R16 の run3 で flow-check:3a の haiku が約 3.5KB の
  `flow --rulings` の stdout を壊れた JSON に写した）。形の検査だけでは後者が通り、落ちた O- や未検証の要素が誰にも見えないまま進む。そこで script は
  写しの本体から digest（§6 の `stdout_fnv`）を計算し直し、合わない写しと壊れた JSON を同じ「写し損ね」として受け取らず、同じコマンドを
  flow-check に `flow-check:<元の label（flow-check でなければ : を - にして前に役の名前）>-recopy` で 1 回だけ実行させる。JSON の行の無い値
  （失敗したコマンドの stderr）は写し損ねではなく、これまでの経路（差し戻しか blocked）で扱う。取り直しも合わなければ、`reason` に checksum と
  書いて段からの `next_args` で止まる（resume は保存された同じ写しを返すので `resumable` は偽。`next_args` で呼び直す）。判断する役
  （resolver・plan reviewer・監査役）を起動し直して写しを取らない（判断ごとやり直すことになる）。呼び出しの場所ごとの扱い:

  | 写しを返す呼び出し | コマンド | 取り直し |
  |---|---|---|
  | flow-check（`<段>`・`<from>-entry`） | `flow --rulings` | する（読むだけ） |
  | flow-check（`<from>-entry`） | `restore --token <state.tx.restore>` | する（控えを消した後の restore は何も戻さず同じ W を返す） |
  | flow-check（`1-entry`） | `reset` | する（2 回目は何も消さず、残した文書と `fixed_sha256` は同じ） |
  | flow-check（`<ゲート>-answers`） | `answers` | する（読むだけ） |
  | flow-check（`<from>-entry`。from が 3a・3a'） | `answers` | する（読むだけ） |
  | writer（`<unit>:draft`・`<unit>:revise`） | `backup` | する（同じ token の控えがあれば取り直さず、控えの版の digest を返す） |
  | plan-reviewer | 最後の `flow --rulings` | する（verifier の put の後の W をそのまま読む） |
  | resolver・planner | `flow`・`conflicts`（planner:1 は `plan` も） | する（生成者が返った直後の W を読む。planner の写しは裁定の後の台帳で数えた stdout になる） |
  | resolver・planner | `questions --check` | する（問いの形の検査の対象の ID で。読むだけ） |
  | plan-reviewer（段 3 の最初の検証） | `plan` | する（読むだけ） |
  | 指名された監査役 | `doc`・`tree-digest` | する（読むだけ） |
  | 指名された監査役 | `quotes` | する（監査の間は誰も本文を書かないので、取り直しも `checks/quotes-r<n>.json` を同じ中身に書き直す） |
  | 指名された監査役 | `snapshot --save` | しない（監査の基準を書き直し、`--live` はその段の監査役の label）。段 5・8 から `next_args` で止まる |

- `holds` と `hold_drafts` は、writer に渡したか（`state.settled_written`）で分ける。渡しただけで本文に入ったとは限らず、
  当て損ねは直後の監査が拾う。
- `notices` の行は、照合の食い違いではない所見である（段 5・8 の監査の基準の snapshot が、W に所有表に無いファイルや
  分量の目安を超えたファイルを数えた、など。行には件数と一覧のファイルのパスだけを載せる）。run は止めず、事後報告に添える。`integrity` に混ぜないのは、その件数を改善候補の
  選別（`scripts/goal_selector.py` の R4）が照合の食い違いとして数えるからである。
- `skipped` は、事実の条件で起動しなかった agent の記録で、その run（leg）で走った分だけを持つ。W の状態の所見ではないので `notices` に
  混ぜず（混ぜると `notices_count` の意味が変わる）、`state` にも載せない。resume は script を頭から走り直すので、その leg の全体を返す。
- `undeclared` は、writer が申告せずに変えた項目を文書ごとに並べたもの。監査の範囲には入れているが、申告の漏れ
  そのものは writer の契約違反なので、事後報告と合わせて見る。

## 4. 段と起動の条件

| 段 | 起動する agent | 起動の条件・上限 | 次 |
|---|---|---|---|
| 1 | flow-check（`1-entry`）→ planner（`planner:1`。仕分け → 流れ → 裁定を 1 体で行う） | 常に。入口の reset の stdout が無いか固定の文書のキーが違えば planner を起動せず blocked（段 1 から。§3） | 返した `plan_check`・`flow_check`（`--lint`）・`conflicts_check` が plan・flow・conflicts・lint の検査に落ちれば、まとめて 1 回だけ差し戻す（`planner:1:rework`。plan が落ちていれば仕分けから、ほかは流れから。表に無い符号は差し戻さずに止める）。差し戻しの後も plan・flow・conflicts のどれかが落ちれば blocked（段 1 から。初稿を始めない）、lint だけが残れば `notices` に出して進む。writer の単位が循環・未知の依存を持つ、固定の文書が単位に入る、既存文書がどの単位にも無い → blocked。閉じた flow の `content_sha256` を `state.flow_digest` にする。裁定は段 3 の state に入れる（段 1 の state には入れない） |
| 3 | resolver（planner:1 が裁定し漏らした組と O- があるときだけ。段 3 から始めた run では、入口の flow-check の stdout の `open_ids`・`pair_keys` のうちどの resolution の `about` にも無いものがあるときだけ） | 段 1 から続く run は planner:1 の裁定を受け取り（聞ける段の指定の外の hold は `resolver:1-toquestion`、問いの形の不合格は `resolver:1-questions` が直す（上限は下と同じ））、残った組と O- だけを渡す。問いを出したのに `questions --check` の stdout が無いか不合格なら差し戻す（上限は prd-spec.js の `MAX_CHECK_REWORK`。3a・3b・3a'・6 も同じ） | 直らなければ blocked |
| 3v | plan-reviewer | 常に（仕分けの既定と flow の出典を検証するため）。verifier も最後に `doc_check flow` を実行し、最初の検証は `plan` も実行する | `plan` の `content_sha256`・`covers`・`units`・指摘が `planner:1` の `plan_check` と違えば `integrity` に 1 行足して blocked（段 1 から）。`flow` の `content_sha256` が `state.flow_digest` と違えば `integrity` に 1 行足して blocked（段 1 から続く run は段 1 から。flow を書いたのは planner:1）、その `unsettled_refs` がその cycle の planner の裁定を引けば blocked（段 1 から。settle・3b は同じ段から）、その cycle で flow を書いた生成者が消せる指摘が 1 件以上でも blocked（3av・6v も同じ。消せない指摘と、台帳の書き込みで出た指摘は settle の flow-framer に渡る（3b の組み直しの前の 3a の例外は 3a の行）。契約 §plan-reviewer）。不合格は resolver に 1 回だけ差し戻し（label は `<段>-fix`、その再検証は `<段>-fixv`）、再検証（落ちた F- ごとに about を `{verification}` にした resolution が返らなければ blocked。段の頭から）。domain assessment は「決定の台帳」の契約に従い、1 回の修正後も不合格なら問いか保持規則に変換せず blocked で止める（台帳の評価と不合格 trace は残し、writer に渡さない）。それ以外でそれでも不合格なら問いか保持規則に変える（どちらにするかは prd-spec.js の `convertFailed`。問いに変えたものは `<段>-convertv` が関連性と根拠を再検証し、不合格なら依頼者に提示する前に blocked で止める。聞ける段では価値の論点・`value_as_method`・cycle の入口で問いだった ID を問いにし、聞けない段では hold だけ。`decidable` で落ちたものが既にその種類なら書き換えない。flow の要素は書き換えるまで。指定と違う種類で返れば 1 回だけ書き換え直させ（`<段>-convert-kind`）、それでも違えば blocked。契約 §resolver）。聞ける段で script が指定していない hold を resolver が新しく返せば 1 回だけ問いに書き換え直させ（`<label>-toquestion`）、それでも hold なら blocked（段の頭から。契約 §resolver）。依頼者のその問いへの回答を根拠にした hold（`doc_check flow` の `answer_holds`）は指定と同じに扱い、書き換え直させず、変換でも問いにしない（その回答の節を出典に `decidable` で落ちたものは問いにする。契約 §resolver）。verifier の `decidable` を受け取れなければ 1 回だけ聞き直す（`<label>-source`。契約 §plan-reviewer） |
| ゲート（`g<n>`） | flow-check（`g<n>-answers`。`gates_answered` にこのゲートがあり今の問いがその ID と同じとき（resume）と、`next_args` で 3a・3a' から始めた run の入口が `answers_check` を返さなかったか、入口の後に回答待ちの問いが変わってゲートか ID が合わないとき（§3）） | 段 3・3b・3a・6・3a' を出るときに回答待ちの問いが 1 件以上あり、依頼者に聞ける回数が残っている（段の入口で開いたゲートの数が `MAX_GATES` 未満。3b の組み直しの前の 3a は 3b へ持ち越す）。ただし最初のゲートを開く前の段 3・3b は問いを持ち越して次の段（4、`entry: existing` は 5）へ進み、writer・監査役・段 6 の resolver にその問いを渡す（論点を決めない・指摘にしない・別の問いにしない）。最初のゲートは段 6 で、持ち越した問いと段 6 の問いをまとめて開く（prd-spec.js の `collecting`） | `needs_answers`（段 3・3b・3a からは `from: 3a`、段 6・3a' からは `from: 3a'`。問いを持ち越した run の段 6 のゲートは `from: 3a`。最初の初稿は回答を知らないので、組み直した flow で書き直す）。名前は開いた順に `g1`・`g2`・…、回答は `answers/g<n>.md`。`gates_answered` の ID と今の問いが同じで、回答のファイルが問いのすべてに答えていれば回答を当てる段へ。仕様書だけを書く run（定義は schemas/agent-contracts.md「## 現物と既存実装の扱い」）では、回答待ちの問いを仕様の論点（`ruling: question`・`layer: 手段`・`upstream_revision` が無く、plan reviewer が合格にした問い。`doc_check flow --rulings` の行の `spec_layer`）と要求の論点（それ以外。`layer` の無い問いを含む）に分け、要求の論点が 1 件でもあればゲートを開かずに `stop_reason: upstream_gap` の blocked で止まり（`question_ids` は要求の論点だけ）、仕様の論点だけなら聞く（延長の段 6 も同じ）。問いの持ち越し（`collecting`・`carrying`）は、仕様書だけを書く run でも最初のゲートの前に限る |
| 3a | resolver → verifier（候補の選択だけの回答でも起動する。回答を当てた resolver が返す `doc_check flow` の stdout を照合するため。ただし検証する resolution が無く、resolver が flow を変えず（段の入口の版は前の段の出口か入口の flow-check で照合済み）、今の版に合否の無い要素も無いときは起動せず、返り値の `skipped` に載せる。そのときは settle の flow-check が stdout を取り直し、`carry` も含めて残りは `<段>v-left` が検証する（prd-spec.js の `unchanged`。3a' も同じ）） | 最初のゲートと、3b から出たゲートの後。resolver の stdout に resolver が消せる指摘（契約「flow.json の形」の直し手）があれば差し戻す。消せない指摘は差し戻さず、同じ cycle の settle の planner（3b の組み直しの前は `planner:3b`）に渡す | 3b の組み直しの前（`state.reframed` が偽。最初のゲートの後）は 3b。この 3a は settle の反映（共通の行の planner・`<段>-settle-*`・`<段>v-settle`）を起動せず、検証し残しの拾い直し（`<段>v-left` まで）を終えて出る（検証の裁定を持つ不合格の要素だけは持って出てよい。裁定の無い不合格の要素があれば渡さずに 3a の settle で直す。3b の出口の不変条件は緩めない。prd-spec.js の `REFLECT_STAGE`）。3b は planner（`planner:3b`）が回答で flow を組み直し、同じ書き込みで 3a の反映（settle の planner に渡すのと同じ行）も写し、組み直した flow のまだ裁定の無い open・組と持ち越した問いを同じ体で裁定し、持ち越した問いも含めた `questions --check` を返す（不合格なら `3b-reframe-questions` が形を直す。flow・conflicts・lint の検査に落ちれば `planner:3b:rework` を 1 回、それでも flow が落ちれば blocked、lint だけなら `notices`）。planner:3b が裁定し漏らした open か組があるときだけ resolver:3b がそれを裁定する。持ち越した問いだけなら planner:3b は裁定せずに返し、問いはそのまま次のゲートで聞く。組み直した flow（3a の反映を含む）は `3bv` が 1 回で検証する（resolver:3b が flow を書かなければ planner:3b の書き込みとして照合し、起動の前の台帳と比べて過少申告を settle の verifier と同じく止める）。写さずに残ったもの（不合格の要素を含む）は 3b の settle が写させて検証する）。そこで問いが残れば次のゲート（`from: 3a`）で聞く。3b の後の 3a で回答の反映から出た続きの問いも、聞ける回数が残っていれば次のゲートで聞き、残っていなければ保持規則（理由は上限）。問いが残らなければ 4（`entry: existing` は 5。問いを持ち越した run では初稿を書き直す。段 5 は書き直した初稿の監査として、前の監査の項目の経路と役を引き継がない） |
| 3・3a・3b・3a'・6 の共通 | planner（`planner:<段>-settle`。裁定を flow に写す流れ → 未裁定の組と O- の裁定を 1 体で行う）→ verifier（`<段>v-settle`）、resolver（`<段>-pairs`・`<段>-opens`） | settle の planner の flow・conflicts が検査に落ちれば `planner:<段>-settle:rework` を 1 回（それでも落ちれば blocked。段の頭から）。flow を変えた呼び出しの後、`conflicts` の `pair_keys` にまだ裁定の無い組があれば、settle の planner の後は `open_ids` にまだ裁定の無い O- もあれば、1 回の resolver に渡す（settle の planner の後は、それが裁定し漏らしたときだけ。O- があれば `<段>-opens`、組だけなら `<段>-pairs`。`<段>` は呼び出した resolver の段で、settle の後は `<段>-settle`、差し戻しの後は差し戻しの label（3v の行）になる。聞けない段では hold で、問いを返せば blocked。3b の組み直しの後の resolver にも同じ集合を渡す。渡した組と O- は次の verifier の stdout と照合する。契約 §plan-reviewer）。verifier は、どの呼び出しでも W の今の版に合否の無い要素を検証する（契約 §plan-reviewer）。最後の verifier の後に resolver を起動していれば flow-check（契約 §flow-check）を起動する。判断に使う stdout（`doc_check flow --rulings`。`resolutions` に裁定と今の版の合否が載る）から、返り値に載らなかった裁定（resolver が書いたのに返さなかったもの・所有表の外の書き込み）を受け取り、今の版に合否の無い要素か、合否が無いか script の持つ合否と違う resolution があれば verifier（`<段>v-left`。settle の n 回目の後は `<段>v-left-<n+1>`）に検証させ（この verifier が残せば blocked。段の頭から。script の持つ合否は、検証を求めた verifier の返り値からだけ入る）、検証に落ちたまま問いにも保持規則にもなっていない裁定（RS-）と `decidable` で落ちた問い・保持規則を段の本体と同じく 1 回差し戻し（`<段>-left-fix` → `<段>-left-fixv`）、それでも落ちれば、domain assessment は「決定の台帳」の規則どおり変換せず blocked にし、それ以外は変換する（`<段>-left-convert`）。どの verifier でも、hold のまま検証に落ちた保持規則（`decidable` を除く。保持規則にしたこと自体の不合格なので差し戻しに回す）は変換に回さず（変換はもう検証しないので、落ちた規範文が writer に届く）、同じ ID のまま書き直させて検証し直す（`<呼び出し>-rehold` → `<呼び出し>-reholdv`。`<呼び出し>` は落とした verifier の段か label）。書き直した直後の検証でも落ちるか、差し戻し（3v の行）の後も hold のまま落ちれば blocked（段の頭から）。合格すると数え直すので、後の verifier で落ちればまた書き直させる（回数は verifier の呼び出しの数で決まり、settle の回数は `MAX_SETTLE_ROUNDS` で抑えられる）。W の ruling が hold でなくなった ID は、保持規則として数えない。判断に使う stdout（同じ節）の `open_only` のうち、合格か回答で閉じた O- の組か、この cycle で裁定が決まった `origin: flow` の指摘か、不合格の要素（`failed_current` のうち、検証の裁定が保持規則か回答待ちの問いのものを除く。合格した検証の裁定があればその裁定を写させ、無ければ落ちた理由で直させる）か、`stale_refs`（覆された決定か検証に落ちた不変条件を引く要素）か `unsettled_refs`（決まっていない裁定を引く要素。その cycle の planner の裁定を引くものは 3v の行のとおり止める）か、flow の指摘（`codes`。符号によらず）があれば settle を起動する（保持規則への変換（`<段>-hold`）の後も同じ。3b の組み直しの前の 3a は起動せず planner:3b に渡す（3a の行））。settle の verifier に落ちた裁定（RS-。保持規則は `decidable` で落ちたものだけ）は、段の本体と同じく 1 回差し戻し（`<段>-settle-fix` → `<段>-settle-fixv`）、それでも落ちれば、domain assessment は「決定の台帳」の規則どおり変換せず blocked にし、それ以外は問いか保持規則に変える（`<段>-settle-convert`。問いは `verifier:<段>-settle-convertv` が関連性と根拠を再検証し、不合格なら blocked。問いへの変換の後はこの stdout を判断に使い、flow-check を起動しない）、settle は残り（閉じた未決を引く要素・覆された決定を引く要素・不合格・flow の指摘）が 0 になるまで回し、減らなければ止める（上限は `MAX_SETTLE_ROUNDS`） | 直らなければ blocked（段の頭から。`next_args.state` は §3） |
| 4 | writer（最初に全単位の文書の控えを取る。§3） | 単位の依存の向きに波を作り、同じ波は並列 | 応答しない単位があれば blocked（一度も書かれていない文書を監査しない） |
| 5・8 の形式検証 | flow-check（`<段>-formal-<rid>`。`doc_check formal-request` を実行する）、反例があれば writer（`writer:<unit>:formal-<回>`。依頼 a の反例のある文書を持つ単位だけ） | 段 5・8 の本体の最初（段 5 は writer の後・監査役の前、段 8 は改稿の後・監査役の前）。`args.formal` が false なら依頼せず、`skipped` に `formal_unavailable` を 1 回足し `notices` に 1 行足す。持ち越した問いのまま書いた段 5（`state.deferred`）は依頼せず上限にも数えない。依頼 a（`rid` は `f<回>a`）は段の種類ごとに `FORMAL_LIMIT` 回まで（`state.formal_by`。依頼 b は数えない。延長のパスの 2 回目の段 8 は上限で依頼しない）。送る単位を決めるのは doc_check（§6 の `formal-request`。`entry: existing` の段 5 は入口から変わった単位が無ければ 0） | 送る単位が 0 なら戻らずに監査役へ（`skipped` に `no_formal_target`）。あれば `needs_formal`（§3。`next_args.from` はその段、`resumable` は false）。呼び直した run の入口が取り込みを照らし（§3）、依頼 a の反例が 1 件以上なら、監査役の前に反例のある文書の writer を段 7 と同じ改稿のプロンプトで 1 回だけ起動する（`ST-FORMAL-CEX-` の指摘だけを直す。最初のコマンドの `backup` の照らす先は依頼の木。段 8 では申告を `state.revised.changes` に足す）。続けて依頼 b（`f<回>b`。依頼 a に入れた単位のうち digest が変わったものだけ）を作り、送る単位が 0（writer が何も変えなかった）なら監査役へ、あれば `needs_formal`。依頼 b の後に残る反例は差し戻さず、doc の `ST-FORMAL-CEX-` として blocking のまま監査と輪の止め方（`finalHold`・`unreflected`・report.md）に進む。監査役のプロンプトには、依頼した run だけ形式検証の事実の 1 行を足す（判定し直さないものとふだんどおり判定するものは契約「## 形式検証の事実」） |
| 5 | writer reviewer（全文書で 1 体）→ whole reviewer（全文書で 1 体。指名） | 常に。`entry: existing` は 3 の後ここへ。writer reviewer は、文書の数に doc_check の文書の分量の目安（`SIZE_BUDGET.document`）を掛けた値が 1 体の読む上限（prd-spec.js の `REVIEW_MAX_BYTES`）を超えるときだけ、文書を単位の文書のキーの順に詰め合わせて分け、並列に起動する（読む量の目安は agent が申告せず、静的な値で決める。台帳と input.md は組によらず全件読むので数えない。目安を超えた文書は数え損ねるが、snapshot の `size_over` に出る）。whole reviewer は文書をまたぐ矛盾を見るので分けず（収まらない文書は契約「### 読むもの」の locate で読む）、writer reviewer がすべて返ってから起動し、その指摘のファイルを渡す | whole reviewer が `audited-<n>` を返さなければ blocked。whole reviewer の `rejected` のうち、同じ回の writer reviewer が返した指摘の ID だけを退け（それ以外の ID は無視して `integrity` に 1 行足す）、退けた指摘を指摘の集合から外してから経路・再発・逆向きの判定に渡す（blocking に数えず、改稿にも裁定にも回さない）。退けた指摘の ID は全件 `notices` に出す（退ける理由は whole reviewer の指摘のファイルの `rejected` にあり、script は理由の真偽を確かめないので、事後報告から追えるようにする）。whole reviewer は判定の前に `quotes`（§6）を実行して stdout を返し、script はその `unquoted`（quote がどの原文にも無い not_found）のうち同じ回の writer reviewer が返した指摘の ID も同じく退け、`rejected` とは別の行で `notices` に出す（`rejected` と重なる ID はこの行にだけ出す）。stdout が無いか、`files` が同じ回の writer reviewer の findings の名前の組と違うか、`tree_digest` が `audited-<n>` の digest と違えば、退けずに `integrity` に 1 行足す（静的な退けは LLM の判断を通らないので、退けない向きに倒す）。段 8 も同じ。退けた後の指摘が blocking を含まず、doc_check の blocking・新しい TBD・回答待ちの問い・まだ本文に入っていないこの run の裁定（`entry: existing` の段 1〜3 の裁定）・当てていない routes のどれも無く、doc の stdout があれば（無ければ doc_check の blocking を数えられないので飛ばさない。lowOnly）、段 6〜8 を飛ばして 9 へ（指摘が 1 件以上なら `skipped` に `low_only`。route が decision で blocking でない指摘も裁定せず、`unreflected` に残す）。それ以外は 6 |
| 6 | resolver → verifier | W に裁定の無い（どの resolution の `about` にも無い）decision の指摘と新しい TBD だけを渡し（延長のパスでは blocking の decision の指摘だけ。blocking でない decision は裁定せずに `unreflected` に残す）、どちらも 0 件なら起動しない（回答待ちの問いがあれば、起動しなくてもゲートか保持規則へ）。writer の指摘はここを通らず段 7 へ。再発した項目は、前のパスの指摘とその裁定の ID を渡して項目の次元を裁定させる。再発した項目の前の裁定に依頼者の回答か保持規則があれば、問いにしないよう指示し、それでも問いで返れば保持規則にする（同じことを二度聞かない） | どのパスでも、問いは聞ける回数が残っていればゲート（`from: 3a'`）、残っていなければ保持規則（理由は上限）。延長のパスで問いが 1 件も残らなければ（ゲートを開かなければ）、7 へ進まずに finalHold（`pass_limit`）。依頼者の回答の無いまま改稿と監査を増やさないため |
| 3a' | resolver → verifier（3a と同じ。起動しない条件も同じ） | 段 6 か 3a' のゲートの後 | 回答の反映から出た続きの問いは、聞ける回数が残っていれば次のゲート（`from: 3a'`）、残っていなければ保持規則（理由は上限）。延長の 3a' では、そのゲートの next_args が `NEXT_ARGS_MAX_CHARS` 以上なら保持規則にする（理由は字数の上限）。仕様書だけを書く run の要求の論点は、どちらでも保持規則にせず `upstream_gap`。問いが残らなければ 7 |
| 7 | writer（変更がある単位だけ。最初に全単位の文書の控えを取る。§3） | writer の指摘・routes・doc_check の指摘・前回の書き込みの後に決まった裁定のどれかがある単位 | 何も無ければ 9 へ（blocking が残っていれば `stop_reason: no_progress` で blocked） |
| 8 | writer reviewer → whole reviewer（指名。段 5 と同じ組み方） | 改稿の後は必ず。範囲は writer の申告の項目に、申告に無い変更（diff の `by_doc` を文書ごとに申告と比べたもの）を足したもの。writer reviewer は判定の前に同じ diff を実行して自分の組の文書の範囲を読み、whole reviewer は指名されて diff の結果を返す。script はそれで申告に無い変更を `undeclared` に記録し、このパスの照合の範囲（既裁定の再出の判定）に入れる | blocking（指摘・doc_check・新しい TBD）が 0 なら 9 へ。改稿のパスを `MAX_AUDIT_PASSES` 回終えた最後の監査の後に、まだ裁定の無い blocking の decision の指摘（再発で decision に回した項目を含む）か新しい TBD が残り、聞ける回数があり、延長のゲートで返すことになる next_args（延長の段 6 の入口の state でゲートを 1 つ開いたもの）の JSON の字数が打ち直しの上限（prd-spec.js の `NEXT_ARGS_MAX_CHARS`）未満なら、延長のパス（`state.pass` が `MAX_AUDIT_PASSES + 1`）で段 6 → ゲート → 3a' → 7 → 8 を 1 回だけ回す（上限を越えるのは依頼者の回答を当てるこの 1 回だけ。上限を超える next_args は打ち直せず、回答を当てて再開できないので、上限以上なら延長しない。延長の段 6 もゲートを開く前に同じく測り、上限以上なら問いを保持規則にして finalHold。仕様書だけを書く run の要求の論点は、この判定より先に `upstream_gap`）。それ以外で残れば（延長の後を含む）finalHold（`pass_limit` の blocked）: 輪を出た後の resolver（`resolver:final`）が、まだ裁定の無い blocking の decision の指摘と新しい TBD を保持規則と Issue の文案にする（blocking でない decision は保持規則にせず、report.md の節に残す）。残った指摘の全件は理由に並べず report.md の「本文に反映していない指摘」の節に載せる（ID は返り値の `unreflected`。doc_check の blocking だけが残るときも上限まで回す）。前のパスと今のパスの両方で blocking の項目（再発）は writer に回さず decision にして、`resolver:final` に渡す。前のパスで段 6 が裁定して合格した指摘と同じ項目・同じ `direction` の指摘で、その後の改稿がその項目に裁定を当てただけのもの（項目が変わっていないか、そのパスの段 7 がその項目に writer の指摘を渡さずにその裁定を渡した）は、既裁定の再出として再発にも blocking にも数えず `notices` に出す |
| 9 | —（収束せずに輪を出た blocked のときだけ resolver が残った論点を保持規則と Issue の文案にし、flow-check の stdout に残った flow の指摘と覆された決定を引く要素を `reason` に載せる） | done の直前 | 事後報告は司令塔が `doc_check report` で導出する |

ゲートは段の位置ではなく、価値の問いが出たことで開く。聞けるかどうかを位置やパスで決めると、同じ論点が見つかった時期だけで
問いにも保持規則にもなり、聞けば決まった論点が保持規則として残る。ただし最初のゲートだけは、初稿の監査の裁定（段 6）まで開かない。
問いを見つけた段ごとに止めると、初稿と監査でしか見えない論点が次のゲート（仕様書だけを書く run では、要求文書を改訂した次の run）に回り、
依頼者を止める回数が論点の見つかった段の数だけ増えるため（実測: 仕様書だけの run が初稿の前の 3 問で止まり、要求文書を改訂して起こし直した
run が初稿の監査で 4 問目に止まった）。持ち越すのは最初のゲートの前だけで、回答の後に出る続きの問いは今どおりその段の終わりに聞く。開く回数の上限は prd-spec.js の `MAX_GATES`（`3 + MAX_AUDIT_PASSES`。内訳は、初稿の監査の後の段 6 で開く最初のゲート、
回答の反映（3a・3b）から出る続きの問いのゲート、改稿のパスの段 6 のゲート（`MAX_AUDIT_PASSES` 回）、2 巡目の後の延長のゲート（段 8 の行）。問いを持ち越さない run では
最初のゲートが改稿のパスの段 6 を兼ねるので 1 回余る）で、回答を当てた段から出る続きの問いも同じ上限から
引く（問いと回答の連鎖はここで終わる）。上限は run 全体で共有するので、初稿の前に続きの問いが連鎖すると、改稿のパスで聞ける分まで
使い切ることがある。上限に達した後と改稿の輪を出た後（段 9）に出た価値の論点だけを保持規則にする。最初のゲートの回答の後の 3a は
問いを 3b へ持ち越し、組み直した flow から出る問いと 1 回のゲートで聞く（回答で flow を組み直して初めて出る問いがあるため）。

範囲を絞った監査の基準は `audited-<n>` の snapshot で、script が保存時の digest を持ち、指名された監査役が
`diff --expect` で照合する。監査の範囲は writer の申告と木全体の diff の和なので、生成した側だけに監査の範囲を
決めさせない。

## 5. 本流から外れた状態

| 状態 | 対応 |
|---|---|
| 依頼が 1 行だけ | intake が仕分け、足りない論点は未決として段 3 と最初のゲートで聞く。推測で埋めない |
| 小規模・低リスクな案件 | 規律は下げない。単位と文書が 1 つになるだけ |
| 依頼者が分割に異を唱えた | 依頼者の言葉を依頼文に続けて `input.md` に逐語で書き、`entry: new` で S0 からやり直す（分割は intake の決定なので、それを入力にして決め直す。intake は `input.md` を読み、answers は段 1 の入口の reset が消す） |
| agent が応答しない（返り値が null） | 出し直さない。その段を blocked にし、`reason` に「利用者が止めたか、runtime の出し直しの後も API エラーだった」と書いて `next_args` を付ける（§3）。司令塔は SKILL.md「## 中継」の「呼び直し」のとおりに呼び直す |
| Workflow が例外で終わった（args の検査か、起動の前の schema・役の opts の検査（`prd-spec.js` の `schemaDefects`・`callDefect`）か script の欠陥）か、`reason` が「script の不変条件に反しました」の blocked（段の出口の検査（`exitViolation`）か、`agent()` の前の呼び出しの検査（`callDefect`）。`reason` にどれを破ったかが載る） | 再実行しない（同じ args では同じ所で止まる）。例外の文か `reason` をそのまま伝える。args の検査なら、渡した args が返った `next_args`（§3 の環境の欄のほかは変えない）かを確かめる。それ以外は script の欠陥なので、prd-spec.js を直すまで run を続けない |
| `reason` が「回答待ちの問いが台帳（…）と script の数えたものとで違います」の blocked（段の出口の照合。prd-spec.js の `questionsDrift`。台帳の側の定義は契約「## 決定の台帳」の resolutions.json） | resolver の返り値と台帳の書き込みの食い違いなので、`next_args` で同じ段からやり直す（SKILL.md「## 中継」の「呼び直し」）。同じ理由で続けて止まれば、`reason` の ID の resolution を台帳で確かめて伝える |
| 出した agent が全件応答しない | セッション上限・レート制限を疑う。解除してから呼び直す（SKILL.md「## 中継」の「呼び直し」） |
| token の目標（`budget.total`）に達した（`stop_reason: budget`） | 目標を上げてから呼び直す（SKILL.md「## 中継」の「呼び直し」） |
| 監査の指摘は 0 件だが開いている TBD がある | 「完成しました」と言わない。「あと N 個決まれば着手できます」と伝える |
| 保存の直前に tree digest が合わない | 保存しない。最後の監査の後に文書が変わっている |
| INDEX だけが既存で本体が無い（またはその逆） | 齟齬として報告し、INDEX を本体から導出し直す |

## 6. doc_check の CLI

本文を読む決定的な検査は `scripts/doc_check.mjs` が正本で、agent が実行して stdout（1 行の JSON）を返す。
結果は `W/checks/` に書かれ、stdout には件数・digest・パスだけが出る。stdout の JSON には、ほかの欄の digest（`stdout_fnv`。`prd-spec.js` の
state_hash と同じ `fnv(canonicalText(...))`）が付き、script は写しから計算し直す（合わない写しの扱いは §3 の「doc_check の stdout の写しが checksum に合わなければ」の項）。

| モード | 実行する役 | 何をするか |
|---|---|---|
| `plan` | intake（plan reviewer も段 3 の最初の検証で） | plan.json の `domain` が `references/domain-analysis.md` §2 の観点のキーを 1 回ずつ持ち、判定の根拠の ID が実在し、`irreversible` が `該当` なら `kind: invariant` の決定か未決があるか |
| `flow [--rulings] [--lint]` / `conflicts` | planner（`flow` は resolver・plan reviewer・flow-check も。`--rulings` は plan reviewer の最後の `flow` と flow-check。`--lint` は `planner:1` と `planner:3b` だけ） | `plan.json` が無いか、その `units` が無いか形が違えば止まる（仕様書を書くランかを `units` で決め、要求文書だけのランでは扱いの無い `may_fail` に `ST-FLOW-FAIL-UNHANDLED-` を出さないため）。`--lint` は生成者の自己点検を `lint`・`lint_codes`・`lint_path` に足すだけで、ほかの欄を変えない（見るものは契約 §flow-framer）。流れの形・閉包・出典の検査（stdout に指摘の件数と符号ごとの場所（`codes`。意味は契約「flow.json の形」の直し手）・`open.json` の件数と ID・flow.json の内容の `content_sha256`・`--rulings` のときは裁定と合否の `resolutions`（形は契約 §flow-framer。仕様の論点の問いの組だけが `spec_layer: true` を持つ）・ほかの欄の意味は契約 §flow-framer） / 同じ target を持つ決定どうし・決定と要素の組の列挙 |
| `doc [--doc <キー>] [--lint] --open-tbd <ID,…>` | writer（内部ループ。`--lint` は writer だけ）、指名された監査役 | `plan.json` が無いか、その `units` が無いか形が違えば止まる（仕様書を書くランかを `units` で決めるため）。`--lint` は `lint`・`lint_codes`・`lint_path` を足すだけで、`blocking` と `digest` を変えない（見るものは契約 §writer）。構造検査・参照先の実在・曖昧語・開いた TBD に触れる断定。要求の発生源の検査（`ST-REQ-NO-ORIGIN-`）のために、台帳（decisions・resolutions・verifications）と plan.json の `domain`・`required_categories` を読む。台帳が正規形でないときや、形の崩れた要素を含むときも止まる。固定の文書に帰属する指摘は `checks/doc.json` に残すが `blocking` に数えず、件数を stdout の `fixed_findings` に出す（ラン内で直せないため。直せる文書がある重複はその文書に帰属させ、`ST-ORPHAN-REQ-` は書いている仕様書で直せるものだけに出すので数える）。固定の仕様書の参照切れ（`ST-DANGLING-REQ-`）は、ラン内の改稿で生じたものかラン前からあるものかを区別できないため数えない（推定で要求文書に帰属させると、直しようのない参照切れが要求の捏造を促す）。stdout の `flow_refs` に項目ごとの trace が指す flow 要素の ID を出す（script が改稿の writer に項目ごとに渡す）。`checks/entry.json` があれば（entry が existing の run）、項目と参照の事実を `scripts/prd-graph impact`（Rust。正本は `plugins/workflow/crates/prd-graph`。binary が無ければ cargo で作り、cargo も無ければ止まる）に渡して影響の範囲を `checks/impact.json` に書き、入口から本文が変わっていない項目の指摘に `preexisting: true` を付けて `blocking` に数えない。項目の本文と trace だけで決まる検査（`ST-NO-EVIDENCE-`・`ST-REQ-NO-ORIGIN-`・`ST-MODAL-`・`ST-AMBIGUOUS-`）は変わっていない項目なら常に、項目どうしの関係を見る検査は影響の範囲（変えた項目と、参照か同じ要求でつながる 1 hop 先）の外のものだけを既存の指摘にする（改訂していない項目には trace が無く、数えると根拠を捏造するしか直し方が無い）。項目の digest は本文の区間と項目自身の trace から取る（この run で付けた trace が原因の指摘を既存の指摘にしないため。同じ ID の見出しが複数あれば全ての区間をまとめる）。開いている TBD や flow に依存する `ST-TBD-ASSERT-`・`ST-FLOW-UNKNOWN-REF-` は既存の指摘にしない。`--doc` を付けたときの影響の範囲は `checks/impact.<キー>.json` に書く。区間の本文・trace・決定・流れの判断・保持規則を `scripts/prd-graph check` に渡し、静的な検査（`ST-DECISION-UNAPPLIED-` を含む 8 種。契約の §structural）の指摘を足す（入口の有無によらず全ての run で呼ぶ。決定と流れに依存する `ST-DECISION-UNAPPLIED-`・`ST-DOC-FLOW-TABLE-` は既存の指摘にせず、`ST-ABBREV-ID-` は区間の本文と全ての文書の ID の集合で決まるので、本文の変わらない区間なら既存の指摘にする。宣言とつながる `ST-ROLE-INPUT-COVERAGE-`・`ST-ENUM-SET-MISMATCH-` は、使う区間と宣言の区間（ENUM は参照元の区間も、ROLE は入口でその役と印の文に現れる役を宣言していた区間も）がどれも変わっておらず消えてもいないときだけ、既存の指摘にする。入口の役の宣言は、reset が `checks/entry.json` の予約のキー `§roles` に役ごとの区間の key で書く（宣言が無ければ書かず、entry.json と `entry_digest` は変わらない）。prd-graph impact には `§roles` を除いて渡す）。構造の解析（区間・表・条件の宣言・本文中の ID・用語表の行）は doc_check が行い、prd-graph には解析済みの値を渡す。入口には ID を持たない節も `<文書キー>§<見出し>` の key で入れるが、影響の範囲の辺にはしない（表の 1 行の改訂が全ての項目に波及しないため）。stdout に `preexisting_findings`・`impact`（changed・removed・items の件数とパス）・`entry_digest` を出す |
| `snapshot --save <label> [--role auditor] [--live <label,…> [--sweep]] [--fixed <キー,…>]` | 監査役（`audited-*`）、writer | 項目ごとの hash を保存する。`--fixed` に挙げた文書の本文と meta の sha256 を stdout の `fixed_sha256` に出す（reset と同じ値）。`audited-` は `--role auditor` のときだけ。W に所有表（契約の「W のファイルと書き手」）と `plan.json` に無いファイルと、`--sweep` で消さなかった `tmp/` のものを `checks/<label>.stray.json` に書き、stdout の `stray` に件数とパスを出す。`--live` に挙げた label の `tmp/` は動作中として除く。`--sweep` は `--live` に無い label の `tmp/<label>/` を空のものも含めて消し、消したファイルとリンクを `checks/<label>.swept.json` に書いて `swept` に件数とパスを出す（`--live` が並行中の label のすべてであるときだけ付ける。script は監査の snapshot にだけ付ける）。台帳と文書のバイト数と、目安（`SIZE_BUDGET`）を超えたものを `checks/<label>.sizes.json` に書いて `size_over` に件数とパスを出す |
| `diff --against <label> --expect <digest>` | 指名された監査役、段 8 の writer reviewer | snapshot と今の木の項目の差分。digest が違えば exit 3 |
| `tree-digest [--doc <キー>] [--live <label,…>]` | writer、指名された監査役、司令塔（保存の前） | 今の木（または 1 文書）の digest。`stray`・`size_over` は snapshot と同じ（一覧は `checks/tree-digest.*.json`） |
| `index [--req-dir] [--spec-dir] [--open-tbd]` | 司令塔（保存の前） | 2 つの INDEX を導出して `checks/INDEX.<kind>.md` に書く。固定でない文書ごとに、開いている TBD があれば `checks/<kind>-<topic>.tbd.json` に書いて stdout の `open_tbd_files`（`doc`・`path`）に、無ければ文書のキーを `open_tbd_clear` に出す（写す先は文書の保存先で決まるので、パスは出さない） |
| `put --ledger <台帳> [--doc <キー>] [--expect-resolutions <sha> --expect-decisions <sha>] --token <token> [--input <作業用ディレクトリの中のパス>]` | 台帳の書き手（契約の所有表で「put で書く」とした役） | 標準入力（`--input` があればそのファイル。書けたら消し、拒否したら残す）の要素をキー単位で足し、同じキーの要素には送った欄だけを上書きする（意味は契約の「共通の約束」）。型の外の欄・経緯の印・欄の条件に合わない要素・逐語でない引用が 1 件でもあれば何も書かない |
| `del --ledger <台帳> --ids <ID,…> [--collection <配列名>] --token <token>` | 台帳の書き手 | キーで要素を消す。無い ID は成功として数える |
| `stash --save <label>` / `unstash --against <label> --token <token>` | なし（prd-spec.js は起動しない。CLI と tests は残す） | flow.json と open.json を `checks/<label>.stash.json` に控え、stdout に `flow_sha256` を出す / 控えのとおりに書き戻し（段の token の控えを先に取る）、`flow_sha256` を出す。控えが無ければ何も書かない |
| `backup --doc <キー> … --token <token>` | writer（段 4・7 の最初のコマンド） | 文書の本文の控えを token の下に取る（無い文書は無い印。同じ token の控えがあれば取り直さない）。stdout に `backup: true`・`token`・控えを取った文書のキー（`docs`）と、控えの版（控えがあればその中身、無ければ今の W）の文書の digest（`digests`: `--doc` の文書ごとの `tree-digest --doc` の値。本文が無ければ null。`entry_digest`: `checks/entry.json` のキーの文書から reset と同じ形で作った値。無ければ null。`tree_digest`: 全文書の木） |
| `restore --token <token>` | flow-check（blocked の後の同じ段の再実行の入口） | token の控えを台帳と文書の本文に戻し、token の下で作られた台帳と文書を消して控えを消す（控えを書く途中で落ちた一時名は数えない。§3）。stdout に戻したファイルごとの前後の sha256（無いファイルは null）と flow.json の前後（`flow_before`・`flow_after`）、控えを消した後の段の token（`pruned_by`。あれば何も戻さない）と、戻した後の W の文書の digest（`backup` と同じ `digests`（W にある文書だけ）・`entry_digest`・`tree_digest`） |
| `place --doc <キー> --source <元の文書のパス>` | 司令塔（S0） | 既存文書を `W/<kind>-<topic>.md` に、その隣の `.tbd.json`（開いている TBD の写し）があれば `W/<kind>-<topic>.tbd.json` に、まとめて逐語で写す。写しが無ければ前に置いた W の写しを消す。写しの形が reset の受け取る形でなければ何も置かずに止まる |
| `reset [--keep <キー,…>] [--fixed <キー,…>]` | flow-check（段 1 から始める run の入口） | W を S0 の直後に戻す（消すものと残すものは §3 の段 1 の項）。キーが文書のキーの形でないか、`--fixed` が `--keep` に無いか、`--keep` の文書が W に無ければ何も消さずに止まる。stdout に消した名前（`removed`）と残した文書のキー（`kept`）と書き直した固定の文書のキー（`fixed`）とその本文と meta の sha256（`fixed_sha256`）と、写しから meta に写した TBD の文書のキーごとの ID（`carried_tbd`）。写しの形が違えば何も消さずに止まる。固定でない残した文書の項目ごとの本文の digest を `checks/entry.json` に書き（「> 渡すもの:」の宣言があれば、役ごとの宣言の区間の key も予約のキー `§roles` に書く）、その文書のキーを stdout の `entry` に、内容の digest を `entry_digest` に出す（script は `state.entry_digest` に持ち、段 5・8 の監査の `doc` の `entry_digest` と照らして、違えば `blocked`。入口が書き換わると、生成者が自分の指摘を既存の指摘にできるため） |
| `get --ledger <台帳> [--doc <キー>] --ids <ID,…> [--fields <欄,…>]` | 台帳を読む役（読み方は契約の「共通の約束」） | 台帳から ID の要素を加工せずに選んで stdout に出す。無い ID は `missing`、stdout の上限（`STDOUT_BUDGET`）に入らない ID は `over_budget`（ID の一覧だけで上限を超えれば exit 1）。何も書かない |
| `view --ledger <台帳> [--doc <キー>] [--fields <欄,…>]` | 台帳を全件読む役（読み方は契約の「共通の約束」） | 台帳の全件を、要素ごとの JSON（`{"<配列名>": 要素}`、スカラーは `{"<名前>": 値}`）の欄と配列の要素を 1 行ずつにして `checks/view-<台帳のファイル名>[.<--fields の fnv>].txt` に書き、stdout にパス・要素数・行数・sha256 を出す（Read は 2000 字を超える行を切る）。名前は台帳と `--fields` だけで決まる |
| `contract --role <役のファイル名> --part <n>` | どの役も（起動の最初。プロンプトが全部の `--part` を挙げる） | 役が読む契約の節（`CONTRACT_SECTIONS`）を契約から逐語で切り出し、`CONTRACT_BUDGET` バイト以下の `n` 番目の断片を出す（断片は節か行の頭で切れ、つなげると全体に戻る。断片が無い `n` は空）。stdout は JSON ではなく節の本文。見出しが 1 つでも無いか、断片が `CONTRACT_PARTS` を超えれば何も出さずに exit 1 |
| `describe` | どの役も（台帳の名前と欄を確かめるとき） | `LEDGERS` から導出した台帳の名前・ファイル・配列・欄・閉集合と、モードの一覧、指摘の符号を出す。W を読まず何も書かない |
| `sha --ledger <台帳> [--doc <キー>]` | plan reviewer（検証を始めるとき）、writer | 台帳の sha256。まだ無い台帳は空の台帳の値 |
| `questions --ids <RS-…> [--check]` | 司令塔（`needs_answers` で問いを出す前）。`--check` は問いを出した resolver（返る前） | resolutions.json の問いから `questions.md`・`questions.json` を導出する。候補の `flow_refs` が flow.json に無い要素を指すか、`answer` が残っていれば（回答済みの問い）不合格。`--check` は同じ形の検査だけを行って何も書かず、stdout に検査した `ids` と不合格の件数（`findings`）と `bad_ids` と理由（`bad`。stderr にも）を出す |
| `answers --file answers/<ゲート>.md --ids <RS-…>` | flow-check（`next_args` で 3a・3a' から始めた run の入口と、`gates_answered` のゲートを越える前と、回答を当てる段がそのゲートの stdout を持っていないとき） | 回答のファイルがあるか（`exists`）と、`<ID>:` で始まる行の無い問い（`missing`）と、候補の `label` 1 つだけではない回答の節の逐語（`free`。`{id, from, to, text}`。label の後に自由欄が続くか label と違う回答。節の切り方は answer_holds と同じ doc_check の `answerSections`（頭は台帳にある ID の行）。空の回答は入らない）を stdout に出す。script は `free` を回答を当てる resolver のプロンプトに写す（prd-spec.js の `answerExcerpt`）。何も書かない |
| `report [--drafts <RS-…>] [--findings <ID,…>] [--formal-off <skill_missing\|host_unsupported>]` | 司令塔（`report_path` が返ったとき） | resolutions.json の `method`・`answered_by`・`hold`・`upstream_revision` から `report.md` を導出する。最後に「形式検証」の節（`--formal-off` か `fm/off.json` があれば最初に行わなかった理由、依頼ごとの outcome と停止の理由、目標ごとの判定・理由・保証・検出、重なり、`fm/facts.json` の未検証、今の版で事実の無い単位）を置く。`--drafts` に挙げた hold は「本文に未反映」の節に分ける（hold でない ID があれば何も書かない）。「本文に反映していない指摘」の節（上位文書の改訂の文案の前）には、`--findings` の各 ID（返り値の `unreflected`）を `W/findings/` の指摘のファイル（ID から引く規則は契約「### 指摘の形」）から引いて `- <ID>（<doc> <item_id>。blocking: <真偽>）: <issue>` で blocking の真を先に並べ（ファイルか要素の無い ID があれば何も書かない）、`checks/doc.json` の指摘のうち blocking に数えるものを `- <id>（<document> <location>）` で並べ、既存の指摘（`preexisting`）は件数の 1 行にする（`checks/doc.json` が無ければ doc_check の指摘は 0 件）。stdout に節の行数（`unreflected`）を足す。run の後なので動いている label は無く、`tmp/<label>/` をすべて消して `checks/report.swept.json` と stdout の `swept` に出す |
| `quotes --findings <r<n>-wr-<組>,…>` | 指名された whole reviewer（段 5・8 の判定の前） | 名前の形が `r<n>-wr-(all\|p<k>)` でないか、回が揃わないか、`W/findings/<名前>.json` が無いか JSON でなければ止まる。各指摘の `quote` が W の原文（固定の文書を含む全ての文書の本文と meta、`input.md`、`answers/*.md`、台帳の decisions・resolutions・flow。指摘の文書と項目には絞らない）のどれかに在るかを、ファイルごとに照らす。正規化は在る向きにだけ倒す: 両側を NFKC にし、quote を `...`（`…` を含む）で断片に分け、文字と数字以外を除いた形（plain）と、その前に HTML のタグ・Markdown のリンクの行き先（`](…)` の括弧の中）・JSON の文字列のエスケープ（`\n`・`\t`・`\"`・`\\` など）を外した形（stripped）を、quote と原文のファイルの両方で作り、quote の 2 つの形と原文の 2 つの形のどの組でも、quote の空でない断片が全て同じファイルの中にこの順で在れば在るとする。どの組でも無ければ `not_found`、quote が無いか、quote のどちらかの形が正規化して空になれば `no_quote`（記録だけ）。結果を `checks/quotes-r<n>.json` に書き、stdout に `findings`（照らした件数）・`files`・`ids`・`unquoted`（not_found の ID）・`path`・`tree_digest`（tree-digest と同じ式）を出す |
| `formal-request --rid <f<回>a\|f<回>b> --stage <5\|8> --phase <a\|b>` | flow-check（段 5・8 の本体の最初） | 形式検証の単位（定義は schemas/agent-contracts.md「## 形式検証の事実」）を取り、送る単位を決める。依頼 a は 1. `fm/facts.json` にその単位の最新の事実があれば digest が違うか `retry` のときだけ 2. `checks/entry.json` があれば自分か依存の区間が入口から変わったときだけ 3. どちらも無ければ送る。依頼 b は依頼 a に入れた単位のうち digest が変わったものだけ。送らない単位は `unsent` に理由を残す（送る単位が 0 でも `fm/facts.json` の `unverified` に残す）。送る単位があれば、単位と依存を持つ文書を `fm/<rid>/target/` に逐語で写し、formal-method の依頼（`fm/<rid>/request.json`。targets・goals・名前と参照の対応の known_requirements・送る行だけの scope・`time_limit_seconds`）と対応表（`fm/<rid>/units.json`）を書き、`<W>.formal` を作る。stdout は `rid`・`goals`・`units`・`unsent`・`tree_digest`（送る単位があれば `request_digest`・`request_fnv`・`cwd` も）。取り込み済みの rid は作り直さず exit 2、outcome の無い rid は上書きする |
| `formal-import --rid <rid> --run-dir <run_dir>` / `formal-import --rid <rid> --unavailable no_result [--run-dir <run_dir>]` | 司令塔（`needs_formal` の formal-method の手順の後。SKILL.md「## 中継」） | `--run-dir` があれば、その実際のパスが `<W>.formal/.formal-method/runs/` の下にあり、そこの `request.json` の対象の location と目標の id の集合が `fm/<rid>/request.json` と同じかを照らし、`result.json` があれば schema が `formal-method.result/2`・`provisional` が偽・対象の指紋が依頼と同じときだけ取り込む（outcome `result`。照合に落ちれば `rejected`、`result.json` が無ければ `provisional`、`--run-dir` が無ければ `no_result`）。目標ごとの判定（契約「## 形式検証の事実」）を `fm/facts.json` に、outcome を `fm/<rid>/outcome.json` に書く。`result` 以外は全ての目標を `未検証` にし、単位に `retry` を付ける。stdout は `rid`・`outcome`・`counts`・`cex_docs`。どの outcome でも exit 0、同じ rid の 2 回目は何も変えずに前の outcome を返す。使い方の誤りは exit 2 |
| `formal-status --rid <rid>` | flow-check（段 5・8 から始める run の入口） | 読むだけ。`request.json` のバイト列から求め直した `fnv`、`units.json` の `request_digest` と合うか（`units_digest_ok`）、取り込みの `outcome`（無ければ null）と `counts`・`cex_docs`、依頼の木と今の木（`tree_digest_request`・`tree_digest_now`）を出す |
| `formal-off --reason <skill_missing\|host_unsupported>` | 司令塔（`formal: false` で呼ぶ前） | `fm/off.json` に形式検証を行わない理由を書く（report.md の「形式検証」の節の最初に書く。段 1 の入口の reset は消さない） |
| `formal-model [--doc <キー,…>]` | 司令塔（保存の前） | 仕様書（`specifications/<topic>`）の状態図と状態表から TLA+ 形式モデル（`<Topic>.tla`, `<Topic>.cfg`, `README.md`, `check.test.mjs`）を導出して `W/formal/<topic>/` に書く。stdout の `formal_models[].files` に生成したファイル一覧を出す |

`node doc_check.mjs <input.json>` の形（文書のパスと申告を JSON で渡すもの）も残っている。構造検査などの本体は同じだが、台帳を読まないので、発生源の検査と要素の振り分け（`ST-REQ-NO-ORIGIN-`・`ST-NOTCHECKED-FLOW-NO-ORIGIN`）は行わない。
fixture テストがこの形で移設前の結果との一致を確かめている。
