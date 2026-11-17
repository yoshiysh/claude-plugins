#!/usr/bin/env python3
"""Strata Worker: High-speed local subagent for specialized generation & adversarial review.

Usage:
  tools/strata-worker --role <role> --goal "<goal>" [options]

Roles:
  test-gen     : Generate comprehensive tests (normal, edge cases, error cases)
  test-review  : Adversarial test reviewer (catch trivial mocks, weak assertions, flakiness)
  code-gen     : Focused, robust code implementation matching existing conventions
  code-review  : Adversarial bug hunter (detect leaks, off-by-one, race conditions, swallowed errors)
  doc-gen      : Structured, unambiguous technical documentation
  doc-review   : Semantic consistency auditor (detect discrepancy between code and doc)

Options:
  --role <role>          Persona/role name (required)
  --goal "<goal>"        Completion goal and acceptance criteria (required)
  --target <path>        Target file or component name
  --context <path|text>  Context file or inline text (can be repeated)
  --diff                 Include current git diff as context
  --output <path>        Write output to file (syntax-checked upon write)
  --no-syntax-check      Skip deterministic syntax check when writing to file
  --api-base <url>       Strata API base URL (default: http://127.0.0.1:8080/v1)
  --api-key <key>        Strata API key (default: read from ~/.config/strata/api_key)
  --model <model>        Model name (default: qwen3.8-flash-next-iq2_xs)
  --max-tokens <int>     Maximum output tokens (default: 4096)
  --temperature <float>  Sampling temperature (default: role-dependent)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PERSONAS: dict[str, dict[str, Any]] = {
    "test-gen": {
        "title": "Exhaustive Test Generator",
        "temperature": 0.2,
        "is_review": False,
        "system": """You are an exhaustive, rigorous test engineer.
Your goal is to write high-coverage, maintainable, and self-contained test cases.

Core Principles:
1. Cover normal paths, error paths, boundary values (0, empty, max limits, timeouts), and edge cases.
2. Every test must have concrete, specific assertions. Never write tautological assertions that always pass.
3. Keep tests self-contained and reproducible.
4. Output ONLY the raw executable test code. Do NOT wrap in markdown fences (```) and do NOT include conversational commentary.""",
    },
    "test-review": {
        "title": "Adversarial Test Reviewer",
        "temperature": 0.1,
        "is_review": True,
        "system": """You are a ruthless, adversarial test auditor.
Your job is to prove that the proposed tests are INSUFFICIENT, WEAK, or DECEPTIVE.
Compliments and positive feedback are strictly forbidden. Focus exclusively on flaws.

Audit Lenses:
1. Tautological Tests: Do tests pass regardless of whether the actual behavior is correct?
2. Mock Abuse: Are mocks hiding real integration failures or mocking away the very behavior under test?
3. Assertion Weakness: Are assertions checking trivialities (e.g. truthiness) instead of exact return values and side effects?
4. Uncovered Conditions: What failure modes, exceptions, or boundary edge cases are omitted?
5. Flakiness: Are there timing, ordering, or environment dependencies that could fail in CI?

Output Format:
Format your output as a Markdown list of concrete findings:
- [CRITICAL | WARNING | SUGGESTION] `file:line` or `test_name`: Description of flaw, why it is dangerous, and concrete counter-example or test case needed.""",
    },
    "code-gen": {
        "title": "Focused Implementation Worker",
        "temperature": 0.2,
        "is_review": False,
        "system": """You are a disciplined, focused software engineer.
Your goal is to write minimal, robust, and clean implementation code strictly satisfying the specified goal.

Core Principles:
1. Strictly follow existing idioms, typing conventions, and patterns in the context.
2. Avoid over-engineering, unnecessary abstractions, or speculative generalizations.
3. Ensure defensive boundary checks, proper error propagation, and resource cleanup.
4. Output ONLY the implementation code. Do NOT wrap in markdown fences (```) and do NOT include commentary.""",
    },
    "code-review": {
        "title": "Adversarial Bug Hunter",
        "temperature": 0.1,
        "is_review": True,
        "system": """You are an adversarial bug hunter and systems auditor.
Your mindset: "This code will break in production under pressure. Where will it fail first?"
Compliments and superficial style comments (naming, linting) are forbidden. Focus on correctness, reliability, security, and contract risk.

Audit Lenses:
1. Correctness & Edge Cases: Off-by-one errors, null/undefined/empty handling, integer overflow, type coercion mistakes.
2. Error Handling: Silent failures, error swallowing, missing rollback/cleanup on error paths.
3. Resource Management: Leaking file descriptors, sockets, child processes, unbounded buffer growth.
4. Concurrency & Reentrancy: Race conditions, TOCTOU, shared mutable state without synchronization.
5. Contract Violations: Breaking existing callers, silently changed defaults, unverified assumptions.

Output Format:
Format your output as a Markdown list of concrete findings:
- [CRITICAL | WARNING | CONCERN] `file:line` or `symbol`: Explain WHY it is wrong with a concrete counter-example/failing input, and propose a specific fix.""",
    },
    "doc-gen": {
        "title": "Technical Documentation Generator",
        "temperature": 0.2,
        "is_review": False,
        "system": """You are a clear, precise technical writer.
