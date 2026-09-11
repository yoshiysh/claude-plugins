"""Opt-in, silent, bounded hook trigger. Never uses payload paths or starts a model."""
import os
from pathlib import Path
import select
import subprocess
import sys
import time

import event_adapters
import measure


def payload():
    deadline = time.monotonic() + 1
    raw = b""
    while time.monotonic() < deadline:
        ready, _, _ = select.select([sys.stdin], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        part = os.read(sys.stdin.fileno(), 4096)
        if not part:
            break
        raw += part
        measure.require(len(raw) <= 65536, "payload_limit")
        try:
            value = measure.decode(raw)
        except (ValueError, UnicodeError):
            continue
        measure.require(type(value) is dict, "payload")
        return value
    raise ValueError("incomplete_payload")


def command(config, event):
    required = {"version", "enabled", "host", "cwd", "adapter", "input", "stream_id", "store", "retention_days"}
    measure.require(type(config) is dict and required <= set(config) <= required | {"proposal"}
        and type(config["version"]) is int and config["version"] == 1
        and type(config["enabled"]) is bool, "config")
    if not config["enabled"]:
        return None
    measure.require(config["host"] in ("codex", "claude") and config["adapter"] in event_adapters.ADAPTERS,
                    "host_adapter")
    if event.get("hook_event_name") not in ("Stop", "SubagentStop", "SessionEnd") or event.get("stop_hook_active") is True:
        return None
    # Codex SessionEnd is capped at 3s, below this worker's worst-case budget.
    # Final usage is drained by the producer owner after wait(), never by this hook.
    if config["host"] == "codex" and event.get("hook_event_name") == "SessionEnd":
        return None
    for key in ("cwd", "input", "store"):
        measure.require(type(config[key]) is str and Path(config[key]).is_absolute(), "absolute_path")
    if type(event.get("cwd")) is not str or Path(event["cwd"]).resolve() != Path(config["cwd"]).resolve():
        return None
    measure.require(type(config["stream_id"]) is str and 1 <= len(config["stream_id"]) <= 256
                    and type(config["retention_days"]) is int and 1 <= config["retention_days"] <= 365,
                    "collection_policy")
    # Only trusted configured paths are read; transcript_path / agent_transcript_path are ignored.
    return [sys.executable, "-E", "-s", "-B", str(Path(__file__).with_name("stream_collect.py")), "collect",
            config["adapter"], config["input"], "--store", config["store"], "--stream-id", config["stream_id"],
            "--retention-days", str(config["retention_days"])]


def main():
    # Fail-open for the host, fail-closed for accounting. No blocking decision or output.
    try:
        if len(sys.argv) != 3 or sys.argv[1] != "--config":
            return 0
        raw = measure.read(sys.argv[2])
        measure.require(len(raw) <= 65536, "config_limit")
        config = measure.decode(raw)
        if type(config) is dict and config.get("enabled") is False:
            return 0
        invocation = command(config, payload())
        if invocation:
            subprocess.run(invocation, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=3, check=False)
            proposal = config.get("proposal")
            if proposal is not None:
                measure.require(type(proposal) is dict and set(proposal) == {"input", "store"}
                                and all(type(v) is str and Path(v).is_absolute() for v in proposal.values()),
                                "proposal_config")
                subprocess.run([sys.executable, "-E", "-s", "-B", str(Path(__file__).with_name("proposals.py")),
                    "evaluate", "--input", proposal["input"], "--store", proposal["store"]],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=2, check=False)
    except (Exception, SystemExit):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
