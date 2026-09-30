"""起動理由の手がかり: 条件付きの経路の起動理由ごとに体数を数えられることを、試走の前に押さえる。

試走の報告は journal の label とプロンプトの行から起動理由ごとの体数を数える。手がかりが script の今の形とずれると、
数えた体数が別の理由に紛れても報告からは見えない。ここでは次を確かめる。

- 手がかり（LABEL_FAMILIES の label の形・PROMPT_CLUES のプロンプトの行）が prd-spec.js の本文にそのまま在る（改名するとここが落ちる）。
- label の形どうしが重ならない（AMBIGUOUS は空。重なる組ができたら、そこに分けるプロンプトの行を足す）。
- 既存の段のテストの run が起動した agent すべてが、ちょうど 1 つの label の形に当たり、プロンプトの行の手がかりが
  その形の起動のプロンプトに現れる（段のテストの経路を流用するので、手がかりの形は実際に組み立てられた label と照合される）。
- skipped の fact の閉集合が script の SKIP と同じ。
"""

import contextlib
import io
import re
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_prd_stages  # noqa: E402
from prd_script import PRD_PATH as PRD  # noqa: E402
from test_prd_pure import value  # noqa: E402

STAGES = re.findall(r"'([^']+)'|\"([^\"]+)\"", re.search(r"^const STAGES = \[(.*)\]$", PRD.read_text(encoding="utf-8"), re.M).group(1))
S = "(?:" + "|".join(re.escape(a or b) for a, b in STAGES) + ")"
N = r"(?:-\d+)?"

