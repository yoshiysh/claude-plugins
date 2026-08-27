"""refine.js の不動点検出（trackStuck / findingDigest）の挙動テスト。

固定回数上限を主たる停止条件から外し、「改稿を経ても同一 digest のまま残ることが
STUCK_THRESHOLD(=2) 回連続した指摘」を stuck として通常改稿から外す設計を固定する。

押さえるのは 4 つ。
1. 同一 digest が 2 回の改稿を跨いで残ると（= 3 ラウンド連続出現）stuck が立つ
2. 途中で digest が変わる（issue の文面が変わる）と数え直しになり stuck にならない
3. 一度消えた digest は tracker から落ち、再出現しても数え直しになる
4. 同一ラウンド内の重複 digest は 1 回として数える（初出が stuck に化けない）

加えて、停止条件の構造（backstop 到達で revision_backstop_reached を立てる /
active が尽きたらループを抜ける）を source で固定する。
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
let tracker = {}
const rounds = []
for (const findings of spec.rounds) {
  const r = trackStuck(tracker, findings, spec.threshold)
  tracker = r.tracker
  rounds.push({
    stuck: r.stuck.map((f) => f.id),
    active: r.active.map((f) => f.id),
    survived: Object.fromEntries([...r.stuck, ...r.active].map((f) => [f.id, f.survived_revisions])),
  })
}
process.stdout.write(JSON.stringify(rounds))
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
class TestTrackStuck(unittest.TestCase):
    def _run(self, rounds, threshold=2):
        src = "\n".join(
            _extract_function(REFINE, n)
            for n in ("stableKey", "findingDigest", "trackStuck")
        )
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "t.mjs"
            script.write_text(src + HARNESS)
            out = subprocess.run(
                ["node", str(script), json.dumps({"rounds": rounds, "threshold": threshold})],
                capture_output=True,
                text=True,
                check=True,
            )
        return json.loads(out.stdout)

    def test_同一digestが2回の改稿を跨いで残ると_stuck(self):
        f = _finding("CL-001")
        rounds = self._run([[f], [f], [f]])
        self.assertEqual(rounds[0]["stuck"], [])  # 初出（survived 0）
        self.assertEqual(rounds[1]["stuck"], [])  # 1 回目の残存（survived 1）
        self.assertEqual(rounds[2]["stuck"], ["CL-001"])  # 2 回連続の残存（survived 2）
        self.assertEqual(rounds[2]["survived"]["CL-001"], 2)

    def test_issueが変わると数え直しで_stuckにならない(self):
        rounds = self._run(
            [[_finding("CL-001")], [_finding("CL-001", issue="別の文面")], [_finding("CL-001", issue="別の文面")]]
        )
        self.assertEqual(rounds[2]["stuck"], [])  # digest が変わった時点で初出扱い

    def test_消えたdigestは再出現しても数え直し(self):
        f = _finding("CL-001")
        rounds = self._run([[f], [f], [], [f], [f]])
        self.assertEqual(rounds[3]["survived"]["CL-001"], 0)  # 消えた事実は前進なので持ち越さない
        self.assertEqual(rounds[4]["stuck"], [])

    def test_同一ラウンド内の重複は1回として数える(self):
        f = _finding("CL-001")
        rounds = self._run([[f, f], [f, f]])
        self.assertEqual(rounds[1]["stuck"], [])
        self.assertEqual(rounds[1]["survived"]["CL-001"], 1)


class TestStopConditionStructure(unittest.TestCase):
    def test_backstopで_verdict_を立てる(self):
        self.assertIn("const REVISION_BACKSTOP = 3", REFINE)
        self.assertIn("backstopReached = true", REFINE)
        self.assertIn("'revision_backstop_reached'", REFINE)

    def test_activeが尽きたらループを抜けてescalationへ(self):
        self.assertIn("const STUCK_THRESHOLD = 2", REFINE)
        self.assertIn("if (!activeFindings.length) {", REFINE)

    def test_escalation_はバッチ1回きりで_unanswerable_を区別する(self):
        self.assertEqual(REFINE.count("escalation_pass: true"), 1)
        self.assertIn("'unanswerable_findings'", REFINE)
        # 3 レンズ（意図 / 実装者の手順 / 反例の構成）が並列で定義されている
        for lens in ("intent", "implementer", "counterexample"):
            self.assertIn(f"name: '{lens}'", REFINE)


if __name__ == "__main__":
    unittest.main()
