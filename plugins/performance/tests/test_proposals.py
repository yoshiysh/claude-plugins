import copy
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import proposals as p


def comparison():
    group = {k: p.fingerprint(k) for k in p.GROUP}
    def cohort(prefix, tokens):
        return {"group": dict(group), "samples": [dict(id=p.fingerprint([prefix, n]),
            usage=dict(input_tokens=tokens, cached_input_tokens=10, output_tokens=10), duration_ms=100,
            status="completed", quality="passed", quality_source="independent",
            quality_evidence=p.fingerprint(["quality", prefix, n]),
            usage_evidence=p.fingerprint(["usage", prefix, n])) for n in range(3)]}
    return dict(mode="drift", baseline=cohort("before", 100), candidate=cohort("after", 200))


class ProposalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = Path(temporary.name) / "queue"

    def test_valid_candidate_is_not_automatic_improvement(self):
        result = p.compare(comparison())
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["reason"], "investigate_regression")
        self.assertEqual(result["before"]["tokens"], 110)
        self.assertEqual(result["after"]["tokens"], 210)

    def test_hook_collects_and_enqueues_without_output_or_duplicate_proposals(self):
        root = self.store.parent
        source = root / "events.jsonl"
        source.write_text(json.dumps({"type": "result", "subtype": "success", "is_error": False,
            "usage": {"input_tokens": 100, "cache_creation_input_tokens": 0,
                      "cache_read_input_tokens": 10, "output_tokens": 20}}) + "\n")
        comparison_path = root / "comparison.json"
        comparison_path.write_text(json.dumps(comparison()))
        config = root / "hook.json"
        config.write_text(json.dumps(dict(enabled=True, host="claude", cwd=str(root),
            adapter="claude-query", input=str(source), stream_id="synthetic-single-query",
            store=str(root / "ledger"), retention_days=30,
            proposal=dict(input=str(comparison_path), store=str(self.store)))))
        script = Path(p.__file__).with_name("hook_collect.py")
        for _ in range(2):
            result = subprocess.run([sys.executable, str(script), "--config", str(config)],
                input=json.dumps({"hook_event_name": "Stop", "cwd": str(root),
                                  "transcript_path": "/ignored/private-transcript"}),
                text=True, capture_output=True, timeout=8)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        ledger = json.loads((root / "ledger" / "state.json").read_text())
        queue = json.loads((self.store / "state.json").read_text())
        self.assertEqual(len(ledger["rows"]), 1)
        self.assertEqual(len(queue["items"]), 1)
        self.assertEqual(queue["items"][0]["state"], "pending")

    def test_reduction_is_only_verification_candidate(self):
        data = comparison()
        data["baseline"], data["candidate"] = data["candidate"], data["baseline"]
        self.assertEqual(p.compare(data)["reason"], "verify_reduction")

    def test_producer_quality_is_not_comparable(self):
        # 生成主体の自己申告品質（producer）は、値が passed でも候補の前提を満たさない。
        data = comparison()
        data["candidate"]["samples"][0]["quality_source"] = "producer"
        self.assertEqual(p.compare(data)["status"], "not_comparable")

    def test_quality_evidence_reuse_is_rejected(self):
        # 品質証拠は usage 証拠・観測 id と別の産物でなければならない（使い回しは schema 拒否）。
        for source in ("usage_evidence", "id"):
            data = comparison()
            sample = data["candidate"]["samples"][0]
            sample["quality_evidence"] = sample[source]
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "quality_evidence_reuse"):
                p.compare(data)

    def test_missing_quality_or_usage_and_failed_execution_not_comparable(self):
        for change in ({"quality": "unmeasured"}, {"quality": "failed"}, {"quality_evidence": None},
                       {"status": "failed"}, {"status": "unknown"}, {"usage": None}, {"duration_ms": None}):
            data = comparison()
            data["candidate"]["samples"][0].update(change)
            with self.subTest(change=change):
                self.assertEqual(p.compare(data)["status"], "not_comparable")

    def test_different_group_and_small_samples_not_comparable(self):
        for key in p.GROUP:
            data = comparison()
            data["candidate"]["group"][key] = "0" * 64
            self.assertEqual(p.compare(data)["status"], "not_comparable")
        data = comparison()
        data["candidate"]["samples"].pop()
        self.assertEqual(p.compare(data)["status"], "not_comparable")

    def test_duplicate_sample_and_evidence_rejected(self):
        for key in ("id", "usage_evidence"):
            data = comparison()
            data["candidate"]["samples"][0][key] = data["baseline"]["samples"][0][key]
            with self.assertRaises(ValueError):
                p.compare(data)

    def test_invalid_numbers_and_arbitrary_fields_rejected(self):
        for change in ({"duration_ms": True}, {"prompt": "SECRET"}, {"quality_evidence": "SECRET"}):
            data = comparison()
            data["candidate"]["samples"][0].update(change)
            with self.assertRaises(ValueError):
                p.compare(data)

    def test_zero_baseline_and_no_change(self):
        data = comparison()
        for sample in data["baseline"]["samples"]:
            sample["duration_ms"] = 0
        self.assertEqual(p.compare(data)["status"], "not_comparable")
        data = comparison()
        for sample in data["candidate"]["samples"]:
            sample["usage"]["input_tokens"] = 100
        self.assertEqual(p.compare(data)["status"], "no_material_change")

    def test_dismissal_survives_reorder_of_identical_observations(self):
        data = comparison()
        candidate = p.compare(data)
        self.assertEqual(p.update(self.store, candidate, now=100, cooldown=60)["status"], "queued")
        p.update(self.store, decision="dismissed", item_id=candidate["fingerprint"], now=101, cooldown=60)
        data["baseline"]["samples"].reverse()
        data["candidate"]["samples"].reverse()
        self.assertEqual(p.compare(data), candidate)
        result = p.update(self.store, p.compare(data), now=200, cooldown=60)
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(result["pending_count"], 0)

    def test_new_evidence_requires_cooldown_and_marks_reproposal(self):
        data = comparison()
        first = p.compare(data)
        p.update(self.store, first, now=100, cooldown=60)
        p.update(self.store, decision="dismissed", item_id=first["fingerprint"], now=101, cooldown=60)
        data["candidate"]["samples"][0]["usage_evidence"] = "0" * 64
        second = p.compare(data)
        self.assertEqual(p.update(self.store, second, now=110, cooldown=60)["status"], "unchanged")
        result = p.update(self.store, second, now=200, cooldown=60)
        self.assertEqual(result["status"], "queued")
        self.assertTrue(result["items"][0]["new_evidence"])

    def test_defer_and_corruption_fail_closed(self):
        candidate = p.compare(comparison())
        p.update(self.store, candidate, now=100, cooldown=60)
        result = p.update(self.store, decision="deferred", item_id=candidate["fingerprint"], now=101, cooldown=60)
        self.assertEqual(result["pending_count"], 0)
        self.assertEqual(p.update(self.store, now=200)["pending_count"], 1)
        path = self.store / "state.json"
        state = json.loads(path.read_text())
        state["items"][0]["prompt"] = "SECRET"
        path.write_text(json.dumps(state))
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            p.update(self.store, now=201)
        self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
