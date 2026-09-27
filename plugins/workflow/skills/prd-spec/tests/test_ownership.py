"""W のファイルの所有と、コピー・版管理の禁止のテスト。

1. snapshot・tree-digest の stray は、契約の所有表から実行時に読んだパターンで決まる。表に無いファイル（版の控え・
   残った作業用の script）が出て、表に合うファイル（checks/INDEX など）は出ない。--live の label の tmp は出ない
2. doc_check は所有表の写しを持たない（表を変えれば結果が変わり、表が読めなければ止まる）
3. コピー・版管理の禁止は契約の「共通の約束」に 1 回だけあり、台帳を Write / Edit で書かせる指示が残っていない
4. 契約の resolutions.json の例が put と questions を通る。候補の数の上限は doc_check にだけある
5. doc_check の中で、台帳のファイル名は LEDGERS と writeCheck の引数にしか無い
"""

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
DOC_CHECK = SKILL / "scripts" / "doc_check.mjs"
CONTRACTS = SKILL / "schemas" / "agent-contracts.md"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "workspace"
SOURCE = DOC_CHECK.read_text(encoding="utf-8")
LEDGER_FILES = re.findall(r"file: \(\) => '([^']+)'", SOURCE)


def _run(ws, mode, *args, stdin=None, doc_check=DOC_CHECK):
    return subprocess.run(
        ["node", str(doc_check), mode, *args, "--workspace", str(ws)],
        input=None if stdin is None else json.dumps(stdin, ensure_ascii=False),
        capture_output=True,
        text=True,
    )


def _ok(ws, mode, *args, stdin=None, doc_check=DOC_CHECK):
    r = _run(ws, mode, *args, stdin=stdin, doc_check=doc_check)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


def _stray_list(ws, out):
    listed = json.loads((Path(ws) / out["stray"]["path"]).read_text(encoding="utf-8"))["stray"]
    assert out["stray"]["count"] == len(listed), out
    return listed


def _section(text, heading):
    start = text.index(f"\n{heading}\n")
    end = text.find("\n## ", start + 1)
    return text[start : end if end >= 0 else len(text)]


def _touch(ws, rel, text=""):
    p = Path(ws) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


