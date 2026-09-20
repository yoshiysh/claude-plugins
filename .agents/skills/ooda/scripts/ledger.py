#!/usr/bin/env python3
"""
OODA Loop Ledger Manager
Manages a JSONL-based run ledger that provides continuity across iterations (state tracking,
deduplication of known-bad attempts, and reporting). Boyd noted the loop "skips memory": the
ledger lets each cycle build on prior observations instead of re-deriving them from scratch.
"""

import json
import os
from datetime import datetime
from dataclasses import dataclass, asdict

LEDGER_FILE = ".ledger.jsonl"

@dataclass
class LedgerEntry:
    run_id: int
    phase: str  # observe | orient | decide | act
    output_hash: str
    summary: str
    timestamp: str = None

def load_ledger() -> list[dict]:
    """Load existing ledger from JSONL file."""
    if not os.path.exists(LEDGER_FILE):
        return []
    entries = []
    with open(LEDGER_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return entries

def save_ledger(entries: list[dict]) -> None:
    """Append new entries to ledger."""
    with open(LEDGER_FILE, "a", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")

def get_next_run_id() -> int:
    """Get next unique run ID based on current max."""
    ledger = load_ledger()
    if not ledger:
        return 0
    return max(e.get("run_id", 0) for e in ledger) + 1

def check_duplicate(run_id: int, phase: str) -> bool:
    """Check if a specific run+phase was already attempted, so known-bad attempts are not repeated."""
    for entry in load_ledger():
        if entry.get("run_id") == run_id and entry.get("phase") == phase:
            return True
    return False

def log_run(run_id: int, phase: str, output_hash: str, summary: str):
    """Log a single run step."""
    entries = [{"run_id": run_id, "phase": phase, "output_hash": output_hash, "summary": summary}]
    save_ledger(entries)

def get_report(run_id_range=None) -> dict:
    """Generate structured report from ledger."""
    ledger = load_ledger()
    if not ledger:
        return {"status": "empty", "runs": []}
    
    runs_by_phase = {}
    for e in ledger:
        pid = e["run_id"]
        phase = e["phase"]
        if phase not in runs_by_phase:
            runs_by_phase[phase] = []
        runs_by_phase[phase].append(e)
        
    return {
        "status": "complete",
        "total_runs": len(ledger),
        "runs_by_phase": runs_by_phase,
        "latest_run_id": max((e["run_id"] for e in ledger), default=0)
    }

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python3 ledger.py <action>")
        print("Actions: list, log <id> <phase> <hash> <summary>, report")
        exit(1)

    action = sys.argv[1]
    if action == "log":
        run_id = int(sys.argv[2])
        phase = sys.argv[3]
        hash_val = sys.argv[4]
        summary = " ".join(sys.argv[5:])
        log_run(run_id, phase, hash_val, summary)
        print(f"Logged run {run_id} [{phase}]")
    elif action == "list":
        report = get_report()
        print(json.dumps(report, indent=2))
    elif action == "report":
        report = get_report(sys.argv[2] if len(sys.argv) > 2 else None)
        print(json.dumps(report, indent=2))
    else:
        print(f"Unknown action: {action}")