"""状態 × イベント表・判定表・工程の流れ（flow）の閉包検査と、その指摘の戻り先のテスト。

実 run（6 文書）で依頼者に届いた 12 問は、ほぼ全件が文書内の不整合だった（表と図が同じ入力に
別の遷移を定める・中断点の後に戻り先が無い・免除条件が項目ごとにずれる・省ける工程の集合が
定義されていない）。これを人間ゲートではなく書き手へ返すため、次を固定する。

1. doc_check.mjs が flow の閉包（行き先の無い判断の値・実在しない行き先・辿り着けない要素・
   項目の当たっていない要素）を検出する
2. 状態 × イベント表の網羅・一意・到達・表と図の一致を検出し、「発生しない」を定義済みと数える
3. 判定表の組み合わせの欠け・重なりを検出する
4. 短い形で出力され、文面の表と flow の検査区間が 3 ファイルで逐語一致する
5. これらの指摘は ladder-judge を通らず writer へ流れ、blocking TBD にならない
6. flow-framer が手順 2 に配線され、flow が draft.js / refine.js の入口で検査され next_args に載る
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from prose import prose_pattern

SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / "scripts"
DOC_CHECK = SCRIPTS / "doc_check.mjs"
REFINE = (SCRIPTS / "refine.js").read_text()
DRAFT = (SCRIPTS / "draft.js").read_text()
SKILL_MD = (SKILL / "SKILL.md").read_text()
CONTRACTS = (SKILL / "schemas" / "agent-contracts.md").read_text()


def _extract_function(source: str, name: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(f"function {name}(") or l.startswith(f"async function {name}("))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


def _marked_block(source: str, name: str) -> str:
    return source[source.index(f"// {name}_BEGIN") : source.index(f"// {name}_END") + len(f"// {name}_END")]


def _node(src: str, spec) -> object:
    with tempfile.TemporaryDirectory() as d:
        script = Path(d) / "t.mjs"
        script.write_text(src + "\nconst spec = JSON.parse(process.argv[2])\n" + "Promise.resolve(main(spec)).then((r) => process.stdout.write(JSON.stringify(r)))\n")
        out = subprocess.run(["node", str(script), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def _structural(docs, flow="__absent__"):
    """doc_check.mjs の structuralFindings（文面付き）で検査する。"""
    src = f"import {{ structuralFindings }} from {json.dumps(DOC_CHECK.as_uri())}\n" + (
        "function main(spec) { return 'flow' in spec ? structuralFindings(spec.docs, spec.flow) : structuralFindings(spec.docs) }"
    )
    spec = {"docs": docs}
    if flow != "__absent__":
        spec["flow"] = flow
    return _node(src, spec)


def _doc(markdown, key="specifications/flow", kind="specifications", **over):
    d = {"key": key, "kind": kind, "topic": key.split("/")[1], "markdown": markdown, "ids": [], "fixed": False}
    d.update(over)
    return d


def _ids(res, prefix):
    return sorted(f["id"] for f in res["findings"] if f["id"].startswith(prefix))


# 入力 F-001 → 判断 F-002（値 A → F-003 / 値 B → 行き先なし）→ 出力 F-003。F-009 はどこからも入られない。
FLOW_BROKEN = {
    "elements": [
        {"id": "F-001", "type": "input", "kind": "外から入るもの", "label": "依頼文", "next": ["F-002"]},
        {"id": "F-002", "type": "decision", "kind": "判断", "label": "対象外か",
         "branches": [{"value": "対象内", "next": "F-003"}, {"value": "対象外"}]},
        {"id": "F-003", "type": "output", "kind": "返すもの", "label": "文書"},
        {"id": "F-009", "type": "step", "kind": "工程", "label": "孤立した工程", "next": ["F-003"]},
    ],
    "kinds": [
        {"name": "外から入るもの", "definition": "系の外から入る"},
        {"name": "判断", "definition": "値で次が変わる"},
        {"name": "工程", "definition": "入力を変換する"},
        {"name": "返すもの", "definition": "系の外へ出る"},
    ],
    "closure": "依頼文の動詞を全て工程に当てた",
}

FLOW_OK = {
    "elements": [
        {"id": "F-001", "type": "input", "kind": "外から入るもの", "label": "依頼文", "next": ["F-002"]},
        {"id": "F-002", "type": "decision", "kind": "判断", "label": "対象外か",
         "branches": [{"value": "対象内", "next": "F-003"}, {"value": "対象外", "next": "F-004"}]},
        {"id": "F-003", "type": "output", "kind": "返すもの", "label": "文書"},
        {"id": "F-004", "type": "output", "kind": "返すもの", "label": "対象外の旨"},
    ],
    "kinds": FLOW_BROKEN["kinds"],
    "closure": "依頼文の動詞を全て工程に当てた",
}


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class FlowClosure(unittest.TestCase):
    def test_行き先の無い判断の値と辿り着けない要素を拾う(self):
        res = _structural([_doc("本文")], FLOW_BROKEN)
        ids = _ids(res, "ST-FLOW-")
        self.assertIn("ST-FLOW-BRANCH-OPEN-F-002-対象外", ids)
        self.assertIn("ST-FLOW-UNREACHABLE-F-009", ids)

    def test_実在しない行き先を拾う(self):
        flow = json.loads(json.dumps(FLOW_OK))
        flow["elements"][0]["next"] = ["F-404"]
        self.assertIn("ST-FLOW-DANGLING-F-001-F-404", _ids(_structural([_doc("本文")], flow), "ST-FLOW-"))

    def test_項目の当たっていない要素を拾い_当たっていれば出さない(self):
        refs = [{"item_id": "SP-FLOW-001", "ref": "F-001"}, {"item_id": "SP-FLOW-002", "ref": "F-002"},
                {"item_id": "SP-FLOW-003", "ref": "F-003"}]
        res = _structural([_doc("本文", flow_refs=refs)], FLOW_OK)
        self.assertEqual(_ids(res, "ST-FLOW-"), ["ST-FLOW-UNATTACHED-F-004"])
        # 隣の要素に項目を当てている文書へ返す
        f = next(x for x in res["findings"] if x["id"] == "ST-FLOW-UNATTACHED-F-004")
        self.assertEqual(f["document"], "specifications/flow")
        res = _structural([_doc("本文", flow_refs=refs + [{"item_id": "SP-FLOW-004", "ref": "F-004"}])], FLOW_OK)
        self.assertEqual(_ids(res, "ST-FLOW-"), [])

    def test_実在しない要素への当てはめを拾う(self):
        res = _structural([_doc("本文", flow_refs=[{"item_id": "SP-FLOW-001", "ref": "F-777"}])], FLOW_OK)
        self.assertIn("ST-FLOW-UNKNOWN-REF-SP-FLOW-001-F-777", _ids(res, "ST-FLOW-"))

    def test_flow_が_null_なら未検査_キーが無ければ検査しない(self):
        res = _structural([_doc("本文")], None)
        self.assertIn("ST-NOTCHECKED-FLOW", [n["id"] for n in res["not_checked"]])
        res = _structural([_doc("本文")])
        self.assertNotIn("ST-NOTCHECKED-FLOW", [n["id"] for n in res["not_checked"]])
        self.assertEqual(_ids(res, "ST-FLOW-"), [])


STATE_DOC = """# 仕様書

