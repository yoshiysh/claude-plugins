"""skill_telemetry.py の抽出・集計・記録・比較の契約テスト。

押さえるのは:
1. task output（result で包まれた形）と素の result のどちらからも同じ指標が抜ける
2. 無いフィールドは None のまま残る（欠測を 0 に丸めない）
3. terminal は next_args の有無（null かどうか）で決まる。label の辞書順とは無関係
4. aggregate_run は leg の値を合算するものと終端 leg だけを採るものを分けて扱う
5. 記録ゼロの summary は exit 2（「未計測」を「良好」と区別する）
6. compare は run_id 単位（複数 leg の集計）で対照する
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "skill_telemetry.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "telemetry"

NEEDS_ANSWERS = {
    "result": {
        "status": "needs_answers",
        "open_tbd": [], "holds": [], "missed": [], "integrity": [], "undeclared": {},
        "question_ids": ["RS-001", "RS-002"],
        "next_args": {"state": {"gate": "g0"}},
    },
    "agentCount": 3, "totalTokens": 1000, "totalToolCalls": 10,
}
DONE = {
    "result": {
        "status": "done",
        "open_tbd": ["TBD-1"], "holds": ["RS-009"], "missed": [], "integrity": ["fact-1"],
        "undeclared": {"requirements/a": ["item-1", "item-2"], "requirements/b": []},
        "next_args": None,
        "report_path": "/W/report.md",
    },
    "agentCount": 5, "totalTokens": 2000, "totalToolCalls": 20,
}


def run(args, env_dir):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env={"SKILL_TELEMETRY_DIR": env_dir, "PATH": "/usr/bin:/bin"},
    )


def record(td, skill, label, data, run_id=None, input_ref="", force=False):
    p = Path(td) / f"{label}.src.json"
    p.write_text(json.dumps(data))
    args = ["record", "--skill", skill, "--label", label, "--input-ref", input_ref, str(p)]
    if run_id:
        args = args[:3] + ["--run-id", run_id] + args[3:]
    if force:
        args.append("--force")
    return run(args, td)


class TestExtract(unittest.TestCase):
    def test_taskoutput形とresult素形で同じ記録になる(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(record(td, "s", "raw", NEEDS_ANSWERS["result"]).returncode, 0)
            self.assertEqual(record(td, "s", "wrapped", NEEDS_ANSWERS).returncode, 0)
            a = json.loads((Path(td) / "s" / "raw.json").read_text())
            b = json.loads((Path(td) / "s" / "wrapped.json").read_text())
            self.assertEqual(a["status"], b["status"])
            self.assertEqual(a["question_count"], 2)
            self.assertEqual(a["gate"], "g0")
            self.assertIsNone(a["agent_count"])  # 素の result には task output の meta が無い
            self.assertEqual(b["agent_count"], 3)

    def test_欠測フィールドはNoneのまま残る(self):
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "min", {"status": "blocked"})
            rec = json.loads((Path(td) / "s" / "min.json").read_text())
            self.assertIsNone(rec["remaining_blocking_count"])
            self.assertIsNone(rec["question_count"])
            self.assertIsNone(rec["holds_count"])

    def test_undeclaredは項目数を数える(self):
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "d", DONE)
            rec = json.loads((Path(td) / "s" / "d.json").read_text())
            self.assertEqual(rec["undeclared_count"], 2)  # doc 数(2)ではなく item 数(2+0)

    def test_terminalはnext_argsの有無で決まる(self):
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "na", NEEDS_ANSWERS)
            record(td, "s", "d", DONE)
            na = json.loads((Path(td) / "s" / "na.json").read_text())
            d = json.loads((Path(td) / "s" / "d.json").read_text())
            self.assertFalse(na["terminal"])
            self.assertTrue(d["terminal"])

    def test_hold_draftsはholdsと別に数える(self):
        blocked = {"status": "blocked", "holds": ["RS-009"], "hold_drafts": ["RS-057", "RS-058"],
                   "remaining_blocking": ["r3-gr-a-001", "r3-gr-a-002"], "carried_blocking": ["r3-gr-a-002"], "next_args": None}
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "b", blocked, run_id="run1", input_ref="in1")
            rec = json.loads((Path(td) / "s" / "b.json").read_text())
            self.assertEqual((rec["holds_count"], rec["hold_drafts_count"], rec["remaining_blocking_count"], rec["carried_blocking_count"]), (1, 2, 2, 1))
            tail = [l for l in run(["summary", "--skill", "s"], td).stdout.splitlines() if l.startswith("-- run1")][0]
            self.assertIn("holds=1 hold_drafts=2", tail)
            self.assertIn("remaining_blocking=2 carried_blocking=1", tail)

    def test_止まった理由とパスの数と経路を変えた項目の数を終端legから採る(self):
        blocked = {"status": "blocked", "stop_reason": "no_progress", "passes": 3, "item_routes": {"requirements/a#PR-A-001": "exhausted", "requirements/a#PR-A-002": "hold"}, "next_args": None}
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "b", blocked, run_id="run1", input_ref="in1")
            rec = json.loads((Path(td) / "s" / "b.json").read_text())
            self.assertEqual((rec["stop_reason"], rec["pass_count"], rec["rerouted_count"]), ("no_progress", 3, 2))
            tail = [l for l in run(["summary", "--skill", "s"], td).stdout.splitlines() if l.startswith("-- run1")][0]
            self.assertIn("stop_reason=no_progress passes=3 rerouted=2", tail)

    def test_noticesはintegrityと別に数える(self):
        with tempfile.TemporaryDirectory() as td:
            data = {**DONE["result"], "notices": ["stray-1", "stray-2"]}
            record(td, "s", "n", data)
            rec = json.loads((Path(td) / "s" / "n.json").read_text())
            self.assertEqual(rec["notices_count"], 2)
            self.assertEqual(rec["integrity_count"], 1)
            record(td, "s", "none", DONE)
            self.assertIsNone(json.loads((Path(td) / "s" / "none.json").read_text())["notices_count"])

    def test_起動しなかったagentの件数はlegごとに足す(self):
        with tempfile.TemporaryDirectory() as td:
            skip = {"step": "verifier:3av", "fact": "unchanged", "ids": ["RS-001"]}
            record(td, "s", "leg1", {**NEEDS_ANSWERS, "result": {**NEEDS_ANSWERS["result"], "skipped": [skip]}}, run_id="run1", input_ref="in1")
            record(td, "s", "leg2", {**DONE, "result": {**DONE["result"], "skipped": [skip, {**skip, "step": "verifier:3a'v"}]}}, run_id="run1", input_ref="in1")
            tail = [l for l in run(["summary", "--skill", "s"], td).stdout.splitlines() if l.startswith("-- run1")][0]
            self.assertIn("skipped=3", tail)

    def test_noticesは終端legの値だけを採る(self):
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "leg1", {**NEEDS_ANSWERS, "result": {**NEEDS_ANSWERS["result"], "notices": ["a"]}}, run_id="run1", input_ref="in1")
            record(td, "s", "leg2", {**DONE, "result": {**DONE["result"], "notices": ["a", "b"]}}, run_id="run1", input_ref="in1")
            out = run(["summary", "--skill", "s"], td)
            tail = [l for l in out.stdout.splitlines() if l.startswith("-- run1")][0]
            self.assertIn("notices=2", tail)
            self.assertIn("integrity=1", tail)

    def test_上書きはforceが要る(self):
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "x", DONE)
            self.assertNotEqual(record(td, "s", "x", DONE).returncode, 0)
            self.assertEqual(record(td, "s", "x", DONE, force=True).returncode, 0)


class TestAggregateRun(unittest.TestCase):
    """label の辞書順が実際の順序と食い違っていても、terminal 判定と集計は壊れない。"""

    def test_labelの辞書順が実際の順序と逆でも終端判定は壊れない(self):
        with tempfile.TemporaryDirectory() as td:
            # "z-first" が実際には最初の leg（needs_answers）、"a-last" が最後（done）。
            # 辞書順で並べると a-last が先に来るが、terminal は next_args の有無で決まる。
            record(td, "s", "z-first", NEEDS_ANSWERS, run_id="run1", input_ref="in1")
            record(td, "s", "a-last", DONE, run_id="run1", input_ref="in1")
            out = run(["summary", "--skill", "s"], td)
            self.assertEqual(out.returncode, 0, out.stderr)
            tail = [l for l in out.stdout.splitlines() if l.startswith("-- run1")][0]
            self.assertIn("status=done", tail)  # 終端 leg（DONE）の status を採る

    def test_合算する指標と終端だけを採る指標を分ける(self):
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "leg1", NEEDS_ANSWERS, run_id="run1", input_ref="in1")
            record(td, "s", "leg2", DONE, run_id="run1", input_ref="in1")
            out = run(["summary", "--skill", "s"], td)
            tail = [l for l in out.stdout.splitlines() if l.startswith("-- run1")][0]
            self.assertIn("agents=8", tail)  # 3 + 5（合算）
            self.assertIn("tokens=3000", tail)  # 1000 + 2000（合算）
            self.assertIn("q=2", tail)  # leg1 の question_ids のみ（合算）
            self.assertIn("holds=1", tail)  # 終端 leg(DONE) の holds のみ（合算しない）
            self.assertIn("open_tbd=1", tail)

    def test_終端legが0件または2件以上は未完了扱い(self):
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "only-leg", NEEDS_ANSWERS, run_id="run1", input_ref="in1")
            out = run(["summary", "--skill", "s"], td)
            self.assertIn("未完了", out.stdout)

    def test_input_refが全leg未記録のrunも未完了扱い(self):
        with tempfile.TemporaryDirectory() as td:
            record(td, "s", "leg1", NEEDS_ANSWERS, run_id="run1")  # input_ref 省略（既定 ""）
            record(td, "s", "leg2", DONE, run_id="run1")
            out = run(["summary", "--skill", "s"], td)
            self.assertIn("未完了", out.stdout)


class TestSummary(unittest.TestCase):
    def test_記録ゼロのsummaryはexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(run(["summary", "--skill", "empty"], td).returncode, 2)

    def test_fixture4legで実測どおりに集計される(self):
        """docs/trials/2026-09-27-prd-spec-cleanup-branches/evidence/run-outputs/run1〜4 を
        trim した fixture。実データでの回帰確認（advisor 実測: agents 24 / tools 399 /
        tokens 2,737,996 / questions 13 / 終端 holds 2 / remaining_blocking 2）。"""
        with tempfile.TemporaryDirectory() as td:
            for label in ("run1", "run2", "run3", "run4"):
                data = json.loads((FIXTURES / f"{label}.output.json").read_text())
                self.assertEqual(
                    record(td, "prd-spec", label, data, run_id="cleanup", input_ref="cleanup-branches").returncode,
                    0,
                )
            out = run(["summary", "--skill", "prd-spec"], td)
            self.assertEqual(out.returncode, 0, out.stderr)
            tail = [l for l in out.stdout.splitlines() if l.startswith("-- cleanup ")][0]
            self.assertIn("legs=4", tail)
            self.assertIn("status=blocked", tail)
            self.assertIn("agents=24", tail)
            self.assertIn("tools=399", tail)
            self.assertIn("tokens=2737996", tail)
            self.assertIn("q=13", tail)
            self.assertIn("holds=2", tail)
            self.assertIn("remaining_blocking=2", tail)
            self.assertIn("notices=None", tail)  # notices・hold_drafts・収束の欄が無かった版の実測なので欠測のまま残る
            absent = ("notices=None", "hold_drafts=None", "carried_blocking=None", "stop_reason=None", "passes=None", "rerouted=None", "skipped=None")
            for field in absent:
                tail = tail.replace(field, "")
            self.assertNotIn("None", tail)


class TestCompare(unittest.TestCase):
    def _seed_run(self, td, run_id, input_ref="args-v1"):
        record(td, "s", f"{run_id}-g0", NEEDS_ANSWERS, run_id=run_id, input_ref=input_ref)
        record(td, "s", f"{run_id}-done", DONE, run_id=run_id, input_ref=input_ref)

    def test_run_idが欠けていればexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self._seed_run(td, "ctrl")
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "total_tokens", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 2)

    def test_未完了runはexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self._seed_run(td, "ctrl")
            record(td, "s", "trt-only", NEEDS_ANSWERS, run_id="trt", input_ref="args-v1")
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "total_tokens", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 2)

    def test_input_refが一致しないrunはexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self._seed_run(td, "ctrl", input_ref="args-v1")
            self._seed_run(td, "trt", input_ref="args-v2")
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "total_tokens", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 2)

    def test_指標が数値で取れなければexit2(self):
        with tempfile.TemporaryDirectory() as td:
            self._seed_run(td, "ctrl")
            self._seed_run(td, "trt")
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "gate", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 2)

    def test_揃っていれば向きと閾値からfavoredを決める(self):
        with tempfile.TemporaryDirectory() as td:
            self._seed_run(td, "ctrl")  # total_tokens 合算 = 1000 + 2000 = 3000
            record(td, "s", "trt-g0", NEEDS_ANSWERS, run_id="trt", input_ref="args-v1")
            cheap_done = json.loads(json.dumps(DONE))
            cheap_done["totalTokens"] = 500
            record(td, "s", "trt-done", cheap_done, run_id="trt", input_ref="args-v1")
            out = run(
                ["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                 "--metric", "total_tokens", "--lower-is-better", "--threshold", "0"], td
            )
            self.assertEqual(out.returncode, 0, out.stderr)
            payload = json.loads(out.stdout)
            self.assertEqual(payload["control"]["value"], 3000.0)
            self.assertEqual(payload["treatment"]["value"], 1500.0)
            self.assertEqual(payload["favored"], "treatment")

    def test_criteria_fileから基準を読む(self):
        with tempfile.TemporaryDirectory() as td:
            self._seed_run(td, "ctrl")
            self._seed_run(td, "trt")
            criteria_file = Path(td) / "criteria.json"
            criteria_file.write_text(json.dumps({
                "criteria": {"metric": "total_tokens", "higher_is_better": False, "threshold": 0}}))
            out = run(["compare", "--skill", "s", "--control", "ctrl", "--treatment", "trt",
                       "--criteria-file", str(criteria_file)], td)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(json.loads(out.stdout)["favored"], "tie")

    def test_criteria_fileと手入力の併用は拒否(self):
        with tempfile.TemporaryDirectory() as td:
            criteria_file = Path(td) / "criteria.json"
            criteria_file.write_text(json.dumps({
                "criteria": {"metric": "m", "higher_is_better": True, "threshold": 0}}))
            out = run(["compare", "--skill", "s", "--control", "c", "--treatment", "t",
                       "--criteria-file", str(criteria_file), "--metric", "other"], td)
            self.assertEqual(out.returncode, 2)

    def test_不正なcriteriaの基準ファイルはexit2(self):
        with tempfile.TemporaryDirectory() as td:
            criteria_file = Path(td) / "criteria.json"
            criteria_file.write_text(json.dumps({
                "criteria": {"metric": "m", "higher_is_better": "yes", "threshold": 0}}))
            out = run(["compare", "--skill", "s", "--control", "c", "--treatment", "t",
                       "--criteria-file", str(criteria_file)], td)
            self.assertEqual(out.returncode, 2)


if __name__ == "__main__":
    unittest.main()
