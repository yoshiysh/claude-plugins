import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import schema_v2


def fingerprint(digest="a" * 64):
    return {"digest": digest, "computed_at": 1, "drift": None}


def skill(plugin="performance", name="agent"):
    return {"marketplace": "yoshiysh-claude-plugins", "plugin": plugin,
            "public_name": name, "scope": None}


def invocation(inv="inv-1", parent=None, root="inv-1", status="completed",
               ended=200, evidence="host_dispatch", **over):
    row = {"invocation_id": inv, "parent_invocation_id": parent,
           "root_invocation_id": root, "skill": skill(),
           "fingerprint": fingerprint(), "started_at": 100, "ended_at": ended,
           "status": status, "boundary_evidence": evidence}
    row.update(over)
    return row


def span(sid="sp-1", inv="inv-1", kind="agent"):
    return {"span_id": sid, "invocation_id": inv, "kind": kind,
            "started_at": 100, "ended_at": 150}


def atom(call="call-1", owner="sp-1", input_tokens=10, cached=2, output=5):
    return {"call_identity": call, "host": "claude", "provider": "anthropic",
            "source_epoch": 1, "usage": {"input_tokens": input_tokens,
                                         "cached_input_tokens": cached,
                                         "output_tokens": output},
            "owner_span_id": owner, "evidence": "sdk_message_id"}


def coverage(state="complete"):
    reason = None if state == "complete" else "not_observed"
    return {d: {"state": state, "missing_reason": reason}
            for d in schema_v2.COVERAGE_DIMENSIONS}


def run(**over):
    value = {"invocations": [invocation()], "spans": [span()],
             "atoms": [atom()], "coverage": {"inv-1": coverage()},
             "evaluations": []}
    value.update(over)
    return value


def experiment(**over):
    value = {"fixed_conditions": {
                 "case_snapshot": "snap-1", "quality_contract": "qc-1",
                 "runtime": "claude-code-2.x", "permissions": "default",
                 "background_context": "fresh", "resolved_model": "claude-fable-5",
                 "effort": "high", "cache_condition": "cold"},
             "variants": [fingerprint("a" * 64), fingerprint("b" * 64)],
             "case_ids": ["case-1", "case-2"], "repetitions": 3,
             "execution_order": "alternating",
             "quality_tolerance": "pass率の低下なし",
             "stop_budget": "12 runs / 2M tokens"}
    value.update(over)
    return value


class InvocationTests(unittest.TestCase):
    def test_valid(self):
        schema_v2.validate_invocation(invocation())

    def test_missing_end_cannot_be_success(self):
        for status in ("completed", "failed", "cancelled", "censored"):
            with self.assertRaisesRegex(ValueError, "missing_end_not_success"):
                schema_v2.validate_invocation(invocation(ended=None, status=status))
        schema_v2.validate_invocation(invocation(ended=None, status="unknown"))
        schema_v2.validate_invocation(invocation(ended=None, status="running"))

    def test_closed_requires_closed_status(self):
        with self.assertRaisesRegex(ValueError, "invalid_status"):
            schema_v2.validate_invocation(invocation(status="running"))

    def test_local_skill_needs_scope(self):
        bad = skill()
        bad["marketplace"] = None
        with self.assertRaisesRegex(ValueError, "unanchored_skill_identity"):
            schema_v2.validate_invocation(invocation(skill=bad))

    def test_fingerprint_drift_is_recordable(self):
        fp = fingerprint()
        fp["drift"] = "dependency_changed:references/measurement.md"
        schema_v2.validate_invocation(invocation(fingerprint=fp))


class LineageTests(unittest.TestCase):
    def test_nested_parallel_retry(self):
        rows = [invocation(),
                invocation("inv-2", parent="inv-1", root="inv-1"),
                invocation("inv-3", parent="inv-1", root="inv-1"),
                invocation("inv-4", parent="inv-2", root="inv-1", status="failed"),
                invocation("inv-5", parent="inv-2", root="inv-1")]
        cov = {r["invocation_id"]: coverage() for r in rows}
        schema_v2.validate_run(run(invocations=rows, coverage=cov))

    def test_duplicate_invocation(self):
        rows = [invocation(), invocation()]
        with self.assertRaisesRegex(ValueError, "duplicate_invocation"):
            schema_v2.validate_run(run(invocations=rows))

    def test_orphan_parent(self):
        rows = [invocation(), invocation("inv-2", parent="ghost", root="inv-1")]
        cov = {"inv-1": coverage(), "inv-2": coverage()}
        with self.assertRaisesRegex(ValueError, "orphan_parent"):
            schema_v2.validate_run(run(invocations=rows, coverage=cov))

    def test_root_must_follow_parent(self):
        rows = [invocation(), invocation("inv-2", parent="inv-1", root="inv-2")]
        cov = {"inv-1": coverage(), "inv-2": coverage()}
        with self.assertRaisesRegex(ValueError, "root_mismatch"):
            schema_v2.validate_run(run(invocations=rows, coverage=cov))


