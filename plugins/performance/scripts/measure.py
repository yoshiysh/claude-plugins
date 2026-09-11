"""Offline, no-inference usage accounting. No writes or network access."""
import argparse
import hashlib
import json
import os
import stat
import sys
from datetime import datetime
from pathlib import Path

LIMIT = 32 * 1024 * 1024
FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens")


def require(condition, code):
    if not condition:
        raise ValueError(code)


def decode(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    return json.loads(data, object_pairs_hook=unique)


def read(path):
    # Nonblocking open prevents a named pipe from hanging before fstat rejects it.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "not_regular_file")
        data = stream.read(LIMIT + 1)
    require(len(data) <= LIMIT, "file_limit")
    return data


def lines(data):
    require(data.endswith(b"\n"), "incomplete_jsonl")
    result = []
    for line in data.splitlines():
        require(0 < len(line) <= 1024 * 1024, "line_limit")
        obj = decode(line)
        require(type(obj) is dict, "invalid_record")
        result.append(obj)
    return result


def usage(value):
    require(type(value) is dict, "invalid_usage")
    for key in FIELDS:
        require(type(value.get(key)) is int and value[key] >= 0, "invalid_tokens")
    require(value[FIELDS[1]] <= value[FIELDS[0]], "cache_exceeds_input")
    return {key: value[key] for key in FIELDS}


def aggregate(records):
    seen = {}
    duplicates = 0
    sources = set()
    for row in records:
        require(set(row) == {"version", "source", "run_id", "call_id", *FIELDS}, "invalid_keys")
        require(type(row["version"]) is int and row["version"] == 1, "unsupported_version")
        for key in ("source", "run_id", "call_id"):
            require(type(row[key]) is str and 0 < len(row[key]) <= 256, "invalid_identity")
        sources.add(row["source"])
        require(len(sources) <= 1, "mixed_sources")
        key = (row["source"], row["run_id"], row["call_id"])
        current = usage(row)
        if key in seen:
            require(seen[key] == current, "conflicting_duplicate")
            duplicates += 1
        seen[key] = current
    total = {key: sum(row[key] for row in seen.values()) for key in FIELDS}
    total["uncached_input_tokens"] = total["input_tokens"] - total["cached_input_tokens"]
    return {"format": "performance-report/v1", "observed_calls": len(seen),
            "duplicates_ignored": duplicates, "usage": total if seen else None,
            "measurement_complete": None, "quality": "unmeasured",
            "scope": "observed completed call usage; not billing, quota or context peak"}


def workflow(directory):
    root = Path(directory).resolve(strict=True)
    paths = [root / name for name in ("request.json", "events.jsonl")]
    require(all(p.resolve(strict=True).parent == root for p in paths), "outside_run")
    request, journal = (read(p) for p in paths)
    require(type(decode(request)) is dict, "invalid_request")
    events = lines(journal)
    require(events[0].get("type") == "run.started", "missing_start")
    require(events[-1].get("type") in ("run.completed", "run.failed"), "missing_terminal")
    starts, outcomes, measured = set(), set(), set()
    records = []
    run_id = hashlib.sha256(request).hexdigest()
    allowed = {"run.started", "run.completed", "run.failed", "agent.started", "agent.completed",
               "agent.failed", "agent.invalid_output", "agent.event", "phase", "log"}
    for index, event in enumerate(events):
        require(type(event.get("sequence")) is int and event["sequence"] == index + 1, "sequence_gap")
        kind = event.get("type")
        require(kind in allowed, "unknown_event")
        if kind == "run.started":
            require(index == 0, "duplicate_start")
        if kind in ("run.completed", "run.failed"):
            require(index == len(events) - 1, "early_terminal")
        if kind.startswith("agent."):
            ident = event.get("id")
            require(type(ident) is int and ident > 0, "invalid_call_id")
            if kind == "agent.started":
                require(ident not in starts, "duplicate_call")
                starts.add(ident)
                continue
            require(ident in starts and ident not in outcomes, "orphan_event")
            if kind in ("agent.completed", "agent.failed"):
                outcomes.add(ident)
            if kind == "agent.event":
                inner = event.get("event")
                require(type(inner) is dict, "invalid_inner_event")
                if inner.get("type") == "turn.completed":
                    require(ident not in measured, "duplicate_usage_event")
                    measured.add(ident)
                    value = inner.get("usage")
                    if value is None or (type(value) is dict and any(k not in value for k in FIELDS)):
                        continue
                    records.append({"version": 1, "source": "dynamic-workflow/v1",
                                    "run_id": run_id, "call_id": str(ident), **usage(value)})
    # A successful return with unfinished calls is outside this adapter's closed-run contract.
    if events[-1]["type"] == "run.completed":
        require(starts == outcomes, "unfinished_success")
    report = aggregate(records)
    known = {int(r["call_id"]) for r in records}
    report.update({"execution_status": events[-1]["type"].removeprefix("run."),
                   "started_calls": len(starts), "calls_without_usage": len(starts - known),
                   "calls_without_outcome": len(starts - outcomes),
                   "measurement_complete": starts == known,
                   "evidence_digest": hashlib.sha256(request + b"\0" + journal).hexdigest()})
    try:
        start, end = [datetime.fromisoformat(e["time"].replace("Z", "+00:00")) for e in (events[0], events[-1])]
        require(start.tzinfo is not None and end.tzinfo is not None, "missing_timezone")
        duration = (end - start).total_seconds() * 1000
        report["duration_ms"] = round(duration) if duration >= 0 else None
    except (KeyError, TypeError, ValueError, AttributeError):
        report["duration_ms"] = None
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("adapter", choices=("workflow", "normalized"))
    parser.add_argument("input")
    args = parser.parse_args()
    try:
        report = workflow(args.input) if args.adapter == "workflow" else aggregate(lines(read(args.input)))
        print(json.dumps(report, ensure_ascii=False))
    except (OSError, ValueError, TypeError, IndexError, RecursionError):
        # Avoid leaking source paths, malformed JSON or content through exceptions.
        print(json.dumps({"status": "measurement_failed", "reason": "invalid_or_unreadable_evidence"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
