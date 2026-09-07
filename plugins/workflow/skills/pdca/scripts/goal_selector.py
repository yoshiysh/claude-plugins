#!/usr/bin/env python3
"""goal-selector: telemetry 在庫から改善候補を選別する（kaizen 手順 1〈観測〉の自動化）。

候補は生成しない — 在庫（skill_telemetry.py が記録した実測 JSON）に対する固定の規則表の
述語評価だけで立ち上がる。在庫に trace できない候補はこのスクリプトからは出ない。
書き出し先は内部キュー（~/.claude/skill-kaizen/goals/）で、GitHub Issue も Git も使わない。
承認・却下は同じファイルへの status 遷移として記録する（依頼者裁定）。

== 適合監査の成文基準（監査者はこの節と実出力を照合する）==
C1 決定性: 同一在庫で 2 回実行した select の出力ディレクトリは byte 同一
    （select はタイムスタンプを書かない。decided_at は decide だけが書く）。
C2 形式契約: 各候補ファイルは {id, skill, rule, statement, trace, score, status} を持ち、
    生成直後の status は "pending"。statement は
    「<skill> の run で <symptom>（<field> 該当 <hit>/<present> run）」の形で、解決策を含まない。
C3 trace 解決: trace.runs の各ラベルと trace.field は在庫に実在する。
C4 在庫応答性: 在庫に run を足し引きすると、hit/present が RULES の述語どおりに変わる。
C5 score 再計算: score.value == impact * frequency / cost、
    frequency == round_half_up(1 + 4 * hit / present)（impact/cost は IMPACT_COST の凍結値）。
C6 裁定一周: decide が status / decided_at / reason を同ファイルへ記録し、pending が残らない。

規則表の粒度と impact/cost の値は既定値（調整は要求変更にあたらない）。述語は在庫の
指標だけを見る絶対条件で書く（在庫相対の述語は leave-one-out で hit 集合が不安定になり、
新規在庫の追加が既存候補の意味を変えてしまう — plan-verifier の反証で実測済み）。
"""

import argparse
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

PURPOSE_REF = "文書生成の崩れ方を、書き手の注意ではなく構造で止める"

# 規則表: field を見る述語と症状文。述語は「問題の徴候」だけを書く（dry_stop=true のような
# 成功状態は候補にしない）。impact / cost は 1-5 の凍結既定値で、根拠を各行に残す。
RULES = [
    {"id": "R1", "field": "verdict", "symptom": "改稿上限に到達して収束しないまま run が終わる",
     "pred": lambda v: v == "revision_backstop_reached",
     "impact": 5, "impact_why": "収束はループ設計の主目的そのもの",
     "cost": 3, "cost_why": "機序特定に対照 run が要る"},
    {"id": "R2", "field": "unpresented_blocking_count", "symptom": "未提示の blocking な未確定事項を残したまま run が終わる",
     "pred": lambda v: isinstance(v, int) and v >= 1,
     "impact": 4, "impact_why": "人間ゲートに届かない裁定待ちは完成条件を壊す",
     "cost": 2, "cost_why": "提示経路の修正で足りることが多い"},
    {"id": "R3", "field": "fabrication_findings", "symptom": "入力に無い内容の混入が検出される",
     "pred": lambda v: isinstance(v, int) and v >= 1,
     "impact": 5, "impact_why": "捏造は成果物の信頼の根を壊す",
     "cost": 3, "cost_why": "権限・経路の設計変更に及ぶ"},
    {"id": "R5", "field": "novelty_history", "symptom": "新規性が下がりきらないまま run が終わる",
     "pred": lambda v: isinstance(v, list) and len(v) > 0 and isinstance(v[-1], (int, float)) and v[-1] > 0,
     "impact": 3, "impact_why": "非収束の徴候だが R1 より弱い早期信号",
     "cost": 2, "cost_why": "判定器の調整で動くことが実証済み"},
    {"id": "R6", "field": "revisions_used", "symptom": "改稿予算（backstop 3）を使い切る",
     "pred": lambda v: isinstance(v, int) and v >= 4,
     "impact": 3, "impact_why": "予算消費はコスト超過の直接指標",
     "cost": 2, "cost_why": "収束改善に相乗りできる"},
    {"id": "R7", "field": "adjudicated", "symptom": "指摘が 1 件も fixed に至らず rejected か documented に流れる",
     "pred": lambda v: isinstance(v, dict) and v.get("fixed") == 0
     and (v.get("rejected", 0) or 0) + (v.get("documented", 0) or 0) >= 1,
     "impact": 3, "impact_why": "直されない指摘の在庫化は品質負債",
     "cost": 3, "cost_why": "裁定基準の見直しは影響範囲が広い"},
    {"id": "R8", "field": "verdict", "symptom": "未確定事項を残して終わる",
     "pred": lambda v: v == "tbd_remaining",
     "impact": 2, "impact_why": "TBD 残しは設計上の正常経路でもある",
     "cost": 2, "cost_why": "review 1 周で解消できる"},
    {"id": "R9", "field": "audit_incomplete", "symptom": "監査が未完のまま run が終わる",
     "pred": lambda v: v is True,
     "impact": 4, "impact_why": "未検査を合格と読み違える入口になる",
     "cost": 2, "cost_why": "リトライ・欠測表示の修正が中心"},
    {"id": "R10", "field": "writer_missing", "symptom": "writer 出力に欠落がある",
     "pred": lambda v: isinstance(v, int) and v >= 1,
     "impact": 4, "impact_why": "一度も直されていない指摘が残る",
     "cost": 2, "cost_why": "再試行経路の追加で足りる"},
]


