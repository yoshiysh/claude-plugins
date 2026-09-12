import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import proposals


def h(text):
    return hashlib.sha256(text.encode()).hexdigest()


def group(model="m"):
    return {"project": h("p"), "task_class": h("t"), "model": h(model),
            "settings": h("s"), "quality_contract": h("q")}


def sample(i, tokens, **over):
    row = {"id": h(f"id-{i}"), "usage": {"input_tokens": tokens,
                                         "cached_input_tokens": 0,
                                         "output_tokens": 10},
           "duration_ms": 1000, "status": "completed", "quality": "passed",
           "quality_source": "independent", "quality_evidence": h(f"qe-{i}"),
           "usage_evidence": h(f"ue-{i}")}
    row.update(over)
    return row


def fingerprint(digest):
    return {"digest": digest, "computed_at": 1, "drift": None}


def payload(base_model="m", cand_model="m", n=3, cand_tokens=100, **sample_over):
    return {"mode": "variant",
            "baseline": {"group": group(base_model),
                         "variant": fingerprint("a" * 64),
                         "samples": [sample(f"b{i}", 1000) for i in range(n)]},
            "candidate": {"group": group(cand_model),
                          "variant": fingerprint("b" * 64),
                          "samples": [sample(f"c{i}", cand_tokens, **sample_over)
                                      for i in range(n)]}}


class ScenarioS9(unittest.TestCase):
    def test_model_mismatch_rejected_with_reason(self):
        result = proposals.compare(payload(cand_model="other-model"))
        self.assertEqual(result["status"], "not_comparable")
        self.assertEqual(result["reasons"], ["group_mismatch:model"])


class ScenarioS10(unittest.TestCase):
    def test_variant_only_difference_is_accepted(self):
        result = proposals.compare(payload())
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["reason"], "verify_reduction")


class ScenarioS11(unittest.TestCase):
    def test_two_repetitions_demoted_to_investigate(self):
        result = proposals.compare(payload(n=2, cand_tokens=600))
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["reason"], "investigate_only")
        self.assertIn("insufficient_repetitions:baseline", result["reasons"])


class ScenarioS12(unittest.TestCase):
    def test_unmeasured_quality_never_certified(self):
        result = proposals.compare(payload(cand_tokens=700,
                                           quality="unmeasured",
                                           quality_evidence=None))
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["reason"], "investigate_only")
        self.assertIn("quality_unmeasured", result["reasons"])


class ScenarioS13(unittest.TestCase):
    def test_shared_quality_evidence_across_cohorts_rejected(self):
        data = payload()
        shared = h("shared-evidence")
        data["baseline"]["samples"][0]["quality_evidence"] = shared
        data["candidate"]["samples"][0]["quality_evidence"] = shared
        result = proposals.compare(data)
        self.assertEqual(result["status"], "not_comparable")
        self.assertEqual(result["reasons"],
                         ["quality_evidence_reuse_across_cohorts"])


class QueueWiring(unittest.TestCase):
    def test_investigate_only_enters_queue(self):
        import tempfile
        result = proposals.compare(payload(n=2, cand_tokens=600))
        with tempfile.TemporaryDirectory() as store:
            outcome = proposals.update(store, result, now=1000)
        self.assertEqual(outcome["status"], "queued")
        self.assertEqual(outcome["items"][0]["reason"], "investigate_only")

    def test_v1_incomparable_never_reaches_queue(self):
        data = payload(n=2, cand_tokens=600)
        data["mode"] = "drift"
        for name in ("baseline", "candidate"):
            del data[name]["variant"]
        result = proposals.compare(data)
        self.assertEqual(result["status"], "not_comparable")


class NoneDurationQueue(unittest.TestCase):
    def test_investigate_only_with_missing_duration_reaches_queue(self):
        import tempfile
        data = payload(n=2, cand_tokens=600, duration_ms=None)
        result = proposals.compare(data)
        self.assertEqual(result["reason"], "investigate_only")
        with tempfile.TemporaryDirectory() as store:
            outcome = proposals.update(store, result, now=1000)
        self.assertEqual(outcome["status"], "queued")
        self.assertIsNone(outcome["items"][0]["after"]["duration_ms"])


if __name__ == "__main__":
    unittest.main()
