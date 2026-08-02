#!/usr/bin/env python3
"""既存スキルをリポジトリの marketplace.json にプラグインとして登録するスクリプト。

`plugins/<name>/` に公開用のプラグインディレクトリを作り、そこに manifest（plugin.json）と
README を生成し、plugins/<name>/skills/<name> をスキル本体（.claude/skills/<name>）への相対
シンボリックリンクにする。marketplace.json の plugins には {name, source: "./plugins/<name>"}
を非破壊で追記する。

なぜこの構成か（symlink + ルート plugin dir）:
- marketplace 経由の install では CLI が plugin dir をキャッシュにコピーする際、
  プラグイン内の symlink を「実体コピー」に解決して取り込む（検証済み）。よってスキル本体は
  .claude/skills/ の1箇所だけを正とし、複製せずに配布できる。
- スキルを <plugin>/skills/<name>/ に「ネスト」させることで、スキル内部の agents/ は
  スキル付属物として正しくスコープされ、プラグインの公開エージェントとして露出しない。
- plugin.json はルート plugin dir 側に置くため、.claude/skills/<name> は plain skill の
  ままで @skills-dir プラグインとして二重ロードされない。

設計上の不変条件:
- 非破壊: marketplace.json の既存 plugins 要素・他トップレベルキーを保持。既存 README は上書きしない。
- 冪等: 2回登録しても plugins が重複せず、symlink も二重化しない。
- 相対 symlink のみ: 絶対 symlink は使わない（クローン先で壊れるため）。
- 不在 != 破損: marketplace.json 不在は新規作成、破損 JSON は中断（自動修復しない）。
- スキル実体は複製しない: 必ず symlink で .claude/skills/<name> を参照する。
"""

import argparse
import json
import os
import sys
from pathlib import Path

# このファイルの位置を起点にパスを解決する（cwd 非依存）。
# .claude/skills/manage-marketplace-plugin/scripts から3つ上がリポジトリルート。
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent

SKILLS_DIR = PROJECT_ROOT / ".claude" / "skills"
MARKETPLACE_PATH = PROJECT_ROOT / ".claude-plugin" / "marketplace.json"
# 公開用プラグインディレクトリの置き場（ルート直下を散らかさないよう plugins/ に集約）。
PLUGINS_DIR = PROJECT_ROOT / "plugins"
# plugins/<name>/skills/ からリポジトリルートまでの相対深さ（.. を3つ）。
SKILL_LINK_TARGET_PREFIX = (os.pardir, os.pardir, os.pardir)

# marketplace.json 不在時に作る雛形（既存フォーマットに合わせる）。
DEFAULT_MARKETPLACE = {
    "name": "yoshiysh-claude-plugins",
    "description": "スキルを公開するマーケットプレイスです。",
    "owner": {"name": "yoshiysh"},
    "plugins": [],
}

# 4スペースインデント（既存 marketplace.json / plugin.json の様式に合わせる）。
INDENT = 4

EXIT_OK = 0
EXIT_CORRUPT = 2     # marketplace.json が壊れた JSON
EXIT_NO_SKILL = 3    # 対象スキルの SKILL.md が無い
EXIT_CONFLICT = 4    # 同名エントリ衝突（--update 未指定）/ 想定外の実体


def fail(exit_code: int, *lines: str) -> None:
    for line in lines:
        print(line, file=sys.stderr)
    sys.exit(exit_code)


def verify_skill_exists(name: str) -> None:
    """対象スキルの SKILL.md 実在を確認する。無ければ中断。"""
    skill_md = SKILLS_DIR / name / "SKILL.md"
    if not skill_md.is_file():
        fail(EXIT_NO_SKILL,
             f"ERROR: 対象スキルの SKILL.md が見つかりません: {skill_md}",
             "  登録対象スキルがリポジトリに実在するか確認してください。")


