# agent 間契約

フィールド名は script（`scripts/pdca.js`）の schema と一致させる。ずれると集計から黙って落ちる。

`[LEDGER]` はこの run で今までに何が決まったかの台帳（初周・未使用時は空）。agent は
**読むだけ**で書かない。entry の構成は script、追記は `scripts/ledger.py` が行う。
見える範囲は agent ごとに script が絞る（verifier は `resolution` / `review_v` のみ、
planner 系は Plan 系のみ、runner と mechanism-arbiter には渡さない）。
型・絞り込みの理由・再提起の扱いは [references/ledger.md](../references/ledger.md)。

| agent | 入力 | 出力 |
|---|---|---|
| intake | 起点の文、資料 | `{origin_mode, statement, has_environment, user_success_definition, budget, questions[], materials[]}` |
| evidence-collector | intake 出力 | `{facts[{statement,source,date}], unverified[{statement,status,why}], constraints_observed[]}` |
| planner | intake + evidence 出力 | Plan（`assets/plan-template.md`）+ `operators_used[]` + `operator_outputs` ／ または `{status:"unverifiable", reason, what_is_needed}` ／ `needs_deliberation` |
| builder | `[PLAN] [FIXED_ACROSS_CONDITIONS] [CONDITIONS] [PREVIOUS_ARTIFACTS?] [PREVIOUS_MECHANISMS?] [REVISION_DIFFS?] [BUILD_FINDINGS?]` | `{artifacts[], measurement_points[], shared_state_warnings[], notes}` |
| build-verifier | `[PLAN_MEASUREMENT] [SUCCESS_CRITERIA] [CONDITIONS] [ARTIFACTS] [MEASUREMENT_POINTS] [SHARED_STATE_WARNINGS] [REVISION_DIFFS?]` | `{verdict: pass\|revise, findings[{lens,severity,claim,why_it_breaks_measurement,what_would_make_it_measurable,refs[],why_resolution_insufficient}], non_findings[]}` |
| runner | `[PLAN] [FIXED] [CONDITION] [ARTIFACTS] [MEASUREMENT_POINTS] [RUN_INDEX] [BUDGET]` | `{condition_id, run_index, executed, observations, raw_measurements, cost, anomalies[]}` |
| verifier | `[SUCCESS_CRITERIA]（text + METRIC + 向き） [LENS]（criteria\|authenticity\|contract） [CONDITION_ID] [RUN_INDEX] [ARTIFACTS] [RUN_OBSERVATIONS] [RAW_MEASUREMENTS] [ANOMALIES]` | `{condition_id, run_index, lens, measured, unmeasured_reason, score（criteria レンズのみ）, criteria_checks[{criterion,met,evidence}], failure_mechanism_hint, self_report_used, refs[], why_resolution_insufficient}` |
| mechanism-analyst（2 名が独立） | `[SUCCESS_CRITERIA] [PER_CONDITION_STATS] [DELTA] [RUN_DETAILS] [SEAT]` | `{mechanisms[{statement,evidence,alternative_explanations[],identified,new,premise_defect}], criteria_validity, unmeasured[], gap}` |
| mechanism-arbiter | `[ANALYST_A_MECHANISMS] [ANALYST_B_MECHANISMS]`（index 付き） | `{pairs[{a,b,why_same}], unpaired_a[], unpaired_b[]}`（index のみ。機序の文言は返さない） |
| plan-verifier | Plan JSON | `{verdict: pass\|revise, findings[{lens,severity,claim,why_it_breaks_measurement,what_would_make_it_testable,refs[],why_resolution_insufficient}], non_findings[]}` |
| act-judge | Do/Check 返り値 + Plan の成功基準・停止条件 | `{decision: standardize|revise_criteria|revise_plan|stop|needs_input, needs_input_kind?: data|decision, questions?[], matched_rule, basis[{field,value,why}], auto_executable, conflicts[], note_for_user}` |
| revision-planner | `check.mechanisms[]`, Plan | `{revisionDiffs[], predicted_observations[], deferred[{diff,why}]}` |

## pdca-plan.js の args / 返り値
```
args: { skillDir, input（起点の文）, materials?, budget?,
        ledger?（scripts/ledger.py read の出力。省略時は空）,
        self_resolution?{ method, reason, rejected_alternatives[] }（直前の BLOCKED を自己解決して再立案するとき必須） }
返り値: { status: "ok"|"NEEDS_INPUT"|"UNVERIFIABLE"|"BLOCKED",
  ok 時: origin_mode, intake, evidence, plan, plan_review{verdict, findings[]}, attempts[]
  NEEDS_INPUT 時: kind: "data", questions[], intake
  UNVERIFIABLE 時: reason, what_is_needed
  BLOCKED 時: reason, next_step, plan?, plan_review?, attempts[]
  全 status 共通: ledger_entries[]（編集せず scripts/ledger.py append へ流す） }
```
`status: ok` の `plan` をそのまま pdca.js の `args.plan` に渡す。
ledger に Plan の BLOCKED があり、それに対する `resolution` も `self_resolution` も無い再実行は
script が BLOCKED で止める（自己解決を経ない再立案を構造で防ぐ）。

## pdca.js の args

```
{ skillDir, plan, successCriteria:{text, metric, higher_is_better}, conditions[{id,label,spec}], fixed,
  runsPerCondition, budget:{maxRuns, note}, cycle, maxCycles?（backstop・既定 5）, previous (前周の返り値をそのまま。script が do.artifacts / check.mechanisms を解決する), revisionDiffs[],
  ledger?（scripts/ledger.py read の出力。省略時は空） }
```

## script の返り値
```
{ status:"ok"|"BLOCKED", reason?, evidence?,
  do:{artifacts[], measurement_points[], runs[]},
  check:{results:{per_condition[{condition_id,label,issued,returned,measured_n,unmeasured[],unscored[],mean_score,spread,self_report_used,lens_disagreements[]}],
                  metric, higher_is_better, delta, delta_basis, favored}, gap, mechanisms[], criteria_validity, unmeasured[]},
  confidence:"mechanism_identified"|"suggestive"|"inconclusive", calibration_notes[], runTable[],
  cycle, max_cycles, new_identified_mechanisms, premise_defect_mechanisms, truncations[], revision_diffs_applied[],
  build_review, build_attempts[], ledger_entries[] }
```
`delta: null` は測れていない（引き分けではない）。`favored` は `higher_is_better` を反映済み。

既存フィールドは名前も意味も変えていない（追加のみ）。ただし `mechanisms[]` の各要素に
`corroboration`（`corroborated` / `single_source`）が増え、**単独出所の機序は `identified: false`**
になる。その結果 `new_identified_mechanisms` は従来より小さく出るので、Act 判定表の
「乾いた → stop」行が以前なら続いた局面で立つ。意図した厳格化である（根拠は
[references/verification-lenses.md](../references/verification-lenses.md)）。
