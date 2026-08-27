"""refine.js の終端裁定（adjudication）と終端網羅監査の回帰テスト。

non-blocking 指摘に終端処理が無いと、修正も棄却も文書への記録もされないまま
unresolved[] に載って終わる（未裁定 limbo）。終了時に残った全指摘を裁定 agent が
三値（fixed / rejected / documented）に分類し、unadjudicated が空であることを
script が検証する設計を固定する。

押さえるのは 3 つ。
1. validateAdjudication の三値分類と unadjudicated 検証
   （理由の無い rejected は無効として未裁定に戻る）
2. 網羅監査は終端 1 回（改稿ループへは戻さない）— log 文とループ外配置で固定
3. unadjudicated が空でなければ verdict に反映される（adjudication_incomplete）
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REFINE = (SKILL / "scripts" / "refine.js").read_text()


def _extract_function(source: str, name: str) -> str:
    lines = source.split("\n")
    start = f"function {name}("
    s = next(i for i, l in enumerate(lines) if l.startswith(start))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


HARNESS = """
const spec = JSON.parse(process.argv[2])
process.stdout.write(JSON.stringify(validateAdjudication(spec.adj, spec.findings)))
"""


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestValidateAdjudication(unittest.TestCase):
    def _run(self, adj, findings):
        src = "\n".join(
            _extract_function(REFINE, n)
            for n in ("stableKey", "findingDigest", "validateAdjudication")
        )
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "t.mjs"
            script.write_text(src + HARNESS)
            out = subprocess.run(
                ["node", str(script), json.dumps({"adj": adj, "findings": findings})],
                capture_output=True,
                text=True,
                check=True,
            )
        return json.loads(out.stdout)

    def test_三値分類で全件が裁定されると_unadjudicated_は空(self):
        findings = [
            {"id": "A", "digest": "d1"},
            {"id": "B", "digest": "d2"},
            {"id": "C", "digest": "d3"},
        ]
        adj = {
            "fixed": [{"digest": "d1", "evidence": "本文 §2 で既に解消済み"}],
            "rejected": [{"digest": "d2", "reason": "偽指摘。repro の入力で判定は割れない"}],
            "documented": [{"digest": "d3", "target_document": "requirements/auth", "text": "意図した制約"}],
        }
        got = self._run(adj, findings)
        self.assertEqual([e["digest"] for e in got["fixed"]], ["d1"])
        self.assertEqual([e["digest"] for e in got["rejected"]], ["d2"])
        self.assertEqual([e["digest"] for e in got["documented"]], ["d3"])
        self.assertEqual(got["unadjudicated"], [])

    def test_理由の無い_rejected_は無効として未裁定に戻る(self):
        findings = [{"id": "A", "digest": "d1"}]
        adj = {"fixed": [], "rejected": [{"digest": "d1"}], "documented": []}
        got = self._run(adj, findings)
        self.assertEqual(got["rejected"], [])
        self.assertEqual([f["id"] for f in got["unadjudicated"]], ["A"])

    def test_どの分類にも入らない指摘は_unadjudicated(self):
        findings = [{"id": "A", "digest": "d1"}, {"id": "B", "digest": "d2"}]
        adj = {"fixed": [{"digest": "d1", "evidence": "解消済み"}], "rejected": [], "documented": []}
        got = self._run(adj, findings)
        self.assertEqual([f["id"] for f in got["unadjudicated"]], ["B"])

    def test_digest_の無い_findings_は_findingDigest_で照合される(self):
        f = {"id": "A", "auditor": "clarity", "document": "requirements/auth", "location": "§1", "issue": "x"}
        # findingDigest(f) を裁定側が正しく echo した想定
        src = "\n".join(
            _extract_function(REFINE, n) for n in ("stableKey", "findingDigest")
        )
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "dg.mjs"
            script.write_text(
                src + "\nprocess.stdout.write(findingDigest(JSON.parse(process.argv[2])))"
            )
            dg = subprocess.run(
                ["node", str(script), json.dumps(f)], capture_output=True, text=True, check=True
            ).stdout.strip()
        got = self._run({"fixed": [{"digest": dg, "evidence": "解消済み"}], "rejected": [], "documented": []}, [f])
        self.assertEqual(got["unadjudicated"], [])


class TestTerminalStructure(unittest.TestCase):
    def test_網羅監査は終端1回でループの外にある(self):
        self.assertIn("網羅監査は終端 1 回", REFINE)
        loop_start = REFINE.index("while (true) {")
        loop_body_end = REFINE.index("// ------------------------------------------- 矛盾解消専用の追加改稿")
        terminal = REFINE.index("網羅監査は終端 1 回")
        self.assertGreater(terminal, loop_body_end, "終端の網羅監査が改稿ループの内側にある")
        self.assertGreater(loop_body_end, loop_start)

    def test_終端監査の新規blockingはTBD起票経路に乗る(self):
        i = REFINE.index("Audit terminal")
        window = REFINE[i : i + 1500]
        self.assertIn("execFindings.push(f)", window)

    def test_unadjudicated_は_verdict_に反映される(self):
        self.assertIn("'adjudication_incomplete'", REFINE)
        self.assertIn("adjudication.unadjudicated.length", REFINE)

    def test_返り値に_adjudication_と_unanswerable_を含む(self):
        self.assertIn("adjudication,", REFINE)
        self.assertIn("unanswerable,", REFINE)

    def test_documented_の転記改稿は1回きり(self):
        self.assertEqual(REFINE.count("adjudication_transfer: true"), 1)


if __name__ == "__main__":
    unittest.main()
