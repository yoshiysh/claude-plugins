import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import cohort
import proposals
import run_schema


def h(text):
    return hashlib.sha256(text.encode()).hexdigest()


def group():
    return {"project": h("p"), "task_class": h("t"), "model": h("m"),
            "settings": h("s"), "quality_contract": h("q")}


def fingerprint(digest):
    return {"digest": digest, "computed_at": 1, "drift": None}


def evaluation(verdict="pass", independent=True, refs=("artifact-1",)):
    return {"case_id": "case-1", "contract_version": "1",
            "verifier_version": "1", "artifact_refs": list(refs),
            "verdict": verdict, "evidence_independent": independent}


def run(inv, input_tokens, status="completed", evaluations=()):
    return {"invocations": [{
                "invocation_id": inv, "parent_invocation_id": None,
                "root_invocation_id": inv,
                "skill": {"marketplace": "m", "plugin": "demo",
                          "public_name": "demo", "scope": None},
                "fingerprint": fingerprint("c" * 64),
                "started_at": 100, "ended_at": 300, "status": status,
                "boundary_evidence": "explicit_entry"}],
            "spans": [{"span_id": f"sp-{inv}", "invocation_id": inv,
                       "kind": "agent", "started_at": 100, "ended_at": 200}],
            "atoms": [{"call_identity": f"call-{inv}", "host": "claude",
                       "provider": "anthropic", "source_epoch": 1,
                       "usage": {"input_tokens": input_tokens,
                                 "cached_input_tokens": 0, "output_tokens": 5},
                       "owner_span_id": f"sp-{inv}", "evidence": "sdk"}],
            "coverage": {inv: {d: {"state": "complete", "missing_reason": None}
                               for d in run_schema.COVERAGE_DIMENSIONS}},
            "evaluations": [dict(e) for e in evaluations]}


def sides(base_tokens=1000, cand_tokens=100, n=3, cand_eval=None):
    base_eval = [evaluation(refs=(f"base-artifact-{i}",)) for i in range(1)]
    return (
        {"variant": fingerprint("a" * 64),
         "runs": [run(f"b{i}", base_tokens,
                      evaluations=[evaluation(refs=(f"ba-{i}",))]) for i in range(n)]},
        {"variant": fingerprint("b" * 64),
         "runs": [run(f"c{i}", cand_tokens,
                      evaluations=cand_eval if cand_eval is not None
                      else [evaluation(refs=(f"ca-{i}",))]) for i in range(n)]},
    )


class WiringTests(unittest.TestCase):
    def test_observed_runs_reach_candidate_verdict(self):
        base, cand = sides()
        payload = cohort.build_comparison(group(), base, cand)
        result = proposals.compare(payload)
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["reason"], "verify_reduction")

    def test_unevaluated_runs_demote_to_investigate(self):
        base, cand = sides(cand_eval=[])
        result = proposals.compare(cohort.build_comparison(group(), base, cand))
        self.assertEqual(result["reason"], "investigate_only")
        self.assertIn("quality_unmeasured", result["reasons"])

    def test_failed_evaluation_never_passes_as_quality(self):
        base, cand = sides(cand_eval=[evaluation("fail", refs=("f-1",))])
        payload = cohort.build_comparison(group(), base, cand)
        self.assertEqual(payload["candidate"]["samples"][0]["quality"], "failed")

    def test_producer_evaluation_marked_as_producer(self):
        base, cand = sides(cand_eval=[evaluation(independent=False,
                                                 refs=("p-1",))])
        payload = cohort.build_comparison(group(), base, cand)
        self.assertEqual(payload["candidate"]["samples"][0]["quality_source"],
                         "producer")

    def test_sample_fields_are_derived_not_shared(self):
        base, cand = sides()
        payload = cohort.build_comparison(group(), base, cand)
        ids = [s["id"] for side in ("baseline", "candidate")
               for s in payload[side]["samples"]]
        evidence = [s["usage_evidence"] for side in ("baseline", "candidate")
                    for s in payload[side]["samples"]]
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual(len(set(evidence)), len(evidence))
        self.assertFalse(set(ids) & set(evidence))

    def test_open_run_has_null_duration_and_unknown_status(self):
        r = run("open-1", 10)
        r["invocations"][0]["ended_at"] = None
        r["invocations"][0]["status"] = "running"
        r["coverage"]["open-1"]["boundary"] = {"state": "unknown",
                                               "missing_reason": "in_progress"}
        sample = cohort.sample_from_run(r)
        self.assertIsNone(sample["duration_ms"])
        self.assertEqual(sample["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
