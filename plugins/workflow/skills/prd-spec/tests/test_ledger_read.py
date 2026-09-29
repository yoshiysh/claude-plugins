"""scripts/doc_check.mjs の読むだけのモード（get・describe）と、--ledger の名前の誤りのテスト。

1. get は台帳の要素を選ぶだけで加工しない。無い ID は missing、stdout の上限に入らない ID は over_budget に出し、黙って落とさない
2. get と describe は W に何も書かない（台帳が無くても作らない）
3. describe は LEDGERS から導出する（写しを持たない）
4. --ledger にファイル名を渡すと、token の検査より前に台帳の名前の一覧を出して exit 1 になり、何も書かない
5. prd-spec.js のプロンプトが渡す --ledger の名前は LEDGERS のキーだけ
6. 契約は input.md を全文読む役と台帳の読み方を役ごとに宣言し、その規則は agents などに写さない
"""

import hashlib
import json
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prd_script import PRD_PATH as PRD  # noqa: E402
from test_ledger import CONTRACTS, DOC_CHECK, SKILL, _exported, _ok, _run, _Workspace  # noqa: E402


def _tree(ws):
    return {str(p.relative_to(ws)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ws.rglob("*")) if p.is_file()}


def _raw(ws, *args):
    return subprocess.run(["node", str(DOC_CHECK), *args, "--workspace", str(ws)], capture_output=True, text=True)


TRICKY = {
    "id": "RS-001",
    "about": {"open": "O-001"},
    "ruling": "internal",
    "value": {"a": "  前後に空白 \n改行\t", "b": [1, {"c": "日本語", "d": None}], "e": ""},
    "why": " 前後に空白のある理由 ",
}


class Get(_Workspace):
    def _file(self, name):
        return json.loads((self.ws / name).read_text())

    def test_要素を加工せずに返し無いIDはmissingに出す(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [TRICKY]})
        out = _ok(self.ws, "get", "--ledger", "resolutions", "--ids", "RS-001,RS-404")
        self.assertEqual(out["resolutions"], self._file("resolutions.json")["resolutions"])
        self.assertEqual((out["missing"], out["over_budget"]), (["RS-404"], []))

    def test_配列が複数ある台帳はどの配列の要素も引く(self):
        out = _ok(self.ws, "get", "--ledger", "flow", "--ids", "F-004,F-002")
        els = {e["id"]: e for e in self._file("flow.json")["elements"]}
        self.assertEqual(out["elements"], [els["F-004"], els["F-002"]])
        self.assertEqual(out["kinds"], [])

    def test_metaのtraceは同じitem_idの行をすべて返す(self):
        rows = [{"item_id": "PR-AUTH-001", "kind": "input", "quote": "ログイン"}, {"item_id": "PR-AUTH-001", "kind": "flow", "ref": "F-002"}]
        _ok(self.ws, "put", "--ledger", "meta", "--doc", "requirements/auth", stdin={"trace": rows})
        out = _ok(self.ws, "get", "--ledger", "meta", "--doc", "requirements/auth", "--ids", "PR-AUTH-001")
        stored = [t for t in self._file("requirements-auth.meta.json")["trace"] if t["item_id"] == "PR-AUTH-001"]
        self.assertEqual((len(out["trace"]), out["trace"]), (2, stored))

    def test_fieldsは欄を絞りキーを残し値は加工しない(self):
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": [TRICKY]})
        out = _ok(self.ws, "get", "--ledger", "resolutions", "--ids", "RS-001", "--fields", "value")
        stored = self._file("resolutions.json")["resolutions"][0]
        self.assertEqual(out["resolutions"], [{"id": "RS-001", "value": stored["value"]}])

    def test_台帳の欄に無いfieldsは一覧を出して止まる(self):
        r = _run(self.ws, "get", "--ledger", "flow", "--ids", "F-001", "--fields", "label,nope")
        self.assertEqual(r.returncode, 1)
        self.assertIn("nope", r.stderr)
        for f in _exported("m.LEDGERS.flow.fields.elements"):
            self.assertIn(f, r.stderr)

    def test_getとdescribeは何も書かず無い台帳も作らない(self):
        before = _tree(self.ws)
        out = _ok(self.ws, "get", "--ledger", "resolutions", "--ids", "RS-001")
        self.assertEqual((out["exists"], out["missing"]), (False, ["RS-001"]))
        _ok(self.ws, "get", "--ledger", "flow", "--ids", "F-001")
        _ok(self.ws, "describe")
        self.assertEqual(_tree(self.ws), before)

    def test_大きな台帳でもstdoutは上限の内で_入らないIDはover_budgetに出す(self):
        # 実 run の台帳は手元に無いので、再試走の resolutions.json（約 364K）と同じ桁の合成の台帳で測る。
        why = "この裁定は依頼文の範囲と既存の決定に照らして内部で決めたものであり、利用者の操作と記録の保存に関わる。" * 3
        items = [{"id": f"RS-{i:03d}", "about": {"open": f"O-{i:03d}"}, "ruling": "internal", "value": f"値 {i} " + "あ" * 40, "why": why} for i in range(1, 601)]
        _ok(self.ws, "put", "--ledger", "resolutions", stdin={"resolutions": items})
        self.assertGreater((self.ws / "resolutions.json").stat().st_size, 300_000)
        # 無い ID に仮名・漢字を混ぜ、上限をバイトで数えていることまで押さえる（文字数で数えると ID の分だけ上限を超える）。
        asked = [x["id"] for x in items] + ["RS-999"] + [f"存在しない裁定の番号-{i}" for i in range(300)]
        r = _run(self.ws, "get", "--ledger", "resolutions", "--ids", ",".join(asked))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLess(len(r.stdout.encode()), _exported("m.STDOUT_BUDGET"))
        out = json.loads(r.stdout)
        got = [x["id"] for x in out["resolutions"]]
        self.assertTrue(got and out["over_budget"])
        self.assertEqual(sorted(got + out["missing"] + out["over_budget"]), sorted(asked))
        self.assertEqual(len(set(got) | set(out["missing"]) | set(out["over_budget"])), len(asked))
        stored = {x["id"]: x for x in self._file("resolutions.json")["resolutions"]}
        self.assertEqual(out["resolutions"], [stored[i] for i in got])


