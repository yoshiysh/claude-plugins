"""1 role = 1 責務の再設計（schemas/role-map.md）の回帰テスト。

固定するのは 5 点。
(a) auditor 契約に自由記述の fix が無く、direction が enum である
    （検査者の文案は writer をアンカリングさせる — 実測済みの実害）
(b) script 起票 TBD の text に「想定される解消」（監査者の解消案）を焼き込まない
(c) 終端裁定の documented に text（転記文の文案）が無い（転記文は writer が起草する）
(d) role-map.md（責務の正本）に全 role の行が存在する
(e) sources_path 指定時、CONTEXT_BLOCK に tbd_answers_history の全文が入らない
    （auditor 系 role の decisions は 1 行形式に縮約される）
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REFINE = (SKILL / "scripts" / "refine.js").read_text(encoding="utf-8")
DRAFT = (SKILL / "scripts" / "draft.js").read_text(encoding="utf-8")
CONTRACTS = (SKILL / "schemas" / "agent-contracts.md").read_text(encoding="utf-8")
ROLE_MAP = (SKILL / "schemas" / "role-map.md").read_text(encoding="utf-8")


def _slice_block(src: str, start_marker: str) -> str:
    """start_marker から始まる { ... } ブロックを波括弧の対応で切り出す。"""
    i = src.index(start_marker)
    j = src.index("{", i)
    depth = 0
    for k in range(j, len(src)):
        if src[k] == "{":
            depth += 1
        elif src[k] == "}":
            depth -= 1
            if depth == 0:
                return src[i : k + 1]
    raise AssertionError(f"{start_marker} の閉じ括弧が見つからない")


class DirectionReplacesFixTests(unittest.TestCase):
    def test_audit_schema_has_direction_enum_and_no_fix(self):
        block = _slice_block(REFINE, "const AUDIT_SCHEMA =")
        self.assertNotIn("fix:", block)
        self.assertIn("direction: { type: 'string', enum: AUDIT_DIRECTIONS }", block)
        self.assertIn("'direction'", block)  # required に direction がある

    def test_exec_schema_has_direction_enum_and_no_fix(self):
        block = _slice_block(DRAFT, "const EXEC_SCHEMA =")
        self.assertNotIn("fix:", block)
        self.assertIn("direction: { type: 'string', enum: AUDIT_DIRECTIONS }", block)

    def test_direction_enum_values_match_between_scripts(self):
        def values(src):
            block = re.search(r"const AUDIT_DIRECTIONS = \[(.*?)\]", src, re.S).group(1)
            return re.findall(r"'([^']+)'", block)

        self.assertEqual(values(REFINE), values(DRAFT))
        self.assertIn("needs_human", values(REFINE))

    def test_contracts_declare_the_no_draft_norm_in_common_form(self):
        # validity 固有だった規範が共通契約へ昇格していること
        self.assertIn("新しい要求文を創作して与えない", CONTRACTS)
        self.assertIn("`direction`", CONTRACTS)
        self.assertIn("direction_note", CONTRACTS)


class NoResolutionBurnInTests(unittest.TestCase):
    def test_tbd_text_does_not_embed_auditor_resolution(self):
        for name, src in (("refine.js", REFINE), ("draft.js", DRAFT)):
            self.assertNotIn("想定される解消", src, f"{name} が監査者の解消案を TBD text に焼き込んでいる")


class AdjudicationDocumentedTests(unittest.TestCase):
    def test_documented_schema_has_no_text(self):
        block = _slice_block(REFINE, "const ADJUDICATION_SCHEMA =")
        documented = block[block.index("documented:") :]
        self.assertNotIn("text: { type: 'string' }", documented)
        self.assertIn("reason: { type: 'string' }", documented)
        self.assertIn("required: ['digest', 'target_document', 'reason']", documented)


class RoleMapTests(unittest.TestCase):
    def test_all_roles_have_a_row(self):
        for role in (
            "intake",
            "domain-analyst",
            "splitter",
            "req-writer / spec-writer",
            "structural（script）",
            "ladder-judge",
            "resolver",
            "resolver-verifier",
            "precedent-judge",
            "measurement",
            "adjudicator",
            "writer（転記改稿）",
            "司令塔（SKILL.md）",
        ):
            self.assertIn(f"| {role} |", ROLE_MAP, f"role-map.md に {role} の行が無い")
        # 監査 7 観点 + specimen が 1 行で宣言されている
        for auditor in ("executability", "clarity", "traceability", "coverage", "fabrication", "consistency", "validity", "specimen"):
            self.assertIn(auditor, ROLE_MAP)

    def test_the_norm_is_stated(self):
        self.assertIn("1 role = 1 責務", ROLE_MAP)
        self.assertIn("判定と事実指摘のみ", ROLE_MAP)

    def test_scripts_and_skill_reference_the_role_map(self):
        self.assertIn("schemas/role-map.md", REFINE)
        self.assertIn("schemas/role-map.md", DRAFT)
        self.assertIn("role-map.md", (SKILL / "SKILL.md").read_text(encoding="utf-8"))


def _extract_function(source: str, name: str) -> str:
    lines = source.split("\n")
    start = f"function {name}("
    s = next(i for i, l in enumerate(lines) if l.startswith(start))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


HARNESS = """
const SKILL_DIR = '/skill'
const mode = 'new'
const input = '依頼文'
const answers = '回答'
const decisions = [{ id: 'D-001', topic: '語尾', value: '4 語尾', why: 'WHY_FIELD', reversibility: 'REV_FIELD' }]
const inputTbdItems = []
const domainFindings = []
const requiredCategories = []
const today = '2026-01-01'
const tbdAnswers = ''
const tbdAnswersHistory = [{ round: 1, answers: 'SECRET_HISTORY_BODY' }]
const spec = JSON.parse(process.argv[2])
const sourcesPath = spec.sources_path
const decisionsOneLine = (list) =>
  (list || []).map((d) => `${d.id}: ${d.topic} = ${d.value}`).join('\\n') || '(決定なし)'
"""


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class ContextBlockTests(unittest.TestCase):
    def _run(self, role, sources_path):
        src = HARNESS + _extract_function(REFINE, "buildContextBlock") + (
            "\nprocess.stdout.write(JSON.stringify(buildContextBlock(spec.role)))"
        )
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "t.mjs"
            script.write_text(src)
            out = subprocess.run(
                ["node", str(script), json.dumps({"role": role, "sources_path": sources_path})],
                capture_output=True,
                text=True,
                check=True,
            )
        return json.loads(out.stdout)

    def test_sources_path_drops_full_history_from_context(self):
        ctx = self._run("auditor", "/ws/sources/r2.md")
        self.assertNotIn("SECRET_HISTORY_BODY", ctx)
        self.assertIn("/ws/sources/r2.md", ctx)  # 正本の所在は要旨 1 行で残る

    def test_without_sources_path_history_stays_inline(self):
        ctx = self._run("auditor", "")
        self.assertIn("SECRET_HISTORY_BODY", ctx)  # 後方互換

    def test_auditor_gets_one_line_decisions_writer_gets_full(self):
        auditor_ctx = self._run("auditor", "")
        self.assertIn("D-001: 語尾 = 4 語尾", auditor_ctx)
        self.assertNotIn("WHY_FIELD", auditor_ctx)
        writer_ctx = self._run("writer", "")
        self.assertIn("WHY_FIELD", writer_ctx)
        self.assertIn("REV_FIELD", writer_ctx)


if __name__ == "__main__":
    unittest.main()
