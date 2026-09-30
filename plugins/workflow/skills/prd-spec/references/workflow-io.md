# prd-spec.js の入出力と再実行（workflow-io）

**目次**: [1. args](#1-args) · [2. model と effort の既定](#2-model-と-effort-の既定) · [3. 返り値と再実行](#3-返り値と再実行) · [4. 段と起動の条件](#4-段と起動の条件) · [5. 本流から外れた状態](#5-本流から外れた状態) · [6. doc_check の CLI](#6-doc_check-の-cli)

`workflows/prd-spec.js` は段の順序・起動の条件・上限・返り値の検査だけを持つ Workflow script である。ファイルを読めない
ので、分岐に使う値（件数・ID・digest）はすべて agent の返り値から受け取り、`next_args.state` に載せて
返す。本体（flow・台帳・文書）は W にだけ置き、state には flow.json の内容の sha256（`flow_digest`）のような digest を載せる。各 agent が読み書きするファイルの形は `schemas/agent-contracts.md` を正とする。

## 1. args

| args | 意味 |
|---|---|
| `workspace` | W の絶対パス（S0 で作ったもの） |
| `skillDir` | このスキルの絶対パス。agent が役割ファイルと契約を Read するパスはここでしか決まらない |
| `entry` | `new` / `existing` / `expand`。既存文書の監査と改訂は `existing`（SKILL.md の S0 の表） |
| `existing_docs` | `existing`・`expand` のとき必須。`[{ key: "<kind>/<topic>", source: "<元のパス>", fixed: true \| false }]`。本文は W に置いてある。`key` が文書のキーの形（`prd-spec.js` の `DOC_KEY`）でないか `fixed` が真偽値でなければ、run は agent を起動する前に止まる（`key` は段 1 の入口の reset のコマンド文に入る） |
| `from` | 始める段（省略時 `1`）。`1` / `2` / `3` / `3a` / `3b` / `4` / `5` / `6` / `3a'` / `7` / `8` / `9` |
| `state` | `from` が `1` 以外のとき要る。前の run の `next_args` ごと渡す（§3） |
| `role_opts` | 任意。役割ごとの `{ model, effort }` の上書き（§2） |
| `gates_answered` | 任意。`{ <ゲート（prd-spec.js の GATE_ANSWERS のキー）>: [<そのゲートの needs_answers の question_ids>] }`。形が違えば agent を起動する前に止まる。いつ何を足すかは SKILL.md「## 中継」の「呼び直し」が正。ゲートを越える条件は prd-spec.js の `needsAnswers`。`next_args` には載らず、`state_hash` にも数えない |

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
キーもそこの役割名である（表に写すと、値を直したときに片方だけが古くなる）。`model` は `haiku`・`sonnet`・`opus`・`fable`・
`claude-` で始まる完全な model ID・`inherit`（その役の model を外し、セッションの model を継承させる）、`effort` は `low`・`medium`・`high`・
`xhigh`・`max` を受ける（Workflow の `agent()` が受ける値。`prd-spec.js` の `MODELS`・`MODEL_ID`・`EFFORTS`）。

## 3. 返り値と再実行

```json
{
  "status": "done | needs_answers | blocked",
  "questions_path": "needs_answers のとき W/questions.md（司令塔が doc_check questions で導出してから見せる）",
  "questions_json_path": "needs_answers のとき W/questions.json（選択式で出すための同じ問い）",
  "gate": "needs_answers のときそのゲート（g0・g0-2・g1）",
  "answers_path": "needs_answers のとき W/answers/g0.md・g0-2.md・g1.md のどれか",
  "question_ids": ["RS-004"],
  "report_path": "done（と、stop_reason が pass_limit か no_progress の blocked）のとき W/report.md（司令塔が doc_check report で導出してから見せる）",
  "remaining_blocking": ["stop_reason が pass_limit か no_progress の blocked のとき、本文に反映されていない blocking の指摘の ID（hold の文案にしたものを含む）"],
  "carried_blocking": ["stop_reason が pass_limit か no_progress の blocked のとき、remaining_blocking のうち最後のパスの監査が出したのではなく前のパスから持ち越した ID"],
  "doc_blocking": "stop_reason が pass_limit か no_progress の blocked のとき、残った doc_check の blocking の件数",
  "next_args": "needs_answers と、やり直せる blocked のとき。次の run の args（渡し方は下の 1 つ目の項）",
  "tree_digest": "最後の監査が見た木の digest（done のとき）",
  "open_tbd": ["開いている TBD の ID"],
  "holds": ["本文に反映した保持規則の resolution の ID（writer に渡したもの）"],
  "hold_drafts": ["文案だけで本文に無い保持規則の resolution の ID（輪を出た後に resolver が作ったものなど。remaining_blocking の指摘と対になる）"],
  "missed": ["渡したのに裁定されなかった論点（finding:… / tbd:…）"],
  "integrity": ["sha256 の照合で食い違った事実"],
  "notices": ["照合ではない所見（監査の時点で W に所有表に無いファイルがあった、など）"],
  "undeclared": { "requirements/auth": ["writer が申告せずに変えた項目キー（追加の監査を当てたもの）"] },
  "stop_reason": "改稿と監査の輪を収束せずに出た blocked のとき `pass_limit`（MAX_AUDIT_PASSES に達した）か `no_progress`（進展なし）、token の目標（Workflow の budget.total）に達して agent を起動できずに止まった blocked のとき `budget`（next_args が付く。目標を上げてから渡す）。それ以外は null（値の集合は prd-spec.js の STOP_REASONS）",
  "passes": "改稿と監査のパスの数",
  "item_routes": { "requirements/auth#PR-AUTH-003": "再発で経路を変えた項目の今の経路（decision | hold | exhausted）" },
  "skipped": [{ "step": "起動しなかった agent の label（verifier:3a'v など）", "fact": "外した事実の符号: `unchanged`・`carried_only`（値の集合は prd-spec.js の SKIP_FACTS）", "ids": ["根拠の ID（unchanged は候補の選択で当たった回答、carried_only は 3a から持ち越した問い）"] }],
  "reason": "blocked のときの理由。needs_answers でも、gates_answered の問いが今の問いと違ったときと、回答のファイルの検査に落ちたときはその理由",
  "resumable": "resumeFromRunId で呼び直して進むか。needs_answers は回答のファイルの検査（flow-check の doc_check answers）に落ちたときのほか true、blocked は next_args があり、結果を返さずに終わった agent があるか stop_reason が budget のときだけ true（完了した agent は resume で保存された結果を返すので、それ以外の blocked は同じ所で同じ理由を返す）"
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
  生成者の検査した版から変わっていた・settle を持たない段（prd-spec.js の `ASKS` に無い段）の入口の flow に不合格の要素があった・段の出口の不変条件に反した（§5）、
  のように、同じ段をやり直しても変わらないときは付かない。settle を持たない段の入口の不合格は、その前の段が不合格の要素を持って出られない（§5）ので、
  所有表の外の書き込みである。司令塔は `reason` の要素と `W/verifications.json` を依頼者に示し、W を戻すか S0 からやり直すかを決めてもらう。
- **段の書き込みは token ごとの取引にする。** script は段に入るたびに token（`prd-spec.js` の `txToken`。`t<段の通し番号>` と、同じ段の再実行の
  `r<回数>`。state から決まり、nonce を含まない。nonce にするとプロンプトが run ごとに変わり、キャッシュが効かない）を決め、台帳を書く役の
  プロンプトに載せる。doc_check の put・del は token ごとに、その台帳の最初の書き込みの前に控えを取る（契約の所有表の `tx/<token>/*`）。
  新しい token の最初の書き込みはそれより前の token の控えを消すので、段を出た後の run は済んだ段より前へ戻せない。後の token の控えが
  あれば、前の token（止まった run の遅れた書き込み・打ち間違い）の put・del は何も書かずに止まる（通すと、今の段の再実行が戻す控えを消す）。
  blocked の `next_args` で同じ段からやり直す run だけが
  （`state.tx.restore` があり、`state.tx.stage` が `from` と同じとき）、入口の flow-check（`<from>-entry`）で `doc_check flow` の前に
  `doc_check restore --token <state.tx.restore>` を実行させ、止まった run の台帳の書き込みを取り消す（token の下で作られた台帳は消す。
  answers・plan.json・checks は戻さない）。文書の本文は writer が Edit で書き、doc_check を通らないので、段 4・7 は writer を起動する前に
  flow-check（`<段>-backup`）に `doc_check backup --doc <その段の writer の文書のキー> --token <段の token>` を実行させて本文の控えを取り
  （stdout が返らなければ writer を起動せずに blocked。その段から）、入口の restore が台帳と一緒に本文を戻す。戻さないと、止まった run が途中まで
  書いた本文が再実行の入力になり、`expand` では S0 が置いた既存文書の原文が W から失われる。段 2 の入口は flow.json がまだ無いことがあるので restore だけを実行させる。restore の stdout が
  返らなければ、同じ token を戻させる `next_args` で止める（restore は何度流しても同じ結果になる）。戻す控えが後の段の token（通し番号が大きい。
  打ち間違えた token か古い `next_args`）の最初の書き込みで消えていれば、restore は何も変えずに stdout の `pruned_by` にその token を挙げ、
  run は `next_args` を付けずに止まる（W を段の入口に戻せないので、同じ `next_args` では同じ所で止まる。S0 からやり直す）。restore の前の
  flow.json が、止まった run が最後に照合を通した版（`state.tx.flow`。flow を書く役のいる段 2 と settle を持つ段だけに付く）と違えば
  `integrity` に 1 行足す。needs_answers の `next_args`・次の段の run には `restore` が付かないので restore しない。
- **段 1 から始める run は、W を S0 の直後に戻してから始める。** 新しい run も、段 1 からの再実行も、入口の flow-check（`1-entry`）に
  `doc_check reset --keep <existing_docs の全部のキー> --fixed <existing_docs の fixed のキー>` を実行させ、その stdout（残した文書と固定の文書の
  キーが args と一致し、固定の文書ごとの `fixed_sha256` があるもの）を受け取るまで intake を起動しない。`fixed_sha256` は `state.fixed_sha` に入り、
  段 5・8 の監査の snapshot（`--fixed`）が返す値と照合する。違えば固定の文書を誰かが書き換えたので（固定の文書の書き手はいない）、`integrity` に
  1 行足して `next_args` を付けずに止まる（どの段からやり直しても W の本文は戻らない。本文を `existing_docs` の `source` から置き直して段 1 から）。
  固定の文書があるのに `state.fixed_sha` が合わない `next_args` は、agent を起動する前に止まる。reset は S0 が書いたもの（依頼文・先例の一覧・`existing_docs` の文書）と
  所有表の外のファイル・`tmp/` を残して段の書き込みと `--keep` に無い文書を消し（消すものの正本は doc_check の `wsReset`）、固定の文書の
  meta を書き直す。`--keep` に無い文書を消すのは、S0 が置くのは `existing_docs` の文書だけで、それ以外は前のランの writer の文書だからである
  （同じ W で S0 からやり直すと、meta の無いまま INDEX に載り、同じ topic の単位の writer に前の草稿が渡る）。put はキー単位で足すので、戻さずに始めると前のランや止まった段 1・2 の
  要素と欄（intake が付けた D- の kind・quote、止まった flow-framer が足した O-）が再実行の書き込みの後にも残り、前のランの後の段の token の
  控えは新しい run の t1 の書き込みを拒む。answers も消すのは、段 1・2 が回答を読まず、新しい run は RS- を振り直すので、残った回答の ID が
  別の問いを指すからである。段 1 への `next_args` は `state` を持たない（止まった run の state を運ぶと、戻した W と食い違う）。
- **再実行は、戻す token と別の token で書く。** 再実行の書く token は `try` で変わり、戻す token（前の回の書く token）と一致しない。
  resume は元の run の args で呼び直すので、restore が入口のプロンプトに載るのは、元の run が `next_args` による同じ段の再実行だったときだけで、
  その入口の flow-check は完了していれば保存された結果を返し、restore を実行しない。入口の flow-check が結果を返さずに終わっていて live で
  走り直しても、その run 自身の書き込みは戻らない: 戻す token の控えは、最初の restore が消したか、その run の最初の書き込みが消している
  （実物の doc_check は `tests/test_ledger.py` が押さえる）。一方、プロンプトが変わって入口の agent が live で走り直すと、段を出た後まで進んだ run では
  restore が後の段の token の `pruned_by` で止まり、段 1 の入口の reset は W を S0 の直後に戻す。
- **段 3 以降から始める run は、最初に W を読み直す**（`prd-spec.js` の `enterFromDisk`）。W の台帳は、同じ段の再実行では restore で
  `next_args.state` と同じ段の入口の版に戻り、needs_answers の再開では前の run が段を出たときのまま（answers だけが増える）なので、
  W を state に写し直すことはしない。違いうるのは所有表の外の書き込みだけで、flow-check（`<from>-entry`）の `doc_check flow --rulings` の
  stdout で flow.json の版が `state.flow_digest` と違えば、止めずに `integrity` に 1 行足してその版を使い、今の版に合否の無い要素と resolution を
  段の本体と同じ経路（§4 の共通の行の `<段>v-left` と変換。label は `<from>v-entry`・`<from>-entry-convert`）で検証させる。版の食い違いで
  止めないのは、要素の合否が (id, digest) で付くので書き換えた要素は検証を通っていない要素に戻り、ここで検証されるからである。それでも
  不合格の要素が残れば、`next_args` を付けずに blocked にする（段の本体に直す役が来るとは限らない）。段の途中の版の食い違い（verifier・
  flow-check・flow を書かない resolver の後）は止める。flow-check の食い違いは、flow を書ける resolver の cycle で verifier を外した後（`unchanged`）なら
  段からやり直せる blocked にし（外す前の verifier の照合と同じ）、それ以外は所有表の外の書き込みとして `next_args` を付けない。
- `integrity` の行は、段の入口の flow.json が `next_args` の版と違った、再実行の入口の restore が照合の前に止まった flow.json の書き込みを取り消した、writer が読んだ resolutions.json と台帳の最新が違った、verifier が検証した版と resolver が
  書き終えた版が違った、verifier が `doc_check flow` で検査した flow.json の `content_sha256` が生成者の検査した版と違った、verifier が返した F- の合否が `doc_check flow` の stdout（verifications.json）に無かった、flow-check が検査した flow.json の `content_sha256` が検証を通った版と違った、flow-check の前に応答した resolver が返した `doc_check flow` の stdout が flow-check の stdout と違った（契約 §flow-check）、のような食い違いである。事後報告に添える。段の途中の flow の版と F- の合否の食い違いだけは run を blocked にし（違う flow や記録されていない合否を見た検証を台帳に入れないため）、それ以外は run を止めない（script は flow-check の stdout しか判断に使わないので、止めても守る判断が無い）。
- **doc_check の stdout の写しが checksum に合わなければ、流し直してよいコマンドだけを取り直す**（`prd-spec.js` の `recopy`）。agent は stdout を
  返り値に手で写すので、壊れた JSON や、一覧の要素を 1 件落とした正しい JSON が返る（実測: R16 の run3 で flow-check:3a の haiku が約 3.5KB の
  `flow --rulings` の stdout を壊れた JSON に写した）。形の検査だけでは後者が通り、落ちた O- や未検証の要素が誰にも見えないまま進む。そこで script は
  写しの本体から digest（§6 の `stdout_fnv`）を計算し直し、合わない写しと壊れた JSON を同じ「写し損ね」として受け取らず、同じコマンドを
  flow-check に `flow-check:<元の label（flow-check でなければ : を - にして前に役の名前）>-recopy` で 1 回だけ実行させる。JSON の行の無い値
  （失敗したコマンドの stderr）は写し損ねではなく、これまでの経路（差し戻しか blocked）で扱う。取り直しも合わなければ、`reason` に checksum と
  書いて段からの `next_args` で止まる（resume は保存された同じ写しを返すので `resumable` は偽。`next_args` で呼び直す）。判断する役
  （resolver・resolver-verifier・監査役）を起動し直して写しを取らない（判断ごとやり直すことになる）。呼び出しの場所ごとの扱い:

  | 写しを返す呼び出し | コマンド | 取り直し |
  |---|---|---|
  | flow-check（`<段>`・`<from>-entry`） | `flow --rulings` | する（読むだけ） |
  | flow-check（`<from>-entry`） | `restore --token <state.tx.restore>` | する（控えを消した後の restore は何も戻さず同じ W を返す） |
  | flow-check（`1-entry`） | `reset` | する（2 回目は何も消さず、残した文書と `fixed_sha256` は同じ） |
  | flow-check（`<ゲート>-answers`） | `answers` | する（読むだけ） |
  | flow-check（`<段>-backup`） | `backup` | する（同じ token の控えがあれば取り直さない。writer の前なので本文は同じ） |
  | resolver-verifier | 最後の `flow --rulings` | する（verifier の put の後の W をそのまま読む） |
  | resolver・flow-framer | `flow`・`conflicts`（flow-framer は `plan` も） | する（生成者が返った直後の W を読む） |
  | resolver・flow-framer | `questions --check` | する（問いの形の検査の対象の ID で。読むだけ） |
  | intake | `plan` | する（読むだけ） |
  | 指名された監査役 | `doc`・`tree-digest` | する（読むだけ。段 8 は追加の監査役を決める前に取り直す） |
  | 指名された監査役 | `snapshot --save` | しない（監査の基準を書き直し、`--live` は監査役の実行中の値）。段 5・8 から `next_args` で止まる |

- `holds` と `hold_drafts` は、writer に渡したか（`state.settled_written`）で分ける。渡しただけで本文に入ったとは限らず、
  当て損ねは直後の監査が拾う。
- `notices` の行は、照合の食い違いではない所見である（段 5・8 の監査の基準の snapshot が、W に所有表に無いファイルや
  分量の目安を超えたファイルを数えた、など。行には件数と一覧のファイルのパスだけを載せる）。run は止めず、事後報告に添える。`integrity` に混ぜないのは、その件数を改善候補の
  選別（`scripts/goal_selector.py` の R4）が照合の食い違いとして数えるからである。
- `skipped` は、事実の条件で起動しなかった agent の記録で、その run（leg）で走った分だけを持つ。W の状態の所見ではないので `notices` に
  混ぜず（混ぜると `notices_count` の意味が変わる）、`state` にも載せない。resume は script を頭から走り直すので、その leg の全体を返す。
- `undeclared` は、writer が申告せずに変えた項目を文書ごとに並べたもの。監査は追加で当てているが、申告の漏れ
  そのものは writer の契約違反なので、事後報告と合わせて見る。

## 4. 段と起動の条件

| 段 | 起動する agent | 起動の条件・上限 | 次 |
|---|---|---|---|
| 1 | flow-check（`1-entry`）→ intake | 常に。入口の reset の stdout が無いか固定の文書のキーが違えば intake を起動せず blocked（段 1 から。§3） | 返した `plan_check`（doc_check `plan`）に指摘があれば、0 件になるまで差し戻す（前の回より減らなければ止める。上限は prd-spec.js の `MAX_CHECK_REWORK`。以下の差し戻しも同じ）。直らない、writer の単位が循環・未知の依存を持つ、固定の文書が単位に入る、既存文書がどの単位にも無い → blocked |
| 2 | flow-framer（blocked の後の同じ段の再実行では、その前に flow-check（`2-entry`）が restore だけを実行する） | 常に。返った `doc_check flow` の stdout の指摘が 0 件でなければ差し戻す | 閉じなければ blocked（初稿を始めない）。0 件なら `content_sha256` を `state.flow_digest` にする。flow-framer が実行した `plan` の `content_sha256` が段 1 の `plan_check` と違うか指摘があれば blocked（段 1 から） |
| 3 | resolver | W に裁定の無い open と組（段 2 の flow-framer の stdout か、入口の flow-check の stdout の `open_ids`・`pair_keys` のうち、どの resolution の `about` にも無いもの）だけを渡し、どちらも 0 件なら起動しない。問いを出したのに `questions --check` の stdout が無いか不合格なら差し戻す（3a・3b・3a'・6 も同じ） | 直らなければ blocked |
| 3v | resolver-verifier | 常に（intake の既定と flow の出典を検証するため）。verifier も最後に `doc_check flow` を実行する | その `content_sha256` が `state.flow_digest` と違えば `integrity` に 1 行足して blocked、その cycle で flow を書いた生成者が消せる指摘が 1 件以上でも blocked（3av・6v も同じ。消せない指摘と、台帳の書き込みで出た指摘は settle の flow-framer に渡る。契約 §resolver-verifier）。不合格は resolver に 1 回だけ差し戻し（label は `<段>-fix`、その再検証は `<段>-fixv`）、再検証（落ちた F- ごとに about を `{verification}` にした resolution が返らなければ blocked。段の頭から）。それでも不合格なら問いか保持規則に変えて、もう検証しない（どちらにするかは prd-spec.js の `convertFailed`: 聞ける段では価値の論点・`value_as_method`・cycle の入口で問いだった ID を問いにし、聞けない段では hold だけ。`decidable` で落ちたものが既にその種類なら書き換えない。flow の要素は書き換えるまで。指定と違う種類で返れば 1 回だけ書き換え直させ（`<段>-convert-kind`）、それでも違えば blocked。契約 §resolver）。聞ける段で script が指定していない hold を resolver が新しく返せば 1 回だけ問いに書き換え直させ（`<label>-toquestion`）、それでも hold なら blocked（段の頭から。契約 §resolver）。verifier の `decidable` を受け取れなければ 1 回だけ聞き直す（`<label>-source`。契約 §resolver-verifier） |
| G0 | flow-check（`g0-answers`。`gates_answered` にこのゲートがあり今の問いがその ID と同じときと、`next_args` で 3a・3a' から始めた run が回答を当てる前） | 問いが 1 件以上 | `needs_answers`（`from: 3a`）。`gates_answered` の ID と今の問いが同じで、回答のファイルが問いのすべてに答えていれば 3a（G0-2・G1 も同じ） |
| 3a | resolver → verifier（候補の選択だけの回答でも起動する。回答を当てた resolver が返す `doc_check flow` の stdout を照合するため。ただし検証する resolution が無く、resolver が flow を変えず（段の入口の版は前の段の出口か入口の flow-check で照合済み）、今の版に合否の無い要素も無いときは起動せず、返り値の `skipped` に載せる。そのときは settle の flow-check が stdout を取り直し、`carry` も含めて残りは `<段>v-left` が検証する（prd-spec.js の `unchanged`。3a' も同じ）） | G0・G0-2 の後。resolver の stdout に resolver が消せる指摘（契約「flow.json の形」の直し手）があれば差し戻す。消せない指摘は差し戻さず、同じ cycle の settle の flow-framer に渡す | G0 の後は 3b（flow-framer `3b-reframe` が回答で flow を組み直し、持ち越した問いの `questions --check` も返す（不合格なら `3b-reframe-questions` が形を直す）。resolver はまだ裁定の無い open か組があるときだけ起動し、それと持ち越した問いを裁定する。持ち越した問いだけなら起動せず、返り値の `skipped` に載せ、問いはそのまま G0-2 で聞く。組み直した flow は `3bv` が照合する）。そこで問いが残れば G0-2（`answers/g0-2.md`、`from: 3a`）の 1 回だけ聞く。G0-2 の後に出た問いは保持規則 |
| 3・3a・3b・3a'・6 の共通 | resolver（`<段>-pairs`・`<段>-opens`）、flow-framer（`<段>-settle`）→ verifier（`<段>v-settle`） | flow を変えた呼び出しの後、`conflicts` の `pair_keys` にまだ裁定の無い組があれば、settle の flow-framer の後は `open_ids` にまだ裁定の無い O- もあれば、1 回の resolver に渡す（O- があれば `<段>-opens`、組だけなら `<段>-pairs`。`<段>` は呼び出した resolver の段で、settle の後は `<段>-settle`、差し戻しの後は差し戻しの label（3v の行）になる。聞けない段では hold で、問いを返せば blocked。3b の組み直しの後の resolver にも同じ集合を渡す。渡した組と O- は次の verifier の stdout と照合する。契約 §resolver-verifier）。verifier は、どの呼び出しでも W の今の版に合否の無い要素を検証する（契約 §resolver-verifier）。最後の verifier の後に resolver を起動していれば flow-check（契約 §flow-check）を起動する。判断に使う stdout（`doc_check flow --rulings`。`resolutions` に裁定と今の版の合否が載る）から、返り値に載らなかった裁定（resolver が書いたのに返さなかったもの・所有表の外の書き込み）を受け取り、今の版に合否の無い要素か、合否が無いか script の持つ合否と違う resolution があれば verifier（`<段>v-left`。settle の n 回目の後は `<段>v-left-<n+1>`）に検証させ（この verifier が残せば blocked。段の頭から。script の持つ合否は、検証を求めた verifier の返り値からだけ入る）、検証に落ちたまま問いにも保持規則にもなっていない裁定（RS-）と `decidable` で落ちた問い・保持規則を段の本体と同じく 1 回差し戻し（`<段>-left-fix` → `<段>-left-fixv`）、それでも落ちれば変換する（`<段>-left-convert`）。どの verifier でも、hold のまま検証に落ちた保持規則（`decidable` を除く。保持規則にしたこと自体の不合格なので差し戻しに回す）は変換に回さず（変換はもう検証しないので、落ちた規範文が writer に届く）、同じ ID のまま書き直させて検証し直す（`<呼び出し>-rehold` → `<呼び出し>-reholdv`。`<呼び出し>` は落とした verifier の段か label）。書き直した直後の検証でも落ちるか、差し戻し（3v の行）の後も hold のまま落ちれば blocked（段の頭から）。合格すると数え直すので、後の verifier で落ちればまた書き直させる（回数は verifier の呼び出しの数で決まり、settle の回数は `MAX_SETTLE_ROUNDS` で抑えられる）。W の ruling が hold でなくなった ID は、保持規則として数えない。判断に使う stdout（同じ節）の `open_only` のうち、合格か回答で閉じた O- の組か、この cycle で裁定が決まった `origin: flow` の指摘か、不合格の要素（`failed_current` のうち、検証の裁定が保持規則か回答待ちの問いのものを除く。合格した検証の裁定があればその裁定を写させ、無ければ落ちた理由で直させる）か、`stale_refs`（覆された決定か検証に落ちた不変条件を引く要素）か、flow の指摘（`codes`。符号によらず）があれば settle を起動する（保持規則への変換（`<段>-hold`）の後も同じ）。settle の verifier に落ちた裁定（RS-。保持規則は `decidable` で落ちたものだけ）は、段の本体と同じく 1 回差し戻し（`<段>-settle-fix` → `<段>-settle-fixv`）、それでも落ちれば問いか保持規則に変え（`<段>-settle-convert`。検証はもう回さない）、settle は残り（閉じた未決を引く要素・覆された決定を引く要素・不合格・flow の指摘）が 0 になるまで回し、減らなければ止める（上限は `MAX_SETTLE_ROUNDS`） | 直らなければ blocked（段の頭から。`next_args.state` は §3） |
| 4 | flow-check（`4-backup`）→ writer | 単位の依存の向きに波を作り、同じ波は並列。writer の前に全単位の文書の本文の控えを取る（§3） | 応答しない単位があれば blocked（一度も書かれていない文書を監査しない） |
| 5 | implementer・grounding（文書ごと）、cross-doc（全文書で 1 体。指名） | 常に。`entry: existing` は 3 の後ここへ | cross-doc が `audited-1` を返さなければ blocked |
| 6 | resolver → verifier | W に裁定の無い（どの resolution の `about` にも無い）decision の指摘と新しい TBD だけを渡し、どちらも 0 件なら起動しない（回答待ちの問いがあれば、起動しなくても G1 か保持規則へ）。writer の指摘はここを通らず段 7 へ。再発した項目は、前のパスの指摘とその裁定の ID を渡して項目の次元を裁定させ、decision の後にも再発した項目は hold を指示する | 1 パス目の問いは G1、2 パス目以降の問いは保持規則 |
| G1 | flow-check（`g1-answers`。G0 と同じ） | 1 パス目の段 6 で問いが出た | `needs_answers`（`from: 3a'`） |
| 7 | flow-check（`7-backup`）→ writer（変更がある単位だけ） | writer の指摘・routes・doc_check の指摘・前回の書き込みの後に決まった裁定のどれかがある単位。writer の前にその単位の文書の本文の控えを取る（§3） | 何も無ければ 9 へ（blocking が残っていれば `stop_reason: no_progress` で blocked） |
| 8 | grounding（変えた文書）、implementer・cross-doc（その観点が指摘した項目が変わったとき）。1 体を指名 | 改稿の後は必ず | 申告に無い変更があれば、それが起きた文書ごとに（diff の `by_doc` で分け、その文書の申告を引いて）implementer と grounding を追加で起動（指名された監査役の返り値だけで決まるので、ほかの監査役を待たずにその返り値に連ねる。起動は指名された監査役の snapshot の後なので、`--live` には挙げない）。blocking（指摘・doc_check・新しい TBD）が 0 なら 9 へ。残れば経路を決めて 6 へ戻る: 前のパスと今のパスの両方で blocking の項目（再発）は writer に回さず、1 回目は decision、decision の後は hold、hold の後は尽きた項目（以後どの経路にも回さない）にする。前のパスで段 6 が裁定して合格した指摘と同じ項目・同じ `direction` の指摘で、その後の改稿がその項目に裁定を当てただけのもの（項目が変わっていないか、そのパスの段 7 がその項目に writer の指摘を渡さずにその裁定を渡した）は、既裁定の再出として再発にも blocking にも数えず `notices` に出す。尽きた項目の指摘は、その項目に指摘を出したことのある役がすべてそのパスでその項目を監査するまで blocking に残す。残った指摘の blocking の項目がすべて尽きた項目で doc_check の blocking が減らず新しい TBD も無ければ `stop_reason: no_progress`、パスが `MAX_AUDIT_PASSES` に達したら `pass_limit` で blocked（doc_check の blocking だけが残るときは上限まで回す） |
| 9 | —（収束せずに輪を出た blocked のときだけ resolver が残った論点を保持規則と Issue の文案にし、flow-check の stdout に残った flow の指摘と覆された決定を引く要素を `reason` に載せる） | done の直前 | 事後報告は司令塔が `doc_check report` で導出する |

問いを聞くゲートは G0・G0-2・G1 の 3 つである。G0-2 を G0 にまとめられないのは、G0 の回答を当て、その回答で flow を組み直して
初めて出る問いだからである。G1 は、初稿と監査の後に初めて出る価値の問いだけを聞く。

範囲を絞った監査の基準は `audited-<n>` の snapshot で、script が保存時の digest を持ち、指名された監査役が
`diff --expect` で照合する。writer の申告と木全体の diff を script が比べるので、生成した側だけに監査の範囲を
決めさせない。

## 5. 本流から外れた状態

| 状態 | 対応 |
|---|---|
| 依頼が 1 行だけ | intake が仕分け、足りない論点は未決として段 3 と G0 で聞く。推測で埋めない |
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
| `plan` | intake | plan.json の `domain` が `references/domain-analysis.md` §2 の観点のキーを 1 回ずつ持ち、判定の根拠の ID が実在し、`irreversible` が `該当` なら `kind: invariant` の決定か未決があるか |
| `flow [--rulings]` / `conflicts` | flow-framer（`flow` は resolver・resolver-verifier・flow-check も。`--rulings` は resolver-verifier の最後の `flow` と flow-check） | 流れの形・閉包・出典の検査（stdout に指摘の件数と符号ごとの場所（`codes`。意味は契約「flow.json の形」の直し手）・`open.json` の件数と ID・flow.json の内容の `content_sha256`・`--rulings` のときは裁定と合否の `resolutions`・ほかの欄の意味は契約 §flow-framer） / 同じ target を持つ決定どうし・決定と要素の組の列挙 |
| `doc [--doc <キー>] --open-tbd <ID,…>` | writer（内部ループ）、指名された監査役 | 構造検査・参照先の実在・曖昧語・開いた TBD に触れる断定。stdout の `flow_refs` に項目ごとの trace が指す flow 要素の ID を出す（script が改稿の writer に項目ごとに渡す） |
| `snapshot --save <label> [--role auditor] [--live <label,…> [--sweep]] [--fixed <キー,…>]` | 監査役（`audited-*`）、writer | 項目ごとの hash を保存する。`--fixed` に挙げた文書の本文と meta の sha256 を stdout の `fixed_sha256` に出す（reset と同じ値）。`audited-` は `--role auditor` のときだけ。W に所有表（契約の「W のファイルと書き手」）と `plan.json` に無いファイルと、`--sweep` で消さなかった `tmp/` のものを `checks/<label>.stray.json` に書き、stdout の `stray` に件数とパスを出す。`--live` に挙げた label の `tmp/` は動作中として除く。`--sweep` は `--live` に無い label の `tmp/<label>/` を空のものも含めて消し、消したファイルとリンクを `checks/<label>.swept.json` に書いて `swept` に件数とパスを出す（`--live` が並行中の label のすべてであるときだけ付ける。script は監査の snapshot にだけ付ける）。台帳と文書のバイト数を `sizes` に、目安（`SIZE_BUDGET`）を超えたものを `checks/<label>.sizes.json` に書いて `size_over` に件数とパスを出す |
| `diff --against <label> --expect <digest>` | 指名された監査役 | snapshot と今の木の項目の差分。digest が違えば exit 3 |
| `tree-digest [--doc <キー>] [--live <label,…>]` | writer、指名された監査役、司令塔（保存の前） | 今の木（または 1 文書）の digest。`stray`・`sizes`・`size_over` は snapshot と同じ（一覧は `checks/tree-digest.*.json`） |
| `index [--req-dir] [--spec-dir] [--open-tbd]` | 司令塔（保存の前） | 2 つの INDEX を導出して `checks/INDEX.<kind>.md` に書く |
| `put --ledger <台帳> [--doc <キー>] [--expect-resolutions <sha> --expect-decisions <sha>] --token <token> [--input <作業用ディレクトリの中のパス>]` | 台帳の書き手（契約の所有表で「put で書く」とした役） | 標準入力（`--input` があればそのファイル。書けたら消し、拒否したら残す）の要素をキー単位で足し、同じキーの要素には送った欄だけを上書きする（意味は契約の「共通の約束」）。型の外の欄・経緯の印・欄の条件に合わない要素・逐語でない引用が 1 件でもあれば何も書かない |
| `del --ledger <台帳> --ids <ID,…> [--collection <配列名>] --token <token>` | 台帳の書き手 | キーで要素を消す。無い ID は成功として数える |
| `backup --doc <キー> … --token <token>` | flow-check（段 4・7 の writer の前） | 文書の本文の控えを token の下に取る（無い文書は無い印。同じ token の控えがあれば取り直さない）。stdout に `backup: true`・`token`・控えを取った文書のキー（`docs`） |
| `restore --token <token>` | flow-check（blocked の後の同じ段の再実行の入口） | token の控えを台帳と文書の本文に戻し、token の下で作られた台帳と文書を消して控えを消す（控えを書く途中で落ちた一時名は数えない。§3）。stdout に戻したファイルごとの前後の sha256（無いファイルは null）と flow.json の前後（`flow_before`・`flow_after`）、控えを消した後の段の token（`pruned_by`。あれば何も戻さない） |
| `reset [--keep <キー,…>] [--fixed <キー,…>]` | flow-check（段 1 から始める run の入口） | W を S0 の直後に戻す（消すものと残すものは §3 の段 1 の項）。キーが文書のキーの形でないか、`--fixed` が `--keep` に無いか、`--keep` の文書が W に無ければ何も消さずに止まる。stdout に消した名前（`removed`）と残した文書のキー（`kept`）と書き直した固定の文書のキー（`fixed`）とその本文と meta の sha256（`fixed_sha256`） |
| `get --ledger <台帳> [--doc <キー>] --ids <ID,…> [--fields <欄,…>]` | 台帳を読む役（読み方は契約の「共通の約束」） | 台帳から ID の要素を加工せずに選んで stdout に出す。無い ID は `missing`、stdout の上限（`STDOUT_BUDGET`）に入らない ID は `over_budget`（ID の一覧だけで上限を超えれば exit 1）。何も書かない |
| `view --ledger <台帳> [--doc <キー>] [--fields <欄,…>]` | 台帳を全件読む役（読み方は契約の「共通の約束」） | 台帳の全件を、要素ごとの JSON（`{"<配列名>": 要素}`、スカラーは `{"<名前>": 値}`）の欄と配列の要素を 1 行ずつにして `checks/view-<台帳のファイル名>[.<--fields の fnv>].txt` に書き、stdout にパス・要素数・行数・sha256 を出す（Read は 2000 字を超える行を切る）。名前は台帳と `--fields` だけで決まる |
| `describe` | どの役も（台帳の名前と欄を確かめるとき） | `LEDGERS` から導出した台帳の名前・ファイル・配列・欄・閉集合と、モードの一覧、指摘の符号を出す。W を読まず何も書かない |
| `sha --ledger <台帳> [--doc <キー>]` | resolver-verifier（検証を始めるとき）、writer | 台帳の sha256。まだ無い台帳は空の台帳の値 |
| `questions --ids <RS-…> [--check]` | 司令塔（`needs_answers` で問いを出す前）。`--check` は問いを出した resolver（返る前） | resolutions.json の問いから `questions.md`・`questions.json` を導出する。候補の `flow_refs` が flow.json に無い要素を指すか、`answer` が残っていれば（回答済みの問い）不合格。`--check` は同じ形の検査だけを行って何も書かず、stdout に検査した `ids` と不合格の件数（`findings`）と `bad_ids` と理由（`bad`。stderr にも）を出す |
| `answers --file answers/<ゲート>.md --ids <RS-…>` | flow-check（`gates_answered` のゲートを越える前と、`next_args` で 3a・3a' から始めた run が回答を当てる前） | 回答のファイルがあるか（`exists`）と、`<ID>:` で始まる行の無い問い（`missing`）を stdout に出す。何も書かない |
| `report [--drafts <RS-…>]` | 司令塔（`report_path` が返ったとき） | resolutions.json の `method`・`answered_by`・`hold`・`upstream_revision` から `report.md` を導出する。`--drafts` に挙げた hold は「本文に未反映」の節に分ける（hold でない ID があれば何も書かない）。run の後なので動いている label は無く、`tmp/<label>/` をすべて消して `checks/report.swept.json` と stdout の `swept` に出す |

`node doc_check.mjs <input.json>` の形（文書のパスと申告を JSON で渡すもの）も残っている。検査の本体は同じで、
fixture テストがこの形で移設前の結果との一致を確かめている。
