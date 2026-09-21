# shunt (fork)

A Claude Code plugin that shunts I/O-heavy work to a cheaper worker model, saving tokens on large file reads and boilerplate generation.

> **Fork of [spotify/portal-ai-plugins](https://github.com/spotify/portal-ai-plugins) `plugins/shunt`** (Apache-2.0, see NOTICE for the pinned upstream commit and the change list). Two changes:
>
> 1. **Transport**: the AiKA / Portal CLI backend is replaced by the AI Studio Gemini API (`scripts/lib/gemini.sh`). Auth is one env var: `CLAUDE_PLUGINS_GEMINI_API_KEY`. No Portal deployment needed.
> 2. **Routing**: the hooks keep upstream's deterministic guards verbatim, but the final "block iff > 350 lines" judgment becomes a typed model decision (enum `allow|block` via `responseSchema`, prompt frozen in `scripts/lib/decide-prompt.txt`) on two axes, not just line count:
>    - **Cost** (how much the command actually ingests): a proxy fix for the fact that `head file` reads 10 lines whatever the file's size, so bounded reads (`head`/`tail`/`sed`/`awk` ranges, piped `| head`) are judged on the slice they actually emit, not the file's total length.
>    - **Fidelity** (how much the content's meaning survives a cheap worker's summary): the gate is shown a real sample — the file's first 40 lines, each truncated to 200 chars, injected via `<file_sample>` — so it can tell simple, repetitive content (logs, generated output, enumerated data) from content with non-trivial control flow or concurrency logic. Simple content past the threshold delegates (block); complex content stays in Claude's own context even past the threshold (allow), because a cheap summary is exactly where a race condition or an off-by-one would get flattened away. The sample is real file content, never inferred from the filename or extension, and is wrapped in its own tag so it is judged as data, not read as instructions.
>
>    When the model can't be consulted, the hook falls back to the upstream line rule and says so in its reason.
>
> Measured on the upstream hook eval corpus plus 4 new two-axis cases against real code/log fixtures (`evals/run_regression.py` → `evals/regression.md`), 39 cases across both hooks: 36/39 identical to the upstream line-count rule, with 3 intentional divergences — `head`/`head -N`/`tail` (no count) reads of large files, all of which emit only a fixed small slice regardless of file size and so allow on the cost axis alone. The 4 added cases pin the fidelity axis directly: a real 405-line file with lock/retry/circuit-breaker logic allows past the threshold, a real 400-line access log blocks past the threshold, a small `head` slice of the complex file allows on cost alone, and a small simple CSV allows on cost alone. These labels document the two-axis design's intent on hand-picked fixtures — they are not a measurement of fidelity-judgment accuracy on a broader corpus, since the eval corpus doesn't (yet) sample real-world code/log diversity. Model-gate latency ≈1.3-1.6s per consulted read (only paid on files over the small-file threshold, and now includes the sample in the request body); worker calls (`bulk-read`) run tens of seconds for real files — raise `SHUNT_TIMEOUT_SECONDS` for multi-file questions.

## How it works

Three layers, from hard gate to soft suggestion:

1. **Hooks** block Claude from reading large files and redirect to the bulk-reader skill
2. **Scripts** handle the worker invocation and output cleanup
3. **Skills** tell Claude when and how to call the scripts

Claude never assembles bash pipelines from prose. It calls a script with named arguments. The scripts handle everything internally.

Delegation goes through the AI Studio Gemini API — one `generateContent` call per delegation — isolated in `scripts/lib/gemini.sh` so a provider swap touches one file.

## Prerequisites

- [`jq`](https://jqlang.org) — `brew install jq`
- `curl`
- An AI Studio API key, exported as `CLAUDE_PLUGINS_GEMINI_API_KEY` in your shell profile. The scripts send it as a request header and never place it in URLs or logs.

Model selection: `SHUNT_GEMINI_MODEL` (default `gemma-4-26b-a4b-it` — the probe in `evals/probe-results.json` records why). Worker timeout: `SHUNT_TIMEOUT_SECONDS` (default 120; raise it for multi-file questions). Gate timeout: `SHUNT_DECIDE_TIMEOUT_SECONDS` (default 8; on expiry the hook falls back to the line rule and says so).

## Plugin structure

```
shunt/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (name, description, version)
├── hooks/
│   ├── hooks.json           # Hook registration (PreToolUse matchers)
│   ├── check-file-size      # Gates Read on large files (typed model decision)
│   └── check-bash-read      # Gates cat/head/tail on large files (typed model decision)
├── scripts/
│   ├── lib/
│   │   ├── gemini.sh        # Shared AI Studio plumbing + typed gate decision
│   │   └── decide-prompt.txt # Frozen gate prompt
│   ├── bulk-read            # Invokes the bulk-reader mode
│   └── code-write           # Invokes the code-writer mode
├── skills/
│   ├── bulk-reader/
│   │   └── SKILL.md         # When/how to call bulk-read
│   └── code-writer/
│       └── SKILL.md         # When/how to call code-write
└── evals/
    ├── run_regression.py     # Runs both hooks against the upstream eval corpus, writes regression.json/.md
    ├── hook-evals.json       # Read hook test cases (17)
    ├── bash-hook-evals.json  # Bash hook test cases (22, incl. 4 real-fixture fidelity-axis cases)
    ├── regression.json       # Latest run_regression.py output (machine-readable)
    ├── regression.md         # Latest run_regression.py output (table + diffs)
    ├── evals.json            # End-to-end skill test cases (3)
    ├── benchmarks.json       # Token savings scenarios (4)
    └── fixtures/             # Real code/log/data fixtures for fidelity-axis eval cases
```

## Scripts

### bulk-read

Delegates file reading to the worker model. Files are wrapped in XML tags (`<file path="...">`) for clear boundaries.

```bash
bulk-read --question "What does this service do?" --paths src/Service.java src/Handler.java

# Follow-up: ask again with the same paths
bulk-read --question "Which methods call the database?" --paths src/Service.java src/Handler.java
```

### code-write

Delegates boilerplate generation to the worker model. Strips markdown fences from output. Can write directly to disk via `--target`. `--reference` is required — without a file to match patterns against, the worker would generate context-free code that fits nothing in the project.

```bash
# Generate and write to file
code-write --spec "Write tests for UserService" --reference tests/OrderTest.java --target tests/UserTest.java

# Build on what was just generated by referencing it
code-write --spec "Now add edge case tests" --reference tests/UserTest.java --target tests/UserEdgeCases.java

# Output to stdout
code-write --spec "Generate a config stub" --reference config/existing.yaml
```

### One shot per call

Each delegation is one ephemeral `generateContent` call: nothing is kept between calls, and the follow-up
mechanism is for the caller to replay prior turns. Replaying a file corpus is the exact cost this
plugin exists to avoid, so shunt does not do it — every call stands alone. Re-sending files is
free where it matters, because the corpus goes to the worker model and never enters Claude's
context.

## Hooks

### check-file-size (Read hook)

Fires on every `Read` tool call. Blocks full-file reads on files exceeding `MIN_LINES` (default: 350, configurable via `SHUNT_MIN_LINES` env var). Allows through:
- Targeted reads (offset or limit set)
- Files under the threshold
- Nonexistent files (let Read handle the error)

### check-bash-read (Bash hook)

Fires on every `Bash` tool call. Catches `cat`, `head`, `tail`, `less`, `more` on large files. Allows through:
- Piped commands (`cat file | grep`) — targeted reads
- Redirections (`cat file > out`) — not reading into context
- Commands with flags that indicate targeted reads
- Non-read commands (`git status`, `grep`, etc.)

## Configuration

All settings are environment variables — add them to the `env` block in `.claude/settings.json`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SHUNT_MIN_LINES` | `350` | Line count above which the Read hook blocks and redirects |
| `SHUNT_MAX_PAYLOAD_BYTES` | `400000` | Request ceiling; the payload travels in the HTTP request body, not argv |
| `SHUNT_TIMEOUT_SECONDS` | `120` | Timeout for one worker (`bulk-read`/`code-write`) invocation |
| `SHUNT_GEMINI_MODEL` | `gemma-4-26b-a4b-it` | AI Studio model id used for both worker calls and the gate decision |
| `SHUNT_DECIDE_TIMEOUT_SECONDS` | `8` | Timeout for the gate's `shunt_decide` call; on expiry the hook falls back to the line rule |
| `SHUNT_TRACE_FILE` | — | When set, append one JSON line per gate consultation (model, http status, decision, judged input, token usage) |
| `SHUNT_GEMINI_ENDPOINT` | `https://generativelanguage.googleapis.com/v1beta` | AI Studio API base URL |

## What doesn't get delegated

The plugin is designed to know when NOT to delegate:
- **Debugging** — requires Claude's reasoning, not a summary
- **Editing** — Claude needs exact content in context; use targeted reads (offset/limit)
- **Small files** — delegation overhead exceeds savings under 350 lines
- **Architectural decisions** — judgment calls stay on Claude

## Evals

```bash
# Regenerate the hook regression table (needs CLAUDE_PLUGINS_GEMINI_API_KEY)
python3 evals/run_regression.py
```

This runs both hooks (`check-bash-read`, `check-file-size`) against the upstream 22+17-case eval
corpus (18 upstream + 4 real-fixture fidelity-axis cases for `check-bash-read`) and writes
`evals/regression.json` (machine-readable) and `evals/regression.md` (table + diff list),
classifying each case as resolved by `model` (proven via `SHUNT_TRACE_FILE`), `code` (a
deterministic guard short-circuited before the model), or `fallback` (the model could not be
consulted or returned an unusable response, so the upstream line rule decided).

## Benchmarks

Tested against a 162K-line Java monorepo:

| Scenario | Lines | Without shunt | With shunt | Savings |
|----------|-------|--------------|------------|---------|
| Single large file | 4,014 | 33,684 tokens | 5,737 tokens | 82% |
| Source + test pair | 7,408 | 75,990 tokens | 4,148 tokens | 94% |
| Multi-file cross-service | 1,281 | 16,221 tokens | 821 tokens | 94% |
| Code-write | 3,667 | 40,614 tokens + generation | 833 lines to disk | - |

Mean bulk-read savings: **90%**

## Known limitations

- **No enforcement for code-writer** — only bulk-reader has hook enforcement. Code-writer relies on Claude recognizing when to use it via the skill description.
- **Request size** — the payload travels in the HTTP request body (no `ARG_MAX` limit), but shunt still refuses anything over `SHUNT_MAX_PAYLOAD_BYTES` (default 400 KB) to stay under the model's context window with headroom. Split into smaller batches.
- **Invocation timeout** — shunt caps one action invocation at `SHUNT_TIMEOUT_SECONDS` (default 180). Very large generations can exceed it; raise the timeout or split the spec into smaller calls.
- **Fidelity-axis labels are documented intent, not a measured accuracy rate** — the 4 real-fixture cases in `bash-hook-evals.json` pin the two-axis design's behavior on hand-picked examples (one genuinely complex file, one genuinely simple one). The upstream eval corpus otherwise uses synthetic filler text, so this fork cannot yet report how often the fidelity judgment agrees with a human reader across a broad, representative sample of real code and logs — only that it behaves as designed on these specific fixtures.
