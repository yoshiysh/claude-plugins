"""check_blocking_rate.py の回帰テスト。

実測（自己適用で blocking 59 件・56 件未提示）をフィクスチャにして、
「blocking の乱発が容量超過として検出されること」と
「欠測（tbd_items 無し）が 0 件＝合格に化けないこと」を固定する。
"""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check_blocking_rate.py"

spec = importlib.util.spec_from_file_location("check_blocking_rate", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def tbd(n_blocking: int, n_non_blocking: int) -> list:
    items = [{"id": f"TBD-B-{i:03d}", "blocking": True} for i in range(n_blocking)]
    items += [{"id": f"TBD-N-{i:03d}", "blocking": False} for i in range(n_non_blocking)]
    return items


def run_cli(payload, *extra_args):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(payload, f)
        path = f.name
    return subprocess.run(
        [sys.executable, str(SCRIPT), path, *extra_args],
        capture_output=True,
        text=True,
    )


class TestAnalyze(unittest.TestCase):
    def test_measured_regression_59_blocking_is_over_capacity(self):
        # 実測値のフィクスチャ: blocking 59 / 全 TBD 74（59 + 進行可能 15）
        result = mod.analyze(tbd(59, 15), warn_over=20, fail_over=40)
        self.assertEqual(result["verdict"], "over_capacity")
        self.assertEqual(result["blocking"], 59)

    def test_calibrated_run_is_ok(self):
        result = mod.analyze(tbd(5, 30), warn_over=20, fail_over=40)
        self.assertEqual(result["verdict"], "ok")

    def test_between_thresholds_is_near_capacity(self):
        result = mod.analyze(tbd(25, 10), warn_over=20, fail_over=40)
        self.assertEqual(result["verdict"], "near_capacity")

    def test_boundary_exactly_at_fail_over_is_not_over(self):
        # 「超えたら」なので 40 ちょうどは容量内（near_capacity）
        result = mod.analyze(tbd(40, 0), warn_over=20, fail_over=40)
        self.assertEqual(result["verdict"], "near_capacity")

    def test_zero_tbd_rate_is_null_not_zero_division(self):
        result = mod.analyze([], warn_over=20, fail_over=40)
        self.assertIsNone(result["blocking_rate"])
        self.assertEqual(result["verdict"], "ok")


class TestCli(unittest.TestCase):
    def test_over_capacity_exits_1(self):
        proc = run_cli({"tbd_items": tbd(59, 15)})
        self.assertEqual(proc.returncode, 1)
        self.assertIn("over_capacity", proc.stdout)

    def test_ok_exits_0(self):
        proc = run_cli({"tbd_items": tbd(3, 5)})
        self.assertEqual(proc.returncode, 0)

    def test_missing_tbd_items_is_unmeasured_not_pass(self):
        # 欠測が exit 0（合格）に化けると「計測していない」が「較正済み」に見える
        proc = run_cli({"documents": []})
        self.assertEqual(proc.returncode, 2)

    def test_broken_json_is_unmeasured(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("{not json")
            path = f.name
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), path], capture_output=True, text=True
        )
        self.assertEqual(proc.returncode, 2)

    def test_bare_list_input_is_accepted(self):
        proc = run_cli(tbd(2, 2))
        self.assertEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