## 状態とイベント

```mermaid
stateDiagram-v2
    [*] --> 下書き
    下書き --> 承認待ち : E1 申請する (SP-A-001)
    承認待ち --> 完了 : E2 承認する (SP-A-002)
    完了 --> [*]
    孤島 --> [*]
    袋小路 --> 袋小路 : E3 差し戻す (SP-A-009)
```

> 対象の状態: 下書き / 承認待ち
> 対象のイベント: E1 申請する / E2 承認する / E3 差し戻す

| 現在の状態 | イベント | 種別 | 次の状態 | 定義済みか |
|---|---|---|---|---|
| 下書き | E2 | — | — | 発生しない |
| 下書き | E3 | 準正常系 | 下書き | ✅ SP-A-003 |
| 承認待ち | E2 | 準正常系 | 下書き | ✅ SP-A-004 |
| 承認待ち | E3 | 準正常系 | 下書き（期限切れのときは完了） | ✅ SP-A-005（承認済みなら袋小路へ移る） |
"""


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class StateTable(unittest.TestCase):
    def setUp(self):
        self.res = _structural([_doc(STATE_DOC)])
        self.ids = _ids(self.res, "ST-STATE-")
        self.k = "specifications/flow"

    def test_欠けた組み合わせを拾う(self):
        # 承認待ち × E1 は表にも図にも無い
        self.assertIn(f"ST-STATE-MISSING-{self.k}-承認待ち-E1", self.ids)

    def test_発生しないは定義済みと数える(self):
        self.assertNotIn(f"ST-STATE-MISSING-{self.k}-下書き-E2", self.ids)
        # 下書き × E1 は図の辺（ラベルが E1 で始まる）が定義している
        self.assertNotIn(f"ST-STATE-MISSING-{self.k}-下書き-E1", self.ids)

    def test_同じ入力に_2_つの行き先を拾う(self):
        self.assertIn(f"ST-STATE-NONDET-{self.k}-承認待ち-E3", self.ids)

    def test_定義済みか列に書いた別の遷移を拾う(self):
        self.assertIn(f"ST-STATE-HIDDEN-{self.k}-承認待ち-E3-袋小路", self.ids)

    def test_表と図の食い違いを拾う(self):
        self.assertIn(f"ST-STATE-DIAGRAM-CONFLICT-{self.k}-承認待ち-E2", self.ids)
        f = next(x for x in self.res["findings"] if x["id"] == f"ST-STATE-DIAGRAM-CONFLICT-{self.k}-承認待ち-E2")
        self.assertIn("下書き", f["issue"])
        self.assertIn("完了", f["issue"])

    def test_到達できない状態と出口の無い状態を拾う(self):
        self.assertIn(f"ST-STATE-UNREACHABLE-{self.k}-孤島", self.ids)
        self.assertIn(f"ST-STATE-DEADEND-{self.k}-袋小路", self.ids)
        self.assertNotIn(f"ST-STATE-DEADEND-{self.k}-完了", self.ids)

    def test_イベントの軸が無い表を拾う(self):
        md = STATE_DOC.replace("> 対象のイベント: E1 申請する / E2 承認する / E3 差し戻す\n", "")
        self.assertTrue(any(i.startswith(f"ST-STATE-NOAXIS-{self.k}") for i in _ids(_structural([_doc(md)]), "ST-STATE-")))

    def test_閉じた表は何も出さない(self):
        md = """## 状態とイベント

