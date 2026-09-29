"""scripts/doc_check.mjs（本文を読む決定的な検査の CLI）のテスト。

本文を Workflow script の手元に置かない設計にした（writer は同じファイルを Edit し、本文を返さない）。
本文を要する検査は agent がこの CLI を実行して件数と digest だけを返す。押さえるのは次のとおり。

1. CLI の出力が、移設前に script の中で計算していた結果と同一である（fixtures/doc_check の
   golden_head.json は移設前の HEAD の structuralFindings / lineTotal / newlineCount /
   changedLineRanges で生成した）
2. 読めない文書は CLI ごと落とさず、その文書の本文検査を「未検査」として返す
3. 出力は短い形で、文面を載せない
4. Workflow script（prd-spec.js）は本文（.markdown）を読まず、文面の表の写しも持たない
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from prd_script import PRD_PATH
from test_ledger import _exported  # noqa: E402

SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / "scripts"
DOC_CHECK = SCRIPTS / "doc_check.mjs"
PRD = PRD_PATH.read_text()
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "doc_check"


def _fixture_input():
    docs = []
    for m in json.loads((FIXTURES / "documents.json").read_text()):
        d = {k: v for k, v in m.items() if k not in ("file", "prev_file")}
        d["path"] = m["file"]
        if "prev_file" in m:
            d["prev_path"] = m["prev_file"]
        docs.append(d)
    return {"documents": docs}


def _marked_block(source: str, name: str) -> str:
    """// <name>_BEGIN 〜 // <name>_END の区間。"""
    return source[source.index(f"// {name}_BEGIN") : source.index(f"// {name}_END") + len(f"// {name}_END")]


def _expand(structural):
    """CLI の短い形を doc_check.mjs の expandStructural で文面付きに戻す。"""
    src = f"import {{ expandStructural }} from {json.dumps(DOC_CHECK.as_uri())}\n" + "function main(spec) { return expandStructural(spec) }"
    return _node(src, structural)


def _run_cli(input_obj, cwd=FIXTURES, entry=DOC_CHECK):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "input.json"
        f.write_text(json.dumps(input_obj, ensure_ascii=False))
        return subprocess.run(["node", str(entry), str(f)], cwd=cwd, capture_output=True, text=True)


