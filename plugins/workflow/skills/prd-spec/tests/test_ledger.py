"""scripts/doc_check.mjs の台帳 CLI（put / del / questions）と、台帳の正規形の検査のテスト。

1. 同じ入力の put・del を繰り返しても、2 回目は何も変えず、ファイルを書き直しもしない
2. put 以外で書かれた（正規形でない）台帳は、flow・conflicts・doc・put のどれでも止まる。meta は文書を読む
   snapshot・diff・tree-digest・index でも止まる（文書の読み手が meta を正規形の検査つきで読むため）
3. 依頼文・回答・証拠のファイルに逐語で無い引用を含む put は、何も書かずに止まる
4. meta の trace は item_id 単位で置き換わり、他の項目の trace は変わらない
5. verifications の sha256 は put の時点のファイルから取り、検証を始めた版と違えば書かない
6. questions は resolutions.json から問いを導出し、同じ台帳からは同じバイト列になる。--check は検査だけで何も書かない
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
DOC_CHECK = SKILL / "scripts" / "doc_check.mjs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "workspace"
CONTRACTS = SKILL / "schemas" / "agent-contracts.md"


def _exported(expr):
    """doc_check.mjs が export する定数を JSON で取り出す（数値や欄の一覧をテストに写さないため）。"""
    code = f"import * as m from {json.dumps(DOC_CHECK.as_uri())}; console.log(JSON.stringify({expr}))"
    r = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def _run(ws, mode, *args, stdin=None):
    return subprocess.run(
        ["node", str(DOC_CHECK), mode, *args, "--workspace", str(ws)],
        input=None if stdin is None else json.dumps(stdin, ensure_ascii=False),
        capture_output=True,
        text=True,
    )


def _ok(ws, mode, *args, stdin=None):
    r = _run(ws, mode, *args, stdin=stdin)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def _stamp(p):
    st = Path(p).stat()
    return st.st_ino, st.st_mtime_ns


def _reorder(value):
    if isinstance(value, dict):
        return {k: _reorder(value[k]) for k in sorted(value, reverse=True)}
    if isinstance(value, list):
        return [_reorder(v) for v in value]
    return value


RESOLUTION_Q = {
    "id": "RS-001",
    "about": {"open": "O-001"},
    "ruling": "question",
    "question": {"header": "結果の返し方", "text": "結果をどう返しますか", "searched": "依頼文に返し方の記述が無い"},
    "options": [
        {"label": "画面", "description": "画面に出す", "flow_effect": "F-003 が画面表示になる", "decision_text": "結果は画面に出す"},
        {"label": "メール", "description": "メールで送る", "flow_effect": "F-003 がメール送信になる", "decision_text": "結果はメールで送る"},
    ],
}


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class _Workspace(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name) / "W"
        shutil.copytree(FIXTURE, self.ws)

    def tearDown(self):
        self._tmp.cleanup()

    def _unchanged_after(self, name, mode, *args, stdin=None):
        p = self.ws / name
        before = p.read_bytes() if p.exists() else None
        r = _run(self.ws, mode, *args, stdin=stdin)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(p.read_bytes() if p.exists() else None, before)
        return r


class Idempotent(_Workspace):
    def test_同じ入力の_put_は_2_回目に何も変えない(self):
        body = {"decisions": [{"id": "D-004", "value": "結果は画面に出す", "source": "input", "quote": "結果を返す"}]}
        first = _ok(self.ws, "put", "--ledger", "decisions", stdin=body)
        self.assertEqual(first["added"], ["D-004"])
        after_first = (self.ws / "decisions.json").read_bytes()
        second = _ok(self.ws, "put", "--ledger", "decisions", stdin=body)
        self.assertEqual((second["added"], second["replaced"], second["unchanged"]), ([], [], ["D-004"]))
        self.assertEqual((self.ws / "decisions.json").read_bytes(), after_first)
        self.assertEqual(second["sha256"], _sha(self.ws / "decisions.json"))

    def test_変更の無い_put_と_del_はファイルを書き直さない(self):
        p = self.ws / "decisions.json"
        stamp = _stamp(p)
        el = json.loads(p.read_text())["decisions"][0]
        self.assertEqual(_ok(self.ws, "put", "--ledger", "decisions", stdin={"decisions": [el]})["unchanged"], ["D-001"])
        self.assertEqual(_ok(self.ws, "del", "--ledger", "decisions", "--ids", "D-404")["unchanged"], ["D-404"])
        self.assertEqual(_stamp(p), stamp)

    def test_台帳ファイルが無い_del_は何も作らない(self):
        out = _ok(self.ws, "del", "--ledger", "routes", "--ids", "RT-001")
        empty = hashlib.sha256(b'{\n "routes": []\n}\n').hexdigest()
        self.assertEqual((out["removed"], out["unchanged"], out["sha256"]), ([], ["RT-001"], empty))
        self.assertFalse((self.ws / "routes.json").exists())

    def test_同じ_ID_の_put_はその位置で置き換える(self):
        out = _ok(self.ws, "put", "--ledger", "decisions", stdin={"decisions": [{"id": "D-001", "value": "承認は人間が 2 人で行う"}]})
        self.assertEqual((out["added"], out["replaced"], out["count"]), ([], ["D-001"], {"decisions": 3}))
        ids = [d["id"] for d in json.loads((self.ws / "decisions.json").read_text())["decisions"]]
        self.assertEqual(ids, ["D-001", "D-002", "D-003"])

    def test_同じ入力の_del_は_2_回目に何も変えない(self):
        first = _ok(self.ws, "del", "--ledger", "decisions", "--ids", "D-002,D-404")
        self.assertEqual((first["removed"], first["unchanged"]), (["D-002"], ["D-404"]))
        after_first = (self.ws / "decisions.json").read_bytes()
        second = _ok(self.ws, "del", "--ledger", "decisions", "--ids", "D-002,D-404")
        self.assertEqual((second["removed"], second["unchanged"]), ([], ["D-002", "D-404"]))
        self.assertEqual((self.ws / "decisions.json").read_bytes(), after_first)

    def test_配列が複数ある台帳の_del_は_collection_が要る(self):
        self._unchanged_after("flow.json", "del", "--ledger", "flow", "--ids", "F-003")
        out = _ok(self.ws, "del", "--ledger", "flow", "--ids", "F-003", "--collection", "elements")
        self.assertEqual(out["removed"], ["F-003"])

    def test_書き込みの一時ファイルは残らない(self):
        _ok(self.ws, "put", "--ledger", "open", stdin={"open": [{"id": "O-002", "text": "通知の宛先"}]})
        self.assertEqual([p.name for p in self.ws.iterdir() if p.name.endswith(".tmp")], [])


class Canonical(_Workspace):
    MODES = (("flow",), ("conflicts",), ("doc",))

    def _variants(self, name):
        value = json.loads((self.ws / name).read_text())
        self.assertEqual((self.ws / name).read_text(), json.dumps(value, ensure_ascii=False, indent=1) + "\n")
        return {
            "キーの順": json.dumps(_reorder(value), ensure_ascii=False, indent=1) + "\n",
            "空白": json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        }

    def _assert_all_stop(self, name, modes):
        for label, text in self._variants(name).items():
            (self.ws / name).write_text(text)
            for mode in modes:
                with self.subTest(file=name, variant=label, mode=mode[0]):
                    r = self._unchanged_after(name, *mode, stdin={} if mode[0] == "put" else None)
                    self.assertIn(name, r.stderr)

    def test_正規形でない_flow_は全モードで止まる(self):
        self._assert_all_stop("flow.json", self.MODES + (("put", "--ledger", "flow"),))

    def test_正規形でない_decisions_は_conflicts_と_put_で止まる(self):
        self._assert_all_stop("decisions.json", (("conflicts",), ("flow",), ("put", "--ledger", "decisions")))

    def test_正規形でない_meta_は_doc_と_put_で止まる(self):
        self._assert_all_stop("requirements-auth.meta.json", (("doc",), ("put", "--ledger", "meta", "--doc", "requirements/auth")))

    def test_正規形でない_meta_は文書を読む全モードで止まる(self):
        digest = _ok(self.ws, "snapshot", "--save", "base")["digest"]
        modes = (("snapshot", "--save", "other"), ("diff", "--against", "base", "--expect", digest), ("tree-digest",), ("index",))
        self._assert_all_stop("requirements-auth.meta.json", modes)
        self.assertFalse((self.ws / "checks" / "other.snapshot.json").exists())

    def test_台帳の欄でない最上位のキーは止まる(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": []})
        self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin={"sha256": "x"})


class Verbatim(_Workspace):
    def test_input_md_に無い引用は何も書かない(self):
        cases = [
            ("decisions.json", ("--ledger", "decisions"), {"decisions": [{"id": "D-004", "quote": "依頼文に無い文"}]}),
            ("flow.json", ("--ledger", "flow"), {"elements": [{"id": "F-004", "source": {"input": "依頼文に無い文"}}]}),
            ("requirements-auth.meta.json", ("--ledger", "meta", "--doc", "requirements/auth"), {"trace": [{"item_id": "PR-AUTH-001", "kind": "input", "quote": "依頼文に無い文"}]}),
        ]
        for name, args, body in cases:
            with self.subTest(file=name):
                self._unchanged_after(name, "put", *args, stdin=body)

    def test_1_件でも落ちたら他の要素も書かない(self):
        body = {"decisions": [{"id": "D-004", "quote": "ログイン"}, {"id": "D-005", "quote": "依頼文に無い文"}]}
        self._unchanged_after("decisions.json", "put", "--ledger", "decisions", stdin=body)

    def test_回答に無い引用は拒否し_回答にあれば通す(self):
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g0.md").write_text("RS-001: 画面に出してください\n")
        bad = {"resolutions": [{**RESOLUTION_Q, "answer": {"path": "answers/g0.md", "quote": "メールで"}}]}
        r = self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin=bad)
        self.assertIn("逐語", r.stderr)
        self._unchanged_after("requirements-auth.meta.json", "put", "--ledger", "meta", "--doc", "requirements/auth",
                              stdin={"trace": [{"item_id": "PR-AUTH-001", "kind": "answers", "quote": "メールで"}]})
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "answer": {"path": "answers/g0.md", "quote": "画面に出して"}}]})

    def test_evidence_は行の範囲で照合する(self):
        src = Path(self._tmp.name) / "impl.py"
        src.write_text("def f():\n    return 1\n\nx = 2\n")

        def body(ev):
            return {"resolutions": [{"id": "RS-002", "ruling": "measured", "evidence": [ev]}]}

        for ev in (
            {"file": str(src), "line": 1, "quote": "return 1"},
            {"file": str(src), "line": 1, "end": 2, "quote": "x = 2"},
            {"file": "impl.py", "line": 1, "quote": "def f"},
            {"file": str(src), "line": 9, "quote": "def f"},
        ):
            with self.subTest(ev=ev):
                self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin=body(ev))
        _ok(self.ws, "put", "--ledger", "resolutions", stdin=body({"file": str(src), "line": 1, "end": 2, "quote": "def f():\n    return 1"}))

    def test_input_md_が無いか空なら_put_flow_conflicts_は止まる(self):
        for text in (None, " \n"):
            if text is None:
                (self.ws / "input.md").unlink()
            else:
                (self.ws / "input.md").write_text(text)
            for mode in (("put", "--ledger", "open"), ("flow",), ("conflicts",)):
                with self.subTest(input=text, mode=mode[0]):
                    r = _run(self.ws, *mode, stdin={} if mode[0] == "put" else None)
                    self.assertEqual(r.returncode, 1)
                    self.assertIn("input.md", r.stderr)


class Meta(_Workspace):
    def test_同じ_item_id_の_trace_だけを置き換える(self):
        p = self.ws / "requirements-auth.meta.json"
        before = json.loads(p.read_text())
        rows = [{"item_id": "PR-AUTH-002", "kind": "flow", "ref": "F-002"}, {"item_id": "PR-AUTH-002", "kind": "decision", "ref": "D-001"}]
        out = _ok(self.ws, "put", "--ledger", "meta", "--doc", "requirements/auth", stdin={"trace": rows})
        self.assertEqual(out["replaced"], ["PR-AUTH-002"])
        after = json.loads(p.read_text())
        self.assertEqual(after["trace"], [before["trace"][0], *rows, before["trace"][2]])
        self.assertEqual(after["tbd"], before["tbd"])

    def test_固定文書の_meta_を_fixed_だけで書ける(self):
        (self.ws / "requirements-base.md").write_text("# 基盤の要求\n\n#### PR-BASE-001 基盤\n\nシステムは起動しなければならない。\n")
        out = _ok(self.ws, "put", "--ledger", "meta", "--doc", "requirements/base", stdin={"fixed": True})
        self.assertEqual(out["added"], ["fixed"])
        self.assertTrue(json.loads((self.ws / "requirements-base.meta.json").read_text())["fixed"])
        body = _ok(self.ws, "doc")
        self.assertIn("digest", body)


class Verifications(_Workspace):
    def setUp(self):
        super().setUp()
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "internal"}]})
        self.res_sha = _sha(self.ws / "resolutions.json")
        self.dec_sha = _sha(self.ws / "decisions.json")

    def _args(self, res=None, dec=None):
        return ("--ledger", "verifications", "--expect-resolutions", res or self.res_sha, "--expect-decisions", dec or self.dec_sha)

    def test_sha256_は_put_の時点のファイルから取り入力の値は使わない(self):
        body = {"resolutions_sha256": "0" * 64, "items": [{"id": "RS-001", "verdict": "pass", "reason": "r"}]}
        out = _ok(self.ws, "put", *self._args(), stdin=body)
        written = json.loads((self.ws / "verifications.json").read_text())
        self.assertEqual((written["resolutions_sha256"], written["decisions_sha256"]), (self.res_sha, self.dec_sha))
        self.assertEqual((out["resolutions_sha256"], out["decisions_sha256"]), (self.res_sha, self.dec_sha))
        self.assertEqual(out["sha256"], _sha(self.ws / "verifications.json"))

    def test_検証を始めた版と違えば書かない(self):
        body = {"items": [{"id": "RS-001", "verdict": "pass", "reason": "r"}]}
        self._unchanged_after("verifications.json", "put", *self._args(res="f" * 64), stdin=body)
        self._unchanged_after("verifications.json", "put", *self._args(dec="f" * 64), stdin=body)
        self._unchanged_after("verifications.json", "put", "--ledger", "verifications", stdin=body)
        _ok(self.ws, "put", *self._args(), stdin=body)
        self._unchanged_after("verifications.json", "put", *self._args(res="f" * 64), stdin={"items": [{"id": "RS-001", "verdict": "fail", "reason": "r"}]})

    def test_flow_要素の項目には今の要素の_digest_が入る(self):
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "F-002", "verdict": "pass", "reason": "r", "digest": "x"}]})
        d1 = json.loads((self.ws / "verifications.json").read_text())["items"][0]["digest"]
        self.assertNotEqual(d1, "x")
        el = json.loads((self.ws / "flow.json").read_text())["elements"][1]
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{**el, "label": "承認（人間）"}]})
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "F-002", "verdict": "pass", "reason": "r"}]})
        self.assertNotEqual(json.loads((self.ws / "verifications.json").read_text())["items"][0]["digest"], d1)
        self._unchanged_after("verifications.json", "put", *self._args(), stdin={"items": [{"id": "F-404", "verdict": "pass", "reason": "r"}]})

    def test_今回検証していない_flow_要素の_digest_は検証した時点の値のまま(self):
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "F-002", "verdict": "pass", "reason": "r"}, {"id": "F-003", "verdict": "pass", "reason": "r"}]})
        d1 = json.loads((self.ws / "verifications.json").read_text())["items"][0]["digest"]
        el = json.loads((self.ws / "flow.json").read_text())["elements"][1]
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{**el, "label": "承認（人間）"}]})
        _ok(self.ws, "del", "--ledger", "flow", "--collection", "elements", "--ids", "F-003")
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "RS-001", "verdict": "pass", "reason": "r"}]})
        self.assertEqual(json.loads((self.ws / "verifications.json").read_text())["items"][0]["digest"], d1)


class FieldMerge(_Workspace):
    """put は同じキーの要素に、送った最上位の欄だけを上書きする。欄を消すのは null だけで、送らない欄は残る。
    型や ruling を変えて、その型に無い欄が残る put は、欄の条件で拒否される。"""

    def _res(self):
        return json.loads((self.ws / "resolutions.json").read_text())["resolutions"]

    def test_回答の反映で送らなかった欄は消えない(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g0.md").write_text("RS-001: 画面\n")
        out = _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [
            {"id": "RS-001", "value": "結果は画面に出す", "answer": {"path": "answers/g0.md", "quote": "RS-001: 画面"}}]})
        self.assertEqual(out["replaced"], ["RS-001"])
        [r] = self._res()
        for k in ("ruling", "about", "question", "options"):
            self.assertEqual(r[k], RESOLUTION_Q[k], k)
        self.assertEqual(r["value"], "結果は画面に出す")

    def test_rulingを変えて古い欄を送らなければ拒否し_nullを送れば通る(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        hold = {"rule": "返し方の裁定が下るまで、結果を返してはならない", "issue_draft": "返し方を決める", "item_ids": ["PR-AUTH-001"]}
        r = self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "hold", "hold": hold}]})
        self.assertIn("question・options", r.stderr)
        self.assertIn("null", r.stderr)
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "hold", "hold": hold, "question": None, "options": None}]})
        res = self._res()[0]
        self.assertNotIn("options", res)
        self.assertNotIn("question", res)
        self.assertEqual(res["ruling"], "hold")

    def test_引用を持つ欄もnullで消せる(self):
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g0.md").write_text("RS-001: 画面\n")
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "answer": {"path": "answers/g0.md", "quote": "RS-001: 画面"}}]})
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "answer": None, "evidence": None}]})
        self.assertNotIn("answer", self._res()[0])
        _ok(self.ws, "put", "--ledger", "decisions", stdin={"decisions": [{"id": "D-001", "quote": None}]})

    def test_再検証で合格にしてfail_kindを残すputは拒否し_nullを送れば通る(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "internal"}]})
        args = ("--ledger", "verifications", "--expect-resolutions", _sha(self.ws / "resolutions.json"), "--expect-decisions", _sha(self.ws / "decisions.json"))
        _ok(self.ws, "put", *args, stdin={"items": [{"id": "RS-001", "verdict": "fail", "fail_kind": "mapping", "reason": "r"}]})
        r = self._unchanged_after("verifications.json", "put", *args, stdin={"items": [{"id": "RS-001", "verdict": "pass", "reason": "r2"}]})
        self.assertIn("fail_kind", r.stderr)
        _ok(self.ws, "put", *args, stdin={"items": [{"id": "RS-001", "verdict": "pass", "fail_kind": None, "reason": "r2"}]})
        self.assertNotIn("fail_kind", json.loads((self.ws / "verifications.json").read_text())["items"][0])

    def test_新しい要素のnullの欄は書かれず_同じ入力の2回目は変えない(self):
        body = {"routes": [{"id": "RT-001", "unit": "U-1", "item_id": None}]}
        _ok(self.ws, "put", "--ledger", "routes", stdin=body)
        self.assertEqual(json.loads((self.ws / "routes.json").read_text())["routes"], [{"id": "RT-001", "unit": "U-1"}])
        before = (self.ws / "routes.json").read_bytes()
        self.assertEqual(_ok(self.ws, "put", "--ledger", "routes", stdin=body)["unchanged"], ["RT-001"])
        self.assertEqual((self.ws / "routes.json").read_bytes(), before)

    def test_スカラーもnullで消える(self):
        doc = ("--ledger", "meta", "--doc", "requirements/auth")
        _ok(self.ws, "put", *doc, stdin={"fixed": True})
        self.assertTrue(json.loads((self.ws / "requirements-auth.meta.json").read_text())["fixed"])
        self.assertEqual(_ok(self.ws, "put", *doc, stdin={"fixed": None})["removed"], ["fixed"])
        self.assertNotIn("fixed", json.loads((self.ws / "requirements-auth.meta.json").read_text()))

    def test_metaのtraceは同じitem_idの行の組を丸ごと置き換える(self):
        doc = ("--ledger", "meta", "--doc", "requirements/auth")
        trace = json.loads((self.ws / "requirements-auth.meta.json").read_text())["trace"]
        item = trace[0]["item_id"]
        _ok(self.ws, "put", *doc, stdin={"trace": [{"item_id": item, "kind": "premise", "ref": "前提 1"}]})
        rows = [t for t in json.loads((self.ws / "requirements-auth.meta.json").read_text())["trace"] if t["item_id"] == item]
        self.assertEqual(rows, [{"item_id": item, "kind": "premise", "ref": "前提 1"}])


class LedgerNotWrittenYet(_Workspace):
    """段 3 で open も組も 0 件だと resolver が起動せず、resolutions.json が無いまま verifier が動く。"""

    def test_無い台帳のshaは空の台帳の値で_verifierのputが通る(self):
        self.assertFalse((self.ws / "resolutions.json").exists())
        res = _ok(self.ws, "sha", "--ledger", "resolutions")
        dec = _ok(self.ws, "sha", "--ledger", "decisions")
        self.assertEqual(res["sha256"], hashlib.sha256(b'{\n "resolutions": []\n}\n').hexdigest())
        self.assertFalse(res["exists"])
        self.assertEqual(dec["sha256"], _sha(self.ws / "decisions.json"))
        args = ("--ledger", "verifications", "--expect-resolutions", res["sha256"], "--expect-decisions", dec["sha256"])
        out = _ok(self.ws, "put", *args, stdin={"items": [{"id": "D-001", "verdict": "pass", "reason": "r"}]})
        self.assertEqual(out["resolutions_sha256"], res["sha256"])
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "internal"}]})
        self.assertEqual(_run(self.ws, "put", *args, stdin={"items": [{"id": "D-001", "verdict": "pass", "reason": "r"}]}).returncode, 1)

    def test_あるファイルのshaはshasumと同じ(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "internal"}]})
        self.assertEqual(_ok(self.ws, "sha", "--ledger", "resolutions")["sha256"], _sha(self.ws / "resolutions.json"))


class Questions(_Workspace):
    def _derived(self):
        return (self.ws / "questions.md").read_bytes(), (self.ws / "questions.json").read_bytes()

    def test_同じ台帳からは同じバイト列になる(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        out = _ok(self.ws, "questions", "--ids", "RS-001")
        first = self._derived()
        _ok(self.ws, "questions", "--ids", "RS-001")
        self.assertEqual(self._derived(), first)
        self.assertEqual(out["questions"], 1)
        self.assertEqual(out["json"]["sha256"], _sha(self.ws / "questions.json"))
        q = json.loads(first[1])
        self.assertEqual(q, [{"id": "RS-001", "header": "結果の返し方", "question": "結果をどう返しますか",
                              "options": [{"label": "画面", "description": "画面に出す"}, {"label": "メール", "description": "メールで送る"}]}])
        self.assertIn("## RS-001", first[0].decode())
        self.assertIn("F-003 がメール送信になる", first[0].decode())

    def test_候補が_2_から_4_個でなければ何も書かない(self):
        opt = RESOLUTION_Q["options"][0]
        for n in (1, 5):
            with self.subTest(options=n):
                _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "options": [opt] * n}]})
                r = _run(self.ws, "questions", "--ids", "RS-001")
                self.assertEqual(r.returncode, 1)
                self.assertFalse((self.ws / "questions.json").exists())
                self.assertFalse((self.ws / "questions.md").exists())

    def test_検査に落ちたら前回の導出物をどちらも変えない(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        _ok(self.ws, "questions", "--ids", "RS-001")
        before = self._derived()
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "options": RESOLUTION_Q["options"][:1]}]})
        self.assertEqual(_run(self.ws, "questions", "--ids", "RS-001").returncode, 1)
        self.assertEqual(self._derived(), before)
        self.assertEqual([p.name for p in self.ws.iterdir() if p.name.endswith(".tmp")], [])

    def test_checkは形だけを検査して何も書かない(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        ok = _ok(self.ws, "questions", "--ids", "RS-001", "--check")
        self.assertEqual((ok["check"], ok["ids"], ok["questions"], ok["findings"]), (True, ["RS-001"], 1, 0))
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "options": RESOLUTION_Q["options"][:1]}]})
        r = _run(self.ws, "questions", "--ids", "RS-001", "--check")
        bad = json.loads(r.stdout)
        self.assertEqual((r.returncode, bad["questions"], bad["findings"], bad["bad_ids"]), (0, 0, 1, ["RS-001"]))
        self.assertIn("候補が 1 個", r.stderr)
        self.assertFalse((self.ws / "questions.json").exists())
        self.assertFalse((self.ws / "questions.md").exists())

    def test_問いの無い_ID_は止まる(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-009", "ruling": "internal"}]})
        self.assertEqual(_run(self.ws, "questions", "--ids", "RS-009").returncode, 1)
        self.assertEqual(_run(self.ws, "questions", "--ids", "RS-404").returncode, 1)


def _limit_body(path_key, text):
    """FIELD_LIMITS の鍵（<台帳>.<配列>.<欄> か <台帳>.<欄>）に text を入れた put の入力。"""
    parts = path_key.split(".")
    if len(parts) == 2:
        return parts[0], {parts[1]: text}
    ledger, lst, field = parts
    base = {
        ("decisions", "decisions"): {"id": "D-009"},
        ("open", "open"): {"id": "O-009"},
        ("resolutions", "resolutions"): {"id": "RS-009", "ruling": "internal"},
        ("verifications", "items"): {"id": "D-001", "verdict": "pass"},
        ("flow", "elements"): {"id": "F-001"},
        ("flow", "kinds"): {"name": "工程"},
    }[(ledger, lst)]
    return ledger, {lst: [{**base, field: text}]}


class FieldTypes(_Workspace):
    """put は型の外の欄・上限を超える欄・経緯の印を持つ欄を、何も書かずに拒否する。"""

    def _put(self, ledger, body):
        extra = ()
        if ledger == "verifications":
            extra = ("--expect-resolutions", _ok(self.ws, "sha", "--ledger", "resolutions")["sha256"],
                     "--expect-decisions", _ok(self.ws, "sha", "--ledger", "decisions")["sha256"])
        return ("--ledger", ledger, *extra), body

    def test_上限ちょうどは通り_1字超えると拒否する(self):
        for key, limit in _exported("m.FIELD_LIMITS").items():
            with self.subTest(field=key):
                ledger, over = _limit_body(key, "字" * (limit + 1))
                args, body = self._put(ledger, over)
                r = self._unchanged_after(f"{ledger}.json", "put", *args, stdin=body)
                self.assertIn(f"{limit} 字", r.stderr)
                ledger, fit = _limit_body(key, "字" * limit)
                _ok(self.ws, "put", *self._put(ledger, fit)[0], stdin=fit)

    def test_型の外の欄は拒否する(self):
        cases = [
            ("decisions.json", ("--ledger", "decisions"), {"decisions": [{"id": "D-001", "note": "経緯"}]}),
            ("flow.json", ("--ledger", "flow"), {"elements": [{"id": "F-001", "history": "前の行き先"}]}),
            ("open.json", ("--ledger", "open"), {"open": [{"id": "O-001", "memo": None}]}),
            ("requirements-auth.meta.json", ("--ledger", "meta", "--doc", "requirements/auth"), {"tbd": [{"id": "TBD-RAUTH-001", "status": "open"}]}),
        ]
        for name, args, body in cases:
            with self.subTest(file=name):
                r = self._unchanged_after(name, "put", *args, stdin=body)
                self.assertIn("欄ではありません", r.stderr)

    def test_経緯の印を持つ自由記述の欄は拒否する(self):
        el = {"id": "F-002"}
        cases = [
            ("flow", {"closure": "工程を列挙した。回答の反映（段 3a、RS-020）: F-029 を足した。"}),
            ("flow", {"closure": "G0-2 の回答で F-020 の枝を除いた"}),
            ("flow", {"elements": [{**el, "label": "承認（段 3a で足した）"}]}),
            ("flow", {"kinds": [{"name": "工程", "definition": "段 3a' で分けた処理"}]}),
            ("decisions", {"decisions": [{"id": "D-001", "why": "G0-2 の問いで決まった"}]}),
            ("resolutions", {"resolutions": [{"id": "RS-001", "ruling": "internal", "why": "r1-im-requirements__auth-002 への対応"}]}),
            ("resolutions", {"resolutions": [{"id": "RS-001", "ruling": "internal", "why": "続けるか止めるかは価値の判断で、段 3a では続きの問いを聞けない"}]}),
            ("resolutions", {"resolutions": [{"id": "RS-001", "ruling": "internal", "why": "段 9 で聞くゲートが残っていないため保持規則にした"}]}),
            ("resolutions", {"resolutions": [{"id": "RS-001", "ruling": "internal", "why": "O-011 は回答の反映で行き先が決まった"}]}),
        ]
        for ledger, body in cases:
            with self.subTest(body=body):
                r = self._unchanged_after(f"{ledger}.json", "put", "--ledger", ledger, stdin=body)
                self.assertIn("経緯の印", r.stderr)

    def test_分野の普通の語は経緯の印にしない(self):
        with (self.ws / "input.md").open("a") as f:
            f.write("\nコミット 3a9f0c1 を基準にする。\n")
        _ok(self.ws, "put", "--ledger", "flow", stdin={
            "closure": "新旧の設定を併存させる。旧版の設定は v2 への移行で消す。",
            "elements": [{"id": "F-002", "label": "API v2 への切替"}, {"id": "F-001", "source": {"input": "コミット 3a9f0c1 を基準にする"}}],
            "kinds": [{"name": "工程", "definition": "2 段階認証を含む入力の変換"}],
        })
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [
            {"id": "RS-001", "ruling": "internal", "why": "RS-232 の配線と、改稿前の版の手順書（第 3 版）の段組みに合わせる。G10 と 3ab の型番も同じ"},
            {"id": "RS-002", "ruling": "internal", "why": "G1 GC はレイテンシが安定しているため採用する"},
            {"id": "RS-003", "ruling": "internal", "why": "要求文書の § 3a に定める手順に従う"},
            {"id": "RS-004", "ruling": "internal", "why": "型番 3a と 3a' の筐体は同じ部品を使う"}]})
        _ok(self.ws, "flow")
        self.assertFalse(any("HISTORY" in i for i in json.loads((self.ws / "checks" / "flow.json").read_text())["findings"]))


class Cases(_Workspace):
    """欄の条件: 型や ruling ごとに持つ欄・持てない欄を宣言し、マージした後の要素で検査する。"""

    HOLD = {"rule": "返し方の裁定が下るまで、結果を返してはならない", "issue_draft": "返し方を決める", "item_ids": ["PR-AUTH-001"]}

    def _answer(self):
        (self.ws / "answers").mkdir(exist_ok=True)
        (self.ws / "answers" / "g0.md").write_text("RS-001: 画面\n")
        return {"path": "answers/g0.md", "quote": "RS-001: 画面"}

    def _rejected(self, body, *words):
        r = self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin=body)
        for w in words:
            self.assertIn(w, r.stderr)

    def test_questionからinternalに変えてoptionsを残すと拒否し_nullで通る(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        self._rejected({"resolutions": [{"id": "RS-001", "ruling": "internal", "value": "画面"}]}, "question・options", "null")
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "internal", "value": "画面", "question": None, "options": None}]})

    def test_回答の前のquestionはvalueを持てず_answerと一緒なら通る(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        self._rejected({"resolutions": [{"id": "RS-001", "value": "結果は画面に出す"}]}, "value")
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "value": "結果は画面に出す", "answer": self._answer()}]})

    def test_holdはvalueを持てずholdが要る(self):
        self._rejected({"resolutions": [{"id": "RS-002", "ruling": "hold", "hold": self.HOLD, "value": "画面"}]}, "value")
        self._rejected({"resolutions": [{"id": "RS-002", "ruling": "hold"}]}, "hold が要ります")
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-002", "ruling": "hold", "hold": self.HOLD}]})

    def test_answerはquestionだけが持てる(self):
        self._rejected({"resolutions": [{"id": "RS-003", "ruling": "internal", "answer": self._answer()}]}, "answer")
        self._rejected({"resolutions": [{"id": "RS-003", "answer": self._answer()}]}, "answer")

    def test_questionは問いと候補が要り_未知のrulingは拒否する(self):
        self._rejected({"resolutions": [{"id": "RS-004", "ruling": "question"}]}, "question・options が要ります")
        self._rejected({"resolutions": [{"id": "RS-004", "ruling": "questoin"}]}, "questoin")

    def test_decisionからstepに変えてbranchesを残すと拒否し_nullで通る(self):
        branches = [{"value": "可", "next": "F-003"}, {"value": "否", "next": "F-003"}]
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "decision", "branches": branches, "next": None}]})
        r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "step", "next": ["F-003"]}]})
        self.assertIn("branches", r.stderr)
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "step", "next": ["F-003"], "branches": None}]})

    def test_decisionはnextを持てない(self):
        r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "decision", "branches": []}]})
        self.assertIn("next", r.stderr)


def _json_after(text, marker):
    m = re.search(re.escape(marker) + r"[^\n]*\n\n```json\n(.*?)\n```", text, re.S)
    return json.loads(m.group(1))


class ContractExamplesUseLedgerFields(unittest.TestCase):
    """契約の JSON の例に出るキーが、すべて LEDGERS の欄の一覧にある（例と型の正本がずれない）。"""

    @unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
    def test_例のキーはLEDGERSの欄にある(self):
        ledgers = _exported("Object.fromEntries(Object.entries(m.LEDGERS).map(([k, v]) => [k, { lists: v.lists, scalars: Object.keys(v.scalars), fields: v.fields }]))")
        text = CONTRACTS.read_text(encoding="utf-8")
        flow_sec = text[text.index("\n## §flow-framer\n"):]
        examples = {
            "decisions": _json_after(text, "**decisions.json**"),
            "resolutions": _json_after(text, "**resolutions.json**"),
            "verifications": _json_after(text, "**verifications.json**"),
            "open": json.loads(re.search(r"\*\*open\.json\*\*\n\n```json\n(.*?)\n```", text, re.S).group(1)),
            "routes": _json_after(text, "**routes.json**"),
            "meta": _json_after(text, "**meta.json**"),
            "flow": json.loads(re.search(r"```json\n(.*?)\n```", flow_sec, re.S).group(1)),
        }
        self.assertEqual(set(examples), set(ledgers))
        for name, ex in examples.items():
            spec = ledgers[name]
            self.assertEqual(set(ex) - set(spec["lists"]) - set(spec["scalars"]), set(), name)
            for lst in spec["lists"]:
                for el in ex.get(lst, []):
                    with self.subTest(ledger=name, list=lst, el=el.get(spec["lists"][lst])):
                        self.assertEqual(set(el) - set(spec["fields"][lst]), set())


def _drop_privileges():
    os.setgid(65534)
    os.setuid(65534)


class AtomicWrite(_Workspace):
    """書き込みか rename の途中で落ちても、元のファイルは変わらず、一時名のファイルも残らない。"""

    def _read_only_run(self, *args, stdin=None):
        """W に書けない利用者として実行する。root は読み取り専用のディレクトリにも書けるので、権限を落とす。"""
        if os.geteuid() == 0:
            for p in [Path(self._tmp.name), *Path(self._tmp.name).rglob("*")]:
                p.chmod(0o755 if p.is_dir() else 0o644)
            kw = {"preexec_fn": _drop_privileges}
        else:
            self.ws.chmod(0o555)
            self.addCleanup(self.ws.chmod, 0o755)
            kw = {}
        return subprocess.run(["node", str(DOC_CHECK), *args, "--workspace", str(self.ws)],
                              input=None if stdin is None else json.dumps(stdin, ensure_ascii=False), capture_output=True, text=True, **kw)

    def _tmps(self):
        return [p.name for p in self.ws.rglob("*.tmp")]

    def test_書き込みで落ちたputは台帳を変えず一時名も残さない(self):
        before = (self.ws / "decisions.json").read_bytes()
        r = self._read_only_run("put", "--ledger", "decisions", stdin={"decisions": [{"id": "D-001", "value": "承認は 2 人で行う"}]})
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("EACCES", r.stderr)
        self.assertEqual((self.ws / "decisions.json").read_bytes(), before)
        self.assertEqual(self._tmps(), [])

    def test_書き込みで落ちたquestionsは2ファイルとも変えない(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        _ok(self.ws, "questions", "--ids", "RS-001")
        before = [(self.ws / n).read_bytes() for n in ("questions.md", "questions.json")]
        (self.ws / "questions.md").write_text("手で直した")
        before[0] = (self.ws / "questions.md").read_bytes()
        r = self._read_only_run("questions", "--ids", "RS-001")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("EACCES", r.stderr)
        self.assertEqual([(self.ws / n).read_bytes() for n in ("questions.md", "questions.json")], before)
        self.assertEqual(self._tmps(), [])

    def _write_atomic(self, *pairs):
        code = (f"import {{ writeAtomic }} from {json.dumps(DOC_CHECK.as_uri())};"
                f"try {{ writeAtomic(...{json.dumps([[str(f), t] for f, t in pairs])}); process.exit(0) }} catch (e) {{ console.error(e.code); process.exit(7) }}")
        return subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True)

    def test_2本目の一時名の書き込みで落ちたら1本目の一時名も消す(self):
        first = self.ws / "decisions.json"
        before = first.read_bytes()
        r = self._write_atomic((first, "x"), (self.ws / "missing" / "questions.json", "y"))
        self.assertEqual(r.returncode, 7, r.stderr)
        self.assertIn("ENOENT", r.stderr)
        self.assertEqual(first.read_bytes(), before)
        self.assertEqual(self._tmps(), [])

    def test_renameで落ちたら元は変わらず一時名も残らない(self):
        target = self.ws / "decisions.json"
        blocker = self.ws / "routes.json"
        blocker.mkdir()
        before = target.read_bytes()
        code = (f"import {{ writeAtomic }} from {json.dumps(DOC_CHECK.as_uri())};"
                f"try {{ writeAtomic([{json.dumps(str(blocker))}, 'x'], [{json.dumps(str(target))}, 'y']); process.exit(0) }} catch {{ process.exit(7) }}")
        r = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True)
        self.assertEqual(r.returncode, 7, r.stderr)
        self.assertTrue(blocker.is_dir())
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(self._tmps(), [])

    def test_renameで落ちたquestionsは2ファイルとも変えない(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        (self.ws / "questions.md").mkdir()
        (self.ws / "questions.json").write_text("前の導出物")
        r = _run(self.ws, "questions", "--ids", "RS-001")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertTrue((self.ws / "questions.md").is_dir())
        self.assertEqual((self.ws / "questions.json").read_text(), "前の導出物")
        self.assertEqual(self._tmps(), [])


if __name__ == "__main__":
    unittest.main()
