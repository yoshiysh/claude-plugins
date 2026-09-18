"""Wire observed runs into comparison input. Arithmetic and digests only.

The missing link the issue named: observation (run_schema runs + evaluations)
to comparison (proposals.compare) without hand-assembling samples. Every
sample field is derived from the run by a fixed rule — nothing here decides
quality or comparability; it only carries what was observed into the shape
the comparator validates.
"""
import hashlib
import json

import run_schema
import run_report
from measure import require


def _digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _run_status(run):
    statuses = {r["status"] for r in run["invocations"]}
    if statuses <= {"completed"}:
        return "completed"
    if "failed" in statuses:
        return "failed"
    return "unknown"


def _duration_ms(run):
    # censored の ended_at は cutoff（観測の打ち切り時刻）で、完了時刻ではない。
    # ここから所要時間を導くと「短い skill ほど長く見える」向きの系統誤差になる
    # ので、censored を 1 件でも含む run の duration は欠測のまま（open と同じ）。
    if any(r["ended_at"] is None or r["status"] == "censored"
           for r in run["invocations"]):
        return None
    return max(r["ended_at"] for r in run["invocations"]) - min(
        r["started_at"] for r in run["invocations"])


def _quality(run):
    # 品質は run に添付された evaluation から機械的に写す。無ければ unmeasured。
    # 複数 evaluation は最悪値を取る（1 件でも fail なら fail — 部分合格を
    # 「合格」に丸めない）。
    evaluations = run["evaluations"]
    if not evaluations:
        return {"quality": "unmeasured", "quality_source": "producer",
                "quality_evidence": None}
    verdicts = {e["verdict"] for e in evaluations}
    if "fail" in verdicts:
        quality = "failed"
    elif verdicts <= {"pass"}:
        quality = "passed"
    else:
        quality = "unmeasured"
    independent = all(e["evidence_independent"] for e in evaluations)
    refs = sorted(ref for e in evaluations for ref in e["artifact_refs"])
    return {"quality": quality,
            "quality_source": "independent" if independent else "producer",
            "quality_evidence": _digest(refs) if refs else None}


def sample_from_run(run):
    run_schema.validate_run(run)
    report = run_report.report(run)
    row = {
        "id": _digest(run),
        "usage": report["skill_usage"],
        "duration_ms": _duration_ms(run),
        "status": _run_status(run),
        # usage の証拠は「どの call を観測したか」の集合。run の id と別物にする
        # （同じ digest の使い回しは comparator が拒否する）。
        "usage_evidence": _digest(sorted(a["call_identity"] for a in run["atoms"])),
    }
    row.update(_quality(run))
    return row


def build_comparison(group, baseline, candidate):
    """runs の対から proposals.compare の variant mode 入力を組み立てる。

    baseline / candidate は {"variant": fingerprint, "runs": [run, ...]}。
    group は固定条件 5 キーの digest 辞書（正本は references/proposals.md）。
    """
    require(type(group) is dict, "invalid_group")
    payload = {"mode": "variant"}
    for name, side in (("baseline", baseline), ("candidate", candidate)):
        require(type(side) is dict and set(side) == {"variant", "runs"}
                and type(side["runs"]) is list and len(side["runs"]) > 0,
                "invalid_cohort_input")
        run_schema.validate_fingerprint(side["variant"])
        payload[name] = {
            "group": group,
            "variant": side["variant"],
            "samples": [sample_from_run(r) for r in side["runs"]],
        }
    return payload
