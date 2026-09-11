"""Bounded incremental collection into a dedicated local ledger; no model calls."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time

import event_adapters as adapters
import measure
from private_state import digest, natural, transaction

CHUNK = 1024 * 1024
MAX_ROWS = 2000
MAX_STREAMS = 32
METRICS = {"attempts", "successes", "failures", "bytes_read", "duplicates", "duration_ms", "rotations"}


def initial():
    return {"version": 1, "updated_at": 0, "rows": [], "streams": {},
            "metrics": dict.fromkeys(METRICS, 0)}


def validate(state):
    measure.require(type(state) is dict and set(state) == {"version", "updated_at", "rows", "streams", "metrics"}
                    and type(state["version"]) is int and state["version"] == 1
                    and natural(state["updated_at"]), "invalid_ledger")
    metrics = state["metrics"]
    measure.require(type(metrics) is dict and set(metrics) == METRICS
                    and all(natural(v) for v in metrics.values())
                    and metrics["attempts"] == metrics["successes"] + metrics["failures"], "invalid_metrics")
    measure.require(type(state["rows"]) is list and len(state["rows"]) <= MAX_ROWS, "row_limit")
    seen = set()
    for row in state["rows"]:
        measure.require(type(row) is dict and set(row) == {"id", "scope", "adapter", "usage", "status", "at"}
                        and digest(row["id"]) and digest(row["scope"]) and row["id"] not in seen
                        and row["adapter"] in adapters.ADAPTERS and row["status"] in ("completed", "failed", "unknown")
                        and natural(row["at"]) and row["at"] <= state["updated_at"], "invalid_row")
        if row["usage"] is not None:
            measure.require(type(row["usage"]) is dict and set(row["usage"]) == set(measure.FIELDS)
                            and all(natural(v) for v in row["usage"].values()), "invalid_usage")
            measure.usage(row["usage"])
        seen.add(row["id"])
    measure.require(type(state["streams"]) is dict and len(state["streams"]) <= MAX_STREAMS, "stream_limit")
    for key, stream in state["streams"].items():
        measure.require(digest(key) and type(stream) is dict
                        and set(stream) == {"adapter", "at", "dev", "ino", "offset", "head", "tail", "parser"}
                        and stream["adapter"] in adapters.ADAPTERS
                        and all(natural(stream[k]) for k in ("at", "dev", "ino", "offset"))
                        and stream["at"] <= state["updated_at"]
                        and digest(stream["head"]) and digest(stream["tail"]), "invalid_cursor")
        adapters.validate(stream["parser"])


def anchors(stream, offset):
    stream.seek(0)
    head = hashlib.sha256(stream.read(min(offset, 4096))).hexdigest()
    stream.seek(max(0, offset - 4096))
    tail = hashlib.sha256(stream.read(min(offset, 4096))).hexdigest()
    return head, tail


def batch(path, adapter, stream_id, previous):
    # Internal capture passes an already-open anonymous file. CLI still accepts paths only.
    fd = os.dup(path) if type(path) is int else os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        measure.require(stat.S_ISREG(info.st_mode), "not_regular_file")
        offset, parser, rotated = 0, adapters.initial(), False
        if previous:
            same_file = (info.st_dev, info.st_ino) == (previous["dev"], previous["ino"])
            same_prefix = info.st_size >= previous["offset"] and anchors(source, previous["offset"]) == (
                previous["head"], previous["tail"])
            if same_file and same_prefix:
                offset, parser = previous["offset"], copy.deepcopy(previous["parser"])
            else:
                rotated = True
        source.seek(offset)
        raw = source.read(CHUNK)
        end = raw.rfind(b"\n") + 1
        measure.require(end > 0 or len(raw) < CHUNK, "line_limit")
        rows = []
        for line in raw[:end].splitlines():
            event = measure.decode(line)
            row = adapters.project(adapter, event, parser, stream_id)
            if row:
                rows.append(row | {"adapter": adapter})
        offset += end
        head, tail = anchors(source, offset)
        # Caller promises append-only input; endpoint anchors detect ordinary replacement/truncation,
        # not arbitrary malicious rewrites of the already consumed middle.
        current = os.fstat(source.fileno())
        measure.require(current.st_size >= offset, "source_shrank")
        cursor = dict(adapter=adapter, at=0, dev=info.st_dev, ino=info.st_ino, offset=offset,
                      head=head, tail=tail, parser=parser)
        return rows, cursor, len(raw), rotated, current.st_size > offset


def run(store, source=None, adapter=None, stream_id=None, retention_days=30, now=None):
    measure.require(type(retention_days) is int and 1 <= retention_days <= 365, "retention")
    if source is not None:
        measure.require(adapter in adapters.ADAPTERS and type(stream_id) is str
                        and 1 <= len(stream_id) <= 256, "explicit_stream_required")
        if type(source) is not int:
            measure.require(not Path(source).resolve().is_relative_to(Path(store).resolve()), "input_inside_store")
    now = int(time.time()) if now is None else now
    measure.require(natural(now), "invalid_time")
    started = time.monotonic()
    result = {"status": "maintained", "pending_bytes": False, "failure_recorded": False}
    with transaction(store, initial, validate) as state:
        measure.require(now >= state["updated_at"], "clock_rollback")
        cutoff = now - retention_days * 86400
        # Store is validated before expiry. Dedup is bounded by this explicit horizon.
        state["rows"] = [r for r in state["rows"] if r["at"] > cutoff]
        state["streams"] = {k: v for k, v in state["streams"].items() if v["at"] > cutoff}
        state["updated_at"] = now
        if source is not None:
            baseline = copy.deepcopy(state)
            try:
                key = adapters.identity(adapter, stream_id)
                measure.require(key in state["streams"] or len(state["streams"]) < MAX_STREAMS, "stream_limit")
                rows, cursor, read, rotated, pending = batch(source, adapter, stream_id, state["streams"].get(key))
                by_id = {r["id"]: r for r in state["rows"]}
                duplicates = 0
                for row in rows:
                    previous = by_id.get(row["id"])
                    if previous:
                        measure.require(all(previous[k] == v for k, v in row.items()), "conflicting_event")
                        duplicates += 1
                    else:
                        measure.require(len(by_id) < MAX_ROWS, "row_limit")
                        by_id[row["id"]] = row | {"at": now}
                state["rows"] = list(by_id.values())
                cursor["at"] = now
                state["streams"][key] = cursor
                state["metrics"]["successes"] += 1
                state["metrics"]["bytes_read"] += read
                state["metrics"]["duplicates"] += duplicates
                state["metrics"]["rotations"] += int(rotated)
                result.update(status="collected", pending_bytes=pending)
            except (OSError, ValueError, TypeError, KeyError, IndexError, RecursionError):
                state.clear()
                state.update(baseline)
                state["metrics"]["failures"] += 1
                result.update(status="collection_failed", failure_recorded=True)
            state["metrics"]["attempts"] += 1
            state["metrics"]["duration_ms"] += round((time.monotonic() - started) * 1000)
        result.update(retained_observations=len(state["rows"]), metrics=dict(state["metrics"]))
    result["collector_duration_ms"] = round((time.monotonic() - started) * 1000)
    return result


def report(store):
    with transaction(store, initial, validate, readonly=True) as state:
        groups = {}
        for row in state["rows"]:
            key = (row["adapter"], row["scope"])
            group = groups.setdefault(key, {"adapter": key[0], "scope": key[1], "observations": 0,
                "without_usage": 0, "completed": 0, "failed": 0, "unknown": 0,
                "usage": None, "first_collected_at": row["at"], "last_collected_at": row["at"]})
            group["observations"] += 1
            group[row["status"]] += 1
            group["last_collected_at"] = max(group["last_collected_at"], row["at"])
            if row["usage"] is None:
                group["without_usage"] += 1
            else:
                if group["usage"] is None:
                    group["usage"] = dict.fromkeys(measure.FIELDS, 0)
                for field in measure.FIELDS:
                    group["usage"][field] += row["usage"][field]
        return {"status": "reported", "metrics": state["metrics"], "updated_at": state["updated_at"],
                "groups": list(groups.values())[:32], "omitted_groups": max(0, len(groups) - 32),
                "measurement_complete": None, "quality": "unmeasured",
                "scope": "retained observations only; groups must not be added across sources or adapters"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("collect", "maintain", "report"):
        command = sub.add_parser(name)
        command.add_argument("--store", required=True)
        command.add_argument("--retention-days", type=int, default=30)
        if name == "collect":
            command.add_argument("adapter", choices=adapters.ADAPTERS)
            command.add_argument("input")
            command.add_argument("--stream-id", required=True)
    args = parser.parse_args()
    try:
        result = report(args.store) if args.command == "report" else run(
            args.store, getattr(args, "input", None), getattr(args, "adapter", None),
            getattr(args, "stream_id", None), args.retention_days)
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        result = {"status": "collection_failed", "failure_recorded": False}
    print(json.dumps(result))
    return int(result["status"] == "collection_failed")


if __name__ == "__main__":
    sys.exit(main())
