"""生成物の規範との相互評価で見つかった欠陥への還流 2 点の回帰テスト。

1. 機械検査の script 化（structuralFindings (6)）:
   - 語尾照合（ST-MODAL）は活用形対応の後方一致で判定する。五段動詞
     （「含まなければならない」「置かなければならない」）を偽陽性にしない。
     である調の宣言文にも発火しない。
   - 仕様項目の単位の自己宣言（ST-NOUNIT）の有無を両方向で固定する。
   - 解消条件の無い blocking TBD（ST-TBD-NORESOLVE）と、ID 見出しレベルの
     不統一（ST-IDHEADING）の検出。
2. specimen の標本多様性: 標本が自己出自文書のみのランは skip せずに
   specimen_self_only: true で申告する（構造の固定）。
"""

import shutil
import unittest
from pathlib import Path

from test_structural_findings import DRAFT, REFINE, doc, ids_of, run_structural

SKILL = Path(__file__).resolve().parents[1]
REFINE_SRC = REFINE.read_text(encoding="utf-8")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class ModalEndingTests(unittest.TestCase):
    """語尾照合。draft/refine 両 script で挙動が一致すること（逐語複製の契約）。"""

    def test_godan_verb_ending_is_not_flagged(self):
        # 「含まなければならない」「置かなければならない」は五段動詞の活用形。
        # 「〜しなければならない」の literal 照合だと偽陽性になる（実測の欠陥）。
        docs = [
            doc(
                "requirements",
                "auth",
                "#### PR-A-001 x\n\nログは利用者 ID を含まなければならない。\n"
                "#### PR-A-002 y\n\n設定ファイルはルート直下に置かなければならない。\n",
                ids=["PR-A-001", "PR-A-002"],
            )
        ]
        for script in (DRAFT, REFINE):
            r = run_structural(docs, script)
            self.assertEqual(
                [], [i for i in ids_of(r) if i.startswith("ST-MODAL")],
                f"{script.name} が五段動詞の語尾を偽陽性にした",
            )

    def test_all_four_endings_pass(self):
        docs = [
            doc(
                "requirements",
                "auth",
                "#### PR-A-001 x\n\n記録してはならない。通知することが望ましい。省略してもよい。\n",
                ids=["PR-A-001"],
            )
        ]
        r = run_structural(docs)
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-MODAL")])

    def test_declarative_dearu_is_not_flagged(self):
        # である調の宣言文は規範文候補から除外する（偽陽性回避優先）。
        docs = [
            doc(
                "requirements",
                "auth",
                "#### PR-A-001 x\n\n本要求の対象は認証基盤である。\n",
                ids=["PR-A-001"],
            )
        ]
        r = run_structural(docs)
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-MODAL")])

    def test_normative_intent_without_four_endings_is_flagged_degraded(self):
        docs = [
            doc(
                "requirements",
                "auth",
                "#### PR-A-001 x\n\nシステムはログを記録するものとする。\n",
                ids=["PR-A-001"],
            )
        ]
        for script in (DRAFT, REFINE):
            r = run_structural(docs, script)
            hits = [f for f in r["findings"] if f["id"].startswith("ST-MODAL")]
            self.assertEqual(1, len(hits), f"{script.name} が規範意図の非 4 語尾を検出しない")
            self.assertEqual("degraded", hits[0]["severity"])

    def test_table_rows_and_rationale_lines_are_excluded(self):
        docs = [
            doc(
                "requirements",
                "auth",
                "#### PR-A-001 x\n\n| 区分 | 語尾すること |\n根拠: 依頼文にすること\n",
                ids=["PR-A-001"],
            )
        ]
        r = run_structural(docs)
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-MODAL")])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class UnitDeclarationTests(unittest.TestCase):
    def spec(self, markdown):
        return doc(
            "specifications",
            "auth",
            markdown,
            ids=["SP-A-001"],
            traceability=[{"requirement_id": "PR-A-001", "spec_id": "SP-A-001"}],
        )

    def req(self):
        return doc("requirements", "auth", "#### PR-A-001 x\n", ids=["PR-A-001"])

    def test_missing_unit_declaration_is_flagged(self):
        for script in (DRAFT, REFINE):
            r = run_structural([self.req(), self.spec("#### SP-A-001 z\n")], script)
            hits = [f for f in r["findings"] if f["id"].startswith("ST-NOUNIT")]
            self.assertEqual(1, len(hits), f"{script.name} が単位宣言の欠落を検出しない")
            self.assertEqual("degraded", hits[0]["severity"])

    def test_unit_declaration_present_is_not_flagged(self):
        md = "本書は `####` 見出し 1 つを 1 仕様項目とする。\n#### SP-A-001 z\n"
        r = run_structural([self.req(), self.spec(md)])
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-NOUNIT")])

    def test_fixed_specification_is_exempt(self):
        d = self.spec("#### SP-A-001 z\n")
        d["fixed"] = True
        r = run_structural([self.req(), d])
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-NOUNIT")])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class TbdResolveAndHeadingLevelTests(unittest.TestCase):
    def test_blocking_tbd_without_resolve_condition_is_flagged(self):
        docs = [
            doc(
                "requirements",
                "auth",
                "上限は未定（TBD-RAUTH-001）。\n",
                tbd=[{"id": "TBD-RAUTH-001", "text": "上限値", "blocking": True}],
            )
        ]
        r = run_structural(docs)
        self.assertIn("ST-TBD-NORESOLVE-TBD-RAUTH-001", ids_of(r))

    def test_blocking_tbd_with_resolve_condition_is_not_flagged(self):
        docs = [
            doc(
                "requirements",
                "auth",
                "上限は未定（TBD-RAUTH-001）。\n",
                tbd=[
                    {
                        "id": "TBD-RAUTH-001",
                        "text": "上限値（解消: 経理が上限を確定したら）",
                        "blocking": True,
                    }
                ],
            )
        ]
        r = run_structural(docs)
        self.assertNotIn("ST-TBD-NORESOLVE-TBD-RAUTH-001", ids_of(r))

    def test_non_blocking_tbd_is_not_flagged(self):
        docs = [
            doc(
                "requirements",
                "auth",
                "文言は未定（TBD-RAUTH-002）。\n",
                tbd=[{"id": "TBD-RAUTH-002", "text": "文言", "blocking": False}],
            )
        ]
        r = run_structural(docs)
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-TBD-NORESOLVE")])

    def test_inconsistent_id_heading_level_is_flagged(self):
        # 基準は最頻レベル（#### が 2 件）。散在した ### 側だけが起票される。
        docs = [
            doc(
                "requirements",
                "auth",
                "#### PR-A-001 x\n#### PR-A-002 y\n### PR-A-003 z\n",
                ids=["PR-A-001", "PR-A-002", "PR-A-003"],
            )
        ]
        for script in (DRAFT, REFINE):
            r = run_structural(docs, script)
            self.assertIn("ST-IDHEADING-PR-A-003", ids_of(r), script.name)
            self.assertNotIn("ST-IDHEADING-PR-A-001", ids_of(r), script.name)

    def test_consistent_id_heading_levels_are_not_flagged(self):
        docs = [
            doc(
                "requirements",
                "auth",
                "#### PR-A-001 x\n#### PR-A-002 y\n",
                ids=["PR-A-001", "PR-A-002"],
            )
        ]
        r = run_structural(docs)
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-IDHEADING")])


class SpecimenSelfOnlyStructureTests(unittest.TestCase):
    """標本が自己出自のみのランを skip せず申告する構造の固定。"""

    def test_self_only_is_computed_and_returned(self):
        self.assertIn(
            "const specimenSelfOnly = !specimenSkipped && specimenPaths.every((p) => documentPathsAll.has(p))",
            REFINE_SRC,
        )
        self.assertIn("specimen_self_only: specimenSelfOnly", REFINE_SRC)

    def test_self_only_warns_but_does_not_skip(self):
        # skip の条件は「標本 0 件」のまま（self-only を skip 条件に混ぜない）。
        self.assertIn("const specimenSkipped = !specimenPaths.length", REFINE_SRC)
        self.assertIn("skip はしません", REFINE_SRC)

    def test_the_recommendation_is_documented(self):
        # 正の所在は references/workflow-io.md（Workflow B の内部機構）。SKILL.md は
        # 呼び出し手順だけを持ち、内部機構の説明を二重に持たない。
        doc = (SKILL / "references" / "workflow-io.md").read_text(encoding="utf-8")
        self.assertIn("specimen_self_only", doc)
        self.assertIn("自己出自", doc)


if __name__ == "__main__":
    unittest.main()
