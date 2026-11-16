#!/usr/bin/env python3
"""Run unittest test files in parallel across directories."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def run_single_test(test_dir: str, filename: str, full_path: str):
    cmd = [sys.executable, "-m", "unittest", "discover", "-s", test_dir, "-p", filename]
    env = dict(os.environ)
    extra_paths = []
    scripts_dir = Path(test_dir).parent / "scripts"
    if scripts_dir.is_dir():
        extra_paths.append(str(scripts_dir.resolve()))
    extra_paths.append(str(Path(test_dir).resolve()))
    if "PYTHONPATH" in env and env["PYTHONPATH"]:
        extra_paths.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(extra_paths)

    start = time.perf_counter()
    try:
        proc = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env
        )
        duration = time.perf_counter() - start
        skipped = 0
        m = re.search(r"skipped=(\d+)", proc.stderr)
        if m:
            skipped = int(m.group(1))
        return {
            "full_path": full_path,
            "duration": duration,
            "success": proc.returncode == 0,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "returncode": proc.returncode,
            "skipped": skipped,
        }
    except Exception as exc:
        duration = time.perf_counter() - start
        return {
            "full_path": full_path,
            "duration": duration,
            "success": False,
            "stdout": "",
            "stderr": f"Execution error: {exc}\n",
            "returncode": -1,
            "skipped": 0,
        }


def main():
    default_jobs = min(8, os.cpu_count() or 4)
    parser = argparse.ArgumentParser(description="Run unittest files in parallel")
    parser.add_argument("test_dirs", nargs="*", help="Directories containing test_*.py files")
    parser.add_argument(
        "-j", "--jobs", type=int, default=default_jobs, help=f"Parallel workers (default: {default_jobs})"
    )
    args = parser.parse_args()

    tasks = []
    for test_dir in args.test_dirs:
        p = Path(test_dir)
        if not p.is_dir():
            continue
        for test_file in sorted(p.glob("test_*.py")):
            tasks.append((str(test_dir), test_file.name, str(test_file)))

    if not tasks:
        print("No unittest files found.")
        sys.exit(0)

    total_count = len(tasks)
    passed_count = 0
    failed_count = 0
    skipped_count = 0
    start_total = time.perf_counter()

    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as executor:
        future_to_test = {
            executor.submit(run_single_test, t_dir, fname, fpath): fpath
            for t_dir, fname, fpath in tasks
        }
        for future in as_completed(future_to_test):
            res = future.result()
            num_skipped = res.get("skipped", 0)
            skipped_count += num_skipped
            skip_info = f", {num_skipped} skipped" if num_skipped > 0 else ""
            if res["success"]:
                passed_count += 1
                print(f"  ok   {res['full_path']} ({res['duration']:.2f}s{skip_info})")
            else:
                failed_count += 1
                print(f"  FAIL {res['full_path']} ({res['duration']:.2f}s{skip_info})")
                if res["stdout"]:
                    print(res["stdout"], end="")
                if res["stderr"]:
                    print(res["stderr"], end="", file=sys.stderr)
            sys.stdout.flush()

    total_duration = time.perf_counter() - start_total
    print(
        f"\nRan {total_count} unittest file(s) in {total_duration:.2f}s: "
        f"{passed_count} passed, {skipped_count} skipped, {failed_count} failed."
    )

    if failed_count > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
