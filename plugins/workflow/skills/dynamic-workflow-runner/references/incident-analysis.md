# Incident Analysis: Why the Workflow Expanded Without Closing

## 観測されたこと

前回の長時間 workflow は、分析能力が不足して停止したのではない。実行面が明文化されていない状態で、
orchestrator が会話、共有 filesystem、追加 subagent、後付け validator を使って scheduler と control plane を
その場で組み立てた。その結果、成果物を作る処理よりも、成果物を承認するための control artifact、hash、review、
repair が増え続けた。

具体的には次が同時に起きた。

1. task graph が開始前に凍結されず、review finding ごとに task、receipt、schema、validator が増えた。
2. canonical path を producer、reviewer、repairer が上書きし、ひとつの修復が downstream hash cascade を起こした。
3. subagent の完了通知と filesystem 上の exact artifact identity が分離し、どれが正本かを都度再判定した。
4. fresh context は意味上の宣言に留まり、共有 status や共有 filesystem から hidden input に触れる場面があった。
5. validator の期待 shape と approved plan の shape が途中で矛盾し、正常系が構造上完了不能になった。
6. `continue` が scheduler の代わりになり、ready / running / blocked / lost handle を state から一意に復元できなかった。
7. `pass`、`revise`、`blocked`、publication eligibility、strategy completeness が一つの成功概念へ混ざった。
8. 本来の投資成果物より control artifact の閉鎖が支配的になり、workflow の目的関数が逆転した。

## 根本原因

根本原因は「multi-agent が不安定」だったことではない。**意味を決める LLM orchestration と、実行を閉じる
deterministic control plane が分離されていなかったこと**である。`multi_agent_v2` や
`collaboration_modes` のような feature 名は、この欠落を自動では埋めない。必要なのは callable capability、
凍結 graph、stable handle、result identity、有限上限、独立 review、明示 gate の一貫した契約である。

## 新設計への対応

| 事故要因 | 新しい制御 |
| --- | --- |
| graph の後付け拡張 | source を実行せず、verified portable manifest を開始前に freeze |
| canonical path の競合 | run/task ごとの owned output と case-folded collision 検査 |
| agent 通知と成果物の乖離 | prepare → runtime handle bind → exact result path/hash finish |
| 重複 spawn / 再開時二重実行 | invocation reservation と idempotent finish |
| lost handle の勝手な再実行 | `workflow_incomplete` で停止し、暗黙 respawn を禁止 |
| config flag の過信 | `spawn` / `collect_or_wait` / stable handle の callable inventory を正本化 |
| validator/plan の不整合 | manifest schema、controller test、独立 contract review を promotion 前に実行 |
| review 失敗による全面再設計 | failure は局所 repair だけを解禁し、graph 自動拡張を禁止 |
| 外部更新の先行 | v1 graph から外部更新を除外し、action package と gate の後に専用 skill へ handoff |
| 成功概念の混同 | execution complete と independently verified workflow complete を分離 |

## 意図的に保証しないもの

- `fork_turns=none` は conversation context を減らすが、OS / filesystem sandbox ではない。
- local hash は偶発 drift と局所 cross-wire を検出するが、全ファイルを同じ権限で協調改変する actor は防げない。
- translator の意味判断を code で taxonomy 化しない。意味対応は fresh verifier が判断する。
- 外部 system への exactly-once write は、この skill の local state だけでは保証しない。外部 mutation は workflow
  の外へ出すか、対象 system の idempotency key と read-back receipt を別 contract で要求する。

## 健全性の判定

この skill が健全に動いたと言えるのは、agent 数や review 数が多いときではない。次が成立するときだけである。

- source の名前と拡張子を変えても同じ意味の graph が生成される。
- 実行できない能力は開始前に `unsupported_runtime` になる。
- graph と上限が固定され、実行途中の finding が無制限の新 task を生まない。
- crash / resume 後も completed task が二重実行されない。
- missing / running / lost / unknown が success へ昇格しない。
- 最終成果物と control evidence を区別し、独立 verifier の `pass` だけが complete を作る。
