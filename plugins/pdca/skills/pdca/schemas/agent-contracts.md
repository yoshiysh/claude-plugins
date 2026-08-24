# agent 間契約

フィールド名は script（`scripts/pdca.js`）の schema と一致させる。ずれると集計から黙って落ちる。

| agent | 入力 | 出力 |
|---|---|---|
| intake | 起点の文、資料 | `{origin_mode, statement, has_environment, user_success_definition, budget, questions[], materials[]}` |
| evidence-collector | intake 出力 | `{facts[{statement,source,date}], unverified[{statement,status,why}], constraints_observed[]}` |
| planner | intake + evidence 出力 | Plan（`assets/plan-template.md`）+ `operators_used[]` + `operator_outputs` ／ または `{status:"unverifiable", reason, what_is_needed}` ／ `needs_deliberation` |
| builder | `[PLAN] [FIXED_ACROSS_CONDITIONS] [CONDITIONS] [PREVIOUS_ARTIFACTS?] [PREVIOUS_MECHANISMS?] [REVISION_DIFFS?]` | `{artifacts[], measurement_points[], shared_state_warnings[], notes}` |
| runner | `[PLAN] [FIXED] [CONDITION] [ARTIFACTS] [MEASUREMENT_POINTS] [RUN_INDEX] [BUDGET]` | `{condition_id, run_index, executed, observations, raw_measurements, cost, anomalies[]}` |
| verifier | `[SUCCESS_CRITERIA]（text + METRIC + 向き） [CONDITION_ID] [RUN_INDEX] [ARTIFACTS] [RUN_OBSERVATIONS] [RAW_MEASUREMENTS]` | `{condition_id, run_index, measured, unmeasured_reason, score, criteria_checks[{criterion,met,evidence}], failure_mechanism_hint, self_report_used}` |
| mechanism-analyst | `[SUCCESS_CRITERIA] [PER_CONDITION_STATS] [DELTA] [RUN_DETAILS]` | `{mechanisms[{statement,evidence,alternative_explanations[],identified}], criteria_validity, unmeasured[], gap}` |
| plan-verifier | Plan JSON | `{verdict: pass|revise, findings[{lens,severity,claim,why_it_breaks_measurement,what_would_make_it_testable}], non_findings[]}` |
| plan-verifier | Plan JSON | `{verdict: pass|revise, findings[{lens,severity,claim,why_it_breaks_measurement,what_would_make_it_testable}], non_findings[]}` |
| act-judge | Do/Check 返り値 + Plan の成功基準・停止条件 | `{decision: standardize|revise|stop|human_required, matched_rule, basis[{field,value,why}], auto_executable, conflicts[], note_for_user}` |
| revision-planner | `check.mechanisms[]`, Plan | `{revisionDiffs[], predicted_observations[], deferred[{diff,why}]}` |

## script の args
```
{ skillDir, plan, successCriteria:{text, metric, higher_is_better}, conditions[{id,label,spec}], fixed,
  runsPerCondition, budget:{maxRuns, note}, cycle, previous (前周の返り値をそのまま。script が do.artifacts / check.mechanisms を解決する), revisionDiffs[] }
```

## script の返り値
```
{ status:"ok"|"BLOCKED", reason?, evidence?,
  do:{artifacts[], measurement_points[], runs[]},
  check:{results:{per_condition[{condition_id,label,issued,returned,measured_n,unmeasured[],unscored[],mean_score,spread,self_report_used}],
                  metric, higher_is_better, delta, delta_basis, favored}, gap, mechanisms[], criteria_validity, unmeasured[]},
  confidence:"mechanism_identified"|"suggestive"|"inconclusive", calibration_notes[], runTable[],
  cycle, max_cycles, truncations[], revision_diffs_applied[] }
```
`delta: null` は測れていない（引き分けではない）。`favored` は `higher_is_better` を反映済み。