def round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def telemetry_dir() -> Path:
    return Path(os.environ.get("SKILL_TELEMETRY_DIR", Path.home() / ".claude" / "skill-telemetry"))


def goals_dir() -> Path:
    return Path(os.environ.get("SKILL_KAIZEN_DIR", Path.home() / ".claude" / "skill-kaizen")) / "goals"


def load_inventory(skill: str) -> dict:
    src = telemetry_dir() / skill
    runs = {}
    if src.is_dir():
        for p in sorted(src.glob("*.json")):
            if p.name == "summary.json":
                continue
            try:
                runs[p.stem] = json.loads(p.read_text())
            except (json.JSONDecodeError, OSError):
                continue  # 壊れた記録は在庫に数えない（hit でも present でもない）
    return runs


def select(skill: str) -> list:
    """在庫の決定的な関数として候補を返す。欠測（field が None / 不在）の run は
    当該規則の present に数えない — 欠測を非 hit（分母入り）にすると hit 率が薄まり、
    「測っていない」が「起きていない」に化ける。"""
    runs = load_inventory(skill)
    goals = []
    for rule in RULES:
        present, hits = [], []
        for label in sorted(runs):
            value = runs[label].get(rule["field"])
            if value is None:
                continue
            present.append(label)
            try:
                if rule["pred"](value):
                    hits.append(label)
            except (TypeError, AttributeError):
                continue  # 型が契約外の値は判定不能として present から外さない（保守的に非 hit）
        if not hits:
            continue  # 徴候の実測が無い規則は候補を出さない（発明しない）
        frequency = round_half_up(1 + 4 * len(hits) / len(present))
        goals.append({
            "id": f"{skill}-{rule['id']}",
            "skill": skill,
            "rule": rule["id"],
            "statement": (
                f"{skill} の run で{rule['symptom']}"
                f"（{rule['field']} 該当 {len(hits)}/{len(present)} run）"
            ),
            "trace": {"runs": hits, "present_runs": present, "field": rule["field"],
                      "purpose_ref": PURPOSE_REF},
            "score": {"impact": rule["impact"], "impact_why": rule["impact_why"],
                      "frequency": frequency, "cost": rule["cost"], "cost_why": rule["cost_why"],
                      "value": round(rule["impact"] * frequency / rule["cost"], 2)},
            "status": "pending",
        })
    goals.sort(key=lambda g: (-g["score"]["value"], g["id"]))
    return goals


def cmd_select(args) -> int:
    out = goals_dir()
    out.mkdir(parents=True, exist_ok=True)
    goals = select(args.skill)
    for g in goals:
        dest = out / f"{g['id']}.json"
        if dest.exists():
            prev = json.loads(dest.read_text())
            if prev.get("status") != "pending":
                continue  # 裁定済みの候補は上書きしない（拒否履歴を消さない）
        dest.write_text(json.dumps(g, ensure_ascii=False, indent=1))
    for g in goals:
        s = g["score"]
        print(f"{g['id']:16} score={s['value']:5} (I{s['impact']}×F{s['frequency']}÷C{s['cost']}) "
              f"[{g['status']}] {g['statement']}")
    if not goals:
        print("候補なし（在庫に徴候の実測が無い）")
    return 0


def cmd_decide(args) -> int:
    dest = goals_dir() / f"{args.goal}.json"
    if not dest.exists():
        raise SystemExit(f"候補がありません: {dest}")
    g = json.loads(dest.read_text())
    g["status"] = args.status
    g["decided_at"] = datetime.now(timezone.utc).isoformat()
    g["reason"] = args.reason
    dest.write_text(json.dumps(g, ensure_ascii=False, indent=1))
    print(f"{args.goal} -> {args.status}")
    return 0


def cmd_list(args) -> int:
    out = goals_dir()
    files = sorted(out.glob("*.json")) if out.is_dir() else []
    if not files:
        print("キューは空です")
        return 0
    for p in files:
        g = json.loads(p.read_text())
        print(f"{g['id']:16} [{g['status']:9}] score={g['score']['value']:5} {g['statement']}"
              + (f"  // {g.get('reason', '')}" if g.get("status") not in (None, "pending") else ""))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    se = sub.add_parser("select", help="在庫から候補を選別して pending としてキューへ書く")
    se.add_argument("--skill", required=True)
    se.set_defaults(fn=cmd_select)
    de = sub.add_parser("decide", help="候補の裁定を記録する（status 遷移）")
    de.add_argument("--goal", required=True)
    de.add_argument("--status", required=True, choices=["approved", "rejected", "done", "superseded"])
    de.add_argument("--reason", required=True)
    de.set_defaults(fn=cmd_decide)
    li = sub.add_parser("list", help="キューの全候補と status を表示する")
    li.set_defaults(fn=cmd_list)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
