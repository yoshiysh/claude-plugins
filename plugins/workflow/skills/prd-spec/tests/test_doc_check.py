"""scripts/doc_check.mjs（本文を読む決定的な検査の CLI）と、それを呼ぶ checker 経路のテスト。

本文を Workflow script の手元に置かない設計にした（writer は改稿稿を Edit し、本文を返さない）。
本文を要する検査は checker agent がこの CLI を実行して結果だけを返す。押さえるのは次のとおり。

1. CLI の出力が、移設前に refine.js の中で計算していた結果と同一である（fixtures/doc_check の
   golden_head.json は移設前の HEAD の structuralFindings / lineTotal / newlineCount /
   changedLineRanges で生成した）
2. 読めない文書は CLI ごと落とさず、その文書の本文検査を「未検査」として返す
3. script 側の verifyCheck が CLI の実出力を受理し、写しの改変（指摘の脱落）を受理しない
4. refine.js は本文（.markdown）を一切読まず、writer に本文を返させない
5. 改稿の writer は前稿を複写して Edit する指示を受け、本文を返せとは言われない
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
SCRIPTS = SKILL / "scripts"
DOC_CHECK = SCRIPTS / "doc_check.mjs"
REFINE = (SCRIPTS / "refine.js").read_text()
DRAFT = (SCRIPTS / "draft.js").read_text()
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "doc_check"


def _extract_function(source: str, name: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(f"function {name}("))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


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
    """// <name>_BEGIN 〜 // <name>_END の区間（const の表は _extract_function で取れないため）。"""
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
class VerifyCheckAcceptsOnlyFaithfulCopies(unittest.TestCase):
    SRC = _marked_block(REFINE, "FINDING_TEXT") + "\n" + "\n".join(
        _extract_function(REFINE, n) for n in ("stableKey", "canonicalJson", "verifyCheck")
    ) + """
function main(spec) {
  const v = verifyCheck(spec.res, spec.input)
  return { ok: v.ok, reason: v.reason || null, ...(spec.withStructural ? { structural: v.structural } : {}) }
}
"""

    def setUp(self):
        self.input = _fixture_input()
        r = _run_cli(self.input)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.output = json.loads(r.stdout)

    def _verify(self, res, input_obj=None):
        return _node(self.SRC, {"res": res, "input": input_obj or self.input})

    def test_CLI_の実出力を受理する(self):
        self.assertEqual(self._verify({"ok": True, "output": self.output}), {"ok": True, "reason": None})

    def test_キー順が変わっても受理する(self):
        reordered = json.loads(json.dumps(self.output, sort_keys=True))
        self.assertTrue(self._verify({"ok": True, "output": reordered})["ok"])

    def test_指摘が落ちた写しは受理しない(self):
        dropped = json.loads(json.dumps(self.output))
        dropped["structural"]["findings"].pop()
        v = self._verify({"ok": True, "output": dropped})
        self.assertFalse(v["ok"])
        self.assertIn("output_digest", v["reason"])

    def test_入力の写しが違えば受理しない(self):
        other = json.loads(json.dumps(self.input))
        other["documents"][0]["ids"].append("PR-AUTH-777")
        v = self._verify({"ok": True, "output": self.output}, other)
        self.assertFalse(v["ok"])
        self.assertIn("input_digest", v["reason"])

    def test_受理した短い形は文面付きに組み立て直される(self):
        v = _node(self.SRC, {"res": {"ok": True, "output": self.output}, "input": self.input, "withStructural": True})
        self.assertTrue(v["ok"])
        golden = json.loads((FIXTURES / "golden_head.json").read_text())
        self.assertEqual(v["structural"], golden["structural"])

    def test_索引の追加分を含む出力も受理し_書き換えは受理しない(self):
        with tempfile.TemporaryDirectory() as tmp:
            inp = _fixture_input()
            inp["index_dir"] = str(Path(tmp) / "index")
            inp["index_extra"] = ["requirements-base.md"]
            out = json.loads(_run_cli(inp).stdout)
        self.assertTrue(self._verify({"ok": True, "output": out}, inp)["ok"])
        tampered = json.loads(json.dumps(out))
        tampered["index_extra"][0]["index_path"] = "/elsewhere.index.md"
        v = self._verify({"ok": True, "output": tampered}, inp)
        self.assertFalse(v["ok"])
        self.assertIn("output_digest", v["reason"])

    def test_未知の種別は受理しない(self):
        bad = json.loads(json.dumps(self.output))
        bad["structural"]["findings"].append({"c": "NO_SUCH_CODE", "d": "requirements/auth", "a": [["x"]]})
        # digest は写しと一致させたうえで、展開できないことだけで落ちることを確かめる
        src = f"import {{ canonicalJson, stableKey }} from {json.dumps(DOC_CHECK.as_uri())}\n" + (
            "function main(spec) { return stableKey(canonicalJson({ documents: spec.documents, structural: spec.structural })) }"
        )
        bad["output_digest"] = _node(src, {"documents": bad["documents"], "structural": bad["structural"]})
        v = self._verify({"ok": True, "output": bad})
        self.assertFalse(v["ok"])
        self.assertIn("展開できない", v["reason"])

    def test_実行失敗と無応答は受理しない(self):
        self.assertFalse(self._verify({"ok": False, "error": "node: not found"})["ok"])
        self.assertFalse(_node(self.SRC.replace("verifyCheck(spec.res", "verifyCheck(null"), {"res": None, "input": self.input})["ok"])


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

    R1 = Path.home() / ".claude/prd-spec-workspace/pdca-redesign/drafts/r1"

    @unittest.skipUnless((Path.home() / ".claude/prd-spec-workspace/pdca-redesign/drafts/r1").is_dir(), "実 run の下書きが無い")
    def test_実_run_の下書きで_50KB_を十分下回る(self):
        # トレーサビリティ表も trace も申告されていない最悪の形（ORPHAN が数百件出る）で測る。
        # 移設時の出力は同じ入力で 440,688 バイトだった。
        docs = []
        for p in sorted(self.R1.glob("*.md")):
            kind, topic = p.stem.split("-", 1)
            pat = r"\bPR-[A-Z][A-Z0-9]*-\d+\b" if kind == "requirements" else r"\bSP-[A-Z][A-Z0-9]*-\d+\b"
            ids = sorted(set(re.findall(pat, p.read_text())))
            docs.append({"key": f"{kind}/{topic}", "kind": kind, "topic": topic, "path": str(p), "fixed": False,
                         "ids": ids, "referenced": [], "vacant": [], "tbd_items": [], "traceability": []})
        r = _run_cli({"documents": docs})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLess(len(r.stdout.encode()), 50_000)
        # 短くしても指摘は 1 件も落ちない（展開すると全件の文面が戻る）
        expanded = _expand(json.loads(r.stdout)["structural"])
        self.assertGreater(len(expanded["findings"]), 500)


