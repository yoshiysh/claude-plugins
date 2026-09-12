import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import report_v2
import schema_v2


def fingerprint():
    return {"digest": "a" * 64, "computed_at": 1, "drift": None}


def skill(plugin="demo"):
    return {"marketplace": "m", "plugin": plugin, "public_name": plugin,
            "scope": None}


def invocation(inv, parent=None, root=None, status="completed", plugin="demo",
               started=100, ended=200):
    return {"invocation_id": inv, "parent_invocation_id": parent,
            "root_invocation_id": root or inv, "skill": skill(plugin),
            "fingerprint": fingerprint(), "started_at": started,
            "ended_at": ended, "status": status,
            "boundary_evidence": "explicit_entry"}


def span(sid, inv, kind="agent"):
    return {"span_id": sid, "invocation_id": inv, "kind": kind,
            "started_at": 100, "ended_at": 150}


def atom(call, owner, tokens):
    return {"call_identity": call, "host": "claude", "provider": "anthropic",
            "source_epoch": 1,
            "usage": {"input_tokens": tokens, "cached_input_tokens": 0,
                      "output_tokens": 0},
            "owner_span_id": owner, "evidence": "sdk"}


def coverage(state="complete", reason=None):
    return {d: {"state": state, "missing_reason": reason}
            for d in schema_v2.COVERAGE_DIMENSIONS}


class ScenarioS5(unittest.TestCase):
    def test_unknown_usage_is_lower_bound_not_zero(self):
        cov = coverage()
        cov["usage"] = {"state": "unknown", "missing_reason": "source_rotated"}
        run = {"invocations": [invocation("inv-1")],
               "spans": [span("sp-1", "inv-1")],
               "atoms": [atom("c1", "sp-1", 500)],
               "coverage": {"inv-1": cov}, "evaluations": []}
        result = report_v2.report(run)
        self.assertEqual(result["skill_usage"]["input_tokens"], 500)
        self.assertEqual(result["total_label"], "observed_lower_bound")
        self.assertIsNone(result["unobserved_usage"])
        self.assertTrue(any(g["dimension"] == "usage"
                            for g in result["coverage_gaps"]))


class ScenarioS6(unittest.TestCase):
    def test_failed_attempt_stays_in_totals(self):
        run = {"invocations": [
                   invocation("inv-f", root="inv-f", status="failed"),
                   invocation("inv-s", parent="inv-f", root="inv-f",
                              status="completed")],
               "spans": [span("sp-f", "inv-f"), span("sp-s", "inv-s")],
               "atoms": [atom("c-f", "sp-f", 200), atom("c-s", "sp-s", 300)],
               "coverage": {"inv-f": coverage(), "inv-s": coverage()},
               "evaluations": []}
        result = report_v2.report(run)
        self.assertEqual(result["skill_usage"]["input_tokens"], 500)
        self.assertEqual(result["failure_cost"]["input_tokens"], 200)
        stats = result["attempts"]["inv-f"]
        self.assertEqual(stats["attempts"], 2)
        self.assertEqual(stats["success_rate"], 0.5)


class ScenarioS7(unittest.TestCase):
    def test_prepare_and_finalize_are_counted(self):
        run = {"invocations": [invocation("inv-1")],
               "spans": [span("sp-p", "inv-1", "prepare"),
                         span("sp-a", "inv-1", "agent"),
                         span("sp-f", "inv-1", "finalize")],
               "atoms": [atom("c-p", "sp-p", 50), atom("c-a", "sp-a", 100),
                         atom("c-f", "sp-f", 70)],
               "coverage": {"inv-1": coverage()}, "evaluations": []}
        result = report_v2.report(run)
        self.assertEqual(result["per_invocation"]["inv-1"]["inclusive"]
                         ["input_tokens"], 220)
        self.assertEqual(result["skill_usage"]["input_tokens"], 220)


class ScenarioS8(unittest.TestCase):
    def test_overhead_shown_separately(self):
        run = {"invocations": [invocation("inv-1"),
                               invocation("inv-perf", plugin="performance")],
               "spans": [span("sp-1", "inv-1"), span("sp-o", "inv-perf")],
               "atoms": [atom("c-1", "sp-1", 220), atom("c-o", "sp-o", 40)],
               "coverage": {"inv-1": coverage(), "inv-perf": coverage()},
               "evaluations": []}
        result = report_v2.report(run)
        self.assertEqual(result["skill_usage"]["input_tokens"], 220)
        self.assertEqual(result["overhead_usage"]["input_tokens"], 40)


class ReportContracts(unittest.TestCase):
    def test_unattributed_not_folded_into_skill(self):
        run = {"invocations": [invocation("inv-1")],
               "spans": [span("sp-1", "inv-1")],
               "atoms": [atom("c-1", "sp-1", 100),
                         atom("c-shared", None, 999)],
               "coverage": {"inv-1": coverage()}, "evaluations": []}
        result = report_v2.report(run)
        self.assertEqual(result["skill_usage"]["input_tokens"], 100)
        self.assertEqual(result["unattributed_usage"]["input_tokens"], 999)

    def test_open_invocation_lowers_success_rate(self):
        run = {"invocations": [
                   invocation("inv-1", status="completed"),
                   invocation("inv-2", parent="inv-1", root="inv-1",
                              status="running", ended=None)],
               "spans": [], "atoms": [],
               "coverage": {"inv-1": coverage(),
                            "inv-2": coverage("unknown", "in_progress")},
               "evaluations": []}
        result = report_v2.report(run)
        self.assertEqual(result["attempts"]["inv-1"]["success_rate"], 0.5)


class WorkflowSpanShapes(unittest.TestCase):
    def test_workflow_generate_and_run_spans_stay_in_totals(self):
        run = {"invocations": [invocation("inv-1")],
               "spans": [span("sp-p", "inv-1", "prepare"),
                         span("sp-g", "inv-1", "workflow_generate"),
                         span("sp-w", "inv-1", "workflow_run"),
                         span("sp-f", "inv-1", "finalize")],
               "atoms": [atom("c-p", "sp-p", 50), atom("c-g", "sp-g", 30),
                         atom("c-w", "sp-w", 100), atom("c-f", "sp-f", 70)],
               "coverage": {"inv-1": coverage()}, "evaluations": []}
        result = report_v2.report(run)
        self.assertEqual(result["skill_usage"]["input_tokens"], 250)
        self.assertEqual(result["per_invocation"]["inv-1"]["inclusive"]
                         ["input_tokens"], 250)


if __name__ == "__main__":
    unittest.main()
