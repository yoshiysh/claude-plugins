"""Explicit local snapshot collection; no hooks, network or inference."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time

import measure

MAX_BYTES = 1024 * 1024
PENDING = ".pending-snapshot"


def validate_item(item):
    def natural(value):
        return type(value) is int and value >= 0

    def digest(value):
        return type(value) is str and len(value) == 64 and all(c in "0123456789abcdef" for c in value)

    measure.require(type(item) is dict and set(item) == {"id", "adapter", "report"}
                    and digest(item["id"]) and item["adapter"] in ("normalized", "workflow"),
                    "invalid_snapshot")
    report = item["report"]
    base = measure.aggregate([])
    extra = {"execution_status", "started_calls", "calls_without_usage", "calls_without_outcome",
             "evidence_digest", "duration_ms"} if item["adapter"] == "workflow" else set()
    measure.require(type(report) is dict and set(report) == set(base) | extra, "invalid_report_keys")
    for key in ("format", "quality", "scope"):
        measure.require(report[key] == base[key], "invalid_report_constant")
    measure.require(natural(report["observed_calls"]) and natural(report["duplicates_ignored"]),
                    "invalid_report_count")
    value = report["usage"]
    if report["observed_calls"] == 0:
        measure.require(value is None, "unexpected_usage")
    else:
        measure.require(type(value) is dict and set(value) == {*measure.FIELDS, "uncached_input_tokens"},
                        "invalid_report_usage")
        measure.usage(value)
        measure.require(natural(value["uncached_input_tokens"])
                        and value["uncached_input_tokens"] == value["input_tokens"] - value["cached_input_tokens"],
                        "invalid_uncached_usage")
    if item["adapter"] == "normalized":
        measure.require(report["measurement_complete"] is None, "invalid_completeness")
        return
    for key in ("started_calls", "calls_without_usage", "calls_without_outcome"):
        measure.require(natural(report[key]), "invalid_workflow_count")
    measure.require(report["execution_status"] in ("completed", "failed")
                    and digest(report["evidence_digest"])
                    and (report["duration_ms"] is None or natural(report["duration_ms"]))
                    and report["duplicates_ignored"] == 0
                    and report["started_calls"] == report["observed_calls"] + report["calls_without_usage"]
                    and report["calls_without_outcome"] <= report["started_calls"]
                    and (report["execution_status"] != "completed" or report["calls_without_outcome"] == 0)
                    and type(report["measurement_complete"]) is bool
                    and report["measurement_complete"] == (report["calls_without_usage"] == 0),
                    "invalid_workflow_report")
    expected = hashlib.sha256(("workflow:" + report["evidence_digest"]).encode()).hexdigest()
    measure.require(item["id"] == expected, "invalid_evidence_identity")


def snapshot(adapter, source):
    if adapter == "workflow":
        report = measure.workflow(source)
        digest = report["evidence_digest"]
    elif adapter == "normalized":
        data = measure.read(source)
        report = measure.aggregate(measure.lines(data))
        digest = hashlib.sha256(data).hexdigest()
    else:
        raise ValueError("unsupported_adapter")
    # This is a snapshot identity, NOT cross-file/run usage deduplication.
    key = hashlib.sha256((adapter + ":" + digest).encode()).hexdigest()
    return {"id": key, "adapter": adapter, "report": report}


def private_file(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info = os.fstat(fd)
    if not (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0 and info.st_nlink == 1):
        os.close(fd)
        raise ValueError("unsafe_store_file")
    return fd


def save(directory, item, retention_days=30, max_records=1000, now=None):
    validate_item(item)
    measure.require(type(retention_days) is int and 1 <= retention_days <= 365, "retention")
    measure.require(type(max_records) is int and 1 <= max_records <= 1000, "capacity")
    now = int(time.time()) if now is None else now
    root = Path(directory)
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    measure.require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                    and info.st_mode & 0o077 == 0, "unsafe_store_directory")
    # Ancestors must be trusted. The leaf and store files may not be symlinks.
    lock = private_file(root / ".lock", os.O_RDWR | os.O_CREAT)
    temporary = None
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        target = root / "snapshots.json"
        try:
            fd = private_file(target, os.O_RDONLY)
        except FileNotFoundError:
            records = []
        else:
            with os.fdopen(fd, "rb") as stream:
                data = stream.read(MAX_BYTES + 1)
            measure.require(len(data) <= MAX_BYTES, "store_limit")
            state = measure.decode(data)
            measure.require(type(state) is dict and set(state) == {"version", "records"}
                            and type(state["version"]) is int and state["version"] == 1
                            and type(state["records"]) is list, "invalid_store")
            records = state["records"]
        # Validate stored shape before retention, so corruption is never silently erased.
        identities = set()
        for row in records:
            measure.require(type(row) is dict and set(row) == {"id", "adapter", "report", "collected_at"}
                            and type(row["id"]) is str and len(row["id"]) == 64
                            and row["id"] not in identities
                            and row["adapter"] in ("workflow", "normalized")
                            and type(row["report"]) is dict
                            and type(row["collected_at"]) is int
                            and 0 <= row["collected_at"] <= now, "invalid_store_record")
            identities.add(row["id"])
            validate_item({key: row[key] for key in ("id", "adapter", "report")})
        records = [r for r in records if r["collected_at"] > now - retention_days * 86400]
        duplicate = next((r for r in records if r["id"] == item["id"]), None)
        if duplicate:
            measure.require(all(duplicate[k] == v for k, v in item.items()), "snapshot_conflict")
        else:
            records.append(item | {"collected_at": now})
        # Stable ordering keeps a newly collected snapshot when timestamps tie.
        records.sort(key=lambda row: row["collected_at"])
        evicted = max(0, len(records) - max_records)
        records = records[-max_records:]
        data = json.dumps({"version": 1, "records": records}, ensure_ascii=False).encode()
        measure.require(len(data) <= MAX_BYTES, "store_limit")
        # One reserved slot bounds crash leftovers; never sweep arbitrary filenames.
        pending = root / PENDING
        recovered = False
        try:
            stale_fd = private_file(pending, os.O_RDONLY)
        except FileNotFoundError:
            pass
        else:
            os.close(stale_fd)
            pending.unlink()
            recovered = True
        fd = private_file(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        temporary = pending
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        temporary = None
        directory_fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return {"status": "collected", "duplicate": duplicate is not None,
                "retained_snapshots": len(records), "capacity_evictions": evicted,
                "recovered_pending": recovered}
    finally:
        try:
            if temporary is not None:
                os.unlink(temporary)
        finally:
            os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("adapter", choices=("workflow", "normalized"))
    parser.add_argument("input")
    parser.add_argument("--store", required=True)
    parser.add_argument("--retention-days", type=int, default=30)
    parser.add_argument("--max-records", type=int, default=1000)
    args = parser.parse_args()
    start = time.monotonic()
    try:
        result = save(args.store, snapshot(args.adapter, args.input), args.retention_days, args.max_records)
    except (OSError, ValueError, TypeError, KeyError, IndexError, RecursionError):
        print(json.dumps({"status": "collection_failed", "reason": "invalid_busy_or_unwritable"}))
        return 1
    result["collector_duration_ms"] = round((time.monotonic() - start) * 1000)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
