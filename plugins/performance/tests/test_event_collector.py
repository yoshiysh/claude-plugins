import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HOOK_DIR = Path(__file__).resolve().parents[1] / "hooks" / "event-collector"
spec = importlib.util.spec_from_file_location("event_collector", HOOK_DIR / "run.py")
event_collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(event_collector)


class NativeHookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.project = self.root / "project"
        self.logs = self.root / "logs"
        self.project.mkdir()
        self.logs.mkdir()
        self.source = self.logs / "session.jsonl"
        self.source.write_text("{}\n")
        self.event = dict(cwd=str(self.project), transcript_path=str(self.source),
                          session_id="session", hook_event_name="Stop")
        self.policy = dict(host="claude", project=str(self.project), transcripts=str(self.logs), enabled=True)

    def test_scope(self):
        self.assertEqual(event_collector.select_source("claude", self.event, [self.policy]), self.source)
        self.assertIsNone(event_collector.select_source("codex", self.event, [self.policy]))
        self.assertIsNone(event_collector.select_source("claude", self.event, [{**self.policy, "enabled": False}]))
        self.event["cwd"] = str(self.root)
        self.assertIsNone(event_collector.select_source("claude", self.event, [self.policy]))

    def test_no_parent_or_child_log_substitution(self):
        self.event["hook_event_name"] = "SubagentStop"
        self.assertIsNone(event_collector.select_source("claude", self.event, [self.policy]))
        self.event["hook_event_name"] = "Stop"
        self.event["transcript_path"] = str(self.project)
        self.assertIsNone(event_collector.select_source("claude", self.event, [self.policy]))

    def test_symlink(self):
        link = self.logs / "alias.jsonl"
        link.symlink_to(self.source)
        self.event["transcript_path"] = str(link)
        with self.assertRaises(ValueError):
            event_collector.select_source("claude", self.event, [self.policy])

    def test_all_projects_policy(self):
        # "*" policy はどの cwd でも許可するが、transcript の許可 root 境界は維持される
        wildcard = dict(host="claude", project="*", transcripts=str(self.logs), enabled=True)
        other = self.root / "other"
        other.mkdir()
        event = {**self.event, "cwd": str(other)}
        self.assertEqual(event_collector.select_source("claude", event, [wildcard]), self.source)
        self.assertIsNone(event_collector.select_source("codex", event, [wildcard]))
        outside = self.root / "outside.jsonl"
        outside.write_text("{}\n")
        self.assertIsNone(
            event_collector.select_source("claude", {**event, "transcript_path": str(outside)}, [wildcard]))

    def test_exact_disabled_beats_wildcard_enabled(self):
        # 全体適用の下でも、cwd 一致の個別 disable（opt-out）が優先される
        wildcard = dict(host="claude", project="*", transcripts=str(self.logs), enabled=True)
        optout = {**self.policy, "enabled": False}
        self.assertIsNone(event_collector.select_source("claude", self.event, [wildcard, optout]))
        self.assertIsNone(event_collector.select_source("claude", self.event, [optout, wildcard]))
        # 個別 enable + "*" disable では個別が勝って収集される
        self.assertEqual(
            event_collector.select_source(
                "claude", self.event, [{**wildcard, "enabled": False}, self.policy]),
            self.source)

    def test_configure_all_projects(self):
        data = self.root / "data"
        result = event_collector.configure("claude", "*", self.logs, True, data)
        self.assertEqual(result["project"], "*")
        state = json.loads((data / "policy" / "state.json").read_text())
        self.assertEqual(state["policies"][0]["project"], "*")
        event_collector.configure("claude", "*", self.logs, False, data)
        state = json.loads((data / "policy" / "state.json").read_text())
        self.assertEqual([p["enabled"] for p in state["policies"]], [False])

    def test_configure_disable(self):
        data = self.root / "data"
        event_collector.configure("claude", self.project, self.logs, True, data)
        event_collector.configure("claude", self.project, self.logs, False, data)
        value = json.loads((data / "policy/state.json").read_text())
        self.assertEqual(len(value["policies"]), 1)
        self.assertFalse(value["policies"][0]["enabled"])

    def test_unconfigured_hook_silent(self):
        env = dict(os.environ, PERFORMANCE_DATA_DIR=str(self.root / "missing"))
        result = subprocess.run([sys.executable, event_collector.__file__], env=env,
                                input="not json", capture_output=True, text=True, timeout=2)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        self.assertFalse((self.root / "missing").exists())


if __name__ == "__main__":
    unittest.main()
