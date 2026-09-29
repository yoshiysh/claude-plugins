"""agent 呼び出しのコスト配分と、本文をプロンプトに埋めない設計の構造テスト。

実測（9 文書・計約 48 万字）で、349 回の agent 呼び出しが利用上限に 2 回達した。原因は 2 つで、
(1) どの agent() も model / effort を指定せず、セッションの xhigh を継承していた、
(2) 改稿後の本文がプロンプトへインラインで埋め込まれ、1 プロンプトが最大 39 万字に達した。

押さえるのは 3 つ。
1. prd.js の全 agent() が model と effort を表（ROLE_OPTS）から取り、表は役のファイル（ROLE_FILES）と 1 対 1 に対応し、
   役のファイルの frontmatter は model / effort を持たない（正本は ROLE_OPTS の 1 か所）
2. プロンプトを組むコードが本文も JSON の全量も埋め込まない（パスで渡す）
3. changedLineRanges（doc_check.mjs）が変更の行範囲を正しく返す
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
PRD = (SKILL / "scripts" / "prd.js").read_text()
DOC_CHECK = SKILL / "scripts" / "doc_check.mjs"

EFFORTS = {"low", "medium", "high", "xhigh", "max"}
MODELS = {"opus", "sonnet", "haiku"}


def _code_lines(src: str):
    """コメント行を除いたコード行を (行番号, 行) で返す。"""
    for i, ln in enumerate(src.split("\n"), 1):
        if ln.strip().startswith("//"):
            continue
        yield i, ln


def _role_opts(src: str) -> dict:
    m = re.search(r"const ROLE_OPTS = \{(.*?)\n\}", src, re.S)
    assert m, "ROLE_OPTS が見つからない"
    return {k: (model, effort) for k, model, effort in re.findall(r"(\w+): \{ model: '(\w+)', effort: '(\w+)' \}", m.group(1))}


def _run_node(source: str, harness: str, spec) -> object:
    with tempfile.TemporaryDirectory() as d:
        script = Path(d) / "t.mjs"
        script.write_text(source + "\n" + harness)
        out = subprocess.run(["node", str(script), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


class TestAgentOptsAreExplicit(unittest.TestCase):
    def test_全_agent_呼び出しが表から_model_と_effort_を取る(self):
        code = "\n".join(ln for _, ln in _code_lines(PRD))
        starts = [m.start() for m in re.finditer(r"(?<![\w.])agent\(", code)]
        self.assertTrue(starts)
        roles = _role_opts(PRD)
        for idx, pos in enumerate(starts):
            end = starts[idx + 1] if idx + 1 < len(starts) else len(code)
            m = re.compile(r"\{\s*\.\.\.OPTS(?:\.(\w+)|\[[\w.]+\])").search(code, pos, end)
            self.assertIsNotNone(m, f"agent() の opts が表から取られていない: {code[pos:pos + 120]!r}")
            if m.group(1):
                self.assertIn(m.group(1), roles)
            self.assertNotRegex(code[pos:m.start()], r"model:", "model を直書きしている")

    def test_配分表と役のファイルが_1_対_1_に対応する(self):
        files = dict(re.findall(r"(\w+): '([\w-]+\.md)'", re.search(r"const ROLE_FILES = \{(.*?)\n\}", PRD, re.S).group(1)))
        roles = _role_opts(PRD)
        self.assertEqual(set(files), set(roles))
        self.assertEqual(sorted(files.values()), sorted(p.name for p in (SKILL / "agents").glob("*.md")))
        for name in files.values():
            text = (SKILL / "agents" / name).read_text()
            self.assertTrue(text.startswith("---\n"), name)
            keys = set(re.findall(r"^(\w+):", text.split("---")[1], re.M))
            self.assertIn("description", keys, name)
            self.assertFalse(keys & {"model", "effort", "subagent_type"}, f"{name}: model / effort の正本は ROLE_OPTS")
        io = (SKILL / "references" / "workflow-io.md").read_text()
        rows = re.findall(r"^\| ((?:`\w+`・?)+) \| (\w+) / (\w+) \|", io, re.M)
        self.assertEqual({r: (m, e) for names, m, e in rows for r in re.findall(r"`(\w+)`", names)}, roles)
        for model, effort in _role_opts(PRD).values():
            self.assertIn(model, MODELS)
            self.assertIn(effort, EFFORTS)

    def test_既定値は_role_opts_で上書きできると明記されている(self):
        io = (SKILL / "references" / "workflow-io.md").read_text()
        self.assertIn("role_opts", io)
        self.assertIn("applyRoleOverrides(ROLE_OPTS, input.role_opts)", PRD)


class TestNoBodyInPrompts(unittest.TestCase):
    def test_プロンプトに_JSON_の全量を埋め込まない(self):
        # JSON.stringify をプロンプトに使うと、決定台帳や指摘の全量が次の agent に載り、同じ内容に 2 度費用を払う。
        code = "\n".join(ln for _, ln in _code_lines(PRD))
        # 使ってよいのは state の複製（JSON.parse(JSON.stringify(...))）だけ。
        self.assertEqual(code.count("JSON.stringify("), code.count("JSON.parse(JSON.stringify("))
        self.assertNotRegex(code, r"\.markdown\b")

    def test_プロンプトの文字列は役と契約の規則を写さない(self):
        # 規則は agents/*.md と契約の節に置き、プロンプトには段・ID・パス・コマンドだけを置く（写しは片方だけ直されてずれる）。
        norm = lambda t: re.sub(r"[\s`*「」]", "", t)
        corpus = [norm(p.read_text()) for p in [*(SKILL / "agents").glob("*.md"), SKILL / "schemas" / "agent-contracts.md"]]
        code = "\n".join(ln for _, ln in _code_lines(PRD))
        found = []
        for m in re.finditer(r"'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`", code):
            for part in re.split(r"\$\{[^}]*\}", m.group(1) if m.group(1) is not None else m.group(2)):
                lit = norm(part)
                for i in range(len(lit) - 19):
                    frag = lit[i : i + 20]
                    if len(re.findall(r"[\u3040-\u30ff\u4e00-\u9fff]", frag)) >= 10 and any(frag in c for c in corpus):
                        found.append(frag)
                        break
        self.assertEqual(found, [])


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestChangedLineRanges(unittest.TestCase):
    H = """
