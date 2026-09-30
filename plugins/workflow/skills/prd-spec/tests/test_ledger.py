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
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_doc_check_workspace import stdout_body  # noqa: E402

SKILL = Path(__file__).resolve().parents[1]
DOC_CHECK = SKILL / "scripts" / "doc_check.mjs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "workspace"
CONTRACTS = SKILL / "schemas" / "agent-contracts.md"


def _exported(expr):
    """doc_check.mjs が export する定数を JSON で取り出す（数値や欄の一覧をテストに写さないため）。"""
    code = f"import * as m from {json.dumps(DOC_CHECK.as_uri())}; console.log(JSON.stringify({expr}))"
    r = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


# TOKEN: 台帳を書くモードに付ける段の token（put・del は token なしを拒否する）。
TOKEN = "t1"
WRITES = ("put", "del")


def _run(ws, mode, *args, stdin=None):
    tx = ("--token", TOKEN) if mode in WRITES and "--token" not in args else ()
    return subprocess.run(
        ["node", str(DOC_CHECK), mode, *args, *tx, "--workspace", str(ws)],
        input=None if stdin is None else json.dumps(stdin, ensure_ascii=False),
        capture_output=True,
        text=True,
    )


def _ok(ws, mode, *args, stdin=None):
    r = _run(ws, mode, *args, stdin=stdin)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return stdout_body(r.stdout)


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def _stamp(p):
    st = Path(p).stat()
    return st.st_ino, st.st_mtime_ns


def _append_invariant_source(ws):
    with (ws / "input.md").open("a") as f:
        f.write("\n未コミットの作業を失ってはならない。\n")


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


