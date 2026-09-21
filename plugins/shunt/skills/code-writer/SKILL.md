---
name: code-writer
description: "Delegates boilerplate code generation to the Gemini worker. Use for tests, config, docstrings, type stubs, or any generation where more than 80% is predictable from reference files."
---

```bash
# Generate and write directly to target file
${CLAUDE_PLUGIN_ROOT}/scripts/code-write --spec "<what to generate>" --reference <reference-file> --target <output-path>

# Output to stdout instead (omit --target)
${CLAUDE_PLUGIN_ROOT}/scripts/code-write --spec "<what to generate>" --reference <reference-file>
```

Each call is independent. To build on what was just generated, pass that file as the
`--reference` for the next call.

When writing to `--target`, the script runs a deterministic syntax check matched to the
file extension (`bash -n`, `python3 -m py_compile`, `node --check`, `jq -e .`) and exits
non-zero with the checker's error on stderr if it fails — a bad generation is caught here
rather than surfacing later at edit or run time. Extensions with no checker are reported as
unverified, not silently treated as passing. This only proves the file parses; still review
it and make surgical edits for the ~5-20% that needs Claude-level judgment.