# LABEL_FAMILIES: label の形（最後の接尾辞で起動の理由が決まる）。reason は起動理由の表の行か、条件付きでない起動（base）。
# source: prd-spec.js の本文にそのまま在る、その label を組み立てる断片。
LABEL_FAMILIES = [
    ("intake", "base", r"intake", ["once('intake'"]),
    ("flow-framer", "base", r"flow-framer", ["frameFlow('flow-framer'"]),
    ("main-resolver", "base", rf"resolver:{S}", ["`resolver:${stage}`"]),
    ("main-verifier", "base", rf"verifier:{S}v", ["`verifier:${stage}v`"]),
    ("writer", "base", r"writer:[^:]+:(?:draft|revise)", ["`writer:${unit.id}:${mode}`"]),
    ("audit-first", "base", r"(?:implementer|grounding|crossDoc):r1:[^:]+(?::extra)?", ["`${p.role}:r${round}:${p.doc}${p.extra ? ':extra' : ''}`"]),
    ("audit-scoped", "base", r"(?:implementer|grounding):r(?:[2-9]|\d{2,}):[^:]+(?::extra)?", []),
    ("flow-check-entry", "base", r"flow-check:.+-entry", ["`flow-check:${from}-entry`", "'flow-check:1-entry'"]),
    ("flow-check-answers", "base", r"flow-check:.+-answers", ["`flow-check:${gate}-answers`"]),
    ("flow-check-backup", "base", r"flow-check:.+-backup", ["`flow-check:${stage}-backup`"]),
    ("resolver-final", "base", r"resolver:final", ["'resolver:final'"]),
    ("rework-resolver", "差し戻し（v1 の不合格）", rf"resolver:{S}-fix", ["const fixOf = (stage) => `${stage}-fix`", "`resolver:${fix}`"]),
    ("rework-verifier", "差し戻し（v1 の不合格）", rf"verifier:{S}-fixv", ["`verifier:${fix}v`"]),
    ("settle-rework-resolver", "差し戻し（settle・検証し残しの不合格）", rf"resolver:.+-(?:settle|left|entry){N}-fix", ["`resolver:${owner}-fix`"]),
    ("settle-rework-verifier", "差し戻し（settle・検証し残しの不合格）", rf"verifier:.+-(?:settle|left|entry){N}-fixv", ["`verifier:${owner}-fixv`"]),
    ("convert", "変換", r"resolver:.+-convert", ["`resolver:${owner}-convert`"]),
    ("convert-kind", "変換の種類の直し", r"resolver:.+-convert-kind", ["`resolver:${owner}-convert-kind`"]),
    ("to-question", "聞ける段の指定の外の hold の書き換え直し", r"resolver:.+-toquestion", ["const TO_QUESTION = '-toquestion'"]),
    ("source-verifier", "decidable の出典の聞き直し", rf"verifier:.+-source{N}", ["reworkLabel(`${label}-source`, n)"]),
    ("settle-framer", "settle", rf"flow-framer:.+-settle{N}", ["`flow-framer:${tag}`", "reworkLabel(`${stage}-settle`, n)"]),
    ("settle-verifier", "settle", rf"verifier:.+v-settle{N}", ["`verifier:${reworkLabel(`${stage}v-settle`, n)}`"]),
    ("opens", "未裁定の O- と組（R6b）", r"resolver:.+-opens", ["`resolver:${owner}-${tag}`", "opens.length ? 'opens' : 'pairs'"]),
    ("pairs", "組の再検査", r"resolver:.+-pairs", ["`resolver:${owner}-${tag}`", "opens.length ? 'opens' : 'pairs'"]),
    ("questions", "問いの形の修正", rf"resolver:.+-questions{N}", ["reworkLabel(`resolver:${owner}-questions`, n)"]),
    ("flow-rework", "doc_check の差し戻し", rf"resolver:.+-flow{N}", ["reworkLabel(`resolver:${stage}-flow`, n)"]),
    ("framer-rework", "doc_check の差し戻し", rf"(?:intake|flow-framer(?::.+)?):rework{N}", ["reworkLabel(`${label}:rework`, n)", "reworkLabel('intake:rework', n)"]),
    ("left-verifier", "検証し残しの拾い直し（settle の前と後・再実行の入口）", rf"verifier:.+v-(?:left{N}|entry)", ["`verifier:${stage}v-${tag}`", "reworkLabel('left', n + 1)", "verifyLeft(from, 'entry'"]),
    ("independent-flow", "独立な flow の数え直し", r"flow-check:(?!.*-(?:entry|answers|backup|recopy)$).+", ["`flow-check:${tag}`"]),
    ("recopy", "写しの取り直し（doc_check の stdout が checksum に合わない）", r"flow-check:.+-recopy", ["label.startsWith('flow-check:') ? `${label}-recopy` : `flow-check:${label.replace(/:/g, '-')}-recopy`"]),
    ("rehold", "保持規則の書き直し", r"resolver:.+-rehold", ["`resolver:${owner}-rehold`"]),
    ("rehold-verifier", "保持規則の書き直し", r"verifier:.+-reholdv", ["`verifier:${owner}-reholdv`"]),
    ("hold-left", "聞けない問いの保持規則への変換", r"resolver:.+-hold", ["`resolver:${stage}-hold`"]),
    ("reframe", "段 3b の組み直し", r"flow-framer:3b-reframe", ["'flow-framer:3b-reframe'"]),
    ("crossdoc-reaudit", "crossDoc の再監査", r"crossDoc:r(?:[2-9]|\d{2,}):all(?::extra)?", []),
]

# AMBIGUOUS: label だけでは分かれない組と、分けるプロンプトの行。journal の started は label だけなので、組があると体数を理由ごとに数えられない。
AMBIGUOUS = {}

