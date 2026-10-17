import contextlib
import io
import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
REGISTER = runpy.run_path(str(SCRIPTS / "register_plugin.py"))

CALLSITE = '  scriptPath: "[SKILL_DIR]/scripts/flow.js",\n'
SKILL_MD = (
    "---\nname: demo\ndescription: Demo. Use when testing.\n---\n\n"
    "```\nWorkflow({\n" + CALLSITE + '  args: { skillDir: "[SKILL_DIR]" }\n})\n```\n'
)
FLOW = "export const meta = {\n  name: 'demo-run',\n  description: 'x',\n}\nreturn null\n"


class Repo:
    def __init__(self, root: Path):
        self.root = root
        self.agents = root / ".agents" / "skills"
        self.plugins = root / "plugins"
        self.claude = root / ".claude-plugin" / "marketplace.json"
        self.codex = root / ".agents" / "plugins" / "marketplace.json"
        self.skill = self.agents / "demo"
        (self.skill / "scripts").mkdir(parents=True)
        (self.skill / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
        (self.skill / "scripts" / "flow.js").write_text(FLOW, encoding="utf-8")
        (self.skill / "scripts" / "helper.js").write_text("module.exports = 1\n", encoding="utf-8")
        self.plugins.mkdir()
        self.claude.parent.mkdir()
        self.claude.write_text(json.dumps({"name": "test", "plugins": []}))
        self.codex.parent.mkdir(parents=True)
        self.codex.write_text(json.dumps({"name": "test", "interface": {"displayName": "Test"}, "plugins": []}))

    def snapshot(self) -> dict:
        return {p: p.read_bytes() for p in sorted(self.root.rglob("*")) if p.is_file() and not p.is_symlink()}

    def register(self, *extra: str) -> tuple[int, dict | None, str]:
        globals_ = REGISTER["main"].__globals__
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(globals_, PROJECT_ROOT=self.root, AGENTS_SKILLS_DIR=self.agents,
                        PLUGINS_DIR=self.plugins, MARKETPLACE_PATH=self.claude,
                        CODEX_MARKETPLACE_PATH=self.codex), \
                patch.object(sys, "argv", ["register_plugin.py", "--skill", "demo", "--plugin", "foo", *extra]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with self.assertRaisesSystemExit() as raised:
                REGISTER["main"]()
        text = out.getvalue()
        return raised.code, (json.loads(text) if text.strip() else None), err.getvalue()

    @contextlib.contextmanager
    def assertRaisesSystemExit(self):
        holder = type("Holder", (), {"code": None})()
        try:
            yield holder
        except SystemExit as exc:
            holder.code = exc.code
        else:
            raise AssertionError("SystemExit was not raised")


class WorkflowRelocationTests(unittest.TestCase):
    def test_publish_moves_workflow_script_and_rewrites_callsite_once(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Repo(Path(temp))
            code, report, err = repo.register()
            self.assertEqual(code, REGISTER["EXIT_OK"], err)
            published = repo.plugins / "foo"
            self.assertEqual((published / "workflows" / "flow.js").read_text(encoding="utf-8"), FLOW)
            skill_dir = published / "skills" / "demo"
            self.assertFalse((skill_dir / "scripts" / "flow.js").exists())
            self.assertTrue((skill_dir / "scripts" / "helper.js").is_file())
            md = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
            self.assertEqual(md, SKILL_MD.replace(CALLSITE, '  name: "foo:demo-run",\n'))
            moves = report["actions"]["workflow_scripts"]
            self.assertEqual([(m["from"], m["to"], m["qualified_name"]) for m in moves],
                             [("skills/demo/scripts/flow.js", "workflows/flow.js", "foo:demo-run")])

            code, report, err = repo.register("--update")
            self.assertEqual(code, REGISTER["EXIT_OK"], err)
            self.assertEqual(report["actions"]["workflow_scripts"], [])
            self.assertEqual((skill_dir / "SKILL.md").read_text(encoding="utf-8"), md)

    def test_dry_run_reports_planned_move_without_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Repo(Path(temp))
            before = repo.snapshot()
            code, report, err = repo.register("--dry-run")
            self.assertEqual(code, REGISTER["EXIT_OK"], err)
            self.assertEqual([m["to"] for m in report["planned_actions"]["workflow_scripts"]], ["workflows/flow.js"])
            self.assertEqual(repo.snapshot(), before)

    def test_unreferenced_workflow_script_stays_in_scripts(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Repo(Path(temp))
            (repo.skill / "SKILL.md").write_text(SKILL_MD.replace(CALLSITE, ""), encoding="utf-8")
            code, report, err = repo.register()
            self.assertEqual(code, REGISTER["EXIT_OK"], err)
            self.assertEqual(report["actions"]["workflow_scripts"], [])
            self.assertTrue((repo.plugins / "foo" / "skills" / "demo" / "scripts" / "flow.js").is_file())

    def test_update_of_published_skill_skips_moves_and_reports_them(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Repo(Path(temp))
            self.assertEqual(repo.register()[0], REGISTER["EXIT_OK"])
            skill_dir = repo.plugins / "foo" / "skills" / "demo"
            (skill_dir / "scripts" / "late.js").write_text(FLOW.replace("demo-run", "late-run"), encoding="utf-8")
            with (skill_dir / "SKILL.md").open("a", encoding="utf-8") as f:
                f.write("resume with scriptPath: scripts/late.js\n")
            code, report, err = repo.register("--update")
            self.assertEqual(code, REGISTER["EXIT_OK"], err)
            self.assertEqual(report["actions"]["workflow_scripts"], [])
            skipped = report["actions"]["workflow_scripts_skipped"]
            self.assertEqual([(s["skill"], s["file"]) for s in skipped], [("demo", "late.js")])
            self.assertTrue(len(skipped[0]["reasons"]) >= 2)
            self.assertTrue((skill_dir / "scripts" / "late.js").is_file())

    def test_bundled_skill_scripts_move_with_the_main_skill(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Repo(Path(temp))
            other = repo.agents / "other"
            (other / "scripts").mkdir(parents=True)
            (other / "SKILL.md").write_text(
                SKILL_MD.replace("name: demo", "name: other").replace("flow.js", "other.js"), encoding="utf-8")
            (other / "scripts" / "other.js").write_text(FLOW.replace("demo-run", "other-run"), encoding="utf-8")
            code, report, err = repo.register("--bundle-skill", "other")
            self.assertEqual(code, REGISTER["EXIT_OK"], err)
            self.assertEqual(sorted(m["qualified_name"] for m in report["actions"]["workflow_scripts"]),
                             ["foo:demo-run", "foo:other-run"])
            published = repo.plugins / "foo"
            self.assertTrue((published / "workflows" / "other.js").is_file())
            self.assertIn('name: "foo:other-run"', (published / "skills" / "other" / "SKILL.md").read_text(encoding="utf-8"))

    def test_failed_move_rolls_back_and_rerun_completes(self):
        two_md = SKILL_MD + "```\nWorkflow({\n  scriptPath: \"[SKILL_DIR]/scripts/second.js\",\n})\n```\n"
        original_rename = Path.rename
        calls = {"n": 0}

        def fail_second_rename(self, target):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("injected rename failure")
            return original_rename(self, target)

        injections = {
            "SKILL.md replace fails": patch("os.replace", side_effect=OSError("injected write failure")),
            "second script rename fails": patch.object(Path, "rename", fail_second_rename),
        }
        for label, injection in injections.items():
            calls["n"] = 0
            with self.subTest(label), tempfile.TemporaryDirectory() as temp:
                repo = Repo(Path(temp))
                (repo.skill / "SKILL.md").write_text(two_md, encoding="utf-8")
                (repo.skill / "scripts" / "second.js").write_text(FLOW.replace("demo-run", "second-run"), encoding="utf-8")
                with injection:
                    code, _, err = repo.register()
                self.assertEqual(code, REGISTER["EXIT_WORKFLOW"], err)
                self.assertFalse(repo.skill.is_symlink())
                self.assertEqual((repo.skill / "SKILL.md").read_text(encoding="utf-8"), two_md)
                self.assertEqual(sorted(p.name for p in (repo.skill / "scripts").iterdir()),
                                 ["flow.js", "helper.js", "second.js"])
                self.assertEqual(list((repo.plugins / "foo" / "workflows").glob("*")), [])
                code, report, err = repo.register("--update")
                self.assertEqual(code, REGISTER["EXIT_OK"], err)
                self.assertEqual(len(report["actions"]["workflow_scripts"]), 2)

    def test_skill_md_temp_file_is_written_outside_the_skill(self):
        seen = []

        def capture(src, dst):
            seen.append(Path(src))
            raise OSError("stop after capturing the temp path")

        with tempfile.TemporaryDirectory() as temp:
            repo = Repo(Path(temp))
            with patch("os.replace", side_effect=capture):
                code, _, err = repo.register()
            self.assertEqual(code, REGISTER["EXIT_WORKFLOW"], err)
            self.assertEqual(len(seen), 1)
            self.assertEqual(seen[0].parent.resolve(), repo.agents.resolve())
            self.assertFalse(seen[0].exists())
            self.assertEqual([p for p in repo.root.rglob("*.tmp")], [])

    def test_relocate_failure_after_move_converges_on_update(self):
        globals_ = REGISTER["main"].__globals__
        original = globals_["relocate_skill"]

        def broken(*args):
            raise OSError("injected relocate failure")

        with tempfile.TemporaryDirectory() as temp:
            repo = Repo(Path(temp))
            with patch.dict(globals_, relocate_skill=broken), self.assertRaises(OSError):
                repo.register()
            self.assertIs(globals_["relocate_skill"], original)
            self.assertFalse(repo.skill.is_symlink())
            code, report, err = repo.register("--update")
            self.assertEqual(code, REGISTER["EXIT_OK"], err)
            self.assertEqual(report["actions"]["workflow_scripts"], [])
            skill_dir = repo.plugins / "foo" / "skills" / "demo"
            self.assertTrue(repo.skill.is_symlink())
            self.assertTrue((repo.plugins / "foo" / "workflows" / "flow.js").is_file())
            self.assertEqual((skill_dir / "SKILL.md").read_text(encoding="utf-8"),
                             SKILL_MD.replace(CALLSITE, '  name: "foo:demo-run",\n'))

    def test_non_directory_workflows_path_stops_before_any_write(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Repo(Path(temp))
            (repo.plugins / "foo").mkdir()
            (repo.plugins / "foo" / "workflows").write_text("not a directory", encoding="utf-8")
            before = repo.snapshot()
            code, _, err = repo.register()
            self.assertEqual(code, REGISTER["EXIT_WORKFLOW"], err)
            self.assertEqual(repo.snapshot(), before)

    def test_broken_preconditions_stop_before_any_write(self):
        cases = {
            "meta.name equals a skill name": lambda r: (r.skill / "scripts" / "flow.js").write_text(
                FLOW.replace("demo-run", "demo"), encoding="utf-8"),
            "meta.name outside the runner name shape": lambda r: (r.skill / "scripts" / "flow.js").write_text(
                FLOW.replace("demo-run", "Demo_Run"), encoding="utf-8"),
            "callsite is not the single exact line": lambda r: (r.skill / "SKILL.md").write_text(
                SKILL_MD.replace(CALLSITE, '  scriptPath: "<abs>/scripts/flow.js",\n'), encoding="utf-8"),
            "callsite plus a loose mention": lambda r: (r.skill / "SKILL.md").write_text(
                SKILL_MD + "resume with the same scriptPath: scripts/flow.js\n", encoding="utf-8"),
            "another file refers to the old path": lambda r: (
                (r.skill / "references").mkdir(),
                (r.skill / "references" / "notes.md").write_text("see `scripts/flow.js`\n", encoding="utf-8")),
            "test imports the old relative path": lambda r: (r.skill / "scripts" / "flow.test.mjs").write_text(
                "new URL('./flow.js', import.meta.url)\n", encoding="utf-8"),
            "workflows file already exists": lambda r: (
                (r.plugins / "foo" / "workflows").mkdir(parents=True),
                (r.plugins / "foo" / "workflows" / "flow.js").write_text(
                    FLOW.replace("demo-run", "other-run"), encoding="utf-8")),
            "workflows meta.name already exists": lambda r: (
                (r.plugins / "foo" / "workflows").mkdir(parents=True),
                (r.plugins / "foo" / "workflows" / "other.js").write_text(FLOW, encoding="utf-8")),
        }
        for label, mutate in cases.items():
            with self.subTest(label), tempfile.TemporaryDirectory() as temp:
                repo = Repo(Path(temp))
                mutate(repo)
                before = repo.snapshot()
                code, _, err = repo.register()
                self.assertEqual(code, REGISTER["EXIT_WORKFLOW"], err)
                self.assertEqual(repo.snapshot(), before)
                self.assertFalse(repo.skill.is_symlink())


if __name__ == "__main__":
    unittest.main()
