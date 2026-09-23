import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from path_safety import (ensure_within, find_project_root, guard_plugin_root,
                         guard_skill_root, guard_tree, validate_name)


class PathSafetyTests(unittest.TestCase):
    def test_project_root_is_found_from_published_skill_layout(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "repo"
            script_dir = checkout / "plugins" / "workflow" / "skills" / "manage" / "scripts"
            script_dir.mkdir(parents=True)
            (checkout / ".claude-plugin").mkdir()
            (checkout / ".claude-plugin" / "marketplace.json").write_text("{}")
            (checkout / "plugins").mkdir(exist_ok=True)
            self.assertEqual(find_project_root(script_dir), checkout.resolve())

    def test_skill_root_only_allows_source_or_matching_published_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "repo"
            agents = checkout / ".agents" / "skills"
            plugins = checkout / "plugins"
            target = plugins / "demo" / "skills" / "demo"
            target.mkdir(parents=True)
            agents.mkdir(parents=True)
            (agents / "demo").symlink_to(target, target_is_directory=True)
            guard_skill_root(agents / "demo", agents, plugins, checkout)

            other = checkout / "unrelated" / "demo"
            other.mkdir(parents=True)
            (agents / "demo").unlink()
            (agents / "demo").symlink_to(other, target_is_directory=True)
            with self.assertRaises(ValueError):
                guard_skill_root(agents / "demo", agents, plugins, checkout)

    def test_plugin_root_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "repo"
            plugins = checkout / "plugins"
            plugins.mkdir(parents=True)
            external = Path(temp) / "external"
            external.mkdir()
            (plugins / "demo").symlink_to(external, target_is_directory=True)
            with self.assertRaises(ValueError):
                guard_plugin_root(plugins / "demo", plugins, checkout)

    def test_rejects_traversal_absolute_and_separators(self):
        for value in ("../outside", "/tmp/outside", "a/b", r"a\b", ".."):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_name(value, "skill")

    def test_accepts_existing_kebab_case_names(self):
        for value in ("review-document", "pr-review-fix", "dynamic-workflow-runner"):
            self.assertEqual(validate_name(value, "skill"), value)

    def test_rejects_allowed_root_symlink_outside_checkout(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "checkout"
            outside = Path(temp) / "outside"
            checkout.mkdir()
            outside.mkdir()
            root = checkout / ".agents" / "skills"
            root.parent.mkdir()
            root.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                ensure_within(root, root, checkout)

    def test_full_tree_guard_rejects_symlink_escape_before_read(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "checkout"
            outside = Path(temp) / "outside"
            root = checkout / ".agents" / "skills"
            root.mkdir(parents=True)
            outside.mkdir()
            marker = outside / "secret.md"
            marker.write_text("must not be read")
            (root / "escape.md").symlink_to(marker)
            with self.assertRaises(ValueError):
                guard_tree(root, [root], checkout)

    def test_contained_corpus_symlink_is_allowed(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "checkout"
            root = checkout / ".agents" / "skills"
            target = checkout / "plugins" / "demo" / "skills" / "demo"
            target.mkdir(parents=True)
            root.mkdir(parents=True)
            (root / "demo").symlink_to(target, target_is_directory=True)
            guard_tree(root, [root, checkout / "plugins"], checkout)

    def test_skill_tree_rejects_symlink_to_another_plugin_inside_checkout(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "checkout"
            skill = checkout / "plugins" / "one" / "skills" / "one"
            other = checkout / "plugins" / "two" / "skills" / "two"
            skill.mkdir(parents=True)
            other.mkdir(parents=True)
            (other / "secret.md").write_text("must not be read")
            (skill / "included.md").symlink_to(other / "secret.md")
            with self.assertRaises(ValueError):
                guard_tree(skill, [skill], checkout)

    def test_plugin_verification_mode_rejects_even_contained_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "checkout"
            root = checkout / "plugins" / "demo"
            root.mkdir(parents=True)
            target = root / "real.txt"
            target.write_text("data")
            (root / "link.txt").symlink_to(target)
            with self.assertRaises(ValueError):
                guard_tree(root, [checkout / "plugins"], checkout, reject_symlinks=True)

    def test_cli_entrypoints_reject_traversal_before_filesystem_lookup(self):
        for script, option in (("check_portability.py", "--skill"),
                               ("detect_dependencies.py", "--skill"),
                               ("check_references.py", "--skill"),
                               ("verify_install.py", "--plugin")):
            with self.subTest(script=script):
                result = subprocess.run(
                    [sys.executable, str(SCRIPTS / script), option, "../outside"],
                    capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 5)


if __name__ == "__main__":
    unittest.main()
