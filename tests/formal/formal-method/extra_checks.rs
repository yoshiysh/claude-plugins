use super::{
    diagnostic, parse_model, run_solver, ChildStatus, SolverResult, IDENTITY_MODEL, MAPPING_MODEL,
    REPORTING_MODEL, JOB_LEDGER,
};
use std::collections::HashSet;

struct Case {
    name: String,
    formula: String,
    expected: SolverResult,
}

fn case(name: impl Into<String>, formula: impl Into<String>, expected: SolverResult) -> Case {
    Case {
        name: name.into(),
        formula: formula.into(),
        expected,
    }
}

// Each batch is a single solver process; each query has its own push/pop scope.
fn run_batch(z3: &str, model: &str, prelude: &str, cases: &[Case]) -> Result<(), String> {
    if cases.is_empty() {
        return Err("empty verification batch".into());
    }
    for chunk in cases.chunks(8) {
        let mut input = format!("{model}\n{prelude}\n");
        for c in chunk {
            input.push_str(&format!(
                "(push)\n(assert {})\n(check-sat)\n(pop)\n",
                c.formula
            ));
        }
        let (status, output, stderr) =
            run_solver(z3, &input).map_err(|e| format!("batch solver failed: {e}"))?;
        if status != ChildStatus::Exited(Some(0)) {
            return Err(format!(
                "batch {} failed: {}",
                chunk[0].name,
                diagnostic(status, &stderr)
            ));
        }
        validate_batch_output(chunk, &output)?;
    }
    Ok(())
}

