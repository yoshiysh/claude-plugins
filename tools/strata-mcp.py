#!/usr/bin/env python3
"""Strata MCP Server: Standard stdio Model Context Protocol interface for Strata Workers.

Exposes specialized local generation & adversarial review tools to any MCP client
(Claude Code, Antigravity, Claude Desktop, Cursor, etc.).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import importlib.util
from importlib.machinery import SourceFileLoader

worker_path = Path(__file__).resolve().parent / "strata-worker.py"
loader = SourceFileLoader("strata_worker", str(worker_path))
spec = importlib.util.spec_from_loader("strata_worker", loader)
strata_worker = importlib.util.module_from_spec(spec)
loader.exec_module(strata_worker)


TOOLS = [
    {
        "name": "strata_generate",
        "description": (
            "Generate tests, implementation code, or documentation using high-speed local Strata models. "
            "Zero cloud API cost, clean syntax validation."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "role": {
                    "type": "string",
                    "enum": ["test-gen", "code-gen", "doc-gen"],
                    "description": "Specialized generation persona to activate.",
                },
                "goal": {
                    "type": "string",
                    "description": "Specific goal and acceptance criteria for generation.",
                },
                "target": {
                    "type": "string",
                    "description": "Target file path or symbol name.",
                },
                "context": {
                    "type": "string",
                    "description": "Relevant context (reference files, types, API contracts).",
                },
                "output_path": {
                    "type": "string",
                    "description": "Optional destination file path to write and syntax-verify the output.",
                },
            },
            "required": ["role", "goal"],
        },
    },
    {
        "name": "strata_review",
        "description": (
            "Run ruthless adversarial review on tests, code, or documentation using local Strata auditor. "
            "Focuses strictly on bugs, leaks, race conditions, weak mocks, and semantic drift. Compliments forbidden."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "role": {
                    "type": "string",
                    "enum": ["test-review", "code-review", "doc-review"],
                    "description": "Adversarial review lens to apply.",
                },
                "goal": {
                    "type": "string",
                    "description": "Verification criteria or high-risk areas to scrutinize.",
                },
                "target": {
                    "type": "string",
                    "description": "Target file or component under audit.",
                },
                "context": {
                    "type": "string",
                    "description": "Relevant reference implementation, contract, or specifications.",
                },
                "diff": {
                    "type": "string",
                    "description": "Optional git diff or proposed code changes to review.",
                },
            },
            "required": ["role", "goal"],
        },
    },
]


def handle_generate(args: dict[str, Any]) -> str:
    role = args.get("role", "code-gen")
    goal = args.get("goal", "")
    target = args.get("target")
    context_str = args.get("context")
    output_path = args.get("output_path")

    contexts = [context_str] if context_str else []
    target_str = target
    if target and Path(target).is_file():
        try:
            target_str = f"File: {target}\n```\n{Path(target).read_text(encoding='utf-8')}\n```"
        except OSError:
            pass

    user_prompt = strata_worker.build_user_prompt(
        goal=goal,
        target=target_str,
        contexts=contexts,
        diff=None,
    )
    persona = strata_worker.PERSONAS[role]
    key = strata_worker.resolve_api_key(None)
    api_base = os.environ.get("STRATA_BASE_URL", "http://127.0.0.1:8080/v1")
    model = os.environ.get("STRATA_MODEL", "qwen3.8-flash-next-iq2_xs")

    raw_output = strata_worker.call_strata_api(
        api_base=api_base,
        api_key=key,
        model=model,
        system_prompt=persona["system"],
        user_prompt=user_prompt,
        temperature=persona["temperature"],
        max_tokens=4096,
    )

    clean_output = strata_worker.clean_markdown_fences(raw_output)

    if output_path:
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(clean_output, encoding="utf-8")
        valid, msg = strata_worker.verify_syntax(out)
        status_msg = f"✓ Saved to {output_path} ({msg})" if valid else f"⚠ Saved to {output_path} with syntax warning: {msg}"
        return f"{status_msg}\n\n```\n{clean_output}\n```"

    return clean_output


def handle_review(args: dict[str, Any]) -> str:
    role = args.get("role", "code-review")
    goal = args.get("goal", "")
    target = args.get("target")
    context_str = args.get("context")
    diff = args.get("diff")

    contexts = [context_str] if context_str else []
    target_str = target
    if target and Path(target).is_file():
        try:
            target_str = f"File: {target}\n```\n{Path(target).read_text(encoding='utf-8')}\n```"
        except OSError:
            pass

    user_prompt = strata_worker.build_user_prompt(
        goal=goal,
        target=target_str,
        contexts=contexts,
        diff=diff,
    )
    persona = strata_worker.PERSONAS[role]
    key = strata_worker.resolve_api_key(None)
    api_base = os.environ.get("STRATA_BASE_URL", "http://127.0.0.1:8080/v1")
    model = os.environ.get("STRATA_MODEL", "qwen3.8-flash-next-iq2_xs")

    return strata_worker.call_strata_api(
        api_base=api_base,
        api_key=key,
        model=model,
        system_prompt=persona["system"],
        user_prompt=user_prompt,
        temperature=persona["temperature"],
        max_tokens=4096,
    )


def handle_rpc(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    req_id = request.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "strata-mcp",
                    "version": "1.0.0",
                },
            },
        }

    if method == "notifications/initialized":
        return None

    if method == "ping":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": TOOLS},
        }

    if method == "tools/call":
        params = request.get("params", {})
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        try:
            if tool_name == "strata_generate":
                res_text = handle_generate(arguments)
            elif tool_name == "strata_review":
                res_text = handle_review(arguments)
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"},
                }

            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": res_text}],
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "isError": True,
                    "content": [{"type": "text", "text": f"Strata Worker Error: {e}"}],
                },
            }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        resp = handle_rpc(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    rust_bin = Path(__file__).resolve().parent.parent / "crates" / "strata" / "target" / "release" / "strata"
    if rust_bin.is_file() and os.access(rust_bin, os.X_OK):
        os.execv(str(rust_bin), ["strata", "mcp"] + sys.argv[1:])
    main()
