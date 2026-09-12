"""skill_telemetry.py の抽出・記録・集計の契約テスト。

押さえるのは 3 つ。
1. task output（result で包まれた形）と素の result のどちらからも同じ指標が抜ける
2. 無いフィールドは None のまま残る（欠測を 0 に丸めない）
3. 記録ゼロの summary は exit 2（「未計測」を「良好」と区別する）
"""

import json
import pathlib
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


class TestCompare(unittest.TestCase):
    """compare が対照 run の判定を機械側に持つことの契約。

    押さえるのは 4 つ。
    1. 片方の記録が無い対照は判定を返さず exit 2（対発行の記録の有無を検査する）
    2. input_ref が一致しない（または未記録）対照も exit 2（同一入力性を検査する）
    3. 指標が数値で取れない場合も exit 2（欠測を 0 に丸めて「差が無い」にしない）
    4. 揃っていれば delta と favored を向きと閾値から機械的に決める
    """

    def _record(self, td, label, result, input_ref="args-v1"):
        p = Path(td) / f"{label}.src.json"
        p.write_text(json.dumps(result))
        return run(
            ["record", "--skill", "s", "--label", label, "--input-ref", input_ref, str(p)], td
        )

    def test_片方の記録が無い対照はexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self._record(td, "ctrl", {"summary": {"fabrication_findings": 3}})
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "fabrication_findings", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 2)

    def test_input_refが一致しない対照はexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self._record(td, "ctrl", {"summary": {"fabrication_findings": 3}}, input_ref="args-v1")
            self._record(td, "trt", {"summary": {"fabrication_findings": 1}}, input_ref="args-v2")
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "fabrication_findings", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 2)

    def test_指標が数値で取れなければexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self._record(td, "ctrl", {"summary": {"fabrication_findings": 3}})
            self._record(td, "trt", {"verdict": "clean"})
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "fabrication_findings", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 2)

    def test_揃っていれば向きと閾値からfavoredを決める(self):
        with tempfile.TemporaryDirectory() as td:
            self._record(td, "ctrl", {"summary": {"fabrication_findings": 3}})
            self._record(td, "trt", {"summary": {"fabrication_findings": 1}})
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "fabrication_findings", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 0, out.stderr)
            payload = json.loads(out.stdout)
            self.assertEqual(payload["delta"], -2.0)
            self.assertEqual(payload["favored"], "treatment")
            # 同じ差でも向きが逆なら control 優位になる（向きを機械側が持つ）
            flipped = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "fabrication_findings", "--higher-is-better", "--threshold", "0"], td
            )
            self.assertEqual(json.loads(flipped.stdout)["favored"], "control")
            # 閾値を超えない差は tie（事前固定の閾値で判定する）
            tied = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "fabrication_findings", "--lower-is-better", "--threshold", "5"], td
            )
            self.assertEqual(json.loads(tied.stdout)["favored"], "tie")

    def test_frozen_manifestから基準を読む(self):
        with tempfile.TemporaryDirectory() as td:
            self._record(td, "ctrl", {"summary": {"fabrication_findings": 3}})
            self._record(td, "trt", {"summary": {"fabrication_findings": 1}})
            manifest = pathlib.Path(td) / "MANIFEST.json"
            manifest.write_text(json.dumps({
                "criteria": {"metric": "fabrication_findings",
                             "higher_is_better": False, "threshold": 0}}))
            out = run(["compare", "--skill", "s", "--control", "ctrl",
                       "--treatment", "trt",
                       "--frozen-manifest", str(manifest)], td)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(json.loads(out.stdout)["favored"], "treatment")

    def test_frozen_manifestと手入力の併用は拒否(self):
        with tempfile.TemporaryDirectory() as td:
            manifest = pathlib.Path(td) / "MANIFEST.json"
            manifest.write_text(json.dumps({
                "criteria": {"metric": "m", "higher_is_better": True,
                             "threshold": 0}}))
            out = run(["compare", "--skill", "s", "--control", "c",
                       "--treatment", "t", "--frozen-manifest", str(manifest),
                       "--metric", "other"], td)
            self.assertEqual(out.returncode, 2)


if __name__ == "__main__":
    unittest.main()
