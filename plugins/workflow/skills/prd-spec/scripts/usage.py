#!/usr/bin/env python3
"""prd-spec の 1 ランの費用と時間を、agent の transcript（agent-*.jsonl）から集計する。

usage: python3 usage.py --workspace <W> <transcript のディレクトリかファイル>... [--json]

母集団（何を 1 ランの agent として数えるか）はここで固定する。呼ぶ人ごとに数え方が変わると、ラン同士を
比べられない（実測: 同じランを「46 体」と「43 体」で数えた食い違いがあった）。

- 数える: usage を持つ応答が 1 つ以上あり、本文のどこかに W の絶対パスが現れる transcript。prd-spec の agent は
  どれも W のファイルを読み書きするので、W を一度も参照しない transcript は別の案件の agent である。
- 除く: usage を持つ応答が 0 の transcript（`empty`。起動しただけで応答しなかった、再開の前の空の 1 本など）と、
  W を参照しない transcript（`other_case`）。除いたものは理由付きで出力に並べる（黙って除くと、全部を数えた
  ように読める）。

集計するもの:
- agent ごとのターン数（usage を持つ応答の数。同じ message id の行は 1 つに数え、各欄は最大値を取る）、
  input・cache read・cache creation・output、最初のターンの入力（input + read + creation）、壁時計（最初と
  最後の行の timestamp の差）
- 合計と model ごとの内訳
- busy_seconds: agent が 1 体以上動いていた時間の和（各 agent の区間の和集合の長さ）。依頼者の回答を待つ
  間は agent が動いていないので除かれる。段の依存から導く critical path そのものではないが、並列の agent は
  重なった区間として 1 回だけ数えるので、直列の段を積み上げた長さに当たる
- 指摘の件数: W/findings/r<n>-*.json の件数、blocking の件数、指摘の当たった項目（doc と item_id の組）の
  数を周回ごとに。項目の数は観点の重複を除いた件数の上限の目安であって、同じ欠陥かの判定はしていない
"""

import argparse
import collections
import glob
import json
import os
import re
import sys
from datetime import datetime

USAGE_KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")


