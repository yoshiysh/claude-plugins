"""goal_selector.py の契約テスト（適合監査 C1/C4/C6 の機械化可能な部分を回帰化）。

押さえるのは 3 つ。
1. 決定性: 同一在庫で 2 回 select しても出力が変わらない（select はタイムスタンプを書かない）
2. 欠測の扱い: field が None / 不在の run は present に数えない（欠測を非 hit に丸めない）
3. 裁定の保全: decide 済み候補は再 select で上書きされない（拒否履歴を消さない）
4. 対象の範囲: PURPOSE_REFS 未登録のスキルはエラーで止まる（既定の目的で trace を埋めない）
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
    d = Path(base) / "telemetry" / "prd-spec"
    d.mkdir(parents=True, exist_ok=True)
    for name, data in runs.items():
        (d / f"{name}.json").write_text(json.dumps(data))


class TestGoalSelector(unittest.TestCase):
    def test_同一在庫で2回selectしても出力が変わらない(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN, "b": MISSING_RUN})
            run(["select", "--skill", "prd-spec"], td)
            goals = Path(td) / "kaizen" / "goals"
            first = {p.name: p.read_bytes() for p in goals.glob("*.json")}
            run(["select", "--skill", "prd-spec"], td)
            second = {p.name: p.read_bytes() for p in goals.glob("*.json")}
            self.assertEqual(first, second)

    def test_欠測runはpresentに数えない(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN, "b": MISSING_RUN})
            run(["select", "--skill", "prd-spec"], td)
            r1 = json.loads((Path(td) / "kaizen" / "goals" / "prd-spec-R1.json").read_text())
            # b は verdict 欠測なので R1 の present は a のみ
            self.assertEqual(r1["trace"]["present_runs"], ["a"])
            self.assertEqual(r1["trace"]["runs"], ["a"])
            r3 = json.loads((Path(td) / "kaizen" / "goals" / "prd-spec-R3.json").read_text())
            # fabrication は両 run に存在し、hit は b のみ
            self.assertEqual(r3["trace"]["present_runs"], ["a", "b"])
            self.assertEqual(r3["trace"]["runs"], ["b"])

    def test_裁定済み候補は再selectで上書きされない(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN})
            run(["select", "--skill", "prd-spec"], td)
            out = run(["decide", "--goal", "prd-spec-R1", "--status", "rejected", "--reason", "仕様として受容"], td)
            self.assertEqual(out.returncode, 0)
            before = (Path(td) / "kaizen" / "goals" / "prd-spec-R1.json").read_bytes()
            run(["select", "--skill", "prd-spec"], td)
            after = (Path(td) / "kaizen" / "goals" / "prd-spec-R1.json").read_bytes()
            self.assertEqual(before, after)
            rec = json.loads(after)
            self.assertEqual(rec["status"], "rejected")
            self.assertIn("decided_at", rec)


class TestAuditFollowups(unittest.TestCase):
    """適合監査の基準外指摘 4 件の回帰化(型崩れの present 非対称 / 再裁定の無警告上書き /
    select 表示が保存済み status を無視 / statement 連結空白は表示検証に含む)。"""

    def test_型が契約外の値はpresentに数えない(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN, "b": {"fabrication_findings": 1},
                      "bad": {"fabrication_findings": "たくさん"}})
            run(["select", "--skill", "prd-spec"], td)
            r3 = json.loads((Path(td) / "kaizen" / "goals" / "prd-spec-R3.json").read_text())
            # "たくさん" は int 契約外 → 未計測扱い(present にも hit にも入れない)
            self.assertEqual(r3["trace"]["present_runs"], ["a", "b"])
            self.assertEqual(r3["trace"]["runs"], ["b"])

    def test_裁定済みへのdecideはforceなしで拒否される(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN})
            run(["select", "--skill", "prd-spec"], td)
            run(["decide", "--goal", "prd-spec-R1", "--status", "rejected", "--reason", "x"], td)
            again = run(["decide", "--goal", "prd-spec-R1", "--status", "approved", "--reason", "y"], td)
            self.assertNotEqual(again.returncode, 0)
            self.assertIn("--force", again.stderr)
            forced = run(["decide", "--goal", "prd-spec-R1", "--status", "approved",
                          "--reason", "y", "--force"], td)
            self.assertEqual(forced.returncode, 0)
            rec = json.loads((Path(td) / "kaizen" / "goals" / "prd-spec-R1.json").read_text())
            self.assertEqual(rec["status"], "approved")

    def test_selectの表示は保存済みstatusを反映する(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN})
            run(["select", "--skill", "prd-spec"], td)
            run(["decide", "--goal", "prd-spec-R1", "--status", "done", "--reason", "x"], td)
            out = run(["select", "--skill", "prd-spec"], td)
            line = next(l for l in out.stdout.splitlines() if l.startswith("prd-spec-R1"))
            self.assertIn("[done]", line)
            self.assertIn("の run で 改稿上限", line)  # statement の連結空白


class TestUnregisteredSkill(unittest.TestCase):
    def test_未登録スキルのselectはエラーで止まる(self):
        with tempfile.TemporaryDirectory() as td:
            seed(td, {"a": BACKSTOP_RUN})
            out = run(["select", "--skill", "unknown-skill"], td)
            self.assertNotEqual(out.returncode, 0)
            self.assertIn("未登録", out.stderr)
            goals = Path(td) / "kaizen" / "goals"
            self.assertFalse(goals.is_dir() and any(goals.iterdir()))


if __name__ == "__main__":
    unittest.main()
