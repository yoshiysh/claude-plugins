"""doc_check の --lint（生成者の自己点検）のテスト。

lint は flow-framer（flow --lint）と writer（doc --lint）が自分のループでだけ使い、verifier・flow-check・監査役の止まり方を変えない。
ここでは次を押さえる。

1. flow --lint は、状態を変える工程の obtain always の出典（obtain_source）の欠けを拾う（試走の証拠の F-005・F-017・F-025 を含む）。
   今の版で合格した要素は見ない。出典の引用は put が input.md と照合し、always でない要素の obtain_source は put が拒否する
2. doc --lint は、表を指す語のある項目の節に表が無い形（試走の証拠の PR-CLEANUP-028 の表が 072 の下にある形）を拾う。
   stash・unstash は lint の差し戻しの前の flow と open を控えて戻す
3. --lint の有無で findings・codes・blocking・digest・checks/flow.json・checks/doc.json が変わらない。LINT_ の符号は codes にも
   FIXERS_BY_CODE にも入らず、prd-spec.js が --lint を渡すのは起草の flow-framer と writer だけ
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_doc_check_workspace import DOC_CHECK, FIXTURE, _ok, _put, _put_run  # noqa: E402
from test_prd_pure import flow_mode_codes, value  # noqa: E402
from prd_script import PRD_PATH as PRD  # noqa: E402

TRIAL = Path(__file__).resolve().parents[5] / "docs" / "trials" / "2026-09-29-prd-spec-cleanup-branches-rerun2" / "evidence"
LINT_CODES = set(re.findall(r"^  ([A-Z_]+): \(", DOC_CHECK.read_text(encoding="utf-8").split("// LINT_TEXT_BEGIN")[1].split("// LINT_TEXT_END")[0], re.M))


def canonical(value):
    return json.dumps(value, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def lint_ids(ws, name):
    return [f["id"] for f in json.loads((Path(ws) / "checks" / name).read_text())["findings"]]


class _Workspace(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name) / "W"
        shutil.copytree(FIXTURE, self.ws)

    def tearDown(self):
        self._tmp.cleanup()


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class FlowLint(_Workspace):
    def _f005(self, **extra):
        """生成の script の既定の obtain="always" のまま、失敗しうる削除の工程を置いた形（試走の証拠の F-005 の最小の再現）。"""
        with (self.ws / "input.md").open("a") as f:
            f.write("\nローカルの取り込み済みのブランチを削除する。未コミットの作業を失ってはならない。\n")
        _put(self.ws, "decisions", {"decisions": [{"id": "D-004", "kind": "invariant", "quote": "未コミットの作業を失ってはならない。", "value": "未コミットの作業を失わない"}]})
        el = {"id": "F-002", "label": "取り込み済みのローカルブランチを削除する", "effect": "destructive", "obtain": "always",
              "source": {"input": "ローカルの取り込み済み"}, "constrained_by": ["D-004"], **extra}
        _put(self.ws, "flow", {"elements": [el]})

    def test_既定値のalwaysの削除の工程は共有の検査を通りlintだけが拾う(self):
        self._f005()
        plain = _ok(self.ws, "flow")
        self.assertEqual((plain["findings"], plain["codes"]), (0, {}), "verifier の止まる検査はこの形を拾わない（だから verifier が insufficient_grounds で落とした）")
        out = _ok(self.ws, "flow", "--lint")
        self.assertEqual(out["lint_codes"], {"LINT_OBTAIN_UNGROUNDED": ["F-002"]})
        self.assertEqual(out["lint"], 1)
        self.assertEqual(out["lint_path"], "checks/flow.lint.json")
        self.assertEqual(lint_ids(self.ws, "flow.lint.json"), ["LINT-OBTAIN-UNGROUNDED-F-002"])

    def test_出典を付けるかmay_failにすれば消える(self):
        self._f005(obtain_source={"decision": "D-004"})
        self.assertEqual(_ok(self.ws, "flow", "--lint")["lint"], 0)
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "obtain": "may_fail", "obtain_source": None, "on_fail": {"as": "削除できない", "source": {"input": "削除する"}}}]})
        self.assertEqual(_ok(self.ws, "flow", "--lint")["lint"], 0)

    def test_readの工程は見ない(self):
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "effect": "read"}]})
        self.assertEqual(_ok(self.ws, "flow", "--lint")["lint"], 0)

    def test_always以外の要素のobtain_sourceはputが拒否する(self):
        # may_fail に変えた要素に always の出典が残ると、根拠の無くなった出典が検証に届く。
        self._f005(obtain_source={"decision": "D-004"})
        before = (self.ws / "flow.json").read_bytes()
        r = _put_run(self.ws, "flow", {"elements": [{"id": "F-002", "obtain": "may_fail", "on_fail": {"as": "削除できない", "source": {"input": "削除する"}}}]})
        self.assertEqual(r.returncode, 1)
        self.assertIn("obtain_source", r.stderr)
        self.assertEqual((self.ws / "flow.json").read_bytes(), before)

    def test_出典の形と実在も見る(self):
        self._f005(obtain_source={"open": "O-001"})
        _ok(self.ws, "flow", "--lint")
        self.assertEqual(lint_ids(self.ws, "flow.lint.json"), ["LINT-GROUNDS-SHAPE-F-002.obtain_source"])
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "obtain_source": {"decision": "D-004"}}]})
        _ok(self.ws, "del", "--ledger", "decisions", "--ids", "D-004")
        _ok(self.ws, "flow", "--lint")
        self.assertIn("LINT-GROUNDS-UNKNOWN-F-002.obtain_source-D-004", lint_ids(self.ws, "flow.lint.json"))

    def test_引用はputがinput_mdと照合する(self):
        before = (self.ws / "flow.json").read_bytes()
        r = _put_run(self.ws, "flow", {"elements": [{"id": "F-002", "obtain_source": {"input": "依頼文に無い文"}}]})
        self.assertEqual(r.returncode, 1)
        self.assertIn("F-002 obtain_source", r.stderr)
        self.assertEqual((self.ws / "flow.json").read_bytes(), before)
        r = _put_run(self.ws, "flow", {"elements": [{"id": "F-004", "obtain_source": {"input": "承認"}}]})
        self.assertEqual(r.returncode, 1, "decision は obtain_source を持てない")

    def test_今の版で合格した要素は見ない(self):
        # settle と verifier の検証の対象を増やさないため（合格した要素を lint で書き換えさせない）。
        self._f005()
        sha = lambda ledger: _ok(self.ws, "sha", "--ledger", ledger)["sha256"]
        _put(self.ws, "verifications", {"items": [{"id": "F-002", "verdict": "pass", "reason": "r"}]},
             "--expect-resolutions", sha("resolutions"), "--expect-decisions", sha("decisions"))
        self.assertEqual(_ok(self.ws, "flow", "--lint")["lint"], 0)

    def test_lintの有無でflowの判断に使う欄とchecksは変わらない(self):
        self._f005()
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "next": ["F-404"]}]})
        plain = _ok(self.ws, "flow")
        before = (self.ws / "checks" / "flow.json").read_bytes()
        linted = _ok(self.ws, "flow", "--lint")
        self.assertEqual((self.ws / "checks" / "flow.json").read_bytes(), before)
        self.assertGreater(plain["findings"], 0)
        self.assertEqual({k: v for k, v in linted.items() if not k.startswith("lint")}, plain)
        self.assertFalse(set(linted["codes"]) & LINT_CODES)
        self.assertTrue(set(linted["lint_codes"]) <= LINT_CODES)
        self.assertNotIn("lint", plain)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
@unittest.skipUnless(TRIAL.is_dir(), "試走の証拠が無い環境ではスキップ")
class TrialEvidence(unittest.TestCase):
    def test_試走の最終のflowの削除と退避をalwaysに戻すとlintだけが拾う(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "input.md").write_text("x\n")
            for name, src in (("flow", "flow-final.json"), ("decisions", "decisions.json"), ("open", "open.json"), ("resolutions", "resolutions-final.json")):
                body = json.loads((TRIAL / src).read_text(encoding="utf-8"))
                if name == "flow":
                    for el in body["elements"]:
                        if el["id"] in ("F-005", "F-017", "F-025"):
                            el["obtain"] = "always"
                (ws / f"{name}.json").write_text(canonical(body))
            out = _ok(ws, "flow", "--lint")
            self.assertEqual(out["findings"], 0, "共有の検査は always に戻した版を拾わない")
            self.assertEqual(set(out["lint_codes"]), {"LINT_OBTAIN_UNGROUNDED"})
            self.assertEqual(sorted(out["lint_codes"]["LINT_OBTAIN_UNGROUNDED"]), ["F-005", "F-017", "F-025", "F-027"], "F-027 は最終の版でも always の reset")

    def test_028の表が072の見出しの下にある形を拾い_直した版は拾わない(self):
        fixed = (TRIAL / "requirements-cleanup-branches.md").read_text(encoding="utf-8")
        # 072 の節を切り出し、028 の本文の段落（見出しの次の段落）の直後に差し込む。028 の表は 072 の見出しの下に入る。
        start = fixed.index("#### PR-CLEANUP-072 ")
        end = fixed.index("\n#### ", start) + 1
        sec072, rest = fixed[start:end], fixed[:start] + fixed[end:]
        heading = rest.index("#### PR-CLEANUP-028 ")
        para_end = rest.index("\n\n", rest.index("\n\n", heading) + 2) + 2
        broken = rest[:para_end] + sec072 + "\n" + rest[para_end:]
        self.assertLess(broken.index("PR-CLEANUP-072 承認"), broken.index("| 一部を承認 |"))
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "requirements-cleanup-branches.md").write_text(fixed)
            ok = _ok(ws, "doc", "--lint")
            self.assertEqual(ok["lint"], 0)
            (ws / "requirements-cleanup-branches.md").write_text(broken)
            plain = _ok(ws, "doc")
            out = _ok(ws, "doc", "--lint")
            self.assertEqual(out["lint_codes"], {"LINT_TABLE_ELSEWHERE": ["PR-CLEANUP-028"]})
            self.assertEqual(lint_ids(ws, "doc.lint.json"), ["LINT-TABLE-ELSEWHERE-requirements/cleanup-branches-PR-CLEANUP-028"])
            self.assertEqual({k: v for k, v in out.items() if not k.startswith("lint")}, plain, "監査役が止まる blocking と digest は変わらない")


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class DocLint(_Workspace):
    DOC = "requirements-auth.md"

    def _append(self, text):
        with (self.ws / self.DOC).open("a") as f:
            f.write(text)

    def _lint(self, body):
        self._append(body)
        out = _ok(self.ws, "doc", "--doc", "requirements/auth", "--lint")
        return out["lint_codes"].get("LINT_TABLE_ELSEWHERE", [])

    def test_表を指す語の節に表が無ければ拾い_自分の節の表は拾わない(self):
        flagged = self._lint("\n#### PR-AUTH-010 応答\n\nシステムは、次の判定表に従って応答を扱わなければならない。\n\n"
                             "#### PR-AUTH-011 別の項目\n\nシステムは記録しなければならない。\n\n| 条件 | 結果 |\n|---|---|\n| a | b |\n\n"
                             "#### PR-AUTH-013 報告\n\nシステムは、以下の表の項目を報告しなければならない。\n\n| 項目 |\n|---|\n| 件数 |\n")
        self.assertEqual(flagged, ["PR-AUTH-010"])
        self.assertEqual(lint_ids(self.ws, "doc.requirements__auth.lint.json"), ["LINT-TABLE-ELSEWHERE-requirements/auth-PR-AUTH-010"])

    def test_表を指す語の言い方(self):
        phrases = {"下表": True, "次に示す表": True, "以下の判定表": True, "以下の状態遷移表": True, "下記の表": True, "次の表": True,
                   "次の表示": False, "以下の表現": False}
        body = "".join(f"\n#### PR-AUTH-{100 + i} 項目\n\nシステムは、{p}に従わなければならない。\n" for i, p in enumerate(phrases))
        expected = [f"PR-AUTH-{100 + i}" for i, (p, hit) in enumerate(phrases.items()) if hit]
        self.assertEqual(sorted(self._lint(body)), expected)

    def test_小見出しの下と引用の中の表は自分の節の表に数え_コードの囲みの中は数えない(self):
        flagged = self._lint("\n#### PR-AUTH-020 小見出し\n\nシステムは、次の判定表に従わなければならない。\n\n##### 判定表\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"
                             "#### PR-AUTH-021 引用\n\nシステムは、次の表に従わなければならない。\n\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n\n"
                             "#### PR-AUTH-022 囲みの中の表\n\nシステムは、次の表に従わなければならない。\n\n```\n| a | b |\n|---|---|\n```\n\n"
                             "#### PR-AUTH-023 囲みの中の語\n\nシステムは記録しなければならない。\n\n```\n次の表\n```\n\n"
                             "#### PR-AUTH-024 ID を持つ小見出し\n\nシステムは、次の表に従わなければならない。\n\n##### PR-AUTH-025 別の項目\n\n| a |\n|---|\n| 1 |\n")
        self.assertEqual(sorted(flagged), ["PR-AUTH-022", "PR-AUTH-024"])

    def test_lintの有無でdocのfindingsとblockingとdigestとchecksは変わらない(self):
        self._append("\n#### PR-AUTH-010 応答\n\nシステムは、次の表に従わなければならない。\n")
        plain = _ok(self.ws, "doc")
        before = (self.ws / "checks" / "doc.json").read_bytes()
        out = _ok(self.ws, "doc", "--lint")
        self.assertEqual((self.ws / "checks" / "doc.json").read_bytes(), before)
        self.assertEqual(out["lint"], 1)
        self.assertEqual({k: v for k, v in out.items() if not k.startswith("lint")}, plain)
        ids = [f["id"] for f in json.loads(before)["findings"]]
        self.assertFalse([i for i in ids if i.startswith("LINT-")])


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class StashUnstash(_Workspace):
    def test_unstashはstashの時点のflowとopenに戻す(self):
        flow_before, open_before = (self.ws / "flow.json").read_bytes(), (self.ws / "open.json").read_bytes()
        st = _ok(self.ws, "stash", "--save", "flow-framer-lint")
        self.assertEqual(st["flow_sha256"], _ok(self.ws, "flow")["content_sha256"])
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "next": ["F-404"]}]})
        _put(self.ws, "open", {"open": [{"id": "O-002", "text": "足した未決"}]})
        out = _ok(self.ws, "unstash", "--against", "flow-framer-lint", "--token", "t1")
        self.assertEqual(out["flow_sha256"], st["flow_sha256"])
        self.assertEqual(((self.ws / "flow.json").read_bytes(), (self.ws / "open.json").read_bytes()), (flow_before, open_before))

    def test_控えが無ければ何も戻さない(self):
        r = subprocess.run(["node", str(DOC_CHECK), "unstash", "--against", "none", "--token", "t1", "--workspace", str(self.ws)], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class LintStaysOutOfStopPaths(unittest.TestCase):
    def test_LINTの符号はflowモードの符号にも直し手の表にも無い(self):
        # 表に LINT_ が入ると、flow-check・verifier の codes に出たときに independentFlow が rerun:false で段を止める。
        self.assertTrue(LINT_CODES)
        self.assertFalse(LINT_CODES & flow_mode_codes())
        self.assertFalse(LINT_CODES & set(value("Object.keys(FIXERS_BY_CODE)")))

    def test_prdがlintを渡すのは起草のflow_framerとwriterだけ(self):
        src = PRD.read_text(encoding="utf-8")
        self.assertIn("--doc <キー> --lint", src[src.index("function writerPrompt("):])
        for name in ("designatedCmds", "RULINGS_FLOW", "copyCmds", "independentFlow"):
            start = src.index(name)
            self.assertNotIn("--lint", src[start:src.index("\n\n", start)], name)
        self.assertEqual(src.count("{ lint: true }"), 2)
        self.assertIn("], 'Flow', { lint: true })", src)
        self.assertIn("], 'Answers', { lint: true })", src)
        settle = src[src.index("async function settleRound("):]
        self.assertIn("], phaseTitle)\n", settle[: settle.index("\n}\n")], "settle の flow-framer は lint を付けずに呼ぶ")


if __name__ == "__main__":
    unittest.main()