class StageTransaction(_Workspace):
    """段の token の下の put・del は、restore で段に入った時点の台帳へ戻せる（blocked の後の同じ段の再実行の入口）。"""

    def _files(self):
        return {str(p.relative_to(self.ws)): p.read_bytes() for p in sorted(self.ws.rglob("*")) if p.is_file() and not str(p.relative_to(self.ws)).startswith("tx/")}

    def _write_stage(self, token):
        tx = ("--token", token)
        _ok(self.ws, "put", "--ledger", "decisions", *tx, stdin={"decisions": [{"id": "D-003", "value": "英語で書く"}]})
        _ok(self.ws, "put", "--ledger", "decisions", *tx, stdin={"decisions": [{"id": "D-003", "value": "英語と日本語で書く"}]})
        _ok(self.ws, "put", "--ledger", "open", *tx, stdin={"open": [{"id": "O-002", "text": "通知の宛先"}]})
        _ok(self.ws, "del", "--ledger", "flow", "--ids", "F-005", "--collection", "elements", *tx)
        _ok(self.ws, "put", "--ledger", "resolutions", *tx, stdin={"resolutions": [{"id": "RS-001", "about": {"open": "O-001"}, "ruling": "internal", "value": "v", "why": "w"}]})
        _ok(self.ws, "put", "--ledger", "routes", *tx, stdin={"routes": [{"id": "RT-001", "unit": "U-1", "resolutions": ["RS-001"]}]})
        _ok(self.ws, "put", "--ledger", "meta", "--doc", "requirements/auth", *tx, stdin={"fixed": True})
        shas = [_ok(self.ws, "sha", "--ledger", x)["sha256"] for x in ("resolutions", "decisions")]
        _ok(self.ws, "put", "--ledger", "verifications", "--expect-resolutions", shas[0], "--expect-decisions", shas[1], *tx, stdin={"items": [{"id": "RS-001", "verdict": "pass"}]})

    def test_tokenの無いputとdelは何も書かずに止まる(self):
        before = self._files()
        for mode in (("put", "--ledger", "decisions"), ("del", "--ledger", "decisions", "--ids", "D-003")):
            with self.subTest(mode=mode[0]):
                r = subprocess.run(["node", str(DOC_CHECK), *mode, "--workspace", str(self.ws)], input=json.dumps({"decisions": [{"id": "D-003", "value": "x"}]}),
                                   capture_output=True, text=True)
                self.assertEqual(r.returncode, 1, r.stderr)
                self.assertIn("--token", r.stderr)
        for bad in ("../x", "t.1", "", "x1", "t1x", "r1"):
            with self.subTest(token=bad):
                r = _run(self.ws, "put", "--ledger", "decisions", "--token", bad, stdin={"decisions": [{"id": "D-003", "value": "x"}]})
                self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(self._files(), before)
        self.assertFalse((self.ws / "tx").exists())

    def test_restoreはtokenの下の台帳の書き込みだけを段に入った時点へ戻す(self):
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g0.md").write_text("RS-001: 画面\n")
        _ok(self.ws, "snapshot", "--save", "audited-1", "--role", "auditor")
        before = self._files()
        self._write_stage("t3")
        (self.ws / "answers" / "g0.md").write_text("RS-001: メール\n")
        doc = self.ws / "requirements-auth.md"
        doc.write_text(doc.read_text() + "\n追記\n")
        _ok(self.ws, "snapshot", "--save", "audited-2", "--role", "auditor")
        untouched = {k: v for k, v in self._files().items() if k.startswith(("answers/", "checks/audited-", "requirements-auth.md"))}
        self.assertEqual(_ok(self.ws, "snapshot", "--save", "w")["stray"]["count"], 0, "控えは所有表の tx/<token>/* に当たる")
        out = _ok(self.ws, "restore", "--token", "t3")
        self.assertEqual(out["token"], "t3")
        created = {"resolutions.json", "routes.json", "verifications.json"}
        self.assertEqual({f["path"] for f in out["files"]}, {"decisions.json", "open.json", "flow.json", "requirements-auth.meta.json"} | created)
        for f in out["files"]:
            self.assertEqual(f["after"], hashlib.sha256(before[f["path"]]).hexdigest() if f["path"] in before else None, f["path"])
            self.assertNotEqual(f["before"], f["after"], f["path"])
        self.assertNotEqual(out["flow_before"], out["flow_after"])
        after = self._files()
        ledgers = {k for k in before if k.endswith(".json") and not k.startswith(("checks/", "plan.json"))}
        self.assertEqual({k: after.get(k) for k in ledgers}, {k: before[k] for k in ledgers}, "台帳は段に入った時点のバイト列に戻る")
        self.assertFalse(created & set(after), "token の下で作られた台帳は消える")
        self.assertEqual({k: after[k] for k in untouched}, untouched, "answers・文書・監査の snapshot は戻さない")
        self.assertEqual(after["plan.json"], before["plan.json"])
        again = _ok(self.ws, "restore", "--token", "t3")
        self.assertEqual((again["restored"], again["files"]), (0, []))
        self.assertEqual(self._files(), after, "2 回目の restore は何も変えない")

    def test_backupで控えを取った文書の本文はrestoreが段に入った時点へ戻す(self):
        # writer は本文を Edit で書き doc_check を通らないので、writer の起動の前に backup で控えを取る。無い文書は restore が消す。
        doc = self.ws / "requirements-auth.md"
        before = doc.read_bytes()
        out = _ok(self.ws, "backup", "--doc", "requirements/new", "--doc", "requirements/auth", "--token", "t4")
        self.assertEqual(out, {"backup": True, "token": "t4", "docs": ["requirements/auth", "requirements/new"]})
        doc.write_text(doc.read_text() + "\n途中まで直した\n")
        (self.ws / "requirements-new.md").write_text("# 途中の草稿\n")
        _ok(self.ws, "put", "--ledger", "meta", "--doc", "requirements/new", "--token", "t4", stdin={"fixed": False})
        self.assertEqual(_ok(self.ws, "backup", "--doc", "requirements/auth", "--token", "t4")["docs"], ["requirements/auth"])
        stray = json.loads((self.ws / _ok(self.ws, "snapshot", "--save", "w")["stray"]["path"]).read_text())["stray"]
        self.assertFalse([x for x in stray if x.startswith("tx/")], "本文の控えも所有表の tx/<token>/* に当たる")
        restored = _ok(self.ws, "restore", "--token", "t4")
        self.assertEqual({f["path"] for f in restored["files"]}, {"requirements-auth.md", "requirements-new.md", "requirements-new.meta.json"})
        self.assertEqual(doc.read_bytes(), before, "同じ token の 2 回目の backup は控えを取り直さない")
        self.assertFalse((self.ws / "requirements-new.md").exists())
        for bad in (("--doc", "notes/x", "--token", "t5"), ("--token", "t5"), ("--doc", "requirements/auth")):
            with self.subTest(bad=bad):
                self.assertEqual(_run(self.ws, "backup", *bad).returncode, 1)

    def test_新しいtokenの最初の書き込みは前のtokenの控えを消し済んだ段より前へ戻さない(self):
        self._write_stage("t1")
        mid = self._files()
        _ok(self.ws, "put", "--ledger", "open", "--token", "t2", stdin={"open": [{"id": "O-003", "text": "通知の頻度"}]})
        self.assertEqual(sorted(p.name for p in (self.ws / "tx").iterdir()), ["t2"])
        stale = _ok(self.ws, "restore", "--token", "t1")
        self.assertEqual((stale["restored"], stale["pruned_by"]), (0, ["t2"]), "戻す控えを後の段が消したことを、何も戻さずに知らせる")
        _ok(self.ws, "restore", "--token", "t2")
        self.assertEqual(self._files(), mid, "t2 の restore は t1 の段を出た時点までしか戻さない")

    def test_再実行が別のtokenで書いた後に同じrestoreを流し直しても何も戻さない(self):
        # resumeFromRunId の再生が入口の restore を実行し直す場合。再実行は戻す token（t3）と別の token（t3r1）で書く。
        self._write_stage("t3")
        _ok(self.ws, "restore", "--token", "t3")
        _ok(self.ws, "put", "--ledger", "decisions", "--token", "t3r1", stdin={"decisions": [{"id": "D-004", "value": "日本語で書く"}]})
        _ok(self.ws, "put", "--ledger", "routes", "--token", "t3r1", stdin={"routes": [{"id": "RT-002", "unit": "U-1"}]})
        written = self._files()
        replay = _ok(self.ws, "restore", "--token", "t3")
        self.assertEqual((replay["files"], replay["pruned_by"]), ([], []), "同じ段の後の token は再実行自身の書き込みで、控えを失った印ではない")
        self.assertEqual(self._files(), written, "再実行の書き込みは戻らない")

    def test_後のtokenの控えがあれば前のtokenの書き込みは何も書かずに止まる(self):
        # 止まった run の遅れた書き込み（zombie）が今の段の控えを消すと、再実行の restore が何も戻さずに成功する。
        before = self._files()
        self._write_stage("t3r1")
        written = self._files()
        for old in ("t3", "t2", "t2r5"):
            with self.subTest(token=old):
                r = _run(self.ws, "put", "--ledger", "decisions", "--token", old, stdin={"decisions": [{"id": "D-003", "value": "遅れた書き込み"}]})
                self.assertEqual(r.returncode, 1, r.stderr)
                self.assertIn("t3r1", r.stderr)
                r = _run(self.ws, "del", "--ledger", "decisions", "--ids", "D-003", "--token", old)
                self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(self._files(), written)
        self.assertEqual(sorted(p.name for p in (self.ws / "tx").iterdir()), ["t3r1"])
        _ok(self.ws, "restore", "--token", "t3r1")
        self.assertEqual({k: v for k, v in self._files().items() if not k.startswith("checks/")}, {k: v for k, v in before.items() if not k.startswith("checks/")})

    def test_後の段のtokenが控えを消していればrestoreは何も変えずにpruned_byに挙げる(self):
        # 打ち間違えた token（t3 の段で t30）の最初の書き込みが t3 の控えを消す。黙って 0 件を戻すと、再実行が止まった run の書き込みの上から始まる。
        self._write_stage("t3")
        _ok(self.ws, "put", "--ledger", "open", "--token", "t30", stdin={"open": [{"id": "O-003", "text": "通知の頻度"}]})
        written = self._files()
        out = _ok(self.ws, "restore", "--token", "t3")
        self.assertEqual((out["restored"], out["files"], out["pruned_by"]), (0, [], ["t30"]))
        self.assertEqual(out["flow_before"], out["flow_after"])
        self.assertEqual(self._files(), written)
        self.assertEqual(sorted(p.name for p in (self.ws / "tx").iterdir()), ["t30"])

    def test_控えを書く途中で落ちた一時名があってもrestoreは控えを戻す(self):
        before = self._files()
        self._write_stage("t4")
        (self.ws / "tx" / "t4" / ".decisions.json.pre.4242.tmp").write_text("{}")
        out = _ok(self.ws, "restore", "--token", "t4")
        self.assertIn("decisions.json", {f["path"] for f in out["files"]})
        self.assertEqual({k: v for k, v in self._files().items() if not k.startswith("checks/")}, {k: v for k, v in before.items() if not k.startswith("checks/")})
        self.assertFalse((self.ws / "tx" / "t4").exists())

    def test_控えでないファイルがあればrestoreは何も戻さない(self):
        self._write_stage("t4")
        (self.ws / "tx" / "t4" / "plan.json.pre").write_text("{}")
        written = self._files()
        r = _run(self.ws, "restore", "--token", "t4")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(self._files(), written)