def _ts(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def scan_transcript(path):
    """1 本の transcript を読み、応答ごとの usage（message id で重複を除く）と時刻を返す。"""
    by_id = collections.OrderedDict()
    stamps = []
    model = None
    with open(path, encoding="utf-8", errors="ignore") as f:
        text = f.read()
    for line in text.splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = _ts(d.get("timestamp")) if d.get("timestamp") else None
        if t is not None:
            stamps.append(t)
        m = d.get("message")
        if not isinstance(m, dict) or not isinstance(m.get("usage"), dict):
            continue
        u = m["usage"]
        mid = m.get("id") or f"line-{len(by_id)}"
        model = m.get("model", model)
        prev = by_id.get(mid, {})
        by_id[mid] = {k: max(prev.get(k, 0), u.get(k) or 0) for k in USAGE_KEYS}
    turns = list(by_id.values())
    total = collections.Counter()
    for u in turns:
        total.update(u)
    first = turns[0] if turns else {}
    return {
        "file": os.path.basename(path),
        "model": model,
        "turns": len(turns),
        "input": total["input_tokens"],
        "cache_read": total["cache_read_input_tokens"],
        "cache_creation": total["cache_creation_input_tokens"],
        "output": total["output_tokens"],
        "first_turn_input": sum(first.get(k, 0) for k in USAGE_KEYS[:3]),
        "start": min(stamps) if stamps else None,
        "end": max(stamps) if stamps else None,
        "seconds": round(max(stamps) - min(stamps), 1) if stamps else None,
        "_text": text,
    }


def classify(rec, workspace):
    """母集団の定義。含めるなら None、除くなら理由を返す。"""
    if rec["turns"] == 0:
        return "empty"
    if workspace not in rec["_text"]:
        return "other_case"
    return None


def busy_seconds(records):
    spans = sorted((r["start"], r["end"]) for r in records if r["start"] is not None and r["end"] is not None)
    total, cur = 0.0, None
    for s, e in spans:
        if cur is None or s > cur[1]:
            if cur:
                total += cur[1] - cur[0]
            cur = [s, e]
        else:
            cur[1] = max(cur[1], e)
    if cur:
        total += cur[1] - cur[0]
    return round(total, 1)


def findings_summary(workspace):
    rounds = collections.defaultdict(lambda: {"findings": 0, "blocking": 0, "items": set()})
    for path in sorted(glob.glob(os.path.join(workspace, "findings", "r*-*.json"))):
        m = re.match(r"r(\d+)-", os.path.basename(path))
        if not m:
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                body = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        r = rounds[f"r{m.group(1)}"]
        for f in body.get("findings", []) if isinstance(body, dict) else []:
            r["findings"] += 1
            r["blocking"] += 1 if f.get("blocking") else 0
            r["items"].add((f.get("doc"), f.get("item_id")))
    return {k: {"findings": v["findings"], "blocking": v["blocking"], "items": len(v["items"])} for k, v in sorted(rounds.items())}


def collect(paths):
    files = []
    for a in paths:
        if os.path.isdir(a):
            files.extend(sorted(glob.glob(os.path.join(a, "**", "agent-*.jsonl"), recursive=True)))
        else:
            files.append(a)
    return files


def summarize(workspace, paths):
    workspace = os.path.abspath(workspace).rstrip("/")
    included, excluded = [], []
    for path in collect(paths):
        rec = scan_transcript(path)
        reason = classify(rec, workspace)
        if reason:
            excluded.append({"file": rec["file"], "reason": reason, "turns": rec["turns"]})
        else:
            included.append(rec)
    agents = [{k: v for k, v in r.items() if not k.startswith("_") and k not in ("start", "end")} for r in included]
    total = collections.Counter()
    by_model = collections.defaultdict(collections.Counter)
    for r in agents:
        c = {k: r[k] for k in ("turns", "input", "cache_read", "cache_creation", "output")}
        total.update(c)
        by_model[r["model"]].update(c)
    starts = [r["start"] for r in included if r["start"] is not None]
    ends = [r["end"] for r in included if r["end"] is not None]
    return {
        "workspace": workspace,
        "agents": len(agents),
        "excluded": excluded,
        "total": {**dict(total), "input_all": total["input"] + total["cache_read"] + total["cache_creation"]},
        "by_model": {str(k): dict(v) for k, v in by_model.items()},
        "span_seconds": round(max(ends) - min(starts), 1) if starts and ends else None,
        "busy_seconds": busy_seconds(included),
        "findings": findings_summary(workspace),
        "per_agent": agents,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--workspace", required=True, help="このランの W（絶対パス）。母集団の判定に使う")
    ap.add_argument("--json", action="store_true", help="agent ごとの内訳を含む JSON を出す")
    ap.add_argument("paths", nargs="+", help="transcript のディレクトリか agent-*.jsonl")
    a = ap.parse_args(argv)
    s = summarize(a.workspace, a.paths)
    if a.json:
        print(json.dumps(s, ensure_ascii=False, indent=1))
        return 0
    t = s["total"]
    print(f"agents {s['agents']}  turns {t.get('turns', 0)}  input_all {t.get('input_all', 0)}  read {t.get('cache_read', 0)}  creation {t.get('cache_creation', 0)}  output {t.get('output', 0)}")
    print(f"busy_seconds {s['busy_seconds']}  span_seconds {s['span_seconds']}")
    for e in s["excluded"]:
        print(f"excluded {e['file']} ({e['reason']}, turns {e['turns']})")
    for k, v in s["findings"].items():
        print(f"findings {k}: {v['findings']} (blocking {v['blocking']}, items {v['items']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