class AtomTests(unittest.TestCase):
    def test_duplicate_call_identity_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate_call_identity"):
            schema_v2.validate_run(run(atoms=[atom(), atom()]))

    def test_shared_call_stays_unattributed(self):
        schema_v2.validate_run(run(atoms=[atom(owner=None)]))
        totals = schema_v2.exclusive_usage(run(atoms=[atom(owner=None)]), "inv-1")
        self.assertEqual(totals, {"input_tokens": 0, "cached_input_tokens": 0,
                                  "output_tokens": 0})

    def test_cache_cannot_exceed_input(self):
        with self.assertRaisesRegex(ValueError, "cache_exceeds_input"):
            schema_v2.validate_atom(atom(input_tokens=1, cached=2))

    def test_orphan_owner(self):
        with self.assertRaisesRegex(ValueError, "orphan_atom_owner"):
            schema_v2.validate_run(run(atoms=[atom(owner="ghost-span")]))

    def test_exclusive_usage_single_owner(self):
        rows = [invocation(),
                invocation("inv-2", parent="inv-1", root="inv-1")]
        spans = [span(), span("sp-2", "inv-2")]
        atoms = [atom("call-1", "sp-1", input_tokens=10, cached=0, output=1),
                 atom("call-2", "sp-2", input_tokens=7, cached=0, output=2)]
        cov = {"inv-1": coverage(), "inv-2": coverage()}
        r = run(invocations=rows, spans=spans, atoms=atoms, coverage=cov)
        schema_v2.validate_run(r)
        self.assertEqual(schema_v2.exclusive_usage(r, "inv-1")["input_tokens"], 10)
        self.assertEqual(schema_v2.exclusive_usage(r, "inv-2")["input_tokens"], 7)


class CoverageTests(unittest.TestCase):
    def test_partial_requires_reason(self):
        cov = coverage()
        cov["usage"] = {"state": "partial", "missing_reason": None}
        with self.assertRaisesRegex(ValueError, "missing_reason_required"):
            schema_v2.validate_run(run(coverage={"inv-1": cov}))

    def test_declared_boundary_cannot_be_complete(self):
        rows = [invocation(evidence="declared")]
        with self.assertRaisesRegex(ValueError, "declared_boundary_complete"):
            schema_v2.validate_run(run(invocations=rows))
        cov = coverage()
        cov["boundary"] = {"state": "unknown", "missing_reason": "declared_only"}
        schema_v2.validate_run(run(invocations=rows, coverage={"inv-1": cov}))


class EvaluationTests(unittest.TestCase):
    def test_verdict_requires_artifacts(self):
        row = {"case_id": "case-1", "contract_version": "1", "verifier_version": "1",
               "artifact_refs": [], "verdict": "pass", "evidence_independent": True}
        with self.assertRaisesRegex(ValueError, "verdict_without_artifacts"):
            schema_v2.validate_evaluation(row)
        row["verdict"] = "unmeasured"
        schema_v2.validate_evaluation(row)


class ExperimentTests(unittest.TestCase):
    def test_valid(self):
        schema_v2.validate_experiment(experiment())

    def test_duplicate_variant(self):
        with self.assertRaisesRegex(ValueError, "duplicate_variant"):
            schema_v2.validate_experiment(experiment(
                variants=[fingerprint(), fingerprint()]))

    def test_minimum_repetitions(self):
        with self.assertRaisesRegex(ValueError, "insufficient_repetitions"):
            schema_v2.validate_experiment(experiment(repetitions=2))

    def test_condition_mismatch_named(self):
        exp = experiment()
        observed = dict(exp["fixed_conditions"])
        observed["resolved_model"] = "claude-opus-5"
        observed["cache_condition"] = "warm"
        with self.assertRaisesRegex(ValueError,
                                    "condition_mismatch:cache_condition,resolved_model"):
            schema_v2.reject_condition_mismatch(exp, observed)
        schema_v2.reject_condition_mismatch(exp, exp["fixed_conditions"])


if __name__ == "__main__":
    unittest.main()
