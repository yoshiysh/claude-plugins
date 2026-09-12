"""End-to-end usage report over a schema_v2 run. Arithmetic only, no inference.

The report never upgrades what it received: an unknown stays null (not zero),
a failed attempt stays in the totals, the plugin's own overhead is shown next
to — never inside — the measured skill's usage, and the grand total is labeled
an observed lower bound whenever any coverage dimension is not complete.
"""
import schema_v2
from measure import require

USAGE_FIELDS = schema_v2.USAGE_FIELDS

# performance 自身の計測費用を見分ける印。skill identity の plugin 名で引くのは、
# atom の provider や evidence では「誰のための呼び出しか」が判別できないため。
OVERHEAD_PLUGIN = "performance"


def _add(target, usage):
    for k in USAGE_FIELDS:
        target[k] += usage[k]


def report(run):
    schema_v2.validate_run(run)
    invocations = {r["invocation_id"]: r for r in run["invocations"]}

    per_invocation = {}
    skill_total = {k: 0 for k in USAGE_FIELDS}
    overhead_total = {k: 0 for k in USAGE_FIELDS}
    unattributed_total = {k: 0 for k in USAGE_FIELDS}
    failure_cost = {k: 0 for k in USAGE_FIELDS}

    span_owner = {s["span_id"]: s["invocation_id"] for s in run["spans"]}
    for atom in run["atoms"]:
        owner_span = atom["owner_span_id"]
        if owner_span is None:
            _add(unattributed_total, atom["usage"])
            continue
        invocation = invocations[span_owner[owner_span]]
        if invocation["skill"]["plugin"] == OVERHEAD_PLUGIN:
            _add(overhead_total, atom["usage"])
        else:
            _add(skill_total, atom["usage"])
        if invocation["status"] == "failed":
            _add(failure_cost, atom["usage"])

    for invocation_id, row in invocations.items():
        per_invocation[invocation_id] = {
            "exclusive": schema_v2.exclusive_usage(run, invocation_id),
            "inclusive": schema_v2.inclusive_usage(run, invocation_id),
            "status": row["status"],
            "wall_ms": (row["ended_at"] - row["started_at"])
                       if row["ended_at"] is not None else None,
        }

    # 試行の集計は root 単位。再試行は parent/root を共有する別 invocation として
    # 記録される前提（schema_v2 の系譜検証がその形を強制する）。
    roots = {}
    for row in run["invocations"]:
        roots.setdefault(row["root_invocation_id"], []).append(row)
    attempts_by_root = {}
    for root_id, rows in roots.items():
        closed = [r for r in rows if r["status"] in schema_v2.CLOSED_STATUSES]
        completed = [r for r in closed if r["status"] == "completed"]
        attempts_by_root[root_id] = {
            "attempts": len(rows),
            "completed": len(completed),
            # 終了していない試行を分母から外すと「まだ終わっていない」が
            # 「成功率が高い」に化けるので、分母は全試行のまま。
            "success_rate": (len(completed) / len(rows)) if rows else None,
        }

    # coverage: 1 次元でも complete でなければ、総量は完全な合計ではなく観測下限。
    incomplete = []
    for invocation_id, cov in run["coverage"].items():
        for dimension, state in cov.items():
            if state["state"] != "complete":
                incomplete.append({"invocation_id": invocation_id,
                                   "dimension": dimension,
                                   "state": state["state"],
                                   "missing_reason": state["missing_reason"]})

    total_label = "complete" if not incomplete else "observed_lower_bound"

    return {
        "skill_usage": skill_total,
        "overhead_usage": overhead_total,
        "unattributed_usage": unattributed_total,
        "failure_cost": failure_cost,
        "per_invocation": per_invocation,
        "attempts": attempts_by_root,
        "coverage_gaps": incomplete,
        "total_label": total_label,
        # unknown を数値に混ぜない: 観測できなかった量そのものは常に null。
        "unobserved_usage": None,
    }
