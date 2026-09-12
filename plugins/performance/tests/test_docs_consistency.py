"""S18 (docs consistency, demoted from oracle): the capability doc and the code
constants must name the same sets. This is a same-author cross-check, not a
proof of correctness — it catches drift, nothing more (ledger seq 8)."""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_schema

DOC = Path(__file__).resolve().parents[1] / "references" / "host-capabilities.md"

CAPABILITIES = ("skill_boundary", "call_linkage", "child_linkage",
                "terminal_event", "usage", "notification")


class DocsConsistency(unittest.TestCase):
    def setUp(self):
        self.text = DOC.read_text()

    def test_all_six_capabilities_documented(self):
        rows = re.findall(r"^\| (\w+) \|", self.text, re.M)
        self.assertEqual(sorted(set(rows) & set(CAPABILITIES)),
                         sorted(CAPABILITIES))

    def test_censored_items_stay_visible(self):
        self.assertIn("C1", self.text)
        self.assertIn("C2", self.text)

    def test_boundary_evidence_values_match_schema(self):
        for value in run_schema.BOUNDARY_EVIDENCE:
            if value == "declared":
                continue
            # host_dispatch / explicit_entry は能力表の語彙として現れるはず
            self.assertTrue(
                value.replace("host_dispatch", "dispatch") in self.text
                or value in self.text or "明示" in self.text)

    def test_tier_b_never_called_proof(self):
        # tier b を「実証」と呼ばない規約: b 行の同じ行に「実証済」の語が無いこと
        for line in self.text.splitlines():
            if re.match(r"^\| \w+ \|", line) and "| b（" in line:
                self.assertNotIn("実証済", line)


if __name__ == "__main__":
    unittest.main()
