"""Explicit bounded producer execution, followed by post-exit event collection. No shell."""
import argparse
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import uuid

import event_adapters
import measure
import stream_collect
from private_state import transaction

MAX_BYTES = 16 * 1024 * 1024
MAX_BATCHES = 32


def drain(store, source, adapter, stream_id):
    """Internal: owner must have observed producer exit AND stdout EOF before calling."""
    previous = -1
    key = event_adapters.identity(adapter, stream_id)
    for _ in range(MAX_BATCHES):
        result = stream_collect.run(store, source, adapter, stream_id)
        measure.require(result["status"] == "collected", "collection_failed")
        with transaction(store, stream_collect.initial, stream_collect.validate, readonly=True) as state:
            cursor = state["streams"][key]
            offset, parser = cursor["offset"], cursor["parser"]
        if not result["pending_bytes"]:
            if adapter == "codex-exec-v1":
                measure.require(parser["thread"] is not None and parser["turn"] > 0
                                and not parser["active"], "missing_terminal")
            elif adapter == "claude-query-v1":
                measure.require(parser["closed"], "missing_terminal")
            report = stream_collect.report(store)
            # This store is dedicated to this capture, not a historical shared ledger.
            measure.require(len(report["groups"]) > 0 and report["omitted_groups"] == 0, "empty_capture")
            return report
        measure.require(offset > previous, "incomplete_tail")
        previous = offset
    raise ValueError("drain_limit")


def stop_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def run(command, adapter, store, timeout=60, max_bytes=MAX_BYTES):
    measure.require(adapter in event_adapters.ADAPTERS and type(command) is list and command and command[0]
                    and all(type(v) is str and '\0' not in v for v in command), "command")
    measure.require(type(timeout) in (int, float) and 0 < timeout <= 300
                    and type(max_bytes) is int and 0 < max_bytes <= MAX_BYTES, "limits")
    store = Path(store)
    # No overwrite/reuse: each explicit producer invocation gets a unique capture and private store.
    store.mkdir(mode=0o700)
    start = time.monotonic()
    status, code, report = "capture_failed", None, None
    captured = 0
    process = None
    try:
        # TemporaryFile unlinks its name immediately on POSIX. SIGKILL cannot orphan a raw log.
        with tempfile.TemporaryFile(mode="w+b", buffering=0) as output:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    eof = False
                    while not eof:
                        left = timeout - (time.monotonic() - start)
                        if left <= 0:
                            raise TimeoutError("producer_timeout")
                        for event, _ in selector.select(min(left, 0.1)):
                            part = os.read(event.fileobj.fileno(), min(65536, max_bytes - captured + 1))
                            if not part:
                                eof = True
                                break
                            measure.require(captured + len(part) <= max_bytes, "capture_limit")
                            output.write(part)
                            captured += len(part)
                    code = process.wait(timeout=max(0.001, timeout - (time.monotonic() - start)))
            finally:
                # On timeout/cap/error, also stop descendants retaining the stdout pipe.
                if code is None:
                    stop_group(process)
                process.stdout.close()
            report = drain(store, output.fileno(), adapter, str(uuid.uuid4()))
            status = "collected" if code == 0 else "producer_failed"
    except (OSError, ValueError, TypeError, KeyError, TimeoutError, subprocess.TimeoutExpired):
        status = "capture_failed"
    return {"status": status, "producer_exit_code": code, "captured_bytes": captured,
            "elapsed_ms": round((time.monotonic() - start) * 1000), "report": report,
            "scope": "explicit producer stdout only; not all host activity or billing",
            "quality": "unmeasured"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", required=True, choices=event_adapters.ADAPTERS)
    parser.add_argument("--store", required=True)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    try:
        result = run(command, args.adapter, args.store, args.timeout)
    except (OSError, ValueError, TypeError):
        result = {"status": "capture_failed", "producer_exit_code": None, "report": None}
    print(json.dumps(result))
    return 0 if result["status"] == "collected" else 1


if __name__ == "__main__":
    sys.exit(main())
