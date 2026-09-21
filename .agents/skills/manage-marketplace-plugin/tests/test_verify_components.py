import json
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
VERIFY = runpy.run_path(str(SCRIPTS / "verify_install.py"))
HOOK_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"'
CODEX_COMMAND = 'python3 "${PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/scripts/gate.py"'


def hooks_config(command=HOOK_COMMAND, **extra):
    return {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": command}]}]}, **extra}


def inventory(skills=0, agents=0, hooks=0):
    return (f"Component inventory\n  Skills ({skills})\n  Agents ({agents})\n"
            f"  Hooks ({hooks})\n  MCP servers (0)\n  LSP servers (0)\n")


class L2ComponentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.enterContext(patch.dict(VERIFY["l2_bundle_check"].__globals__,
                                     PLUGINS_DIR=self.root))
        self.plugin = self.root / "demo"
        for host in ("claude", "codex"):
            self.write(f".{host}-plugin/plugin.json", json.dumps({"name": "demo"}))

    def write(self, rel, text=""):
        path = self.plugin / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def check(self):
        return VERIFY["l2_bundle_check"]("demo")

    def test_hook_only_plugin_passes(self):
        self.write("hooks/hooks.json", json.dumps(hooks_config()))
        self.write("scripts/gate.mjs")
        result = self.check()
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["components"], ["hooks"])

    def test_codex_shared_root_variable_is_resolved(self):
        self.write("hooks/hooks.json", json.dumps(hooks_config(CODEX_COMMAND)))
        self.write("scripts/gate.py")
        self.assertTrue(self.check()["passed"])

    def test_hook_referencing_missing_script_fails(self):
        self.write("hooks/hooks.json", json.dumps(hooks_config()))
        result = self.check()
        self.assertFalse(result["passed"])
        self.assertIn("scripts/gate.mjs", " ".join(result["findings"]))

    def test_hooks_json_extra_top_level_field_fails(self):
        self.write("hooks/hooks.json", json.dumps(hooks_config(description="x")))
        self.write("scripts/gate.mjs")
        result = self.check()
        self.assertFalse(result["passed"])
        self.assertEqual(result["findings"], [
            "hooks/hooks.json の top-level に hooks 以外のフィールドがある: "
            "['description']（Codex で hook 全体が無効になる）"])

    def test_hooks_json_without_handlers_fails(self):
        self.write("hooks/hooks.json", json.dumps({"hooks": {}}))
        result = self.check()
        self.assertFalse(result["passed"])
        self.assertEqual(result["findings"], ["hooks/hooks.json に hook が 1 つも無い"])

    def assert_command(self, command, findings):
        self.write("hooks/hooks.json", json.dumps(hooks_config(command)))
        self.assertEqual(self.check()["findings"], findings)

    def test_reference_ends_at_shell_metacharacters(self):
        self.write("scripts/a.sh")
        for command in ('${CLAUDE_PLUGIN_ROOT}/scripts/a.sh;true',
                        '${CLAUDE_PLUGIN_ROOT}/scripts/a.sh&&true',
                        '${CLAUDE_PLUGIN_ROOT}/scripts/a.sh|cat',
                        '${CLAUDE_PLUGIN_ROOT}/scripts/a.sh>out',
                        '${CLAUDE_PLUGIN_ROOT}/scripts/a.sh<in',
                        '(${CLAUDE_PLUGIN_ROOT}/scripts/a.sh)'):
            with self.subTest(command=command):
                self.assert_command(command, [])

    def test_unbraced_reference_is_checked(self):
        self.assert_command("$CLAUDE_PLUGIN_ROOT/scripts/x.sh", [
            "hooks/hooks.json の Stop が参照する同梱ファイルが無い: scripts/x.sh"])
        self.write("scripts/x.sh")
        self.assert_command("$CLAUDE_PLUGIN_ROOT/scripts/x.sh", [])

    def test_reference_outside_plugin_root_fails(self):
        (self.root / "outside.sh").write_text("")
        self.assert_command("${CLAUDE_PLUGIN_ROOT}/../outside.sh", [
            "hooks/hooks.json の Stop が plugin root 外を参照している: ../outside.sh"])

    def test_directory_reference_passes_when_present(self):
        command = 'PYTHONPATH=${CLAUDE_PLUGIN_ROOT}/lib python3 -m gate'
        self.assert_command(command, [
            "hooks/hooks.json の Stop が参照する同梱ファイルが無い: lib"])
        self.write("lib/gate.py")
        self.assert_command(command, [])
        self.assertIn("lib", VERIFY["plugin_components"]("demo")[0]["hooks"])

    def test_manifest_declared_hooks_path_is_validated(self):
        self.write(".claude-plugin/plugin.json",
                   json.dumps({"name": "demo", "hooks": "./config/hooks.json"}))
        self.write(".codex-plugin/plugin.json",
                   json.dumps({"name": "demo", "hooks": "./config/hooks.json"}))
        self.assertFalse(self.check()["passed"])
        self.write("config/hooks.json", json.dumps(hooks_config()))
        self.write("scripts/gate.mjs")
        self.assertTrue(self.check()["passed"])

    def test_plugin_without_components_fails(self):
        self.write("README.md", "demo")
        result = self.check()
        self.assertFalse(result["passed"])
        self.assertIn("配布コンポーネントが無い", " ".join(result["findings"]))

    def test_skill_plugin_unchanged(self):
        self.write("skills/demo/SKILL.md", "---\nname: demo\ndescription: demo\n---\n")
        self.assertTrue(self.check()["passed"])
        self.write("skills/broken/README.md")
        result = self.check()
        self.assertFalse(result["passed"])
        self.assertIn("skills/broken/SKILL.md が無い", result["findings"])


