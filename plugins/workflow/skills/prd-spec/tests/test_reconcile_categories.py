"""scripts/draft.js・refine.js の reconcileCategories() の回帰テスト。

`categories_deferred` は coverage-auditor に対する免罪符である —「導出カテゴリのうち TBD に
落としたものを反映漏れとして指摘するな」というリスト。設計上の関係は

    categories_deferred ⊆ required_categories

だが、writer は自由記述の文字列を返すため実際には破れる（実測で required 7 件に対し
deferred 18 件）。`[REQUIRED_CATEGORIES]` は writer のプロンプトに既に渡してあるので、
**言い聞かせでは閉じない**ことが分かっている。

破れたときに起きること:

- required に無い名前は**何も免除しない**（coverage-auditor は required 側しか見ない）
- そのうえ coverage-auditor は「deferred に挙がっているのに TBD 一覧に対応項目が無い」も
  検査するため、素性の分からない名前がそこで**偽の指摘**に化ける
- 件数がそのまま人間へ返り、未確定の規模を実際より大きく見せる

関数は 2 つの script に**逐語で複製**されている（workflow script は import を書けない）。
片方だけ直すと初稿と改稿で扱いが食い違うので、一致することもテストする。
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
DRAFT = SCRIPTS / "draft.js"
REFINE = SCRIPTS / "refine.js"

FUNC_START = "const reconcileCategories ="

HARNESS = """
const spec = JSON.parse(process.argv[2])
console.log(JSON.stringify(reconcileCategories(spec.documents, spec.required)))
"""


def _extract_function(source: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(FUNC_START))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


def run_reconcile(documents, required):
    src = _extract_function(DRAFT.read_text(encoding="utf-8")) + "\n" + HARNESS
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "reconcile.mjs"
        path.write_text(src, encoding="utf-8")
        out = subprocess.run(
            ["node", str(path), json.dumps({"documents": documents, "required": required})],
            capture_output=True,
            text=True,
            check=True,
        )
    return json.loads(out.stdout)


def doc(key, deferred):
    return {"key": key, "categories_deferred": deferred}


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class ReconcileCategoriesTests(unittest.TestCase):
    def test_known_categories_pass_through(self):
        r = run_reconcile([doc("requirements/auth", ["監査証跡"])], ["監査証跡", "権限"])
        self.assertEqual(r["deferred"], ["監査証跡"])
        self.assertEqual(r["findings"], [])

    def test_unknown_category_is_dropped_and_reported(self):
        r = run_reconcile([doc("requirements/auth", ["監査ログ"])], ["監査証跡"])
        # 下流には渡さない（偽の指摘の材料にしない）
        self.assertEqual(r["deferred"], [])
        # ただし黙って捨てない。writer が名前を直せるように指摘として返す
        self.assertEqual([f["id"] for f in r["findings"]], ["ST-UNKNOWN-CATEGORY-監査ログ"])
        self.assertEqual(r["findings"][0]["document"], "requirements/auth")
        self.assertIn("監査証跡", r["findings"][0]["fix"])

    def test_mixed_input_keeps_only_the_known_ones(self):
        r = run_reconcile(
            [doc("requirements/auth", ["監査証跡", "監査ログ", "ログ記録"])], ["監査証跡", "権限"]
        )
        self.assertEqual(r["deferred"], ["監査証跡"])
        self.assertEqual(len(r["findings"]), 2)

    def test_same_name_from_two_documents_is_reported_per_document(self):
        """文書ごとに直す相手が違うので、片方だけ潰して終わりにしない。"""
        r = run_reconcile(
            [doc("requirements/auth", ["監査ログ"]), doc("specifications/auth", ["監査ログ"])],
            ["監査証跡"],
        )
        self.assertEqual(sorted(f["document"] for f in r["findings"]),
                         ["requirements/auth", "specifications/auth"])

    def test_duplicate_within_one_document_is_reported_once(self):
        r = run_reconcile([doc("requirements/auth", ["監査ログ", "監査ログ"])], ["監査証跡"])
        self.assertEqual(len(r["findings"]), 1)

    def test_deferred_is_deduplicated_across_documents(self):
        r = run_reconcile(
            [doc("requirements/auth", ["監査証跡"]), doc("specifications/auth", ["監査証跡"])],
            ["監査証跡"],
        )
        self.assertEqual(r["deferred"], ["監査証跡"])

    def test_empty_required_drops_everything_and_reports(self):
        """導出カテゴリが 0 件の案件では、deferred は成立しない（免除する相手がいない）。"""
        r = run_reconcile([doc("requirements/auth", ["監査証跡"])], [])
        self.assertEqual(r["deferred"], [])
        self.assertEqual(len(r["findings"]), 1)
        self.assertIn("（空）", r["findings"][0]["fix"])

    def test_missing_field_is_tolerated(self):
        r = run_reconcile([{"key": "requirements/auth"}], ["監査証跡"])
        self.assertEqual(r["deferred"], [])
        self.assertEqual(r["findings"], [])

    def test_draft_and_refine_share_the_same_implementation(self):
        self.assertEqual(
            _extract_function(DRAFT.read_text(encoding="utf-8")),
            _extract_function(REFINE.read_text(encoding="utf-8")),
            "reconcileCategories が draft.js と refine.js で食い違っています。"
            "初稿と改稿で categories_deferred の扱いが変わるため、両方を同時に直すこと。",
        )


if __name__ == "__main__":
    unittest.main()
