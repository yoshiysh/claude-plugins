import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import experiment
import run_schema


def fingerprint(digest):
    return {"digest": digest, "computed_at": 1, "drift": None}


def protocol():
    return {"fixed_conditions": {
                "case_snapshot": "snap-1", "quality_contract": "qc-1",
                "runtime": "claude-code", "permissions": "default",
                "background_context": "fresh", "resolved_model": "claude-fable-5",
                "effort": "high", "cache_condition": "cold"},
            "variants": [fingerprint("a" * 64), fingerprint("b" * 64)],
            "case_ids": ["case-1"], "repetitions": 3,
            "execution_order": "alternating",
            "quality_tolerance": "pass率の低下なし",
            "stop_budget": "6 runs"}


def run(inv, output_tokens, status="completed", offset=0):
    return {"invocations": [{
                "invocation_id": inv, "parent_invocation_id": None,
                "root_invocation_id": inv,
                "skill": {"marketplace": "m", "plugin": "demo",
                          "public_name": "demo", "scope": None},
                "fingerprint": fingerprint("c" * 64),
                "started_at": 100 + offset, "ended_at": 200 + offset,
                "status": status, "boundary_evidence": "explicit_entry"}],
            "spans": [{"span_id": f"sp-{inv}", "invocation_id": inv,
                       "kind": "agent", "started_at": 100 + offset,
                       "ended_at": 150 + offset}],
            "atoms": [{"call_identity": f"c-{inv}", "host": "claude",
                       "provider": "anthropic", "source_epoch": 1 + offset,
                       "usage": {"input_tokens": 10, "cached_input_tokens": 0,
                                 "output_tokens": output_tokens},
                       "owner_span_id": f"sp-{inv}", "evidence": "sdk"}],
            "coverage": {inv: {d: {"state": "complete", "missing_reason": None}
                               for d in run_schema.COVERAGE_DIMENSIONS}},
            "evaluations": []}


def fixture(cand_output=300):
    return {"a" * 64: [run(f"b{i}", 400) for i in range(3)],
            "b" * 64: [run(f"c{i}", cand_output) for i in range(3)]}


class ScenarioS14(unittest.TestCase):
    def test_replay_tracks_usage_mutation(self):
        before = experiment.replay(protocol(), fixture(cand_output=300))
        self.assertEqual(before["deltas"]["b" * 64]["output_tokens_pct"], -25.0)
        after = experiment.replay(protocol(), fixture(cand_output=600))
        self.assertEqual(after["deltas"]["b" * 64]["output_tokens_pct"], 50.0)


class ScenarioS15(unittest.TestCase):
    def test_status_mutation_moves_success_rate_and_failure_cost(self):
        data = fixture()
        data["b" * 64][0] = run("c0", 300, status="failed")
        result = experiment.replay(protocol(), data)
        agg = result["variants"]["b" * 64]
        self.assertAlmostEqual(agg["success_rate"], 2 / 3)
        self.assertEqual(agg["failure_cost"]["output_tokens"], 300)


class ScenarioS16(unittest.TestCase):
    def test_id_rename_and_atom_reorder_change_nothing(self):
        base = experiment.replay(protocol(), fixture())
        data = fixture()
        renamed = copy.deepcopy(data)
        for digest, runs in renamed.items():
            for i, r in enumerate(runs):
                old = r["invocations"][0]["invocation_id"]
                new = f"renamed-{digest[:4]}-{i}"
                r["invocations"][0]["invocation_id"] = new
                r["invocations"][0]["root_invocation_id"] = new
                r["spans"][0]["invocation_id"] = new
                r["coverage"] = {new: r["coverage"][old]}
                r["atoms"].reverse()
        mutated = experiment.replay(protocol(), renamed)
        self.assertEqual(base["variants"], mutated["variants"])
        self.assertEqual(base["deltas"], mutated["deltas"])


class ScenarioS17(unittest.TestCase):
    def test_uniform_timestamp_offset_changes_nothing(self):
        base = experiment.replay(protocol(), fixture())
        shifted = {"a" * 64: [run(f"b{i}", 400, offset=3600000) for i in range(3)],
                   "b" * 64: [run(f"c{i}", 300, offset=3600000) for i in range(3)]}
        mutated = experiment.replay(protocol(), shifted)
        self.assertEqual(base["variants"], mutated["variants"])
        self.assertEqual(base["deltas"], mutated["deltas"])


if __name__ == "__main__":
    unittest.main()
