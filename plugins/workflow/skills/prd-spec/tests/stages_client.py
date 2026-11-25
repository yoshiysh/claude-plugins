"""test_prd_stages.py 用の常駐 Node ワーカークライアント。

Node プロセス起動オーバーヘッドを削減するため、常駐 Node ワーカープロセスで
JSON リクエスト/レスポンスをやり取りする。
"""

import atexit
import json
from pathlib import Path
import shutil
import tempfile

from node_worker import NodeWorker

_worker = None
_tmpdir = None


def _cleanup():
    global _worker, _tmpdir
    w = _worker
    _worker = None
    if w is not None:
        w.close()
    if _tmpdir is not None:
        shutil.rmtree(_tmpdir, ignore_errors=True)
        _tmpdir = None


atexit.register(_cleanup)


def _build_worker_script():
    from test_prd_stages import wrapped_source

    src = wrapped_source(())
    target_start = "const spec = JSON.parse(process.argv[2])\n"
    target_end = (
        "console.log(JSON.stringify({ result, labels, logs, error, findingFiles, prompts, auditSchema, "
        "resolverSchema, disk: { ...onDisk(false), resolutions: rulingRowsOnDisk() }, writerDisk, "
        "docs: disk.docs || {}, opts: optsSeen, attempted, stubErrors, calls, replayed, "
        "atReads: atReads() }))\n"
    )

    assert target_start in src, "target_start が wrapped_source に見つかりません"
    assert target_end in src, "target_end が wrapped_source に見つかりません"

    func_start = "async function runSingle(spec) {\n  delete globalThis.budget\n  try {\n"
    func_end = (
        "    delete globalThis.budget\n"
        "    return { result, labels, logs, error, findingFiles, prompts, auditSchema, resolverSchema, "
        "disk: { ...onDisk(false), resolutions: rulingRowsOnDisk() }, writerDisk, docs: disk.docs || {}, "
        "opts: optsSeen, attempted, stubErrors, calls, replayed, atReads: atReads() }\n"
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
    global _worker, _tmpdir
    if _worker is not None and _worker.is_alive():
        return _worker

    _cleanup()
    _tmpdir = tempfile.mkdtemp(prefix="stages_worker_")
    worker_path = Path(_tmpdir) / "worker.mjs"
    script = _build_worker_script()
    worker_path.write_text(script, encoding="utf-8")
    _worker = NodeWorker(worker_path, cleanup_callback=_cleanup)
    return _worker


def run_harness(spec, orig_run_fn, patch=()):
    if patch:
        return orig_run_fn(spec, patch)

    worker = _get_worker()
    resp = worker.send_and_receive(spec)
    if not resp.get("success"):
        err = resp.get("error", "unknown worker error")
        raise RuntimeError(f"stages worker failed: {err}")
    return resp["data"]