```mermaid
stateDiagram-v2
    [*] --> 待ち
    待ち --> 済み : E1 受け取る (SP-B-001)
    済み --> [*]
```

> 対象の状態: 待ち
> 対象のイベント: E1 受け取る / E2 取り消す

| 現在の状態 | イベント | 種別 | 次の状態 | 定義済みか |
|---|---|---|---|---|
| 待ち | E2 | 準正常系 | 済み | ✅ SP-B-002 |
"""
        self.assertEqual(_ids(_structural([_doc(md)]), "ST-STATE-"), [])

    def test_図と表が別の節でも文書に図が_1_つなら突き合わせる(self):
        md = STATE_DOC.replace("```\n\n> 対象の状態", "```\n\n## 状態 × イベント表\n\n> 対象の状態")
        self.assertIn("## 状態 × イベント表", md)
        ids = _ids(_structural([_doc(md)]), "ST-STATE-")
        self.assertIn(f"ST-STATE-UNREACHABLE-{self.k}-孤島", ids)
        self.assertIn(f"ST-STATE-DEADEND-{self.k}-袋小路", ids)
        self.assertIn(f"ST-STATE-DIAGRAM-CONFLICT-{self.k}-承認待ち-E2", ids)

    def test_固定文書は検査しない(self):
        self.assertEqual(_ids(_structural([_doc(STATE_DOC, fixed=True)]), "ST-STATE-"), [])


DT_DOC = """## 保存

> 条件の値: 呼び手 = 人間 / 司令塔
> 条件の値: 書き込む先 = 中 / 外

