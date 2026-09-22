#!/usr/bin/env python3
"""OODA run ledger の唯一の writer / reader。

ledger は 1 run の時系列台帳（JSON Lines）で、各周の observe / orient / decide / act と、
検証役を通った観測（act_verified）が起きた順に並ぶ。scripts/ooda.js はファイルを書けないので
entry を組み立てて返り値の ledger_entries に載せるだけで、司令塔がそれを編集せずに
ここへ流す。seq と timestamp はこのスクリプトが付ける（呼び出し側に書かせると、欠落や
後からの書き換えを検出できなくなる）。

entry の形: {seq, iteration, phase, payload, timestamp}
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

PAYLOAD_SHAPES = {
    "observe": {"baseline_metrics": list, "current_state": str, "gaps_identified": list},
    "orient": {"status": str, "options": list},
    "decide": {"status": str},
    "act": {"executed_steps": list, "new_observations": list, "outcome": str},
    "act_verified": {"verified": list, "rejected": list},
}
PHASES = tuple(PAYLOAD_SHAPES)
INPUT_KEYS = {"iteration", "phase", "payload"}
STORED_KEYS = INPUT_KEYS | {"seq", "timestamp"}


class LedgerError(Exception):
    pass


def _check_body(entry: object, where: str, allowed_keys: set) -> dict:
    if not isinstance(entry, dict):
        raise LedgerError(f"{where}: entry は object である必要があります: {entry!r}")
    unknown = set(entry) - allowed_keys
    if unknown:
        raise LedgerError(f"{where}: 受け付けないキーがあります: {', '.join(sorted(unknown))}")
    missing = INPUT_KEYS - set(entry)
    if missing:
        raise LedgerError(f"{where}: 必須キーがありません: {', '.join(sorted(missing))}")
    iteration = entry["iteration"]
    if isinstance(iteration, bool) or not isinstance(iteration, int) or iteration < 1:
        raise LedgerError(f"{where}: iteration は 1 以上の整数である必要があります: {iteration!r}")
    if entry["phase"] not in PHASES:
        raise LedgerError(f"{where}: 未知の phase '{entry['phase']}'。使えるのは {', '.join(PHASES)}")
    payload = entry["payload"]
    if not isinstance(payload, dict):
        raise LedgerError(f"{where}: payload は object である必要があります")
    for field, kind in PAYLOAD_SHAPES[entry["phase"]].items():
        if not isinstance(payload.get(field), kind):
            raise LedgerError(f"{where}: phase '{entry['phase']}' の payload.{field} は {kind.__name__} である必要があります")
    return entry


def read_entries(path: Path, allow_missing: bool = True) -> list[dict]:
    """既存 entry を読む。壊れた行があれば読まずに止める。"""
    if not path.exists():
        if allow_missing:
            return []
        raise LedgerError(f"{path} がありません（新規 run なら read に --allow-missing を付ける）")
    if not path.is_file():
        raise LedgerError(f"{path} はファイルではありません")
    text = path.read_text(encoding="utf-8")
    if text and not text.endswith("\n"):
        raise LedgerError(f"{path}: 末尾が改行で終わっていません（途中で切れた書き込みか、別の writer が混ざっています）")
    entries = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        where = f"{path}:{lineno}"
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LedgerError(f"{where} が JSON として読めません: {exc}") from exc
        _check_body(parsed, where, STORED_KEYS)
        if parsed.get("seq") != lineno:
            raise LedgerError(f"{where}: seq は {lineno} であるべきところ {parsed.get('seq')!r} です（行の削除・並べ替え・書き換え）")
        if not isinstance(parsed.get("timestamp"), str) or not parsed["timestamp"]:
            raise LedgerError(f"{where}: timestamp がありません")
        entries.append(parsed)
    return entries


def append_entries(path: Path, new_entries: list) -> list[dict]:
    """既存行を検証してから、1 entry 1 行で追記する。1 件でも不正なら何も書かない。"""
    existing = read_entries(path)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stored = []
    for offset, raw in enumerate(new_entries, start=1):
        body = _check_body(raw, f"入力 entry #{offset}", INPUT_KEYS)
        stored.append(
            {
                "seq": len(existing) + offset,
                "iteration": body["iteration"],
                "phase": body["phase"],
                "payload": body["payload"],
                "timestamp": timestamp,
            }
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for entry in stored:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return stored


def _load_payload(raw: str) -> list:
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise LedgerError("--json には entry の配列（ooda.js の ledger_entries）を渡してください")
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OODA run ledger の追記と読み出し")
    sub = parser.add_subparsers(dest="command", required=True)

    ap = sub.add_parser("append", help="entry の配列を追記する")
    ap.add_argument("--path", required=True)
    ap.add_argument("--json", default=None, help="entry の配列。省略時は stdin から読む")

    rp = sub.add_parser("read", help="全 entry を JSON 配列で出す")
    rp.add_argument("--path", required=True)
    rp.add_argument("--allow-missing", action="store_true", help="新規 run のときだけ付ける。ファイルが無ければ [] を返す")

    args = parser.parse_args(argv)
    path = Path(args.path).expanduser()

    try:
        if args.command == "append":
            raw = args.json if args.json is not None else sys.stdin.read()
            written = append_entries(path, _load_payload(raw))
            last_seq = written[-1]["seq"] if written else len(read_entries(path))
            print(json.dumps({"appended": len(written), "last_seq": last_seq}, ensure_ascii=False))
            return 0
        print(json.dumps(read_entries(path, allow_missing=args.allow_missing), ensure_ascii=False))
        return 0
    except (LedgerError, json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
