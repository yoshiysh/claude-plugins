#!/usr/bin/env python3
"""Validate the queue's own run records; no parallel manifest is accepted."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from content_contract import content_application_errors, content_verification_errors
from page_identity import cleanup_verified, identity_errors, identity_key, job_page_mode


TERMINAL_STATES = {"registered", "unresolved", "deferred"}
ACTIVE_STATES = {"ready", "waiting_retry", "leased"}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def required_verification(job: dict[str, Any], errors: list[str]) -> None:
    verification = job.get("verification")
    prefix = job["job_id"]
    if not isinstance(verification, dict):
        errors.append(f"{prefix}: terminal job lacks verifier record")
        return
    if not verification.get("verifier_id") or not verification.get("verified_at"):
        errors.append(f"{prefix}: verifier identity or time is missing")
    refetch = verification.get("notion_refetch")
    if not isinstance(refetch, dict) or not all(refetch.get(key) for key in ("page_id", "fetched_at", "destination_parent_id")):
        errors.append(f"{prefix}: Notion refetch evidence is incomplete")
    identity = verification.get("page_identity")
    errors.extend(identity_errors(job, identity, "verification.page_identity"))
    application = job.get("application") or {}
    application_identity = application.get("page_identity")
    if identity_key(application_identity) != identity_key(identity):
        errors.append(f"{prefix}: verification.page_identity must match application.page_identity")
    if isinstance(identity, dict) and isinstance(refetch, dict) and refetch.get("page_id") != identity.get("canonical_page_id"):
        errors.append(f"{prefix}: Notion refetch page_id must equal canonical_page_id")
    if job_page_mode(job) == "url_item" and not cleanup_verified(verification.get("source_queue_cleanup")):
        errors.append(f"{prefix}: URL-only terminal job lacks verified source_queue_cleanup")
    if job["state"] == "registered":
        for key in ("db_registered", "content_verified", "move_attempted", "move_verified"):
            if verification.get(key) is not True:
                errors.append(f"{prefix}: registered job lacks {key}=true")
        errors.extend(content_verification_errors(job, verification.get("content_verification"), f"{prefix}: verification.content_verification"))
    elif job["state"] == "unresolved":
        if not verification.get("unresolved_reason"):
            errors.append(f"{prefix}: unresolved job lacks unresolved_reason")
        if verification.get("move_verified") is not True:
            errors.append(f"{prefix}: unresolved job lacks move_verified=true")
    elif job["state"] == "deferred" and not verification.get("deferred_reason"):
        errors.append(f"{prefix}: deferred job lacks deferred_reason")


def validate_proposal(job: dict[str, Any], errors: list[str]) -> None:
    proposal = job.get("proposal")
    if job.get("phase") not in {"classify", "apply", "verify", "done"}:
        return
    if not isinstance(proposal, dict):
        errors.append(f"{job['job_id']}: classification phase lacks AI proposal")
        return
    classification = proposal.get("classification")
    if not isinstance(classification, dict):
        errors.append(f"{job['job_id']}: AI proposal lacks classification")
        return
    for key in ("domain", "topic", "decision_reason", "evidence"):
        if not classification.get(key):
            errors.append(f"{job['job_id']}: classification lacks {key}")
    for tag in classification.get("tags", []):
        if not isinstance(tag, dict) or not tag.get("value") or not tag.get("evidence"):
            errors.append(f"{job['job_id']}: tag lacks evidence")


def validate_application(job: dict[str, Any], errors: list[str]) -> None:
    if job.get("phase") not in {"apply", "verify", "done"}:
        return
    application = job.get("application")
    if not isinstance(application, dict):
        errors.append(f"{job['job_id']}: apply phase lacks application record")
        return
    errors.extend(identity_errors(job, application.get("page_identity"), "application.page_identity"))
    errors.extend(content_application_errors(job, application, f"{job['job_id']}: application"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--phase", choices=("preflight", "progress", "final"), required=True)
    args = parser.parse_args()

    run_directory = args.workspace.expanduser().resolve() / "runs" / args.run_id
    run_path = run_directory / "run.json"
    if not run_path.is_file():
        print(json.dumps({"status": "revise", "errors": ["run not found"]}, ensure_ascii=False))
        return 1
    run = read_json(run_path)
    jobs = [read_json(path) for path in sorted((run_directory / "jobs").glob("*.json"))]
    errors: list[str] = []
    if run.get("schema_version") != 2:
        errors.append("run must use queue schema_version 2")
    if len(jobs) > run.get("batch_limit", 0):
        errors.append("job count exceeds batch_limit")
    ids = [job.get("job_id") for job in jobs]
    if len(ids) != len(set(ids)) or any(not value for value in ids):
        errors.append("job ids must be unique and nonempty")

    for job in jobs:
        state = job.get("state")
        if state not in TERMINAL_STATES | ACTIVE_STATES:
            errors.append(f"{job.get('job_id')}: invalid state {state!r}")
            continue
        if args.phase == "preflight" and state not in TERMINAL_STATES | {"ready"}:
            errors.append(f"{job['job_id']}: preflight requires a ready or already-verified terminal state, got {state}")
        if state in TERMINAL_STATES:
            required_verification(job, errors)
        validate_proposal(job, errors)
        validate_application(job, errors)
        if job.get("state") == "leased":
            lease = job.get("lease") or {}
            if not lease.get("worker_id") or not lease.get("expires_at"):
                errors.append(f"{job['job_id']}: leased job lacks worker or expiry")

    if args.phase == "final":
        nonterminal = [job["job_id"] for job in jobs if job.get("state") not in TERMINAL_STATES]
        if nonterminal:
            errors.append("final requires all jobs terminal: " + ", ".join(nonterminal))
    # progress intentionally permits ready, waiting_retry, and leased jobs.  It
    # validates every terminal job already emitted by a worker.
    if errors:
        print(json.dumps({"status": "revise", "phase": args.phase, "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    counts = {state: sum(job.get("state") == state for job in jobs) for state in sorted(TERMINAL_STATES | ACTIVE_STATES)}
    print(json.dumps({"status": "passed", "phase": args.phase, "items": len(jobs), "counts": counts}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
