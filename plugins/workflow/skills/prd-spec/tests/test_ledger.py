"""scripts/doc_check.mjs の台帳 CLI（put / del / questions）と、台帳の正規形の検査のテスト。

1. 同じ入力の put・del を繰り返しても、2 回目は何も変えず、ファイルを書き直しもしない
2. put 以外で書かれた（正規形でない）台帳は、flow・conflicts・doc・put のどれでも止まる。meta は文書を読む
   snapshot・diff・tree-digest・index でも止まる（文書の読み手が meta を正規形の検査つきで読むため）
3. 依頼文・回答・証拠のファイルに逐語で無い引用を含む put は、何も書かずに止まる
4. meta の trace は item_id 単位で置き換わり、他の項目の trace は変わらない
5. verifications の sha256 は put の時点のファイルから取り、検証を始めた版と違えば書かない
6. questions は resolutions.json から問いを導出し、同じ台帳からは同じバイト列になる
"""

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
DOC_CHECK = SKILL / "scripts" / "doc_check.mjs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "workspace"


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
        bad = {"resolutions": [{"id": "RS-001", "answer": {"path": "answers/g0.md", "quote": "メールで"}}]}
        self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin=bad)
        self._unchanged_after("requirements-auth.meta.json", "put", "--ledger", "meta", "--doc", "requirements/auth",
                              stdin={"trace": [{"item_id": "PR-AUTH-001", "kind": "answers", "quote": "メールで"}]})
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "answer": {"path": "answers/g0.md", "quote": "画面に出して"}}]})

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
    """put は同じキーの要素に、送った最上位の欄だけを上書きする。欄を消すのは null だけで、送らない欄は残る。"""

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

    def test_送らない欄は古い値が残り_nullを送れば消える(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [RESOLUTION_Q]})
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "hold"}]})
        self.assertIn("options", self._res()[0], "送らなかった options は残る（消したつもりでも消えない）")
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "question": None, "options": None}]})
        r = self._res()[0]
        self.assertNotIn("options", r)
        self.assertNotIn("question", r)
        self.assertEqual(r["ruling"], "hold")

    def test_引用を持つ欄もnullで消せる(self):
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g0.md").write_text("RS-001: 画面\n")
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "answer": {"path": "answers/g0.md", "quote": "RS-001: 画面"}}]})
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "answer": None, "evidence": None}]})
        self.assertNotIn("answer", self._res()[0])
        _ok(self.ws, "put", "--ledger", "decisions", stdin={"decisions": [{"id": "D-001", "quote": None}]})

    def test_再検証で合格にしてもfail_kindはnullを送るまで残る(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "ruling": "internal"}]})
        args = ("--ledger", "verifications", "--expect-resolutions", _sha(self.ws / "resolutions.json"), "--expect-decisions", _sha(self.ws / "decisions.json"))
        _ok(self.ws, "put", *args, stdin={"items": [{"id": "RS-001", "verdict": "fail", "fail_kind": "mapping", "reason": "r"}]})
        _ok(self.ws, "put", *args, stdin={"items": [{"id": "RS-001", "verdict": "pass", "reason": "r2"}]})
        item = json.loads((self.ws / "verifications.json").read_text())["items"][0]
        self.assertEqual((item["verdict"], item["fail_kind"]), ("pass", "mapping"))
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

    def test_問いの無い_ID_は止まる(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-009", "ruling": "internal"}]})
        self.assertEqual(_run(self.ws, "questions", "--ids", "RS-009").returncode, 1)
        self.assertEqual(_run(self.ws, "questions", "--ids", "RS-404").returncode, 1)


if __name__ == "__main__":
    unittest.main()
