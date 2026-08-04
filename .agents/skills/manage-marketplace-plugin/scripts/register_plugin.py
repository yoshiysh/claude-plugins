#!/usr/bin/env python3
"""既存スキルをリポジトリの marketplace.json にプラグインとして登録するスクリプト。

`plugins/<plugin>/` に公開用のプラグインディレクトリを作り、そこに manifest（plugin.json）と
README を生成し、plugins/<plugin>/skills/<公開名> をスキル本体（.claude/skills/<skill>）への
相対シンボリックリンクにする。marketplace.json の plugins には
{name, source: "./plugins/<plugin>"} を非破壊で追記する。

plugin はカテゴリ単位で複数スキルを収録できる（例: plugins/git/skills/{commit,pr-create}）。
- `--plugin` で対象 plugin を指定する（未指定ならスキル名と同名の plugin）。
- skills/ 配下のエントリ名（symlink 名）は**スキル実体ディレクトリ名**を既定とする。
  公開名（/plugin:skill の skill 部分）は frontmatter の `name` が担うため、symlink 名を
  変える必要はない。むしろ install 先のキャッシュは symlink 名でディレクトリが作られるため、
  `[SKILL_DIR]/../<兄弟スキル>/` のようなディレクトリ名参照を持つスキルは symlink 名を
  実体名から変えると install 先で参照が切れる。`--as` は例外的な明示上書き用。

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
  既存 plugin への追加登録時は、既にある skills/ 配下の他スキル symlink を保持する。
- 冪等: 2回登録しても plugins が重複せず、symlink も二重化しない。
- 相対 symlink のみ: 絶対 symlink は使わない（クローン先で壊れるため）。
- 不在 != 破損: marketplace.json 不在は新規作成、破損 JSON は中断（自動修復しない）。
- スキル実体は複製しない: 必ず symlink で .claude/skills/<skill> を参照する。
"""

import argparse
import json
import os
import re
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
# plugins/<plugin>/skills/ からリポジトリルートまでの相対深さ（.. を3つ）。
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


def frontmatter_name(skill: str) -> str:
    """SKILL.md frontmatter の name を読む。取れなければスキルディレクトリ名を返す。

    公開名（skills/ 配下のエントリ名）の既定値。frontmatter の name が
    ディレクトリ名より優先される公式仕様に合わせ、公開名も name に揃える。
    """
    skill_md = SKILLS_DIR / skill / "SKILL.md"
    try:
        text = skill_md.read_text(encoding="utf-8")
    except OSError:
        return skill
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return skill
    nm = re.search(r"^name:\s*(\S+)\s*$", m.group(1), re.MULTILINE)
    return nm.group(1) if nm else skill


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


def merge_marketplace_entry(data: dict, plugin: str, update: bool) -> str:
    """plugins 配列に {name, source: "./plugins/<plugin>"} を非破壊・重複なしで追加する。

    戻り値: "added" | "updated"
    既存エントリがあり update=False のときは衝突として中断する。
    """
    entry = {"name": plugin, "source": f"./plugins/{plugin}"}
    plugins = data["plugins"]
    for i, p in enumerate(plugins):
        if isinstance(p, dict) and p.get("name") == plugin:
            if not update:
                fail(EXIT_CONFLICT,
                     f"ERROR: plugin '{plugin}' は既に marketplace.json に登録済みです。",
                     "  更新（スキル追加を含む）の場合は --update を付けて再実行してください。")
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


def build_plugin_json(plugin: str, version: str, author: str, description: str) -> str:
    data = {"name": plugin, "version": version}
    if description:
        data["description"] = description
    data["author"] = {"name": author}
    return json.dumps(data, indent=INDENT, ensure_ascii=False) + "\n"


