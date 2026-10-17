import contextlib
import io
import json
import runpy
import tempfile
import unittest
from pathlib import Path

QV = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "quick_validate.py"))
FRONT = "---\nname: demo\ndescription: Demo. Use when testing.\n---\n\n"
SCRIPT_CALL = 'Workflow({\n  scriptPath: "[SKILL_DIR]/scripts/run.js",\n  args: { name: "foo", skillDir: "[SKILL_DIR]" }\n})\n'
NAME_CALL = 'Workflow({\n  name: "p:demo-run",\n  args: { skillDir: "[SKILL_DIR]" }\n})\n'


def make_plugin(root: Path, body: str) -> Path:
    (root / ".claude-plugin").mkdir(parents=True)
    (root / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "p"}))
    (root / "workflows").mkdir()
    (root / "workflows" / "run.js").write_text(
        "export const meta = {\n  name: 'demo-run',\n  description: 'x',\n  extra: { name: 'nested' },\n}\nreturn null\n")
    skill = root / "skills" / "demo"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(FRONT + body)
    return skill


def run(skill: Path) -> tuple[bool, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        ok = QV["validate_skill"](str(skill), verbose=True)
    return ok, out.getvalue()


class NamedWorkflowValidationTests(unittest.TestCase):
    def test_name_call_resolves_against_plugin_workflows(self):
        with tempfile.TemporaryDirectory() as temp:
            ok, out = run(make_plugin(Path(temp), NAME_CALL))
            self.assertTrue(ok, out)

    def test_unresolved_or_foreign_name_is_an_error(self):
        for body in (NAME_CALL.replace("demo-run", "nested"), NAME_CALL.replace("p:", "q:")):
            with self.subTest(body), tempfile.TemporaryDirectory() as temp:
                ok, out = run(make_plugin(Path(temp), body))
                self.assertFalse(ok, out)

    def test_name_inside_args_is_not_a_selector(self):
        with tempfile.TemporaryDirectory() as temp:
            skill = Path(temp) / "demo"
            skill.mkdir()
            (skill / "SKILL.md").write_text(FRONT + SCRIPT_CALL)
            ok, out = run(skill)
            self.assertTrue(ok, out)
            self.assertNotIn("名前で呼べません", out)
            self.assertNotIn("scriptPath で呼んでいます", out)

    def test_plugin_member_calling_by_script_path_is_warned_not_failed(self):
        with tempfile.TemporaryDirectory() as temp:
            ok, out = run(make_plugin(Path(temp), SCRIPT_CALL))
            self.assertTrue(ok, out)
            self.assertIn("scriptPath で呼んでいます", out)


if __name__ == "__main__":
    unittest.main()
