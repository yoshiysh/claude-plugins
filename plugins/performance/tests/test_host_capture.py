import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import host_capture
import native_hook
import skill_events


def policy(project, enabled=True):
    # configure() は project を resolve して保存するので、テストも同じ形で渡す
    return {"host": "claude", "project": str(Path(project).resolve()),
            "transcripts": "/tmp", "enabled": enabled}


def dispatch_event(cwd, event="PreToolUse", skill="demo"):
    row = {"hook_event_name": event, "tool_name": "Skill",
           "cwd": cwd, "session_id": "s-1", "tool_use_id": "toolu_1",
           "tool_input": {"skill": skill}}
    if event == "PostToolUse":
        row["tool_response"] = {"success": True, "commandName": skill}
        row["duration_ms"] = 42
    return row


class DispatchPolicy(unittest.TestCase):
    def test_gated_by_same_policy_as_sessions(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(native_hook.dispatch_policy(
                "claude", dispatch_event(d), [policy(d)]))
            self.assertFalse(native_hook.dispatch_policy(
                "claude", dispatch_event(d), [policy(d, enabled=False)]))
            self.assertFalse(native_hook.dispatch_policy(
                "claude", dispatch_event(d), []))

    def test_only_skill_tool_captured(self):
        with tempfile.TemporaryDirectory() as d:
            row = dispatch_event(d)
            row["tool_name"] = "Bash"
            self.assertFalse(native_hook.dispatch_policy("claude", row, [policy(d)]))

    def test_record_and_reload(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "data"
            native_hook.record_dispatch(dispatch_event(d), root, 1000)
            native_hook.record_dispatch(dispatch_event(d, "PostToolUse"), root, 1042)
            loaded = host_capture.load_records(root / "dispatch" / "records.jsonl")
            self.assertEqual(len(loaded["records"]), 2)
            self.assertEqual(loaded["records"][1]["duration_ms"], 42)

    def test_record_limit_leaves_censoring_marker(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "data"
            path = root / "dispatch" / "records.jsonl"
            native_hook.prepare(root / "dispatch")
            filler = json.dumps({"captured_at": 1, "event": "PreToolUse",
                                 "session_id": "s", "tool_use_id": "t",
                                 "cwd": d, "skill": "x"})
            path.write_text((filler + "\n") * native_hook.MAX_DISPATCH_RECORDS)
            native_hook.record_dispatch(dispatch_event(d), root, 2000)
            loaded = host_capture.load_records(path)
            self.assertEqual(loaded["censored"], ["dispatch_record_limit"])
            self.assertEqual(len(loaded["records"]),
                             native_hook.MAX_DISPATCH_RECORDS)


class Conversion(unittest.TestCase):
    def test_dispatch_projects_as_host_boundary_still_open(self):
        records = [{"captured_at": 1000, "event": "PreToolUse",
                    "session_id": "s", "tool_use_id": "toolu_1",
                    "cwd": "/proj", "skill": "demo"},
                   {"captured_at": 1042, "event": "PostToolUse",
                    "session_id": "s", "tool_use_id": "toolu_1",
                    "cwd": "/proj", "skill": "demo", "success": True,
                    "duration_ms": 42}]
        fp = {"demo": {"digest": "a" * 64, "computed_at": 1, "drift": None}}
        converted = host_capture.to_events(records, fp)
        self.assertEqual(len(converted["events"]), 1)
        run = skill_events.project_events(converted["events"])["run"]
        inv = run["invocations"][0]
        self.assertEqual(inv["boundary_evidence"], "host_dispatch")
        self.assertEqual(inv["status"], "running")
        self.assertIsNone(inv["ended_at"])

    def test_unresolved_skill_not_dropped_silently(self):
        records = [{"captured_at": 1, "event": "PreToolUse", "session_id": "s",
                    "tool_use_id": "t", "cwd": "/p", "skill": "unknown-skill"}]
        converted = host_capture.to_events(records, {})
        self.assertEqual(converted["events"], [])
        self.assertEqual(len(converted["unresolved"]), 1)


class Fingerprint(unittest.TestCase):
    def test_deterministic_and_content_sensitive(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "SKILL.md").write_text("a")
            one = host_capture.fingerprint_skill_dir(d, 1)
            two = host_capture.fingerprint_skill_dir(d, 1)
            self.assertEqual(one, two)
            Path(d, "SKILL.md").write_text("b")
            self.assertNotEqual(host_capture.fingerprint_skill_dir(d, 1), one)


class Notification(unittest.TestCase):
    def _queue(self, d):
        import proposals
        store = Path(d) / "data" / "proposals"
        store.parent.mkdir(parents=True, mode=0o700)
        store.mkdir(mode=0o700)
        result = {"status": "candidate", "fingerprint": "f" * 64,
                  "evidence": "e" * 64, "reason": "verify_reduction",
                  "before": {"tokens": 100, "duration_ms": 10},
                  "after": {"tokens": 50, "duration_ms": 5}}
        proposals.update(str(store), result, now=1000)

    def test_presents_once_then_cooldown(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "data"
            self._queue(d)
            first = native_hook.present_notification(root, 10000)
            self.assertIn("pending", first)
            self.assertIsNone(native_hook.present_notification(root, 10001))
            again = native_hook.present_notification(
                root, 10001 + native_hook.PRESENT_COOLDOWN_S)
            self.assertIn("pending", again)

    def test_empty_queue_prints_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(native_hook.present_notification(
                Path(d) / "data", 10000))

    def test_presentation_does_not_mutate_queue(self):
        import proposals
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "data"
            self._queue(d)
            native_hook.present_notification(root, 10000)
            outcome = proposals.update(str(root / "proposals"), now=20000)
            self.assertEqual(outcome["pending_count"], 1)


if __name__ == "__main__":
    unittest.main()