class FreshRunReset(_Workspace):
    """段 1 から始める run の入口の reset は、W を S0 の直後（依頼文・先例の一覧・existing_docs の文書と、固定の文書の meta）に戻す。"""

    # KEEP: fixture の W に S0 が置いた文書（existing_docs）。requirements/auth だけが固定。
    KEEP = ("--keep", "requirements/auth,specifications/auth")
    FIXED = ("--fixed", "requirements/auth")

    def _files(self):
        return {str(p.relative_to(self.ws)): p.read_bytes() for p in sorted(self.ws.rglob("*")) if p.is_file()}

    def _s0_meta(self):
        # S0 が固定の文書に書いていた meta のバイト列（put の正規形）。reset はこれと同じものを書き直す。
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "input.md").write_text("x")
            _ok(ws, "put", "--ledger", "meta", "--doc", "requirements/auth", "--token", "t1", stdin={"fixed": True})
            return (ws / "requirements-auth.meta.json").read_bytes()

    def _reused(self):
        """前のランが段を進めた W。後の段の token（t30）の控え・回答・監査の出力・作業用のファイル・所有表に無いファイルと、
        前のランの writer が書いた existing_docs に無い文書（meta つき）がある。"""
        (self.ws / "precedent.json").write_text('{"paths": []}\n')
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g1.md").write_text("RS-004: 画面\n")
        (self.ws / "findings").mkdir()
        (self.ws / "findings" / "r2-gr-requirements__auth.json").write_text("{}")
        (self.ws / "questions.md").write_text("q")
        (self.ws / "questions.json").write_text("[]")
        (self.ws / "report.md").write_text("r")
        (self.ws / "tmp" / "writer__U-1__draft").mkdir(parents=True)
        (self.ws / "tmp" / "writer__U-1__draft" / "gen.py").write_text("")
        (self.ws / "notes.txt").write_text("stray")
        (self.ws / "requirements-billing.md").write_text("# 前のランの草稿\n")
        _ok(self.ws, "put", "--ledger", "meta", "--doc", "requirements/billing", "--token", "t1", stdin={"tbd": []})
        _ok(self.ws, "snapshot", "--save", "audited-3", "--role", "auditor")
        _ok(self.ws, "put", "--ledger", "resolutions", "--token", "t30", stdin={"resolutions": [{"id": "RS-004", "about": {"open": "O-001"}, "ruling": "internal", "value": "v", "why": "w"}]})

    def test_resetはS0が書いたものだけを残し固定の文書のmetaを書き直す(self):
        self._reused()
        before = self._files()
        out = _ok(self.ws, "reset", *self.KEEP, *self.FIXED)
        kept = {"input.md", "precedent.json", "requirements-auth.md", "specifications-auth.md", "requirements-auth.meta.json", "tmp/writer__U-1__draft/gen.py", "notes.txt"}
        after = self._files()
        self.assertEqual(set(after), kept)
        self.assertEqual({k: after[k] for k in kept - {"requirements-auth.meta.json"}}, {k: before[k] for k in kept - {"requirements-auth.meta.json"}}, "S0 が書いたものと所有表の外は触らない")
        self.assertEqual(after["requirements-auth.meta.json"], self._s0_meta())
        self.assertEqual((out["kept"], out["fixed"]), (["requirements/auth", "specifications/auth"], ["requirements/auth"]))
        self.assertEqual(out["removed"], sorted(["answers", "checks", "decisions.json", "findings", "flow.json", "open.json", "plan.json", "questions.json", "questions.md", "report.md",
                                                 "requirements-billing.md", "requirements-billing.meta.json", "resolutions.json", "specifications-auth.meta.json", "tx"]))
        self.assertEqual(_ok(self.ws, "reset", *self.KEEP, *self.FIXED)["removed"], [], "流し直しても同じ W になる")
        self.assertEqual(self._files(), after)
        _ok(self.ws, "put", "--ledger", "decisions", "--token", "t1", stdin={"decisions": [{"id": "D-001", "value": "承認は人間が行う"}]})

    def test_resetとsnapshotは固定の文書の本文とmetaのsha256を同じ値で返し書き換えで変わる(self):
        self._reused()
        plan = (self.ws / "plan.json").read_bytes()
        base = _ok(self.ws, "reset", *self.KEEP, *self.FIXED)["fixed_sha256"]
        (self.ws / "plan.json").write_bytes(plan)
        self.assertEqual(list(base), ["requirements/auth"])
        snap = lambda: _ok(self.ws, "snapshot", "--save", "s", "--fixed", "requirements/auth")["fixed_sha256"]
        self.assertEqual(snap(), base)
        self.assertNotIn("fixed_sha256", _ok(self.ws, "snapshot", "--save", "s"))
        doc = self.ws / "requirements-auth.md"
        doc.write_text(doc.read_text() + "\n追記\n")
        moved = snap()
        self.assertNotEqual(moved, base, "本文の書き換え")
        meta = self.ws / "requirements-auth.meta.json"
        meta.write_text(meta.read_text().replace('"fixed": true', '"fixed": false'))
        self.assertNotEqual(snap(), moved, "fixed の印を外した meta の書き換え")

    def test_前のランのwriterの文書はresetの後のindexに載らない(self):
        # 分割に異を唱えた依頼者の言葉を足して同じ W で S0 からやり直す経路。前のランの writer の文書（billing）は existing_docs に無い。
        self._reused()
        index = lambda: (_ok(self.ws, "index", "--req-dir", "docs/requirements", "--spec-dir", "docs/specifications"), (self.ws / "checks" / "INDEX.requirements.md").read_text())[1]
        self.assertIn("billing", index(), "reset の前は、前のランの文書が INDEX に載る")
        _ok(self.ws, "reset", "--keep", "requirements/auth")
        self.assertEqual(sorted(p.name for p in self.ws.glob("*.md")), ["input.md", "requirements-auth.md"])
        self.assertNotIn("billing", index())

    def test_再利用したWの新しいrunの最初の書き込みはresetの後にだけ通る(self):
        self._reused()
        stopped = _run(self.ws, "put", "--ledger", "decisions", "--token", "t1", stdin={"decisions": [{"id": "D-001", "value": "承認は部長が行う"}]})
        self.assertEqual(stopped.returncode, 1, "前のランの後の段の控えがあると、新しいランの t1 は何も書けない")
        self.assertIn("t30", stopped.stderr)
        _ok(self.ws, "reset", *self.KEEP)
        _ok(self.ws, "put", "--ledger", "decisions", "--token", "t1", stdin={"decisions": [{"id": "D-001", "value": "承認は部長が行う"}]})

    def test_段1の再実行は止まったintakeの要素と欄を残さない(self):
        _append_invariant_source(self.ws)
        stopped = {"decisions": [{"id": "D-003", "kind": "invariant", "quote": "未コミットの作業を失ってはならない"}, {"id": "D-009", "value": "止まった intake の既定", "source": "default"}]}
        rerun = {"decisions": [{"id": "D-003", "value": "日本語で書く", "source": "default"}]}
        control = Path(self._tmp.name) / "control"
        shutil.copytree(self.ws, control)
        for ws in (self.ws, control):
            (ws / "decisions.json").unlink()
            _ok(ws, "put", "--ledger", "decisions", "--token", "t1", stdin=stopped)
        _ok(self.ws, "reset", *self.KEEP)
        for ws in (self.ws, control):
            _ok(ws, "put", "--ledger", "decisions", "--token", "t1", stdin=rerun)
        merged = json.loads((control / "decisions.json").read_text())["decisions"]
        self.assertEqual([(d["id"], d.get("kind")) for d in merged], [("D-003", "invariant"), ("D-009", None)], "reset が無いと put はキー単位で足すので、止まった run の要素と欄が残る")
        self.assertEqual(json.loads((self.ws / "decisions.json").read_text())["decisions"], rerun["decisions"])

    def test_引数が合わなければresetは何も消さない(self):
        self._reused()
        before = self._files()
        for name, argv, needle in (
            ("固定の文書が W に無い", ("--keep", "requirements/auth,requirements/none", "--fixed", "requirements/auth,requirements/none"), "requirements/none"),
            ("固定でない既存文書が W に無い", ("--keep", "requirements/auth,specifications/none"), "specifications/none"),
            ("--keep のキーの形が違う", ("--keep", "requirements/auth,docs/auth"), "docs/auth"),
            ("--fixed のキーの形が違う", ("--keep", "requirements/auth", "--fixed", "requirements/../auth"), "requirements/../auth"),
            ("--fixed が --keep に無い", ("--keep", "specifications/auth", "--fixed", "requirements/auth"), "requirements/auth"),
        ):
            with self.subTest(name):
                r = _run(self.ws, "reset", *argv)
                self.assertEqual(r.returncode, 1, r.stderr)
                self.assertIn(needle, r.stderr)
                self.assertEqual(self._files(), before)


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


