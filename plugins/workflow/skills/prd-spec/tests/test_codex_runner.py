"""Exercise the distributed prd-spec source through the actual Codex runner VM."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_prd_stages import HARNESS, SKILL, VERIFY_ALL_MARK, args  # noqa: E402
from prd_script import PRD_PATH  # noqa: E402

PLUGIN = PRD_PATH.parent.parent
RUNTIME = PLUGIN / "skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs"


def run(spec):
    src = PRD_PATH.read_text(encoding="utf-8")
    metadata = src[:src.index("\n}\n") + 3].replace("export const meta = ", "const __meta = ", 1)
    spec = {"verify_all_mark": VERIFY_ALL_MARK, "doc_check_url": (SKILL / "scripts/doc_check.mjs").as_uri(), **spec}
    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(spec["args"]["workspace"])
        workspace.mkdir(parents=True, exist_ok=True)
        bridge = f"""
import {{ Workflow }} from {json.dumps(RUNTIME.as_uri())};
const __main = async (args, agent) => Workflow({{name:'workflow:prd-spec-run',args}}, {{
  trustedSource:true, runDir:{json.dumps(str(Path(tmp) / 'run'))},
  trustedPluginRoots:[{json.dumps(str(PLUGIN))}], requirements:['workspace-write'],
  maxAgents:200, concurrency:4, timeoutMs:15000, maxOutputBytes:10000000,
  backend:{{capabilities:['read-only','fresh-thread','workspace-write'], prepare:async()=>({{cwd:args.workspace,mode:'workspace-write'}}),run:agent}}
}});
"""
        path = Path(tmp) / "runner-harness.mjs"
        path.write_text(metadata + bridge + HARNESS, encoding="utf-8")
        proc = subprocess.run(["node", str(path), json.dumps(spec)], capture_output=True, text=True, timeout=30)
        if proc.returncode:
            raise AssertionError(f"runner harness exit {proc.returncode}: {proc.stderr}")
        got = json.loads(proc.stdout)
        events = [json.loads(x) for x in (Path(tmp) / "run/events.jsonl").read_text().splitlines()]
        receipt = json.loads((Path(tmp) / "run/request.json").read_text())
    assert not got["stubErrors"], got["stubErrors"]
    assert not [x for x in events if x["type"] == "agent.invalid_output"], events
    got["receipt"] = receipt
    return got


class CodexRunner(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.workspace = str(Path(self.tmp.name).resolve() / "W")

    def args(self):
        return args(workspace=self.workspace)

    def test_unmodified_source_completes_through_vm_and_schema_validation(self):
        got = run({"args": self.args()})
        self.assertIsNone(got["error"])
        self.assertEqual(got["result"]["status"], "done")
        self.assertIn("writer:U-1:draft", got["labels"])
        self.assertIn("grounding:r1:requirements/x", got["labels"])
        self.assertEqual(got["receipt"]["namedWorkflow"]["name"], "workflow:prd-spec-run")

    def test_all_human_gates_use_next_args_and_do_not_replay_intake(self):
        for gate, spec, stage, ruled in [
            ("g0", {"flow_open": 1, "questions_at": {"3": ["RS-001"]}}, "3a", "RS-001"),
            ("g1", {"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}, "3a'", "RS-010"),
        ]:
            with self.subTest(gate=gate):
                stopped = run({"args": self.args(), **spec})["result"]
                self.assertEqual(stopped["status"], "needs_answers")
                self.assertEqual(stopped["next_args"]["from"], stage)
                self.assertEqual(stopped["next_args"]["workspace"], self.workspace)
                done = run({"args": stopped["next_args"], "ruled_at": {stage: [ruled]}})
                self.assertIsNone(done["error"])
                self.assertEqual(done["result"]["status"], "done")
                self.assertNotIn("intake", done["labels"])
        g0 = run({"args": self.args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        g02 = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        self.assertEqual(g02["status"], "needs_answers")
        self.assertEqual(g02["answers_path"], self.workspace + "/answers/g0-2.md")
        done = run({"args": g02["next_args"], "ruled_at": {"3a": ["RS-002"]}})
        self.assertIsNone(done["error"])
        self.assertEqual(done["result"]["status"], "done")

    def test_failed_agent_and_corrupted_continuation_fail_closed(self):
        got = run({"args": self.args(), "null_labels": ["intake"]})
        self.assertEqual(got["result"]["status"], "blocked")
        stopped = run({"args": self.args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        broken = {**stopped["next_args"], "from": "4"}
        got = run({"args": broken})
        self.assertIn("state_hash", got["error"])
        self.assertEqual(got["labels"], [])


if __name__ == "__main__":
    unittest.main()
