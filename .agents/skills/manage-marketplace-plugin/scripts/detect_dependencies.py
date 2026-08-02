#!/usr/bin/env python3
"""対象スキルが呼び出す「他スキルへの依存」を静的に検出する（候補出し）。

なぜ必要か:
marketplace 経由で install されると、プラグインに含まれる skills/ 配下だけが配置される。
対象スキルが別スキルをパイプライン呼び出ししている場合、その依存スキルを同梱しないと
install 先で連鎖が切れて動かない。本スクリプトは対象スキルのテキストを走査し、
`.claude/skills/` に実在する「他スキル名」への言及を依存候補として返す（推移的）。

ここは broad-net の検出に徹する（言及があれば候補に挙げる）。実際にランタイムで
呼び出す依存か、単なる案内（「代わりに X を使ってください」）かの最終判断は
dependency-resolver エージェントが行う。
"""

import argparse
import json
import re
import sys
from pathlib import Path

# .claude/skills/manage-marketplace-plugin/scripts から3つ上がリポジトリルート。
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".claude" / "skills"

# 走査対象の拡張子（テキスト系のみ）。
SCAN_GLOBS = ("*.md", "*.sh", "*.py", "*.json")


def all_skill_names() -> list:
    """SKILL.md を持つ実在スキル名の一覧。"""
    if not SKILLS_DIR.is_dir():
        return []
    return sorted(p.name for p in SKILLS_DIR.iterdir()
                  if (p / "SKILL.md").is_file())


def scan_for_mentions(skill: str, pool: list) -> dict:
    """skill のテキストから pool 内スキル名への言及を集める。

    戻り値: { dep_name: [ {file, line, text}, ... ] }
    名前はハイフンを含むため `[\\w-]` 境界で部分一致を防ぐ。
    """
    root = SKILLS_DIR / skill
    patterns = {dep: re.compile(r"(?<![\w-])" + re.escape(dep) + r"(?![\w-])")
                for dep in pool}
    hits = {}
    for glob in SCAN_GLOBS:
        for path in sorted(root.rglob(glob)):
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            for lineno, line in enumerate(lines, 1):
                for dep, pat in patterns.items():
                    if pat.search(line):
                        hits.setdefault(dep, []).append({
                            "file": str(path.relative_to(root)),
                            "line": lineno,
                            "text": line.strip()[:160],
                        })
    return hits


def main() -> None:
    ap = argparse.ArgumentParser(
        description="対象スキルの他スキル依存を静的検出する（候補出し）")
    ap.add_argument("--skill", required=True, help="検査対象スキル名")
    args = ap.parse_args()
    target = args.skill

    if not (SKILLS_DIR / target / "SKILL.md").is_file():
        print(json.dumps({"status": "error", "skill": target,
                          "error": "対象スキルの SKILL.md が見つかりません"},
                         ensure_ascii=False))
        sys.exit(3)

    names = all_skill_names()
    # 推移的探索（依存の依存もたどる）。サイクルは seen で防ぐ。
    candidates = {}     # dep -> {referenced_by, occurrences}
    seen = {target}
    queue = [target]
    while queue:
        cur = queue.pop(0)
        pool = [n for n in names if n != cur and n != target]
        for dep, occ in scan_for_mentions(cur, pool).items():
            if dep not in candidates:
                candidates[dep] = {"referenced_by": cur, "occurrences": occ}
                if dep not in seen:
                    seen.add(dep)
                    queue.append(dep)

    report = {
        "status": "ok",
        "skill": target,
        "has_candidates": bool(candidates),
        "dependency_candidates": candidates,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0)


if __name__ == "__main__":
    main()