| 条件: 呼び手 | 条件: 書き込む先 | 結果 |
|---|---|---|
| 司令塔 | 中 | 承認を求めない |
| 司令塔 | * | 承認を求める |
"""


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class DecisionTable(unittest.TestCase):
    def test_欠けた組み合わせと重なりを拾う(self):
        ids = _ids(_structural([_doc(DT_DOC)]), "ST-DT-")
        k = "specifications/flow"
        self.assertIn(f"ST-DT-GAP-{k}-保存-呼び手=人間, 書き込む先=中", ids)
        self.assertIn(f"ST-DT-GAP-{k}-保存-呼び手=人間, 書き込む先=外", ids)
        self.assertIn(f"ST-DT-OVERLAP-{k}-保存-呼び手=司令塔, 書き込む先=中", ids)
        self.assertEqual(len(ids), 3)

    def test_上記以外の行が欠けを閉じる(self):
        md = DT_DOC.replace("| 司令塔 | * | 承認を求める |", "| 司令塔 | 外 | 承認を求める |\n| 上記以外 | * | 承認を求める |")
        self.assertEqual(_ids(_structural([_doc(md)]), "ST-DT-"), [])

    def test_宣言外の値を拾う(self):
        md = DT_DOC.replace("| 司令塔 | 中 |", "| 司令塔 | 横 |")
        self.assertTrue(any(i.startswith("ST-DT-VALUE-") for i in _ids(_structural([_doc(md)]), "ST-DT-")))


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class CompactAndParity(unittest.TestCase):
    def test_CLI_は短い形で出し_文面を載せない(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.md"
            p.write_text(STATE_DOC)
            inp = Path(d) / "in.json"
            inp.write_text(json.dumps({"documents": [{"key": "specifications/flow", "kind": "specifications", "path": str(p), "ids": []}], "flow": FLOW_OK}, ensure_ascii=False))
            r = subprocess.run(["node", str(DOC_CHECK), str(inp)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        codes = {g["c"] for g in out["structural"]["findings"]}
        self.assertTrue({"STATE_MISSING", "STATE_NONDET", "FLOW_UNATTACHED"} <= codes)
        self.assertNotIn("issue", r.stdout)

    def test_flow_の検査区間と_checker_向けの形が_3_ファイルで逐語一致(self):
        cli = _marked_block(DOC_CHECK.read_text(), "FLOW_GRAPH")
        self.assertEqual(_marked_block(DRAFT, "FLOW_GRAPH"), cli)
        self.assertEqual(_marked_block(REFINE, "FLOW_GRAPH"), cli)
        from test_function_parity import extract_function as normalized

        for name in ("flowForCheck", "flowContext", "execToTbd", "checkerDoc"):
            self.assertEqual(normalized(DRAFT, name), normalized(REFINE, name), name)

    def test_新しい種別は文面の表にある(self):
        table = _marked_block(DOC_CHECK.read_text(), "FINDING_TEXT")
        used = set(re.findall(r"c: '([A-Z_]+)'", DOC_CHECK.read_text()))
        for code in used:
            self.assertIn(f"  {code}: (", table, code)


def _classify_harness():
    return "\n".join([
        next(l for l in REFINE.split("\n") if l.startswith("const LADDER_KINDS = ")),
        next(l for l in REFINE.split("\n") if l.startswith("const FORMAL_FINDING = ")),
        "const LADDER_SCHEMA = {}",
        "const ROLE_OPTS = { ladderJudge: {} }",
        "const SKILL_DIR = '/skill'",
        "const roleHeader = () => ''",
        "const log = () => {}",
        "const findingDigest = (f) => f.id",
        "let agentCalls = 0",
        "const agent = async (prompt) => { agentCalls++; const fs = JSON.parse(prompt.slice(prompt.indexOf('\\n[') + 1)); "
        "return { classified: fs.map((f) => ({ digest: f.digest, kind: f.digest.startsWith('C-') ? 'consistency' : 'question', cited: ['SP-A-001', 'SP-A-002'], rationale: 'r' })) } }",
        _extract_function(REFINE, "partitionLadder"),
        _extract_function(REFINE, "classifyFindings"),
        "async function main(spec) { const r = await classifyFindings(spec.findings, 'x'); return { ...r, agentCalls } }",
    ])


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class Routing(unittest.TestCase):
    def test_構造検査の閉包指摘は_judge_を通らず_writer_へ(self):
        findings = [
            {"id": "ST-STATE-NONDET-specifications/flow-文書生成中-E3", "auditor": "structural", "document": "specifications/flow", "issue": "2 つの行き先"},
            {"id": "ST-DT-GAP-x", "auditor": "structural", "document": "specifications/flow", "issue": "欠け"},
            {"id": "ST-FLOW-UNATTACHED-F-004", "auditor": "structural", "document": "specifications/flow", "issue": "未割当"},
        ]
        r = _node(_classify_harness(), {"findings": findings})
        self.assertEqual(r["agentCalls"], 0)
        self.assertEqual(r["needsInput"], [])
        self.assertEqual(sorted(f["id"] for f in r["toWriter"]), sorted(f["id"] for f in findings))

    def test_consistency_は_cited_付きで_writer_へ_question_は人間へ(self):
        findings = [
            {"id": "C-001", "auditor": "consistency", "document": "d", "issue": "免除条件が項目で違う"},
            {"id": "Q-001", "auditor": "validity", "document": "d", "issue": "上限額"},
            {"id": "ST-STATE-MISSING-d-a-E1", "auditor": "structural", "document": "d", "issue": "欠け"},
        ]
        r = _node(_classify_harness(), {"findings": findings})
        self.assertEqual(r["agentCalls"], 1)
        writer = {f["id"]: f for f in r["toWriter"]}
        self.assertEqual(writer["C-001"]["ladder_kind"], "consistency")
        self.assertEqual(writer["C-001"]["cited"], ["SP-A-001", "SP-A-002"])
        self.assertIn("ST-STATE-MISSING-d-a-E1", writer)
        self.assertEqual([f["id"] for f in r["needsInput"]], ["Q-001"])

    def test_writer_が閉じる着手不能は_judge_を通らず_writer_へ(self):
        # judge は resolved_by を見ないので、全件 question と答えても needs_input に落ちないこと。
        findings = [
            {"id": "EX-001", "auditor": "executability", "severity": "blocking", "resolved_by": "writer", "document": "d", "issue": "表と図が違う"},
            {"id": "EX-WRITER-abc1234", "auditor": "executability", "severity": "blocking", "resolved_by": "writer", "document": "d", "issue": "戻り先が無い", "from_draft": True},
            {"id": "EX-002", "auditor": "executability", "severity": "blocking", "resolved_by": "requester", "document": "d", "issue": "上限額"},
        ]
        r = _node(_classify_harness(), {"findings": findings})
        self.assertEqual(sorted(f["id"] for f in r["toWriter"]), ["EX-001", "EX-WRITER-abc1234"])
        self.assertEqual([f["id"] for f in r["needsInput"]], ["EX-002"])

    def test_閉包指摘は_TBD_に化けない(self):
        # blocking TBD の起票元は writer の tbd_items / execToTbd / ladderToTbd（needs_input）だけで、
        # 構造検査の指摘をそこへ入れる経路が無い。
        start = REFINE.index("const tbdItems = mergeTbd(") if "const tbdItems = mergeTbd(" in REFINE else REFINE.index("execToTbd(execFindings), needsInputTbd]")
        self.assertIn("[...documents.map((d) => d.tbd_items), execToTbd(execFindings), needsInputTbd]", REFINE)
        self.assertGreater(start, 0)

    def test_writer_が閉じる着手不能は_TBD_にしない(self):
        src = _extract_function(DRAFT, "execToTbd") + "\nfunction stableKey(t) { return t.length.toString(36) }\nfunction main(spec) { return execToTbd(spec) }"
        out = _node(src, [
            {"id": "EX-1", "severity": "blocking", "resolved_by": "writer", "document": "d", "location": "l", "issue": "表と図が違う"},
            {"id": "EX-2", "severity": "blocking", "resolved_by": "requester", "document": "d", "location": "l", "issue": "上限額"},
            {"id": "EX-3", "severity": "blocking", "document": "d", "location": "l", "issue": "欠けたら依頼者"},
        ])
        self.assertEqual(sorted(t["source_finding_id"] for t in out), ["EX-2", "EX-3"])
        self.assertIn("f.severity === 'blocking' && f.resolved_by === 'writer'", DRAFT)

    def test_precedent_judge_は_internal_を書き手の経路へ回す(self):
        self.assertIn("enum: ['resolvable', 'internal', 'measurable', 'novel', 'conflict', 'irreversible']", REFINE)
        self.assertIn("const internalCandidates = withVerdict('internal').filter((t) => t.cited.length)", REFINE)
        self.assertIn("await runResolveCandidates(items, 'internal')", REFINE)
        self.assertRegex(CONTRACTS, prose_pattern("| `internal` |"))


def _entry_harness():
    return "\n".join([
        next(l for l in REFINE.split("\n") if l.startswith("const MAX_OUTER_ROUNDS = ")),
        _marked_block(REFINE, "FLOW_GRAPH"),
        _extract_function(REFINE, "entryErrors"),
        _extract_function(REFINE, "buildNextArgs"),
        "function main(spec) { const na = buildNextArgs(spec.ctx); return { na, ok: entryErrors({ ...na, tbd_answers: '回答' }), broken: entryErrors({ ...na, flow: spec.broken }) } }",
    ])


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class Wiring(unittest.TestCase):
    def test_flow_framer_が手順_2_に配線されている(self):
        self.assertTrue((SKILL / "agents" / "flow-framer.md").exists())
        self.assertIn("## 2. 事前分析を発行する（4 agent 並列）", SKILL_MD)
        self.assertIn("Read [SKILL_DIR]/agents/flow-framer.md", SKILL_MD)
        self.assertIn("flow: <手順 2 の flow-framer の返り値をそのまま>", SKILL_MD)
        self.assertIn("flow: <手順 2 の flow をそのまま>", SKILL_MD)
        self.assertIn("## §flow-framer", CONTRACTS)
        fm = (SKILL / "agents" / "flow-framer.md").read_text().split("---")[1]
        self.assertIn("model: opus", fm)

    def test_draft_は崩れた_flow_を入口で止める(self):
        self.assertIn("args.flow が閉じていません", DRAFT)
        self.assertIn("flow: flowForCheck(flow)", DRAFT)
        self.assertLess(DRAFT.index("// FLOW_GRAPH_END"), DRAFT.index("args.flow が閉じていません"))
        src = f"import {{ flowGraphCompact }} from {json.dumps(DOC_CHECK.as_uri())}\nfunction main(spec) {{ return flowGraphCompact(spec).map((f) => f.c) }}"
        self.assertEqual(_node(src, FLOW_OK), [])
        self.assertTrue(_node(src, FLOW_BROKEN))

    def test_refine_の入口は_flow_を検査し_next_args_に載せる(self):
        from test_next_args import _ctx

        r = _node(_entry_harness(), {"ctx": _ctx(draft_dir="/ws/drafts/r1", flow=FLOW_OK), "broken": FLOW_BROKEN})
        self.assertEqual(r["na"]["flow"], FLOW_OK)
        self.assertEqual(r["ok"], [])
        self.assertTrue(any("args.flow が閉じていません" in e for e in r["broken"]))
        self.assertIn("flow: flowForCheck(flow),", REFINE)

    def test_flow_refs_が文書に載って持ち越される(self):
        from test_next_args import _ctx

        ctx = _ctx(draft_dir="/ws/drafts/r1")
        ctx["documents"][0]["flow_refs"] = [{"item_id": "PR-AUTH-001", "ref": "F-001"}]
        r = _node(_entry_harness(), {"ctx": ctx, "broken": FLOW_BROKEN})
        self.assertEqual(r["na"]["documents"][0]["flow_refs"], [{"item_id": "PR-AUTH-001", "ref": "F-001"}])
        for src in (DRAFT, REFINE):
            self.assertIn("flow_refs: { type: 'array', items: FLOW_REF_ITEM }", src)


if __name__ == "__main__":
    unittest.main()
