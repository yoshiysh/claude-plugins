#!/usr/bin/env python3
"""スキル実行の telemetry を記録・集計する（kaizen 運転の Check 入力）。

pdca をスキル自身に適用する（問題起点の対象が配布スキルである）とき、Plan の「事実」と
Check の測定値はこのファイルが書き出す実測 JSON を正とする。会話ログや記憶を事実の
出所にすると、run の詳細が session とともに消え、次のサイクルが同じ抽出を手書きで
やり直すことになる（実測: kaizen 第 1 サイクルまでは毎回インライン抽出だった）。

対象は Workflow 返り値（prd-spec の refine.js / pdca.js など、構造化 summary を返す
script）。task output（{"result": ...} で包まれた形）と素の result の両方を受け付ける。

使い方:
  skill_telemetry.py record --skill prd-spec --label run6 --variant "main+fix" \
      --input-ref runner/run6-args.sh <output.json>
  skill_telemetry.py summary --skill prd-spec
  skill_telemetry.py compare --skill prd-spec --control run6-main --treatment run6-staging \
      --metric fabrication_findings --lower-is-better --threshold 0

`compare` は対照 run の判定を機械側に置く。対で記録されているか・同一入力（input_ref の
一致）か・指標が両条件で数値として取れるかを検査し、どれかが欠けたら判定を返さず exit 2
（「差が無い」と「測定が成立していない」を混ぜない）。

保存先: $SKILL_TELEMETRY_DIR（既定 ~/.claude/skill-telemetry）/<skill>/<label>.json
"""

import argparse
import json
import os
import sys
from pathlib import Path


def telemetry_dir() -> Path:
    return Path(os.environ.get("SKILL_TELEMETRY_DIR", Path.home() / ".claude" / "skill-telemetry"))


def load_result(path: str) -> dict:
    data = json.loads(Path(path).read_text())
    # task output は {"result": {...}, "logs": [...]} の形。素の result ならそのまま。
    if isinstance(data, dict) and isinstance(data.get("result"), dict):
        return data["result"]
    if not isinstance(data, dict):
        raise SystemExit(f"result が dict ではありません: {path}")
    return data


def extract(result: dict) -> dict:
    """返り値から指標だけを抜く。無いフィールドは None のまま残す（欠測を 0 に化けさせない）。"""
    summary = result.get("summary") or {}
    unpresented = result.get("unpresented_blocking") or []
    return {
        "verdict": result.get("verdict"),
        "dry_stop": result.get("dry_stop"),
        "novelty_history": result.get("novelty_history"),
        "revisions_used": result.get("revisions_used"),
        "fabrication_findings": summary.get("fabrication_findings"),
        "executability_findings": summary.get("executability_findings"),
        "validity_findings": summary.get("validity_findings"),
        "blocking_tbd_count": summary.get("blocking_tbd_count"),
        "unpresented_blocking_count": summary.get("unpresented_blocking_count"),
        "needs_input_sources": [
            str(t.get("source_finding_id") or "")[:2] for t in unpresented if isinstance(t, dict)
        ],
        "adjudicated": summary.get("adjudicated"),
        "writer_missing": len(result.get("writer_missing") or []),
        "audit_incomplete": result.get("audit_incomplete"),
        # (kaizen C3) 帰属判定用の内訳（refine.js の instr）。extract はホワイトリスト方式
        # なので、この行が無いと refine.js 側で emit しても telemetry には現れない。
        "instrumentation": summary.get("instrumentation"),
    }


def cmd_record(args) -> int:
    rec = {
        "run": args.label,
        "variant": args.variant,
        "source_file": args.output_json,
        # input_ref: 同一入力で発行されたことを後から機械的に照合するための識別子
        # （再現入力の wrapper script のパスや args の digest）。対照 run はこれが一致して
        # いないと「同じ入力で比べた」と言えないので、compare は不一致を測定不成立にする。
        "input_ref": args.input_ref,
    }
    rec.update(extract(load_result(args.output_json)))
    out = telemetry_dir() / args.skill
    out.mkdir(parents=True, exist_ok=True)
    dest = out / f"{args.label}.json"
    if dest.exists() and not args.force:
        raise SystemExit(f"既存の記録があります（上書きは --force）: {dest}")
    dest.write_text(json.dumps(rec, ensure_ascii=False, indent=1))
    print(dest)
    return 0


def cmd_summary(args) -> int:
    src = telemetry_dir() / args.skill
    files = sorted(p for p in src.glob("*.json") if p.name != "summary.json") if src.is_dir() else []
    if not files:
        # 記録ゼロは「良好」ではなく「未計測」。exit 2 で区別する（0 に丸めない）。
        print(f"telemetry がありません: {src}", file=sys.stderr)
        return 2
    rows = [json.loads(p.read_text()) for p in files]
    for r in rows:
        nov = r.get("novelty_history")
        tail = nov[-1] if isinstance(nov, list) and nov else None
        print(
            f"{r.get('run', '?'):18} {str(r.get('variant', ''))[:30]:30} "
            f"verdict={str(r.get('verdict')):26} dry={r.get('dry_stop')} "
            f"nov={nov} tail={tail} rev={r.get('revisions_used')} "
            f"fab={r.get('fabrication_findings')} unpres={r.get('unpresented_blocking_count')}"
        )
    dried = sum(1 for r in rows if r.get("dry_stop") is True)
    print(f"-- runs={len(rows)} dry_stop 到達 {dried}/{len(rows)}")
    return 0


def _numeric(value):
    """判定に使える数値だけを通す。bool は 0/1、それ以外の非数値は None（欠測）。"""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return None


