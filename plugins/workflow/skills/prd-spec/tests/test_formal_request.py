"""doc_check の形式検証の接続（E 段）のテスト。workflow-io.md と agent-contracts.md「## 形式検証の事実」を、CLI の stdout と W のファイルで確かめる。

押さえること（正本は workflow-io.md と agent-contracts.md「## 形式検証の事実」）:
1. formal-request が単位を 4 つの種（domain・bounds・guard・state）で取り、送らない単位を理由つきで unsent に残す
2. 目標の JSON（fm/<rid>/request.json）と対応表（fm/<rid>/units.json）の形。どの目標も量の制約を前提にしない
3. 名前と参照の対応を K-NAME-*・K-REF-* として渡す
4. 送る単位の規則 1〜3 と --phase b
5. 状態遷移図のガードで分けた組の扱い
6. formal-import の結び付け・帰属・検出能力・照合・outcome と formal-status
7. doc の ST-FORMAL-CEX- と report の節、所有表と reset

formal-method のファイルは読まない（配布物に入るテストなので）。結果の fixture（fixtures/formal/results/）が formal-method.result/2 の
形であることは、リポジトリ直下の tests/prd-spec-formal-request.test.mjs が formal-method の検査で確かめる。
"""

import copy
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
DOC_CHECK = SKILL / "scripts" / "doc_check.mjs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "workspace"
FORMAL = Path(__file__).resolve().parent / "fixtures" / "formal"
SPEC_MD = (FORMAL / "specifications-auth.md").read_text(encoding="utf-8")
RESULTS = FORMAL / "results"
DOC_KEY = "specifications/auth"
DOC_FILE = "specifications-auth.md"
SHA = re.compile(r"(sha256:)?[0-9a-f]{64}")


def line_of(text, needle):
    """needle を含む最初の行の番号（1 始まり）。"""
    for i, line in enumerate(text.split("\n"), 1):
        if needle in line:
            return i
    raise AssertionError(f"{needle!r} が無い")


def _run(ws, mode, *args):
    return subprocess.run(["node", str(DOC_CHECK), mode, *map(str, args), "--workspace", str(ws)], capture_output=True, text=True)


def _ok(ws, mode, *args):
    r = _run(ws, mode, *args)
    if r.returncode != 0:
        raise AssertionError(f"doc_check {mode} が exit {r.returncode}: {r.stderr or r.stdout}")
    out = json.loads(r.stdout)
    out.pop("stdout_fnv", None)
    return out


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def collection_hash(root: Path) -> str:
    """artifact-formats.md「版と指紋」の集まりの指紋。FilePath のバイト列の辞書順に `<path>\\0<sha256:...>\\n` をつないだ SHA-256。"""
    files = sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.relative_to(root).as_posix().encode())
    text = "".join(f"{p.relative_to(root).as_posix()}\0sha256:{sha256_hex(p.read_bytes())}\n" for p in files)
    return "sha256:" + sha256_hex(text.encode())


def load_result(name):
    base = json.loads((RESULTS / "base.json").read_text(encoding="utf-8"))
    return {**base, **json.loads((RESULTS / f"{name}.json").read_text(encoding="utf-8"))} if name != "base" else base


