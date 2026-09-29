#!/usr/bin/env python3
"""prd-spec の 1 ランの費用と時間を、agent の transcript（agent-*.jsonl）から集計する。

usage: python3 usage.py --workspace <W> <transcript のディレクトリかファイル>... [--weights R,W5M,W1H] [--json]

母集団（何を 1 ランの agent として数えるか）はここで固定する。呼ぶ人ごとに数え方が変わると、ラン同士を
比べられない（実測: 同じランを「46 体」と「43 体」で数えた食い違いがあった）。

- 数える: usage を持つ応答が 1 つ以上あり、本文のどこかに W の絶対パスが現れる transcript。prd-spec の agent は
  どれも W のファイルを読み書きするので、W を一度も参照しない transcript は別の案件の agent である。
- 除く: usage を持つ応答が 0 の transcript（`empty`。起動しただけで応答しなかった、再開の前の空の 1 本など）と、
  W を参照しない transcript（`other_case`）。除いたものは理由付きで出力に並べる（黙って除くと、全部を数えた
  ように読める）。

集計するもの:
- agent ごとの行（per_agent）: label（隣の agent-<id>.meta.json の description。無ければ null）、run（transcript の
  親ディレクトリが Workflow の呼び出しごとの wf_* なら、その名前。外なら null）、ターン数（usage を持つ応答の数。
  同じ message id の行は 1 つに数え、各欄は最大値を取る）、input・cache_read・cache_creation と、その内訳の
  cache_creation_5m・cache_creation_1h（usage.cache_creation.ephemeral_5m_input_tokens・ephemeral_1h_input_tokens）、
  output、最初のターン（first_turn）の同じ欄、壁時計（最初と最後の行の timestamp の差）
- 内訳が無いか、内訳の和が cache_creation_input_tokens に足りない応答の差分は cache_creation_unsplit に出す
  （5 分か 1 時間のどちらかに寄せると、請求の重みが黙って変わる）
- run（Workflow の呼び出し）ごとの合計（per_run。最初の行の時刻の順）と、run の最初の agent の label と最初の
  ターン。合計と model ごとの内訳
- --weights（cache read・5 分の書き込み・1 時間の書き込みの、通常の入力に対する倍率）を渡したときだけ、
  weighted_input（通常の入力に換算した入力の token 数）を足す。倍率はここに持たない: 司令塔が試走の時点の公式の
  料金表（claude-api スキルの pricing）から取って渡す（書き写すと料金の改定でずれる）。unsplit が 0 でない行は
  重みが決まらないので null にする
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
SPLIT_KEYS = {"ephemeral_5m_input_tokens": "cache_creation_5m", "ephemeral_1h_input_tokens": "cache_creation_1h"}
FIELDS = ("input", "cache_read", "cache_creation", "cache_creation_5m", "cache_creation_1h", "cache_creation_unsplit", "output")
RUN_DIR = re.compile(r"^wf_")


def _ts(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else 0


def _turn_fields(u):
    split = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else {}
    out = {
        "input": _num(u.get("input_tokens")),
        "cache_read": _num(u.get("cache_read_input_tokens")),
        "cache_creation": _num(u.get("cache_creation_input_tokens")),
        "output": _num(u.get("output_tokens")),
    }
    for k, name in SPLIT_KEYS.items():
        out[name] = _num(split.get(k))
    return out


def _unsplit(t):
    return max(0, t["cache_creation"] - t["cache_creation_5m"] - t["cache_creation_1h"])


def _label(path):
    meta = re.sub(r"\.jsonl$", ".meta.json", path)
    try:
        with open(meta, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    return d.get("description") if isinstance(d, dict) else None


def _run(path):
    parent = os.path.basename(os.path.dirname(os.path.abspath(path)))
    return parent if RUN_DIR.match(parent) else None


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
        mid = m.get("id") or f"line-{len(by_id)}"
        model = m.get("model", model)
        cur = _turn_fields(m["usage"])
        prev = by_id.get(mid, {})
        by_id[mid] = {k: max(prev.get(k, 0), v) for k, v in cur.items()}
    turns = [{**t, "cache_creation_unsplit": _unsplit(t)} for t in by_id.values()]
    total = collections.Counter()
    for t in turns:
        total.update(t)
    first = turns[0] if turns else {}
    return {
        "file": os.path.basename(path),
        "label": _label(path),
        "run": _run(path),
        "model": model,
        "turns": len(turns),
        **{k: total[k] for k in FIELDS},
        "first_turn": {k: first.get(k, 0) for k in FIELDS},
        "first_turn_input": sum(first.get(k, 0) for k in ("input", "cache_read", "cache_creation")),
        "start": min(stamps) if stamps else None,
        "end": max(stamps) if stamps else None,
        "seconds": round(max(stamps) - min(stamps), 1) if stamps else None,
        "_text": text,
    }


def weighted_input(row, weights):
    """通常の入力に換算した入力。unsplit があれば 5 分と 1 時間のどちらの重みかが決まらないので None。"""
    if row["cache_creation_unsplit"]:
        return None
    read, w5m, w1h = weights
    return row["input"] + row["cache_read"] * read + row["cache_creation_5m"] * w5m + row["cache_creation_1h"] * w1h


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


def _sum(rows):
    c = collections.Counter()
    for r in rows:
        c.update({k: r[k] for k in ("turns", *FIELDS)})
    return dict(c)


def _order(r):
    return (r["start"] is None, r["start"] or 0, r["file"])


def per_run(agents):
    runs = collections.OrderedDict()
    for r in sorted(agents, key=_order):
        runs.setdefault(r["run"], []).append(r)
    out = []
    for run, rows in runs.items():
        head = rows[0]
        out.append({
            "run": run,
            "agents": len(rows),
            **_sum(rows),
            "first_agent": {"label": head["label"], "file": head["file"], "first_turn": dict(head["first_turn"])},
        })
    return out


def summarize(workspace, paths, weights=None):
    workspace = os.path.abspath(workspace).rstrip("/")
    included, excluded = [], []
    for path in collect(paths):
        rec = scan_transcript(path)
        reason = classify(rec, workspace)
        if reason:
            excluded.append({"file": rec["file"], "reason": reason, "turns": rec["turns"]})
        else:
            included.append(rec)
    agents = [{k: v for k, v in r.items() if not k.startswith("_") and k != "end"} for r in sorted(included, key=_order)]
    total = collections.Counter(_sum(agents))
    by_model = collections.defaultdict(list)
    for r in agents:
        by_model[r["model"]].append(r)
    runs = per_run(agents)
    if weights:
        for row in agents:
            row["weighted_input"] = weighted_input(row, weights)
            row["first_turn"]["weighted_input"] = weighted_input(row["first_turn"], weights)
        for row in runs:
            row["weighted_input"] = weighted_input(row, weights)
            row["first_agent"]["first_turn"]["weighted_input"] = weighted_input(row["first_agent"]["first_turn"], weights)
    starts = [r["start"] for r in included if r["start"] is not None]
    ends = [r["end"] for r in included if r["end"] is not None]
    out = {
        "workspace": workspace,
        "agents": len(agents),
        "excluded": excluded,
        "total": {**dict(total), "input_all": total["input"] + total["cache_read"] + total["cache_creation"]},
        "by_model": {str(k): _sum(v) for k, v in by_model.items()},
        "per_run": runs,
        "span_seconds": round(max(ends) - min(starts), 1) if starts and ends else None,
        "busy_seconds": busy_seconds(included),
        "findings": findings_summary(workspace),
        "per_agent": agents,
    }
    if weights:
        out["weights"] = {"cache_read": weights[0], "cache_creation_5m": weights[1], "cache_creation_1h": weights[2]}
        out["total"]["weighted_input"] = weighted_input(out["total"], weights)
        for v in out["by_model"].values():
            v["weighted_input"] = weighted_input(v, weights)
    return out


def _weights(text):
    try:
        values = [float(x) for x in text.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError("--weights は数値 3 つをカンマで区切る（cache read, 5 分の書き込み, 1 時間の書き込み）")
    if len(values) != 3 or any(v < 0 for v in values):
        raise argparse.ArgumentTypeError("--weights は 0 以上の数値 3 つ（cache read, 5 分の書き込み, 1 時間の書き込み）")
    return tuple(values)


def _cols(row):
    parts = [f"{k} {row.get(k, 0)}" for k in FIELDS]
    if "weighted_input" in row:
        parts.append(f"weighted_input {row['weighted_input']}")
    return "  ".join(parts)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--workspace", required=True, help="このランの W（絶対パス）。母集団の判定に使う")
    ap.add_argument("--weights", type=_weights, help="cache read・5 分の書き込み・1 時間の書き込みの、通常の入力に対する倍率（R,W5M,W1H）。試走の時点の公式の料金表から取る")
    ap.add_argument("--json", action="store_true", help="agent ごとの内訳を含む JSON を出す")
    ap.add_argument("paths", nargs="+", help="transcript のディレクトリか agent-*.jsonl")
    a = ap.parse_args(argv)
    s = summarize(a.workspace, a.paths, a.weights)
    if a.json:
        print(json.dumps(s, ensure_ascii=False, indent=1))
        return 0
    t = s["total"]
    print(f"agents {s['agents']}  turns {t.get('turns', 0)}  input_all {t.get('input_all', 0)}  read {t.get('cache_read', 0)}  creation {t.get('cache_creation', 0)}  output {t.get('output', 0)}")
    print(f"total  {_cols(t)}")
    print(f"busy_seconds {s['busy_seconds']}  span_seconds {s['span_seconds']}")
    for r in s["per_run"]:
        f = r["first_agent"]
        print(f"run {r['run']}  agents {r['agents']}  turns {r['turns']}  {_cols(r)}")
        print(f"  first_agent {f['label']} ({f['file']})  first_turn  {_cols(f['first_turn'])}")
    for r in s["per_agent"]:
        print(f"agent {r['run']} {r['label']} ({r['file']}, {r['model']})  turns {r['turns']}  {_cols(r)}")
        print(f"  first_turn  {_cols(r['first_turn'])}")
    for e in s["excluded"]:
        print(f"excluded {e['file']} ({e['reason']}, turns {e['turns']})")
    for k, v in s["findings"].items():
        print(f"findings {k}: {v['findings']} (blocking {v['blocking']}, items {v['items']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
