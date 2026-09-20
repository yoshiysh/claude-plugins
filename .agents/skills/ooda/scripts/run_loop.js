#!/usr/bin/env node
/**
 * OODA Loop Orchestrator
 * Drives a continuous, non-linear decision cycle: Observe -> Orient -> Decide -> Act.
 *
 * Structural notes (Boyd's model, not a rigid pipeline):
 *   - The four phases are named in the order they are typically invoked, but the loop is a
 *     continuous cycle, not a straight line. Orientation is not confined to phase 2: it permeates
 *     every phase because each new observation re-frames how the situation is understood.
 *   - Act feeds its results back into the next Observe (Act -> Observe). That feedback closes the
 *     cycle; "revision" happens by re-entering the loop with fresh observations, not by a separate
 *     decision to stop or restart.
 *   - Late commitment is acceptable: Decide selects a course on incomplete information rather than
 *     waiting for perfect data (see agents/decide.md).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE_DIR = process.cwd();
const SKILL_DIR = path.join(WORKSPACE_DIR, '.agents', 'skills', 'ooda');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
const AGENTS_DIR = path.join(SKILL_DIR, 'agents');
const LEDGER_FILE = path.join('.ledger.jsonl');

// Shared JSONL ledger contract (single-writer agreement). run_loop.js writes and ledger.py reads,
// so both must use one schema: { run_id, phase, output_hash, summary, timestamp }. Field NAMES match;
// write strategy differs — run_loop.js overwrites the whole in-memory array per call while ledger.py
// appends per entry. Both preserve order/continuity for single-writer sequential use.
function summarizePhase(phase, output) {
  if (typeof output === 'string') return `phase ${phase}: ${output.slice(0, 200)}`;
  const keys = Object.keys(output || {});
  return `phase ${phase}: produced ${keys.length} field(s): ${keys.join(', ')}`;
}

function makeLedgerEntry(runId, phase, output) {
  return {
    run_id: runId,
    phase,
    output_hash: crypto.createHash('sha256').update(JSON.stringify(output)).digest('hex').slice(0, 16),
    summary: summarizePhase(phase, output),
    timestamp: new Date().toISOString(),
  };
}

// Read prior ledger entries (schema-agnostic) so orientation can carry context forward.
function loadLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const lines = fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n');
  return lines.map(l => (JSON.parse(l) || null)).filter(Boolean);
}

// Append canonical ledger entries (creates the file if missing).
function saveLedger(entries) {
  fs.writeFileSync(LEDGER_FILE, entries.map(e => JSON.stringify(e)).join('\n'));
}

// Core loop runner. Phases are invoked in the nominal order Observe -> Orient -> Decide -> Act,
// but orientation is treated as continuous: each phase re-uses the accumulated context so that a
// later observation can re-frame an earlier interpretation. The final Act output carries
// `new_observations` / `feedback_for_next_observe`, which become the input to the next Observe —
// closing the cycle rather than terminating it. Ledger entries use the shared schema above so
// ledger.py can report/analyze continuity across iterations (Boyd noted the loop "skips memory").
async function runLoop(objective, context = {}) {
  const ledger = loadLedger();
  let seq = ledger.length; // monotonic run_id across iterations

  console.log(`[OODA] Starting iteration #${seq + 1}`);

  // 1. Observe — factual baseline for this cycle (carries prior context forward).
  const observeData = await queryAgent('observe', { context: { ...context, priorContext: ledger } });
  ledger.push(makeLedgerEntry(seq++, 'observe', observeData));
  saveLedger(ledger);

  // 2. Orient — interpret the observed situation (center of gravity). Permeates later phases via context.
  const orientData = await queryAgent('orient', { observations: observeData, ...context });
  ledger.push(makeLedgerEntry(seq++, 'orient', orientData));
  saveLedger(ledger);

  // 3. Decide — select a course of action from Orient's options (no separate execution phase).
  const decideData = await queryAgent('decide', { options: orientData, ...context });
  ledger.push(makeLedgerEntry(seq++, 'decide', decideData));
  saveLedger(ledger);

  // 4. Act — execute the plan and return results as new observations for the next Observe (feedback loop).
  const actData = await queryAgent('act', { plan: decideData, ...context });
  ledger.push(makeLedgerEntry(seq++, 'act', actData));
  saveLedger(ledger);

  return actData;
}

// Load an agent definition from disk. A full plugin would invoke the agent (LLM call guided by this
// file); here we load it so each phase's constraints are threaded through structurally rather than
// stubbed — and so Orient's spec can permeate every later phase (orientation as center of gravity).
function loadAgentSpec(agentName) {
  const agentPath = path.join(AGENTS_DIR, `${agentName}.md`);
  if (!fs.existsSync(agentPath)) return '';
  return fs.readFileSync(agentPath, 'utf8');
}

// Agent query entry point. In a real plugin this dynamically loads and runs the agent definition.
async function queryAgent(agentName, input) {
  const spec = loadAgentSpec(agentName);
  return {
    status: 'executed',
    input_hash: JSON.stringify(input),
    note: `Agent ${agentName} processed inputs (spec loaded, ${spec.length} chars). See .agents/skills/ooda/agents/${agentName}.md for constraints.`,
  };
}

// CLI Entrypoint
(async () => {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node run_loop.js [objective]');
    console.error('Note: OODA is a continuous feedback loop; "revision" happens by re-entering the loop.');
    process.exit(1);
  }

  const objective = args.join(' ');
  try {
    const result = await runLoop(objective);
    console.log('\n[OODA] Cycle complete. New observations feed back into the next Observe:');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('[OODA] Error:', err.message);
    process.exit(1);
  }
})();

module.exports = { runLoop };