def load_marketplace() -> tuple[dict, bool]:
    """marketplace.json を読む。

    戻り値: (data, created_new)
    - 不在 → (雛形, True)
    - 破損 → 中断（他人のエントリを失わないため自動修復しない）
    """
    if not MARKETPLACE_PATH.exists():
        return json.loads(json.dumps(DEFAULT_MARKETPLACE)), True
    try:
        data = json.loads(MARKETPLACE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(EXIT_CORRUPT,
             "ERROR: marketplace.json が壊れた JSON です。",
             f"  path: {MARKETPLACE_PATH}",
             f"  detail: {e}",
             "  自動修復は行いません（他のプラグイン定義を失う恐れがあるため）。"
             "JSON を手動で修正してから再実行してください。")
    if not isinstance(data, dict):
        fail(EXIT_CORRUPT,
             "ERROR: marketplace.json のトップレベルがオブジェクトではありません。")
    if not isinstance(data.get("plugins"), list):
        data["plugins"] = []  # plugins キーが無い/不正なら空配列で補う（他キーは保持）
    return data, False


def merge_marketplace_entry(data: dict, name: str, update: bool) -> str:
    """plugins 配列に {name, source: "./<name>"} を非破壊・重複なしで追加する。

    戻り値: "added" | "updated"
    既存エントリがあり update=False のときは衝突として中断する。
    """
    entry = {"name": name, "source": f"./plugins/{name}"}
    plugins = data["plugins"]
    for i, p in enumerate(plugins):
        if isinstance(p, dict) and p.get("name") == name:
            if not update:
                fail(EXIT_CONFLICT,
                     f"ERROR: '{name}' は既に marketplace.json に登録済みです。",
                     "  更新する場合は --update を付けて再実行してください。")
            plugins[i] = entry  # 冪等: 内容を正規形に揃える
            return "updated"
    plugins.append(entry)
    return "added"


def write_marketplace(data: dict) -> None:
    MARKETPLACE_PATH.parent.mkdir(parents=True, exist_ok=True)
    MARKETPLACE_PATH.write_text(
        json.dumps(data, indent=INDENT, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def build_plugin_json(name: str, version: str, author: str, description: str) -> str:
    plugin = {"name": name, "version": version}
    if description:
        plugin["description"] = description
    plugin["author"] = {"name": author}
    return json.dumps(plugin, indent=INDENT, ensure_ascii=False) + "\n"


def build_readme(name: str, description: str, bundled_skills=None) -> str:
    """README の最小要件（スキル名・概要・呼び出し例・参照先）を満たす雛形。

    bundled_skills（依存として同梱した他スキル）があれば「含まれるスキル」に併記する。
    """
    desc = description or f"{name} スキルをプラグインとして公開します。"
    rows = [f"| `{name}` | {desc} |"]
    for dep in (bundled_skills or []):
        rows.append(f"| `{dep}` | {name} が依存するため同梱（連鎖呼び出し用） |")
    skills_table = "\n".join(rows)
    bundle_note = ""
    if bundled_skills:
        links = ", ".join(f"`skills/{d}`" for d in bundled_skills)
        bundle_note = (
            f"\nこのプラグインには {name} が依存する {links} も同梱されています"
            "（いずれもリポジトリ本体への相対シンボリックリンク）。\n")
    return (
        f"# {name}\n\n"
        f"{desc}\n\n"
        "## 含まれるスキル\n\n"
        "| スキル | 説明 |\n"
        "|---|---|\n"
        f"{skills_table}\n\n"
        "## 使い方\n\n"
        "プラグインを有効化したうえで、スキルを呼び出します。\n\n"
        "```\n"
        f"/{name} <依頼内容>\n"
        "```\n\n"
        f"詳細なフローは `skills/{name}/SKILL.md` を参照してください。\n\n"
        "## 構成について\n\n"
        f"このプラグインの `skills/{name}` は、リポジトリ本体の\n"
        f"`.claude/skills/{name}` への相対シンボリックリンクです。\n"
        "スキルの実体は `.claude/skills/` を唯一の正とし、公開時はリンク経由で参照します。\n"
        f"{bundle_note}"
    )


def write_plugin_files(name: str, version: str, author: str,
                       description: str, bundled_skills=None) -> dict:
    """ルート plugin dir に plugin.json を生成し、README は既存があれば保持する。

    戻り値: {"plugin_json": "created", "readme": "created"|"kept"}
    """
    plugin_dir = PLUGINS_DIR / name / ".claude-plugin"
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "plugin.json").write_text(
        build_plugin_json(name, version, author, description), encoding="utf-8")

    readme_path = PLUGINS_DIR / name / "README.md"
    if readme_path.exists():
        readme_action = "kept"  # 既存 README を上書きしない（手書き保護）
    else:
        readme_path.write_text(
            build_readme(name, description, bundled_skills), encoding="utf-8")
        readme_action = "created"
    return {"plugin_json": "created", "readme": readme_action}


def ensure_symlink(plugin_name: str, skill_name: str) -> str:
    """<plugin_name>/skills/<skill_name> → ../../../.claude/skills/<skill_name> の相対 symlink を作る。

    plugin_name と skill_name を分けるのは、依存スキルを同一プラグインに同梱
    （`<plugin_name>/skills/<dep>`）するため。本体は plugin_name == skill_name。
    冪等: 既に正しい相対 symlink ならそのまま。違う向きなら張り直す。
    戻り値: "created" | "kept" | "relinked"
    """
    skills_subdir = PLUGINS_DIR / plugin_name / "skills"
    skills_subdir.mkdir(parents=True, exist_ok=True)
    link_path = skills_subdir / skill_name
    target = os.path.join(*SKILL_LINK_TARGET_PREFIX, ".claude", "skills", skill_name)

    if link_path.is_symlink():
        if os.readlink(link_path) == target:
            return "kept"
        link_path.unlink()
        link_path.symlink_to(target)
        return "relinked"
    if link_path.exists():
        # symlink でない実体がある場合は複製を疑い、安全のため中断。
        fail(EXIT_CONFLICT,
             f"ERROR: {link_path} が symlink ではない実体として存在します。",
             "  スキル本体の複製の可能性があるため自動削除しません。手動で確認してください。")
    link_path.symlink_to(target)
    return "created"


def verify_symlink(plugin_name: str, skill_name: str) -> bool:
    """リンク経由で SKILL.md が読めるかを検証する。"""
    linked_skill_md = PLUGINS_DIR / plugin_name / "skills" / skill_name / "SKILL.md"
    return linked_skill_md.is_file()


def read_existing_version(name: str):
    """既存 plugin.json から version を読む。無ければ None。"""
    pj = PLUGINS_DIR / name / ".claude-plugin" / "plugin.json"
    if pj.is_file():
        try:
            return json.loads(pj.read_text(encoding="utf-8")).get("version")
        except (json.JSONDecodeError, OSError):
            return None
    return None


def bump_patch(version: str) -> str:
    """セマンティックバージョンの patch を +1 する。非 semver はそのまま返す。"""
    parts = version.split(".")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        parts[2] = str(int(parts[2]) + 1)
        return ".".join(parts)
    return version


def resolve_version(name: str, explicit, exists: bool):
    """登録/更新時の plugin.json version を決める。戻り値: (version, bump_note)

    - 明示指定（--version）があれば最優先（更新でも新規でも）。
    - 更新（exists=True）で未指定なら既存 version の patch を +1（既存が無ければ 0.1.0）。
    - 新規（exists=False）で未指定なら 0.1.0。

    なぜ更新時に patch を上げるか: 同じ version のまま再公開すると install 側が更新を
    検知しづらいため。minor/major を上げる判断は人間に委ね、--version で明示してもらう。
    """
    if explicit:
        return explicit, "explicit"
    if exists:
        cur = read_existing_version(name)
        if cur:
            return bump_patch(cur), f"{cur} -> patch+1"
        return "0.1.0", "default(0.1.0)"
    return "0.1.0", "default(0.1.0)"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="既存スキルを marketplace.json にプラグイン登録する")
    parser.add_argument("--skill", required=True, help="登録対象スキル名")
    parser.add_argument("--version", default=None,
                        help="plugin.json の version。未指定なら新規=0.1.0／"
                             "更新=既存 version の patch を +1")
    parser.add_argument("--author", default="yoshiysh", help="plugin.json の author 名")
    parser.add_argument("--description", default="",
                        help="プラグイン説明文（未指定時は空。input-resolver が補う想定）")
    parser.add_argument("--update", action="store_true",
                        help="同名エントリが既にある場合に更新する（既定は衝突中断）")
    parser.add_argument("--bundle-skill", action="append", default=[],
                        metavar="DEP",
                        help="依存スキルを同一プラグインに同梱する（skills/<DEP> を追加。"
                             "複数指定可）")
    parser.add_argument("--dry-run", action="store_true",
                        help="ファイルに書き込まず、行う操作のみ報告する")
    args = parser.parse_args()

    name = args.skill

    # 同梱依存スキル（重複除去・本体除外・入力順を保持）
    bundle_skills = []
    for dep in args.bundle_skill:
        if dep and dep != name and dep not in bundle_skills:
            bundle_skills.append(dep)

    # 1. 実在確認（最初に行い無駄な書き込みを防ぐ）。同梱依存も実在を要求する。
    verify_skill_exists(name)
    for dep in bundle_skills:
        verify_skill_exists(dep)

    # 2. marketplace.json 読み込み（破損中断・不在は新規）
    data, created_new = load_marketplace()
    exists = any(isinstance(p, dict) and p.get("name") == name
                 for p in data["plugins"])

    # version を解決（明示 > 更新時 patch+1 > 新規 0.1.0）
    version, version_bump = resolve_version(name, args.version, exists)

    if args.dry_run:
        if exists and not args.update:
            fail(EXIT_CONFLICT,
                 f"ERROR: '{name}' は既に登録済みです（--update が必要）。")
        report = {
            "status": "ok",
            "dry_run": True,
            "created_new": created_new,
            "marketplace_path": str(MARKETPLACE_PATH),
            "version": version,
            "version_bump": version_bump,
            "planned_actions": {
                "marketplace_entry": "updated" if exists else "added",
                "plugin_json": f"would_create (version {version})",
                "readme": "would_keep" if (PLUGINS_DIR / name / "README.md").exists()
                          else "would_create",
                "symlink": f"./plugins/{name}/skills/{name} -> ../../../.claude/skills/{name}",
                "bundled_symlinks": [
                    f"./plugins/{name}/skills/{dep} -> ../../../.claude/skills/{dep}"
                    for dep in bundle_skills
                ],
            },
            "bundled_skills": bundle_skills,
            "next_action":
                f"/plugin install {name}@{data.get('name', 'yoshiysh-claude-plugins')} "
                "でインストールして動作確認できます。",
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(EXIT_OK)

    # 3. marketplace.json へ非破壊マージ（衝突は exit 4）
    entry_action = merge_marketplace_entry(data, name, update=args.update)
    write_marketplace(data)

    # 4-5. plugin.json / README 生成・相対 symlink 作成（本体）
    file_actions = write_plugin_files(name, version, args.author,
                                      args.description, bundle_skills)
    symlink_action = ensure_symlink(name, name)

    # 4-5b. 依存スキルを同一プラグインに同梱（skills/<dep> の追加 symlink）
    bundled = []
    for dep in bundle_skills:
        dep_action = ensure_symlink(name, dep)
        bundled.append({"skill": dep, "symlink": dep_action,
                        "ok": verify_symlink(name, dep)})

    # 6. symlink 検証（本体＋同梱すべて）
    symlink_ok = verify_symlink(name, name) and all(b["ok"] for b in bundled)

    report = {
        "status": "ok",
        "dry_run": False,
        "created_new": created_new,
        "marketplace_path": str(MARKETPLACE_PATH),
        "version": version,
        "version_bump": version_bump,
        "actions": {
            "marketplace_entry": entry_action,
            "plugin_json": file_actions["plugin_json"],
            "readme": file_actions["readme"],
            "symlink": symlink_action,
        },
        "bundled_skills": bundled,
        "symlink_ok": symlink_ok,
        "next_action":
            f"/plugin install {name}@{data.get('name', 'yoshiysh-claude-plugins')} "
            "でインストールして動作確認できます。",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(EXIT_OK if symlink_ok else EXIT_NO_SKILL)


if __name__ == "__main__":
    main()
