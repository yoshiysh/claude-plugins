#!/usr/bin/env python3
"""登録済みプラグインを「実際に install して動くか」まで検証するスクリプト（L2＋L3）。

register_plugin.py（登録）＋ claude plugin validate（構造=L1）だけでは
「install 先で実際に解決・展開されるか」は確認できない。本スクリプトは：

- L2（バンドル解決・読み取り専用）：ルートの plugin dir を辿り、Claude 用・Codex 用
  両方の plugin.json が揃って内容一致すること／配布コンポーネント（skills・agents・hooks）を
  1 つ以上持つこと／各スキルが SKILL.md を持つこと／hooks 定義が解釈でき、command が参照する
  同梱ファイルが実在すること／**配布サブツリーに symlink が 1 つも無いこと**を確認する。
- L3（隔離 install スモーク）：一時 marketplace を複製し、HOME を一時ディレクトリに
  差し替えて `claude plugin marketplace add` + `install` を実行する。
  キャッシュに各コンポーネントの資産が実体として展開され、`claude plugin details` の
  Component inventory がそのコンポーネントを 1 件以上数えることを確認する。
  HOME を隔離するため**ユーザーの実 ~/.claude/plugins を一切変更しない**。終了時に確実に後始末する。

plugin はカテゴリ単位で複数スキルを持ちうる（例: plugins/git/skills/{commit,pr-create,...}）。
skills/ 配下のディレクトリ名と公開名は異なってよい（frontmatter の name が優先される仕様のため）。
スキルを持たず hooks だけを配る plugin もある（例: claim-gate・performance）。

L4（実データでの実行）は入力・認証が対象ごとに異なるため本スクリプトには含めない。
司令塔が AskUserQuestion で入力を聞き、install 済みバンドルに対して実行する（SKILL.md 参照）。
"""

import argparse
import functools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".claude" / "skills"
PLUGINS_DIR = PROJECT_ROOT / "plugins"   # 公開用プラグイン dir の置き場
# .claude-plugin/plugin.json だけに載るフィールド（register_plugin.py と揃える）。
CLAUDE_ONLY_FIELDS = ("dependencies",)
CODEX_ONLY_FIELDS = ("interface",)

EXIT_OK = 0
EXIT_FAIL = 5          # 検証失敗（install 先で壊れる）
EXIT_NO_PLUGIN = 3     # 登録されたプラグイン dir が無い

DEFAULT_HOOKS = "hooks/hooks.json"
INVENTORY_LABELS = {"skills": "Skills", "agents": "Agents", "hooks": "Hooks"}
INVENTORY_RE = re.compile(r"^\s*(Skills|Agents|Hooks|MCP servers|LSP servers) \((\d+)\)", re.M)
HOOK_ASSET_RE = re.compile(
    r"\$(?:\{(?:PLUGIN_ROOT:-\$)?CLAUDE_PLUGIN_ROOT\}|CLAUDE_PLUGIN_ROOT\b)/([^\s\"';&|<>)]+)")


class DistributionError(Exception):
    pass


class Distribution(NamedTuple):
    files: set[str]
    untracked: list[str]
    opaque: list[str]