# PROMPT_CLUES: 同じ label の形の中で起動の理由を分けるプロンプトの行（family, 理由, 行の断片）。断片は prd-spec.js にそのまま在る。
PROMPT_CLUES = [
    ("settle-framer", "settle: 閉じた未決の終端（left）", "要素（閉じた O- ← 閉じた resolution）: "),
    ("settle-framer", "settle: 閉じた未決の終端（left、constrained_by）", "constrained_by の閉じた O-（要素 の O- ← 閉じた resolution）: "),
    ("settle-framer", "settle: 裁定した指摘（found）", "指摘（ID ← それを裁定した resolution）: "),
    ("settle-framer", "settle: 検証の裁定（verification、R2）", "検証の裁定（要素 ← 裁定した resolution）: "),
    ("settle-framer", "settle: 裁定の無い不合格の要素（redo、R2）", "検証に落ちた要素: "),
    ("settle-framer", "settle: 続けて出た項目（R6）", "は改稿で直らず再発した項目の指摘である"),
    ("settle-framer", "settle: 覆された決定を引く要素（stale_refs）", "覆された決定か検証に落ちた不変条件を出典か constrained_by に持つ要素（要素 ← その決定）: "),
    ("settle-framer", "settle: flow の指摘の引き渡し（handoff）", "flow の指摘（要素: 何が無いか か符号。"),
    ("settle-framer", "直し手の振り分け（R6b）", "縛る不変条件が無い"),
    ("opens", "settle の後の未裁定の O-（R6b）", "- まだ裁定の無い open: "),
    ("opens", "組の再検査（O- とまとめた呼び出し）", "- まだ裁定の無い組（"),
    ("main-resolver", "収束のループの経路の変更（R6、再発した項目）", "再発した項目（項目: 前のパスの指摘 ← その裁定）: "),
    ("main-resolver", "収束のループの経路の変更（R6、hold の指示）", "再発が続いた項目の指摘（hold にする）: "),
    ("rework-resolver", "差し戻し（v1 の不合格）", "（差し戻し）"),
    ("crossdoc-reaudit", "crossDoc の再監査（scopedAuditPlan が当てた項目）", "範囲を絞った監査: 対象は項目 "),
]

# SKIPPED_CLUES: 事実の条件で外した手順（返り値の skipped）。fact ごとに外した step の label の形。
SKIPPED_CLUES = {"unchanged": rf"verifier:{S}v", "carried_only": r"resolver:3b"}

# COVERING_TESTS: 全形と全行を起動する既存の段のテスト（段のテスト全体の run を捕まえて貪欲に選んだ被覆。全部を走らせ直すと
# 段のテストの時間が倍になる）。足りない 1 行は recurring_ledger_spec で足す。
COVERING_TESTS = [
    "RerunFromTheSameStage.test_止まったrunが書いて検証していないものは再実行が検証してから段を出る",
    "FlowFixerRoutes.test_重い段の経路でもlabelは重ならない",
    "Convergence.test_decisionの後の再発はholdを指示しholdの後は尽きてno_progressで止まる",
    "FailedHolds.test_settleのverifierに落ちた保持規則も変換せずに書き直させる",
    "FlowRecheck.test_差し戻しの後も落ちた要素は同じcycleの検証の裁定をsettleで写せば進む",
    "FindingRoutes.test_G1の後の3aでは段6で写した指摘を写し直さない",
    "FlowDigest.test_3aでflowのstdoutを返さないresolverは差し戻す",
    "FlowFixerRoutes.test_3aの裁定で閉じたOはsettleの次の回でRSに差し替わり段を出る",
    "FlowFixerRoutes.test_settleが新しい組と新しいOを作ったら1回のresolverにまとめて渡す",
    "Transcription.test_試走で写し損ねたflow_checkのstdoutは取り直して進む",
    "DecidedNotHeld.test_変換は指定した種類で返させる",
    "DecidedNotHeld.test_聞ける段でscriptの指定に無いholdは1回だけ問いに書き換え直させる",
    "DecidedNotHeld.test_揃えても受け取れないdecidableは同じverifierに1回だけ聞き直す",
]


