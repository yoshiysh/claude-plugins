#!/usr/bin/env python3
"""スキルの .md が指すファイル参照が実在するかを検査する合否ゲート。

check_portability.py が「install 先で壊れる**書き方**」を分類する広めの検出器なのに対し、
本スクリプトは「その参照先が**今このリポジトリに存在するか**」だけを厳密に見る。
存在しない参照は書き方が正しくても壊れているため、こちらは exit 1 で落とす。

検出する参照の形:
- `[SKILL_DIR]/<path>`            … スキル自身の配下。skill_root/<path> の実在を見る。
- `[SKILL_DIR]/../<name>/<path>`  … 同一 plugin 内の兄弟スキル。install 先でも解決する
                                     のは「同じ plugin の skills/ にある」場合だけなので、
                                     その条件込みで見る。
- markdown リンク `](<相対パス>)`  … 記述ファイルからの相対。URL・アンカーは対象外。
- `.agents/skills/<x>/...`        … リポジトリ絶対パス。install 先には存在しないため、
  `.claude/skills/<x>/...`          実在していても常に壊れている扱いにする。

誤検知を避けるための除外（ゲートを無効化させないため、ここは意図的に厳しく絞る）:
- `<...>` を含むプレースホルダ（`[SKILL_DIR]/scripts/<f>` など）
- `...` を含む省略表記（`[SKILL_DIR]/...`）
- `$`・`{}` を含む変数展開
- 拡張子もスラッシュも無い断片（散文中の `[SKILL_DIR]` 単体など）
"""

import argparse
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".agents" / "skills"
PLUGINS_DIR = PROJECT_ROOT / "plugins"

EXIT_OK = 0
EXIT_BROKEN = 1
EXIT_NO_SKILL = 3

# `[SKILL_DIR]/<path>` の path 部分。空白・引用符・閉じ括弧・全角括弧で終端する。
RE_SKILL_DIR = re.compile(r"\[SKILL_DIR\]/([^\s`\"'）)\]]+)")
# markdown リンクの相対パス（`](...)`）。
RE_MD_LINK = re.compile(r"\]\(([^)\s]+)\)")
# リポジトリ絶対のスキル参照。
RE_REPO_PATH = re.compile(r"\.(?:agents|claude)/skills/([\w.\-]+)/([^\s`\"'）)\]]+)")

# プレースホルダ・省略・変数展開を含む断片は参照ではない。
PLACEHOLDER = re.compile(r"[<>${}]|\.\.\.")


def is_pathlike(s: str) -> bool:
    """ファイル/ディレクトリ参照として検査に値する形か。"""
    if not s or PLACEHOLDER.search(s):
        return False
    # 末尾の句読点を除いた上で、拡張子かスラッシュを持つものだけ対象にする。
    return "/" in s or "." in s.rstrip("/")


def clean(s: str) -> str:
    """行末の句読点・記号を落とす。"""
    return s.rstrip("。、,.:;！？!?」』)")


def owning_plugin_skills_dir(skill: str):
    """スキルが属する plugin の skills/ を返す。未登録なら None。"""
    if not PLUGINS_DIR.is_dir():
        return None
    for plugin_dir in sorted(PLUGINS_DIR.iterdir()):
        if (plugin_dir / "skills" / skill).is_dir():
            return plugin_dir / "skills"
    return None


def check_skill(skill: str) -> dict:
    skill_root = SKILLS_DIR / skill
    siblings_dir = owning_plugin_skills_dir(skill)
    findings = []

    for md in sorted(skill_root.rglob("*.md")):
        try:
            lines = md.read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        rel_file = md.relative_to(skill_root)
        for lineno, line in enumerate(lines, 1):
            for raw in RE_SKILL_DIR.findall(line):
                ref = clean(raw)
                if not is_pathlike(ref):
                    continue
                if ref.startswith("../"):
                    # 兄弟スキル参照。install 先で解決するのは同一 plugin 内だけ。
                    rest = ref[3:]
                    sib = rest.split("/", 1)[0]
                    if siblings_dir is None:
                        findings.append(_f(rel_file, lineno, ref, line,
                                           "未登録スキルからの兄弟参照（属する plugin が無い）"))
                    elif not (siblings_dir / rest).exists():
                        reason = (f"同一 plugin に '{sib}' が同梱されていない"
                                  if not (siblings_dir / sib).exists()
                                  else "参照先ファイルが無い")
                        findings.append(_f(rel_file, lineno, ref, line, reason))
                elif not (skill_root / ref).exists():
                    findings.append(_f(rel_file, lineno, ref, line, "参照先が無い"))

            for raw in RE_MD_LINK.findall(line):
                ref = raw.split("#", 1)[0]
                if (not ref or ref.startswith(("http://", "https://", "mailto:", "#", "/"))
                        or not is_pathlike(ref) or "[SKILL_DIR]" in ref):
                    continue
                if not (md.parent / ref).exists():
                    findings.append(_f(rel_file, lineno, ref, line,
                                       "markdown リンクの参照先が無い"))

            for other, rest in RE_REPO_PATH.findall(line):
                ref = clean(f".agents/skills/{other}/{rest}")
                if not is_pathlike(rest):
                    continue
                findings.append(_f(
                    rel_file, lineno, ref, line,
                    "リポジトリ絶対パス参照。install 先には存在しないため常に壊れる"
                    f"（[SKILL_DIR]/ 基準に直すか、{other} の定義を自前に持つ）"))

    return {
        "status": "ok",
        "skill": skill,
        "broken": len(findings),
        "findings": findings,
    }


def _f(rel_file, lineno, ref, line, reason) -> dict:
    return {"file": str(rel_file), "line": lineno, "ref": ref,
            "reason": reason, "context": line.strip()[:160]}


def main() -> None:
    ap = argparse.ArgumentParser(description="スキルのファイル参照が実在するか検査する")
    ap.add_argument("--skill", help="対象スキル名（未指定なら全スキル）")
    ap.add_argument("--quiet", action="store_true", help="壊れた参照だけを表示する")
    args = ap.parse_args()

    if args.skill:
        if not (SKILLS_DIR / args.skill / "SKILL.md").is_file():
            print(f"ERROR: 対象スキルが見つかりません: {SKILLS_DIR / args.skill}",
                  file=sys.stderr)
            sys.exit(EXIT_NO_SKILL)
        skills = [args.skill]
    else:
        skills = sorted(p.name for p in SKILLS_DIR.iterdir()
                        if (p / "SKILL.md").is_file())

    reports = [check_skill(s) for s in skills]
    total = sum(r["broken"] for r in reports)
    for r in reports:
        if args.quiet and not r["broken"]:
            continue
        mark = "BROKEN" if r["broken"] else "ok    "
        print(f"{mark} {r['skill']}" + (f"  ({r['broken']} 件)" if r["broken"] else ""))
        for f in r["findings"]:
            print(f"       {f['file']}:{f['line']}  {f['ref']}")
            print(f"         → {f['reason']}")
    if total:
        print(f"\n{total} 件の壊れた参照があります。", file=sys.stderr)
    sys.exit(EXIT_BROKEN if total else EXIT_OK)


if __name__ == "__main__":
    main()
