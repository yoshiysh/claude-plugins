#!/usr/bin/env python3
"""State store and scheduler for notion-organize-knowledge.

This script deliberately does not infer content, tags, or taxonomy.  An AI
worker owns those decisions; this script owns durable job state, leases,
domain backoff, and evidence-shaped completion records.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from content_contract import content_application_errors, content_verification_errors
from page_identity import cleanup_verified, identity_errors, identity_key, job_page_mode


INPUT_KINDS = {
    "notion_page", "notion_children", "notion_database", "notion_search",
    "url_list_page", "url_list", "resume_run",
}
TERMINAL_STATES = {"registered", "unresolved", "deferred"}
WORKING_STATE = "leased"
SCHEDULABLE_STATES = {"ready", "waiting_retry", WORKING_STATE}
ALL_STATES = {"ready", "waiting_retry", WORKING_STATE, *TERMINAL_STATES}
PHASES = ("resolve", "enrich", "classify", "apply", "verify")
PHASE_INDEX = {phase: index for index, phase in enumerate(PHASES)}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(f".tmp-{uuid.uuid4().hex}")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def run_dir(workspace: Path, run_id: str) -> Path:
    return workspace / "runs" / run_id


def jobs_dir(workspace: Path, run_id: str) -> Path:
    return run_dir(workspace, run_id) / "jobs"


def load_run(workspace: Path, run_id: str) -> tuple[Path, dict[str, Any]]:
    directory = run_dir(workspace, run_id)
    metadata = directory / "run.json"
    if not metadata.is_file():
        raise ValueError(f"run not found: {run_id}")
    return directory, read_json(metadata)


def load_jobs(workspace: Path, run_id: str) -> list[tuple[Path, dict[str, Any]]]:
    directory = jobs_dir(workspace, run_id)
    if not directory.is_dir():
        raise ValueError(f"run not found: {run_id}")
    jobs = [(path, read_json(path)) for path in directory.glob("*.json")]
    return sorted(jobs, key=lambda entry: (entry[1].get("sequence", 0), entry[1]["job_id"]))


def lock(directory: Path) -> Path:
    path = directory / ".queue.lock"
    try:
        path.mkdir()
    except FileExistsError as error:
        raise RuntimeError(f"queue is busy: {directory.name}") from error
    return path


def unlock(path: Path) -> None:
    path.rmdir()


def append_event(directory: Path, event: dict[str, Any]) -> None:
    with (directory / "events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"at": now(), **event}, ensure_ascii=False) + "\n")


def parse_object(raw: str, label: str) -> dict[str, Any]:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def domain_from_source(source: dict[str, Any], explicit: str | None = None) -> str | None:
    if explicit:
        return explicit.lower()
    for key in ("canonical_url", "normalized_url", "source_url", "url"):
        value = source.get(key)
        if isinstance(value, str) and value:
            return urlparse(value).netloc.lower() or None
    return None


def lease_expired(job: dict[str, Any]) -> bool:
    lease = job.get("lease") or {}
    expires_at = lease.get("expires_at")
    return bool(expires_at and parse_time(expires_at) <= datetime.now(timezone.utc))


def retry_due(job: dict[str, Any]) -> bool:
    retry = job.get("retry") or {}
    not_before = retry.get("not_before")
    return bool(not_before and parse_time(not_before) <= datetime.now(timezone.utc))


def gate_active(run: dict[str, Any], domain: str | None) -> bool:
    if not domain:
        return False
    gate = (run.get("domain_gates") or {}).get(domain)
    return bool(gate and gate.get("not_before") and parse_time(gate["not_before"]) > datetime.now(timezone.utc))


def assert_owner(job: dict[str, Any], worker_id: str) -> None:
    if job["state"] != WORKING_STATE:
        raise ValueError(f"job is not leased: {job['state']}")
    if lease_expired(job):
        raise ValueError("job lease has expired; let dispatcher reclaim it")
    if (job.get("lease") or {}).get("worker_id") != worker_id:
        raise ValueError("worker does not own this job")


def write_job(path: Path, job: dict[str, Any]) -> None:
    job["updated_at"] = now()
    atomic_write(path, job)


def refresh_schedulable_jobs(directory: Path, jobs: list[tuple[Path, dict[str, Any]]]) -> None:
    for path, job in jobs:
        if job["state"] == WORKING_STATE and lease_expired(job):
            previous = job["state"]
            job["state"] = "ready"
            job["lease"] = None
            job["recovery"] = {"reason": "lease_expired", "at": now(), "phase": job["phase"]}
            write_job(path, job)
            append_event(directory, {"event": "lease_expired", "job_id": job["job_id"], "from": previous, "to": "ready"})
        elif job["state"] == "waiting_retry" and retry_due(job):
            job["state"] = "ready"
            job["retry"] = None
            write_job(path, job)
            append_event(directory, {"event": "retry_due", "job_id": job["job_id"], "to": "ready"})


def claim_one(directory: Path, run: dict[str, Any], jobs: list[tuple[Path, dict[str, Any]]], worker_id: str, lease_minutes: int, job_id: str | None = None) -> dict[str, Any] | None:
    refresh_schedulable_jobs(directory, jobs)
    active = sum(1 for _, job in load_jobs_from_directory(directory) if job["state"] == WORKING_STATE and not lease_expired(job))
    if active >= run["scheduler"]["max_workers"]:
        return None
    candidates = load_jobs_from_directory(directory)
    if job_id:
        candidates = [(path, job) for path, job in candidates if job["job_id"] == job_id]
        if not candidates:
            raise ValueError(f"job not found: {job_id}")
    for path, job in candidates:
        if job["state"] != "ready" or gate_active(run, job.get("domain")):
            continue
        job["state"] = WORKING_STATE
        job["attempt_count"] += 1
        job["lease"] = {
            "worker_id": worker_id,
            "claimed_at": now(),
            "heartbeat_at": now(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=lease_minutes)).isoformat().replace("+00:00", "Z"),
        }
        write_job(path, job)
        append_event(directory, {"event": "claimed", "job_id": job["job_id"], "worker_id": worker_id, "phase": job["phase"]})
        return job
    return None


def load_jobs_from_directory(directory: Path) -> list[tuple[Path, dict[str, Any]]]:
    jobs = [(path, read_json(path)) for path in (directory / "jobs").glob("*.json")]
    return sorted(jobs, key=lambda entry: (entry[1].get("sequence", 0), entry[1]["job_id"]))


def cmd_create_run(args: argparse.Namespace) -> None:
    workspace = Path(args.workspace).expanduser().resolve()
    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    directory = run_dir(workspace, run_id)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "jobs").mkdir()
    run = {
        "schema_version": 2,
        "run_id": run_id,
        "created_at": now(),
        "status": "open",
        "input": {"kind": args.input_kind, "source": parse_object(args.source_json, "--source-json")},
        "batch_limit": args.batch_limit,
        "scheduler": {"max_workers": args.max_workers, "lease_minutes": args.lease_minutes},
        "domain_gates": {},
    }
    atomic_write(directory / "run.json", run)
    append_event(directory, {"event": "run_created", "run_id": run_id})
    print(json.dumps(run, ensure_ascii=False, indent=2))


def cmd_enqueue(args: argparse.Namespace) -> None:
    workspace = Path(args.workspace).expanduser().resolve()
    directory, run = load_run(workspace, args.run_id)
    held = lock(directory)
    try:
        jobs = load_jobs_from_directory(directory)
        if len(jobs) >= run["batch_limit"]:
            raise ValueError(f"batch limit reached: {run['batch_limit']}")
        source = parse_object(args.source_json, "--source-json")
        job_id = args.job_id or f"job-{uuid.uuid4().hex[:12]}"
        path = directory / "jobs" / f"{job_id}.json"
        if path.exists():
            raise ValueError(f"job already exists: {job_id}")
        job = {
            "schema_version": 2,
            "job_id": job_id,
            "sequence": len(jobs),
            "input_kind": args.input_kind or run["input"]["kind"],
            "source": source,
            "domain": domain_from_source(source, args.domain),
            "state": "ready",
            "phase": "resolve",
            "attempt_count": 0,
            "retry": None,
            "lease": None,
            "proposal": None,
            "application": None,
            "verification": None,
            "created_at": now(),
            "updated_at": now(),
        }
        atomic_write(path, job)
        append_event(directory, {"event": "enqueued", "job_id": job_id, "sequence": job["sequence"], "domain": job["domain"]})
        print(json.dumps(job, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def cmd_claim(args: argparse.Namespace) -> None:
    workspace = Path(args.workspace).expanduser().resolve()
    directory, run = load_run(workspace, args.run_id)
    held = lock(directory)
    try:
        job = claim_one(directory, run, load_jobs_from_directory(directory), args.worker_id, args.lease_minutes or run["scheduler"]["lease_minutes"], args.job_id)
        reason = "claimed" if job else "capacity_exhausted_or_no_eligible_job"
        print(json.dumps({"job": job, "reason": reason}, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def cmd_dispatch(args: argparse.Namespace) -> None:
    """Return an execution worklist without reserving jobs.

    This command is a control-plane operation.  An AI/MCP worker must call
    ``claim`` immediately before it starts a real item.  Leasing here would
    turn a mere plan into a false in-flight worker when the caller cannot
    actually execute it (for example, a shell-only background process).
    """
    workspace = Path(args.workspace).expanduser().resolve()
    directory, run = load_run(workspace, args.run_id)
    held = lock(directory)
    try:
        jobs = load_jobs_from_directory(directory)
        refresh_schedulable_jobs(directory, jobs)
        jobs = load_jobs_from_directory(directory)
        active = sum(1 for _, job in jobs if job["state"] == WORKING_STATE and not lease_expired(job))
        capacity = max(0, run["scheduler"]["max_workers"] - active)
        limit = min(capacity, args.max_claims or run["scheduler"]["max_workers"])
        worklist = []
        for _, job in jobs:
            if len(worklist) >= limit:
                break
            if job["state"] != "ready" or gate_active(run, job.get("domain")):
                continue
            worklist.append({"job_id": job["job_id"], "phase": job["phase"], "domain": job.get("domain")})
        append_event(directory, {"event": "dispatch_planned", "job_ids": [job["job_id"] for job in worklist], "active": active, "capacity": capacity})
        print(json.dumps({"worklist": worklist, "active_workers": active, "available_capacity": capacity, "remaining_capacity": capacity - len(worklist)}, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def cmd_heartbeat(args: argparse.Namespace) -> None:
    workspace = Path(args.workspace).expanduser().resolve()
    directory, _ = load_run(workspace, args.run_id)
    path = directory / "jobs" / f"{args.job_id}.json"
    held = lock(directory)
    try:
        job = read_json(path)
        assert_owner(job, args.worker_id)
        job["lease"]["heartbeat_at"] = now()
        job["lease"]["expires_at"] = (datetime.now(timezone.utc) + timedelta(minutes=args.lease_minutes)).isoformat().replace("+00:00", "Z")
        write_job(path, job)
        append_event(directory, {"event": "heartbeat", "job_id": job["job_id"], "worker_id": args.worker_id})
        print(json.dumps(job, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def validate_proposal(proposal: dict[str, Any]) -> None:
    classification = proposal.get("classification")
    if not isinstance(classification, dict):
        raise ValueError("proposal requires classification")
    for key in ("domain", "topic", "decision_reason", "evidence"):
        if not classification.get(key):
            raise ValueError(f"proposal.classification requires {key}")
    if not isinstance(classification.get("evidence"), list):
        raise ValueError("proposal.classification.evidence must be a list")
    tags = classification.get("tags", [])
    if not isinstance(tags, list):
        raise ValueError("proposal.classification.tags must be a list")
    for tag in tags:
        if not isinstance(tag, dict) or not tag.get("value") or not tag.get("evidence"):
            raise ValueError("each tag requires value and evidence")
    if not isinstance(classification.get("alternatives", []), list):
        raise ValueError("proposal.classification.alternatives must be a list")


def validate_application(job: dict[str, Any], application: dict[str, Any]) -> None:
    errors = identity_errors(job, application.get("page_identity"), "application.page_identity")
    errors.extend(content_application_errors(job, application))
    if errors:
        raise ValueError("; ".join(errors))


def cmd_advance(args: argparse.Namespace) -> None:
    workspace = Path(args.workspace).expanduser().resolve()
    directory, _ = load_run(workspace, args.run_id)
    path = directory / "jobs" / f"{args.job_id}.json"
    held = lock(directory)
    try:
        job = read_json(path)
        assert_owner(job, args.worker_id)
        if args.phase not in PHASE_INDEX:
            raise ValueError(f"unknown phase: {args.phase}")
        if PHASE_INDEX[args.phase] != PHASE_INDEX[job["phase"]] + 1:
            raise ValueError(f"phase must advance exactly one step: {job['phase']} -> {args.phase}")
        if args.proposal_json:
            proposal = parse_object(args.proposal_json, "--proposal-json")
            validate_proposal(proposal)
            job["proposal"] = proposal
        if args.application_json:
            job["application"] = parse_object(args.application_json, "--application-json")
        if args.phase == "classify" and not job.get("proposal"):
            raise ValueError("classify phase requires an AI proposal")
        if args.phase == "apply" and not job.get("application"):
            raise ValueError("apply phase requires an application record")
        if args.phase == "apply":
            validate_application(job, job["application"])
        previous = job["phase"]
        job["phase"] = args.phase
        write_job(path, job)
        append_event(directory, {"event": "phase_advanced", "job_id": job["job_id"], "worker_id": args.worker_id, "from": previous, "to": args.phase})
        print(json.dumps(job, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def cmd_record_proposal(args: argparse.Namespace) -> None:
    """Attach an AI classification proposal without changing the workflow phase.

    This is intentionally separate from ``advance`` so a migrated legacy item
    already at ``verify`` can gain the evidence record required by the v2
    audit without replaying an already-applied Notion update.
    """
    workspace = Path(args.workspace).expanduser().resolve()
    directory, _ = load_run(workspace, args.run_id)
    path = directory / "jobs" / f"{args.job_id}.json"
    held = lock(directory)
    try:
        job = read_json(path)
        assert_owner(job, args.worker_id)
        if PHASE_INDEX[job["phase"]] < PHASE_INDEX["classify"]:
            raise ValueError("proposal can be recorded only from classify phase onward")
        proposal = parse_object(args.proposal_json, "--proposal-json")
        validate_proposal(proposal)
        job["proposal"] = proposal
        write_job(path, job)
        append_event(directory, {"event": "proposal_recorded", "job_id": job["job_id"], "worker_id": args.worker_id, "phase": job["phase"]})
        print(json.dumps(job, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def validate_verification(job: dict[str, Any], state: str, verification: dict[str, Any], worker_id: str, verifier_id: str) -> None:
    if verifier_id == worker_id:
        raise ValueError("completion requires a verifier distinct from the applying worker")
    if verification.get("verifier_id") != verifier_id or not verification.get("verified_at"):
        raise ValueError("verification requires matching verifier_id and verified_at")
    refetch = verification.get("notion_refetch")
    if not isinstance(refetch, dict) or not refetch.get("page_id") or not refetch.get("fetched_at") or not refetch.get("destination_parent_id"):
        raise ValueError("verification requires a Notion refetch with page_id, fetched_at, and destination_parent_id")
    identity = verification.get("page_identity")
    errors = identity_errors(job, identity, "verification.page_identity")
    if errors:
        raise ValueError("; ".join(errors))
    application = job.get("application") or {}
    application_identity = application.get("page_identity")
    if identity_key(application_identity) != identity_key(identity):
        raise ValueError("verification.page_identity must match application.page_identity")
    if refetch.get("page_id") != identity.get("canonical_page_id"):
        raise ValueError("Notion refetch page_id must equal the verified canonical_page_id")
    if job_page_mode(job) == "url_item" and not cleanup_verified(verification.get("source_queue_cleanup")):
        raise ValueError("URL-only terminal verification requires successful source_queue_cleanup")
    if state == "registered":
        for key in ("db_registered", "content_verified", "move_attempted", "move_verified"):
            if verification.get(key) is not True:
                raise ValueError(f"registered verification requires {key}=true")
        errors = content_verification_errors(job, verification.get("content_verification"))
        if errors:
            raise ValueError("; ".join(errors))
    elif state == "unresolved":
        if not verification.get("unresolved_reason"):
            raise ValueError("unresolved verification requires unresolved_reason")
        if verification.get("move_verified") is not True:
            raise ValueError("unresolved verification requires move_verified=true")
    elif state == "deferred" and not verification.get("deferred_reason"):
        raise ValueError("deferred verification requires deferred_reason")


def cmd_complete(args: argparse.Namespace) -> None:
    workspace = Path(args.workspace).expanduser().resolve()
    directory, _ = load_run(workspace, args.run_id)
    path = directory / "jobs" / f"{args.job_id}.json"
    held = lock(directory)
    try:
        job = read_json(path)
        assert_owner(job, args.worker_id)
        if job["phase"] != "verify":
            raise ValueError("job must reach verify phase before completion")
        verification = parse_object(args.verification_json, "--verification-json")
        validate_verification(job, args.state, verification, args.worker_id, args.verifier_id)
        job["state"] = args.state
        job["phase"] = "done"
        job["lease"] = None
        job["verification"] = verification
        write_job(path, job)
        append_event(directory, {"event": "worker_finished", "job_id": job["job_id"], "state": args.state, "worker_id": args.worker_id, "verifier_id": args.verifier_id, "dispatch_required": True})
        print(json.dumps({"job": job, "dispatch_required": True}, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def cmd_retry(args: argparse.Namespace) -> None:
    workspace = Path(args.workspace).expanduser().resolve()
    directory, run = load_run(workspace, args.run_id)
    path = directory / "jobs" / f"{args.job_id}.json"
    held = lock(directory)
    try:
        job = read_json(path)
        assert_owner(job, args.worker_id)
        not_before = args.retry_after
        if parse_time(not_before) <= datetime.now(timezone.utc):
            raise ValueError("--retry-after must be in the future")
        domain = args.domain or job.get("domain")
        job["state"] = "waiting_retry"
        job["lease"] = None
        job["retry"] = {"not_before": not_before, "reason": args.reason, "domain": domain}
        write_job(path, job)
        if domain:
            run.setdefault("domain_gates", {})[domain] = {"not_before": not_before, "reason": args.reason, "job_id": job["job_id"]}
            atomic_write(directory / "run.json", run)
        append_event(directory, {"event": "retry_scheduled", "job_id": job["job_id"], "worker_id": args.worker_id, "domain": domain, "not_before": not_before, "dispatch_required": True})
        print(json.dumps({"job": job, "dispatch_required": True}, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def cmd_status(args: argparse.Namespace) -> None:
    workspace = Path(args.workspace).expanduser().resolve()
    directory, run = load_run(workspace, args.run_id)
    held = lock(directory)
    try:
        # Status is part of the control plane: it must never report expired
        # leases as work in flight.
        refresh_schedulable_jobs(directory, load_jobs_from_directory(directory))
        jobs = load_jobs_from_directory(directory)
        counts = {state: 0 for state in sorted(ALL_STATES)}
        for _, job in jobs:
            counts[job["state"]] = counts.get(job["state"], 0) + 1
        active = sum(1 for _, job in jobs if job["state"] == WORKING_STATE and not lease_expired(job))
        payload = {
            "run_id": args.run_id,
            "counts": counts,
            "capacity": {"max_workers": run["scheduler"]["max_workers"], "active": active, "available": run["scheduler"]["max_workers"] - active},
            "domain_gates": run.get("domain_gates", {}),
        }
        if args.verbose:
            payload["jobs"] = [job for _, job in jobs]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def cmd_reopen(args: argparse.Namespace) -> None:
    """Reopen a terminal job so a distinct worker/verifier can revise it.

    ``claim``, ``record-proposal``, and ``advance`` all require a job to
    already be leased, so a terminal (registered/unresolved/deferred) job is
    otherwise unreachable once ``complete`` has run. This lets a corrected
    proposal or a fresh verifier re-fetch flow the job back through
    classify/apply/verify without hand-editing job JSON or losing the prior
    proposal/application history.
    """
    workspace = Path(args.workspace).expanduser().resolve()
    directory, _ = load_run(workspace, args.run_id)
    path = directory / "jobs" / f"{args.job_id}.json"
    held = lock(directory)
    try:
        job = read_json(path)
        if job["state"] not in TERMINAL_STATES:
            raise ValueError(f"only a terminal job can be reopened: state={job['state']}")
        previous_state = job["state"]
        job["state"] = WORKING_STATE
        job["phase"] = args.phase
        job["attempt_count"] += 1
        job["verification"] = None
        job["lease"] = {
            "worker_id": args.worker_id,
            "claimed_at": now(),
            "heartbeat_at": now(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=args.lease_minutes)).isoformat().replace("+00:00", "Z"),
        }
        job["reopened_from"] = {"state": previous_state, "reason": args.reason, "at": now()}
        write_job(path, job)
        append_event(directory, {"event": "reopened", "job_id": job["job_id"], "worker_id": args.worker_id, "from_state": previous_state, "to_phase": args.phase, "reason": args.reason})
        print(json.dumps(job, ensure_ascii=False, indent=2))
    finally:
        unlock(held)


def cmd_migrate_run(args: argparse.Namespace) -> None:
    """Migrate schema v1 run data without treating prior self-attested work as verified."""
    workspace = Path(args.workspace).expanduser().resolve()
    directory, run = load_run(workspace, args.run_id)
    held = lock(directory)
    try:
        if run.get("schema_version") == 2:
            print(json.dumps({"status": "already_current", "run_id": args.run_id}, ensure_ascii=False))
            return
        if run.get("schema_version") != 1:
            raise ValueError(f"unsupported schema version: {run.get('schema_version')}")
        phase_map = {"resolve": "resolve", "resolving": "resolve", "enrich": "enrich", "enriching": "enrich", "ready_to_apply": "apply", "applying": "apply", "verify": "verify", "verifying": "verify"}
        for sequence, (path, old) in enumerate(load_jobs_from_directory(directory)):
            old_state = old.get("state", "pending")
            if old_state in {"registered", "unresolved"}:
                state, phase = "ready", "verify"
                recovery = "legacy_terminal_requires_verification"
            elif old_state == "deferred":
                state, phase = "deferred", "verify"
                recovery = None
            else:
                state = "waiting_retry" if old.get("retry_after") and not retry_due({"retry": {"not_before": old["retry_after"]}}) else "ready"
                phase = phase_map.get(old.get("stage"), "resolve")
                recovery = "legacy_run_resumed"
            source = old.get("source", {})
            job = {
                "schema_version": 2, "job_id": old["job_id"], "sequence": sequence,
                "input_kind": old.get("input_kind", run["input"]["kind"]), "source": source,
                "domain": domain_from_source(source), "state": state, "phase": phase,
                "attempt_count": old.get("attempt_count", 0),
                "retry": {"not_before": old["retry_after"], "reason": "legacy_retry", "domain": domain_from_source(source)} if state == "waiting_retry" else None,
                "lease": None, "proposal": None, "application": None, "verification": None,
                "legacy_result": old.get("result"), "recovery": {"reason": recovery, "at": now()} if recovery else None,
                "created_at": old.get("created_at", now()), "updated_at": now(),
            }
            atomic_write(path, job)
        run.update({"schema_version": 2, "scheduler": {"max_workers": args.max_workers, "lease_minutes": args.lease_minutes}, "domain_gates": {}})
        atomic_write(directory / "run.json", run)
        append_event(directory, {"event": "run_migrated", "from_schema": 1, "to_schema": 2})
        print(json.dumps({"status": "migrated", "run_id": args.run_id}, ensure_ascii=False))
    finally:
        unlock(held)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create-run")
    create.add_argument("--workspace", required=True)
    create.add_argument("--input-kind", required=True, choices=sorted(INPUT_KINDS - {"resume_run"}))
    create.add_argument("--source-json", required=True)
    create.add_argument("--batch-limit", type=int, default=50)
    create.add_argument("--max-workers", type=int, default=4)
    create.add_argument("--lease-minutes", type=int, default=20)
    create.add_argument("--run-id")
    create.set_defaults(func=cmd_create_run)

    enqueue = commands.add_parser("enqueue")
    enqueue.add_argument("--workspace", required=True)
    enqueue.add_argument("--run-id", required=True)
    enqueue.add_argument("--source-json", required=True)
    enqueue.add_argument("--input-kind", choices=sorted(INPUT_KINDS - {"resume_run"}))
    enqueue.add_argument("--domain")
    enqueue.add_argument("--job-id")
    enqueue.set_defaults(func=cmd_enqueue)

    for name, func in (("claim", cmd_claim), ("dispatch", cmd_dispatch)):
        command = commands.add_parser(name)
        command.add_argument("--workspace", required=True)
        command.add_argument("--run-id", required=True)
        command.add_argument("--lease-minutes", type=int)
        if name == "claim":
            command.add_argument("--worker-id", required=True)
            command.add_argument("--job-id")
        else:
            # Kept as compatibility-only flags for existing scripts.  Dispatch
            # now returns a non-mutating worklist; workers lease via `claim`.
            command.add_argument("--worker-prefix", default="worker", help=argparse.SUPPRESS)
            command.add_argument("--max-claims", type=int, help="maximum worklist entries")
        command.set_defaults(func=func)

    heartbeat = commands.add_parser("heartbeat")
    heartbeat.add_argument("--workspace", required=True)
    heartbeat.add_argument("--run-id", required=True)
    heartbeat.add_argument("--job-id", required=True)
    heartbeat.add_argument("--worker-id", required=True)
    heartbeat.add_argument("--lease-minutes", type=int, default=20)
    heartbeat.set_defaults(func=cmd_heartbeat)

    advance = commands.add_parser("advance")
    advance.add_argument("--workspace", required=True)
    advance.add_argument("--run-id", required=True)
    advance.add_argument("--job-id", required=True)
    advance.add_argument("--worker-id", required=True)
    advance.add_argument("--phase", required=True, choices=PHASES)
    advance.add_argument("--proposal-json")
    advance.add_argument("--application-json")
    advance.set_defaults(func=cmd_advance)

    proposal = commands.add_parser("record-proposal")
    proposal.add_argument("--workspace", required=True)
    proposal.add_argument("--run-id", required=True)
    proposal.add_argument("--job-id", required=True)
    proposal.add_argument("--worker-id", required=True)
    proposal.add_argument("--proposal-json", required=True)
    proposal.set_defaults(func=cmd_record_proposal)

    complete = commands.add_parser("complete")
    complete.add_argument("--workspace", required=True)
    complete.add_argument("--run-id", required=True)
    complete.add_argument("--job-id", required=True)
    complete.add_argument("--worker-id", required=True)
    complete.add_argument("--verifier-id", required=True)
    complete.add_argument("--state", required=True, choices=sorted(TERMINAL_STATES))
    complete.add_argument("--verification-json", required=True)
    complete.set_defaults(func=cmd_complete)

    retry = commands.add_parser("retry")
    retry.add_argument("--workspace", required=True)
    retry.add_argument("--run-id", required=True)
    retry.add_argument("--job-id", required=True)
    retry.add_argument("--worker-id", required=True)
    retry.add_argument("--retry-after", required=True)
    retry.add_argument("--reason", required=True)
    retry.add_argument("--domain")
    retry.set_defaults(func=cmd_retry)

    status = commands.add_parser("status")
    status.add_argument("--workspace", required=True)
    status.add_argument("--run-id", required=True)
    status.add_argument("--verbose", action="store_true")
    status.set_defaults(func=cmd_status)

    reopen = commands.add_parser("reopen")
    reopen.add_argument("--workspace", required=True)
    reopen.add_argument("--run-id", required=True)
    reopen.add_argument("--job-id", required=True)
    reopen.add_argument("--worker-id", required=True)
    reopen.add_argument("--phase", choices=PHASES, default="verify")
    reopen.add_argument("--lease-minutes", type=int, default=20)
    reopen.add_argument("--reason", required=True)
    reopen.set_defaults(func=cmd_reopen)

    migrate = commands.add_parser("migrate-run")
    migrate.add_argument("--workspace", required=True)
    migrate.add_argument("--run-id", required=True)
    migrate.add_argument("--max-workers", type=int, default=4)
    migrate.add_argument("--lease-minutes", type=int, default=20)
    migrate.set_defaults(func=cmd_migrate_run)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        args.func(args)
        return 0
    except (ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