def build_readme(plugin: str, public_name: str, skill: str,
                 description: str, bundled_skills=None) -> str:
    """README の最小要件（スキル名・概要・呼び出し例・参照先）を満たす雛形。

    bundled_skills（依存として同梱した他スキル）があれば「収録スキル」に併記する。
    既存 README がある場合は呼ばれない（上書きしない）。
    """
    desc = description or f"{public_name} スキルをプラグインとして公開します。"
    rows = [f"| `{public_name}` | `/{plugin}:{public_name}` | {desc} |"]
    for dep in (bundled_skills or []):
        dep_public = frontmatter_name(dep)
        rows.append(f"| `{dep_public}` | `/{plugin}:{dep_public}` | "
                    f"{public_name} が依存するため同梱（連鎖呼び出し用） |")
    skills_table = "\n".join(rows)
    entity_note = ""
    if public_name != skill:
        entity_note = (
            f"スキル実体はディレクトリ名（`{skill}`）のまま、"
            f"frontmatter の `name`（`{public_name}`）で公開されます。\n")
    return (
        f"# {plugin}\n\n"
        f"{desc}\n\n"
        "## 収録スキル\n\n"
        "| スキル | 呼び出し | 説明 |\n"
        "|---|---|---|\n"
        f"{skills_table}\n\n"
        "## 使い方\n\n"
        "```\n"
        f"/{plugin}:{public_name} <依頼内容>\n"
        "```\n\n"
        f"詳細なフローは `skills/{skill}/SKILL.md` を参照してください。\n\n"
        "## 構成\n\n"
        "このプラグインの `skills/` 配下は、リポジトリ本体の\n"
        "`.claude/skills/` への相対シンボリックリンクです。\n"
        f"{entity_note}"
    )


def write_plugin_files(plugin: str, public_name: str, skill: str, version: str,
                       author: str, description: str, bundled_skills=None) -> dict:
    """ルート plugin dir に plugin.json を生成し、README は既存があれば保持する。

    戻り値: {"plugin_json": "created", "readme": "created"|"kept"}
    """
    plugin_dir = PLUGINS_DIR / plugin / ".claude-plugin"
    plugin_dir.mkdir(parents=True, exist_ok=True)
    # 既存カテゴリ plugin への追加登録で description 未指定のとき、
    # 既存 plugin.json の description（plugin 全体の説明）を消さない。
    if not description:
        pj = plugin_dir / "plugin.json"
        if pj.is_file():
            try:
                description = json.loads(
                    pj.read_text(encoding="utf-8")).get("description", "")
            except (json.JSONDecodeError, OSError):
                pass
    (plugin_dir / "plugin.json").write_text(
        build_plugin_json(plugin, version, author, description), encoding="utf-8")

    readme_path = PLUGINS_DIR / plugin / "README.md"
    if readme_path.exists():
        readme_action = "kept"  # 既存 README を上書きしない（手書き保護）
    else:
        readme_path.write_text(
            build_readme(plugin, public_name, skill, description, bundled_skills),
            encoding="utf-8")
        readme_action = "created"
    return {"plugin_json": "created", "readme": readme_action}


def ensure_symlink(plugin: str, link_name: str, skill: str) -> str:
    """plugins/<plugin>/skills/<link_name> → ../../../.claude/skills/<skill> の相対 symlink を作る。

    link_name（公開名）と skill（実体ディレクトリ名）は異なってよい。
    冪等: 既に正しい相対 symlink ならそのまま。違う向きなら張り直す。
    戻り値: "created" | "kept" | "relinked"
    """
    skills_subdir = PLUGINS_DIR / plugin / "skills"
    skills_subdir.mkdir(parents=True, exist_ok=True)
    link_path = skills_subdir / link_name
    target = os.path.join(*SKILL_LINK_TARGET_PREFIX, ".claude", "skills", skill)

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


def verify_symlink(plugin: str, link_name: str) -> bool:
    """リンク経由で SKILL.md が読めるかを検証する。"""
    linked_skill_md = PLUGINS_DIR / plugin / "skills" / link_name / "SKILL.md"
    return linked_skill_md.is_file()


def read_existing_version(plugin: str):
    """既存 plugin.json から version を読む。無ければ None。"""
    pj = PLUGINS_DIR / plugin / ".claude-plugin" / "plugin.json"
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


