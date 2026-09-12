"""Skill-invocation data contract: attribution, lineage, coverage, experiments.

Validation only — no I/O, no inference. Callers construct records from observed
evidence; this module rejects records that could produce double counting,
orphan lineage, fabricated success, or non-comparable experiments. A record
that passes here is well-formed, not true: evidence fields carry where each
value came from, and unknown stays unknown (never zero, never success).
"""
from measure import require
from private_state import natural

# 識別子は host が発行する不透明文字列。空と極端な長さだけを拒む（形式を規定すると
# ホスト差で正当な ID を落とす）。4096 は native_collect.identity と同じ上限。
MAX_ID = 4096
# 1 invocation の span / atom / 子の数。実測の workflow（109 agents）を一桁上回る余裕を
# 取りつつ、壊れた producer の無限増殖を打ち切る値。上限到達は censoring として扱う。
MAX_SPANS = 4096
MAX_ATOMS = 65536
MAX_INVOCATIONS = 4096
MAX_CASES = 1024
MAX_VARIANTS = 16
# 反復は各 variant 3 回以上が候補判定の最低条件（Issue #60 §4）。上限は交互実行の
# 実行計画が現実的に収まる範囲。
MIN_REPETITIONS = 3
MAX_REPETITIONS = 100

USAGE_FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens")

# 終了欠落は成功にしない: ended_at が無い invocation に許される status はこの 2 つだけ。
OPEN_STATUSES = ("running", "unknown")
# censored の ended_at は「完了時刻」ではなく「観測の打ち切り時刻（cutoff）」。
# 打ち切り点の代表例は turn 境界（Stop）。この値から所要時間を導かないのは
# 読み手（cohort / run_report）の契約で、そこにだけ書く。
CLOSED_STATUSES = ("completed", "failed", "cancelled", "censored")

SPAN_KINDS = (
    "prepare",            # 親の準備（SKILL 読込・入力整形。end-to-end 集計に含める）
    "workflow_generate",  # 動的 Workflow 生成（生成費用も同じ invocation に帰属）
    "workflow_run",
    "agent",
    "child_skill",
    "verify",
    "finalize",           # 最終統合
)

# 境界証拠: 宣言（LLM 自己申告・SKILL.md 読込・名前の一致・時刻の重なり）は実測と
# 区別する（Issue #60 §1）。declared だけの invocation は coverage.boundary が
# complete になれない。
BOUNDARY_EVIDENCE = ("host_dispatch", "explicit_entry", "declared")

COVERAGE_DIMENSIONS = ("boundary", "call", "child", "usage")
COVERAGE_STATES = ("complete", "partial", "unknown")

EVAL_VERDICTS = ("pass", "fail", "unmeasured")


def _id(value, code):
    require(type(value) is str and 0 < len(value) <= MAX_ID, code)
    return value


def _optional_id(value, code):
    if value is None:
        return None
    return _id(value, code)


def _epoch_ms(value, code):
    require(type(value) is int and value > 0, code)
    return value


def validate_skill_identity(value):
    require(type(value) is dict, "invalid_skill_identity")
    require(set(value) == {"marketplace", "plugin", "public_name", "scope"},
            "invalid_skill_identity")
    for key in ("plugin", "public_name"):
        _id(value[key], "invalid_skill_identity")
    # marketplace はローカル skill では無い。scope はローカル skill の project 識別。
    require(value["marketplace"] is None or type(value["marketplace"]) is str,
            "invalid_skill_identity")
    require(value["scope"] is None or type(value["scope"]) is str,
            "invalid_skill_identity")
    require(value["marketplace"] is not None or value["scope"] is not None,
            "unanchored_skill_identity")
    return value


