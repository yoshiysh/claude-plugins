"""人間必要性の判定パイプライン（段 2〜4）が、同じランの中で本文へ反映されることの固定。

**ここが壊れた状態が実際にあった。** 先例裁定で解消した項目を「次周回の tbd_answers に採る」
規約にしていたため、未提示 blocking が 0 件になったランでは次周回そのものが起きず、解消文が
本文に一度も書かれないまま「解消済み」として依頼者へ提示されていた（文書の実体と提示内容の
乖離）。反映を同一ラウンドに置くこと・反映後に集計を引き直すことを、構造として押さえる。
"""

import re
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
REFINE = (SKILL / "scripts" / "refine.js").read_text(encoding="utf-8")


class InRunResolutionTests(unittest.TestCase):
    def test_resolution_pass_runs_in_the_same_round(self):
        # 反映専用の改稿を同一ランで発行していること（次周回に持ち越さない）。
        self.assertIn("R${outerRound}.resolve", REFINE)
        self.assertIn("writerDirectives = resolutionDirectives", REFINE)

    def test_directives_force_the_writer_to_run(self):
        # 指摘 0 件でも決着の反映は走らせる。指摘の有無で絞ると反映パスが空回りする。
        self.assertIn("if ((writerDirectives.get(d.key) || []).length) return true", REFINE)

    def test_counts_are_recomputed_after_the_resolution_pass(self):
        # 反映後に引き直さないと、返り値は反映前の件数を報告する。
        pass_idx = REFINE.index("R${outerRound}.resolve")
        self.assertIn("recomputeTbd()", REFINE[pass_idx:])
        self.assertIn("structural = [...structResult.findings", REFINE[pass_idx:])

    def test_recompute_is_the_only_place_the_unpresented_rule_lives(self):
        # unpresented_blocking の式が 2 箇所にあると、反映後だけ古い式で出る。
        self.assertEqual(1, REFINE.count("if (!rec.digest) return false"))


class MeasurementStageTests(unittest.TestCase):
    def test_precedent_judge_can_route_to_measurement(self):
        self.assertIn("'measurable'", REFINE)
        self.assertIn("measurement_target", REFINE)

    def test_measurement_agent_file_exists(self):
        self.assertTrue((SKILL / "agents" / "measurement.md").is_file())

    def test_unmeasurable_items_go_back_to_the_gate(self):
        # 計測できなかった項目を黙って消さない。
        self.assertIn(
            "gateBlocking = [...gateBlocking, ...measurableBlocking.filter((t) => !resolvedIds.has(t.id))]",
            REFINE,
        )

    def test_resolution_without_evidence_is_rejected(self):
        # 証拠の無い解消は計測ではなく推測。採ると要求の捏造になる。
        self.assertIn("(r.evidence || []).length", REFINE)


class HoldingRuleTests(unittest.TestCase):
    def test_holding_rules_target_only_presented_items(self):
        # 一度も聞いていない項目を保持規則へ落とすと、聞かずに終える経路になる。
        m = re.search(r"const isPresented = \(t\) => \{(.*?)\n\}", REFINE, re.S)
        self.assertIsNotNone(m)
        self.assertIn("if (!rec) return false", m.group(1))
        self.assertIn("const holdingTargets = blockingTbd.filter(isPresented)", REFINE)

    def test_settled_items_are_subtracted_from_the_recount(self):
        # script 起票の TBD（TBD-EX- / TBD-NI-）は writer の申告に関係なく再投入されるため、
        # 差し引かないと本文と返り値が食い違う（在ラン解消の目的そのものが崩れる）。
        self.assertIn("rebuilt.current.filter((t) => !settled.has(t.id))", REFINE)

    def test_a_non_responding_writer_does_not_settle_anything(self):
        # 応答しなかった writer の文書は前稿のまま。決着扱いにすると TBD が黙って消える。
        self.assertIn("if (failedDocs.has(docKey)) continue", REFINE)

    def test_non_blocking_tbd_does_not_block_completion(self):
        # 進行可能な未確定は「決まらなくても着手できる」正しい状態であり、verdict を
        # tbd_remaining に落とし続けると clean が到達不能になる。
        self.assertIn("  : blockingTbd.length\n  ? 'tbd_remaining'", REFINE)
        self.assertIn("const carryTargets = tbdItems.filter((t) => !t.blocking)", REFINE)

    def test_work_items_are_returned_and_not_written_into_documents(self):
        self.assertIn("work_items: workItems", REFINE)
        # 文書へ書かせる指示は resolve / hold の 2 種だけで、work_items は writer へ渡さない。
        directives = REFINE[REFINE.index("const resolutionDirectives = new Map()") :]
        directives = directives[: directives.index("if (resolutionDirectives.size)")]
        self.assertNotIn("workItems", directives)

    def test_audit_trail_carries_the_records_documents_no_longer_hold(self):
        for key in ("basis:", "auto_resolved:", "measured:", "holding_rules:", "adjudication,"):
            self.assertIn(key, REFINE[REFINE.index("audit_trail: {") :])


if __name__ == "__main__":
    unittest.main()
