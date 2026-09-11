"""Deterministic comparison and bounded proposal queue. No automatic inference or changes."""
import argparse
import hashlib
import json
import statistics
import sys
import time

import measure
import schema_v2
from private_state import digest, natural, transaction

GROUP = {"project", "task_class", "model", "settings", "quality_contract"}
REASONS = {"investigate_regression", "verify_reduction"}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def compare(data, minimum=3, threshold_percent=25):
    measure.require(type(minimum) is int and 3 <= minimum <= 100
                    and type(threshold_percent) is int and 1 <= threshold_percent <= 1000, "invalid_policy")
    measure.require(type(data) is dict and set(data) == {"version", "baseline", "candidate"}
                    and type(data["version"]) is int and data["version"] in (1, 2), "comparison_schema")
    # v1: group（settings に実装版を含む固定条件）の完全一致を要求する遺産形式。
    #     実装を変えた前後は定義上比較できないため、観測 source としてのみ維持する。
    # v2: group は固定条件だけを持ち、変更する実装版は cohort ごとの variant
    #     （実装 fingerprint）に分離する。改修前後の比較はこちらで行う（#60 §4）。
    version = data["version"]
    cohort_keys = {"group", "samples"} if version == 1 else {"group", "variant", "samples"}
    groups, variants, totals, seen, evidence_seen = [], [], [], set(), set()
    comparable = True
    for name in ("baseline", "candidate"):
        cohort = data[name]
        measure.require(type(cohort) is dict and set(cohort) == cohort_keys
                        and type(cohort["group"]) is dict and set(cohort["group"]) == GROUP
                        and all(digest(v) for v in cohort["group"].values())
                        and type(cohort["samples"]) is list and len(cohort["samples"]) <= 100, "cohort_schema")
        if version == 2:
            variants.append(schema_v2.validate_fingerprint(cohort["variant"]))
        groups.append(cohort["group"])
        comparable &= len(cohort["samples"]) >= minimum
        token_values, durations = [], []
        for sample in cohort["samples"]:
            measure.require(type(sample) is dict and set(sample) == {
                "id", "usage", "duration_ms", "status", "quality", "quality_source",
                "quality_evidence", "usage_evidence"}
                and digest(sample["id"]) and sample["id"] not in seen
                and digest(sample["usage_evidence"]) and sample["usage_evidence"] not in evidence_seen
                and sample["status"] in ("completed", "failed", "unknown")
                and sample["quality"] in ("passed", "failed", "unmeasured")
                and sample["quality_source"] in ("independent", "producer")
                and (sample["quality_evidence"] is None or digest(sample["quality_evidence"]))
                and (sample["duration_ms"] is None or natural(sample["duration_ms"])), "sample_schema")
            # 品質証拠は「別の産物」でなければならない。usage 証拠や観測 id の使い回しは、
            # 品質を測っていないのに測った形だけ整える最短の抜け道になる（構造で塞ぐ）。
            measure.require(sample["quality_evidence"] is None
                            or sample["quality_evidence"] not in (sample["id"], sample["usage_evidence"]),
                            "quality_evidence_reuse")
            seen.add(sample["id"])
            evidence_seen.add(sample["usage_evidence"])
            # producer（sample を生成した主体の自己申告）の品質は候補の前提を満たさない。
            # 「質を維持したまま」の質は、生成と別の工程（fresh 監査者・検証段）の産物で
            # 裏付けられたときだけ比較の前提にできる（生成者は自分の出力に通る判定を書ける）。
            comparable &= (sample["status"] == "completed" and sample["quality"] == "passed"
                           and sample["quality_source"] == "independent"
                           and sample["quality_evidence"] is not None and sample["duration_ms"] is not None
                           and sample["usage"] is not None)
            if sample["usage"] is not None:
                measure.require(type(sample["usage"]) is dict and set(sample["usage"]) == set(measure.FIELDS)
                                and all(natural(v) for v in sample["usage"].values()), "sample_usage")
                usage = measure.usage(sample["usage"])
                token_values.append(usage["input_tokens"] + usage["output_tokens"])
            if sample["duration_ms"] is not None:
                durations.append(sample["duration_ms"])
        totals.append({"tokens": statistics.median_low(token_values) if token_values else None,
                       "duration_ms": statistics.median_low(durations) if durations else None})
    if not comparable or groups[0] != groups[1]:
        return {"status": "not_comparable"}
    # v2 で variant が同一なら、それは実装差を測っていない（差が出ても条件の揺らぎ）。
    if version == 2 and variants[0]["digest"] == variants[1]["digest"]:
        return {"status": "not_comparable"}
    before, after = totals
    # Zero baseline has no percentage interpretation; do not fabricate one.
    if any(before[k] == 0 for k in before):
        return {"status": "not_comparable"}
    increased = any((after[k] - before[k]) * 100 >= before[k] * threshold_percent for k in before)
    decreased = any((before[k] - after[k]) * 100 >= before[k] * threshold_percent for k in before)
    if not increased and not decreased:
        return {"status": "no_material_change"}
    reason = "investigate_regression" if increased else "verify_reduction"
    canonical = {"version": version, **{name: data[name] | {
        "samples": sorted(data[name]["samples"], key=lambda row: row["id"])}
        for name in ("baseline", "candidate")}}
    evidence = fingerprint(canonical)
    identity = [groups[0], reason] if version == 1 else [
        groups[0], reason, variants[0]["digest"], variants[1]["digest"]]
    return {"status": "candidate", "fingerprint": fingerprint(identity),
            "evidence": evidence, "reason": reason, "before": before, "after": after}