def recurring_ledger_spec():
    """origin が ledger の指摘が同じ項目に 2 パス続く（再発）。ledger 由来の指摘が settle に回るのは再発したときだけで、
    「続けて出た項目」の行を持つ settle を起動する経路は既存の段のテストに無いので、ここで組む。"""
    d = test_prd_stages.Convergence.DIRECTIONS
    findings = {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision", "direction": d[0], "origin": "ledger"}],
                "grounding:r2": [{"id": "r2-gr-requirements__x-001", "direction": d[1], "origin": "ledger"}]}
    about = {"RS-010": {"finding": "r1-cd-all-001"}, "RS-011": {"finding": "r2-gr-requirements__x-001"}}
    return {"args": test_prd_stages.args(), "findings": findings, "ruled_seq_at": {"6": [["RS-010"], ["RS-011"]]}, "about": about}


def families_of(label):
    return [name for name, _, pat, _ in LABEL_FAMILIES if re.fullmatch(pat, label)]


def classify(label, prompt):
    hit = families_of(label)
    if len(hit) == 2 and tuple(hit) in AMBIGUOUS:
        return hit[1] if AMBIGUOUS[tuple(hit)] in prompt else hit[0]
    return hit[0] if len(hit) == 1 else None


def capture(test_names):
    """段のテストを走らせ、run() が起動した (label, prompt) と skipped を集める。"""
    seen = []
    original = test_prd_stages.run

    def recording(spec, patch=()):
        got = original(spec, patch)
        seen.append({"prompts": got["prompts"], "skipped": (got.get("result") or {}).get("skipped") or []})
        return got

    test_prd_stages.run = recording
    try:
        suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(n, test_prd_stages) for n in test_names)
        with contextlib.redirect_stderr(io.StringIO()):
            outcome = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)
    finally:
        test_prd_stages.run = original
    return seen, outcome


