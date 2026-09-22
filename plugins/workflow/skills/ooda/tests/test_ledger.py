"""ledger.py の追記・読み出しの契約テスト。"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ledger.py"


def run(*argv):
    return subprocess.run([sys.executable, str(SCRIPT), *argv], capture_output=True, text=True)


PAYLOADS = {
    "observe": {"baseline_metrics": [], "current_state": "s", "gaps_identified": []},
    "orient": {"status": "ok", "options": []},
    "decide": {"status": "ok"},
    "act": {"executed_steps": [], "new_observations": [], "outcome": "observed"},
    "act_verified": {"verified": [], "rejected": []},
}


def entry(iteration=1, phase="observe", payload=None):
    return {"iteration": iteration, "phase": phase, "payload": payload if payload is not None else PAYLOADS.get(phase, {})}


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "run" / "ledger.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def append(self, entries):
        return run("append", "--path", str(self.path), "--json", json.dumps(entries))

    def read(self, *extra):
        return run("read", "--path", str(self.path), *extra)

    def test_append_ends_every_line_with_newline(self):
        result = self.append([entry(), entry(phase="orient")])
        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.path.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(len(text.splitlines()), 2)

    def test_consecutive_appends_stay_parseable(self):
        self.assertEqual(self.append([entry()]).returncode, 0)
        self.assertEqual(self.append([entry(phase="act"), entry(phase="act_verified")]).returncode, 0)
        result = self.read()
        self.assertEqual(result.returncode, 0, result.stderr)
        entries = json.loads(result.stdout)
        self.assertEqual([e["phase"] for e in entries], ["observe", "act", "act_verified"])
        for e in entries:
            self.assertEqual(set(e), {"seq", "iteration", "phase", "payload", "timestamp"})

    def test_broken_line_is_an_error_not_skipped(self):
        self.assertEqual(self.append([entry()]).returncode, 0)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write("{not json\n")
        self.assertNotEqual(self.read().returncode, 0)
        before = self.path.read_text(encoding="utf-8")
        self.assertNotEqual(self.append([entry()]).returncode, 0)
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

    def test_missing_trailing_newline_is_an_error(self):
        self.assertEqual(self.append([entry()]).returncode, 0)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"seq": 2, **entry(), "timestamp": "x"}))
        self.assertNotEqual(self.read().returncode, 0)

    def test_unknown_phase_is_rejected_without_writing(self):
        result = self.append([entry(), entry(phase="revise")])
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.path.exists())

    def test_invalid_types_are_rejected(self):
        for bad in (entry(iteration=0), entry(iteration="1"), entry(payload=[1]), {"phase": "observe", "payload": PAYLOADS["observe"]}):
            self.assertNotEqual(self.append([bad]).returncode, 0, bad)
        self.assertNotEqual(run("append", "--path", str(self.path), "--json", json.dumps(entry())).returncode, 0)

    def test_caller_cannot_supply_seq_or_timestamp(self):
        self.assertNotEqual(self.append([{**entry(), "seq": 99}]).returncode, 0)
        self.assertNotEqual(self.append([{**entry(), "timestamp": "2000-01-01"}]).returncode, 0)

    def test_act_verified_payload_shape_is_enforced(self):
        for bad in ({}, {"verified": [], "rejected": {}}, {"verified": None, "rejected": []}):
            self.assertNotEqual(self.append([entry(phase="act_verified", payload=bad)]).returncode, 0, bad)
        self.assertFalse(self.path.exists())

    def test_act_verified_payload_shape_is_checked_on_read(self):
        self.path.parent.mkdir(parents=True)
        stored = {"seq": 1, "iteration": 1, "phase": "act_verified", "payload": {}, "timestamp": "t"}
        self.path.write_text(json.dumps(stored) + "\n", encoding="utf-8")
        self.assertNotEqual(self.read().returncode, 0)

    def test_read_missing_file_is_an_error_unless_allowed(self):
        missing = self.read()
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("--allow-missing", missing.stderr)
        allowed = self.read("--allow-missing")
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(json.loads(allowed.stdout), [])

    def test_directory_path_is_a_clean_error(self):
        self.path.parent.mkdir(parents=True)
        result = run("read", "--path", str(self.path.parent))
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Traceback", result.stderr)

    def test_append_accepts_stdin(self):
        payload = json.dumps([entry(phase="act", payload={"executed_steps": [], "new_observations": [{"observation": "it's 3.1s", "source": "log"}], "outcome": "observed"})])
        result = subprocess.run([sys.executable, str(SCRIPT), "append", "--path", str(self.path)], input=payload, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.read().stdout)[0]["payload"]["new_observations"][0]["observation"], "it's 3.1s")

    def test_seq_increases_monotonically_across_appends(self):
        self.append([entry(), entry(phase="orient")])
        self.append([entry(phase="decide")])
        self.append([entry(iteration=2)])
        seqs = [e["seq"] for e in json.loads(self.read().stdout)]
        self.assertEqual(seqs, [1, 2, 3, 4])


if __name__ == "__main__":
    unittest.main()
