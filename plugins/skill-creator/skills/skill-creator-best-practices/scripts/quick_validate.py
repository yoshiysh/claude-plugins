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

    # scripts/ 配下の workflow script（`export const meta` で始まる .js）を検査する。
    # 構文と「起動前に落ちる書き方」は静的に判定できるので、ここで潰しておく。
    for js in sorted((path / "scripts").glob("*.js")) if (path / "scripts").is_dir() else []:
        errors.extend(validate_workflow_script(js))

    _print_result(errors, warnings, verbose, has_agents=agents_dir.exists())
    return len(errors) == 0


# workflow script に書くとランタイムが起動前に落ちる / resume が壊れる構文。
# 出典: references/best-practices.md §13「実行時制約」。
_FORBIDDEN = [
    (re.compile(r"\bimport\s*\("), "import() を含む script は起動前に失敗する"),
    (re.compile(r"\bDate\.now\s*\("), "Date.now() は throw する（resume を壊すため）"),
    (re.compile(r"\bMath\.random\s*\("), "Math.random() は throw する（resume を壊すため）"),
    (re.compile(r"\bnew\s+Date\s*\(\s*\)"), "引数なし new Date() は throw する"),
]


def validate_workflow_script(js_path: Path) -> list:
    """workflow script を静的検査する。workflow script でなければ何も見ない。

    ランタイムは script 本体を async 関数として実行するため、top-level の `await` と
    `return` が使える。素の ESM として `node --check` に掛けると `return` で落ちるので、
    同じ形（async 関数で包み、関数内に置けない `export` を外す）にしてから検査する。
    """
    import shutil
    import subprocess
    import tempfile

    src = js_path.read_text(encoding="utf-8")
    if not re.match(r"^\s*export\s+const\s+meta\s*=", src):
        return []  # workflow script ではない（通常のヘルパー .js）

    errors = []
    rel = f"scripts/{js_path.name}"

    # meta は純粋なリテラルでなければならない。中身に変数展開・関数呼び出し・スプレッドが
    # 入っていると承認ダイアログの表示前に評価できず落ちる。
    m = re.search(r"export\s+const\s+meta\s*=\s*\{(.*?)\n\}", src, re.S)
    if not m:
        errors.append(f"{rel}: export const meta = {{...}} を読み取れません")
    else:
        meta_body = m.group(1)
        for key in ("name", "description"):
            if not re.search(rf"\b{key}\s*:", meta_body):
                errors.append(f"{rel}: meta に {key} がありません")
        if "..." in meta_body or "`" in meta_body:
            errors.append(f"{rel}: meta は純粋なリテラルにする（スプレッド・テンプレート展開が入っている）")
        # phase() のタイトルは meta.phases[].title と一致していないと進捗表示が割れる。
        declared = set(re.findall(r"title:\s*['\"]([^'\"]+)['\"]", meta_body))
        used = set(re.findall(r"\bphase\(\s*['\"]([^'\"]+)['\"]\s*\)", src))
        for t in sorted(used - declared):
            errors.append(f"{rel}: phase('{t}') に対応する meta.phases のエントリがありません")

    for pattern, why in _FORBIDDEN:
        if pattern.search(src):
            errors.append(f"{rel}: {why}")

    if not shutil.which("node"):
        return errors  # node が無い環境では構文検査だけ飛ばす（他の検査は済んでいる）

    body = re.sub(r"^\s*export\s+const\s+meta\s*=", "const meta =", src, count=1, flags=re.M)
    with tempfile.TemporaryDirectory() as d:
        wrapped = Path(d) / "check.mjs"
        wrapped.write_text(f"async function __check() {{\n{body}\n}}\n", encoding="utf-8")
        r = subprocess.run(["node", "--check", str(wrapped)], capture_output=True, text=True)
        if r.returncode != 0:
            detail = (r.stderr or r.stdout).strip().splitlines()
            errors.append(f"{rel}: 構文エラー — {detail[3] if len(detail) > 3 else detail[:1]}")
    return errors


# このスクリプトが原理的に判定できない項目。「✅ 通過」を全項目の合格と読ませないために、
# 何を見ていないかを毎回明示する。適否がスキルの機能（何を生み出し誰が使うか）に依存する
# 項目は、機械判定にすると代理指標ゲートになる（best-practices.md §12）ため、ここでは
# 判定せず設計レビューへ送る。
_UNCHECKED = [
    "生成物を、それを生成した agent 以外が検証する経路があるか"
    "（状態変更・下流で行動の根拠になる出力を持つスキルに適用。agents/ の有無では判定しない）",
    "その検証が状態変更の前に置かれているか",
    "description が実際に狙ったリクエストで発火するか（evals での実測が必要）",
    "参照ファイルの内容が SKILL.md の記述と整合しているか",
]


def _print_result(errors: list, warnings: list, verbose: bool, has_agents: bool = False):
    if errors:
        print("❌ バリデーション失敗")
        for e in errors:
            print(f"  ERROR: {e}")
    else:
        print("✅ バリデーション通過（機械検査のみ）")

    if warnings and verbose:
        for w in warnings:
            print(f"  WARN:  {w}")
    elif warnings:
        print(f"  ⚠️  {len(warnings)} 件の警告があります（--verbose で詳細表示）")

    if verbose:
        print("  ── このスクリプトが見ていない項目（設計レビューで確認する）")
        for item in _UNCHECKED:
            print(f"  SKIP:  {item}")
        if not has_agents:
            print("  SKIP:  agents/ が無いため agent 関連の検査を実行していない"
                  "（無いこと自体が欠落でありうる。上記 1 件目を参照）")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="SKILL.md の基本バリデーション")
    parser.add_argument("skill_dir", help="スキルディレクトリのパス")
    parser.add_argument("--verbose", "-v", action="store_true", help="警告の詳細を表示")
    args = parser.parse_args()

    ok = validate_skill(args.skill_dir, args.verbose)
    sys.exit(0 if ok else 1)