class FindingTextParity(unittest.TestCase):
    def test_文面の表は_3_ファイルで逐語一致(self):
        cli = _marked_block(DOC_CHECK.read_text(), "FINDING_TEXT")
        self.assertEqual(_marked_block(REFINE, "FINDING_TEXT"), cli)
        self.assertEqual(_marked_block(DRAFT, "FINDING_TEXT"), cli)

    def test_CLI_は種別ごとに表の項目を使う(self):
        cli = DOC_CHECK.read_text()
        used = set(re.findall(r"push\(\{ c: '([A-Z_]+)'", cli))
        table = set(re.findall(r"^  ([A-Z_]+): \(", _marked_block(cli, "FINDING_TEXT"), re.M))
        self.assertEqual(used, table)


class CheckerWiring(unittest.TestCase):
    def test_canonicalJson_は_CLI_と_script_で同一(self):
        cli = DOC_CHECK.read_text()
        self.assertEqual(_extract_function(cli, "canonicalJson"), _extract_function(REFINE, "canonicalJson"))
        self.assertEqual(_extract_function(cli, "stableKey"), _extract_function(REFINE, "stableKey"))

    def test_checker_は安いモデルで判断をしない(self):
        for src in (REFINE, DRAFT):
            self.assertIn("checker: { model: 'sonnet', effort: 'low' },", src)
            self.assertIn("...ROLE_OPTS.checker,", src)
        prompt = _extract_function(REFINE, "checkerPrompt")
        self.assertIn("doc_check.mjs", prompt)
        self.assertIn("cd しない", prompt)

    def test_checker_の欠測は監査の欠測として返る(self):
        # missing は監査ラウンドごとに組み直されるので、checker の欠測は別に貯めて合流させる。
        self.assertIn("const missingAll = [...missing, ...checkerMissing]", REFINE)
        self.assertIn("const verdict = missingAll.length", REFINE)
        self.assertIn("missing_auditors: missingAll,", REFINE)
        self.assertIn("'ST-NOTCHECKED-CHECKER'", REFINE)
        # draft は構造検査を実行できなければゲート②を飛ばさない
        self.assertIn("checkerMissing.length === 0 && gate2PresentFindings.length === 0", DRAFT)

    def test_不採用の稿は検査し直す(self):
        body = REFINE[REFINE.index("async function reviseDocuments(") :]
        self.assertIn("lineCountConfirmed(reportedLineCount(s.result), check.byKey.get(s.key))", body)
        self.assertIn("runDocChecks(`${revisionId}-recheck`", body)


