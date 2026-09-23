import json
import runpy
import tempfile
import unittest
import contextlib
import io
import sys
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
REGISTER = runpy.run_path(str(SCRIPTS / "register_plugin.py"))
PORTABILITY = runpy.run_path(str(SCRIPTS / "check_portability.py"))
REFERENCES = runpy.run_path(str(SCRIPTS / "check_references.py"))


class MarketplaceSafetyTests(unittest.TestCase):
    def test_relocation_preflight_rejects_contained_source_symlinks(self):
        preflight = REGISTER["preflight_relocations"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            agents = root / ".agents" / "skills"
            plugins = root / "plugins"
            source = agents / "demo"
            source.mkdir(parents=True)
            (source / "SKILL.md").write_text("---\nname: demo\ndescription: Demo\n---\n")
            (source / "real.md").write_text("data")
            (source / "included.md").symlink_to(source / "real.md")
            with patch.dict(preflight.__globals__, AGENTS_SKILLS_DIR=agents,
                            PLUGINS_DIR=plugins, PROJECT_ROOT=root):
                with self.assertRaises(SystemExit) as raised:
                    preflight("demo", [("demo", "demo")])
            self.assertEqual(raised.exception.code, REGISTER["EXIT_CONFLICT"])

    def test_portability_remediation_copies_script_instead_of_symlinking(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            skills = root / ".agents" / "skills"
            skill = skills / "demo"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("run scripts/shared.sh\n")
            (root / "scripts").mkdir()
            (root / "scripts" / "shared.sh").write_text("#!/bin/sh\n")
            with patch.dict(PORTABILITY["detect"].__globals__,
                            SKILLS_DIR=skills, PROJECT_ROOT=root):
                report = PORTABILITY["detect"]("demo")
            self.assertIn("コピーして同梱", report["findings"][0]["remediation"])
            self.assertNotIn("symlink", report["findings"][0]["remediation"])

    def test_register_rejects_plugin_root_symlink_before_any_write(self):
        globals_ = REGISTER["main"].__globals__
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            agents = root / ".agents" / "skills"
            plugins = root / "plugins"
            source = agents / "demo"
            source.mkdir(parents=True)
            (source / "SKILL.md").write_text("---\nname: demo\ndescription: Demo\n---\n")
            real_plugin = plugins / "bar"
            (real_plugin / ".claude-plugin").mkdir(parents=True)
            (real_plugin / ".codex-plugin").mkdir()
            (real_plugin / ".claude-plugin" / "plugin.json").write_text("{}")
            (real_plugin / ".codex-plugin" / "plugin.json").write_text("{}")
            (plugins / "foo").symlink_to(real_plugin, target_is_directory=True)
            claude = root / ".claude-plugin" / "marketplace.json"
            claude.parent.mkdir()
            claude.write_text(json.dumps({"name": "test", "plugins": []}))
            codex = root / ".agents" / "plugins" / "marketplace.json"
            codex.parent.mkdir(parents=True)
            codex.write_text(json.dumps({"name": "test", "interface": {"displayName": "Test"},
                                         "plugins": []}))
            protected = [claude, codex, real_plugin / ".claude-plugin" / "plugin.json",
                         real_plugin / ".codex-plugin" / "plugin.json"]
            before = {path: path.read_bytes() for path in protected}
            with patch.dict(globals_, PROJECT_ROOT=root, AGENTS_SKILLS_DIR=agents,
                            PLUGINS_DIR=plugins, MARKETPLACE_PATH=claude,
                            CODEX_MARKETPLACE_PATH=codex), \
                    patch.object(sys, "argv", ["register_plugin.py", "--skill", "demo",
                                                "--plugin", "foo"]), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    REGISTER["main"]()
            self.assertEqual(raised.exception.code, REGISTER["EXIT_INVALID"])
            self.assertEqual({path: path.read_bytes() for path in protected}, before)


    def test_plugin_name_rejects_path_traversal_and_separators(self):
        validate = REGISTER["validate_plugin_name"]
        for name in ("../escape", "/tmp/escape", "group/plugin", r"group\plugin", ".."):
            with self.subTest(name=name), self.assertRaises(SystemExit) as raised:
                validate(name)
            self.assertEqual(raised.exception.code, REGISTER["EXIT_INVALID"])

    def test_plugin_name_accepts_lowercase_kebab_case(self):
        validate = REGISTER["validate_plugin_name"]
        self.assertEqual(validate("claim-gate"), "claim-gate")

    def test_skill_bundle_and_as_names_reject_traversal(self):
        validate = REGISTER["validate_skill_dir_name"]
        for option in ("--skill", "--bundle-skill", "--as"):
            with self.subTest(option=option), self.assertRaises(SystemExit) as raised:
                validate("../escape", option)
            self.assertEqual(raised.exception.code, REGISTER["EXIT_INVALID"])

    def test_existing_skill_directory_names_remain_valid(self):
        validate = REGISTER["validate_skill_dir_name"]
        for name in ("review-document", "pr-review-fix", "dynamic-workflow-runner"):
            with self.subTest(name=name):
                self.assertEqual(validate(name), name)

    def test_resolved_skill_path_must_remain_within_allowed_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "skills"
            outside = Path(temp) / "outside"
            root.mkdir()
            outside.mkdir()
            (root / "escape").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(SystemExit) as raised:
                REGISTER["ensure_path_within"](root / "escape" / "skill", [root], "skill")
            self.assertEqual(raised.exception.code, REGISTER["EXIT_INVALID"])

    def test_claude_entry_update_preserves_unknown_fields(self):
        data = {"plugins": [{"name": "claim-gate", "source": "old", "custom": {"keep": True}}]}
        action = REGISTER["merge_marketplace_entry"](data, "claim-gate", update=True)
        self.assertEqual(action, "updated")
        self.assertEqual(data["plugins"][0], {
            "name": "claim-gate",
            "source": "./plugins/claim-gate",
            "custom": {"keep": True},
        })

    def test_codex_catalog_rejects_unvalidated_source_name(self):
        data = {"plugins": []}
        claude = {"plugins": [{"name": "../escape", "source": "./plugins/../escape"}]}
        with self.assertRaises(SystemExit) as raised:
            REGISTER["merge_codex_catalog"](data, claude)
        self.assertEqual(raised.exception.code, REGISTER["EXIT_INVALID"])

    def test_codex_source_uses_validated_plugin_name(self):
        data = {"plugins": []}
        claude = {"plugins": [{"name": "claim-gate", "source": "./plugins/claim-gate"}]}
        REGISTER["merge_codex_catalog"](data, claude)
        self.assertEqual(data["plugins"][0]["source"], {
            "source": "local",
            "path": "./plugins/claim-gate",
        })

    def test_codex_catalog_rejects_unknown_non_local_source_types(self):
        load = REGISTER["load_codex_marketplace"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / ".agents" / "plugins" / "marketplace.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"name": "test", "interface": {"displayName": "Test"},
                                        "plugins": [{"name": "external", "source": {
                                            "source": "unknown", "url": "https://example.test"},
                                            "policy": {"installation": "AVAILABLE",
                                                       "authentication": "ON_INSTALL"},
                                            "category": "Productivity"}]}))
            with patch.dict(load.__globals__, CODEX_MARKETPLACE_PATH=path, PROJECT_ROOT=root):
                with self.assertRaises(SystemExit) as raised:
                    load()
            self.assertEqual(raised.exception.code, REGISTER["EXIT_CORRUPT"])

    def test_codex_catalog_accepts_official_source_forms_and_preserves_entries(self):
        load = REGISTER["load_codex_marketplace"]
        sources = ["./plugins/local", {"source": "local", "path": "./plugins/local"},
                   {"source": "url", "url": "https://github.com/example/plugin.git"},
                   {"source": "git-subdir", "url": "https://github.com/example/repo.git",
                    "path": "./plugins/demo", "ref": "main", "sha": "abc123"},
                   {"source": "npm", "package": "@example/plugin", "version": "1.2.3",
                    "registry": "https://registry.npmjs.org"}]
        entries = [{"name": f"entry-{i}", "source": source,
                    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                    "category": "Productivity"} for i, source in enumerate(sources)]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "marketplace.json"
            original = {"name": "test", "interface": {"displayName": "Test"}, "plugins": entries}
            path.write_text(json.dumps(original))
            with patch.dict(load.__globals__, CODEX_MARKETPLACE_PATH=path,
                            PROJECT_ROOT=Path(temp)):
                loaded, _ = load()
            self.assertEqual(loaded["plugins"], entries)

    def test_codex_catalog_rejects_broken_official_source_forms(self):
        load = REGISTER["load_codex_marketplace"]
        sources = [{"source": "url", "url": "bad"},
                   {"source": "url", "url": "https://bad_host.test/plugin"},
                   {"source": "url", "url": "https://example.test:/plugin"},
                   {"source": "url", "url": "https://[invalid-ipv6]/plugin"},
                   {"source": "git-subdir", "url": "https://example.test/repo.git", "path": "../escape"},
                   {"source": "npm"},
                   {"source": "npm", "package": "demo", "registry": "http://registry.npmjs.org"},
                   {"source": "npm", "package": "demo", "registry": "https://user@registry.npmjs.org"},
                   {"source": "npm", "package": "demo", "registry": "https://registry.npmjs.org?token=x"},
                   {"source": "npm", "package": "demo", "registry": "https://registry.npmjs.org#fragment"},
                   {"source": "npm", "package": "demo", "registry": "https://bad host.test"},
                   {"source": "npm", "package": "demo", "registry": "https://registry.npmjs.org:bad"},
                   {"source": "npm", "package": "demo", "registry": "https://registry.npmjs.org:"},
                   {"source": "npm", "package": "demo", "registry": "https://bad_host.test"},
                   {"source": "npm", "package": "demo", "registry": "https://@registry.npmjs.org"},
                   {"source": "npm", "package": "demo", "registry": "https://[invalid"}]
        for source in sources:
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "marketplace.json"
                path.write_text(json.dumps({"name": "test", "interface": {"displayName": "Test"},
                    "plugins": [{"name": "external", "source": source,
                        "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                        "category": "Productivity"}]}))
                with patch.dict(load.__globals__, CODEX_MARKETPLACE_PATH=path,
                                PROJECT_ROOT=Path(temp)):
                    stderr = io.StringIO()
                    with contextlib.redirect_stderr(stderr):
                        with self.assertRaises(SystemExit) as raised:
                            load()
                self.assertEqual(raised.exception.code, REGISTER["EXIT_CORRUPT"])
                self.assertNotIn("Traceback", stderr.getvalue())

    def test_codex_catalog_fills_missing_policy_and_category_without_dropping_entries(self):
        load = REGISTER["load_codex_marketplace"]
        merge = REGISTER["merge_codex_catalog"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            catalog = root / ".agents" / "plugins" / "marketplace.json"
            catalog.parent.mkdir(parents=True)
            catalog.write_text(json.dumps({"name": "test", "interface": {"displayName": "Test"},
                "plugins": [{"name": "codex-only", "source": "./plugins/codex-only"},
                            {"name": "synced", "source": "./plugins/synced"}]}))
            with patch.dict(load.__globals__, CODEX_MARKETPLACE_PATH=catalog,
                            PLUGINS_DIR=root / "plugins", PROJECT_ROOT=root):
                data, _ = load()
                merge(data, {"plugins": [{"name": "synced", "source": "./plugins/synced"}]})
            by_name = {entry["name"]: entry for entry in data["plugins"]}
            self.assertIn("codex-only", by_name)
            for entry in by_name.values():
                self.assertEqual(entry["policy"], {
                    "installation": "AVAILABLE", "authentication": "ON_INSTALL"})
                self.assertEqual(entry["category"], "Productivity")

    def test_codex_target_category_comes_from_manifest_before_default(self):
        load = REGISTER["load_codex_marketplace"]
        merge = REGISTER["merge_codex_catalog"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            catalog = root / ".agents" / "plugins" / "marketplace.json"
            catalog.parent.mkdir(parents=True)
            catalog.write_text(json.dumps({"name": "test", "interface": {"displayName": "Test"},
                "plugins": [{"name": "codex-only", "source": "./plugins/codex-only"},
                            {"name": "synced", "source": "./plugins/synced"}]}))
            manifest = root / "plugins" / "synced" / ".codex-plugin" / "plugin.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({"interface": {"category": "Developer tools"}}))
            with patch.dict(load.__globals__, CODEX_MARKETPLACE_PATH=catalog,
                            PLUGINS_DIR=root / "plugins", PROJECT_ROOT=root):
                data, _ = load()
                self.assertNotIn("category", data["plugins"][1])
                merge(data, {"plugins": [{"name": "synced", "source": "./plugins/synced"}]})
            by_name = {entry["name"]: entry for entry in data["plugins"]}
            self.assertEqual(by_name["synced"]["category"], "Developer tools")
            self.assertEqual(by_name["codex-only"]["category"], "Productivity")

    def test_catalog_symlinks_are_rejected_before_read_or_write(self):
        cases = (("load_marketplace", "MARKETPLACE_PATH", (".claude-plugin", "marketplace.json")),
                 ("load_codex_marketplace", "CODEX_MARKETPLACE_PATH",
                  (".agents", "plugins", "marketplace.json")))
        for function_name, path_name, path_parts in cases:
            load = REGISTER[function_name]
            for target_kind in ("external", "internal"):
                with self.subTest(catalog=path_name, target_kind=target_kind), \
                        tempfile.TemporaryDirectory() as temp:
                    temp_root = Path(temp)
                    root = temp_root / "repo"
                    root.mkdir()
                    catalog = root.joinpath(*path_parts)
                    catalog.parent.mkdir(parents=True)
                    target = root / "target.json" if target_kind == "internal" else temp_root / "target.json"
                    target.write_text("protected")
                    catalog.symlink_to(target)
                    before = target.read_bytes()
                    with patch.dict(load.__globals__, **{path_name: catalog}, PROJECT_ROOT=root):
                        with self.assertRaises(SystemExit) as raised:
                            load()
                    self.assertEqual(raised.exception.code, REGISTER["EXIT_INVALID"])
                    self.assertEqual(target.read_bytes(), before)

    def test_reference_owner_scan_rejects_plugin_and_skills_root_symlinks(self):
        owning = REFERENCES["owning_plugin_skills_dir"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plugins = root / "plugins"
            actual = plugins / "actual"
            (actual / "skills" / "demo").mkdir(parents=True)
            (actual / "skills" / "demo" / "SKILL.md").write_text("demo")
            (plugins / "alias").symlink_to(actual, target_is_directory=True)
            with patch.dict(REFERENCES["owning_plugin_skills_dir"].__globals__,
                            PLUGINS_DIR=plugins, PROJECT_ROOT=root):
                with self.assertRaises(ValueError):
                    owning("demo")
            (plugins / "alias").unlink()
            (actual / "skills").rename(actual / "real-skills")
            (actual / "skills").symlink_to(actual / "real-skills", target_is_directory=True)
            with patch.dict(REFERENCES["owning_plugin_skills_dir"].__globals__,
                            PLUGINS_DIR=plugins, PROJECT_ROOT=root):
                with self.assertRaises(ValueError):
                    owning("demo")

    def test_codex_catalog_parent_symlink_is_rejected(self):
        cases = (("load_marketplace", "MARKETPLACE_PATH", ".claude-plugin"),
                 ("load_codex_marketplace", "CODEX_MARKETPLACE_PATH", ".agents/plugins"))
        for function_name, path_name, parent_rel in cases:
            load = REGISTER[function_name]
            with self.subTest(catalog=path_name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                parent = root / parent_rel
                parent.parent.mkdir(parents=True, exist_ok=True)
                target_dir = root / "catalogs"
                target_dir.mkdir()
                (target_dir / "marketplace.json").write_text("protected")
                parent.symlink_to(target_dir, target_is_directory=True)
                catalog = parent / "marketplace.json"
                with patch.dict(load.__globals__, **{path_name: catalog}, PROJECT_ROOT=root):
                    with self.assertRaises(SystemExit) as raised:
                        load()
                self.assertEqual(raised.exception.code, REGISTER["EXIT_INVALID"])
                self.assertEqual((target_dir / "marketplace.json").read_text(), "protected")

    def test_non_directory_catalog_parent_fails_before_claude_catalog_changes(self):
        globals_ = REGISTER["main"].__globals__
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            agents = root / ".agents" / "skills"
            source = agents / "demo"
            source.mkdir(parents=True)
            (source / "SKILL.md").write_text("---\nname: demo\ndescription: Demo\n---\n")
            claude = root / ".claude-plugin" / "marketplace.json"
            claude.parent.mkdir()
            claude.write_text(json.dumps({"name": "test", "plugins": []}))
            before = claude.read_bytes()
            (root / ".agents" / "plugins").write_text("not a directory")
            with patch.dict(globals_, PROJECT_ROOT=root, AGENTS_SKILLS_DIR=agents,
                            PLUGINS_DIR=root / "plugins", MARKETPLACE_PATH=claude,
                            CODEX_MARKETPLACE_PATH=root / ".agents" / "plugins" / "marketplace.json"), \
                    patch.object(sys, "argv", ["register_plugin.py", "--skill", "demo"]), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    REGISTER["main"]()
            self.assertEqual(raised.exception.code, REGISTER["EXIT_INVALID"])
            self.assertEqual(claude.read_bytes(), before)

    def test_main_duplicate_relocation_destination_leaves_catalogs_and_manifests_unchanged(self):
        globals_ = REGISTER["main"].__globals__
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            agents = root / ".agents" / "skills"
            plugins = root / "plugins"
            source = agents / "demo"
            bundled_source = agents / "other"
            dest = plugins / "demo" / "skills" / "demo"
            (source).mkdir(parents=True)
            (source / "SKILL.md").write_text("---\\nname: demo\\ndescription: Demo\\n---\\n")
            bundled_source.mkdir(parents=True)
            (bundled_source / "SKILL.md").write_text("---\\nname: other\\ndescription: Other\\n---\\n")
            dest.mkdir(parents=True)
            (dest / "SKILL.md").write_text("---\\nname: demo\\ndescription: Demo\\n---\\n")
            (plugins / "demo" / ".claude-plugin").mkdir(parents=True)
            (plugins / "demo" / ".codex-plugin").mkdir()
            (plugins / "demo" / ".claude-plugin" / "plugin.json").write_text("{}")
            (plugins / "demo" / ".codex-plugin" / "plugin.json").write_text(
                json.dumps({"interface": {"category": "Productivity"}}))
            claude = root / ".claude-plugin" / "marketplace.json"
            claude.parent.mkdir()
            claude.write_text(json.dumps({"name": "test", "plugins": [
                {"name": "demo", "source": "./plugins/demo"}]}))
            codex = root / ".agents" / "plugins" / "marketplace.json"
            codex.parent.mkdir()
            codex.write_text(json.dumps({"name": "test", "interface": {"displayName": "Test"},
                "plugins": [{"name": "demo", "source": {"source": "local", "path": "./plugins/demo"},
                    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                    "category": "Productivity"}]}))
            before = {path: path.read_bytes() for path in (claude, codex,
                plugins / "demo" / ".claude-plugin" / "plugin.json",
                plugins / "demo" / ".codex-plugin" / "plugin.json")}
            with patch.dict(globals_, PROJECT_ROOT=root, AGENTS_SKILLS_DIR=agents,
                            PLUGINS_DIR=plugins, MARKETPLACE_PATH=claude,
                            CODEX_MARKETPLACE_PATH=codex), \
                    patch.object(sys, "argv", ["register_plugin.py", "--skill", "demo",
                                                 "--plugin", "demo", "--as", "other",
                                                 "--bundle-skill", "other", "--update"]), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    REGISTER["main"]()
            self.assertEqual(raised.exception.code, REGISTER["EXIT_CONFLICT"])
            self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_existing_plugin_symlink_fails_before_catalog_or_manifest_writes(self):
        globals_ = REGISTER["main"].__globals__
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            agents = root / ".agents" / "skills"
            plugins = root / "plugins"
            source = agents / "demo"
            source.mkdir(parents=True)
            (source / "SKILL.md").write_text("---\\nname: demo\\ndescription: Demo\\n---\\n")
            plugin = plugins / "demo"
            (plugin / ".claude-plugin").mkdir(parents=True)
            (plugin / ".codex-plugin").mkdir()
            (plugin / ".claude-plugin" / "plugin.json").write_text("{}")
            (plugin / ".codex-plugin" / "plugin.json").write_text(
                json.dumps({"interface": {"category": "Productivity"}}))
            outside = root / "outside.txt"
            outside.write_text("outside")
            (plugin / "escape.txt").symlink_to(outside)
            claude = root / ".claude-plugin" / "marketplace.json"
            claude.parent.mkdir()
            claude.write_text(json.dumps({"name": "test", "plugins": []}))
            codex = root / ".agents" / "plugins" / "marketplace.json"
            codex.parent.mkdir()
            codex.write_text(json.dumps({"name": "test", "interface": {"displayName": "Test"},
                                        "plugins": []}))
            manifests = [plugin / ".claude-plugin" / "plugin.json",
                         plugin / ".codex-plugin" / "plugin.json"]
            before = {path: path.read_bytes() for path in [claude, codex, *manifests]}
            with patch.dict(globals_, PROJECT_ROOT=root, AGENTS_SKILLS_DIR=agents,
                            PLUGINS_DIR=plugins, MARKETPLACE_PATH=claude,
                            CODEX_MARKETPLACE_PATH=codex), \
                    patch.object(sys, "argv", ["register_plugin.py", "--skill", "demo",
                                                 "--plugin", "demo"]), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    REGISTER["main"]()
            self.assertEqual(raised.exception.code, REGISTER["EXIT_CONFLICT"])
            self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_plugin_dependencies_are_ordered_union(self):
        write = REGISTER["write_plugin_files"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plugin = root / "plugins" / "claim-gate"
            (plugin / ".claude-plugin").mkdir(parents=True)
            (plugin / ".codex-plugin").mkdir()
            (plugin / ".claude-plugin" / "plugin.json").write_text(json.dumps({
                "dependencies": ["research", "workflow"]
            }))
            (plugin / ".codex-plugin" / "plugin.json").write_text(json.dumps({
                "interface": {"displayName": "Claim Gate"}
            }))
            globals_ = write.__globals__
            with patch.dict(globals_, PLUGINS_DIR=root / "plugins", PROJECT_ROOT=root):
                write("claim-gate", "claim", "claim", "0.1.0", "yoshiysh", "",
                      dependencies=["workflow", "skill-creator"])
            result = json.loads((plugin / ".claude-plugin" / "plugin.json").read_text())
            self.assertEqual(result["dependencies"], ["research", "workflow", "skill-creator"])

    def test_manifest_preflight_rejects_invalid_codex_interface_before_writes(self):
        preflight = REGISTER["preflight_plugin_inputs"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plugin = root / "plugins" / "claim-gate"
            manifest = plugin / ".codex-plugin" / "plugin.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({"interface": []}))
            with patch.dict(preflight.__globals__, PLUGINS_DIR=root / "plugins", PROJECT_ROOT=root):
                with self.assertRaises(ValueError):
                    preflight("claim-gate")
            self.assertFalse((root / ".claude-plugin" / "marketplace.json").exists())

    def test_claude_catalog_rejects_duplicate_plugin_names(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "marketplace.json"
            path.write_text(json.dumps({"plugins": [
                {"name": "claim-gate", "source": "./plugins/claim-gate"},
                {"name": "claim-gate", "source": "./plugins/claim-gate"},
            ]}))
            load = REGISTER["load_marketplace"]
            with patch.dict(load.__globals__, MARKETPLACE_PATH=path,
                            PROJECT_ROOT=path.parent, PLUGINS_DIR=path.parent / "plugins"):
                with self.assertRaises(SystemExit) as raised:
                    load()
            self.assertEqual(raised.exception.code, REGISTER["EXIT_CORRUPT"])


if __name__ == "__main__":
    unittest.main()
