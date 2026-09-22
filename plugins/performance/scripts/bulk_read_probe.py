"""Observation-mode PreToolUse probe for large Read calls.

Non-blocking and local-only. On a Read tool call this stats the target file's
size WITHOUT reading content, then appends a hashed record to a private ledger so
the size distribution can be measured to calibrate a delegation threshold. It never
sends data externally, never reads file bodies, and never blocks the tool call: it
always exits 0 and writes nothing model-facing to stdout.

Host-agnostic: parses both Claude Code and Codex PreToolUse JSON shapes. Only files
owned by the current user are measured (owner match) and symlinks are never followed,
so other users' data is left untouched.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import time
from pathlib import Path

from collect import private_file
from measure import require

DEFAULT_THRESHOLD_BYTES = 20000
MAX_RECORD_BYTES = 4096
MAX_LOG_BYTES = 10 * 1024 * 1024
DATA_DIR_ENV = "BULK_READ_DATA_DIR"
DEFAULT_DATA_DIR = "~/.local/share/yoshiysh-performance/bulk-read"


def threshold_bytes():
    override = os.environ.get("BULK_READ_THRESHOLD_BYTES")
    if override and override.strip():
        try:
            value = int(override)
        except ValueError:
            return DEFAULT_THRESHOLD_BYTES
        require(value >= 0, "negative_threshold")
        return value
    return DEFAULT_THRESHOLD_BYTES


def detect_host(event):
    if isinstance(event.get("turn_id"), str) and event["turn_id"]:
        return "codex"
    if isinstance(event.get("tool_use_id"), str) or isinstance(event.get("transcript_path"), str):
        return "claude"
    return "claude"


def read_targets(event):
    tool = event.get("tool_name")
    if not isinstance(tool, str):
        return None, []
    tin = event.get("tool_input")
    paths = []
    if isinstance(tin, dict):
        for key in ("file_path", "path"):
            value = tin.get(key)
            if isinstance(value, str) and value:
                paths.append(value)
    elif isinstance(tin, str) and tin:
        paths.append(tin)
    return tool, [p for p in paths if p]


def resolve_path(raw, cwd):
    if not isinstance(raw, str) or not raw:
        return None
    candidate = Path(raw)
    if not candidate.is_absolute() and cwd:
        candidate = Path(cwd) / raw
    try:
        resolved = candidate.resolve(strict=False)
    except OSError:
        return None
    text = str(resolved)
    require(isinstance(text, str) and len(text) <= 1024, "path_too_long")
    return text


def safe_size(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    if not (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_nlink == 1):
        return None
    size = int(info.st_size)
    require(size >= 0, "negative_size")
    return size


def data_root():
    override = os.environ.get(DATA_DIR_ENV)
    base = Path(override) if override and override.strip() else Path(DEFAULT_DATA_DIR)
    expanded = str(base.expanduser())
    require(isinstance(expanded, str) and len(expanded) <= 1024, "data_dir_long")
    return expanded


def rotate_if_needed(log_path):
    try:
        if log_path.stat().st_size >= MAX_LOG_BYTES:
            backup = log_path.with_name(log_path.name + ".1")
            if backup.exists():
                try:
                    backup.unlink()
                except OSError:
                    pass
            try:
                os.replace(log_path, backup)
            except OSError:
                pass
    except OSError:
        pass


def append_record(host, tool_name, hashed, size):
    root = Path(data_root())
    try:
        root.mkdir(mode=0o700, exist_ok=True)
    except OSError:
        return
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0, "unsafe_data_dir")
    log_path = root / "probe.log"
    rotate_if_needed(log_path)
    record = {
        "t": int(time.time()),
        "host": host,
        "tool": tool_name or "Read",
        "path": hashed,
        "bytes": size,
    }
    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
    require(len(line) <= MAX_RECORD_BYTES, "record_too_long")
    try:
        fd = private_file(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
    except OSError:
        return
    try:
        os.write(fd, line)
    finally:
        os.close(fd)


def hash_path(text):
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    require(len(digest) == 64 and all(c in "0123456789abcdef" for c in digest), "bad_digest")
    return digest


def main(argv):
    host = None
    rest = list(argv[1:])
    while rest:
        token = rest.pop(0)
        if token == "--host" and rest:
            host = rest.pop(0)
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
        require(isinstance(event, dict), "event_not_object")
    except (ValueError, OSError):
        return 0

    if host is None:
        host = detect_host(event)

    try:
        tool, paths = read_targets(event)
        cwd = event.get("cwd")
        cwd = cwd if isinstance(cwd, str) else None
        for target in paths:
            resolved = resolve_path(target, cwd)
            if not resolved:
                continue
            size = safe_size(resolved)
            if size is None or size < threshold_bytes():
                continue
            append_record(host, tool, hash_path(resolved), size)
    except (ValueError, OSError):
        return 0
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except Exception:
        if os.environ.get("BULK_READ_DEBUG"):
            print("bulk_read_probe error", file=sys.stderr)
        sys.exit(0)
