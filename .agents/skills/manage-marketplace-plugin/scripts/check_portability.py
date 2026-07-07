#!/usr/bin/env python3
"""登録対象スキルが「install 先で壊れる参照」を持っていないか静的スキャンする検出器。

marketplace 経由で install されると、プラグインは <plugin>/skills/<name>/ 配下だけが
キャッシュにコピーされる。そのため「スキルディレクトリの外」を指す参照は install 先で
解決できず壊れる。本スクリプトはそれらを検出して分類するだけで、修正はしない
（修正は portability-checker エージェントがユーザー確認のうえ行う）。

検出種別:
- self_hardcode      : 自己参照のリポジトリ固定パス（.claude/skills/<name>/...）。
                       → [SKILL_DIR]/ 基準へ直すべき（symlink 不要）。
- external_script    : スキル外の自己完結スクリプト参照（リポジトリ直下 /scripts/foo.sh 等）。
                       → スキル内 scripts/ への symlink で同梱可能（bundleable）。
- env_build          : 専用 CLI、外部認証、ビルド手順などのローカル環境依存。symlink では運べない（配布不可の警告）。
- script_internal_dep: スキル内スクリプト（.sh/.py）が内部で別スクリプトを cwd 相対で呼ぶ。
                       → 自分の場所基準（$(dirname "$0") / Path(__file__).parent）へ。共有
                         スクリプトの場合は本体編集になるため自動修正せず警告に留める。
- other_external     : ../ でスキル外へ出る / 絶対パス / .claude/rules や他スキル参照など。

判定はあくまで候補出し（broad net）。記述的な言及か実行コマンドかの最終判断は
エージェント側に委ねる。
"""

import argparse
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".claude" / "skills"

# .claude/skills/<name>/scripts/ から リポジトリ直下 /scripts/ までの相対深さ。
ROOT_SCRIPTS_REL = "../../../../scripts"

EXIT_OK = 0
EXIT_NO_SKILL = 3


def scan_text_files(skill_root: Path):
    """スキル配下の .md ファイルを行単位で走査する（scripts 実体や評価データは除外）。"""
    for path in sorted(skill_root.rglob("*.md")):
        rel = path.relative_to(skill_root)
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            continue
        for i, line in enumerate(lines, 1):
            yield str(rel), i, line


def scan_script_files(skill_root: Path):
    """スキル配下のスクリプト本体（.sh / .py）を行単位で走査する。

    symlink（共有 root スクリプトへのリンク）もリンク先の中身を読む。スクリプトが
    内部できょうだいスクリプトを cwd 相対で呼んでいないか（install 先で壊れる）を見る。
    """
    seen = set()
    for pattern in ("*.sh", "*.py"):
        for path in sorted(skill_root.rglob(pattern)):
            if not path.is_file():  # 壊れた symlink 等はスキップ
                continue
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            rel = path.relative_to(skill_root)
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except (UnicodeDecodeError, OSError):
                continue
            for i, line in enumerate(lines, 1):
                yield str(rel), i, line


