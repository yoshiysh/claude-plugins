---
name: ooda
description: Real Boyd-model OODA Loop automation skill for iterative, evidence-based decision-making under uncertainty
author: yoshiysh
version: 0.2.0

# OODA Loop Automation Skill

Implements a structured **OODA Loop** (Observe → Orient → Decide → Act) after John Boyd's model to
support iterative decision-making where outcomes are not deterministic and information is incomplete.
The skill uses sub-agents for each phase, treats orientation as the continuous center of gravity that
permeates every phase, and closes the cycle by feeding Act results back into the next Observe. A ledger
tracks state across iterations so known-bad attempts are not repeated.

## Overview

The OODA loop is an adaptive decision-making framework for high-stakes, dynamic situations:

1. **Observe** – Gather raw data, current state metrics, and historical context to establish a factual baseline. This is revisited continuously as new feedback arrives.
2. **Orient** – Interpret the observed situation through mental models, experience, and Implicit Guidance & Control (IG&C). Orient is the "schwerpunkt" (center of gravity): it decides *how the situation should be understood*, which frames every later decision. It is not a comparison against pre-set goals — that framing comes from orientation itself.
3. **Decide** – Select a course of action from Orient's options, based on constraints and risk tolerance. Decisions are made on incomplete information rather than waiting for perfect data (late commitment). There is no separate execution phase.
4. **Act** – Execute the chosen plan, then feed the results back as new observations into the next Observe. Each pass through the loop *is* the revision; there is no distinct "revise/stop" gate — fresh observations drive the next cycle.

Unlike PDCA (which optimizes known processes and commits early), OODA navigates unknown situations by
cycling faster than the environment changes, with orientation as the strategic leverage point.

## Sub-Agents

- `observe.md`: Gathers verifiable facts only. No speculation. Returns structured JSON with baseline metrics and current state. Revisited each cycle as feedback arrives.
- `orient.md`: Interprets observations into a coherent situational picture via mental models, frameworks, and IG&C (past/repetitive experience, institutional memory). Generates ranked options. This is the center of gravity of the loop.
- `decide.md`: Selects one actionable course from Orient's options against constraints. Outputs the plan; execution happens in Act. Does not have its own "Do" phase.
- `act.md`: Executes the plan and returns results as new observations for the next Observe — closing the feedback loop.

## Architecture

- **Orchestrator**: Node.js (`scripts/run_loop.js`) drives the cycle, invoking each agent and threading context so orientation permeates every phase; Act's results feed back into the next Observe (continuous loop, not a straight line).
- **Ledger**: JSONL-based state tracking (`scripts/ledger.py`). Provides continuity across iterations so known-bad attempts are skipped.
- **Tests**: `evals/evals.json` contains scenarios that exercise each phase and the Act→Observe feedback closure.

## Usage

1. Install as a plugin: `/plugin install ooda@yoshiysh-claude-plugins`
2. Run a loop iteration: `/ooda "Reduce checkout page load time by 30% on mobile devices." context="Mobile traffic spike during flash sales. Current LCP is 4.2s, target < 2.5s. Constraints: budget limited to frontend changes only (no CDN upgrade)."`
3. Each iteration returns structured JSON; Act's `new_observations` become the input to the next Observe, continuing the cycle.

## Success Criteria

Each run should produce:
- `observe`: Verifiable facts only, gaps identified where data is missing.
- `orient`: A coherent interpretation of the situation with ranked options (exactly 3 primary), each linked to evidence; IG&C noted when a read leans on prior experience rather than fresh analysis.
- `decide`: One actionable plan (who/what/how) or `BLOCKED` if no option meets constraints.
- `act`: Factual execution results translated into new observations that close the loop, without claiming success/failure when data is ambiguous (`inconclusive`).

## Constraints

- The skill models Boyd's OODA loop: continuous, feedback-driven, orientation as center of gravity — not a linear PDCA-style pipeline.
- Each agent follows its documented constraints strictly (no speculation in Observe; exactly 3 options in Orient; single course selection in Decide; feedback closure in Act).
- The ledger provides continuity across iterations but does not force termination or restart decisions — those emerge from fresh observations each cycle.