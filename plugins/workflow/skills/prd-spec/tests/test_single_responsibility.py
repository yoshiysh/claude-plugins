"""1 role = 1 責務（schemas/role-map.md）の回帰テスト。

固定するのは 3 点。
(a) 監査役の契約に自由記述の修正文が無く、解消の方向（direction）だけを返す
    （検査者の文案は writer をアンカリングさせる — 実測済みの実害）
(b) role-map.md（責務の正本）に全 role の行があり、規範が宣言されている
(c) script と SKILL.md が role-map.md を正として指す
"""

import re
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
PRD = (SKILL / "scripts" / "prd.js").read_text(encoding="utf-8")
CONTRACTS = (SKILL / "schemas" / "agent-contracts.md").read_text(encoding="utf-8")
ROLE_MAP = (SKILL / "schemas" / "role-map.md").read_text(encoding="utf-8")

ROLES = (
    "intake",
    "flow-framer",
    "resolver",
    "resolver-verifier",
    "writer",
    "implementer",
    "grounding",
    "cross-doc",
    "doc_check",
    "prd.js",
    "司令塔",
)


def _row_pattern(role):
    return re.compile(rf"^\|[^|]*\|\s*{re.escape(role)}[（ (|]", re.M)


class DirectionReplacesFixTests(unittest.TestCase):
    def test_contracts_declare_the_no_draft_norm_in_common_form(self):
        self.assertIn("新しい要求文を創作して与えない", CONTRACTS)
        self.assertIn("`direction`", CONTRACTS)
        self.assertIn("direction_note", CONTRACTS)

    def test_script_does_not_burn_auditor_resolution_into_prompts(self):
        self.assertNotIn("想定される解消", PRD)


class RequestCoverageTests(unittest.TestCase):
    def test_cross_docの守備範囲に依頼と照らした範囲がある(self):
        # 要求文書の上位は依頼そのものなので、ここが無いと依頼に対する欠落と作り込みを誰も見ない。
        row = next(l for l in CONTRACTS.splitlines() if l.startswith("| cross-doc |"))
        seen = row.split("|")[2]
        self.assertIn("依頼（input.md・answers）と照らした文書全体の範囲の欠落と逸脱", seen)


class RoleMapTests(unittest.TestCase):
    def test_all_roles_have_a_row(self):
        for role in ROLES:
            self.assertRegex(ROLE_MAP, _row_pattern(role), f"role-map.md に {role} の行が無い")

    def test_every_agent_file_has_a_row(self):
        for path in sorted((SKILL / "agents").glob("*.md")):
            self.assertRegex(ROLE_MAP, _row_pattern(path.stem), f"{path.name} の行が role-map.md に無い")

    def test_the_norm_is_stated(self):
        self.assertIn("1 role = 1 責務", ROLE_MAP)
        self.assertIn("判定と事実指摘のみ", ROLE_MAP)

    def test_resolverの行に段9と事後報告が無い(self):
        # 事後報告は doc_check report の導出物で、生成する役を持たない。
        row = next(l for l in ROLE_MAP.splitlines() if _row_pattern("resolver").match(l))
        stages = row.split("|")[1]
        self.assertNotIn("9", stages)
        self.assertNotIn("事後報告", row)
        self.assertIn("doc_check report", next(l for l in ROLE_MAP.splitlines() if _row_pattern("司令塔").match(l)))

    def test_scripts_and_skill_reference_the_role_map(self):
        self.assertIn("schemas/role-map.md", PRD)
        self.assertIn("role-map.md", (SKILL / "SKILL.md").read_text(encoding="utf-8"))