class L3ComponentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.installed = Path(temp.name)
        self.check = VERIFY["l3_component_check"]

    def write(self, rel):
        path = self.installed / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")

    def test_hook_only_install_passes_when_assets_and_inventory_match(self):
        self.write("hooks/hooks.json")
        self.write("scripts/gate.mjs")
        components = {"hooks": ["hooks/hooks.json", "scripts/gate.mjs"]}
        self.assertTrue(self.check(self.installed, components, 0, inventory(hooks=1))["passed"])

    def test_hook_only_install_fails_when_hooks_not_recognized(self):
        self.write("hooks/hooks.json")
        self.write("scripts/gate.mjs")
        components = {"hooks": ["hooks/hooks.json", "scripts/gate.mjs"]}
        result = self.check(self.installed, components, 0, inventory(hooks=0))
        self.assertFalse(result["details_ok"])
        self.assertFalse(result["passed"])

    def test_hook_script_missing_from_install_fails(self):
        self.write("hooks/hooks.json")
        components = {"hooks": ["hooks/hooks.json", "scripts/gate.mjs"]}
        result = self.check(self.installed, components, 0, inventory(hooks=1))
        self.assertFalse(result["hooks"]["scripts/gate.mjs"])
        self.assertFalse(result["passed"])

    def test_skill_install_requires_skill_md_and_recognition(self):
        self.write("skills/demo/SKILL.md")
        components = {"skills": ["skills/demo"]}
        self.assertTrue(self.check(self.installed, components, 0, inventory(skills=1))["passed"])
        self.assertFalse(self.check(self.installed, components, 0, inventory(skills=0))["passed"])
        self.assertFalse(self.check(self.installed, {"skills": ["skills/other"]}, 0,
                                    inventory(skills=1))["passed"])

    def test_directory_hook_asset_is_verified(self):
        self.write("hooks/hooks.json")
        self.write("lib/gate.py")
        components = {"hooks": ["hooks/hooks.json", "lib"]}
        self.assertTrue(self.check(self.installed, components, 0, inventory(hooks=1))["passed"])
        self.assertFalse(self.check(self.installed, {"hooks": ["hooks/hooks.json", "missing"]},
                                    0, inventory(hooks=1))["passed"])

    def test_nothing_shipped_or_not_installed_fails(self):
        self.assertFalse(self.check(self.installed, {}, 0, inventory())["passed"])
        self.assertEqual(self.check(None, {"hooks": ["hooks/hooks.json"]}, 0, inventory(hooks=1)),
                         {"passed": False, "installed_root": None})


if __name__ == "__main__":
    unittest.main()
