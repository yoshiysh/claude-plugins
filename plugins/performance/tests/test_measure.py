import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "measure.py"
spec = importlib.util.spec_from_file_location("measure", SCRIPT)
measure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measure)


def record(**changes):
    return dict(version=1, source="test", run_id="r", call_id="1",
                input_tokens=100, cached_input_tokens=40, output_tokens=20) | changes


def events():
    return [
        {"type": "run.started", "time": "2026-09-08T04:00:00Z"},
        {"type": "agent.started", "id": 1, "prompt": "SECRET"},
        {"type": "agent.event", "id": 1, "event": {
            "type": "turn.completed", "usage": {
                "input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 20}}},
        {"type": "agent.completed", "id": 1, "result": "SECRET"},
        {"type": "agent.started", "id": 2},
        {"type": "run.failed", "time": "2026-09-08T04:00:01Z", "inFlight": [2]},
    ]


class MeasurementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "request.json").write_text('{"prompt":"SECRET"}')

    def write_events(self, rows):
        data = "".join(json.dumps(row | {"sequence": n}) + "\n"
                       for n, row in enumerate(rows, 1))
        (self.root / "events.jsonl").write_text(data)

    def test_arithmetic_and_deduplication(self):
        result = measure.aggregate([record(), record(), record(call_id="2")])
        self.assertEqual(result["usage"], dict(input_tokens=200, cached_input_tokens=80,
                                             output_tokens=40, uncached_input_tokens=120))
        self.assertEqual(result["observed_calls"], 2)
        self.assertEqual(result["duplicates_ignored"], 1)
        self.assertIsNone(result["measurement_complete"])

    def test_invalid_normalized_values(self):
        mutations = [dict(input_tokens=True), dict(input_tokens=-1), dict(input_tokens=1.5),
                     dict(cached_input_tokens=101), dict(output_tokens=None), dict(version=True),
                     dict(version=2), dict(call_id=""), dict(extra="SECRET")]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                measure.aggregate([record(**mutation)])
        missing = record()
        del missing["output_tokens"]
        with self.assertRaises(ValueError):
            measure.aggregate([missing])

    def test_conflicting_or_cross_source_records_rejected(self):
        for second in [record(output_tokens=21), record(source="other")]:
            with self.assertRaises(ValueError):
                measure.aggregate([record(), second])

    def test_empty_is_unknown_but_observed_zero_is_zero(self):
        self.assertIsNone(measure.aggregate([])["usage"])
        self.assertEqual(measure.aggregate([record(input_tokens=0, cached_input_tokens=0,
                                                  output_tokens=0)])["usage"]["input_tokens"], 0)

    def test_partial_failed_run_preserves_observations_and_source(self):
        self.write_events(events())
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        result = measure.workflow(self.root)
        self.assertEqual(result["usage"]["input_tokens"], 100)
        self.assertEqual(result["duration_ms"], 1000)
        self.assertEqual(result["execution_status"], "failed")
        self.assertEqual(result["calls_without_usage"], 1)
        self.assertEqual(result["calls_without_outcome"], 1)
        self.assertFalse(result["measurement_complete"])
        self.assertEqual(result["quality"], "unmeasured")
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})

    def test_complete_usage_is_not_quality_success(self):
        rows = events()[:4] + [{"type": "run.completed"}]
        self.write_events(rows)
        result = measure.workflow(self.root)
        self.assertTrue(result["measurement_complete"])
        self.assertEqual(result["quality"], "unmeasured")
        self.assertIsNone(result["duration_ms"])

    def test_unfinished_success_rejected(self):
        self.write_events(events()[:3] + [{"type": "run.completed"}])
        with self.assertRaisesRegex(ValueError, "unfinished_success"):
            measure.workflow(self.root)

    def test_duplicate_json_keys_rejected_everywhere(self):
        for key in ("input_tokens", "call_id"):
            data = json.dumps(record()).replace("{", '{"' + key + '": 1,', 1)
            with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
                measure.lines((data + "\n").encode())
        self.write_events(events())
        path = self.root / "events.jsonl"
        path.write_text(path.read_text().replace('"input_tokens": 100',
                                                '"input_tokens": 1, "input_tokens": 100'))
        with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
            measure.workflow(self.root)
        self.write_events(events())
        (self.root / "request.json").write_text('{"id": 1, "id": 2}')
        with self.assertRaisesRegex(ValueError, "duplicate_json_key"):
            measure.workflow(self.root)

    def test_missing_usage_not_zero(self):
        for usage in [None, {"input_tokens": 100}, {}]:
            rows = events()
            rows[2]["event"]["usage"] = usage
            self.write_events(rows)
            result = measure.workflow(self.root)
            self.assertIsNone(result["usage"])
            self.assertEqual(result["calls_without_usage"], 2)

    def test_bad_sequences_and_orphan_events(self):
        original = events()
        variants = [original[1:], original[:-1], original[:3] + original[2:],
                    original[:4] + [original[3]] + original[4:],
                    original[:1] + [original[2]] + original[1:],
                    original + [{"type": "run.completed"}],
                    original[:1] + [{"type": "unknown"}] + original[1:]]
        for rows in variants:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.write_events(rows)
                measure.workflow(self.root)
        self.write_events(original)
        path = self.root / "events.jsonl"
        path.write_text(path.read_text().replace('"sequence": 2', '"sequence": 99'))
        with self.assertRaises(ValueError):
            measure.workflow(self.root)

    def test_backward_time_unknown(self):
        rows = events()
        rows[-1]["time"] = "2026-09-07T00:00:00Z"
        self.write_events(rows)
        self.assertIsNone(measure.workflow(self.root)["duration_ms"])

    def test_malformed_jsonl(self):
        for data in [b"", b"{}", b"\n", b"[]\n", b"SECRET\n", b" " * (1024 * 1024 + 1) + b"\n"]:
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                measure.lines(data)

    def test_outside_symlink_rejected(self):
        self.write_events(events())
        path = self.root / "request.json"
        path.unlink()
        path.symlink_to(SCRIPT)
        with self.assertRaises(ValueError):
            measure.workflow(self.root)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "requires FIFO support")
    def test_fifo_rejected_without_waiting(self):
        path = self.root / "pipe"
        os.mkfifo(path)
        result = subprocess.run([sys.executable, str(SCRIPT), "normalized", str(path)],
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 1)

    def test_cli_failure_does_not_leak_content(self):
        path = self.root / "SECRET.jsonl"
        path.write_text("SECRET\n")
        result = subprocess.run([sys.executable, str(SCRIPT), "normalized", str(path)],
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        self.assertNotIn("SECRET", result.stdout)
        self.assertEqual(json.loads(result.stdout)["status"], "measurement_failed")


if __name__ == "__main__":
    unittest.main()
