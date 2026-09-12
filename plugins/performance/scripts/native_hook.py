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
    return {"policies": []}


def validate(value):
    require(type(value) is dict and set(value) == {"policies"}
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


# dispatch 記録の上限。1 行 ~300B × 20000 で ~6MB。超過は黙って落とさず打ち切り
# marker を 1 行残す（安い観測ほど残り高い観測が消える偏りを可視化する）。
MAX_DISPATCH_RECORDS = 20000


def dispatch_policy(host, event, policies):
    """Skill dispatch（PreToolUse/PostToolUse, tool_name=Skill）が収集対象かを判定する。

    session 収集と同じ policy で gate する — 有効化した覚えの無い捕捉を作らない。
    """
    if event.get("hook_event_name") not in ("PreToolUse", "PostToolUse"):
        return False
    if event.get("tool_name") != "Skill":
        return False
    for key in ("cwd", "session_id", "tool_use_id"):
        if not (type(event.get(key)) is str and 0 < len(event[key]) <= 4096):
            return False
    cwd = Path(event["cwd"]).resolve(strict=True)
    exact = next((p for p in policies if p["host"] == host and p["project"] != "*"
                  and cwd == Path(p["project"])), None)
    chosen = exact if exact is not None else next(
        (p for p in policies if p["host"] == host and p["project"] == "*"), None)
    return bool(chosen and chosen["enabled"])


def record_dispatch(event, root, now_ms):
    prepare(root / "dispatch")
    path = root / "dispatch" / "records.jsonl"
    lines = 0
    if path.exists():
        with path.open("rb") as f:
            lines = sum(1 for _ in f)
    if lines >= MAX_DISPATCH_RECORDS:
        if lines == MAX_DISPATCH_RECORDS:
            with path.open("a") as f:
                f.write(json.dumps({"censored": "dispatch_record_limit"}) + "\n")
        return
    tool_input = event.get("tool_input") or {}
    row = {
        "captured_at": now_ms,
        "event": event["hook_event_name"],
        "session_id": event["session_id"],
        "tool_use_id": event["tool_use_id"],
        "cwd": event["cwd"],
        "skill": str(tool_input.get("skill", "")),
    }
    if event["hook_event_name"] == "PostToolUse":
        response = event.get("tool_response") or {}
        row["success"] = response.get("success")
        row["duration_ms"] = event.get("duration_ms")
    with path.open("a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    path.chmod(0o600)


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


# 提示の再掲間隔。応答境界ごとに同じ候補を出すと通知が壁紙化するので、提示自体にも
# 間隔を置く（dismiss/defer は queue 側の状態で別管理）。1 日は「次の作業セッションで
# もう一度見える」最短の粒度。
PRESENT_COOLDOWN_S = 86400


def present_notification(root, now_s):
    """pending の改善候補を最大 1 件、1 行で返す（無ければ None）。

    UserPromptSubmit の stdout は host が Claude の文脈に足すので、これが
    「通常の応答境界での提示」の実体になる。読むだけ — queue の状態は変えない
    （dismiss/defer はユーザーの指示で proposals.py CLI が行う）。
    """
    import proposals
    store = root / "proposals"
    if not store.is_dir():
        # queue が一度も作られていない = 提示するものが無い。存在しない store を
        # ここで作らない（作るのは queue に書く側の仕事）。
        return None
    with transaction(store, proposals.initial, proposals.validate,
                     readonly=True) as state:
        pending = [r for r in state["items"] if r["state"] == "pending"]
    if not pending:
        return None
    item = pending[0]
    marker = root / "presented"
    prepare(marker)
    stamp = marker / (item["fingerprint"] + ".at")
    if stamp.exists() and now_s - int(stamp.read_text()) < PRESENT_COOLDOWN_S:
        return None
    stamp.write_text(str(now_s))
    return ("[performance] 改善候補が 1 件 pending です（reason: " + item["reason"]
            + ", fingerprint: " + item["fingerprint"][:12] + "…）。"
            + "詳細は proposals.py list、却下/保留は dismiss/defer。")


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
        if event.get("hook_event_name") == "UserPromptSubmit":
            import time
            line = present_notification(root, int(time.time()))
            if line:
                print(line)
        if dispatch_policy(host, event, policies):
            import time
            record_dispatch(event, root, int(time.time() * 1000))
            return
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
