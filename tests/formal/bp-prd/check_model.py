#!/usr/bin/env python3
"""Bounded explicit-state model of selected BP requirements, not implementation."""
from collections import deque
from dataclasses import dataclass, replace
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT = {
    'docs/requirements/bp-designed-skill.md': '4576d731b34131d4c2a3ea405ef6ba79c22208b1a544cc016687e6dea3fed087',
    'docs/requirements/bp-operations.md': '252162163995832f86075276a221047c9483add2bdfd7a77e0865513e8930d1e',
}

@dataclass(frozen=True)
class State:
    phase: str = 'running'
    verification: str = 'pending'
    persistence: str = 'pending'
    records: int = 0
    historical: int = 0
    deletion_requested: bool = False
    direct_ledger_write: bool = False

INIT = State()

def transitions(s, mutation=None):
    out=[]
    def add(name, **kw): out.append((name, replace(s, **kw)))
    if s.phase == 'running':
        if s.verification == 'pending':
            add('verification-pass', verification='pass')
            add('verification-fail', verification='fail', phase='running' if mutation == 'no_stop_verification' else 'stopped')
        if s.persistence == 'pending':
            if not s.records & 1:
                add('save-partial', records=s.records | 1, historical=s.historical | 1)
            add('save-success', persistence='pass', records=s.records | 1, historical=s.historical | 1)
            if mutation == 'partial_save_loss' and s.records:
                add('save-failure-discards-records', persistence='fail', phase='stopped', records=0)
            else:
                add('save-failure', persistence='fail', phase='running' if mutation == 'no_stop_save' else 'stopped')
        if s.persistence == 'pass' and not s.records & 2:
            add('record-next-run', records=s.records | 2, historical=s.historical | 2)
        if s.verification == 'pass' and s.persistence == 'pass':
            add('complete', phase='completed')
        if mutation == 'premature_complete' and s.verification != 'pass' and s.persistence == 'pass':
            add('complete-without-verification', phase='completed')
        if mutation == 'premature_persistence' and s.verification == 'pass' and s.persistence != 'pass':
            add('complete-without-persistence', phase='completed')
        if mutation == 'direct_ledger_write':
            add('agent-writes-ledger', direct_ledger_write=True)
    if not s.deletion_requested:
        add('user-requests-deletion', deletion_requested=True)
    if s.records and (s.deletion_requested or mutation == 'unrequested_deletion'):
        add('delete-records', records=0)
    return out

def violations(s):
    errors=[]
    if s.phase == 'completed' and (s.verification != 'pass' or s.persistence != 'pass'):
        errors.append('completion_requires_verified_and_persisted')
    if s.verification == 'fail' and s.phase != 'stopped': errors.append('verification_failure_stops')
    if s.persistence == 'fail' and s.phase != 'stopped': errors.append('save_failure_stops')
    if not s.deletion_requested and s.records != s.historical: errors.append('retention_without_delete_request')
    if s.direct_ledger_write: errors.append('agent_does_not_write_shared_ledger')
    return errors

def explore(mutation=None):
    q=deque([(INIT, [])]); visited={INIT}; checked=0
    while q:
        state, path=q.popleft(); checked+=1
        err=violations(state)
        if err: return {'mutation': mutation or 'none', 'states':len(visited), 'checked':checked, 'violation':err, 'trace':path}
        for name, next_state in transitions(state, mutation):
            if next_state not in visited:
                visited.add(next_state); q.append((next_state, path+[name]))
    return {'mutation': mutation or 'none', 'states':len(visited), 'checked':checked, 'violation':[], 'trace':[]}

if __name__ == '__main__':
    import json
    for path, expected in SNAPSHOT.items():
        actual = sha256((ROOT / path).read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f'PRD changed: {path}; recheck model correspondence before updating SHA-256')
    expected_violations = {
        'no_stop_verification': 'verification_failure_stops',
        'no_stop_save': 'save_failure_stops',
        'premature_complete': 'completion_requires_verified_and_persisted',
        'premature_persistence': 'completion_requires_verified_and_persisted',
        'partial_save_loss': 'retention_without_delete_request',
        'unrequested_deletion': 'retention_without_delete_request',
        'direct_ledger_write': 'agent_does_not_write_shared_ledger',
    }
    cases=[None, *expected_violations]
    results=[explore(x) for x in cases]
    print(json.dumps(results,ensure_ascii=False,indent=2))
    if results[0]['violation'] or any(
        expected_violations[r['mutation']] not in r['violation'] for r in results[1:]
    ):
        raise SystemExit('Model check failed or a mutation did not produce a counterexample')
