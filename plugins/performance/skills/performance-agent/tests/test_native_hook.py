import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import native_hook


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
        self.assertEqual(native_hook.select_source("claude", self.event, [self.policy]), self.source)
        self.assertIsNone(native_hook.select_source("codex", self.event, [self.policy]))
        self.assertIsNone(native_hook.select_source("claude", self.event, [{**self.policy, "enabled": False}]))
        self.event["cwd"] = str(self.root)
        self.assertIsNone(native_hook.select_source("claude", self.event, [self.policy]))

    def test_no_parent_or_child_log_substitution(self):
        self.event["hook_event_name"] = "SubagentStop"
        self.assertIsNone(native_hook.select_source("claude", self.event, [self.policy]))
        self.event["hook_event_name"] = "Stop"
        self.event["transcript_path"] = str(self.project)
        self.assertIsNone(native_hook.select_source("claude", self.event, [self.policy]))

    def test_symlink(self):
        link = self.logs / "alias.jsonl"
        link.symlink_to(self.source)
        self.event["transcript_path"] = str(link)
        with self.assertRaises(ValueError):
            native_hook.select_source("claude", self.event, [self.policy])

    def test_configure_disable(self):
        data = self.root / "data"
        native_hook.configure("claude", self.project, self.logs, True, data)
        native_hook.configure("claude", self.project, self.logs, False, data)
        value = json.loads((data / "policy/state.json").read_text())
        self.assertEqual(len(value["policies"]), 1)
        self.assertFalse(value["policies"][0]["enabled"])

    def test_unconfigured_hook_silent(self):
        env = dict(os.environ, PERFORMANCE_DATA_DIR=str(self.root / "missing"))
        result = subprocess.run([sys.executable, native_hook.__file__], env=env,
                                input="not json", capture_output=True, text=True, timeout=2)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        self.assertFalse((self.root / "missing").exists())


if __name__ == "__main__":
    unittest.main()
