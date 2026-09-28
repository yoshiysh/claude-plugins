"""scripts/prd.js の純粋関数（PURE_BEGIN〜PURE_END）のテスト。

段の分岐はこれらの関数の値で決まる。壊れても例外は出ず、段が黙って飛ぶか余計に起動するだけなので、
入力と出力を直接押さえる。区間を取り出して node で評価する（workflow script は import を書けない）。
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

PRD = Path(__file__).resolve().parents[1] / "scripts" / "prd.js"
CONTRACTS = Path(__file__).resolve().parents[1] / "schemas" / "agent-contracts.md"


def contract_values(heading):
    """契約の「### <heading>」の表の 1 列目の値。"""
    text = CONTRACTS.read_text(encoding="utf-8")
    body = text.split(f"\n### {heading}\n", 1)[1].split("\n#", 1)[0]
    return sorted(re.findall(r"^\| `([a-z_]+)` \|", body, re.M))


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

    def test_invalidIdsは検証に落ちた既定と今の版で不合格の流れの要素を無効にする(self):
        state = {"superseded": ["D-003"], "failed_ids": ["D-004", "RS-002", "D-009"], "passed": ["D-009"], "flow_failed": ["F-007"]}
        self.assertEqual(value(f"invalidIds({json.dumps(state)})"), {"decisions": ["D-003", "D-004"], "flow": ["F-007"]})

    def test_pendingQuestionsは回答済みと保持規則を除く(self):
        state = {"questions": ["RS-1", "RS-2", "RS-3"], "answered": ["RS-1"], "holds": ["RS-3"]}
        self.assertEqual(value(f"pendingQuestions({json.dumps(state)})"), ["RS-2"])

    def test_settledTerminalsは合格と回答で閉じたOの組だけを返す(self):
        state = {
            "about": {"RS-001": "open:O-001", "RS-002": "open:O-002", "RS-003": "open:O-003", "RS-004": "open:O-004", "RS-005": "open:O-005", "RS-006": "open:O-006"},
            "passed": ["RS-001", "RS-003", "RS-004", "RS-006"], "answered": ["RS-002"], "holds": ["RS-003"],
            "questions": ["RS-002", "RS-004"], "failed_ids": ["RS-006"],
        }
        only = [{"el": f"F-09{i}", "open": f"O-00{i}"} for i in range(1, 8)]
        got = value(f"settledTerminals({json.dumps(only)}, {json.dumps(state)})")
        # O-003 は hold、O-004 は回答待ちの問い、O-005 は未合格、O-006 は不合格、O-007 は開いたまま
        self.assertEqual(got, [{"el": "F-091", "open": "O-001"}, {"el": "F-092", "open": "O-002"}])
        self.assertEqual(value(f"settledOpenIds({json.dumps(state)})"), ["O-001", "O-002"])

    def test_reversedFindingsは同じ項目への逆向きの指摘だけを拾う(self):
        prev = [
            {"id": "r2-001", "doc": "requirements/a", "item_id": "PR-A-001", "direction": "tighten"},
            {"id": "r2-002", "doc": "requirements/a", "item_id": "PR-A-002", "direction": "tighten"},
            {"id": "r2-003", "doc": "requirements/a", "item_id": "PR-A-003", "direction": "remove"},
        ]
        now = [
            {"id": "r3-001", "doc": "requirements/a", "item_id": "PR-A-001", "direction": "relax"},
            {"id": "r3-002", "doc": "requirements/a", "item_id": "PR-A-002", "direction": "tighten"},
            {"id": "r3-003", "doc": "requirements/a", "item_id": "PR-A-009", "direction": "relax"},
            {"id": "r3-004", "doc": "requirements/b", "item_id": "PR-A-001", "direction": "relax"},
            {"id": "r3-005", "doc": "requirements/a", "item_id": "PR-A-003", "direction": "document_decision"},
        ]
        self.assertEqual(value(f"reversedFindings({json.dumps(prev)}, {json.dumps(now)})"), ["r3-001"])
        self.assertEqual(value(f"reversedFindings(undefined, {json.dumps(now)})"), [])

    def test_toDecisionは本文の外の指摘と逆転した指摘をdecisionにする(self):
        fs = [{"id": f"f{i}", "route": "writer", "origin": o} for i, o in enumerate(["text", "flow", "ledger", "input", "text"], 1)]
        got = {f["id"]: f["route"] for f in value(f"toDecision({json.dumps(fs)}, ['f5'])")}
        self.assertEqual(got, {"f1": "writer", "f2": "decision", "f3": "decision", "f4": "decision", "f5": "decision"})

    def test_settledFlowFindingsはこのcycleで決まったflowの指摘だけを返す(self):
        state = {
            "about": {f"RS-{i}": f"finding:f{i}" for i in range(1, 6)},
            "passed": ["RS-1", "RS-2", "RS-3", "RS-4", "RS-5"],
            "holds": ["RS-2"],
            "questions": ["RS-3"],
        }
        pending = [{"id": f"f{i}", "origin": "text" if i == 4 else "flow"} for i in range(1, 6)]
        # f2 は hold、f3 は回答待ちの問い、f4 は origin が text、f5 は cycle に入る前に決まっていた
        self.assertEqual(value(f"settledFlowFindings({json.dumps(pending)}, {json.dumps(state)}, ['RS-5'])"), ["f1"])
        self.assertEqual(value(f"settledFlowFindings(undefined, {json.dumps(state)}, [])"), [])

    def test_settledVerificationsはこのcycleで合格した流れの要素の検証の裁定だけを返す(self):
        about = {"RS-1": "verification:F-001", "RS-2": "verification:F-002", "RS-3": "verification:F-003", "RS-4": "verification:D-004",
                 "RS-5": "verification:F-005", "RS-6": "pair:D-001|F-006", "RS-7": "tbd:T-1", "RS-8": "finding:f8", "RS-9": "verification:F-009"}
        state = {"about": about, "passed": ["RS-1", "RS-2", "RS-3", "RS-4", "RS-5", "RS-6", "RS-7", "RS-8"], "holds": ["RS-2"], "questions": ["RS-3"]}
        # F-002 は hold、F-003 は回答待ちの問い、D-004 は flow の要素でない、F-005 は cycle に入る前に決まっていた、F-009 は未合格
        self.assertEqual(value(f"settledVerifications({json.dumps(state)}, ['RS-5'])"), ["F-001"])

    def test_flowCheckOfは一覧の欄が欠けたstdoutを受け取らない(self):
        base = {"findings": 0, "open": 0, "content_sha256": "x", "unverified": [], "failed_current": [], "open_only": [], "stale_refs": [], "open_ids": []}
        self.assertIsNotNone(value(f"flowCheckOf({json.dumps(json.dumps(base))})"))
        for k in ("unverified", "failed_current", "open_only", "stale_refs", "open_ids"):
            broken = {x: v for x, v in base.items() if x != k}
            self.assertIsNone(value(f"flowCheckOf({json.dumps(json.dumps(broken))})"), k)

    def test_stateErrorsは入口ごとに要る値を挙げる(self):
        self.assertEqual(value("stateErrors('1', {})"), [])
        errs = value("stateErrors('8', {units: [], flow_digest: 'f', flow_failed: []})")
        self.assertTrue(any("state.audit" in e for e in errs))
        self.assertTrue(any("state.revised" in e for e in errs))
        self.assertTrue(any("state.settled_written" in e for e in errs), "finish() が holds と hold_drafts を分ける鍵")
        self.assertFalse(any("flow" in e for e in errs))
        self.assertEqual(value("stateErrors('4', {units: [], flow: {}, failed_ids: ['F-001']})"),
                         ['from "4" には state.flow_digest が要ります', 'from "4" には state.flow_failed が要ります'])
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


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class ContractEnums(unittest.TestCase):
    def test_DIRECTIONSとORIGINSは契約の表の値と一致する(self):
        self.assertEqual(sorted(value("DIRECTIONS")), contract_values("direction"))
        self.assertEqual(sorted(value("ORIGINS")), contract_values("origin"))
        self.assertEqual(len(contract_values("origin")), 4)

    def test_OPPOSITEの値は契約のdirectionの表にある(self):
        table = set(contract_values("direction"))
        opposite = value("OPPOSITE")
        self.assertTrue(opposite)
        self.assertLessEqual(set(opposite) | set(opposite.values()), table)


if __name__ == "__main__":
    unittest.main()
