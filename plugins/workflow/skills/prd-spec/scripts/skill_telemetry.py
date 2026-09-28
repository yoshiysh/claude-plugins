#!/usr/bin/env python3
"""スキル実行の telemetry を記録・集計する（kaizen 運転の Check 入力）。

配布スキル自身を改善の対象にするとき、改善前の「事実」と対照 run の測定値は
このファイルが書き出す実測 JSON を正とする。会話ログや記憶を事実の
出所にすると、run の詳細が session とともに消え、次のサイクルが同じ抽出を手書きで
やり直すことになる。

対象は `prd.js` の Workflow task output（`{summary, agentCount, result, workflowProgress,
totalTokens, totalToolCalls}` の形。task output で包まれていない素の `result` も受け付ける）。

record/compare/summary の単位（leg と run、集計の仕方）は `references/telemetry.md` を正とする。

使い方:
  skill_telemetry.py record --skill prd-spec --label run6-g0 --run-id run6 --variant "main" \
      --input-ref runner/run6-args.sh <output.json>
  skill_telemetry.py summary --skill prd-spec
  skill_telemetry.py compare --skill prd-spec --control run6 --treatment run6-staging \
      --criteria-file criteria.json
"""

import argparse
import json
import os
import sys
from pathlib import Path


def telemetry_dir() -> Path:
    return Path(os.environ.get("SKILL_TELEMETRY_DIR", Path.home() / ".claude" / "skill-telemetry"))


def load_task_output(path: str) -> tuple:
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict):
        raise SystemExit(f"result が dict ではありません: {path}")
    if isinstance(data.get("result"), dict):
        return data["result"], data
    return data, {}


def _count(value):
    if isinstance(value, (list, dict)):
        return len(value)
    return None


def _undeclared_count(value):
    if not isinstance(value, dict):
        return None
    return sum(len(v) for v in value.values() if isinstance(v, list))


def extract(result: dict, meta: dict) -> dict:
    """prd.js の finish()（[SKILL_DIR]/scripts/prd.js）が返す形から指標だけを抜く。"""
    next_args = result.get("next_args")
    state = (next_args or {}).get("state") or {}
    return {
        "status": result.get("status"),
        "gate": state.get("gate"),
        "terminal": next_args is None,
        "question_count": _count(result.get("question_ids")),
        "holds_count": _count(result.get("holds")),
        "hold_drafts_count": _count(result.get("hold_drafts")),
        "open_tbd_count": _count(result.get("open_tbd")),
        "missed_count": _count(result.get("missed")),
        "integrity_count": _count(result.get("integrity")),
        "notices_count": _count(result.get("notices")),
        "undeclared_count": _undeclared_count(result.get("undeclared")),
        "remaining_blocking_count": _count(result.get("remaining_blocking")),
        "carried_blocking_count": _count(result.get("carried_blocking")),
        "stop_reason": result.get("stop_reason"),
        "pass_count": result.get("passes"),
        "rerouted_count": _count(result.get("item_routes")),
        "agent_count": meta.get("agentCount"),
        "total_tokens": meta.get("totalTokens"),
        "total_tool_calls": meta.get("totalToolCalls"),
    }


SUM_FIELDS = ("agent_count", "total_tokens", "total_tool_calls", "question_count")
TERMINAL_FIELDS = ("status", "holds_count", "hold_drafts_count", "open_tbd_count", "missed_count",
                    "integrity_count", "notices_count", "undeclared_count", "remaining_blocking_count",
                    "carried_blocking_count", "stop_reason", "pass_count", "rerouted_count")


def aggregate_run(legs: list) -> dict:
    """1 run 分の leg レコードから run 単位の値を作る。

    agent 数・token・tool call・問いの件数は leg ごとの値の合算（leg は独立した
    Workflow 実行）。holds・hold_drafts・open_tbd・missed・integrity・notices・undeclared・remaining_blocking・carried_blocking は
    prd.js の `state` が run を通じて積み上がるものなので、終端 leg（`next_args` が
    null、すなわち done か再開不能な blocked）の値だけを採る（合算すると二重に数える）。
    終端 leg が 1 件でない run と、全 leg で共有する非空 input_ref が無い run は invalid。
    """
    terminals = [leg for leg in legs if leg.get("terminal")]
    all_refs = {leg.get("input_ref") for leg in legs}
    # 全 leg が同じ非空 input_ref を持つときだけ「同一入力の run」として成立する。
    # 未記録（空文字・欠測）は測定できない run として invalid に含める。
    shared_ref = next(iter(all_refs)) if len(all_refs) == 1 else None
    if len(terminals) != 1 or not shared_ref:
        return {
            "valid": False,
            "leg_count": len(legs),
            "terminal_count": len(terminals),
            "input_refs": sorted(r for r in all_refs if r),
        }
    term = terminals[0]
    agg = {
        "valid": True,
        "leg_count": len(legs),
        "input_ref": shared_ref,
        "gates_visited": sorted({leg.get("gate") for leg in legs if leg.get("gate")}),
    }
    for k in SUM_FIELDS:
        vals = [leg.get(k) for leg in legs if isinstance(leg.get(k), (int, float))]
        agg[k] = sum(vals) if vals else None
    for k in TERMINAL_FIELDS:
        agg[k] = term.get(k)
    return agg