@functools.cache
def git_local_env_vars() -> frozenset[str]:
    try:
        r = subprocess.run(["git", "rev-parse", "--local-env-vars"],
                           capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise DistributionError(f"git で配布集合を決められない: {e}") from e
    return frozenset(r.stdout.split())


def git_env() -> dict[str, str]:
    """リポジトリの位置を固定する環境変数（hook 内実行で継承される GIT_DIR 等）を除いた env。"""
    return {k: v for k, v in os.environ.items() if k not in git_local_env_vars()}


def _ls_files(root: Path, *args: str) -> list[str]:
    try:
        r = subprocess.run(["git", "-C", str(root), "ls-files", "-z", *args, "--", "."],
                           capture_output=True, text=True, env=git_env())
    except (FileNotFoundError, NotADirectoryError) as e:
        raise DistributionError(f"git で配布集合を決められない: {root}: {e}") from e
    if r.returncode != 0:
        raise DistributionError(
            f"git 管理下に無いため配布集合を決められない: {root}: {r.stderr.strip()}")
    return [f for f in r.stdout.split("\0") if f]


def distribution(root: Path) -> Distribution:
    """root 配下で marketplace 経由の install が取得しうるファイルを root 相対で返す。

    marketplace は git リポジトリとして取得されるため、配布されるのは commit 済みのファイル。
    登録直後の未 commit 状態も検証できるよう、gitignore されていない untracked も配布候補として
    含め、commit するまで配布されないものとして untracked に分けて返す。submodule（mode 160000）と
    untracked の入れ子リポジトリは中身が配布集合として見えないので opaque に分ける。
    git 管理外では配布集合を決められないので失敗させる。
    """
    tracked, opaque = set(), []
    for record in _ls_files(root, "--cached", "--stage"):
        meta, path = record.split("\t", 1)
        if meta.split()[0] == "160000":
            opaque.append(path)
        elif os.path.lexists(root / path):
            tracked.add(path)
    untracked = []
    for path in _ls_files(root, "--others", "--exclude-standard"):
        if path.endswith("/"):
            opaque.append(path.rstrip("/"))
        elif os.path.lexists(root / path):
            untracked.append(path)
    return Distribution(tracked | set(untracked), sorted(untracked), sorted(opaque))


def copy_distribution(src: Path, dst: Path) -> None:
    """配布集合だけを symlink を保ったまま複製する。"""
    for rel in sorted(distribution(src).files):
        source, target = src / rel, dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink():
            os.symlink(os.readlink(source), target)
        elif source.is_file():
            shutil.copy2(source, target)


def children(files: set[str], root: str) -> set[str]:
    prefix = "" if root == "." else f"{root}/"
    return {prefix + f[len(prefix):].split("/")[0] for f in files
            if f.startswith(prefix) and not f[len(prefix):].startswith(".")}


def claude_manifest(plugin: str, files: set[str]) -> dict:
    """配布される .claude-plugin/plugin.json を返す。読めない場合の指摘は L2 の manifest 検査が出す。"""
    if ".claude-plugin/plugin.json" not in files:
        return {}
    pj = PLUGINS_DIR / plugin / ".claude-plugin" / "plugin.json"
    try:
        meta = json.loads(pj.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return meta if isinstance(meta, dict) else {}


def declared_paths(value) -> list[str]:
    """manifest のパス宣言（文字列か文字列の配列）を plugin root 相対の正規形で返す。"""
    items = [value] if isinstance(value, str) else value if isinstance(value, list) else []
    return [os.path.normpath(v) for v in items if isinstance(v, str)]


def skill_entries(plugin: str, files: set[str]) -> list[str]:
    """skills/ と manifest の skills 宣言が指す dir 配下で配布されるスキルエントリを列挙する。"""
    entries = set()
    for root in dict.fromkeys(["skills", *declared_paths(claude_manifest(plugin, files).get("skills"))]):
        entries |= children(files, root)
    return sorted(entries)


def agent_entries(plugin: str, files: set[str]) -> list[str]:
    """agents/ と manifest の agents 宣言が指す、配布される agent 定義（*.md）を列挙する。"""
    entries = set()
    for decl in dict.fromkeys(["agents", *declared_paths(claude_manifest(plugin, files).get("agents"))]):
        if decl in files:
            entries.add(decl)
        else:
            entries |= {c for c in children(files, decl) if c in files and c.endswith(".md")}
    return sorted(entries)


def hook_bundle(plugin: str, files: set[str]) -> tuple[list[str], list[str]]:
    """hooks 定義を検査し、(指摘, install 先に実在すべき同梱資産の root 相対パス) を返す。

    Claude Code と Codex は同じ hooks/hooks.json を読む。Codex のパーサは top-level に
    hooks 以外のフィールドがあると hook 全体を無効にする（claim-gate README の実測）。
    """
    plugin_dir = PLUGINS_DIR / plugin
    declared = claude_manifest(plugin, files).get("hooks")
    findings, assets = [], []
    if isinstance(declared, dict):
        findings.append("plugin.json のインライン hooks 宣言は検証できない（hooks.json に分離する）")
    sources = [DEFAULT_HOOKS] if DEFAULT_HOOKS in files else []
    sources += [p for p in declared_paths(declared) if p not in sources]
    for rel in sources:
        if rel not in files:
            findings.append(f"宣言された hooks ファイルが配布されない: {rel}")
            continue
        try:
            config = json.loads((plugin_dir / rel).read_text(encoding="utf-8"))
        except OSError as e:
            findings.append(f"{rel} を読めない: {e}")
            continue
        except json.JSONDecodeError as e:
            findings.append(f"{rel} が不正な JSON: {e}")
            continue
        assets.append(rel)
        if not isinstance(config, dict) or not isinstance(config.get("hooks"), dict):
            findings.append(f"{rel} に hooks オブジェクトが無い")
            continue
        if config.keys() - {"hooks"}:
            findings.append(
                f"{rel} の top-level に hooks 以外のフィールドがある: "
                f"{sorted(config.keys() - {'hooks'})}（Codex で hook 全体が無効になる）")
        handlers = 0
        for event, groups in config["hooks"].items():
            for group in groups if isinstance(groups, list) else [None]:
                group_hooks = group.get("hooks") if isinstance(group, dict) else None
                if not isinstance(group_hooks, list) or not group_hooks:
                    findings.append(f"{rel} の {event} に hooks 配列が無い")
                    continue
                for handler in group_hooks:
                    handlers += 1
                    command = handler.get("command") if isinstance(handler, dict) else None
                    if not isinstance(handler, dict) or not handler.get("type"):
                        findings.append(f"{rel} の {event} に type の無い hook がある")
                    elif handler["type"] == "command" and not isinstance(command, str):
                        findings.append(f"{rel} の {event} に command の無い command hook がある")
                    for asset in HOOK_ASSET_RE.findall(command if isinstance(command, str) else ""):
                        asset = os.path.normpath(asset)
                        if asset == ".." or asset.startswith(("../", "/")):
                            findings.append(f"{rel} の {event} が plugin root 外を参照している: {asset}")
                        elif not (asset in files or children(files, asset)):
                            findings.append(f"{rel} の {event} が参照する同梱ファイルが無い: {asset}")
                        elif asset not in assets:
                            assets.append(asset)
        if not handlers:
            findings.append(f"{rel} に hook が 1 つも無い")
    return findings, assets


def plugin_components(plugin: str, files: set[str]) -> tuple[dict[str, list[str]], list[str]]:
    """配布コンポーネントごとの install 先で実在すべき root 相対パスと、hooks の指摘を返す。"""
    hook_findings, hook_assets = hook_bundle(plugin, files)
    components = {
        "skills": skill_entries(plugin, files),
        "agents": agent_entries(plugin, files),
        "hooks": hook_assets,
    }
    return {k: v for k, v in components.items() if v}, hook_findings


def l2_bundle_check(plugin: str) -> dict:
    """読み取り専用で「コピー後に全資産が解決するか」を検査する。

    最重要は **配布サブツリーに symlink が 1 つも無いこと**。Claude Code は同一 marketplace 内を
    指す symlink を dereference するが、Codex は plugin サブツリーだけを取得して symlink を落とす。
    実測では skills/ が空のまま install が「成功」した。よって「symlink が解決するか」ではなく
    「symlink が存在しないか」を見る。
    """
    findings = []
    plugin_dir = PLUGINS_DIR / plugin
    try:
        dist = distribution(plugin_dir)
    except DistributionError as e:
        return {"passed": False, "findings": [str(e)], "components": [],
                "untracked": {"count": 0, "paths": []}}
    files = dist.files
    for path in dist.opaque:
        findings.append(
            f"入れ子の git リポジトリか submodule がある: {path}"
            "（中身が配布集合として見えず、検査も複製もされない）")
    # plugin.json は Claude 用・Codex 用の両方を要求し、内容一致まで見る。
    manifests = {}
    for manifest_dir in (".claude-plugin", ".codex-plugin"):
        pj = plugin_dir / manifest_dir / "plugin.json"
        if f"{manifest_dir}/plugin.json" not in files:
            findings.append(f"plugin.json が無い: {pj}")
            continue
        try:
            meta = json.loads(pj.read_text(encoding="utf-8"))
            manifests[manifest_dir] = meta
            if not meta.get("name"):
                findings.append(f"{manifest_dir}/plugin.json に name が無い")
        except json.JSONDecodeError as e:
            findings.append(f"{manifest_dir}/plugin.json が不正な JSON: {e}")
    if len(manifests) == 2:
        # dependencies は Claude 固有（Codex に同等機能が無く、未知フィールドの許容も
        # 明記されていない）。共通フィールドだけを比較する。
        shared = {k: {kk: vv for kk, vv in m.items()
                      if kk not in (*CLAUDE_ONLY_FIELDS, *CODEX_ONLY_FIELDS)}
                  for k, m in manifests.items()}
        if shared[".claude-plugin"] != shared[".codex-plugin"]:
            findings.append(
                ".claude-plugin/plugin.json と .codex-plugin/plugin.json の"
                "共通フィールドが一致しない")
        if manifests[".codex-plugin"].keys() & set(CLAUDE_ONLY_FIELDS):
            findings.append(
                ".codex-plugin/plugin.json に Claude 固有フィールドが混入している: "
                f"{sorted(manifests['.codex-plugin'].keys() & set(CLAUDE_ONLY_FIELDS))}")
        if manifests[".claude-plugin"].keys() & set(CODEX_ONLY_FIELDS):
            findings.append(".claude-plugin/plugin.json に Codex 固有フィールドが混入している")
        if "interface" in manifests[".codex-plugin"] and not isinstance(
                manifests[".codex-plugin"]["interface"], dict):
            findings.append("Codex interface は object でなければならない")

    for rel in sorted(files):
        if (plugin_dir / rel).is_symlink():
            findings.append(
                f"配布サブツリーに symlink がある: {rel} "
                f"-> {os.readlink(plugin_dir / rel)}（Codex の install 先で中身ごと落ちる）")

    components, hook_findings = plugin_components(plugin, files)
    findings.extend(hook_findings)
    if not components:
        findings.append(
            "配布コンポーネントが無い: skills/・agents/*.md・hooks/hooks.json と "
            "plugin.json の skills/agents/hooks 宣言のいずれも見つからない")
    for rel in components.get("skills", []):
        if f"{rel}/SKILL.md" not in files:
            findings.append(f"{rel}/SKILL.md が無い")
    return {"passed": not findings, "findings": findings, "components": sorted(components),
            "untracked": {"count": len(dist.untracked), "paths": dist.untracked}}


def declared_dependencies(plugin: str) -> list[str]:
    """.claude-plugin/plugin.json の dependencies を plugin 名のリストで返す。"""
    pj = PLUGINS_DIR / plugin / ".claude-plugin" / "plugin.json"
    if not pj.is_file():
        return []
    try:
        deps = json.loads(pj.read_text(encoding="utf-8")).get("dependencies") or []
    except (json.JSONDecodeError, OSError):
        return []
    # 要素は "name" か {"name": ..., "version": ...} のどちらでもよい。
    names = []
    for d in deps:
        name = d if isinstance(d, str) else (d.get("name") if isinstance(d, dict) else None)
        if name and name not in names:
            names.append(name)
    return names


def _run(cmd, env, timeout=120):
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    out = (r.stdout + r.stderr).strip()
    return r.returncode, out


def installed_root(home: str, marketplace: str, plugin: str) -> Path | None:
    """install キャッシュ上の plugin root（cache/<marketplace>/<plugin>/<version>）を返す。"""
    found = sorted(Path(home, ".claude", "plugins", "cache", marketplace, plugin)
                   .glob("*/.claude-plugin/plugin.json"))
    return found[0].parent.parent if found else None


def is_real_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def is_real_path(path: Path) -> bool:
    return path.exists() and not path.is_symlink()


def l3_component_check(root: Path | None, components: dict[str, list[str]],
                       details_rc: int, details_out: str) -> dict:
    """install 先の資産の実在と、details の Component inventory による認識を突き合わせる。"""
    if root is None:
        return {"passed": False, "installed_root": None}
    per_skill = {}
    for rel in components.get("skills", []):
        skill_dir = root / rel
        scripts = [s for s in sorted((skill_dir / "scripts").iterdir())
                   if not s.is_dir()] if (skill_dir / "scripts").is_dir() else []
        per_skill[Path(rel).name] = {
            "bundled_skill_md": is_real_file(skill_dir / "SKILL.md"),
            "bundled_scripts": [s.name for s in scripts],
            "bundled_scripts_real": all(is_real_file(s) for s in scripts),
        }
    hooks = {rel: is_real_path(root / rel) for rel in components.get("hooks", [])}
    agents = {rel: is_real_file(root / rel) for rel in components.get("agents", [])}
    inventory = {label: int(n) for label, n in INVENTORY_RE.findall(details_out)}
    details_ok = details_rc == 0 and all(
        inventory.get(INVENTORY_LABELS[kind], 0) > 0 for kind in components)
    assets_ok = all(v["bundled_skill_md"] and v["bundled_scripts_real"]
                    for v in per_skill.values()) and all(
        (*hooks.values(), *agents.values()))
    return {
        "skills": per_skill,
        "hooks": hooks,
        "agents": agents,
        "inventory": inventory,
        "details_ok": details_ok,
        "passed": bool(components) and assets_ok and details_ok,
    }


def l3_isolated_install(plugin: str) -> dict:
    """HOME を隔離して実際に install し、バンドル展開とコンポーネント認識を確認する。

    実ホームを汚さないため HOME を一時ディレクトリに差し替える。終了時に全て削除する。
    """
    tmp_mp = tempfile.mkdtemp(prefix="plugin-verify-mp-")
    tmp_home = tempfile.mkdtemp(prefix="plugin-verify-home-")
    result = {"passed": False, "steps": []}
    try:
        mp = Path(tmp_mp)
        (mp / ".claude-plugin").mkdir(parents=True)
        # 本番と同じ深さで複製し、深さ依存も再現する。
        try:
            copy_distribution(PLUGINS_DIR / plugin, mp / "plugins" / plugin)
            if (PROJECT_ROOT / "scripts").is_dir():
                copy_distribution(PROJECT_ROOT / "scripts", mp / "scripts")
        except DistributionError as e:
            result["steps"].append(("distribution", 1, str(e)))
            return result
        mpname = "plugin-verify"
        # plugin.json の dependencies に挙がった plugin も一時 marketplace に含める。
        # 含めないと依存が解決できず、「宣言した plugin 名が実在するか」を検証できない
        # （install 自体は通ってしまうため、typo が素通りする）。
        entries = [{"name": plugin, "source": f"./plugins/{plugin}"}]
        for dep in declared_dependencies(plugin):
            dep_src = PLUGINS_DIR / dep
            if not dep_src.is_dir():
                result["steps"].append(
                    ("dependency missing", 1, f"dependencies に挙がった '{dep}' が plugins/ に無い"))
                return result
            try:
                copy_distribution(dep_src, mp / "plugins" / dep)
            except DistributionError as e:
                result["steps"].append(("distribution", 1, str(e)))
                return result
            entries.append({"name": dep, "source": f"./plugins/{dep}"})
        (mp / ".claude-plugin" / "marketplace.json").write_text(json.dumps(
            {"name": mpname, "owner": {"name": "verify"}, "plugins": entries}),
            encoding="utf-8")

        env = dict(os.environ, HOME=tmp_home)
        rc, out = _run(["claude", "plugin", "marketplace", "add", tmp_mp], env)
        result["steps"].append(("marketplace add", rc, out.splitlines()[-1] if out else ""))
        if rc != 0:
            return result
        rc, out = _run(["claude", "plugin", "install", f"{plugin}@{mpname}"], env)
        result["steps"].append(("install", rc, out.splitlines()[-1] if out else ""))
        if rc != 0:
            return result

        components, _ = plugin_components(plugin, distribution(PLUGINS_DIR / plugin).files)
        rc, out = _run(["claude", "plugin", "details", f"{plugin}@{mpname}"], env)
        result.update(l3_component_check(
            installed_root(tmp_home, mpname, plugin), components, rc, out))
        return result
    finally:
        # 後始末（実ホームは触っていないので tmp を消すだけ）
        shutil.rmtree(tmp_mp, ignore_errors=True)
        shutil.rmtree(tmp_home, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="登録済みプラグインの install 検証（L2+L3）")
    ap.add_argument("--plugin", "--skill", dest="plugin", required=True,
                    help="検証対象の plugin 名（旧 --skill も受け付ける）")
    args = ap.parse_args()
    plugin = args.plugin

    if not (PLUGINS_DIR / plugin / ".claude-plugin" / "plugin.json").exists():
        print(f"ERROR: 登録された plugin dir が見つかりません: {PLUGINS_DIR / plugin}",
              file=sys.stderr)
        sys.exit(EXIT_NO_PLUGIN)

    l2 = l2_bundle_check(plugin)
    l3 = l3_isolated_install(plugin)
    report = {
        "plugin": plugin,
        "l2_bundle_check": l2,
        "l3_isolated_install": l3,
        "overall_passed": l2["passed"] and l3["passed"],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(EXIT_OK if report["overall_passed"] else EXIT_FAIL)


if __name__ == "__main__":
    main()
