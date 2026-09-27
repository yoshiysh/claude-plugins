#!/usr/bin/env python3
"""既存スキルをリポジトリの marketplace.json にプラグインとして登録するスクリプト。

`plugins/<plugin>/` に公開用のプラグインディレクトリを作り、そこに Claude manifest と Codex の
互換 fallback manifest（`.claude-plugin/plugin.json` と `.codex-plugin/plugin.json`）および README を生成し、
**スキル実体を `.agents/skills/<skill>` から `plugins/<plugin>/skills/<公開名>` へ移動**して、
`.agents/skills/<skill>` を移動先への相対 symlink に置き換える。marketplace.json の plugins には
{name, source: "./plugins/<plugin>"} を非破壊で追記する。

つまり「開発中は `.agents/skills/` に実体、公開したら `plugins/` に実体」という向きになる。
新規スキルは従来どおり `.agents/skills/` に作ればよく、公開の瞬間にこのスクリプトが反転させる。

plugin はカテゴリ単位で複数スキルを収録できる（例: plugins/git/skills/{commit,pr-create}）。
- `--plugin` で対象 plugin を指定する（未指定ならスキル名と同名の plugin）。
- skills/ 配下のエントリ名は**スキル実体ディレクトリ名**を既定とする。
  公開名（/plugin:skill の skill 部分）は frontmatter の `name` が担うため、変える必要はない。
  むしろ install 先のキャッシュはこのディレクトリ名で作られるため、
  `[SKILL_DIR]/../<兄弟スキル>/` のようなディレクトリ名参照を持つスキルは名前を
  実体名から変えると install 先で参照が切れる。`--as` は例外的な明示上書き用。

なぜ symlink ではなく実体移動なのか:
- Claude Code は plugin dir をキャッシュへコピーする際、同一 marketplace 内を指す symlink を
  dereference する（公式仕様。plugins-reference "Share files within a marketplace with symlinks"）。
  この前提で以前は plugins/<plugin>/skills/<name> -> .claude/skills/<name> の symlink にしていた。
- しかし Codex は plugin サブツリーだけを取得し、symlink を落とす。実測では
  ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/skills/ が空になり、
  plugin.json は読めているのにスキルが 1 つも入らない。
- 両方で動く構成は「配布サブツリーに symlink を置かない」形しかないため、実体を
  plugins/ 側に置き、リポジトリ内の開発用参照を symlink にする向きへ反転した。

設計上の不変条件:
- 非破壊: marketplace.json の既存 plugins 要素・他トップレベルキーを保持。既存 README は上書きしない。
  既存 plugin への追加登録時は、既にある skills/ 配下の他スキルを保持する。
- 冪等: 2回登録しても plugins が重複せず、既に移動済みのスキルは "kept" になる。
- 配布サブツリーに symlink を置かない: plugins/<plugin>/ 配下は全て実体でなければならない。
- 相対 symlink のみ: `.agents/skills/<skill>` からの逆参照は相対で張る（クローン先で壊れるため）。
- 不在 != 破損: marketplace.json 不在は新規作成、破損 JSON は中断（自動修復しない）。
- スキル実体は複製しない: 実体は常に 1 箇所。複数 plugin での共有はコピーになるため許可しない。
"""

import argparse
import ipaddress
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse
from path_safety import find_project_root, guard_plugin_root, guard_skill_root, guard_tree

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = find_project_root(SCRIPT_DIR)

# スキルの開発用置き場（実体または plugins/ への symlink）。編集はこちら側から行う。
AGENTS_SKILLS_DIR = PROJECT_ROOT / ".agents" / "skills"
MARKETPLACE_PATH = PROJECT_ROOT / ".claude-plugin" / "marketplace.json"
CODEX_MARKETPLACE_PATH = PROJECT_ROOT / ".agents" / "plugins" / "marketplace.json"
# 公開用プラグインディレクトリの置き場（ルート直下を散らかさないよう plugins/ に集約）。
PLUGINS_DIR = PROJECT_ROOT / "plugins"
# .agents/skills/ から plugins/<plugin>/skills/<name> までの相対深さ（.. を2つ）。
BACKLINK_PREFIX = (os.pardir, os.pardir)
# Codex 用 .codex-plugin/plugin.json は、root plugin.json を使わない既存形式の互換 fallback。
MANIFEST_DIRS = (".claude-plugin", ".codex-plugin")
# Claude 側だけに書くフィールド。Claude Code は未知フィールドを無視すると明記しているが、
# Codex 側にその保証が無いため、Codex 仕様に無い項目は .codex-plugin へ入れない。
CLAUDE_ONLY_FIELDS = ("dependencies",)

# marketplace.json 不在時に作る雛形（既存フォーマットに合わせる）。
DEFAULT_MARKETPLACE = {
    "name": "yoshiysh-claude-plugins",
    "description": "スキルを公開するマーケットプレイスです。",
    "owner": {"name": "yoshiysh"},
    "plugins": [],
}

DEFAULT_CODEX_MARKETPLACE = {
    "name": "yoshiysh-claude-plugins",
    "interface": {"displayName": "Yoshiysh Plugins"},
    "plugins": [],
}

# 4スペースインデント（既存 marketplace.json / plugin.json の様式に合わせる）。
INDENT = 4

