"""agent に読ませる量を絞る設計の構造テスト。

実 run（6 文書 333〜1002 行 + 固定文書 3 件、audit_rounds 1）で、書き手は書き終えた稿を 4 回に分けて
読み直し、validity 1 体は固定文書を含む全文書を通読して文脈 80 万トークン（キャッシュ読み 1,660 万）に
達した。押さえるのは次のとおり。

1. 書き手は書いた稿を全体に読み直さない（確かめるのは Edit した範囲だけ）
2. 固定文書・他文書は見出し索引と行範囲だけで渡し、全文を読ませない
3. validity / specimen は文書ごとに 1 体で、他文書の本文を 1 体に持たせない
4. 終端裁定・解消候補の起草は、指摘の箇所だけを読む
5. 回答の反映パスは、回答が名指しした文書に絞れるときだけ絞る
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REFINE = (SKILL / "scripts" / "refine.js").read_text()
DRAFT = (SKILL / "scripts" / "draft.js").read_text()


def _extract_function(source: str, name: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(f"function {name}("))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


def _extract_const(source: str, name: str) -> str:
    m = re.search(rf"^const {name} = .*$", source, re.M)
    assert m, name
    return m.group(0)


def _run(src: str, expr: str, spec) -> object:
    harness = src + "\nconst spec = JSON.parse(process.argv[2])\nprocess.stdout.write(JSON.stringify(" + expr + "))\n"
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "t.mjs"
        p.write_text(harness)
        out = subprocess.run(["node", str(p), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


DOCS = [
    {"key": "requirements/auth", "path": "docs/requirements/auth.md", "draft_path": "/ws/requirements-auth.md", "concern": "認証",
     "ids": ["PR-AUTH-001"], "fixed": False, "index_path": "/ws/checks/index/requirements__auth.index.md", "index_lines": 40},
    {"key": "specifications/auth", "path": "docs/specifications/auth.md", "draft_path": "/ws/specifications-auth.md", "concern": "認証の仕様",
     "ids": ["SP-AUTH-001"], "fixed": False, "index_path": "/ws/checks/index/specifications__auth.index.md", "index_lines": 420},
    {"key": "requirements/base", "path": "docs/requirements/base.md", "draft_path": "docs/requirements/base.md", "concern": "共通",
     "ids": ["PR-BASE-001"], "fixed": True, "index_path": None, "index_lines": None},
]

INDEX_SRC = "\n".join(
    [_extract_const(REFINE, "READ_CHUNK_LINES"), _extract_function(REFINE, "indexInstruction"), _extract_function(REFINE, "crossDocSection")]
)


class WritersDoNotReread(unittest.TestCase):
    def test_改稿は_Edit_した範囲だけを確かめる(self):
        body = _extract_function(REFINE, "editInPlaceSection")
        self.assertIn("確かめるのは Edit した範囲だけにする", body)
        self.assertIn("書き終えた稿を全体に読み直さない", body)

    def test_初稿は書いた後に読み直さない(self):
        body = _extract_function(DRAFT, "writeBackLines")
        self.assertIn("書いた本文を Read し直して確かめない", body)

    def test_writer_common_が理由とともに書く(self):
        text = (SKILL / "agents" / "writer-common.md").read_text()
        self.assertIn("書き終えた稿を全体に読み直さない", text)

    def test_書き手に全文の通読や再確認を求める指示が無い(self):
        for name, src in (("refine.js", _extract_function(REFINE, "buildWriterPrompt") + _extract_function(REFINE, "editInPlaceSection")),
                          ("draft.js", _extract_function(DRAFT, "buildReqPrompt") + _extract_function(DRAFT, "buildSpecPrompt") + _extract_function(DRAFT, "writeBackLines"))):
            for bad in ("全文を読み直", "全体を読み直して確", "もう一度全体", "念のため"):
                self.assertNotIn(bad, src, name)
        for f in ("writer-common.md", "req-writer.md", "spec-writer.md"):
            text = (SKILL / "agents" / f).read_text()
            self.assertNotRegex(text, r"書(い|き終え)た(後|あと)に?全文を(Read|読)", f)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class FixedAndOtherDocsViaIndex(unittest.TestCase):
    def test_索引があれば索引と行範囲だけを読ませる(self):
        out = _run(INDEX_SRC, "indexInstruction(spec.d)", {"d": DOCS[0]})
        self.assertIn("Read /ws/checks/index/requirements__auth.index.md", out.replace("見出し索引: ", "Read ").replace("（40 行", ""))
        self.assertIn("全体は読まない", out)
        self.assertNotIn("offset=1 limit=300", out)

    def test_長い索引は区切って読ませる(self):
        out = _run(INDEX_SRC, "indexInstruction(spec.d)", {"d": DOCS[1]})
        self.assertIn("offset=1 limit=300", out)
        self.assertIn("offset=301 limit=300", out)
        self.assertIn("/ws/checks/index/specifications__auth.index.md", out)

    def test_索引が無くても全文読みに戻さず見出しを_Grep_させる(self):
        out = _run(INDEX_SRC, "indexInstruction(spec.d)", {"d": DOCS[2]})
        self.assertIn("見出し索引なし", out)
        self.assertIn("Grep", out)
        self.assertIn("全体は読まない", out)

    def test_全文書を束ねる監査でも固定文書は索引で渡す(self):
        body = _extract_function(REFINE, "buildAuditPrompt")
        self.assertIn("d.fixed ? indexInstruction(d) : auditBodyOf(d, narrowed)", body)
        section = _extract_function(REFINE, "locateDocumentsSection")
        self.assertIn("d.fixed ? indexInstruction(d) : readInstruction(d.draft_path, d.lineCount)", section)

    def test_書き手の他文書は索引で渡す(self):
        body = _extract_function(REFINE, "otherDocsContext")
        self.assertIn("indexInstruction(d)", body)
        self.assertNotIn("readInstruction", body)

    def test_仕様書の書き手は実現する要求文書だけを通読する(self):
        start = DRAFT.index("const requirementsContextFor = (spec) => {")
        body = DRAFT[start : DRAFT.index("\n}\n", start)]
        self.assertIn("const whole = !r.result.fixed && (!covers.size || covers.has(r.doc.topic))", body)
        self.assertIn("全体は読まない", body)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class PerDocumentCorpusAuditors(unittest.TestCase):
    def _cross(self, self_key):
        src = "const documents = JSON.parse(process.argv[2]).docs\n" + INDEX_SRC
        return _run(src, "crossDocSection(spec.docs.find((d) => d.key === spec.self)).join('\\n')", {"docs": DOCS, "self": self_key})

    def test_他文書は_ID_と索引だけで本文を渡さない(self):
        out = self._cross("requirements/auth")
        self.assertIn("ID: SP-AUTH-001", out)
        self.assertIn("/ws/checks/index/specifications__auth.index.md", out)
        # 他文書の本文の区切り読み（本文ファイルの offset 指定）を並べない
        self.assertNotIn("Read /ws/specifications-auth.md offset=", out)
        self.assertNotIn("Read docs/requirements/base.md offset=", out)
        self.assertIn("他文書の問題そのものは指摘しない", out)

    def test_文書間の矛盾は片側だけが報告する(self):
        first = self._cross("requirements/auth")
        second = self._cross("specifications/auth")
        own = lambda text: re.search(r"相手が次の文書のときだけ: (.*)。", text).group(1)
        self.assertIn("specifications/auth", own(first))
        self.assertNotIn("requirements/auth", own(second))
        # 固定文書との矛盾は常に監査される側が報告する
        self.assertIn("requirements/base", own(first))
        self.assertIn("requirements/base", own(second))

    def test_validity_と_specimen_だけが索引を受け取る(self):
        body = _extract_function(REFINE, "buildAuditPrompt")
        self.assertIn("(auditor.name === 'validity' || auditor.name === 'specimen') ? crossDocSection(task.docs[0]) : []", body)

    def test_標本は索引から要る節だけを読む(self):
        body = _extract_function(REFINE, "buildAuditPrompt")
        self.assertIn("indexInstruction(specimenIndexOf(p))", body)
        text = (SKILL / "agents" / "specimen-auditor.md").read_text()
        self.assertNotIn("標本文書をすべて Read する", text)


class FindingScopedReads(unittest.TestCase):
    def test_終端裁定と解消候補は指摘の箇所だけを読む(self):
        adj = _extract_function(REFINE, "buildAdjudicationPrompt")
        self.assertNotIn("bodyOf(d)", adj)
        self.assertIn("FINDING_READ_NOTE", adj)
        rel = _extract_function(REFINE, "relevantBodies")
        self.assertNotIn("bodyOf(d)", rel)
        self.assertIn("indexInstruction(d)", rel)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class ReflectionPassTargets(unittest.TestCase):
    SRC = "const _s = JSON.parse(process.argv[2])\nconst documents = _s.docs\nconst inputTbdItems = _s.items\n" + _extract_function(REFINE, "answerTargets")

    def _targets(self, answers, items=()):
        docs = [
            {"key": "requirements/auth", "path": "docs/requirements/auth.md", "draft_path": "/ws/a.md", "tbd_items": [{"id": "TBD-RAUTH-001"}]},
            {"key": "requirements/pay", "path": "docs/requirements/pay.md", "draft_path": "/ws/p.md", "tbd_items": [{"id": "TBD-RPAY-001"}]},
            {"key": "specifications/auth", "path": "docs/specifications/auth.md", "draft_path": "/ws/s.md", "tbd_items": []},
        ]
        return _run(self.SRC, "(() => { const r = answerTargets(spec.answers); return r ? [...r].sort() : null })()",
                    {"docs": docs, "items": list(items), "answers": answers})

    def test_全行が既知の_ID_を名指しすれば持ち主の文書だけ(self):
        self.assertEqual(self._targets("TBD-RAUTH-001: 30 分とする\n\nTBD-RAUTH-001 の例外は無い"), ["requirements/auth"])

    def test_script_が起票した_TBD_は_document_で持ち主を引く(self):
        items = [{"id": "TBD-EX-0abc123", "document": "specifications/auth"}]
        self.assertEqual(self._targets("TBD-EX-0abc123: 上限は 5 回", items), ["specifications/auth"])

    def test_宛先の決まらない行があれば全文書(self):
        self.assertIsNone(self._targets("TBD-RAUTH-001: 30 分とする\n全体として監査ログは 1 年保持する"))
        self.assertIsNone(self._targets("TBD-UNKNOWN-009: 知らない ID"))

    def test_反映パスは絞った集合でも仕様書の追随規則を残す(self):
        body = REFINE[REFINE.index("async function reviseDocuments(") :]
        body = body[: body.index("\n}\n")]
        self.assertIn("if (forceAll === true) return true", body)
        self.assertIn("if (forceAll instanceof Set && forceAll.has(d.key)) return true", body)
        self.assertIn("return kind === 'specifications' && requirementsRevised", body)
        self.assertIn("await reviseDocuments(new Map(), `R${outerRound}.0`, reflectTargets || true)", REFINE)

    def test_回答の書式を司令塔に伝える(self):
        # 回答が ID で始まらなければ絞り込みは働かない。書式の指示が SKILL.md に無いと常に全文書になる。
        self.assertIn("答える TBD の ID で書き始める", (SKILL / "SKILL.md").read_text())


if __name__ == "__main__":
    unittest.main()
