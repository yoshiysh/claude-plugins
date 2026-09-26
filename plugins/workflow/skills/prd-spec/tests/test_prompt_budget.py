"""agent 呼び出しのコスト配分と、本文をプロンプトに埋めない設計の構造テスト。

実測（9 文書・計約 48 万字の Workflow B）で、349 回の agent 呼び出しが利用上限に 2 回達した。
原因は 2 つで、(1) どの agent() も model / effort を指定せず、セッションの xhigh を継承していた、
(2) 改稿後の本文がプロンプトへインラインで埋め込まれ、1 プロンプトが最大 39 万字に達した。

押さえるのは 5 つ。
1. draft.js / refine.js の全 agent() が model と effort を明示する（表から取る）
2. プロンプトを組むコードが本文（.markdown）を埋め込まない（構造検査などの非プロンプト処理は許可リスト）
3. readInstruction は 300 行を超える本文を offset/limit の区切り読みで指示する
4. changedLineRanges がスコープ監査で読ませる行範囲を正しく返す
5. 冗長指摘（degraded + action）が writer の改稿対象に届く
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
DRAFT = (SKILL / "scripts" / "draft.js").read_text()
REFINE = (SKILL / "scripts" / "refine.js").read_text()
SOURCES = {"draft.js": DRAFT, "refine.js": REFINE}

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
    return {
        k: (model, effort)
        for k, model, effort in re.findall(
            r"(\w+): \{ model: '(\w+)', effort: '(\w+)' \}", m.group(1)
        )
    }


def _extract_function(source: str, name: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(f"function {name}("))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


def _extract_const(source: str, name: str) -> str:
    m = re.search(rf"^const {name} = .*$", source, re.M)
    assert m, f"{name} が見つからない"
    return m.group(0)


class TestAgentOptsAreExplicit(unittest.TestCase):
    OPTS_START = re.compile(
        r"(?<!\$)\{\s*(?:\.\.\.ROLE_OPTS\.(\w+)|model: task\.auditor\.model,\s*effort: task\.auditor\.effort,|model:)"
    )

    def _calls(self, src):
        code = "\n".join(ln for _, ln in _code_lines(src))
        starts = [m.start() for m in re.finditer(r"(?<![\w.])agent\(", code)]
        return code, starts

    def test_全_agent_呼び出しが表から_model_と_effort_を取る(self):
        for name, src in SOURCES.items():
            roles = _role_opts(src)
            code, starts = self._calls(src)
            self.assertTrue(starts, f"{name}: agent( が見つからない")
            for idx, pos in enumerate(starts):
                end = starts[idx + 1] if idx + 1 < len(starts) else len(code)
                m = self.OPTS_START.search(code, pos, end)
                self.assertIsNotNone(m, f"{name}: agent() の opts が見つからない: {code[pos:pos + 120]!r}")
                text = m.group(0)
                self.assertNotEqual(
                    text.rstrip().split()[-1],
                    "model:",
                    f"{name}: model を直書きしている（表から取ること）: {code[pos:pos + 120]!r}",
                )
                if m.group(1):
                    self.assertIn(m.group(1), roles, f"{name}: ROLE_OPTS.{m.group(1)} が未定義")

    def test_ROLE_OPTS_の値が有効(self):
        for name, src in SOURCES.items():
            roles = _role_opts(src)
            self.assertTrue(roles, name)
            for role, (model, effort) in roles.items():
                self.assertIn(model, MODELS, f"{name}:{role}")
                self.assertIn(effort, EFFORTS, f"{name}:{role}")

    def test_AUDITORS_の全観点が_model_と_effort_を持つ(self):
        m = re.search(r"const AUDITORS = \[(.*?)\n\]", REFINE, re.S)
        entries = re.findall(r"\{ name: '(\w+)'[^}]*\}", m.group(1))
        self.assertEqual(len(entries), 8)
        for e in re.findall(r"\{ name: '\w+'[^}]*\}", m.group(1)):
            model = re.search(r"model: '(\w+)'", e)
            effort = re.search(r"effort: '(\w+)'", e)
            self.assertTrue(model and effort, e)
            self.assertIn(model.group(1), MODELS, e)
            self.assertIn(effort.group(1), EFFORTS, e)

    def test_配分表(self):
        refine = _role_opts(REFINE)
        self.assertEqual(refine["writer"], ("opus", "medium"))
        self.assertEqual(refine["ladderJudge"], ("sonnet", "medium"))
        for judge in ["resolver", "resolverVerifier", "adjudicator", "precedentJudge", "measurement"]:
            self.assertEqual(refine[judge], ("opus", "high"), judge)
        draft = _role_opts(DRAFT)
        self.assertEqual(draft["reqWriter"], ("opus", "medium"))
        self.assertEqual(draft["specWriter"], ("opus", "medium"))
        self.assertEqual(draft["executability"], ("opus", "high"))


class TestNoBodyInPrompts(unittest.TestCase):
    # 本文を使ってよい非プロンプト処理（script の構造検査）。
    ALLOWED_FUNCTIONS = {"structuralFindings"}
    # 行数計算・真偽判定・データの受け渡しに限った .markdown の使い方。
    WRAPPERS = [
        r"[\w.\[\]]+\.markdown \? (?=lineTotal)",
        r"lineTotal\([\w.\[\]]*\.markdown\)",
        r"newlineCount\([\w.\[\]]*\.markdown\)",
        r"changedLineRanges\(prevMarkdown, result\.markdown\)",
    ]
    PLUMBING = [
        r"^\s*markdown: [\w.]+\.markdown,?$",
        r"^\s*markdown: [\w.]+\.markdown \|\| '',?$",
        r"^\s*const prevMarkdown = documents\[idx\]\.markdown$",
        r"^\s*if \(!result \|\| !result\.markdown\) \{$",
        r"^\s*\(r\) => r && r\.result && r\.result\.markdown && writeConfirmed\(r\.result\)$",
        r"^const hasBody = \(d\) => Boolean\(d\.markdown \|\| d\.path\)$",
        r"^\s*const bodyOnly = existingDocs\.filter\(\(d\) => d && d\.markdown && !d\.path\)$",
        r"^const writerFailed = .*!r\.result\.markdown \|\| !writeConfirmed\(r\.result\)\)\)$",
        r"^\s*\.map\(\(d\) => \(\{ doc: d, result: \{ markdown: d\.markdown \|\| '',",
        r"^\s*if \(declared\.length \|\| !result\.fixed \|\| !result\.markdown\) return declared$",
        r"^\s*return \[\.\.\.new Set\(result\.markdown\.match\(ID_IN_TEXT\[kind\]\) \|\| \[\]\)\]$",
    ]

    def _function_spans(self, src):
        spans = []
        lines = src.split("\n")
        for i, ln in enumerate(lines):
            m = re.match(r"^function (\w+)\(", ln)
            if m and m.group(1) in self.ALLOWED_FUNCTIONS:
                e = next(j for j in range(i + 1, len(lines)) if lines[j] == "}")
                spans.append((i + 1, e + 1))
        return spans

    def test_プロンプトを組むコードが本文を埋め込まない(self):
        for name, src in SOURCES.items():
            spans = self._function_spans(src)
            offenders = []
            for no, ln in _code_lines(src):
                if ".markdown" not in ln:
                    continue
                if any(s <= no <= e for s, e in spans):
                    continue
                rest = ln
                for w in self.WRAPPERS:
                    rest = re.sub(w, "", rest)
                if ".markdown" not in rest:
                    continue
                if any(re.search(p, ln) for p in self.PLUMBING):
                    continue
                offenders.append(f"{name}:{no}: {ln.strip()}")
            self.assertEqual(offenders, [], "本文をプロンプトへ渡しうる .markdown の使用")

    def test_旧い埋め込み経路が残っていない(self):
        self.assertNotIn("d.markdown ? d.markdown", REFINE)
        self.assertNotIn("${d.markdown}", REFINE)
        self.assertNotIn("${r.result.markdown}", DRAFT)
        self.assertNotRegex(DRAFT, r"`# \[DOCUMENT\] \$\{doc\.key\}`,\n\s*doc\.markdown,")


def _run_node(source: str, harness: str, spec) -> object:
    with tempfile.TemporaryDirectory() as d:
        script = Path(d) / "t.mjs"
        script.write_text(source + "\n" + harness)
        out = subprocess.run(
            ["node", str(script), json.dumps(spec)], capture_output=True, text=True, check=True
        )
    return json.loads(out.stdout)


READ_SRC = "\n".join(
    [
        _extract_const(REFINE, "READ_CHUNK_LINES"),
        _extract_function(REFINE, "newlineCount"),
        _extract_function(REFINE, "lineTotal"),
        _extract_function(REFINE, "readInstruction"),
    ]
)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestReadInstruction(unittest.TestCase):
    H = """
