"""workflows/prd-spec.js の純粋関数（PURE_BEGIN〜PURE_END）のテスト。

段の分岐はこれらの関数の値で決まる。壊れても例外は出ず、段が黙って飛ぶか余計に起動するだけなので、
入力と出力を直接押さえる。区間を取り出して node で評価する（workflow script は import を書けない）。
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prd_script import PRD_PATH as PRD  # noqa: E402
from test_doc_check_workspace import FIXTURE, _ok, _put  # noqa: E402
from test_ledger import _exported  # noqa: E402

CONTRACTS = Path(__file__).resolve().parents[1] / "schemas" / "agent-contracts.md"
WORKFLOW_IO = Path(__file__).resolve().parents[1] / "references" / "workflow-io.md"


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
    def test_ownsFlowOfは回答を当てたその段のresolverのときだけ真(self):
        self.assertTrue(value("ownsFlowOf({ tag: '3a' }, '3a')"))
        for expr in ("ownsFlowOf({ tag: '3a-questions' }, '3a')", "ownsFlowOf({ tag: '3a-questions-2' }, '3a')", "ownsFlowOf(null, '3a')"):
            with self.subTest(expr):
                self.assertFalse(value(expr))

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

    def test_usableResolutionsは合格したholdと回答待ちの問いを根拠にしない(self):
        # hold は保持規則として書く（根拠にすると、決まっていない値を決まったものとして書く）。回答待ちの問いも値が決まっていない。
        state = {"passed": ["RS-1", "RS-2", "RS-3", "RS-4"], "holds": ["RS-2"], "questions": ["RS-3", "RS-4"], "answered": ["RS-4"]}
        self.assertEqual(value(f"usableResolutions({json.dumps(state)})"), ["RS-1", "RS-4"])

    def test_invalidIdsは検証に落ちた既定と今の版で不合格の流れの要素を無効にする(self):
        state = {"superseded": ["D-003"], "failed_ids": ["D-004", "RS-002"]}
        self.assertEqual(value(f"invalidIds({json.dumps(state)}, ['F-007'])"), {"decisions": ["D-003", "D-004"], "flow": ["F-007"]})

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
        bound = [{"el": "F-053", "constraint": "O-001"}, {"el": "F-054", "constraint": "O-003"}]
        self.assertEqual(value(f"settledTerminals({json.dumps(bound)}, {json.dumps(state)})"), bound[:1], "constrained_by の O- も同じ条件で閉じる")

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

    def _f(self, id, item="PR-A-001", blocking=True, direction="tighten", origin="text"):
        return {"id": id, "doc": "requirements/a", "item_id": item, "blocking": blocking, "direction": direction, "origin": origin}

    def test_recurringItemsは両パスでblockingの項目だけを返しoriginを問わない(self):
        prev = [self._f("p1"), self._f("p2", item="PR-A-002"), self._f("p3", item="PR-A-003", blocking=False)]
        now = [self._f("n1"), self._f("n2", item="PR-A-002", blocking=False), self._f("n3", item="PR-A-003"), self._f("n4", item="PR-A-004")]
        self.assertEqual(value(f"recurringItems({json.dumps(prev)}, {json.dumps(now)})"), ["requirements/a#PR-A-001"])
        self.assertEqual(value(f"recurringItems({json.dumps(prev)}, {json.dumps([self._f('n1', origin='flow')])})"), ["requirements/a#PR-A-001"])
        self.assertEqual(value(f"recurringItems({json.dumps(prev)}, {json.dumps(now)}, [{{id: 'n1'}}])"), [], "既裁定の再出は数えない")

    def test_reRaisedは合格した裁定と同じdirectionで裁定を当てただけの項目の指摘だけを返す(self):
        prev = [self._f("p1")]
        decided = {"requirements/a": {"PR-A-001": {"p1": {"blocking": True, "route": "decision"}}}}
        state = {"about": {"RS-1": "finding:p1"}, "passed": ["RS-1"], "pending": {"findings": decided}}
        again = lambda st, now, changed={}: value(f"reRaised({json.dumps(prev)}, [], {json.dumps(now)}, {json.dumps(st)}, {json.dumps(changed)})")
        self.assertEqual(again(state, [self._f("n1")]), [{"id": "n1", "doc": "requirements/a", "item_id": "PR-A-001", "direction": "tighten", "rulings": ["RS-1"]}])
        for name, st, now, changed in (
            ("裁定が合格していない", {**state, "passed": []}, [self._f("n1")], {}),
            ("direction が違う", state, [self._f("n1", direction="relax")], {}),
            ("writer の指摘を渡した項目を改稿で変えた", {**state, "pending": {"findings": {"requirements/a": {"PR-A-001": {**decided["requirements/a"]["PR-A-001"], "w1": {"route": "writer"}}}}}}, [self._f("n1")], {"requirements/a": ["PR-A-001"]}),
        ):
            with self.subTest(name):
                self.assertEqual(again(st, now, changed), [])
        self.assertEqual([x["id"] for x in again(state, [self._f("n1")], {"requirements/a": ["PR-A-001"]})], ["n1"], "writer の指摘を渡さずに裁定を渡した項目の変更は裁定を当てただけ")
        stuck = {**state, "item_routes": {"requirements/a#PR-A-001": "exhausted"}}
        self.assertEqual(again(stuck, [self._f("n1")], {"requirements/a": ["PR-A-001"]}), [], "段 6 に渡さなかった（尽きた項目の）指摘の裁定はこのパスで渡していない")
        carried = {**state, "pending": {"findings": decided, "carried": ["p1"]}}
        self.assertEqual([x["id"] for x in again(carried, [self._f("n1")], {"requirements/a": ["PR-A-001"]})], ["n1"], "持ち越しでも段 6 に渡して裁定した指摘の裁定はこのパスで渡した")
        prev_again = [{"id": "n1", "doc": "requirements/a", "item_id": "PR-A-001", "direction": "tighten", "rulings": ["RS-1"]}]
        chained = lambda changed: value(f"reRaised([], {json.dumps(prev_again)}, {json.dumps([self._f('m1')])}, {{about: {{}}, passed: []}}, {json.dumps(changed)})")
        self.assertEqual([x["id"] for x in chained({})], ["m1"], "前のパスの再出が持ち越した裁定でも数えない")
        self.assertEqual(chained({"requirements/a": ["PR-A-001"]}), [], "前のパスの再出だけが持つ裁定はこのパスで渡していないので、変わった項目は当てただけではない")

    def test_pendingViewは束とdecisionとblockingを指摘から導き尽きた項目を経路から外す(self):
        f = lambda route, blocking=True: {"blocking": blocking, "route": route, "direction": "tighten", "origin": "text"}
        p = {"findings": {"requirements/a": {"PR-A-001": {"w1": f("writer"), "d1": f("decision")}, "PR-A-002": {"w2": f("writer", False)}, "PR-A-003": {"w3": f("writer")}}},
             "flow": {"requirements/a": {"PR-A-001": ["F-001"]}}, "doc_blocking": 0}
        v = value(f"pendingView({json.dumps(p)}, {{'requirements/a#PR-A-003': 'exhausted'}})")
        self.assertEqual([(b["item_id"], b["findings"], b.get("flow")) for b in v["bundles"]], [("PR-A-001", ["w1"], ["F-001"]), ("PR-A-002", ["w2"], None)])
        self.assertEqual((v["decision"], sorted(v["blocking"]), v["doc_blocking"]), (["d1"], ["d1", "w1", "w3"], 0))

    def test_routeRecurringはdecisionからholdを経て尽きた項目にする(self):
        routes = {"k2": "decision", "k3": "hold", "k4": "exhausted"}
        self.assertEqual(value(f"routeRecurring(['k1', 'k2', 'k3', 'k4'], {{item_routes: {json.dumps(routes)}}})"),
                         {"k1": "decision", "k2": "hold", "k3": "exhausted", "k4": "exhausted"})

    def _rework(self, counts, limit=3):
        # counts[0] は最初の返り値の件数、counts[n] は n 回目の差し戻しの件数（None は stdout が無い）。
        js = json.dumps(counts)
        return value(
            f"(async () => {{ const cs = {js}; const calls = []; const d = (x) => (x.c === 0 ? null : {{ count: x.c === null ? Infinity : x.c, text: String(x.c) }});"
            f" const r = await rework({{ c: cs[0] }}, d, async (_, __, n) => {{ calls.push(n); return {{ c: cs[n] }} }}, {limit}); return {{ calls, defect: r.defect, got: r.got.c }} }})()"
        )

    def test_reworkは件数が0になるまで回し減らなければ止める(self):
        self.assertEqual(self._rework([3, 1, 0]), {"calls": [1, 2], "defect": None, "got": 0})
        self.assertEqual(self._rework([3, 3, 0])["calls"], [1], "3 → 3 は進展なし")
        self.assertEqual(self._rework([None, None, 0])["calls"], [1], "stdout が 2 回とも無ければ止める")
        self.assertEqual(self._rework([None, 2, 0])["got"], 0)
        self.assertEqual(self._rework([4, 3, 2, 1, 0], limit=3)["calls"], [1, 2, 3], "減り続けても上限で止める")
        self.assertEqual(self._rework([0])["calls"], [])

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
        ledger = [{"id": "f1", "origin": "ledger", "doc": "requirements/a", "item_id": "PR-A-001"}]
        self.assertEqual(value(f"settledFlowFindings({json.dumps(ledger)}, {json.dumps(state)}, [])"), [])
        self.assertEqual(value(f"settledFlowFindings({json.dumps(ledger)}, {json.dumps(state)}, [], {{'requirements/a#PR-A-001': ['p1']}})"), ["f1"], "再発した項目の ledger 由来の指摘も flow に写す")

    def test_failedOpenは保持規則か回答待ちの問いの検証の裁定がある不合格の要素だけを除く(self):
        about = {"RS-1": "verification:F-001", "RS-2": "verification:F-002", "RS-3": "verification:F-003", "RS-6": "open:O-1"}
        state = {"about": about, "passed": ["RS-1", "RS-2", "RS-3"], "holds": ["RS-2"], "questions": ["RS-3"]}
        fc = {"failed_current": ["F-001", "F-002", "F-003", "F-004"]}
        # F-001 は合格した裁定（settle が写す）、F-002 は hold、F-003 は回答待ちの問い、F-004 は裁定が無い
        self.assertEqual(value(f"failedOpen({json.dumps(fc)}, {json.dumps(state)}, true)"), ["F-001", "F-004"])
        self.assertEqual(value(f"failedOpen({json.dumps(fc)}, {json.dumps(state)}, false)"), ["F-001", "F-003", "F-004"], "聞くゲートの無い出口では回答待ちで進めない")

    def test_unverifiedLeftは今の版に合否の無い要素とresolutionと進めない不合格を挙げる(self):
        converted = [{"id": "RS-5", "about": {"verification": "F-002"}, "ruling": "hold", "verdict": "pass"},
                     {"id": "RS-6", "about": {"open": "O-6"}, "ruling": "hold", "verdict": "fail", "fail_kind": "insufficient_grounds"},
                     {"id": "RS-7", "about": {"open": "O-7"}, "ruling": "question", "verdict": "fail", "fail_kind": "value_as_method"}]
        clean = {"unverified": ["F-002"], "failed_current": ["F-002"], "resolutions": converted}
        state = {"about": {"RS-5": "verification:F-002"}, "holds": ["RS-5"]}
        self.assertIsNone(value(f"unverifiedLeft({json.dumps(clean)}, {json.dumps(state)}, false)"))
        for name, fc, st in (("書き換えて検証していない要素", {**clean, "unverified": ["F-001", "F-002"]}, state),
                             ("合否の無い resolution", {**clean, "resolutions": [*converted, {"id": "RS-9", "about": {"open": "O-1"}, "ruling": "internal", "verdict": None}]}, state),
                             ("問いにも保持規則にもならない不合格の resolution", {**clean, "resolutions": [*converted, {"id": "RS-9", "about": {"open": "O-1"}, "ruling": "internal", "verdict": "fail", "fail_kind": "insufficient_grounds"}]}, state),
                             ("裁定の無い不合格の要素", clean, {}),
                             ("不合格の回答済みの問い", {**clean, "resolutions": [*converted, {"id": "RS-8", "about": {"open": "O-8"}, "ruling": "question", "verdict": "fail", "fail_kind": "insufficient_grounds"}]},
                              {**state, "questions": ["RS-8"], "answered": ["RS-8"]})):
            with self.subTest(name):
                self.assertIsNotNone(value(f"unverifiedLeft({json.dumps(fc)}, {json.dumps(st)}, false)"))

    def test_flowCheckOfは一覧の欄が欠けたstdoutを受け取らない(self):
        base = {"findings": 0, "codes": {}, "open": 0, "content_sha256": "x", "unverified": [], "failed_current": [], "resolutions": [], "open_only": [], "stale_refs": [], "open_ids": [], "pair_keys": []}
        self.assertIsNotNone(value(f"flowCheckOf({json.dumps(json.dumps(base))}, true)"))
        for k in ("codes", "unverified", "failed_current", "resolutions", "open_only", "stale_refs", "open_ids", "pair_keys"):
            broken = {x: v for x, v in base.items() if x != k}
            self.assertIsNone(value(f"flowCheckOf({json.dumps(json.dumps(broken))}, true)"), k)
            if k != "resolutions":
                self.assertIsNone(value(f"flowCheckOf({json.dumps(json.dumps(broken))})"), k)
        plain = {x: v for x, v in base.items() if x != "resolutions"}
        self.assertIsNotNone(value(f"flowCheckOf({json.dumps(json.dumps(plain))})"), "生成者の doc_check flow（--rulings なし）は resolutions を持たない")
        two = {**base, "findings": 2, "codes": {"FLOW_DANGLING": ["F-001"], "FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-002"]}}
        self.assertIsNotNone(value(f"flowCheckOf({json.dumps(json.dumps(two))})"))
        self.assertIsNone(value(f"flowCheckOf({json.dumps(json.dumps({**two, 'findings': 3}))})"), "符号の件数の和と findings が食い違う stdout は受け取らない")

    def test_splitFlowFindingsは生成者が消せる指摘とflow_framerに回す指摘と表に無い符号に分ける(self):
        fc = {"codes": {"FLOW_DANGLING": ["F-001", "F-002"], "FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"], "FLOW_NEW": ["F-009"]}}
        self.assertEqual(value(f"splitFlowFindings({json.dumps(fc)}, 'resolver')"),
                         {"own": 2, "handoff": [{"code": "FLOW_DESTRUCTIVE_UNCONSTRAINED", "at": "F-053"}], "unknown": ["FLOW_NEW"]})
        self.assertEqual(value(f"splitFlowFindings({json.dumps(fc)}, 'flowFramer')"), {"own": 3, "handoff": [], "unknown": ["FLOW_NEW"]})

    def test_flowDefectは生成者に消せない指摘を数えず表に無い符号では差し戻さずに止める(self):
        only = {"codes": {"FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}}
        self.assertIsNone(value(f"flowDefect({json.dumps(only)}, 'resolver', 'p')"))
        self.assertEqual(value(f"flowDefect({json.dumps(only)}, 'flowFramer', 'p')")["count"], 1)
        mixed = {"codes": {"FLOW_DANGLING": ["F-001"], "FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-053"]}}
        d = value(f"flowDefect({json.dumps(mixed)}, 'resolver', 'p')")
        self.assertEqual(d["count"], 1)
        self.assertIn("F-053（FLOW_DESTRUCTIVE_UNCONSTRAINED） は flow-framer が settle で直すので触らない", d["text"])
        unknown = value("flowDefect({codes: {FLOW_NEW: ['F-009']}}, 'flowFramer', 'p')")
        self.assertTrue(unknown["stop"])
        calls = value("(async () => { const calls = []; await rework(1, () => ({ count: 1, stop: true, text: 't' }), async () => { calls.push(1); return 2 }, 3); return calls })()")
        self.assertEqual(calls, [], "stop の不合格は生成者に差し戻さない")

    def test_stateErrorsは入口ごとに要る値を挙げる(self):
        self.assertEqual(value("stateErrors('1', {})"), [])
        errs = value("stateErrors('8', {units: [], flow_digest: 'f'})")
        self.assertTrue(any("state.audit" in e for e in errs))
        self.assertTrue(any("state.revised" in e for e in errs))
        self.assertTrue(any("state.settled_written" in e for e in errs), "finish() が holds と hold_drafts を分ける鍵")
        self.assertFalse(any("flow" in e for e in errs))
        self.assertEqual(value("stateErrors('4', {units: [], flow: {}, failed_ids: ['F-001']})"),
                         ['from "4" には state.flow_digest が要ります'])
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


DOC_CHECK = Path(__file__).resolve().parents[1] / "scripts" / "doc_check.mjs"


def flow_mode_codes():
    """doc_check flow（wsFlow）が組み合わせる検査の関数が出しうる符号。関数名は wsFlow の list の行から取る。"""
    src = DOC_CHECK.read_text(encoding="utf-8")
    body = src[src.index("function wsFlow(") :]
    line = re.search(r"const list = \[(.*)\]\n", body).group(1)
    names = re.findall(r"\.\.\.(\w+)\(", line)
    assert len(names) >= 4, names
    codes = set()
    for name in names:
        start = src.index(f"function {name}(")
        end = src.index("\n}\n", start)
        codes |= set(re.findall(r"'(FLOW_[A-Z_]+)'", src[start:end]))
    return codes


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FlowFixers(unittest.TestCase):
    def test_直し手の表はdoc_check_flowが出しうる符号とちょうど一致する(self):
        # 表に無い符号を黙って生成者に差し戻さないため（実行時は表に無い符号で止まる）。WORKSPACE_TEXT の flow の符号と、
        # flow モードも出す FINDING_TEXT のグラフの符号（FLOW_SHAPE など）の両方を含む。
        codes = flow_mode_codes()
        self.assertIn("FLOW_DESTRUCTIVE_UNCONSTRAINED", codes)
        self.assertIn("FLOW_DANGLING", codes)
        src = DOC_CHECK.read_text(encoding="utf-8")
        ws_text = src[src.index("// WORKSPACE_TEXT_BEGIN") : src.index("// WORKSPACE_TEXT_END")]
        self.assertLessEqual(set(re.findall(r"^  (FLOW_[A-Z_]+): \(", ws_text, re.M)), codes)
        self.assertEqual(set(value("Object.keys(FIXERS_BY_CODE)")), codes)

    def test_どの符号もflow_framerが消せ_resolverに消せない符号だけが渡す行を持つ(self):
        table = value("FIXERS_BY_CODE")
        self.assertTrue(all("flowFramer" in v["fixers"] and set(v["fixers"]) <= {"flowFramer", "resolver"} for v in table.values()))
        self.assertEqual({k for k, v in table.items() if v.get("handoff")}, {k for k, v in table.items() if "resolver" not in v["fixers"]})
        self.assertEqual(table["FLOW_DESTRUCTIVE_UNCONSTRAINED"]["fixers"], ["flowFramer"], "resolver は open.json に不変条件の O- を足せない")

    def _flow_codes(self, edit):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp) / "W"
            shutil.copytree(FIXTURE, ws)
            els = json.loads((ws / "flow.json").read_text())["elements"]
            edit({e["id"]: e for e in els})
            _put(ws, "flow", {"elements": els})
            return _ok(ws, "flow")["codes"]

    def test_flow_framerだけが消せる符号は出典と縛りの欠けが出す符号とちょうど一致する(self):
        def strip(els):
            els["F-001"]["source"] = None
            els["F-004"]["cases"][0].pop("source")
            els["F-002"]["effect"] = "destructive"
        table = value("FIXERS_BY_CODE")
        self.assertEqual(set(self._flow_codes(strip)), {k for k, v in table.items() if "resolver" not in v["fixers"]})

    def test_欠けたマスは出典が決まらなくてもcaseを足せばflow_framer専用の符号だけが残る(self):
        def gap(els):
            els["F-004"]["cases"] = els["F-004"]["cases"][:1]
        def unsourced(els):
            els["F-004"]["cases"][1].pop("source")
        table = value("FIXERS_BY_CODE")
        self.assertIn("FLOW_DT_GAP", self._flow_codes(gap))
        self.assertIn("resolver", table["FLOW_DT_GAP"]["fixers"])
        left = set(self._flow_codes(unsourced))
        self.assertEqual(left, {"FLOW_CASE_NOSOURCE"})
        self.assertNotIn("resolver", table["FLOW_CASE_NOSOURCE"]["fixers"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class ContractEnums(unittest.TestCase):
    def test_DIRECTIONSとORIGINSは契約の表の値と一致する(self):
        self.assertEqual(sorted(value("DIRECTIONS")), contract_values("direction"))
        self.assertEqual(sorted(value("ORIGINS")), contract_values("origin"))
        self.assertEqual(len(contract_values("origin")), 4)

    def test_RESOLUTION_IDはdoc_checkの台帳のIDの形と同じ(self):
        self.assertEqual(value("RESOLUTION_ID.source"), _exported("m.LEDGERS.resolutions.keyShape.source"))

    def test_ENV_ARGSはworkflow_ioの3節が変えてよいと書いた欄と同じ(self):
        section = WORKFLOW_IO.read_text(encoding="utf-8").split("## 3. 返り値と再実行", 1)[1].split("\n## ", 1)[0]
        allowed = section.split("変えてよいのは", 1)[1].split("だけ", 1)[0]
        self.assertEqual(sorted(re.findall(r"`([A-Za-z_]+)`", allowed)), sorted(value("ENV_ARGS")))

    def test_nextArgsHashは環境の欄と最上位の空の欄を覆わない(self):
        a = {"workspace": "/w", "entry": "new", "from": "3a", "state": {"pass": 1, "questions": []}, "existing_docs": []}
        h = value(f"nextArgsHash({json.dumps(a)})")
        same = [{**a, "skillDir": "/s2", "role_opts": {"writer": {"effort": "high"}}}, {k: v for k, v in a.items() if k != "existing_docs"}, {**a, "state_hash": "x"}]
        for b in same:
            self.assertEqual(value(f"nextArgsHash({json.dumps(b)})"), h, b)
        differ = [{**a, "workspace": "/w2"}, {**a, "from": "3b"}, {**a, "state": {"pass": 1}}, {**a, "existing_docs": [{"key": "requirements/x"}]}]
        for b in differ:
            self.assertNotEqual(value(f"nextArgsHash({json.dumps(b)})"), h, b)

    def test_OPPOSITEの値は契約のdirectionの表にある(self):
        table = set(contract_values("direction"))
        opposite = value("OPPOSITE")
        self.assertTrue(opposite)
        self.assertLessEqual(set(opposite) | set(opposite.values()), table)


if __name__ == "__main__":
    unittest.main()
