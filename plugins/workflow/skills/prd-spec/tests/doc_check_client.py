"""常駐 Node ワーカー (doc_check_worker.mjs) へのクライアント。

Node プロセスの起動オーバーヘッドを削減するため、1 つの常駐ワーカープロセスをオンデマンドで
起動・保持し、テスト間で使い回す。ワーカーの起動や通信に失敗した場合は、従来の
subprocess.run(["node", doc_check.mjs, ...]) へ安全にフォールバックする。
"""

import atexit
import json
import subprocess
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
DOC_CHECK_SCRIPT = SKILL_DIR / "scripts" / "doc_check.mjs"
DOC_CHECK_WORKER = Path(__file__).resolve().parent / "doc_check_worker.mjs"


class WorkerClient:
    def __init__(self):
        self._proc = None

    def _start(self):
        if self._proc is not None and self._proc.poll() is None:
            return self._proc
        self.close()
        self._proc = subprocess.Popen(
            ["node", str(DOC_CHECK_WORKER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            encoding="utf-8",
        )
        return self._proc

    def close(self):
        if self._proc is not None:
            try:
                if self._proc.poll() is None:
                    self._proc.terminate()
                    try:
                        self._proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        self._proc.kill()
                        self._proc.wait()
            except Exception:
                pass
            finally:
                self._proc = None

    def request(self, req):
        proc = self._start()
        payload = json.dumps(req, ensure_ascii=False) + "\n"
        proc.stdin.write(payload)
        proc.stdin.flush()
        line = proc.stdout.readline()
        if not line:
            returncode = proc.poll()
            stderr = proc.stderr.read() if proc.stderr else ""
            self.close()
            raise RuntimeError(f"worker terminated unexpectedly (code {returncode}): {stderr}")
        return json.loads(line)


_client = WorkerClient()
atexit.register(_client.close)


def _fallback_run(ws, mode, args, stdin=None):
    cmd = ["node", str(DOC_CHECK_SCRIPT), mode, *args]
    inp = None
    if stdin is not None:
        inp = stdin if isinstance(stdin, str) else json.dumps(stdin, ensure_ascii=False)
    return subprocess.run(cmd, input=inp, capture_output=True, text=True)


def run_worker(ws, mode, args, stdin=None):
    full_args = [str(a) for a in args]
    if "--workspace" not in full_args:
        full_args.extend(["--workspace", str(ws)])

    norm_stdin = None
    if stdin is not None:
        norm_stdin = stdin if isinstance(stdin, str) else json.dumps(stdin, ensure_ascii=False)

    try:
        res = _client.request({
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
    except Exception:
        _client.close()
        return _fallback_run(ws, mode, full_args, stdin=norm_stdin)