EXIT_OK = 0
EXIT_CORRUPT = 2     # marketplace.json が壊れた JSON
EXIT_NO_SKILL = 3    # 対象スキルの SKILL.md が無い
EXIT_CONFLICT = 4    # 同名エントリ衝突（--update 未指定）/ 想定外の実体
EXIT_INVALID = 5    # 名前形式または許可 path root が不正
PLUGIN_NAME_PATTERN = r"[a-z0-9]+(?:-[a-z0-9]+)*"
SKILL_DIR_NAME_PATTERN = PLUGIN_NAME_PATTERN


def fail(exit_code: int, *lines: str) -> None:
    for line in lines:
        print(line, file=sys.stderr)
    sys.exit(exit_code)


def validate_plugin_name(name: str) -> str:
    """Accept lowercase kebab-case names before using them in filesystem paths."""
    if not isinstance(name, str) or not re.fullmatch(PLUGIN_NAME_PATTERN, name):
        fail(EXIT_INVALID,
             f"ERROR: plugin 名が許可形式ではありません: {name!r}",
             "  小文字英数字をハイフンで区切った名前を指定してください。")
    return name


def validate_skill_dir_name(name: str, option: str = "skill") -> str:
    """Accept existing lowercase kebab-case skill directory names only."""
    if not isinstance(name, str) or not re.fullmatch(SKILL_DIR_NAME_PATTERN, name):
        fail(EXIT_INVALID,
             f"ERROR: {option} 名が許可形式ではありません: {name!r}",
             "  小文字英数字をハイフンで区切った名前を指定してください。")
    return name


def ensure_path_within(path: Path, roots: list[Path], label: str) -> Path:
    """Reject symlink-resolved paths outside their designated repository roots."""
    try:
        resolved = path.resolve()
        resolved_roots = [root.resolve() for root in roots]
    except (OSError, RuntimeError):
        fail(EXIT_INVALID, f"ERROR: {label} の実パスを安全に解決できません: {path}")
    if not any(resolved == root or root in resolved.parents for root in resolved_roots):
        fail(EXIT_INVALID, f"ERROR: {label} が許可されたディレクトリの外を指しています: {path}")
    return path


def ensure_project_path(path: Path, label: str) -> Path:
    return ensure_path_within(path, [PROJECT_ROOT], label)


def preflight_file_path(path: Path, label: str) -> Path:
    """Reject symlinks and invalid parent shapes before reading or writing a file."""
    try:
        relative = path.relative_to(PROJECT_ROOT)
    except ValueError:
        fail(EXIT_INVALID, f"ERROR: {label} が checkout 外です: {path}")
    current = PROJECT_ROOT
    if current.is_symlink() or not current.is_dir():
        fail(EXIT_INVALID, f"ERROR: checkout root が通常ディレクトリではありません: {current}")
    for part in relative.parts[:-1]:
        current = current / part
        if current.is_symlink():
            fail(EXIT_INVALID, f"ERROR: {label} の親ディレクトリに symlink は使えません: {current}")
        if current.exists() and not current.is_dir():
            fail(EXIT_INVALID, f"ERROR: {label} の親がディレクトリではありません: {current}")
    if path.is_symlink():
        fail(EXIT_INVALID, f"ERROR: {label} に symlink は使えません: {path}")
    if path.exists() and not path.is_file():
        fail(EXIT_INVALID, f"ERROR: {label} が通常ファイルではありません: {path}")
    return ensure_project_path(path, label)


def validate_repository_roots() -> None:
    for root, label in ((AGENTS_SKILLS_DIR, ".agents/skills"),
                        (PLUGINS_DIR, "plugins"),
                        (MARKETPLACE_PATH.parent, ".claude-plugin"),
                        (CODEX_MARKETPLACE_PATH.parent, ".agents/plugins")):
        ensure_project_path(root, label)


def plugin_dir_path(plugin: str) -> Path:
    validate_plugin_name(plugin)
    path = PLUGINS_DIR / plugin
    guard_plugin_root(path, PLUGINS_DIR, PROJECT_ROOT)
    return ensure_path_within(path, [PLUGINS_DIR], "plugin directory")


def plugin_skills_path(plugin: str) -> Path:
    plugin_dir = plugin_dir_path(plugin)
    path = plugin_dir / "skills"
    if path.is_symlink():
        fail(EXIT_INVALID, f"ERROR: plugin skills directory に symlink は使えません: {path}")
    if path.exists() and not path.is_dir():
        fail(EXIT_INVALID, f"ERROR: plugin skills path がディレクトリではありません: {path}")
    return ensure_path_within(path, [plugin_dir], "plugin skills directory")


def skill_source_path(name: str) -> Path:
    validate_skill_dir_name(name)
    return ensure_path_within(AGENTS_SKILLS_DIR / name, skill_source_roots(), "skill directory")


def verify_skill_exists(name: str) -> None:
    """対象スキルの SKILL.md 実在を確認する。無ければ中断。"""
    validate_skill_dir_name(name)
    source = skill_source_path(name)
    skill_md = ensure_path_within(source / "SKILL.md", skill_source_roots(), "SKILL.md")
    if not skill_md.is_file():
        fail(EXIT_NO_SKILL,
             f"ERROR: 対象スキルの SKILL.md が見つかりません: {skill_md}",
             "  登録対象スキルがリポジトリに実在するか確認してください。")


def skill_source_roots() -> list[Path]:
    roots = [AGENTS_SKILLS_DIR]
    if PLUGINS_DIR.is_dir():
        roots.extend(
            plugin_skills_path(plugin_dir.name)
            for plugin_dir in PLUGINS_DIR.iterdir()
            if plugin_dir.is_dir() and re.fullmatch(PLUGIN_NAME_PATTERN, plugin_dir.name)
        )
    return roots