def detect(name: str) -> dict:
    skill_root = SKILLS_DIR / name
    findings = []

    # 種別判定用の正規表現
    # self_hardcode: 自分の固定パス配下の「サブパス」を指す参照のみ（ファイル構成の
    # ディレクトリ見出し `.claude/skills/<name>/` 単体は誤検出しないようサブパス必須）。
    re_self = re.compile(r"\.claude/skills/" + re.escape(name) + r"/[\w.\-]")
    # bare scripts/foo.(sh|py)（[SKILL_DIR]/ や <skill>/ で前置されていないもの）
    re_script = re.compile(r"(?<![\w./\]])scripts/([\w.\-]+\.(?:sh|py))")
    re_env = re.compile(r"(/usr/bin/make\b|\bmake\s+[a-z][\w-]*)")
    # other_external: 絶対パス・ルールファイル等。`../` 単体は symlink 設計で正当に
    # 使うため除外（ノイズ回避）。
    re_other = re.compile(r"(/Users/|\.claude/rules/)")

    for rel, lineno, line in scan_text_files(skill_root):
        # self_hardcode
        if re_self.search(line):
            findings.append({
                "type": "self_hardcode", "file": rel, "line": lineno,
                "match": line.strip()[:160],
                "remediation": "参照を [SKILL_DIR]/... に書き換える（symlink 不要）",
            })
        # external_script（[SKILL_DIR]/scripts は除外）
        for m in re_script.finditer(line):
            if "[SKILL_DIR]/scripts/" in line:
                continue
            fname = m.group(1)
            root_script = PROJECT_ROOT / "scripts" / fname
            skill_link = skill_root / "scripts" / fname
            already_bundled = skill_link.exists()
            if already_bundled:
                remediation = (
                    f"既にスキル内 scripts/{fname} に存在（同梱済み）。"
                    f"参照を [SKILL_DIR]/scripts/{fname} に直すだけ（symlink 不要）"
                )
            elif root_script.is_file():
                remediation = (
                    f"スキル内に symlink を貼って同梱: "
                    f".claude/skills/{name}/scripts/{fname} -> {ROOT_SCRIPTS_REL}/{fname} "
                    f"＋参照を [SKILL_DIR]/scripts/{fname} に変更"
                )
            else:
                remediation = "参照先スクリプトが /scripts/ にもスキル内にも無い。手動確認が必要"
            findings.append({
                "type": "external_script", "file": rel, "line": lineno,
                "match": line.strip()[:160],
                "script": fname,
                "exists_at_root": root_script.is_file(),
                "already_bundled": already_bundled,
                "remediation": remediation,
            })
        # env_build
        if re_env.search(line):
            findings.append({
                "type": "env_build", "file": rel, "line": lineno,
                "match": line.strip()[:160],
                "remediation": "ローカル環境依存。symlink では運べない。配布可否を要判断",
            })
        # other_external
        if re_other.search(line):
            findings.append({
                "type": "other_external", "file": rel, "line": lineno,
                "match": line.strip()[:160],
                "remediation": "スキル外参照の可能性。記述的言及か実依存かを要判断",
            })

    # スクリプト本体（.sh / .py）の内部依存スキャン
    # 自分基準にアンカーされていない cwd 相対のきょうだい参照（`scripts/foo.sh` 等）を検出。
    # 修正済みの形（sh の $(dirname "$0")/foo / py の Path(__file__).parent）は
    # `scripts/` を含まないためマッチしない。
    # 誤検出回避：コメント行・自分自身への参照（usage 例の多くが該当）はスキップ。
    re_internal = re.compile(r"(?<![\w./\]])scripts/([\w.\-]+\.(?:sh|py))")
    for rel, lineno, line in scan_script_files(skill_root):
        own = Path(rel).name
        for m in re_internal.finditer(line):
            if line[:m.start()].lstrip().startswith("#"):
                continue  # コメント行
            if m.group(1) == own:
                continue  # 自分自身の usage 例など
            findings.append({
                "type": "script_internal_dep", "file": rel, "line": lineno,
                "match": line.strip()[:160],
                "script": m.group(1),
                "remediation": (
                    "スクリプト内部の cwd 相対参照。install 先（cwd≠repoルート）で壊れる。"
                    "自分の場所基準に直す（sh: \"$(dirname \"$0\")/<f>\" / "
                    "py: Path(__file__).parent / \"<f>\"）。共有スクリプトの場合は本体編集に"
                    "なるため後方互換に注意（自動修正はしない）"
                ),
            })
            break  # 1行1件で十分

    by_type = {}
    for f in findings:
        by_type[f["type"]] = by_type.get(f["type"], 0) + 1

    # 配布をブロックし得る重大種別
    blockers = by_type.get("self_hardcode", 0) + by_type.get("external_script", 0) \
        + by_type.get("env_build", 0) + by_type.get("script_internal_dep", 0)

    return {
        "status": "ok",
        "skill": name,
        "summary": by_type,
        "has_blockers": blockers > 0,
        "findings": findings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="登録対象スキルの配布 portability を静的スキャンする")
    parser.add_argument("--skill", required=True, help="対象スキル名")
    args = parser.parse_args()

    skill_md = SKILLS_DIR / args.skill / "SKILL.md"
    if not skill_md.is_file():
        print(f"ERROR: 対象スキルが見つかりません: {skill_md}", file=sys.stderr)
        sys.exit(EXIT_NO_SKILL)

    report = detect(args.skill)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
