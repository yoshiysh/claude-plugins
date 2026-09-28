"""状態 × イベント表・判定表・工程の流れ（flow）の閉包検査と、その指摘の戻り先のテスト。

実 run（6 文書）で依頼者に届いた 12 問は、ほぼ全件が文書内の不整合だった（表と図が同じ入力に
別の遷移を定める・中断点の後に戻り先が無い・免除条件が項目ごとにずれる・省ける工程の集合が
定義されていない）。これを人間ゲートではなく書き手へ返すため、次を固定する。

1. doc_check.mjs が flow の閉包（行き先の無い判断の値・実在しない行き先・辿り着けない要素・
   項目の当たっていない要素）を検出する
2. 状態 × イベント表の網羅・一意・到達・表と図の一致を検出し、「発生しない」を定義済みと数える
3. 判定表の組み合わせの欠け・重なりを検出する
4. 短い形で出力される
5. 閉包検査は doc_check.mjs の 1 か所だけにあり、prd.js は写しを持たず state に flow の本体を載せない
   （doc_check の stdout で閉じない flow では初稿を始めない経路は tests/test_prd_stages.py が走らせて確かめる）
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / "scripts"
DOC_CHECK = SCRIPTS / "doc_check.mjs"
PRD = (SCRIPTS / "prd.js").read_text()


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


def _flow_table(flow):
    """doc_check.mjs の flowTableCompact（短い形）を当て、(種別, 引数) の組にする。"""
    src = f"import {{ flowTableCompact }} from {json.dumps(DOC_CHECK.as_uri())}\n" + "function main(spec) { return flowTableCompact(spec.flow) }"
    return [(f["c"], f["a"]) for f in _node(src, {"flow": flow})]


def _codes(found, code):
    return [a for c, a in found if c == code]


PR_STATES = ["MERGED", "OPEN", "CLOSED", "無し", "不明"]


def _cleanup_flow():
    """前回の試走（cleanup-branches）の F-010〜F-013 の最小の再現。F-012 は PR の状態 5 値 × 場所 2 値で、
    取り込みなし × OPEN と 取り込みなし × 不明（gh が使えない × 基準ブランチに無い remote ブランチ）のマスが無い。"""
    src = {"input": "依頼文"}
    return {
        "elements": [
            {"id": "F-001", "type": "input", "kind": "k", "label": "ブランチの一覧", "next": ["F-010"], "source": src, "obtain": "always"},
            {"id": "F-010", "type": "decision", "kind": "k", "label": "PR の状態", "source": src,
             "inputs": [{"name": "PR", "values": PR_STATES, "from": "F-001"}],
             "cases": [{"when": {"PR": v}, "branch": v, "source": src} for v in PR_STATES],
             "branches": [{"value": v, "next": "F-011"} for v in PR_STATES]},
            {"id": "F-011", "type": "step", "kind": "k", "label": "場所の判定", "next": ["F-012"], "source": src, "obtain": "always"},
            {"id": "F-012", "type": "decision", "kind": "k", "label": "ref ごとの分類", "source": src,
             "inputs": [{"name": "PR の状態", "values": PR_STATES, "from": "F-010"},
                        {"name": "場所", "values": ["取り込み済み", "取り込みなし"], "from": "F-011"}],
             "cases": [{"when": {"PR の状態": "*", "場所": "取り込み済み"}, "branch": "削除候補", "source": src},
                       {"when": {"PR の状態": "MERGED", "場所": "取り込みなし"}, "branch": "削除候補", "source": src},
                       {"when": {"PR の状態": "CLOSED", "場所": "取り込みなし"}, "branch": "要判断", "source": src},
                       {"when": {"PR の状態": "無し", "場所": "取り込みなし"}, "branch": "要判断", "source": src}],
             "branches": [{"value": "削除候補", "next": "F-013"}, {"value": "要判断", "next": "F-014"}]},
            {"id": "F-013", "type": "output", "kind": "k", "label": "削除する ref", "source": src},
            {"id": "F-014", "type": "output", "kind": "k", "label": "要判断の ref", "source": src},
        ],
        "kinds": [{"name": "k", "definition": "d"}],
        "closure": "c",
    }


def _el(flow, id_):
    return next(e for e in flow["elements"] if e["id"] == id_)


def _f051_flow(obtain="may_fail", values=("true", "false"), unknown=None):
    """再試走の F-051 の最小の再現。current_branch_open_pr は remote の取り込み（F-004）から来るが、値は 2 つだけだった。"""
    src = {"input": "依頼文"}
    inp = {"name": "current_branch_open_pr", "values": list(values), "from": "F-004"}
    if unknown is not None:
        inp["unknown"] = unknown
    step = {"id": "F-004", "type": "step", "kind": "k", "label": "状態を取る", "next": ["F-051"], "source": src}
    if obtain is not None:
        step["obtain"] = obtain
    return {"elements": [
        {"id": "F-001", "type": "input", "kind": "k", "label": "l", "next": ["F-004"], "source": src},
        step,
        {"id": "F-051", "type": "decision", "kind": "k", "label": "open PR があるか", "source": src, "inputs": [inp],
         "cases": [{"when": {"current_branch_open_pr": "true"}, "branch": "あり", "source": src},
                   {"when": {"current_branch_open_pr": "false"}, "branch": "なし", "source": src}],
         "branches": [{"value": "あり", "next": "F-052"}, {"value": "なし", "next": "F-053"}]},
        {"id": "F-052", "type": "output", "kind": "k", "label": "o", "source": src},
        {"id": "F-053", "type": "output", "kind": "k", "label": "o2", "source": src},
    ]}


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class FlowTable(unittest.TestCase):
    def test_前回のF012の形は欠けた2マスをFLOW_DT_GAPに出す(self):
        found = _flow_table(_cleanup_flow())
        self.assertEqual(
            sorted(_codes(found, "FLOW_DT_GAP")),
            [["F-012", "PR の状態=OPEN, 場所=取り込みなし"], ["F-012", "PR の状態=不明, 場所=取り込みなし"]],
        )
        self.assertEqual(found and [c for c, _ in found if c != "FLOW_DT_GAP"], [])

    def test_マスを埋めれば何も出さない(self):
        flow = _cleanup_flow()
        _el(flow, "F-012")["cases"].append({"when": {"上記以外": True}, "branch": "要判断", "source": {"open": "O-001"}})
        self.assertEqual(_flow_table(flow), [])

    def test_重なりと宣言外の値と書かれていない入力を拾う(self):
        flow = _cleanup_flow()
        cases = _el(flow, "F-012")["cases"]
        cases.append({"when": {"PR の状態": "MERGED", "場所": "*"}, "branch": "要判断", "source": {"input": "x"}})
        cases.append({"when": {"PR の状態": "DRAFT", "場所": "取り込みなし"}, "branch": "要判断", "source": {"input": "x"}})
        cases.append({"when": {"PR の状態": "OPEN"}, "branch": "要判断", "source": {"input": "x"}})
        found = _flow_table(flow)
        self.assertIn(["F-012", "PR の状態=MERGED, 場所=取り込みなし", 2, 5], _codes(found, "FLOW_DT_OVERLAP"))
        self.assertIn(["F-012", "PR の状態", "DRAFT"], _codes(found, "FLOW_DT_VALUE"))
        self.assertIn(["F-012", "場所", "（書かれていない）"], _codes(found, "FLOW_DT_VALUE"))

    def test_表の無い判断と枝に無いcaseと選ばれない枝と実在しないfromを拾う(self):
        flow = _cleanup_flow()
        del _el(flow, "F-010")["inputs"]
        f12 = _el(flow, "F-012")
        f12["cases"][3]["branch"] = "保持"
        f12["inputs"][1]["from"] = "F-404"
        f12["branches"].append({"value": "保留", "next": "F-014"})
        found = _flow_table(flow)
        self.assertEqual(_codes(found, "FLOW_NO_TABLE"), [["F-010"]])
        self.assertEqual(_codes(found, "FLOW_CASE_BRANCH"), [["F-012", 4, "保持"]])
        self.assertEqual(_codes(found, "FLOW_BRANCH_UNUSED"), [["F-012", "保留"]])
        self.assertEqual(_codes(found, "FLOW_INPUT_FROM"), [["F-012", "場所", "F-404"]])

    def test_全枝が同じ行き先で下流が値を使わない判断はFLOW_SAME_NEXT(self):
        flow = _cleanup_flow()
        self.assertEqual(_codes(_flow_table(flow), "FLOW_SAME_NEXT"), [])
        _el(flow, "F-012")["inputs"][0]["from"] = "F-011"
        self.assertEqual(_codes(_flow_table(flow), "FLOW_SAME_NEXT"), [["F-010", "F-011"]])

    def test_上流の判断が値を使っても下流の宣言にはならない(self):
        src = {"input": "依頼文"}
        dec = lambda id_, frm, nxt: {
            "id": id_, "type": "decision", "kind": "k", "label": id_, "source": src,
            "inputs": [{"name": "v", "values": ["a", "b"], "from": frm}],
            "cases": [{"when": {"v": "a"}, "branch": "a", "source": src}, {"when": {"v": "b"}, "branch": "b", "source": src}],
            "branches": [{"value": "a", "next": nxt}, {"value": "b", "next": nxt}],
        }
        flow = {"elements": [
            {"id": "F-001", "type": "input", "kind": "k", "label": "l", "next": ["F-002"], "source": src},
            dec("F-002", "F-003", "F-003"),
            dec("F-003", "F-001", "F-004"),
            {"id": "F-004", "type": "output", "kind": "k", "label": "o", "source": src},
        ]}
        self.assertEqual(_codes(_flow_table(flow), "FLOW_SAME_NEXT"), [["F-002", "F-003"], ["F-003", "F-004"]])

    def test_前回の試走の2値の分類は表が無く全枝が同じ行き先(self):
        flow = _cleanup_flow()
        for id_ in ("F-010", "F-012"):
            el = _el(flow, id_)
            del el["inputs"], el["cases"]
        _el(flow, "F-012")["branches"][1]["next"] = "F-013"
        found = _flow_table(flow)
        self.assertEqual(sorted(_codes(found, "FLOW_NO_TABLE")), [["F-010"], ["F-012"]])
        self.assertEqual(sorted(_codes(found, "FLOW_SAME_NEXT")), [["F-010", "F-011"], ["F-012", "F-013"]])

    def test_組み合わせが上限を超えた判断だけをFLOW_DT_SIZEにする(self):
        max_combos = int(re.search(r"const DT_MAX_COMBOS = (\d+)", DOC_CHECK.read_text()).group(1))
        src = {"input": "依頼文"}

        def flow(n):
            return {"elements": [
                {"id": "F-001", "type": "input", "kind": "k", "label": "l", "next": ["F-002"], "source": src, "obtain": "always"},
                {"id": "F-002", "type": "decision", "kind": "k", "label": "d", "source": src,
                 "inputs": [{"name": "a", "values": [str(i) for i in range(n)], "from": "F-001"}],
                 "cases": [{"when": {"a": "0"}, "branch": "q", "source": src}, {"when": {"上記以外": True}, "branch": "p", "source": src}],
                 "branches": [{"value": "p", "next": "F-003"}, {"value": "q", "next": "F-004"}]},
                {"id": "F-003", "type": "output", "kind": "k", "label": "o", "source": src},
                {"id": "F-004", "type": "output", "kind": "k", "label": "o2", "source": src},
            ]}

        self.assertEqual(_flow_table(flow(max_combos)), [], "ちょうど上限は検査する")
        self.assertEqual(_flow_table(flow(max_combos + 1)), [("FLOW_DT_SIZE", ["F-002", max_combos + 1])])

    def test_fromの要素にobtainが無いか値の外ならFLOW_OBTAIN_MISSING(self):
        self.assertEqual(_codes(_flow_table(_f051_flow(obtain=None)), "FLOW_OBTAIN_MISSING"), [["F-004", ""]])
        self.assertEqual(_codes(_flow_table(_f051_flow(obtain="sometimes")), "FLOW_OBTAIN_MISSING"), [["F-004", "sometimes"]])

    def test_may_failの直後の判断にunknownが無ければ扱いが無く値の外ならFLOW_INPUT_UNKNOWN(self):
        self.assertEqual(_flow_table(_f051_flow()), [("FLOW_FAIL_UNHANDLED", ["F-004", False])])
        self.assertEqual(_codes(_flow_table(_f051_flow(unknown="不明")), "FLOW_INPUT_UNKNOWN"), [["F-051", "current_branch_open_pr", "不明"]])
        self.assertEqual(_flow_table(_f051_flow(obtain="always")), [])

    def test_F051に不明の値を足しcaseが無ければFLOW_DT_GAPが1件(self):
        found = _flow_table(_f051_flow(values=("true", "false", "不明"), unknown="不明"))
        self.assertEqual(found, [("FLOW_DT_GAP", ["F-051", "current_branch_open_pr=不明"])])

    def test_F013の形でunknownが既存の値なら何も出さない(self):
        flow = _f051_flow(values=("取り込み済み", "取り込み済みと確認できない"), unknown="取り込み済みと確認できない")
        for c, v in zip(_el(flow, "F-051")["cases"], ("取り込み済み", "取り込み済みと確認できない")):
            c["when"] = {"current_branch_open_pr": v}
        self.assertEqual(_flow_table(flow), [])

    def test_unknownのマスを上記以外に任せるとFLOW_UNKNOWN_CASE(self):
        flow = _f051_flow(values=("true", "false", "不明"), unknown="不明")
        cases = _el(flow, "F-051")["cases"]
        cases.append({"when": {"上記以外": True}, "branch": "なし", "source": {"input": "依頼文"}})
        self.assertEqual(_flow_table(flow), [("FLOW_UNKNOWN_CASE", ["F-051", "current_branch_open_pr", "current_branch_open_pr=不明"])])
        cases[-1]["when"] = {"current_branch_open_pr": "不明"}
        self.assertEqual(_flow_table(flow), [])

    def test_unknownのマスをワイルドカードに任せてもFLOW_UNKNOWN_CASE(self):
        flow = _cleanup_flow()
        f12 = _el(flow, "F-012")
        f12["inputs"][1] = {**f12["inputs"][1], "values": ["取り込み済み", "取り込みなし", "確認できない"], "unknown": "確認できない"}
        _el(flow, "F-011")["obtain"] = "may_fail"
        f12["cases"].append({"when": {"上記以外": True}, "branch": "要判断", "source": {"open": "O-001"}})
        found = _codes(_flow_table(flow), "FLOW_UNKNOWN_CASE")
        self.assertEqual(len(found), len(PR_STATES), "取り込み済みの * の case と上記以外は、確認できないのマスを受けたことにならない")
        f12["cases"].append({"when": {"PR の状態": "*", "場所": "確認できない"}, "branch": "要判断", "source": {"open": "O-001"}})
        self.assertEqual(_flow_table(flow), [])

    def test_unknownの列に置いたワイルドカードもunknownを受けたことにならない(self):
        src = {"input": "依頼文"}
        flow = {"elements": [
            {"id": "F-001", "type": "input", "kind": "k", "label": "l", "next": ["F-002"], "source": src, "obtain": "always"},
            {"id": "F-002", "type": "step", "kind": "k", "label": "取る", "next": ["F-003"], "source": src, "obtain": "may_fail", "effect": "read"},
            {"id": "F-003", "type": "decision", "kind": "k", "label": "d", "source": src,
             "inputs": [{"name": "a", "values": ["x", "y"], "from": "F-001"}, {"name": "b", "values": ["p", "不明"], "from": "F-002", "unknown": "不明"}],
             "cases": [{"when": {"a": "x", "b": "*"}, "branch": "A", "source": src}, {"when": {"a": "y", "b": "p"}, "branch": "B", "source": src},
                       {"when": {"a": "y", "b": "不明"}, "branch": "B", "source": src}],
             "branches": [{"value": "A", "next": "F-004"}, {"value": "B", "next": "F-005"}]},
            {"id": "F-004", "type": "output", "kind": "k", "label": "o", "source": src},
            {"id": "F-005", "type": "output", "kind": "k", "label": "o2", "source": src},
        ]}
        self.assertEqual(_flow_table(flow), [("FLOW_UNKNOWN_CASE", ["F-003", "b", "a=x, b=不明"])])

    def test_契約の例の判定表は検査を通る(self):
        text = (SKILL / "schemas" / "agent-contracts.md").read_text(encoding="utf-8")
        example = json.loads(re.search(r"```json\n(.*?)\n```", text[text.index("\n## flow.json の形\n"):], re.S).group(1))
        self.assertTrue(any("unknown" in i for el in example["elements"] for i in el.get("inputs", [])))
        self.assertEqual(_flow_table(example), [])

    def test_文書の判定表とflowは同じ展開の関数を使う(self):
        cli = DOC_CHECK.read_text()
        self.assertEqual(cli.count("combos = [[]]"), 1)
        self.assertGreaterEqual(len(re.findall(r"\btableFindings\(", cli)), 3)


FLOW_FAIL = json.loads((Path(__file__).resolve().parent / "fixtures" / "flow_fail.json").read_text(encoding="utf-8"))


def _shape(name):
    return json.loads(json.dumps(FLOW_FAIL[name]))


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class FlowFailHandling(unittest.TestCase):
    """may_fail の失敗は、直後の成否の判断（a）か on_fail（b）のどちらか 1 つで値になる。下流への伝播は計算しない。"""

    def test_値を使わない判断を挟んでも扱いの無い失敗はFLOW_FAIL_UNHANDLED(self):
        flow = _shape("a_decision")
        self.assertEqual(_flow_table(flow), [("FLOW_FAIL_UNHANDLED", ["F-002", False])])
        _el(flow, "F-002")["on_fail"] = {"as": "取れない", "source": {"input": "依頼文"}}
        self.assertEqual(_flow_table(flow), [], "on_fail で扱えば下流は何も要らない")

    def test_直後に成否の判断を置けば通る(self):
        flow = _shape("a_decision")
        _el(flow, "F-002")["next"] = ["F-008"]
        flow["elements"].append({"id": "F-008", "type": "decision", "kind": "k", "label": "取れたか", "source": {"input": "依頼文"},
                                 "inputs": [{"name": "取得", "values": ["取れた", "取れない"], "from": "F-002", "unknown": "取れない"}],
                                 "cases": [{"when": {"取得": "取れた"}, "branch": "続ける", "source": {"input": "依頼文"}},
                                           {"when": {"取得": "取れない"}, "branch": "やめる", "source": {"input": "依頼文"}}],
                                 "branches": [{"value": "続ける", "next": "F-003"}, {"value": "やめる", "next": "F-091"}]})
        self.assertEqual(_flow_table(flow), [])

    def test_on_failで扱った失敗の先に起こり得ないunknownを求めない(self):
        flow = _shape("ws_on_fail")
        self.assertEqual(_flow_table(flow), [])
        del _el(flow, "F-004")["on_fail"]
        self.assertEqual(_flow_table(flow), [("FLOW_FAIL_UNHANDLED", ["F-004", False])], "F-017 に unknown を求めない")

    def test_on_failの要素を読む入力はvaluesにasが要る(self):
        flow = _shape("ws_on_fail")
        f17 = _el(flow, "F-017")
        f17["inputs"][0]["from"] = "F-004"
        self.assertEqual(_flow_table(flow), [("FLOW_INPUT_ON_FAIL", ["F-017", "primary か", "取れない"])])
        f17["inputs"][0]["values"].append("取れない")
        f17["cases"].append({"when": {"primary か": "取れない"}, "branch": "それ以外", "source": {"input": "依頼文"}})
        self.assertEqual(_flow_table(flow), [])

    def test_成功の枝の先はunknownが要らず失敗の枝の先は要る(self):
        self.assertEqual(_flow_table(_shape("after_check")), [("FLOW_INPUT_UNKNOWN", ["F-005", "値", ""])])

    def test_直後の判断とon_failの両方はFLOW_FAIL_UNHANDLED(self):
        flow = _shape("after_check")
        _el(flow, "F-002")["on_fail"] = {"as": "取れない", "source": {"input": "依頼文"}}
        self.assertIn(("FLOW_FAIL_UNHANDLED", ["F-002", True]), _flow_table(flow))

    def test_判断を読む入力はbranchesと同じ値かbranch_mapが要る(self):
        flow = _shape("f024")
        self.assertEqual(_flow_table(flow), [], "失敗の枝が集約の後も独立した値に写る F-024 の形は通る")
        inp = _el(flow, "F-004")["inputs"][0]
        del inp["branch_map"]["残す"]
        self.assertEqual(_flow_table(flow), [("FLOW_INPUT_BRANCH_MAP", ["F-004", "ローカルの要判断", "F-003"])])
        del inp["branch_map"]
        self.assertEqual(_flow_table(flow), [("FLOW_INPUT_BRANCH_MAP", ["F-004", "ローカルの要判断", "F-003"])])
        inp["values"] = ["取り込み済み", "残す", "要判断"]
        _el(flow, "F-004")["cases"] = [{"when": {"ローカルの要判断": v}, "branch": b, "source": {"input": "依頼文"}}
                                       for v, b in (("取り込み済み", "0 件"), ("残す", "0 件"), ("要判断", "1 件以上"))]
        self.assertEqual(_flow_table(flow), [], "branches と同じ値なら宣言は要らない")

    def test_失敗の枝と失敗でない枝を同じ値に写すとFLOW_FAIL_MERGED(self):
        flow = _shape("f024")
        _el(flow, "F-004")["inputs"][0]["branch_map"]["要判断"] = "0 件"
        self.assertEqual(_codes(_flow_table(flow), "FLOW_FAIL_MERGED"), [["F-004", "ローカルの要判断", "F-003"]])

    def test_失敗の枝を持つ判断を数える工程を読む入力はfailure_valueが要る(self):
        flow = _shape("b_step")
        self.assertEqual(_flow_table(flow), [])
        del _el(flow, "F-005")["inputs"][0]["failure_value"]
        self.assertEqual(_flow_table(flow), [("FLOW_AGGREGATE_FAILURE", ["F-005", "ローカルの要判断", "F-004"])])
        _el(flow, "F-004")["aggregates"] = ["F-404"]
        self.assertEqual(_codes(_flow_table(flow), "FLOW_AGGREGATE_FAILURE"), [["F-005", "ローカルの要判断", "F-004"]], "判断でない ID でも外れない")
        del _el(flow, "F-004")["aggregates"]
        self.assertEqual(_flow_table(flow), [], "aggregates の無い数える工程は見ていない（resolver-verifier の観点）")


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

    def test_prd_は閉包検査の写しも_flow_の本体も持たない(self):
        self.assertNotIn("FLOW_GRAPH_BEGIN", PRD)
        self.assertNotIn("state.flow =", PRD)

    def test_新しい種別は文面の表にある(self):
        cli = DOC_CHECK.read_text()
        table = _marked_block(cli, "FINDING_TEXT") + _marked_block(cli, "WORKSPACE_TEXT")
        used = set(re.findall(r"c: '([A-Z_]+)'", cli))
        for code in used:
            self.assertIn(f"  {code}: (", table, code)


if __name__ == "__main__":
    unittest.main()