def validate_fingerprint(value):
    # 実装 fingerprint はコード・指示・参照の実内容の決定的 inventory から取る。
    # ここでは形だけを見る: inventory 由来の digest と、算出時刻・drift 記録。
    require(type(value) is dict and set(value) == {"digest", "computed_at", "drift"},
            "invalid_fingerprint")
    require(type(value["digest"]) is str and len(value["digest"]) == 64
            and all(c in "0123456789abcdef" for c in value["digest"]),
            "invalid_fingerprint")
    _epoch_ms(value["computed_at"], "invalid_fingerprint")
    # drift: 外部依存の変化・実行中の変更を fingerprint の失効として区別する。
    require(value["drift"] is None or (type(value["drift"]) is str and value["drift"]),
            "invalid_fingerprint")
    return value


def validate_invocation(value):
    require(type(value) is dict, "invalid_invocation")
    require(set(value) == {"invocation_id", "parent_invocation_id", "root_invocation_id",
                           "skill", "fingerprint", "started_at", "ended_at", "status",
                           "boundary_evidence"},
            "invalid_invocation")
    _id(value["invocation_id"], "invalid_invocation")
    _optional_id(value["parent_invocation_id"], "invalid_invocation")
    _id(value["root_invocation_id"], "invalid_invocation")
    validate_skill_identity(value["skill"])
    validate_fingerprint(value["fingerprint"])
    _epoch_ms(value["started_at"], "invalid_invocation")
    require(value["boundary_evidence"] in BOUNDARY_EVIDENCE, "invalid_boundary_evidence")
    if value["ended_at"] is None:
        # 終了欠落を成功にしない。遅延 usage の受領で status を書き換えることも
        # この検証が拒む（closed へ変えるには ended_at の実測が要る）。
        require(value["status"] in OPEN_STATUSES, "missing_end_not_success")
    else:
        _epoch_ms(value["ended_at"], "invalid_invocation")
        require(value["ended_at"] >= value["started_at"], "invalid_invocation")
        require(value["status"] in CLOSED_STATUSES, "invalid_status")
    return value


def validate_span(value):
    require(type(value) is dict, "invalid_span")
    require(set(value) == {"span_id", "invocation_id", "kind", "started_at", "ended_at"},
            "invalid_span")
    _id(value["span_id"], "invalid_span")
    _id(value["invocation_id"], "invalid_span")
    require(value["kind"] in SPAN_KINDS, "invalid_span_kind")
    _epoch_ms(value["started_at"], "invalid_span")
    if value["ended_at"] is not None:
        _epoch_ms(value["ended_at"], "invalid_span")
        require(value["ended_at"] >= value["started_at"], "invalid_span")
    return value


def validate_atom(value):
    require(type(value) is dict, "invalid_atom")
    require(set(value) == {"call_identity", "host", "provider", "source_epoch",
                           "usage", "owner_span_id", "evidence"},
            "invalid_atom")
    _id(value["call_identity"], "invalid_atom")
    require(value["host"] in ("claude", "codex"), "invalid_atom_host")
    require(type(value["provider"]) is str and value["provider"], "invalid_atom")
    _epoch_ms(value["source_epoch"], "invalid_atom")
    usage = value["usage"]
    require(type(usage) is dict and set(usage) == set(USAGE_FIELDS)
            and all(natural(usage[k]) for k in USAGE_FIELDS), "invalid_atom_usage")
    require(usage["cached_input_tokens"] <= usage["input_tokens"], "cache_exceeds_input")
    # 所有者は 1 つ、または未帰属。複数スキルが共有する call は任意配分せず
    # owner_span_id = None（shared/unattributed）で保持する（Issue #60 §3）。
    _optional_id(value["owner_span_id"], "invalid_atom")
    require(type(value["evidence"]) is str and value["evidence"], "invalid_atom")
    return value


def validate_coverage(value):
    require(type(value) is dict and set(value) == set(COVERAGE_DIMENSIONS),
            "invalid_coverage")
    for dimension in COVERAGE_DIMENSIONS:
        row = value[dimension]
        require(type(row) is dict and set(row) == {"state", "missing_reason"},
                "invalid_coverage")
        require(row["state"] in COVERAGE_STATES, "invalid_coverage_state")
        if row["state"] == "complete":
            require(row["missing_reason"] is None, "invalid_coverage")
        else:
            # 欠測理由の無い partial/unknown を許すと、欠測が黙って通常値に見える。
            require(type(row["missing_reason"]) is str and row["missing_reason"],
                    "missing_reason_required")
    return value


