#!/usr/bin/env python3
"""
SKILL.md の基本バリデーション。
スキル公開前のチェックに使う。

使い方:
  python scripts/quick_validate.py .claude/skills/[スキル名]
  python scripts/quick_validate.py .claude/skills/[スキル名] --verbose
"""

import sys
import re
from pathlib import Path


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """SKILL.md のフロントマターをパースする。"""
    if not content.startswith("---"):
        return {}, content

    end = content.find("---", 3)
    if end == -1:
        return {}, content

    frontmatter_text = content[3:end].strip()
    body = content[end + 3:].strip()

    fields = {}
    current_key = None
    current_value_lines = []

    for line in frontmatter_text.splitlines():
        if line.startswith(" ") or line.startswith("\t"):
            if current_key:
                current_value_lines.append(line.strip())
        elif ": " in line or line.endswith(":"):
            if current_key and current_value_lines:
                fields[current_key] = " ".join(current_value_lines)
            key, _, val = line.partition(": ")
            current_key = key.strip()
            val = val.strip().lstrip(">").strip()
            current_value_lines = [val] if val else []
        elif line.strip() == "" and current_key:
            continue

    if current_key and current_value_lines:
        fields[current_key] = " ".join(current_value_lines)

    return fields, body


def validate_skill(skill_dir: str, verbose: bool = False) -> bool:
    path = Path(skill_dir)
    errors = []
    warnings = []

    # SKILL.md の存在確認
    skill_md = path / "SKILL.md"
    if not skill_md.exists():
        errors.append("SKILL.md が存在しません")
        _print_result(errors, warnings, verbose)
        return False

    content = skill_md.read_text(encoding="utf-8")
    fields, body = parse_frontmatter(content)

    # name フィールド
    if "name" not in fields or not fields["name"]:
        errors.append("frontmatter に name フィールドがありません")
    else:
        name = fields["name"]
        if len(name) > 64:
            errors.append(f"name が64文字を超えています（{len(name)}文字）: {name}")
        if not re.match(r"^[a-z0-9-]+$", name):
            errors.append(f"name に使用できない文字が含まれています（英小文字・数字・ハイフンのみ）: {name}")
        if "anthropic" in name or "claude" in name:
            errors.append(f"name に予約語（anthropic / claude）が含まれています: {name}")
        if "<" in name or ">" in name:
            errors.append(f"name に XML タグが含まれています: {name}")
        if verbose and not re.match(r"^[a-z]+-", name):
            warnings.append(f"name は gerund 形式（processing-pdfs など）を推奨します: {name}")

    # description フィールド
    if "description" not in fields or not fields["description"]:
        errors.append("frontmatter に description フィールドがありません")
    else:
        desc = fields["description"]
        if len(desc) > 1024:
            errors.append(f"description が1024文字を超えています（{len(desc)}文字）")
        if "<" in desc or ">" in desc:
            errors.append("description に XML タグが含まれています")
        if re.search(r"\bI\b|\bI'm\b|私は", desc):
            warnings.append("description が1人称になっています。3人称（Processes... など）で書いてください")
        if "?" not in desc and "Use when" not in desc and "use" not in desc.lower():
            warnings.append("description に [When]（いつ使うか）が含まれていない可能性があります")

    # SKILL.md の行数
    line_count = len(content.splitlines())
    if line_count > 500:
        warnings.append(f"SKILL.md が500行を超えています（{line_count}行）。references/ への分割を検討してください")

    # agents/ のフロントマター確認
    agents_dir = path / "agents"
    if agents_dir.exists():
        for agent_file in agents_dir.glob("*.md"):
            agent_content = agent_file.read_text(encoding="utf-8")
            if not agent_content.startswith("---"):
                warnings.append(f"agents/{agent_file.name} にフロントマターがありません（model: の指定を推奨）")
            else:
                agent_fields, _ = parse_frontmatter(agent_content)
                if "model" not in agent_fields:
                    warnings.append(f"agents/{agent_file.name} に model: フィールドがありません")

    _print_result(errors, warnings, verbose)
    return len(errors) == 0


def _print_result(errors: list, warnings: list, verbose: bool):
    if errors:
        print("❌ バリデーション失敗")
        for e in errors:
            print(f"  ERROR: {e}")
    else:
        print("✅ バリデーション通過")

    if warnings and verbose:
        for w in warnings:
            print(f"  WARN:  {w}")
    elif warnings:
        print(f"  ⚠️  {len(warnings)} 件の警告があります（--verbose で詳細表示）")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="SKILL.md の基本バリデーション")
    parser.add_argument("skill_dir", help="スキルディレクトリのパス")
    parser.add_argument("--verbose", "-v", action="store_true", help="警告の詳細を表示")
    args = parser.parse_args()

    ok = validate_skill(args.skill_dir, args.verbose)
    sys.exit(0 if ok else 1)