STRAY = ["requirements-auth.pre2.md", "resolutions.pre6.json", "tmp/resolver__3a/apply3a.py"]
OWNED = [
    "checks/INDEX.requirements.md",
    "checks/audited-1.snapshot.json",
    "answers/g0-2.md",
    "findings/r2-gr-requirements__auth-extra.json",
    "questions.md",
    "questions.json",
    "report.md",
    "precedent.json",
]


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class Stray(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name) / "W"
        shutil.copytree(FIXTURE, self.ws)
        for rel in STRAY + OWNED:
            _touch(self.ws, rel)

    def tearDown(self):
        self._tmp.cleanup()

    def test_所有表に無いファイルだけがstrayに出る(self):
        self.assertEqual(_stray_list(self.ws, _ok(self.ws, "snapshot", "--save", "x")), STRAY)
        self.assertEqual(_stray_list(self.ws, _ok(self.ws, "tree-digest")), STRAY)

    def test_liveのlabelの作業用ディレクトリは出ない(self):
        out = _ok(self.ws, "snapshot", "--save", "audited-1", "--role", "auditor", "--live", "grounding__r1__x,resolver__3a")
        self.assertEqual(_stray_list(self.ws, out), [s for s in STRAY if not s.startswith("tmp/")])
        self.assertIn("tmp/resolver__3a/apply3a.py", _stray_list(self.ws, _ok(self.ws, "tree-digest", "--live", "resolver__3b")))


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class OwnershipComesFromContract(unittest.TestCase):
    """doc_check と契約を一時の SKILL_DIR に写し、契約の表だけを変えて結果が追従することを見る。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        (root / "skill" / "scripts").mkdir(parents=True)
        (root / "skill" / "schemas").mkdir()
        self.doc_check = root / "skill" / "scripts" / "doc_check.mjs"
        shutil.copy(DOC_CHECK, self.doc_check)
        self.contract = root / "skill" / "schemas" / "agent-contracts.md"
        self.ws = root / "W"
        shutil.copytree(FIXTURE, self.ws)
        _touch(self.ws, "extra.txt")

    def tearDown(self):
        self._tmp.cleanup()

    def _stray(self):
        return _stray_list(self.ws, _ok(self.ws, "tree-digest", doc_check=self.doc_check))

    def test_表に行を足すとそのファイルはstrayでなくなる(self):
        text = CONTRACTS.read_text(encoding="utf-8")
        self.contract.write_text(text, encoding="utf-8")
        self.assertEqual(self._stray(), ["extra.txt"])
        row = "| `findings/r<n>-<役>-<文書>.json` |"
        self.assertIn(row, text)
        self.contract.write_text(text.replace(row, "| `extra.txt` | 試験 | — | — |\n" + row, 1), encoding="utf-8")
        self.assertEqual(self._stray(), [])

    def test_表が読めなければ止まる(self):
        text = CONTRACTS.read_text(encoding="utf-8").replace("## W のファイルと書き手", "## 見出しを変えた", 1)
        self.contract.write_text(text, encoding="utf-8")
        r = _run(self.ws, "tree-digest", doc_check=self.doc_check)
        self.assertEqual(r.returncode, 1)
        self.assertIn("所有表", r.stderr)

    def test_prd_jsの作業用ディレクトリは所有表の行と同じ形(self):
        self.assertIn("| `tmp/<label>/` |", CONTRACTS.read_text(encoding="utf-8"))
        self.assertIn("/tmp/${fileKey(label)}/", (SKILL / "scripts" / "prd.js").read_text(encoding="utf-8"))

    def test_プロンプトが指す節は契約の見出しにある(self):
        src = (SKILL / "scripts" / "prd.js").read_text(encoding="utf-8")
        common = re.search(r"const COMMON_SECTIONS = \[(.*?)\]", src).group(1)
        per_role = re.search(r"const CONTRACT_SECTIONS = \{(.*?)\n\}", src, re.S).group(1)
        names = set(re.findall(r"'([^']+)'", common + per_role))
        headings = set(re.findall(r"^## (.+)$", CONTRACTS.read_text(encoding="utf-8"), re.M))
        self.assertIn("W のファイルと書き手", names)
        self.assertEqual(names - headings, set())
        self.assertIn(f"'## {'W のファイルと書き手'}'", SOURCE)

    def test_見出しがあっても表が無ければ止まる(self):
        text = CONTRACTS.read_text(encoding="utf-8")
        sec = _section(text, "## W のファイルと書き手")
        body = "\n".join(l for l in sec.splitlines() if not l.startswith("|"))
        self.contract.write_text(text.replace(sec, body, 1), encoding="utf-8")
        r = _run(self.ws, "tree-digest", doc_check=self.doc_check)
        self.assertEqual(r.returncode, 1)
        self.assertIn("所有表", r.stderr)

    def test_見出しが無ければ後ろの表を読みに行かず止まる(self):
        text = CONTRACTS.read_text(encoding="utf-8").replace("## W のファイルと書き手", "W のファイルと書き手（見出しでない）", 1)
        self.contract.write_text("| `extra.txt` | 最初の見出しより前の表 |\n\n" + text, encoding="utf-8")
        r = _run(self.ws, "tree-digest", doc_check=self.doc_check)
        self.assertEqual(r.returncode, 1)
        self.assertIn("所有表", r.stderr)

    def test_doc_checkは所有表の写しを持たない(self):
        for literal in ("precedent.json", "answers/g0", "findings/r", "W_FILES", "'tmp", "`tmp"):
            self.assertNotIn(literal, SOURCE)


class CopyBanLivesInOnePlace(unittest.TestCase):
    PHRASE = "コピーと版管理をせず"

    def _texts(self):
        files = [*SKILL.glob("*.md"), *SKILL.glob("agents/*.md"), *SKILL.glob("schemas/*.md"), *SKILL.glob("references/*.md"), *SKILL.glob("scripts/*")]
        return {p: p.read_text(encoding="utf-8") for p in files if p.is_file()}

    def test_禁止の文は共通の約束に1回だけある(self):
        hits = {p: t.count(self.PHRASE) for p, t in self._texts().items() if self.PHRASE in t}
        self.assertEqual(hits, {CONTRACTS: 1})
        self.assertIn(self.PHRASE, _section(CONTRACTS.read_text(encoding="utf-8"), "## 共通の約束"))

    def test_役のファイルに写しや例外が無い(self):
        for p in SKILL.glob("agents/*.md"):
            text = p.read_text(encoding="utf-8")
            for bad in ("版ごとのコピー", "一括置換", "W/tmp/"):
                self.assertNotIn(bad, text, p.name)

    def test_台帳をWriteやEditで書かせる行が無い(self):
        names = [*LEDGER_FILES, "meta"]
        for p in [SKILL / "SKILL.md", *SKILL.glob("agents/*.md")]:
            for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                if re.search(r"\b(Write|Edit)\b", line):
                    self.assertFalse([x for x in names if x in line], f"{p.name}:{n}: {line}")


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class ContractExampleMatchesImplementation(unittest.TestCase):
    EVIDENCE_ROOT = "/repo/"

    def _example(self):
        text = CONTRACTS.read_text(encoding="utf-8")
        m = re.search(r"\*\*resolutions\.json\*\*[^\n]*\n\n```json\n(.*?)\n```", text, re.S)
        return json.loads(m.group(1))

    def test_契約の例がputとquestionsを通る(self):
        body = self._example()
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "W"
            shutil.copytree(FIXTURE, ws)
            for r in body["resolutions"]:
                if "answer" in r:
                    _touch(ws, r["answer"]["path"], f"{r['id']}: {r['answer']['quote']}\n")
                for e in r.get("evidence", []):
                    self.assertTrue(e["file"].startswith(self.EVIDENCE_ROOT), e["file"])
                    e["file"] = str(Path(td) / "repo" / e["file"][len(self.EVIDENCE_ROOT) :])
                    lines = [""] * max(e["line"], e.get("end", e["line"]))
                    lines[e["line"] - 1] = e["quote"]
                    _touch(td, e["file"], "\n".join(lines) + "\n")
            _ok(ws, "put", "--ledger", "resolutions", stdin=body)
            asked = [r["id"] for r in body["resolutions"] if "question" in r]
            self.assertTrue(asked)
            self.assertEqual(_ok(ws, "questions", "--ids", ",".join(asked))["questions"], len(asked))
            self.assertEqual(_ok(ws, "report")["holds"], sum(1 for r in body["resolutions"] if r["ruling"] == "hold"))

    def test_候補の数の上限はdoc_checkにだけある(self):
        self.assertRegex(SOURCE, r"const QUESTION_OPTIONS = \{ min: \d+, max: \d+ \}")
        for p in [CONTRACTS, *SKILL.glob("agents/*.md"), *SKILL.glob("references/*.md"), SKILL / "SKILL.md"]:
            self.assertIsNone(re.search(r"2\s*[〜～\-]\s*4\s*個", p.read_text(encoding="utf-8")), p.name)


class LimitsLiveInDocCheck(unittest.TestCase):
    """欄の字数の上限は置かない。分量の目安（SIZE_BUDGET）の数値は doc_check にだけあり、契約・agents・文書には写さない。"""

    def _numbers(self, const):
        block = re.search(rf"const {const} = \{{(.*?)\}}", SOURCE, re.S).group(1)
        return {int(n) for n in re.findall(r":\s*(\d+)", block)}

    def test_数値は契約とagentsに無い(self):
        nums = self._numbers("SIZE_BUDGET")
        self.assertGreater(len(nums), 7)
        files = [CONTRACTS, SKILL / "SKILL.md", *SKILL.glob("agents/*.md"), *SKILL.glob("schemas/*.md"), *SKILL.glob("references/*.md")]
        for p in files:
            text = p.read_text(encoding="utf-8").replace(",", "")
            for n in nums:
                self.assertIsNone(re.search(rf"(?<![\d.]){n}\s*(字|バイト|bytes?)", text), f"{p.name}: {n}")

    def test_欄の字数の上限を持たない(self):
        self.assertNotIn("FIELD_LIMITS", SOURCE)
        common = _section(CONTRACTS.read_text(encoding="utf-8"), "## 共通の約束")
        self.assertIn("必要最低限で書く", common)
        self.assertIsNone(re.search(r"\d+\s*字", common))


class LedgerFileNamesComeFromLedgers(unittest.TestCase):
    def test_台帳のファイル名はLEDGERSとwriteCheckの外に無い(self):
        self.assertEqual(len(LEDGER_FILES), 6)
        lines = SOURCE.splitlines()
        start = lines.index("const LEDGERS = {")
        end = lines.index("}", start)
        for n, line in enumerate(lines, 1):
            if start < n <= end + 1 or line.lstrip().startswith("//") or "writeCheck(" in line:
                continue
            for name in [*LEDGER_FILES, ".meta.json"]:
                self.assertNotIn(name, line, f"doc_check.mjs:{n}: {line}")


if __name__ == "__main__":
    unittest.main()
