"""test_prd_stages.py 用の常駐 Node ワーカークライアント。

Node プロセス起動オーバーヘッドを削減するため、常駐 Node ワーカープロセスで
JSON リクエスト/レスポンスをやり取りする。
"""

import atexit
import json
import subprocess
import sys
from pathlib import Path

_worker_proc = None
_worker_path = Path(__file__).resolve().parent / ".stages_worker.mjs"


def _cleanup():
    global _worker_proc
    if _worker_proc is not None:
        try:
            if _worker_proc.poll() is None:
                _worker_proc.terminate()
                try:
                    _worker_proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    _worker_proc.kill()
                    _worker_proc.wait(timeout=1.0)
        except Exception:
            pass
        _worker_proc = None
    if _worker_path.exists():
        try:
            _worker_path.unlink()
        except OSError:
            pass


atexit.register(_cleanup)


def _build_worker_script():
    from test_prd_stages import wrapped_source

    src = wrapped_source(())
    target_start = "const spec = JSON.parse(process.argv[2])\n"
    target_end = (
        "console.log(JSON.stringify({ result, labels, logs, error, findingFiles, prompts, auditSchema, "
        "resolverSchema, disk: { ...onDisk(false), resolutions: rulingRowsOnDisk() }, writerDisk, "
        "docs: disk.docs || {}, heldTimeout, opts: optsSeen, attempted, stubErrors, calls, replayed, "
        "atReads: atReads() }))\n"
    )

    assert target_start in src, "target_start が wrapped_source に見つかりません"
    assert target_end in src, "target_end が wrapped_source に見つかりません"

    func_start = "async function runSingle(spec) {\n  delete globalThis.budget\n  try {\n"
    func_end = (
        "    delete globalThis.budget\n"
        "    return { result, labels, logs, error, findingFiles, prompts, auditSchema, resolverSchema, "
        "disk: { ...onDisk(false), resolutions: rulingRowsOnDisk() }, writerDisk, docs: disk.docs || {}, "
        "heldTimeout, opts: optsSeen, attempted, stubErrors, calls, replayed, atReads: atReads() }\n"
        "  } catch (err) {\n"
        "    delete globalThis.budget\n"
        "    throw err\n"
        "  }\n"
        "}\n"
    )

    body = src.replace(target_start, func_start, 1).replace(target_end, func_end, 1)

    loop_code = """
import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    delete globalThis.budget;
    const req = JSON.parse(trimmed);
    const res = await runSingle(req);
    delete globalThis.budget;
    process.stdout.write(JSON.stringify({ success: true, data: res }) + '\\n');
  } catch (err) {
    delete globalThis.budget;
    const msg = String(err && err.stack ? err.stack : err);
    process.stdout.write(JSON.stringify({ success: false, error: msg }) + '\\n');
  }
}
"""
    return body + loop_code


def _get_worker():
    global _worker_proc
    if _worker_proc is not None:
        if _worker_proc.poll() is None:
            return _worker_proc
        _cleanup()

    try:
        script = _build_worker_script()
        _worker_path.write_text(script, encoding="utf-8")
        proc = subprocess.Popen(
            ["node", str(_worker_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        if proc.poll() is not None:
            _cleanup()
            return None
        _worker_proc = proc
        return _worker_proc
    except Exception:
        _cleanup()
        return None


def run_harness(spec, orig_run_fn, patch=()):
    if patch:
        return orig_run_fn(spec, patch)

    worker = _get_worker()
    if worker is None:
        return orig_run_fn(spec, patch)

    try:
        payload = json.dumps(spec)
        worker.stdin.write(payload + "\n")
        worker.stdin.flush()
        line = worker.stdout.readline()
        if not line:
            _cleanup()
            return orig_run_fn(spec, patch)
        resp = json.loads(line)
        if not resp.get("success"):
            _cleanup()
            return orig_run_fn(spec, patch)
        return resp["data"]
    except Exception:
        _cleanup()
        return orig_run_fn(spec, patch)