def frontmatter_name(skill: str) -> str:
    """SKILL.md frontmatter の name を読む。取れなければスキルディレクトリ名を返す。

    公開名（skills/ 配下のエントリ名）の既定値。frontmatter の name が
    ディレクトリ名より優先される公式仕様に合わせ、公開名も name に揃える。
    """
    skill_md = ensure_path_within(skill_source_path(skill) / "SKILL.md",
                                  skill_source_roots(), "SKILL.md")
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
    preflight_file_path(MARKETPLACE_PATH, "Claude marketplace file")
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
    names = [entry.get("name") for entry in data["plugins"] if isinstance(entry, dict)]
    names = [name for name in names if isinstance(name, str)]
    if len(names) != len(set(names)):
        fail(EXIT_CORRUPT, "ERROR: marketplace.json に重複した plugin name があります。")
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
            plugins[i] = {**p, **entry}
            return "updated"
    plugins.append(entry)
    return "added"


def write_marketplace(data: dict) -> None:
    preflight_file_path(MARKETPLACE_PATH, "Claude marketplace destination")
    MARKETPLACE_PATH.parent.mkdir(parents=True, exist_ok=True)
    MARKETPLACE_PATH.write_text(
        json.dumps(data, indent=INDENT, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_codex_marketplace() -> tuple[dict, bool]:
    """Read the Codex repository plugin catalog, creating its initial shape when absent."""
    preflight_file_path(CODEX_MARKETPLACE_PATH, "Codex marketplace file")
    if not CODEX_MARKETPLACE_PATH.exists():
        return json.loads(json.dumps(DEFAULT_CODEX_MARKETPLACE)), True
    try:
        data = json.loads(CODEX_MARKETPLACE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(EXIT_CORRUPT,
             "ERROR: Codex marketplace.json が壊れた JSON です。",
             f"  path: {CODEX_MARKETPLACE_PATH}", f"  detail: {e}")
    if not isinstance(data, dict):
        fail(EXIT_CORRUPT, "ERROR: Codex marketplace.json のトップレベルがオブジェクトではありません。")
    if not isinstance(data.get("name"), str) or not data["name"]:
        fail(EXIT_CORRUPT, "ERROR: Codex marketplace.json に name がありません。")
    interface = data.get("interface")
    if (not isinstance(interface, dict)
            or not isinstance(interface.get("displayName"), str)
            or not interface["displayName"].strip()):
        fail(EXIT_CORRUPT,
             "ERROR: Codex marketplace.json に空でない interface.displayName がありません。")
    plugins = data.get("plugins")
    if not isinstance(plugins, list):
        fail(EXIT_CORRUPT, "ERROR: Codex marketplace.json の plugins が配列ではありません。")
    names = [p.get("name") for p in plugins if isinstance(p, dict)]
    if len(names) != len(plugins) or any(not isinstance(n, str) or not n for n in names):
        fail(EXIT_CORRUPT, "ERROR: Codex marketplace.json の plugins に不正な entry があります。")
    if len(names) != len(set(names)):
        fail(EXIT_CORRUPT, "ERROR: Codex marketplace.json に重複した plugin name があります。")
    def invalid_source(entry: dict, reason: str) -> None:
        fail(EXIT_CORRUPT,
             f"ERROR: Codex catalog entry '{entry['name']}' の source が不正です: {reason}")

    def validate_remote_url(value: object) -> bool:
        if not isinstance(value, str) or not value.strip() or any(c.isspace() for c in value):
            return False
        try:
            parsed = urlparse(value)
            hostname = parsed.hostname or ""
            parsed.port
            if ":" in hostname:
                ipaddress.ip_address(hostname)
                hostname_valid = True
            else:
                label = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                hostname_valid = bool(re.fullmatch(rf"{label}(?:\.{label})*\.?", hostname))
        except ValueError:
            return False
        authority = parsed.netloc.rsplit("@", 1)[-1]
        return (parsed.scheme in {"https", "http", "ssh", "git"}
                and bool(parsed.netloc) and hostname_valid and not authority.endswith(":"))

    def validate_local_path(value: object, entry: dict) -> None:
        if not isinstance(value, str) or not value.startswith("./"):
            invalid_source(entry, "local path は './' 相対である必要があります")
        resolved = (PROJECT_ROOT / value).resolve()
        try:
            resolved.relative_to(PROJECT_ROOT.resolve())
        except ValueError:
            invalid_source(entry, f"local path が marketplace root の外を指しています: {value}")

    for entry in plugins:
        source = entry.get("source")
        policy = entry.get("policy")
        if isinstance(source, str):
            validate_local_path(source, entry)
        elif isinstance(source, dict) and isinstance(source.get("source"), str):
            kind = source["source"]
            if kind == "local":
                validate_local_path(source.get("path"), entry)
            elif kind == "url":
                if not validate_remote_url(source.get("url")):
                    invalid_source(entry, "url source に有効な url が必要です")
            elif kind == "git-subdir":
                if not validate_remote_url(source.get("url")):
                    invalid_source(entry, "git-subdir source に有効な url が必要です")
                path_value = source.get("path")
                if (not isinstance(path_value, str) or not path_value.startswith("./")
                        or "\\" in path_value
                        or ".." in Path(path_value).parts):
                    invalid_source(entry, "git-subdir path は './' 相対である必要があります")
                if any(not isinstance(source[k], str) or not source[k].strip()
                       for k in ("ref", "sha") if k in source):
                    invalid_source(entry, "git-subdir ref/sha は空でない文字列である必要があります")
            elif kind == "npm":
                if not isinstance(source.get("package"), str) or not source["package"].strip():
                    invalid_source(entry, "npm source に package が必要です")
                if any(not isinstance(source[k], str) or not source[k].strip()
                       for k in ("version", "registry") if k in source):
                    invalid_source(entry, "npm version/registry は空でない文字列である必要があります")
                if "registry" in source:
                    try:
                        registry = urlparse(source["registry"])
                        port = registry.port
                        hostname = registry.hostname or ""
                    except ValueError as exc:
                        invalid_source(entry, f"npm registry URL が不正です: {exc}")
                    host_label = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                    if ":" in hostname:
                        try:
                            ipaddress.ip_address(hostname)
                            hostname_valid = True
                        except ValueError:
                            hostname_valid = False
                    else:
                        hostname_valid = bool(re.fullmatch(
                            rf"{host_label}(?:\.{host_label})*\.?", hostname))
                    authority = registry.netloc.rsplit("@", 1)[-1]
                    if (registry.scheme != "https" or not hostname or any(c.isspace() for c in hostname)
                            or not hostname_valid or authority.endswith(":")
                            or (port is not None and not 1 <= port <= 65535)
                            or "@" in registry.netloc or registry.username is not None
                            or registry.password is not None or registry.query or registry.fragment):
                        invalid_source(entry, "npm registry は有効な host/port を持ち、userinfo/query/fragment を含まない HTTPS URL が必要です")
            else:
                invalid_source(entry, f"未知の source type: {kind}")
        else:
            invalid_source(entry, "未対応の source 形式です")
        if policy is not None and not isinstance(policy, dict):
            fail(EXIT_CORRUPT, f"ERROR: Codex catalog entry '{entry['name']}' の policy が不正です。")
        policy = policy or {}
        if "installation" in policy and (not isinstance(policy["installation"], str)
                or policy["installation"] not in {"AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"}):
            fail(EXIT_CORRUPT,
                 f"ERROR: Codex catalog entry '{entry['name']}' の installation policy が不正です: {policy['installation']}")
        if "authentication" in policy and (not isinstance(policy["authentication"], str)
                or not policy["authentication"].strip()):
            fail(EXIT_CORRUPT,
                 f"ERROR: Codex catalog entry '{entry['name']}' の authentication policy が空です。")
        if "category" in entry and (not isinstance(entry["category"], str) or not entry["category"]):
            fail(EXIT_CORRUPT, f"ERROR: Codex catalog entry '{entry['name']}' の category がありません。")
        entry["policy"] = {"installation": "AVAILABLE", "authentication": "ON_INSTALL", **policy}
    return data, False


def codex_category(plugin: str, existing: dict | None) -> str:
    """Use the catalog's existing category, then plugin UI metadata, then the default."""
    category = existing.get("category") if isinstance(existing, dict) else None
    if isinstance(category, str) and category:
        return category
    path = plugin_dir_path(plugin) / ".codex-plugin" / "plugin.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get("interface", {}).get("category")
    except (OSError, json.JSONDecodeError, AttributeError):
        value = None
    return value if isinstance(value, str) and value else "Productivity"


def merge_codex_catalog(data: dict, claude_marketplace: dict) -> dict:
    """Sync Claude-listed plugins into the Codex catalog while retaining unrelated entries."""
    entries = data["plugins"]
    by_name = {entry["name"]: entry for entry in entries}
    actions = {"added": [], "updated": [], "kept": []}
    for claude_entry in claude_marketplace["plugins"]:
        if not isinstance(claude_entry, dict) or not isinstance(claude_entry.get("name"), str):
            continue
        name = claude_entry["name"]
        validate_plugin_name(name)
        current = by_name.get(name)
        current = current if isinstance(current, dict) else None
        if current and "policy" in current and not isinstance(current["policy"], dict):
            fail(EXIT_CORRUPT, f"ERROR: Codex catalog entry '{name}' の policy がオブジェクトではありません。")
        policy = dict(current.get("policy", {})) if current else {}
        policy.setdefault("installation", "AVAILABLE")
        policy.setdefault("authentication", "ON_INSTALL")
        canonical = {
            "name": name,
            "source": {"source": "local", "path": f"./plugins/{name}"},
            "policy": policy,
        }
        if current and "category" in current and not isinstance(current["category"], str):
            fail(EXIT_CORRUPT, f"ERROR: Codex catalog entry '{name}' の category が文字列ではありません。")
        if current is None or not current.get("category"):
            canonical["category"] = codex_category(name, current)
        if current is None:
            entries.append(canonical)
            by_name[name] = canonical
            actions["added"].append(name)
            continue
        merged = {**current, **canonical}
        if merged != current:
            current.clear()
            current.update(merged)
            actions["updated"].append(name)
        else:
            actions["kept"].append(name)
    for entry in entries:
        entry.setdefault("category", "Productivity")
    return actions


def write_codex_marketplace(data: dict) -> None:
    ensure_project_path(CODEX_MARKETPLACE_PATH, "Codex marketplace destination")
    CODEX_MARKETPLACE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CODEX_MARKETPLACE_PATH.write_text(
        json.dumps(data, indent=INDENT, ensure_ascii=False) + "\n", encoding="utf-8")
    written = json.loads(CODEX_MARKETPLACE_PATH.read_text(encoding="utf-8"))
    if written != data:
        fail(EXIT_CORRUPT, "ERROR: Codex marketplace.json の書き込み後 readback が一致しません。")


def build_plugin_json(plugin: str, version: str, author: str, description: str,
                      dependencies=None, claude_only: bool = True, interface=None) -> str:
    data = {"name": plugin, "version": version}
    if description:
        data["description"] = description
    data["author"] = {"name": author}
    if dependencies and claude_only:
        # 他 plugin のスキルを呼び出す場合に、その plugin の同時 install を保証する。
        # Codex には同等のフィールドが無いため .codex-plugin 側には書かない。
        data["dependencies"] = list(dependencies)
    if not claude_only:
        data["interface"] = interface if interface is not None else {
            "displayName": plugin,
            "shortDescription": description or plugin,
            "longDescription": description or plugin,
            "developerName": author,
            "category": "Productivity",
            "capabilities": [],
            "defaultPrompt": ["このプラグインの対応範囲と使い方を教えて"],
        }
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
        "このプラグインの `skills/` 配下がスキルの実体です。\n"
        "リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。\n"
        f"{entity_note}"
    )


def write_plugin_files(plugin: str, public_name: str, skill: str, version: str,
                       author: str, description: str, bundled_skills=None,
                       dependencies=None) -> dict:
    """ルート plugin dir に plugin.json を生成し、README は既存があれば保持する。

    plugin.json の共通フィールドは両環境で揃える。interface は Codex 専用として保持する。Claude Code は
    Codex portable 形式の root plugin.json ではなく、既存の .codex-plugin/plugin.json
    compatibility fallback を生成する。portable root manifest 化は別途必要。

    戻り値: {"plugin_json": "created", "readme": "created"|"kept"}
    """
    plugin_dir_path(plugin)
    # 既存カテゴリ plugin への追加登録で description 未指定のとき、
    # 既存 plugin.json の description（plugin 全体の説明）を消さない。
    if not description:
        pj = plugin_dir_path(plugin) / MANIFEST_DIRS[0] / "plugin.json"
        if pj.is_file():
            try:
                description = json.loads(
                    pj.read_text(encoding="utf-8")).get("description", "")
            except (json.JSONDecodeError, OSError):
                pass
    pj = plugin_dir_path(plugin) / MANIFEST_DIRS[0] / "plugin.json"
    existing_claude = json.loads(pj.read_text(encoding="utf-8")) if pj.is_file() else {}
    if not isinstance(existing_claude, dict):
        raise ValueError("Claude plugin manifest must be an object")
    existing_dependencies = existing_claude.get("dependencies", [])
    if not isinstance(existing_dependencies, list) or any(not isinstance(d, str) for d in existing_dependencies):
        raise ValueError("Claude dependencies must be an array of strings")
    dependencies = list(dict.fromkeys([*existing_dependencies, *(dependencies or [])]))
    # Read before either write: malformed existing UI metadata must not be silently lost.
    plugin_dir = plugin_dir_path(plugin)
    codex_path = plugin_dir / ".codex-plugin" / "plugin.json"
    interface = None
    if codex_path.is_file():
        existing = json.loads(codex_path.read_text(encoding="utf-8"))
        if not isinstance(existing, dict):
            raise ValueError("Codex plugin manifest must be an object")
        if "interface" in existing:
            interface = existing["interface"]
            if not isinstance(interface, dict):
                raise ValueError("Codex interface must be an object")
            category = interface.get("category")
            if category is not None and (not isinstance(category, str) or not category.strip()):
                raise ValueError("Codex interface.category must be a non-empty string")
    outputs = {
        ensure_project_path(plugin_dir / manifest_dir / "plugin.json", "plugin manifest destination"):
        build_plugin_json(plugin, version, author, description, dependencies,
                          claude_only=(manifest_dir == ".claude-plugin"), interface=interface)
        for manifest_dir in MANIFEST_DIRS
    }
    readme_path = ensure_project_path(plugin_dir / "README.md", "plugin README destination")
    readme_content = None if readme_path.exists() else build_readme(plugin, public_name, skill, description, bundled_skills)
    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    if readme_content is None:
        readme_action = "kept"  # 既存 README を上書きしない（手書き保護）
    else:
        readme_path.write_text(readme_content, encoding="utf-8")
        readme_action = "created"
    return {"plugin_json": "created", "readme": readme_action}


def relocate_skill(plugin: str, entry_name: str, skill: str) -> str:
    """スキル実体を plugins/<plugin>/skills/<entry_name> へ移し、開発用の逆 symlink を張る。

    entry_name（配布時のディレクトリ名）と skill（開発側ディレクトリ名）は異なってよい。

    冪等性の判定は「実体がどちら側にあるか」で行う:
    - 既に移動済み（配布側が実体・開発側がそこを指す symlink）→ "kept"
    - 旧レイアウト（配布側が symlink・開発側が実体）→ 反転して "migrated"
    - 未登録（配布側が無い・開発側が実体）→ 移動して "created"

    戻り値: "created" | "migrated" | "kept"
    """
    validate_skill_dir_name(entry_name, "--as")
    validate_skill_dir_name(skill, "--skill")
    skills_subdir = plugin_skills_path(plugin)
    skills_subdir.mkdir(parents=True, exist_ok=True)
    dest = ensure_path_within(skills_subdir / entry_name,
                              [skills_subdir, AGENTS_SKILLS_DIR], "plugin skill entry")
    src = skill_source_path(skill)
    ensure_project_path(src, "skill relocation source")
    ensure_project_path(dest, "skill relocation destination")
    ensure_project_path(src.parent, "skill backlink destination")
    backlink_target = os.path.join(*BACKLINK_PREFIX, "plugins", plugin, "skills", entry_name)

    dest_is_entity = dest.is_dir() and not dest.is_symlink()
    src_is_entity = src.is_dir() and not src.is_symlink()

    # 既に移動済み。開発側の symlink だけ、向きが正しいか確認して必要なら張り直す。
    if dest_is_entity and not src_is_entity:
        if src.is_symlink() and os.readlink(src) != backlink_target:
            src.unlink()
            src.symlink_to(backlink_target)
        elif not src.exists() and not src.is_symlink():
            src.symlink_to(backlink_target)
        return "kept"

    # 実体が両側にある = 複製。どちらが正か機械判断できないので中断する。
    if dest_is_entity and src_is_entity:
        fail(EXIT_CONFLICT,
             f"ERROR: スキル実体が 2 箇所にあります: {src} と {dest}",
             "  複製は許可していません（drift するため）。どちらが正か確認し、"
             "不要な方を手で削除してから再実行してください。")

    if not src_is_entity:
        fail(EXIT_CONFLICT,
             f"ERROR: 移動元のスキル実体が見つかりません: {src}",
             "  開発中のスキルは .agents/skills/<name>/ に実体で置いてください。")

    # 旧レイアウト（配布側が symlink）なら、まずそれを外す。
    action = "created"
    if dest.is_symlink():
        dest.unlink()
        action = "migrated"

    src.rename(dest)
    src.symlink_to(backlink_target)
    return action


def verify_entity(plugin: str, entry_name: str) -> bool:
    """配布側が実体として存在し、SKILL.md を持つかを検証する。"""
    validate_skill_dir_name(entry_name, "--as")
    skills_root = plugin_skills_path(plugin)
    entry = skills_root / entry_name
    if entry.is_symlink() or not entry.is_dir():
        return False
    entry = ensure_path_within(entry, [skills_root], "plugin skill entry")
    return ensure_path_within(entry / "SKILL.md", [skills_root], "SKILL.md").is_file()


def owning_plugin(skill: str):
    """スキル実体が既にどの plugin に属しているかを返す。未登録なら None。"""
    validate_skill_dir_name(skill, "--bundle-skill")
    if not PLUGINS_DIR.is_dir():
        return None
    for plugin_dir in sorted(PLUGINS_DIR.iterdir()):
        if not re.fullmatch(PLUGIN_NAME_PATTERN, plugin_dir.name):
            continue
        entry = plugin_skills_path(plugin_dir.name) / skill
        if entry.is_dir() and not entry.is_symlink():
            return plugin_dir.name
    return None


def find_symlinks(plugin: str) -> list[str]:
    """plugins/<plugin>/ 配下に残っている symlink を列挙する。

    配布サブツリーに symlink があると Codex の install 先で中身が落ちる。
    「壊れた symlink が無いか」ではなく「symlink が 1 つも無いか」を見るのが要点。
    """
    plugin_dir = plugin_dir_path(plugin)
    if not plugin_dir.is_dir():
        return []
    return sorted(
        str(p.relative_to(plugin_dir))
        for p in plugin_dir.rglob("*") if p.is_symlink()
    )


def read_existing_version(plugin: str):
    """既存 plugin.json から version を読む。無ければ None。"""
    pj = plugin_dir_path(plugin) / ".claude-plugin" / "plugin.json"
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


def preflight_plugin_inputs(plugin: str) -> None:
    plugin_dir = plugin_dir_path(plugin)
    for manifest_dir in MANIFEST_DIRS:
        path = preflight_file_path(plugin_dir / manifest_dir / "plugin.json", "plugin manifest destination")
        if not path.exists():
            continue
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"{path} must contain a JSON object")
        if manifest_dir == ".claude-plugin":
            deps = value.get("dependencies", [])
            if not isinstance(deps, list) or any(not isinstance(dep, str) for dep in deps):
                raise ValueError(f"{path} dependencies must be an array of strings")
        else:
            interface = value.get("interface")
            if interface is not None and not isinstance(interface, dict):
                raise ValueError(f"{path} interface must be an object")
            if isinstance(interface, dict):
                category = interface.get("category")
                if category is not None and (not isinstance(category, str) or not category.strip()):
                    raise ValueError(f"{path} interface.category must be a non-empty string")
    preflight_file_path(plugin_dir / "README.md", "plugin README destination")


def preflight_catalog_manifests(marketplace: dict) -> None:
    for entry in marketplace["plugins"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            continue
        name = validate_plugin_name(entry["name"])
        plugin_dir = plugin_dir_path(name)
        for manifest_dir in MANIFEST_DIRS:
            path = preflight_file_path(plugin_dir / manifest_dir / "plugin.json", "catalog manifest input")
            if not path.exists():
                continue
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError(f"{path} must contain a JSON object")
            if manifest_dir == ".codex-plugin" and "interface" in value and not isinstance(value["interface"], dict):
                raise ValueError(f"{path} interface must be an object")
            if manifest_dir == ".codex-plugin" and isinstance(value.get("interface"), dict):
                category = value["interface"].get("category")
                if category is not None and (not isinstance(category, str) or not category.strip()):
                    raise ValueError(f"{path} interface.category must be a non-empty string")
            if manifest_dir == ".claude-plugin":
                dependencies = value.get("dependencies", [])
                if not isinstance(dependencies, list) or any(not isinstance(dep, str) for dep in dependencies):
                    raise ValueError(f"{path} dependencies must be an array of strings")


def preflight_relocations(plugin: str, relocations: list[tuple[str, str]]) -> None:
    plugin_dir_path(plugin)
    skills_root = plugin_skills_path(plugin)
    destinations = [str((skills_root / entry_name).resolve()) for _, entry_name in relocations]
    if len(destinations) != len(set(destinations)):
        fail(EXIT_CONFLICT, "ERROR: 複数の relocation が同じ plugin skill destination を指定しています。")
    leftovers = find_symlinks(plugin)
    if leftovers:
        fail(EXIT_CONFLICT,
             f"ERROR: plugin 配下に既存 symlink があるため書き込み前に中断します: {leftovers[0]}")
    for source_name, entry_name in relocations:
        src = skill_source_path(source_name)
        try:
            guard_skill_root(src, AGENTS_SKILLS_DIR, PLUGINS_DIR, PROJECT_ROOT)
            if src.is_symlink():
                guard_tree(src.resolve(), [src.resolve()], PROJECT_ROOT, reject_symlinks=True)
            else:
                guard_tree(src, [src], PROJECT_ROOT, reject_symlinks=True)
        except ValueError as exc:
            fail(EXIT_CONFLICT, f"ERROR: unsafe relocation source tree: {exc}")
        dest = ensure_path_within(skills_root / entry_name,
                                  [skills_root, AGENTS_SKILLS_DIR], "plugin skill entry")
        src_is_entity = src.is_dir() and not src.is_symlink()
        dest_is_entity = dest.is_dir() and not dest.is_symlink()
        if src_is_entity and dest_is_entity:
            fail(EXIT_CONFLICT, f"ERROR: relocation preflight found duplicate entities: {src} and {dest}")
        if not src_is_entity and not (dest_is_entity and (src.is_symlink() or not src.exists())):
            fail(EXIT_CONFLICT, f"ERROR: relocation preflight found invalid source state: {src}")
        if dest.exists() and not dest_is_entity and not dest.is_symlink():
            fail(EXIT_CONFLICT, f"ERROR: relocation destination is not a skill directory: {dest}")
        if src.is_symlink() and src.exists() and not dest_is_entity:
            fail(EXIT_CONFLICT, f"ERROR: relocation source is a symlink without destination entity: {src}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="既存スキルを marketplace.json にプラグイン登録する")
    parser.add_argument("--skill", required=True,
                        help="登録対象スキル名（.claude/skills/ の実ディレクトリ名）")
    parser.add_argument("--plugin", default=None,
                        help="登録先 plugin 名（カテゴリ）。未指定ならスキル名と同名の plugin")
    parser.add_argument("--as", dest="link_name", default=None,
                        help="skills/ 配下のエントリ名。既定はスキル実体"
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
                        help="依存スキルを同一プラグインに同梱する（skills/<DEP> を追加。"
                             "複数指定可）。既に別 plugin に属するスキルは指定できない"
                             "（実体の複製になるため。中断して案内する）")
    parser.add_argument("--depends-on", action="append", default=[],
                        metavar="PLUGIN",
                        help="このプラグインが必要とする別 plugin（複数指定可）。"
                             ".claude-plugin/plugin.json の dependencies に書き、Claude Code に"
                             "同時 install させる。Codex には同等機能が無いため "
                             ".codex-plugin 側には書かない。別 plugin のスキルを "
                             "Skill として呼び出す場合に使う（ファイルパス参照は不可）")
    parser.add_argument("--dry-run", action="store_true",
                        help="ファイルに書き込まず、行う操作のみ報告する")
    args = parser.parse_args()

    try:
        validate_repository_roots()
    except ValueError as exc:
        fail(EXIT_INVALID, f"ERROR: unsafe repository path: {exc}")

    skill = validate_skill_dir_name(args.skill, "--skill")
    plugin = validate_plugin_name(args.plugin or skill)
    requested_bundle_skills = [validate_skill_dir_name(dep, "--bundle-skill")
                               for dep in args.bundle_skill]
    args.depends_on = [validate_plugin_name(dep) for dep in args.depends_on]
    link_name = validate_skill_dir_name(args.link_name, "--as") if args.link_name else skill
    try:
        plugin_dir_path(plugin)
        skills_root = plugin_skills_path(plugin)
        for entry_name in [link_name, *requested_bundle_skills]:
            ensure_path_within(skills_root / entry_name,
                               [skills_root, AGENTS_SKILLS_DIR], "plugin skill entry")
    except ValueError as exc:
        fail(EXIT_INVALID, f"ERROR: unsafe plugin destination: {exc}")

    # 同梱依存スキル（重複除去・本体除外・入力順を保持）
    bundle_skills = []
    for dep in requested_bundle_skills:
        if dep and dep != skill and dep not in bundle_skills:
            bundle_skills.append(dep)

    # 1. 実在確認（最初に行い無駄な書き込みを防ぐ）。同梱依存も実在を要求する。
    verify_skill_exists(skill)
    for dep in bundle_skills:
        verify_skill_exists(dep)
        owner = owning_plugin(dep)
        if owner and owner != plugin:
            fail(EXIT_CONFLICT,
                 f"ERROR: '{dep}' は既に plugin '{owner}' の実体です。",
                 f"  '{plugin}' へ同梱すると実体が 2 箇所になり drift します。",
                 "  配布サブツリーに symlink は置けない（Codex の install で落ちる）ため、"
                 "共有はできません。",
                 f"  対処: {plugin} 側が必要とする定義を自前の references/ に持たせるか、"
                 f"依存元スキルを {owner} plugin へ移してください。")

    # symlink 名は明示（--as）> スキル実体ディレクトリ名。公開名は frontmatter の name。
    public_name = frontmatter_name(skill)

    # 2. Both catalogs are validated before either is changed.
    data, created_new = load_marketplace()
    codex_data, codex_created_new = load_codex_marketplace()
    try:
        preflight_catalog_manifests(data)
    except (ValueError, json.JSONDecodeError, OSError) as exc:
        fail(EXIT_CORRUPT, f"ERROR: 既存 catalog manifest が不正です: {exc}")
    exists = any(isinstance(p, dict) and p.get("name") == plugin
                 for p in data["plugins"])

    # version を解決（明示 > 更新時 patch+1 > 新規 0.1.0）
    version, version_bump = resolve_version(plugin, args.version, exists)

    if exists and not args.update:
        fail(EXIT_CONFLICT,
             f"ERROR: plugin '{plugin}' は既に marketplace.json に登録済みです（--update が必要）。")
    planned_marketplace = json.loads(json.dumps(data))
    claude_action = merge_marketplace_entry(planned_marketplace, plugin, update=args.update)
    codex_actions = merge_codex_catalog(codex_data, planned_marketplace)
    try:
        preflight_plugin_inputs(plugin)
        preflight_file_path(MARKETPLACE_PATH, "Claude marketplace destination")
        preflight_file_path(CODEX_MARKETPLACE_PATH, "Codex marketplace destination")
        skills_root = plugin_skills_path(plugin)
        ensure_project_path(skills_root, "plugin skills destination")
        for entry_name in (link_name, *bundle_skills):
            ensure_project_path(skills_root / entry_name, "plugin skill relocation destination")
        for name in (skill, *bundle_skills):
            ensure_project_path(skill_source_path(name), "skill relocation source")
        preflight_relocations(plugin, [(skill, link_name), *((dep, dep) for dep in bundle_skills)])
    except (ValueError, json.JSONDecodeError, OSError) as exc:
        fail(EXIT_CORRUPT, f"ERROR: 既存 plugin manifest または保存先が不正です: {exc}")

    if args.dry_run:
        if exists and not args.update:
            fail(EXIT_CONFLICT,
                 f"ERROR: plugin '{plugin}' は既に登録済みです（--update が必要）。")
        report = {
            "status": "ok",
            "dry_run": True,
            "created_new": created_new,
            "marketplace_path": str(MARKETPLACE_PATH),
            "codex_marketplace_path": str(CODEX_MARKETPLACE_PATH),
            "plugin": plugin,
            "skill": skill,
            "public_name": public_name,
            "version": version,
            "version_bump": version_bump,
            "planned_actions": {
                "marketplace_entry": claude_action,
                "codex_marketplace": codex_actions,
                "plugin_json": f"would_create (version {version})",
                "readme": "would_keep" if (plugin_dir_path(plugin) / "README.md").exists()
                          else "would_create",
                "relocate": f".agents/skills/{skill} -> ./plugins/{plugin}/skills/{link_name} "
                            f"（実体を移動し、.agents/skills/{skill} を逆 symlink に置換）",
                "bundled_relocations": [
                    f".agents/skills/{dep} -> ./plugins/{plugin}/skills/{dep}"
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

    # 3. Write both catalogs from the validated plan, keeping Codex-only entries intact.
    data = planned_marketplace
    entry_action = claude_action
    write_marketplace(data)
    write_codex_marketplace(codex_data)

    # 4-5. plugin.json / README 生成・スキル実体の移動（本体）
    file_actions = write_plugin_files(plugin, public_name, skill, version,
                                      args.author, args.description, bundle_skills,
                                      args.depends_on or None)
    relocate_action = relocate_skill(plugin, link_name, skill)

    # 4-5b. 依存スキルを同一プラグインに同梱（未登録スキルのみ。既登録は上で中断済み）
    bundled = []
    for dep in bundle_skills:
        dep_action = relocate_skill(plugin, dep, dep)
        bundled.append({"skill": dep, "public_name": frontmatter_name(dep),
                        "relocate": dep_action,
                        "ok": verify_entity(plugin, dep)})

    # 6. 検証: 実体が揃っているか＋配布サブツリーに symlink が 1 つも無いか。
    #    後者が本命。symlink が残っていると Codex の install 先で中身ごと落ちる。
    leftover_symlinks = find_symlinks(plugin)
    entities_ok = verify_entity(plugin, link_name) and all(b["ok"] for b in bundled)
    bundle_ok = entities_ok and not leftover_symlinks

    report = {
        "status": "ok",
        "dry_run": False,
        "created_new": created_new,
        "marketplace_path": str(MARKETPLACE_PATH),
        "codex_marketplace_path": str(CODEX_MARKETPLACE_PATH),
        "plugin": plugin,
        "skill": skill,
        "public_name": public_name,
        "version": version,
        "version_bump": version_bump,
        "actions": {
            "marketplace_entry": entry_action,
            "codex_marketplace": codex_actions,
            "plugin_json": file_actions["plugin_json"],
            "readme": file_actions["readme"],
            "relocate": relocate_action,
        },
        "bundled_skills": bundled,
        "entities_ok": entities_ok,
        "leftover_symlinks": leftover_symlinks,
        "bundle_ok": bundle_ok,
        "next_action":
            f"/plugin install {plugin}@{data.get('name', 'yoshiysh-claude-plugins')} "
            "でインストールして動作確認できます。",
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(EXIT_OK if bundle_ok else EXIT_NO_SKILL)


if __name__ == "__main__":
    main()
