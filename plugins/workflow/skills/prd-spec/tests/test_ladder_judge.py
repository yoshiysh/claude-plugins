"""スコープの梯子（ladder-judge）の契約実在テスト + ladderToTbd の挙動テスト。

戻り先が writer 改稿 1 種類しか無いと、根拠が入力に無い指摘まで改稿予算を消費してから
TBD 起票で逃げる。専任 judge が failure kind で 4 分類し、artifact / criteria だけを
改稿ループへ流し、premise / question は即座に blocking TBD（needs_input）へ起票する
設計を固定する。

押さえるのは 3 つ。
1. 判定表の契約が schemas/agent-contracts.md に実在する（4 値・優先順位・表に無い状況の
   needs_input(decision) 落ち・rationale 必須）
2. agents/ladder-judge.md が実在し、生成側と別 spawn の分類専任である
3. refine.js の配線: premise / question は needs_input へ、分類欠測は writer へ、
   ladderToTbd は blocking:true の TBD-NI- を安定キーで起票し kind を data / decision に写す
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REFINE = (SKILL / "scripts" / "refine.js").read_text()
CONTRACTS = (SKILL / "schemas" / "agent-contracts.md").read_text()
AGENT_MD = SKILL / "agents" / "ladder-judge.md"


def _extract_function(source: str, name: str) -> str:
    lines = source.split("\n")
    start = f"function {name}("
    s = next(i for i, l in enumerate(lines) if l.startswith(start))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


class TestContractExists(unittest.TestCase):
    def test_判定表が4値を持つ(self):
        self.assertIn("## §ladder-judge", CONTRACTS)
        for kind in ("premise", "question", "criteria", "artifact"):
            self.assertIn(f"`{kind}`", CONTRACTS)

    def test_表に無い状況は_needs_input_decision_に落とす(self):
        self.assertIn("表に無い状況は `question`（`needs_input(decision)`）に落とす", CONTRACTS)
        self.assertIn("規則を発明しない", CONTRACTS)

    def test_行に優先順位がある(self):
        self.assertIn("複数行に当たるときは番号の小さい行を採る", CONTRACTS)

    def test_criteria_は_writer_が既定を提案し_decisions_候補として返す(self):
        self.assertIn("writer が既定を提案し、decisions 候補", CONTRACTS)

    def test_rationale_は必須(self):
        self.assertIn("分類の根拠（1 行必須）", CONTRACTS)

    def test_agent_md_が実在し分類専任である(self):
        self.assertTrue(AGENT_MD.exists())
        body = AGENT_MD.read_text()
        self.assertIn("別 spawn", body)
        self.assertIn("分類だけを行う", body)
        self.assertIn("rationale", body)


class TestRefineWiring(unittest.TestCase):
    def test_4値のenumがschemaにある(self):
        self.assertIn("const LADDER_KINDS = ['artifact', 'criteria', 'premise', 'question']", REFINE)

    def test_premise_question_は_needs_input_へ_分類欠測は_writer_へ(self):
        self.assertIn("if (kind === 'premise' || kind === 'question') needsInput.push", REFINE)
        self.assertIn("toWriter.push({ ...f, ladder_kind: kind || 'artifact' })", REFINE)

    def test_needs_input_は改稿予算を消費しない(self):
        # ladder 分類は backstop 判定より前にあり、writer に渡るのは toWriter 側だけ
        ladder = REFINE.index("await classifyFindings(activeFindings")
        backstop = REFINE.index("if (revisions >= REVISION_BACKSTOP) {")
        self.assertLess(ladder, backstop)
        self.assertIn("const reviseTargets = laddered.toWriter", REFINE)

    def test_返り値に_needs_input_が載る(self):
        self.assertIn("needs_input: needsInput", REFINE)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestLadderToTbd(unittest.TestCase):
    def _run(self, entries):
        src = "\n".join(_extract_function(REFINE, n) for n in ("stableKey", "ladderToTbd"))
        harness = """
const entries = JSON.parse(process.argv[2])
process.stdout.write(JSON.stringify(ladderToTbd(entries)))
"""
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "t.mjs"
            script.write_text(src + harness)
            out = subprocess.run(
                ["node", str(script), json.dumps(entries)],
                capture_output=True,
                text=True,
                check=True,
            )
        return json.loads(out.stdout)

    def test_TBD_NI_で_blocking_起票され_kind_が写る(self):
        finding = {
            "id": "VA-001",
            "document": "requirements/auth",
            "location": "§2",
            "issue": "根拠が入力に無い",
            "fix": "依頼者に確認する",
        }
        items = self._run(
            [{"kind": "premise", "finding": finding}, {"kind": "question", "finding": {**finding, "location": "§3"}}]
        )
        self.assertTrue(all(t["id"].startswith("TBD-NI-") for t in items))
        self.assertTrue(all(t["blocking"] for t in items))
        self.assertEqual(items[0]["needs_input_kind"], "data")      # premise → data
        self.assertEqual(items[1]["needs_input_kind"], "decision")  # question → decision
        # 安定キー: 同じ指摘からは同じ ID（提示済み照合が壊れない）
        again = self._run([{"kind": "premise", "finding": finding}])
        self.assertEqual(items[0]["id"], again[0]["id"])


if __name__ == "__main__":
    unittest.main()