const spec = JSON.parse(process.argv[2])
process.stdout.write(JSON.stringify(changedLineRanges(spec.prev, spec.next)))
"""
    BASE = "\n".join(
        [
            "# 仕様",  # 1
            "",  # 2
            "## 1. 範囲",  # 3
            "対象は A。",  # 4
            "",  # 5
            "### 項目",  # 6
            "",  # 7
            "#### SP-A-001 入力",  # 8
            "入力を受け付けなければならない。",  # 9
            "",  # 10
            "#### SP-A-002 出力",  # 11
            "出力しなければならない。",  # 12
            "",  # 13
            "#### SP-A-003 失敗",  # 14
            "失敗時は拒否しなければならない。",  # 15
            "",  # 16
        ]
    )

    def _run(self, prev, nxt):
        src = f"import {{ changedLineRanges }} from {json.dumps(DOC_CHECK.as_uri())}"
        return _run_node(src, self.H, {"prev": prev, "next": nxt})

    def test_変更なしは空(self):
        self.assertEqual(self._run(self.BASE, self.BASE), [])

    def test_1_項目の変更はその行範囲だけ(self):
        nxt = self.BASE.replace("出力しなければならない。", "JSON で出力しなければならない。")
        self.assertEqual(self._run(self.BASE, nxt), [{"start": 11, "end": 13, "heading": "#### SP-A-002 出力"}])

    def test_隣接する変更は_1_範囲に畳む(self):
        nxt = self.BASE.replace("出力しなければならない。", "JSON で出力しなければならない。").replace(
            "失敗時は拒否しなければならない。", "失敗時は 400 を返さなければならない。"
        )
        out = self._run(self.BASE, nxt)
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["start"], out[0]["end"]), (11, 15))
        self.assertIn("SP-A-002", out[0]["heading"])
        self.assertIn("SP-A-003", out[0]["heading"])

    def test_節の挿入は後続を変更扱いにしない(self):
        nxt = self.BASE.replace(
            "#### SP-A-002 出力", "#### SP-A-004 検証\n検証しなければならない。\n\n#### SP-A-002 出力"
        )
        self.assertEqual(self._run(self.BASE, nxt), [{"start": 11, "end": 13, "heading": "#### SP-A-004 検証"}])

    def test_節の削除は幅_0_の範囲で位置を示す(self):
        nxt = self.BASE.replace("#### SP-A-002 出力\n出力しなければならない。\n\n", "")
        out = self._run(self.BASE, nxt)
        self.assertEqual(out, [{"start": 11, "end": 10, "heading": "#### SP-A-002 出力", "deleted": True}])

    def test_コードフェンス内の見出し記号は節にしない(self):
        prev = "## A\n```\n## not heading\n```\n本文\n"
        nxt = "## A\n```\n## not heading\n```\n本文を変更\n"
        self.assertEqual(self._run(prev, nxt), [{"start": 1, "end": 5, "heading": "## A"}])



if __name__ == "__main__":
    unittest.main()