Your goal is to write concise, unambiguous documentation (README, API references, or specifications).

Core Principles:
1. Eliminate vague language ("as appropriate", "might", "etc."). Use precise declarative statements.
2. Explicitly specify prerequisites, exact inputs, outputs, errors, and reproducible examples.
3. Match documentation strictly to what the code actually does.
4. Output clean, structured Markdown.""",
    },
    "doc-review": {
        "title": "Semantic Consistency Auditor",
        "temperature": 0.1,
        "is_review": True,
        "system": """You are an adversarial documentation auditor.
Your job is to find discrepancies between documentation and actual implementation behavior.
Compliments are forbidden.

Audit Lenses:
1. Semantic Drift: Where does the doc claim a capability or behavior that the code does not actually support?
2. Undefined Terms: Are there domain-specific terms, flags, or concepts used without definition?
3. Missing Constraints: Does the doc fail to mention necessary permissions, environment prerequisites, or rate limits?
4. Misleading Examples: Do code samples contain syntax errors, obsolete APIs, or invalid assumptions?

Output Format:
Format your output as a Markdown list of concrete findings:
- [DISCREPANCY | AMBIGUITY | OMISSION] `section` or `quote`: State the exact conflict between doc and reality, and what needs correction.""",
    },
}


def resolve_api_key(explicit_key: str | None) -> str:
    """Resolve Strata API key from argument, environment, or config file."""
    if explicit_key:
        return explicit_key
    env_key = os.environ.get("STRATA_API_KEY")
    if env_key:
        return env_key
    config_file = Path.home() / ".config" / "strata" / "api_key"
    if config_file.is_file():
        try:
            return config_file.read_text(encoding="utf-8").strip()
        except OSError:
            pass
    return ""


def clean_markdown_fences(content: str) -> str:
    """Strip outermost markdown code fences if present."""
    lines = content.strip().splitlines()
    if len(lines) >= 2 and lines[0].startswith("```") and lines[-1].startswith("```"):
        return "\n".join(lines[1:-1]).strip()
    return content.strip()


def verify_syntax(file_path: Path) -> tuple[bool, str]:
    """Run deterministic syntax check matching file extension."""
    suffix = file_path.suffix.lower()
    cmd: list[str] | None = None

    if suffix in (".py", ".pyw"):
        cmd = [sys.executable, "-m", "py_compile", str(file_path)]
    elif suffix in (".js", ".mjs"):
        cmd = ["node", "--check", str(file_path)]
    elif suffix in (".sh", ".bash"):
        cmd = ["bash", "-n", str(file_path)]
    elif suffix == ".json":
        cmd = ["python3", "-c", "import json, sys; json.load(open(sys.argv[1]))", str(file_path)]

    if not cmd:
        return True, "No syntax checker registered for this file type (assumed ok)"

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            err = proc.stderr.strip() or proc.stdout.strip()
            return False, f"Syntax error ({cmd[0]}): {err}"
        return True, "Syntax check passed"
    except FileNotFoundError:
        return True, f"Checker binary '{cmd[0]}' not installed, skipped"


def build_user_prompt(
    goal: str,
    target: str | None,
    contexts: list[str],
    diff: str | None,
) -> str:
    """Construct structured prompt following Goal specification protocol."""
    sections = [f"## Goal\n{goal}\n"]

    if target:
        sections.append(f"## Target\n{target}\n")

    if diff:
        sections.append(f"## Git Diff\n```diff\n{diff}\n```\n")

    if contexts:
        sections.append("## Context & References")
        for idx, ctx in enumerate(contexts, 1):
            sections.append(f"### Reference {idx}\n{ctx}\n")

    return "\n".join(sections)


def ensure_model_loaded(api_base: str, api_key: str) -> None:
    """Ensure the model is loaded in Strata; if unloaded, trigger /load and wait."""
    import time
    models_url = f"{api_base.rstrip('/')}/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    try:
        req = urllib.request.Request(models_url, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8")).get("data", [])
            if any(m.get("status", {}).get("value") == "loaded" for m in data):
                return
    except Exception:
        pass

    print("[Strata Worker] Model is unloaded; sending /load request...", file=sys.stderr)
    base_host = api_base.split("/v1")[0]
    load_endpoint = f"{base_host}/load"
    load_headers = {
        "Origin": base_host,
        "Content-Type": "application/json",
    }
    if api_key:
        load_headers["Authorization"] = f"Bearer {api_key}"

    try:
        load_req = urllib.request.Request(load_endpoint, data=b"{}", headers=load_headers, method="POST")
        with urllib.request.urlopen(load_req, timeout=60) as _:
            pass
        print("[Strata Worker] /load completed.", file=sys.stderr)
        return
    except Exception as e:
        print(f"Warning: /load request returned {e}", file=sys.stderr)

    for _ in range(30):
        time.sleep(2)
        try:
            req = urllib.request.Request(models_url, headers=headers)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8")).get("data", [])
                if any(m.get("status", {}).get("value") == "loaded" for m in data):
                    print("[Strata Worker] Model successfully loaded.", file=sys.stderr)
                    return
        except Exception:
            pass
    print("Warning: Timed out waiting for model to load", file=sys.stderr)


def call_strata_api(
    api_base: str,
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    temperature: float,
    max_tokens: int,
) -> str:
    """Send request to Strata completions endpoint."""
    ensure_model_loaded(api_base, api_key)
    url = f"{api_base.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    data = json.dumps(payload).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        # Timeout 1800s (30m) to allow heavy local generation without premature client cut-off
        with urllib.request.urlopen(req, timeout=1800) as resp:
            body = resp.read().decode("utf-8")
            res_json = json.loads(body)
            choices = res_json.get("choices", [])
            if not choices:
                raise RuntimeError("Strata returned empty choices")
            message = choices[0].get("message", {})
            content = message.get("content") or ""
            reasoning = message.get("reasoning_content") or ""
            return content if content else reasoning
    except urllib.error.URLError as err:
        raise RuntimeError(
            f"Failed to connect to Strata at {url}: {err}\n"
            "Ensure the Strata server is running (e.g. tools/claude-strata --start-server)."
        ) from err


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Strata Worker: High-speed local subagent for specialized tasks.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--role", required=True, choices=list(PERSONAS.keys()), help="Persona role")
    parser.add_argument("--goal", required=True, help="Specific goal / acceptance criteria")
    parser.add_argument("--target", help="Target file path or symbol name")
    parser.add_argument("--context", action="append", default=[], help="Context file path or text block")
    parser.add_argument("--diff", action="store_true", help="Include current git diff as context")
    parser.add_argument("--output", help="Output destination file")
    parser.add_argument("--no-syntax-check", action="store_true", help="Skip syntax validation on file write")
    parser.add_argument("--api-base", default=os.environ.get("STRATA_BASE_URL", "http://127.0.0.1:8080/v1"))
    parser.add_argument("--api-key", help="Strata API key")
    parser.add_argument("--model", default=os.environ.get("STRATA_MODEL", "qwen3.8-flash-next-iq2_xs"))
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--temperature", type=float)

    args = parser.parse_args()

    persona = PERSONAS[args.role]
    temp = args.temperature if args.temperature is not None else persona["temperature"]
    key = resolve_api_key(args.api_key)

    # Collect context contents
    contexts: list[str] = []
    for ctx_arg in args.context:
        p = Path(ctx_arg)
        if p.is_file():
            try:
                contexts.append(f"File: {ctx_arg}\n{p.read_text(encoding='utf-8')}")
            except OSError as e:
                print(f"Warning: Failed to read context file {ctx_arg}: {e}", file=sys.stderr)
        else:
            contexts.append(ctx_arg)

    # Collect git diff if requested
    diff_text: str | None = None
    if args.diff:
        try:
            diff_proc = subprocess.run(
                ["git", "diff", "HEAD"], capture_output=True, text=True, check=False
            )
            if diff_proc.returncode == 0 and diff_proc.stdout.strip():
                diff_text = diff_proc.stdout.strip()
        except OSError:
            pass

    # Read target content if it points to an existing file
    target_str = args.target
    if args.target and Path(args.target).is_file():
        try:
            content = Path(args.target).read_text(encoding="utf-8")
            target_str = f"File: {args.target}\n```\n{content}\n```"
        except OSError:
            pass

    user_prompt = build_user_prompt(
        goal=args.goal,
        target=target_str,
        contexts=contexts,
        diff=diff_text,
    )

    print(f"[{persona['title']}] Submitting request to Strata ({args.model})...", file=sys.stderr)
    try:
        raw_output = call_strata_api(
            api_base=args.api_base,
            api_key=key,
            model=args.model,
            system_prompt=persona["system"],
            user_prompt=user_prompt,
            temperature=temp,
            max_tokens=args.max_tokens,
        )
    except Exception as err:
        print(f"Error: {err}", file=sys.stderr)
        return 1

    # Clean markdown fences for pure code generators
    clean_output = raw_output
    if not persona["is_review"]:
        clean_output = clean_markdown_fences(raw_output)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(clean_output, encoding="utf-8")
        print(f"Wrote output to {out_path}", file=sys.stderr)

        if not args.no_syntax_check and not persona["is_review"]:
            valid, msg = verify_syntax(out_path)
            if not valid:
                print(f"Error: Syntax verification failed!\n{msg}", file=sys.stderr)
                return 2
            print(f"✓ {msg}", file=sys.stderr)
    else:
        print(clean_output)

    return 0


if __name__ == "__main__":
    rust_bin = Path(__file__).resolve().parent.parent / "crates" / "strata" / "target" / "release" / "strata"
    if rust_bin.is_file() and os.access(rust_bin, os.X_OK):
        os.execv(str(rust_bin), ["strata", "run"] + sys.argv[1:])
    sys.exit(main())
