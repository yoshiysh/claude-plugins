"""Bounded explicit native JSONL collection; metadata only, no inference or scans.

Claude input = fresh + cache creation + cache read. Codex cached input is a
subset of input; its total_token_usage is one session snapshot, never a delta.
Trusted path ancestors are required. No claim of complete billing coverage.
"""
import hashlib
import os
import stat
import time

from measure import decode, require
from private_state import digest, natural, transaction

MAX_BYTES = 16 * 1024 * 1024
MAX_LINES = 100000
MAX_RECORDS = 2000
MAX_SESSIONS = 100
MAX_SKIPPED = 100
RETENTION_DAYS = 30
FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens")
# サイズ上限による不収集は「失敗」ではなく打ち切り（censoring）として ledger に残す。
# 上限に当たるのは長い session、つまり最も高コストな観測ほど計測から消える系統的な偏りであり、
# 黙って落とすと集計が安い側へ偏った事実ごと見えなくなる。データ整合性エラー（不正レコード等）
# はこの分類に入れず従来どおり例外のまま伝播させる（壊れた入力を「大きすぎた」と混同しない）。
CENSOR_REASONS = ("source_limit", "line_count_limit", "line_limit", "record_limit")


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


def identity(value):
    require(type(value) is str and 0 < len(value) <= 4096, "invalid_identity")
    return value


def tokens(value, names):
    require(type(value) is dict and all(natural(value.get(k)) for k in names), "invalid_native_usage")
    return {k: value[k] for k in names}


def normalized(value):
    result = tokens(value, FIELDS)
    require(result["cached_input_tokens"] <= result["input_tokens"], "cache_exceeds_input")
    return result


def monotonic(previous, current):
    require(all(current[k] >= previous[k] for k in previous), "usage_regression")


def read_source(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), "unsafe_source")
        require(info.st_size <= MAX_BYTES, "source_limit")
        raw = stream.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, "source_limit")
    incomplete = bool(raw) and not raw.endswith(b"\n")
    rows = raw.split(b"\n")[:-1]
    require(len(rows) <= MAX_LINES, "line_count_limit")
    return rows, incomplete


def parse(host, path):
    rows, incomplete = read_source(path)
    records = {}
    updates = 0
    missing = 0
    for line in rows:
        require(0 < len(line) <= 1024 * 1024, "line_limit")
        row = decode(line)
        require(type(row) is dict, "invalid_native_record")
        if host == "claude" and row.get("type") == "assistant":
            message = row.get("message")
            require(type(message) is dict, "invalid_assistant_message")
            if "usage" not in message:
                missing += 1
                continue
            key = hashed(identity(message.get("id")))
            u = tokens(message["usage"], ("input_tokens", "cache_creation_input_tokens",
                                         "cache_read_input_tokens", "output_tokens"))
            current = {"input_tokens": u["input_tokens"] + u["cache_creation_input_tokens"]
                       + u["cache_read_input_tokens"],
                       "cached_input_tokens": u["cache_read_input_tokens"],
                       "output_tokens": u["output_tokens"],
                       "fresh_input_tokens": u["input_tokens"],
                       "cache_creation_input_tokens": u["cache_creation_input_tokens"]}
            normalized(current)
        elif host == "codex" and row.get("type") == "event_msg":
            payload = row.get("payload")
            require(type(payload) is dict, "invalid_event_payload")
            if payload.get("type") != "token_count":
                continue
            info = payload.get("info")
            if info is None:
                missing += 1
                continue
            require(type(info) is dict, "invalid_token_info")
            raw_usage = info.get("total_token_usage")
            current = normalized(raw_usage)
            for optional in ("total_tokens", "reasoning_output_tokens"):
                if optional in raw_usage:
                    require(natural(raw_usage[optional]), "invalid_native_usage")
            if "total_tokens" in raw_usage:
                require(raw_usage["total_tokens"] == current["input_tokens"] + current["output_tokens"],
                        "invalid_total_tokens")
            if "reasoning_output_tokens" in raw_usage:
                require(raw_usage["reasoning_output_tokens"] <= current["output_tokens"],
                        "reasoning_exceeds_output")
            key = hashed("cumulative_session")
        else:
            continue
        if key in records:
            monotonic(records[key], current)
            updates += 1
        records[key] = current
        require(len(records) <= MAX_RECORDS, "record_limit")
    return records, incomplete, updates, missing


def initial():
    return {"version": 1, "sessions": {}, "skipped": {}}


