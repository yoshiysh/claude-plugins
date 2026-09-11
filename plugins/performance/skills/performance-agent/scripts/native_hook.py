"""Plugin-bundled, opt-in native session collection. No model or network calls."""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

from hook_collect import payload
from measure import require
from private_state import transaction


def base():
    return Path(os.environ.get("PERFORMANCE_DATA_DIR", str(Path.home() / ".local/share/yoshiysh-performance")))


def initial():
    return {"version": 1, "policies": []}


def validate(value):
    require(type(value) is dict and set(value) == {"version", "policies"}
            and type(value["version"]) is int and value["version"] == 1
            and type(value["policies"]) is list and len(value["policies"]) <= 64, "policy")
    for p in value["policies"]:
        # project はリテラル "*"（全プロジェクト。ユーザーの明示指定でのみ書かれる）か絶対パス。
        # transcripts は "*" を認めない — 読む範囲の境界（許可 root 配下）は全体適用でも維持する。
        require(type(p) is dict and set(p) == {"host", "project", "transcripts", "enabled"}
                and p["host"] in ("claude", "codex") and type(p["enabled"]) is bool
                and type(p["project"]) is str
                and (p["project"] == "*" or Path(p["project"]).is_absolute())
                and type(p["transcripts"]) is str and Path(p["transcripts"]).is_absolute(),
                "policy_entry")


def prepare(root):
    require(root.is_absolute(), "absolute_data_dir")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0, "private_data_dir")


def configure(host, project, transcripts, enabled, root):
    # project="*" は全プロジェクト適用（--all-projects の明示指定でのみ渡る。推測で書かない）。
    if project != "*":
        project = str(Path(project).resolve(strict=True))
        require(Path(project).is_dir(), "directories_required")
    transcripts = Path(transcripts).resolve(strict=True)
    require(transcripts.is_dir(), "directories_required")
    prepare(root)
    with transaction(root / "policy", initial, validate) as state:
        entry = {"host": host, "project": project, "transcripts": str(transcripts), "enabled": enabled}
        state["policies"] = [p for p in state["policies"]
                             if (p["host"], p["project"]) != (host, project)] + [entry]
    return {"status": "enabled" if enabled else "disabled", "host": host,
            "project": project, "transcript_root": str(transcripts), "data_dir": str(root)}


def select_source(host, event, policies):
    if event.get("hook_event_name") not in ("Stop", "SessionEnd", "UserPromptSubmit"):
        return None
    if event.get("stop_hook_active") is True:
        return None
    for key in ("cwd", "transcript_path", "session_id"):
        require(type(event.get(key)) is str and 0 < len(event[key]) <= 4096, "event_fields")
    source = Path(event["transcript_path"])
    require(source.is_absolute() and not source.is_symlink(), "source_path")
    resolved = source.resolve(strict=True)
    cwd = Path(event["cwd"]).resolve(strict=True)
    # cwd に完全一致する個別 policy が全体適用（"*"）より優先する。個別エントリが disabled なら
    # "*" が enabled でも収集しない — 全体適用の下でもプロジェクト単位の opt-out を残すため。
    # どちらの経路でも transcript は当該 policy の許可 root 配下に限る（読む範囲の境界は不変）。
    exact = next((p for p in policies if p["host"] == host and p["project"] != "*"
                  and cwd == Path(p["project"])), None)
    chosen = exact if exact is not None else next(
        (p for p in policies if p["host"] == host and p["project"] == "*"), None)
    if chosen and chosen["enabled"] and resolved.is_relative_to(Path(chosen["transcripts"])):
        return source
    return None


def hook():
    # Codex documents PLUGIN_ROOT; both hosts document CLAUDE_PLUGIN_ROOT.
    host = "codex" if os.environ.get("PLUGIN_ROOT") else "claude"
    root = base()
    try:
        with transaction(root / "policy", initial, validate, readonly=True) as state:
            policies = state["policies"][:]
        if not any(p["enabled"] and p["host"] == host for p in policies):
            return
        event = payload()
        source = select_source(host, event, policies)
        if source is None:
            return
        # 1s stdin budget + 1s worker fits beneath the host's 3s SessionEnd cap.
        subprocess.run([sys.executable, "-E", "-s", "-B", str(Path(__file__).resolve()),
                        "worker", "--host", host, "--source", str(source),
                        "--session", event["session_id"]], timeout=1,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=False)
    except Exception:
        # Fail-open for user work; never claim missing accounting succeeded.
        return


def main():
    if len(sys.argv) == 1:
        hook()
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("enable", "disable"):
        p = sub.add_parser(action)
        p.add_argument("--host", choices=("claude", "codex"), required=True)
        target = p.add_mutually_exclusive_group(required=True)
        target.add_argument("--project")
        target.add_argument("--all-projects", action="store_true",
                            help="全プロジェクトに適用する（個別 policy が cwd 一致で優先する）")
        p.add_argument("--transcript-root", required=True)
    sub.add_parser("status")
    worker = sub.add_parser("worker")
    worker.add_argument("--host", choices=("claude", "codex"), required=True)
    worker.add_argument("--source", required=True)
    worker.add_argument("--session", required=True)
    args = parser.parse_args()
    if args.action in ("enable", "disable"):
        target = "*" if args.all_projects else args.project
        result = configure(args.host, target, args.transcript_root, args.action == "enable", base())
    elif args.action == "worker":
        import native_collect
        result = native_collect.collect(args.host, args.source, args.session, base() / "native-ledger")
    else:
        import native_collect
        try:
            result = native_collect.report(base() / "native-ledger")
        except FileNotFoundError:
            result = {"status": "no_observations", "usage": None, "quality": "unmeasured"}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