def cmd_record(args) -> int:
    result, meta = load_task_output(args.output_json)
    rec = {
        "label": args.label,
        "run_id": args.run_id or args.label,
        "variant": args.variant,
        "source_file": args.output_json,
        "input_ref": args.input_ref,
    }
    rec.update(extract(result, meta))
    out = telemetry_dir() / args.skill
    out.mkdir(parents=True, exist_ok=True)
    dest = out / f"{args.label}.json"
    if dest.exists() and not args.force:
        raise SystemExit(f"既存の記録があります（上書きは --force）: {dest}")
    dest.write_text(json.dumps(rec, ensure_ascii=False, indent=1))
    print(dest)
    return 0


def load_inventory(skill: str) -> dict:
    """skill の全 leg レコードを run_id ごとにまとめる。"""
    src = telemetry_dir() / skill
    files = sorted(p for p in src.glob("*.json") if p.name != "summary.json") if src.is_dir() else []
    runs = {}
    for p in files:
        try:
            rec = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        runs.setdefault(rec.get("run_id") or rec.get("label", "?"), []).append(rec)
    return runs


def cmd_summary(args) -> int:
    runs = load_inventory(args.skill)
    if not runs:
        # 記録ゼロは「良好」ではなく「未計測」。exit 2 で区別する（0 に丸めない）。
        print(f"telemetry がありません: {telemetry_dir() / args.skill}", file=sys.stderr)
        return 2
    done = 0
    for run_id in sorted(runs):
        legs = sorted(runs[run_id], key=lambda r: r.get("label", ""))
        for r in legs:
            print(
                f"{run_id:18} {r.get('label', '?'):20} {str(r.get('variant', ''))[:20]:20} "
                f"status={str(r.get('status')):14} gate={str(r.get('gate')):8} "
                f"terminal={r.get('terminal')} q={r.get('question_count')} "
                f"tokens={r.get('total_tokens')} tools={r.get('total_tool_calls')} agents={r.get('agent_count')}"
            )
        agg = aggregate_run(legs)
        if not agg["valid"]:
            print(f"-- {run_id} legs={agg['leg_count']} 未完了（終端 leg {agg['terminal_count']} 件・input_ref {agg['input_refs']}）")
            continue
        if agg.get("status") == "done":
            done += 1
        print(
            f"-- {run_id} legs={agg['leg_count']} gates={agg['gates_visited']} status={agg['status']} "
            f"agents={agg['agent_count']} tokens={agg['total_tokens']} tools={agg['total_tool_calls']} "
            f"q={agg['question_count']} holds={agg['holds_count']} hold_drafts={agg['hold_drafts_count']} open_tbd={agg['open_tbd_count']} "
            f"missed={agg['missed_count']} integrity={agg['integrity_count']} notices={agg['notices_count']} "
            f"undeclared={agg['undeclared_count']} remaining_blocking={agg['remaining_blocking_count']} carried_blocking={agg['carried_blocking_count']} "
            f"stop_reason={agg['stop_reason']} passes={agg['pass_count']} rerouted={agg['rerouted_count']}"
        )
    print(f"-- runs={len(runs)} done 到達 {done}/{len(runs)}")
    return 0


def _numeric(value):
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return None


