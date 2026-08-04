#!/usr/bin/env python3
"""登録済みプラグインを「実際に install して動くか」まで検証するスクリプト（L2＋L3）。

register_plugin.py（登録）＋ claude plugin validate（構造=L1）だけでは
「install 先で実際に解決・展開されるか」は確認できない。本スクリプトは：

- L2（バンドル解決・読み取り専用）：ルートの plugin dir を辿り、
  plugin.json の妥当性／skills/ 配下の各 symlink が SKILL.md へ解決すること／
  スキル配下に dangling な symlink が無いことを確認する。
- L3（隔離 install スモーク）：一時 marketplace を複製し、HOME を一時ディレクトリに
  差し替えて `claude plugin marketplace add` + `install` を実行する。
  キャッシュにバンドル（symlink が実体コピーへ解決された結果）が展開され、
  `claude plugin details` でスキルが認識されることを確認する。
  HOME を隔離するため**ユーザーの実 ~/.claude/plugins を一切変更しない**。終了時に確実に後始末する。

plugin はカテゴリ単位で複数スキルを持ちうる（例: plugins/git/skills/{commit,pr-create,...}）。
skills/ 配下のエントリ名（公開名）とリンク先の実体ディレクトリ名は異なってよい
（frontmatter の name が優先される仕様のため）。

L4（実データでの実行）は入力・認証が対象ごとに異なるため本スクリプトには含めない。
司令塔が AskUserQuestion で入力を聞き、install 済みバンドルに対して実行する（SKILL.md 参照）。
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".claude" / "skills"
PLUGINS_DIR = PROJECT_ROOT / "plugins"   # 公開用プラグイン dir の置き場

EXIT_OK = 0
EXIT_FAIL = 5          # 検証失敗（install 先で壊れる）
EXIT_NO_PLUGIN = 3     # 登録されたプラグイン dir が無い


def skill_entries(plugin: str) -> list[Path]:
    """plugins/<plugin>/skills/ 配下のスキルエントリ（symlink）を列挙する。"""
    skills_dir = PLUGINS_DIR / plugin / "skills"
    if not skills_dir.is_dir():
        return []
    return sorted(p for p in skills_dir.iterdir() if not p.name.startswith("."))


def l2_bundle_check(plugin: str) -> dict:
    """読み取り専用で「コピー後に全資産が解決するか」を検査する。"""
    findings = []
    plugin_dir = PLUGINS_DIR / plugin
    # plugin.json
    pj = plugin_dir / ".claude-plugin" / "plugin.json"
    if not pj.is_file():
        findings.append(f"plugin.json が無い: {pj}")
    else:
        try:
            meta = json.loads(pj.read_text(encoding="utf-8"))
            if not meta.get("name"):
                findings.append("plugin.json に name が無い")
        except json.JSONDecodeError as e:
            findings.append(f"plugin.json が不正な JSON: {e}")
    entries = skill_entries(plugin)
    if not entries:
        findings.append(f"skills/ 配下にスキルエントリが無い: {plugin_dir / 'skills'}")
    for linked_skill in entries:
        # skills/<公開名> symlink → SKILL.md
        if not (linked_skill / "SKILL.md").is_file():
            findings.append(f"skills/{linked_skill.name}/SKILL.md がリンク経由で解決しない")
            continue
        # スキル配下の dangling symlink 検出（リンクを辿って実体が無いもの）
        real = linked_skill.resolve()
        for p in real.rglob("*"):
            if p.is_symlink() and not p.exists():
                findings.append(
                    f"dangling symlink ({linked_skill.name}): "
                    f"{p.relative_to(real)} -> {os.readlink(p)}")
    return {"passed": not findings, "findings": findings}


def _run(cmd, env, timeout=120):
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    out = (r.stdout + r.stderr).strip()
    return r.returncode, out


def l3_isolated_install(plugin: str) -> dict:
    """HOME を隔離して実際に install し、バンドル展開とスキル認識を確認する。

    実ホームを汚さないため HOME を一時ディレクトリに差し替える。終了時に全て削除する。
    """
    tmp_mp = tempfile.mkdtemp(prefix="plugin-verify-mp-")
    tmp_home = tempfile.mkdtemp(prefix="plugin-verify-home-")
    result = {"passed": False, "steps": []}
    try:
        mp = Path(tmp_mp)
        (mp / ".claude-plugin").mkdir(parents=True)
        (mp / ".claude" / "skills").mkdir(parents=True)
        # プラグイン dir を symlink 保持で複製し、参照される実体スキルを全て複製する。
        # 本番と同じ深さ（plugins/<plugin>）で複製しないと相対 symlink が解決しない。
        shutil.copytree(PLUGINS_DIR / plugin, mp / "plugins" / plugin, symlinks=True)
        for entry in skill_entries(plugin):
            real = entry.resolve()
            dest = mp / ".claude" / "skills" / real.name
            if not dest.exists():
                shutil.copytree(real, dest, symlinks=True)
        if (PROJECT_ROOT / "scripts").is_dir():
            shutil.copytree(PROJECT_ROOT / "scripts", mp / "scripts")
        mpname = "plugin-verify"
        (mp / ".claude-plugin" / "marketplace.json").write_text(json.dumps(
            {"name": mpname, "owner": {"name": "verify"},
             "plugins": [{"name": plugin, "source": f"./plugins/{plugin}"}]}), encoding="utf-8")

        env = dict(os.environ, HOME=tmp_home)
        rc, out = _run(["claude", "plugin", "marketplace", "add", tmp_mp], env)
        result["steps"].append(("marketplace add", rc, out.splitlines()[-1] if out else ""))
        if rc != 0:
            return result
        rc, out = _run(["claude", "plugin", "install", f"{plugin}@{mpname}"], env)
        result["steps"].append(("install", rc, out.splitlines()[-1] if out else ""))
        if rc != 0:
            return result

        # 各スキルの SKILL.md がキャッシュ上で実体（symlink でない）として展開されたか
        all_ok = True
        per_skill = {}
        for entry in skill_entries(plugin):
            cache = glob.glob(
                f"{tmp_home}/.claude/plugins/cache/**/skills/{entry.name}/SKILL.md",
                recursive=True)
            skill_md_ok = (bool(cache) and Path(cache[0]).is_file()
                           and not Path(cache[0]).is_symlink())
            # バンドルされた scripts も実体か（あれば）
            cache_dir = Path(cache[0]).parent if cache else None
            scripts_ok = True
            bundled_scripts = []
            if cache_dir and (cache_dir / "scripts").is_dir():
                for s in (cache_dir / "scripts").iterdir():
                    if s.is_dir():
                        continue  # __pycache__ などのディレクトリは対象外
                    bundled_scripts.append(s.name)
                    if s.is_symlink() or not s.is_file():
                        scripts_ok = False
            per_skill[entry.name] = {
                "bundled_skill_md": skill_md_ok,
                "bundled_scripts": bundled_scripts,
                "bundled_scripts_real": scripts_ok,
            }
            all_ok = all_ok and skill_md_ok and scripts_ok
        result["skills"] = per_skill
        # skill 認識
        rc, out = _run(["claude", "plugin", "details", f"{plugin}@{mpname}"], env)
        details_ok = rc == 0 and ("Skills" in out)
        result["details_ok"] = details_ok
        result["passed"] = all_ok and details_ok and bool(per_skill)
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
