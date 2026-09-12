"""Captured host dispatch records -> explicit skill events. Deterministic.

Probe result this module encodes (measured on Claude Code, claude -p with a
project skill): PreToolUse/PostToolUse with matcher Skill fire with
tool_input.skill and tool_use_id, so the dispatch START is host-observed
(tier a boundary evidence). PostToolUse marks the end of the skill LOAD, not
of the skill's work — the Skill tool returns after injecting instructions —
so no skill_end is emitted and the invocation honestly stays open with its
terminal state unknown.
"""
import hashlib
import json
from pathlib import Path

from measure import require


def fingerprint_skill_dir(path, computed_at):
    """スキル実装の決定的 inventory digest（相対パス + 内容の sha256）。"""
    root = Path(path)
    require(root.is_dir(), "skill_dir_required")
    digest = hashlib.sha256()
    for file in sorted(p for p in root.rglob("*") if p.is_file()):
        digest.update(str(file.relative_to(root)).encode())
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return {"digest": digest.hexdigest(), "computed_at": computed_at, "drift": None}


def load_records(path):
    rows = []
    censored = []
    for line in Path(path).read_text().splitlines():
        row = json.loads(line)
        if "censored" in row:
            censored.append(row["censored"])
            continue
        rows.append(row)
    return {"records": rows, "censored": censored}


def to_events(records, fingerprints):
    """dispatch 記録を skill_events.project_events の入力へ変換する。

    fingerprints は {skill 名: fingerprint} — 実装 inventory は捕捉時の hook では
    計算しない（3 秒予算に収まらない）ので、変換時に fingerprint_skill_dir で
    作った対応表を渡す。表に無い skill の記録は unresolved に分けて返し、
    黙って落とさない。
    """
    events = []
    unresolved = []
    stops = sorted((r for r in records if r["event"] == "Stop"),
                   key=lambda r: r["captured_at"])
    for row in records:
        if row["event"] != "PreToolUse":
            # PostToolUse は load 終端。invocation の終端ではないので skill_end に
            # しない（したら「読込完了」が「実行成功」に化ける）。Stop は下で
            # cutoff としてだけ使う。
            continue
        name = row["skill"]
        if name not in fingerprints:
            unresolved.append(row)
            continue
        events.append({
            "type": "skill_start",
            "invocation_id": row["tool_use_id"],
            "parent_invocation_id": None,
            "root_invocation_id": row["tool_use_id"],
            "skill": {"marketplace": None, "plugin": name.split(":")[0],
                      "public_name": name.split(":")[-1], "scope": row["cwd"]},
            "fingerprint": fingerprints[name],
            "boundary_evidence": "host_dispatch",
            "at": row["captured_at"],
        })
        # 同一 session で dispatch より後の最初の Stop = censoring cutoff。
        # スキルの仕事がそこで終わった観測ではない（turn 境界での観測の打ち切り）
        # ので status は censored。cutoff の意味は status が運び、ended_at は
        # 打ち切り時刻になる — 派生 duration を作らないのは下流（cohort/report）の
        # 責務で、そこが本変更の安全性の全体（Plan v4 findings）。
        cutoff = next((s for s in stops
                       if s["session_id"] == row["session_id"]
                       and s["captured_at"] > row["captured_at"]), None)
        if cutoff is not None:
            events.append({"type": "skill_end",
                           "invocation_id": row["tool_use_id"],
                           "status": "censored",
                           "at": cutoff["captured_at"]})
    return {"events": events, "unresolved": unresolved}
