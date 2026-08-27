"""refine.js の「矛盾解消専用の追加改稿」（blocking 限定・1 回きり）の回帰テスト。

改稿上限に達したときに残る blocking（fail-open/fail-closed の適用範囲の重なりのような
定義同士の矛盾。前提 7）だけを対象に、追加 1 回の改稿を許す設計を固定する。

押さえるのは 3 つ。

1. contradictionPassTargets は severity === 'blocking' の指摘だけを返す
   （degraded を混ぜると追加枠が MAX_REVISIONS の実質的な引き上げに化ける）
2. 追加パスの再監査は validity / executability の 2 観点に限定されている
3. 追加パスはループしない（1 回きりで打ち切り、unresolved として返す）

2 と 3 は挙動を単体で駆動できない（Workflow の main flow に埋まっている）ため、
source の構造で固定する。書き換えでこの制約を外すとここが落ちる。
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REFINE = (SKILL / "scripts" / "refine.js").read_text()

FUNC_START = "function contradictionPassTargets("


def _extract_function(source: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(FUNC_START))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


HARNESS = """
const spec = JSON.parse(process.argv[2])
process.stdout.write(JSON.stringify(contradictionPassTargets(spec.findings)))
"""


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestContradictionPassTargets(unittest.TestCase):
    def _run(self, findings):
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "t.mjs"
            script.write_text(_extract_function(REFINE) + HARNESS)
            out = subprocess.run(
                ["node", str(script), json.dumps({"findings": findings})],
                capture_output=True,
                text=True,
                check=True,
            )
        return json.loads(out.stdout)

    def test_blocking_だけを返す(self):
        findings = [
            {"id": "V-1", "auditor": "validity", "severity": "blocking"},
            {"id": "E-1", "auditor": "executability", "severity": "degraded"},
            {"id": "C-1", "auditor": "clarity"},  # severity 無し
            {"id": "E-2", "auditor": "executability", "severity": "blocking"},
        ]
        got = self._run(findings)
        self.assertEqual([f["id"] for f in got], ["V-1", "E-2"])

    def test_blocking_が無ければ空(self):
        findings = [
            {"id": "C-1", "auditor": "clarity"},
            {"id": "E-1", "auditor": "executability", "severity": "degraded"},
        ]
        self.assertEqual(self._run(findings), [])

    def test_null_や欠損に耐える(self):
        self.assertEqual(self._run([]), [])
        got = self._run([None, {"id": "V-1", "severity": "blocking"}])
        self.assertEqual([f["id"] for f in got], ["V-1"])


class TestContradictionPassStructure(unittest.TestCase):
    def test_再監査は_validity_と_executability_の_2_観点に限定(self):
        self.assertIn(
            "a.name === 'validity' || a.name === 'executability'",
            REFINE,
            "追加パスの再監査が 2 観点限定でなくなっている",
        )

    def test_追加パスは_1_回きり_ループの外にある(self):
        # 追加パスの目印（extra_contradiction_pass）は while ループの閉じ括弧より後に
        # 1 度だけ現れる。ループ内へ移すと「1 回きり」の制約が外れる。
        self.assertEqual(REFINE.count("extra_contradiction_pass: true"), 1)
        loop_end = REFINE.index("// ------------------------------------------- 矛盾解消専用の追加改稿")
        while_start = REFINE.index("while (true) {")
        self.assertGreater(loop_end, while_start)
        self.assertNotIn(
            "extra_contradiction_pass",
            REFINE[while_start:loop_end],
            "追加パスが改稿ループの内側に入っている（1 回きりの制約が外れる）",
        )

    def test_前提_7_が実在する(self):
        premises = (SKILL / "references" / "fixed-premises.md").read_text()
        self.assertIn("| 7 |", premises)
        self.assertIn("fail-closed", premises)
        # 参照側（writer / validity）も前提 7 を指している
        self.assertIn("前提 7", (SKILL / "agents" / "spec-writer.md").read_text())
        self.assertIn("前提 7", (SKILL / "agents" / "validity-auditor.md").read_text())


if __name__ == "__main__":
    unittest.main()
