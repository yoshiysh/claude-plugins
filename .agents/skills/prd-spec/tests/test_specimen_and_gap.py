"""監査網の盲点 3 差分の回帰テスト。

1. 欠番申告チェック（機械）: ID 連番の欠けが本文に無申告なら ST-GAP-UNDECLARED を出し、
   申告（「欠番」の語 + 当該 ID）があれば出さない。
2. 標本適用監査（specimen）: AUDITORS に居て、初回監査と終端の網羅監査だけに参加する。
   標本が無いランは skip し、欠測（missing）ではなく specimen_skipped: true で返す。
3. 宣言漏れ検査（declaration-gap）: validity-auditor.md に第 4 の検出種が実在し、
   fix が「二択を writer に委ねる」形に固定されている。
"""

import re
import shutil
import unittest
from pathlib import Path

from test_structural_findings import DRAFT, REFINE, doc, ids_of, run_structural

SKILL = Path(__file__).resolve().parents[1]
REFINE_SRC = REFINE.read_text(encoding="utf-8")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class GapDeclarationTests(unittest.TestCase):
    """欠番申告チェック。draft/refine 両 script で挙動が一致すること（逐語複製の契約）。"""

    def test_undeclared_gap_is_reported_in_both_scripts(self):
        docs = [
            doc(
                "requirements",
                "doc",
                "### PR-XXX-016 x\n### PR-XXX-018 y\n",
                ids=["PR-XXX-016", "PR-XXX-018"],
            )
        ]
        for script in (DRAFT, REFINE):
            r = run_structural(docs, script)
            self.assertIn(
                "ST-GAP-UNDECLARED-PR-XXX-017", ids_of(r), f"{script.name} が欠番を検出しない"
            )

    def test_declared_gap_is_not_reported(self):
        # 「欠番」の語 + 当該 ID の申告があれば起票しない（採番を詰める改稿を強制しない）。
        docs = [
            doc(
                "requirements",
                "doc",
                "### PR-XXX-016 x\n### PR-XXX-018 y\n\nPR-XXX-017 は欠番である。\n",
                ids=["PR-XXX-016", "PR-XXX-018"],
                referenced=["PR-XXX-017"],
            )
        ]
        for script in (DRAFT, REFINE):
            r = run_structural(docs, script)
            self.assertNotIn(
                "ST-GAP-UNDECLARED-PR-XXX-017", ids_of(r), f"{script.name} が申告済み欠番を起票した"
            )

    def test_word_alone_without_the_id_does_not_count_as_declaration(self):
        # 別の欠番の申告が「欠番」の語だけで免罪符になってはならない（ID の併記が要る）。
        docs = [
            doc(
                "requirements",
                "doc",
                "### PR-XXX-016 x\n### PR-XXX-018 y\n\n他文書に欠番がある。\n",
                ids=["PR-XXX-016", "PR-XXX-018"],
            )
        ]
        r = run_structural(docs)
        self.assertIn("ST-GAP-UNDECLARED-PR-XXX-017", ids_of(r))

    def test_no_gap_no_finding(self):
        r = run_structural(
            [doc("requirements", "doc", "### PR-XXX-001 x\n### PR-XXX-002 y\n", ids=["PR-XXX-001", "PR-XXX-002"])]
        )
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-GAP")])

    def test_fixed_document_is_exempt(self):
        # 固定文書は自己申告（ids）を持たない。欠番も申告があって初めて定義できる。
        r = run_structural(
            [doc("requirements", "doc", "x", ids=["PR-XXX-016", "PR-XXX-018"], fixed=True)]
        )
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-GAP")])


class SpecimenAuditorStructureTests(unittest.TestCase):
    """specimen が AUDITORS に居て、初回 + 終端のみ参加する構造の固定。"""

    def test_specimen_is_registered_in_auditors(self):
        m = re.search(r"const AUDITORS = \[(.*?)\n\]", REFINE_SRC, re.S)
        self.assertIsNotNone(m)
        self.assertIn("name: 'specimen'", m.group(1))
        self.assertIn("specimen-auditor.md", m.group(1))

    def test_specimen_agent_file_exists(self):
        self.assertTrue((SKILL / "agents" / "specimen-auditor.md").is_file())

    def test_specimen_skips_scoped_revision_audits(self):
        # 主ループ内: 改稿後（revisions > 0 またはスコープ限定）のラウンドには参加しない。
        block = re.search(
            r"if \(auditor\.name === 'specimen'\) \{.*?continue\n    \}", REFINE_SRC, re.S
        )
        self.assertIsNotNone(block, "主ループに specimen の分岐が無い")
        self.assertIn("revisions > 0 || lastRevisionFindings", block.group(0))

    def test_specimen_participates_in_terminal_audit(self):
        # runAuditPass（終端の網羅監査が使う）にも specimen の発行分岐があること。
        run_audit_pass = REFINE_SRC[REFINE_SRC.index("async function runAuditPass") :]
        run_audit_pass = run_audit_pass[: run_audit_pass.index("const wrapped")]
        self.assertIn("auditor.name === 'specimen'", run_audit_pass)

    def test_no_specimens_means_skipped_not_missing(self):
        # 標本 0 件は環境の事実であり欠測（失敗）ではない。区別して返す契約の固定。
        self.assertIn("const specimenSkipped = !specimenPaths.length", REFINE_SRC)
        self.assertIn("specimen_skipped: specimenSkipped", REFINE_SRC)

    def test_specimen_paths_default_to_fixed_documents(self):
        self.assertIn("parsedArgs.specimen_paths", REFINE_SRC)
        self.assertRegex(REFINE_SRC, r"filter\(\(d\) => d && d\.fixed\)")

    def test_contradiction_pass_recheck_excludes_specimen(self):
        # 矛盾解消の再監査は validity / executability の 2 観点だけ（既存契約を壊さない）。
        self.assertIn(
            "AUDITORS.filter((a) => a.name === 'validity' || a.name === 'executability')",
            REFINE_SRC,
        )

    def test_kind_targets_are_routed_by_finding_document(self):
        # KIND: ターゲットの指摘は finding.document で宛先解決される（宛先を失うと改稿に回らない）。
        self.assertIn("String(r.target).startsWith('KIND:')", REFINE_SRC)


class DeclarationGapInValidityAuditorTests(unittest.TestCase):
    """validity-auditor.md の第 4 の検出種（宣言漏れ）の実在テスト。"""

    VALIDITY = (SKILL / "agents" / "validity-auditor.md").read_text(encoding="utf-8")

    def test_declaration_gap_section_exists(self):
        self.assertIn("### 4. 宣言漏れ", self.VALIDITY)
        self.assertIn("検出する 4 種", self.VALIDITY)

    def test_item_list_sources_are_the_existing_references(self):
        # 新規カタログを作らず、既存 2 ファイルの項目リストを正とする契約。
        self.assertIn("requirement-writing-rules.md", self.VALIDITY)
        self.assertIn("document-structure.md", self.VALIDITY)

    def test_fix_is_fixed_to_two_way_choice(self):
        self.assertIn("スコープ外宣言を追加するか、要求を追加するかの二択を writer に委ねる", self.VALIDITY)

    def test_severity_is_degraded(self):
        section = self.VALIDITY[self.VALIDITY.index("### 4. 宣言漏れ") :]
        section = section[: section.index("## 見ないもの")]
        self.assertIn("`degraded`", section)


if __name__ == "__main__":
    unittest.main()
