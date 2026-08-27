"""needs_input 再開契約（next_args / buildNextArgs）の構造テスト。

周回を跨ぐ再開で司令塔が 30〜70KB の args JSON を手組みする転記を廃し、script が
完全な args を組み立てて返す設計を固定する。司令塔の置換箇所は tbd_answers の
"<<ANSWER_HERE>>" 1 点だけ。

押さえるのは 4 つ。
1. tbd_answers がプレースホルダで、outer_round が +1 されている
2. presented_tbd_ids が digest 込みの完全形でそのまま入る
3. writer が draft_path へ Write 済みの文書は markdown が空になり draft_path 参照で渡る
   （draft_path が保存先 path と同じ文書は markdown を保持する — path へは Write させない）
4. 周回上限・継続不要（needs_input も未提示 blocking も無い）では null
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REFINE = (SKILL / "scripts" / "refine.js").read_text()


def _extract_function(source: str, name: str) -> str:
    lines = source.split("\n")
    start = f"function {name}("
    s = next(i for i, l in enumerate(lines) if l.startswith(start))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


def _ctx(**over):
    base = {
        "outer_round": 1,
        "max_outer_rounds": 2,
        "has_needs_input": True,
        "has_unpresented_blocking": False,
        "skillDir": "/skill",
        "mode": "new",
        "input": "依頼文",
        "answers": "回答",
        "decisions": [{"id": "D-001"}],
        "tbd_answers_history": [{"round": 1, "answers": "1 周目の回答"}],
        "documents": [
            {
                "key": "requirements/auth",
                "kind": "requirements",
                "topic": "auth",
                "concern": "認証",
                "path": "docs/requirements/auth.md",
                "draft_path": "/ws/drafts/r1/requirements-auth.md",
                "markdown": "# 本文",
                "summary": "要約",
                "items": [{"id": "PR-AUTH-001", "heading": "多要素認証"}],
                "referenced": [],
                "traceability": [],
                "tbd_items": [],
                "categories_deferred": [],
                "fixed": False,
            },
            {
                "key": "requirements/base",
                "kind": "requirements",
                "topic": "base",
                "concern": "基盤",
                "path": "docs/requirements/base.md",
                "draft_path": "docs/requirements/base.md",  # review 経路: path が下敷き
                "markdown": "# 既存本文",
                "summary": "要約",
                "items": [],
                "referenced": [],
                "traceability": [],
                "tbd_items": [],
                "categories_deferred": [],
                "fixed": False,
            },
        ],
        "tbd_items": [{"id": "TBD-RAUTH-001", "text": "論点", "blocking": True}],
        "presented_tbd_ids": [{"id": "TBD-RAUTH-001", "digest": "abc1234"}],
        "domain_findings": [],
        "required_categories": [],
        "self_containment": "",
        "paths": {"requirements": "docs/requirements", "specifications": "docs/specifications"},
        "today": "2026-08-25",
        "specimen_paths_arg": [],
    }
    base.update(over)
    return base


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestBuildNextArgs(unittest.TestCase):
    def _run(self, ctx):
        src = _extract_function(REFINE, "buildNextArgs")
        harness = """
const ctx = JSON.parse(process.argv[2])
process.stdout.write(JSON.stringify(buildNextArgs(ctx)))
"""
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "t.mjs"
            script.write_text(src + harness)
            out = subprocess.run(
                ["node", str(script), json.dumps(ctx)],
                capture_output=True,
                text=True,
                check=True,
            )
        return json.loads(out.stdout)

    def test_プレースホルダと周回カウンタ(self):
        na = self._run(_ctx())
        self.assertEqual(na["tbd_answers"], "<<ANSWER_HERE>>")
        self.assertEqual(na["outer_round"], 2)
        self.assertEqual(na["tbd_answers_history"], [{"round": 1, "answers": "1 周目の回答"}])

    def test_presented_tbd_ids_は_digest_込みの完全形(self):
        na = self._run(_ctx())
        self.assertEqual(na["presented_tbd_ids"], [{"id": "TBD-RAUTH-001", "digest": "abc1234"}])

    def test_Write済み文書は_markdown_空で_draft_path_参照(self):
        na = self._run(_ctx())
        auth = next(d for d in na["documents"] if d["key"] == "requirements/auth")
        self.assertEqual(auth["markdown"], "")
        self.assertEqual(auth["draft_path"], "/ws/drafts/r1/requirements-auth.md")
        # draft_path が保存先 path と同じ文書（review 経路）は本文を保持する
        base = next(d for d in na["documents"] if d["key"] == "requirements/base")
        self.assertEqual(base["markdown"], "# 既存本文")

    def test_unpresented_blocking_だけでも組み立てる(self):
        na = self._run(_ctx(has_needs_input=False, has_unpresented_blocking=True))
        self.assertIsNotNone(na)

    def test_周回上限と継続不要では_null(self):
        self.assertIsNone(self._run(_ctx(outer_round=2)))
        self.assertIsNone(self._run(_ctx(has_needs_input=False, has_unpresented_blocking=False)))


class TestNextArgsWiring(unittest.TestCase):
    def test_返り値に_next_args_が載る(self):
        self.assertIn("next_args: nextArgs", REFINE)

    def test_writer_に最終稿の_Write_が指示される(self):
        # script は FS を触れないため、draft への書き出しは writer の仕事として明記される
        self.assertIn("[WRITE_BACK] 最終稿の書き出し", REFINE)
        self.assertIn("doc.draft_path && doc.draft_path !== doc.path", REFINE)


if __name__ == "__main__":
    unittest.main()
