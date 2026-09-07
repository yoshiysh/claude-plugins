"""skill_telemetry.py の抽出・記録・集計の契約テスト。

押さえるのは 3 つ。
1. task output（result で包まれた形）と素の result のどちらからも同じ指標が抜ける
2. 無いフィールドは None のまま残る（欠測を 0 に丸めない）
3. 記録ゼロの summary は exit 2（「未計測」を「良好」と区別する）
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "skill_telemetry.py"

RESULT = {
    "verdict": "tbd_remaining",
    "dry_stop": True,
    "novelty_history": [7, 5, 0],
    "revisions_used": 3,
    "writer_missing": [],
    "audit_incomplete": False,
    "unpresented_blocking": [{"source_finding_id": "VA-001"}],
    "summary": {
        "fabrication_findings": 1,
        "unpresented_blocking_count": 1,
        "adjudicated": {"fixed": 0, "rejected": 3, "documented": 5, "unadjudicated": 0},
    },
}


def run(args, env_dir):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env={"SKILL_TELEMETRY_DIR": env_dir, "PATH": "/usr/bin:/bin"},
    )


class TestSkillTelemetry(unittest.TestCase):
    def test_taskoutput形とresult素形で同じ記録になる(self):
        with tempfile.TemporaryDirectory() as td:
            raw = Path(td) / "raw.json"
            wrapped = Path(td) / "wrapped.json"
            raw.write_text(json.dumps(RESULT))
            wrapped.write_text(json.dumps({"result": RESULT, "logs": ["x"]}))
            self.assertEqual(run(["record", "--skill", "s", "--label", "a", str(raw)], td).returncode, 0)
            self.assertEqual(run(["record", "--skill", "s", "--label", "b", str(wrapped)], td).returncode, 0)
            a = json.loads((Path(td) / "s" / "a.json").read_text())
            b = json.loads((Path(td) / "s" / "b.json").read_text())
            for k in ("verdict", "dry_stop", "novelty_history", "fabrication_findings", "needs_input_sources"):
                self.assertEqual(a[k], b[k])
            self.assertEqual(a["needs_input_sources"], ["VA"])

    def test_欠測フィールドはNoneのまま残る(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "min.json"
            p.write_text(json.dumps({"verdict": "clean"}))
            run(["record", "--skill", "s", "--label", "m", str(p)], td)
            rec = json.loads((Path(td) / "s" / "m.json").read_text())
            self.assertIsNone(rec["novelty_history"])
            self.assertIsNone(rec["fabrication_findings"])
            self.assertEqual(rec["writer_missing"], 0)

    def test_上書きはforceが要る(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "r.json"
            p.write_text(json.dumps(RESULT))
            run(["record", "--skill", "s", "--label", "x", str(p)], td)
            self.assertNotEqual(run(["record", "--skill", "s", "--label", "x", str(p)], td).returncode, 0)
            self.assertEqual(
                run(["record", "--skill", "s", "--label", "x", "--force", str(p)], td).returncode, 0
            )

    def test_記録ゼロのsummaryはexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(run(["summary", "--skill", "empty"], td).returncode, 2)

    def test_summaryはdry_stop到達率を出す(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "r.json"
            p.write_text(json.dumps(RESULT))
            run(["record", "--skill", "s", "--label", "x", str(p)], td)
            out = run(["summary", "--skill", "s"], td)
            self.assertEqual(out.returncode, 0)
            self.assertIn("dry_stop 到達 1/1", out.stdout)


if __name__ == "__main__":
    unittest.main()
