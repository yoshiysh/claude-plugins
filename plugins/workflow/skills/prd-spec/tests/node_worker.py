"""常駐 Node ワーカープロセスのライフサイクルを管理する共通基盤。"""

import atexit
import json
from pathlib import Path
import subprocess
from typing import Any, Callable, Optional, Union


class WorkerError(Exception):
    """NodeWorker の基底例外"""
    pass


class WorkerSendError(WorkerError):
    """ワーカー起動またはリクエスト書き込み完了前のエラー"""
    pass


class WorkerResponseError(WorkerError):
    """リクエスト書き込み完了後のエラー"""
    pass


class NodeWorker:
    """常駐 Node ワーカープロセスの管理クラス。"""

    def __init__(
        self,
        script_path: Union[str, Path, Callable[[], Union[str, Path]]],
        cleanup_callback: Optional[Callable[[], Any]] = None,
    ):
        self._script_path = script_path
        self._cleanup_callback = cleanup_callback
        self._proc: Optional[subprocess.Popen] = None
        atexit.register(self.close)

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _resolve_script_path(self) -> str:
        if callable(self._script_path):
            return str(self._script_path())
        return str(self._script_path)

    def _stop_proc(self) -> None:
        if self._proc is not None:
            try:
                if self._proc.poll() is None:
                    self._proc.terminate()
                    try:
                        self._proc.wait(timeout=1.0)
                    except subprocess.TimeoutExpired:
                        self._proc.kill()
                        self._proc.wait(timeout=1.0)
            except Exception:
                pass
            finally:
                self._proc = None

    def _start(self) -> subprocess.Popen:
        if self.is_alive():
            return self._proc  # type: ignore[return-value]

        self._stop_proc()
        target = self._resolve_script_path()
        try:
            self._proc = subprocess.Popen(
                ["node", target],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                encoding="utf-8",
            )
        except Exception as exc:
            raise WorkerSendError(f"failed to spawn node worker: {exc}") from exc

        if self._proc.poll() is not None:
            rc = self._proc.returncode
            err = self._proc.stderr.read() if self._proc.stderr else ""
            self._stop_proc()
            raise WorkerSendError(f"worker exited immediately with code {rc}: {err}")

        return self._proc

    def close(self) -> None:
        self._stop_proc()
        if self._cleanup_callback is not None:
            cb = self._cleanup_callback
            self._cleanup_callback = None
            try:
                cb()
            except Exception:
                pass

    def send_and_receive(self, payload: dict) -> dict:
        try:
            proc = self._start()
            line = json.dumps(payload, ensure_ascii=False) + "\n"
            proc.stdin.write(line)
            proc.stdin.flush()
        except Exception as exc:
            self.close()
            raise WorkerSendError(f"failed to send request to worker: {exc}") from exc

        try:
            resp_line = proc.stdout.readline()
        except Exception as exc:
            self.close()
            raise WorkerResponseError(f"failed to read response from worker: {exc}") from exc

        if not resp_line:
            rc = proc.poll()
            err = proc.stderr.read() if proc.stderr else ""
            self.close()
            raise WorkerResponseError(f"worker terminated unexpectedly (code {rc}): {err}")

        try:
            return json.loads(resp_line)
        except json.JSONDecodeError as exc:
            self.close()
            raise WorkerResponseError(f"invalid JSON response from worker: {exc}") from exc
