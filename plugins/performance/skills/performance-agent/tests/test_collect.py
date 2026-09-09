import fcntl
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


if __name__ == "__main__":
    unittest.main()
