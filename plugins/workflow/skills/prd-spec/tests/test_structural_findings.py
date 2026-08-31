"""scripts/draft.js・refine.js の structuralFindings() の回帰テスト。

この関数は agent の判断に一切依存せず、集合演算と文字列検査だけで契約違反を出す。
スキルが売りにしている保証 —「片側にしか現れない ID を必ず検出する」「廃止済み規制の語を
必ず検出する」「文書を跨いだ ID 重複を検出する」— がここに載っているため、壊れると
「監査を通った」と表示されたまま契約が破れる。

関数は 2 つの script に**逐語で複製**されている（workflow script は import を書けない）。
片方だけ直すと初稿と改稿で判定が食い違うので、一致することもテストする。
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
DRAFT = SCRIPTS / "draft.js"
REFINE = SCRIPTS / "refine.js"

CONST_START = "const OBSOLETE_TERMS"
CONST_END = "const ID_IN_TEXT"
FUNC_START = "function structuralFindings"


def _extract_pure_part(source: str) -> str:
    """定数群と structuralFindings 本体だけを取り出す（agent/parallel に触れない部分）。"""
    lines = source.split("\n")

    const_from = next(i for i, l in enumerate(lines) if l.startswith(CONST_START))
    # ID_IN_TEXT はオブジェクトリテラルなので、トップレベルの閉じ括弧まで含める。
    const_open = next(i for i, l in enumerate(lines) if l.startswith(CONST_END))
    const_to = next(i for i in range(const_open, len(lines)) if lines[i] == "}")

    func_from = next(i for i, l in enumerate(lines) if l.startswith(FUNC_START))
    func_to = next(i for i in range(func_from + 1, len(lines)) if lines[i] == "}")

    return "\n".join(lines[const_from : const_to + 1] + [""] + lines[func_from : func_to + 1])


def _extract_function(source: str) -> str:
    """structuralFindings の本体だけを取り出す（定数のコメントは script ごとに違ってよい）。"""
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(FUNC_START))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


def _constant_values(source: str) -> dict:
    """判定に効く定数の値だけを取り出す（コメントを除いた実体の比較用）。"""
    out = {}
    for name in ("OBSOLETE_TERMS", "UNVERIFIABLE_STANDARDS", "CLAUSE_REF", "TBD_ID_IN_TEXT"):
        m = re.search(rf"^const {name} = (.+)$", source, re.M)
        out[name] = m.group(1) if m else None
    m = re.search(r"^const ID_IN_TEXT = \{(.*?)^\}", source, re.M | re.S)
    out["ID_IN_TEXT"] = re.sub(r"\s+", "", m.group(1)) if m else None
    return out


def run_structural(docs, script: Path = DRAFT):
    """structuralFindings(docs) を Node で実行して {findings, not_checked} を返す。"""
    pure = _extract_pure_part(script.read_text(encoding="utf-8"))
    harness = (
        pure
        + "\nconst __docs = JSON.parse(process.argv[2])\n"
        + "console.log(JSON.stringify(structuralFindings(__docs)))\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "pure.mjs"
        path.write_text(harness, encoding="utf-8")
        out = subprocess.run(
            ["node", str(path), json.dumps(docs)], capture_output=True, text=True, check=True
        )
    return json.loads(out.stdout)


_OMIT = object()


def doc(
    kind,
    topic,
    markdown,
    ids=None,
    referenced=None,
    traceability=None,
    tbd=None,
    fixed=False,
    trace=None,
):
    """trace の既定は「全 ID に根拠あり」。

    根拠の所在検査（ST-NO-EVIDENCE）は全 ID に効くので、既定を空にすると
    このファイルの全ケースに無関係な指摘が混ざる。trace=_OMIT を渡すと
    キーごと省き、未申告（ST-NOTCHECKED-TRACE）のケースを作れる。
    """
    d = {
        "key": f"{kind}/{topic}",
        "kind": kind,
        "topic": topic,
        "markdown": markdown,
        "ids": ids or [],
        "referenced": referenced or [],
        "traceability": traceability or [],
        "tbd_items": tbd or [],
        "fixed": fixed,
    }
    if trace is not _OMIT:
        d["trace"] = (
            trace
            if trace is not None
            else [{"item_id": i, "kind": "input", "quote": "依頼文の該当箇所"} for i in (ids or [])]
        )
    return d


def ids_of(result):
    return [f["id"] for f in result["findings"]]


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class StructuralFindingsTests(unittest.TestCase):
    # ------------------------------------------------ 文書を跨いだ ID の重複

    def test_same_id_defined_in_two_documents_is_reported(self):
        r = run_structural(
            [
                doc("requirements", "auth", "### PR-A-001 x\n", ids=["PR-A-001"]),
                doc("requirements", "notify", "### PR-A-001 y\n", ids=["PR-A-001"]),
            ]
        )
        self.assertIn("ST-DUP-PR-A-001", ids_of(r))

    def test_same_tbd_id_from_two_documents_is_reported(self):
        # 分割文書は並列に書かれ互いの採番を知らない。統合時に片方が黙って消えるため、
        # 消えた側が blocking だと「聞くべき項目が最初から存在しなかった」ことになる。
        r = run_structural(
            [
                doc("requirements", "auth", "x", tbd=[{"id": "TBD-003", "text": "上限値", "blocking": True}]),
                doc("requirements", "notify", "y", tbd=[{"id": "TBD-003", "text": "通知先", "blocking": True}]),
            ]
        )
        self.assertIn("ST-DUP-TBD-TBD-003", ids_of(r))

    # ------------------------------------------------ TBD の申告漏れ

    def test_tbd_declared_in_another_document_is_not_reported(self):
        """仕様書が要求文書の TBD を引くのは正しい参照である（ID は文書を跨いで一意）。

        文書ローカルで突き合わせると、この参照が全部「申告漏れ」に化ける。実測では 6 文書の
        初稿で 15 件の誤検出になり、writer が直せない指摘を抱えて改稿枠を空回りさせた。
        """
        r = run_structural(
            [
                doc("requirements", "auth", "#### PR-A-001 x\n", ids=["PR-A-001"],
                    tbd=[{"id": "TBD-RAUTH-002", "text": "未決", "blocking": True}]),
                doc("specifications", "auth",
                    "#### SP-A-001 y\n\nこの判断は TBD-RAUTH-002 が決まるまで定まらない。\n",
                    ids=["SP-A-001"], referenced=["PR-A-001"],
                    traceability=[{"requirement_id": "PR-A-001", "spec_id": "SP-A-001", "verification": "レビュー"}]),
            ]
        )
        self.assertNotIn("ST-UNDECLARED-TBD-TBD-RAUTH-002", ids_of(r))

    def test_tbd_cited_in_body_but_not_declared_is_reported(self):
        # 本文が「まだ決まっていない」と書いているのに申告に載らない TBD は blocking の
        # 集計から外れ、「未提示の blocking が 0 件」という完成判定を素通りする。
        # 決まっていないことを決まった風に提示する状態そのもの。
        r = run_structural(
            [doc("requirements", "auth", "上限値は未定である（TBD-RAUTH-004）。\n", tbd=[])]
        )
        self.assertIn("ST-UNDECLARED-TBD-TBD-RAUTH-004", ids_of(r))

    def test_declared_tbd_is_not_reported(self):
        r = run_structural(
            [
                doc(
                    "requirements",
                    "auth",
                    "上限値は未定である（TBD-RAUTH-004）。\n",
                    tbd=[{"id": "TBD-RAUTH-004", "text": "上限値", "blocking": True}],
                )
            ]
        )
        self.assertNotIn("ST-UNDECLARED-TBD-TBD-RAUTH-004", ids_of(r))

    def test_fixed_document_is_exempt_from_tbd_declaration_check(self):
        # 固定文書は本ランの対象外で agent の自己申告が存在しない。申告漏れは
        # 申告があって初めて定義できるので、ここを見ると必ず誤検出になる。
        r = run_structural(
            [doc("requirements", "auth", "未定である（TBD-RAUTH-004）。\n", tbd=[], fixed=True)]
        )
        self.assertNotIn("ST-UNDECLARED-TBD-TBD-RAUTH-004", ids_of(r))

    def test_namespaced_tbd_ids_do_not_collide(self):
        r = run_structural(
            [
                doc("requirements", "auth", "x", tbd=[{"id": "TBD-AUTH-001", "text": "a", "blocking": True}]),
                doc("requirements", "notify", "y", tbd=[{"id": "TBD-NOTIFY-001", "text": "b", "blocking": True}]),
            ]
        )
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-DUP-TBD")])

    # ------------------------------------------------------------ 片側 ID

    def test_requirement_without_traceability_row_is_reported(self):
        r = run_structural(
            [
                doc("requirements", "auth", "### PR-A-001 x\n### PR-A-002 y\n", ids=["PR-A-001", "PR-A-002"]),
                doc(
                    "specifications",
                    "auth",
                    "### SP-A-001 z\n",
                    ids=["SP-A-001"],
                    traceability=[{"requirement_id": "PR-A-001", "spec_id": "SP-A-001"}],
                ),
            ]
        )
        self.assertIn("ST-ORPHAN-REQ-PR-A-002", ids_of(r))

    def test_cross_document_traceability_is_accepted(self):
        # 要求と仕様が別 topic に分かれていても、文書を跨いで照合できなければならない。
        r = run_structural(
            [
                doc("requirements", "auth", "### PR-A-001 x\n", ids=["PR-A-001"]),
                doc(
                    "specifications",
                    "login",
                    "本書は `####` 見出し 1 つを 1 仕様項目とする。\n### SP-L-001 z\n根拠: PR-A-001\n",
                    ids=["SP-L-001"],
                    referenced=["PR-A-001"],
                    traceability=[{"requirement_id": "PR-A-001", "spec_id": "SP-L-001"}],
                ),
            ]
        )
        self.assertEqual([], r["findings"])

    # ------------------------------------------ 本文と申告の突き合わせ

    def test_id_in_body_but_not_declared_is_reported(self):
        r = run_structural([doc("requirements", "auth", "### PR-A-001\n### PR-A-002\n", ids=["PR-A-001"])])
        self.assertIn("ST-UNDECLARED-PR-A-002", ids_of(r))

    def test_referenced_id_is_not_reported_as_undeclared(self):
        # 複数文書化で他文書の ID への言及は日常的に起きる。これを申告漏れとして出すと、
        # writer は直しようのない指摘で改稿枠を空回りさせる。
        r = run_structural(
            [doc("specifications", "auth", "### SP-A-001\n根拠: SP-B-009 参照\n", ids=["SP-A-001"], referenced=["SP-B-009"])]
        )
        self.assertEqual([], [i for i in ids_of(r) if "UNDECLARED" in i])

    def test_fixed_document_is_exempt_from_declaration_checks(self):
        # 固定文書（このランの対象外）は agent の自己申告を持たない。
        # 申告漏れは申告があって初めて定義できる。
        r = run_structural([doc("requirements", "auth", "### PR-A-001\n### PR-A-002\n", ids=[], fixed=True)])
        self.assertEqual([], [i for i in ids_of(r) if "UNDECLARED" in i or "PHANTOM" in i])

    def test_id_template_placeholder_is_not_matched(self):
        r = run_structural([doc("requirements", "auth", "ID は `PR-<領域>-<連番>` の形式とする。", ids=[])])
        self.assertEqual([], r["findings"])

    # ------------------------------------------------------ not_checked

    def test_missing_requirements_side_is_reported_as_not_checked(self):
        # 材料が空のまま「指摘 0 件」と数えられると、紐付け先が 1 件も無い状態で
        # 「紐付け欠落 0 件」と報告される。失格ではなく未検査として返す。
        r = run_structural([doc("specifications", "auth", "### SP-A-001\n", ids=["SP-A-001"])])
        self.assertIn("ST-NOTCHECKED-CROSSREF", [n["id"] for n in r["not_checked"]])

    def test_both_sides_present_means_no_not_checked(self):
        r = run_structural(
            [
                doc("requirements", "auth", "### PR-A-001\n", ids=["PR-A-001"]),
                doc(
                    "specifications",
                    "auth",
                    "### SP-A-001\n",
                    ids=["SP-A-001"],
                    traceability=[{"requirement_id": "PR-A-001", "spec_id": "SP-A-001"}],
                ),
            ]
        )
        self.assertEqual([], r["not_checked"])

    # -------------------------------------------- 廃止済み規制の語・条番号

    def test_obsolete_citation_counted_once(self):
        r = run_structural([doc("requirements", "auth", "21 CFR 820.30 に従う。", ids=[])])
        self.assertEqual(1, len([i for i in ids_of(r) if i.startswith("ST-OBSOLETE")]))

    def test_dhf_and_spelled_out_form_counted_once(self):
        r = run_structural([doc("requirements", "auth", "Design History File (DHF) に記録する。", ids=[])])
        self.assertEqual(1, len([i for i in ids_of(r) if i.startswith("ST-OBSOLETE")]))

    def test_plain_japanese_is_not_flagged(self):
        r = run_structural([doc("requirements", "auth", "設計の入力と出力を管理しなければならない。", ids=[])])
        self.assertEqual([], r["findings"])

    def test_clause_citation_of_unverifiable_standard_is_reported(self):
        r = run_structural([doc("requirements", "auth", "IEC 62304 §5.2 が要求する。", ids=[])])
        self.assertEqual(1, len([i for i in ids_of(r) if i.startswith("ST-UNVERIFIED")]))

    def test_edition_number_is_not_mistaken_for_a_clause(self):
        # 「第14版」は版数。条番号として誤検出すると改稿が 1 周無駄になる。
        r = run_structural([doc("requirements", "auth", "FISC 安全対策基準 第14版 を参照した。", ids=[])])
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-UNVERIFIED")])

    # ------------------------------------------------ 根拠の所在（trace）

    def test_item_without_trace_is_reported(self):
        # 本文に根拠句を書かない規約にした以上、根拠は trace にしか残らない。
        # ここを検査しないと、根拠句を消した瞬間に捏造検査の入力が消える。
        r = run_structural([doc("requirements", "auth", "### PR-A-001\n", ids=["PR-A-001"], trace=[])])
        self.assertIn("ST-NO-EVIDENCE-PR-A-001", ids_of(r))

    def test_item_with_trace_is_not_reported(self):
        r = run_structural([doc("requirements", "auth", "### PR-A-001\n", ids=["PR-A-001"])])
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-NO-EVIDENCE")])

    def test_missing_trace_field_is_not_checked_rather_than_pass(self):
        # trace を返さなかった writer を「根拠あり」と読むと、未検査が合格に化ける。
        r = run_structural([doc("requirements", "auth", "### PR-A-001\n", ids=["PR-A-001"], trace=_OMIT)])
        self.assertIn("ST-NOTCHECKED-TRACE-requirements/auth", [n["id"] for n in r["not_checked"]])
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-NO-EVIDENCE")])

    # ------------------------------------------ 本文に混ざった非規範の記述

    def test_decision_source_annotation_in_body_is_reported(self):
        r = run_structural(
            [doc("requirements", "auth", "### PR-A-001\n方式は OIDC とする（既定: D-003）。", ids=["PR-A-001"])]
        )
        self.assertEqual(1, len([i for i in ids_of(r) if i.startswith("ST-NON-NORMATIVE")]))

    def test_tbd_chapter_heading_in_body_is_reported(self):
        r = run_structural([doc("requirements", "auth", "## 未確定事項\n\n- TBD-A-001\n", ids=[])])
        self.assertEqual(1, len([i for i in ids_of(r) if i.startswith("ST-NON-NORMATIVE")]))

    def test_normative_body_is_not_flagged_as_non_normative(self):
        r = run_structural(
            [doc("requirements", "auth", "### PR-A-001\n利用者を認証しなければならない。", ids=["PR-A-001"])]
        )
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-NON-NORMATIVE")])


class ScriptShapeTests(unittest.TestCase):
    """script 側の前提が崩れていないか。"""

    def test_structural_findings_is_identical_in_both_scripts(self):
        # 逐語複製が崩れると、初稿で通った文書が改稿後に落ちる（またはその逆）。
        self.assertEqual(
            _extract_function(DRAFT.read_text(encoding="utf-8")),
            _extract_function(REFINE.read_text(encoding="utf-8")),
        )

    def test_detection_constants_are_identical_in_both_scripts(self):
        # 禁止語リストや ID の抽出パターンが片方だけ更新されると、初稿と改稿で
        # 検出結果が食い違う。コメントの違いは許すが、値は一致していなければならない。
        self.assertEqual(
            _constant_values(DRAFT.read_text(encoding="utf-8")),
            _constant_values(REFINE.read_text(encoding="utf-8")),
        )

    def test_scripts_do_not_use_forbidden_runtime_apis(self):
        # workflow script では Date.now() / Math.random() / 引数なし new Date() が throw する。
        for path in (DRAFT, REFINE):
            source = path.read_text(encoding="utf-8")
            for forbidden in ("Date.now(", "Math.random(", "new Date()"):
                self.assertNotIn(forbidden, source, f"{path.name} に {forbidden} がある")

    def test_scripts_have_no_dynamic_import(self):
        # import() を含む script は起動前に失敗する。
        for path in (DRAFT, REFINE):
            self.assertIsNone(re.search(r"\bimport\s*\(", path.read_text(encoding="utf-8")), path.name)

    def test_gate2_decision_is_only_in_draft_script(self):
        # ゲート②を飛ばすかの判定式は script に 1 つだけ置く。SKILL.md 側で件数から
        # 再判定すると、executability が全滅した run で「聞くことが無い」に化ける。
        self.assertIn("gate2_skippable", DRAFT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