def resolve_version(plugin: str, explicit, exists: bool):
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
        cur = read_existing_version(plugin)
        if cur:
            return bump_patch(cur), f"{cur} -> patch+1"
        return "0.1.0", "default(0.1.0)"
    return "0.1.0", "default(0.1.0)"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="既存スキルを marketplace.json にプラグイン登録する")
    parser.add_argument("--skill", required=True,
                        help="登録対象スキル名（.claude/skills/ の実ディレクトリ名）")
    parser.add_argument("--plugin", default=None,
                        help="登録先 plugin 名（カテゴリ）。未指定ならスキル名と同名の plugin")
    parser.add_argument("--as", dest="link_name", default=None,
                        help="skills/ 配下のエントリ名（symlink 名）。既定はスキル実体"
                             "ディレクトリ名（公開名は frontmatter の name が担うため通常不要）")
    parser.add_argument("--version", default=None,
                        help="plugin.json の version。未指定なら新規=0.1.0／"
                             "更新=既存 version の patch を +1")
    parser.add_argument("--author", default="yoshiysh", help="plugin.json の author 名")
    parser.add_argument("--description", default="",
                        help="プラグイン説明文（未指定時は空。input-resolver が補う想定）")
    parser.add_argument("--update", action="store_true",
                        help="同名 plugin エントリが既にある場合に更新する（既定は衝突中断）。"
                             "既存カテゴリ plugin へのスキル追加もこれ")
    parser.add_argument("--bundle-skill", action="append", default=[],
                        metavar="DEP",
                        help="依存スキルを同一プラグインに同梱する（skills/<DEP公開名> を追加。"
                             "複数指定可）")
    parser.add_argument("--dry-run", action="store_true",
                        help="ファイルに書き込まず、行う操作のみ報告する")
    args = parser.parse_args()

    skill = args.skill
    plugin = args.plugin or skill

    # 同梱依存スキル（重複除去・本体除外・入力順を保持）
    bundle_skills = []
    for dep in args.bundle_skill:
        if dep and dep != skill and dep not in bundle_skills:
            bundle_skills.append(dep)

    # 1. 実在確認（最初に行い無駄な書き込みを防ぐ）。同梱依存も実在を要求する。
    verify_skill_exists(skill)
    for dep in bundle_skills:
        verify_skill_exists(dep)

    # symlink 名は明示（--as）> スキル実体ディレクトリ名。公開名は frontmatter の name。
    link_name = args.link_name or skill
    public_name = frontmatter_name(skill)

    # 2. marketplace.json 読み込み（破損中断・不在は新規）
    data, created_new = load_marketplace()
    exists = any(isinstance(p, dict) and p.get("name") == plugin
                 for p in data["plugins"])

    # version を解決（明示 > 更新時 patch+1 > 新規 0.1.0）
    version, version_bump = resolve_version(plugin, args.version, exists)

    if args.dry_run:
        if exists and not args.update:
            fail(EXIT_CONFLICT,
                 f"ERROR: plugin '{plugin}' は既に登録済みです（--update が必要）。")
        report = {
            "status": "ok",
            "dry_run": True,
            "created_new": created_new,
            "marketplace_path": str(MARKETPLACE_PATH),
            "plugin": plugin,
            "skill": skill,
            "public_name": public_name,
            "version": version,
            "version_bump": version_bump,
            "planned_actions": {
                "marketplace_entry": "updated" if exists else "added",
                "plugin_json": f"would_create (version {version})",
                "readme": "would_keep" if (PLUGINS_DIR / plugin / "README.md").exists()
                          else "would_create",
                "symlink": f"./plugins/{plugin}/skills/{link_name} -> "
                           f"../../../.claude/skills/{skill}",
                "bundled_symlinks": [
                    f"./plugins/{plugin}/skills/{dep} -> ../../../.claude/skills/{dep}"
                    for dep in bundle_skills
                ],
            },
            "bundled_skills": bundle_skills,
            "next_action":
                f"/plugin install {plugin}@{data.get('name', 'yoshiysh-claude-plugins')} "
                "でインストールして動作確認できます。",
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        sys.exit(EXIT_OK)

    # 3. marketplace.json へ非破壊マージ（衝突は exit 4）
    entry_action = merge_marketplace_entry(data, plugin, update=args.update)
    write_marketplace(data)

    # 4-5. plugin.json / README 生成・相対 symlink 作成（本体）
    file_actions = write_plugin_files(plugin, public_name, skill, version,
                                      args.author, args.description, bundle_skills)
    symlink_action = ensure_symlink(plugin, link_name, skill)

    # 4-5b. 依存スキルを同一プラグインに同梱（skills/<dep> の追加 symlink）
    bundled = []
    for dep in bundle_skills:
        dep_action = ensure_symlink(plugin, dep, dep)
        bundled.append({"skill": dep, "public_name": frontmatter_name(dep),
                        "symlink": dep_action,
                        "ok": verify_symlink(plugin, dep)})

    # 6. symlink 検証（本体＋同梱すべて）
    symlink_ok = verify_symlink(plugin, link_name) and all(b["ok"] for b in bundled)

    report = {
        "status": "ok",
        "dry_run": False,
        "created_new": created_new,
        "marketplace_path": str(MARKETPLACE_PATH),
        "plugin": plugin,
        "skill": skill,
        "public_name": public_name,
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
            f"/plugin install {plugin}@{data.get('name', 'yoshiysh-claude-plugins')} "
            "でインストールして動作確認できます。",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(EXIT_OK if symlink_ok else EXIT_NO_SKILL)


if __name__ == "__main__":
    main()
