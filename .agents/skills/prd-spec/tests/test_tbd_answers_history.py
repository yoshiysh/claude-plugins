"""ゲート②回答の周回累積（tbd_answers_history）の回帰テスト。

文書は周回を跨いで過去回答を根拠に持つのに、根拠の原本（CONTEXT_BLOCK の
[TBD_ANSWERS]）が今周回の回答だけだと、fabrication-auditor に過去回答由来の
要求が「存在しない回答を挙げた捏造」として blocking 判定される
（実測: 自己適用 2 周目で偽陽性 6 件）。

この退行を、refine.js のソースが次の 3 点を持つことで固定する:
1. args.tbd_answers_history を受け取る
2. CONTEXT_BLOCK の [TBD_ANSWERS] に過去周回分を並べる
3. 返り値に累積済み tbd_answers_history を含める（次周回へそのまま渡す規約）
"""

import re
import unittest
from pathlib import Path

REFINE = (Path(__file__).resolve().parent.parent / "scripts" / "refine.js").read_text()


class TestTbdAnswersHistory(unittest.TestCase):
    def test_args_accepts_history(self):
        self.assertIn("parsedArgs.tbd_answers_history", REFINE)

    def test_context_block_includes_history(self):
        # [TBD_ANSWERS] セクションの組み立てが tbdAnswersHistory を参照していること
        m = re.search(r"# \[TBD_ANSWERS\][^\]]*?過去周回", REFINE)
        self.assertIsNotNone(m, "[TBD_ANSWERS] の見出しが過去周回を含むと宣言していない")
        self.assertIn("tbdAnswersHistory.map", REFINE)

    def test_return_accumulates_history(self):
        # 返り値が「既存 history + 今周回」の形で累積していること
        self.assertRegex(
            REFINE,
            r"tbd_answers_history:\s*\[\s*\.\.\.tbdAnswersHistory",
            "返り値の tbd_answers_history が過去分を引き継いでいない",
        )
        self.assertIn("round: outerRound", REFINE)

    def test_empty_answers_not_accumulated(self):
        # 空回答の周回を履歴に積まない（(未確定事項への回答なし) が根拠扱いされない）
        self.assertRegex(REFINE, r"tbdAnswers \? \[\{ round: outerRound")

    def test_auditor_doc_declares_history_as_evidence(self):
        fab = (
            Path(__file__).resolve().parent.parent / "agents" / "fabrication-auditor.md"
        ).read_text()
        self.assertIn("過去周回の回答も含めて全部が根拠", fab)


if __name__ == "__main__":
    unittest.main()
