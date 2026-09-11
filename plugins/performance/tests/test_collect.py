import fcntl
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import collect


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root / "store"
        self.source = self.root / "usage.jsonl"
        self.source.write_text(json.dumps(dict(version=1, source="SECRET", run_id="SECRET",
            call_id="SECRET", input_tokens=100, cached_input_tokens=20, output_tokens=10)) + "\n")
        self.item = collect.snapshot("normalized", self.source)

    def read(self):
        return json.loads((self.store / "snapshots.json").read_text())["records"]

    def test_exact_replay_no_double_count_no_raw_text(self):
        original = self.source.read_bytes()
        collect.save(self.store, self.item, now=100)
        result = collect.save(self.store, self.item, now=101)
        self.assertTrue(result["duplicate"])
        self.assertEqual(len(self.read()), 1)
        self.assertEqual(self.read()[0]["collected_at"], 100)
        self.assertNotIn("SECRET", (self.store / "snapshots.json").read_text())
        self.assertEqual(original, self.source.read_bytes())
        self.assertEqual((self.store / "snapshots.json").stat().st_mode & 0o777, 0o600)

    def test_expiration_and_capacity_keep_newest(self):
        collect.save(self.store, self.item, now=100)
        second = self.item | {"id": "0" * 64}
        collect.save(self.store, second, now=100, max_records=1)
        self.assertEqual(self.read()[0]["id"], second["id"])
        collect.save(self.store, self.item, now=100 + 86401, retention_days=1)
        self.assertEqual(len(self.read()), 1)
        self.assertEqual(self.read()[0]["id"], self.item["id"])

    def test_conflict_and_corruption_leave_store_unchanged(self):
        collect.save(self.store, self.item, now=100)
        target = self.store / "snapshots.json"
        before = target.read_bytes()
        with self.assertRaises(ValueError):
            collect.save(self.store, self.item | {"report": {}}, now=101)
        self.assertEqual(before, target.read_bytes())
        target.write_text("SECRET invalid json")
        with self.assertRaises(ValueError):
            collect.save(self.store, self.item, now=101)
        self.assertEqual(target.read_text(), "SECRET invalid json")

    def test_parallel_writer_busy_without_waiting(self):
        collect.save(self.store, self.item, now=100)
        with (self.store / ".lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run([sys.executable, str(SCRIPTS / "collect.py"), "normalized",
                                     str(self.source), "--store", str(self.store)],
                                    capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("SECRET", result.stdout + result.stderr)
        self.assertEqual(len(self.read()), 1)

    def test_failure_before_replace_is_atomic(self):
        collect.save(self.store, self.item, now=100)
        before = (self.store / "snapshots.json").read_bytes()
        with patch.object(collect.os, "replace", side_effect=OSError("failure")):
            with self.assertRaises(OSError):
                collect.save(self.store, self.item | {"id": "1" * 64}, now=101)
        self.assertEqual(before, (self.store / "snapshots.json").read_bytes())
        self.assertEqual(list(self.store.glob(".pending-*")), [])

    def test_symlink_directory_and_files_rejected(self):
        actual = self.root / "actual"
        actual.mkdir(mode=0o700)
        self.store.symlink_to(actual, target_is_directory=True)
        with self.assertRaises(ValueError):
            collect.save(self.store, self.item, now=100)
        self.store.unlink()
        self.store.mkdir(mode=0o700)
        for name in (".lock", "snapshots.json"):
            link = self.store / name
            if link.exists():
                link.unlink()
            link.symlink_to(self.source)
            with self.assertRaises(OSError):
                collect.save(self.store, self.item, now=100)
            link.unlink()

    def test_unsafe_permissions_and_clock_rollback_rejected(self):
        self.store.mkdir(mode=0o755)
        self.store.chmod(0o755)
        with self.assertRaises(ValueError):
            collect.save(self.store, self.item, now=100)
        self.store.chmod(0o700)
        collect.save(self.store, self.item, now=100)
        with self.assertRaises(ValueError):
            collect.save(self.store, self.item, now=99)

    def test_byte_limit_preserves_previous_store(self):
        collect.save(self.store, self.item, now=100)
        before = (self.store / "snapshots.json").read_bytes()
        with patch.object(collect, "MAX_BYTES", len(before) + 1):
            with self.assertRaises(ValueError):
                collect.save(self.store, self.item | {"id": "2" * 64}, now=101)
        self.assertEqual(before, (self.store / "snapshots.json").read_bytes())

    def test_abrupt_process_exit_before_replace_recovers(self):
        collect.save(self.store, self.item, now=100)
        before = (self.store / "snapshots.json").read_bytes()
        program = (
            "import sys,os; sys.path.insert(0,sys.argv[1]); import collect; "
            "item=collect.snapshot('normalized',sys.argv[2]); "
            "collect.os.replace=lambda *a: os._exit(71); "
            "collect.save(sys.argv[3],item,now=101)"
        )
        result = subprocess.run([sys.executable, "-c", program, str(SCRIPTS),
                                 str(self.source), str(self.store)], timeout=3)
        self.assertEqual(result.returncode, 71)
        self.assertTrue((self.store / collect.PENDING).is_file())
        self.assertEqual(before, (self.store / "snapshots.json").read_bytes())
        result = collect.save(self.store, self.item, now=102)
        self.assertTrue(result["recovered_pending"])
        self.assertTrue(result["duplicate"])
        self.assertFalse((self.store / collect.PENDING).exists())
        self.assertEqual(len(self.read()), 1)

    def test_pending_symlink_and_hardlink_not_removed(self):
        collect.save(self.store, self.item, now=100)
        pending = self.store / collect.PENDING
        pending.symlink_to(self.source)
        with self.assertRaises(OSError):
            collect.save(self.store, self.item, now=101)
        self.assertTrue(pending.is_symlink())
        pending.unlink()
        os.link(self.source, pending)
        with self.assertRaises(ValueError):
            collect.save(self.store, self.item, now=101)
        self.assertTrue(pending.exists())

    def test_directory_fsync_failure_can_be_retried_without_duplicate(self):
        real_fsync = os.fsync
        count = 0
        def fail_second(fd):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("directory fsync failed")
            real_fsync(fd)
        with patch.object(collect.os, "fsync", side_effect=fail_second):
            with self.assertRaises(OSError):
                collect.save(self.store, self.item, now=100)
        self.assertEqual(len(self.read()), 1)
        result = collect.save(self.store, self.item, now=101)
        self.assertTrue(result["duplicate"])
        self.assertEqual(len(self.read()), 1)

    def test_unknown_files_and_corrupt_store_are_not_cleaned(self):
        collect.save(self.store, self.item, now=100)
        legacy = self.store / ".pending-unknown"
        legacy.write_text("user-owned")
        collect.save(self.store, self.item, now=101)
        self.assertEqual(legacy.read_text(), "user-owned")
        pending = self.store / collect.PENDING
        pending.write_text("partial")
        pending.chmod(0o600)
        (self.store / "snapshots.json").write_text("corrupt")
        with self.assertRaises(ValueError):
            collect.save(self.store, self.item, now=102)
        self.assertEqual(pending.read_text(), "partial")

    def test_invalid_stored_reports_rejected_before_expiration(self):
        collect.save(self.store, self.item, now=100)
        target = self.store / "snapshots.json"
        valid = json.loads(target.read_text())
        reports = [{}, {"prompt": "SECRET_LOG_BODY"}]
        for changes in ({"quality": "SECRET"}, {"observed_calls": True},
                        {"measurement_complete": True}, {"usage": None},
                        {"usage": self.item["report"]["usage"] | {"uncached_input_tokens": 99}},
                        {"usage": self.item["report"]["usage"] | {"prompt": "SECRET"}}):
            reports.append(self.item["report"] | changes)
        for report in reports:
            with self.subTest(report=report):
                state = copy.deepcopy(valid)
                state["records"][0]["report"] = report
                target.write_text(json.dumps(state))
                before = target.read_bytes()
                with self.assertRaises(ValueError):
                    collect.save(self.store, self.item | {"id": "0" * 64},
                                 now=100 + 86401, retention_days=1)
                self.assertEqual(before, target.read_bytes())

    def test_new_invalid_snapshot_creates_no_store(self):
        for changes in ({"report": {}}, {"prompt": "SECRET"}, {"id": "z" * 64}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                collect.save(self.store, self.item | changes, now=100)
            self.assertFalse(self.store.exists())

    def test_workflow_report_contract(self):
        report = self.item["report"] | dict(execution_status="failed", started_calls=2,
            calls_without_usage=1, calls_without_outcome=1, measurement_complete=False,
            evidence_digest="a" * 64, duration_ms=None)
        item = dict(adapter="workflow", report=report,
                    id=hashlib.sha256(("workflow:" + "a" * 64).encode()).hexdigest())
        collect.save(self.store, item, now=100)
        self.assertTrue(collect.save(self.store, item, now=101)["duplicate"])
        for changes in ({"started_calls": 0}, {"calls_without_outcome": 3},
                        {"execution_status": "completed"}, {"measurement_complete": 0},
                        {"duration_ms": float("nan")}, {"duplicates_ignored": 1},
                        {"evidence_digest": "b" * 64}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                collect.save(self.store, item | {"report": report | changes}, now=102)

    def test_cleanup_failure_releases_lock(self):
        collect.save(self.store, self.item, now=100)
        with patch.object(collect.os, "replace", side_effect=OSError("replace failed")), \
             patch.object(collect.os, "unlink", side_effect=OSError("cleanup failed")):
            with self.assertRaises(OSError):
                collect.save(self.store, self.item, now=101)
        self.assertTrue(collect.save(self.store, self.item, now=102)["recovered_pending"])


if __name__ == "__main__":
    unittest.main()
