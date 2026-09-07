#!/usr/bin/env python3
"""スキル実行の telemetry を記録・集計する（kaizen 運転の Check 入力）。

pdca をスキル自身に適用する（問題起点の対象が配布スキルである）とき、Plan の「事実」と
Check の測定値はこのファイルが書き出す実測 JSON を正とする。会話ログや記憶を事実の
出所にすると、run の詳細が session とともに消え、次のサイクルが同じ抽出を手書きで
やり直すことになる（実測: kaizen 第 1 サイクルまでは毎回インライン抽出だった）。

対象は Workflow 返り値（prd-spec の refine.js / pdca.js など、構造化 summary を返す
script）。task output（{"result": ...} で包まれた形）と素の result の両方を受け付ける。

使い方:
  skill_telemetry.py record --skill prd-spec --label run6 --variant "main+fix" <output.json>
  skill_telemetry.py summary --skill prd-spec

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
    }


def cmd_record(args) -> int:
    rec = {"run": args.label, "variant": args.variant, "source_file": args.output_json}
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    rec = sub.add_parser("record", help="Workflow 出力 1 件から指標を抽出して記録する")
    rec.add_argument("--skill", required=True)
    rec.add_argument("--label", required=True, help="run の識別名（ファイル名になる）")
    rec.add_argument("--variant", default="", help="条件の説明（例: main / staging+A案）")
    rec.add_argument("--force", action="store_true")
    rec.add_argument("output_json", help="Workflow の task output か result の JSON パス")
    rec.set_defaults(fn=cmd_record)
    sm = sub.add_parser("summary", help="スキルの記録を一覧し dry_stop 到達率を出す")
    sm.add_argument("--skill", required=True)
    sm.set_defaults(fn=cmd_summary)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