def validate_evaluation(value):
    require(type(value) is dict, "invalid_evaluation")
    require(set(value) == {"case_id", "contract_version", "verifier_version",
                           "artifact_refs", "verdict", "evidence_independent"},
            "invalid_evaluation")
    _id(value["case_id"], "invalid_evaluation")
    for key in ("contract_version", "verifier_version"):
        require(type(value[key]) is str and value[key], "invalid_evaluation")
    refs = value["artifact_refs"]
    require(type(refs) is list and all(type(r) is str and r for r in refs),
            "invalid_evaluation")
    require(value["verdict"] in EVAL_VERDICTS, "invalid_verdict")
    # 品質判定は成果物への証拠対応が要る。unmeasured は refs 無しでよいが、
    # pass/fail が refs ゼロなら自己申告と区別が付かない。
    if value["verdict"] != "unmeasured":
        require(len(refs) > 0, "verdict_without_artifacts")
    require(type(value["evidence_independent"]) is bool, "invalid_evaluation")
    return value


def validate_experiment(value):
    require(type(value) is dict, "invalid_experiment")
    require(set(value) == {"fixed_conditions", "variants", "case_ids", "repetitions",
                           "execution_order", "quality_tolerance", "stop_budget"},
            "invalid_experiment")
    fixed = value["fixed_conditions"]
    # 固定条件: case snapshot・品質契約・runtime・権限・背景・モデル・cache 条件
    # （Issue #60 §4）。resolved_model は alias でなく実際の解決モデル。
    require(type(fixed) is dict and set(fixed) == {
        "case_snapshot", "quality_contract", "runtime", "permissions",
        "background_context", "resolved_model", "effort", "cache_condition"},
        "invalid_fixed_conditions")
    for key, row in fixed.items():
        require(type(row) is str and row, "invalid_fixed_conditions")
    variants = value["variants"]
    require(type(variants) is list and 2 <= len(variants) <= MAX_VARIANTS,
            "invalid_variants")
    digests = [validate_fingerprint(v)["digest"] for v in variants]
    # variant は実装 fingerprint。同一 fingerprint 同士の比較は差を測っていない。
    require(len(set(digests)) == len(digests), "duplicate_variant")
    cases = value["case_ids"]
    require(type(cases) is list and 0 < len(cases) <= MAX_CASES
            and all(type(c) is str and c for c in cases)
            and len(set(cases)) == len(cases), "invalid_case_ids")
    require(type(value["repetitions"]) is int
            and MIN_REPETITIONS <= value["repetitions"] <= MAX_REPETITIONS,
            "insufficient_repetitions")
    require(value["execution_order"] in ("alternating", "randomized"),
            "invalid_execution_order")
    require(type(value["quality_tolerance"]) is str and value["quality_tolerance"],
            "invalid_experiment")
    require(type(value["stop_budget"]) is str and value["stop_budget"],
            "invalid_experiment")
    return value


def reject_condition_mismatch(experiment, observed_conditions):
    """固定条件の不一致を理由付きで拒否する（黙って混ぜない）。"""
    fixed = experiment["fixed_conditions"]
    require(type(observed_conditions) is dict and set(observed_conditions) == set(fixed),
            "invalid_observed_conditions")
    mismatched = sorted(k for k in fixed if fixed[k] != observed_conditions[k])
    require(not mismatched, "condition_mismatch:" + ",".join(mismatched))


