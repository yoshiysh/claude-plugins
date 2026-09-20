#!/usr/bin/env node
/**
 * OODA Loop Orchestrator
 * Manages the iteration cycle: Observe -> Orient -> Decide -> Act
 * Uses ledger.jsonl for state tracking and prevents redundant work.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE_DIR = process.cwd();
const SKILL_DIR = path.join(WORKSPACE_DIR, '.agents', 'skills', 'ooda');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');
const AGENTS_DIR = path.join(SKILL_DIR, 'agents');
const LEDGER_FILE = path.join('.ledger.jsonl');

// Helper: Read JSONL ledger and return array of entries
function loadLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const lines = fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n');
  return lines.map(l => (JSON.parse(l) || null)).filter(Boolean);
}

// Helper: Append to ledger (creates if missing)
function saveLedger(entries) {
  fs.writeFileSync(LEDGER_FILE, entries.map(e => JSON.stringify(e)).join('\n'));
}

// Core loop runner
async function runLoop(objective, context = {}) {
  const ledger = loadLedger();
  let currentEntryId = ledger.length;
  
  console.log(`[OODA] Starting iteration #${currentEntryId + 1}`);
  
  // 1. Observe
  const observeData = await queryAgent('observe', { context });
  ledger.push({ id: currentEntryId, phase: 'observe', output: observeData, timestamp: new Date().toISOString() });
  saveLedger(ledger);

  // 2. Orient
  const orientData = await queryAgent('orient', { observations: observeData, ...context });
  ledger.push({ id: currentEntryId + 1, phase: 'orient', output: orientData, timestamp: new Date().toISOString() });
  saveLedger(ledger);

  // 3. Decide
  const decideData = await queryAgent('decide', { options: orientData, ...context });
  ledger.push({ id: currentEntryId + 2, phase: 'decide', output: decideData, timestamp: new Date().toISOString() });
  saveLedger(ledger);

  // 4. Act (Evaluate & Recommend)
  const actData = await queryAgent('act', { plan: decideData, ...context });
  ledger.push({ id: currentEntryId + 3, phase: 'act', output: actData, timestamp: new Date().toISOString() });
  saveLedger(ledger);

  return actData;
}

// Mock agent query (replace with actual dynamic import or subprocess in production)
async function queryAgent(agentName, input) {
  // In a real plugin, this would dynamically require/execute the agent script
  // For now, returns structured placeholder based on agent constraints
  const agentPath = path.join(AGENTS_DIR, `${agentName}.md`);
  return { 
    status: 'executed', 
    input_hash: JSON.stringify(input),
    note: `Agent ${agentName} processed inputs. See .agents/skills/ooda/agents/${agentName}.md for constraints.`
  };
}

// CLI Entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node run_loop.js [objective]');
    process.exit(1);
  }
  
  const objective = args.join(' ');
  try {
    const result = await runLoop(objective);
    console.log('\n[OODA] Final Recommendation:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('[OODA] Error:', err.message);
    process.exit(1);
  }
}

module.exports = { runLoop };