def cmd_compare(args) -> int:
    """対照 run（control / treatment）を事前固定の基準で機械的に判定する。

    散文の手順だと、対で発行したか・同一入力だったか・事前固定の基準どおりに判定したかを
    誰も検査しない。ここで検査するのは 3 つで、どれかが欠けたら判定を返さず exit 2
    （「差が無い」ではなく「測定が成立していない」）。

    1. 両条件の記録が実在するか（対発行の記録の有無）
    2. 両者の input_ref が一致するか（同一入力性）
    3. 指標が両者で数値として取れるか（欠測を 0 に丸めない）
    """
    # 判定基準の解決。凍結 MANIFEST があればそこから読む — 差分を入れた本人が
    # Check 時に指標・向き・閾値を CLI で選び直す経路（凍結が防ごうとした事故の
    # 同型）を塞ぐ。手入力 3 値との併用は曖昧なので拒否する。
    manual = [args.metric is not None, args.higher_is_better is not None,
              args.threshold is not None]
    if args.frozen_manifest is not None:
        if any(manual):
            print(json.dumps({"ok": False,
                              "reason": "--frozen-manifest と手入力の基準（--metric / 向き / --threshold）は併用できません"},
                             ensure_ascii=False), file=sys.stderr)
            return 2
        manifest = json.loads(Path(args.frozen_manifest).read_text())
        criteria = manifest.get("criteria")
        if not isinstance(criteria, dict):
            print(json.dumps({"ok": False,
                              "reason": "MANIFEST に criteria がありません（凍結し直しが必要）"},
                             ensure_ascii=False), file=sys.stderr)
            return 2
        args.metric = criteria["metric"]
        args.higher_is_better = criteria["higher_is_better"]
        args.threshold = float(criteria["threshold"])
    elif not all(manual):
        print(json.dumps({"ok": False,
                          "reason": "--frozen-manifest か、--metric / 向き / --threshold の 3 点を渡してください"},
                         ensure_ascii=False), file=sys.stderr)
        return 2
    src = telemetry_dir() / args.skill
    missing = [
        label
        for label in (args.control, args.treatment)
        if not (src / f"{label}.json").is_file()
    ]
    if missing:
        print(
            json.dumps(
                {"ok": False, "reason": "対照 run の記録が欠けています", "missing": missing},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    ctrl = json.loads((src / f"{args.control}.json").read_text())
    trt = json.loads((src / f"{args.treatment}.json").read_text())

    ctrl_ref = str(ctrl.get("input_ref") or "")
    trt_ref = str(trt.get("input_ref") or "")
    if not ctrl_ref or not trt_ref or ctrl_ref != trt_ref:
        print(
            json.dumps(
                {
                    "ok": False,
                    "reason": "input_ref が一致しない（または未記録）ため同一入力の対照として成立していません",
                    "control_input_ref": ctrl_ref or None,
                    "treatment_input_ref": trt_ref or None,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    a = _numeric(ctrl.get(args.metric))
    b = _numeric(trt.get(args.metric))
    if a is None or b is None:
        print(
            json.dumps(
                {
                    "ok": False,
                    "reason": f"指標 {args.metric} が数値として両条件から取れません（未計測）",
                    "control": ctrl.get(args.metric),
                    "treatment": trt.get(args.metric),
                },
                ensure_ascii=False,
            ),
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
                "control": {"label": args.control, "value": a, "variant": ctrl.get("variant")},
                "treatment": {"label": args.treatment, "value": b, "variant": trt.get("variant")},
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
    rec = sub.add_parser("record", help="Workflow 出力 1 件から指標を抽出して記録する")
    rec.add_argument("--skill", required=True)
    rec.add_argument("--label", required=True, help="run の識別名（ファイル名になる）")
    rec.add_argument("--variant", default="", help="条件の説明（例: main / staging+A案）")
    rec.add_argument("--force", action="store_true")
    rec.add_argument(
        "--input-ref",
        default="",
        help="再現入力の識別子（wrapper script のパス等）。対照 run は同じ値で記録する",
    )
    rec.add_argument("output_json", help="Workflow の task output か result の JSON パス")
    rec.set_defaults(fn=cmd_record)
    sm = sub.add_parser("summary", help="スキルの記録を一覧し dry_stop 到達率を出す")
    sm.add_argument("--skill", required=True)
    sm.set_defaults(fn=cmd_summary)
    cp = sub.add_parser(
        "compare", help="対照 run（control / treatment）を事前固定の基準で判定する"
    )
    cp.add_argument("--skill", required=True)
    cp.add_argument("--control", required=True, help="本体版の run label")
    cp.add_argument("--treatment", required=True, help="staging 版の run label")
    cp.add_argument(
        "--frozen-manifest",
        default=None,
        help="凍結 harness の MANIFEST.json。指定時は metric / 向き / threshold を"
             "凍結値から読む（手入力の 3 引数とは併用不可）",
    )
    cp.add_argument("--metric", default=None, help="判定に使う記録フィールド名（--frozen-manifest 無しのとき必須）")
    cp.add_argument(
        "--threshold",
        type=float,
        default=None,
        help="この差を超えて初めて優劣を言う（--frozen-manifest 無しのとき必須）",
    )
    direction = cp.add_mutually_exclusive_group(required=False)
    direction.add_argument("--higher-is-better", dest="higher_is_better", action="store_true", default=None)
    direction.add_argument("--lower-is-better", dest="higher_is_better", action="store_false")
    cp.set_defaults(fn=cmd_compare)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
