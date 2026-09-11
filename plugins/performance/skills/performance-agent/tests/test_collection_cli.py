"""Exercise a standalone copy of shipped scripts, without installing hooks."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class CollectionCLITests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.scripts = self.root / "standalone bundle" / "scripts"
        shutil.copytree(Path(__file__).resolve().parents[1] / "scripts", self.scripts,
                        ignore=shutil.ignore_patterns("__pycache__"))
        self.store = self.root / "private store"
        self.source = self.root / "SECRET usage.jsonl"
        self.source.write_text(json.dumps(dict(version=1, source="SECRET", run_id="SECRET",
            call_id="SECRET", input_tokens=100, cached_input_tokens=40, output_tokens=20)) + "\n")

    def invoke(self, adapter="normalized", source=None, script="collect.py"):
        # Ignore Python environment/user packages while preserving sibling imports.
        command = [sys.executable, "-E", "-s", "-B", str(self.scripts / script), adapter,
                   str(source or self.source)]
        if script == "collect.py":
            command += ["--store", str(self.store)]
        result = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.stderr, "")
        self.assertNotIn("SECRET", result.stdout)
        self.assertNotIn(str(self.root), result.stdout)
        return result.returncode, json.loads(result.stdout)

    def records(self):
        raw = (self.store / "snapshots.json").read_text()
        self.assertNotIn("SECRET", raw)
        self.assertNotIn(str(self.root), raw)
        return json.loads(raw)["records"]

    def test_standalone_normalized_collection_and_replay(self):
        before = self.source.read_bytes()
        code, result = self.invoke()
        self.assertEqual(code, 0)
        self.assertFalse(result["duplicate"])
        self.assertIs(type(result["collector_duration_ms"]), int)
        self.assertGreaterEqual(result["collector_duration_ms"], 0)
        self.assertEqual(self.invoke()[1]["duplicate"], True)
        rows = self.records()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["report"]["usage"]["uncached_input_tokens"], 60)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(self.store.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.store / "snapshots.json").stat().st_mode & 0o777, 0o600)

    def test_workflow_terminal_states_and_unknown_usage(self):
        run = self.root / "SECRET run"
        run.mkdir()
        (run / "request.json").write_text('{"prompt":"SECRET"}')
        journal = run / "events.jsonl"
        for terminal, known in (("completed", True), ("failed", True), ("failed", False)):
            with self.subTest(terminal=terminal, known=known):
                rows = [dict(type="run.started"), dict(type="agent.started", id=1, prompt="SECRET")]
                if known:
                    rows.append(dict(type="agent.event", id=1, event=dict(type="turn.completed",
                        usage=dict(input_tokens=100, cached_input_tokens=40, output_tokens=20))))
                if terminal == "completed":
                    rows.append(dict(type="agent.completed", id=1, result="SECRET"))
                rows.append(dict(type="run." + terminal))
                journal.write_text("".join(json.dumps(row | {"sequence": n}) + "\n"
                                          for n, row in enumerate(rows, 1)))
                before = journal.read_bytes()
                code, result = self.invoke("workflow", run)
                self.assertEqual(code, 0)
                self.assertEqual(result["status"], "collected")
                report = self.records()[-1]["report"]
                self.assertEqual(report["execution_status"], terminal)
                self.assertIs(report["measurement_complete"], known)
                self.assertEqual(report["quality"], "unmeasured")
                self.assertEqual(report["calls_without_outcome"], int(terminal == "failed"))
                if not known:
                    self.assertIsNone(report["usage"])
                self.assertEqual(journal.read_bytes(), before)
        self.assertEqual(len(self.records()), 3)

    def test_measurement_never_creates_store(self):
        code, report = self.invoke(script="measure.py")
        self.assertEqual(code, 0)
        self.assertEqual(report["usage"]["input_tokens"], 100)
        self.assertFalse(self.store.exists())

    def test_invalid_input_fails_without_store_or_body_output(self):
        self.source.write_text("SECRET broken evidence\n")
        code, result = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(result, dict(status="collection_failed", reason="invalid_busy_or_unwritable"))
        self.assertFalse(self.store.exists())

    def test_corrupt_existing_report_is_preserved_and_not_printed(self):
        self.assertEqual(self.invoke()[0], 0)
        target = self.store / "snapshots.json"
        state = json.loads(target.read_text())
        state["records"][0]["report"] = {"prompt": "SECRET"}
        target.write_text(json.dumps(state))
        before = target.read_bytes()
        code, result = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "collection_failed")
        self.assertEqual(target.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
