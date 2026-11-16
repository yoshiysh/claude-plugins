"""常駐 Node ワーカー (doc_check_worker.mjs) へのクライアント。

Node プロセスの起動オーバーヘッドを削減するため、1 つの常駐ワーカープロセスをオンデマンドで
起動・保持し、テスト間で使い回す。ワーカーの起動や通信初期に失敗した場合は、従来の
subprocess.run(["node", doc_check.mjs, ...]) へ安全にフォールバックする。
"""

import json
from pathlib import Path
import subprocess
import sys

from node_worker import NodeWorker, WorkerSendError

SKILL_DIR = Path(__file__).resolve().parents[1]
DOC_CHECK_SCRIPT = SKILL_DIR / "scripts" / "doc_check.mjs"
DOC_CHECK_WORKER = Path(__file__).resolve().parent / "doc_check_worker.mjs"

_worker = NodeWorker(DOC_CHECK_WORKER)


def _fallback_run(cmd, stdin):
    sys.stderr.write("[doc_check_client] warning: falling back to direct node execution\n")
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True)


def run_worker(ws, mode, args, stdin=None):
    full_args = [str(a) for a in args]
    if "--workspace" not in full_args:
        full_args.extend(["--workspace", str(ws)])

    norm_stdin = None
    if stdin is not None:
        norm_stdin = stdin if isinstance(stdin, str) else json.dumps(stdin, ensure_ascii=False)

    try:
        res = _worker.send_and_receive({
            "mode": mode,
            "args": full_args,
            "stdin": norm_stdin,
        })
        return subprocess.CompletedProcess(
            args=["node", str(DOC_CHECK_WORKER), mode, *full_args],
            returncode=res["returncode"],
            stdout=res["stdout"],
            stderr=res["stderr"],
        )
    except WorkerSendError:
        cmd = ["node", str(DOC_CHECK_SCRIPT), mode, *full_args]
        return _fallback_run(cmd, norm_stdin)
