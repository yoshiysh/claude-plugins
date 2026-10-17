"""scripts/doc_check.mjs の structuralFindings() の回帰テスト。

この関数は agent の判断に一切依存せず、集合演算と文字列検査だけで契約違反を出す。
スキルが売りにしている保証 —「片側にしか現れない ID を必ず検出する」「廃止済み規制の語を
必ず検出する」「文書を跨いだ ID 重複を検出する」— がここに載っているため、壊れると
「監査を通った」と表示されたまま契約が破れる。

正本は doc_check.mjs 1 箇所に置く。Workflow script（prd-spec.js）は本文を読めないので、この検査の
複製を持たず、agent に CLI を実行させて件数と digest だけを受け取る。複製が無いことをテストする。
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from prd_script import PRD_PATH as PRD

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
DOC_CHECK = SCRIPTS / "doc_check.mjs"


def run_structural(docs):
    """structuralFindings(docs) を doc_check.mjs から import して実行し {findings, not_checked} を返す。"""
    harness = (
        f"import {{ structuralFindings }} from {json.dumps(DOC_CHECK.as_uri())}\n"
        "const __docs = JSON.parse(process.argv[2])\n"
        "console.log(JSON.stringify(structuralFindings(__docs)))\n"
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
    vacant=None,
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
        "vacant": vacant or [],
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

    def test_requirements_only_run_does_not_ask_for_specifications(self):
        # 要求文書を書くランに固定の仕様書があっても、要求 → 仕様の紐付けは問わない（仕様書はそのランで書かれない）。
        r = run_structural(
            [
                doc("requirements", "magi", "### PR-M-001 x\n", ids=["PR-M-001"]),
                doc("requirements", "base", "### PR-B-001 y\n", ids=["PR-B-001"], fixed=True),
                doc(
                    "specifications",
                    "base",
                    "### SP-B-001 z\n",
                    ids=["SP-B-001"],
                    traceability=[{"requirement_id": "PR-B-001", "spec_id": "SP-B-001"}],
                    fixed=True,
                ),
            ]
        )
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-ORPHAN-REQ")])

    def test_orphan_requirement_is_asked_only_of_documents_the_written_spec_covers(self):
        r = run_structural(
            [
                doc("requirements", "auth", "### PR-A-001 x\n### PR-A-002 y\n", ids=["PR-A-001", "PR-A-002"]),
                doc("requirements", "base", "### PR-B-001 y\n", ids=["PR-B-001"], fixed=True),
                doc(
                    "specifications",
                    "auth",
                    "### SP-A-001 z\n",
                    ids=["SP-A-001"],
                    traceability=[{"requirement_id": "PR-A-001", "spec_id": "SP-A-001"}],
                ),
            ]
        )
        orphans = [i for i in ids_of(r) if i.startswith("ST-ORPHAN-REQ")]
        self.assertEqual(["ST-ORPHAN-REQ-PR-A-002"], orphans)

    def test_covers_reaches_requirements_the_spec_has_not_traced_yet(self):
        spec = doc("specifications", "auth", "### SP-A-001 z\n", ids=["SP-A-001"])
        spec["covers"] = ["requirements/auth"]
        r = run_structural([doc("requirements", "auth", "### PR-A-001 x\n", ids=["PR-A-001"]), spec])
        self.assertIn("ST-ORPHAN-REQ-PR-A-001", ids_of(r))

    def test_requirements_written_with_specs_are_asked_without_covers(self):
        # 要求と仕様を同じランで書くとき、covers の書き漏らしで要求文書が丸ごと検出から外れない。
        r = run_structural(
            [
                doc("requirements", "auth", "### PR-A-001 x\n", ids=["PR-A-001"]),
                doc("specifications", "login", "### SP-L-001 z\n", ids=["SP-L-001"]),
            ]
        )
        self.assertIn("ST-ORPHAN-REQ-PR-A-001", ids_of(r))

    def test_dangling_link_of_a_fixed_spec_stays_on_the_fixed_spec(self):
        # ラン前からの参照切れと区別できないので、推定で要求文書に帰属させない（帰属させると writer に ID の捏造を促す）。
        r = run_structural(
            [
                doc("requirements", "auth", "### PR-A-001 x\n", ids=["PR-A-001"]),
                doc(
                    "specifications",
                    "auth",
                    "### SP-A-001 z\n### SP-A-002 w\n",
                    ids=["SP-A-001", "SP-A-002"],
                    traceability=[
                        {"requirement_id": "PR-A-001", "spec_id": "SP-A-001"},
                        {"requirement_id": "PR-A-002", "spec_id": "SP-A-002"},
                    ],
                    fixed=True,
                ),
            ]
        )
        dangling = [f for f in r["findings"] if f["id"] == "ST-DANGLING-REQ-PR-A-002"]
        self.assertEqual(["specifications/auth"], [f["document"] for f in dangling])

    def test_duplicate_id_is_attributed_to_the_document_that_can_change(self):
        r = run_structural(
            [
                doc("requirements", "base", "### PR-X-001 y\n", ids=["PR-X-001"], fixed=True),
                doc("requirements", "new", "### PR-X-001 x\n", ids=["PR-X-001"]),
            ]
        )
        dup = [f for f in r["findings"] if f["id"].startswith("ST-DUP-")]
        self.assertEqual(["requirements/new"], [f["document"] for f in dup])

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

    # -------------------------------------------------- 欠番宣言と申告漏れ

    def test_vacant_id_declared_on_same_line_is_not_reported_as_undeclared(self):
        # 欠番の列挙は表記規約が要求する記載であり、items にも referenced_ids にも属さない。
        # 除外しないと欠番宣言を持つ文書で ST-UNDECLARED が run のたびに再発し、
        # 終端裁定が同じ棄却を繰り返す（棄却は run を跨いで持ち越されない）。#53
        body = "### PR-A-001 x\n### PR-A-003 y\nPR-A-002 は欠番である。再利用してはならない。\n"
        r = run_structural([doc("requirements", "auth", body, ids=["PR-A-001", "PR-A-003"])])
        self.assertEqual([], [i for i in ids_of(r) if "UNDECLARED" in i])

    def test_vacancy_word_elsewhere_does_not_mask_real_undeclared_id(self):
        # 「欠番」の語が文書のどこかにあるだけで全 ID が免除されると、本物の申告漏れが隠れる。
        # 除外は ID と「欠番」が同じ行に併記されている場合に限る。
        body = "採番には欠番がありうる。\n### PR-A-001 x\n### PR-A-002 y\n"
        r = run_structural([doc("requirements", "auth", body, ids=["PR-A-001"])])
        self.assertIn("ST-UNDECLARED-PR-A-002", ids_of(r))

    def test_gap_declared_on_vacancy_line_is_not_reported(self):
        # (3c) も (3) と同じ行併記基準（vacantDeclared）で判定する。
        body = "### PR-A-001 x\n### PR-A-003 y\nPR-A-002 は欠番である。\n"
        r = run_structural([doc("requirements", "auth", body, ids=["PR-A-001", "PR-A-003"])])
        self.assertEqual([], [i for i in ids_of(r) if i.startswith("ST-GAP-UNDECLARED")])

    def test_undeclared_gap_in_numbering_is_reported(self):
        body = "### PR-A-001 x\n### PR-A-003 y\n"
        r = run_structural([doc("requirements", "auth", body, ids=["PR-A-001", "PR-A-003"])])
        self.assertIn("ST-GAP-UNDECLARED-PR-A-002", ids_of(r))

    def test_vacant_ids_declaration_silences_undeclared_and_gap(self):
        # 一級の申告（vacant_ids）。行併記が無くても申告があれば欠番として扱う。
        body = "### PR-A-001 x\n### PR-A-003 y\n以下の ID は割り当てない。\nPR-A-002\n"
        r = run_structural(
            [doc("requirements", "auth", body, ids=["PR-A-001", "PR-A-003"], vacant=["PR-A-002"])]
        )
        self.assertEqual([], [i for i in ids_of(r) if "UNDECLARED" in i])

    def test_vacant_id_also_declared_as_item_is_conflict(self):
        # 欠番は「割り当てられていない」の宣言であり、実在の項目と両立しない。
        body = "### PR-A-001 x\n### PR-A-002 y\n"
        r = run_structural(
            [doc("requirements", "auth", body, ids=["PR-A-001", "PR-A-002"], vacant=["PR-A-002"])]
        )
        self.assertIn("ST-VACANT-CONFLICT-PR-A-002", ids_of(r))

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
    """Workflow script 側の前提が崩れていないか。"""

    def test_structural_findings_has_a_single_source(self):
        # 検査の複製を script に持つと、CLI と script で判定が食い違う。script は CLI を agent に実行させる。
        self.assertIn("function structuralFindings", DOC_CHECK.read_text(encoding="utf-8"))
        self.assertNotIn("function structuralFindings", PRD.read_text(encoding="utf-8"))

    def test_detection_constants_live_only_in_doc_check(self):
        # 禁止語リストや ID の抽出パターンが片方だけ更新されると、検出結果が食い違う。
        for name in ("OBSOLETE_TERMS", "UNVERIFIABLE_STANDARDS", "CLAUSE_REF", "TBD_ID_IN_TEXT", "ID_IN_TEXT", "FINDING_TEXT"):
            self.assertRegex(DOC_CHECK.read_text(encoding="utf-8"), rf"(?m)^const {name} = ", name)
            self.assertNotRegex(PRD.read_text(encoding="utf-8"), rf"(?m)^const {name} = ", name)

    def test_scripts_do_not_use_forbidden_runtime_apis(self):
        # workflow script では Date.now() / Math.random() / 引数なし new Date() が throw する。
        source = PRD.read_text(encoding="utf-8")
        for forbidden in ("Date.now(", "Math.random(", "new Date()"):
            self.assertNotIn(forbidden, source)

    def test_scripts_have_no_dynamic_import(self):
        # import() を含む script は起動前に失敗する。
        self.assertIsNone(re.search(r"\bimport\s*\(", PRD.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
