"""refine.js のスコープ監査（buildScopeNote）のプロンプト組み立てテスト。

改稿のたびに全文を 7 観点で再監査すると、新しい仕上げレベルの指摘が毎回汲み出され、
生成量 ≈ 消化量で non-blocking の総数が減らない（実測 run5/run6: 13→12 件）。
指摘起因の改稿の後の再監査は、当該指摘の document / location に対応する範囲に
限定する設計を固定する。

押さえるのは 3 つ。
1. buildScopeNote が指摘の document / location から範囲限定の指示文を組み立てる
   （「この範囲だけを見る。checked にその範囲を書く」を含む / 重複範囲は畳む / 空なら ''）
2. 主ループの監査が改稿契機の指摘から scope note を渡している
3. スコープ監査の対象範囲が log に出る（検証で使う）
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
process.stdout.write(JSON.stringify(buildScopeNote(spec.findings)))
"""


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestBuildScopeNote(unittest.TestCase):
    def _run(self, findings):
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "t.mjs"
            script.write_text(_extract_function(REFINE, "buildScopeNote") + HARNESS)
            out = subprocess.run(
                ["node", str(script), json.dumps({"findings": findings})],
                capture_output=True,
                text=True,
                check=True,
            )
        return json.loads(out.stdout)

    def test_documentとlocationから範囲限定の指示文を組み立てる(self):
        note = self._run(
            [
                {"document": "specifications/auth", "location": "SP-AUTH-003"},
                {"document": "requirements/auth", "location": "受入条件の章"},
            ]
        )
        self.assertIn("[AUDIT_SCOPE]", note)
        self.assertIn("specifications/auth", note)
        self.assertIn("SP-AUTH-003", note)
        self.assertIn("requirements/auth", note)
        self.assertIn("この範囲だけを見る。checked にその範囲を書くこと", note)
        self.assertIn("範囲外", note)  # 範囲外の新規指摘は起票しない

    def test_同一範囲は畳む(self):
        note = self._run(
            [
                {"document": "specifications/auth", "location": "SP-AUTH-003"},
                {"document": "specifications/auth", "location": "SP-AUTH-003"},
            ]
        )
        self.assertEqual(note.count("SP-AUTH-003"), 1)

    def test_空や宛先不明なら範囲を限定しない(self):
        self.assertEqual(self._run([]), "")
        self.assertEqual(self._run([{"location": "§1"}]), "")  # document 無し = 宛先不明

    def test_location欠損でもdocument単位で範囲になる(self):
        note = self._run([{"document": "requirements/auth"}])
        self.assertIn("requirements/auth", note)


class TestScopedAuditWiring(unittest.TestCase):
    def test_主ループの監査に_scope_note_が渡る(self):
        # 直前の改稿の契機（lastRevisionFindings）から組み立て、buildAuditPrompt へ渡す
        self.assertIn(
            "const roundScopeNote = lastRevisionFindings ? buildScopeNote(lastRevisionFindings) : ''",
            REFINE,
        )
        self.assertIn("buildAuditPrompt(task.auditor, task, deferred, roundScopeNote)", REFINE)

    def test_改稿契機が次ラウンドの範囲になる(self):
        # ladder-judge 導入後は writer に渡った指摘（reviseTargets）だけが次ラウンドの範囲になる
        # （needs_input へ回った指摘は改稿されないので、再監査の範囲に含める理由が無い）
        self.assertIn("lastRevisionFindings = reviseTargets", REFINE)

    def test_対象範囲がログに出る(self):
        self.assertIn("スコープ監査の対象範囲", REFINE)

    def test_スコープ監査を使ったランだけが終端網羅監査を持つ(self):
        self.assertIn("scopedAuditUsed = true", REFINE)
        self.assertIn("if (scopedAuditUsed && !backstopReached && !skipTerminal)", REFINE)


if __name__ == "__main__":
    unittest.main()
