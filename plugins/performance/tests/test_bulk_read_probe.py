import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
HOOK = Path(__file__).resolve().parents[1] / "hooks" / "bulk-read-probe" / "run.py"
sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location("bulk_read_probe", HOOK)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def run_main(event, data_dir):
    old_env = os.environ.get("BULK_READ_DATA_DIR")
    os.environ["BULK_READ_DATA_DIR"] = str(data_dir)
    try:
        payload = json.dumps(event) if not isinstance(event, str) else event
        patched = io.StringIO(payload)
        real_stdin = sys.stdin
        sys.stdin = patched
        try:
            return probe.main(["run.py"])
        finally:
            sys.stdin = real_stdin
    finally:
        if old_env is None:
            os.environ.pop("BULK_READ_DATA_DIR", None)
        else:
            os.environ["BULK_READ_DATA_DIR"] = old_env


def read_logs(data_dir):
    path = Path(data_dir) / "probe.log"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class BulkReadProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "bulk"
        self.proj = Path(self.tmp.name) / "proj"
        self.proj.mkdir()
        self.big = self.proj / "big.py"
        self.big.write_text("x\n" * 12000)          # ~24000 bytes, above default threshold
        self.tiny = self.proj / "tiny.py"
        self.tiny.write_text("short\n")

    def test_detect_host(self):
        self.assertEqual(probe.detect_host({"tool_use_id": "a", "transcript_path": "/x"}), "claude")
        self.assertEqual(probe.detect_host({"turn_id": "t", "model": "haiku"}), "codex")
        self.assertEqual(probe.detect_host({}), "claude")

    def test_read_targets_variants(self):
        self.assertEqual(probe.read_targets({"tool_name": "Read", "tool_input": {"file_path": "/a.py"}}),
                         ("Read", ["/a.py"]))
        self.assertEqual(probe.read_targets({"tool_name": "Read", "tool_input": {"path": "/b.py"}}),
                         ("Read", ["/b.py"]))
        self.assertEqual(probe.read_targets({"tool_name": "Read", "tool_input": "/c.py"}), ("Read", ["/c.py"]))
        self.assertEqual(probe.read_targets({"tool_name": "Bash", "tool_input": {"command": "ls"}}),
                         ("Bash", []))
        self.assertEqual(probe.read_targets({"tool_input": {"file_path": "/a.py"}}), (None, []))

    def test_resolve_path(self):
        resolved = probe.resolve_path("big.py", str(self.proj))
        self.assertEqual(resolved, str(self.big.resolve()))
        self.assertIsNone(probe.resolve_path("", None))
        self.assertIsNone(probe.resolve_path(123, None))

    def test_safe_size_only_owned_regular_file(self):
        self.assertEqual(probe.safe_size(str(self.big)), self.big.stat().st_size)
        self.assertIsNone(probe.safe_size(str(self.proj / "missing.py")))
        link = self.proj / "alias.py"
        link.symlink_to(self.big)
        self.assertIsNone(probe.safe_size(str(link)))

    def test_large_read_logs_hashed_record(self):
        event = {"hook_event_name": "PreToolUse", "tool_name": "Read",
                 "tool_input": {"file_path": str(self.big)}, "tool_use_id": "x", "cwd": str(self.proj)}
        self.assertEqual(run_main(event, self.data), 0)
        logs = read_logs(self.data)
        self.assertEqual(len(logs), 1)
        record = logs[0]
        self.assertEqual(record["host"], "claude")
        self.assertEqual(record["tool"], "Read")
        self.assertEqual(record["bytes"], self.big.stat().st_size)
        self.assertEqual(record["path"], hashlib.sha256(str(self.big.resolve()).encode()).hexdigest())
        self.assertNotIn("content", record)

    def test_main_detects_codex_host(self):
        event = {"hook_event_name": "PreToolUse", "tool_name": "Read",
                 "tool_input": {"file_path": str(self.big)}, "turn_id": "t1",
                 "model": "sonnet-5", "cwd": str(self.proj)}
        self.assertEqual(run_main(event, self.data), 0)
        logs = read_logs(self.data)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["host"], "codex")

    def test_small_and_non_read_do_not_log(self):
        small = {"hook_event_name": "PreToolUse", "tool_name": "Read",
                 "tool_input": {"file_path": str(self.tiny)}, "turn_id": "t1", "cwd": str(self.proj)}
        self.assertEqual(run_main(small, self.data), 0)
        bash = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                "tool_input": {"command": "ls"}, "tool_use_id": "y", "cwd": str(self.proj)}
        self.assertEqual(run_main(bash, self.data), 0)
        self.assertEqual(read_logs(self.data), [])

    def test_threshold_override(self):
        event = {"hook_event_name": "PreToolUse", "tool_name": "Read",
                 "tool_input": {"file_path": str(self.tiny)}, "tool_use_id": "x", "cwd": str(self.proj)}
        os.environ["BULK_READ_THRESHOLD_BYTES"] = "1"
        try:
            self.assertEqual(run_main(event, self.data), 0)
            self.assertEqual(len(read_logs(self.data)), 1)
        finally:
            os.environ.pop("BULK_READ_THRESHOLD_BYTES", None)

    def test_malformed_json_does_not_raise(self):
        self.assertEqual(run_main("not-json{", self.data), 0)
        self.assertEqual(run_main(12345, self.data), 0)

    def test_non_blocking_via_subprocess(self):
        event = {"hook_event_name": "PreToolUse", "tool_name": "Read",
                 "tool_input": {"file_path": str(self.big)}, "tool_use_id": "x", "cwd": str(self.proj)}
        env = dict(os.environ)
        env["BULK_READ_DATA_DIR"] = str(self.data)
        proc = subprocess.run([sys.executable, "-E", "-s", "-B", str(HOOK)],
                              input=json.dumps(event).encode(), capture_output=True, env=env, cwd=str(HOOK.parent))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, b"")


if __name__ == "__main__":
    unittest.main()
