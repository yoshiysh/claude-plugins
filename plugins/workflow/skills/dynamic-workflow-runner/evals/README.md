# Portable Eval Fixtures

この directory は、repository 固有の workflow 名や collaboration tool 名に依存せず、
`dynamic-workflow-runner` の公開契約を再現する。workflow source の拡張子や basename は
routing 条件ではなく、fixture を識別するためだけに使う。

## Case の結合契約

`evals.json` の35件すべてに安定した `case_id` がある。`fixtures/expected-mappings.json` と
`actual-results.json` は同じ `case_id` を一度ずつ持ち、さらに `eval_id` と `eval_name` も一致
しなければならない。配列の位置やファイル名から case を推測してはならない。

- `evals.json`: prompt、期待出力、assertion、evaluatorへ渡すfile
- `fixtures/expected-mappings.json`: route、bridge/native exact execution count、caller continuation、return status、terminal、runtime event、required/forbidden observation、fixture hash
- `actual-results.json`: with-skill / baseline の実測ledger
- `fixtures/workflow-call.cases.json`: 任意名caller skillからのcall、routing input、path mutation
- `fixtures/workflow-return.cases.json`: exact callへ結合されるreturnとcrosswire mutation

`actual-results.json` は現在、全caseを `not_executed` と明記している。各caseは `case_id`、
`eval_id`、`eval_name` の3つを `evals.json` とmappingへexactに結合する。fixtureの静的検査は
モデルやsubagentによるskill評価ではないため、実測結果へ昇格させない。

実測evidenceは `evidence_root: "evidence"` 配下の
`<case_id>/<with_skill|baseline>/...` に置く。executed variantは通常fileへの安全な相対pathを
1件以上必要とし、root escape、symlink、別case/variantのevidence流用を拒否する。

ledgerの状態はevidenceから機械的に決まる。

- どのvariantにもevidenceがない: `model_execution.status=not_executed`、gradeも`not_executed`
- 一部variantだけにevidenceがある: `model_execution.status=partial`、片側だけのcaseはgradeを`pending`
- 全caseのwith-skill/baselineが揃う: `model_execution.status=completed`。grade進捗は別の件数で表す

gradeを`graded`にできるのは同じcaseのwith-skillとbaselineが両方executedの場合だけで、有限の
`delta` が必要になる。

caller fixture のentrypointは `caller-skill.fixture.txt` として保存し、preflight中だけOSのtemporary
directoryへ任意名caller rootを作ってskill entrypointへmaterializeする。したがって、`evals/` 配下の
fixtureがproduction skillとして自動検出されることはない。

## 決定的なfixture preflight

repository root以外のcwdからも実行できる。

```bash
node /absolute/path/to/dynamic-workflow-runner/evals/run-fixtures.mjs
```

このrunnerは外部network、モデル、subagent、workflow controllerを呼び出さない。call作成と検査に
同skillの決定的 `workflow-bridge.mjs prepare-call / validate-call` だけを使い、次を機械的に検査する。

