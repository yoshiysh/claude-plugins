# prd.js の入出力と再実行（workflow-io）

**目次**: [1. args](#1-args) · [2. model と effort の既定](#2-model-と-effort-の既定) · [3. 返り値と再実行](#3-返り値と再実行) · [4. 段と起動の条件](#4-段と起動の条件) · [5. 本流から外れた状態](#5-本流から外れた状態) · [6. doc_check の CLI](#6-doc_check-の-cli)

`scripts/prd.js` は段の順序・起動の条件・上限・返り値の検査だけを持つ Workflow script である。ファイルを読めない
ので、分岐に使う値（件数・ID・digest・flow 本体）はすべて agent の返り値から受け取り、`next_args.state` に載せて
返す。各 agent が読み書きするファイルの形は `schemas/agent-contracts.md` を正とする。

## 1. args

| args | 意味 |
|---|---|
| `workspace` | W の絶対パス（S0 で作ったもの）。`~` は展開しておく |
| `skillDir` | このスキルの絶対パス。agent が役割ファイルと契約を Read するパスはここでしか決まらない |
| `entry` | `new` / `existing` / `expand`。`review` / `update` は使わない（Codex の runner が拒否する値と衝突する） |
| `existing_docs` | `existing`・`expand` のとき必須。`[{ key: "<kind>/<topic>", source: "<元のパス>", fixed }]`。本文は W に置いてある |
| `from` | 始める段（省略時 `1`）。`1` / `2` / `3` / `3a` / `4` / `5` / `6` / `3a'` / `7` / `8` / `9` |
| `state` | `from` が `1` 以外のとき、前の run の `next_args.state` をそのまま渡す |
| `role_opts` | 任意。役割ごとの `{ model, effort }` の上書き（§2） |

依頼文は args に入れない（`W/input.md` にある）。args に全文を入れると、司令塔が手で組む args が数十万字に
なり、写し間違いがそのまま入力になる。

## 2. model と effort の既定

省略するとセッションの設定（xhigh など）を継承し、全呼び出しが最重量で走って利用上限に達した実測がある。
だから全役に既定を置く。`args.role_opts` で上書きでき、未知の役割名・model・effort は run を止める（黙って
既定に落ちると、指定したつもりの配分が効かない）。値は既定であって、E2 の実測で較正する。

| 役割（`role_opts` のキー） | model / effort | 理由 |
|---|---|---|
| `intake`・`flowFramer`・`resolver`・`verifier`・`writer` | opus / medium | 判断と生成を要する。知識作業では medium で high と同等の結果が出る |
| `implementer`・`grounding` | opus / high | 見落としがそのまま欠陥（着手不能・捏造）になる |
| `crossDoc` | sonnet / medium | 項目の間の関係を見る。1 文ずつの深い判断は要らない |

## 3. 返り値と再実行

```json
{
  "status": "done | needs_answers | blocked",
  "questions_path": "needs_answers のとき W/questions.md",
  "answers_path": "needs_answers のとき W/answers/g0.md・g0-2.md・g1.md のどれか",
  "question_ids": ["RS-004"],
  "report_path": "done（と、上限に達した blocked）のとき W/report.md",
  "next_args": "needs_answers と、やり直せる blocked のとき。そのまま渡す args",
  "tree_digest": "最後の監査が見た木の digest（done のとき）",
  "open_tbd": ["開いている TBD の ID"],
  "holds": ["保持規則になった resolution の ID"],
  "missed": ["渡したのに裁定されなかった論点（finding:… / tbd:…）"],
  "integrity": ["sha256 の照合で食い違った事実"],
  "reason": "blocked のときの理由"
}
```

- **`next_args` は完成形である。** 司令塔は回答を `answers_path` に逐語で書き、`next_args` を変えずに渡すだけでよい。
  `state` は plain JSON で、Map・Set を含まない（runtime の境界を越えると中身が失われる）。
- **再実行は resume ではなく `from` で行う。** 状態は W のファイルと `state` にあり、段の境界ならどこからでも
  始められる。`from` ごとに要る `state` の値が無ければ run は最初に止まる（`prd.js` の `REQUIRES`）。
  resume に頼ると、止まった agent 以降が全部やり直しになり、Codex には resume が無い。
- **`blocked` の `next_args`**: agent が応答しなかった（出し直しても返らなかった）ときは、その段からの
  `next_args` が付く。セッション上限なら解除してから渡す。監査の基準の digest が合わない・上限の 2 パスを
  使い切った、のように、同じ段をやり直しても変わらないときは付かない。
- `integrity` の行は、writer が読んだ resolutions.json と台帳の最新が違った、verifier が検証した版と resolver が
  書き終えた版が違った、のような食い違いである。run は止めないが、事後報告に添える。

## 4. 段と起動の条件

| 段 | 起動する agent | 起動の条件・上限 | 次 |
|---|---|---|---|
| 1 | intake | 常に | writer の単位が循環・未知の依存を持つ、固定の文書が単位に入る、既存文書がどの単位にも無い → blocked |
| 2 | flow-framer | 常に。返り値の flow に script が閉包検査を当て、欠陥があれば 1 回だけ差し戻す | 閉じなければ blocked（初稿を始めない） |
| 3 | resolver | open と組がどちらも 0 件なら起動しない | — |
| 3v | resolver-verifier | 常に（intake の既定と flow の出典を検証するため） | 不合格は resolver に 1 回だけ差し戻し、再検証。それでも不合格なら `value_as_method` は問い、それ以外は保持規則に変えて、もう検証しない |
| G0 | — | 問いが 1 件以上 | `needs_answers`（`from: 3a`） |
| 3a | resolver（自由記述があれば verifier） | G0 の後 | 続きの問いは 1 回だけ（`answers/g0-2.md`）。それを超える問いは保持規則 |
| 4 | writer | 単位の依存の向きに波を作り、同じ波は並列 | 応答しない単位があれば blocked（一度も書かれていない文書を監査しない） |
| 5 | implementer・grounding（文書ごと）、cross-doc（全文書で 1 体。指名） | 常に。`entry: existing` は 3 の後ここへ | cross-doc が `audited-1` を返さなければ blocked |
| 6 | resolver → verifier | decision の指摘も新しい TBD も 0 件なら起動しない。writer の指摘はここを通らず段 7 へ | 1 パス目の問いは G1、2 パス目の問いは保持規則 |
| G1 | — | 1 パス目の段 6 で問いが出た | `needs_answers`（`from: 3a'`） |
| 7 | writer（変更がある単位だけ） | writer の指摘・routes・doc_check の指摘・前回の書き込みの後に決まった裁定のどれかがある単位 | 何も無ければ 9 へ |
| 8 | grounding（変えた文書）、implementer・cross-doc（その観点が指摘した項目が変わったとき）。1 体を指名 | 改稿の後は必ず | 申告に無い変更があれば implementer と grounding を追加で起動。blocking が残れば 6 へ（2 パスまで）、それでも残れば blocked |
| 9 | resolver（report.md） | done の直前。上限で blocked のときは、残った論点の保持規則と Issue の文案を書いてから | — |

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
| 出した agent が全件応答しない | 出し直さない（セッション上限・レート制限を疑う）。解除してから `next_args` を渡す |
| 監査の指摘は 0 件だが開いている TBD がある | 「完成しました」と言わない。「あと N 個決まれば着手できます」と伝える |
| 保存の直前に tree digest が合わない | 保存しない。最後の監査の後に文書が変わっている |
| INDEX だけが既存で本体が無い（またはその逆） | 齟齬として報告し、INDEX を本体から導出し直す |

## 6. doc_check の CLI

本文を読む決定的な検査は `scripts/doc_check.mjs` が正本で、agent が実行して stdout（1 行の JSON）を返す。
結果は `W/checks/` に書かれ、stdout には件数・digest・パスだけが出る。

| モード | 実行する役 | 何をするか |
|---|---|---|
| `flow` / `conflicts` | flow-framer | 流れの形・閉包・出典の検査 / 同じ target を持つ決定どうし・決定と要素の組の列挙 |
| `doc [--doc <キー>] --open-tbd <ID,…>` | writer（内部ループ）、指名された監査役 | 構造検査・参照先の実在・曖昧語・開いた TBD に触れる断定 |
| `snapshot --save <label> [--role auditor]` | 監査役（`audited-*`）、writer | 項目ごとの hash を保存する。`audited-` は `--role auditor` のときだけ |
| `diff --against <label> --expect <digest>` | 指名された監査役 | snapshot と今の木の項目の差分。digest が違えば exit 3 |
| `tree-digest [--doc <キー>]` | writer、指名された監査役、司令塔（保存の前） | 今の木（または 1 文書）の digest |
| `index [--req-dir] [--spec-dir] [--open-tbd]` | 司令塔（保存の前） | 2 つの INDEX を導出して `checks/INDEX.<kind>.md` に書く |

`node doc_check.mjs <input.json>` の形（文書のパスと申告を JSON で渡すもの）も残っている。検査の本体は同じで、
fixture テストがこの形で移設前の結果との一致を確かめている。
