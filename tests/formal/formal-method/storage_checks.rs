use super::{run_case, SolverResult};
pub(super) const MODEL: &str = include_str!("storage.smt2");
pub(super) const SOURCE: &str = include_str!("storage_checks.rs");
pub(super) const IMPLEMENTATION: &str = include_str!("durable_storage.rs");
pub(super) const TESTS: &str = include_str!("durable_storage_tests.rs");
pub(super) fn run(z3: &str) -> Result<(), String> {
    let flags = [
        "bad_early_ack",
        "bad_precommit_replace",
        "bad_report_replace",
        "bad_auto_delete",
    ];
    let checks = [
        ("ack_after_directory_sync", "(and acknowledged (< stage 5))"),
        (
            "precommit_preserves_previous",
            "(and (< stage 4) (not (= recovered previous)))",
        ),
        (
            "stopped_report_preserved",
            "(not (= report_after report_before))",
        ),
        ("only_user_deletes", "(and deleted (not user_delete))"),
    ];
    for (i, (name, query)) in checks.iter().enumerate() {
        for mutate in [false, true] {
            let pre = flags
                .iter()
                .enumerate()
                .map(|(n, f)| {
                    format!(
                        "(assert (= {f} {}))\n",
                        if mutate && n == i { "true" } else { "false" }
                    )
                })
                .collect::<String>();
            run_case(
                z3,
                &format!(
                    "storage_{name}_{}",
                    if mutate { "mutation" } else { "correct" }
                ),
                MODEL,
                &pre,
                query,
                if mutate {
                    SolverResult::Sat
                } else {
                    SolverResult::Unsat
                },
            )?;
        }
    }
    run_case(
        z3,
        "storage_failure_before_publish_reachable",
        MODEL,
        "(assert (= bad_precommit_replace false))",
        "(and (= stage 3) (not (= previous proposed)) (= recovered previous))",
        SolverResult::Sat,
    )?;
    run_case(
        z3,
        "storage_uncertain_publish_reachable",
        MODEL,
        "(assert (= bad_early_ack false))",
        "(and (= stage 4) (= recovered proposed) (not acknowledged))",
        SolverResult::Sat,
    )
}