def _node(src: str, spec) -> object:
    with tempfile.TemporaryDirectory() as d:
        script = Path(d) / "t.mjs"
        script.write_text(src + "\nconst spec = JSON.parse(process.argv[2])\n" + "process.stdout.write(JSON.stringify(main(spec)))\n")
        out = subprocess.run(["node", str(script), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class CliMatchesPreviousInScriptResults(unittest.TestCase):
    def setUp(self):
        r = _run_cli(_fixture_input())
        self.assertEqual(r.returncode, 0, r.stderr)
        self.out = json.loads(r.stdout)
        self.golden = json.loads((FIXTURES / "golden_head.json").read_text())

    def test_構造検査が移設前と同一(self):
        # CLI は短い形を出し、文面は表から組み立てる。組み立て結果は移設前の文面と 1 字も違わない
        # （文面は TBD-EX / TBD-NI の ID・novelty の digest・抑止の照合キーに入る）。
        expanded = _expand(self.out["structural"])
        self.assertEqual(expanded, self.golden["structural"])
        # fixture が検査の主要な分岐を実際に通っていること（空の一致で通らない）
        ids = {f["id"].split("-")[0] + "-" + f["id"].split("-")[1] for f in expanded["findings"]}
        for prefix in ("ST-ORPHAN", "ST-DANGLING", "ST-UNDECLARED", "ST-PHANTOM", "ST-OBSOLETE", "ST-MODAL",
                       "ST-TBD", "ST-GAP", "ST-UNVERIFIED", "ST-NOUNIT", "ST-NO", "ST-NON"):
            self.assertIn(prefix, ids)

    def test_行数と変更範囲が移設前と同一(self):
        got = [{k: d[k] for k in ("key", "line_count", "newline_count", "changed_ranges")} for d in self.out["documents"]]
        self.assertEqual(got, self.golden["documents"])

    def test_digest_が付く(self):
        self.assertRegex(self.out["input_digest"], r"^[0-9a-z]{7}$")
        self.assertRegex(self.out["output_digest"], r"^[0-9a-z]{7}$")


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class CliEdgeCases(unittest.TestCase):
    def test_読めない文書は未検査として返し_CLI_は落ちない(self):
        inp = _fixture_input()
        inp["documents"][0]["path"] = "does-not-exist.md"
        r = _run_cli(inp)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        first = out["documents"][0]
        self.assertEqual((first["exists"], first["line_count"], first["changed_ranges"]), (False, None, None))
        expanded = _expand(out["structural"])
        self.assertIn("ST-NOTCHECKED-BODY-requirements/auth", [n["id"] for n in expanded["not_checked"]])
        # 読めた文書の検査は失われない
        self.assertTrue(any(f["document"] == "specifications/auth" for f in expanded["findings"]))

    def test_申告の無い固定文書は本文から_ID_を補う(self):
        inp = _fixture_input()
        base = inp["documents"][2]
        base["ids"] = []
        base["extract_ids"] = True
        out = json.loads(_run_cli(inp).stdout)
        self.assertEqual(out["documents"][2]["ids_in_text"], ["PR-BASE-001"])
        # 補った ID で照合される（補わなければ ORPHAN にならず、トレーサビリティの穴が見えない）
        self.assertIn("ST-ORPHAN-REQ-PR-BASE-001", [f["id"] for f in _expand(out["structural"])["findings"]])

    def test_不正な入力は非ゼロで終わる(self):
        r = _run_cli({"documents": [{"key": "x"}]})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("doc_check:", r.stderr)

    def test_symlink_経由で起動しても出力する(self):
        # plugin のパスは symlink を含みうる。main 判定を文字列比較にすると黙って何も出さない。
        with tempfile.TemporaryDirectory() as d:
            link = Path(d) / "doc_check.mjs"
            os.symlink(DOC_CHECK, link)
            r = _run_cli(_fixture_input(), entry=link)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("output_digest", r.stdout)

    def test_import_しただけでは実行しない(self):
        src = f"import {{ runChecks }} from {json.dumps(DOC_CHECK.as_uri())}\nprocess.stdout.write(typeof runChecks)\n"
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "t.mjs"
            p.write_text(src)
            r = subprocess.run(["node", str(p)], capture_output=True, text=True, check=True)
        self.assertEqual(r.stdout, "function")


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class CompactOutput(unittest.TestCase):
    """checker は CLI の出力を書き写して返すので、出力の量がそのまま写す量と写し間違いの機会になる。"""

    def test_出力に文面を載せない(self):
        out = json.loads(_run_cli(_fixture_input()).stdout)
        text = json.dumps(out["structural"], ensure_ascii=False)
        for key in ('"issue"', '"fix"', '"location"', '"quote"', '"auditor"'):
            self.assertNotIn(key, text)
        for g in out["structural"]["findings"]:
            self.assertEqual(set(g), {"c", "d", "a"})
            self.assertIsInstance(g["a"], list)

    def test_指摘が数百件の入力でも_50KB_を十分下回る(self):
        # トレーサビリティ表も trace も申告されていない最悪の形（ORPHAN が数百件出る）で測る。
        # 短い形にしないと、この入力で約 490KB になる。
        with tempfile.TemporaryDirectory() as tmp:
            docs = []
            for kind, prefix in (("requirements", "PR"), ("specifications", "SP")):
                for topic in ("alpha", "beta", "gamma", "delta"):
                    tag = topic.upper()
                    ids = [f"{prefix}-{tag}-{n:03d}" for n in range(1, 121)]
                    p = Path(tmp) / f"{kind}-{topic}.md"
                    p.write_text(f"# {kind} {topic}\n\n" + "".join(f"- {i}: {topic} の項目 {i} を満たす。\n" for i in ids))
                    docs.append({"key": f"{kind}/{topic}", "kind": kind, "topic": topic, "path": str(p), "fixed": False,
                                 "ids": ids, "referenced": [], "vacant": [], "tbd_items": [], "traceability": []})
            r = _run_cli({"documents": docs})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLess(len(r.stdout.encode()), _exported("m.STDOUT_BUDGET"))
        # 短くしても指摘は 1 件も落ちない（展開すると全件の文面が戻る）
        expanded = _expand(json.loads(r.stdout)["structural"])
        self.assertGreater(len(expanded["findings"]), 500)

    def test_ids_in_text_は求めたときだけ(self):
        out = json.loads(_run_cli(_fixture_input()).stdout)
        self.assertTrue(all("ids_in_text" not in d for d in out["documents"]))

    def test_byte_size_は_UTF_8_のバイト数(self):
        out = json.loads(_run_cli(_fixture_input()).stdout)
        for d, m in zip(out["documents"], json.loads((FIXTURES / "documents.json").read_text())):
            self.assertEqual(d["byte_size"], len((FIXTURES / m["file"]).read_bytes()))

    def test_索引は_index_dir_を渡したときだけ書き_本文は出力に載せない(self):
        with tempfile.TemporaryDirectory() as tmp:
            inp = _fixture_input()
            inp["index_dir"] = str(Path(tmp) / "index")
            inp["index_extra"] = ["requirements-base.md"]
            out = json.loads(_run_cli(inp).stdout)
            for d in out["documents"]:
                idx = Path(d["index_path"])
                self.assertTrue(idx.is_file())
                lines = idx.read_text().splitlines()
                self.assertEqual(d["index_lines"], len(lines))
                for ln in lines[1:]:
                    self.assertRegex(ln, r"^\d+-\d+ #{2,4} ")
            self.assertEqual(out["index_extra"][0]["path"], "requirements-base.md")
            self.assertTrue(Path(out["index_extra"][0]["index_path"]).is_file())
        self.assertTrue(all("index_path" not in d for d in json.loads(_run_cli(_fixture_input()).stdout)["documents"]))

    def test_索引の範囲は次の同格以上の見出しの手前まで(self):
        src = f"import {{ headingIndex }} from {json.dumps(DOC_CHECK.as_uri())}\n" + "function main(spec) { return headingIndex(spec.md) }"
        md = "# t\n## A\na\n### A1\nb\n```\n## not heading\n```\n## B\nc\n"
        self.assertEqual(
            _node(src, {"md": md}),
            [
                {"level": 2, "start": 2, "heading": "## A", "end": 8},
                {"level": 3, "start": 4, "heading": "### A1", "end": 8},
                {"level": 2, "start": 9, "heading": "## B", "end": 10},
            ],
        )


class FindingText(unittest.TestCase):
    def test_文面の表は_doc_check_だけが持つ(self):
        # 文面は CLI の出力を展開するときだけに要る。script に写しを置くと、片方だけ直したときに食い違う。
        self.assertIn("// FINDING_TEXT_BEGIN", DOC_CHECK.read_text())
        self.assertNotIn("FINDING_TEXT", PRD)

    def test_CLI_は種別ごとに表の項目を使う(self):
        # workspace モードだけの種別は WORKSPACE_TEXT に置く。2 つの表は重ならず、和が CLI の使う種別と一致する。
        cli = DOC_CHECK.read_text()
        used = set(re.findall(r"push\(\{ c: '([A-Z_]+)'", cli))
        table = set(re.findall(r"^  ([A-Z_]+): \(", _marked_block(cli, "FINDING_TEXT"), re.M))
        ws_table = set(re.findall(r"^  ([A-Z_]+): \(", _marked_block(cli, "WORKSPACE_TEXT"), re.M))
        self.assertFalse(table & ws_table)
        self.assertEqual(used, table | ws_table)


class ScriptHoldsNoBody(unittest.TestCase):
    def test_prd_は本文を読まない(self):
        # script はファイルを読めない。本文を返り値で運ぶと、同じ内容に 2 度費用を払う（実測: cache read の約 45%）。
        self.assertNotRegex(PRD, r"\.markdown\b|\bmarkdown:")


if __name__ == "__main__":
    unittest.main()
