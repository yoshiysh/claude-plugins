"""Explicit event formats, never transcript autodetection. No inference or raw-text output."""
import hashlib
import json

import measure
from private_state import digest, natural

ADAPTERS = ("normalized", "codex-exec", "claude-query")


def identity(*values):
    return hashlib.sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


def initial():
    return {"thread": None, "turn": 0, "active": False, "closed": False}


def validate(state):
    measure.require(type(state) is dict and set(state) == {"thread", "turn", "active", "closed"}
                    and (state["thread"] is None or digest(state["thread"]))
                    and natural(state["turn"]) and type(state["active"]) is bool
                    and type(state["closed"]) is bool, "invalid_adapter_state")


def project(adapter, event, state, stream):
    measure.require(adapter in ADAPTERS and type(event) is dict, "invalid_event")
    if adapter == "normalized":
        report = measure.aggregate([event])
        return {"id": identity(adapter, event["source"], event["run_id"], event["call_id"]),
                "scope": identity(adapter, event["source"]),
                "usage": {k: report["usage"][k] for k in measure.FIELDS}, "status": "unknown"}
    kind = event.get("type")
    if adapter == "codex-exec":
        if kind == "thread.started":
            measure.require(state["thread"] is None and type(event.get("thread_id")) is str
                            and 0 < len(event["thread_id"]) <= 256, "thread_start")
            state["thread"] = identity(event["thread_id"])
        elif kind == "turn.started":
            measure.require(state["thread"] is not None and not state["active"], "turn_start")
            state["active"] = True
            state["turn"] += 1
        elif kind in ("turn.completed", "turn.failed"):
            measure.require(state["active"], "orphan_terminal")
            state["active"] = False
            value = event.get("usage")
            if kind == "turn.failed" or value is None or any(k not in value for k in measure.FIELDS):
                value = None
            else:
                value = measure.usage(value)
            return {"id": identity(adapter, stream, state["thread"], state["turn"]),
                    "scope": identity(adapter, stream),
                    "usage": value, "status": kind.removeprefix("turn.")}
        else:
            measure.require(kind in ("item.started", "item.updated", "item.completed", "error"),
                            "unsupported_codex_event")
    else:
        # Single-shot query only. Streaming-input cumulative results are not additive.
        if kind == "result":
            measure.require(not state["closed"], "multiple_query_results")
            state["closed"] = True
            measure.require(type(event.get("is_error")) is bool, "missing_result_status")
            success = event.get("subtype") == "success" and not event["is_error"]
            value = None
            if success:
                usage = event.get("usage")
                fields = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
                if type(usage) is dict and all(k in usage for k in fields):
                    measure.require(all(natural(usage[k]) for k in fields), "invalid_claude_usage")
                    value = dict(input_tokens=sum(usage[k] for k in fields[:3]),
                                 cached_input_tokens=usage["cache_read_input_tokens"],
                                 output_tokens=usage["output_tokens"])
            return {"id": identity(adapter, stream), "usage": value,
                    "scope": identity(adapter, stream),
                    "status": "completed" if success else "failed"}
        measure.require(kind in ("system", "assistant", "user", "stream_event", "tool_progress",
                                 "tool_use_summary", "auth_status", "rate_limit_event"),
                        "unsupported_claude_event")
        measure.require(not state["closed"], "event_after_result")
    return None
