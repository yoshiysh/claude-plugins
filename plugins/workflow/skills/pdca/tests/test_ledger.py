"""ledger.py の追記・読み出し・改竄検出の契約テスト。

押さえるのは 4 つ。
1. seq は台帳の行数で採番され、呼び出し側の申告では動かない
2. 追記は既存行を一切変えない（append-only）
3. 行の削除・並べ替えは validate / read で落ちる（黙って通らない）
4. 未知の type と必須欄の欠落は追記前に落ち、壊れた entry がファイルに入らない
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ledger.py"


def run(*argv, stdin=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *argv],
        input=stdin,
        capture_output=True,
        text=True,
    )


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "ledger.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def append(self, entries):
        return run("append", "--path", str(self.path), "--json", json.dumps(entries))

    def test_seq_is_assigned_by_the_file_not_the_caller(self):
        self.append([{"type": "plan_v", "phase": "Plan", "summary": "v1", "seq": 99}])
        self.append([{"type": "review_v", "phase": "Plan", "summary": "findings 2 件"}])
        entries = json.loads(run("read", "--path", str(self.path)).stdout)
        self.assertEqual([e["seq"] for e in entries], [1, 2])

    def test_append_does_not_rewrite_existing_lines(self):
        self.append([{"type": "plan_v", "phase": "Plan", "summary": "v1"}])
        first = self.path.read_text(encoding="utf-8").splitlines()[0]
        self.append([{"type": "resolution", "phase": "Plan", "summary": "descope", "refs": [1]}])
        self.assertEqual(self.path.read_text(encoding="utf-8").splitlines()[0], first)

    def test_deleted_line_is_detected(self):
        self.append(
            [
                {"type": "plan_v", "phase": "Plan", "summary": "v1"},
                {"type": "plan_v", "phase": "Plan", "summary": "v2"},
            ]
        )
        lines = self.path.read_text(encoding="utf-8").splitlines()
        self.path.write_text(lines[1] + "\n", encoding="utf-8")
        self.assertEqual(run("validate", "--path", str(self.path)).returncode, 1)

    def test_unknown_type_is_rejected_before_writing(self):
        result = self.append([{"type": "whatever", "phase": "Plan", "summary": "x"}])
        self.assertEqual(result.returncode, 1)
        self.assertFalse(self.path.exists())

    def test_missing_required_field_is_rejected(self):
        self.assertEqual(self.append([{"type": "plan_v", "phase": "Plan"}]).returncode, 1)

    def test_read_can_filter_by_type(self):
        self.append(
            [
                {"type": "plan_v", "phase": "Plan", "summary": "v1"},
                {"type": "resolution", "phase": "Plan", "summary": "class 変更", "refs": [1]},
            ]
        )
        entries = json.loads(run("read", "--path", str(self.path), "--types", "resolution").stdout)
        self.assertEqual([e["type"] for e in entries], ["resolution"])

    def test_stdin_payload_is_accepted(self):
        run(
            "append",
            "--path",
            str(self.path),
            stdin=json.dumps({"type": "note", "phase": "Do", "summary": "観測"}),
        )
        self.assertEqual(len(json.loads(run("read", "--path", str(self.path)).stdout)), 1)


if __name__ == "__main__":
    unittest.main()