def validate(state):
    # "skipped" 導入前の既存 store（{"version","sessions"} のみ）は読み込み時に補完する。
    # 旧形を拒否すると、更新した瞬間から過去の ledger 全体が読めなくなる。
    require(type(state) is dict
            and set(state) in ({"version", "sessions"}, {"version", "sessions", "skipped"})
            and type(state["version"]) is int and state["version"] == 1
            and type(state["sessions"]) is dict and len(state["sessions"]) <= MAX_SESSIONS,
            "invalid_native_store")
    state.setdefault("skipped", {})
    require(type(state["skipped"]) is dict and len(state["skipped"]) <= MAX_SKIPPED, "invalid_skip_store")
    for key, row in state["skipped"].items():
        require(digest(key) and type(row) is dict and set(row) == {
            "host", "path_hash", "updated_at", "reason", "count"}, "invalid_skip_entry")
        require(row["host"] in ("claude", "codex") and digest(row["path_hash"])
                and natural(row["updated_at"]) and row["reason"] in CENSOR_REASONS
                and natural(row["count"]) and row["count"] >= 1, "invalid_skip_metadata")
    count = 0
    for key, row in state["sessions"].items():
        require(digest(key) and type(row) is dict and set(row) == {
            "host", "path_hash", "updated_at", "records", "incomplete", "missing_usage"},
            "invalid_native_session")
        require(row["host"] in ("claude", "codex") and digest(row["path_hash"])
                and natural(row["updated_at"]) and type(row["incomplete"]) is bool
                and natural(row["missing_usage"]) and type(row["records"]) is dict,
                "invalid_native_metadata")
        require(row["host"] != "codex" or set(row["records"]) <= {hashed("cumulative_session")},
                "invalid_codex_snapshot")
        for record_id, value in row["records"].items():
            extras = {"fresh_input_tokens", "cache_creation_input_tokens"} if row["host"] == "claude" else set()
            require(digest(record_id) and type(value) is dict and set(value) == set(FIELDS) | extras,
                    "invalid_native_record")
            normalized(value)
            if extras:
                tokens(value, extras)
                require(value["input_tokens"] == value["fresh_input_tokens"]
                        + value["cache_creation_input_tokens"] + value["cached_input_tokens"],
                        "invalid_claude_input")
        count += len(row["records"])
    require(count <= MAX_RECORDS, "record_limit")


def summarize(state):
    sessions = list(state["sessions"].values())
    records = [u for row in sessions for u in row["records"].values()]
    skipped = list(state.get("skipped", {}).values())
    return {"format": "performance-native-report/v1", "retained_sessions": len(sessions),
            "observed_usage_records": len(records),
            "usage": {k: sum(u[k] for u in records) for k in FIELDS} if records else None,
            "incomplete_sources": sum(row["incomplete"] for row in sessions),
            "missing_usage_events": sum(row["missing_usage"] for row in sessions),
            # censored: 上限超過で観測から外れた session。usage 合計はこの分を含まないので、
            # censored_sessions > 0 のとき合計は下方に偏っている（0 と「無い」を混同しない）。
            "censored_sessions": len(skipped),
            "censored_by_reason": {r: sum(1 for row in skipped if row["reason"] == r)
                                   for r in CENSOR_REASONS if any(row["reason"] == r for row in skipped)},
            "measurement_complete": None, "quality": "unmeasured",
            "scope": "retained observed native usage; not billing, quota or context peak",
            "retention_days": RETENTION_DAYS}


def record_skip(host, key, path_hash, reason, store):
    """上限超過による不収集を打ち切りとして記録する。収集の代替ではなく欠測の可視化。"""
    now = int(time.time())
    with transaction(store, initial, validate) as state:
        skipped = state["skipped"]
        for old_key in list(skipped):
            if skipped[old_key]["updated_at"] <= now - RETENTION_DAYS * 86400:
                del skipped[old_key]
        previous = skipped.pop(key, None)
        count = (previous["count"] if previous and previous["reason"] == reason else 0) + 1
        skipped[key] = {"host": host, "path_hash": path_hash, "updated_at": now,
                        "reason": reason, "count": min(count, 2**63 - 1)}
        while len(skipped) > MAX_SKIPPED:
            victim = min((k for k in skipped if k != key), key=lambda k: skipped[k]["updated_at"])
            del skipped[victim]
        result = summarize(state)
        result.update(status="censored", reason=reason)
        return result


def collect(host, path, session_id, store):
    """Read only path; merge into dedicated private store. Same session binds path."""
    require(host in ("claude", "codex"), "unsupported_host")
    key = hashed(host + ":" + identity(session_id))
    path_hash = hashed(os.path.abspath(os.fspath(path)))
    try:
        records, incomplete, updates, missing = parse(host, path)
    except ValueError as error:
        if str(error) in CENSOR_REASONS:
            return record_skip(host, key, path_hash, str(error), store)
        raise
    now = int(time.time())
    with transaction(store, initial, validate) as state:
        sessions = state["sessions"]
        for old_key in list(sessions):
            if sessions[old_key]["updated_at"] <= now - RETENTION_DAYS * 86400:
                del sessions[old_key]
        # 過去に打ち切られた session が収まる大きさで観測できたなら、打ち切り記録は解消する。
        state["skipped"].pop(key, None)
        previous = sessions.get(key)
        if previous:
            require(previous["path_hash"] == path_hash, "session_path_conflict")
            for record_id, value in records.items():
                if record_id in previous["records"]:
                    monotonic(previous["records"][record_id], value)
            records = previous["records"] | records
        require(len(records) <= MAX_RECORDS, "record_limit")
        sessions.pop(key, None)
        sessions[key] = {"host": host, "path_hash": path_hash, "updated_at": now,
                         "records": records, "incomplete": incomplete, "missing_usage": missing}
        evicted = 0
        while len(sessions) > MAX_SESSIONS or sum(len(s["records"]) for s in sessions.values()) > MAX_RECORDS:
            victim = min((k for k in sessions if k != key), key=lambda k: sessions[k]["updated_at"])
            del sessions[victim]
            evicted += 1
        result = summarize(state)
        result.update(status="collected", duplicate_updates=updates, capacity_evictions=evicted)
        return result


def report(store):
    """Read-only retained-state report; expiration is applied to view, not disk."""
    with transaction(store, initial, validate, readonly=True) as state:
        cutoff = int(time.time()) - RETENTION_DAYS * 86400
        return summarize({"sessions": {k: v for k, v in state["sessions"].items()
                                      if v["updated_at"] > cutoff},
                          "skipped": {k: v for k, v in state["skipped"].items()
                                      if v["updated_at"] > cutoff}})
