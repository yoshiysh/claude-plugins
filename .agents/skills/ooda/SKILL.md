---
name: ooda
description: OODA Loop automation skill for iterative, evidence-based problem solving
author: yoshiysh
version: 0.1.0

# OODA Automation Skill

Implements a structured **OODA Loop** workflow (Observe → Orient → Decide → Act) to support
iterative, evidence-based problem solving where outcomes are not deterministic. The skill uses
sub-agents for each phase and maintains a ledger for state tracking across iterations.

## Overview

The OODA loop is an adaptive decision-making framework used in high-stakes, dynamic environments:

1. **Observe** – Gather raw data, current state metrics, and historical context to establish a factual baseline.
2. **Orient** – Analyze the observed state against success criteria. Identify root causes of deviation and generate ranked hypotheses/options for testing.
3. **Decide** – Evaluate generated options against constraints, resources, and risk tolerance. Select the single best path for execution ("Do").
4. **Act** – Execute the plan, gather results, evaluate them against success criteria, and recommend the next loop action (Revise, Standardize, or Stop).

## Sub-Agents

- `observe.md`: Gathers verifiable facts only. No speculation. Returns structured JSON with baseline metrics and current state.
- `orient.md`: Analyzes observations against success criteria. Identifies root causes and generates exactly 3 ranked options (with fallbacks if needed).
- `decide.md`: Evaluates options against constraints and ledger history to avoid redundant attempts. Outputs a single actionable plan or `BLOCKED`.
- `act.md`: Executes the plan, compares results against success criteria, and recommends `revise`/`standardize`/`stop` with specific next-step parameters for revision.

## Architecture

- **Orchestrator**: Node.js (`scripts/run_loop.js`) drives the iteration cycle, invoking each agent in sequence.
- **Ledger**: JSONL-based state tracking (`scripts/ledger.py`). Prevents redundant experimentation by checking previous run IDs and phases.
- **Tests**: `evals/evals.json` contains 3 scenarios (performance optimization, A/B testing, strategy validation) to verify each loop phase works correctly.

## Usage

1. Install as a plugin: `/plugin install ooda@yoshiysh-claude-plugins`
2. Run a loop iteration: `/ooda "Reduce checkout page load time by 30% on mobile devices." context="Mobile traffic spike during flash sales. Current LCP is 4.2s, target < 2.5s. Constraints: budget limited to frontend changes only (no CDN upgrade)."`
3. Each iteration returns structured JSON with the recommendation and updated context for the next phase.

## Success Criteria

Each run should produce:
- `observe`: Verifiable facts only, gaps identified where data is missing.
- `orient`: Exactly 3 ranked options with clear rationale (impact vs. effort/risk).
- `decide`: Single actionable plan with explicit success metrics checkpoints, or `BLOCKED` if no option meets constraints.
- `act`: Direct quantitative comparison against criteria, specific revision parameters for next Decide phase, or clear stop justification.

## Constraints

- The skill is designed for iterative problem solving where outcomes are not deterministic.
- Each agent must follow its documented constraints strictly (no speculation in Observe, exactly 3 options in Orient, single decision in Decide).
- The ledger ensures idempotency: duplicate run IDs/phases are skipped.