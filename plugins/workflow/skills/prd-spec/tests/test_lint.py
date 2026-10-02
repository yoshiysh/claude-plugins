"""doc_check の --lint（生成者の自己点検）のテスト。

lint は flow-framer（flow --lint）と writer（doc --lint）が自分のループでだけ使い、verifier・flow-check・監査役の止まり方を変えない。
ここでは次を押さえる。

1. flow --lint は、状態を変える工程の obtain always の出典（obtain_source）の欠けを拾う（試走の証拠の flow の書き込みの工程を既定値の always に戻した形を含む）。
   今の版で合格した要素は見ない。出典の引用は put が input.md と照合し、always でない要素の obtain_source は put が拒否する
2. doc --lint は、表を指す語のある項目の節に表が無い形（判定表を指す項目の表が、次の項目の見出しの下に入った形）を拾う。
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
    def _always_delete(self, **extra):
        """生成の script の既定の obtain="always" のまま、失敗しうる削除の工程を置いた形（最小の再現）。"""
        with (self.ws / "input.md").open("a") as f:
            f.write("\nローカルの取り込み済みのブランチを削除する。未コミットの作業を失ってはならない。\n")
        _put(self.ws, "decisions", {"decisions": [{"id": "D-004", "kind": "invariant", "quote": "未コミットの作業を失ってはならない。", "value": "未コミットの作業を失わない"}]})
        el = {"id": "F-002", "label": "取り込み済みのローカルブランチを削除する", "effect": "destructive", "obtain": "always",
              "source": {"input": "ローカルの取り込み済み"}, "constrained_by": ["D-004"], **extra}
        _put(self.ws, "flow", {"elements": [el]})

    def test_既定値のalwaysの削除の工程は共有の検査を通りlintだけが拾う(self):
        self._always_delete()
        plain = _ok(self.ws, "flow")
        self.assertEqual((plain["findings"], plain["codes"]), (0, {}), "verifier の止まる検査はこの形を拾わない（だから verifier が insufficient_grounds で落とした）")
        out = _ok(self.ws, "flow", "--lint")
        self.assertEqual(out["lint_codes"], {"LINT_OBTAIN_UNGROUNDED": ["F-002"]})
        self.assertEqual(out["lint"], 1)
        self.assertEqual(out["lint_path"], "checks/flow.lint.json")
        self.assertEqual(lint_ids(self.ws, "flow.lint.json"), ["LINT-OBTAIN-UNGROUNDED-F-002"])

    def test_出典を付けるかmay_failにすれば消える(self):
        self._always_delete(obtain_source={"decision": "D-004"})
        self.assertEqual(_ok(self.ws, "flow", "--lint")["lint"], 0)
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "obtain": "may_fail", "obtain_source": None, "on_fail": {"as": "削除できない", "source": {"input": "削除する"}}}]})
        self.assertEqual(_ok(self.ws, "flow", "--lint")["lint"], 0)

    def test_readの工程は見ない(self):
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "effect": "read"}]})
        self.assertEqual(_ok(self.ws, "flow", "--lint")["lint"], 0)

    def test_always以外の要素のobtain_sourceはputが拒否する(self):
        # may_fail に変えた要素に always の出典が残ると、根拠の無くなった出典が検証に届く。
        self._always_delete(obtain_source={"decision": "D-004"})
        before = (self.ws / "flow.json").read_bytes()
        r = _put_run(self.ws, "flow", {"elements": [{"id": "F-002", "obtain": "may_fail", "on_fail": {"as": "削除できない", "source": {"input": "削除する"}}}]})
        self.assertEqual(r.returncode, 1)
        self.assertIn("obtain_source", r.stderr)
        self.assertEqual((self.ws / "flow.json").read_bytes(), before)

    def test_出典の形と実在も見る(self):
        self._always_delete(obtain_source={"open": "O-001"})
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
        self._always_delete()
        sha = lambda ledger: _ok(self.ws, "sha", "--ledger", ledger)["sha256"]
        _put(self.ws, "verifications", {"items": [{"id": "F-002", "verdict": "pass", "reason": "r"}]},
             "--expect-resolutions", sha("resolutions"), "--expect-decisions", sha("decisions"))
        self.assertEqual(_ok(self.ws, "flow", "--lint")["lint"], 0)

    def test_lintの有無でflowの判断に使う欄とchecksは変わらない(self):
        self._always_delete()
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
    def test_書き込みの工程のmay_failを既定値のalwaysに戻すと共有の検査は通りlintだけがすべて拾う(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "input.md").write_text("x\n")
            writes = set()
            for name, src in (("flow", "flow-final.json"), ("decisions", "decisions.json"), ("open", "open.json"), ("resolutions", "resolutions-final.json")):
                body = json.loads((TRIAL / src).read_text(encoding="utf-8"))
                if name == "flow":
                    for el in body["elements"]:
                        if el["type"] == "step" and el.get("effect") != "read":
                            if el.get("obtain") == "may_fail" and "on_fail" not in el:
                                el["obtain"] = "always"
                            if el.get("obtain") == "always":
                                writes.add(el["id"])
                (ws / f"{name}.json").write_text(canonical(body))
            self.assertGreaterEqual(len(writes), 3)
            out = _ok(ws, "flow", "--lint")
            self.assertEqual(out["findings"], 0, "共有の検査は always に戻した版を拾わない")
            self.assertEqual(set(out["lint_codes"]), {"LINT_OBTAIN_UNGROUNDED"})
            self.assertEqual(sorted(out["lint_codes"]["LINT_OBTAIN_UNGROUNDED"]), sorted(writes))

    def test_判定表を指す項目の表の前に次の項目の節を差し込むとその項目だけを拾い_元の版は拾わない(self):
        fixed = (TRIAL / "requirements-cleanup-branches.md").read_text(encoding="utf-8")
        heads = [(m.start(), m.group(1)) for m in re.finditer(r"^#### (PR-[A-Z]+-\d+) ", fixed, re.M)]
        # 本文が「次の判定表」と指し、表を自分の節に持つ最初の項目と、その直後の項目。
        k = next(i for i, (at, _) in enumerate(heads[:-1]) if "次の判定表" in fixed[at:heads[i + 1][0]] and "\n| " in fixed[at:heads[i + 1][0]])
        (at, item), (nxt, _) = heads[k], heads[k + 1]
        end = heads[k + 2][0] if k + 2 < len(heads) else fixed.index("\n#", nxt + 1) + 1
        moved, rest = fixed[nxt:end], fixed[:nxt] + fixed[end:]
        para_end = rest.index("\n\n", rest.index("\n\n", at) + 2) + 2
        broken = rest[:para_end] + moved + "\n" + rest[para_end:]
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "requirements-cleanup-branches.md").write_text(fixed)
            self.assertEqual(_ok(ws, "doc", "--lint")["lint"], 0)
            (ws / "requirements-cleanup-branches.md").write_text(broken)
            plain = _ok(ws, "doc")
            out = _ok(ws, "doc", "--lint")
            self.assertEqual(out["lint_codes"], {"LINT_TABLE_ELSEWHERE": [item]})
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
        phrases = {"下表に従わ": True, "次に示す表に従わ": True, "以下の判定表に従わ": True, "以下の状態遷移表に従わ": True, "下記の表に従わ": True, "次の表に従わ": True,
                   "次の表示に従わ": False, "以下の表現に従わ": False, "以下の内容を公表し": False, "以下の代表例に従わ": False, "以下の発表に従わ": False, "以下の図表に従わ": False}
        body = "".join(f"\n#### PR-AUTH-{100 + i} 項目\n\nシステムは、{p}なければならない。\n" for i, p in enumerate(phrases))
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

    def test_unstashは段のtokenの控えを先に取りrestoreは段の入口の版に戻す(self):
        # 段の最初の書き込みが lint の差し戻しの中でも、再実行の入口の restore は段の入口の版に戻る（unstash の版で控えを上書きしない）。
        entry_flow, entry_open = (self.ws / "flow.json").read_bytes(), (self.ws / "open.json").read_bytes()
        _ok(self.ws, "stash", "--save", "flow-framer-lint")
        _ok(self.ws, "unstash", "--against", "flow-framer-lint", "--token", "t2")
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "label": "後で書いた版"}]}, "--token", "t2")
        out = _ok(self.ws, "restore", "--token", "t2")
        self.assertEqual(out["pruned_by"], [])
        self.assertEqual(((self.ws / "flow.json").read_bytes(), (self.ws / "open.json").read_bytes()), (entry_flow, entry_open))
        self.assertEqual(sorted(f["path"] for f in out["files"]), ["flow.json", "open.json"])

    def test_unstashは後のtokenの控えがあれば何も書かない(self):
        _ok(self.ws, "stash", "--save", "flow-framer-lint")
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "label": "後の段の版"}]}, "--token", "t3")
        before = (self.ws / "flow.json").read_bytes()
        r = subprocess.run(["node", str(DOC_CHECK), "unstash", "--against", "flow-framer-lint", "--token", "t2", "--workspace", str(self.ws)], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual((self.ws / "flow.json").read_bytes(), before)

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
