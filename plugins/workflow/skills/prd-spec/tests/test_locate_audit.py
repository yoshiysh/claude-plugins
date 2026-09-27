"""locate 読み（安いモデルが探し、監査役が原文で判定する）の構造テスト。

shunt の bulk-read は大きな文書を安いモデルに読ませるためにある。安いモデルに任せてよいのは
「どこを見るか」の選択（閉集合）だけで、判定・要約は任せない。原文は元ファイルから監査役が読み、
安いモデルが選ばなかった部分は script が割り当てた抜き取りで見落としを測る。

押さえるのは 6 つ。
1. AUDITORS の read は consistency / coverage だけが locate、他は full。role_opts の read は locate / full だけ通る
2. locate の計画は read === 'locate' かつ bulk_read_path ありのときだけ。それ以外は full / full_fallback
3. locate の [DOCUMENTS] は bulk_read_path・判定と言い換えの禁止・完全一致での特定・抜き取り範囲・全文読みへの退路を持つ
4. 抜き取り範囲は決定的で、文書の範囲内に収まり、定数どおりの数で、版が変われば変わりうる
5. locator の件数は監査役ごとに集計され、見落としは found_via から script が数える
6. 返り値・next_args・スコープ監査への配線
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
    assert m, f"{name} が見つからない"
    return m.group(0)


SRC = "\n".join(
    [
        _extract_const(REFINE, "READ_CHUNK_LINES"),
        _extract_const(REFINE, "MISS_SAMPLE_SMALL_DOC_LINES"),
        _extract_const(REFINE, "MISS_SAMPLE_CHUNKS_SMALL"),
        _extract_const(REFINE, "MISS_SAMPLE_CHUNKS_LARGE"),
        _extract_const(REFINE, "LOCATE_GROUP_MAX_BYTES"),
        _extract_const(REFINE, "LOCATE_PART_MAX_BYTES"),
        _extract_const(REFINE, "LOCATE_FILE_OVERHEAD_BYTES"),
        _extract_const(REFINE, "LOCATE_PROMPT_OVERHEAD_BYTES"),
        _extract_const(REFINE, "qDir"),
    ]
    + [
        _extract_function(REFINE, fn)
        for fn in [
            "readInstruction",
            "indexInstruction",
            "utf8Bytes",
            "locatorSampleRanges",
            "locateGroups",
            "auditReadPlan",
            "locateQuestion",
            "locateDocumentsSection",
            "fullFallbackNote",
            "summarizeLocator",
        ]
    ]
)


def _run(expr_js: str, spec) -> object:
    harness = "\nconst spec = JSON.parse(process.argv[2])\nprocess.stdout.write(JSON.stringify(" + expr_js + "))\n"
    with tempfile.TemporaryDirectory() as d:
        script = Path(d) / "t.mjs"
        script.write_text(SRC + harness)
        out = subprocess.run(["node", str(script), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def _auditors() -> dict:
    m = re.search(r"const AUDITORS = \[(.*?)\n\]", REFINE, re.S)
    return dict(re.findall(r"\{ name: '(\w+)'[^}]*read: '(\w+)' \}", m.group(1)))


class TestAuditorReadModes(unittest.TestCase):
    def test_locate_は_consistency_と_coverage_だけ(self):
        modes = _auditors()
        self.assertEqual(len(modes), 8)
        self.assertEqual({k for k, v in modes.items() if v == "locate"}, {"consistency", "coverage"})
        self.assertTrue(all(v in ("locate", "full") for v in modes.values()))

    def _override(self, src_name, tables_js, overrides):
        src = (SKILL / "scripts" / src_name).read_text()
        s = src.index("const MODELS = [")
        e = src.index("\nconst ", src.index("function applyRoleOverrides("))
        code = src[s:e] + f"\nconst tables = {tables_js};\n" + (
            "try { applyRoleOverrides(tables, " + json.dumps(overrides) + ");"
            " console.log(JSON.stringify({tables})) } catch (err) { console.log(JSON.stringify({err: err.message})) }"
        )
        out = subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    @unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
    def test_read_の上書きは_locate_と_full_だけ通る(self):
        tables = "[{writer: {model: 'opus', effort: 'medium'}}, {consistency: {model: 'sonnet', effort: 'medium', read: 'locate'}}]"
        for name in ("refine.js", "draft.js"):
            r = self._override(name, tables, {"consistency": {"read": "full"}})
            self.assertEqual(r["tables"][1]["consistency"]["read"], "full")
            r = self._override(name, tables, {"consistency": {"read": "locate", "effort": "low"}})
            self.assertEqual(r["tables"][1]["consistency"], {"model": "sonnet", "effort": "low", "read": "locate"})
            for bad in ({"consistency": {"read": "skim"}}, {"consistency": {"read": ""}}, {"writer": {"read": "full"}}):
                self.assertIn("err", self._override(name, tables, bad), (name, bad))


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestReadPlan(unittest.TestCase):
    DOCS = [
        {"key": "requirements/a", "draft_path": "/ws/a.md", "lineCount": 700, "byteSize": 60000, "revision": "R1.0", "fixed": False},
        {"key": "requirements/b", "draft_path": "/ws/b.md", "lineCount": 120, "byteSize": 9000, "revision": "R1.0", "fixed": False},
    ]

    def _plan(self, read, scoped, bulk, docs=None):
        return _run(
            "auditReadPlan(spec.read, spec.scoped, spec.bulk, spec.docs, 1000, '/ws/locate/consistency-ALL')",
            {"read": read, "scoped": scoped, "bulk": bulk, "docs": docs if docs is not None else self.DOCS},
        )

    def test_locate_と_bulk_read_path_が揃ったときだけ_locate(self):
        plan = self._plan("locate", False, "/p/bulk-read")
        self.assertEqual(plan["mode"], "locate")
        self.assertEqual([s["key"] for s in plan["samples"]], ["requirements/a", "requirements/b"])

    def test_full_の観点とスコープ監査は_full(self):
        self.assertEqual(self._plan("full", False, "/p/bulk-read"), {"mode": "full"})
        self.assertEqual(self._plan("locate", True, "/p/bulk-read"), {"mode": "full"})

    def test_bulk_read_path_が無ければ_full_fallback(self):
        self.assertEqual(self._plan("locate", False, ""), {"mode": "full_fallback", "reason": "bulk_read_path_unset"})

    def test_行数不明の対象文書があれば_full_fallback_固定文書は問わない(self):
        docs = self.DOCS + [{"key": "specifications/x", "draft_path": "/ws/x.md", "lineCount": None, "byteSize": 100, "fixed": False}]
        plan = self._plan("locate", False, "/p/bulk-read", docs)
        self.assertEqual(plan["mode"], "full_fallback")
        self.assertIn("line_count_unknown", plan["reason"])
        self.assertIn("specifications/x", plan["reason"])
        docs = self.DOCS + [{"key": "requirements/parent", "draft_path": "/ws/p.md", "lineCount": None, "fixed": True}]
        plan = self._plan("locate", False, "/p/bulk-read", docs)
        self.assertEqual(plan["mode"], "locate")
        self.assertNotIn("requirements/parent", [s["key"] for s in plan["samples"]])
        # 大きさの分からない固定文書は bulk-read に送らない（索引から要る節を読ませる）
        self.assertNotIn("/ws/p.md", [it["file"] for g in plan["groups"] for it in g["items"]])

    def test_バイト数不明の対象文書があれば_full_fallback(self):
        docs = self.DOCS + [{"key": "specifications/y", "draft_path": "/ws/y.md", "lineCount": 50, "byteSize": None, "fixed": False}]
        plan = self._plan("locate", False, "/p/bulk-read", docs)
        self.assertEqual(plan["mode"], "full_fallback")
        self.assertIn("byte_size_unknown: specifications/y", plan["reason"])

    def test_full_fallback_のプロンプトは全文の区切り読みで_read_mode_を求める(self):
        out = _run(
            "fullFallbackNote(spec.reason) + '\\n' + readInstruction('/ws/a.md', 700)",
            {"reason": "bulk_read_path_unset"},
        )
        self.assertIn("full_fallback", out)
        self.assertIn("bulk_read_path_unset", out)
        self.assertIn("offset=601 limit=100", out)
        self.assertNotIn("bulk-read", out.split("bulk_read_path_unset")[1])


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestLocatePrompt(unittest.TestCase):
    def _section(self, auditor="consistency", bulk="/home/u/.claude/plugins/cache/x/shunt/0.1.1/scripts/bulk-read"):
        docs = [
            {"key": "requirements/a", "draft_path": "/ws/a.md", "lineCount": 700, "byteSize": 60000, "revision": "R1.0", "fixed": False, "concern": "認証"},
            {"key": "requirements/b", "draft_path": "/ws/b.md", "lineCount": 120, "byteSize": 9000, "revision": "R1.0", "fixed": False, "concern": "通知"},
        ]
        return _run(
            "(() => { const plan = auditReadPlan('locate', false, spec.bulk, spec.docs, 1000, '/ws/locate/consistency-ALL');"
            " return { plan, text: locateDocumentsSection(plan, spec.docs, spec.bulk, locateQuestion(spec.auditor, ['二重実行の防止'])) } })()",
            {"docs": docs, "bulk": bulk, "auditor": auditor},
        )

    def test_bulk_read_path_と対象パスを含むコマンド(self):
        out = self._section()
        text = out["text"]
        self.assertIn("'/home/u/.claude/plugins/cache/x/shunt/0.1.1/scripts/bulk-read' --question", text)
        self.assertIn("--paths '/ws/a.md' '/ws/b.md'", text)
        self.assertIn("<<'LOCATE_Q'", text)

    def test_問いは判定と言い換えを禁じ_引用だけを求める(self):
        for auditor in ("consistency", "coverage"):
            q = _run("locateQuestion(spec.a, ['二重実行の防止'])", {"a": auditor})
            self.assertIn("一字一句そのまま", q)
            self.assertIn("要約・言い換え", q)
            self.assertIn("判断・評価は一切書かない", q)
            self.assertIn("ファイルパスを添える", q)
        self.assertIn("二重実行の防止", _run("locateQuestion('coverage', ['二重実行の防止'])", {}))

    def test_完全一致で特定して原文から判定する(self):
        text = self._section()["text"]
        self.assertIn("Grep（固定文字列・行番号付き）", text)
        self.assertIn("判定は Read した原文だけから行う", text)
        self.assertIn("locator_unmatched", text)
        self.assertIn("引用が無いことは不在の証拠にならない", text)

    def test_抜き取り範囲を列挙し_found_via_を求める(self):
        out = self._section()
        text = out["text"]
        for s in out["plan"]["samples"]:
            for r in s["ranges"]:
                self.assertIn(f"- {s['key']}: Read {s['path']} offset={r['start']} limit={r['end'] - r['start'] + 1}", text)
        self.assertIn('found_via', text)
        self.assertIn('"sample"', text)

    def test_実行時の失敗に備えて全文読みの退路を持つ(self):
        text = self._section()["text"]
        fallback = text.split("## [FALLBACK]")[1]
        self.assertIn("offset=1 limit=300", fallback)
        self.assertIn("offset=601 limit=100", fallback)
        self.assertIn("/ws/b.md（120 行。Read すること）", fallback)
        self.assertIn('read_mode: "full_fallback"', text)
        self.assertIn("読まずに判定してはならない", text)

    def test_パスの単一引用符はシェルで壊れない(self):
        text = self._section(bulk="/p/it's/bulk-read")["text"]
        self.assertIn("'/p/it'\\''s/bulk-read'", text)

    def test_未定義の監査役は止まる(self):
        with self.assertRaises(subprocess.CalledProcessError):
            _run("locateQuestion('clarity', [])", {})


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestSampleRanges(unittest.TestCase):
    def _ranges(self, key, rev, lines):
        return _run("locatorSampleRanges(spec.key, spec.rev, spec.lines)", {"key": key, "rev": rev, "lines": lines})

    def test_同じ入力なら同じ範囲(self):
        a = self._ranges("requirements/a", "R1.2", 2000)
        self.assertEqual(a, self._ranges("requirements/a", "R1.2", 2000))

    def test_範囲は文書内で塊の境界に揃う(self):
        for lines in (1, 299, 300, 301, 600, 601, 1234, 5000):
            for rev in ("R1.0", "R1.1", "R2.3"):
                for r in self._ranges("specifications/x", rev, lines):
                    self.assertGreaterEqual(r["start"], 1)
                    self.assertLessEqual(r["end"], lines)
                    self.assertLessEqual(r["end"] - r["start"] + 1, 300)
                    self.assertEqual((r["start"] - 1) % 300, 0)

    def test_件数は定数どおり(self):
        self.assertEqual(_extract_const(REFINE, "MISS_SAMPLE_SMALL_DOC_LINES"), "const MISS_SAMPLE_SMALL_DOC_LINES = 600")
        self.assertEqual(len(self._ranges("k", "R1.0", 150)), 1)
        self.assertEqual(len(self._ranges("k", "R1.0", 600)), 1)
        self.assertEqual(len(self._ranges("k", "R1.0", 601)), 2)
        self.assertEqual(len(self._ranges("k", "R1.0", 4000)), 2)
        self.assertEqual(self._ranges("k", "R1.0", 0), [])
        two = self._ranges("k", "R1.0", 4000)
        self.assertNotEqual(two[0]["start"], two[1]["start"])

    def test_版が変われば範囲が変わりうる(self):
        seen = {json.dumps(self._ranges("requirements/a", f"R1.{i}", 6000)) for i in range(8)}
        self.assertGreater(len(seen), 1)

    def test_乱数と時刻を使わない(self):
        body = _extract_function(REFINE, "locatorSampleRanges")
        self.assertNotIn("Math.random", body)
        self.assertNotIn("Date", body)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestSummarizeLocator(unittest.TestCase):
    def test_監査役ごとに集計し_見落としは_found_via_から数える(self):
        plan = {"mode": "locate", "samples": [{"key": "a", "path": "/a", "ranges": [{"start": 1, "end": 300}, {"start": 601, "end": 900}]}]}
        records = [
            {
                "auditor": "consistency",
                "plan": plan,
                "result": {
                    "read_mode": "locate",
                    "locator_quotes": 12,
                    "locator_unmatched": 2,
                    "locator_misses": 0,
                    "failed": [{"found_via": "locator"}, {"found_via": "sample"}, {"found_via": "locator"}],
                },
            },
            {"auditor": "coverage", "plan": {"mode": "full_fallback", "reason": "bulk_read_path_unset"}, "result": {"failed": [{}]}},
            {
                "auditor": "coverage",
                "plan": plan,
                "result": {"read_mode": "full_fallback", "read_fallback_reason": "exit 1", "failed": []},
            },
            {"auditor": "coverage", "plan": plan, "result": {"failed": []}},
        ]
        out = _run("summarizeLocator(spec.records)", {"records": records})
        c = out["consistency"]
        self.assertEqual((c["calls"], c["locate"], c["full_fallback"]), (1, 1, 0))
        self.assertEqual((c["locator_quotes"], c["locator_unmatched"]), (12, 2))
        self.assertEqual((c["findings_via_locator"], c["locator_misses"], c["locator_misses_reported"]), (2, 1, 0))
        self.assertAlmostEqual(c["locator_miss_rate"], 1 / 3)
        self.assertEqual(c["sampled_chunks"], 2)
        v = out["coverage"]
        self.assertEqual((v["calls"], v["locate"], v["full_fallback"], v["unreported"]), (3, 0, 2, 1))
        self.assertEqual(v["fallback_reasons"], ["bulk_read_path_unset", "exit 1"])
        self.assertIsNone(v["locator_miss_rate"])

    def test_記録が無ければ空(self):
        self.assertEqual(_run("summarizeLocator([])", {}), {})


class TestWiring(unittest.TestCase):
    def test_計画は_buildAuditPrompt_で決まり_結果と一緒に記録される(self):
        body = _extract_function(REFINE, "buildAuditPrompt")
        self.assertIn("auditReadPlan(auditor.read, narrowed, bulkReadPath, locateDocs, utf8Bytes(question), chunkDir)", body)
        self.assertIn("plan.mode === 'locate'", body)
        self.assertIn("fullFallbackNote(plan.reason)", body)
        self.assertEqual(REFINE.count("plan: task.readPlan"), 2)
        self.assertEqual(REFINE.count("for (const r of received) recordLocator(r)"), 2)

    def test_返り値と_next_args(self):
        self.assertIn("locator: summarizeLocator(locatorRecords)", REFINE)
        self.assertIn("...(ctx.bulk_read_path ? { bulk_read_path: ctx.bulk_read_path } : {})", REFINE)
        self.assertIn("bulk_read_path: bulkReadPath,", REFINE)
        self.assertIn("bulkReadPath.startsWith('/')", REFINE)

    def test_監査スキーマの追加項目は任意(self):
        m = re.search(r"const AUDIT_SCHEMA = \{(.*?)\n\}", REFINE, re.S)
        schema = m.group(1)
        for f in ("read_mode", "locator_quotes", "locator_unmatched", "locator_misses", "found_via"):
            self.assertIn(f"{f}: {{", schema)
        self.assertIn("required: ['failed', 'checked']", schema)
        self.assertIn("required: ['id', 'location', 'quote', 'issue', 'direction']", schema)

    def test_draft_は_bulk_read_を使わない(self):
        self.assertNotIn("bulk_read_path", DRAFT)

    def test_文書が_locate_読みを説明する(self):
        for md in ("agents/consistency-auditor.md", "agents/coverage-auditor.md"):
            text = (SKILL / md).read_text()
            self.assertIn("## locate 読み", text)
            self.assertIn("found_via", text)
            self.assertIn("full_fallback", text)
        self.assertIn("locator_unmatched", (SKILL / "schemas" / "agent-contracts.md").read_text())
        self.assertIn("`bulk_read_path`", (SKILL / "references" / "workflow-io.md").read_text())
        self.assertIn("bulk_read_path:", (SKILL / "SKILL.md").read_text())


if __name__ == "__main__":
    unittest.main()


class DocLineCountTest(unittest.TestCase):
    """行数は checker が数えた値（documents[].line_count）から取る（初回監査が全文読みへ戻らないように）。

    本文は script の手元に無い。旧形式の args が markdown を持っていても行数の材料にしない。
    """

    def test_line_count_だけを使う(self):
        src = (SKILL / "scripts" / "refine.js").read_text()
        fn = next(l for l in src.split("\n") if l.startswith("const docLineCount ="))
        code = fn + "\nconsole.log(JSON.stringify([docLineCount({markdown:'a\\nb\\n'}), docLineCount({markdown:'', line_count: 1002}), docLineCount({markdown:''})]))"
        out = subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout), [None, 1002, None])


# 実 run（pdca-redesign の r1 下書き 9 文書）の UTF-8 バイト数と行数。全部を 1 回で送ると shunt の
# 上限 400,000 バイトを超えて失敗した（481,051 バイト）。
R1_DOCS = [
    ("requirements/consumer", 21472, 333),
    ("requirements/pdca", 26164, 403),
    ("requirements/requester", 33707, 474),
    ("specifications/authoring", 72780, 722),
    ("specifications/elicitation", 56232, 566),
    ("specifications/flow", 100739, 1002),
    ("specifications/pdca-flow", 72977, 624),
    ("specifications/pdca-goal", 32799, 363),
    ("specifications/verification", 62279, 566),
]


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestLocateGroups(unittest.TestCase):
    LIMIT = int(_extract_const(REFINE, "LOCATE_GROUP_MAX_BYTES").split("=")[1])
    PART = int(_extract_const(REFINE, "LOCATE_PART_MAX_BYTES").split("=")[1])

    def _docs(self, rows):
        return [
            {"key": k, "draft_path": f"/ws/drafts/r1/{k.replace('/', '-')}.md", "lineCount": n, "byteSize": b, "revision": "R1.0", "fixed": False}
            for k, b, n in rows
        ]

    def _plan(self, docs, q=1500):
        return _run("auditReadPlan('locate', false, '/p/bulk-read', spec.docs, spec.q, '/ws/locate/consistency-ALL')", {"docs": docs, "q": q})

    def test_上限は_shunt_の上限の手前(self):
        # shunt 0.1.1 scripts/lib/gemini.sh の SHUNT_MAX_PAYLOAD_BYTES=400000 より十分小さい
        self.assertLess(self.LIMIT, 400000)
        self.assertLess(self.PART, self.LIMIT)

    def test_実_run_の文書群は上限内の組に分かれ_各文書はちょうど一度送られる(self):
        plan = self._plan(self._docs(R1_DOCS))
        self.assertEqual(plan["mode"], "locate")
        self.assertGreaterEqual(len(plan["groups"]), 2)
        for g in plan["groups"]:
            self.assertLessEqual(g["bytes"], self.LIMIT, g["id"])
        sent = sorted(it["key"] for g in plan["groups"] for it in g["items"])
        self.assertEqual(sent, sorted(k for k, _, _ in R1_DOCS))
        self.assertEqual(plan["chunks"], [])  # 1 文書で上限を超えるものは無い
        # 同じ入力なら同じ組
        self.assertEqual(plan["groups"], self._plan(self._docs(R1_DOCS))["groups"])

    def test_上限を超える_1_文書は行範囲の片に分ける(self):
        docs = self._docs([("specifications/huge", 450000, 3000)])
        plan = self._plan(docs)
        parts = [it for g in plan["groups"] for it in g["items"]]
        self.assertGreater(len(parts), 1)
        # 片は 1 行目から末尾まで隙間なく重ならずに並ぶ
        ranges = sorted((p["start"], p["end"]) for p in parts)
        self.assertEqual(ranges[0][0], 1)
        self.assertEqual(ranges[-1][1], 3000)
        for (a1, b1), (a2, _) in zip(ranges, ranges[1:]):
            self.assertEqual(a2, b1 + 1)
        for p in parts:
            self.assertLessEqual(p["bytes"], self.PART + 200)
            self.assertTrue(p["file"].startswith("/ws/locate/consistency-ALL/"))
        for g in plan["groups"]:
            self.assertLessEqual(g["bytes"], self.LIMIT)
        chunk_files = {c["file"] for c in plan["chunks"]}
        self.assertTrue({p["file"] for p in parts} <= chunk_files)

    def test_時間切れ用の半分は同じ範囲を覆う(self):
        plan = self._plan(self._docs(R1_DOCS + [("specifications/huge", 450000, 3000)]))
        for g in plan["groups"]:
            self.assertIsNotNone(g["halves"], g["id"])
            whole = sorted((it["key"], it["start"], it["end"]) for it in g["items"])
            if len(g["items"]) > 1:
                halves = sorted((it["key"], it["start"], it["end"]) for h in g["halves"] for it in h)
                self.assertEqual(halves, whole)
            else:
                (k, a, b), = whole
                lines = sorted((it["start"], it["end"]) for h in g["halves"] for it in h)
                self.assertEqual((lines[0][0], lines[-1][1]), (a, b))
                self.assertEqual(lines[1][0], lines[0][1] + 1)

    def test_プロンプトは組ごとに実行させ_時間切れは半分で_1_回だけ再実行(self):
        docs = self._docs(R1_DOCS + [("specifications/huge", 450000, 3000)])
        out = _run(
            "(() => { const plan = auditReadPlan('locate', false, '/p/bulk-read', spec.docs, 1500, '/ws/locate/consistency-ALL');"
            " return { plan, text: locateDocumentsSection(plan, spec.docs, '/p/bulk-read', locateQuestion('consistency', [])) } })()",
            {"docs": docs},
        )
        text, plan = out["text"], out["plan"]
        for g in plan["groups"]:
            self.assertIn(f"### {g['id']}（見積もり {g['bytes']} バイト", text)
        self.assertIn("curl rc=28", text)
        self.assertIn('"split_ok"', text)
        self.assertIn("その組の文書だけを末尾の [FALLBACK] で全文読み", text)
        self.assertIn("他の組の結果は捨てない", text)
        for c in plan["chunks"]:
            self.assertIn(f"sed -n '{c['start']},{c['end']}p' '/ws/drafts/r1/specifications-huge.md' > '{c['file']}'", text)
        # 問いは 1 回だけファイルに書き、各組はそれを読む
        self.assertEqual(text.count("<<'LOCATE_Q'"), 1)
        self.assertIn("--question \"$(cat '/ws/locate/consistency-ALL/locate-question.txt')\"", text)

    def test_送信量の見積もりは_bulk_read_の枠を下回らない(self):
        bulk = Path.home() / ".claude/plugins/cache/yoshiysh-claude-plugins/shunt/0.1.1/scripts/bulk-read"
        if not bulk.is_file():
            self.skipTest("shunt 0.1.1 が無い")
        src = bulk.read_text()
        wrapper = len("<file path=\"\">\n".encode()) + len("</file>\n\n".encode())
        self.assertIn("printf '<file path=\"%s\">\\n' \"$path\"", src)
        self.assertLessEqual(wrapper, int(_extract_const(REFINE, "LOCATE_FILE_OVERHEAD_BYTES").split("=")[1]))
        trailer = re.findall(r"printf '([^']*)'", src.split("Question: %s")[1])
        trailer_bytes = sum(len(t.replace("\\n", "\n").encode()) for t in trailer) + len("Question: \n")
        self.assertLessEqual(trailer_bytes, int(_extract_const(REFINE, "LOCATE_PROMPT_OVERHEAD_BYTES").split("=")[1]))

    def test_utf8_のバイト数で数える(self):
        self.assertEqual(_run("utf8Bytes(spec.s)", {"s": "aé日😀"}), 1 + 2 + 3 + 4)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TestLocateGroupSummary(unittest.TestCase):
    def test_組ごとの結果を集計し_呼び出し単位の件数は変えない(self):
        plan = {"mode": "locate", "samples": [], "groups": [{"id": "G1"}, {"id": "G2"}, {"id": "G3"}, {"id": "G4"}]}
        result = {
            "read_mode": "locate",
            "failed": [],
            "locate_groups": [
                {"group": "G1", "status": "ok"},
                {"group": "G2", "status": "split_ok"},
                {"group": "G3", "status": "full_fallback", "reason": "curl rc=28"},
            ],
        }
        v = _run("summarizeLocator([{ auditor: 'consistency', plan: spec.plan, result: spec.result }])", {"plan": plan, "result": result})["consistency"]
        self.assertEqual((v["calls"], v["locate"], v["full_fallback"]), (1, 1, 0))
        self.assertEqual((v["groups"], v["group_split_ok"], v["group_full_fallback"], v["group_unreported"]), (4, 1, 1, 1))
        self.assertEqual(v["group_fallback_reasons"], ["curl rc=28"])