const spec = JSON.parse(process.argv[2])
process.stdout.write(JSON.stringify(readInstruction(spec.path, spec.lines, spec.ranges)))
"""

    def _run(self, lines, ranges=None):
        return _run_node(READ_SRC, self.H, {"path": "/ws/a.md", "lines": lines, "ranges": ranges})

    def test_300_行以下は_1_回の_Read(self):
        out = self._run(250)
        self.assertIn("/ws/a.md", out)
        self.assertNotIn("offset=", out)

    def test_300_行を超えると_300_行ずつ区切る(self):
        out = self._run(650)
        self.assertIn("offset=1 limit=300", out)
        self.assertIn("offset=301 limit=300", out)
        self.assertIn("offset=601 limit=50", out)
        self.assertEqual(out.count("- Read "), 3)

    def test_行数不明でも一括_Read_を指示しない(self):
        out = self._run(None)
        self.assertIn("300 行ずつ", out)
        self.assertIn("全体を読まず", out)

    def test_範囲指定は範囲だけを読ませる(self):
        out = self._run(900, [{"start": 10, "end": 20, "heading": "#### SP-A-001"}, {"start": 500, "end": 499, "heading": "## 旧", "deleted": True}])
        self.assertIn("offset=10 limit=11", out)
        self.assertIn("削除された節「## 旧」", out)
        self.assertEqual(out.count("- Read "), 1)

    def test_本文を関数に持ち込まない(self):
        # readInstruction は本文を受け取らない（パスと行数だけ）
        self.assertRegex(REFINE, r"function readInstruction\(path, lineCount, ranges\)")

    def test_draft_と_refine_で逐語一致(self):
        for fn in ["newlineCount", "lineTotal", "readInstruction", "writeConfirmed"]:
            self.assertEqual(_extract_function(DRAFT, fn), _extract_function(REFINE, fn), fn)
        self.assertEqual(_extract_const(DRAFT, "READ_CHUNK_LINES"), _extract_const(REFINE, "READ_CHUNK_LINES"))


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestWriteConfirmed(unittest.TestCase):
    H = """
