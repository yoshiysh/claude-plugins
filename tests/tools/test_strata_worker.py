from __future__ import annotations

import tempfile
import unittest
import importlib.util
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
WORKER_PATH = REPO_ROOT / "tools" / "strata-worker"
MCP_PATH = REPO_ROOT / "tools" / "strata-mcp"

def _load_module(name: str, path: Path):
    loader = SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod

strata_worker = _load_module("strata_worker", WORKER_PATH)
strata_mcp = _load_module("strata_mcp", MCP_PATH)


class TestStrataWorker(unittest.TestCase):
    def test_personas_structure(self):
        self.assertEqual(
            set(strata_worker.PERSONAS.keys()),
            {
                "test-gen",
                "test-review",
                "code-gen",
                "code-review",
                "doc-gen",
                "doc-review",
            },
        )
        for name, p in strata_worker.PERSONAS.items():
            self.assertIn("title", p)
            self.assertIn("temperature", p)
            self.assertIn("is_review", p)
            self.assertIn("system", p)
            self.assertGreater(len(p["system"]), 50)

    def test_clean_markdown_fences(self):
        # Outer fences should be stripped
        self.assertEqual(strata_worker.clean_markdown_fences("```python\nprint(1)\n```"), "print(1)")
        self.assertEqual(strata_worker.clean_markdown_fences("```\nhello\nworld\n```"), "hello\nworld")

        # Inner fences should be preserved
        mixed = "```markdown\n# Doc\n```python\nprint(2)\n```\nEnd\n```"
        expected = "# Doc\n```python\nprint(2)\n```\nEnd"
        self.assertEqual(strata_worker.clean_markdown_fences(mixed), expected)

        # Plain text without fences should remain untouched
        plain = "def foo(): pass"
        self.assertEqual(strata_worker.clean_markdown_fences(plain), plain)

    def test_build_user_prompt(self):
        prompt = strata_worker.build_user_prompt(
            goal="Write unit tests",
            target="foo.py",
            contexts=["Context content 1", "Context content 2"],
            diff="diff --git a b",
        )
        self.assertIn("## Goal\nWrite unit tests", prompt)
        self.assertIn("## Target\nfoo.py", prompt)
        self.assertIn("## Git Diff\n```diff\ndiff --git a b\n```", prompt)
        self.assertIn("## Context & References", prompt)
        self.assertIn("### Reference 1\nContext content 1", prompt)
        self.assertIn("### Reference 2\nContext content 2", prompt)

    def test_verify_syntax(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)

            # Valid Python
            py_ok = tmp_path / "valid.py"
            py_ok.write_text("x = 1 + 2\n", encoding="utf-8")
            ok, _ = strata_worker.verify_syntax(py_ok)
            self.assertTrue(ok)

            # Invalid Python
            py_bad = tmp_path / "invalid.py"
            py_bad.write_text("def invalid(\n", encoding="utf-8")
            ok, msg = strata_worker.verify_syntax(py_bad)
            self.assertFalse(ok)
            self.assertIn("Syntax error", msg)

            # Valid JSON
            json_ok = tmp_path / "valid.json"
            json_ok.write_text('{"a": 1}', encoding="utf-8")
            ok, _ = strata_worker.verify_syntax(json_ok)
            self.assertTrue(ok)

            # Invalid JSON
            json_bad = tmp_path / "invalid.json"
            json_bad.write_text('{"a": 1,}', encoding="utf-8")
            ok, _ = strata_worker.verify_syntax(json_bad)
            self.assertFalse(ok)

    def test_mcp_initialize_and_tools_list(self):
        init_req = {"jsonrpc": "2.0", "id": 1, "method": "initialize"}
        init_res = strata_mcp.handle_rpc(init_req)
        self.assertEqual(init_res["result"]["serverInfo"]["name"], "strata-mcp")
        self.assertIn("tools", init_res["result"]["capabilities"])

        tools_req = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
        tools_res = strata_mcp.handle_rpc(tools_req)
        tools = tools_res["result"]["tools"]
        tool_names = [t["name"] for t in tools]
        self.assertIn("strata_generate", tool_names)
        self.assertIn("strata_review", tool_names)


if __name__ == "__main__":
    unittest.main()