def _code_lines(src: str):
    return [ln for ln in src.split("\n") if not ln.strip().startswith("//")]


class RefineHoldsNoBody(unittest.TestCase):
    def test_refine_は_markdown_を読まない(self):
        offenders = [ln.strip() for ln in _code_lines(REFINE) if ".markdown" in ln or re.search(r"\bmarkdown:", ln)]
        self.assertEqual(offenders, [])

    def test_writer_の返り値に本文が無い(self):
        for name, src in (("refine.js", REFINE), ("draft.js", DRAFT)):
            for schema in ("REQ_DOC_SCHEMA", "SPEC_DOC_SCHEMA"):
                m = re.search(rf"const {schema} = \{{(.*?)\n\}}", src, re.S)
                self.assertIsNotNone(m, f"{name}:{schema}")
                code = "\n".join(_code_lines(m.group(1)))
                self.assertNotIn("markdown", code, f"{name}:{schema}")

    def test_返り値の文書は_draft_path_を持ち本文を持たない(self):
        ret = REFINE[REFINE.index("  documents: documents.map((d) => ({\n    key: d.key,") :]
        ret = ret[: ret.index("})),")]
        self.assertIn("draft_path: d.draft_path,", ret)
        self.assertNotIn("markdown", "\n".join(_code_lines(ret)))


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class RevisionWriterEditsInPlace(unittest.TestCase):
    def _section(self, revision_id):
        src = "\n".join(
            [
                next(l for l in REFINE.split("\n") if l.startswith("const READ_CHUNK_LINES = ")),
                "const draftDir = '/ws/drafts/r1'",
                next(l for l in REFINE.split("\n") if l.startswith("const revisedDraftPath = ")),
                next(l for l in REFINE.split("\n") if l.startswith("const docLineCount = ")),
                _extract_function(REFINE, "previousMetadata"),
                _extract_function(REFINE, "editInPlaceSection"),
                "function main(spec) { return editInPlaceSection(spec.doc, spec.rev).join('\\n') }",
            ]
        )
        doc = {
            "key": "requirements/auth",
            "kind": "requirements",
            "topic": "auth",
            "path": "docs/requirements/auth.md",
            "draft_path": "/ws/drafts/r1/requirements-auth.md",
            "line_count": 812,
            "summary": "認証の要求",
            "items": [{"id": "PR-AUTH-001", "heading": "多要素認証"}],
            "trace": [{"item_id": "PR-AUTH-001", "kind": "input", "quote": "多要素認証を必須とする"}],
            "tbd_items": [],
            "referenced": [],
            "vacant": [],
        }
        return _node(src, {"doc": doc, "rev": revision_id})

    def test_複写して_Edit_し全文を書き直さない(self):
        out = self._section("R1.1")
        self.assertIn("cp '/ws/drafts/r1/requirements-auth.md' '/ws/drafts/r1/requirements-auth.R1.1.md'", out)
        self.assertIn("Edit", out)
        self.assertIn("Write で全文を書き直さない", out)
        self.assertIn("offset/limit", out)
        self.assertIn("wc -l < '/ws/drafts/r1/requirements-auth.R1.1.md'", out)
        self.assertIn("本文は返り値に入れない", out)
        self.assertNotIn("返り値の markdown", out)
        # 全体の区切り読み（1 行目から末尾まで）を指示しない
        self.assertNotIn("offset=1 limit=300", out)

    def test_触っていない項目の申告を写させる(self):
        out = self._section("R1.1")
        self.assertIn("[PREVIOUS_METADATA]", out)
        self.assertIn("多要素認証を必須とする", out)
        self.assertIn("PR-AUTH-001", out)

    def test_回答反映パスは_TBD_の_ID_で探させる(self):
        self.assertIn("[TBD_ANSWERS] の回答が効く箇所", self._section("R1.0"))
        self.assertNotIn("[TBD_ANSWERS] の回答が効く箇所", self._section("R1.1"))

    def test_writer_プロンプトに前稿の通読指示が残っていない(self):
        body = _extract_function(REFINE, "buildWriterPrompt")
        self.assertIn("...editInPlaceSection(doc, revisionId),", body)
        self.assertNotIn("readInstruction(doc.draft_path", body)


if __name__ == "__main__":
    unittest.main()
