"""Bounded private JSON transactions. Dedicated directory; trusted ancestors only."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import stat

from collect import private_file
from measure import decode, require

LIMIT = 2 * 1024 * 1024
NAMES = {".lock", "state.json", ".pending"}


@contextmanager
def transaction(directory, initial, validate, readonly=False):
    root = Path(directory)
    if not readonly:
        root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0, "unsafe_directory")
    lock = private_file(root / ".lock", os.O_RDONLY if readonly else os.O_RDWR | os.O_CREAT)
    pending = False
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(set(p.name for p in root.iterdir()) <= NAMES, "unknown_store_files")
        for name in NAMES:
            try:
                fd = private_file(root / name, os.O_RDONLY)
            except FileNotFoundError:
                continue
            try:
                require(os.fstat(fd).st_size <= (0 if name == ".lock" else LIMIT), "store_limit")
            finally:
                os.close(fd)
        try:
            fd = private_file(root / "state.json", os.O_RDONLY)
        except FileNotFoundError:
            state = initial()
        else:
            with os.fdopen(fd, "rb") as stream:
                raw = stream.read(LIMIT + 1)
            require(len(raw) <= LIMIT, "store_limit")
            state = decode(raw)
        validate(state)
        yield state
        if readonly:
            return
        validate(state)
        raw = json.dumps(state, separators=(",", ":"), allow_nan=False).encode()
        require(len(raw) <= LIMIT, "store_limit")
        try:
            (root / ".pending").unlink()
        except FileNotFoundError:
            pass
        fd = private_file(root / ".pending", os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        pending = True
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(root / ".pending", root / "state.json")
        pending = False
        fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        try:
            if pending:
                (root / ".pending").unlink()
        finally:
            os.close(lock)


def natural(value):
    return type(value) is int and 0 <= value <= 2**63 - 1


def digest(value):
    return type(value) is str and len(value) == 64 and all(c in "0123456789abcdef" for c in value)
