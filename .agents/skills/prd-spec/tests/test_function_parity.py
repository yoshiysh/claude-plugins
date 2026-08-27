"""draft/refine 間の複製関数と、reference⇔script 間の定数の一致テスト。

workflow script は import を書けないため、draft.js と refine.js は一部の関数を
逐語複製している。structuralFindings 等は test_structural_findings.py が一致を
固定しているが、execToTbd / stableKey には一致テストが無く、実際に refine.js 側
だけ source_finding_id が落ちる drift が起きた（フル実行評価で検出）。

また OBSOLETE_TERMS / UNVERIFIABLE_STANDARDS は citation-policy.md（正と宣言）と
両 script の 3 箇所に実体があるが、reference⇔script の一致は誰も検査していなかった。
citation-policy.md に語を足しても script が黙って検査しない退行をここで固定する。
"""

import re
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
DRAFT = (SKILL / "scripts" / "draft.js").read_text()
REFINE = (SKILL / "scripts" / "refine.js").read_text()
CITATION = (SKILL / "references" / "citation-policy.md").read_text()


def extract_function(src: str, name: str) -> str:
    """function <name>(...) { ... } の本体をコメント・空白を正規化して返す。"""
    m = re.search(rf"function {name}\([^)]*\) \{{", src)
    assert m, f"{name} が見つからない"
    depth = 0
    for i in range(m.start(), len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                body = src[m.start() : i + 1]
                break
    else:
        raise AssertionError(f"{name} の閉じ括弧が見つからない")
    # コメント行を除去し、空白を正規化（コメントは script ごとに文脈が違ってよい）
    lines = [
        re.sub(r"\s+", " ", ln).strip()
        for ln in body.splitlines()
        if not ln.strip().startswith("//") and ln.strip()
    ]
    return "\n".join(lines)


def extract_array(src: str, name: str) -> list:
    m = re.search(rf"const {name} = \[(.*?)\]", src, re.S)
    assert m, f"{name} が見つからない"
    return re.findall(r"'([^']+)'", m.group(1))


class TestReplicatedFunctions(unittest.TestCase):
    def test_stable_key_identical(self):
        self.assertEqual(
            extract_function(DRAFT, "stableKey"), extract_function(REFINE, "stableKey")
        )

    def test_exec_to_tbd_identical(self):
        self.assertEqual(
            extract_function(DRAFT, "execToTbd"), extract_function(REFINE, "execToTbd")
        )


class TestReferenceScriptConstants(unittest.TestCase):
    def test_obsolete_terms_appear_in_citation_policy(self):
        for script_name, src in (("draft.js", DRAFT), ("refine.js", REFINE)):
            for term in extract_array(src, "OBSOLETE_TERMS"):
                self.assertIn(
                    term.lower(),
                    CITATION.lower(),
                    f"{script_name} の OBSOLETE_TERMS '{term}' が citation-policy.md に無い",
                )

    def test_unverifiable_standards_appear_in_citation_policy(self):
        for script_name, src in (("draft.js", DRAFT), ("refine.js", REFINE)):
            for term in extract_array(src, "UNVERIFIABLE_STANDARDS"):
                self.assertIn(
                    term,
                    CITATION,
                    f"{script_name} の UNVERIFIABLE_STANDARDS '{term}' が citation-policy.md に無い",
                )

    def test_citation_policy_obsolete_terms_appear_in_scripts(self):
        # 逆方向: citation-policy.md の「禁止語」節に backtick で列挙された語のうち、
        # 旧規制語（OBSOLETE_TERMS の族）が script 側にも存在すること。
        # md 側の列挙全体を機械抽出するのは書式に脆いので、両 script の定数一致
        # （test_structural_findings 側）+ 本テストの片方向包含 + この代表語の存在で固定する。
        for representative in ("design history file", "21 cfr 820.30"):
            self.assertIn(representative, extract_array(DRAFT, "OBSOLETE_TERMS"))


class TestDigestContract(unittest.TestCase):
    def test_blocking_items_carry_script_computed_digest(self):
        # digest は script が計算して返す（司令塔に text から作らせない）契約の固定
        for name, src in (("draft.js", DRAFT), ("refine.js", REFINE)):
            self.assertRegex(
                src,
                r"blocking_tbd_items: blockingTbd\.map\(\(t\) => \(\{ \.\.\.t, digest: stableKey\(",
                f"{name} の blocking_tbd_items に script 計算の digest が無い",
            )

    def test_presented_echo_keeps_full_records(self):
        self.assertIn("presented_tbd_ids: [...presentedById.values()]", REFINE)


class TestDecisionsPlumbing(unittest.TestCase):
    """決定ログ [DECISIONS] が両 script の CONTEXT に配線されていることの固定。

    片方にしか無いと、A で既定を根拠にした記述が B の fabrication-auditor に
    捏造として指摘される（tbd_answers_history と同型の周回間欠落）。
    """

    def test_decisions_in_both_contexts(self):
        for name, src in (("draft.js", DRAFT), ("refine.js", REFINE)):
            self.assertIn("# [DECISIONS]", src, f"{name} の CONTEXT に [DECISIONS] が無い")
            self.assertIn("parsedArgs.decisions", src, f"{name} が args.decisions を受けていない")

    def test_decisions_cited_as_evidence_in_refine(self):
        self.assertIn("TBD_ANSWERS / DECISIONS に根拠が無い要求", REFINE)


if __name__ == "__main__":
    unittest.main()
