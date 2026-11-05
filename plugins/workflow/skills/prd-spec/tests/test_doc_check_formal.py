"""scripts/doc_check.mjs の formal-check・formal-digest・formal-tools のテスト。

formal-check は formal-modeler が W/formal/<kind>-<topic>/ に書いたモジュール 1 つと manifest を、doc_check が manifest と SANY の AST から
作った cfg と変異で、固定の argv の TLC に流して合否を決める。modeler の書ける面は TLA+ の本文と manifest だけで、判定に要る事実（性質の段・
参照の閉包・CONSTANT の宣言）は AST から取る。押さえるのは次のとおり。

1. 合格するモデルは指摘も欠陥も 0 件。不変条件の違反（exit 12）は、性質の定義と反例を載せた項目への指摘になる
2. 性質は状態述語（level 1 以下）だけ。時相・action の包みは property_level にし、TLC を走らせない
3. 性質の閉包が Init・Next・制約の閉包と本文を共有すれば property_in_spec（名前・LOCAL・INSTANCE・制約のどれで引いても）
4. cfg の CONSTANT は AST が宣言した名前にだけ値を書く。定義名の上書き・cfg の注釈を含む値・定義名と衝突するモデル値は欠陥
5. 変異は doc_check が Init・Next の閉包から作る。性質が弱く（常に真）て殺せなければ、どう書いて守っても mutant_survived
6. 試行は checks/formal-r<n>-a<k>.json に追記だけで残る（控え）。run の全試行で破れた性質と項目は prd-spec.js が持ち、--violated で渡す。
   渡された性質と項目を外すと violated_dropped（checks/ を消しても変わらない）、破れた性質の閉包の本文を同じ名前で変えると redefined。
   前の巡で破れ writer が改稿した項目は --revised で渡り、外しても欠陥にせず dropped に出す（redefined は --revised でも照らす）。
   report の「未確認の違反」・redefined・dropped は done の返り値の formal（--formal）だけから載せる。前の試行の指摘の ID（replaces）は
   ファイル名の fm の接頭辞に合うものだけを集める（監査役の指摘の ID を混ぜると段 8 がその指摘を落とす）
11. 根のモジュールの名前が jar の同梱するモジュールと同じなら module_reserved（TLC が Java の実装で定義を上書きする）。入れ子の
    モジュールには当てない（固定した jar の TLC は入れ子に上書きを当てず、違反はそのまま見つかる）
7. 予算切れ・timeout は未検査（unchecked）で、合格にしない。jar が無い・sha256 が違う・java が無いときは unavailable
8. formal-digest は写しと元が同じなら同じ digest を返す
9. TLC の出力に行を書ける・探索を変える TLC の演算子を引く定義は operator_forbidden（`:>`・`@@` は引ける）
10. 機械で確かめないもの（性質の強さ、CONSTRAINT と CONSTANT による刈り込み）は not_checked と report に宣言し、制約の定義と定数の値を
    stdout と report の要約に出す

scratchpad の攻撃（a_bypass2・b_kind2・c_cfg2・d_drop・f_temporal・g_guard・probeF2）はここで回帰テストにしている。
実 TLC を使うテストは、jar（formal-tools の jar）と java が無ければ理由を付けて skip する。CI（CI=true）では skip せずに落とす
（黙って skip すると、判定のテストが走らないまま合格に見える）。
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
SOURCE = DOC_CHECK.read_text(encoding="utf-8")
STDOUT_FNV = re.search(r"^const STDOUT_FNV = '(\w+)'$", SOURCE, re.M).group(1)
NODE = shutil.which("node")
IN_CI = os.environ.get("CI") == "true"


def body(stdout):
    out = json.loads(stdout)
    assert re.fullmatch(r"[0-9a-f]{8}", str(out.pop(STDOUT_FNV, ""))), stdout
    return out


def formal_tools(env=None):
    r = subprocess.run([NODE, str(DOC_CHECK), "formal-tools"], capture_output=True, text=True, env=env, check=True)
    return body(r.stdout)


TOOLS = formal_tools() if NODE else None
HAS_TLC = TOOLS is not None and TOOLS["fault"] is None
NO_TLC = f"実 TLC の検査には jar と PATH 上の java が要る: {TOOLS['fault'] if TOOLS else 'node が無い'}"

DOC = """# x

## SP-X-001 上限

カウンタは 3 を超えてはならない。

## SP-X-002 到達

カウンタはいずれ 3 に達しなければならない。

## SP-X-003 記録

記録を残さなければならない。
"""

STATE_DOC = DOC + """
## SP-X-004 状態

