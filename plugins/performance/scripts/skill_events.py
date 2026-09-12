"""Explicit skill-execution events -> schema_v2 run. No transcript autodetection.

The projection only consumes events a host or the explicit entry wrapper
declared; nothing is inferred from file reads, skill names in prose, or time
overlap. A SKILL.md read is recorded as evidence of reading, never of
execution. Declared-only boundaries survive, but their coverage can never be
complete — the distinction between declared and measured is kept, not fixed.
"""
import schema_v2
from measure import require
from private_state import natural

# 投影が受け付ける出来事。閉じてあるのは、未知の型を黙って握ると「観測しなかった」と
# 「観測対象でなかった」の区別が消えるため。未知の型は reject し、呼び出し側が
# adapter 側で明示的に落とすか変換する。
EVENT_TYPES = (
    "skill_start",   # invocation の開始。boundary evidence を必ず運ぶ
    "skill_end",     # invocation の終了。status を必ず運ぶ
    "span_start",
    "span_end",
    "usage",         # usage atom 1 件。claimed_by で所有 invocation を申告する
    "skill_md_read", # SKILL.md が読まれた事実。実行の証拠ではない（invocation を作らない）
)

# usage イベントの claimed_by が複数 invocation を指した場合、按分せず未帰属で保持する。
# 按分は任意の重みを要求し、その重みの根拠を観測が持たないため（Issue #60 §3）。


def _span_kind_default(kind):
    return kind if kind in schema_v2.SPAN_KINDS else "agent"


def project_events(events):
    """イベント列を schema_v2.validate_run が通る run に投影する。

    決定的: 同じ列からは同じ run が出る。skill_md_read だけの列からは
    invocation が 1 件も出ない（読込を実行扱いしない）。
    """
    require(type(events) is list, "invalid_events")
    invocations = []
    spans = []
    atoms = []
    coverage = {}
    open_invocations = {}
    md_reads = []

    for event in events:
        require(type(event) is dict and event.get("type") in EVENT_TYPES,
                "unknown_event_type")
        kind = event["type"]

        if kind == "skill_md_read":
            # 読込は記録するが、invocation・span・atom のいずれも生まない。
            md_reads.append({"path": str(event.get("path", "")),
                             "at": event.get("at")})
            continue

        if kind == "skill_start":
            row = {
                "invocation_id": event["invocation_id"],
                "parent_invocation_id": event.get("parent_invocation_id"),
                "root_invocation_id": event.get("root_invocation_id",
                                                event["invocation_id"]),
                "skill": event["skill"],
                "fingerprint": event["fingerprint"],
                "started_at": event["at"],
                "ended_at": None,
                "status": "running",
                "boundary_evidence": event["boundary_evidence"],
            }
            schema_v2.validate_invocation(row)
            invocations.append(row)
            open_invocations[row["invocation_id"]] = row
            # coverage の初期値: 何も観測が揃っていない段階は unknown。
            # declared 境界は complete に到達する経路が無い（validate_run が拒む）。
            coverage[row["invocation_id"]] = {
                d: {"state": "unknown", "missing_reason": "in_progress"}
                for d in schema_v2.COVERAGE_DIMENSIONS
            }
            continue

        if kind == "skill_end":
            row = open_invocations.get(event["invocation_id"])
            require(row is not None, "end_without_start")
            row["ended_at"] = event["at"]
            row["status"] = event["status"]
            evidence = row["boundary_evidence"]
            boundary_state = "complete" if evidence in ("host_dispatch", "explicit_entry") else "partial"
            boundary_reason = None if boundary_state == "complete" else "declared_only"
            coverage[row["invocation_id"]]["boundary"] = {
                "state": boundary_state, "missing_reason": boundary_reason}
            continue

        if kind == "span_start":
            spans.append({
                "span_id": event["span_id"],
                "invocation_id": event["invocation_id"],
                "kind": _span_kind_default(event.get("kind")),
                "started_at": event["at"],
                "ended_at": None,
            })
            continue

        if kind == "span_end":
            for row in spans:
                if row["span_id"] == event["span_id"]:
                    row["ended_at"] = event["at"]
                    break
            else:
                require(False, "span_end_without_start")
            continue

        if kind == "usage":
            claimed = event.get("claimed_by")
            require(type(claimed) is list and len(claimed) > 0, "usage_without_claim")
            # 単独 claim だけが帰属を得る。複数 claim は shared/unattributed。
            owner = event.get("owner_span_id") if len(claimed) == 1 else None
            atoms.append({
                "call_identity": event["call_identity"],
                "host": event["host"],
                "provider": event["provider"],
                "source_epoch": event["at"],
                "usage": event["usage"],
                "owner_span_id": owner,
                "evidence": event["evidence"],
            })
            continue

    # 終了イベントが来なかった invocation は running のまま（成功に化けない）。
    # usage の観測が 1 件でもあれば usage 次元を partial に上げる（complete は
    # ここからは言えない — 全 call を見たことをこの層は知り得ない）。
    for invocation_id, cov in coverage.items():
        own = {s["span_id"] for s in spans if s["invocation_id"] == invocation_id}
        if any(a["owner_span_id"] in own for a in atoms):
            cov["usage"] = {"state": "partial", "missing_reason": "only_claimed_calls_observed"}

    run = {"invocations": invocations, "spans": spans, "atoms": atoms,
           "coverage": coverage, "evaluations": []}
    if invocations:
        schema_v2.validate_run(run)
    else:
        require(not spans and not atoms, "orphan_records_without_invocation")
    return {"run": run, "skill_md_reads": md_reads}