class Describe(unittest.TestCase):
    def _describe(self, mutate=""):
        code = (f"import * as m from {json.dumps(DOC_CHECK.as_uri())}; {mutate}"
                "console.log(JSON.stringify(m.runWorkspace('describe', [])))")
        r = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, check=True)
        return json.loads(r.stdout)

    def test_LEDGERSの名前と欄とモードを出す(self):
        d = self._describe()
        names = _exported("Object.keys(m.LEDGERS)")
        self.assertEqual(list(d["ledgers"]), names)
        for n in names:
            self.assertEqual(d["ledgers"][n]["fields"], _exported(f"m.LEDGERS[{json.dumps(n)}].fields"))
            self.assertEqual(d["ledgers"][n]["lists"], _exported(f"m.LEDGERS[{json.dumps(n)}].lists"))
        self.assertEqual(d["ledgers"]["resolutions"]["file"], "resolutions.json")
        self.assertEqual(d["modes"], _exported("m.WS_MODES"))
        self.assertIn("FLOW_NOSOURCE", d["finding_codes"])

    def test_LEDGERSを変えると出力が変わる(self):
        d = self._describe("m.LEDGERS.decisions.fields.decisions.push('zz_new'); m.LEDGERS.extra = { file: () => 'extra.json', lists: { rows: 'id' }, scalars: {} };")
        self.assertIn("zz_new", d["ledgers"]["decisions"]["fields"]["decisions"])
        self.assertEqual(d["ledgers"]["extra"]["file"], "extra.json")


class WrongLedgerName(_Workspace):
    def test_ファイル名を渡すとtokenの前に台帳の名前の一覧を出して何も書かない(self):
        names = _exported("Object.keys(m.LEDGERS)")
        before = _tree(self.ws)
        for mode, arg, want in (("put", "resolutions.json", "resolutions"), ("del", "flow.json", "flow"), ("put", "requirements-auth.meta.json", "meta")):
            with self.subTest(mode=mode, arg=arg):
                r = subprocess.run(["node", str(DOC_CHECK), mode, "--ledger", arg, "--ids", "X", "--workspace", str(self.ws)], input="{}", capture_output=True, text=True)
                self.assertEqual(r.returncode, 1)
                self.assertIn(f"--ledger {want} ", r.stderr)
                for n in names:
                    self.assertIn(n, r.stderr)
        self.assertEqual(_tree(self.ws), before)


class PromptLedgerNames(unittest.TestCase):
    def test_プロンプトの_ledger_はLEDGERSのキーだけ(self):
        src = PRD.read_text(encoding="utf-8")
        used = set(re.findall(r"--ledger ([^\s`\\]+)", src)) | set(re.findall(r"(?:getCli|put)\('([^']+)'", src))
        self.assertTrue(used)
        self.assertEqual(used - {"<台帳>", "${ledger}"}, used & set(_exported("Object.keys(m.LEDGERS)")))


class InputReadersInContract(unittest.TestCase):
    ROLE_ROW = re.compile(r"^  \| ([a-z-]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$", re.M)

    def _rows(self):
        return {m.group(1): m.group(2).strip() for m in self.ROLE_ROW.finditer(CONTRACTS.read_text(encoding="utf-8"))}

    def test_全ての役がinput_mdの読み方を宣言しresolver_verifierとgroundingは全文(self):
        rows = self._rows()
        self.assertEqual(set(rows), {p.stem for p in (SKILL / "agents").glob("*.md")})
        for role in ("resolver-verifier", "grounding"):
            self.assertTrue(rows[role].startswith("全文"), role)

    def test_読み方の規則はagentsとreferencesとSKILLに写さない(self):
        text = CONTRACTS.read_text(encoding="utf-8")
        start = text.index("- **台帳の中身は `get")
        body = text[start : text.index("- **1 つのファイルを現行として", start)]
        cut = re.compile(r"`[^`]*`|[\w.-]*/[\w./-]+|[、。（）()「」『』:：;；|\n]")
        clauses = {c for c in (re.sub(r"[\s*]", "", x) for x in cut.split(body)) if len(re.findall(r"[぀-ヿ一-鿿]", c)) >= 8}
        self.assertTrue(clauses)
        paths = [*(SKILL / "agents").glob("*.md"), *(SKILL / "references").glob("*.md"), SKILL / "SKILL.md"]
        found = [(p.name, c) for p in paths for c in clauses if c in re.sub(r"[\s*]", "", p.read_text(encoding="utf-8"))]
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
