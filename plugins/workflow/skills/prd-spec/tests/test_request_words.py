"""依頼語から作る文書を決める表（references/document-splitting.md §0）と、それを読む側の食い違いのテスト。

「要件」を要求文書だけに割り当てると、要件（実装・評価できる形に具体化したもの）が要求文書に入る
（prd-and-spec.md §11.5）。表を直したときに、intake が読む参照と eval の期待が古い割り当てのまま残らないかを見る。
"""

import json
import re
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
SPLITTING = SKILL / "references" / "document-splitting.md"
EVALS = SKILL / "evals" / "evals.json"


def _table():
    sec = SPLITTING.read_text().split("## 0.", 1)[1].split("\n## ", 1)[0]
    rows = {}
    for line in sec.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 2 or cells[1] in ("作成対象", "---"):
            continue
        words = re.split(r"\s*/\s*", cells[0].split("。")[0])
        rows[cells[1].strip("*")] = [w for w in words if w]
    return rows


def _target(prompt, rows):
    hit = {t for t, words in rows.items() if any(w in prompt for w in words)}
    return hit.pop() if len(hit) == 1 else "両方"


class RequestWords(unittest.TestCase):
    def test_要件は両方を作り_要求文書だけを作る語に要件を含めない(self):
        rows = _table()
        self.assertEqual(set(rows), {"requirements", "specifications", "両方"})
        self.assertEqual(rows["requirements"], ["PRD", "要求", "要求文書"])
        self.assertEqual(rows["両方"], ["要件", "要件定義"])

    def test_intakeは表を参照し語を写さない(self):
        intake = (SKILL / "agents" / "planner.md").read_text()
        self.assertIn("`references/document-splitting.md` §0", intake)
        self.assertNotRegex(intake, r"要件定義\s*/|/\s*要件定義")

    def test_evalの期待は表の割り当てと食い違わない(self):
        rows = _table()
        for ev in json.loads(EVALS.read_text())["evals"]:
            text = ev["expected_output"] + "\n".join(ev["assertions"])
            target = _target(ev["prompt"], rows)
            with self.subTest(id=ev["id"], target=target):
                if target == "requirements":
                    self.assertNotIn("仕様項目 ID", text)
                    self.assertNotIn("SP-", text)
                else:
                    self.assertNotIn("要求文書だけ", text)
                    self.assertNotIn("仕様書を作らず", text)


if __name__ == "__main__":
    unittest.main()
