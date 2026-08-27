"""refine.js の乾き停止（computeNovelty / dry_stop）の挙動テスト。

停止条件を証拠側（novelty = 前ラウンドまでに見た digest 集合に無い新規指摘の件数）に置き、
novelty 0 のラウンドで改稿予算が残っていても改稿ループを抜ける設計を固定する。
REVISION_BACKSTOP は暴走防止の backstop としてだけ残る。

押さえるのは 3 つ。
1. 全指摘が既出 digest のラウンドでは novelty が 0 になる（dry_stop が立つ側）
2. 新規指摘が混ざるラウンドでは novelty > 0 になる（dry_stop が立たない側）
3. 停止構造: novelty 0 で break する分岐が backstop 判定より前にあり、
   dry_stop / novelty_history が返り値に載り、backstop は従来どおり残る
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
const seen = new Set()
const history = []
for (const findings of spec.rounds) {
  history.push(computeNovelty(seen, findings))
}
process.stdout.write(JSON.stringify(history))
"""


def _finding(fid, issue="判定が割れる", location="§1"):
    return {
        "id": fid,
        "auditor": "clarity",
        "document": "requirements/auth",
        "location": location,
        "issue": issue,
    }


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestComputeNovelty(unittest.TestCase):
    def _run(self, rounds):
        src = "\n".join(
            _extract_function(REFINE, n)
            for n in ("stableKey", "findingDigest", "computeNovelty")
        )
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "t.mjs"
            script.write_text(src + HARNESS)
            out = subprocess.run(
                ["node", str(script), json.dumps({"rounds": rounds})],
                capture_output=True,
                text=True,
                check=True,
            )
        return json.loads(out.stdout)

    def test_全指摘が既出digestのラウンドは_novelty_0(self):
        a, b = _finding("CL-001"), _finding("CL-002", issue="別の指摘")
        history = self._run([[a, b], [a, b]])
        self.assertEqual(history, [2, 0])  # 2 ラウンド目で dry_stop が立つ側

    def test_新規指摘が混ざるラウンドは_novelty_が正(self):
        a = _finding("CL-001")
        b = _finding("CL-002", issue="新表面の露出")
        history = self._run([[a], [a, b]])
        self.assertEqual(history, [1, 1])  # 既出 1 + 新規 1 → novelty 1（止まらない側）

    def test_issueの文面が変わると新規として数える(self):
        history = self._run([[_finding("CL-001")], [_finding("CL-001", issue="別の文面")]])
        self.assertEqual(history, [1, 1])  # digest が変わった＝監査が判定し直した


class TestDryStopStructure(unittest.TestCase):
    def test_novelty_0_で改稿ループを抜ける(self):
        self.assertIn("if (novelty === 0) {", REFINE)
        self.assertEqual(REFINE.count("dryStop = true"), 1)  # 立つ経路は乾き停止だけ

    def test_乾き停止は_backstop_判定より前にある(self):
        dry = REFINE.index("if (novelty === 0) {")
        backstop = REFINE.index("if (revisions >= REVISION_BACKSTOP) {")
        self.assertLess(dry, backstop)  # 改稿予算が残っていても抜ける

    def test_返り値に_dry_stop_と_novelty_history_が載る(self):
        self.assertIn("dry_stop: dryStop", REFINE)
        self.assertIn("novelty_history: noveltyHistory", REFINE)

    def test_backstop_は従来どおり残る(self):
        self.assertIn("const REVISION_BACKSTOP = 3", REFINE)
        self.assertIn("'revision_backstop_reached'", REFINE)


if __name__ == "__main__":
    unittest.main()
