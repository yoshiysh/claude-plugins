import copy
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
import stream_collect as sc
import private_state
import event_adapters as adapters
import hook_collect


def usage(call="1", **changes):
    return dict(source="SECRET", run_id="SECRET", call_id=call,
                input_tokens=100, cached_input_tokens=40, output_tokens=20) | changes


class IncrementalTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / "SECRET.jsonl"
        self.store = self.root / "store"

    def write(self, rows):
        self.source.write_text("".join(json.dumps(row) + "\n" for row in rows))

    def run_collect(self, **kwargs):
        return sc.run(self.store, self.source, kwargs.pop("adapter", "normalized"), "capture-1",
                      now=kwargs.pop("now", 100), **kwargs)

    def state(self):
        raw = (self.store / "state.json").read_text()
        self.assertNotIn("SECRET", raw)
        self.assertNotIn(str(self.root), raw)
        return json.loads(raw)

    def test_incremental_partial_line_and_replay(self):
        self.write([usage()])
        self.assertEqual(self.run_collect()["status"], "collected")
        original = self.source.read_text()
        extra = json.dumps(usage("2"))
        self.source.write_text(original + extra[:30])
        self.assertTrue(self.run_collect()["pending_bytes"])
        self.assertEqual(len(self.state()["rows"]), 1)
        self.source.write_text(original + extra + "\n")
        self.assertEqual(self.run_collect()["retained_observations"], 2)
        self.assertEqual(self.run_collect()["retained_observations"], 2)

    def test_rotation_dedup_and_conflict(self):
        self.write([usage()])
        self.run_collect()
        self.source.rename(self.root / "old")
        self.write([usage(), usage("2")])
        result = self.run_collect()
        self.assertEqual(result["metrics"]["rotations"], 1)
        self.assertEqual(result["metrics"]["duplicates"], 1)
        self.assertEqual(result["retained_observations"], 2)
        self.write([usage(output_tokens=999)])
        result = self.run_collect()
        self.assertEqual(result["status"], "collection_failed")
        self.assertTrue(result["failure_recorded"])
        self.assertEqual(result["metrics"]["failures"], 1)
        self.assertEqual(len(self.state()["rows"]), 2)

    def test_malformed_batch_rolls_back_all_rows_and_cursor(self):
        self.write([usage()])
        self.run_collect()
        before = self.state()
        self.source.write_text(self.source.read_text() + json.dumps(usage("2")) + "\nSECRET\n")
        result = self.run_collect()
        self.assertEqual(result["status"], "collection_failed")
        after = self.state()
        self.assertEqual(before["rows"], after["rows"])
        self.assertEqual(before["streams"], after["streams"])

    def test_retention_maintenance_and_capacity_fail_closed(self):
        self.write([usage(), usage("2")])
        with patch.object(sc, "MAX_ROWS", 1):
            self.assertEqual(self.run_collect()["status"], "collection_failed")
        self.assertEqual(self.state()["rows"], [])
        self.run_collect()
        sc.run(self.store, retention_days=1, now=86501)
        self.assertEqual(self.state()["rows"], [])
        self.assertEqual(self.state()["streams"], {})

    def test_oversized_line_and_bounded_backlog(self):
        self.source.write_text("x" * sc.CHUNK)
        self.assertEqual(self.run_collect()["status"], "collection_failed")
        self.write([usage(), usage("2"), usage("3")])
        with patch.object(sc, "CHUNK", len(json.dumps(usage())) + 2):
            self.assertTrue(self.run_collect()["pending_bytes"])
            self.assertTrue(self.run_collect()["pending_bytes"])
            self.assertFalse(self.run_collect()["pending_bytes"])
        self.assertEqual(len(self.state()["rows"]), 3)

    def test_unknown_files_and_symlinks_are_not_deleted(self):
        self.write([usage()])
        self.run_collect()
        unknown = self.store / "user-owned"
        unknown.write_text("SECRET")
        with self.assertRaises(ValueError):
            self.run_collect()
        self.assertEqual(unknown.read_text(), "SECRET")
        unknown.unlink()
        (self.store / ".pending").symlink_to(self.source)
        with self.assertRaises(OSError):
            self.run_collect()
        self.assertTrue((self.store / ".pending").is_symlink())

    def test_input_inside_store_is_never_reclaimed_as_pending(self):
        self.store.mkdir(mode=0o700)
        source = self.store / ".pending"
        source.write_text(json.dumps(usage()) + "\n")
        source.chmod(0o600)
        before = source.read_bytes()
        with self.assertRaises(ValueError):
            sc.run(self.store, source, "normalized", "capture-1", now=100)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual([p.name for p in self.store.iterdir()], [".pending"])

    def test_corrupt_ledger_is_not_rewritten_or_expired(self):
        self.write([usage()])
        self.run_collect()
        target = self.store / "state.json"
        state = self.state()
        state["rows"][0]["prompt"] = "SECRET"
        target.write_text(json.dumps(state))
        before = target.read_bytes()
        with self.assertRaises(ValueError):
            self.run_collect(now=9999999, retention_days=1)
        self.assertEqual(before, target.read_bytes())

    def test_replace_failure_and_crash_recovery(self):
        self.write([usage()])
        self.run_collect()
        before = (self.store / "state.json").read_bytes()
        with patch.object(private_state.os, "replace", side_effect=OSError("failed")):
            with self.assertRaises(OSError):
                self.run_collect()
        self.assertEqual(before, (self.store / "state.json").read_bytes())
        program = ("import sys,os;sys.path.insert(0,sys.argv[1]);import stream_collect,private_state;"
                   "private_state.os.replace=lambda *a:os._exit(71);"
                   "stream_collect.run(sys.argv[2],sys.argv[3],'normalized','capture-1',now=100)")
        result = subprocess.run([sys.executable, "-c", program, str(SCRIPTS), str(self.store), str(self.source)], timeout=5)
        self.assertEqual(result.returncode, 71)
        self.assertTrue((self.store / ".pending").exists())
        self.assertEqual(self.run_collect()["retained_observations"], 1)
        self.assertFalse((self.store / ".pending").exists())

    def test_codex_events_usage_and_unknown_failure(self):
        rows = [dict(type="thread.started", thread_id="SECRET"), dict(type="turn.started"),
                dict(type="item.completed", item={"text": "SECRET"}),
                dict(type="turn.completed", usage=dict(input_tokens=100, cached_input_tokens=40, output_tokens=20)),
                dict(type="turn.started"), dict(type="turn.failed", error={"message": "SECRET"})]
        self.write(rows)
        self.assertEqual(self.run_collect(adapter="codex-exec")["retained_observations"], 2)
        observations = self.state()["rows"]
        self.assertEqual(observations[0]["usage"]["input_tokens"], 100)
        self.assertIsNone(observations[1]["usage"])
        self.assertEqual(observations[1]["status"], "failed")

    def test_codex_orphan_and_unknown_format_rejected(self):
        for rows in ([dict(type="turn.completed", usage={})], [dict(type="event_msg", payload={})]):
            self.write(rows)
            self.assertEqual(self.run_collect(adapter="codex-exec")["status"], "collection_failed")

    def test_report_is_readonly_and_keeps_sources_separate(self):
        self.write([usage(), usage(source="OTHER", output_tokens=10)])
        self.run_collect()
        before = (self.store / "state.json").read_bytes()
        result = sc.report(self.store)
        self.assertEqual(len(result["groups"]), 2)
        self.assertIsNone(result["measurement_complete"])
        self.assertEqual(result["quality"], "unmeasured")
        self.assertEqual(before, (self.store / "state.json").read_bytes())
        with self.assertRaises(FileNotFoundError):
            sc.report(self.root / "absent")
        self.assertFalse((self.root / "absent").exists())

    def test_busy_writer_and_fifo_do_not_block(self):
        self.write([usage()])
        self.run_collect()
        with (self.store / ".lock").open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run([sys.executable, str(SCRIPTS / "stream_collect.py"), "collect",
                "normalized", str(self.source), "--stream-id", "capture-1", "--store", str(self.store)],
                capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stdout)["failure_recorded"])
        self.source.unlink()
        os.mkfifo(self.source)
        self.assertEqual(self.run_collect()["status"], "collection_failed")

    def test_stored_numeric_corruption_is_rejected(self):
        self.write([usage()])
        self.run_collect()
        target = self.store / "state.json"
        original = self.state()
        for value in (True, -1, 1.5, float("nan")):
            state = copy.deepcopy(original)
            state["rows"][0]["usage"]["input_tokens"] = value
            target.write_text(json.dumps(state))
            before = target.read_bytes()
            with self.assertRaises(ValueError):
                self.run_collect()
            self.assertEqual(before, target.read_bytes())

    def test_claude_result_ignores_step_placeholders(self):
        self.write([dict(type="assistant", message=dict(content="SECRET", usage=dict(output_tokens=999))),
                    dict(type="result", subtype="success", is_error=False, result="SECRET", usage=dict(
                        input_tokens=10, cache_creation_input_tokens=20, cache_read_input_tokens=70, output_tokens=30))])
        self.assertEqual(self.run_collect(adapter="claude-query")["retained_observations"], 1)
        self.assertEqual(self.state()["rows"][0]["usage"],
                         dict(input_tokens=100, cached_input_tokens=70, output_tokens=30))

    def test_claude_streaming_multiple_results_rejected(self):
        row = dict(type="result", subtype="success", is_error=False, usage={})
        self.write([row, row])
        self.assertEqual(self.run_collect(adapter="claude-query")["status"], "collection_failed")
        self.assertEqual(self.state()["rows"], [])

    def test_claude_crash_zero_not_counted_as_zero_usage(self):
        self.write([dict(type="result", subtype="error_during_execution", is_error=True, usage=dict(
            input_tokens=0, cache_creation_input_tokens=0, cache_read_input_tokens=0, output_tokens=0))])
        self.run_collect(adapter="claude-query")
        self.assertIsNone(self.state()["rows"][0]["usage"])

    def test_hook_is_silent_and_uses_only_configured_paths(self):
        self.write([usage()])
        config = dict(enabled=True, host="codex", cwd=str(self.root), adapter="normalized",
                      input=str(self.source), stream_id="capture-1", store=str(self.store), retention_days=30)
        event = dict(hook_event_name="Stop", cwd=str(self.root), transcript_path="/SECRET/not-allowed")
        args = hook_collect.command(config, event)
        self.assertNotIn(event["transcript_path"], args)
        self.assertIsNone(hook_collect.command(config, event | {"stop_hook_active": True}))
        self.assertIsNone(hook_collect.command(config, event | {"cwd": "/other"}))
        path = self.root / "config.json"
        path.write_text(json.dumps(config))
        command = [sys.executable, str(SCRIPTS / "hook_collect.py"), "--config", str(path)]
        result = subprocess.run(command, input=json.dumps(event), capture_output=True, text=True, timeout=5)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        self.assertEqual(len(self.state()["rows"]), 1)
        path.write_text(json.dumps(config | {"enabled": False}))
        before = (self.store / "state.json").read_bytes()
        result = subprocess.run(command, input="SECRET invalid", capture_output=True, text=True, timeout=5)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        self.assertEqual(before, (self.store / "state.json").read_bytes())

    def test_hook_timeout_and_failure_are_silent(self):
        config = dict(enabled=True, host="codex", cwd=str(self.root), adapter="normalized",
                      input=str(self.source), stream_id="capture-1", store=str(self.store), retention_days=30)
        path = self.root / "config.json"
        path.write_text(json.dumps(config))
        event = dict(hook_event_name="Stop", cwd=str(self.root))
        with patch.object(sys, "argv", ["hook_collect.py", "--config", str(path)]), \
             patch.object(hook_collect, "payload", return_value=event), \
             patch.object(hook_collect.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 3)):
            self.assertEqual(hook_collect.main(), 0)
        result = subprocess.run([sys.executable, str(SCRIPTS / "hook_collect.py"), "--SECRET"],
                                capture_output=True, text=True, timeout=3)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))


if __name__ == "__main__":
    unittest.main()
