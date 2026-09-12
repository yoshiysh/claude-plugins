import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import proposals


def h(text):
    return hashlib.sha256(text.encode()).hexdigest()


def group():
    return {"project": h("p"), "task_class": h("t"), "model": h("m"),
            "settings": h("s"), "quality_contract": h("q")}


def sample(i, tokens):
    return {"id": h(f"id-{i}"), "usage": {"input_tokens": tokens,
                                          "cached_input_tokens": 0,
                                          "output_tokens": 10},
            "duration_ms": 1000, "status": "completed", "quality": "passed",
            "quality_source": "independent", "quality_evidence": h(f"qe-{i}"),
            "usage_evidence": h(f"ue-{i}")}


def fingerprint(digest):
    return {"digest": digest, "computed_at": 1, "drift": None}


def payload(base_fp="a" * 64, cand_fp="b" * 64, cand_tokens=100):
    return {"mode": "variant",
            "baseline": {"group": group(), "variant": fingerprint(base_fp),
                         "samples": [sample(f"b{i}", 1000) for i in range(3)]},
            "candidate": {"group": group(), "variant": fingerprint(cand_fp),
                          "samples": [sample(f"c{i}", cand_tokens) for i in range(3)]}}


class CompareV2Tests(unittest.TestCase):
    def test_variant_split_allows_implementation_change(self):
        result = proposals.compare(payload())
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["reason"], "verify_reduction")

    def test_same_variant_not_comparable(self):
        result = proposals.compare(payload(base_fp="a" * 64, cand_fp="a" * 64))
        self.assertEqual(result["status"], "not_comparable")

    def test_group_mismatch_not_comparable(self):
        data = payload()
        data["candidate"]["group"]["settings"] = h("other-settings")
        self.assertEqual(proposals.compare(data)["status"], "not_comparable")

    def test_variant_mode_requires_variant_key(self):
        data = payload()
        del data["candidate"]["variant"]
        with self.assertRaisesRegex(ValueError, "cohort_schema"):
            proposals.compare(data)

    def test_v1_still_accepts_legacy_cohorts(self):
        data = payload(cand_tokens=1000)
        data["mode"] = "drift"
        for name in ("baseline", "candidate"):
            del data[name]["variant"]
        self.assertEqual(proposals.compare(data)["status"], "no_material_change")

    def test_v1_rejects_variant_key(self):
        data = payload()
        data["mode"] = "drift"
        del data["candidate"]["variant"]
        with self.assertRaisesRegex(ValueError, "cohort_schema"):
            proposals.compare(data)

    def test_fingerprint_distinguishes_variant_pairs(self):
        a = proposals.compare(payload(cand_fp="b" * 64))
        b = proposals.compare(payload(cand_fp="c" * 64))
        self.assertNotEqual(a["fingerprint"], b["fingerprint"])


if __name__ == "__main__":
    unittest.main()
