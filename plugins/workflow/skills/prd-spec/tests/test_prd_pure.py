"""scripts/prd.js の純粋関数（PURE_BEGIN〜PURE_END）のテスト。

段の分岐はこれらの関数の値で決まる。壊れても例外は出ず、段が黙って飛ぶか余計に起動するだけなので、
入力と出力を直接押さえる。区間を取り出して node で評価する（workflow script は import を書けない）。
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PRD = Path(__file__).resolve().parents[1] / "scripts" / "prd.js"


def pure_region():
    src = PRD.read_text(encoding="utf-8")
    return src[src.index("// PURE_BEGIN") : src.index("// PURE_END")]


def call(expr):
    """PURE 区間を読み込んだうえで式を評価し、JSON で返す（例外は {"error": ...}）。"""
    src = (
        "const log = () => {}\nconst pipeline = async (xs, f) => Promise.all(xs.map((x, i) => f(x, x, i)))\n"
        + pure_region()
        + f"\nlet out\ntry {{ out = {{ value: await (async () => ({expr}))() }} }} catch (e) {{ out = {{ error: String(e.message) }} }}\n"
        + "console.log(JSON.stringify(out))\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "pure.mjs"
        path.write_text(src, encoding="utf-8")
        out = subprocess.run(["node", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def value(expr):
    r = call(expr)
    if "error" in r:
        raise AssertionError(r["error"])
    return r["value"]


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Pure(unittest.TestCase):
    def test_unitWavesは依存の向きに波を作る(self):
        units = [
            {"id": "U-3", "docs": ["c"], "depends_on": ["U-1", "U-2"]},
            {"id": "U-2", "docs": ["b"], "depends_on": ["U-1"]},
            {"id": "U-1", "docs": ["a"], "depends_on": []},
            {"id": "U-4", "docs": ["d"], "depends_on": []},
        ]
        self.assertEqual(value(f"unitWaves({json.dumps(units)})"), [["U-1", "U-4"], ["U-2"], ["U-3"]])

    def test_unitWavesは循環と未知の依存を止める(self):
        cyc = [{"id": "A", "depends_on": ["B"]}, {"id": "B", "depends_on": ["A"]}]
        self.assertIn("循環", call(f"unitWaves({json.dumps(cyc)})")["error"])
        unk = [{"id": "A", "depends_on": ["Z"]}]
        self.assertIn("Z", call(f"unitWaves({json.dumps(unk)})")["error"])

    def test_partitionFindingsはwriterの指摘を項目ごとに束ねる(self):
        fs = [
            {"id": "f2", "doc": "requirements/a", "item_id": "PR-A-001", "route": "writer", "blocking": True},
            {"id": "f1", "doc": "requirements/a", "item_id": "PR-A-001", "route": "writer", "blocking": False},
            {"id": "f3", "doc": "requirements/a", "item_id": "PR-A-002", "route": "decision", "blocking": True},
        ]
        p = value(f"partitionFindings({json.dumps(fs)})")
        self.assertEqual(p["bundles"], [{"item_id": "PR-A-001", "doc": "requirements/a", "findings": ["f1", "f2"]}])
        self.assertEqual(p["decision"], ["f3"])
        self.assertEqual(p["blocking"], ["f2", "f3"])

    def test_scopedAuditPlanは指摘を出した観点だけを当て直す(self):
        changes = {"requirements/a": ["PR-A-001", "PR-A-002"], "specifications/b": ["SP-B-001"]}
        roles = {"PR-A-001": ["implementer"], "SP-B-001": ["crossDoc"]}
        plan = value(f"scopedAuditPlan({json.dumps(changes)}, {json.dumps(roles)})")
        self.assertEqual(
            plan,
            [
                {"role": "grounding", "doc": "requirements/a", "items": ["PR-A-001", "PR-A-002"], "designated": True},
                {"role": "implementer", "doc": "requirements/a", "items": ["PR-A-001"]},
                {"role": "grounding", "doc": "specifications/b", "items": ["SP-B-001"]},
                {"role": "crossDoc", "doc": "all", "items": ["SP-B-001"]},
            ],
        )

    def test_scopedAuditPlanは変更の無い文書に起動しない(self):
        self.assertEqual(value("scopedAuditPlan({}, {})"), [])

    def test_undeclaredChangesは申告に無い項目だけを返す(self):
        diff = {"changed": ["PR-A-001"], "added": ["PR-A-009"], "removed": ["requirements/a§用語"]}
        self.assertEqual(value(f"undeclaredChanges({json.dumps(diff)}, ['PR-A-001'])"), ["PR-A-009", "requirements/a§用語"])

    def test_undeclaredByDocは変更の起きた文書ごとに申告漏れを返す(self):
        diff = {
            "changed": ["PR-A-001", "PR-B-003"],
            "added": [],
            "removed": [],
            "by_doc": {
                "requirements/a": {"changed": ["PR-A-001"], "added": [], "removed": []},
                "requirements/b": {"changed": ["PR-B-003"], "added": [], "removed": []},
            },
        }
        changes = {"requirements/a": ["PR-A-001"]}
        self.assertEqual(value(f"undeclaredByDoc({json.dumps(diff)}, {json.dumps(changes)}, ['requirements/a', 'requirements/b'])"), {"requirements/b": ["PR-B-003"]})

    def test_undeclaredByDocはby_docが無ければ改稿の対象の全文書に当てる(self):
        diff = {"changed": ["PR-A-001", "PR-B-003"], "added": [], "removed": []}
        changes = {"requirements/a": ["PR-A-001"]}
        self.assertEqual(
            value(f"undeclaredByDoc({json.dumps(diff)}, {json.dumps(changes)}, ['requirements/a', 'requirements/b'])"),
            {"requirements/a": ["PR-B-003"], "requirements/b": ["PR-B-003"]},
        )

    def test_aboutKeyは組の向きに依らない(self):
        self.assertEqual(value("aboutKey({pair: ['D-2', 'D-1']})"), value("aboutKey({pair: ['D-1', 'D-2']})"))
        self.assertEqual(value("aboutKey({tbd: 'TBD-RA-001'})"), "tbd:TBD-RA-001")
        self.assertIsNone(value("aboutKey({})"))

    def test_missedTargetsは返り値のaboutに無い対象を数える(self):
        r = {"ruled": [{"id": "RS-1", "about": {"finding": "f1"}}], "questions": [], "holds": [{"id": "RS-2", "about": {"tbd": "T-1"}}]}
        self.assertEqual(value(f"missedTargets(['finding:f1', 'finding:f2', 'tbd:T-1'], {json.dumps(r)})"), ["finding:f2"])

    def test_openTbdOfは台帳に入った裁定で閉じたTBDを除く(self):
        state = {
            "open_tbd": ["T-1", "T-2", "T-3"],
            "about": {"RS-1": "tbd:T-1", "RS-2": "tbd:T-2", "RS-3": "tbd:T-3"},
            "passed": ["RS-1"],
            "holds": ["RS-3"],
            "questions": ["RS-2"],
        }
        # RS-2 は問いのまま回答が無いので、T-2 はまだ開いている。
        self.assertEqual(value(f"openTbdOf({json.dumps(state)})"), ["T-2"])

    def test_usableResolutionsは不合格と決定のIDを含めない(self):
        state = {"passed": ["RS-1", "D-4", "F-2"], "answered": ["RS-5"], "failed_ids": ["RS-5"]}
        self.assertEqual(value(f"usableResolutions({json.dumps(state)})"), ["RS-1"])

    def test_invalidIdsは検証に落ちた既定と流れの要素を無効にする(self):
        state = {"superseded": ["D-003"], "failed_ids": ["D-004", "F-007", "RS-002", "D-009"], "passed": ["D-009"]}
        self.assertEqual(value(f"invalidIds({json.dumps(state)})"), {"decisions": ["D-003", "D-004"], "flow": ["F-007"]})

    def test_pendingQuestionsは回答済みと保持規則を除く(self):
        state = {"questions": ["RS-1", "RS-2", "RS-3"], "answered": ["RS-1"], "holds": ["RS-3"]}
        self.assertEqual(value(f"pendingQuestions({json.dumps(state)})"), ["RS-2"])

    def test_stateErrorsは入口ごとに要る値を挙げる(self):
        self.assertEqual(value("stateErrors('1', {})"), [])
        errs = value("stateErrors('8', {units: [], flow: {}})")
        self.assertTrue(any("state.audit" in e for e in errs))
        self.assertTrue(any("state.revised" in e for e in errs))
        self.assertIn("段の境界", value("stateErrors('x', {})")[0])

    def test_rolesByItemは観点を重ねて持つ(self):
        h = value("rolesByItem({'PR-A-1': ['grounding']}, [{item_id: 'PR-A-1'}, {item_id: 'PR-A-2'}], 'implementer')")
        self.assertEqual(h, {"PR-A-1": ["grounding", "implementer"], "PR-A-2": ["implementer"]})

    def test_parseStdoutは最後のJSON行を読む(self):
        self.assertEqual(value("parseStdout('warn\\n{\"digest\": \"x\"}\\n')"), {"digest": "x"})
        self.assertIsNone(value("parseStdout('')"))
        self.assertIsNone(value("parseStdout('not json')"))

    def test_applyRoleOverridesは既定を上書きし未知の値を止める(self):
        table = {"writer": {"model": "opus", "effort": "medium"}}
        self.assertEqual(
            value(f"applyRoleOverrides({json.dumps(table)}, {{writer: {{effort: 'high'}}}})"),
            {"writer": {"model": "opus", "effort": "high"}},
        )
        for bad in ("{checker: {}}", "{writer: {model: 'gpt'}}", "{writer: {effort: 'huge'}}", "{writer: {read: 'full'}}"):
            with self.subTest(bad=bad):
                self.assertIn("error", call(f"applyRoleOverrides({json.dumps(table)}, {bad})"))


if __name__ == "__main__":
    unittest.main()