def initial():
    return {"version": 1, "updated_at": 0, "items": []}


def validate(state):
    measure.require(type(state) is dict and set(state) == {"version", "updated_at", "items"}
                    and type(state["version"]) is int and state["version"] == 1 and natural(state["updated_at"])
                    and type(state["items"]) is list and len(state["items"]) <= 100, "invalid_queue")
    seen = set()
    for item in state["items"]:
        measure.require(type(item) is dict and set(item) == {"fingerprint", "evidence", "reason", "before", "after",
                        "state", "at", "until", "new_evidence"}
                        and digest(item["fingerprint"]) and item["fingerprint"] not in seen
                        and digest(item["evidence"]) and item["reason"] in REASONS
                        and item["state"] in ("pending", "deferred", "dismissed")
                        and natural(item["at"]) and item["at"] <= state["updated_at"] and natural(item["until"])
                        and type(item["new_evidence"]) is bool, "invalid_proposal")
        for key in ("before", "after"):
            measure.require(type(item[key]) is dict and set(item[key]) == {"tokens", "duration_ms"}
                            and all(natural(v) for v in item[key].values()), "invalid_observation")
        seen.add(item["fingerprint"])


def update(store, candidate=None, decision=None, item_id=None, cooldown=86400, now=None):
    measure.require(type(cooldown) is int and 60 <= cooldown <= 30 * 86400, "cooldown")
    now = int(time.time()) if now is None else now
    measure.require(natural(now), "time")
    with transaction(store, initial, validate) as state:
        measure.require(now >= state["updated_at"], "clock_rollback")
        state["updated_at"] = now
        outcome = "unchanged"
        if decision is not None:
            measure.require(decision in ("dismissed", "deferred") and digest(item_id), "decision")
            item = next((r for r in state["items"] if r["fingerprint"] == item_id), None)
            measure.require(item is not None, "unknown_proposal")
            item.update(state=decision, until=now + cooldown)
            outcome = decision
        elif candidate is not None and candidate["status"] == "candidate":
            item = next((r for r in state["items"] if r["fingerprint"] == candidate["fingerprint"]), None)
            if item is None or (candidate["evidence"] != item["evidence"] and now >= item["until"]):
                new = {k: v for k, v in candidate.items() if k != "status"}
                new.update(state="pending", at=now, until=now + cooldown, new_evidence=item is not None)
                if item is None:
                    measure.require(len(state["items"]) < 100, "queue_full")
                    state["items"].append(new)
                else:
                    item.clear()
                    item.update(new)
                outcome = "queued"
        pending = [r for r in state["items"] if r["state"] == "pending"
                   or (r["state"] == "deferred" and now >= r["until"])]
        return {"status": outcome, "pending_count": len(pending), "items": pending[:5]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("evaluate", "list", "dismiss", "defer"))
    parser.add_argument("--store", required=True)
    parser.add_argument("--input")
    parser.add_argument("--id")
    parser.add_argument("--min-samples", type=int, default=3)
    parser.add_argument("--threshold-percent", type=int, default=25)
    parser.add_argument("--cooldown", type=int, default=86400)
    args = parser.parse_args()
    try:
        if args.command == "evaluate":
            data = measure.decode(measure.read(args.input))
            result = compare(data, args.min_samples, args.threshold_percent)
            if result["status"] == "candidate":
                result = update(args.store, result, cooldown=args.cooldown)
        else:
            result = update(args.store, decision={"dismiss": "dismissed", "defer": "deferred"}.get(args.command),
                            item_id=args.id, cooldown=args.cooldown)
        print(json.dumps(result))
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        print('{"status":"proposal_failed"}')
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