```mermaid
stateDiagram-v2
    Idle --> Running: 開始
    Running --> Idle: 停止
```
"""

HEAD = "---- MODULE X ----\n"
BASE = HEAD + "EXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x < 3 /\\ x' = x + 1\nAtMost3 == x <= 3\nWitnessTwo == x # 2\nWitnessNine == x # 9\nWitnessZero == x # 0\nSmall == x <= 9\n====\n"
WEAK = BASE.replace("AtMost3 == x <= 3", "AtMost3 == x <= 2")


def module(top="", prop="AtMost3 == x <= 3\n", ext="EXTENDS Naturals\n", nxt="Next == x < 3 /\\ x' = x + 1\n"):
    return HEAD + ext + "VARIABLE x\n" + top + "Init == x = 0\n" + nxt + prop + "WitnessTwo == x # 2\n====\n"


def manifest(**over):
    m = {
        "doc": "specifications/x",
        "module": "X",
        "abstraction": "カウンタを 0..3 に限る",
        "init": "Init",
        "next": "Next",
        "constants": {},
        "properties": [{"name": "AtMost3", "items": ["SP-X-001", "SP-X-002"]}],
        "excluded": [{"item": "SP-X-003", "why": "記録は状態遷移ではない"}],
        "constraints": [],
        "witnesses": [{"id": "w1", "invariant": "WitnessTwo", "property": "AtMost3", "reaches": "x = 2"}],
    }
    m.update(over)
    return m


class FormalCase(unittest.TestCase):
    def setUp(self):
        self.ws = Path(tempfile.mkdtemp(prefix="prd-formal-test-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        self.write_doc(DOC)
        self.dir = self.ws / "formal" / "specifications-x"
        self.write_model()

    def write_doc(self, text):
        (self.ws / "specifications-x.md").write_text(text, encoding="utf-8")

    def write_model(self, base=BASE, m=None, files=None):
        if self.dir.exists():
            shutil.rmtree(self.dir)
        self.dir.mkdir(parents=True)
        if base is not None:
            (self.dir / "X.tla").write_text(base, encoding="utf-8")
        for name, text in (files or {}).items():
            (self.dir / name).write_text(text, encoding="utf-8")
        (self.dir / "manifest.json").write_text(json.dumps(m or manifest(), ensure_ascii=False), encoding="utf-8")

    def check(self, env=None, round_=1, budget=None, violated=(), revised=()):
        argv = [NODE, str(DOC_CHECK), "formal-check", "--workspace", str(self.ws), "--round", str(round_), "--doc", "specifications/x"]
        argv += [a for v in violated for a in ("--violated", v)] + [a for v in revised for a in ("--revised", v)]
        # 並列の make test で TLC の起動が遅れても timeout に化けないよう上限を広げる。timeout を見るテストは --budget-ms で上限を決める。
        env = {"PRD_SPEC_FORMAL_TIMEOUT_SCALE": "5", **(env or os.environ)}
        r = subprocess.run(argv + (["--budget-ms", str(budget)] if budget else []), capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = body(r.stdout)
        self.last = out
        return out

    def report(self, out=None):
        return json.loads((self.ws / (out or self.last)["path"]).read_text(encoding="utf-8"))

    def codes(self, out=None):
        return sorted(d["code"] for d in self.report(out)["defects"])

    def details(self, code, out=None):
        return [d["detail"] for d in self.report(out)["defects"] if d["code"] == code]

    def doc0(self, out=None):
        return self.report(out)["docs"][0]


@unittest.skipUnless(NODE, "node が無い環境ではスキップする")
@unittest.skipUnless(HAS_TLC or IN_CI, NO_TLC)
class TlcCase(FormalCase):
    def setUp(self):
        if not HAS_TLC:
            self.fail(f"CI では実 TLC の判定を skip しない。{NO_TLC}")
        super().setUp()


class TlcVerdicts(TlcCase):
    def test_passing_model_has_no_findings_or_defects(self):
        out = self.check()
        self.assertEqual((out["status"], out["attempt"], out["findings"], out["defects"], out["path"]), ("checked", 1, [], 0, "checks/formal-r1-a1.json"))
        self.assertEqual(out["models"]["specifications/x"]["dir"], "formal/specifications-x")
        d = self.doc0()
        self.assertEqual(d["cfg"], "INIT Init\nNEXT Next\nINVARIANT AtMost3\n", "cfg は manifest と AST から doc_check が書く")
        self.assertIn("AtMost3", d["mutants"]["killed"])
        written = json.loads((self.ws / "findings" / "r1-fm-specifications__x-a1.json").read_text(encoding="utf-8"))
        self.assertEqual(written["findings"], [])
        self.assertTrue(out["not_checked"])
        self.assertEqual(self.report()["not_checked"], out["not_checked"], "返り値と checks に同じ宣言を出す")

    def test_invariant_violation_carries_definition_and_trace(self):
        self.write_model(base=WEAK)
        out = self.check()
        self.assertEqual(out["findings"], [
            {"id": f"r1-fm-specifications__x-a1-00{i}", "doc": "specifications/x", "item_id": item, "blocking": True, "route": "writer", "direction": "choose_one", "origin": "text"}
            for i, item in ((1, "SP-X-001"), (2, "SP-X-002"))
        ])
        self.assertEqual([(v["property"], v["exit"]) for v in self.doc0()["violations"]], [("AtMost3", 12)])
        self.assertIsNone(self.doc0()["mutants"], "基で破れていれば変異を流さない")
        full = json.loads((self.ws / "findings" / "r1-fm-specifications__x-a1.json").read_text(encoding="utf-8"))["findings"][0]
        self.assertIn("AtMost3 == x <= 2", full["quote"], "性質の定義")
        self.assertIn("State 1:", full["repro"], "反例のトレース")
        self.assertIn("x = 3", full["repro"])
        self.assertTrue((self.ws / full["repro"].split("W/")[1].split("）")[0]).is_file(), "反例の TLC 出力の全文が W/checks にある")

    def test_next_round_lists_earlier_findings_as_replaced(self):
        self.write_model(base=WEAK)
        self.assertEqual(self.check()["replaces"], [])
        self.write_model()
        second = self.check(round_=2)
        self.assertEqual((second["findings"], second["replaces"], second["defects"], second["attempt"]), ([], ["r1-fm-specifications__x-a1-001", "r1-fm-specifications__x-a1-002"], 0, 1))

    def test_evaluation_error_is_model_defect_not_finding(self):
        self.write_model(base=BASE.replace("AtMost3 == x <= 3", 'AtMost3 == x = "a" \\/ TRUE'))
        out = self.check()
        self.assertEqual((out["findings"], self.codes()), ([], ["model_error"]))

    def test_unreached_witness_is_vacuous_property(self):
        self.write_model(m=manifest(witnesses=[{"id": "w1", "invariant": "WitnessNine", "property": "AtMost3", "reaches": "x = 9"}]))
        self.check()
        self.assertEqual(self.codes(), ["witness_unreached"])

    def test_witness_broken_by_initial_state_is_not_reach(self):
        self.write_model(m=manifest(witnesses=[{"id": "w1", "invariant": "WitnessZero", "property": "AtMost3", "reaches": "x = 0"}]))
        self.check()
        self.assertEqual(self.codes(), ["witness_initial"])
        witness = [r for r in self.doc0()["runs"] if r["kind"] == "witness"]
        self.assertEqual([(r["id"], r["exit"]) for r in witness], [("w1", 12)])
        self.assertIsInstance(next(r for r in self.doc0()["runs"] if r["kind"] == "base")["distinct"], int, "TLC 出力の distinct states を runs に残す")

    def test_constraint_is_written_by_doc_check_and_reported_with_definition(self):
        self.write_model(m=manifest(constraints=[{"name": "Small", "why": "カウンタの範囲を 0..9 に限る"}]))
        out = self.check()
        self.assertEqual((out["defects"], out["findings"]), (0, []))
        self.assertIn("CONSTRAINT Small\n", self.doc0()["cfg"])
        self.assertEqual(self.doc0()["constraints"], [{"name": "Small", "definition": "Small == x <= 9", "why": "カウンタの範囲を 0..9 に限る"}])

    def test_table_missing_extra_and_overlap(self):
        self.write_model(m=manifest(excluded=[{"item": "SP-X-009", "why": "文書に無い"}, {"item": "SP-X-001", "why": "両方に書く"}]))
        self.check()
        self.assertEqual({d["code"]: d["detail"] for d in self.report()["defects"]}, {"coverage_missing": "SP-X-003", "coverage_extra": "SP-X-009", "coverage_overlap": "SP-X-001"})

    def test_property_without_witness_and_model_without_property(self):
        self.write_model(m=manifest(witnesses=[]))
        self.check()
        self.assertEqual(self.codes(), ["no_witness"])
        self.write_model(m=manifest(properties=[], witnesses=[], excluded=[{"item": f"SP-X-00{i}", "why": "形式化しない"} for i in (1, 2, 3)]))
        self.check()
        self.assertEqual(self.codes(), ["no_property"])

    def test_no_model_is_a_defect_only_when_the_doc_has_a_state_model(self):
        none = manifest(module=None, init=None, next=None, properties=[], witnesses=[], excluded=[{"item": f"SP-X-00{i}", "why": "形式化しない"} for i in (1, 2, 3)])
        self.write_model(base=None, m=none)
        out = self.check()
        self.assertEqual((out["defects"], out["runs"]), (0, 0), "図も表も無い文書は全項目を excluded にできる（not_checked で宣言する）")
        self.assertTrue(any("excluded" in x for x in out["not_checked"]))
        self.write_doc(STATE_DOC)
        self.write_model(base=None, m={**none, "excluded": [*none["excluded"], {"item": "SP-X-004", "why": "形式化しない"}]})
        self.check()
        self.assertEqual(self.codes(), ["state_unmodeled"])

    def test_budget_exhaustion_is_unchecked(self):
        out = self.check(budget=1)
        self.assertEqual(out["findings"], [])
        self.assertTrue(self.codes() and set(self.codes()) == {"unchecked"}, self.codes())

    def test_timeout_is_unchecked(self):
        # 上限の無いカウンタで、性質は常に真: TLC は状態を数え続け、上限で切られる。
        endless = BASE.replace("Next == x < 3 /\\ x' = x + 1", "Next == x' = x + 1").replace("AtMost3 == x <= 3", "AtMost3 == x >= 0")
        self.write_model(base=endless)
        out = self.check(budget=8000)
        self.assertEqual((out["findings"], self.codes()), ([], ["unchecked"]))


class Bypasses(TlcCase):
    """検証役の攻撃（scratchpad/vf3・vf4）。どれも実 TLC 上で「指摘 0 件・欠陥 0 件」の合格にならないことを固定する。"""

    def test_mutants_reach_helpers_however_they_are_written(self):
        # a_bypass2: 常に真の性質を、変異の守る範囲の外に見える書き方で隠す。守る範囲は AST の閉包なので、どの書き方でも変異が届く。
        for name, tla in (
            ("LOCAL の定義", module("LOCAL Ok(v) == v # 99\n", "AtMost3 == Ok(x)\n")),
            ("字下げした定義", module(" Ok(v) == v # 99\n", "AtMost3 == Ok(x)\n")),
            ("高階の引数", module("Ap(F(_), v) == F(v) # 99\nId(v) == v\n", "AtMost3 == Ap(Id, x)\n")),
            ("中置の演算子", module("a ++ b == a # b + 99\n", "AtMost3 == x ++ 0\n")),
        ):
            with self.subTest(name):
                self.write_model(base=tla)
                out = self.check()
                self.assertEqual((out["findings"], self.codes()), ([], ["mutant_survived"]))
                self.assertGreater(self.doc0()["mutants"]["generated"], 0)

    def test_other_module_files_are_rejected(self):
        # a_bypass2: 複数行の EXTENDS の継続行で別ファイルのモジュールを引く。
        self.write_model(base=module("", "AtMost3 == Ok(x)\n", ext="EXTENDS Naturals,\n        Strong\n"), files={"Strong.tla": "---- MODULE Strong ----\nOk(v) == v # 99\n====\n"})
        out = self.check()
        self.assertEqual((self.codes(), self.details("file_extra"), out["runs"]), (["file_extra"], ["Strong.tla"], 0))

    def test_modeler_written_cfg_is_rejected(self):
        # c_cfg2: modeler が cfg を書くと `<-` を注釈に隠して演算子を差し替えられる。cfg は doc_check だけが書く。
        self.write_model(files={"X.cfg": 'INIT Init\nNEXT Next\nCONSTANT A = "(*"\nCONSTANT AtMost3 <- TRUE\nCONSTANT B = "*)"\n'})
        out = self.check()
        self.assertEqual((self.codes(), self.details("file_extra"), out["runs"]), (["file_extra"], ["X.cfg"], 0))

    def test_temporal_wraps_are_property_level_without_running_tlc(self):
        # b_kind2: 違反する状態述語を時相の演算子で包むと、不変条件として流したときに違反が消える。対照（包まない）は違反になる。
        for wrapped in ("x <= 2 /\\ []TRUE", "[]TRUE /\\ x <= 2", "x <= 2 \\/ <>FALSE", "(x <= 2) /\\ (TRUE ~> TRUE)", "x <= 2 /\\ [][TRUE]_x", "[][x' >= x]_x"):
            with self.subTest(wrapped):
                self.write_model(base=module(prop=f"AtMost3 == {wrapped}\n"))
                out = self.check()
                self.assertEqual((out["findings"], self.codes(), out["runs"]), ([], ["property_level"], 0))
        self.write_model(base=module(prop="AtMost3 == x <= 2\n"))
        self.assertEqual(len(self.check()["findings"]), 2)

    def test_honest_temporal_property_is_declared_not_a_false_mutant_error(self):
        # f_temporal: 真の時相の性質を temporal で申告すると、変異の exit が合わず mutant_error（偽の欠陥）になっていた。
        self.write_model(base=module(prop="AtMost3 == [](x <= 3)\n"))
        out = self.check()
        self.assertEqual((self.codes(), out["runs"]), (["property_level"], 0))
        self.assertTrue(any("時相" in x for x in out["not_checked"]))

    def test_cfg_constants_only_bind_declared_constants(self):
        # c_cfg2: CONSTANT に定義名を書いて演算子を上書きする、cfg の注釈の区切りを値に入れて後ろを隠す、値を定義名と衝突させる。
        tla = HEAD + "EXTENDS Naturals\nCONSTANTS A, B\nVARIABLE x\nInit == x = 0\nNext == x < 3 /\\ x' = x + 1\nBound == x <= 2\nAtMost3 == Bound /\\ x <= 4\nbound == 1\nWitnessTwo == x # 2\n====\n"
        for name, constants, code in (
            ("定義名の上書き", {"A": 1, "B": 2, "Bound": True}, "constant_mismatch"),
            ("注釈を含む値", {"A": "(*", "B": "*)"}, "manifest_shape"),
            ("定義名と衝突するモデル値", {"A": "bound", "B": 2}, "constant_shape"),
        ):
            with self.subTest(name):
                self.write_model(base=tla, m=manifest(constants=constants))
                out = self.check()
                self.assertEqual((out["findings"], set(self.codes()), out["runs"]), ([], {code}, 0))
        self.write_model(base=tla, m=manifest(constants={"A": 1, "B": 2}))
        self.assertEqual(len(self.check()["findings"]), 2)
        self.assertIn("CONSTANT A = 1\nCONSTANT B = 2\n", self.doc0()["cfg"])

    def test_property_closure_must_not_prune_the_state_space(self):
        # g_guard: 違反する性質を Next（名前・LOCAL の補助・別の INSTANCE）や制約から引いて、違反する状態へ遷移させない。
        nest = HEAD + "EXTENDS Naturals\n---- MODULE Inner ----\nOk(v) == v <= 2\n====\nVARIABLE x\nI == INSTANCE Inner\nI2 == INSTANCE Inner\nInit == x = 0\nNext == x < 3 /\\ x' = x + 1 /\\ I!Ok(x')\nAtMost3 == I2!Ok(x)\nWitnessTwo == x # 2\n====\n"
        for name, tla, m in (
            ("Next が性質を引く", module(prop="", nxt="AtMost3 == x <= 2\nNext == x < 3 /\\ x' = x + 1 /\\ AtMost3'\n"), manifest()),
            ("LOCAL の補助を共有", module("LOCAL Ok(v) == v <= 2\n", "AtMost3 == Ok(x)\n", nxt="Next == x < 3 /\\ x' = x + 1 /\\ Ok(x')\n"), manifest()),
            ("別の INSTANCE で同じ本文", nest, manifest()),
            ("制約に性質を置く", module(prop="AtMost3 == x <= 2\n"), manifest(constraints=[{"name": "AtMost3", "why": "x"}])),
        ):
            with self.subTest(name):
                self.write_model(base=tla, m=m)
                out = self.check()
                self.assertEqual((out["findings"], self.codes(), out["runs"]), ([], ["property_in_spec"], 0))


    def test_tlc_operators_that_write_output_or_steer_search_are_forbidden(self):
        # vf5 p1_spoof・p3_constraint: PrintT で深さや違反の行を偽ると、TLC の出力を読む判定が指摘 0・欠陥 0 になっていた。
        tlc = module(ext="EXTENDS Naturals, TLC\n", prop="AtMost3 == x # 99\n")
        for name, tla in (
            ("深さの行を偽る", tlc.replace("Init == x = 0", 'Init == x = 0 /\\ PrintT("The depth of the complete state graph search is 100000")')),
            ("違反の行を偽る", tlc.replace("Next == x < 3 /\\ x' = x + 1", 'Next == x < 3 /\\ x\' = x + 1 /\\ PrintT("Invariant AtMost3 is violated")')),
            ("INSTANCE 越し", tlc.replace("Init == x = 0", 'T == INSTANCE TLC\nInit == x = 0 /\\ T!PrintT("a")')),
            ("ASSUME", tlc.replace("Init == x = 0", 'ASSUME PrintT("a")\nInit == x = 0')),
            ("TLCSet", tlc.replace("Init == x = 0", 'Init == x = 0 /\\ TLCSet("exit", TRUE)')),
            ("RandomElement", tlc.replace("Init == x = 0", "Init == x = RandomElement({0})")),
            ("TLC の外のモジュール（Randomization）", tlc.replace("EXTENDS Naturals, TLC\n", "EXTENDS Naturals, Randomization\n").replace("Init == x = 0", "Init == x = 0 /\\ RandomSubset(1, {0}) # {}")),
            ("入れ子のモジュールの EXTENDS TLC", tlc.replace("EXTENDS Naturals, TLC\n", "EXTENDS Naturals\n---- MODULE In ----\nEXTENDS TLC\nG == PrintT(1)\n====\nI == INSTANCE In\n").replace("Init == x = 0", "Init == x = 0 /\\ I!G")),
        ):
            with self.subTest(name):
                self.write_model(base=tla)
                out = self.check()
                self.assertEqual((out["findings"], self.codes(), out["runs"]), ([], ["operator_forbidden"], 0))
        self.write_model(base=module(ext="EXTENDS Naturals, TLC\n", prop="AtMost3 == x <= 3 /\\ (1 :> 2 @@ 3 :> 4)[1] = 2\n"))
        out = self.check()
        self.assertEqual((out["findings"], out["defects"]), ([], 0), "値だけを返す :> と @@ は引ける")

    def test_string_value_cannot_spoof_a_violation_line(self):
        # q2 string: 状態の文字列に違反の行を入れても、TLC は値を引用符つきで出すので行頭の照合に当たらない。
        tla = HEAD + 'EXTENDS Naturals\nVARIABLE x, s\nInit == x = 0 /\\ s = "a\\nError: Invariant AtMost3 is violated."\nNext == x < 3 /\\ x\' = x + 1 /\\ s\' = s\nAtMost3 == x # 99\nWitnessTwo == x # 2\n====\n'
        self.write_model(base=tla)
        out = self.check()
        self.assertEqual((out["findings"], self.codes()), ([], ["mutant_survived"]))

    HOOKED = "EXTENDS Naturals\n{inner}VARIABLE x\nInit == x = 0\nNext == x < 5 /\\ x' = x + 1 /\\ (x' = 4 => {call}(\"exit\", TRUE))\nAtMost3 == x <= 3\nWitnessTwo == x # 2\n====\n"

    def test_root_module_named_like_a_bundled_module_is_reserved(self):
        # vf7 a3: 根を TLC と名付けると TLC が Java の TLCSet を当て、本文の TLCSet の定義も forbidden の照合も素通りになり、違反の状態で探索が止まった。
        for name, tla in (
            ("TLC", "---- MODULE TLC ----\n" + self.HOOKED.format(inner="TLCSet(i, v) == TRUE\n", call="TLCSet")),
            ("Randomization", "---- MODULE Randomization ----\n" + module().split("\n", 1)[1]),
            ("Tlc", "---- MODULE Tlc ----\n" + self.HOOKED.format(inner="TLCSet(i, v) == TRUE\n", call="TLCSet")),
        ):
            with self.subTest(name):
                self.write_model(base=None, m=manifest(module=name), files={f"{name}.tla": tla})
                out = self.check()
                self.assertEqual((out["findings"], self.codes(), out["runs"]), ([], ["module_reserved"], 0))

    def test_nested_module_named_like_a_bundled_module_is_still_checked(self):
        # vf7 a4: 入れ子の TLC には Java の実装が当たらないので、本文の定義のまま評価され、違反は見つかる。
        for name, inner, call in (("INSTANCE", "---- MODULE TLC ----\nTLCSet(i, v) == TRUE\n====\nT == INSTANCE TLC\n", "T!TLCSet"),
                                  ("LOCAL INSTANCE", "---- MODULE TLC ----\nTLCSet(i, v) == TRUE\n====\nLOCAL INSTANCE TLC\n", "TLCSet")):
            with self.subTest(name):
                self.write_model(base=HEAD + self.HOOKED.format(inner=inner, call=call))
                out = self.check()
                self.assertEqual((self.codes(), [f["item_id"] for f in out["findings"]]), ([], ["SP-X-001", "SP-X-002"]))


class Declarations(TlcCase):
    """vf5 p4_pad・p9 pad_attack: 状態空間の水増しと CONSTRAINT・CONSTANT の刈り込みは機械で塞がず、宣言と事実の表示で残す。"""

    PAD = HEAD + "EXTENDS Naturals\nVARIABLES x, y\nInit == x = 0 /\\ y = 0\nNext == (x < 3 /\\ x' = x + 1 /\\ y' = y) \\/ (y < 10 /\\ y' = y + 1 /\\ x' = x)\nAtMost3 == x <= 2\nSmall == x <= 1\nWitnessOne == x # 1\n====\n"

    def test_constraint_pruning_is_shown_and_declared(self):
        m = manifest(constraints=[{"name": "Small", "why": "範囲を限る"}], witnesses=[{"id": "w1", "invariant": "WitnessOne", "property": "AtMost3", "reaches": "x = 1"}])
        self.write_model(base=self.PAD, m=m)
        out = self.check()
        self.assertEqual(out["pruning"], {"specifications/x": {"constraints": [{"name": "Small", "definition": "Small == x <= 1"}], "constants": {}}}, "制約の定義を stdout に出す")
        self.assertTrue(any("性質の強さ" in x for x in out["not_checked"]))
        self.assertTrue(any("CONSTRAINT と CONSTANT" in x for x in out["not_checked"]))
        r = subprocess.run([NODE, str(DOC_CHECK), "report", "--workspace", str(self.ws)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        text = (self.ws / "report.md").read_text(encoding="utf-8")
        section = text[text.index("## 形式検査"):]
        self.assertIn("  - 制約（CONSTRAINT）: `Small == x <= 1`", section)
        self.assertTrue(all(f"- {x}" in section for x in out["not_checked"]))


class AttemptLog(TlcCase):
    """d_drop・probeF2・vf5（p5 delete2・p5 helper・p9 inround）: 破れた性質と項目の正本は --violated で、modeler が消せる checks/ ではない。"""

    TWO = HEAD + "EXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x < 3 /\\ x' = x + 1\nAtMost3 == x <= 2\nBelow5 == x <= 4\nWitnessTwo == x # 2\n====\n"
    FULL = manifest(
        properties=[{"name": "AtMost3", "items": ["SP-X-001"]}, {"name": "Below5", "items": ["SP-X-002"]}],
        witnesses=[{"id": "w1", "invariant": "WitnessTwo", "property": "AtMost3", "reaches": "x = 2"}, {"id": "w2", "invariant": "WitnessTwo", "property": "Below5", "reaches": "x = 2"}],
    )
    DROPPED = manifest(
        properties=[{"name": "Below5", "items": ["SP-X-002"]}],
        excluded=[{"item": "SP-X-001", "why": "形式化しない"}, {"item": "SP-X-003", "why": "記録"}],
        witnesses=[{"id": "w2", "invariant": "WitnessTwo", "property": "Below5", "reaches": "x = 2"}],
    )
    DROP = "前の検査で破れた性質と項目が、同じ名前の性質から外れた: AtMost3（SP-X-001）"

    def first_violation(self):
        self.write_model(base=self.TWO, m=self.FULL)
        a1 = self.check()
        self.assertEqual((a1["attempt"], len(a1["findings"])), (1, 1))
        self.assertEqual(len(a1["violated"]), 1)
        self.assertRegex(a1["violated"][0], r"^specifications/x:SP-X-001:AtMost3:[0-9a-f]{12}$", "返すのは ID と digest だけ")
        return a1["violated"]

    def run_report(self, *extra):
        r = subprocess.run([NODE, str(DOC_CHECK), "report", "--workspace", str(self.ws), *extra], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        text = (self.ws / "report.md").read_text(encoding="utf-8")
        return text[text.index("## 形式検査"):]

    def test_dropping_a_violated_item_is_judged_from_the_argument_not_checks(self):
        violated = self.first_violation()
        self.write_model(base=self.TWO, m=self.FULL, files={"Extra.tla": "x"})
        a2 = self.check(violated=violated)
        self.assertEqual((a2["attempt"], self.codes(), a2["violated"]), (2, ["file_extra"], []), "欠陥の試行は違反を返さない（消えたかは prd-spec.js が数える）")
        self.write_model(base=self.TWO, m=self.DROPPED)
        self.check(violated=violated)
        self.assertEqual(self.details("violated_dropped"), [self.DROP], "a1 の違反は a2 を挟んでも引数で残る")
        self.assertEqual(sorted(f.name for f in (self.ws / "checks").glob("formal-r1-a*.json")), [f"formal-r1-a{k}.json" for k in (1, 2, 3)], "試行ごとに別のファイルに残る")
        first = json.loads((self.ws / "findings" / "r1-fm-specifications__x-a1.json").read_text(encoding="utf-8"))
        self.assertEqual([f["item_id"] for f in first["findings"]], ["SP-X-001"], "前の試行の指摘を上書きしない")
        shutil.rmtree(self.ws / "checks")
        self.check(violated=violated)
        self.assertEqual(self.details("violated_dropped"), [self.DROP], "p5 delete2・p9 inround: checks/ を消しても violated_dropped は消えない")
        self.check()
        self.assertNotIn("violated_dropped", self.codes(), "照らす正本は --violated だけで、checks/ の控えからは数えない")

    def test_redefining_a_violated_property_is_reported_by_closure(self):
        violated = self.first_violation()
        self.write_model(base=self.TWO.replace("AtMost3 == x <= 2", "AtMost3 == x <= 3"), m=self.FULL)
        out = self.check(violated=violated)
        self.assertEqual((out["findings"], out["redefined"], out["violated"]), ([], [{"doc": "specifications/x", "property": "AtMost3"}], []))
        self.assertNotIn("violated_dropped", self.codes(), "redefined は欠陥にしない（宣言で残す）")

    def test_redefining_a_helper_of_a_violated_property_is_redefined(self):
        # p5 helper: 性質の本文はそのままで、引いている補助の定義だけを変えて違反を消す。比べるのは閉包の本文なので拾う。
        helper = HEAD + "EXTENDS Naturals\nVARIABLE x\nOk(v) == v <= 2\nInit == x = 0\nNext == x < 3 /\\ x' = x + 1\nAtMost3 == Ok(x)\nWitnessTwo == x # 2\n====\n"
        self.write_model(base=helper)
        violated = self.check()["violated"]
        self.assertEqual([v.split(":")[1] for v in violated], ["SP-X-001", "SP-X-002"])
        self.write_model(base=helper.replace("v <= 2", "v <= 3"))
        out = self.check(violated=violated)
        self.assertEqual((out["findings"], out["redefined"]), ([], [{"doc": "specifications/x", "property": "AtMost3"}]))

    def test_redefinition_through_instance_substitution_is_redefined_not_a_constant_mismatch(self):
        # vf7 a7b: INSTANCE の WITH の置き換えで性質を弱める。入れ子のモジュールの CONSTANT を根の宣言に数えると constant_mismatch に化けていた。
        inner = HEAD + "EXTENDS Naturals\nVARIABLE x\n---- MODULE In ----\nEXTENDS Naturals\nCONSTANT L\nVARIABLE y\nOk == y <= L\n====\nI == INSTANCE In WITH L <- {lim}, y <- x\nInit == x = 0\nNext == x < 3 /\\ x' = x + 1\nAtMost3 == I!Ok\nWitnessTwo == x # 2\n====\n"
        self.write_model(base=inner.format(lim=2))
        violated = self.check()["violated"]
        self.assertEqual((self.codes(), len(violated)), ([], 2))
        self.write_model(base=inner.format(lim=3))
        out = self.check(violated=violated)
        self.assertNotIn("constant_mismatch", self.codes())
        self.assertEqual((out["findings"], out["redefined"]), ([], [{"doc": "specifications/x", "property": "AtMost3"}]))

    def test_revised_item_moved_out_is_dropped_not_a_defect(self):
        violated = self.first_violation()
        self.write_model(base=self.TWO, m=self.DROPPED)
        out = self.check(round_=2, revised=violated)
        self.assertNotIn("violated_dropped", self.codes(), "writer が改稿した項目は意味が変わりうる")
        self.assertEqual(out["dropped"], [{"doc": "specifications/x", "item": "SP-X-001", "property": "AtMost3"}])
        self.assertEqual(self.check(round_=2, violated=violated)["dropped"], [], "改稿していない項目は dropped にせず欠陥にする")
        self.assertEqual(self.details("violated_dropped"), [self.DROP])

    def test_revised_item_with_a_weakened_property_is_still_redefined(self):
        # vf7 a9: 改稿した項目の token を渡さないと、性質を弱めても redefined が出なかった。
        violated = self.first_violation()
        self.write_model(base=self.TWO.replace("AtMost3 == x <= 2", "AtMost3 == x <= 3"), m=self.FULL)
        out = self.check(round_=2, revised=violated)
        self.assertEqual((out["findings"], out["redefined"], out["dropped"]), ([], [{"doc": "specifications/x", "property": "AtMost3"}], []))
        self.assertNotIn("violated_dropped", self.codes())

    def test_replaces_collects_only_ids_of_the_file_prefix(self):
        # vf7 a8: fm のファイルに監査役の指摘の ID を書くと replaces に載り、段 8 がその指摘を前の形式検査の指摘として落とした。
        (self.ws / "findings").mkdir(exist_ok=True)
        planted = {"findings": [{"id": "r1-im-specifications__x-001"}, {"id": "r9-fm-zzz-a1-001x"}, {"id": "r9-fm-zzz-a1-002"}]}
        (self.ws / "findings" / "r9-fm-zzz-a1.json").write_text(json.dumps(planted), encoding="utf-8")
        self.assertEqual(self.check(round_=10)["replaces"], ["r9-fm-zzz-a1-002"])

    def test_malformed_violated_argument_stops(self):
        r = subprocess.run([NODE, str(DOC_CHECK), "formal-check", "--workspace", str(self.ws), "--round", "1", "--doc", "specifications/x", "--violated", "SP-X-001 AtMost3"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0, "形の合わない違反を読み飛ばすと violated_dropped が黙って消える")

    def test_report_lists_unconfirmed_and_redefined_only_from_the_done_formal(self):
        violated = self.first_violation()
        self.write_model(base=self.TWO.replace("AtMost3 == x <= 2", "AtMost3 == x <= 3"), m=self.FULL)
        a2 = self.check(violated=violated)
        section = self.run_report()
        self.assertIn("最後の検査: checks/formal-r1-a2.json", section)
        self.assertIn("### 未確認の違反\n\ndone の返り値の formal を --formal で渡していないので載せない", section, "checks/ の控えから未確認を数えない")
        formal = {"round": 1, "attempt": 2, "unconfirmed": [{"doc": "specifications/x", "item": "SP-X-001", "properties": ["AtMost3"]}], "redefined": a2["redefined"],
                  "dropped": [{"doc": "specifications/x", "item": "SP-X-002", "property": "Below5"}]}
        section = self.run_report("--formal", json.dumps(formal, ensure_ascii=False))
        self.assertIn("### 未確認の違反\n\n- specifications/x SP-X-001: 性質 AtMost3（", section)
        self.assertIn("### 破れた後に定義が変わった性質\n\n- specifications/x AtMost3\n", section)
        self.assertIn("- specifications/x SP-X-002: 性質 Below5", section[section.index("### 改稿の後に性質から外した項目"):])
        self.assertTrue(all(f"- {x}" in section for x in a2["not_checked"]))
        clean = self.run_report("--formal", json.dumps({**formal, "unconfirmed": [], "redefined": [], "dropped": []}))
        self.assertIn("### 未確認の違反\n\n0 件。", clean)
        r = subprocess.run([NODE, str(DOC_CHECK), "report", "--workspace", str(self.ws), "--formal", json.dumps({"round": 1, "attempt": 2, "unconfirmed": [{"doc": "specifications/x"}], "redefined": [], "dropped": []})], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0, "形の合わない --formal は止める")

    def test_violation_in_an_earlier_round_cannot_be_dropped_later(self):
        violated = self.first_violation()
        self.write_model(base=self.TWO, m=self.DROPPED)
        out = self.check(round_=2, violated=violated)
        self.assertEqual(out["attempt"], 1)
        self.assertEqual(self.details("violated_dropped"), [self.DROP])

    def test_attempt_files_are_never_overwritten(self):
        self.check()
        planted = '{"findings": []}'
        (self.ws / "findings" / "r1-fm-specifications__x-a2.json").write_text(planted, encoding="utf-8")
        self.assertEqual(self.check()["attempt"], 3, "番号は指摘のファイルからも数え、既にある名前を使わない")
        self.assertEqual((self.ws / "findings" / "r1-fm-specifications__x-a2.json").read_text(encoding="utf-8"), planted)


class ManifestShape(TlcCase):
    """manifest の形の誤りは TLC を走らせずに manifest_shape にする。"""

    def test_each_shape_error(self):
        base = manifest()
        for name, m in (
            ("doc が違う", {**base, "doc": "specifications/y"}),
            ("constraints が無い", {k: v for k, v in base.items() if k != "constraints"}),
            ("cfg を持つ", {**base, "cfg": "X"}),
            ("性質が kind を持つ", {**base, "properties": [{**base["properties"][0], "kind": "invariant"}]}),
            ("性質の名前が重複", {**base, "properties": [base["properties"][0], {"name": "AtMost3", "items": ["SP-X-003"]}], "excluded": []}),
            ("目撃の性質が無い", {**base, "witnesses": [{**base["witnesses"][0], "property": "Nope"}]}),
            ("目撃が module を持つ", {**base, "witnesses": [{**base["witnesses"][0], "module": "X_w"}]}),
            ("constraints の形", {**base, "constraints": [{"name": "Small"}]}),
            ("constants が配列", {**base, "constants": []}),
            ("init が名前でない", {**base, "init": "Init /\\ TRUE"}),
            ("module null に性質", {**base, "module": None, "init": None, "next": None}),
        ):
            with self.subTest(name):
                self.write_model(m=m)
                out = self.check()
                self.assertEqual((set(self.codes()), out["runs"]), ({"manifest_shape"}, 0))

    def test_symlink_in_model_dir_is_rejected(self):
        (self.dir / "link.tla").symlink_to(self.dir / "X.tla")
        self.check()
        self.assertEqual(self.codes(), ["manifest_shape"])

    def test_missing_manifest(self):
        (self.dir / "manifest.json").unlink()
        out = self.check()
        self.assertEqual((self.codes(), out["models"]["specifications/x"]["digest"]), (["manifest_missing"], None))

    def test_named_definitions_must_exist_at_the_top_level(self):
        self.write_model(m=manifest(next="Step"))
        out = self.check()
        self.assertEqual((self.codes(), out["runs"]), (["definition_missing"], 0))

    def test_java_missing_is_unavailable(self):
        out = self.check(env={**os.environ, "PATH": "/nonexistent"})
        self.assertEqual(out["status"], "unavailable")
        self.assertIn("java", out["reason"])
        self.assertFalse((self.ws / "checks").exists(), "検査できないときは結果を書かない")


class ConcurrentChecks(TlcCase):
    def test_concurrent_checks_do_not_share_java_tmpdir(self):
        real = shutil.which("java")
        bindir = Path(tempfile.mkdtemp(prefix="prd-formal-java-"))
        self.addCleanup(shutil.rmtree, bindir, True)
        log = bindir / "tmpdirs.log"
        wrapper = bindir / "java"
        wrapper.write_text(
            "#!/bin/sh\n"
            "case \" $* \" in *\" tlc2.TLC \"*|*\" tla2sany.\"*)\n"
            "  t=\n"
            "  for a; do case $a in -Djava.io.tmpdir=*) t=${a#-Djava.io.tmpdir=} ;; esac; done\n"
            f"  printf '%s\\n' \"$t\" >> '{log}' ;;\n"
            "esac\n"
            f"exec '{real}' \"$@\"\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
        other = Path(tempfile.mkdtemp(prefix="prd-formal-test-"))
        self.addCleanup(shutil.rmtree, other, True)
        shutil.copytree(self.ws, other, dirs_exist_ok=True)
        env = {**os.environ, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}", "PRD_SPEC_FORMAL_TIMEOUT_SCALE": "5"}
        procs = [
            subprocess.Popen([NODE, str(DOC_CHECK), "formal-check", "--workspace", str(ws), "--round", "1", "--doc", "specifications/x"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            for ws in (self.ws, other)
        ]
        for p in procs:
            stdout, stderr = p.communicate()
            self.assertEqual(p.returncode, 0, stderr)
            out = body(stdout)
            self.assertEqual((out["status"], out["defects"]), ("checked", 0), out)
        dirs = log.read_text(encoding="utf-8").splitlines()
        self.assertTrue(dirs and all(dirs), dirs)
        self.assertEqual(len(set(dirs)), len(dirs), dirs)
        system = os.path.realpath(tempfile.gettempdir())
        self.assertTrue(all(os.path.realpath(d) != system and "/prd-formal-" in d for d in dirs), dirs)


@unittest.skipUnless(NODE, "node が無い環境ではスキップする")
class ToolFaults(FormalCase):
    def env_with_jar(self, jar_bytes):
        d = Path(tempfile.mkdtemp(prefix="prd-formal-jar-"))
        self.addCleanup(shutil.rmtree, d, True)
        jar = d / "tla2tools.jar"
        if jar_bytes is not None:
            jar.write_bytes(jar_bytes)
        return {**os.environ, TOOLS["env"]: str(jar)}

    def test_env_overrides_the_default_jar(self):
        env = self.env_with_jar(None)
        self.assertEqual(formal_tools(env)["jar"], env[TOOLS["env"]])
        home = Path(tempfile.mkdtemp(prefix="prd-formal-home-"))
        self.addCleanup(shutil.rmtree, home, True)
        bare = {k: v for k, v in os.environ.items() if k != TOOLS["env"]}
        default = Path(formal_tools({**bare, "HOME": str(home)})["jar"])
        self.assertEqual(default.name, "tla2tools.jar")
        self.assertTrue(default.is_relative_to(home), default)

    def test_missing_jar_is_unavailable_and_names_the_source(self):
        out = self.check(env=self.env_with_jar(None))
        self.assertEqual(out["status"], "unavailable")
        self.assertIn("jar がありません", out["reason"])
        self.assertIn(TOOLS["url"], out["reason"])
        self.assertIn(TOOLS["env"], out["reason"])

    def test_sha_mismatch_is_unavailable(self):
        fake = b"not tla2tools"
        self.assertNotEqual(hashlib.sha256(fake).hexdigest(), TOOLS["sha256"])
        out = self.check(env=self.env_with_jar(fake))
        self.assertEqual(out["status"], "unavailable")
        self.assertIn("sha256", out["reason"])
        self.assertNotIn("findings", out)

    def test_budget_can_only_be_lowered(self):
        for bad in ("0", "480001", "x"):
            with self.subTest(bad=bad):
                r = subprocess.run([NODE, str(DOC_CHECK), "formal-check", "--workspace", str(self.ws), "--round", "1", "--doc", "specifications/x", "--budget-ms", bad], capture_output=True, text=True)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("--budget-ms", r.stderr)

    def test_doc_stdout_names_the_model_dir(self):
        r = subprocess.run([NODE, str(DOC_CHECK), "doc", "--workspace", str(self.ws)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(body(r.stdout)["formal_dirs"], {"specifications/x": {"doc": "specifications-x.md", "dir": "formal/specifications-x"}})

    def test_digest_matches_copy_and_detects_change(self):
        copy = Path(tempfile.mkdtemp(prefix="prd-formal-copy-")) / "x"
        self.addCleanup(shutil.rmtree, copy.parent, True)
        shutil.copytree(self.dir, copy)

        def digest(d):
            r = subprocess.run([NODE, str(DOC_CHECK), "formal-digest", "--dir", str(d)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            return body(r.stdout)["digest"]

        self.assertEqual(digest(self.dir), digest(copy))
        (copy / "X.tla").write_text(BASE + "\n", encoding="utf-8")
        self.assertNotEqual(digest(self.dir), digest(copy))


if __name__ == "__main__":
    unittest.main()
