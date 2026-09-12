"""Deterministic comparison and bounded proposal queue. No automatic inference or changes."""
import argparse
import hashlib
import json
import statistics
import sys
import time

import measure
import run_schema
from private_state import digest, natural, transaction

GROUP = {"project", "task_class", "model", "settings", "quality_contract"}
REASONS = {"investigate_regression", "verify_reduction", "investigate_only"}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def compare(data, minimum=3, threshold_percent=25):
    measure.require(type(minimum) is int and 3 <= minimum <= 100
                    and type(threshold_percent) is int and 1 <= threshold_percent <= 1000, "invalid_policy")
    measure.require(type(data) is dict and set(data) == {"mode", "baseline", "candidate"}
                    and data["mode"] in ("drift", "variant"), "comparison_schema")
    # mode は比較の質問そのものを名指しする（番号ではなく）。
    # drift:   同一実装のまま経時で悪化していないか。group（settings に実装版を含む
    #          固定条件）の完全一致を要求する。実装を変えた前後は定義上比較できない。
    # variant: 実装を変えた before/after。group は固定条件だけを持ち、変更する実装版は
    #          cohort ごとの variant（実装 fingerprint）に分離する（#60 §4）。
    mode = data["mode"]
    cohort_keys = {"group", "samples"} if mode == "drift" else {"group", "variant", "samples"}
    groups, variants, totals, seen, evidence_seen = [], [], [], set(), set()
    comparable = True
    # 拒否・降格の理由コード。数値だけ返すと「なぜ比較にならないか」が読み手の推測に落ちる。
    reasons = []
    quality_evidence_by_cohort = []
    for name in ("baseline", "candidate"):
        cohort = data[name]
        measure.require(type(cohort) is dict and set(cohort) == cohort_keys
                        and type(cohort["group"]) is dict and set(cohort["group"]) == GROUP
                        and all(digest(v) for v in cohort["group"].values())
                        and type(cohort["samples"]) is list and len(cohort["samples"]) <= 100, "cohort_schema")
        if mode == "variant":
            variants.append(run_schema.validate_fingerprint(cohort["variant"]))
        groups.append(cohort["group"])
        if len(cohort["samples"]) < minimum:
            comparable = False
            reasons.append(f"insufficient_repetitions:{name}")
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
            if sample["quality"] == "unmeasured":
                reasons.append("quality_unmeasured")
            elif sample["quality_source"] != "independent":
                reasons.append("quality_not_independent")
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
        quality_evidence_by_cohort.append(
            {s["quality_evidence"] for s in cohort["samples"] if s["quality_evidence"] is not None})
    # hard reject: 理由コード付きで比較そのものを拒否する（降格ではない）。
    # 品質証拠を baseline と candidate が共有している場合、「質を維持した」の質が
    # 同じ産物 1 つで二重に証明されている — 片側は測っていない（AC: 使い回しを通さない）。
    if quality_evidence_by_cohort[0] & quality_evidence_by_cohort[1]:
        return {"status": "not_comparable",
                "reasons": ["quality_evidence_reuse_across_cohorts"]}
    if groups[0] != groups[1]:
        mismatched = sorted(k for k in GROUP if groups[0][k] != groups[1][k])
        return {"status": "not_comparable",
                "reasons": ["group_mismatch:" + ",".join(mismatched)]}
    # variant mode で fingerprint が同一なら、それは実装差を測っていない（差が出ても条件の揺らぎ）。
    if mode == "variant" and variants[0]["digest"] == variants[1]["digest"]:
        return {"status": "not_comparable", "reasons": ["variant_identical"]}
    before, after = totals
    if before["tokens"] is None or after["tokens"] is None:
        return {"status": "not_comparable", "reasons": ["usage_unobserved"]}
    # Zero baseline has no percentage interpretation; do not fabricate one.
    if any(before[k] == 0 for k in before if before[k] is not None):
        return {"status": "not_comparable", "reasons": ["zero_baseline"]}
    # 片側でも欠測（None）の指標は差の判定に使わない。0 に潰すと欠測が
    # 「変化なし」や「激減」に化ける。tokens は上の usage_unobserved で保証済みなので、
    # ここで落ちるのは duration のみ。
    measurable = [k for k in before if before[k] is not None and after[k] is not None]
    increased = any((after[k] - before[k]) * 100 >= before[k] * threshold_percent for k in measurable)
    decreased = any((before[k] - after[k]) * 100 >= before[k] * threshold_percent for k in measurable)
    if not comparable and mode == "drift":
        # drift の契約: 前提を欠く比較は常に not_comparable。降格（investigate_only）の
        # 意味論は variant mode だけが持つ — 経時監視で前提が欠けたら測り直すのが正で、
        # 調査候補に変換する意味が無い。
        return {"status": "not_comparable", "reasons": sorted(set(reasons))}
    if not increased and not decreased:
        return {"status": "no_material_change"}
    # variant: 差はあるが候補の前提（反復数・独立した品質証拠）を欠く場合は、品質維持
    # 改善と認定せず調査候補に降格する（日常観測は調査候補の発見用 — Issue #60 §4）。
    if not comparable:
        reason = "investigate_only"
    else:
        reason = "investigate_regression" if increased else "verify_reduction"
    canonical = {"mode": mode, **{name: data[name] | {
        "samples": sorted(data[name]["samples"], key=lambda row: row["id"])}
        for name in ("baseline", "candidate")}}
    evidence = fingerprint(canonical)
    identity = [groups[0], reason] if mode == "drift" else [
        groups[0], reason, variants[0]["digest"], variants[1]["digest"]]
    return {"status": "candidate", "fingerprint": fingerprint(identity),
            "evidence": evidence, "reason": reason, "before": before, "after": after,
            "reasons": sorted(set(reasons))}


def initial():
    return {"updated_at": 0, "items": []}


def validate(state):
    measure.require(type(state) is dict and set(state) == {"updated_at", "items"}
                    and natural(state["updated_at"])
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
            # duration_ms は欠測（None）を許す。0 に潰すと「測れていない」が「一瞬で
            # 終わった」に化けるため、欠測は欠測のまま queue に載せる。tokens は
            # compare が usage_unobserved で早期拒否するので None はここまで来ない。
            measure.require(type(item[key]) is dict and set(item[key]) == {"tokens", "duration_ms"}
                            and natural(item[key]["tokens"])
                            and (item[key]["duration_ms"] is None or natural(item[key]["duration_ms"])),
                            "invalid_observation")
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
                new = {k: v for k, v in candidate.items() if k not in ("status", "reasons")}
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
