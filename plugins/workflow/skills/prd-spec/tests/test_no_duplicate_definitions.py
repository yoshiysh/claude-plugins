"""正典的な列挙集合が 2 つ以上のファイルで定義されていないことを検査する。

このスキルは生成する文書に対して二重管理を禁じている（`document-structure.md` §2.7・§6、
`document-splitting.md` §6）。**同じ規律を自分の参照ファイル群には適用していなかった。**

実際に起きたこと:

- 「目的側の文書に必須なもの」が `prd-and-spec.md` §4（4 項目）と `document-structure.md` §1
  （7 章）の両方で閉じられ、**内容が食い違ったまま両方が「正」として agent に読まれていた**
- ID の形式が `traceability.md` §1 と `document-splitting.md` §5 の両方で定義されていた
  （こちらは食い違う前に発見）

どちらも例外を投げず、テストも通り、生成された文書も一見正常に見える。**壊れ方が静かなので、
人が気づくまで残り続ける。** だから機械で押さえる。

## 検査の方法

各概念について「その定義が書かれていれば必ず現れる文字列」を列挙し、**全部を含むファイルが
2 つ以上あれば失格**とする。一部だけを含むファイルは参照や言及なので通す。

判定の鍵は `members` の選び方にある。**定義の形（`PR-<領域>-<連番>` のような雛形）を使い、
実体（`PR-AUTH-001`）を使わない。** 実体で照合すると、例示ファイルが定義箇所として数えられる。

## 概念を増やしたとき

`CANONICAL_SETS` に足す。足さなければ検査されない — この一覧が検査範囲そのものである。
"""

import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]

# name -> (定義が書かれていれば必ず現れる文字列の集合)
CANONICAL_SETS = {
    "必須の内容項目（目的側）": ["何を作るのか", "誰のためか", "どう使われるか", "やらないこと"],
    "ID の形式": [
        "`PR-<領域>-<連番>`",
        "`SP-<領域>-<連番>`",
        "`TBD-<領域>-<連番>`",
        "`RK-<連番>`",
    ],
    "TBD の区分": ["`blocking: true`", "`blocking: false`"],
    "異常系の 3 種別": ["正常系エッジ", "準正常系", "異常系", "種別 | 定義"],
    "EARS のパターン": ["Ubiquitous", "Event-driven", "State-driven", "Unwanted", "Optional"],
    "助動詞規約": ["shall", "should", "may", "will", "§5.2.7"],
}


def target_files():
    """agent と参照ファイルと SKILL.md。tests/ と scripts/ は対象外。"""
    return (
        [SKILL / "SKILL.md"]
        + sorted((SKILL / "references").glob("*.md"))
        + sorted((SKILL / "agents").glob("*.md"))
        + sorted((SKILL / "schemas").glob("*.md"))
    )


class NoDuplicateDefinitionsTests(unittest.TestCase):
    def test_each_concept_is_defined_in_at_most_one_file(self):
        for name, members in CANONICAL_SETS.items():
            with self.subTest(concept=name):
                hits = [
                    str(f.relative_to(SKILL))
                    for f in target_files()
                    if all(m in f.read_text(encoding="utf-8") for m in members)
                ]
                self.assertLessEqual(
                    len(hits),
                    1,
                    f"「{name}」が {len(hits)} 箇所で定義されています: {hits}。"
                    "正の所在を 1 つに決め、他方は参照させてください"
                    "（片方だけが更新されると、agent は両方を『正』として読んで矛盾を自分で裁くことになります）。",
                )

    def test_every_concept_is_defined_somewhere(self):
        """0 箇所は「検査が空振りしている」状態なので、検出できないまま通り続ける。

        members の書き方が本文とずれる（記法の変更・語の言い換え）と、二重定義があっても
        ヒット 0 件になり、上のテストは黙って通る。**検査していないことを合格と読まない。**
        """
        for name, members in CANONICAL_SETS.items():
            with self.subTest(concept=name):
                hits = [
                    str(f.relative_to(SKILL))
                    for f in target_files()
                    if all(m in f.read_text(encoding="utf-8") for m in members)
                ]
                self.assertEqual(
                    len(hits),
                    1,
                    f"「{name}」の定義箇所が見つかりません（members が本文とずれている可能性）。"
                    f"members={members}",
                )


if __name__ == "__main__":
    unittest.main()
