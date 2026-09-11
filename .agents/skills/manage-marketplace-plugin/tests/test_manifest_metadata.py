import json
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
REGISTER = runpy.run_path(str(SCRIPTS / "register_plugin.py"))
VERIFY = runpy.run_path(str(SCRIPTS / "verify_install.py"))


class ManifestMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.writer = REGISTER["write_plugin_files"]
        self.check = VERIFY["l2_bundle_check"]
        for function in (self.writer, self.check, VERIFY["skill_entries"]):
            self.enterContext(patch.dict(function.__globals__, PLUGINS_DIR=self.root))
        skill = self.root / "demo" / "skills" / "demo"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: demo\ndescription: demo\n---\n")

    def write(self, version="0.1.0"):
        self.writer("demo", "demo", "demo", version, "author", "description",
                    dependencies=["other"])

    def path(self, host):
        return self.root / "demo" / f".{host}-plugin" / "plugin.json"

    def read(self, host):
        return json.loads(self.path(host).read_text())

    def mutate(self, host, key, value):
        data = self.read(host)
        data[key] = value
        self.path(host).write_text(json.dumps(data))

    def test_new_manifests_separate_host_fields(self):
        self.write()
        claude, codex = self.read("claude"), self.read("codex")
        self.assertNotIn("interface", claude)
        self.assertNotIn("dependencies", codex)
        self.assertEqual(codex["interface"]["developerName"], "author")
        self.assertTrue(self.check("demo")["passed"])

    def test_update_preserves_custom_ui(self):
        self.write()
        custom = self.read("codex")["interface"] | {"displayName": "Custom", "brandColor": "#123456"}
        self.mutate("codex", "interface", custom)
        self.write("0.1.1")
        self.assertEqual(self.read("codex")["interface"], custom)
        self.assertEqual(self.read("codex")["version"], "0.1.1")
        self.assertTrue(self.check("demo")["passed"])

    def test_legacy_manifest_upgraded_on_registration(self):
        self.write()
        data = self.read("codex")
        del data["interface"]
        self.path("codex").write_text(json.dumps(data))
        self.assertTrue(self.check("demo")["passed"])
        self.write()
        self.assertIsInstance(self.read("codex")["interface"], dict)

    def test_common_field_drift_still_fails(self):
        self.write()
        self.mutate("codex", "version", "9.0.0")
        self.assertFalse(self.check("demo")["passed"])

    def test_wrong_host_fields_fail(self):
        for host, key, value in [("claude", "interface", {}), ("codex", "dependencies", ["other"])]:
            with self.subTest(host=host):
                self.write()
                self.mutate(host, key, value)
                self.assertFalse(self.check("demo")["passed"])

    def test_invalid_existing_ui_does_not_overwrite_manifests(self):
        self.write()
        self.mutate("codex", "interface", None)
        before = {host: self.path(host).read_bytes() for host in ("claude", "codex")}
        with self.assertRaises(ValueError):
            self.write("0.1.1")
        self.assertEqual(before, {host: self.path(host).read_bytes() for host in before})
        self.assertFalse(self.check("demo")["passed"])


if __name__ == "__main__":
    unittest.main()