def cmd_compare(args) -> int:
    """対照 run（control / treatment）を事前固定の基準で機械的に判定する。run_id ごとに
    leg を集計してから比べる（1 run は複数 leg に分かれうるので、leg 単体の比較では run の
    総コストや終端状態を捉え損なう）。

    判定を返さず exit 2 にする条件:
    1. どちらかの run_id に記録が無い
    2. どちらかの run が未完了（終端 leg が 0 件か 2 件以上）か、leg 間で input_ref が割れている
    3. 両 run の input_ref が一致しない
    4. 指標が両条件で数値として取れない
    """
    manual = [args.metric is not None, args.higher_is_better is not None,
              args.threshold is not None]
    if args.criteria_file is not None:
        if any(manual):
            print(json.dumps({"ok": False,
                              "reason": "--criteria-file と手入力の基準（--metric / 向き / --threshold）は併用できません"},
                             ensure_ascii=False), file=sys.stderr)
            return 2
        criteria = json.loads(Path(args.criteria_file).read_text()).get("criteria")
        if (not isinstance(criteria, dict)
                or not str(criteria.get("metric") or "").strip()
                or not isinstance(criteria.get("higher_is_better"), bool)
                or not isinstance(criteria.get("threshold"), (int, float))
                or isinstance(criteria.get("threshold"), bool)):
            print(json.dumps({"ok": False,
                              "reason": "基準ファイルの criteria が不正か欠けています"},
                             ensure_ascii=False), file=sys.stderr)
            return 2
        args.metric = str(criteria["metric"]).strip()
        args.higher_is_better = criteria["higher_is_better"]
        args.threshold = float(criteria["threshold"])
    elif not all(manual):
        print(json.dumps({"ok": False,
                          "reason": "--criteria-file か、--metric / 向き / --threshold の 3 点を渡してください"},
                         ensure_ascii=False), file=sys.stderr)
        return 2

    runs = load_inventory(args.skill)
    missing = [label for label in (args.control, args.treatment) if label not in runs]
    if missing:
        print(
            json.dumps({"ok": False, "reason": "対照 run の記録が欠けています", "missing": missing},
                       ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    ctrl = aggregate_run(runs[args.control])
    trt = aggregate_run(runs[args.treatment])
    if not ctrl["valid"] or not trt["valid"]:
        print(
            json.dumps({
                "ok": False,
                "reason": "run が未完了（終端 leg が 1 件でない）か input_ref が leg 間で割れています",
                "control": ctrl, "treatment": trt,
            }, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    ctrl_ref = str(ctrl.get("input_ref") or "")
    trt_ref = str(trt.get("input_ref") or "")
    if not ctrl_ref or not trt_ref or ctrl_ref != trt_ref:
        print(
            json.dumps({
                "ok": False,
                "reason": "input_ref が一致しない（または未記録）ため同一入力の対照として成立していません",
                "control_input_ref": ctrl_ref or None,
                "treatment_input_ref": trt_ref or None,
            }, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    a = _numeric(ctrl.get(args.metric))
    b = _numeric(trt.get(args.metric))
    if a is None or b is None:
        print(
            json.dumps({
                "ok": False,
                "reason": f"指標 {args.metric} が数値として両条件から取れません（未計測）",
                "control": ctrl.get(args.metric),
                "treatment": trt.get(args.metric),
            }, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    delta = b - a
    gain = delta if args.higher_is_better else -delta
    if gain > args.threshold:
        favored = "treatment"
    elif -gain > args.threshold:
        favored = "control"
    else:
        favored = "tie"
    print(
        json.dumps(
            {
                "ok": True,
                "metric": args.metric,
                "higher_is_better": args.higher_is_better,
                "input_ref": ctrl_ref,
                "control": {"run_id": args.control, "value": a},
                "treatment": {"run_id": args.treatment, "value": b},
                "delta": delta,
                "threshold": args.threshold,
                "favored": favored,
            },
            ensure_ascii=False,
        )
    )
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    rec = sub.add_parser("record", help="prd.js の task output 1 leg から指標を抽出して記録する")
    rec.add_argument("--skill", required=True)
    rec.add_argument("--label", required=True, help="leg の識別名（ファイル名になる）")
    rec.add_argument("--run-id", default="", help="同じ run に属する leg をまとめる識別子（省略時は --label と同じ）")
    rec.add_argument("--variant", default="", help="条件の説明（例: main / staging+A案）")
    rec.add_argument("--force", action="store_true")
    rec.add_argument("--input-ref", default="", help="再現入力の識別子。対照 run の全 leg で同じ値にする")
    rec.add_argument("output_json", help="prd.js の task output か result の JSON パス")
    rec.set_defaults(fn=cmd_record)
    sm = sub.add_parser("summary", help="スキルの記録を run 単位で一覧し done 到達率を出す")
    sm.add_argument("--skill", required=True)
    sm.set_defaults(fn=cmd_summary)
    cp = sub.add_parser("compare", help="対照 run（control / treatment、run_id で指定）を事前固定の基準で判定する")
    cp.add_argument("--skill", required=True)
    cp.add_argument("--control", required=True, help="本体版の run_id")
    cp.add_argument("--treatment", required=True, help="staging 版の run_id")
    cp.add_argument("--criteria-file", default=None,
                     help="criteria{metric, higher_is_better, threshold} を持つ JSON")
    cp.add_argument("--metric", default=None, help="判定に使う run 集計フィールド名（--criteria-file 無しのとき必須）")
    cp.add_argument("--threshold", type=float, default=None,
                     help="この差を超えて初めて優劣を言う（--criteria-file 無しのとき必須）")
    direction = cp.add_mutually_exclusive_group(required=False)
    direction.add_argument("--higher-is-better", dest="higher_is_better", action="store_true", default=None)
    direction.add_argument("--lower-is-better", dest="higher_is_better", action="store_false")
    cp.set_defaults(fn=cmd_compare)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