const spec = JSON.parse(process.argv[2])
process.stdout.write(JSON.stringify(spec.cases.map((c) => writeConfirmed(c))))
"""

    def test_line_count_照合(self):
        src = READ_SRC + "\n" + _extract_function(REFINE, "writeConfirmed")
        cases = [
            {"markdown": "a\nb\n", "line_count": 2},  # 末尾改行あり: wc -l = 2
            {"markdown": "a\nb", "line_count": 1},  # 返り値どおり Write: wc -l = 1
            {"markdown": "a\nb", "line_count": 2},  # Write 時に末尾改行が足された
            {"markdown": "a\nb", "line_count": "  2"},  # wc -l の前置空白
            {"markdown": "a\nb"},  # 欠落
            {"markdown": "a\nb", "line_count": None},
            {"markdown": "a\nb", "line_count": 4},  # 2 行ずれ
        ]
        out = _run_node(src, self.H, {"cases": cases})
        self.assertEqual(out, [True, True, True, True, False, False, False])


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
        return _run_node(_extract_function(REFINE, "changedLineRanges"), self.H, {"prev": prev, "next": nxt})

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


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestRedundancyReachesWriter(unittest.TestCase):
    H = """
const spec = JSON.parse(process.argv[2])
const out = partitionLadder(spec.findings, new Map(spec.kinds))
process.stdout.write(JSON.stringify({ writer: out.toWriter, contradiction: contradictionPassTargets(out.toWriter) }))
"""

    def test_冗長指摘は_action_を保ったまま_writer_へ届く(self):
        src = _extract_function(REFINE, "partitionLadder") + "\n" + _extract_function(REFINE, "contradictionPassTargets")
        finding = {
            "digest": "d1",
            "auditor": "executability",
            "document": "specifications/a",
            "location": "SP-A-002",
            "issue": "SP-A-001 の言い換え",
            "direction": "remove",
            "severity": "degraded",
            "action": "merge_into:SP-A-001",
        }
        for kinds in ([], [["d1", "artifact"]]):
            out = _run_node(src, self.H, {"findings": [finding], "kinds": kinds})
            self.assertEqual(len(out["writer"]), 1)
            self.assertEqual(out["writer"][0]["action"], "merge_into:SP-A-001")
            self.assertEqual(out["writer"][0]["severity"], "degraded")
            # 矛盾解消の追加パスは blocking 限定（意図的に degraded を渡さない）
            self.assertEqual(out["contradiction"], [])

    def test_監査スキーマと_writer_指示が_action_を扱う(self):
        self.assertIn("action: { type: 'string' }", REFINE)
        self.assertIn("action: { type: 'string' }", DRAFT)
        self.assertIn("`action` が付いた指摘は冗長の指摘である", REFINE)
        self.assertRegex(REFINE, r"const \{ toWriter, needsInput \} = partitionLadder\(withDigest, kindByDigest\)")
        self.assertIn("const reviseTargets = laddered.toWriter", REFINE)
        auditor = (SKILL / "agents" / "executability-auditor.md").read_text()
        for word in ["delete", "merge_into:", "replace_with_reference:", "severity: degraded"]:
            self.assertIn(word, auditor)


class TestWriteBackIsVerified(unittest.TestCase):
    def test_writer_は常に書き出して_line_count_を返す(self):
        for src in (DRAFT, REFINE):
            self.assertIn("line_count: { type: 'number' }", src)
            self.assertIn("wc -l <", src)
            self.assertIn("writeConfirmed(r.result)", src)

    def test_draft_dir_は絶対パスを要求する(self):
        for src in (DRAFT, REFINE):
            self.assertIn("draftDir.startsWith('/')", src)


if __name__ == "__main__":
    unittest.main()
