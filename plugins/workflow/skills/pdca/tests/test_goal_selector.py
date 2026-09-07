"""goal_selector.py の契約テスト（適合監査 C1/C4/C6 の機械化可能な部分を回帰化）。

押さえるのは 3 つ。
1. 決定性: 同一在庫で 2 回 select しても出力が変わらない（select はタイムスタンプを書かない）
2. 欠測の扱い: field が None / 不在の run は present に数えない（欠測を非 hit に丸めない）
3. 裁定の保全: decide 済み候補は再 select で上書きされない（拒否履歴を消さない）
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "goal_selector.py"

BACKSTOP_RUN = {"verdict": "revision_backstop_reached", "novelty_history": [5, 3],
                "revisions_used": 4, "fabrication_findings": 0,
                "unpresented_blocking_count": 2, "audit_incomplete": False, "writer_missing": 0}
MISSING_RUN = {"fabrication_findings": 1}  # verdict ほか欠測


def run(args, base):
    env = {"SKILL_TELEMETRY_DIR": f"{base}/telemetry", "SKILL_KAIZEN_DIR": f"{base}/kaizen",
           "PATH": "/usr/bin:/bin"}
    return subprocess.run([sys.executable, str(SCRIPT), *args],
                          capture_output=True, text=True, env=env)


def seed(base, runs):
    d = Path(base) / "telemetry" / "s"
    d.mkdir(parents=True, exist_ok=True)
    for name, data in runs.items():
        (d / f"{name}.json").write_text(json.dumps(data))


class TestGoalSelector(unittest.TestCase):
    def test_同一在庫で2回selectしても出力が変わらない(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN, "b": MISSING_RUN})
            run(["select", "--skill", "s"], td)
            goals = Path(td) / "kaizen" / "goals"
            first = {p.name: p.read_bytes() for p in goals.glob("*.json")}
            run(["select", "--skill", "s"], td)
            second = {p.name: p.read_bytes() for p in goals.glob("*.json")}
            self.assertEqual(first, second)

    def test_欠測runはpresentに数えない(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN, "b": MISSING_RUN})
            run(["select", "--skill", "s"], td)
            r1 = json.loads((Path(td) / "kaizen" / "goals" / "s-R1.json").read_text())
            # b は verdict 欠測なので R1 の present は a のみ
            self.assertEqual(r1["trace"]["present_runs"], ["a"])
            self.assertEqual(r1["trace"]["runs"], ["a"])
            r3 = json.loads((Path(td) / "kaizen" / "goals" / "s-R3.json").read_text())
            # fabrication は両 run に存在し、hit は b のみ
            self.assertEqual(r3["trace"]["present_runs"], ["a", "b"])
            self.assertEqual(r3["trace"]["runs"], ["b"])

    def test_裁定済み候補は再selectで上書きされない(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN})
            run(["select", "--skill", "s"], td)
            out = run(["decide", "--goal", "s-R1", "--status", "rejected", "--reason", "仕様として受容"], td)
            self.assertEqual(out.returncode, 0)
            before = (Path(td) / "kaizen" / "goals" / "s-R1.json").read_bytes()
            run(["select", "--skill", "s"], td)
            after = (Path(td) / "kaizen" / "goals" / "s-R1.json").read_bytes()
            self.assertEqual(before, after)
            rec = json.loads(after)
            self.assertEqual(rec["status"], "rejected")
            self.assertIn("decided_at", rec)


if __name__ == "__main__":
    unittest.main()