class ExistingImplementationRuleLivesInOnePlace(unittest.TestCase):
    SECTION = "現物と既存実装の扱い"
    READERS = {"intake": "intake.md", "resolver": "resolver.md", "verifier": "resolver-verifier.md", "writer": "writer.md", "grounding": "grounding.md"}

    def _sections(self):
        body = re.search(r"const CONTRACT_SECTIONS = \{(.*?)\n\}", PRD, re.S).group(1)
        return {m.group(1): re.findall(r"'([^']+)'", m.group(2)) for m in re.finditer(r"^\s*(\w+): \[(.*?)\]", body, re.M)}

    def test_規則を使う役だけがその節を読む(self):
        readers = {role for role, secs in self._sections().items() if self.SECTION in secs}
        self.assertEqual(readers, set(self.READERS))

    def test_節の見出しは契約に1回だけある(self):
        self.assertEqual(len(re.findall(rf"^## {self.SECTION}$", CONTRACTS, re.M)), 1)

    def test_役のファイルとreferencesは節を参照し本文を写さない(self):
        phrases = ("将来の意図", "現物は将来", "現状どおり", "本当は違う形にしたい", "実装がそうなって", "既存実装は根拠にならない", "実装は要求の根拠にならない", "読んでよいと")
        for path in sorted([*(SKILL / "agents").glob("*.md"), *(SKILL / "references").glob("*.md")]):
            text = path.read_text(encoding="utf-8")
            for phrase in phrases:
                self.assertFalse(phrase in text, f"{path.name}: {phrase}")
            if path.name in self.READERS.values():
                self.assertEqual(text.count(f"「## {self.SECTION}」"), 1, path.name)



class FlowShapeSectionIsReadByFlowUsers(ExistingImplementationRuleLivesInOnePlace):
    SECTION = "flow.json の形"
    READERS = {"flowFramer", "resolver", "verifier"}

    def test_規則を使う役だけがその節を読む(self):
        readers = {role for role, secs in self._sections().items() if self.SECTION in secs}
        self.assertEqual(readers, self.READERS)
        self.assertNotIn("§flow-framer", self._sections()["verifier"], "verifier に §flow-framer 全体を配らない")

    def test_役のファイルとreferencesは節を参照し本文を写さない(self):
        # 節の本文の 20 字（仮名・漢字 10 字以上）が、契約の他の節・agents・references に無い。
        norm = lambda t: re.sub(r"[\s`*「」]", "", t)
        body = re.search(rf"^## {re.escape(self.SECTION)}$(.*?)^## ", CONTRACTS, re.S | re.M).group(1)
        others = [norm(CONTRACTS.replace(body, "")), *(norm(p.read_text(encoding="utf-8")) for p in [*(SKILL / "agents").glob("*.md"), *(SKILL / "references").glob("*.md")])]
        lit = norm(re.sub(r"```.*?```", "", body, flags=re.S))
        found = sorted({lit[i : i + 20] for i in range(len(lit) - 19)
                        if len(re.findall(r"[\u3040-\u30ff\u4e00-\u9fff]", lit[i : i + 20])) >= 10 and any(lit[i : i + 20] in o for o in others)})
        self.assertEqual(found, [])


class InvariantKindSectionIsReadByKindUsers(FlowShapeSectionIsReadByFlowUsers):
    SECTION = "不変条件の kind"
    READERS = {"intake", "flowFramer", "resolver", "verifier"}


class ExistingDocRuleLivesInCommonPromise(unittest.TestCase):
    PHRASES = ("既存の本文には trace が無い", "それ自身を原本", "既存の記述に同じ物差しを当てると")
    READERS = ("grounding.md", "writer.md")

    def test_規則は全役が読む共通の約束に1回だけある(self):
        common = re.search(r"^## 共通の約束$(.*?)^## ", CONTRACTS, re.S | re.M).group(1)
        for phrase in self.PHRASES:
            self.assertEqual(CONTRACTS.count(phrase), 1, phrase)
            self.assertIn(phrase, common)
        self.assertIn("'共通の約束'", re.search(r"const COMMON_SECTIONS = \[(.*?)\]", PRD).group(1))

    def test_役のファイルとreferencesは写さず参照する(self):
        for path in sorted([*(SKILL / "agents").glob("*.md"), *(SKILL / "references").glob("*.md"), SKILL / "SKILL.md"]):
            text = path.read_text(encoding="utf-8")
            for phrase in self.PHRASES:
                self.assertNotIn(phrase, text, path.name)
            if path.name in self.READERS:
                self.assertIn("契約の「共通の約束」の既存の本文の扱い", text, path.name)


if __name__ == "__main__":
    unittest.main()