class PutInput(_Workspace):
    """put --input は作業用ディレクトリの中のファイルだけを受け、書けたら消し、拒否したら直して流し直せるよう残す。"""

    def _input(self, body, rel="tmp/verifier__3v/put.json"):
        p = self.ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        return p

    def test_書けたらファイルを消しディレクトリは残す(self):
        p = self._input({"decisions": [{"id": "D-003", "value": "英語で書く"}]})
        _ok(self.ws, "put", "--ledger", "decisions", "--input", str(p))
        self.assertFalse(p.exists())
        self.assertTrue(p.parent.is_dir(), "呼び出し中の agent のディレクトリは消さない（片付けは snapshot --sweep と report）")
        self.assertIn("英語で書く", (self.ws / "decisions.json").read_text(encoding="utf-8"))

    def test_拒否したらファイルを残し直して流し直せる(self):
        p = self._input({"decisions": [{"id": "D-003", "nope": 1}]})
        self._unchanged_after("decisions.json", "put", "--ledger", "decisions", "--input", str(p))
        self.assertTrue(p.exists())
        p.write_text(json.dumps({"decisions": [{"id": "D-003", "value": "英語で書く"}]}, ensure_ascii=False), encoding="utf-8")
        _ok(self.ws, "put", "--ledger", "decisions", "--input", str(p))
        self.assertFalse(p.exists())

    def test_Wをsymlink越しに指してもWの中の作業用ディレクトリなら受ける(self):
        link = Path(self._tmp.name) / "W-link"
        link.symlink_to(self.ws)
        p = self._input({"decisions": [{"id": "D-003", "value": "英語で書く"}]})
        r = subprocess.run(["node", str(DOC_CHECK), "put", "--ledger", "decisions", "--token", TOKEN, "--workspace", str(link), "--input", str(p)],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(p.exists())

    def test_作業用ディレクトリの外のファイルは拒否して消さない(self):
        outside = Path(self._tmp.name) / "scratchpad" / "put.json"
        for p in (outside, self.ws / "put.json", self.ws / "checks" / "put.json"):
            with self.subTest(str(p)):
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps({"decisions": [{"id": "D-003", "value": "英語で書く"}]}), encoding="utf-8")
                self._unchanged_after("decisions.json", "put", "--ledger", "decisions", "--input", str(p))
                self.assertTrue(p.exists())


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
        self._assert_all_stop("flow.json", self.MODES + (("put", "--ledger", "flow"), ("get", "--ledger", "flow", "--ids", "F-001")))

    def test_正規形でない_decisions_は_conflicts_と_put_で止まる(self):
        self._assert_all_stop("decisions.json", (("conflicts",), ("flow",), ("put", "--ledger", "decisions"), ("get", "--ledger", "decisions", "--ids", "D-001")))

    def test_正規形でない_meta_は_doc_と_put_で止まる(self):
        self._assert_all_stop("requirements-auth.meta.json", (("doc",), ("put", "--ledger", "meta", "--doc", "requirements/auth"), ("get", "--ledger", "meta", "--doc", "requirements/auth", "--ids", "PR-AUTH-001")))

    def test_正規形でない_meta_は文書を読む全モードで止まる(self):
        digest = _ok(self.ws, "snapshot", "--save", "base")["digest"]
        modes = (("snapshot", "--save", "other"), ("diff", "--against", "base", "--expect", digest), ("tree-digest",), ("index",))
        self._assert_all_stop("requirements-auth.meta.json", modes)
        self.assertFalse((self.ws / "checks" / "other.snapshot.json").exists())

    def test_台帳の欄でない最上位のキーは止まる(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": []})
        self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin={"sha256": "x"})

    def test_形の外の_resolution_の_ID_は何も書かない(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001"}]})
        for bad in ("R-001", "D-001", "RS-", "rs-001"):
            with self.subTest(bad):
                r = self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": bad}]})
                self.assertIn(bad, r.stderr)


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

    def test_不合格から合格に変えたputはfail_kindを送らなくても消す(self):
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "RS-001", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r"}]})
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "RS-001", "verdict": "pass", "reason": "r2"}]})
        item = json.loads((self.ws / "verifications.json").read_text())["items"][0]
        self.assertEqual({k: item[k] for k in item if k != "digest"}, {"id": "RS-001", "verdict": "pass", "reason": "r2"})
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "RS-001", "verdict": "pass", "fail_kind": None, "reason": "r3"}]})
        self._unchanged_after("verifications.json", "put", *self._args(),
                              stdin={"items": [{"id": "RS-001", "verdict": "pass", "fail_kind": "mapping", "reason": "r"}]})

    def test_不合格のまま理由だけ送ったputはfail_kindを残す(self):
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "RS-001", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r"}]})
        _ok(self.ws, "put", *self._args(), stdin={"items": [{"id": "RS-001", "verdict": "fail", "reason": "r2"}]})
        item = json.loads((self.ws / "verifications.json").read_text())["items"][0]
        self.assertEqual({k: item[k] for k in item if k != "digest"}, {"id": "RS-001", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r2"})

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

    def test_候補のflow_refsはflowにある要素だけを指せる(self):
        opts = [{**o, "flow_refs": refs} for o, refs in zip(RESOLUTION_Q["options"], (["F-003"], []))]
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "options": opts}]})
        opts[1] = {**opts[1], "flow_refs": ["F-099"]}
        r = self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "options": opts}]})
        self.assertIn("F-099", r.stderr)

    def test_flowから消えた要素を指す候補はquestionsの検査に落ちる(self):
        opts = [{**o, "flow_refs": refs} for o, refs in zip(RESOLUTION_Q["options"], (["F-003"], []))]
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**RESOLUTION_Q, "options": opts}]})
        self.assertEqual(_ok(self.ws, "questions", "--ids", "RS-001", "--check")["findings"], 0)
        _ok(self.ws, "del", "--ledger", "flow", "--collection", "elements", "--ids", "F-003")
        r = _run(self.ws, "questions", "--ids", "RS-001", "--check")
        self.assertEqual((r.returncode, json.loads(r.stdout)["bad_ids"]), (0, ["RS-001"]))
        self.assertIn("F-003", r.stderr)

    def test_問いの無い_ID_は止まる(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-009", "ruling": "internal"}]})
        self.assertEqual(_run(self.ws, "questions", "--ids", "RS-009").returncode, 1)
        self.assertEqual(_run(self.ws, "questions", "--ids", "RS-404").returncode, 1)


class Answers(_Workspace):
    """answers は回答のファイルが問いのすべてに `<ID>:` の行を持つかを数えるだけで、何も書かない（script がゲートを越えてよいかを決める）。"""

    def test_問いごとの行の有無を数える(self):
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g0.md").write_text("RS-001: 画面\n  RS-003: その他\n注記 RS-002: 行の頭ではない\n")
        before = sorted(p.relative_to(self.ws) for p in self.ws.rglob("*"))
        out = _ok(self.ws, "answers", "--file", "answers/g0.md", "--ids", "RS-003,RS-001,RS-002,RS-001")
        self.assertEqual(out, {"file": "answers/g0.md", "exists": True, "ids": ["RS-001", "RS-002", "RS-003"], "missing": ["RS-002"]})
        self.assertEqual(sorted(p.relative_to(self.ws) for p in self.ws.rglob("*")), before)

    def test_resetが消した回答はファイルが無い(self):
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g0.md").write_text("RS-001: 画面\n")
        self.assertEqual(_ok(self.ws, "answers", "--file", "answers/g0.md", "--ids", "RS-001")["missing"], [])
        _ok(self.ws, "reset", "--keep", "requirements/auth,specifications/auth")
        out = _ok(self.ws, "answers", "--file", "answers/g0.md", "--ids", "RS-001")
        self.assertEqual((out["exists"], out["missing"]), (False, ["RS-001"]))

    def test_answersの外のファイルとIDの無い呼び出しは止まる(self):
        for bad in (("--file", "../input.md", "--ids", "RS-001"), ("--file", "input.md", "--ids", "RS-001"), ("--file", "answers/g0.md")):
            with self.subTest(bad=bad):
                self.assertEqual(_run(self.ws, "answers", *bad).returncode, 1)


class FieldTypes(_Workspace):
    """put は型の外の欄・経緯の印を持つ欄を、何も書かずに拒否する。字数では拒否しない。"""

    def test_長い自由記述の欄も字数では拒否しない(self):
        long = "字" * 3000
        _ok(self.ws, "put", "--ledger", "flow", stdin={"closure": long, "elements": [{"id": "F-001", "label": long}], "kinds": [{"name": "工程", "definition": long}]})
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-009", "ruling": "internal", "why": long}]})
        _ok(self.ws, "put", "--ledger", "open", stdin={"open": [{"id": "O-009", "text": long, "searched": long}]})
        _ok(self.ws, "put", "--ledger", "decisions", stdin={"decisions": [{"id": "D-009", "why": long}]})
        self.assertEqual(json.loads((self.ws / "flow.json").read_text())["closure"], long)

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

    def test_閉集合の欄は値の外を拒否しnullで消せる(self):
        enums = _exported("Object.fromEntries(Object.entries(m.LEDGERS).filter(([, v]) => v.enums).map(([k, v]) => [k, { enums: v.enums, lists: v.lists }]))")
        self.assertLessEqual({"flow", "decisions"}, set(enums))
        _append_invariant_source(self.ws)
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-001", "about": {"tbd": "TBD-X-001"}, "ruling": "internal", "value": "v", "why": "w"}]})
        pick = {"flow": "F-002"}
        for name, spec in enums.items():
            for lst, fields in spec["enums"].items():
                key = spec["lists"][lst]
                els = json.loads((self.ws / f"{name}.json").read_text())[lst]
                el = next(e for e in els if e[key] == pick.get(name, els[0][key]))
                base = {key: el[key], "quote": "未コミットの作業を失ってはならない。"} if name == "decisions" else {key: el[key]}
                for field, values in fields.items():
                    with self.subTest(ledger=name, field=field):
                        r = self._unchanged_after(f"{name}.json", "put", "--ledger", name, stdin={lst: [{**base, field: "sometimes"}]})
                        self.assertIn(" / ".join(values), r.stderr)
                        for v in values:
                            _ok(self.ws, "put", "--ledger", name, stdin={lst: [{**base, field: v}]})
                        _ok(self.ws, "put", "--ledger", name, stdin={lst: [{key: el[key], field: None}]})
                        self.assertNotIn(field, json.loads((self.ws / f"{name}.json").read_text())[lst][0])

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

    def test_実測で決めた裁定を問いに変えるとvalueを残せず_nullで通り問いの検査に通る(self):
        # 前回の試走の RS-010 の形: O-010 の失敗の行き先を現行の挙動で決めた measured を、変換で question にする。
        src = Path(self._tmp.name) / "repo_state.py"
        src.write_text("def sync():\n    return 'abort'\n")
        measured = {"id": "RS-010", "about": {"open": "O-010"}, "ruling": "measured", "value": "失敗したら中断する",
                    "evidence": [{"file": str(src), "line": 2, "quote": "return 'abort'"}]}
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [measured]})
        q = {"ruling": "question", "question": RESOLUTION_Q["question"], "options": RESOLUTION_Q["options"]}
        self._rejected({"resolutions": [{"id": "RS-010", **q}]}, "value", "null")
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-010", **q, "value": None}]})
        ok = _ok(self.ws, "questions", "--ids", "RS-010", "--check")
        self.assertEqual((ok["questions"], ok["findings"]), (1, 0))

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

    def test_invariantの決定はquoteが要る(self):
        _append_invariant_source(self.ws)
        r = self._unchanged_after("decisions.json", "put", "--ledger", "decisions", stdin={"decisions": [{"id": "D-004", "kind": "invariant", "value": "未コミットの作業を失わない"}]})
        self.assertIn("quote が要ります", r.stderr)
        _ok(self.ws, "put", "--ledger", "decisions", stdin={"decisions": [{"id": "D-004", "kind": "invariant", "quote": "未コミットの作業を失ってはならない。"}]})

    def test_decisionからstepに変えてbranchesを残すと拒否し_nullで通る(self):
        branches = [{"value": "可", "next": "F-003"}, {"value": "否", "next": "F-003"}]
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "decision", "branches": branches, "next": None, "effect": None, "obtain": None}]})
        r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "step", "next": ["F-003"]}]})
        self.assertIn("branches", r.stderr)
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "step", "next": ["F-003"], "branches": None}]})

    def test_decisionをやめるとinputsとcasesを残せない(self):
        r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [{"id": "F-004", "type": "step", "next": ["F-003"], "branches": None}]})
        self.assertIn("inputs・cases", r.stderr)
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{"id": "F-004", "type": "step", "next": ["F-003"], "branches": None, "inputs": None, "cases": None}]})

    def test_decisionはnextを持てない(self):
        r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "decision", "branches": []}]})
        self.assertIn("next", r.stderr)

    def test_effectはstepだけ_obtainはinputとstepだけが持てる(self):
        for el, field in (({"id": "F-001", "effect": "destructive"}, "effect"), ({"id": "F-004", "effect": "destructive"}, "effect"), ({"id": "F-004", "obtain": "always"}, "obtain"),
                          ({"id": "F-003", "obtain": "always"}, "obtain"), ({"id": "F-003", "effect": "read"}, "effect")):
            with self.subTest(el=el):
                r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [el]})
                self.assertIn(f"では {field} を持てません", r.stderr)
        r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "type": "decision", "branches": [], "next": None}]})
        self.assertIn("effect・obtain を持てません", r.stderr, "型を変えても前の型の欄は残せない")
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{"id": "F-001", "obtain": "may_fail"}]})

    def test_on_failはmay_failの要素だけが持てる(self):
        fail = {"as": "読めない", "source": {"input": "ログイン"}}
        for el in ({"id": "F-002", "on_fail": fail}, {"id": "F-004", "on_fail": fail}):
            with self.subTest(el=el):
                r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [el]})
                self.assertIn("では on_fail を持てません", r.stderr)
        r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [{"id": "F-001", "obtain": "may_fail", "on_fail": {**fail, "source": {"input": "依頼に無い文"}}}]})
        self.assertIn("逐語で無い", r.stderr)
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{"id": "F-001", "obtain": "may_fail", "on_fail": fail}]})


