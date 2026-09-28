# prd.js の入出力と再実行（workflow-io）

**目次**: [1. args](#1-args) · [2. model と effort の既定](#2-model-と-effort-の既定) · [3. 返り値と再実行](#3-返り値と再実行) · [4. 段と起動の条件](#4-段と起動の条件) · [5. 本流から外れた状態](#5-本流から外れた状態) · [6. doc_check の CLI](#6-doc_check-の-cli)

`scripts/prd.js` は段の順序・起動の条件・上限・返り値の検査だけを持つ Workflow script である。ファイルを読めない
ので、分岐に使う値（件数・ID・digest）はすべて agent の返り値から受け取り、`next_args.state` に載せて
返す。本体（flow・台帳・文書）は W にだけ置き、state には flow.json の内容の sha256（`flow_digest`）のような digest を載せる。各 agent が読み書きするファイルの形は `schemas/agent-contracts.md` を正とする。

## 1. args

| args | 意味 |
|---|---|
| `workspace` | W の絶対パス（S0 で作ったもの）。`~` は展開しておく |
| `skillDir` | このスキルの絶対パス。agent が役割ファイルと契約を Read するパスはここでしか決まらない |
| `entry` | `new` / `existing` / `expand`。`review` / `update` は使わない（Codex の runner が拒否する値と衝突する） |
| `existing_docs` | `existing`・`expand` のとき必須。`[{ key: "<kind>/<topic>", source: "<元のパス>", fixed }]`。本文は W に置いてある |
| `from` | 始める段（省略時 `1`）。`1` / `2` / `3` / `3a` / `3b` / `4` / `5` / `6` / `3a'` / `7` / `8` / `9` |
| `state` | `from` が `1` 以外のとき要る。前の run の `next_args` ごと渡す（§3） |
| `role_opts` | 任意。役割ごとの `{ model, effort }` の上書き（§2） |

**司令塔が args に打ち直すのは ID・件数・digest に限る。** 本文や本体の JSON は W に置き、args にはそのパスか
digest を載せる。司令塔は args と `next_args` を打ち直して渡すので、本体を載せると、打ち直す量と写し間違いの機会が
その大きさに比例して増え、写し間違いがそのまま次の段の入力になる（実測: 2026-09-27 の試走で、next_args の 61〜85% が
prd.js のどこからも読まれない `state.flow` だった）。依頼文を args に入れず `W/input.md` に置くのも、この規則の 1 つの例である。
script が本体の中身を確かめる必要があるときは、本体を運ばずに、生成者と別の agent がそれぞれ実行した doc_check の
stdout の digest を突き合わせる（flow は `doc_check flow` の `content_sha256`）。

## 2. model と effort の既定

省略するとセッションの設定（xhigh など）を継承し、全呼び出しが最重量で走って利用上限に達した実測がある。
だから全役に既定を置く。`args.role_opts` で上書きでき、未知の役割名・model・effort は run を止める（黙って
既定に落ちると、指定したつもりの配分が効かない）。値は既定であって、E2 の実測で較正する。

| 役割（`role_opts` のキー） | model / effort | 理由 |
|---|---|---|
| `intake`・`flowFramer`・`resolver`・`verifier`・`writer` | opus / medium | 判断と生成を要する。知識作業では medium で high と同等の結果が出る |
| `implementer`・`grounding` | opus / high | 見落としがそのまま欠陥（着手不能・捏造）になる |
| `crossDoc` | sonnet / medium | 項目の間の関係を見る。1 文ずつの深い判断は要らない |
| `flowCheck` | haiku / low | コマンドを 1 回実行して stdout を返すだけで、判断を要しない |

## 3. 返り値と再実行

```json
{
  "status": "done | needs_answers | blocked",
  "questions_path": "needs_answers のとき W/questions.md（司令塔が doc_check questions で導出してから見せる）",
  "questions_json_path": "needs_answers のとき W/questions.json（選択式で出すための同じ問い）",
  "answers_path": "needs_answers のとき W/answers/g0.md・g0-2.md・g1.md のどれか",
  "question_ids": ["RS-004"],
  "report_path": "done（と、stop_reason のある blocked）のとき W/report.md（司令塔が doc_check report で導出してから見せる）",
  "remaining_blocking": ["stop_reason のある blocked のとき、本文に反映されていない blocking の指摘の ID（hold の文案にしたものを含む）"],
  "carried_blocking": ["stop_reason のある blocked のとき、remaining_blocking のうち最後のパスの監査が出したのではなく前のパスから持ち越した ID"],
  "doc_blocking": "stop_reason のある blocked のとき、残った doc_check の blocking の件数",
  "next_args": "needs_answers と、やり直せる blocked のとき。次の run の args（渡し方は下の 1 つ目の項）",
  "tree_digest": "最後の監査が見た木の digest（done のとき）",
  "open_tbd": ["開いている TBD の ID"],
  "holds": ["本文に反映した保持規則の resolution の ID（writer に渡したもの）"],
  "hold_drafts": ["文案だけで本文に無い保持規則の resolution の ID（輪を出た後に resolver が作ったものなど。remaining_blocking の指摘と対になる）"],
  "missed": ["渡したのに裁定されなかった論点（finding:… / tbd:…）"],
  "integrity": ["sha256 の照合で食い違った事実"],
  "notices": ["照合ではない所見（監査の時点で W に所有表に無いファイルがあった、など）"],
  "undeclared": { "requirements/auth": ["writer が申告せずに変えた項目キー（追加の監査を当てたもの）"] },
  "stop_reason": "改稿と監査の輪を収束せずに出た blocked のとき pass_limit（MAX_AUDIT_PASSES に達した）か no_progress（進展なし）。それ以外は null",
  "passes": "改稿と監査のパスの数",
  "item_routes": { "requirements/auth#PR-AUTH-003": "再発で経路を変えた項目の今の経路（decision | hold | exhausted）" },
  "reason": "blocked のときの理由"
}
```

- **`next_args` は完成形で、司令塔は変えずに渡す。** SKILL.md とこの文書で「`next_args` を渡す」と書いたところは、すべてこの規則による。
  回答は `answers_path` に逐語で書き、`next_args` には入れない。変えてよいのは run のデータではない環境の欄の
  `skillDir`（plugin の更新で版のパスが変わる）と `role_opts`（レート制限などで役の配分を変える）だけである（`prd.js` の `ENV_ARGS`）。
  Codex の runner には、`role_opts` で上書きした後に全役（§2 の表の既定を含む）が使う model のすべてに対応する `modelMap` を渡す。
  `state_hash` はそれ以外の欄すべての hash で、合わなければ（打ち直しでどれかの値が変わった）run は agent を起動する前に止まる。
  最上位の欄の空の配列・オブジェクトは、欄が無いのと同じに扱う。`state` は plain JSON で、Map・Set を含まない（runtime の境界を越えると中身が失われる）。
- **再実行は resume ではなく `from` で行う。** 状態は W のファイルと `state` にあり、prd.js は段の境界ならどこからでも
  始められる。どの段から始めるかは `next_args.from` が決める。`from` ごとに要る `state` の値が無ければ run は最初に止まる（`prd.js` の `REQUIRES`）。
  resume に頼ると、止まった agent 以降が全部やり直しになり、Codex には resume が無い。
- **`blocked` の `next_args`**: agent が応答しなかった（出し直しても返らなかった）とき、返した doc_check の stdout が
  差し戻しの後も不合格だったときは、その段からの `next_args` が付く。セッション上限なら解除してから渡す。
  `next_args.state` はその段に入った時点の state で、段の途中で足した値（候補の選択で当たった回答・形の検査に落ちた問い・
  integrity の行）を持ち越さない。持ち越すと、再実行が止まらなかった run と違う状態から始まる。
  監査の基準の digest が合わない・改稿と監査の輪を収束せずに出た（`stop_reason`）・その段に flow を書く生成者がいないのに flow.json が
  生成者の検査した版から変わっていた、差し戻しの後も flow の要素が検証に落ち、写す検証の裁定も無かった（要素は問いや保持規則に変えられない）、段の出口の不変条件に反した（§5）、のように、同じ段をやり直しても変わらないときは付かない。
- `integrity` の行は、writer が読んだ resolutions.json と台帳の最新が違った、verifier が検証した版と resolver が
  書き終えた版が違った、verifier が `doc_check flow` で検査した flow.json の `content_sha256` が生成者の検査した版と違った、verifier が返した F- の合否が `doc_check flow` の stdout（verifications.json）に無かった、flow-check が検査した flow.json の `content_sha256` が検証を通った版と違った、flow-check の前に応答した resolver が返した `doc_check flow` の stdout が flow-check の stdout と違った（契約 §flow-check）、のような食い違いである。事後報告に添える。flow の版と F- の合否の食い違いだけは run を blocked にし（違う flow や記録されていない合否を見た検証を台帳に入れないため）、それ以外は run を止めない（script は flow-check の stdout しか判断に使わないので、止めても守る判断が無い）。
- `holds` と `hold_drafts` は、writer に渡したか（`state.settled_written`）で分ける。渡しただけで本文に入ったとは限らず、
  当て損ねは直後の監査が拾う。
- `notices` の行は、照合の食い違いではない所見である（段 5・8 の監査の基準の snapshot が、W に所有表に無いファイルや
  分量の目安を超えたファイルを数えた、など。行には件数と一覧のファイルのパスだけを載せる）。run は止めず、事後報告に添える。`integrity` に混ぜないのは、その件数を改善候補の
  選別（`scripts/goal_selector.py` の R4）が照合の食い違いとして数えるからである。
- `undeclared` は、writer が申告せずに変えた項目を文書ごとに並べたもの。監査は追加で当てているが、申告の漏れ
  そのものは writer の契約違反なので、事後報告と合わせて見る。

## 4. 段と起動の条件

| 段 | 起動する agent | 起動の条件・上限 | 次 |
|---|---|---|---|
| 1 | intake | 常に | 返した `plan_check`（doc_check `plan`）に指摘があれば、0 件になるまで差し戻す（前の回より減らなければ止める。上限は prd.js の `MAX_CHECK_REWORK`。以下の差し戻しも同じ）。直らない、writer の単位が循環・未知の依存を持つ、固定の文書が単位に入る、既存文書がどの単位にも無い → blocked |
| 2 | flow-framer | 常に。返った `doc_check flow` の stdout の指摘が 0 件でなければ差し戻す | 閉じなければ blocked（初稿を始めない）。0 件なら `content_sha256` を `state.flow_digest` にする。flow-framer が実行した `plan` の `content_sha256` が段 1 の `plan_check` と違うか指摘があれば blocked（段 1 から） |
| 3 | resolver | open と組がどちらも 0 件なら起動しない。問いを出したのに `questions --check` の stdout が無いか不合格なら差し戻す（3a・3b・3a'・6 も同じ） | 直らなければ blocked |
| 3v | resolver-verifier | 常に（intake の既定と flow の出典を検証するため）。verifier も最後に `doc_check flow` を実行する | その `content_sha256` が `state.flow_digest` と違えば `integrity` に 1 行足して blocked、その cycle で flow を書いた生成者が消せる指摘が 1 件以上でも blocked（3av・6v も同じ。消せない指摘と、誰も flow を書いていない cycle の指摘は settle の flow-framer に渡る。契約 §resolver-verifier）。不合格は resolver に 1 回だけ差し戻し、再検証。それでも不合格なら `value_as_method` と cycle の入口で問いだった ID は問い、それ以外は保持規則に変えて、もう検証しない（flow の要素は書き換えるまで。聞けない段では hold だけ。question にも hold にも返らなかった ID があれば blocked。契約 §resolver） |
| G0 | — | 問いが 1 件以上 | `needs_answers`（`from: 3a`） |
| 3a | resolver → verifier（候補の選択だけの回答でも起動する。回答を当てた resolver が返す `doc_check flow` の stdout を照合するため） | G0・G0-2 の後。resolver の stdout に resolver が消せる指摘（契約「flow.json の形」の直し手）があれば差し戻す。消せない指摘は差し戻さず、同じ cycle の settle の flow-framer に渡す | G0 の後は 3b（flow-framer `3b-reframe` が回答で flow を組み直し、resolver がまだ裁定の無い open・組と持ち越した問いを裁定する）。そこで問いが残れば G0-2（`answers/g0-2.md`、`from: 3a`）の 1 回だけ聞く。G0-2 の後に出た問いは保持規則 |
| 3・3a・3b・3a'・6 の共通 | resolver（`<段>-pairs`・`<段>-opens`）、flow-framer（`<段>-settle`）→ verifier（`<段>v-settle`） | flow を変えた呼び出しの後、`conflicts` の `pair_keys` にまだ裁定の無い組があれば、settle の flow-framer の後は `open_ids` にまだ裁定の無い O- もあれば、1 回の resolver に渡す（O- があれば `<段>-opens`、組だけなら `<段>-pairs`。`<段>` は呼び出した resolver の段で、settle の後は `<段>-settle`、差し戻しの後は `<段>'` になる。聞けない段では hold で、問いを返せば blocked。3b の組み直しの後の resolver にも同じ集合を渡す。渡した組と O- は次の verifier の stdout と照合する。契約 §resolver-verifier）。検証を通っていない要素（契約 §flow-framer の `unverified` と `failed_current`）の出典を verifier に回す。最後の verifier の後に resolver を起動していれば flow-check（契約 §flow-check）を起動する。判断に使う stdout（同じ節）の `open_only` のうち、合格か回答で閉じた O- の組か、この cycle で裁定が決まった `origin: flow` の指摘か flow の要素への `verification` の裁定か、`stale_refs`（覆された決定か検証に落ちた不変条件を引く要素）か、flow の指摘（`codes`。符号によらず）があれば settle を起動する（保持規則への変換（`<段>-hold`）の後も同じ）。settle の verifier に落ちた裁定（RS-）は、差し戻しの後と同じく問いか保持規則に変え（`<段>-settle-convert`。検証はもう回さない）、settle は残り（閉じた未決を引く要素・覆された決定を引く要素・検証を通っていない要素・不合格・flow の指摘）が 0 になるまで回し、減らなければ止める（上限は `MAX_SETTLE_ROUNDS`） | 直らなければ blocked（その段に入った時点の state で段の頭から） |
| 4 | writer | 単位の依存の向きに波を作り、同じ波は並列 | 応答しない単位があれば blocked（一度も書かれていない文書を監査しない） |
| 5 | implementer・grounding（文書ごと）、cross-doc（全文書で 1 体。指名） | 常に。`entry: existing` は 3 の後ここへ | cross-doc が `audited-1` を返さなければ blocked |
| 6 | resolver → verifier | decision の指摘も新しい TBD も 0 件なら起動しない。writer の指摘はここを通らず段 7 へ。再発した項目は、前のパスの指摘とその裁定の ID を渡して項目の次元を裁定させ、decision の後にも再発した項目は hold を指示する | 1 パス目の問いは G1、2 パス目以降の問いは保持規則 |
| G1 | — | 1 パス目の段 6 で問いが出た | `needs_answers`（`from: 3a'`） |
| 7 | writer（変更がある単位だけ） | writer の指摘・routes・doc_check の指摘・前回の書き込みの後に決まった裁定のどれかがある単位 | 何も無ければ 9 へ（blocking が残っていれば `stop_reason: no_progress` で blocked） |
| 8 | grounding（変えた文書）、implementer・cross-doc（その観点が指摘した項目が変わったとき）。1 体を指名 | 改稿の後は必ず | 申告に無い変更があれば、それが起きた文書ごとに（diff の `by_doc` で分け、その文書の申告を引いて）implementer と grounding を追加で起動。blocking（指摘・doc_check・新しい TBD）が 0 なら 9 へ。残れば経路を決めて 6 へ戻る: 前のパスと今のパスの両方で blocking の項目（再発）は writer に回さず、1 回目は decision、decision の後は hold、hold の後は尽きた項目（以後どの経路にも回さない）にする。前のパスで段 6 が裁定して合格した指摘と同じ項目・同じ `direction` の指摘で、その後の改稿がその項目に裁定を当てただけのもの（項目が変わっていないか、そのパスの段 7 がその項目に writer の指摘を渡さずにその裁定を渡した）は、既裁定の再出として再発にも blocking にも数えず `notices` に出す。尽きた項目の指摘は、その項目に指摘を出したことのある役がすべてそのパスでその項目を監査するまで blocking に残す。残った指摘の blocking の項目がすべて尽きた項目で doc_check の blocking が減らず新しい TBD も無ければ `stop_reason: no_progress`、パスが `MAX_AUDIT_PASSES` に達したら `pass_limit` で blocked（doc_check の blocking だけが残るときは上限まで回す） |
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
| 依頼者が分割に異を唱えた | 回答として `answers` に書き、`entry: new` で S0 からやり直す（分割は intake の決定なので、回答を入力にして決め直す） |
| agent が一部だけ応答しない | script が落ちた分だけを 1 回出し直す。それでも返らなければ blocked（`next_args` 付き） |
| Workflow が例外で終わった（args の検査か script の欠陥）か、`reason` が「script の不変条件に反しました」の blocked（段の出口の検査） | 再実行しない（同じ args では同じ所で止まる）。例外の文か `reason` をそのまま伝える。args の検査なら、渡した args が返った `next_args`（§3 の環境の欄のほかは変えない）かを確かめる。それ以外は script の欠陥なので、prd.js を直すまで run を続けない |
| 出した agent が全件応答しない | 出し直さない（セッション上限・レート制限を疑う）。解除してから `next_args` を渡す |
| 監査の指摘は 0 件だが開いている TBD がある | 「完成しました」と言わない。「あと N 個決まれば着手できます」と伝える |
| 保存の直前に tree digest が合わない | 保存しない。最後の監査の後に文書が変わっている |
| INDEX だけが既存で本体が無い（またはその逆） | 齟齬として報告し、INDEX を本体から導出し直す |

## 6. doc_check の CLI

本文を読む決定的な検査は `scripts/doc_check.mjs` が正本で、agent が実行して stdout（1 行の JSON）を返す。
結果は `W/checks/` に書かれ、stdout には件数・digest・パスだけが出る。

| モード | 実行する役 | 何をするか |
|---|---|---|
| `plan` | intake | plan.json の `domain` が `references/domain-analysis.md` §2 の観点のキーを 1 回ずつ持ち、判定の根拠の ID が実在し、`irreversible` が `該当` なら `kind: invariant` の決定か未決があるか |
| `flow` / `conflicts` | flow-framer（`flow` は resolver・resolver-verifier・flow-check も） | 流れの形・閉包・出典の検査（stdout に指摘の件数と符号ごとの場所（`codes`。意味は契約「flow.json の形」の直し手）・`open.json` の件数と ID・flow.json の内容の `content_sha256`・ほかの欄の意味は契約 §flow-framer） / 同じ target を持つ決定どうし・決定と要素の組の列挙 |
| `doc [--doc <キー>] --open-tbd <ID,…>` | writer（内部ループ）、指名された監査役 | 構造検査・参照先の実在・曖昧語・開いた TBD に触れる断定。stdout の `flow_refs` に項目ごとの trace が指す flow 要素の ID を出す（script が改稿の writer に項目ごとに渡す） |
| `snapshot --save <label> [--role auditor] [--live <label,…>]` | 監査役（`audited-*`）、writer | 項目ごとの hash を保存する。`audited-` は `--role auditor` のときだけ。W に所有表（契約の「W のファイルと書き手」）と `plan.json` に無いファイルと `tmp/` に残ったものを `checks/<label>.stray.json` に書き、stdout の `stray` に件数とパスを出す。`--live` に挙げた label の `tmp/` は動作中として除く。台帳と文書のバイト数を `sizes` に、目安（`SIZE_BUDGET`）を超えたものを `checks/<label>.sizes.json` に書いて `size_over` に件数とパスを出す |
| `diff --against <label> --expect <digest>` | 指名された監査役 | snapshot と今の木の項目の差分。digest が違えば exit 3 |
| `tree-digest [--doc <キー>] [--live <label,…>]` | writer、指名された監査役、司令塔（保存の前） | 今の木（または 1 文書）の digest。`stray`・`sizes`・`size_over` は snapshot と同じ（一覧は `checks/tree-digest.*.json`） |
| `index [--req-dir] [--spec-dir] [--open-tbd]` | 司令塔（保存の前） | 2 つの INDEX を導出して `checks/INDEX.<kind>.md` に書く |
| `put --ledger <台帳> [--doc <キー>] [--expect-resolutions <sha> --expect-decisions <sha>]` | 台帳の書き手（契約の所有表で「put で書く」とした役）、司令塔（S0 の固定の文書の meta） | 標準入力の要素をキー単位で足し、同じキーの要素には送った欄だけを上書きする（意味は契約の「共通の約束」）。型の外の欄・経緯の印・欄の条件に合わない要素・逐語でない引用が 1 件でもあれば何も書かない |
| `del --ledger <台帳> --ids <ID,…> [--collection <配列名>]` | 台帳の書き手 | キーで要素を消す。無い ID は成功として数える |
| `sha --ledger <台帳> [--doc <キー>]` | resolver-verifier（検証を始めるとき）、writer | 台帳の sha256。まだ無い台帳は空の台帳の値 |
| `questions --ids <RS-…> [--check]` | 司令塔（`needs_answers` で問いを出す前）。`--check` は問いを出した resolver（返る前） | resolutions.json の問いから `questions.md`・`questions.json` を導出する。候補の `flow_refs` が flow.json に無い要素を指せば不合格。`--check` は同じ形の検査だけを行って何も書かず、stdout に検査した `ids` と不合格の件数（`findings`）と `bad_ids` を出す（理由は stderr） |
| `report [--drafts <RS-…>]` | 司令塔（`report_path` が返ったとき） | resolutions.json の `method`・`hold`・`upstream_revision` から `report.md` を導出する。`--drafts` に挙げた hold は「本文に未反映」の節に分ける（hold でない ID があれば何も書かない） |

`node doc_check.mjs <input.json>` の形（文書のパスと申告を JSON で渡すもの）も残っている。検査の本体は同じで、
fixture テストがこの形で移設前の結果との一致を確かめている。