fn validate_batch_output(chunk: &[Case], output: &str) -> Result<(), String> {
    if chunk.is_empty() {
        return Err("empty verification batch".into());
    }
    let lines = output.lines().map(str::trim).collect::<Vec<_>>();
    if lines.len() != chunk.len() {
        return Err(format!(
            "batch {} returned {} results for {} queries; output(first512)={:?}",
            chunk[0].name,
            lines.len(),
            chunk.len(), output.chars().take(512).collect::<String>()
        ));
    }
    for (c, line) in chunk.iter().zip(lines) {
        let result = match line {
            "sat" => SolverResult::Sat,
            "unsat" => SolverResult::Unsat,
            "unknown" => SolverResult::Unknown,
            "timeout" => SolverResult::Timeout,
            _ => SolverResult::Error,
        };
        println!("{}: {:?} (expected {:?})", c.name, result, c.expected);
        if result != c.expected {
            return Err(format!(
                "{}: unexpected result; no verification pass",
                c.name
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{case, run_batch, validate_batch_output, validate_flags, SolverResult};
    #[test]
    fn incomplete_unknown_or_reordered_batch_is_not_accepted() {
        let cases = [
            case("a", "true", SolverResult::Sat),
            case("b", "false", SolverResult::Unsat),
        ];
        assert!(validate_batch_output(&cases, "sat\nunsat\n").is_ok());
        for output in [
            "sat\n",
            "sat\nunknown\n",
            "sat\ntimeout\n",
            "unsat\nsat\n",
            "sat\nunsat\nsat\n",
            "sat\n(error bad)\n",
        ] {
            assert!(validate_batch_output(&cases, output).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn batch_rejects_solver_failure_and_unknown_in_real_process() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("formal-batch-test-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("fake-solver");
        let cases = [
            case("a", "true", SolverResult::Sat),
            case("b", "false", SolverResult::Unsat),
        ];
        for (output, exit, accepted) in [
            ("sat\\nunsat\\n", 0, true),
            ("sat\\nunknown\\n", 0, false),
            ("sat\\n", 0, false),
            ("sat\\nunsat\\n", 42, false),
        ] {
            std::fs::write(
                &path,
                format!("#!/bin/sh\ncat >/dev/null\nprintf '{output}'\nexit {exit}\n"),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(
                run_batch(path.to_str().unwrap(), "", "", &cases).is_ok(),
                accepted
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn undeclared_or_duplicate_mutations_are_rejected() {
        assert!(validate_flags("(declare-const bad_x Bool)", &["bad_x"]).is_ok());
        assert!(validate_flags(
            "(declare-const bad_x Bool)(declare-const bad_y Bool)",
            &["bad_x"]
        )
        .is_err());
        assert!(validate_flags(
            "(declare-const bad_x Bool)(declare-const bad_x Bool)",
            &["bad_x"]
        )
        .is_err());
        assert!(validate_flags("", &["bad_x"]).is_err());
    }
}

fn validate_flags(model: &str, expected: &[&str]) -> Result<(), String> {
    let forms = parse_model(model)?;
    let mut seen = HashSet::new();
    for form in forms {
        let Some(xs) = form.list() else { continue };
        if xs.first().and_then(|x| x.atom()) != Some("declare-const") {
            continue;
        }
        if xs.len() != 3 {
            return Err("invalid declaration".into());
        }
        let Some(name) = xs[1].atom() else {
            return Err("invalid declaration name".into());
        };
        if name.starts_with("bad_") || name.starts_with("mutate_") || expected.contains(&name) {
            if !expected.contains(&name)
                || xs[2].atom() != Some("Bool")
                || !seen.insert(name.to_owned())
            {
                return Err(format!("unexpected or duplicate mutation flag {name}"));
            }
        }
    }
    if seen.len() != expected.len() {
        return Err("mutation flags differ from test contract".into());
    }
    Ok(())
}

fn fixed_flags(flags: &[&str], enabled: Option<&str>) -> String {
    flags
        .iter()
        .map(|f| {
            if Some(*f) == enabled {
                f.to_string()
            } else {
                format!("(not {f})")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn with_flags(flags: &[&str], enabled: Option<&str>, predicate: &str) -> String {
    format!("(and {} {predicate})", fixed_flags(flags, enabled))
}

fn check_identity(z3: &str) -> Result<(), String> {
    let mut cases = Vec::new();
    let v0 = "((as const (Array Field Value)) V0)";
    cases.push(case(
        "identity_reuse_oracle",
        "(not (= (reuse-permitted old current) (oracle-reuse old current)))",
        SolverResult::Unsat,
    ));
    cases.push(case(
        "identity_comparison_oracle",
        "(not (= (can-report-faster old current ta tb) (oracle-comparison old current ta tb)))",
        SolverResult::Unsat,
    ));
    cases.push(case(
        "identity_matching",
        format!("(not (= (classification {v0} {v0}) 0))"),
        SolverResult::Unsat,
    ));
    cases.push(case(
        "identity_matching_reuse",
        format!("(reuse-permitted {v0} {v0})"),
        SolverResult::Sat,
    ));
    let fields = [
        "Target",
        "Model",
        "ToolKind",
        "ToolVersion",
        "ToolConfig",
        "Evidence",
        "Acquisition",
        "Property",
        "Assumptions",
        "Scope",
        "Criteria",
        "Time",
    ];
    for field in fields {
        for (name, value, class) in [
            ("mismatch", "V1", 1),
            ("missing", "Missing", 2),
            ("invalid", "Invalid", 3),
        ] {
            let changed = format!("(store {v0} {field} {value})");
            cases.push(case(
                format!("identity_{name}_{field}"),
                format!("(not (= (classification {v0} {changed}) {class}))"),
                SolverResult::Unsat,
            ));
            cases.push(case(
                format!("identity_reuse_denied_{name}_{field}"),
                format!("(reuse-permitted {v0} {changed})"),
                SolverResult::Unsat,
            ));
            cases.push(case(
                format!("identity_old_{name}_{field}"),
                format!("(not (= (classification {changed} {v0}) {class}))"),
                SolverResult::Unsat,
            ));
        }
    }
    for field in ["Target", "Property", "Assumptions", "Scope"] {
        for value in ["V1", "Missing", "Invalid"] {
            cases.push(case(
                format!("comparison_denied_{field}_{value}"),
                format!("(can-report-faster {v0} (store {v0} {field} {value}) 1 2)"),
                SolverResult::Unsat,
            ));
        }
    }
    cases.push(case(
        "comparison_missing_time",
        format!("(can-report-faster {v0} {v0} (- 1) 2)"),
        SolverResult::Unsat,
    ));
    cases.push(case(
        "comparison_different_tools",
        format!("(can-report-faster {v0} (store {v0} ToolKind V1) 1 2)"),
        SolverResult::Sat,
    ));
    cases.push(case("identity_mutant_wrong_version", format!("(and (mutant-ignore-version {v0} (store {v0} ToolVersion V1)) (not (oracle-reuse {v0} (store {v0} ToolVersion V1))))"), SolverResult::Sat));
    let missing = format!("(store {v0} ToolVersion Missing)");
    cases.push(case("identity_mutant_missing", format!("(and (mutant-allow-missing {missing} {missing}) (not (oracle-reuse {missing} {missing})))"), SolverResult::Sat));
    cases.push(case("comparison_mutant_scope", format!("(and (mutant-ignore-scope {v0} (store {v0} Scope V1) 1 2) (not (oracle-comparison {v0} (store {v0} Scope V1) 1 2)))"), SolverResult::Sat));
    cases.push(case("identity_invalid_precedes_missing", format!("(not (= (classification (store {v0} ToolVersion Missing) (store {v0} Target Invalid)) 3))"), SolverResult::Unsat));
    if cases.len() != 130 {
        return Err(format!("identity case inventory changed: {}", cases.len()));
    }
    run_batch(z3, IDENTITY_MODEL, "(declare-const old Identity)\n(declare-const current Identity)\n(declare-const ta Int)\n(declare-const tb Int)", &cases)
}

fn check_mapping(z3: &str) -> Result<(), String> {
    let flags = [
        "hide_unmapped",
        "complete_with_unmapped",
        "overclaim_scope",
        "bad_scope_target",
        "compare_mismatch",
        "compare_unknown",
    ];
    validate_flags(MAPPING_MODEL, &flags)?;
    let mut cases = Vec::new();
    for p in [
        "missing_hidden",
        "complete_with_missing",
        "claims_outside_verified",
        "invalid_comparison",
    ] {
        cases.push(case(
            format!("mapping_normal_{p}"),
            with_flags(&flags, None, p),
            SolverResult::Unsat,
        ));
    }
    for (m, p) in [
        ("hide_unmapped", "missing_hidden"),
        ("complete_with_unmapped", "complete_with_missing"),
        ("overclaim_scope", "claims_outside_verified"),
        ("bad_scope_target", "claims_outside_verified"),
        ("compare_mismatch", "invalid_comparison"),
        ("compare_unknown", "invalid_comparison"),
    ] {
        cases.push(case(
            format!("mapping_mutation_{m}"),
            with_flags(&flags, Some(m), p),
            SolverResult::Sat,
        ));
    }
    for (name, p) in [
        ("valid_mapping", "(and required0 link00 (= reqTarget0 propTarget0) verified0 (= scope0 #b01) claim0 (= claimScope0 #b01) (not reportMissing0))"),
        ("missing_report", "(and required0 (not link00) (not link01) reportMissing0 (not complete))"),
        ("aligned_comparison", "(and (= leftTarget #b01) (= rightTarget #b01) (= leftProperty #b10) (= rightProperty #b10) (= leftAssumption #b01) (= rightAssumption #b01) (= leftRange #b10) (= rightRange #b10) comparisonReported)"),
        ("mismatch_rejected", "(and (= leftTarget #b01) (= rightTarget #b10) (not comparisonReported))"),
        ("unknown_rejected", "(and (= leftTarget #b00) (not comparisonReported))"),
    ] { cases.push(case(format!("mapping_witness_{name}"), with_flags(&flags, None, p), SolverResult::Sat)); }
    cases.push(case("mapping_known_mismatch", with_flags(&flags, Some("compare_mismatch"), "(and invalid_comparison (= leftTarget #b01) (= rightTarget #b10) (= leftProperty #b01) (= rightProperty #b01) (= leftAssumption #b01) (= rightAssumption #b01) (= leftRange #b01) (= rightRange #b01))"), SolverResult::Sat));
    cases.push(case("mapping_unknown_target", with_flags(&flags, Some("compare_unknown"), "(and invalid_comparison (= leftTarget #b00) (= rightTarget #b01) (= leftProperty #b01) (= rightProperty #b01) (= leftAssumption #b01) (= rightAssumption #b01) (= leftRange #b01) (= rightRange #b01))"), SolverResult::Sat));
    if cases.len() != 17 {
        return Err(format!("mapping case inventory changed: {}", cases.len()));
    }
    run_batch(z3, MAPPING_MODEL, "", &cases)
}

const REPORT_FLAGS: [&str; 25] = [
    "bad_complete",
    "bad_report_poststop",
    "bad_stale_ledger",
    "bad_report_ledger_current",
    "bad_state_ref",
    "bad_report_done",
    "bad_report_unstarted",
    "bad_report_pending",
    "bad_report_unknown",
    "bad_report_unsaved",
    "bad_resume_reference",
    "bad_resume_inputs",
    "bad_no_reason",
    "bad_resume_position",
    "bad_resume_early",
    "bad_archive",
    "bad_report_review",
    "bad_report_ledger",
    "bad_report_timeout",
    "bad_report_error",
    "bad_report_counterexample",
    "bad_review_early",
    "bad_review_independence",
    "bad_report_reviewer",
    "bad_report_stop_reason",
];

fn report_case(
    name: &str,
    mutation: Option<&str>,
    predicate: &str,
    expected: SolverResult,
) -> Case {
    case(
        name,
        with_flags(&REPORT_FLAGS, mutation, predicate),
        expected,
    )
}

fn reporting_steps() -> String {
    (0..8)
        .map(|i| format!("(assert (next {i} {}))", i + 1))
        .collect::<Vec<_>>()
        .join("\n")
}

fn check_reporting(z3: &str) -> Result<(), String> {
 validate_flags(REPORTING_MODEL,&REPORT_FLAGS)?;
 let steps=format!("{}\n{}",reporting_steps(),(0..8).map(|t|format!("(assert (and (not (= (event {t}) 8)) (not (= (event {t}) 9)) (not (= (event {t}) 10))))")).collect::<Vec<_>>().join("\n"));
 let local_assumptions="(and (or (= (phase 0) 0) (= (phase 0) 1) (= (phase 0) 2)) (=> (= (phase 0) 2) (not (bad-done 0))) (<= 0 (run 0)) (<= (run 0) 1) (=> (= (review 0) 1) (= (reviewBy 0) 1)) (=> (= (phase 0) 1) (and (<= 1 (resumePosition 0)) (<= (resumePosition 0) 2) (ite (canResume 0) (and (> (stateRef 0) 0) (stateSaved 0)) (> (reasonNoResume 0) 0)))))";
 let without_init=REPORTING_MODEL.replacen("(assert init)","",1);
 let post_assumptions=["phase","run","review","reviewBy","resumePosition","canResume","stateRef","stateSaved","reasonNoResume","bad-done"].iter().fold(local_assumptions.to_owned(),|text,name|text.replace(&format!("({name} 0)"),&format!("({name} 1)")));
 run_batch(z3,REPORTING_MODEL,"",&[report_case("reporting_scoped_invariant_init",None,&format!("(not {local_assumptions})"),SolverResult::Unsat)])?;

 run_batch(z3,&without_init,"",&[report_case("reporting_scoped_one_step_snapshot_safety",None,&format!("(and {local_assumptions} (next 0 1) (not (= (event 0) 8)) (not (= (event 0) 9)) (not (= (event 0) 10)) (or (bad-report 0 1) (bad-review 0 1) (bad-done 1)))"),SolverResult::Unsat)])?;
 run_batch(z3,&without_init,"",&[report_case("reporting_scoped_invariant_step",None,&format!("(and {local_assumptions} (next 0 1) (not (= (event 0) 8)) (not (= (event 0) 9)) (not (= (event 0) 10)) (not {post_assumptions}))"),SolverResult::Unsat)])?;
 let mut cases=Vec::new();
 let ready="(and (= (event 0) 0) (= (eventJob 0) 0) (= (eventResult 0) 2) (= (event 1) 0) (= (eventJob 1) 1) (= (eventResult 1) 2) (= (event 2) 1) (= (eventJob 2) 0) (= (event 3) 1) (= (eventJob 3) 1) (= (event 4) 4))";
 let complete=format!("(and {ready} (= (event 5) 2) (= (event 6) 3) (= (event 7) 5) (= (phase 8) 2))");
 cases.push(report_case("reporting_two_jobs_review_ledger_eligible",None,&complete,SolverResult::Sat));
 cases.push(report_case("reporting_reverse_arrival_order",None,&complete.replace("(= (eventJob 0) 0)","(= (eventJob 0) 1)").replace("(= (eventJob 1) 1)","(= (eventJob 1) 0)"),SolverResult::Sat));
 for (name,event,step) in [("review",2,5),("ledger",3,6),("aggregate",4,4)] {
  let missing=complete.replace(&format!("(= (event {step}) {event})"),&format!("(= (event {step}) 11)"));
  cases.push(report_case(&format!("reporting_missing_{name}_rejected"),None,&missing,SolverResult::Unsat));
 }
 let stale=format!("(and {ready} (= (event 5) 3) (= (event 6) 2) (= (event 7) 5) (not (= (ledgerRevision 7) (workRevision 7))) (= (phase 8) 2))");
 cases.push(report_case("reporting_stale_ledger_rejected",None,&stale,SolverResult::Unsat));
 cases.push(report_case("reporting_stale_ledger_mutation",Some("bad_stale_ledger"),&stale,SolverResult::Sat));
 for (flag,predicate) in [
  ("bad_report_done","(and (= (event 0) 0) (= (eventJob 0) 0) (= (eventResult 0) 3) (= (event 1) 7) (bad-report 1 2))".to_owned()),
  ("bad_report_unknown","(and (= (event 0) 0) (= (eventJob 0) 0) (= (eventResult 0) 4) (= (event 1) 7) (bad-report 1 2))".into()),
  ("bad_report_unsaved","(and (= (event 0) 0) (= (eventJob 0) 0) (= (eventResult 0) 4) (= (event 1) 7) (bad-report 1 2))".into()),
  ("bad_review_early","(and (= (event 0) 2) (bad-review 0 1))".into()),
  ("bad_review_independence",format!("(and {ready} (= (event 5) 2) (= (chooseReviewer 5) 0) (bad-review 5 6))")),
  ("bad_report_ledger","(and (= (event 0) 3) (= (event 1) 6) (= (event 2) 7) (bad-report 2 3))".into()),
  ("bad_report_stop_reason","(and (= (event 0) 6) (= (event 1) 7) (bad-report 1 2))".into()),
  ("bad_report_pending","(and (= (event 0) 6) (= (event 1) 7) (bad-report 1 2))".into()),
  ("bad_report_unstarted","(and (= (event 0) 12) (= (eventJob 0) 1) (= (event 1) 6) (= (event 2) 7) (bad-report 2 3))".into()),
  ("bad_report_timeout","(and (= (event 0) 0) (= (eventJob 0) 0) (= (eventResult 0) 5) (= (event 1) 7) (bad-report 1 2))".into()),
  ("bad_report_error","(and (= (event 0) 0) (= (eventJob 0) 0) (= (eventResult 0) 6) (= (event 1) 7) (bad-report 1 2))".into())] {
  cases.push(report_case(&format!("reporting_scoped_{flag}"),Some(flag),&predicate,SolverResult::Sat));
 }
 for (flag,predicate) in [
  ("bad_report_ledger_current","(and (= (event 0) 6) (= (event 1) 7) (bad-report 1 2))".to_owned()),
  ("bad_report_counterexample","(and (= (event 0) 0) (= (eventJob 0) 0) (= (eventResult 0) 3) (= (event 1) 7) (bad-report 1 2))".into()),
  ("bad_report_review",format!("(and {ready} (= (event 5) 2) (= (event 6) 6) (= (event 7) 7) (bad-report 7 8))")),
  ("bad_report_reviewer",format!("(and {ready} (= (event 5) 2) (= (event 6) 6) (= (event 7) 7) (bad-report 7 8))"))] {
  cases.push(report_case(&format!("reporting_scoped_{flag}"),Some(flag),&predicate,SolverResult::Sat));
 }
 run_batch(z3,REPORTING_MODEL,&steps,&cases)
}

fn check_job_ledger(z3:&str)->Result<(),String> {
 let flags=["bad_run","bad_version","bad_duplicate","bad_source","bad_record_source","bad_record_value"];
 validate_flags(JOB_LEDGER,&flags)?;
 let steps="(assert (next 0 1))(assert (next 1 2))";
 let invalid="(or (and (accepted 1) (not (valid 0))) (and (accepted 2) (not (valid 1))))";
 let mut cases=vec![case("job_ledger_identity_gate",with_flags(&flags,None,invalid),SolverResult::Unsat)];
 for flag in ["bad_run","bad_version","bad_duplicate","bad_source"] {cases.push(case(format!("job_ledger_{flag}_mutation"),with_flags(&flags,Some(flag),invalid),SolverResult::Sat));}
 let record="(or (and (accepted 1) (or (not (= (select (source 1) (msgJob 0)) (msgSource 0))) (not (= (select (value 1) (msgJob 0)) (msgValue 0))))) (and (accepted 2) (or (not (= (select (source 2) (msgJob 1)) (msgSource 1))) (not (= (select (value 2) (msgJob 1)) (msgValue 1))))))";
 cases.push(case("job_ledger_record_identity",with_flags(&flags,None,record),SolverResult::Unsat));
 for flag in ["bad_record_source","bad_record_value"] {cases.push(case(format!("job_ledger_{flag}_mutation"),with_flags(&flags,Some(flag),record),SolverResult::Sat));}
 let both="(and (= (msgJob 0) 0) (= (msgJob 1) 1) (= (msgValue 0) 1) (= (msgValue 1) 1) (accepted 1) (accepted 2) (select (seen 2) 0) (select (seen 2) 1))";
 cases.push(case("job_ledger_same_values_both_sources",with_flags(&flags,None,both),SolverResult::Sat));
 cases.push(case("job_ledger_same_values_source_swap_detected",with_flags(&flags,Some("bad_record_source"),&format!("(and {both} {record})")),SolverResult::Sat));
 run_batch(z3,JOB_LEDGER,steps,&cases)
}

pub(super) fn run_all(z3:&str)->Result<(),String>{check_identity(z3)?;check_mapping(z3)?;check_reporting(z3)?;check_job_ledger(z3)}