class InvariantOpen(_Workspace):
    def _open(self, kind="invariant"):
        _ok(self.ws, "put", "--ledger", "open", stdin={"open": [{"id": "O-009", "text": "何を失ってはならないか", **({"kind": kind} if kind else {})}]})

    def test_invariantのOを閉じるresolutionはkindが要る(self):
        self._open()
        body = {"id": "RS-009", "about": {"open": "O-009"}, "ruling": "internal", "value": "未 push の commit を失わない", "why": "w"}
        r = self._unchanged_after("resolutions.json", "put", "--ledger", "resolutions", stdin={"resolutions": [body]})
        self.assertIn("kind が要ります", r.stderr)
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{**body, "kind": "invariant"}]})

    def test_kindの無いresolutionが閉じたOはinvariantにできない(self):
        self._open(kind=None)
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-012", "about": {"open": "O-009"}, "ruling": "internal", "value": "v", "why": "w"}]})
        r = self._unchanged_after("open.json", "put", "--ledger", "open", stdin={"open": [{"id": "O-009", "kind": "invariant"}]})
        self.assertIn("kind を持てません", r.stderr)
        self.assertIn("新しい kind が invariant の O- を open.json に足し", r.stderr, "拒否の文が直し方を示す")
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-012", "kind": "invariant"}]})
        self._open()

    def test_invariantでないOを閉じるresolutionはkindが無くてよい(self):
        self._open(kind=None)
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [{"id": "RS-009", "about": {"open": "O-009"}, "ruling": "internal", "value": "v", "why": "w"}]})

    def test_constrained_byはinvariantのOだけを指せる(self):
        self._open(kind=None)
        r = self._unchanged_after("flow.json", "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "constrained_by": ["O-009"]}]})
        self.assertIn("O-009", r.stderr)
        self._open()
        _ok(self.ws, "put", "--ledger", "flow", stdin={"elements": [{"id": "F-002", "constrained_by": ["O-009"]}]})


def _json_after(text, marker):
    m = re.search(re.escape(marker) + r"[^\n]*\n\n```json\n(.*?)\n```", text, re.S)
    return json.loads(m.group(1))


class ContractExamplesUseLedgerFields(unittest.TestCase):
    """契約の JSON の例に出るキーが、すべて LEDGERS の欄の一覧にある（例と型の正本がずれない）。"""

    @unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
    def test_例のキーはLEDGERSの欄にある(self):
        ledgers = _exported("Object.fromEntries(Object.entries(m.LEDGERS).map(([k, v]) => [k, { lists: v.lists, scalars: Object.keys(v.scalars), fields: v.fields }]))")
        text = CONTRACTS.read_text(encoding="utf-8")
        flow_sec = text[text.index("\n## flow.json の形\n"):]
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

    @unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
    def test_閉集合の欄の値は契約にLEDGERSと同じ並びで書く(self):
        enums = _exported("Object.fromEntries(Object.entries(m.LEDGERS).filter(([, v]) => v.enums).map(([k, v]) => [k, v.enums]))")
        text = CONTRACTS.read_text(encoding="utf-8")
        self.assertTrue(enums)
        for name, lists in enums.items():
            for lst, fields in lists.items():
                for field, values in fields.items():
                    with self.subTest(ledger=name, field=field):
                        self.assertIn(" / ".join(f"`{v}`" for v in values), text)


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
        tx = ("--token", TOKEN) if args[0] in WRITES else ()
        return subprocess.run(["node", str(DOC_CHECK), *args, *tx, "--workspace", str(self.ws)],
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
