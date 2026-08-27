#!/usr/bin/env python3
"""blocking TBD の較正を測る回帰ゲート。

Workflow（draft.js / refine.js）の返り値 JSON から tbd_items を読み、
blocking の件数と比率を提示容量と照合する。判定は純粋な算術で、
「どの TBD が本当に blocking か」の質は判定しない（それは
references/traceability.md §4 の基準で人間と auditor が見る）。

容量の根拠: 人間ゲート②は 1 回の提示で 20 件を超えると絞り込みに入り、
外側ループは最大 2 周。したがって 1 案件で提示できる blocking は
おおむね 40 件が上限で、それを超えた分は「未提示のまま完了」に直結する。
実測では自己適用 1 案件で blocking 59 件が起票され、56 件が未提示のまま残った。
この回帰を検出するのが本スクリプトの目的である。

exit code:
  0 = 容量内
  1 = 容量超過（blocking > --fail-over）
  2 = 入力が読めない / tbd_items が無い（「0 件」ではなく「未計測」。0 に丸めない）
"""

import argparse
import json
import sys

# 人間ゲート②の 1 回あたりの絞り込み閾値（SKILL.md「20 件を超えるなら blocking に絞る」）
GATE_CAPACITY_PER_ROUND = 20
# 外側ループの最大周回数（SKILL.md「最大 2 周」）
MAX_OUTER_ROUNDS = 2


def analyze(tbd_items: list, warn_over: int, fail_over: int) -> dict:
    total = len(tbd_items)
    blocking = [t for t in tbd_items if t.get("blocking")]
    n = len(blocking)
    return {
        "total_tbd": total,
        "blocking": n,
        "blocking_rate": round(n / total, 3) if total else None,
        "warn_over": warn_over,
        "fail_over": fail_over,
        "verdict": "over_capacity" if n > fail_over else "near_capacity" if n > warn_over else "ok",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Workflow 返り値の JSON ファイル（tbd_items を含むもの）")
    parser.add_argument(
        "--warn-over",
        type=int,
        default=GATE_CAPACITY_PER_ROUND,
        help="この件数を超えたら警告（既定: ゲート② 1 回の絞り込み閾値）",
    )
    parser.add_argument(
        "--fail-over",
        type=int,
        default=GATE_CAPACITY_PER_ROUND * MAX_OUTER_ROUNDS,
        help="この件数を超えたら exit 1（既定: 全周回で提示しきれる上限）",
    )
    args = parser.parse_args()

    try:
        with open(args.input, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"NG: 入力を読めない: {e}", file=sys.stderr)
        return 2

    tbd_items = data.get("tbd_items") if isinstance(data, dict) else data
    if not isinstance(tbd_items, list):
        # 欠測は 0 件と区別する。ここで 0 を返すと「計測していない」が「合格」に化ける。
        print("NG: tbd_items が見つからない（未計測。0 件ではない）", file=sys.stderr)
        return 2

    result = analyze(tbd_items, args.warn_over, args.fail_over)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result["verdict"] == "over_capacity":
        print(
            f"NG: blocking {result['blocking']} 件 > 提示容量 {args.fail_over} 件。"
            "「未提示の blocking 0 件」という完成保証に到達できない。"
            "references/traceability.md §4 の較正基準（執筆規約・欠陥を blocking の TBD に"
            "しない）で起票側を絞ること。",
            file=sys.stderr,
        )
        return 1
    if result["verdict"] == "near_capacity":
        print(
            f"WARN: blocking {result['blocking']} 件 > ゲート② 1 回の閾値 {args.warn_over} 件。"
            "絞り込み・持ち越しが発生する。",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