1. 3つのJSON文書がparseできること
2. 35件の `case_id` / `eval_id` / `eval_name` / `files` がexactに1対1対応すること
3. 全file参照がskill directory内の通常fileへ解決すること
4. fixtureのraw SHA-256がmappingと一致すること
5. `*.case.json` 内の `case_id` が外側のcaseと一致すること
6. direct manifest templateをmemory上だけでmaterializeし、sourceのabsolute pathとraw SHA-256が結合されること
7. actual ledgerのnot-executed / partial / completed状態をevidenceから導出し、片側だけのgrade、欠落evidence、case/name crosswireを拒否すること
8. `[SKILL_DIR]` とcaller-root-relative pathをcaller rootへ解決し、source / caller `SKILL.md` / exact argsのhashをcall receiptへ結合すること
9. missing source、root escape、symlink source、args hash driftを実行前に拒否すること
10. native precedence、ordinary script、inactive branch、implicit bridgeのrouteとbridge/native実行回数がmappingとexactに一致すること
11. `workflow-call.schema.json` / `workflow-return.schema.json` に適合するcall/returnを作り、call hash・value hash・schema hash・caller root・phase ownershipを照合すること
12. 別callerのschema-valid return bindingまたはreturn receiptをcrosswireしても拒否すること
13. native Workflowを一度attemptしたcallは、失敗後もbridgeへfallbackせずnative実行回数1でrejectすること
14. skill bridgeのtranslation input/receiptがworkflow call bindingを必須とし、欠落と別callerへのcrosswireを拒否すること
15. translation reviewが実行controllerとexact ordered runner contract inventoryへ結合され、別copy、欠落、hash driftを拒否すること
16. translated modeの実translator handleがreview input/receipt/outputへ事前固定され、crosswireとreviewer handle再利用を拒否すること
17. artifact projectionがsource-selected fieldだけを凍結し、投影外contextとproducer driftを拒否すること
18. data-dependent capability requestがprojection後に評価され、利用不能時のdomain fallback guardを強制すること
19. collaboration operationの最小requirementと、relative transport path / absolute semantic pathの分離を確認すること
20. semantic agent callsiteのexact visible inputを保ち、決定的pre/post transformを別境界へ分離すること
21. raw agent schemaを後段normalization invariantで狭化せず、normalized artifact contractを別に持つこと
22. source-authorizedなbounded conditional readを順序付きoptional artifactとして保持すること
23. bounded `prefixItems`をtask/returnでindex別に検証し、validator実装もrunner review inventoryへ結合すること

成功時のstdoutの `model_execution` はledgerから導出したstatus、実行variant数、grade済みcase数を
出す。現在値は `not_executed` だが、部分実測なら `partial`、全件実測・grade済みなら `completed` に
なる。preflight自身のsynthetic ledger mutationは実測に数えず、skillの品質passにも昇格させない。

特に、`implicit-cross-skill-bridge` などの静的route fixtureは、Codexのskill auto-selectionが実際に
発火したことを証明しない。user promptにはcompatibility runner名を含めていないが、preflightが証明する
のは「caller callsiteが選択済みなら、call/route/return契約を決定的に検査できる」ことまでである。
skill discoveryと間接起動はfresh modelのtool traceを保存した実モデル評価でのみ確認する。

## 実モデル評価

実測するときは次をcaseごとに保存する。

1. `evals.json` の `files` をfresh evaluatorへ渡す。
2. `case_id` が完全一致するmappingだけを選ぶ。
3. `runtime_events` があるcaseは、記載順のoutcome、resume snapshot、gate decisionを与える。
4. evaluatorは返却文だけでなく、manifest、receipt、state、review artifactを使って
   `required_observations` と `forbidden_observations` を判定する。
5. with-skillとbaselineを別のfresh contextで実行し、`evidence/<case_id>/<variant>/` 配下へevidenceを残す。
6. 両方のevidenceが揃ったcaseだけをgradeする。片側欠測を0点や不合格へ丸めない。
7. 実行後にのみ `actual-results.json` の該当caseを更新する。推測した結果は書かない。
8. indirect caseではuser promptへcompatibility runner名を足さず、caller skillの選択、active callsite到達、native/bridgeのexact execution countをtool traceで確認する。
9. native precedence caseはnativeが1回、bridgeが0回であることを、inactive/ordinary caseは両方0回であることをtraceで確認する。

## Direct manifest template

`direct-portable` caseでは、`direct-portable.manifest.template.json` をtemporary directoryへcopyして
使えるが、preflight runnerは同じmaterializationをmemory上だけで検証する。
`{{SOURCE_PATH}}` は `direct-research.input` のabsolute path、`{{SOURCE_SHA256}}` は同fileのraw
SHA-256で一度だけ置換する。それ以外のfieldは変えない。

fixtureに含むhashはダミーとして成功扱いしない。templateの2つのplaceholder以外でhashが
合わない場合は、その不一致を検出するcaseでない限りfixture/harness失敗とする。