class Clues(unittest.TestCase):
    def test_手がかりの断片はprd_specの本文にそのまま在る(self):
        src = PRD.read_text(encoding="utf-8")
        for name, _, _, frags in LABEL_FAMILIES:
            for frag in frags:
                with self.subTest(family=name, fragment=frag):
                    self.assertIn(frag, src)
        for fam, reason, frag in PROMPT_CLUES:
            with self.subTest(reason=reason):
                self.assertIn(frag, src)

    def test_label_の形は重ならず_重なるのは_AMBIGUOUS_の組だけ(self):
        self.assertEqual(AMBIGUOUS, {})
        samples = {
            "resolver:3a'": ("main-resolver",),
            "resolver:3a-fix": ("rework-resolver",),
            "resolver:3a'-fix": ("rework-resolver",),
            "resolver:3-fix": ("rework-resolver",),
            "resolver:3b": ("main-resolver",),
            "verifier:3a'v": ("main-verifier",),
            "verifier:3a-fixv": ("rework-verifier",),
            "verifier:3a'-fixv": ("rework-verifier",),
            "resolver:3a-fix-flow": ("flow-rework",),
            "resolver:3a'-fix-questions": ("questions",),
            "resolver:3-fix-opens": ("opens",),
            "resolver:3-fix-pairs": ("pairs",),
            "resolver:3-fix-rehold": ("rehold",),
            "verifier:3-fix-reholdv": ("rehold-verifier",),
            "flow-check:3a-fix": ("independent-flow",),
            "resolver:3-convert": ("convert",),
            "resolver:3a-settle-2-convert": ("convert",),
            "resolver:3b-reframe-questions": ("questions",),
            "resolver:3-convert-questions-2": ("questions",),
            "resolver:6-rehold": ("rehold",),
            "resolver:6-hold": ("hold-left",),
            "verifier:6-holdv-settle": ("settle-verifier",),
            "verifier:3av-left-2": ("left-verifier",),
            "flow-check:3a-settle-convert": ("independent-flow",),
            "flow-check:6-entry": ("flow-check-entry",),
            "flow-check:3a-recopy": ("recopy",),
            "flow-check:3a-entry-recopy": ("recopy",),
            "flow-check:verifier-3v-recopy": ("recopy",),
            "flow-check:crossDoc-r1-all-recopy": ("recopy",),
            "flow-framer:3b-reframe": ("reframe",),
            "flow-framer:3b-reframe:rework-2": ("framer-rework",),
            "flow-framer:6-hold-settle-2": ("settle-framer",),
            "crossDoc:r1:all": ("audit-first",),
            "crossDoc:r2:all": ("crossdoc-reaudit",),
            "grounding:r3:requirements/x:extra": ("audit-scoped",),
        }
        for label, want in samples.items():
            with self.subTest(label=label):
                self.assertEqual(tuple(families_of(label)), want)

    def test_skipped_の_fact_は_script_の_SKIP_と同じ(self):
        self.assertEqual(sorted(SKIPPED_CLUES), sorted(value("SKIP").values()))
        self.assertIn("step: 'resolver:3b', fact: SKIP.carriedOnly", PRD.read_text(encoding="utf-8"))
        self.assertIn("step: v1Label, fact: SKIP.unchanged", PRD.read_text(encoding="utf-8"))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Launched(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runs, cls.outcome = capture(COVERING_TESTS)
        got = test_prd_stages.run(recurring_ledger_spec())
        cls.recurring = got
        cls.runs.append({"prompts": got["prompts"], "skipped": got["result"].get("skipped") or []})

    def test_流用した段のテストが通る(self):
        self.assertTrue(self.outcome.wasSuccessful(), [str(t) for t, _ in self.outcome.failures + self.outcome.errors])

    def test_再発したledger由来の指摘だけがsettleに続けて出た項目の行で渡る(self):
        self.assertEqual(self.recurring["result"]["status"], "done")
        [first, *_] = [p["prompt"] for p in self.recurring["prompts"] if p["label"] == "flow-framer:6-settle"]
        self.assertIn("このうち r2-gr-requirements__x-001 は改稿で直らず再発した項目の指摘である", first)
        self.assertNotIn("r1-cd-all-001", first, "再発していない ledger 由来の指摘は flow に写さない")

    def test_起動したagentはちょうど1つの形に当たる(self):
        bad = sorted({p["label"] for r in self.runs for p in r["prompts"] if classify(p["label"], p["prompt"]) is None})
        self.assertEqual(bad, [])

    def test_全形と全行が実際の起動に現れる(self):
        launched = [(classify(p["label"], p["prompt"]), p["prompt"]) for r in self.runs for p in r["prompts"]]
        fams = {f for f, _ in launched}
        self.assertEqual(sorted(n for n, _, _, _ in LABEL_FAMILIES if n not in fams), [])
        for fam, reason, frag in PROMPT_CLUES:
            with self.subTest(reason=reason):
                self.assertTrue(any(f == fam and frag in p for f, p in launched), f"{fam} の起動のプロンプトに「{frag}」が無い")

    def test_label_の重なる組は両方とも起動しプロンプトの行で分かれる(self):
        for pair, frag in AMBIGUOUS.items():
            label_pat = [pat for name, _, pat, _ in LABEL_FAMILIES if name == pair[0]][0]
            both = {classify(p["label"], p["prompt"]) for r in self.runs for p in r["prompts"] if len(families_of(p["label"])) == 2 and re.fullmatch(label_pat, p["label"])}
            self.assertEqual(both, set(pair), f"「{frag}」の有無で分ける")

    def test_skipped_の_step_は外した役の_label_の形(self):
        facts = [s for r in self.runs for s in r["skipped"]]
        self.assertEqual(sorted({s["fact"] for s in facts}), sorted(SKIPPED_CLUES))
        for s in facts:
            with self.subTest(step=s["step"]):
                self.assertRegex(s["step"], rf"^{SKIPPED_CLUES[s['fact']]}$")


if __name__ == "__main__":
    unittest.main()