def validate_run(value):
    """invocation 木 + span + atom + coverage を一括検証する。

    ここで拒むのは集計を壊す構造: 混線（span が別 invocation を指す）、
    二重加算（call_identity の重複）、孤児 lineage、宣言境界の complete 扱い。
    """
    require(type(value) is dict and set(value) == {"invocations", "spans", "atoms",
                                                   "coverage", "evaluations"},
            "invalid_run")
    invocations = value["invocations"]
    require(type(invocations) is list and 0 < len(invocations) <= MAX_INVOCATIONS,
            "invalid_run")
    by_id = {}
    for row in invocations:
        validate_invocation(row)
        # 同一 session の別 skill・同じ skill の再実行は別 invocation_id。重複は混線。
        require(row["invocation_id"] not in by_id, "duplicate_invocation")
        by_id[row["invocation_id"]] = row
    for row in invocations:
        parent = row["parent_invocation_id"]
        if parent is None:
            require(row["root_invocation_id"] == row["invocation_id"], "root_mismatch")
        else:
            require(parent in by_id, "orphan_parent")
            require(parent != row["invocation_id"], "self_parent")
            require(row["root_invocation_id"] == by_id[parent]["root_invocation_id"],
                    "root_mismatch")

    spans = value["spans"]
    require(type(spans) is list and len(spans) <= MAX_SPANS, "invalid_run")
    span_owner = {}
    for row in spans:
        validate_span(row)
        require(row["span_id"] not in span_owner, "duplicate_span")
        require(row["invocation_id"] in by_id, "orphan_span")
        span_owner[row["span_id"]] = row["invocation_id"]

    atoms = value["atoms"]
    require(type(atoms) is list and len(atoms) <= MAX_ATOMS, "invalid_run")
    seen_calls = set()
    for row in atoms:
        validate_atom(row)
        # SDK/native log の同一 call は identity で重複排除される前提。ここに同じ
        # call_identity が 2 回来るのは二重加算の入口なので拒む。
        require(row["call_identity"] not in seen_calls, "duplicate_call_identity")
        seen_calls.add(row["call_identity"])
        if row["owner_span_id"] is not None:
            require(row["owner_span_id"] in span_owner, "orphan_atom_owner")

    coverage = value["coverage"]
    require(type(coverage) is dict and set(coverage) == set(by_id), "invalid_run")
    for invocation_id, row in coverage.items():
        validate_coverage(row)
        # 宣言だけの境界は complete にしない（SKILL.md 読込・自己申告を実行証拠に
        # しない、の機械化）。
        if by_id[invocation_id]["boundary_evidence"] == "declared":
            require(row["boundary"]["state"] != "complete", "declared_boundary_complete")

    evaluations = value["evaluations"]
    require(type(evaluations) is list, "invalid_run")
    for row in evaluations:
        validate_evaluation(row)
    return value


def exclusive_usage(run, invocation_id):
    """invocation 直下の span が所有する atom の合計（子孫を含めない）。

    inclusive は子孫 invocation の exclusive の集合和として呼び出し側が組み立てる。
    atom の所有者は 1 つなので、この分割で二重加算が構造的に起きない。
    未帰属 atom（owner_span_id が None）はどの invocation にも足さない。
    """
    require(invocation_id in {r["invocation_id"] for r in run["invocations"]},
            "unknown_invocation")
    own_spans = {r["span_id"] for r in run["spans"] if r["invocation_id"] == invocation_id}
    totals = {k: 0 for k in USAGE_FIELDS}
    for atom in run["atoms"]:
        if atom["owner_span_id"] in own_spans:
            for k in USAGE_FIELDS:
                totals[k] += atom["usage"][k]
    return totals

def inclusive_usage(run, invocation_id):
    """invocation とその子孫の exclusive_usage の集合和。

    atom の所有者は 1 つ（validate_run が保証）なので、子孫の exclusive を足しても
    同じ atom が 2 回数えられる経路は無い。未帰属 atom はここにも入らない。
    """
    children = {}
    for row in run["invocations"]:
        children.setdefault(row["parent_invocation_id"], []).append(row["invocation_id"])
    totals = {k: 0 for k in USAGE_FIELDS}
    stack = [invocation_id]
    while stack:
        current = stack.pop()
        part = exclusive_usage(run, current)
        for k in USAGE_FIELDS:
            totals[k] += part[k]
        stack.extend(children.get(current, []))
    return totals