def fill(value, request, units, target_text):
    """fixture の置き場所（@goal: など）を、DC が書いた request.json・units.json の値で埋める。"""
    def unit(item):
        got = [u for u in units["units"] if u["item_id"] == item]
        assert got, f"units.json に {item} の単位が無い"
        return got[0]

    def one(v):
        if not isinstance(v, str) or not v.startswith("@"):
            return v
        if v.startswith("@goal:"):
            prefix = v[len("@goal:"):] + "."
            ids = sorted(g["id"] for g in request["goals"] if g["id"].startswith(prefix))
            assert ids, f"request.json に {prefix}* の目標が無い"
            return ids[0]
        if v == "@content_hash":
            return request["targets"][0]["content_hash"]
        if v == "@location":
            return request["targets"][0]["location"]
        if v.startswith("@file:"):
            return unit(v[len("@file:"):])["lines"][0]["file"]
        if v.startswith("@span:"):
            return unit(v[len("@span:"):])["lines"][0]["span"]
        if v.startswith("@arrow:"):
            n = line_of(target_text, f"({v[len('@arrow:'):]})")
            return f"L{n}-L{n}"
        raise AssertionError(v)

    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return one(v)

    return walk(value)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class _W(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name) / "W"
        shutil.copytree(FIXTURE, self.ws)
        (self.ws / DOC_FILE).write_text(SPEC_MD, encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    # ---- 操作
    def edit(self, old, new, name=DOC_FILE):
        p = self.ws / name
        text = p.read_text(encoding="utf-8")
        self.assertIn(old, text)
        p.write_text(text.replace(old, new, 1), encoding="utf-8")

    def request(self, rid="f1a", stage="5", phase="a"):
        return _ok(self.ws, "formal-request", "--rid", rid, "--stage", stage, "--phase", phase)

    def fm(self, rel):
        return json.loads((self.ws / "fm" / rel).read_text(encoding="utf-8"))

    def units(self, rid="f1a"):
        return self.fm(f"{rid}/units.json")

    def req(self, rid="f1a"):
        return self.fm(f"{rid}/request.json")

    def kinds(self, rid="f1a"):
        return sorted((u["item_id"], u["kind"]) for u in self.units(rid)["units"])

    def unsent(self, out_or_units):
        return {(u["item_id"], u["reason"]) for u in out_or_units["unsent"]}

    def goals(self, item, kind, rid="f1a"):
        return [g for u in self.units(rid)["units"] if u["item_id"] == item and u["kind"] == kind for g in u["goals"]]

    def run_dir(self, name="r1", root=None):
        d = (root or Path(f"{self.ws}.formal")) / ".formal-method" / "runs" / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    def place_run(self, rid="f1a", result="cex_goal", name="r1", root=None, request_patch=None, result_patch=None):
        """FM の run の領域を、受け付けた依頼（request.json）と結果（result.json）で作る。result=None なら result.json を置かない。"""
        d = self.run_dir(name, root)
        request = self.req(rid)
        fm_request = copy.deepcopy(request)
        if request_patch:
            request_patch(fm_request)
        (d / "request.json").write_text(json.dumps(fm_request, ensure_ascii=False), encoding="utf-8")
        if result is not None:
            target = Path(request["targets"][0]["location"]) / DOC_FILE
            r = fill(load_result(result), request, self.units(rid), target.read_text(encoding="utf-8"))
            if result_patch:
                result_patch(r)
            (d / "result.json").write_text(json.dumps(r, ensure_ascii=False), encoding="utf-8")
        return d

    def import_(self, rid="f1a", run_dir=None, unavailable=None):
        args = ["--rid", rid]
        if run_dir is not None:
            args += ["--run-dir", run_dir]
        if unavailable:
            args += ["--unavailable", unavailable]
        return _ok(self.ws, "formal-import", *args)

    def facts_goal(self, item, kind, blocking=None):
        facts = self.fm("facts.json")
        got = [g for u in facts["units"] if u["item_id"] == item and u["kind"] == kind for g in u["goals"] if blocking is None or g["blocking"] is blocking]
        self.assertTrue(got, f"facts.json に {item} {kind} の目標が無い")
        return got


class FormalUnits(_W):
    """単位の選び方。"""

    def test_4つの種の単位を取る(self):
        out = self.request()
        self.assertEqual(self.kinds(), sorted([
            ("SP-AUTH-010", "domain"), ("SP-AUTH-011", "bounds"), ("SP-AUTH-012", "guard"),
            ("SP-AUTH-013", "guard"), ("SP-AUTH-018", "guard"), ("SP-AUTH-020", "state"),
        ]))
        self.assertEqual(out["units"], len(self.units()["units"]))
        self.assertEqual(out["goals"], len(self.req()["goals"]))
        self.assertEqual(out["rid"], "f1a")

    def test_列挙だけの宣言とガードの無い文は単位にしない(self):
        out = self.request()
        items = {i for i, _ in self.kinds()}
        self.assertNotIn("SP-AUTH-014", items, "列挙だけの宣言は decisionCheck が決める")
        self.assertNotIn("SP-AUTH-001", items)
        self.assertNotIn("SP-AUTH-014", {i for i, _ in self.unsent(out)}, "送らない理由の無い項目は unsent にも載せない")

    def test_ガードの無い状態図は取らない(self):
        start = SPEC_MD.index("```mermaid")
        end = SPEC_MD.index("```", start + 3) + 3
        plain = "\n".join([
            "```mermaid", "stateDiagram-v2", "    [*] --> 承認待ち", "    承認待ち --> 経理連携中 : E2 承認する (SP-AUTH-021)",
            "    部長承認待ち --> 経理連携中 : E3 部長が承認する (SP-AUTH-023)", "    経理連携中 --> [*]", "```",
        ])
        (self.ws / DOC_FILE).write_text(SPEC_MD[:start] + plain + SPEC_MD[end:], encoding="utf-8")
        out = self.request()
        self.assertNotIn(("SP-AUTH-020", "state"), self.kinds())
        self.assertNotIn("SP-AUTH-020", {i for i, _ in self.unsent(out)})

    def test_制約と条件はコードスパンの直後の語で分けどちらでもない式はunsentに入る(self):
        out = self.request()
        self.assertIn(("SP-AUTH-011", "bounds"), self.kinds(), "でなければならない は制約")
        self.assertIn(("SP-AUTH-012", "guard"), self.kinds(), "のとき は条件")
        self.assertIn(("SP-AUTH-016", "制約か条件か決まらない"), self.unsent(out))
        self.assertEqual(self.unsent(out), self.unsent(self.units()), "stdout と units.json の unsent は同じ")

    def test_名前を解けない式は送らずunsentに名前を残す(self):
        out = self.request()
        self.assertIn(("SP-AUTH-015", "名前を解けない: 種別"), self.unsent(out))
        self.assertNotIn("SP-AUTH-015", {i for i, _ in self.kinds()})

    def test_静的な指摘が残る単位は送らない(self):
        # ガードで分けた組（承認待ち × E2）の行を表に書くと ST-STATE-DIAGRAM-CONFLICT が残る。
        self.edit("| 承認待ち | E3 | — | — | 発生しない |", "| 承認待ち | E2 | 正常系 | 経理連携中 | ✅ SP-AUTH-021 |\n| 承認待ち | E3 | — | — | 発生しない |")
        out = self.request()
        self.assertNotIn(("SP-AUTH-020", "state"), self.kinds())
        self.assertIn(("SP-AUTH-020", "静的な検査の指摘が残っている"), self.unsent(out))

    def test_目標のblockingは種ごとに決まる(self):
        self.request()
        for item, kind, n in (("SP-AUTH-010", "domain", 1), ("SP-AUTH-011", "bounds", 1), ("SP-AUTH-012", "guard", 1), ("SP-AUTH-018", "guard", 1)):
            with self.subTest(item=item):
                self.assertEqual([g["blocking"] for g in self.goals(item, kind)], [True] * n)
        # 条件が 2 つの項目: 充足が 2 つ（blocking）と、重なりが 1 つ（blocking でない）。
        self.assertEqual(sorted(g["blocking"] for g in self.goals("SP-AUTH-013", "guard")), [False, True, True])
        state = self.goals("SP-AUTH-020", "state")
        self.assertEqual((len(state), {g["blocking"] for g in state}), (3, {True}), "状態遷移の 3 つの目標は全て blocking")

    def test_目標のidは項目と種と番号で出所は単位の最初の行(self):
        self.request()
        req = self.req()
        ids = [g["id"] for g in req["goals"]]
        self.assertEqual(len(ids), len(set(ids)))
        by_unit = {u["item_id"]: u for u in self.units()["units"]}
        for g in req["goals"]:
            m = re.fullmatch(r"(SP-AUTH-\d{3})\.(domain|bounds|guard|state)\.(\d+)", g["id"])
            self.assertIsNotNone(m, g["id"])
            u = by_unit[m.group(1)]
            self.assertEqual(m.group(2), u["kind"])
            first = min(int(re.match(r"L(\d+)", x["span"]).group(1)) for x in u["lines"])
            self.assertEqual((g["source"]["target_id"], int(re.match(r"L(\d+)", g["source"]["span"]).group(1))), ("prd-spec", first))
        self.assertEqual(sorted(g["goal_id"] for u in self.units()["units"] for g in u["goals"]), sorted(ids))


class FormalRequestShape(_W):
    """目標の JSON と、写した対象。"""

    def test_依頼の形と写した対象(self):
        out = self.request()
        req = self.req()
        [target] = req["targets"]
        self.assertEqual(target["id"], "prd-spec")
        self.assertEqual(Path(target["location"]).resolve(), (self.ws / "fm" / "f1a" / "target").resolve())
        copied = Path(target["location"])
        self.assertEqual((copied / DOC_FILE).read_bytes(), (self.ws / DOC_FILE).read_bytes(), "単位を持つ文書は逐語で写す（行番号が W と同じ）")
        self.assertEqual(target["content_hash"], collection_hash(copied), "content_hash は artifact-formats の集まりの指紋")
        self.assertEqual(req["scope"]["exclude"], [])
        self.assertEqual(req["time_limit_seconds"], 3600)
        include = req["scope"]["include"]
        goal_ptrs = {p["id"] for p in include if p["kind"] == "goal"}
        self.assertEqual(goal_ptrs, {g["id"] for g in req["goals"]})
        kr_ptrs = {p["id"] for p in include if p["kind"] == "known_requirement"}
        self.assertEqual(kr_ptrs, {k["id"] for k in req["known_requirements"]})
        locs = [p for p in include if p["kind"] == "location"]
        self.assertTrue(locs and all(p["target_id"] == "prd-spec" and "span" in p for p in locs), "送る行を範囲で渡す（文書の全体を渡さない）")
        # 散文の項目（単位でない SP-AUTH-001）の行は入れない。
        prose = line_of(SPEC_MD, "応答を返さなければならない")
        covered = lambda n: any(int(a) <= n <= int(b) for a, b in (re.fullmatch(r"L(\d+)-L(\d+)", p["span"]).groups() for p in locs))
        self.assertFalse(covered(prose), "散文の行は scope に入れない")
        self.assertTrue(covered(line_of(SPEC_MD, "`1 件 ≤ 件数 ≤ 100 件` でなければならない")))
        # stdout と units.json
        body = (self.ws / "fm" / "f1a" / "request.json").read_bytes()
        units = self.units()
        self.assertEqual(units["rid"], "f1a")
        self.assertEqual((str(units["stage"]), units["phase"]), ("5", "a"))
        self.assertTrue(units["request_digest"].endswith(sha256_hex(body)), "request_digest は request.json のバイト列の sha256")
        self.assertEqual(out["request_digest"], units["request_digest"])
        self.assertRegex(out["request_fnv"], r"^[0-9a-f]{8}$")
        self.assertEqual(out["request_fnv"], units["request_fnv"])
        self.assertEqual(Path(out["cwd"]).resolve(), Path(f"{self.ws}.formal").resolve())
        self.assertTrue(Path(out["cwd"]).is_dir(), "FM の cwd を作る")
        self.assertEqual(out["tree_digest"], units["tree_digest"])
        for u in units["units"]:
            self.assertTrue(u["lines"] and all(x["file"] == DOC_FILE for x in u["lines"]), u)
            self.assertEqual(u["doc"], DOC_KEY)

    def test_送る単位が無ければファイルを書かずgoals0を返す(self):
        (self.ws / DOC_FILE).write_text((FIXTURE / DOC_FILE).read_text(encoding="utf-8"), encoding="utf-8")
        out = self.request()
        self.assertEqual((out["goals"], out["units"]), (0, 0))
        self.assertFalse((self.ws / "fm" / "f1a" / "request.json").exists())

    def test_どの目標も量の制約を前提にしない(self):
        self.request()
        req = self.req()
        bound = "1 件 ≤ 件数 ≤ 100 件"
        holders = [g["id"] for g in req["goals"] if bound in g["text"]]
        self.assertTrue(holders and all(h.startswith("SP-AUTH-011.bounds.") for h in holders), f"制約の式は自分の bounds の目標にだけ現れる: {holders}")
        self.assertFalse([k["id"] for k in req["known_requirements"] if bound in k["text"]], "制約を既知の要求として前提に渡さない")
        guard = [u for u in self.units()["units"] if u["item_id"] == "SP-AUTH-012"][0]
        self.assertFalse([d for d in guard["deps"] if "SP-AUTH-011" in str(d)], "bounds を他の単位の依存にしない")

    def test_outcomeのあるridの依頼は作り直さずexit2(self):
        self.request()
        self.import_(unavailable="no_result")
        r = _run(self.ws, "formal-request", "--rid", "f1a", "--stage", "5", "--phase", "a")
        self.assertEqual(r.returncode, 2, r.stderr)

    def test_outcomeの無いridの依頼は上書きする(self):
        self.request()
        self.edit("`件数 > 100 件` のとき", "`件数 > 200 件` のとき")
        self.request()
        self.assertIn("件数 > 200 件", (Path(self.req()["targets"][0]["location"]) / DOC_FILE).read_text(encoding="utf-8"))


class NamesAndRefs(_W):
    """参照と名前の対応を既知の要求として渡す。"""

    def _known(self, prefix):
        return [k for k in self.req()["known_requirements"] if k["id"].startswith(prefix)]

    def test_参照の対応をK_REFで渡す(self):
        self.request()
        ref_line = line_of(SPEC_MD, "> 条件の値: 金額 = SP-AUTH-010")
        decl_line = line_of(SPEC_MD, "> 条件の値: 金額 = 金額 ≤ 100000 円")
        refs = self._known("K-REF-")
        self.assertTrue(any(f"L{ref_line}" in k["text"] and "SP-AUTH-010" in k["text"] and f"L{decl_line}" in k["text"] for k in refs), refs)
        deps = [u for u in self.units()["units"] if u["item_id"] == "SP-AUTH-020"][0]["deps"]
        self.assertTrue(any("SP-AUTH-010" in str(d) for d in deps), "state の単位はガードが使う宣言の区間に依存する")

    def test_名前は同じ区間の宣言から先に解く(self):
        self.request()
        names = self._known("K-NAME-")
        route = [k["text"] for k in names if "「経路」" in k["text"]]
        d13 = line_of(SPEC_MD, "> 条件の値: 経路 = 社内 / 社外")
        d18 = line_of(SPEC_MD, "> 条件の値: 経路 = 甲 / 乙")
        self.assertTrue(any(f"L{d18}" in t for t in route), "SP-AUTH-018 の条件は同じ区間の直書きの宣言を指す")
        self.assertTrue(any(f"L{d13}" in t for t in route), "SP-AUTH-013 の条件は同じ区間の直書きの宣言を指す")
        self.assertTrue(all("条件" in t for t in route))

    def test_参照で解いた宣言と量の名前(self):
        self.request()
        names = self._known("K-NAME-")
        decl = line_of(SPEC_MD, "> 条件の値: 金額 = 金額 ≤ 100000 円")
        amount = [k["text"] for k in names if "「金額」" in k["text"]]
        self.assertTrue(any(f"L{decl}" in t for t in amount), "状態図のガードの 金額 は参照で解いた宣言を指す")
        self.assertTrue(amount and all("条件" in t for t in amount), "条件と量の両方に当たる名前は条件とする")
        count = [k["text"] for k in names if "「件数」" in k["text"]]
        self.assertTrue(count and all("量" in t for t in count), "宣言の無い 件数 は量の名前として解く")


class SendRules(_W):
    """送る単位の規則 1〜3 と --phase b。"""

    def _reset_entry(self):
        _ok(self.ws, "reset", "--keep", "requirements/auth,specifications/auth")
        shutil.copy(FIXTURE / "plan.json", self.ws / "plan.json")

    def _import_result(self, rid, result="verified_unmutated", name=None):
        d = self.place_run(rid, result, name or f"run-{rid}")
        return self.import_(rid, run_dir=d)

    def test_existingの入口から変わらない単位は送らない(self):
        self._reset_entry()
        out = self.request()
        self.assertEqual((out["goals"], out["units"]), (0, 0), "入口から変わらない単位は送らない")
        self.edit("`件数 > 100 件` のとき", "`件数 > 200 件` のとき")
        self.request()
        self.assertEqual(self.kinds(), [("SP-AUTH-012", "guard")])

    def test_依存の宣言だけを変えると依存する単位も送る(self):
        self.request()
        self._import_result("f1a")
        self.assertEqual(self.request("f2a", "8")["goals"], 0, "facts と同じ digest の単位は送らない")
        self.edit("> 条件の値: 金額 = 金額 ≤ 100000 円 / 金額 > 100000 円", "> 条件の値: 金額 = 金額 ≤ 200000 円 / 金額 > 200000 円")
        self.request("f2a", "8")
        self.assertEqual(self.kinds("f2a"), [("SP-AUTH-010", "domain"), ("SP-AUTH-020", "state")], "SP-AUTH-020 は自分が変わらなくても依存が変われば送る")

    def test_retryの単位はdigestが同じでも送り直す(self):
        self.request()
        before = self.kinds()
        self.import_(unavailable="no_result")
        self.assertTrue(all(u["retry"] for u in self.fm("facts.json")["units"]))
        self.request("f2a", "8")
        self.assertEqual(self.kinds("f2a"), before)

    def test_phase_bは差し戻しで変わった単位だけを送る(self):
        self.request()
        self._import_result("f1a", "cex_goal")
        self.edit("`1 件 ≤ 件数 ≤ 100 件` でなければならない", "`1 件 ≤ 件数 ≤ 200 件` でなければならない")
        out = self.request("f1b", "5", "b")
        self.assertEqual(self.kinds("f1b"), [("SP-AUTH-011", "bounds")])
        self.assertEqual(self.units("f1b")["phase"], "b")
        self.assertEqual(out["rid"], "f1b")

    def test_phase_bで変わった単位が無ければgoals0(self):
        self.request()
        self._import_result("f1a", "cex_goal")
        self.assertEqual(self.request("f1b", "5", "b")["goals"], 0)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class GuardedStates(unittest.TestCase):
    """状態遷移図の矢印のガード。structuralFindings（doc_check の export）で照らす。"""

    K = DOC_KEY

    def _ids(self, md):
        src = (f"import {{ structuralFindings }} from {json.dumps(DOC_CHECK.as_uri())}\n"
               "const spec = JSON.parse(process.argv[2])\n"
               "const r = structuralFindings([{ key: spec.key, kind: 'specifications', topic: 'auth', markdown: spec.md, ids: [], fixed: false }])\n"
               "process.stdout.write(JSON.stringify(r.findings.filter((f) => f.id.startsWith('ST-STATE-')).map((f) => ({ id: f.id, issue: f.issue }))))\n")
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "t.mjs"
            p.write_text(src)
            out = subprocess.run(["node", str(p), json.dumps({"key": self.K, "md": md})], capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_ガードで分けた組はNONDETもMISSINGも出さない(self):
        ids = [f["id"] for f in self._ids(SPEC_MD)]
        self.assertNotIn(f"ST-STATE-NONDET-{self.K}-承認待ち-E2", ids)
        self.assertNotIn(f"ST-STATE-MISSING-{self.K}-承認待ち-E2", ids, "表に行が無くても図のガードが覆う")
        self.assertEqual(ids, [], "閉じた表とガードで分けた図は何も出さない")

    def test_ガードで分けた組の行が表にあればDIAGRAM_CONFLICT(self):
        md = SPEC_MD.replace("| 承認待ち | E3 | — | — | 発生しない |", "| 承認待ち | E2 | 正常系 | 経理連携中 | ✅ SP-AUTH-021 |\n| 承認待ち | E3 | — | — | 発生しない |")
        got = {f["id"]: f for f in self._ids(md)}
        fid = f"ST-STATE-DIAGRAM-CONFLICT-{self.K}-承認待ち-E2"
        self.assertIn(fid, got)
        self.assertIn("ガードで分けた組は表に書かない", got[fid]["issue"])
        self.assertNotIn(f"ST-STATE-NONDET-{self.K}-承認待ち-E2", got)

    def test_ガードの有る矢印と無い矢印が混ざる組はNONDET(self):
        md = SPEC_MD.replace("E2 承認する [金額 > 100000 円] (SP-AUTH-022)", "E2 承認する (SP-AUTH-022)")
        self.assertIn(f"ST-STATE-NONDET-{self.K}-承認待ち-E2", [f["id"] for f in self._ids(md)])

    def test_ガードはイベントの名前に入らない(self):
        # ラベルの [式] を除いたイベントが表の軸（E2）と合うので、承認待ち × E2 は欠けた組にも未知のイベントにもならない。
        ids = [f["id"] for f in self._ids(SPEC_MD)]
        self.assertFalse([i for i in ids if "金額" in i], ids)


class Import(_W):
    """formal-import の結び付け（H3）・帰属（H2）・検出能力（M5）。"""

    def setUp(self):
        super().setUp()
        self.request()

    def _import(self, result, **kw):
        return self.import_(run_dir=self.place_run(result=result, **kw))

    def test_goalの出所の性質はその目標だけに結び付く(self):
        out = self._import("cex_goal")
        self.assertEqual(out["outcome"], "result")
        [b] = self.facts_goal("SP-AUTH-011", "bounds")
        self.assertEqual(b["verdict"], "反例")
        self.assertEqual(b["location"]["item_id"], "SP-AUTH-011", "反例の sources の goal の id から単位を引く")
        self.assertIn("入力 1 の値と経路", b["witness"])
        self.assertIn("違反した条件 1", b["witness"])
        [g] = self.facts_goal("SP-AUTH-012", "guard")
        self.assertEqual(g["verdict"], "検証済み")
        for x in self.facts_goal("SP-AUTH-013", "guard"):
            self.assertEqual((x["verdict"], x["reason"]), ("未検証", "目標に対応する性質が無い"))
        self.assertEqual((out["counts"]["counterexample"], out["counts"]["verified"]), (1, 1))
        self.assertEqual(out["cex_docs"], [DOC_KEY])

    def test_goalの出所の無い性質は単位自身の行のspanで結び付く(self):
        self._import("cex_span")
        [g] = self.facts_goal("SP-AUTH-012", "guard")
        self.assertEqual(g["verdict"], "反例", "全てが blocking の単位の span の反例は 反例")
        self.assertEqual(g["location"]["item_id"], "SP-AUTH-012", "goal の id が無いときは location の行が入る単位に帰属する")
        mixed = self.facts_goal("SP-AUTH-013", "guard")
        self.assertFalse([x for x in mixed if x["verdict"] in ("反例", "重なり")], "blocking でない目標の混ざる span の反例は blocking に混ぜない")
        self.assertTrue([x for x in mixed if x["verdict"] == "未検証" and "目標に結び付かない反例" in x["reason"]], mixed)

    def test_stateの反例は図の矢印のラベルの項目に帰属する(self):
        self._import("cex_state")
        cex = [g for g in self.facts_goal("SP-AUTH-020", "state") if g["verdict"] == "反例"]
        self.assertEqual(len(cex), 1)
        self.assertEqual(cex[0]["location"]["item_id"], "SP-AUTH-022")
        self.assertEqual(cex[0]["location"]["line"], line_of(SPEC_MD, "(SP-AUTH-022)"))

    def test_原因が対象の欠陥でない反例は未検証(self):
        self._import("cex_model_defect")
        [b] = self.facts_goal("SP-AUTH-011", "bounds")
        self.assertEqual(b["verdict"], "未検証")
        self.assertIn("形式モデルの欠陥", b["reason"])

    def test_変異の無い検証済みは検出能力未確認のまま入る(self):
        self._import("verified_unmutated")
        [d] = self.facts_goal("SP-AUTH-010", "domain")
        self.assertEqual((d["verdict"], d["detection"]), ("検証済み", "検出能力未確認"))
        self.assertIsNotNone(d["assurance"])

    def test_分割を採った結果(self):
        self._import("decomposed")
        [d] = self.facts_goal("SP-AUTH-010", "domain")
        self.assertEqual(d["verdict"], "検証済み")
        [req] = self.fm("facts.json")["requests"]
        self.assertIs(req["decomposition_adopted"], True)
        self.assertEqual((req["rid"], req["outcome"], req["status"]), ("f1a", "result", "完了"))

    def test_目標に結び付かない性質はunverifiedに残る(self):
        def stray(r):
            r["properties"].append({**r["properties"][0], "id": "P9", "sources": [{"kind": "known_requirement", "id": "K-OTHER", "source": None}], "check_ids": [], "verdict": ["未確認"], "assurance": None})
        self._import("verified_unmutated", result_patch=stray)
        self.assertTrue(any("目標に結び付かない性質: P9" in u["item"] for u in self.fm("facts.json")["unverified"]))


class ImportChecks(_W):
    """取り込みの照合と outcome。"""

    def setUp(self):
        super().setUp()
        self.request()

    def _all_unverified_retry(self, outcome):
        units = self.fm("facts.json")["units"]
        self.assertTrue(units)
        for u in units:
            self.assertIs(u["retry"], True, u)
            for g in u["goals"]:
                self.assertEqual(g["verdict"], "未検証")
                self.assertIn(outcome, g["reason"])
        o = self.fm("f1a/outcome.json")
        self.assertEqual(set(o), {"rid", "outcome", "reason", "run_dir", "result_digest", "request_digest"})
        self.assertEqual(o["outcome"], outcome)

    def test_run_dirがW_formalの外ならrejected(self):
        d = self.place_run(root=Path(self._tmp.name) / "elsewhere")
        r = _run(self.ws, "formal-import", "--rid", "f1a", "--run-dir", d)
        self.assertEqual(r.returncode, 0, "どの outcome でも exit 0")
        self.assertEqual(json.loads(r.stdout)["outcome"], "rejected")
        self._all_unverified_retry("rejected")

    def test_依頼の目標が違えばrejected(self):
        out = self.import_(run_dir=self.place_run(request_patch=lambda q: q["goals"].pop()))
        self.assertEqual(out["outcome"], "rejected")
        self._all_unverified_retry("rejected")

    def test_依頼の対象が違えばrejected(self):
        def other(q):
            q["targets"][0]["location"] = str(Path(self._tmp.name) / "other")
        self.assertEqual(self.import_(run_dir=self.place_run(request_patch=other))["outcome"], "rejected")

    def test_結果の対象の指紋が違えばrejected(self):
        def moved(r):
            r["verified_scope"]["targets"][0]["content_hash"] = "sha256:" + "0" * 64
        self.assertEqual(self.import_(run_dir=self.place_run(result_patch=moved))["outcome"], "rejected")

    def test_仮の結果のresult_jsonはrejected(self):
        def prov(r):
            r["provisional"] = True
        self.assertEqual(self.import_(run_dir=self.place_run(result_patch=prov))["outcome"], "rejected")

    def test_unavailableでもrun_dirにresultがあれば取り込む(self):
        out = self.import_(run_dir=self.place_run(), unavailable="no_result")
        self.assertEqual(out["outcome"], "result")

    def test_run_dirに結果が無ければprovisional(self):
        out = self.import_(run_dir=self.place_run(result=None))
        self.assertEqual(out["outcome"], "provisional")
        self._all_unverified_retry("provisional")

    def test_run_dirが無くunavailableならno_result(self):
        out = self.import_(unavailable="no_result")
        self.assertEqual(out["outcome"], "no_result")
        self._all_unverified_retry("no_result")
        [req] = self.fm("facts.json")["requests"]
        self.assertEqual((req["outcome"], req["run_dir"]), ("no_result", None))

    def test_同じridの2回目は何も変えずに前のoutcomeを返す(self):
        first = self.import_(run_dir=self.place_run())
        facts = (self.ws / "fm" / "facts.json").read_bytes()
        second = self.import_(unavailable="no_result")
        self.assertEqual(second, first)
        self.assertEqual((self.ws / "fm" / "facts.json").read_bytes(), facts)

    def test_使い方の誤りはexit2(self):
        r = _run(self.ws, "formal-import", "--rid", "f1a")
        self.assertEqual(r.returncode, 2, "--run-dir も --unavailable も無い")


class Status(_W):
    """formal-status は読むだけで、入口の照合に要る値を出す。"""

    def setUp(self):
        super().setUp()
        self.out = self.request()

    def _status(self):
        return _ok(self.ws, "formal-status", "--rid", "f1a")

    def test_取り込む前(self):
        s = self._status()
        self.assertEqual(s["rid"], "f1a")
        self.assertEqual(s["fnv"], self.out["request_fnv"])
        self.assertIs(s["units_digest_ok"], True)
        self.assertIsNone(s["outcome"])
        self.assertEqual(s["tree_digest_now"], s["tree_digest_request"])
        self.assertEqual(s["tree_digest_request"], self.out["tree_digest"])
        self.assertFalse((self.ws / "fm" / "facts.json").exists(), "読むだけ")

    def test_依頼のファイルが変わればfnvとunits_digest_okが変わる(self):
        p = self.ws / "fm" / "f1a" / "request.json"
        p.write_bytes(p.read_bytes() + b"\n")
        s = self._status()
        self.assertIs(s["units_digest_ok"], False)
        self.assertNotEqual(s["fnv"], self.out["request_fnv"])

    def test_文書が変わればtree_digest_nowが変わる(self):
        self.edit("`件数 > 100 件` のとき", "`件数 > 200 件` のとき")
        s = self._status()
        self.assertNotEqual(s["tree_digest_now"], s["tree_digest_request"])

    def test_取り込んだ後はoutcomeとcountsを出す(self):
        got = self.import_(run_dir=self.place_run())
        s = self._status()
        self.assertEqual((s["outcome"], s["counts"], s["cex_docs"]), (got["outcome"], got["counts"], got["cex_docs"]))


class DocFindings(_W):
    """doc の ST-FORMAL-CEX- と、既存の指摘にしないこと。"""

    def _doc(self):
        out = _ok(self.ws, "doc")
        found = {f["id"]: f for f in json.loads((self.ws / out["path"]).read_text(encoding="utf-8"))["findings"]}
        return out, found

    def _cex(self, found):
        return {k: v for k, v in found.items() if k.startswith("ST-FORMAL-CEX-")}

    def test_反例はblockingの指摘になり書き換えると消える(self):
        before, _ = self._doc()
        self.request()
        self.import_(run_dir=self.place_run(result="cex_goal"))
        out, found = self._doc()
        goal = sorted(g["id"] for g in self.req()["goals"] if g["id"].startswith("SP-AUTH-011.bounds."))[0]
        cex = self._cex(found)
        self.assertEqual(list(cex), [f"ST-FORMAL-CEX-{goal}"])
        f = cex[f"ST-FORMAL-CEX-{goal}"]
        self.assertEqual((f["document"], f["location"]), (DOC_KEY, "SP-AUTH-011"))
        self.assertIn(f["quote"], SPEC_MD)
        self.assertIn("document-structure.md §2.9", f["fix"])
        self.assertEqual(out["blocking"], before["blocking"] + 1, "doc_blocking に数える")
        self.edit("`1 件 ≤ 件数 ≤ 100 件` でなければならない", "`1 件 ≤ 件数 ≤ 200 件` でなければならない")
        _, found = self._doc()
        self.assertEqual(self._cex(found), {}, "単位の digest が今の版と違えば出さない")

    def test_重なりは指摘にならない(self):
        self.request()
        overlap = [g["goal_id"] for g in self.goals("SP-AUTH-013", "guard") if not g["blocking"]][0]

        def to_overlap(r):
            r["properties"][0]["sources"] = [{"kind": "goal", "id": overlap, "source": None}]
            r["counterexamples"][0]["sources"] = [{"kind": "goal", "id": overlap}]
        self.import_(run_dir=self.place_run(result="cex_goal", result_patch=to_overlap))
        [g] = [x for x in self.facts_goal("SP-AUTH-013", "guard") if x["goal_id"] == overlap]
        self.assertEqual(g["verdict"], "重なり")
        _, found = self._doc()
        self.assertEqual(self._cex(found), {})

    def test_入口から変わらない単位の反例も既存の指摘にしない(self):
        _ok(self.ws, "reset", "--keep", "requirements/auth,specifications/auth")
        shutil.copy(FIXTURE / "plan.json", self.ws / "plan.json")
        old, new = "`1 件 ≤ 件数 ≤ 100 件` でなければならない", "`1 件 ≤ 件数 ≤ 200 件` でなければならない"
        self.edit(old, new)
        self.request()
        self.import_(unavailable="no_result")
        self.edit(new, old)  # 入口の本文に戻す（facts の retry で送り直される）
        self.request("f2a", "8")
        self.assertIn(("SP-AUTH-011", "bounds"), self.kinds("f2a"))
        # 規則 2 により f2a で送るのは SP-AUTH-011 の bounds だけなので、011 にだけ当たる反例の結果を使う。
        self.import_("f2a", run_dir=self.place_run("f2a", "cex_bounds", "r2"))
        out, found = self._doc()
        cex = self._cex(found)
        self.assertEqual(len(cex), 1)
        self.assertFalse(any(f.get("preexisting") for f in cex.values()), "ST-FORMAL-CEX- は既存の指摘にしない（NEVER_PREEXISTING）")


class ReviewFixes(_W):
    """差分の検証の指摘を直した後の振る舞い（決めた直し方の 1・2・3・5・6・7・8 の LOW 2）。"""

    UNRESOLVED = "#### SP-AUTH-015 種別の扱い\n\n`種別 = 特別` のとき、システムは記録を残さなければならない。\n"

    def _section(self, *extra):
        _ok(self.ws, "report", "--findings", "", *extra)
        text = (self.ws / "report.md").read_text(encoding="utf-8")
        start = text.index("## 形式検証")
        end = text.find("\n## ", start + 1)
        return text[start: end if end >= 0 else len(text)]

    def _unverified_part(self, sec):
        self.assertIn("### 未検証として残したもの", sec)
        part = sec.split("### 未検証として残したもの", 1)[1]
        return part.split("\n### ", 1)[0]

    # 1
    def test_送る単位が0でも名前を解けない式はfactsとreportに残る(self):
        base = (FIXTURE / DOC_FILE).read_text(encoding="utf-8")
        (self.ws / DOC_FILE).write_text(base.replace("## トレーサビリティ表", self.UNRESOLVED + "\n## トレーサビリティ表"), encoding="utf-8")
        out = self.request()
        self.assertEqual(out["goals"], 0)
        self.assertIn(("SP-AUTH-015", "名前を解けない: 種別"), self.unsent(out))
        facts = self.fm("facts.json")
        self.assertTrue(any("SP-AUTH-015" in u["item"] and "名前を解けない: 種別" in u["reason"] for u in facts["unverified"]), facts["unverified"])
        part = self._unverified_part(self._section())
        self.assertIn("SP-AUTH-015", part)
        self.assertIn("名前を解けない: 種別", part)

    def test_existingで送る単位が0でもunsentはreportに残る(self):
        _ok(self.ws, "reset", "--keep", "requirements/auth,specifications/auth")
        shutil.copy(FIXTURE / "plan.json", self.ws / "plan.json")
        out = self.request("f2a", "8")
        self.assertEqual(out["goals"], 0, "入口から変わらない単位は送らない")
        part = self._unverified_part(self._section())
        self.assertIn("SP-AUTH-015", part)
        self.assertIn("SP-AUTH-016", part)

    # 2
    def _idless_state(self):
        start = SPEC_MD.index("#### SP-AUTH-020 承認の状態")
        end = SPEC_MD.index("#### SP-AUTH-021")
        body = SPEC_MD[start:end].replace("#### SP-AUTH-020 承認の状態\n\n", "").replace("> 条件の値: 金額 = SP-AUTH-010\n\n", "")
        return SPEC_MD[:start] + body + SPEC_MD[end:]

    def test_IDの無い節のガード付きの状態図は単位にせずunsentで開示しNONDETを抑えない(self):
        md = self._idless_state()
        self.assertNotIn("SP-AUTH-020", md)
        (self.ws / DOC_FILE).write_text(md, encoding="utf-8")
        out = self.request()
        self.assertFalse([k for k in self.kinds() if k[1] == "state"], "ID の無い節の図は単位にしない")
        state_unsent = [u for u in out["unsent"] if u["kind"] == "state"]
        self.assertEqual(len(state_unsent), 1, out["unsent"])
        self.assertTrue(state_unsent[0]["reason"])
        found = GuardedStates()._ids(md)
        self.assertIn(f"ST-STATE-NONDET-{DOC_KEY}-承認待ち-E2", [f["id"] for f in found], "単位にならない図の非決定は抑えない")

    # 3
    def test_1つの項目の別の量の制約は別の単位になり片方の反例も指摘になる(self):
        two = ("#### SP-AUTH-019 待ちと再試行\n\n"
               "システムは、`1 秒 ≤ 待ち時間 ≤ 3 秒` でなければならない。\n"
               "システムは、`0 回 ≤ 再試行 ≤ 5 回` でなければならない。\n\n")
        (self.ws / DOC_FILE).write_text(SPEC_MD.replace("## 状態とイベント", two + "## 状態とイベント"), encoding="utf-8")
        self.request()
        bounds = [u for u in self.units()["units"] if u["item_id"] == "SP-AUTH-019" and u["kind"] == "bounds"]
        self.assertEqual(len(bounds), 2, "量ごとに別の単位")
        self.assertEqual(len({u["unit_digest"] for u in bounds}), 2)
        second = sorted(g["goal_id"] for u in bounds for g in u["goals"])[1]

        def to_second(r):
            r["properties"][0]["sources"] = [{"kind": "goal", "id": second, "source": None}]
            r["counterexamples"][0]["sources"] = [{"kind": "goal", "id": second}]
        self.import_(run_dir=self.place_run(result="cex_bounds", result_patch=to_second))
        facts = [u for u in self.fm("facts.json")["units"] if u["item_id"] == "SP-AUTH-019" and u["kind"] == "bounds"]
        self.assertEqual(len(facts), 2, "facts でも 2 つの単位が上書きし合わない")
        out = _ok(self.ws, "doc")
        found = {f["id"] for f in json.loads((self.ws / out["path"]).read_text(encoding="utf-8"))["findings"]}
        self.assertIn(f"ST-FORMAL-CEX-{second}", found)

    # 5
    def test_boundsは固定の文書の同じ量の制約を依存に入れ固定の文書は単位にしない(self):
        req = self.ws / "requirements-auth.md"
        req.write_text(req.read_text(encoding="utf-8") + "\n#### PR-AUTH-004 件数の上限\n\nシステムは、`1 件 ≤ 件数 ≤ 500 件` でなければならない。\n", encoding="utf-8")
        meta = self.ws / "requirements-auth.meta.json"
        m = json.loads(meta.read_text(encoding="utf-8"))
        m["fixed"] = True
        meta.write_text(json.dumps(m, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")  # 台帳の正規形
        self.request()
        units = self.units()["units"]
        self.assertFalse([u for u in units if u["doc"] == "requirements/auth"], "固定の文書の項目は単位にしない")
        [b] = [u for u in units if u["item_id"] == "SP-AUTH-011" and u["kind"] == "bounds"]
        self.assertTrue(any("PR-AUTH-004" in str(d) for d in b["deps"]), b["deps"])
        target = Path(self.req()["targets"][0]["location"])
        self.assertTrue((target / "requirements-auth.md").exists(), "依存を持つ固定の文書も写す")

    # 6
    def test_帰属が別の文書の単位の行ならその文書にその文書の行のquoteで出る(self):
        req = self.ws / "requirements-auth.md"
        guard = "`件数 > 200 件` のとき、システムは要求を拒否しなければならない。"
        req.write_text(req.read_text(encoding="utf-8") + f"\n#### PR-AUTH-004 件数の超過\n\n{guard}\n", encoding="utf-8")
        self.request()
        [ru] = [u for u in self.units()["units"] if u["doc"] == "requirements/auth"]
        file, span = ru["lines"][0]["file"], ru["lines"][0]["span"]
        goal = sorted(g["id"] for g in self.req()["goals"] if g["id"].startswith("SP-AUTH-011.bounds."))[0]

        def elsewhere(r):
            r["counterexamples"][0]["sources"] = [{"kind": "location", "target_id": "prd-spec", "file": file, "span": span}]
        self.import_(run_dir=self.place_run(result="cex_bounds", result_patch=elsewhere))
        out = _ok(self.ws, "doc")
        found = json.loads((self.ws / out["path"]).read_text(encoding="utf-8"))["findings"]
        [f] = [x for x in found if x["id"] == f"ST-FORMAL-CEX-{goal}"]
        self.assertEqual((f["document"], f["location"]), ("requirements/auth", "PR-AUTH-004"))
        self.assertIn(f["quote"], req.read_text(encoding="utf-8"))
        self.assertIn("件数 > 200 件", f["quote"])

    # 再検証の後に決めた直し方 1
    def test_reportの送らなかった式は今の文書から求め直す(self):
        self.request()
        self.import_(run_dir=self.place_run(result="verified_unmutated"))
        # formal-request を走らせない段（延長の 2 回目の段 8 など）の後に、本文に足された式。
        self.edit("## 状態とイベント", "#### SP-AUTH-017 再試行の目安\n\nシステムは、`再試行 ≤ 3 回` を目安にする。\n\n"
                  "#### SP-AUTH-024 区分の扱い\n\n`区分 = 特別` のとき、システムは通知しなければならない。\n\n## 状態とイベント")
        part = self._unverified_part(self._section())
        self.assertIn("SP-AUTH-017", part)
        self.assertIn("制約か条件か決まらない", part)
        self.assertIn("SP-AUTH-024", part)
        self.assertIn("名前を解けない: 区分", part)
        self.assertIn("SP-AUTH-015", part, "前からある送らなかった式も載る")

    # 再検証の後に決めた直し方 2
    def test_cex_docsは反例の帰属の文書(self):
        req = self.ws / "requirements-auth.md"
        req.write_text(req.read_text(encoding="utf-8") + "\n#### PR-AUTH-004 件数の超過\n\n`件数 > 200 件` のとき、システムは要求を拒否しなければならない。\n", encoding="utf-8")
        self.request()
        [ru] = [u for u in self.units()["units"] if u["doc"] == "requirements/auth"]
        file, span = ru["lines"][0]["file"], ru["lines"][0]["span"]

        def elsewhere(r):
            r["counterexamples"][0]["sources"] = [{"kind": "location", "target_id": "prd-spec", "file": file, "span": span}]
        out = self.import_(run_dir=self.place_run(result="cex_bounds", result_patch=elsewhere))
        self.assertEqual(out["cex_docs"], ["requirements/auth"], "差し戻すのは ST-FORMAL-CEX- が出る文書の writer")
        [b] = self.facts_goal("SP-AUTH-011", "bounds")
        self.assertEqual(b["location"]["doc"], "requirements/auth", "location は { doc, item_id, line }")
        self.assertEqual(_ok(self.ws, "formal-status", "--rid", "f1a")["cex_docs"], ["requirements/auth"])

    # 7
    def test_formal_offを実行していなくても渡された値で行わなかったと書く(self):
        self.assertFalse((self.ws / "fm" / "off.json").exists())
        sec = self._section("--formal-off", "host_unsupported")
        first = next(l for l in sec.split("\n")[1:] if l.strip())
        self.assertIn("形式検証は行わなかった（host_unsupported）", first)

    # 8 の LOW 2
    def test_直した後の新しいridの取り込みで古いridのunsentはreportから消える(self):
        self.request()
        self.import_(unavailable="no_result")
        self.assertIn("名前を解けない: 種別", self._unverified_part(self._section()))
        self.edit("#### SP-AUTH-015 種別の扱い\n", "#### SP-AUTH-015 種別の扱い\n\n> 条件の値: 種別 = 特別 / 通常\n")
        self.request("f2a", "8")
        self.assertIn(("SP-AUTH-015", "guard"), self.kinds("f2a"))
        self.import_("f2a", unavailable="no_result")
        self.assertNotIn("名前を解けない: 種別", self._unverified_part(self._section()), "直した単位の古い rid の unsent を載せ続けない")


class ReportAndOwnership(_W):
    """report の節、fm/off.json の区別、所有表と reset。"""

    def _section(self):
        _ok(self.ws, "report", "--findings", "")
        text = (self.ws / "report.md").read_text(encoding="utf-8")
        self.assertIn("## 形式検証", text)
        start = text.index("## 形式検証")
        end = text.find("\n## ", start + 1)
        return text[start: end if end >= 0 else len(text)]

    def test_reportは依頼ごとのoutcomeと目標ごとの判定と未検証と事実の無い単位を載せる(self):
        self.request()
        self.import_(run_dir=self.place_run(result="cex_goal"))
        self.edit("> 条件の値: 経路 = 甲 / 乙", "> 条件の値: 経路 = 甲 / 乙 / 丙")  # SP-AUTH-018 は今の版で事実が無い
        sec = self._section()
        self.assertIn("f1a", sec)
        self.assertIn("result", sec)
        goal = sorted(g["id"] for g in self.req()["goals"] if g["id"].startswith("SP-AUTH-011.bounds."))[0]
        self.assertIn(goal, sec)
        self.assertIn("反例", sec)
        self.assertIn("目標に対応する性質が無い", sec)
        self.assertIn("SP-AUTH-018", sec)
        self.assertIn("SP-AUTH-015", sec, "送らなかった単位（unsent）も未検証として載せる")
        self.assertNotIn("形式検証は行わなかった", sec)

    def test_formal_offは行わなかったと書き結果の無い依頼と分ける(self):
        _ok(self.ws, "formal-off", "--reason", "skill_missing")
        self.assertTrue((self.ws / "fm" / "off.json").exists())
        sec = self._section()
        first = next(l for l in sec.split("\n")[1:] if l.strip())
        self.assertIn("形式検証は行わなかった（skill_missing）", first, "節の最初に書く")

    def test_no_resultの依頼は行わなかったとは書かない(self):
        self.request()
        self.import_(unavailable="no_result")
        sec = self._section()
        self.assertIn("no_result", sec)
        self.assertNotIn("形式検証は行わなかった", sec)

    def test_resetはfmを消しoff_jsonを残す(self):
        self.request()
        self.import_(unavailable="no_result")
        _ok(self.ws, "formal-off", "--reason", "host_unsupported")
        _ok(self.ws, "reset", "--keep", "requirements/auth,specifications/auth")
        self.assertEqual(sorted(p.relative_to(self.ws / "fm").as_posix() for p in (self.ws / "fm").rglob("*")), ["off.json"])

    def test_fmのファイルは所有表に合いstrayに出ない(self):
        self.request()
        self.import_(run_dir=self.place_run())
        _ok(self.ws, "formal-off", "--reason", "skill_missing")
        out = _ok(self.ws, "tree-digest")
        listed = json.loads((self.ws / out["stray"]["path"]).read_text(encoding="utf-8"))["stray"]
        self.assertEqual([s for s in listed if str(s).startswith("fm/")], [], listed)
        self.assertTrue((self.ws / "fm" / "f1a" / "target" / DOC_FILE).exists())


if __name__ == "__main__":
    unittest.main()
