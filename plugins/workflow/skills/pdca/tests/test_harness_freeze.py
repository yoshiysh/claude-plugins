"""harness_freeze.py の凍結・照合の契約テスト。

押さえるのは 7 つ。
1. 凍結は run-dir 配下に複製を作り、digest つきの ledger entry を返す
2. 凍結後に凍結物を書き換えると verify が exit 1 で落ちる（凍結の意味はここにある）
3. 二重凍結は拒否される（Do の途中で harness を差し替える経路を塞ぐ）
4. 凍結先が harness の置き場の内側なら拒否される（builder の作業ツリーに同居させない）
5. 未知の class・空の files は複製前に落ちる
6. verify は freeze が返した path をそのまま受け付ける（親の推測を要求しない）
7. source-root の前方一致で外部ディレクトリを拾わない
"""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "harness_freeze.py"

SPEC = {
    "class": "deterministic_script",
    "criteria": {"metric": "pass_rate", "higher_is_better": True, "threshold": 0},
    "entry": "score.py",
    "files": ["score.py", "fixtures/cases.json"],
}


def run(*argv):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *argv], capture_output=True, text=True
    )


class HarnessFreezeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.source = root / "harness"
        (self.source / "fixtures").mkdir(parents=True)
        (self.source / "score.py").write_text("print(1)\n", encoding="utf-8")
        (self.source / "fixtures" / "cases.json").write_text('{"a": 1}\n', encoding="utf-8")
        self.run_dir = root / "workspace" / "run-1"
        self.run_dir.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def freeze(self, spec=None):
        return run(
            "freeze",
            "--run-dir",
            str(self.run_dir),
            "--source-root",
            str(self.source),
            "--json",
            json.dumps(spec or SPEC),
        )

    def test_凍結は複製とledger_entryを返す(self):
        out = self.freeze()
        self.assertEqual(out.returncode, 0, out.stderr)
        payload = json.loads(out.stdout)
        self.assertEqual(payload["ledger_entry"]["type"], "harness_frozen")
        self.assertEqual(payload["frozenHarness"]["file_count"], 2)
        self.assertTrue((self.run_dir / "frozen" / "score.py").is_file())
        self.assertTrue((self.run_dir / "frozen" / "fixtures" / "cases.json").is_file())
        self.assertEqual(
            run("verify", "--run-dir", str(self.run_dir), "--expect", payload["frozenHarness"]["digest"]).returncode,
            0,
        )

    def test_verifyはfreezeが返したpathをそのまま受け付ける(self):
        # 照合する agent は frozenHarness.path を渡す。ここで親の推測を要求すると、
        # 呼び方を間違えただけで「凍結が破れている」判定になり run が止まる。
        payload = json.loads(self.freeze().stdout)
        path = payload["frozenHarness"]["path"]
        self.assertEqual(
            run("verify", "--run-dir", path, "--expect", payload["frozenHarness"]["digest"]).returncode,
            0,
        )
        # run-dir 形でも同じ結果になる（どちらでも通る）
        self.assertEqual(run("verify", "--run-dir", str(self.run_dir)).returncode, 0)

    def test_source_rootの前方一致では外部を拾わない(self):
        # /tmp/harness-evil を /tmp/harness の内側と誤判定しないこと。
        sibling = self.source.parent / f"{self.source.name}-evil"
        sibling.mkdir()
        (sibling / "leak.py").write_text("print(3)\n", encoding="utf-8")
        out = self.freeze(
            {"class": "deterministic_script", "entry": "score.py", "files": ["score.py", "../harness-evil/leak.py"], "criteria": {"metric": "m", "higher_is_better": True, "threshold": 0}}
        )
        self.assertEqual(out.returncode, 2)

    def test_凍結物の書き換えはverifyで落ちる(self):
        self.freeze()
        (self.run_dir / "frozen" / "score.py").write_text("print(2)\n", encoding="utf-8")
        out = run("verify", "--run-dir", str(self.run_dir))
        self.assertEqual(out.returncode, 1)
        self.assertFalse(json.loads(out.stdout)["ok"])

    def test_凍結物の欠落もverifyで落ちる(self):
        self.freeze()
        (self.run_dir / "frozen" / "fixtures" / "cases.json").unlink()
        self.assertEqual(run("verify", "--run-dir", str(self.run_dir)).returncode, 1)

    def test_二重凍結は拒否される(self):
        self.freeze()
        self.assertEqual(self.freeze().returncode, 2)

    def test_凍結先がsource_rootの内側なら拒否される(self):
        out = run(
            "freeze",
            "--run-dir",
            str(self.source / "ws"),
            "--source-root",
            str(self.source),
            "--json",
            json.dumps(SPEC),
        )
        self.assertEqual(out.returncode, 2)

    def test_未知のclassと空のfilesは複製前に落ちる(self):
        self.assertEqual(self.freeze({**SPEC, "class": "vibes"}).returncode, 2)
        self.assertEqual(self.freeze({**SPEC, "files": []}).returncode, 2)
        self.assertFalse((self.run_dir / "frozen").exists())

    def test_entryがfilesに無くても凍結対象に含める(self):
        out = self.freeze({"class": "llm_judge", "entry": "score.py", "files": ["fixtures/cases.json"], "criteria": {"metric": "m", "higher_is_better": True, "threshold": 0}})
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)["frozenHarness"]["file_count"], 2)

    def test_凍結の記録が無いverifyは落ちる(self):
        self.assertEqual(run("verify", "--run-dir", str(self.run_dir)).returncode, 2)

    def test_criteriaの無いspecは拒否される(self):
        spec = {k: v for k, v in SPEC.items() if k != "criteria"}
        self.assertEqual(self.freeze(spec).returncode, 2)

    def test_criteriaはMANIFESTに凍結される(self):
        import json as _json
        out = self.freeze(SPEC)
        self.assertEqual(out.returncode, 0)
        frozen = _json.loads(out.stdout)["frozenHarness"]
        manifest = _json.loads(
            (pathlib.Path(frozen["path"]) / "MANIFEST.json").read_text())
        self.assertEqual(manifest["criteria"],
                         {"metric": "pass_rate", "higher_is_better": True,
                          "threshold": 0})


if __name__ == "__main__":
    unittest.main()
