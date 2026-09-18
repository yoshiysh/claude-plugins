"""Recorded real-model experiment (6 haiku runs, alternating) replays to the
committed results. This pins the arithmetic to real observations: quality was
6/6 (every run produced SUM=2870, independently checked by a string verifier)
while the effect was mixed — the script variant cut output tokens but grew
input via extra tool turns, which is exactly why a lone workflow success does
not certify an improvement."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import experiment

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "experiment-demo"


class RecordedExperiment(unittest.TestCase):
    def setUp(self):
        self.protocol = json.loads((FIXTURES / "protocol.json").read_text())
        self.fixture = json.loads((FIXTURES / "recorded-runs.json").read_text())
        self.results = json.loads((FIXTURES / "results.json").read_text())

    def test_replay_reproduces_committed_results(self):
        replay = experiment.replay(self.protocol, self.fixture)
        self.assertEqual(replay["variants"], self.results["variants"])
        self.assertEqual(replay["deltas"], self.results["deltas"])

    def test_quality_held_while_effect_was_mixed(self):
        for aggregate in self.results["variants"].values():
            self.assertEqual(aggregate["success_rate"], 1.0)
        (delta,) = self.results["deltas"].values()
        self.assertLess(delta["output_tokens_pct"], 0)
        self.assertGreater(delta["input_tokens_pct"], 0)

    def test_comparison_flagged_for_investigation_not_certified(self):
        self.assertEqual(self.results["comparison"]["status"], "candidate")
        self.assertEqual(self.results["comparison"]["reason"],
                         "investigate_regression")


if __name__ == "__main__":
    unittest.main()
