"""名前付き workflow（plugin の workflows/prd-spec.js）の meta の検査。

- meta は pure literal（値に変数・関数呼び出し・spread・テンプレートの展開が無い）。そうでないと Claude Code は
  `/<name>` を一覧から外し、SKILL.md が名前で呼べなくなる。
- meta.name は prd-spec-run。skill の呼び出し名 workflow:prd-spec と workflow の /workflow:<name> を同じ名前にしない
  （同名のときの優先は本家に定めが無い）。
- meta.phases の title の集合は、本体が phase() に渡す title の集合と同じ。title が合わない phase() は別の進捗の枠になる。
  変数で渡す title（phaseTitle・opts.phase）は、本体の大文字で始まる 1 語の文字列のリテラルがすべて meta.phases のどれかであることで
  押さえる（本体でその形のリテラルは phase の title にだけ使う）。test_prd_stages の stub も、テストが通る経路の phase() と
  opts.phase を実行時に照合する。
"""

import json
import re
import shutil
import subprocess
import unittest

from prd_script import PRD_PATH


def meta_source(src):
    assert src.startswith("export const meta = {"), "script は export const meta から始まる"
    return src[len("export const meta = ") : src.index("\n}\n") + 2]


def non_literal(text):
    """文字列のリテラルとキーを除いた残り。pure literal なら括弧・区切りと空白だけが残る。"""
    rest = re.sub(r"'(?:[^'\\\n]|\\.)*'", "", text)
    return re.sub(r"\b[A-Za-z_]\w*\s*:", "", rest)


def literal_value(text):
    r = subprocess.run(["node", "-e", f"console.log(JSON.stringify({text}))"], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def phase_titles_in_body(src):
    body = src[src.index("\n}\n") :]
    literal = set(re.findall(r"(?<![\w.])phase\('([^'\\]+)'\)", body))
    table = re.search(r"^const PHASE_OF = (\{.*\})$", body, re.M)
    assert table, "PHASE_OF が見つからない"
    return literal | set(literal_value(table.group(1)).values())


class MetaIsPureLiteral(unittest.TestCase):
    def test_metaの値は文字列のリテラルだけ(self):
        src = PRD_PATH.read_text(encoding="utf-8")
        rest = non_literal(meta_source(src))
        self.assertRegex(rest, r"^[{}\[\],\s]*$", f"meta に文字列のリテラル以外の値がある: {rest!r}")

    def test_pure_literalの検査は識別子の値とspreadとテンプレートを拒否する(self):
        for bad in ("{ name: NAME }", "{ ...base }", "{ name: `x${y}` }", "{ name: f('x') }"):
            with self.subTest(bad):
                self.assertNotRegex(non_literal(bad), r"^[{}\[\],\s]*$")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class MetaMatchesBody(unittest.TestCase):
    def setUp(self):
        self.src = PRD_PATH.read_text(encoding="utf-8")
        self.meta = literal_value(meta_source(self.src))

    def test_名前はprd_spec_run(self):
        self.assertEqual(self.meta["name"], "prd-spec-run")

    def test_meta_phasesのtitleは本体のphaseのtitleと同じ集合(self):
        titles = [p["title"] for p in self.meta["phases"]]
        self.assertEqual(len(titles), len(set(titles)))
        self.assertEqual(set(titles), phase_titles_in_body(self.src))
        body = self.src[self.src.index("\n}\n") :]
        self.assertLessEqual(set(re.findall(r"'([A-Z][A-Za-z]*)'", body)), set(titles), "phaseTitle・opts.phase に渡す title が meta.phases に無い")


if __name__ == "__main__":
    unittest.main()
