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

    def test_scripts_and_skill_reference_the_role_map(self):
        self.assertIn("schemas/role-map.md", PRD)
        self.assertIn("role-map.md", (SKILL / "SKILL.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
