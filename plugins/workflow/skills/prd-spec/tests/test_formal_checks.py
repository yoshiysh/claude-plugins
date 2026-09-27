"""状態 × イベント表・判定表・工程の流れ（flow）の閉包検査と、その指摘の戻り先のテスト。

実 run（6 文書）で依頼者に届いた 12 問は、ほぼ全件が文書内の不整合だった（表と図が同じ入力に
別の遷移を定める・中断点の後に戻り先が無い・免除条件が項目ごとにずれる・省ける工程の集合が
定義されていない）。これを人間ゲートではなく書き手へ返すため、次を固定する。

1. doc_check.mjs が flow の閉包（行き先の無い判断の値・実在しない行き先・辿り着けない要素・
   項目の当たっていない要素）を検出する
2. 状態 × イベント表の網羅・一意・到達・表と図の一致を検出し、「発生しない」を定義済みと数える
3. 判定表の組み合わせの欠け・重なりを検出する
4. 短い形で出力され、flow の検査区間が doc_check.mjs と prd.js で逐語一致する
5. prd.js が flow-framer と回答を当てた resolver の返り値の flow に閉包検査を当て、閉じない flow では
   初稿を始めない（経路は tests/test_prd_stages.py が走らせて確かめる）
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

    def test_flow_の検査区間が_doc_check_と_prd_で逐語一致(self):
        # prd.js は import を書けないので、閉包検査を写しで持つ。写しがずれると、doc_check が通した flow を
        # script が止める（またはその逆）。
        self.assertEqual(_marked_block(PRD, "FLOW_GRAPH"), _marked_block(DOC_CHECK.read_text(), "FLOW_GRAPH"))

    def test_prd_は返り値の_flow_に閉包検査を当てる(self):
        self.assertIn("flowDefects(r.flow)", PRD)
        self.assertIn("return blocked(`流れが閉じていません。初稿を始めません", PRD)

    def test_新しい種別は文面の表にある(self):
        cli = DOC_CHECK.read_text()
        table = _marked_block(cli, "FINDING_TEXT") + _marked_block(cli, "WORKSPACE_TEXT")
        used = set(re.findall(r"c: '([A-Z_]+)'", cli))
        for code in used:
            self.assertIn(f"  {code}: (", table, code)


if __name__ == "__main__":
    unittest.main()
