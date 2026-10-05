"""references/permissions.md の allow rule が、実行させるコマンドと W の置き場に一致すること。

規則が実行の形とずれると、doc_check の実行ごとに確認か classifier の審査が入る。規則の文字列の正本は permissions.md だけで、
SKILL.md・workflow-io は参照だけを持つ（写すと片方だけ直ってずれる）。
"""

import re
import unittest
from pathlib import Path

from prd_script import PRD_PATH

SKILL = Path(__file__).resolve().parents[1]
PERMISSIONS = SKILL / "references" / "permissions.md"
RULE_TOOLS = ("Bash", "Read", "Edit", "Write")


def rules():
    text = PERMISSIONS.read_text(encoding="utf-8")
    section = text[text.index("## allow rule を足す") :]
    block = re.search(r"```\n(.*?)```", section, re.S)
    assert block, "permissions.md §1 に規則の code block が無い"
    return [line.strip() for line in block.group(1).splitlines() if line.strip()]


def code_lines(src):
    return [line for line in src.splitlines() if not line.lstrip().startswith("//")]


class PermissionRules(unittest.TestCase):
    def setUp(self):
        self.rules = rules()
        self.src = PRD_PATH.read_text(encoding="utf-8")

    def bash_prefix(self):
        bash = [r for r in self.rules if r.startswith("Bash(")]
        self.assertEqual(len(bash), 1, f"Bash の規則は doc_check の 1 行だけ: {bash}")
        m = re.fullmatch(r"Bash\((.+) \*\)", bash[0])
        self.assertTrue(m, f"Bash の規則は '<接頭辞> *' の形: {bash[0]}")
        return m.group(1)

    def test_every_doc_check_in_the_script_goes_through_cli(self):
        uses = [line for line in code_lines(self.src) if "doc_check.mjs" in line]
        self.assertEqual(len(uses), 1, f"doc_check.mjs のコマンド文は cli() の 1 か所だけで作る: {uses}")
        self.assertTrue(uses[0].startswith("const cli = "), uses[0])
        self.assertNotRegex(self.src, r"\bnode\s+\$\{SKILL_DIR\}(?!/scripts/doc_check\.mjs \$\{mode\})", "cli() を通らない node の実行がある")

    def test_bash_rule_matches_the_cli_prefix(self):
        m = re.search(r"const cli = \(mode, rest\) => `(node \$\{SKILL_DIR\}/scripts/doc_check\.mjs) \$\{mode\}", self.src)
        self.assertTrue(m, "cli() の形が変わった")
        self.assertEqual(self.bash_prefix(), m.group(1).replace("${SKILL_DIR}", "[SKILL_DIR]"))

    def test_orchestrator_and_contract_commands_use_the_same_prefix(self):
        prefix = self.bash_prefix()
        skill_md = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        cmds = re.findall(r"`([^`]*doc_check\.mjs [^`]*)`", skill_md)
        self.assertTrue(cmds, "SKILL.md に doc_check のコマンドが無い")
        for cmd in cmds:
            self.assertTrue(cmd.startswith(prefix + " "), cmd)
        contract = (SKILL / "schemas" / "agent-contracts.md").read_text(encoding="utf-8")
        for cmd in re.findall(r"`([^`]*doc_check\.mjs [^`]*)`", contract):
            self.assertTrue(cmd.replace("<SKILL_DIR>", "[SKILL_DIR]").startswith(prefix + " "), cmd)

    def test_native_skill_dir_read_rule_covers_the_workspace_root_of_s0(self):
        skill_md = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        root = re.search(r"\*\*W を作る\*\*: native では `([^<`]+)<案件>/`", skill_md)
        self.assertTrue(root, "SKILL.md の S0 の native W の置き場が読めない")
        self.assertTrue(root.group(1).startswith("[SKILL_DIR]/"), f"W が [SKILL_DIR] の外にあると Read の規則が W を覆わない: {root.group(1)}")
        self.assertIn("Read(/[SKILL_DIR]/**)", self.rules)

    def test_rules_are_only_the_doc_check_prefix_and_the_skill_dir_read(self):
        # W は install 先では protected path（~/.claude/）の下で、allow rule は Write・Edit を通さない（permissions.md の前提）。
        self.assertEqual(sorted(r for r in self.rules if not r.startswith("Bash(")), ["Read(/[SKILL_DIR]/**)"], "効かない規則か範囲の外の規則がある")

    def test_rule_strings_are_not_copied(self):
        pattern = re.compile(r"\b(" + "|".join(RULE_TOOLS) + r")\((?:node|/|~|\[)")
        for rel in ("SKILL.md", "references/workflow-io.md", "references/io-example.md"):
            text = (SKILL / rel).read_text(encoding="utf-8")
            self.assertNotRegex(text, pattern, f"{rel} に規則の写しがある（permissions.md を参照する）")
        self.assertIn("references/permissions.md", (SKILL / "SKILL.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
