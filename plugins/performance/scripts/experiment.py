"""Before/after experiment harness: preregistration, replay, approval gate.

Real-model execution is deliberately absent. The harness can (1) validate a
preregistered protocol, (2) replay recorded fixtures deterministically into
per-variant aggregates and deltas, and (3) refuse execution without a budget
approval record while writing down exactly what remains unverified. Running
live models is a separate, approved step — the refusal is the implementation
of that boundary, not a stub for it.
"""
import run_schema
import run_report
from measure import require

# 承認記録の必須欄。Issue #60 受け入れ条件: 実モデル評価はケース数・呼び出し数・
# 時間/使用量予算を承認してから行う。欄が欠けた承認は承認として数えない。
APPROVAL_FIELDS = ("case_count", "call_count", "budget", "approved_by", "approved_at")


def validate_protocol(protocol):
    """事前登録プロトコル。variant・反復・実行順・品質許容は run_schema の契約で縛る。"""
    run_schema.validate_experiment(protocol)
    return protocol


def _variant_aggregate(runs):
    totals = {k: 0 for k in run_schema.USAGE_FIELDS}
    failure = {k: 0 for k in run_schema.USAGE_FIELDS}
    attempts = 0
    completed = 0
    for run in runs:
        result = run_report.report(run)
        for k in run_schema.USAGE_FIELDS:
            totals[k] += result["skill_usage"][k]
            failure[k] += result["failure_cost"][k]
        for stats in result["attempts"].values():
            attempts += stats["attempts"]
            completed += stats["completed"]
    return {
        "usage": totals,
        "failure_cost": failure,
        "attempts": attempts,
        "completed": completed,
        "success_rate": (completed / attempts) if attempts else None,
    }


def replay(protocol, fixture):
    """recorded fixture を決定的に集計する。

    fixture は {variant_digest: [run, ...]} で、各 run は run_schema の run。
    集計は run_report の算術のみ。ID の付け替え・atom の並べ替え・timestamp の
    一律オフセットは数値を変えない（変わるなら集計が識別子や順序に依存している）。
    """
    validate_protocol(protocol)
    digests = [v["digest"] for v in protocol["variants"]]
    require(type(fixture) is dict and set(fixture) == set(digests),
            "fixture_variant_mismatch")
    for digest, runs in fixture.items():
        require(type(runs) is list and len(runs) >= 1, "empty_variant_fixture")

    aggregates = {d: _variant_aggregate(fixture[d]) for d in digests}
    baseline, others = digests[0], digests[1:]
    deltas = {}
    for d in others:
        row = {}
        for k in run_schema.USAGE_FIELDS:
            base = aggregates[baseline]["usage"][k]
            # ゼロ基準に百分率の解釈は無い（捏造しない）。
            row[k + "_pct"] = (
                None if base == 0
                else round((aggregates[d]["usage"][k] - base) * 100.0 / base, 6))
        deltas[d] = row
    return {"variants": aggregates, "baseline": baseline, "deltas": deltas,
            "mode": "replay",
            "unverified_scope": "実モデルでの効果測定（recorded fixture の再集計であり、"
                                "実行そのものの観測ではない）"}


def authorize_execution(protocol, approval):
    """実モデル実行の承認ゲート。承認記録が無ければ拒否し、未検証範囲を記録する。

    承認があっても実行はここでは始まらない — 返るのは登録済みプロトコルと承認の
    対応付けだけで、実行は別工程が行い、その実行証拠は run として別途観測される。
    """
    validate_protocol(protocol)
    if approval is None:
        return {
            "status": "refused",
            "reason": "missing_budget_approval",
            "unverified_scope": {
                "what": "実モデルでの before/after 効果測定",
                "why": "ケース数・呼び出し数・時間/使用量予算の承認記録が無い",
                "protocol_registered": True,
            },
        }
    require(type(approval) is dict and set(approval) == set(APPROVAL_FIELDS),
            "invalid_approval_record")
    require(type(approval["case_count"]) is int and approval["case_count"] > 0,
            "invalid_approval_record")
    require(type(approval["call_count"]) is int and approval["call_count"] > 0,
            "invalid_approval_record")
    for key in ("budget", "approved_by"):
        require(type(approval[key]) is str and approval[key],
                "invalid_approval_record")
    require(type(approval["approved_at"]) is int and approval["approved_at"] > 0,
            "invalid_approval_record")
    # 承認されたケース数がプロトコルの実行計画を下回るなら、その承認では走れない。
    planned_cases = len(protocol["case_ids"]) * protocol["repetitions"] * len(protocol["variants"])
    if approval["case_count"] < planned_cases:
        return {
            "status": "refused",
            "reason": "approval_smaller_than_protocol",
            "unverified_scope": {
                "what": f"計画 {planned_cases} 実行のうち承認は {approval['case_count']} 実行分",
                "protocol_registered": True,
            },
        }
    return {"status": "authorized", "planned_executions": planned_cases,
            "approval": approval}
