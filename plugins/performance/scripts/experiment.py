"""Before/after experiment harness: preregistration and deterministic replay.

The harness validates a preregistered protocol and replays recorded runs into
per-variant aggregates and deltas. Live-model execution happens outside this
module; its recorded runs come back through the same replay arithmetic.
"""
import run_schema
import run_report
from measure import require


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
