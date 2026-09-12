#!/usr/bin/env python3
"""run ledger の決定的な writer / reader。

ledger は 1 run の時系列台帳（JSON Lines）で、plan の改稿・verifier の findings・棄却案と
その理由・司令塔の自己解決裁定・Do/Check/Act の結果が起きた順に並ぶ。後段の agent は
これを読んでから書くので、「一度裁定した論点が次の agent で無かったことになる」経路が減る。

**entry を書くのはこのスクリプトだけ**である。workflow script（pdca-plan.js / pdca.js）は
runtime にファイル IO を持たないため entry を構成して返り値に載せるところまでを行い、
司令塔がその JSON を**編集せずに**ここへ流す。agent に自筆で追記させないのは、追記が
agent の裁量に乗った時点で、都合の悪い entry の欠落と後からの書き換えが検出できなく
なるため。seq の採番・型の検査・既存行の不変性はここで機械的に担保する。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# ENTRY_TYPES: 台帳に載せてよい出来事の型。列挙で閉じてあるのは、型が自由記述だと
# 同じ出来事が run ごとに別名で載り、「裁定済みか」を後段が機械的に引けなくなるため。
ENTRY_TYPES = (
    "plan_v",  # planner が出した Plan の版
    "review_v",  # plan-verifier / build-verifier / verifier の findings
    "resolution",  # 論点の裁定（司令塔の自己解決・棄却案とその理由）
    "harness_frozen",  # 評価 harness の凍結（scripts/harness_freeze.py の digest と凍結時刻）
    "build",  # builder の成果物と測定点
    "build_review",  # build-verifier の判定
    "do_run",  # 条件 × 反復の実行と検証の結果
    "check",  # 集計・機序・較正
    "act_decision",  # act-judge の decision と根拠
    "note",  # 上記に当てはまらない観測事実
)

REQUIRED_FIELDS = ("type", "phase", "summary")


class LedgerError(Exception):
    pass


def _normalize(entry: object, seq: int) -> dict:
    if not isinstance(entry, dict):
        raise LedgerError(f"entry は object である必要があります: {entry!r}")
    missing = [f for f in REQUIRED_FIELDS if not str(entry.get(f) or "").strip()]
    if missing:
        raise LedgerError(f"entry seq={seq}: 必須フィールドが空です: {', '.join(missing)}")
    if entry["type"] not in ENTRY_TYPES:
        raise LedgerError(
            f"entry seq={seq}: 未知の type '{entry['type']}'。使えるのは {', '.join(ENTRY_TYPES)}"
        )
    refs = entry.get("refs", [])
    if not isinstance(refs, list) or any(not isinstance(r, int) for r in refs):
        raise LedgerError(f"entry seq={seq}: refs は seq(int) の配列である必要があります")
    normalized = dict(entry)
    # 呼び出し側の seq 申告は採用しない。採番はファイルの行数で決まる（台帳が正）。
    normalized["seq"] = seq
    normalized["refs"] = refs
    return normalized


def read_entries(path: Path) -> list[dict]:
    """既存 entry を読む。ファイルが無ければ空。壊れた行はここで落とす。"""
    if not path.exists():
        return []
    entries = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LedgerError(f"{path}:{lineno} が JSON として読めません: {exc}") from exc
        if not isinstance(parsed, dict) or "seq" not in parsed:
            raise LedgerError(f"{path}:{lineno} に seq がありません")
        entries.append(parsed)
    for expected, entry in enumerate(entries, start=1):
        if entry["seq"] != expected:
            raise LedgerError(
                f"{path}: seq が {expected} であるべき行に {entry['seq']} が入っています"
                "（行の削除・並べ替え・書き換えが起きています）"
            )
    return entries


def append_entries(path: Path, new_entries: list) -> list[dict]:
    """既存行を一切変えずに追記する。追記前に既存行を検証し、壊れていれば書かない。"""
    existing = read_entries(path)
    seq = len(existing)
    normalized = []
    for raw in new_entries:
        seq += 1
        normalized.append(_normalize(raw, seq))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for entry in normalized:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return normalized


def _load_payload(args: argparse.Namespace) -> list:
    if args.json is not None:
        raw = args.json
    else:
        raw = sys.stdin.read()
    if not raw.strip():
        return []
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, list) else [parsed]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PDCA run ledger の追記と読み出し")
    sub = parser.add_subparsers(dest="command", required=True)

    ap = sub.add_parser("append", help="entry を追記する（JSON object または array）")
    ap.add_argument("--path", required=True)
    ap.add_argument("--json", default=None, help="省略時は stdin から読む")

    rp = sub.add_parser("read", help="entry を JSON array で出す")
    rp.add_argument("--path", required=True)
    rp.add_argument("--types", default=None, help="カンマ区切りで型を絞る")

    vp = sub.add_parser("validate", help="台帳の整合（seq の連番・型・必須欄）を検査する")
    vp.add_argument("--path", required=True)

    args = parser.parse_args(argv)
    path = Path(args.path)

    try:
        if args.command == "append":
            written = append_entries(path, _load_payload(args))
            print(json.dumps({"appended": len(written), "last_seq": written[-1]["seq"] if written else len(read_entries(path))}, ensure_ascii=False))
            return 0
        if args.command == "read":
            entries = read_entries(path)
            if args.types:
                wanted = {t.strip() for t in args.types.split(",") if t.strip()}
                entries = [e for e in entries if e.get("type") in wanted]
            print(json.dumps(entries, ensure_ascii=False))
            return 0
        entries = read_entries(path)
        for entry in entries:
            _normalize(entry, entry["seq"])
        print(json.dumps({"entries": len(entries), "valid": True}, ensure_ascii=False))
        return 0
    except (LedgerError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
